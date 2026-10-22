// The agency context of the shell (design D-PRIV-1, D-DS-3; 11 "Agency context stays visible"): the agency the page is showing, read from the
// api once the session is confirmed and drawn as a name and a state beside the navigation. It holds no React and no DOM, like the session
// runtime it follows.
//   - A page outside an agency has no context and asks for nothing.
//   - The name is a fact of the private view: it is read only after the session is confirmed, and dropped the moment the session is not
//     (pagehide, a restored page, a 401, sign-out, a switch), so a frozen page holds no agency name.
//   - The reply is trusted only when it names the agency the URL names. A refusal, a reply for another agency, a reply that fails the
//     contract and a lost answer all end as the same single "not available": the page never says which one, and never shows a name it
//     cannot vouch for.
//   - A re-confirmation of the same session (the tab came back) refreshes the context without blanking it: a refusal ends it (the person
//     may have lost access while away), a lost answer keeps what was confirmed, exactly as the session runtime treats its own re-read.
import type { AgencyMembershipView, AgencyView, GetAgencyReply, ListAgenciesReply } from "../api/generated.ts";
import type { ApiAnswer } from "../client/answer.ts";
import type { SessionPhase } from "../client/session.ts";

export type AgencyState = AgencyView["state"];
export type MembershipRole = AgencyMembershipView["role"];

export type AgencyContext =
  | { readonly kind: "NONE" }
  | { readonly kind: "LOADING" }
  | { readonly kind: "UNAVAILABLE" }
  | {
      readonly kind: "READY";
      readonly agencyId: string;
      readonly displayName: string;
      readonly state: AgencyState;
      /** The person's role in this agency, from their own active membership (Order 11 round 2: the account button names it); null when unknown. */
      readonly role: MembershipRole | null;
    };

/** What one api answer means for the agency the URL names. Anything but a reply for exactly that agency is unavailable. */
export function agencyContextOf(agencyId: string, answer: ApiAnswer<GetAgencyReply>, role: MembershipRole | null = null): AgencyContext {
  if (answer.kind !== "REPLY") return { kind: "UNAVAILABLE" };
  const view = answer.body.data;
  if (view.agencyId !== agencyId) return { kind: "UNAVAILABLE" };
  return { kind: "READY", agencyId: view.agencyId, displayName: view.displayName, state: view.state, role };
}

/**
 * The person's role in one agency, from the list of their own memberships: only an active membership of exactly that agency names a role.
 * Anything else (no answer, a refusal, an agency on a later page) is "unknown", and unknown shows no role: it never decides access, which
 * stays with the api's permitted actions.
 */
export function roleOf(agencyId: string, answer: ApiAnswer<ListAgenciesReply> | null): MembershipRole | null {
  if (answer === null || answer.kind !== "REPLY") return null;
  const mine = answer.body.data.items.find((item) => item.agencyId === agencyId && item.membershipState === "ACTIVE");
  return mine?.role ?? null;
}

export interface AgencyContextDeps {
  /** The agency of the page's URL, or null on a page outside an agency. */
  readonly agencyId: string | null;
  /** GetAgency for that agency under the session; the signal ends the read when the session it belongs to no longer stands. */
  readonly read: (agencyId: string, signal: AbortSignal) => Promise<ApiAnswer<GetAgencyReply>>;
  /** ListAgencies under the session (the person's own memberships), read beside GetAgency for the role; absent, no role is shown. */
  readonly readMemberships?: (signal: AbortSignal) => Promise<ApiAnswer<ListAgenciesReply>>;
}

/** The two things the context needs of a session runtime. */
export interface SessionSource {
  snapshot(): SessionPhase;
  subscribe(listener: () => void): () => void;
}

function same(left: AgencyContext, right: AgencyContext): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "READY" || right.kind !== "READY") return true;
  return left.agencyId === right.agencyId && left.displayName === right.displayName && left.state === right.state && left.role === right.role;
}

export class AgencyContextRuntime {
  readonly #deps: AgencyContextDeps;
  readonly #listeners = new Set<() => void>();
  #context: AgencyContext;
  #controller: AbortController | null = null;
  /** Bumped by everything that decides what the context is; an answer asked before the bump is ignored. */
  #generation = 0;

  constructor(deps: AgencyContextDeps) {
    this.#deps = deps;
    this.#context = deps.agencyId === null ? { kind: "NONE" } : { kind: "LOADING" };
  }

  snapshot(): AgencyContext {
    return this.#context;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Follows a session: the first time it is signed in the agency is read (the context is LOADING meanwhile); every later confirmation
   * refreshes it in place; any other phase forgets it. Returns the function that stops following and aborts what is on its way.
   */
  follow(session: SessionSource): () => void {
    let wasSignedIn = false;
    const onChange = (): void => {
      const signedIn = session.snapshot().kind === "SIGNED_IN";
      if (signedIn) this.#load(wasSignedIn ? "REFRESH" : "FIRST");
      else this.#forget();
      wasSignedIn = signedIn;
    };
    onChange();
    const stop = session.subscribe(onChange);
    return () => {
      stop();
      this.#abort();
    };
  }

  #abort(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
  }

  #forget(): void {
    this.#abort();
    if (this.#deps.agencyId !== null) this.#set({ kind: "LOADING" });
  }

  #load(mode: "FIRST" | "REFRESH"): void {
    const agencyId = this.#deps.agencyId;
    if (agencyId === null) return;
    this.#abort();
    const controller = new AbortController();
    this.#controller = controller;
    const generation = this.#generation;
    if (mode === "FIRST") this.#set({ kind: "LOADING" });
    void this.#read(agencyId, controller, generation, mode);
  }

  async #read(agencyId: string, controller: AbortController, generation: number, mode: "FIRST" | "REFRESH"): Promise<void> {
    const memberships = this.#deps.readMemberships;
    // the role is asked beside the agency, never before it: the agency's answer alone decides what the page may show
    let pending: Promise<ApiAnswer<GetAgencyReply>>;
    try {
      pending = this.#deps.read(agencyId, controller.signal);
    } catch {
      pending = Promise.resolve({ kind: "NO_ANSWER", reason: "UNREADABLE", status: null });
    }
    const role = memberships === undefined ? null : memberships(controller.signal).catch((): ApiAnswer<ListAgenciesReply> => ({ kind: "NO_ANSWER", reason: "UNREADABLE", status: null }));
    let answer: ApiAnswer<GetAgencyReply>;
    try {
      answer = await pending;
    } catch {
      answer = { kind: "NO_ANSWER", reason: "UNREADABLE", status: null };
    }
    const mine = role === null ? null : await role;
    if (generation !== this.#generation) return;
    this.#controller = null;
    if (mode === "REFRESH" && answer.kind === "NO_ANSWER") return;
    // a lost answer about the role keeps the role already confirmed, as a lost answer about the agency keeps the agency
    const previous = this.#context.kind === "READY" && this.#context.agencyId === agencyId ? this.#context.role : null;
    this.#set(agencyContextOf(agencyId, answer, mine !== null && mine.kind === "NO_ANSWER" ? previous : roleOf(agencyId, mine)));
  }

  #set(next: AgencyContext): void {
    if (same(this.#context, next)) return;
    this.#context = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

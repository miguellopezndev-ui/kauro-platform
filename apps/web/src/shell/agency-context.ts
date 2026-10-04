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
import type { AgencyView, GetAgencyReply } from "../api/generated.ts";
import type { ApiAnswer } from "../client/answer.ts";
import type { SessionPhase } from "../client/session.ts";

export type AgencyState = AgencyView["state"];

export type AgencyContext =
  | { readonly kind: "NONE" }
  | { readonly kind: "LOADING" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "READY"; readonly agencyId: string; readonly displayName: string; readonly state: AgencyState };

/** What one api answer means for the agency the URL names. Anything but a reply for exactly that agency is unavailable. */
export function agencyContextOf(agencyId: string, answer: ApiAnswer<GetAgencyReply>): AgencyContext {
  if (answer.kind !== "REPLY") return { kind: "UNAVAILABLE" };
  const view = answer.body.data;
  if (view.agencyId !== agencyId) return { kind: "UNAVAILABLE" };
  return { kind: "READY", agencyId: view.agencyId, displayName: view.displayName, state: view.state };
}

export interface AgencyContextDeps {
  /** The agency of the page's URL, or null on a page outside an agency. */
  readonly agencyId: string | null;
  /** GetAgency for that agency under the session; the signal ends the read when the session it belongs to no longer stands. */
  readonly read: (agencyId: string, signal: AbortSignal) => Promise<ApiAnswer<GetAgencyReply>>;
}

/** The two things the context needs of a session runtime. */
export interface SessionSource {
  snapshot(): SessionPhase;
  subscribe(listener: () => void): () => void;
}

function same(left: AgencyContext, right: AgencyContext): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "READY" || right.kind !== "READY") return true;
  return left.agencyId === right.agencyId && left.displayName === right.displayName && left.state === right.state;
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
    let answer: ApiAnswer<GetAgencyReply>;
    try {
      answer = await this.#deps.read(agencyId, controller.signal);
    } catch {
      answer = { kind: "NO_ANSWER", reason: "UNREADABLE", status: null };
    }
    if (generation !== this.#generation) return;
    this.#controller = null;
    if (mode === "REFRESH" && answer.kind === "NO_ANSWER") return;
    this.#set(agencyContextOf(agencyId, answer));
  }

  #set(next: AgencyContext): void {
    if (same(this.#context, next)) return;
    this.#context = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

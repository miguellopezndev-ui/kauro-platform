// The session and privacy runtime of the page (design D-PRIV-1, D-AUTH-1, D-AUTH-4; case S067's browser half). Private data exists only
// in this page's memory, and this object decides when the page may show it:
//   - `pagehide` replaces the private view with the loading shell, so a back/forward-cache snapshot holds nothing;
//   - `pageshow` (restored from the cache) and `visibilitychange` (back on screen) read the session again; a restored page draws only
//     after that read, and a tab that comes back reacts to a session that ended or changed hands while it was away;
//   - a 401 from any call ends the private view, whichever screen made the call (the api client tells `observeAnswer`);
//   - a change of agency is an explicit clearing state followed by a full document navigation, so the JS heap starts empty;
//   - sign-out is the revoke call, and only a confirmed revoke replaces the location with the sign-in page; an unconfirmed one stays put
//     and says so, because the person may still be signed in;
//   - nothing is ever written to a browser store: no localStorage, sessionStorage, IndexedDB, cache or cookie is touched here (a test
//     reads the source for it and runs the runtime with every store made to throw).
// The object holds no React and no DOM: the shell subscribes to it, and `bindPageEvents` connects the page's events to it.
import { matchRoute, pathOf } from "../screens.ts";
import type { ApiAnswer } from "./answer.ts";
import type { ClientContext } from "./api-client.ts";
import type { SessionApi, SessionSummary, SessionView } from "./session-api.ts";

export type UnavailableReason = "NO_ANSWER" | "REJECTED" | "INTEGRITY" | "SIGN_OUT_UNCONFIRMED";

/**
 * What the page may draw. Only SIGNED_IN allows private content; every other phase is a shell with a message. The phases hold no token.
 */
export type SessionPhase =
  | { readonly kind: "CHECKING" }
  | { readonly kind: "SIGNED_IN"; readonly session: SessionSummary }
  | { readonly kind: "SIGNED_OUT" }
  | { readonly kind: "UNAVAILABLE"; readonly reason: UnavailableReason }
  | { readonly kind: "LEAVING" }
  | { readonly kind: "SWITCHING"; readonly agencyId: string | null };

/** Full-document navigation, the only kind this runtime performs: `location.assign` and `location.replace`, never the client router. */
export interface DocumentNavigation {
  assign(url: string): void;
  replace(url: string): void;
}

export interface SessionDeps {
  readonly api: SessionApi;
  readonly navigation: DocumentNavigation;
  /** The pathname the page was loaded with; the agency in it is the page's agency for its whole life. */
  readonly initialPathname: string;
}

export type SignOutResult = "LEFT" | "UNCONFIRMED" | "SUPERSEDED";
export type BoundaryResult = "SAME_AGENCY" | "HARD_NAVIGATION";

const AGENCY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_PATH = /^\/[A-Za-z0-9_\-/]*$/;

function agencyOfPath(pathname: string): string | null {
  const agency = matchRoute(pathname)?.params["agencyId"];
  return agency !== undefined && AGENCY_ID.test(agency) ? agency : null;
}

/** Copies the fields the page may see, one by one, so a member added to the wire shape later is not exposed by accident. */
function summaryOf(view: SessionView): SessionSummary {
  return {
    userId: view.userId,
    emailVerified: view.emailVerified,
    mfaEnrolled: view.mfaEnrolled,
    ...(view.mfaAt === undefined ? {} : { mfaAt: view.mfaAt }),
    ...(view.stepUpFreshUntil === undefined ? {} : { stepUpFreshUntil: view.stepUpFreshUntil }),
    idleExpiresAt: view.idleExpiresAt,
    absoluteExpiresAt: view.absoluteExpiresAt,
  };
}

function isUnauthenticated(answer: ApiAnswer<unknown>): boolean {
  return (answer.kind === "PROBLEM" || answer.kind === "INTEGRITY") && answer.status === 401;
}

export class SessionRuntime implements ClientContext {
  readonly #deps: SessionDeps;
  readonly #agency: string | null;
  readonly #listeners = new Set<() => void>();
  #phase: SessionPhase = { kind: "CHECKING" };
  #view: SessionView | null = null;
  /** Bumped by every action that decides what the page shows; an answer that was asked before the bump is ignored. */
  #generation = 0;
  #leaving: Promise<SignOutResult> | null = null;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#agency = agencyOfPath(deps.initialPathname);
  }

  // ---- what the page and the api client read ----

  snapshot(): SessionPhase {
    return this.#phase;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The X-Kauro-CSRF token of the current session; the api client asks for it on every unsafe request. */
  csrfToken(): string | null {
    return this.#view?.csrfToken ?? null;
  }

  /** The agency of the page's URL, or null on a page outside an agency. */
  activeAgency(): string | null {
    return this.#agency;
  }

  // ---- reading the session ----

  /** The first read of a page load: the shell is drawn, private content waits for the answer. */
  start(): Promise<void> {
    return this.#read("FOREGROUND");
  }

  /** "Check again" on a shell that could not confirm the session. */
  checkAgain(): Promise<void> {
    return this.#read("FOREGROUND");
  }

  /** `pagehide`: the private view becomes the loading shell before the page is frozen, unloaded or put in the back/forward cache. */
  onPageHide(): void {
    this.#generation += 1;
    this.#view = null;
    // a page that is already leaving or switching is already a shell
    if (this.#phase.kind !== "LEAVING" && this.#phase.kind !== "SWITCHING") this.#showShell();
  }

  /** `pageshow`: a page restored from the cache draws nothing until the session has been read again. */
  onPageShow(persisted: boolean): Promise<void> {
    if (!persisted) return Promise.resolve();
    // whatever the page was doing when it was frozen (a sign-out, an agency switch) is over: it starts from the loading shell
    this.#generation += 1;
    this.#leaving = null;
    this.#view = null;
    this.#showShell();
    return this.#read("FOREGROUND");
  }

  /** `visibilitychange` to visible: a tab that was away re-reads the session and reacts to what changed. */
  onBecameVisible(): Promise<void> {
    switch (this.#phase.kind) {
      case "SIGNED_IN":
        return this.#read("BACKGROUND");
      case "UNAVAILABLE":
        return this.#phase.reason === "SIGN_OUT_UNCONFIRMED" ? Promise.resolve() : this.#read("FOREGROUND");
      default:
        return Promise.resolve();
    }
  }

  async #read(mode: "FOREGROUND" | "BACKGROUND"): Promise<void> {
    if (this.#phase.kind === "LEAVING") return;
    this.#generation += 1;
    const generation = this.#generation;
    const previousUser = this.#view?.userId ?? null;
    if (mode === "FOREGROUND") {
      this.#view = null;
      this.#showShell();
    }
    const answer = await this.#deps.api.current();
    if (generation !== this.#generation) return;
    if (answer.kind === "REPLY") {
      if (mode === "BACKGROUND" && previousUser !== null && previousUser !== answer.body.userId) {
        this.#handOver();
        return;
      }
      this.#view = answer.body;
      this.#set({ kind: "SIGNED_IN", session: summaryOf(answer.body) });
      return;
    }
    if (isUnauthenticated(answer)) {
      this.#end({ kind: "SIGNED_OUT" });
      return;
    }
    if (answer.kind === "INTEGRITY") {
      this.#end({ kind: "UNAVAILABLE", reason: "INTEGRITY" });
      return;
    }
    // no answer, or a refusal that is not "signed out": a tab that was already showing a confirmed session keeps it; a shell that
    // has not confirmed one stays a shell
    if (mode === "BACKGROUND") return;
    this.#end({ kind: "UNAVAILABLE", reason: answer.kind === "NO_ANSWER" ? "NO_ANSWER" : "REJECTED" });
  }

  /** Another tab signed in as someone else: this page's private data belongs to the previous person, so it is wiped and the page reloads. */
  #handOver(): void {
    this.#generation += 1;
    this.#view = null;
    this.#showShell();
    this.#deps.navigation.replace(pathOf("UI10"));
  }

  /**
   * Any api answer, from any screen. A 401 while a session is showing means it is gone: the private view ends. While the runtime itself
   * is reading, leaving or switching, it owns the outcome and this does nothing.
   */
  observeAnswer(answer: ApiAnswer<unknown>): void {
    if (this.#phase.kind === "SIGNED_IN" && isUnauthenticated(answer)) {
      this.#generation += 1;
      this.#end({ kind: "SIGNED_OUT" });
    }
  }

  // ---- leaving ----

  /** Signs out: private view cleared, session revoked, and only a confirmed revoke replaces the location with the sign-in page. */
  signOut(): Promise<SignOutResult> {
    if (this.#leaving !== null) return this.#leaving;
    this.#generation += 1;
    const generation = this.#generation;
    // the private view is gone now; the token stays until the revoke has been asked, because the revoke is a request that needs it
    this.#set({ kind: "LEAVING" });
    const finished = this.#revoke(generation).finally(() => {
      this.#leaving = null;
    });
    this.#leaving = finished;
    return finished;
  }

  async #revoke(generation: number): Promise<SignOutResult> {
    const answer = await this.#deps.api.revoke();
    if (generation !== this.#generation) return "SUPERSEDED";
    // 204 confirms it; a 401 says the session was already gone (the revoke is idempotent by contract)
    if (answer.kind === "REPLY" || isUnauthenticated(answer)) {
      this.#view = null;
      this.#deps.navigation.replace("/login");
      return "LEFT";
    }
    this.#set({ kind: "UNAVAILABLE", reason: "SIGN_OUT_UNCONFIRMED" });
    return "UNCONFIRMED";
  }

  /** Switches agency: an explicit clearing state, then a full document navigation so nothing of the previous agency survives in memory. */
  switchAgency(agencyId: string): void {
    if (!AGENCY_ID.test(agencyId)) throw new RangeError("an agency id is a UUID");
    this.#clearAndNavigate(agencyId, pathOf("UI11", { agencyId }));
  }

  /**
   * A navigation the client router is about to make. One that crosses an agency boundary (into another agency, out of an agency, or into
   * one from outside) is refused as a soft navigation: the page is wiped and the destination is loaded as a new document.
   */
  checkAgencyBoundary(destination: string): BoundaryResult {
    if (!LOCAL_PATH.test(destination) || destination.includes("//")) throw new RangeError("a destination is a plain path of this application");
    if (agencyOfPath(destination) === this.#agency) return "SAME_AGENCY";
    this.#clearAndNavigate(agencyOfPath(destination), destination);
    return "HARD_NAVIGATION";
  }

  #clearAndNavigate(agencyId: string | null, destination: string): void {
    this.#generation += 1;
    this.#view = null;
    this.#set({ kind: "SWITCHING", agencyId });
    this.#deps.navigation.assign(destination);
  }

  // ---- state ----

  /** The loading shell. A page that already shows it is not told again. */
  #showShell(): void {
    if (this.#phase.kind !== "CHECKING") this.#set({ kind: "CHECKING" });
  }

  /** Ends the private view for a reason: the token goes with it. */
  #end(phase: SessionPhase): void {
    this.#view = null;
    this.#set(phase);
  }

  #set(phase: SessionPhase): void {
    this.#phase = phase;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Connects the page's events to a runtime. Returns the function that disconnects them. */
export function bindPageEvents(runtime: SessionRuntime, page: { readonly window: EventTarget; readonly document: EventTarget & { readonly visibilityState: string } }): () => void {
  const onHide = (): void => runtime.onPageHide();
  const onShow = (event: Event): void => {
    void runtime.onPageShow((event as Event & { readonly persisted?: boolean }).persisted === true);
  };
  const onVisibility = (): void => {
    if (page.document.visibilityState === "visible") void runtime.onBecameVisible();
  };
  page.window.addEventListener("pagehide", onHide);
  page.window.addEventListener("pageshow", onShow);
  page.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    page.window.removeEventListener("pagehide", onHide);
    page.window.removeEventListener("pageshow", onShow);
    page.document.removeEventListener("visibilitychange", onVisibility);
  };
}

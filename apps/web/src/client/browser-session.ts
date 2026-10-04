// The composition of a page's runtime (design D-PRIV-1, D-TOPO-1): one api client, one session runtime, the page's events bound to it, and
// the client's answers observed by it. Everything the browser provides arrives through `BrowserPage`, so the same wiring runs in a test
// with a fake fetch, a fake location and an EventTarget.
import { ApiClient, type FetchLike } from "./api-client.ts";
import { newFormKey } from "./idempotency.ts";
import { bindPageEvents, SessionRuntime } from "./session.ts";
import { sessionApi } from "./session-api.ts";

export interface BrowserPage {
  readonly fetch: FetchLike;
  readonly location: {
    readonly pathname: string;
    assign(url: string): void;
    replace(url: string): void;
  };
  readonly window: EventTarget;
  readonly document: EventTarget & { readonly visibilityState: string };
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
}

export interface BrowserSession {
  readonly runtime: SessionRuntime;
  readonly client: ApiClient;
  /** Unbinds the page's events. */
  readonly detach: () => void;
}

export function createBrowserSession(page: BrowserPage): BrowserSession {
  // the client needs the runtime for its context and its observer, and the runtime needs the client for its two calls
  const slot: { runtime: SessionRuntime | null } = { runtime: null };
  const client = new ApiClient({
    fetch: page.fetch,
    newCorrelationId: () => newFormKey(page.now, page.randomBytes),
    context: { csrfToken: () => slot.runtime?.csrfToken() ?? null, activeAgency: () => slot.runtime?.activeAgency() ?? null },
    observe: (answer) => slot.runtime?.observeAnswer(answer),
  });
  const runtime = new SessionRuntime({
    api: sessionApi(client),
    navigation: { assign: (url) => page.location.assign(url), replace: (url) => page.location.replace(url) },
    initialPathname: page.location.pathname,
  });
  slot.runtime = runtime;
  return { runtime, client, detach: bindPageEvents(runtime, { window: page.window, document: page.document }) };
}

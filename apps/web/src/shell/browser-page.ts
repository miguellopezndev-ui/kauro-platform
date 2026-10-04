// The browser as the runtime sees it (design D-PRIV-1, D-TOPO-1): the one place the shell touches `window`. It is a thin adapter, so it is
// exercised by the browser suite against the built application rather than by node:test, and it is never imported by a server module.
import type { BrowserPage } from "../client/browser-session.ts";

export function browserPage(): BrowserPage {
  return {
    fetch: (url, init) => window.fetch(url, init),
    location: {
      get pathname() {
        return window.location.pathname;
      },
      assign: (url) => window.location.assign(url),
      replace: (url) => window.location.replace(url),
    },
    window,
    document,
    now: () => Date.now(),
    randomBytes: (length) => window.crypto.getRandomValues(new Uint8Array(length)),
  };
}

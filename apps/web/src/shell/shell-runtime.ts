// The composition of the application shell's runtime (design D-PRIV-1, D-TOPO-1): the page's session runtime, its api client and the
// agency context that follows the session, built from everything the browser provides (`BrowserPage`), so the same wiring runs in a test
// with a fake fetch and a fake location. The React layer only subscribes to what this returns.
import type { ApiClient } from "../client/api-client.ts";
import { type BrowserPage, createBrowserSession } from "../client/browser-session.ts";
import type { SessionRuntime } from "../client/session.ts";
import { AgencyContextRuntime } from "./agency-context.ts";

export interface Shell {
  readonly session: SessionRuntime;
  readonly agency: AgencyContextRuntime;
  readonly client: ApiClient;
  /** Unbinds the page's events and stops the agency context following the session. */
  readonly detach: () => void;
}

export function createShell(page: BrowserPage): Shell {
  const { runtime, client, detach } = createBrowserSession(page);
  const agency = new AgencyContextRuntime({
    agencyId: runtime.activeAgency(),
    // the agency is in the path (the operation names it as a path parameter): the client sends no separate agency header for it
    read: (agencyId, signal) => client.call("GetAgency", { path: { agencyId }, signal }),
    // the person's own memberships, for the role the account button names (the largest page the api serves, so one read covers nearly everyone)
    readMemberships: (signal) => client.call("ListAgencies", { query: { limit: 100 }, signal }),
  });
  const stop = agency.follow(runtime);
  return {
    session: runtime,
    agency,
    client,
    detach: () => {
      stop();
      detach();
    },
  };
}

// The project a page is inside, read once for the frame (Order 24): the project's header and the project's areas in the menu are drawn from
// the api's own reads, never from the address alone. GetProject answers the project's service (mode) and its purpose, which is the name the
// agency gave the work; ListClients answers the client's display name (the api serves no single-client read, so the agency's client pages are
// read until the project's client is found, at most CLIENT_PAGES pages). Anything but a contract-valid reply leaves the project unknown: the
// page then keeps its own name as its h1 and the menu does not nest a project (the frame's documented fallback), never a guessed name.
import type { ApiClient } from "../client/api-client.ts";
import type { ServiceMode } from "../screens.ts";

export interface ProjectOfPage {
  readonly projectId: string;
  readonly name: string;
  readonly clientLabel: string;
  readonly mode: ServiceMode;
}

/** The bound on the client pages read to name one project's client (100 clients a page). */
export const CLIENT_PAGES = 5;
const CLIENT_PAGE_SIZE = 100;

export async function readProjectOfPage(client: ApiClient, agencyId: string, projectId: string, signal?: AbortSignal): Promise<ProjectOfPage | null> {
  const project = await client.call("GetProject", { path: { projectId }, ...(signal === undefined ? {} : { signal }) });
  if (project.kind !== "REPLY") return null;
  const view = project.body.data;
  // a project of another agency than the page's is never drawn under this agency's menu
  if (view.projectId !== projectId || view.agencyId !== agencyId) return null;
  let cursor: string | undefined;
  for (let page = 0; page < CLIENT_PAGES; page += 1) {
    const clients = await client.call("ListClients", { path: { agencyId }, query: { limit: CLIENT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }, ...(signal === undefined ? {} : { signal }) });
    if (clients.kind !== "REPLY") return null;
    const found = clients.body.data.items.find((c) => c.clientId === view.clientId);
    if (found !== undefined) return { projectId, name: view.purpose, clientLabel: found.displayName, mode: view.mode };
    cursor = clients.body.data.nextCursor;
    if (cursor === undefined) break;
  }
  return null;
}

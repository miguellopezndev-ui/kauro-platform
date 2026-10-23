// UI13 Overview as data (registry: "The current revision and next required action."; Order 24): the project from GetProject and its row of
// ListProjects (ProjectDashboardItem: its phase and the next required action). The api serves no single-project dashboard read, so the row is
// found by reading the agency's list under each server filter in turn (active, failed, delivered, archived), at most ROW_PAGES pages of each.
// A row that cannot be found leaves the stage unknown: the page then draws no progress and no next step rather than a guessed one.
import type { ProjectDashboardItem } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";

export const ROW_PAGES = 3;
const ROW_PAGE_SIZE = 100;
const FILTERS = ["active", "failed", "delivered", "archived"] as const;

export async function dashboardRowOf(client: ApiClient, agencyId: string, projectId: string, signal?: AbortSignal): Promise<ProjectDashboardItem | null> {
  for (const filter of FILTERS) {
    let cursor: string | undefined;
    for (let page = 0; page < ROW_PAGES; page += 1) {
      const answer = await client.call("ListProjects", { path: { agencyId }, query: { limit: ROW_PAGE_SIZE, filter, ...(cursor === undefined ? {} : { cursor }) }, ...(signal === undefined ? {} : { signal }) });
      if (answer.kind !== "REPLY") return null;
      const found = answer.body.data.items.find((item) => item.projectId === projectId);
      if (found !== undefined) return found;
      cursor = answer.body.data.nextCursor;
      if (cursor === undefined) break;
    }
  }
  return null;
}

// UI11 Projects as data (registry: "Your client preparation projects."; Order 24): the agency's projects exactly as ListProjects answers them
// (ProjectDashboardItem), grouped for the person reading — what needs a step, what Kauro is doing, what stopped, what is finished — in that
// order. ListProjects filters on the server (active by default; delivered, failed and archived apart), so each group is the page of its own
// filter: the active list splits into "needs a step" and "Kauro is working"; stopped is the failed filter; completed the delivered one. The
// stage is the project's phase in the six stages' own words (the same as the project's header and menu); the link opens the project's
// Overview, or the area of its stage when the Overview is not built. Nothing here is computed beyond the api's answer: no counts, no guesses.
import type { ListProjectsReply, ProjectDashboardItem } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";
import { pathOf } from "../../screens.ts";
import type { ProjectStage } from "../shared/project-header.tsx";
import type { PagedSource } from "../shared/use-paged-read.ts";

export const PAGE_SIZE = 50;

export type ProjectGroup = "needs" | "working" | "stopped" | "done";
export const GROUPS: readonly ProjectGroup[] = ["needs", "working", "stopped", "done"];

/** The server-side filters this page reads (ListProjects `filter`); archived projects are not listed on this work page. */
export type ProjectFilter = "active" | "failed" | "delivered";

/** Finished work is completed, a failed project stopped; an active project waiting for a step needs a step; the rest is Kauro's. */
export function groupOf(item: ProjectDashboardItem): ProjectGroup {
  if (item.phase === "DELIVERED" || item.phase === "ARCHIVED") return "done";
  if (item.phase === "FAILED") return "stopped";
  return item.requiredAction !== "NONE" ? "needs" : "working";
}

const STAGE_OF: Readonly<Record<ProjectDashboardItem["phase"], ProjectStage>> = {
  SOURCES: "files",
  HEALTH_CHECK: "check",
  PLAN: "plan",
  PURCHASE: "purchase",
  PROCESSING: "preparation",
  DELIVERED: "delivery",
  FAILED: "preparation",
  ARCHIVED: "delivery",
};

export function stageOf(item: ProjectDashboardItem): ProjectStage {
  return STAGE_OF[item.phase];
}

/** The first screen of each stage's area (screens.ts PROJECT_AREAS). */
const AREA_SCREEN: Readonly<Record<ProjectStage, string>> = { files: "UI14", check: "UI18", plan: "UI19", purchase: "UI23", preparation: "UI25", delivery: "UI26" };

/** The project's page for its stage when that page exists in this build, else its files (always built), else none: the next step's page. */
export function stageHref(agencyId: string, item: ProjectDashboardItem, implemented: ReadonlySet<string>): string | null {
  const screen = AREA_SCREEN[stageOf(item)];
  if (implemented.has(screen)) return pathOf(screen, { agencyId, id: item.projectId });
  return implemented.has("UI14") ? pathOf("UI14", { agencyId, id: item.projectId }) : null;
}

/** Where a project of the list opens: its Overview when built (which names the next step), else its stage's page. */
export function projectHref(agencyId: string, item: ProjectDashboardItem, implemented: ReadonlySet<string>): string | null {
  return implemented.has("UI13") ? pathOf("UI13", { agencyId, id: item.projectId }) : stageHref(agencyId, item, implemented);
}

/** The agency's projects of one filter, keyset-paged: the only cursor sent is the one the server issued (it is bound to its filter). */
export function projectSource(client: ApiClient, agencyId: string, filter: ProjectFilter): PagedSource<ListProjectsReply, ProjectDashboardItem> {
  return {
    load: (cursor, signal) => client.call("ListProjects", { path: { agencyId }, query: cursor === null ? { limit: PAGE_SIZE, filter } : { limit: PAGE_SIZE, filter, cursor }, signal }),
    pageOf: (body) => ({ items: body.data.items, nextCursor: body.data.nextCursor ?? null, version: `projects-${filter}` }),
  };
}

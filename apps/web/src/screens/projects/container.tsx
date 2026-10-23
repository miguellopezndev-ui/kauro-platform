"use client";
// The container of UI11 (Order 24; design D-PRIV-1, D-STATE-1): the agency's projects as three paged ListProjects reads, one per server filter
// (active, failed, delivered). A refused read draws the shared state; a list that changed between pages asks to be loaded again.
import { type ReactElement, useContext } from "react";
import { message } from "../../copy/en.ts";
import { useShell } from "../../shell/shell-context.ts";
import { ImplementedScreens } from "../shared/implemented-screens.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { usePagedRead } from "../shared/use-paged-read.ts";
import { projectHref, projectSource } from "./model.ts";
import { type ProjectPage, ProjectList } from "./view.tsx";

export function ProjectsScreen({ agencyId }: { readonly agencyId: string }): ReactElement {
  const { client } = useShell();
  const implemented = useContext(ImplementedScreens);
  const reads = [
    usePagedRead(projectSource(client, agencyId, "active"), `${agencyId}/active`),
    usePagedRead(projectSource(client, agencyId, "failed"), `${agencyId}/failed`),
    usePagedRead(projectSource(client, agencyId, "delivered"), `${agencyId}/delivered`),
  ] as const;
  const failure = reads.find((r) => r.state.status === "FAILED" && r.state.failure !== null);
  const changed = reads.find((r) => r.state.status === "CHANGED");
  const pageOf = (read: (typeof reads)[number]): ProjectPage => ({ projects: read.state.items, hasMore: read.state.hasMore, loading: read.state.status === "LOADING" || read.state.status === "IDLE", onMore: read.more });
  return (
    <>
      {failure !== undefined && failure.state.failure !== null ? <StatePanel decision={failure.state.failure} onNext={failure.reload} /> : null}
      {changed !== undefined ? (
        <section role="status">
          <p>{message("screen.projects.changed.body")}</p>
          <button type="button" className="kauro-button" onClick={() => reads.forEach((r) => r.reload())}>
            {message("screen.projects.refresh.cta")}
          </button>
        </section>
      ) : null}
      {failure === undefined && changed === undefined ? <ProjectList active={pageOf(reads[0])} failed={pageOf(reads[1])} delivered={pageOf(reads[2])} projectHref={(item) => projectHref(agencyId, item, implemented)} /> : null}
    </>
  );
}

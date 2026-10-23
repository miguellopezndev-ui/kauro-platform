"use client";
// The container of UI13 (Order 24; design D-PRIV-1, D-STATE-1): GetProject, and the project's ListProjects row for its stage and next step.
// The project's header is drawn here, once the row says where the project stands; before that (or when no row is found) the page's own name
// is its heading and no progress is drawn. A refused GetProject draws the shared state and nothing of the project.
import { type ReactElement, useContext, useEffect, useState } from "react";
import type { ProjectDashboardItem } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { ProjectContext } from "../../shell/frame.tsx";
import { useShell } from "../../shell/shell-context.ts";
import { stageHref, stageOf } from "../projects/model.ts";
import { ImplementedScreens } from "../shared/implemented-screens.ts";
import { PageHeader, ProjectHeader } from "../shared/project-header.tsx";
import { StatePanel } from "../shared/state-panel.tsx";
import { useRead } from "../shared/use-read.ts";
import { dashboardRowOf } from "./model.ts";
import { OverviewDetails } from "./view.tsx";

export function OverviewScreen({ agencyId, projectId }: { readonly agencyId: string; readonly projectId: string }): ReactElement {
  const { client } = useShell();
  const implemented = useContext(ImplementedScreens);
  const frame = useContext(ProjectContext);
  const { state, refresh } = useRead((signal) => client.call("GetProject", { path: { projectId }, signal }), projectId);
  const [row, setRow] = useState<ProjectDashboardItem | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    dashboardRowOf(client, agencyId, projectId, abort.signal).then(
      (found) => {
        if (!abort.signal.aborted) setRow(found);
      },
      () => undefined,
    );
    return () => abort.abort();
  }, [client, agencyId, projectId]);
  const header = row === null ? <PageHeader title={message("screen.overview.title")} lead={message("screen.overview.lead.body")} /> : <ProjectHeader stage={stageOf(row)} title={message("screen.overview.title")} lead={message("screen.overview.lead.body")} />;
  if (state.kind === "LOADING") return <>{header}<StatePanel decision={state.decision} /></>;
  const project = state.kind === "ANSWERED" && state.answer.kind === "REPLY" ? state.answer.body.data : null;
  if (project === null) return <>{header}<StatePanel decision={state.decision} onNext={refresh} /></>;
  const next = row === null ? null : stageHref(agencyId, row, implemented);
  return (
    <>
      {header}
      <OverviewDetails project={project} row={row} clientLabel={frame?.clientLabel ?? null} nextHref={next} />
    </>
  );
}

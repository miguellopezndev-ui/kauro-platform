// UI13 Overview as markup (Order 24): the next step first (the required action in words and the way to its page, or that nothing is needed),
// what is in the way when something blocks (the api's readiness blockers, in words), then the project's facts. Customer strings (the client's
// name, the purpose) are text nodes. Pure markup: the container owns the reads.
import { Deadline, LinkButton } from "@kauro/ui";
import type { ReactElement } from "react";
import type { ProjectDashboardItem, ProjectView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { groupOf } from "../projects/model.ts";

export interface OverviewProps {
  readonly project: ProjectView;
  /** The project's ListProjects row, or null when it could not be found (then no next step is drawn). */
  readonly row: ProjectDashboardItem | null;
  /** The client's name as the frame read it, or null before it is known. */
  readonly clientLabel: string | null;
  /** The page of the next step, when it exists in this build. */
  readonly nextHref: string | null;
}

function NextStep({ row, nextHref }: { readonly row: ProjectDashboardItem; readonly nextHref: string | null }): ReactElement {
  const group = groupOf(row);
  return (
    <section className="kauro-screen-section" aria-labelledby="overview-next">
      <h2 id="overview-next">{message("screen.overview.next.heading")}</h2>
      {group === "needs" ? (
        <>
          <p>{message(`screen.projects.action.${row.requiredAction}`)}</p>
          {row.deadline === null ? null : (
            <p className="kauro-ledger-note">
              {message("screen.projects.deadline.label")}: <Deadline at={row.deadline} timeZone="UTC" />
            </p>
          )}
          {nextHref === null ? null : <LinkButton href={nextHref}>{message("screen.overview.next.cta")}</LinkButton>}
        </>
      ) : (
        <p>{message(group === "working" ? "screen.overview.next.working.body" : group === "stopped" ? "screen.overview.next.stopped.body" : "screen.overview.next.done.body")}</p>
      )}
    </section>
  );
}

export function OverviewDetails({ project, row, clientLabel, nextHref }: OverviewProps): ReactElement {
  return (
    <>
      {row === null ? null : <NextStep row={row} nextHref={nextHref} />}
      {project.readinessBlockers.length === 0 ? null : (
        <section className="kauro-screen-section" aria-labelledby="overview-blockers">
          <h2 id="overview-blockers">{message("screen.overview.blockers.heading")}</h2>
          <ul>
            {project.readinessBlockers.map((code) => (
              <li key={code}>{message(`screen.overview.blocker.${code}`)}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="kauro-screen-section" aria-labelledby="overview-facts">
        <h2 id="overview-facts">{message("screen.overview.facts.heading")}</h2>
        <dl className="kauro-ledger-facts">
          {clientLabel === null ? null : <div><dt>{message("screen.overview.facts.client.label")}</dt><dd><bdi>{clientLabel}</bdi></dd></div>}
          <div><dt>{message("screen.overview.facts.service.label")}</dt><dd>{message(`service.${project.mode}.name`)}</dd></div>
          <div><dt>{message("screen.overview.facts.purpose.label")}</dt><dd><bdi>{project.purpose}</bdi></dd></div>
          <div><dt>{message("screen.overview.facts.state.label")}</dt><dd>{message(`screen.overview.state.${project.state}`)}</dd></div>
          <div><dt>{message("screen.overview.facts.files.label")}</dt><dd>{message(`screen.sources.revision.state.${project.currentRevision.state}`)}</dd></div>
          <div><dt>{message("screen.overview.facts.started.label")}</dt><dd><Deadline at={project.createdAt} timeZone="UTC" /></dd></div>
        </dl>
      </section>
    </>
  );
}

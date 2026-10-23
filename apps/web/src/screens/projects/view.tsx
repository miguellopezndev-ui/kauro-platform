// UI11 Projects as markup (Order 24): one section per group that has projects (an empty group is not drawn, no zero counts), each project a
// ledger item — its client and service as the heading, its stage in words, the next step, the date that matters and the last activity — and
// one link to the project. The client's name is customer text, drawn as a text node. Pure markup: the container owns the read.
import { Button, Deadline, LinkButton, StatusBadge } from "@kauro/ui";
import type { ReactElement } from "react";
import type { ProjectDashboardItem } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { stageLabel } from "../shared/project-header.tsx";
import { GROUPS, groupOf, type ProjectGroup, stageOf } from "./model.ts";

function Facts({ item }: { readonly item: ProjectDashboardItem }): ReactElement {
  return (
    <dl className="kauro-ledger-facts">
      <div>
        <dt>{message("screen.projects.stage.label")}</dt>
        <dd>
          {stageLabel(stageOf(item), item.mode)}
          {item.phase === "FAILED" ? <> <StatusBadge tone="danger">{message("screen.projects.stopped.label")}</StatusBadge></> : null}
          {item.phase === "ARCHIVED" ? <> <StatusBadge tone="neutral">{message("screen.projects.archived.label")}</StatusBadge></> : null}
        </dd>
      </div>
      <div><dt>{message("screen.projects.next.label")}</dt><dd>{message(`screen.projects.action.${item.requiredAction}`)}</dd></div>
      <div>
        <dt>{message("screen.projects.deadline.label")}</dt>
        <dd>{item.deadline === null ? message("screen.projects.deadline.none") : <Deadline at={item.deadline} timeZone="UTC" />}</dd>
      </div>
      <div><dt>{message("screen.projects.activity.label")}</dt><dd><Deadline at={item.lastActivityAt} timeZone="UTC" /></dd></div>
    </dl>
  );
}

/** One filter's page: its projects so far, whether the server holds more, whether a page is being read. */
export interface ProjectPage {
  readonly projects: readonly ProjectDashboardItem[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onMore: () => void;
}

export interface ProjectListProps {
  readonly active: ProjectPage;
  readonly failed: ProjectPage;
  readonly delivered: ProjectPage;
  /** The address of a project's page, built by the container; null when no page of the project exists in this build. */
  readonly projectHref: (item: ProjectDashboardItem) => string | null;
}

function Group({ group, projects, projectHref, more }: { readonly group: ProjectGroup; readonly projects: readonly ProjectDashboardItem[]; readonly projectHref: ProjectListProps["projectHref"]; readonly more: ProjectPage | null }): ReactElement {
  const id = `projects-${group}`;
  return (
    <section className="kauro-screen-section" aria-labelledby={id}>
      <h2 id={id}>{message(`screen.projects.group.${group}.title`)}</h2>
      <p className="kauro-ledger-note">{message(`screen.projects.group.${group}.body`)}</p>
      <ul className="kauro-ledger-list">
        {projects.map((item) => {
          const href = projectHref(item);
          return (
            <li key={item.projectId} className="kauro-ledger-item">
              <div className="kauro-ledger-item-head">
                <h3>
                  <bdi>{item.clientLabel}</bdi>
                  <span aria-hidden="true"> · </span>
                  {message(`service.${item.mode}.name`)}
                </h3>
                {href === null ? null : (
                  <LinkButton href={href} variant="secondary">
                    {message("screen.projects.open.cta")}
                  </LinkButton>
                )}
              </div>
              <Facts item={item} />
            </li>
          );
        })}
      </ul>
      {more !== null && more.hasMore ? (
        <Button variant="secondary" disabled={more.loading} onClick={more.onMore}>
          {message("screen.projects.more.cta")}
        </Button>
      ) : null}
    </section>
  );
}

export function ProjectList({ active, failed, delivered, projectHref }: ProjectListProps): ReactElement {
  const pages = [active, failed, delivered];
  if (pages.every((p) => p.projects.length === 0 && !p.loading && !p.hasMore)) {
    return (
      <section>
        <h2>{message("screen.projects.empty.title")}</h2>
        <p>{message("screen.projects.empty.body")}</p>
      </section>
    );
  }
  // the active page feeds two groups; "more" sits under the last group it feeds that is drawn
  const pageOf: Readonly<Record<ProjectGroup, ProjectPage>> = { needs: active, working: active, stopped: failed, done: delivered };
  const drawn = GROUPS.map((group) => ({ group, projects: pageOf[group].projects.filter((item) => groupOf(item) === group) })).filter((g) => g.projects.length > 0);
  const lastOfActive = [...drawn].reverse().find((g) => g.group === "needs" || g.group === "working")?.group;
  return (
    <>
      {drawn.map(({ group, projects }) => (
        <Group key={group} group={group} projects={projects} projectHref={projectHref} more={group === "needs" || group === "working" ? (group === lastOfActive ? active : null) : pageOf[group]} />
      ))}
      {active.hasMore && lastOfActive === undefined ? (
        <Button variant="secondary" disabled={active.loading} onClick={active.onMore}>
          {message("screen.projects.more.cta")}
        </Button>
      ) : null}
    </>
  );
}

"use client";
// The head of every project page (Order 11 round 2; research agency-workspace.md §5.3 and app-shell-settings.md §9.5): one anatomy on every
// page of a project, so a person returning after days rebuilds where they are without memory.
//   1. a context line: the client and the service ("Larch Studio · Prepare for HubSpot");
//   2. the h1: the project's own name, the object the page is about, never the page's name ("Overview" was the largest and least
//      informative word on the page); a status in words beside it when the page knows one;
//   3. where the project stands: the six stages of How it works, in short form, the same words as the project's areas in the menu
//      (Files, Health check, Plan, Quote and payment, Preparation, Delivery and import), each stage once (round 1 drew the preparation and
//      the delivery both as "step 5"). It is progress, not navigation: the areas in the menu are the one way to a page (no second menu);
//   4. the page's own heading (h2), its lead sentence and its one primary action, at the right from 768 px.
// The project comes from the frame (ProjectContext), which reads it once for the menu. Without it (a page whose address names no project, or
// before the project is read) the page's own name is the h1, so a page always has exactly one. A stage is said in words for assistive
// technology, never by colour alone.
import { StatusBadge, type Tone } from "@kauro/ui";
import { type ReactElement, type ReactNode, useContext } from "react";
import { message, type MessageId } from "../../copy/en.ts";
import { ProjectContext } from "../../shell/frame.tsx";

/** The six stages of a project, in How it works's order. "import" is the sixth stage's second half (a page of it, not a stage). */
export type ProjectStage = "files" | "check" | "plan" | "purchase" | "preparation" | "delivery";
export type ProjectStep = ProjectStage | "import";

const STAGES: readonly ProjectStage[] = ["files", "check", "plan", "purchase", "preparation", "delivery"];

/** A stage's short name; the sixth is "Delivery and import" where the service has an import, "Delivery" for "Clean your data". */
export function stageLabel(stage: ProjectStage, mode: "CLEAN" | "HUBSPOT" | "SALESFORCE"): string {
  const id: MessageId = stage === "delivery" && mode === "CLEAN" ? "project.stage.delivery-clean.label" : `project.stage.${stage}.label`;
  return message(id);
}

export interface ProjectHeaderProps {
  /** Where the project stands (the stage it is at), not where the page sits. */
  readonly stage: ProjectStep;
  /** The page's own name: the h2 under the project, or the h1 when no project is known. */
  readonly title: string;
  readonly lead?: ReactNode;
  /** The project's state in words, beside its name ("Waiting for your transfer"). */
  readonly status?: { readonly tone: Tone; readonly text: string };
  /** The page's one primary action (and at most one quiet secondary). */
  readonly action?: ReactNode;
}

function PageTitle({ level, title, lead, action }: { readonly level: 1 | 2; readonly title: string; readonly lead?: ReactNode; readonly action?: ReactNode }): ReactElement {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className={action === undefined ? "kauro-ptitle" : "kauro-ptitle kauro-ptitle--action"}>
      <div className="kauro-ptitle-text">
        <Heading>{title}</Heading>
        {lead === undefined ? null : <p className="kauro-ptitle-lead">{lead}</p>}
      </div>
      {action === undefined ? null : <div className="kauro-ptitle-action">{action}</div>}
    </div>
  );
}

/** The head of a page outside a project (Billing, Settings, Support, Team): its name as the h1, its lead, its one action. */
export function PageHeader({ title, lead, action }: { readonly title: string; readonly lead?: ReactNode; readonly action?: ReactNode }): ReactElement {
  return <PageTitle level={1} title={title} lead={lead} action={action} />;
}

export function ProjectHeader({ stage, title, lead, status, action }: ProjectHeaderProps): ReactElement {
  const project = useContext(ProjectContext);
  if (project === null) return <PageTitle level={1} title={title} lead={lead} action={action} />;
  const at = STAGES.indexOf(stage === "import" ? "delivery" : stage);
  const current = STAGES[at] ?? "files";
  return (
    <>
      <header className="kauro-phead">
        <p className="kauro-phead-context">
          <bdi>{project.clientLabel}</bdi>
          <span aria-hidden="true"> · </span>
          <span>{message(`service.${project.mode}.name`)}</span>
        </p>
        <div className="kauro-phead-name">
          <h1>
            <bdi>{project.name}</bdi>
          </h1>
          {status === undefined ? null : <StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
        </div>
        <div className="kauro-phead-progress">
          <p className="kauro-phead-count">{message("project.progress.count", { number: at + 1, total: STAGES.length, name: stageLabel(current, project.mode) })}</p>
          <ol className="kauro-phead-stages" aria-label={message("project.progress.label")}>
            {STAGES.map((one, index) => {
              const state = index < at ? "done" : index === at ? "current" : "later";
              return (
                <li key={one} className={`kauro-phead-stage kauro-phead-stage--${state}`} aria-current={state === "current" ? "step" : undefined}>
                  <span className="kauro-phead-stage-name">{stageLabel(one, project.mode)}</span>
                  <span className="kauro-visually-hidden-text"> ({message(`project.stages.${state}.label`)})</span>
                </li>
              );
            })}
          </ol>
        </div>
      </header>
      <PageTitle level={2} title={title} lead={lead} action={action} />
    </>
  );
}

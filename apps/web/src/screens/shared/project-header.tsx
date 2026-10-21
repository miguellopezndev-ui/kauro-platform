"use client";
// The head of every project page (Order 11, the owner's decision of 2026-10-20 on project navigation): which project this is (its client,
// its name, its service) and where the project stands, as a contextual line of the real stages of its service ("Prepare for HubSpot" and
// "Prepare for Salesforce": Files, Health check, Plan, Purchase, Delivery, Import; "Clean your data" has no import). It does not navigate:
// the project's areas are places in the side menu, and drawing them twice would make two ways to the same page. The stages before the
// page's are done, the page's is current, the rest are later; a state is said in words for assistive technology, never by colour alone.
// The project comes from the frame (ProjectContext), which reads it once for the menu; without it (a page outside a project's read) the
// header draws nothing rather than guess.
import { type ReactElement, useContext } from "react";
import { message, type MessageId } from "../../copy/en.ts";
import { ProjectContext } from "../../shell/frame.tsx";

export type ProjectStep = "files" | "check" | "plan" | "purchase" | "delivery" | "import";

const STEPS: readonly { readonly key: ProjectStep; readonly label: MessageId }[] = [
  { key: "files", label: "nav.project.files.label" },
  { key: "check", label: "nav.project.check.label" },
  { key: "plan", label: "nav.project.plan.label" },
  { key: "purchase", label: "nav.project.purchase.label" },
  { key: "delivery", label: "nav.project.delivery.label" },
  { key: "import", label: "nav.project.import.label" },
];

export function ProjectHeader({ current }: { readonly current: ProjectStep }): ReactElement | null {
  const project = useContext(ProjectContext);
  if (project === null) return null;
  const steps = project.mode === "CLEAN" ? STEPS.filter((step) => step.key !== "import") : STEPS;
  const at = Math.max(0, steps.findIndex((step) => step.key === current));
  return (
    <header className="kauro-project-header">
      <p className="kauro-project-header-context">
        <bdi>{project.clientLabel}</bdi>
        <span aria-hidden="true"> · </span>
        <span>{message(`service.${project.mode}.name`)}</span>
      </p>
      <p className="kauro-project-header-name">
        <bdi>{project.name}</bdi>
      </p>
      <div className="kauro-project-progress">
        <p className="kauro-project-progress-count">{message("project.progress.count", { number: at + 1, total: steps.length, name: message(steps[at]?.label ?? "nav.project.files.label") })}</p>
        <ol className="kauro-project-progress-steps" aria-label={message("project.progress.label")}>
          {steps.map((step, index) => {
            const state = index < at ? "done" : index === at ? "current" : "later";
            return (
              <li key={step.key} className={`kauro-project-step kauro-project-step--${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span className="kauro-project-step-name">{message(step.label)}</span>
                <span className="kauro-visually-hidden-text"> ({message(`project.stages.${state}.label`)})</span>
              </li>
            );
          })}
        </ol>
      </div>
    </header>
  );
}

"use client";
// The six stages of a project (Order 11): the project's own sub-navigation, on every project page, in How it works's words (its stage
// headings, the same catalogue entries), so what a buyer read on the public site is what they walk inside. A page belongs to one stage,
// and the product's order makes the rest true without reading anything: a quote exists only after an approved plan, a preparation only
// after a payment, an audit only after a sealed set. The stages before the page's are done, the page's is current, the ones after it are
// later. Only a done or current stage links, and only to a page this build has (the review shows every page, so it widens the set).
// A state is said in words for assistive technology, never by colour alone.
import { createContext, type ReactElement, useContext } from "react";
import { message, type MessageId } from "../../copy/en.ts";
import { IMPLEMENTED_SCREENS, pathOf } from "../../screens.ts";
import { AnchorContext } from "../../shell/frame.tsx";

export type ProjectStage = "files" | "check" | "decide" | "quote" | "prepare" | "import";

const STAGES: readonly { readonly key: ProjectStage; readonly heading: MessageId; readonly screen: string }[] = [
  { key: "files", heading: "how.stage.files.heading", screen: "UI14" },
  { key: "check", heading: "how.stage.check.heading", screen: "UI18" },
  { key: "decide", heading: "how.stage.decide.heading", screen: "UI19" },
  { key: "quote", heading: "how.stage.quote.heading", screen: "UI23" },
  { key: "prepare", heading: "how.stage.prepare.heading", screen: "UI25" },
  { key: "import", heading: "how.stage.import.heading", screen: "UI26" },
];

/** The screens this build has; a review of every screen provides a wider set. */
export const ImplementedScreens = createContext<ReadonlySet<string>>(IMPLEMENTED_SCREENS);

export function ProjectStages({ agencyId, projectId, current }: { readonly agencyId: string; readonly projectId: string | null; readonly current: ProjectStage }): ReactElement {
  const implemented = useContext(ImplementedScreens);
  const Link = useContext(AnchorContext);
  const at = STAGES.findIndex((stage) => stage.key === current);
  return (
    <nav className="kauro-stages" aria-label={message("project.stages.label")}>
      <p className="kauro-stages-count" aria-hidden="true">
        {message("project.stages.count", { number: at + 1, total: STAGES.length })}
        <span className="kauro-stages-current"> · {message(STAGES[at]?.heading ?? "how.stage.files.heading")}</span>
      </p>
      <ol>
        {STAGES.map((stage, index) => {
          const state = index < at ? "done" : index === at ? "current" : "later";
          const name = (
            <>
              <span className="kauro-stage-mark" aria-hidden="true">
                {index + 1}
              </span>
              <span className="kauro-stage-name">{message(stage.heading)}</span>
              <span className="kauro-stages-hidden"> ({message(`project.stages.${state}.label`)})</span>
            </>
          );
          const href = projectId !== null && state !== "later" && implemented.has(stage.screen) ? pathOf(stage.screen, { agencyId, id: projectId }) : null;
          return (
            <li key={stage.key} className={`kauro-stage kauro-stage--${state}`} aria-current={state === "current" ? "step" : undefined}>
              {href === null ? (
                <span className="kauro-stage-link">{name}</span>
              ) : (
                <Link href={href} prefetch={false}>
                  <span className="kauro-stage-link">{name}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

"use client";
// What every review page draws (Order 11): the review strip (synthetic data, who the application is shown to, a way to change it, the way
// back to the review's index), then the screen inside the real application shell. A real screen arrives as `children` (its own page,
// rendered by the server); a prototype is drawn here from the state the review asks for.
import { type ReactElement, type ReactNode, useMemo } from "react";
import { CONTEXTS, type ContextKey } from "./contexts.ts";
import { proposalOf } from "./proposals.ts";
import { agencyFor } from "./world.ts";
import { agencyOfPathname } from "@web/screens.ts";
import { asHref, REVIEW } from "./links.ts";
import { ReviewShell } from "./review-shell.tsx";
import { scriptOf } from "./scenario.ts";
import { screenDef } from "./screens.tsx";

const PEOPLE: readonly ContextKey[] = ["newcomer", "agency", "company", "admin", "operator", "owner", "seller", "outsider"];

export function FrameHost({ id, context, state, pathname, children }: { readonly id: string; readonly context: ContextKey; readonly state: string; readonly pathname: string; readonly children: ReactNode }): ReactElement {
  const def = screenDef(id);
  const stateDef = def.states.find((candidate) => candidate.key === state) ?? def.states[0];
  // the workspace a prototype draws is the one its address names, as this person sees it (their own role there), never only their first
  const base = CONTEXTS[context];
  const pathAgency = agencyOfPathname(pathname);
  const ctx = pathAgency === null ? base : { ...base, agency: agencyFor(context, pathAgency) ?? base.agency };
  const script = useMemo(() => {
    const fixed = stateDef === undefined ? {} : scriptOf(stateDef, context);
    return () => fixed;
  }, [stateDef, context]);
  const Prototype = def.Prototype;
  return (
    <>
      <div className="kauro-review-strip" role="note" aria-label="Review">
        <span className="kauro-review-strip-tag">Review</span>
        <span>Synthetic data. Nothing is sent or saved.</span>
        <details className="kauro-review-who">
          <summary>
            Seen as <strong>{ctx.label}</strong>
          </summary>
          <ul>
            {PEOPLE.map((key) => (
              <li key={key}>
                <a href={asHref(key)} aria-current={key === context ? "true" : undefined}>
                  <strong>{CONTEXTS[key].label}</strong>
                  <span>{CONTEXTS[key].who}</span>
                </a>
              </li>
            ))}
          </ul>
        </details>
        {id === "UI32" ? (
          <a href={`${pathname}?review-proposal=P-02`}>See the proposed complete design of this page (P-02)</a>
        ) : null}
        {id === "P-02" ? <a href={pathname}>Back to the page as built (UI32)</a> : null}
        {id === "UI18" ? <a href={`${pathname}?review-proposal=P-07`}>See the proposed results page (P-07)</a> : null}
        {id === "P-07" ? <a href={pathname}>Back to the check as built (UI18)</a> : null}
        <a className="kauro-review-strip-index" href={REVIEW}>
          All screens and states
        </a>
      </div>
      <ReviewShell appPath={proposalOf(id)?.anonymous === true ? "/login" : pathname} context={context} script={script}>
        {children ?? (Prototype === undefined ? <NotDesigned id={id} /> : <Prototype ctx={ctx} state={stateDef?.key ?? "normal"} />)}
      </ReviewShell>
    </>
  );
}

/** A screen of a later group: said plainly, in the review's voice, never dressed as part of the product. */
function NotDesigned({ id }: { readonly id: string }): ReactElement {
  return (
    <div className="kauro-review-pending">
      <p className="kauro-review-strip-tag">Review</p>
      <h1>{id} is not designed yet</h1>
      <p>This screen belongs to a later review group. Group A is designed first; the rest follow once it is right.</p>
    </div>
  );
}

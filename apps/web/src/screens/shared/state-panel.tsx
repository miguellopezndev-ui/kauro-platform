// The shared states of a screen as markup (design D-STATE-1; reference "Shared states"): the title and body of the state, the support
// reference and the retry hint the decision carries, and the one next step as a control the screen wires. Pure markup: no hooks, so a
// node test renders it. A pending or uncertain state says not to repeat the action (`discouragesRepeat`), and never reads as a failure.
import type { ReactElement } from "react";
import { message, nextStepLabel, stateCopy } from "../../copy/en.ts";
import type { StateDecision } from "../../client/states.ts";

export interface StatePanelProps {
  readonly decision: StateDecision;
  /** Wired by the screen for the state's one next step (reload, check again, step-up…); absent: the step is words only. */
  readonly onNext?: (() => void) | undefined;
}

const ALERTING = new Set(["DENIED", "RESTRICTED", "INTEGRITY_FAILURE", "UNCERTAIN", "STALE", "EXPIRED", "UNSAVED"]);

export function StatePanel({ decision, onNext }: StatePanelProps): ReactElement {
  const copy = stateCopy(decision.state);
  const label = nextStepLabel(decision.next);
  const role = decision.state === "LOADING" || decision.state === "PENDING" ? "status" : ALERTING.has(decision.state) ? "alert" : undefined;
  return (
    <section className="kauro-state" data-state={decision.state} role={role} aria-busy={decision.state === "LOADING" ? true : undefined}>
      <h2 tabIndex={-1}>{copy.title}</h2>
      <p>{copy.body}</p>
      {decision.supportReference === null ? null : <p>{message("state.support-reference.body", { reference: decision.supportReference })}</p>}
      {decision.retryAfterSeconds === null ? null : <p>{message("state.retry-after.hint", { seconds: decision.retryAfterSeconds })}</p>}
      {label === null || onNext === undefined ? null : (
        <button type="button" className="kauro-button" onClick={onNext}>
          {label}
        </button>
      )}
    </section>
  );
}

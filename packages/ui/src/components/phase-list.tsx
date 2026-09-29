import type { ReactElement, ReactNode } from "react";
import { CLASS, cx } from "../internal/class-names.js";
import { Icon } from "../internal/icon.js";
import type { IconName } from "../internal/icon.js";

export type PhaseState = "done" | "current" | "upcoming" | "failed";

export interface Phase {
  readonly id: string;
  readonly label: string;
  readonly state: PhaseState;
  /** What the phase is doing or why it failed, in words. */
  readonly detail?: ReactNode;
}

export interface PhaseListProps {
  /** The list's accessible name, for example "Progress". */
  readonly label: string;
  readonly phases: readonly Phase[];
  /** The word for each state ("Done", "In progress", "Not started", "Failed"): the state is written, not only drawn. */
  readonly copy: Readonly<Record<PhaseState, string>>;
}

const STATE_CLASS: Readonly<Record<PhaseState, string>> = Object.freeze({
  done: CLASS.phaseDone,
  current: CLASS.phaseCurrent,
  upcoming: CLASS.phaseUpcoming,
  failed: CLASS.phaseFailed,
});

const STATE_ICON: Readonly<Record<PhaseState, IconName>> = Object.freeze({
  done: "success",
  current: "current",
  upcoming: "upcoming",
  failed: "danger",
});

/**
 * PhaseList (D-DS-1): the phases of a job in order, each with an icon and the word for its state. There is never a percentage
 * and never a progress bar: a job has phases, not a measured fraction of completion. The phase in progress is marked
 * aria-current="step".
 */
export function PhaseList({ label, phases, copy }: PhaseListProps): ReactElement {
  const ids = new Set<string>();
  for (const phase of phases) {
    if (!Object.hasOwn(STATE_CLASS, phase.state)) throw new RangeError(`unknown phase state: ${JSON.stringify(phase.state)}`);
    if (ids.has(phase.id)) throw new RangeError(`phase id repeated: ${phase.id}`);
    ids.add(phase.id);
  }
  if (phases.filter((phase) => phase.state === "current").length > 1) throw new RangeError("at most one phase is in progress");
  return (
    <ol className={CLASS.phaseList} aria-label={label}>
      {phases.map((phase) => (
        <li key={phase.id} className={cx(CLASS.phase, STATE_CLASS[phase.state])} aria-current={phase.state === "current" ? "step" : undefined}>
          <Icon name={STATE_ICON[phase.state]} />
          <span className={CLASS.phaseLabel}>{phase.label}</span>
          <span className={CLASS.phaseState}>{copy[phase.state]}</span>
          {phase.detail === undefined ? null : <span>{phase.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

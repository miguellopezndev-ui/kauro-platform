"use client";
// One command of a screen (design D-OPS-1; case S066): the OperationRunner decides keys and retries; this hook holds the run's outcome and
// refuses a second activation while one is in flight (the runner joins it anyway: correctness never depends on the disabled button).
import { useCallback, useRef, useState } from "react";
import { OperationRunner, browserRunnerDeps, type RunOutcome } from "../../client/operation-runner.ts";
import { type StateDecision, stateOfRun } from "../../client/states.ts";

let sharedRunner: OperationRunner | null = null;
/** One runner per page: its in-flight table is what joins a double activation. */
export function pageRunner(): OperationRunner {
  sharedRunner ??= new OperationRunner(browserRunnerDeps());
  return sharedRunner;
}

export type RunState<Data> = { readonly kind: "IDLE" } | { readonly kind: "RUNNING" } | { readonly kind: "DONE"; readonly outcome: RunOutcome<Data>; readonly decision: StateDecision };

export function useCommand<Data>(start: () => Promise<RunOutcome<Data>>): { readonly state: RunState<Data>; readonly run: () => void } {
  const [state, setState] = useState<RunState<Data>>({ kind: "IDLE" });
  const running = useRef(false);
  const latest = useRef(start);
  latest.current = start;
  const run = useCallback(() => {
    if (running.current) return;
    running.current = true;
    setState({ kind: "RUNNING" });
    void latest.current().then(
      (outcome) => {
        running.current = false;
        setState({ kind: "DONE", outcome, decision: stateOfRun(outcome) });
      },
      () => {
        running.current = false;
        setState({ kind: "IDLE" });
      },
    );
  }, []);
  return { state, run };
}

"use client";
// One read of a screen (design D-STATE-1, D-PRIV-1): while it is in flight the previous private view is gone (LOADING); the answer is
// classified once by `stateOfAnswer`; `refresh` reads the same resource again (never a new command). A read that changed under the
// screen's feet is dropped (a stale answer never replaces a newer one), and unmounting aborts it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiAnswer } from "../../client/answer.ts";
import { loading, type ReadClassifiers, type StateDecision, stateOfAnswer } from "../../client/states.ts";

export type ReadState<Body> = { readonly kind: "LOADING"; readonly decision: StateDecision } | { readonly kind: "ANSWERED"; readonly answer: ApiAnswer<Body>; readonly decision: StateDecision };

export function useRead<Body>(load: (signal: AbortSignal) => Promise<ApiAnswer<Body>>, identity: string, classifiers: ReadClassifiers<Body> = {}): { readonly state: ReadState<Body>; readonly refresh: () => void } {
  const [state, setState] = useState<ReadState<Body>>({ kind: "LOADING", decision: loading() });
  const [round, setRound] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  const classify = useRef(classifiers);
  classify.current = classifiers;
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "LOADING", decision: loading() });
    void latest.current(controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      setState({ kind: "ANSWERED", answer, decision: stateOfAnswer(answer, classify.current) });
    });
    return () => controller.abort();
  }, [identity, round]);
  const refresh = useCallback(() => setRound((value) => value + 1), []);
  return { state, refresh };
}

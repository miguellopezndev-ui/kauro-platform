"use client";
// One read of a screen (design D-STATE-1, D-PRIV-1): while it is in flight the previous private view is gone (LOADING); the answer is
// classified once by `stateOfAnswer`; `refresh` reads the same resource again (never a new command). A read that changed under the
// screen's feet is dropped (a stale answer never replaces a newer one), and unmounting aborts it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiAnswer } from "../../client/answer.ts";
import { loading, readRefused, type ReadClassifiers, type StateDecision, stateOfAnswer } from "../../client/states.ts";

export type ReadState<Body> =
  | { readonly kind: "LOADING"; readonly decision: StateDecision }
  | { readonly kind: "ANSWERED"; readonly answer: ApiAnswer<Body>; readonly decision: StateDecision }
  /** The load rejected before any answer (the client refused to send): a stated failure, never a LOADING nothing will replace. */
  | { readonly kind: "ERROR"; readonly decision: StateDecision };

/** Runs one load to its state; null when the read was dropped (aborted) before it settled, whether it answered or rejected. */
export async function settleRead<Body>(load: (signal: AbortSignal) => Promise<ApiAnswer<Body>>, signal: AbortSignal, classifiers: ReadClassifiers<Body> = {}): Promise<ReadState<Body> | null> {
  let state: ReadState<Body>;
  try {
    const answer = await load(signal);
    state = { kind: "ANSWERED", answer, decision: stateOfAnswer(answer, classifiers) };
  } catch {
    state = { kind: "ERROR", decision: readRefused() };
  }
  return signal.aborted ? null : state;
}

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
    void settleRead(latest.current, controller.signal, classify.current).then((settled) => {
      if (settled !== null) setState(settled);
    });
    return () => controller.abort();
  }, [identity, round]);
  const refresh = useCallback(() => setRound((value) => value + 1), []);
  return { state, refresh };
}

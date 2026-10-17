// The behaviour the interactive pieces of the public site share (journey, audience, package): a set of tabs that is a plain stack of panels
// until the script runs (every panel readable without it), then one panel at a time, moved with the arrow keys as the ARIA tabs pattern
// asks; and a number that counts up to its value when its panel opens, unless the visitor asked for less motion.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface Tabs {
  /** The tab shown. */
  readonly index: number;
  readonly select: (index: number) => void;
  /** False until the script runs: the panels are then all shown, one after the other. */
  readonly ready: boolean;
  /** The tab buttons, so the keyboard can move focus between them. */
  readonly refs: { current: Array<HTMLButtonElement | null> };
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useTabs(count: number, initial = 0): Tabs {
  const [index, setIndex] = useState(initial);
  const [ready, setReady] = useState(false);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => setReady(true), []);
  const select = (next: number): void => setIndex(Math.max(0, Math.min(count - 1, next)));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const moves: Readonly<Record<string, number>> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: count - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = (target + count) % count;
    setIndex(next);
    refs.current[next]?.focus();
  };
  return { index, select, ready, refs, onKeyDown };
}

const reducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A figure that runs from `from` to `to` over `ms` once `run` is true; the final value at once for reduced motion and before the script. */
export function useCountUp(to: number, run: boolean, from = 0, ms = 900): number {
  const [value, setValue] = useState(to);
  useEffect(() => {
    if (!run || reducedMotion()) {
      setValue(to);
      return undefined;
    }
    let frame = 0;
    // the first frame's own timestamp starts the run, so the hook never reads the clock itself (K0)
    let start = -1;
    const tick = (now: number): void => {
      if (start < 0) start = now;
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    setValue(from);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, run, from, ms]);
  return value;
}

// A number that counts to its value when the step that shows it opens (the Home journey), unless the visitor asked for less motion.
// It never reads the clock itself (K0): the run starts on the first animation frame's own timestamp.
import { useEffect, useState } from "react";

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

"use client";

// The six steps of How it works as one process the reader walks down (Order 10, owner review). On a wide screen the steps are read on the
// left and one window of the product stays beside them: it starts at step 01 with the rest still to come, and as each step is reached the
// same window is brought up to date (the step before is ticked off, the current one is shown with its fragment) instead of a new picture
// appearing. Nothing moves until the reader scrolls, and the window only changes state. On a narrow screen, or without the script, every
// step shows its own fragment beneath it, as a plain list.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

export interface FlowStep {
  readonly key: string;
  readonly actor: "team" | "kauro";
  readonly actorLabel: string;
  readonly heading: string;
  readonly body: string;
  readonly pane: ReactNode;
}

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const two = (n: number): string => String(n).padStart(2, "0");

export function HowFlow({ steps, brand, project }: { readonly steps: readonly FlowStep[]; readonly brand: string; readonly project: string }): ReactElement {
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    setReady(true);
    let frame = 0;
    // the step being read is the last one whose top has passed a line a little above the middle of the window
    const read = (): void => {
      frame = 0;
      const items = list.current?.children;
      if (items === undefined) return;
      const line = window.innerHeight * 0.45;
      let index = 0;
      for (let i = 0; i < items.length; i += 1) if ((items[i]?.getBoundingClientRect().top ?? Infinity) <= line) index = i;
      setActive(index);
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  const current = steps[active];
  return (
    <div className={cx("kauro-flow", ready && "is-ready")}>
      <ol ref={list} className="kauro-site-timeline kauro-steps">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className={cx(
              "kauro-site-timeline-step",
              `kauro-site-timeline-step--${step.actor}`,
              "kauro-step",
              ready && index < active && "is-done",
              ready && index === active && "is-current",
              ready && index > active && "is-ahead",
            )}
          >
            <div className="kauro-step-text">
              <p className="kauro-site-actor">{step.actorLabel}</p>
              <h3>{step.heading}</h3>
              <p>{step.body}</p>
            </div>
            <div className="kauro-step-pane">{step.pane}</div>
          </li>
        ))}
      </ol>
      {ready ? (
        <div className="kauro-flow-window kauro-paper" aria-hidden="true">
          <p className="kauro-flow-bar">
            <span className="kauro-flow-brand">{brand}</span>
            <span className="kauro-flow-title">{project}</span>
            <span className="kauro-flow-count">{`${two(active + 1)} / ${two(steps.length)}`}</span>
          </p>
          <ol className="kauro-flow-progress">
            {steps.map((step, index) => (
              <li key={step.key} className={cx("kauro-flow-row", `kauro-flow-row--${step.actor}`, index < active && "is-done", index === active && "is-current", index > active && "is-ahead")}>
                <span className="kauro-flow-number">{two(index + 1)}</span>
                <span className="kauro-flow-name">{step.heading}</span>
              </li>
            ))}
          </ol>
          <div key={current?.key} className="kauro-flow-detail">
            {current?.pane}
          </div>
        </div>
      ) : null}
    </div>
  );
}

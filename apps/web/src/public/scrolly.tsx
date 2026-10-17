"use client";

// The six steps of How it works, read by scrolling (A10 §7): the steps are one ordered list, and on a wide screen the product pane of the
// step being read stays beside them and changes as the reader moves down. The panes are drawn on the server (artifacts.tsx) and handed in;
// before the script runs, and on a narrow screen, each pane simply sits under its step.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

export interface ScrollyStep {
  readonly key: string;
  readonly actor: "team" | "kauro";
  readonly actorLabel: string;
  readonly heading: string;
  readonly body: string;
  readonly pane: ReactNode;
}

export function Scrolly({ steps }: { readonly steps: readonly ScrollyStep[] }): ReactElement {
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  const items = useRef<Array<HTMLLIElement | null>>([]);
  useEffect(() => {
    setReady(true);
    if (typeof IntersectionObserver === "undefined") return undefined;
    // the step whose middle crosses the middle band of the screen is the one being read
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = items.current.indexOf(entry.target as HTMLLIElement);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const item of items.current) if (item !== null) observer.observe(item);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={ready ? "kauro-scrolly is-ready" : "kauro-scrolly"}>
      <ol className="kauro-site-timeline">
        {steps.map((step, index) => (
          <li
            key={step.key}
            ref={(element) => {
              items.current[index] = element;
            }}
            className={`kauro-site-timeline-step kauro-site-timeline-step--${step.actor}${index === active ? " is-active" : ""}${index < active ? " is-past" : ""}`}
          >
            <p className="kauro-site-actor">{step.actorLabel}</p>
            <h3>{step.heading}</h3>
            <p>{step.body}</p>
            <div className="kauro-scrolly-inline">{step.pane}</div>
          </li>
        ))}
      </ol>
      <div className="kauro-scrolly-stage" aria-hidden="true">
        <div className="kauro-scrolly-sticky">
          <p className="kauro-scrolly-count">{`${String(active + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}`}</p>
          {steps.map((step, index) => (
            <div key={step.key} className={index === active ? "kauro-scrolly-pane is-active" : "kauro-scrolly-pane"}>
              {step.pane}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

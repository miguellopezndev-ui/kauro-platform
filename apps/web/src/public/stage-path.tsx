"use client";

// How it works, the six stages (owner's section review, 2026-10-21): one section instead of an overview followed by six sheets. The stages
// are a timeline that runs down, the numbers joined by a rule; choosing one opens what happens, what you get and what stops it. On a wide
// screen the timeline is the index on the left and the chosen stage reads in a panel beside it; on a narrow one the chosen stage opens
// under its own name (as GOV.UK's step-by-step and Airtable's sections do). On a wide screen every card has the height of the tallest, so
// the panel and its previous and next never move as the stages change. One stage is open at a time: the first on a wide screen, none
// on a narrow one until it is chosen. The open stage ends with the previous and next stage.
//
// It never hides anything it cannot give back: rendered without a script (and in print) every stage is open, in order, as a plain list. The
// script only marks the list ready and then shows one stage. A link to #stage-<key> opens that stage. Nothing moves on its own: a stage
// changes only when it is chosen.
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { PUBLIC_COPY } from "../copy/public.ts";

export interface PathStage {
  readonly key: string;
  readonly number: string;
  readonly name: string;
  readonly actor: "team" | "kauro";
  readonly actorLabel: string;
  readonly outcome: string;
  /** The stage itself: its summary, what you get, what stops it and the folded detail (server-rendered). */
  readonly sheet: ReactNode;
}

const WIDE = "(min-width: 62rem)";

export function StagePath({ stages }: { readonly stages: readonly PathStage[] }): ReactElement {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  // how the chosen stage is brought into view on a narrow screen: always after previous or next, only when out of sight after a tap
  const moved = useRef<"always" | "if-hidden" | null>(null);

  const fromHash = useCallback((): void => {
    const index = stages.findIndex((stage) => `#stage-${stage.key}` === window.location.hash);
    if (index >= 0) setOpen(index);
  }, [stages]);

  useEffect(() => {
    setReady(true);
    // a wide screen always shows one stage beside the timeline; a narrow one starts with the six closed, a short list to open from
    if (!window.matchMedia(WIDE).matches) setOpen(-1);
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [fromHash]);

  // after a stage was chosen on a narrow screen, its name is in view, below the site header (the stage that closed above it may have
  // pulled it up, and previous or next starts reading at the name)
  useEffect(() => {
    const how = moved.current;
    moved.current = null;
    const button = buttons.current[open];
    if (how === null || button === null || button === undefined || window.matchMedia(WIDE).matches) return;
    const top = button.getBoundingClientRect().top;
    const header = document.querySelector(".kauro-site-header")?.getBoundingClientRect().bottom ?? 0;
    if (how === "always" || top < header || top > window.innerHeight) button.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [open]);

  const choose = (index: number): void => {
    moved.current = "if-hidden";
    // a narrow screen may close the open stage again; a wide one always shows one
    setOpen((current) => (current === index && !window.matchMedia(WIDE).matches ? -1 : index));
  };
  const step = (index: number): void => {
    moved.current = "always";
    setOpen(index);
    buttons.current[index]?.focus({ preventScroll: true });
  };

  return (
    <div className="kauro-path" data-ready={ready ? "" : undefined}>
      <ol className="kauro-path-list">
        {stages.map((stage, index) => {
          const isOpen = !ready || open === index;
          const previous = stages[index - 1];
          const next = stages[index + 1];
          return (
            <li key={stage.key} id={`stage-${stage.key}`} className={`kauro-stage kauro-stage--${stage.actor} kauro-path-stage`} data-open={ready && open === index ? "" : undefined}>
              <div className="kauro-path-head">
                <span className="kauro-path-number" aria-hidden="true">
                  {stage.number}
                </span>
                <h3 className="kauro-path-name">
                  <button
                    type="button"
                    ref={(element) => {
                      buttons.current[index] = element;
                    }}
                    id={`stage-${stage.key}-button`}
                    aria-expanded={ready ? open === index : undefined}
                    aria-controls={`stage-${stage.key}-panel`}
                    disabled={!ready}
                    onClick={() => choose(index)}
                  >
                    {stage.name}
                  </button>
                </h3>
                <span className={`kauro-r2-actor kauro-r2-actor--${stage.actor}`}>{stage.actorLabel}</span>
                <span className="kauro-path-outcome">{stage.outcome}</span>
                <span className="kauro-path-sign" aria-hidden="true" />
              </div>
              <div id={`stage-${stage.key}-panel`} className="kauro-path-panel" role="region" aria-labelledby={`stage-${stage.key}-button`} hidden={!isOpen}>
                <div className="kauro-path-panel-head" aria-hidden="true">
                  <p className="kauro-path-panel-title">
                    <span className="kauro-path-panel-number">{stage.number}</span> {stage.name}
                  </p>
                  <span className={`kauro-r2-actor kauro-r2-actor--${stage.actor}`}>{stage.actorLabel}</span>
                </div>
                {stage.sheet}
                {ready ? (
                  <div className="kauro-path-turn">
                    {previous === undefined ? (
                      <span />
                    ) : (
                      <button type="button" className="kauro-path-turn-previous" onClick={() => step(index - 1)}>
                        <span className="kauro-path-turn-label">{PUBLIC_COPY["how.path.previous"]}</span>
                        <span className="kauro-path-turn-name">
                          {previous.number} {previous.name}
                        </span>
                      </button>
                    )}
                    {next === undefined ? null : (
                      <button type="button" className="kauro-path-turn-next" onClick={() => step(index + 1)}>
                        <span className="kauro-path-turn-label">{PUBLIC_COPY["how.path.next"]}</span>
                        <span className="kauro-path-turn-name">
                          {next.number} {next.name}
                        </span>
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

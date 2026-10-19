"use client";

// The six steps of How it works as one process the reader walks through (Order 10, owner review). On a wide screen, once the section is
// in the middle of the screen it holds still: the timeline on the left and one window of the product on the right stay where they are,
// and each further stretch of scrolling moves the process one step on (back again when the reader scrolls up). The timeline is brought
// up to date instead of scrolling, and the window shows the project at that step, doing what the step says: the files are dropped in and
// sealed, the check measures them, the decision is taken, the quote is printed, the counts reconcile, the files go to the team in order.
// After step 06 the page scrolls on as usual. The ordered list underneath is what assistive technology reads, and what a phone or a
// browser without the script shows: every step with its fragment, one under the other.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { PUBLIC_COPY, copy } from "../copy/public.ts";
import { useCountUp } from "./count-up.ts";
import { FileName } from "./parts.tsx";
import { formatCount, formatUsd, startingPrice } from "./pricing-bands.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";
import { JOURNEY_ROWS, MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_SOURCES, sharePercent } from "./sample-data.ts";

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
/** How much of a stretch of scrolling moves the process on: a short scroll past the middle of a stretch is enough. */
const AHEAD = 0.6;

const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
const countOf = (label: string): number => REPORT_ROWS.find((row) => row.label === label)?.count ?? 0;

/** What the window says the project is doing at each step. */
const STATE = [
  PUBLIC_COPY["how.frag.sealed"],
  PUBLIC_COPY["home.app.phase.check.label"],
  PUBLIC_COPY["home.frag.awaiting"],
  PUBLIC_COPY["how.frag.quote"],
  PUBLIC_COPY["home.app.phase.prepare.label"],
  PUBLIC_COPY["home.app.phase.deliver.body"],
];

/** 01: the source files are dropped into the project, one after the other, and the set is sealed. */
function Upload(): ReactElement {
  const rows = [SAMPLE.contacts, companies?.source ?? 0];
  return (
    <div className="kauro-scene kauro-scene--upload">
      <div className="kauro-scene-drop">
        {SAMPLE_SOURCES.map((file, index) => (
          <div key={file} className="kauro-scene-file">
            <span className="kauro-scene-file-icon" />
            <FileName>{file}</FileName>
            <span className="kauro-scene-file-rows">{copy("home.files.rows", { count: formatCount(rows[index] ?? 0) })}</span>
          </div>
        ))}
      </div>
      <span className="kauro-scene-seal">{PUBLIC_COPY["how.frag.sealed"]}</span>
    </div>
  );
}

function Bar({ count, label, run }: { readonly count: number; readonly label: string; readonly run: boolean }): ReactElement {
  const shown = useCountUp(count, run);
  const share = sharePercent(count, SAMPLE.contacts);
  return (
    <li className="kauro-scene-bar">
      <span className="kauro-scene-bar-figure">{formatCount(shown)}</span>
      <span className="kauro-scene-bar-label">{label}</span>
      <span className="kauro-scene-bar-share">{share}</span>
      {/* the bar is the share of the file, drawn against the largest finding */}
      <svg className="kauro-scene-bar-track" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        <rect className="kauro-scene-bar-fill" width={Math.round((count / countOf("sample.report.company")) * 100)} height="4" />
      </svg>
    </li>
  );
}

/** 02: the free check measures the whole file: what it finds, as counts and as shares of the file. */
function Check(): ReactElement {
  return (
    <div className="kauro-scene kauro-scene--check">
      <p className="kauro-scene-caption">{copy("home.app.phase.check.body", { count: formatCount(SAMPLE.contacts) })}</p>
      <ul className="kauro-scene-bars">
        <Bar count={countOf("sample.report.duplicates")} label={PUBLIC_COPY["home.frag.candidates"]} run />
        <Bar count={countOf("sample.report.emails")} label={PUBLIC_COPY["home.frag.invalid"]} run />
        <Bar count={countOf("sample.report.company")} label={PUBLIC_COPY["home.frag.company"]} run />
      </ul>
    </div>
  );
}

/** 03: a proposed change waits for the team: two records that may be one, and the approval that unifies them. */
function Decide(): ReactElement {
  const pair = JOURNEY_ROWS.filter((row) => row.flags.includes("duplicate"));
  return (
    <div className="kauro-scene kauro-scene--decide">
      <div className="kauro-scene-pair">
        {pair.map((row) => (
          <div key={row.id} className="kauro-scene-record">
            <span className="kauro-scene-record-name">{row.name}</span>
            <span className="kauro-scene-record-email">{row.email}</span>
            <span className="kauro-scene-record-company">{row.company ?? "—"}</span>
          </div>
        ))}
      </div>
      <div className="kauro-scene-proposal">
        <span className="kauro-scene-proposal-change">{copy("home.frag.unify", { count: contacts?.unified ?? 0 })}</span>
        <span className="kauro-scene-proposal-state">
          <span className="kauro-scene-proposal-waiting">{PUBLIC_COPY["home.frag.awaiting"]}</span>
          <span className="kauro-scene-proposal-done">{copy("home.app.phase.decide.body", { count: formatCount(contacts?.unified ?? 0) })}</span>
        </span>
        <span className="kauro-scene-approve">{PUBLIC_COPY["home.frag.approve"]}</span>
      </div>
    </div>
  );
}

/** 04: the quote, priced from the exact number of billable source units in the sealed files. */
function Quote(): ReactElement {
  const [currency, ...amount] = formatUsd(startingPrice("CLEAN")).split(" ");
  return (
    <div className="kauro-scene kauro-scene--quote">
      <div className="kauro-scene-receipt">
        <p className="kauro-scene-receipt-title">{PUBLIC_COPY["how.frag.quote"]}</p>
        <p className="kauro-scene-receipt-line">
          <span>{PUBLIC_COPY["pricing.table.units.label"]}</span>
          <span>{formatCount(SAMPLE.contacts)}</span>
        </p>
        <p className="kauro-scene-receipt-line">
          <span>{PUBLIC_COPY["services.clean.name"]}</span>
          <span className="kauro-scene-receipt-price">
            <span className="kauro-scene-receipt-currency">{currency}</span> {amount.join(" ")}
          </span>
        </p>
        <p className="kauro-scene-receipt-valid">{copy("how.frag.valid", { days: POLICY_SNAPSHOT.quoteDays })}</p>
      </div>
    </div>
  );
}

/** 05: Kauro runs the approved plan: what came in, less what was unified, is what goes out, and the delivery is written. */
function Prepare(): ReactElement {
  return (
    <div className="kauro-scene kauro-scene--prepare">
      <p className="kauro-scene-sum">
        <span className="kauro-scene-term">{formatCount(contacts?.source ?? 0)}</span>
        <span className="kauro-scene-term kauro-scene-term--op">−</span>
        <span className="kauro-scene-term">{formatCount(contacts?.unified ?? 0)}</span>
        <span className="kauro-scene-term kauro-scene-term--op">=</span>
        <span className="kauro-scene-term kauro-scene-term--total">{formatCount(contacts?.rows ?? 0)}</span>
      </p>
      <p className="kauro-scene-ok">{PUBLIC_COPY["home.app.phase.prepare.body"]}</p>
      <div className="kauro-scene-outputs">
        {[...MANIFEST_FILES.map((file) => file.name), PUBLIC_COPY["home.delivery.report.name"], PUBLIC_COPY["home.delivery.manifest.name"]].map((name) => (
          <span key={name} className="kauro-scene-output">
            <FileName>{name}</FileName>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 06: the team imports the files into its own account, in their order. */
function Import(): ReactElement {
  const order = [...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]];
  return (
    <div className="kauro-scene kauro-scene--import">
      <p className="kauro-scene-caption">{PUBLIC_COPY["home.frag.order"]}</p>
      <ol className="kauro-scene-order">
        {order.map((name) => (
          <li key={name} className="kauro-scene-order-step">
            <FileName>{name}</FileName>
          </li>
        ))}
      </ol>
      <span className="kauro-scene-arrow" />
      <span className="kauro-scene-team">{PUBLIC_COPY["home.frag.team"]}</span>
    </div>
  );
}

const SCENES: ReadonlyArray<() => ReactElement> = [Upload, Check, Decide, Quote, Prepare, Import];

export function HowFlow({ steps, brand, project }: { readonly steps: readonly FlowStep[]; readonly brand: string; readonly project: string }): ReactElement {
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    let frame = 0;
    // the stretch of scrolling each step takes is a custom property of the track (its height holds one stretch per step after the first)
    const read = (): void => {
      frame = 0;
      const el = track.current;
      if (el === null) return;
      const stretch = el.offsetHeight > window.innerHeight ? (el.offsetHeight - window.innerHeight) / Math.max(1, steps.length - 1) : 0;
      if (stretch === 0) return;
      const progress = -el.getBoundingClientRect().top / stretch;
      setActive(Math.min(steps.length - 1, Math.max(0, Math.floor(progress + AHEAD))));
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
  }, [ready, steps.length]);
  const Scene = SCENES[active] ?? Upload;
  return (
    <div className={cx("kauro-flow", ready && "is-ready")}>
      <ol className="kauro-site-timeline kauro-steps">
        {steps.map((step) => (
          <li key={step.key} className={`kauro-site-timeline-step kauro-site-timeline-step--${step.actor} kauro-step`}>
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
        <div ref={track} className="kauro-flow-track">
          <div className="kauro-flow-stage" aria-hidden="true">
            <ol className="kauro-flow-line">
              {steps.map((step, index) => (
                <li
                  key={step.key}
                  className={cx("kauro-flow-point", `kauro-flow-point--${step.actor}`, index < active && "is-done", index === active && "is-current", index > active && "is-ahead")}
                >
                  <span className="kauro-flow-point-number">{two(index + 1)}</span>
                  <span className="kauro-flow-point-actor">{step.actorLabel}</span>
                  <span className="kauro-flow-point-heading">{step.heading}</span>
                  {index === active ? <span className="kauro-flow-point-body">{step.body}</span> : null}
                </li>
              ))}
            </ol>
            <div className="kauro-flow-window kauro-paper">
              <p className="kauro-flow-bar">
                <span className="kauro-flow-brand">{brand}</span>
                <span className="kauro-flow-title">{project}</span>
                <span key={active} className={cx("kauro-flow-state", active === steps.length - 1 && "is-final")}>
                  {STATE[active]}
                </span>
              </p>
              <div key={active} className="kauro-flow-scene">
                <Scene />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

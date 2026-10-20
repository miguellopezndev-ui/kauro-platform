"use client";

// How it works on Home (A10 §8; Order 10, owner review: the How it works page and Home's process made one section). The section is an
// ordinary part of the page; nothing holds it while the page scrolls, so anyone can read past it. On the left its heading, the step being
// told (who acts, what happens) and the controls; on the right the product's window, the same file, contacts.csv, from the first step to
// the last, changed in place: Upload reads it in and seals it, Measure flags what the free check finds, Decide shows the team approving the
// three changes (the visitor watches; nothing on this page approves anything), Quote prices the sealed rows, Prepare applies what was
// approved, Import hands the file over. Under the file the window shows the tool of the step (the files read in and sealed, the findings,
// the three approvals, the quote, the sum that reconciles, the import order).
//
// Each step plays the owner-approved film of the process exactly, at its speed: the moments below (milliseconds from the start of the step)
// are the film's, and the CSS of the section uses the same ones. While the process plays, a step stays until its last moment has passed and
// one second more. The window is as tall as its step needs and never moves: it hangs from the place where the tallest step sits centred
// beside the text, so a shorter step only ends sooner. The arrows and the six marks move one step or straight to a step. With less motion
// asked for, every step is shown finished. Without the script the six steps are listed beside the window at its first step.
import { useEffect, useState, type ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { bandIndexOf, bandLabel, bandRange, formatCount, formatUsd, priceOf } from "./pricing-bands.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";
import { JOURNEY_ROWS, MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_COLUMN, SAMPLE_MODE, SAMPLE_SOURCES, sharePercent, type JourneyRow, type RowFlag } from "./sample-data.ts";

type ProposalId = "unify" | "normalise" | "map";
type Actor = "team" | "kauro";

const STEPS: ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId; readonly actor: Actor; readonly ms: number }> = [
  // ms: how long the step stays while the process plays: its last moment in the film, and one second more
  { name: "home.process.upload.name", body: "home.process.upload.body", actor: "team", ms: 7600 },
  { name: "home.process.measure.name", body: "home.process.measure.body", actor: "kauro", ms: 5600 },
  { name: "home.process.decide.name", body: "home.process.decide.body", actor: "team", ms: 7800 },
  { name: "home.process.quote.name", body: "home.process.quote.body", actor: "team", ms: 5600 },
  { name: "home.process.prepare.name", body: "home.process.prepare.body", actor: "kauro", ms: 9000 },
  { name: "home.process.import.name", body: "home.process.import.body", actor: "team", ms: 6600 },
];
const ACTOR: Readonly<Record<Actor, PublicCopyId>> = { team: "how.actor.team.label", kauro: "how.actor.kauro.label" };
const UPLOAD = 0;
const MEASURE = 1;
const DECIDE = 2;
const QUOTE = 3;
const PREPARE = 4;
const LAST = STEPS.length - 1;

/** The film's moments that change what the window says (milliseconds from the start of the step). */
const AT = {
  readFrom: 1400, // Upload: the rows are counted in, over 3 s
  approve: [2800, 4200, 5600], // Decide: the team approves the three changes in turn
  approvedChip: 6200, // Decide: the state reads Approved: 3/3
  unitsFrom: 500, // Quote: the units are counted, over 1.8 s
  rename: 1800, // Prepare: the name is normalised
  remap: 2400, // Prepare: the column is renamed
  countFrom: 3400, // Prepare: the rows run down, over 1.8 s
  quiet: 3800, // Prepare: what nobody approved stays marked, quieter
  fold: 4200, // Prepare: the duplicate folds into its pair
  unified: 4600, // Prepare: the pair is one row
} as const;

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const two = (n: number): string => String(n).padStart(2, "0");
const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
const sourceRows = contacts?.source ?? SAMPLE.contacts;
const outputRows = contacts?.rows ?? sourceRows;
// every object of the sealed files is a billable source unit, counted before anything is unified: the contacts and the companies
const billableUnits = sourceRows + (companies?.source ?? 0);
// the project is an import into a CRM (associations, import order, the team's account): it is priced as the HubSpot service
const QUOTED_MODE = SAMPLE_MODE;
const countOf = (label: PublicCopyId): number => REPORT_ROWS.find((row) => row.label === label)?.count ?? 0;
const reducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True once `ms` have passed since `step` became the current step (at once with less motion asked for); false on any other step. */
function useAfter(step: number, target: number, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (step !== target) {
      setOn(false);
      return undefined;
    }
    if (reducedMotion()) {
      setOn(true);
      return undefined;
    }
    setOn(false);
    const timer = window.setTimeout(() => setOn(true), ms);
    return () => window.clearTimeout(timer);
  }, [step, target, ms]);
  return on;
}

/**
 * A figure that waits at `from` for `delay` ms, then runs to `to` over `ms`, eased as the film's counts are; `to` at once when not running
 * or with less motion asked for. It never reads the clock itself (K0): the run starts on the first animation frame's own timestamp.
 */
function useCount(from: number, to: number, run: boolean, delay: number, ms: number): number {
  const [value, setValue] = useState(to);
  useEffect(() => {
    if (!run || reducedMotion()) {
      setValue(to);
      return undefined;
    }
    setValue(from);
    let frame = 0;
    let start = -1;
    const tick = (now: number): void => {
      if (start < 0) start = now;
      const t = Math.min(1, (now - start) / ms);
      setValue(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(tick);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [from, to, run, delay, ms]);
  return value;
}

/** Which proposal touches a row: the number it carries in the margin while the team decides. */
const PROPOSAL_OF_ROW: Readonly<Record<string, ProposalId>> = { c2: "normalise", c3: "unify", c4: "unify" };
const PROPOSALS: readonly ProposalId[] = ["unify", "normalise", "map"];
const markOf = (id: ProposalId): string => String(PROPOSALS.indexOf(id) + 1);

/** Where the file stands: what the team approved, and which of the approved changes the preparation has already applied. */
interface FileState {
  readonly step: number;
  readonly approved: ReadonlySet<ProposalId>;
  readonly renamed: boolean;
  readonly remapped: boolean;
  readonly quiet: boolean;
  readonly folded: boolean;
  readonly unified: boolean;
}

function Row({ row, file }: { readonly row: JourneyRow; readonly file: FileState }): ReactElement {
  const { step, approved } = file;
  const proposal = PROPOSAL_OF_ROW[row.id];
  const unified = file.unified && approved.has("unify");
  // the row unified into another folds away
  const folded = file.folded && approved.has("unify") && row.id === "c4";
  const renamed = file.renamed && approved.has("normalise") && row.name !== row.fixed;
  // nothing is flagged before the check has measured the file
  const flagged = (flag: RowFlag): boolean => step >= MEASURE && row.flags.includes(flag) && !(flag === "duplicate" && (unified || folded)) && !(flag === "name" && renamed);
  const mark = proposal === undefined || step < DECIDE ? null : (
    <span className={cx("kauro-walk-mark", approved.has(proposal) && "is-approved")}>{markOf(proposal)}</span>
  );
  return (
    <div className={cx("kauro-walk-row", folded && "is-folded", flagged("duplicate") && "is-pair", unified && row.id === "c3" && "is-unified")}>
      <span className="kauro-walk-cell kauro-walk-cell--mark">{mark}</span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--name", flagged("name") && "is-flag")}>
        {renamed ? (
          <span className="kauro-walk-swap">
            <s>{row.name}</s>
            <span className="kauro-walk-new">{row.fixed}</span>
          </span>
        ) : (
          row.name
        )}
        {unified && row.id === "c3" ? <span className="kauro-walk-tag">{PUBLIC_COPY["home.journey.unified"]}</span> : null}
      </span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--mono kauro-walk-cell--email", flagged("email") && "is-flag")}>{row.email}</span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--company", flagged("company") && "is-flag")}>{row.company ?? "—"}</span>
    </div>
  );
}

function Metric({ label, count, run, delay }: { readonly label: string; readonly count: number; readonly run: boolean; readonly delay: number }): ReactElement {
  const shown = useCount(0, count, run, delay, 1600);
  return (
    <li className="kauro-walk-metric">
      <span className="kauro-walk-metric-figure">{formatCount(shown)}</span>
      <span className="kauro-walk-metric-label">{label}</span>
      <span className="kauro-walk-metric-share">{sharePercent(count, SAMPLE.contacts)}</span>
    </li>
  );
}

function Units({ run }: { readonly run: boolean }): ReactElement {
  return <>{formatCount(useCount(0, billableUnits, run, AT.unitsFrom, 1800))}</>;
}

/** The tool of the step, under the file. */
function Tool({ step, approved, run }: { readonly step: number; readonly approved: ReadonlySet<ProposalId>; readonly run: boolean }): ReactElement {
  switch (step) {
    case UPLOAD: {
      const rows = [SAMPLE.contacts, companies?.source ?? 0];
      return (
        <div className="kauro-walk-tool kauro-walk-tool--upload">
          <ul className="kauro-walk-reads">
            {SAMPLE_SOURCES.map((file, index) => (
              <li key={file}>
                <FileName>{file}</FileName>
                <span className="kauro-walk-read-rows">{copy("home.files.rows", { count: formatCount(rows[index] ?? 0) })}</span>
                {/* the file read in, to its last row */}
                <span className="kauro-walk-read-bar" />
              </li>
            ))}
          </ul>
          <span className="kauro-walk-stamp">{PUBLIC_COPY["how.frag.sealed"]}</span>
        </div>
      );
    }
    case MEASURE:
      return (
        <ul className="kauro-walk-tool kauro-walk-metrics">
          <Metric label={PUBLIC_COPY["home.frag.candidates"]} count={countOf("sample.report.duplicates")} run={run} delay={2400} />
          <Metric label={PUBLIC_COPY["home.frag.invalid"]} count={countOf("sample.report.emails")} run={run} delay={2700} />
          <Metric label={PUBLIC_COPY["home.frag.company"]} count={countOf("sample.report.company")} run={run} delay={3000} />
        </ul>
      );
    case DECIDE: {
      const detail: Readonly<Record<ProposalId, string>> = {
        unify: JOURNEY_ROWS[2]?.name ?? "",
        normalise: `${JOURNEY_ROWS[1]?.name ?? ""} → ${JOURNEY_ROWS[1]?.fixed ?? ""}`,
        map: `${SAMPLE_COLUMN.from} → ${SAMPLE_COLUMN.to}`,
      };
      const title: Readonly<Record<ProposalId, string>> = {
        unify: copy("home.frag.unify", { count: 2 }),
        normalise: PUBLIC_COPY["home.journey.normalise"],
        map: PUBLIC_COPY["home.journey.map"],
      };
      return (
        <ul className="kauro-walk-tool kauro-walk-proposals">
          {PROPOSALS.map((id) => {
            const on = approved.has(id);
            return (
              <li key={id} className={cx("kauro-walk-proposal", on && "is-approved")}>
                <span className="kauro-walk-mark">{markOf(id)}</span>
                <span className="kauro-walk-proposal-title">{title[id]}</span>
                <span className="kauro-walk-proposal-detail">{detail[id]}</span>
                <span key={on ? "on" : "off"} className={cx("kauro-walk-approve", on && "is-on")}>
                  {on ? PUBLIC_COPY["home.journey.approved"] : PUBLIC_COPY["home.frag.approve"]}
                </span>
              </li>
            );
          })}
        </ul>
      );
    }
    case QUOTE: {
      const band = bandIndexOf(billableUnits) ?? 0;
      const [currency, ...amount] = formatUsd(priceOf(band, QUOTED_MODE)).split(" ");
      return (
        <div className="kauro-walk-tool kauro-walk-tool--quote">
          <div className="kauro-walk-quote-units">
            <p className="kauro-walk-quote-figure">
              <Units run={run} /> <span>{PUBLIC_COPY["pricing.table.units.label"]}</span>
            </p>
            {/* where the sealed rows fall in the band that prices them */}
            <svg className="kauro-walk-quote-meter" viewBox="0 0 100 4" preserveAspectRatio="none">
              <rect className="kauro-walk-quote-band" width="100" height="4" />
              <rect className="kauro-walk-quote-fill" width={Math.max(2, Math.round((billableUnits / bandRange(band).to) * 100))} height="4" />
            </svg>
            <p className="kauro-walk-quote-band-label">{copy("home.journey.band", { band: bandLabel(band).toLowerCase() })}</p>
          </div>
          <span className="kauro-walk-tool-arrow" />
          <div className="kauro-walk-quote-total">
            <p className="kauro-walk-quote-price">
              <span className="kauro-walk-quote-currency">{currency}</span> {amount.join(" ")}
            </p>
            <p className="kauro-walk-quote-valid">{copy("how.frag.valid", { days: POLICY_SNAPSHOT.quoteDays })}</p>
          </div>
        </div>
      );
    }
    case PREPARE:
      return (
        <div className="kauro-walk-tool kauro-walk-tool--prepare">
          <p className="kauro-walk-sum">
            <span>{formatCount(sourceRows)}</span> <span className="kauro-walk-sum-op">−</span> <span>{formatCount(contacts?.unified ?? 0)}</span>{" "}
            <span className="kauro-walk-sum-op">=</span> <span className="kauro-walk-sum-total">{formatCount(outputRows)}</span>
          </p>
          <p className="kauro-walk-ok">{PUBLIC_COPY["home.app.phase.prepare.body"]}</p>
        </div>
      );
    default: {
      const order = [...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]];
      const docs: readonly PublicCopyId[] = ["home.delivery.report.name", "home.delivery.files.name", "home.delivery.manifest.name", "home.delivery.steps.name"];
      return (
        <div className="kauro-walk-tool kauro-walk-tool--import">
          <ul className="kauro-walk-docs">
            {docs.map((id) => (
              <li key={id}>{PUBLIC_COPY[id]}</li>
            ))}
          </ul>
          <div className="kauro-walk-handover">
            <ol className="kauro-walk-order">
              {order.map((name) => (
                <li key={name}>
                  <FileName>{name}</FileName>
                </li>
              ))}
            </ol>
            <span className="kauro-walk-tool-arrow" />
            <p className="kauro-walk-crm">
              {PUBLIC_COPY["home.journey.crm"]}
              <span>{PUBLIC_COPY["home.journey.crm.note"]}</span>
            </p>
          </div>
        </div>
      );
    }
  }
}

/** What the project's state reads at each step; Decide and Prepare change it at their moment in the film. */
function stateOf(step: number, approvedAll: boolean): { readonly now: string; readonly then: string | null; readonly ok: boolean } {
  switch (step) {
    case UPLOAD:
      return { now: PUBLIC_COPY["how.frag.sealed"], then: null, ok: false };
    case MEASURE:
      return { now: PUBLIC_COPY["home.journey.measured"], then: null, ok: false };
    case DECIDE:
      return { now: approvedAll ? copy("home.journey.approved.count", { count: `${PROPOSALS.length}/${PROPOSALS.length}` }) : PUBLIC_COPY["home.frag.awaiting"], then: null, ok: approvedAll };
    case QUOTE:
      return { now: PUBLIC_COPY["how.frag.quote"], then: null, ok: false };
    case PREPARE:
      return { now: PUBLIC_COPY["home.journey.preparing"], then: PUBLIC_COPY["home.app.state.label"], ok: false };
    default:
      return { now: PUBLIC_COPY["home.app.phase.deliver.body"], then: null, ok: true };
  }
}

/** The window at a step. A sizer is the same window, finished and never seen: the six sizers give the holder the height of the tallest step. */
function Sheet({ file, approvedAll, ready, sizer = false }: { readonly file: FileState; readonly approvedAll: boolean; readonly ready: boolean; readonly sizer?: boolean }): ReactElement {
  const { step, approved } = file;
  const readIn = useCount(0, sourceRows, !sizer && ready && step === UPLOAD, AT.readFrom, 3000);
  const counted = useCount(sourceRows, outputRows, !sizer && ready && step === PREPARE, AT.countFrom, 1800);
  const rows = step === UPLOAD ? readIn : step < PREPARE ? sourceRows : step === PREPARE ? counted : outputRows;
  const mapped = file.remapped && approved.has("map");
  const fileName = step >= PREPARE ? SAMPLE.contactsFile : (SAMPLE_SOURCES[0] ?? SAMPLE.contactsFile);
  const state = stateOf(step, approvedAll);
  return (
    <div className={cx("kauro-walk-window", "kauro-paper", sizer && "kauro-walk-sizer")} aria-hidden="true">
      <div className="kauro-walk-bar">
        <span className="kauro-walk-brand">{PUBLIC_COPY["site.name"]}</span>
        <span className="kauro-walk-project">{PUBLIC_COPY["home.app.project.name"]}</span>
        <span key={`state-${step}-${state.now}`} className={cx("kauro-walk-chip", state.then !== null && "kauro-walk-chip--swap", state.ok && "is-ok")}>
          <span className="kauro-walk-chip-now">{state.now}</span>
          {state.then === null ? null : <span className="kauro-walk-chip-then">{state.then}</span>}
        </span>
      </div>
      <div className="kauro-walk-work">
        <p className="kauro-walk-file">
          <FileName key={fileName}>{fileName}</FileName>
          <span key={step === UPLOAD ? "seal-upload" : "seal"} className="kauro-walk-sealed">
            {PUBLIC_COPY["how.frag.sealed"]}
          </span>
          <span className="kauro-walk-rows">{copy("home.files.rows", { count: formatCount(rows) })}</span>
        </p>
        <div className="kauro-walk-table">
          <div className="kauro-walk-row kauro-walk-row--head">
            <span className="kauro-walk-cell kauro-walk-cell--mark">
              {step >= DECIDE ? <span className={cx("kauro-walk-mark", approved.has("map") && "is-approved")}>{markOf("map")}</span> : null}
            </span>
            <span className="kauro-walk-cell kauro-walk-cell--name">{PUBLIC_COPY["home.app.contact.label"]}</span>
            <span className={cx("kauro-walk-cell kauro-walk-cell--email", mapped && "is-renamed")}>
              {mapped ? (
                <span className="kauro-walk-swap">
                  <s>{SAMPLE_COLUMN.from}</s>
                  <span className="kauro-walk-new">{SAMPLE_COLUMN.to}</span>
                </span>
              ) : (
                SAMPLE_COLUMN.from
              )}
            </span>
            <span className="kauro-walk-cell kauro-walk-cell--company">{PUBLIC_COPY["home.app.company.label"]}</span>
          </div>
          {JOURNEY_ROWS.map((row) => (
            <Row key={row.id} row={row} file={file} />
          ))}
          {/* the free check measuring the file, once, as the step opens */}
          {step === MEASURE && !sizer ? <span className="kauro-walk-scan" /> : null}
        </div>
        {sizer ? (
          <div className="kauro-walk-tools">
            <Tool step={step} approved={approved} run={false} />
          </div>
        ) : ready ? (
          <div className="kauro-walk-tools" key={`tool-${step}`}>
            <Tool step={step} approved={approved} run={step === MEASURE || step === QUOTE} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A step finished: every change of the film applied up to that step. */
const finished = (step: number): FileState => ({
  step,
  approved: new Set(step >= DECIDE ? PROPOSALS : []),
  renamed: step >= PREPARE,
  remapped: step >= PREPARE,
  quiet: step >= PREPARE,
  folded: step >= PREPARE,
  unified: step >= PREPARE,
});

export function Journey({ eyebrow, heading, headingId }: { readonly eyebrow: string; readonly heading: string; readonly headingId: string }): ReactElement {
  const [step, setStep] = useState(UPLOAD);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setReady(true), []);
  // playing: each step stays for its time, then the next one comes; the last one stops the film
  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setTimeout(() => {
      if (step >= LAST) setPlaying(false);
      else setStep(step + 1);
    }, STEPS[step]?.ms ?? 6000);
    return () => window.clearTimeout(timer);
  }, [playing, step]);
  const approvals = [useAfter(step, DECIDE, AT.approve[0]), useAfter(step, DECIDE, AT.approve[1]), useAfter(step, DECIDE, AT.approve[2])];
  const approvedChip = useAfter(step, DECIDE, AT.approvedChip);
  const renamed = useAfter(step, PREPARE, AT.rename);
  const remapped = useAfter(step, PREPARE, AT.remap);
  const quiet = useAfter(step, PREPARE, AT.quiet);
  const folded = useAfter(step, PREPARE, AT.fold);
  const unified = useAfter(step, PREPARE, AT.unified);
  const go = (target: number): void => {
    setPlaying(false);
    setStep(Math.min(LAST, Math.max(0, target)));
  };
  const play = (): void => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (step >= LAST) setStep(UPLOAD);
    setPlaying(true);
  };
  const approvedCount = step < DECIDE ? 0 : step > DECIDE ? PROPOSALS.length : approvals.filter(Boolean).length;
  const after = step > PREPARE;
  const file: FileState = {
    step,
    approved: new Set(PROPOSALS.slice(0, approvedCount)),
    renamed: after || renamed,
    remapped: after || remapped,
    quiet: after || quiet,
    folded: after || folded,
    unified: after || unified,
  };
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className={cx("kauro-walk", "kauro-walk--book", ready && "is-ready", playing && "is-playing", `is-step-${step}`, file.quiet && "is-applied")}>
      <div className="kauro-walk-story">
        <p className="kauro-site-eyebrow">{eyebrow}</p>
        <h2 id={headingId}>{heading}</h2>
        {/* what assistive technology reads, and what a page without the script shows: the six steps */}
        <ol className="kauro-walk-steps" aria-label={PUBLIC_COPY["home.journey.label"]}>
          {STEPS.map((entry, index) => (
            <li key={entry.name} className={`kauro-walk-step kauro-walk-step--${entry.actor}`}>
              <span className="kauro-walk-step-number" aria-hidden="true">
                {two(index + 1)}
              </span>
              <p className="kauro-walk-step-actor">{PUBLIC_COPY[ACTOR[entry.actor]]}</p>
              <h3>{PUBLIC_COPY[entry.name]}</h3>
              <p className="kauro-walk-step-body">{PUBLIC_COPY[entry.body]}</p>
            </li>
          ))}
        </ol>
        {ready && current !== undefined ? (
          <>
            <div key={step} className={`kauro-walk-now kauro-walk-now--${current.actor}`} aria-hidden="true">
              <p className="kauro-walk-now-count">
                <span>{two(step + 1)}</span> / {two(STEPS.length)}
                <span className="kauro-walk-now-actor">{PUBLIC_COPY[ACTOR[current.actor]]}</span>
              </p>
              <p className="kauro-walk-now-name">{PUBLIC_COPY[current.name]}</p>
              <p className="kauro-walk-now-body">{PUBLIC_COPY[current.body]}</p>
            </div>
            <div className="kauro-walk-controls">
              <button type="button" className="kauro-walk-arrow kauro-walk-arrow--back" aria-label={PUBLIC_COPY["home.journey.prev.label"]} disabled={step === 0} onClick={() => go(step - 1)} />
              <ol className="kauro-walk-dots">
                {STEPS.map((entry, index) => (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className={cx("kauro-walk-dot", index < step && "is-done", index === step && "is-current")}
                      aria-label={copy("home.journey.step.label", { id: index + 1, name: PUBLIC_COPY[entry.name] })}
                      aria-current={index === step ? "step" : undefined}
                      onClick={() => go(index)}
                    />
                  </li>
                ))}
              </ol>
              <button type="button" className="kauro-walk-arrow kauro-walk-arrow--next" aria-label={PUBLIC_COPY["home.journey.next.label"]} disabled={step === LAST} onClick={() => go(step + 1)} />
            </div>
            <button type="button" className={cx("kauro-walk-play", playing && "is-playing")} aria-pressed={playing} onClick={play}>
              {playing ? PUBLIC_COPY["home.journey.pause"] : step >= LAST ? PUBLIC_COPY["home.journey.replay"] : PUBLIC_COPY["home.journey.play"]}
            </button>
          </>
        ) : null}
      </div>
      {/* the window hangs from the top of a holder as tall as its tallest step, so it never moves and a shorter step only ends sooner */}
      <div className="kauro-walk-holder">
        <Sheet file={file} approvedAll={approvedChip} ready={ready} />
        {ready ? STEPS.map((entry, index) => <Sheet key={entry.name} file={finished(index)} approvedAll ready={ready} sizer />) : null}
      </div>
    </div>
  );
}

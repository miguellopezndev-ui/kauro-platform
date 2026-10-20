"use client";

// How it works on Home (A10 §8; Order 10, owner review: the How it works page and Home's process made one section, designed again for
// it). The section is one composition: on the left its heading, the step being told (who acts, what happens) and the controls that move
// through the steps; on the right one sheet of the product, contacts.csv, the same from the first step to the last. The sheet has no
// separate tool area: each step works inside it. Its last column says what the step does to each row (read, found, decided, counted,
// prepared, delivered) and its last line carries the step's total (the files sealed, the findings, the approvals, the quote, the count
// that reconciles, the order of the import). Decide shows the team approving the three changes: the visitor watches, nothing on this page
// approves anything.
//
// With the script the composition holds in the middle of the screen once it gets there, and the scroll moves the project one step at a
// time, forwards going down and back going up. After the sixth step the page scrolls on; coming back up past a finished process never
// holds again, and once the sheet has left the screen below, the process starts again from the first step. The buttons beside the step
// move through the steps too, by moving the page to that step, so the scroll and the step always agree. Without the script the six steps
// are listed beside the sheet at its first step.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { bandIndexOf, bandLabel, formatCount, formatUsd, priceOf } from "./pricing-bands.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";
import { JOURNEY_ROWS, MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_COLUMN, SAMPLE_SOURCES, sharePercent, type JourneyRow, type RowFlag } from "./sample-data.ts";
import { useCountUp } from "./count-up.ts";

type ProposalId = "unify" | "normalise" | "map";
type Actor = "team" | "kauro";

const STEPS: ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId; readonly actor: Actor; readonly column: PublicCopyId }> = [
  { name: "home.process.upload.name", body: "home.process.upload.body", actor: "team", column: "home.journey.col.read" },
  { name: "home.process.measure.name", body: "home.process.measure.body", actor: "kauro", column: "home.journey.col.finding" },
  { name: "home.process.decide.name", body: "home.process.decide.body", actor: "team", column: "home.journey.col.decision" },
  { name: "home.process.quote.name", body: "home.process.quote.body", actor: "team", column: "home.journey.col.units" },
  { name: "home.process.prepare.name", body: "home.process.prepare.body", actor: "kauro", column: "home.journey.col.result" },
  { name: "home.process.import.name", body: "home.process.import.body", actor: "team", column: "home.journey.col.delivery" },
];
const ACTOR: Readonly<Record<Actor, PublicCopyId>> = { team: "how.actor.team.label", kauro: "how.actor.kauro.label" };
const UPLOAD = 0;
const MEASURE = 1;
const DECIDE = 2;
const QUOTE = 3;
const PREPARE = 4;
const LAST = STEPS.length - 1;
/** How much of a stretch of scrolling moves the project on: a short scroll past the start of a stretch is enough. */
const AHEAD = 0.6;
/** The pause between two approvals while the team decides. */
const APPROVE_MS = 550;

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const two = (n: number): string => String(n).padStart(2, "0");
const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
const sourceRows = contacts?.source ?? SAMPLE.contacts;
const countOf = (label: PublicCopyId): number => REPORT_ROWS.find((row) => row.label === label)?.count ?? 0;
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Which proposal touches a row: the number it carries in the margin while the team decides. */
const PROPOSAL_OF_ROW: Readonly<Record<string, ProposalId>> = { c2: "normalise", c3: "unify", c4: "unify" };
const PROPOSALS: readonly ProposalId[] = ["unify", "normalise", "map"];
const markOf = (id: ProposalId): string => String(PROPOSALS.indexOf(id) + 1);
const PROPOSAL_NAME: Readonly<Record<ProposalId, () => string>> = {
  unify: () => copy("home.frag.unify", { count: 2 }),
  normalise: () => PUBLIC_COPY["home.journey.normalise"],
  map: () => PUBLIC_COPY["home.journey.map"],
};
const FLAG_NAME: Readonly<Record<RowFlag, PublicCopyId>> = {
  duplicate: "home.app.result.candidate",
  email: "home.journey.flag.email",
  company: "home.journey.flag.company",
  name: "home.journey.flag.name",
};

/** What the step does to one row, in the sheet's last column. */
function stepCell(row: JourneyRow, step: number, approved: ReadonlySet<ProposalId>): ReactNode {
  const proposal = PROPOSAL_OF_ROW[row.id];
  switch (step) {
    case UPLOAD:
      return <span className="kauro-walk-read">{PUBLIC_COPY["home.journey.read"]}</span>;
    case MEASURE:
      return row.flags.length === 0 ? <span className="kauro-walk-quiet">—</span> : <span className="kauro-walk-finding">{row.flags.map((flag) => PUBLIC_COPY[FLAG_NAME[flag]]).join(" · ")}</span>;
    case DECIDE:
      return proposal === undefined ? (
        <span className="kauro-walk-quiet">—</span>
      ) : (
        <span className={cx("kauro-walk-approve", approved.has(proposal) && "is-on")}>{approved.has(proposal) ? PUBLIC_COPY["home.journey.approved"] : PUBLIC_COPY["home.frag.approve"]}</span>
      );
    case QUOTE:
      // every row of the sealed file is a billable source unit, duplicates included: they are counted before anything is unified
      return <span className="kauro-walk-unit">1</span>;
    case PREPARE:
      if (row.id === "c3" && approved.has("unify")) return <span className="kauro-walk-done">{PUBLIC_COPY["home.journey.unified"]}</span>;
      if (proposal === "normalise" && approved.has("normalise")) return <span className="kauro-walk-done">{PUBLIC_COPY["home.app.result.normalised"]}</span>;
      return row.flags.length === 0 ? <span className="kauro-walk-quiet">{PUBLIC_COPY["home.app.result.valid"]}</span> : <span className="kauro-walk-quiet">{PUBLIC_COPY["home.journey.reported"]}</span>;
    default:
      return <span className="kauro-walk-done">{PUBLIC_COPY["home.journey.ready"]}</span>;
  }
}

function Row({ row, step, approved }: { readonly row: JourneyRow; readonly step: number; readonly approved: ReadonlySet<ProposalId> }): ReactElement {
  const applied = step >= PREPARE;
  const proposal = PROPOSAL_OF_ROW[row.id];
  const unified = applied && approved.has("unify");
  const folded = unified && row.id === "c4";
  const renamed = applied && approved.has("normalise") && row.name !== row.fixed;
  // nothing is flagged before the check has measured the file
  const flagged = (flag: RowFlag): boolean => step >= MEASURE && row.flags.includes(flag) && !(flag === "duplicate" && unified) && !(flag === "name" && renamed);
  const mark = proposal === undefined || step < DECIDE ? null : (
    <span className={cx("kauro-walk-mark", approved.has(proposal) && "is-approved")}>{markOf(proposal)}</span>
  );
  return (
    <div className={cx("kauro-walk-row", folded && "is-folded", flagged("duplicate") && "is-pair", unified && row.id === "c3" && "is-unified")}>
      <span className="kauro-walk-cell kauro-walk-cell--mark">{mark}</span>
      <span className={cx("kauro-walk-cell", flagged("name") && "is-flag")}>
        {renamed ? (
          <>
            <s>{row.name}</s>
            <span className="kauro-walk-new">{row.fixed}</span>
          </>
        ) : (
          row.name
        )}
      </span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--mono", flagged("email") && "is-flag")}>{row.email}</span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--company", flagged("company") && "is-flag")}>{row.company ?? "—"}</span>
      <span className="kauro-walk-cell kauro-walk-cell--step">{stepCell(row, step, approved)}</span>
    </div>
  );
}

function Finding({ label, count, run }: { readonly label: string; readonly count: number; readonly run: boolean }): ReactElement {
  const shown = useCountUp(count, run);
  return (
    <li>
      <span className="kauro-walk-total-figure">{formatCount(shown)}</span> {label} <span className="kauro-walk-total-share">{sharePercent(count, SAMPLE.contacts)}</span>
    </li>
  );
}

/** The sheet's last line: what the step comes to, as a total. */
function Total({ step, approved, run }: { readonly step: number; readonly approved: ReadonlySet<ProposalId>; readonly run: boolean }): ReactElement {
  switch (step) {
    case UPLOAD: {
      const rows = [SAMPLE.contacts, companies?.source ?? 0];
      return (
        <div className="kauro-walk-total kauro-walk-total--upload">
          <ul>
            {SAMPLE_SOURCES.map((file, index) => (
              <li key={file}>
                <FileName>{file}</FileName> <span className="kauro-walk-quiet">{copy("home.files.rows", { count: formatCount(rows[index] ?? 0) })}</span>
              </li>
            ))}
          </ul>
          <span className="kauro-walk-seal">{PUBLIC_COPY["how.frag.sealed"]}</span>
        </div>
      );
    }
    case MEASURE:
      return (
        <ul className="kauro-walk-total kauro-walk-total--findings">
          <Finding label={PUBLIC_COPY["home.frag.candidates"]} count={countOf("sample.report.duplicates")} run={run} />
          <Finding label={PUBLIC_COPY["home.frag.invalid"]} count={countOf("sample.report.emails")} run={run} />
          <Finding label={PUBLIC_COPY["home.frag.company"]} count={countOf("sample.report.company")} run={run} />
        </ul>
      );
    case DECIDE:
      return (
        <ul className="kauro-walk-total kauro-walk-total--decide">
          {PROPOSALS.map((id) => (
            <li key={id} className={cx(approved.has(id) && "is-approved")}>
              <span className={cx("kauro-walk-mark", approved.has(id) && "is-approved")}>{markOf(id)}</span> {PROPOSAL_NAME[id]()}
            </li>
          ))}
        </ul>
      );
    case QUOTE: {
      const band = bandIndexOf(SAMPLE.contacts) ?? 0;
      const [currency, ...amount] = formatUsd(priceOf(band, "CLEAN")).split(" ");
      return (
        <div className="kauro-walk-total kauro-walk-total--quote">
          <p>
            <span className="kauro-walk-total-figure">{formatCount(SAMPLE.contacts)}</span> {PUBLIC_COPY["pricing.table.units.label"]} <span className="kauro-walk-quiet">· {bandLabel(band)}</span>
          </p>
          <p className="kauro-walk-total-price">
            <span className="kauro-walk-total-currency">{currency}</span> {amount.join(" ")}
            <span className="kauro-walk-quiet">{copy("how.frag.valid", { days: POLICY_SNAPSHOT.quoteDays })}</span>
          </p>
        </div>
      );
    }
    case PREPARE:
      return (
        <div className="kauro-walk-total kauro-walk-total--prepare">
          <p className="kauro-walk-total-sum">
            <span>{formatCount(sourceRows)}</span> <span className="kauro-walk-quiet">−</span> <span>{formatCount(contacts?.unified ?? 0)}</span> <span className="kauro-walk-quiet">=</span>{" "}
            <span className="kauro-walk-total-figure">{formatCount(contacts?.rows ?? sourceRows)}</span>
          </p>
          <p className="kauro-walk-ok">{PUBLIC_COPY["home.journey.traced"]}</p>
        </div>
      );
    default: {
      const files = [...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]];
      return (
        <div className="kauro-walk-total kauro-walk-total--import">
          <ol>
            {files.map((file) => (
              <li key={file}>
                <FileName>{file}</FileName>
              </li>
            ))}
          </ol>
          <p className="kauro-walk-quiet">{PUBLIC_COPY["sample.guide.step.counts"]}</p>
        </div>
      );
    }
  }
}

const STATE: readonly PublicCopyId[] = ["how.frag.sealed", "home.journey.measured", "home.journey.approved.count", "how.frag.quote", "home.journey.preparing", "home.frag.team"];
const DONE: ReadonlyArray<PublicCopyId | null> = [null, null, null, null, "home.app.state.label", "home.journey.imported"];

export function Journey({ eyebrow, heading, headingId }: { readonly eyebrow: string; readonly heading: string; readonly headingId: string }): ReactElement {
  const [step, setStep] = useState(UPLOAD);
  const [ready, setReady] = useState(false);
  const [approvals, setApprovals] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  /** The reader has gone through the whole process and on past it; coming back up, the section no longer holds. */
  const finished = useRef(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (!ready) return undefined;
    let frame = 0;
    let lastY = window.scrollY;
    const read = (): void => {
      frame = 0;
      const el = track.current;
      const held = stage.current;
      if (el === null || held === null) return;
      const y = window.scrollY;
      const up = y < lastY;
      lastY = y;
      const box = held.getBoundingClientRect();
      // the sheet has left the screen below (the reader went back up past the section): it starts again from the first step
      if (box.top >= window.innerHeight) {
        el.classList.remove("is-collapsed");
        finished.current = false;
        setStep(UPLOAD);
        return;
      }
      if (el.classList.contains("is-collapsed")) return;
      const holdAt = Number.parseFloat(window.getComputedStyle(held).top) || 0;
      const into = holdAt - el.getBoundingClientRect().top;
      const length = el.offsetHeight - held.offsetHeight;
      if (into > length + 1) finished.current = true;
      if (up && finished.current && into > 0) {
        // back up past a finished process: the track gives up its extra length, and the page moves by the same amount so nothing jumps
        el.classList.add("is-collapsed");
        window.scrollBy(0, held.getBoundingClientRect().top - box.top);
        lastY = window.scrollY;
        return;
      }
      const stretch = length / LAST;
      if (stretch <= 0) return;
      // inside the process the scroll moves it both ways: forwards going down, one step back going up
      setStep(Math.min(LAST, Math.max(0, Math.floor(into / stretch + AHEAD))));
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
  }, [ready]);
  // while the team decides, the three changes are approved one after the other
  useEffect(() => {
    if (step !== DECIDE) return undefined;
    if (reducedMotion()) {
      setApprovals(PROPOSALS.length);
      return undefined;
    }
    setApprovals(0);
    const timers = PROPOSALS.map((_, index) => window.setTimeout(() => setApprovals(index + 1), APPROVE_MS * (index + 1)));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [step]);
  /** A button moves to a step by moving the page to it, so the scroll and the step agree. */
  const go = (target: number): void => {
    const next = Math.min(LAST, Math.max(0, target));
    const el = track.current;
    const held = stage.current;
    if (el === null || held === null || el.classList.contains("is-collapsed")) {
      setStep(next);
      return;
    }
    const holdAt = Number.parseFloat(window.getComputedStyle(held).top) || 0;
    const stretch = (el.offsetHeight - held.offsetHeight) / LAST;
    const top = el.getBoundingClientRect().top + window.scrollY - holdAt + next * stretch;
    window.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  const approvedCount = step < DECIDE ? 0 : step > DECIDE ? PROPOSALS.length : approvals;
  const approved: ReadonlySet<ProposalId> = new Set(PROPOSALS.slice(0, approvedCount));
  const out = approved.has("unify") ? (contacts?.rows ?? sourceRows) : sourceRows;
  const readIn = useCountUp(sourceRows, ready && step === UPLOAD, 0, 1100);
  const counted = useCountUp(out, ready && step === PREPARE, sourceRows, 1400);
  const rows = step === UPLOAD ? readIn : step < PREPARE ? sourceRows : step === PREPARE ? counted : out;
  const mapped = step >= PREPARE && approved.has("map");
  const fileName = step >= PREPARE ? SAMPLE.contactsFile : (SAMPLE_SOURCES[0] ?? SAMPLE.contactsFile);
  const done = DONE[step] ?? null;
  const state = STATE[step] === "home.journey.approved.count" ? copy("home.journey.approved.count", { count: `${approved.size}/${PROPOSALS.length}` }) : PUBLIC_COPY[STATE[step] ?? "how.frag.sealed"];
  const current = STEPS[step] ?? STEPS[0];
  const walk = (
    <div ref={stage} className={cx("kauro-walk", ready && "is-ready", `is-step-${step}`)}>
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
          </>
        ) : null}
      </div>
      <div className="kauro-walk-window kauro-paper" aria-hidden="true">
        <div className="kauro-walk-bar">
          <span className="kauro-walk-brand">{PUBLIC_COPY["site.name"]}</span>
          <span className="kauro-walk-project">{PUBLIC_COPY["home.app.project.name"]}</span>
          <span key={`state-${step}`} className={cx("kauro-walk-chip", done !== null && "kauro-walk-chip--swap")}>
            <span className="kauro-walk-chip-now">{state}</span>
            {done === null ? null : <span className="kauro-walk-chip-then">{PUBLIC_COPY[done]}</span>}
          </span>
        </div>
        <div className="kauro-walk-work">
          <p className="kauro-walk-file">
            <FileName key={fileName}>{fileName}</FileName>
            {step === UPLOAD ? null : <span className="kauro-walk-sealed">{PUBLIC_COPY["how.frag.sealed"]}</span>}
            <span className="kauro-walk-rows">{copy("home.files.rows", { count: formatCount(rows) })}</span>
          </p>
          <div className="kauro-walk-table">
            <div className="kauro-walk-row kauro-walk-row--head">
              <span className="kauro-walk-cell kauro-walk-cell--mark">
                {step >= DECIDE ? <span className={cx("kauro-walk-mark", approved.has("map") && "is-approved")}>{markOf("map")}</span> : null}
              </span>
              <span className="kauro-walk-cell">{PUBLIC_COPY["home.app.contact.label"]}</span>
              <span className={cx("kauro-walk-cell", mapped && "is-renamed")}>
                {mapped ? (
                  <>
                    <s>{SAMPLE_COLUMN.from}</s>
                    <span className="kauro-walk-new">{SAMPLE_COLUMN.to}</span>
                  </>
                ) : (
                  SAMPLE_COLUMN.from
                )}
              </span>
              <span className="kauro-walk-cell kauro-walk-cell--company">{PUBLIC_COPY["home.app.company.label"]}</span>
              <span key={`column-${step}`} className="kauro-walk-cell kauro-walk-cell--step">
                {PUBLIC_COPY[current?.column ?? "home.journey.col.read"]}
              </span>
            </div>
            {JOURNEY_ROWS.map((row) => (
              <Row key={row.id} row={row} step={step} approved={approved} />
            ))}
            <div className="kauro-walk-foot" key={`total-${step}`}>
              <Total step={step} approved={approved} run={ready && step === MEASURE} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  // with the script, the composition is held in the middle of the screen while the reader scrolls through the steps
  return ready ? (
    <div ref={track} className="kauro-walk-track">
      {walk}
    </div>
  ) : (
    walk
  );
}

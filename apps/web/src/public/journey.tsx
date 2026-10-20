"use client";

// How it works on Home (A10 §8; Order 10, owner review: the How it works page and Home's process made one section, designed again for
// it). The section is one composition: on the left its heading, the step being told (who acts, what happens) and the controls that move
// through the steps; on the right one sheet of the product, contacts.csv, the same from the first step to the last. The sheet has no
// separate tool area: each step works inside it. Its last column says what the step does to each row and its last line, always three
// figures in the same places, carries what the step comes to. Decide shows the team approving the three changes: the visitor watches,
// nothing on this page approves anything. Nothing in the composition changes size or place from one step to the next.
//
// With the script the section fills the screen under the header and holds there while the reader goes through the six steps, each step
// one stretch of scrolling, the first included. With a mouse wheel one notch inside the process is one step, whatever the wheel is set to
// scroll, like the frames of a video; a touchpad, a touch screen or the keyboard scroll as they always do. Going up inside the process goes
// back one step. After the sixth the page scrolls on; coming back up past a finished process never holds, and once the sheet has left the
// screen below the process starts again from the first step. The buttons beside the step move the page to that step, so the scroll and the
// step always agree. Without the script the six steps are listed beside the sheet at its first step.
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
/** The pause between two approvals while the team decides. */
const APPROVE_MS = 550;
/** After a wheel notch moves the process one step, the wheel waits this long before it can move it again. */
const NOTCH_MS = 650;

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
  duplicate: "home.journey.flag.duplicate",
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
      return row.flags.length === 0 ? (
        <span className="kauro-walk-quiet">—</span>
      ) : (
        <span className="kauro-walk-findings">
          {row.flags.map((flag) => (
            <span key={flag} className="kauro-walk-finding">
              {PUBLIC_COPY[FLAG_NAME[flag]]}
            </span>
          ))}
        </span>
      );
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
      if (row.id === "c4" && approved.has("unify")) return <span className="kauro-walk-quiet">{PUBLIC_COPY["home.journey.merged"]}</span>;
      if (row.id === "c3" && approved.has("unify")) return <span className="kauro-walk-done">{PUBLIC_COPY["home.journey.unified"]}</span>;
      if (proposal === "normalise" && approved.has("normalise")) return <span className="kauro-walk-done">{PUBLIC_COPY["home.app.result.normalised"]}</span>;
      return row.flags.length === 0 ? <span className="kauro-walk-quiet">{PUBLIC_COPY["home.app.result.valid"]}</span> : <span className="kauro-walk-quiet">{PUBLIC_COPY["home.journey.reported"]}</span>;
    default:
      return row.id === "c4" ? <span className="kauro-walk-quiet">{PUBLIC_COPY["home.journey.merged"]}</span> : <span className="kauro-walk-done">{PUBLIC_COPY["home.journey.ready"]}</span>;
  }
}

function Row({ row, step, approved }: { readonly row: JourneyRow; readonly step: number; readonly approved: ReadonlySet<ProposalId> }): ReactElement {
  const applied = step >= PREPARE;
  const proposal = PROPOSAL_OF_ROW[row.id];
  const unified = applied && approved.has("unify");
  // the row unified into another keeps its place, struck through, so the sheet never changes height
  const merged = unified && row.id === "c4";
  const renamed = applied && approved.has("normalise") && row.name !== row.fixed;
  // nothing is flagged before the check has measured the file
  const flagged = (flag: RowFlag): boolean => step >= MEASURE && row.flags.includes(flag) && !(flag === "duplicate" && unified) && !(flag === "name" && renamed);
  const mark = proposal === undefined || step < DECIDE ? null : (
    <span className={cx("kauro-walk-mark", approved.has(proposal) && "is-approved")}>{markOf(proposal)}</span>
  );
  return (
    <div className={cx("kauro-walk-row", merged && "is-merged", flagged("duplicate") && "is-pair", unified && row.id === "c3" && "is-unified")}>
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
      <span className={cx("kauro-walk-cell kauro-walk-cell--mono kauro-walk-cell--email", flagged("email") && "is-flag")}>{row.email}</span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--company", flagged("company") && "is-flag")}>{row.company ?? "—"}</span>
      <span className="kauro-walk-cell kauro-walk-cell--step">{stepCell(row, step, approved)}</span>
    </div>
  );
}

/** One of the three figures of the sheet's last line: the figure, then what it is. */
function Figure({ figure, label, note }: { readonly figure: ReactNode; readonly label: ReactNode; readonly note?: ReactNode }): ReactElement {
  return (
    <li className="kauro-walk-figure">
      <span className="kauro-walk-figure-value">{figure}</span>
      <span className="kauro-walk-figure-label">{label}</span>
      {note === undefined ? null : <span className="kauro-walk-figure-note">{note}</span>}
    </li>
  );
}

function Count({ count, run }: { readonly count: number; readonly run: boolean }): ReactElement {
  return <>{formatCount(useCountUp(count, run))}</>;
}

/** The sheet's last line: what the step comes to, always three figures in the same places. */
function Total({ step, approved, run }: { readonly step: number; readonly approved: ReadonlySet<ProposalId>; readonly run: boolean }): ReactElement {
  switch (step) {
    case UPLOAD: {
      const rows = [SAMPLE.contacts, companies?.source ?? 0];
      return (
        <ul className="kauro-walk-figures">
          {SAMPLE_SOURCES.map((file, index) => (
            <Figure key={file} figure={formatCount(rows[index] ?? 0)} label={<FileName>{file}</FileName>} note={PUBLIC_COPY["sample.manifest.rows.label"]} />
          ))}
          <li className="kauro-walk-figure kauro-walk-figure--seal">
            <span className="kauro-walk-seal">{PUBLIC_COPY["how.frag.sealed"]}</span>
          </li>
        </ul>
      );
    }
    case MEASURE:
      return (
        <ul className="kauro-walk-figures">
          {(["sample.report.duplicates", "sample.report.emails", "sample.report.company"] as const).map((id, index) => (
            <Figure
              key={id}
              figure={<Count count={countOf(id)} run={run} />}
              label={PUBLIC_COPY[(["home.frag.candidates", "home.frag.invalid", "home.frag.company"] as const)[index] ?? "home.frag.candidates"]}
              note={sharePercent(countOf(id), SAMPLE.contacts)}
            />
          ))}
        </ul>
      );
    case DECIDE:
      return (
        <ul className="kauro-walk-figures">
          {PROPOSALS.map((id) => (
            <Figure
              key={id}
              figure={<span className={cx("kauro-walk-mark", "kauro-walk-mark--large", approved.has(id) && "is-approved")}>{markOf(id)}</span>}
              label={PROPOSAL_NAME[id]()}
              note={<span className={cx("kauro-walk-state", approved.has(id) && "is-on")}>{approved.has(id) ? PUBLIC_COPY["home.journey.approved"] : PUBLIC_COPY["home.frag.approve"]}</span>}
            />
          ))}
        </ul>
      );
    case QUOTE: {
      const band = bandIndexOf(SAMPLE.contacts) ?? 0;
      const [currency, ...amount] = formatUsd(priceOf(band, "CLEAN")).split(" ");
      return (
        <ul className="kauro-walk-figures">
          <Figure figure={formatCount(SAMPLE.contacts)} label={PUBLIC_COPY["pricing.table.units.label"]} />
          <Figure figure={bandLabel(band)} label={PUBLIC_COPY["home.journey.band"]} />
          <Figure
            figure={
              <>
                <span className="kauro-walk-currency">{currency}</span> {amount.join(" ")}
              </>
            }
            label={copy("how.frag.valid", { days: POLICY_SNAPSHOT.quoteDays })}
          />
        </ul>
      );
    }
    case PREPARE:
      return (
        <ul className="kauro-walk-figures kauro-walk-figures--sum">
          <Figure figure={formatCount(sourceRows)} label={PUBLIC_COPY["sample.manifest.source.label"]} />
          <Figure figure={`− ${formatCount(contacts?.unified ?? 0)}`} label={PUBLIC_COPY["sample.manifest.unified.label"]} />
          <Figure figure={`= ${formatCount(contacts?.rows ?? sourceRows)}`} label={PUBLIC_COPY["home.app.phase.prepare.body"]} />
        </ul>
      );
    default: {
      const files = [...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]];
      return (
        <ul className="kauro-walk-figures">
          {files.map((file, index) => (
            <Figure key={file} figure={String(index + 1)} label={<FileName>{file}</FileName>} note={PUBLIC_COPY["home.frag.order"]} />
          ))}
        </ul>
      );
    }
  }
}

const STATE: readonly PublicCopyId[] = ["how.frag.sealed", "home.journey.measured", "home.journey.approved.count", "how.frag.quote", "home.journey.preparing", "home.frag.team"];
const DONE: ReadonlyArray<PublicCopyId | null> = [null, null, null, null, "home.app.state.label", "home.journey.imported"];

/** Where the held section is: the track's top relative to the screen, how far into the hold the reader is, one step's stretch. */
function geometry(el: HTMLElement, held: HTMLElement): { readonly into: number; readonly stretch: number; readonly length: number; readonly trackTop: number } {
  const holdAt = Number.parseFloat(window.getComputedStyle(held).top) || 0;
  const trackTop = el.getBoundingClientRect().top;
  const length = el.offsetHeight - held.offsetHeight;
  return { into: holdAt - trackTop, stretch: length / STEPS.length, length, trackTop: trackTop + window.scrollY - holdAt };
}

export function Journey({ eyebrow, heading, headingId }: { readonly eyebrow: string; readonly heading: string; readonly headingId: string }): ReactElement {
  const [step, setStep] = useState(UPLOAD);
  const [ready, setReady] = useState(false);
  const [approvals, setApprovals] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  /** The reader has gone through the whole process and on past it; coming back up, the section no longer holds. */
  const finished = useRef(false);
  const stepRef = useRef(UPLOAD);
  stepRef.current = step;
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (!ready) return undefined;
    let frame = 0;
    let lastY = window.scrollY;
    let quietUntil = 0;
    const read = (): void => {
      frame = 0;
      const el = track.current;
      const held = stage.current;
      if (el === null || held === null) return;
      const y = window.scrollY;
      const up = y < lastY;
      lastY = y;
      const box = held.getBoundingClientRect();
      // the section has left the screen below (the reader went back up past it): it starts again from the first step
      if (box.top >= window.innerHeight) {
        el.classList.remove("is-collapsed");
        finished.current = false;
        setStep(UPLOAD);
        return;
      }
      if (el.classList.contains("is-collapsed")) return;
      const { into, stretch, length } = geometry(el, held);
      if (into > length + 1) finished.current = true;
      if (up && finished.current && into > 0) {
        // back up past a finished process: the track gives up its extra length, and the page moves by the same amount so nothing jumps
        el.classList.add("is-collapsed");
        window.scrollBy(0, held.getBoundingClientRect().top - box.top);
        lastY = window.scrollY;
        return;
      }
      if (stretch <= 0) return;
      // each step is one full stretch of the hold, the first included
      setStep(Math.min(LAST, Math.max(0, Math.floor(into / stretch))));
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    // a mouse wheel moves the process one step a notch, however many lines a notch scrolls; a touchpad's and a touch screen's own scrolling is
    // left alone (a touchpad's many small events are taken as one notch at a time)
    const wheel = (event: WheelEvent): void => {
      const el = track.current;
      const held = stage.current;
      if (el === null || held === null || el.classList.contains("is-collapsed") || event.ctrlKey || event.deltaY === 0) return;
      const { into, stretch, length, trackTop } = geometry(el, held);
      const down = event.deltaY > 0;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * window.innerHeight : event.deltaY;
      // coming into the hold from above, a notch stops at its first step instead of running past it
      const entering = down && into < 0 && into + delta > 0;
      const inside = into >= 0 && into <= length;
      if (!entering && !inside) return;
      if (finished.current && !down) return;
      event.preventDefault();
      if (event.timeStamp < quietUntil) return;
      quietUntil = event.timeStamp + NOTCH_MS;
      const current = entering ? -1 : stepRef.current;
      const next = current + (down ? 1 : -1);
      // past either end the page is let go: just above the hold going up, just below it going down
      const target = next < 0 ? trackTop - 2 : next > LAST ? trackTop + length + 2 : trackTop + next * stretch + stretch / 2;
      window.scrollTo({ top: entering ? trackTop + stretch / 2 : target, behavior: reducedMotion() ? "auto" : "smooth" });
    };
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("wheel", wheel);
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
    const { stretch, trackTop } = geometry(el, held);
    window.scrollTo({ top: trackTop + next * stretch + stretch / 2, behavior: reducedMotion() ? "auto" : "smooth" });
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
            <span className={cx("kauro-walk-sealed", step === UPLOAD && "is-waiting")}>{PUBLIC_COPY["how.frag.sealed"]}</span>
            <span className="kauro-walk-rows">{copy("home.files.rows", { count: formatCount(rows) })}</span>
          </p>
          <div className="kauro-walk-table">
            <div className="kauro-walk-row kauro-walk-row--head">
              <span className="kauro-walk-cell kauro-walk-cell--mark">
                {step >= DECIDE ? <span className={cx("kauro-walk-mark", approved.has("map") && "is-approved")}>{markOf("map")}</span> : null}
              </span>
              <span className="kauro-walk-cell">{PUBLIC_COPY["home.app.contact.label"]}</span>
              <span className={cx("kauro-walk-cell kauro-walk-cell--email", mapped && "is-renamed")}>
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
          </div>
          <div className="kauro-walk-foot" key={`total-${step}`}>
            <Total step={step} approved={approved} run={ready && step === MEASURE} />
          </div>
        </div>
      </div>
    </div>
  );
  // with the script, the section fills the screen and holds while the reader goes through the steps
  return ready ? (
    <div ref={track} className="kauro-walk-track">
      {walk}
    </div>
  ) : (
    walk
  );
}

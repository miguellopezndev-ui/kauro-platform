"use client";

// How it works on Home (A10 §8; Order 10, owner review: the How it works page and Home's process made one section, designed again for
// it). The section is one composition: on the left, its heading and the step being told (who acts, what happens); on the right, the
// product itself, one project window whose rail lists the six phases and whose file, contacts.csv, is the same from the first phase to the
// last and changes in place. Upload reads the files in and seals them. Measure flags what the free check finds. Decide shows the three
// changes and the team approving them (the visitor watches; nothing on this page approves anything). Quote prices the sealed rows from the
// policy's band. Prepare applies what was approved: the duplicate pair folds into one row, the name is normalised, the column renamed, the
// row count runs down. Import hands the files over in their order.
//
// With the script, the composition holds in the middle of the screen once it gets there, and each stretch of scrolling moves the project
// one phase on; after the sixth the page scrolls on. Going back up never holds and never plays the phases again: the section scrolls
// past as an ordinary block showing where the project got to, and only once it has left the screen below does it start again from the
// first phase. Without the script, the six steps are listed beside the window at its first phase.
import { useEffect, useRef, useState, type ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { bandIndexOf, bandLabel, bandRange, formatCount, formatUsd, priceOf } from "./pricing-bands.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";
import { JOURNEY_ROWS, MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_COLUMN, SAMPLE_SOURCES, sharePercent, type JourneyRow, type RowFlag } from "./sample-data.ts";
import { useCountUp } from "./count-up.ts";

type ProposalId = "unify" | "normalise" | "map";
type Actor = "team" | "kauro";

const STEPS: ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId; readonly actor: Actor }> = [
  { name: "home.process.upload.name", body: "home.process.upload.body", actor: "team" },
  { name: "home.process.measure.name", body: "home.process.measure.body", actor: "kauro" },
  { name: "home.process.decide.name", body: "home.process.decide.body", actor: "team" },
  { name: "home.process.quote.name", body: "home.process.quote.body", actor: "team" },
  { name: "home.process.prepare.name", body: "home.process.prepare.body", actor: "kauro" },
  { name: "home.process.import.name", body: "home.process.import.body", actor: "team" },
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

function Metric({ label, count, run }: { readonly label: string; readonly count: number; readonly run: boolean }): ReactElement {
  const shown = useCountUp(count, run);
  return (
    <li className="kauro-walk-metric">
      <span className="kauro-walk-metric-figure">{formatCount(shown)}</span>
      <span className="kauro-walk-metric-label">{label}</span>
      <span className="kauro-walk-metric-share">{sharePercent(count, SAMPLE.contacts)}</span>
    </li>
  );
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
    <span className={cx("kauro-walk-mark", approved.has(proposal) && "is-approved", applied && !approved.has(proposal) && "is-skipped")}>{markOf(proposal)}</span>
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
        {unified && row.id === "c3" ? <span className="kauro-walk-tag">{PUBLIC_COPY["home.journey.unified"]}</span> : null}
      </span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--mono", flagged("email") && "is-flag")}>{row.email}</span>
      <span className={cx("kauro-walk-cell", flagged("company") && "is-flag")}>{row.company ?? "—"}</span>
    </div>
  );
}

/** The tool of the phase, under the file, in a space that keeps its size. */
function Tray({ step, approved, run }: { readonly step: number; readonly approved: ReadonlySet<ProposalId>; readonly run: boolean }): ReactElement {
  switch (step) {
    case UPLOAD: {
      const rows = [SAMPLE.contacts, companies?.source ?? 0];
      return (
        <div className="kauro-walk-upload">
          <ul className="kauro-walk-sources">
            {SAMPLE_SOURCES.map((file, index) => (
              <li key={file}>
                <FileName>{file}</FileName>
                <span className="kauro-walk-source-rows">{copy("home.files.rows", { count: formatCount(rows[index] ?? 0) })}</span>
                {/* the file being read in, to its last row */}
                <span className="kauro-walk-source-read" />
              </li>
            ))}
          </ul>
          <span className="kauro-walk-seal">{PUBLIC_COPY["how.frag.sealed"]}</span>
        </div>
      );
    }
    case MEASURE:
      return (
        <ul className="kauro-walk-metrics">
          <Metric label={PUBLIC_COPY["home.frag.candidates"]} count={countOf("sample.report.duplicates")} run={run} />
          <Metric label={PUBLIC_COPY["home.frag.invalid"]} count={countOf("sample.report.emails")} run={run} />
          <Metric label={PUBLIC_COPY["home.frag.company"]} count={countOf("sample.report.company")} run={run} />
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
        <ul className="kauro-walk-proposals">
          {PROPOSALS.map((id) => {
            const on = approved.has(id);
            return (
              <li key={id} className={cx("kauro-walk-proposal", on && "is-approved")}>
                <span className="kauro-walk-mark">{markOf(id)}</span>
                <span className="kauro-walk-proposal-title">{title[id]}</span>
                <span className="kauro-walk-proposal-detail">{detail[id]}</span>
                <span className={cx("kauro-walk-approve", on && "is-on")}>{on ? PUBLIC_COPY["home.journey.approved"] : PUBLIC_COPY["home.frag.approve"]}</span>
              </li>
            );
          })}
        </ul>
      );
    }
    case QUOTE: {
      const band = bandIndexOf(SAMPLE.contacts) ?? 0;
      const [currency, ...amount] = formatUsd(priceOf(band, "CLEAN")).split(" ");
      return (
        <div className="kauro-walk-quote">
          <div className="kauro-walk-quote-units">
            <p className="kauro-walk-quote-figure">
              {formatCount(SAMPLE.contacts)} <span>{PUBLIC_COPY["pricing.table.units.label"]}</span>
            </p>
            {/* where the sealed rows fall in the band that prices them */}
            <svg className="kauro-walk-quote-meter" viewBox="0 0 100 4" preserveAspectRatio="none">
              <rect className="kauro-walk-quote-band" width="100" height="4" />
              <rect className="kauro-walk-quote-fill" width={Math.max(2, Math.round((SAMPLE.contacts / bandRange(band).to) * 100))} height="4" />
            </svg>
            <p className="kauro-walk-quote-band-label">{bandLabel(band)}</p>
          </div>
          <div className="kauro-walk-quote-total">
            <p className="kauro-walk-quote-price">
              <span className="kauro-walk-quote-currency">{currency}</span> {amount.join(" ")}
            </p>
            <p className="kauro-walk-quote-valid">{copy("how.frag.valid", { days: POLICY_SNAPSHOT.quoteDays })}</p>
          </div>
        </div>
      );
    }
    case PREPARE: {
      const skipped = PROPOSALS.length - approved.size;
      return (
        <ul className="kauro-walk-checks">
          <li>{PUBLIC_COPY["home.journey.applied"]}</li>
          <li>{PUBLIC_COPY["home.journey.traced"]}</li>
          <li>{PUBLIC_COPY["home.app.phase.prepare.body"]}</li>
          {skipped > 0 ? <li className="is-skipped">{copy("home.journey.skipped", { count: skipped })}</li> : null}
        </ul>
      );
    }
    default: {
      const files = [...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]];
      return (
        <div className="kauro-walk-import">
          <ol className="kauro-walk-order">
            {files.map((file) => (
              <li key={file}>
                <FileName>{file}</FileName>
              </li>
            ))}
          </ol>
          <p className="kauro-walk-compare">{PUBLIC_COPY["sample.guide.step.counts"]}</p>
        </div>
      );
    }
  }
}

/** What each phase leaves on the rail once it is done: the project keeps a record of how it got where it is. */
function resultOf(index: number): string {
  switch (index) {
    case UPLOAD:
      return copy("home.files.rows", { count: formatCount(sourceRows) });
    case MEASURE:
      return `${formatCount(countOf("sample.report.duplicates"))} ${PUBLIC_COPY["home.frag.candidates"]}`;
    case DECIDE:
      return copy("home.journey.approved.count", { count: `${PROPOSALS.length}/${PROPOSALS.length}` });
    case QUOTE:
      return formatUsd(priceOf(bandIndexOf(SAMPLE.contacts) ?? 0, "CLEAN"));
    case PREPARE:
      return copy("home.files.rows", { count: formatCount(contacts?.rows ?? sourceRows) });
    default:
      return PUBLIC_COPY["home.journey.imported"];
  }
}

const STATE: readonly PublicCopyId[] = ["how.frag.sealed", "home.journey.measured", "home.journey.approved.count", "how.frag.quote", "home.journey.preparing", "home.frag.team"];
const DONE: ReadonlyArray<PublicCopyId | null> = [null, null, null, null, "home.app.state.label", "home.journey.imported"];

export function Journey({ eyebrow, heading, headingId }: { readonly eyebrow: string; readonly heading: string; readonly headingId: string }): ReactElement {
  const [step, setStep] = useState(UPLOAD);
  const [ready, setReady] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [approvals, setApprovals] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
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
      // the section has left the screen below (the reader went back up past it): next time it starts again from the first phase
      if (box.top >= window.innerHeight) {
        el.classList.remove("is-collapsed");
        setStep(UPLOAD);
        setEngaged(false);
        return;
      }
      if (el.classList.contains("is-collapsed")) return;
      const holdAt = Number.parseFloat(window.getComputedStyle(held).top) || 0;
      const into = holdAt - el.getBoundingClientRect().top;
      if (up && into > 0) {
        // going back up never holds: the track gives up its extra length, and the page is moved by the same amount so nothing jumps
        el.classList.add("is-collapsed");
        window.scrollBy(0, held.getBoundingClientRect().top - box.top);
        lastY = window.scrollY;
        return;
      }
      const stretch = (el.offsetHeight - held.offsetHeight) / LAST;
      if (stretch <= 0) return;
      if (into >= 0) setEngaged(true);
      const reached = Math.min(LAST, Math.max(0, Math.floor(into / stretch + AHEAD)));
      setStep((current) => Math.max(current, reached));
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
  const approvedCount = step < DECIDE ? 0 : step > DECIDE ? PROPOSALS.length : approvals;
  const approved: ReadonlySet<ProposalId> = new Set(PROPOSALS.slice(0, approvedCount));
  const out = approved.has("unify") ? (contacts?.rows ?? sourceRows) : sourceRows;
  const read = useCountUp(sourceRows, ready && engaged && step === UPLOAD, 0, 1100);
  const counted = useCountUp(out, ready && step === PREPARE, sourceRows, 1400);
  const rows = step === UPLOAD ? read : step < PREPARE ? sourceRows : step === PREPARE ? counted : out;
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
          <div key={step} className={`kauro-walk-now kauro-walk-now--${current.actor}`} aria-hidden="true">
            <p className="kauro-walk-now-count">
              <span>{two(step + 1)}</span> / {two(STEPS.length)}
              <span className="kauro-walk-now-actor">{PUBLIC_COPY[ACTOR[current.actor]]}</span>
            </p>
            <p className="kauro-walk-now-name">{PUBLIC_COPY[current.name]}</p>
            <p className="kauro-walk-now-body">{PUBLIC_COPY[current.body]}</p>
          </div>
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
        <div className="kauro-walk-body">
          {/* the project's phases, as the product lists them: passed, current, to come */}
          <ol className="kauro-walk-rail">
            {STEPS.map((entry, index) => (
              <li key={entry.name} className={cx("kauro-walk-phase", `kauro-walk-phase--${entry.actor}`, index < step && "is-done", index === step && "is-current")}>
                <span className="kauro-walk-phase-number">{two(index + 1)}</span>
                <span className="kauro-walk-phase-name">{PUBLIC_COPY[entry.name]}</span>
                {index < step ? <span className="kauro-walk-phase-result">{resultOf(index)}</span> : null}
              </li>
            ))}
          </ol>
          <div className="kauro-walk-work">
            <p className="kauro-walk-file">
              <FileName key={fileName}>{fileName}</FileName>
              {step === UPLOAD ? null : <span className="kauro-walk-sealed">{PUBLIC_COPY["how.frag.sealed"]}</span>}
              <span className="kauro-walk-rows">{copy("home.files.rows", { count: formatCount(rows) })}</span>
            </p>
            <div className="kauro-walk-table">
              <div className="kauro-walk-row kauro-walk-row--head">
                <span className="kauro-walk-cell kauro-walk-cell--mark">
                  {step >= DECIDE ? <span className={cx("kauro-walk-mark", approved.has("map") && "is-approved", step >= PREPARE && !approved.has("map") && "is-skipped")}>{markOf("map")}</span> : null}
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
                <span className="kauro-walk-cell">{PUBLIC_COPY["home.app.company.label"]}</span>
              </div>
              {JOURNEY_ROWS.map((row) => (
                <Row key={row.id} row={row} step={step} approved={approved} />
              ))}
            </div>
            <div className="kauro-walk-tray" key={`tray-${step}`}>
              <Tray step={step} approved={approved} run={ready && step === MEASURE} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  // with the script, the composition is held in the middle of the screen while the reader scrolls through the phases
  return ready ? (
    <div ref={track} className="kauro-walk-track">
      {walk}
    </div>
  ) : (
    walk
  );
}

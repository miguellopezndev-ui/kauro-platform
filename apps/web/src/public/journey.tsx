"use client";

// How it works on Home (A10 §8; Order 10, owner review: the How it works page and Home's process made one section). The section is an
// ordinary part of the page; nothing holds it while the page scrolls, so anyone can read past it. On the left its heading, the step being
// told (who acts, what happens) and the controls; on the right the product's window, the same file, contacts.csv, from the first step to
// the last, changed in place: Upload reads it in and seals it, Measure flags what the free check finds, Decide shows the team approving the
// three changes (the visitor watches; nothing on this page approves anything), Quote prices the sealed rows, Prepare applies what was
// approved, Import hands the file over. Whoever wants the whole process plays it: the steps follow one another by themselves, like a short
// film, and can be paused; the arrows and the six marks move one step or straight to a step. Nothing in the section changes size or place
// from one step to the next. Without the script the six steps are listed beside the window at its first step.
import { useEffect, useState, type ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { bandIndexOf, formatCount, formatUsd, priceOf } from "./pricing-bands.ts";
import { JOURNEY_ROWS, MANIFEST_FILES, SAMPLE, SAMPLE_COLUMN, SAMPLE_SOURCES, type JourneyRow, type RowFlag } from "./sample-data.ts";
import { useCountUp } from "./count-up.ts";

type ProposalId = "unify" | "normalise" | "map";
type Actor = "team" | "kauro";

const STEPS: ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId; readonly actor: Actor; readonly ms: number }> = [
  { name: "home.process.upload.name", body: "home.process.upload.body", actor: "team", ms: 4200 },
  { name: "home.process.measure.name", body: "home.process.measure.body", actor: "kauro", ms: 4500 },
  { name: "home.process.decide.name", body: "home.process.decide.body", actor: "team", ms: 4800 },
  { name: "home.process.quote.name", body: "home.process.quote.body", actor: "team", ms: 4200 },
  { name: "home.process.prepare.name", body: "home.process.prepare.body", actor: "kauro", ms: 4800 },
  { name: "home.process.import.name", body: "home.process.import.body", actor: "team", ms: 4500 },
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

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const two = (n: number): string => String(n).padStart(2, "0");
const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const sourceRows = contacts?.source ?? SAMPLE.contacts;
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Which proposal touches a row: the number it carries in the margin while the team decides. */
const PROPOSAL_OF_ROW: Readonly<Record<string, ProposalId>> = { c2: "normalise", c3: "unify", c4: "unify" };
const PROPOSALS: readonly ProposalId[] = ["unify", "normalise", "map"];
const markOf = (id: ProposalId): string => String(PROPOSALS.indexOf(id) + 1);

function Row({ row, step, approved }: { readonly row: JourneyRow; readonly step: number; readonly approved: ReadonlySet<ProposalId> }): ReactElement {
  const applied = step >= PREPARE;
  const proposal = PROPOSAL_OF_ROW[row.id];
  const unified = applied && approved.has("unify");
  // the row unified into another keeps its place, struck through, so the window never changes height
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
      <span className={cx("kauro-walk-cell kauro-walk-cell--name", flagged("name") && "is-flag")}>
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
      <span className={cx("kauro-walk-cell kauro-walk-cell--mono kauro-walk-cell--email", flagged("email") && "is-flag")}>{row.email}</span>
      <span className={cx("kauro-walk-cell kauro-walk-cell--company", flagged("company") && "is-flag")}>{row.company ?? "—"}</span>
    </div>
  );
}

const STATE: readonly PublicCopyId[] = ["how.frag.sealed", "home.journey.measured", "home.journey.approved.count", "how.frag.quote", "home.journey.preparing", "home.frag.team"];
const DONE: ReadonlyArray<PublicCopyId | null> = [null, null, null, null, "home.app.state.label", "home.journey.imported"];

export function Journey({ eyebrow, heading, headingId }: { readonly eyebrow: string; readonly heading: string; readonly headingId: string }): ReactElement {
  const [step, setStep] = useState(UPLOAD);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [approvals, setApprovals] = useState(0);
  useEffect(() => setReady(true), []);
  // playing: each step stays for its time, then the next one comes; the last one stops the film
  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setTimeout(() => {
      if (step >= LAST) setPlaying(false);
      else setStep(step + 1);
    }, STEPS[step]?.ms ?? 4500);
    return () => window.clearTimeout(timer);
  }, [playing, step]);
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
  // what the file line says at the step: its rows, and at the quote the price of the sealed rows
  const fact = step === QUOTE ? copy("home.journey.quote.line", { price: formatUsd(priceOf(bandIndexOf(SAMPLE.contacts) ?? 0, "CLEAN")), count: formatCount(SAMPLE.contacts) }) : copy("home.files.rows", { count: formatCount(rows) });
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className={cx("kauro-walk", "kauro-walk--book", ready && "is-ready", playing && "is-playing", `is-step-${step}`)}>
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
            <span key={step === UPLOAD ? "seal-upload" : "seal"} className="kauro-walk-sealed">
              {PUBLIC_COPY["how.frag.sealed"]}
            </span>
            <span key={step === QUOTE ? "quote" : "rows"} className="kauro-walk-rows">
              {fact}
            </span>
          </p>
          <div className="kauro-walk-table">
            <div className="kauro-walk-row kauro-walk-row--head">
              <span className="kauro-walk-cell kauro-walk-cell--mark">
                {step >= DECIDE ? <span className={cx("kauro-walk-mark", approved.has("map") && "is-approved")}>{markOf("map")}</span> : null}
              </span>
              <span className="kauro-walk-cell kauro-walk-cell--name">{PUBLIC_COPY["home.app.contact.label"]}</span>
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
            </div>
            {JOURNEY_ROWS.map((row) => (
              <Row key={row.id} row={row} step={step} approved={approved} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

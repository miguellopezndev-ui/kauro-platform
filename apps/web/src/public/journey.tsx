"use client";

// The process on Home as one file the visitor walks through four steps (A10 §8). It is the same window and the same rows of contacts.csv
// from the first step to the last; each step changes them in place. Measure flags what the health check finds. Decide asks for the three
// changes, which the visitor approves themselves. Prepare applies only what was approved: the duplicate pair folds into one row, the
// name is normalised, the column renamed, and the row count runs down. Import hands the same file over, in order. The window keeps its size,
// so nothing on the page moves. Without the script the four steps are listed and the window shows the first one.
import { useEffect, useState, type ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { formatCount } from "./pricing-bands.ts";
import { JOURNEY_ROWS, MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_COLUMN, SAMPLE_SOURCES, sharePercent, type JourneyRow, type RowFlag } from "./sample-data.ts";
import { useCountUp } from "./tabs.ts";

type ProposalId = "unify" | "normalise" | "map";

const STEPS: ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId }> = [
  { name: "home.process.measure.name", body: "home.process.measure.body" },
  { name: "home.process.decide.name", body: "home.process.decide.body" },
  { name: "home.process.prepare.name", body: "home.process.prepare.body" },
  { name: "home.process.import.name", body: "home.process.import.body" },
];
const MEASURE = 0;
const DECIDE = 1;
const PREPARE = 2;
const IMPORT = 3;

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const two = (n: number): string => String(n).padStart(2, "0");
const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const sourceRows = contacts?.source ?? SAMPLE.contacts;
const countOf = (label: PublicCopyId): number => REPORT_ROWS.find((row) => row.label === label)?.count ?? 0;

/** Which proposal touches a row: the number it carries in the margin while the visitor decides. */
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
  const flagged = (flag: RowFlag): boolean => row.flags.includes(flag) && !(flag === "duplicate" && unified) && !(flag === "name" && renamed);
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

function Tray({ step, approved, toggle, run }: { readonly step: number; readonly approved: ReadonlySet<ProposalId>; readonly toggle: (id: ProposalId) => void; readonly run: boolean }): ReactElement {
  switch (step) {
    case MEASURE:
      return (
        <ul className="kauro-walk-metrics" aria-hidden="true">
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
        <div className="kauro-walk-decide">
          <ul className="kauro-walk-proposals">
            {PROPOSALS.map((id) => {
              const on = approved.has(id);
              return (
                <li key={id} className={cx("kauro-walk-proposal", on && "is-approved")}>
                  <span className="kauro-walk-mark" aria-hidden="true">
                    {markOf(id)}
                  </span>
                  <span className="kauro-walk-proposal-title">{title[id]}</span>
                  <span className="kauro-walk-proposal-detail" aria-hidden="true">
                    {detail[id]}
                  </span>
                  <button type="button" className="kauro-walk-approve" aria-pressed={on} onClick={() => toggle(id)}>
                    {on ? PUBLIC_COPY["home.journey.approved"] : PUBLIC_COPY["home.frag.approve"]}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="kauro-walk-hint" role="status">
            {approved.size === PROPOSALS.length ? PUBLIC_COPY["home.journey.all"] : PUBLIC_COPY["home.journey.waiting"]}
          </p>
        </div>
      );
    }
    case PREPARE: {
      const skipped = PROPOSALS.length - approved.size;
      return (
        <ul className="kauro-walk-checks" aria-hidden="true">
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
        <div className="kauro-walk-import" aria-hidden="true">
          <p className="kauro-walk-label">{PUBLIC_COPY["home.frag.order"]}</p>
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

const STATE: readonly PublicCopyId[] = ["home.journey.measured", "home.journey.approved.count", "home.journey.preparing", "home.frag.team"];
const DONE: ReadonlyArray<PublicCopyId | null> = [null, null, "home.app.state.label", "home.journey.imported"];

export function Journey(): ReactElement {
  const [step, setStep] = useState(MEASURE);
  const [ready, setReady] = useState(false);
  const [approved, setApproved] = useState<ReadonlySet<ProposalId>>(new Set());
  useEffect(() => setReady(true), []);
  const toggle = (id: ProposalId): void =>
    setApproved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const go = (next: number): void => {
    if (next === MEASURE && step === IMPORT) setApproved(new Set());
    setStep(next);
  };
  const out = approved.has("unify") ? (contacts?.rows ?? sourceRows) : sourceRows;
  const counted = useCountUp(out, ready && step === PREPARE, sourceRows, 1400);
  const rows = step < PREPARE ? sourceRows : step === PREPARE ? counted : out;
  const mapped = step >= PREPARE && approved.has("map");
  const fileName = step >= PREPARE ? SAMPLE.contactsFile : (SAMPLE_SOURCES[0] ?? SAMPLE.contactsFile);
  const done = DONE[step] ?? null;
  const state = STATE[step] === "home.journey.approved.count" ? copy("home.journey.approved.count", { count: `${approved.size}/${PROPOSALS.length}` }) : PUBLIC_COPY[STATE[step] ?? "home.journey.measured"];
  return (
    <div className={cx("kauro-walk", ready && "is-ready", `is-step-${step}`)}>
      <ol className="kauro-walk-steps" aria-label={PUBLIC_COPY["home.journey.label"]}>
        {STEPS.map((entry, index) => (
          <li key={entry.name} className={cx("kauro-walk-step", index < step && "is-done", index === step && "is-current")}>
            <span className="kauro-walk-step-number" aria-hidden="true">
              {two(index + 1)}
            </span>
            <h3>
              {ready ? (
                <button type="button" aria-current={index === step ? "step" : undefined} onClick={() => go(index)}>
                  {PUBLIC_COPY[entry.name]}
                </button>
              ) : (
                PUBLIC_COPY[entry.name]
              )}
            </h3>
            <p>{PUBLIC_COPY[entry.body]}</p>
          </li>
        ))}
      </ol>
      {ready ? (
        <div className="kauro-walk-controls">
          <button type="button" className="kauro-walk-next" onClick={() => go(step === IMPORT ? MEASURE : step + 1)}>
            {step === IMPORT ? PUBLIC_COPY["home.journey.restart.cta"] : PUBLIC_COPY["home.journey.next.cta"]}
          </button>
        </div>
      ) : null}
      <div className="kauro-walk-window">
        <div className="kauro-walk-bar" aria-hidden="true">
          <span className="kauro-walk-brand">{PUBLIC_COPY["site.name"]}</span>
          <span className="kauro-walk-project">{PUBLIC_COPY["home.app.project.name"]}</span>
          <span key={`state-${step}`} className={cx("kauro-walk-chip", done !== null && "kauro-walk-chip--swap")}>
            <span className="kauro-walk-chip-now">{state}</span>
            {done === null ? null : <span className="kauro-walk-chip-then">{PUBLIC_COPY[done]}</span>}
          </span>
        </div>
        <div className="kauro-walk-sheet" aria-hidden="true">
          <p className="kauro-walk-file">
            <FileName key={fileName}>{fileName}</FileName>
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
        </div>
        <div className="kauro-walk-tray" key={`tray-${step}`}>
          <Tray step={step} approved={approved} toggle={toggle} run={ready && step === MEASURE} />
        </div>
      </div>
    </div>
  );
}

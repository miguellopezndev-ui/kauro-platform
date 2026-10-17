"use client";

// The process on Home as a journey the visitor walks (A10 §7): four steps on a rail, and for each one the Kauro window as it looks at that
// step, from the synthetic sample. The visitor can approve the proposed changes in the Decide step themselves, watch the counts reconcile in
// Prepare and the files go in, in order, in Import. Without the script the four steps are simply shown one after the other.
import { useState, type ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { formatCount } from "./pricing-bands.ts";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_COLUMN, SAMPLE_RECORDS, sharePercent } from "./sample-data.ts";
import { useCountUp, useTabs } from "./tabs.ts";

type StepKey = "measure" | "decide" | "prepare" | "import";

const STEPS: ReadonlyArray<{ readonly key: StepKey; readonly name: PublicCopyId; readonly body: PublicCopyId }> = [
  { key: "measure", name: "home.process.measure.name", body: "home.process.measure.body" },
  { key: "decide", name: "home.process.decide.name", body: "home.process.decide.body" },
  { key: "prepare", name: "home.process.prepare.name", body: "home.process.prepare.body" },
  { key: "import", name: "home.process.import.name", body: "home.process.import.body" },
];

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const two = (n: number): string => String(n).padStart(2, "0");
const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);

function Window({ state, done, children }: { readonly state: string; readonly done?: string; readonly children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div className="kauro-journey-window">
      <div className="kauro-journey-bar">
        <span className="kauro-journey-brand">{PUBLIC_COPY["site.name"]}</span>
        <span className="kauro-journey-project">{PUBLIC_COPY["home.app.project.name"]}</span>
        <span className={cx("kauro-journey-chip", done !== undefined && "kauro-journey-chip--swap")}>
          <span className="kauro-journey-chip-now">{state}</span>
          {done === undefined ? null : <span className="kauro-journey-chip-then">{done}</span>}
        </span>
      </div>
      <div className="kauro-journey-body">{children}</div>
    </div>
  );
}

function Metric({ label, count, population, max, active }: { readonly label: string; readonly count: number; readonly population: number; readonly max: number; readonly active: boolean }): ReactElement {
  const shown = useCountUp(count, active);
  return (
    <li className="kauro-journey-metric">
      <span className="kauro-journey-metric-figure">{formatCount(shown)}</span>
      <span className="kauro-journey-metric-label">{label}</span>
      <span className="kauro-journey-metric-share">{sharePercent(count, population)}</span>
      <progress className="kauro-journey-meter" max={max} value={shown} aria-hidden="true" />
    </li>
  );
}

function Measure({ active }: { readonly active: boolean }): ReactElement {
  const rows = [
    { id: "sample.report.duplicates", label: PUBLIC_COPY["home.frag.candidates"] },
    { id: "sample.report.emails", label: PUBLIC_COPY["home.frag.invalid"] },
    { id: "sample.report.company", label: PUBLIC_COPY["home.frag.company"] },
  ] as const;
  const found = rows.map((row) => ({ ...row, count: REPORT_ROWS.find((report) => report.label === row.id)?.count ?? 0 }));
  const max = Math.max(...found.map((row) => row.count));
  return (
    <Window state={PUBLIC_COPY["home.journey.measured"]}>
      <p className="kauro-journey-file">
        <FileName>{SAMPLE.contactsFile.replace("-clean", "")}</FileName>
        <span>{copy("home.files.rows", { count: formatCount(SAMPLE.contacts) })}</span>
      </p>
      <ul className="kauro-journey-metrics">
        {found.map((row) => (
          <Metric key={row.id} label={row.label} count={row.count} population={SAMPLE.contacts} max={max} active={active} />
        ))}
      </ul>
    </Window>
  );
}

function Decide(): ReactElement {
  const candidate = SAMPLE_RECORDS.find((record) => record.result === "candidate");
  const normalised = SAMPLE_RECORDS.find((record) => record.result === "normalised");
  const proposals = [
    { id: "unify", title: copy("home.frag.unify", { count: 2 }), detail: candidate?.name ?? "" },
    { id: "normalise", title: PUBLIC_COPY["home.journey.normalise"], detail: `${normalised?.before ?? ""} → ${normalised?.name ?? ""}` },
    { id: "map", title: PUBLIC_COPY["home.journey.map"], detail: `${SAMPLE_COLUMN.from} → ${SAMPLE_COLUMN.to}` },
  ];
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setApproved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Window state={copy("home.journey.approved.count", { count: `${approved.size}/${proposals.length}` })}>
      <ul className="kauro-journey-proposals">
        {proposals.map((proposal) => {
          const on = approved.has(proposal.id);
          return (
            <li key={proposal.id} className={cx("kauro-journey-proposal", on && "is-approved")}>
              <span className="kauro-journey-proposal-title">{proposal.title}</span>
              <span className="kauro-journey-proposal-detail">{proposal.detail}</span>
              <button type="button" className="kauro-journey-approve" aria-pressed={on} onClick={() => toggle(proposal.id)}>
                {on ? PUBLIC_COPY["home.journey.approved"] : PUBLIC_COPY["home.frag.approve"]}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="kauro-journey-hint" role="status">
        {approved.size === proposals.length ? PUBLIC_COPY["home.journey.all"] : PUBLIC_COPY["home.journey.waiting"]}
      </p>
    </Window>
  );
}

function Prepare({ active }: { readonly active: boolean }): ReactElement {
  const out = useCountUp(contacts?.rows ?? 0, active, contacts?.source ?? 0, 1400);
  return (
    <Window state={PUBLIC_COPY["home.journey.preparing"]} done={PUBLIC_COPY["home.app.state.label"]}>
      <p className="kauro-journey-sum">
        <span className="kauro-journey-sum-from">{formatCount(contacts?.source ?? 0)}</span>
        <span className="kauro-journey-sum-arrow" aria-hidden="true" />
        <span className="kauro-journey-sum-to">{formatCount(out)}</span>
      </p>
      <ul className="kauro-journey-checks">
        <li>{PUBLIC_COPY["home.journey.applied"]}</li>
        <li>{PUBLIC_COPY["home.journey.traced"]}</li>
        <li>{PUBLIC_COPY["home.app.phase.prepare.body"]}</li>
      </ul>
    </Window>
  );
}

function Import(): ReactElement {
  const files = [...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]];
  return (
    <Window state={PUBLIC_COPY["home.frag.team"]} done={PUBLIC_COPY["home.journey.imported"]}>
      <p className="kauro-journey-label">{PUBLIC_COPY["home.frag.order"]}</p>
      <ol className="kauro-journey-order">
        {files.map((file) => (
          <li key={file}>
            <FileName>{file}</FileName>
          </li>
        ))}
      </ol>
      <p className="kauro-journey-compare">{PUBLIC_COPY["sample.guide.step.counts"]}</p>
    </Window>
  );
}

function Stage({ step, active }: { readonly step: StepKey; readonly active: boolean }): ReactElement {
  switch (step) {
    case "measure":
      return <Measure active={active} />;
    case "decide":
      return <Decide />;
    case "prepare":
      return <Prepare active={active} />;
    case "import":
      return <Import />;
  }
}

export function Journey(): ReactElement {
  const tabs = useTabs(STEPS.length);
  const last = STEPS.length - 1;
  return (
    <div className={cx("kauro-journey", tabs.ready && "is-ready", `is-step-${tabs.index}`)}>
      <div className="kauro-journey-track" role="tablist" aria-label={PUBLIC_COPY["home.journey.label"]} onKeyDown={tabs.onKeyDown}>
        <span className="kauro-journey-rail" aria-hidden="true">
          <span className="kauro-journey-fill" />
        </span>
        {STEPS.map((step, index) => (
          <button
            key={step.key}
            ref={(element) => {
              tabs.refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`journey-tab-${step.key}`}
            aria-selected={tabs.index === index}
            aria-controls={`journey-panel-${step.key}`}
            tabIndex={tabs.index === index ? 0 : -1}
            className={cx("kauro-journey-tab", index < tabs.index && "is-done", index === tabs.index && "is-current")}
            onClick={() => tabs.select(index)}
          >
            <span className="kauro-journey-dot" aria-hidden="true">
              {two(index + 1)}
            </span>
            <span className="kauro-journey-name">{PUBLIC_COPY[step.name]}</span>
          </button>
        ))}
      </div>
      {STEPS.map((step, index) => {
        const shown = !tabs.ready || tabs.index === index;
        return (
          <div
            key={step.key}
            role="tabpanel"
            id={`journey-panel-${step.key}`}
            aria-labelledby={`journey-tab-${step.key}`}
            hidden={!shown}
            className="kauro-journey-panel"
          >
            <div className="kauro-journey-copy">
              <p className="kauro-journey-count" aria-hidden="true">
                {`${two(index + 1)} / ${two(STEPS.length)}`}
              </p>
              <h3>{PUBLIC_COPY[step.name]}</h3>
              <p>{PUBLIC_COPY[step.body]}</p>
              {tabs.ready ? (
                <div className="kauro-journey-controls">
                  {index > 0 ? (
                    <button type="button" className="kauro-journey-back" onClick={() => tabs.select(index - 1)}>
                      {PUBLIC_COPY["home.journey.previous.cta"]}
                    </button>
                  ) : null}
                  <button type="button" className="kauro-journey-next" onClick={() => tabs.select(index === last ? 0 : index + 1)}>
                    {index === last ? PUBLIC_COPY["home.journey.restart.cta"] : PUBLIC_COPY["home.journey.next.cta"]}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="kauro-journey-stage">{shown ? <Stage key={`${step.key}-${tabs.ready ? tabs.index : "all"}`} step={step.key} active={tabs.ready && tabs.index === index} /> : null}</div>
          </div>
        );
      })}
    </div>
  );
}

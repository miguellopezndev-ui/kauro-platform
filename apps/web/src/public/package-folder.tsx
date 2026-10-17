"use client";

// What the team receives (Home): the delivery package as a folder with four tabs, and each tab opens the document it holds, drawn from the
// synthetic sample: the report's counts, the cleaned file with a change it explains, the manifest that adds up and traces rows, the import
// steps in order. Without the script the four documents are shown one after the other.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../copy/public.ts";
import { FileName } from "./parts.tsx";
import { formatCount } from "./pricing-bands.ts";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_RECORDS, SAMPLE_TRACE, sharePercent } from "./sample-data.ts";
import { useTabs } from "./tabs.ts";

type DocKey = "report" | "files" | "manifest" | "steps";

const DOCS: ReadonlyArray<{ readonly key: DocKey; readonly name: PublicCopyId; readonly body: PublicCopyId }> = [
  { key: "report", name: "home.delivery.report.name", body: "home.delivery.report" },
  { key: "files", name: "home.delivery.files.name", body: "home.delivery.files" },
  { key: "manifest", name: "home.delivery.manifest.name", body: "home.delivery.manifest" },
  { key: "steps", name: "home.delivery.steps.name", body: "home.delivery.steps" },
];

const cx = (...names: ReadonlyArray<string | false>): string => names.filter((name) => name !== false && name !== "").join(" ");
const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);

function Report(): ReactElement {
  const rows = [
    { id: "sample.report.duplicates", label: PUBLIC_COPY["home.frag.candidates"] },
    { id: "sample.report.emails", label: PUBLIC_COPY["home.frag.invalid"] },
    { id: "sample.report.company", label: PUBLIC_COPY["home.frag.company"] },
  ] as const;
  return (
    <div className="kauro-doc kauro-doc--report">
      <p className="kauro-doc-title">{PUBLIC_COPY["health-check.title"]}</p>
      <p className="kauro-doc-meta">{copy("sample.report.unit.contacts", { count: formatCount(SAMPLE.contacts) })}</p>
      <ul className="kauro-doc-lines">
        {rows.map((row) => {
          const count = REPORT_ROWS.find((report) => report.label === row.id)?.count ?? 0;
          return (
            <li key={row.id}>
              <span className="kauro-doc-figure">{formatCount(count)}</span>
              <span className="kauro-doc-label">{row.label}</span>
              <span className="kauro-doc-share">{sharePercent(count, SAMPLE.contacts)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Files(): ReactElement {
  return (
    <div className="kauro-doc kauro-doc--files">
      <p className="kauro-doc-title">
        <FileName>{SAMPLE.contactsFile}</FileName>
      </p>
      <p className="kauro-doc-meta">{copy("home.files.rows", { count: formatCount(contacts?.rows ?? 0) })}</p>
      <div className="kauro-doc-grid">
        <span className="kauro-doc-head">{PUBLIC_COPY["home.app.contact.label"]}</span>
        <span className="kauro-doc-head">{PUBLIC_COPY["home.app.email.label"]}</span>
        {SAMPLE_RECORDS.map((record) => (
          <span key={record.email} className={cx("kauro-doc-row", record.before !== null && "is-changed")}>
            <span className="kauro-doc-cell">
              {record.before === null ? null : <s>{record.before}</s>}
              {record.name}
            </span>
            <span className="kauro-doc-cell kauro-doc-cell--mono">{record.email}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Manifest(): ReactElement {
  return (
    <div className="kauro-doc kauro-doc--manifest">
      <p className="kauro-doc-sum">
        <span>{formatCount(contacts?.source ?? 0)}</span>
        <span className="kauro-doc-op">{"−"}</span>
        <span>{formatCount(contacts?.unified ?? 0)}</span>
        <span className="kauro-doc-op">=</span>
        <span className="kauro-doc-sum-total">{formatCount(contacts?.rows ?? 0)}</span>
      </p>
      <div className="kauro-doc-trace">
        <span className="kauro-doc-head">{PUBLIC_COPY["home.package.trace.label"]}</span>
        <span className="kauro-doc-head">{PUBLIC_COPY["home.package.trace.from"]}</span>
        {SAMPLE_TRACE.map((line) => (
          <span key={line.output} className={cx("kauro-doc-row", line.unified !== null && "is-changed")}>
            <span className="kauro-doc-cell kauro-doc-cell--mono">{formatCount(line.output)}</span>
            <span className="kauro-doc-cell kauro-doc-cell--mono">
              {formatCount(line.source)}
              {line.unified === null ? null : <span className="kauro-doc-unified">{`+ ${formatCount(line.unified)} · ${PUBLIC_COPY["home.package.trace.unified"]}`}</span>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Steps(): ReactElement {
  return (
    <div className="kauro-doc kauro-doc--steps">
      <p className="kauro-doc-title">{PUBLIC_COPY["sample.guide.heading"]}</p>
      <ol className="kauro-doc-steps">
        <li>{PUBLIC_COPY["sample.guide.step.companies"]}</li>
        <li>{PUBLIC_COPY["sample.guide.step.contacts"]}</li>
        <li>{PUBLIC_COPY["sample.guide.step.links"]}</li>
        <li>{PUBLIC_COPY["sample.guide.step.counts"]}</li>
      </ol>
    </div>
  );
}

function Doc({ doc }: { readonly doc: DocKey }): ReactElement {
  switch (doc) {
    case "report":
      return <Report />;
    case "files":
      return <Files />;
    case "manifest":
      return <Manifest />;
    case "steps":
      return <Steps />;
  }
}

export function PackageFolder({ sampleHref, sampleLabel }: { readonly sampleHref: string; readonly sampleLabel: string }): ReactElement {
  const tabs = useTabs(DOCS.length);
  return (
    <div className={cx("kauro-folder", tabs.ready && "is-ready")}>
      <div className="kauro-folder-tabs" role="tablist" aria-label={PUBLIC_COPY["home.package.label"]} onKeyDown={tabs.onKeyDown}>
        {DOCS.map((doc, index) => (
          <button
            key={doc.key}
            ref={(element) => {
              tabs.refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`folder-tab-${doc.key}`}
            aria-selected={tabs.index === index}
            aria-controls={`folder-panel-${doc.key}`}
            tabIndex={tabs.index === index ? 0 : -1}
            className="kauro-folder-tab"
            onClick={() => tabs.select(index)}
          >
            <span className="kauro-folder-tab-number" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            {PUBLIC_COPY[doc.name]}
          </button>
        ))}
      </div>
      {DOCS.map((doc, index) => {
        const shown = !tabs.ready || tabs.index === index;
        return (
          <div key={doc.key} role="tabpanel" id={`folder-panel-${doc.key}`} aria-labelledby={`folder-tab-${doc.key}`} hidden={!shown} className="kauro-folder-panel">
            <div className="kauro-folder-copy">
              <h3>{PUBLIC_COPY[doc.name]}</h3>
              <p>{PUBLIC_COPY[doc.body]}</p>
              <a className="kauro-site-arrow" href={sampleHref}>
                {sampleLabel}
              </a>
            </div>
            <div className="kauro-folder-doc">{shown ? <Doc key={`${doc.key}-${tabs.ready ? tabs.index : "all"}`} doc={doc.key} /> : null}</div>
          </div>
        );
      })}
    </div>
  );
}

// UI05 Sample delivery (A3 3.6): a synthetic delivery, labelled as such before anything else, whose numbers reconcile. Every figure comes
// from sample-data.ts; nothing here is a real customer, logo, quote or import, and the page carries no address.
//
// Order 11 round 2: the head shows the real thing instead of a picture of it, a crop of the sample report's own table, and the next section
// starts in the first screen. The package is named document by document before each is shown. The report keeps its table and says how to
// read it; the duplicate counts (candidate groups, approved unifications, unified rows) moved here from How it works, beside the report they
// explain; the manifest states its sum once, in words and in its table, with no strip of large figures repeating it. The page ends in the
// closing band every decision page shares.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { MarginNote } from "../artifacts.tsx";
import { DataTable, Stamp } from "../parts.tsx";
import { formatCount } from "../pricing-bands.ts";
import { Block, CHECK_CTA, Closing, Head } from "../r2.tsx";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_GROUPS, sharePercent } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

const n = formatCount;

/** The first rows of the sample report, drawn as the report draws them: what the reader sees first is the delivery itself. */
function ReportCrop(): ReactElement {
  return (
    <div className="kauro-r2-crop kauro-paper" aria-hidden="true">
      <p className="kauro-r2-crop-title">{PUBLIC_COPY["sample.report.table.caption"]}</p>
      <div className="kauro-r2-crop-rows">
        {REPORT_ROWS.slice(0, 4).map((row) => (
          <p key={row.label} className="kauro-r2-crop-row">
            <span>{PUBLIC_COPY[row.label]}</span>
            <span className="kauro-r2-crop-figure">{formatCount(row.count)}</span>
            <span className="kauro-r2-crop-share">{row.population === null ? PUBLIC_COPY["sample.report.na"] : sharePercent(row.count, row.population)}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

const PACKAGE = [
  { key: "report", href: "#sample-report", name: "sample.package.report.name", body: "sample.package.report.body" },
  { key: "files", href: "#sample-manifest", name: "sample.package.files.name", body: "sample.package.files.body" },
  { key: "manifest", href: "#sample-manifest", name: "sample.package.manifest.name", body: "sample.package.manifest.body" },
  { key: "guide", href: "#sample-guide", name: "sample.package.guide.name", body: "sample.package.guide.body" },
] as const;

export function SampleDeliveryPage(): ReactElement {
  const contactsFile = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  const { pairs, triples, pairsKeptApart } = SAMPLE_GROUPS;
  const groups = pairs + triples;
  return (
    <>
      <Head kind="path" accent={2} eyebrow={PUBLIC_COPY["nav.sample.label"]} title={PUBLIC_COPY["sample.title"]} lead={PUBLIC_COPY["sample.lead"]} aside={<ReportCrop />}>
        <p className="kauro-site-stamp-line">
          <Stamp>{PUBLIC_COPY["sample.badge.label"]}</Stamp>
        </p>
      </Head>
      <Block id="sample-package" heading={PUBLIC_COPY["sample.package.heading"]} variant="kauro-r2-block--first">
        <ul className="kauro-r2-package">
          {PACKAGE.map((item) => (
            <li key={item.key}>
              <a href={item.href}>
                <span className="kauro-r2-package-name">{PUBLIC_COPY[item.name]}</span>
                <span className="kauro-r2-package-body">{PUBLIC_COPY[item.body]}</span>
              </a>
            </li>
          ))}
        </ul>
      </Block>
      <Block id="sample-report" heading={PUBLIC_COPY["sample.report.heading"]} lead={copy("sample.report.intro", { contacts: n(SAMPLE.contacts) })} tone="sunken">
        <DataTable
          variant="kauro-r2-report"
          caption={PUBLIC_COPY["sample.report.table.caption"]}
          columns={[PUBLIC_COPY["sample.report.measure.label"], PUBLIC_COPY["sample.report.count.label"], PUBLIC_COPY["sample.report.population.label"], PUBLIC_COPY["sample.report.share.label"]]}
          rows={REPORT_ROWS.map((row) => ({
            key: row.label,
            head: PUBLIC_COPY[row.label],
            cells: [
              n(row.count),
              row.population === null ? PUBLIC_COPY["sample.report.na"] : copy("sample.report.unit.contacts", { count: n(row.population) }),
              row.population === null ? PUBLIC_COPY["sample.report.na"] : sharePercent(row.count, row.population),
            ],
          }))}
        />
        <MarginNote>{PUBLIC_COPY["sample.note.population"]}</MarginNote>
      </Block>
      {contactsFile === undefined ? null : (
        <Block id="sample-duplicates" heading={PUBLIC_COPY["sample.duplicates.heading"]} lead={PUBLIC_COPY["sample.duplicates.lead"]} layout="split">
          <DataTable
            caption={PUBLIC_COPY["how.example.counts.caption"]}
            columns={[PUBLIC_COPY["how.example.counts.what"], PUBLIC_COPY["how.example.counts.figure"], PUBLIC_COPY["how.example.counts.meaning"]]}
            stack
            variant="kauro-r2-ledger"
            rows={[
              { key: "groups", head: PUBLIC_COPY["how.example.groups.label"], cells: [copy("how.example.groups.value", { count: n(groups), contacts: n(pairs * 2 + triples * 3) }), PUBLIC_COPY["how.example.groups.meaning"]] },
              { key: "approved", head: PUBLIC_COPY["how.example.approved.label"], cells: [copy("how.example.approved.value", { count: n(groups - pairsKeptApart), max: n(groups) }), copy("how.example.approved.meaning", { kept: n(pairsKeptApart) })] },
              { key: "unified", head: PUBLIC_COPY["how.example.unified.label"], cells: [n(contactsFile.unified), copy("how.example.unified.meaning", { source: n(contactsFile.source), output: n(contactsFile.rows) })] },
            ]}
          />
        </Block>
      )}
      <Block id="sample-manifest" heading={PUBLIC_COPY["sample.manifest.heading"]} layout="split" tone="sunken">
        {contactsFile === undefined ? null : <p>{copy("sample.manifest.body", { source: n(contactsFile.source), unified: n(contactsFile.unified), output: n(contactsFile.rows) })}</p>}
        <DataTable
          variant="kauro-r2-files"
          caption={PUBLIC_COPY["sample.manifest.table.caption"]}
          columns={[PUBLIC_COPY["sample.manifest.file.label"], PUBLIC_COPY["sample.manifest.rows.label"], PUBLIC_COPY["sample.manifest.source.label"], PUBLIC_COPY["sample.manifest.unified.label"]]}
          rows={MANIFEST_FILES.map((file) => ({ key: file.name, head: file.name, cells: [n(file.rows), n(file.source), n(file.unified)] }))}
        />
      </Block>
      <Block id="sample-guide" heading={PUBLIC_COPY["sample.guide.heading"]} lead={PUBLIC_COPY["sample.guide.intro"]} layout="split">
        <ol className="kauro-r2-steps">
          <li>{PUBLIC_COPY["sample.guide.step.companies"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.contacts"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.links"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.counts"]}</li>
        </ol>
      </Block>
      <Closing id="sample-limits" heading={PUBLIC_COPY["sample.time.heading"]} body={PUBLIC_COPY["sample.time.body"]} primary={CHECK_CTA} links={[{ href: ROUTE.pricing, label: PUBLIC_COPY["sample.next.cta"] }]} />
    </>
  );
}

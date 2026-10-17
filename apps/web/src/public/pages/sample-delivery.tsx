// UI05 Sample delivery (A3 3.6): a synthetic delivery, labelled as such before anything else, whose numbers reconcile. Every figure comes
// from sample-data.ts; nothing here is a real customer, logo, quote or import, and the page carries no address.
//
// The page is laid out like the package itself: the report as a document, the manifest with its sum written out, and the importer guide as
// numbered steps.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { formatCount } from "../pricing-bands.ts";
import { DataTable, FileName, LinkButton, PageHead, Section, Stamp, rich } from "../parts.tsx";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, sharePercent } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

export function SampleDeliveryPage(): ReactElement {
  const contactsFile = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  return (
    <>
      <PageHead
        tone="clay"
        accent={2}
        eyebrow={PUBLIC_COPY["nav.sample.label"]}
        title={PUBLIC_COPY["sample.title"]}
        lead={PUBLIC_COPY["sample.lead"]}
        aside={
          <div className="kauro-site-cover" aria-hidden="true">
            <div className="kauro-site-cover-sheet">
              <p className="kauro-site-cover-kicker">{PUBLIC_COPY["sample.report.heading"]}</p>
              <p className="kauro-site-cover-figure">{formatCount(SAMPLE.contacts)}</p>
              <p className="kauro-site-cover-label">{PUBLIC_COPY["sample.report.contacts"]}</p>
            </div>
          </div>
        }
      >
        <p className="kauro-site-stamp-line">
          <Stamp>{PUBLIC_COPY["sample.badge.label"]}</Stamp>
        </p>
      </PageHead>
      <Section id="sample-report" heading={PUBLIC_COPY["sample.report.heading"]} tone="sunken" variant="kauro-site-document">
        <div className="kauro-site-sheet">
          <p className="kauro-site-sheet-intro">{rich("sample.report.intro", { contacts: formatCount(SAMPLE.contacts) })}</p>
          <DataTable
            variant="kauro-site-table-region--report"
            caption={PUBLIC_COPY["sample.report.table.caption"]}
            columns={[PUBLIC_COPY["sample.report.measure.label"], PUBLIC_COPY["sample.report.count.label"], PUBLIC_COPY["sample.report.population.label"], PUBLIC_COPY["sample.report.share.label"]]}
            rows={REPORT_ROWS.map((row) => ({
              key: row.label,
              head: PUBLIC_COPY[row.label],
              cells: [
                formatCount(row.count),
                row.population === null ? PUBLIC_COPY["sample.report.na"] : copy("sample.report.unit.contacts", { count: formatCount(row.population) }),
                row.population === null ? PUBLIC_COPY["sample.report.na"] : sharePercent(row.count, row.population),
              ],
            }))}
          />
        </div>
      </Section>
      <Section id="sample-manifest" heading={PUBLIC_COPY["sample.manifest.heading"]} layout="split">
        {contactsFile === undefined ? null : (
          <>
            <div className="kauro-site-sum" aria-hidden="true">
              <p className="kauro-site-sum-term">
                <span className="kauro-site-sum-value">{formatCount(contactsFile.source)}</span>
                <span className="kauro-site-sum-label">{PUBLIC_COPY["sample.manifest.source.label"]}</span>
              </p>
              <p className="kauro-site-sum-term kauro-site-sum-term--less">
                <span className="kauro-site-sum-value">{formatCount(contactsFile.unified)}</span>
                <span className="kauro-site-sum-label">{PUBLIC_COPY["sample.manifest.unified.label"]}</span>
              </p>
              <p className="kauro-site-sum-term kauro-site-sum-term--total">
                <span className="kauro-site-sum-value">{formatCount(contactsFile.rows)}</span>
                <span className="kauro-site-sum-label">
                  <FileName>{contactsFile.name}</FileName>
                </span>
              </p>
            </div>
            <p>
              {copy("sample.manifest.body", {
                source: formatCount(contactsFile.source),
                unified: formatCount(contactsFile.unified),
                output: formatCount(contactsFile.rows),
              })}
            </p>
          </>
        )}
        <DataTable
          variant="kauro-site-table-region--files"
          caption={PUBLIC_COPY["sample.manifest.table.caption"]}
          columns={[PUBLIC_COPY["sample.manifest.file.label"], PUBLIC_COPY["sample.manifest.rows.label"], PUBLIC_COPY["sample.manifest.source.label"], PUBLIC_COPY["sample.manifest.unified.label"]]}
          rows={MANIFEST_FILES.map((file) => ({ key: file.name, head: file.name, cells: [formatCount(file.rows), formatCount(file.source), formatCount(file.unified)] }))}
        />
      </Section>
      <Section id="sample-guide" heading={PUBLIC_COPY["sample.guide.heading"]} layout="split" lead={PUBLIC_COPY["sample.guide.intro"]} tone="clay">
        <ol className="kauro-site-numbered">
          <li>{PUBLIC_COPY["sample.guide.step.companies"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.contacts"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.links"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.counts"]}</li>
        </ol>
      </Section>
      <Section id="sample-limits" heading={PUBLIC_COPY["sample.time.heading"]} layout="split">
        <p className="kauro-site-statement kauro-site-statement--small">{PUBLIC_COPY["sample.time.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.pricing}>{PUBLIC_COPY["sample.next.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

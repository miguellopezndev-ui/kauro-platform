// UI05 Sample delivery (A3 3.6): a synthetic delivery, labelled as such before anything else, whose numbers reconcile. Every figure comes
// from sample-data.ts; nothing here is a real customer, logo, quote or import, and the page carries no address.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { formatCount } from "../pricing-bands.ts";
import { DataTable, LinkButton, PageHead, Section } from "../parts.tsx";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, sharePercent } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

export function SampleDeliveryPage(): ReactElement {
  const contactsFile = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  return (
    <>
      <PageHead title={PUBLIC_COPY["sample.title"]} lead={PUBLIC_COPY["sample.lead"]} />
      <p className="kauro-site-badge">{PUBLIC_COPY["sample.badge.label"]}</p>
      <Section id="sample-report" heading={PUBLIC_COPY["sample.report.heading"]}>
        <p>{copy("sample.report.intro", { contacts: formatCount(SAMPLE.contacts) })}</p>
        <DataTable
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
      </Section>
      <Section id="sample-manifest" heading={PUBLIC_COPY["sample.manifest.heading"]}>
        {contactsFile === undefined ? null : (
          <p>
            {copy("sample.manifest.body", {
              source: formatCount(contactsFile.source),
              unified: formatCount(contactsFile.unified),
              output: formatCount(contactsFile.rows),
            })}
          </p>
        )}
        <DataTable
          caption={PUBLIC_COPY["sample.manifest.table.caption"]}
          columns={[PUBLIC_COPY["sample.manifest.file.label"], PUBLIC_COPY["sample.manifest.rows.label"], PUBLIC_COPY["sample.manifest.source.label"], PUBLIC_COPY["sample.manifest.unified.label"]]}
          rows={MANIFEST_FILES.map((file) => ({ key: file.name, head: file.name, cells: [formatCount(file.rows), formatCount(file.source), formatCount(file.unified)] }))}
        />
      </Section>
      <Section id="sample-guide" heading={PUBLIC_COPY["sample.guide.heading"]}>
        <p>{PUBLIC_COPY["sample.guide.intro"]}</p>
        <ol className="kauro-site-steps">
          <li>{PUBLIC_COPY["sample.guide.step.companies"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.contacts"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.links"]}</li>
          <li>{PUBLIC_COPY["sample.guide.step.counts"]}</li>
        </ol>
      </Section>
      <Section id="sample-limits" heading={PUBLIC_COPY["sample.time.heading"]}>
        <p>{PUBLIC_COPY["sample.time.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.pricing}>{PUBLIC_COPY["sample.next.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

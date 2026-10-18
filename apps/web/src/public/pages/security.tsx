// UI06 Data handling (A3 3.5, manual 09): what is processed, how customers are kept apart, what a model may see, who decides, how long each
// kind of data stays (the full schedule, from the policy), what deletion does not cover, and what this page does not claim. It describes what
// Kauro does today; it claims no certification and no compliance outcome.
//
// The page opens on carbon, the colour of the serious part of the site, and reads like a policy: each heading beside its answer.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { DataTable, FileName, LinkButton, PageHead, Section } from "../parts.tsx";
import { SAMPLE } from "../sample-data.ts";
import { DEFECT_CLAIM_DAYS, DEFECT_REPAIR_BUSINESS_DAYS, DOWNLOAD_LINK_MINUTES, REUPLOAD_NOTICE, RETENTION_ROWS } from "../retention.ts";
import { ROUTE } from "../site.ts";

/** The sections of the page, in order, for the index in the head. */
const INDEX: ReadonlyArray<readonly [id: string, heading: PublicCopyId]> = [
  ["security-processed", "security.processed.heading"],
  ["security-isolation", "security.isolation.heading"],
  ["security-model", "security.model.heading"],
  ["security-authority", "security.authority.heading"],
  ["security-retention", "security.retention.heading"],
  ["security-residual", "security.residual.heading"],
  ["security-claims", "security.claims.heading"],
];

export function SecurityPage(): ReactElement {
  return (
    <>
      <PageHead eyebrow={PUBLIC_COPY["nav.security.label"]} title={PUBLIC_COPY["security.title"]} accent={4} lead={PUBLIC_COPY["security.lead"]} tone="inverse" variant="kauro-site-head-strata">
        <nav className="kauro-site-index" aria-label={PUBLIC_COPY["security.index.label"]}>
          <p className="kauro-site-index-title" aria-hidden="true">
            {PUBLIC_COPY["security.index.label"]}
          </p>
          <ol>
            {INDEX.map(([id, heading]) => (
              <li key={id}>
                <a href={`#${id}`}>{PUBLIC_COPY[heading]}</a>
              </li>
            ))}
          </ol>
        </nav>
      </PageHead>
      <Section id="security-processed" heading={PUBLIC_COPY["security.processed.heading"]} layout="split" variant="kauro-site-policy">
        <p className="kauro-site-statement kauro-site-statement--small">{PUBLIC_COPY["security.processed.body"]}</p>
        <p className="kauro-site-callout kauro-site-callout--warning">{PUBLIC_COPY["security.excluded.body"]}</p>
      </Section>
      <Section id="security-isolation" heading={PUBLIC_COPY["security.isolation.heading"]} layout="split" variant="kauro-site-policy">
        <p>{PUBLIC_COPY["security.isolation.body"]}</p>
        <div className="kauro-answer" aria-hidden="true">
          <span className="kauro-answer-ask">{PUBLIC_COPY["security.frag.request"]}</span>
          <span className="kauro-answer-stamp">{PUBLIC_COPY["security.frag.answer"]}</span>
        </div>
      </Section>
      <Section id="security-model" heading={PUBLIC_COPY["security.model.heading"]} layout="split" variant="kauro-site-policy">
        <p>{PUBLIC_COPY["security.model.body"]}</p>
        <div className="kauro-redact" aria-hidden="true">
          <span className="kauro-redact-file">
            <FileName>{SAMPLE.contactsFile}</FileName>
          </span>
          {Array.from({ length: 7 }, (_unused, index) =>
            index === 3 ? (
              <span key={index} className="kauro-redact-line kauro-redact-line--seen">
                {PUBLIC_COPY["security.frag.context"]}
              </span>
            ) : (
              <span key={index} className="kauro-redact-line" />
            ),
          )}
          <span className="kauro-redact-note">{PUBLIC_COPY["security.frag.whole"]}</span>
        </div>
      </Section>
      <Section id="security-authority" heading={PUBLIC_COPY["security.authority.heading"]} layout="split" variant="kauro-site-policy">
        <p>{PUBLIC_COPY["security.authority.body"]}</p>
      </Section>
      <Section id="security-retention" heading={PUBLIC_COPY["security.retention.heading"]} tone="sunken">
        <DataTable
          variant="kauro-site-table-region--retention"
          caption={PUBLIC_COPY["security.retention.table.caption"]}
          columns={[PUBLIC_COPY["security.retention.subject.label"], PUBLIC_COPY["security.retention.rule.label"]]}
          rows={RETENTION_ROWS.map((row, index) => ({ key: `retention-${index}`, head: row.subject, cells: [row.rule] }))}
        />
        <ul className="kauro-site-facts-inline">
          <li>{copy("security.retention.links", { minutes: DOWNLOAD_LINK_MINUTES })}</li>
          <li>{copy("security.retention.defect", { days: DEFECT_CLAIM_DAYS, repair: DEFECT_REPAIR_BUSINESS_DAYS })}</li>
          <li>{REUPLOAD_NOTICE}</li>
        </ul>
      </Section>
      <Section id="security-residual" heading={PUBLIC_COPY["security.residual.heading"]} layout="split" variant="kauro-site-policy">
        <p>{PUBLIC_COPY["security.residual.body"]}</p>
      </Section>
      <Section id="security-claims" heading={PUBLIC_COPY["security.claims.heading"]} layout="split" variant="kauro-site-policy">
        <p>{PUBLIC_COPY["security.claims.body"]}</p>
      </Section>
      <Section id="security-next" heading={PUBLIC_COPY["security.next.heading"]} layout="split" tone="inverse" variant="kauro-site-band-compact">
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.processing}>{PUBLIC_COPY["security.next.processing.cta"]}</LinkButton>
          <LinkButton href={ROUTE.privacy}>{PUBLIC_COPY["security.next.privacy.cta"]}</LinkButton>
          <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["security.next.ask.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

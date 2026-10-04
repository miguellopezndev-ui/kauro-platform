// UI06 Data handling (A3 3.5, manual 09): what is processed, how agencies are kept apart, what a model may see, who decides, how long each
// kind of data stays (the full schedule, from the policy), what deletion does not cover, and what this page does not claim. It describes what
// Kauro does today; it claims no certification and no compliance outcome.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { DataTable, LinkButton, PageHead, Section } from "../parts.tsx";
import { DEFECT_CLAIM_DAYS, DEFECT_REPAIR_BUSINESS_DAYS, DOWNLOAD_LINK_MINUTES, REUPLOAD_NOTICE, RETENTION_ROWS } from "../retention.ts";
import { ROUTE } from "../site.ts";

export function SecurityPage(): ReactElement {
  return (
    <>
      <PageHead title={PUBLIC_COPY["security.title"]} lead={PUBLIC_COPY["security.lead"]} />
      <Section id="security-processed" heading={PUBLIC_COPY["security.processed.heading"]}>
        <p>{PUBLIC_COPY["security.processed.body"]}</p>
        <p>{PUBLIC_COPY["security.excluded.body"]}</p>
      </Section>
      <Section id="security-isolation" heading={PUBLIC_COPY["security.isolation.heading"]}>
        <p>{PUBLIC_COPY["security.isolation.body"]}</p>
      </Section>
      <Section id="security-model" heading={PUBLIC_COPY["security.model.heading"]}>
        <p>{PUBLIC_COPY["security.model.body"]}</p>
      </Section>
      <Section id="security-authority" heading={PUBLIC_COPY["security.authority.heading"]}>
        <p>{PUBLIC_COPY["security.authority.body"]}</p>
      </Section>
      <Section id="security-retention" heading={PUBLIC_COPY["security.retention.heading"]}>
        <DataTable
          caption={PUBLIC_COPY["security.retention.table.caption"]}
          columns={[PUBLIC_COPY["security.retention.subject.label"], PUBLIC_COPY["security.retention.rule.label"]]}
          rows={RETENTION_ROWS.map((row, index) => ({ key: `retention-${index}`, head: row.subject, cells: [row.rule] }))}
        />
        <p>{copy("security.retention.links", { minutes: DOWNLOAD_LINK_MINUTES })}</p>
        <p>{copy("security.retention.defect", { days: DEFECT_CLAIM_DAYS, repair: DEFECT_REPAIR_BUSINESS_DAYS })}</p>
        <p>{REUPLOAD_NOTICE}</p>
      </Section>
      <Section id="security-residual" heading={PUBLIC_COPY["security.residual.heading"]}>
        <p>{PUBLIC_COPY["security.residual.body"]}</p>
      </Section>
      <Section id="security-claims" heading={PUBLIC_COPY["security.claims.heading"]}>
        <p>{PUBLIC_COPY["security.claims.body"]}</p>
      </Section>
      <Section id="security-next" heading={PUBLIC_COPY["security.next.heading"]}>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.processing}>{PUBLIC_COPY["security.next.processing.cta"]}</LinkButton>
          <LinkButton href={ROUTE.privacy}>{PUBLIC_COPY["security.next.privacy.cta"]}</LinkButton>
          <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["security.next.ask.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

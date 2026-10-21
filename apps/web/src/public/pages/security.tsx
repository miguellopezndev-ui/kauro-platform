// UI06 Data handling (A3 3.5, manual 09): what is processed, how customers are kept apart, what a model may see, who decides, how long each
// kind of data stays (the full schedule, from the policy), what deletion does not cover, and what this page does not claim. It describes what
// Kauro does today; it claims no certification and no compliance outcome.
//
// Order 11 round 2: a security reviewer should have the answers in the first screen. The heading is a reference page's (the old 84 px head
// filled the whole first screen), and five facts follow it as label and value: the connection to a CRM, how long the files of a check and of
// a purchase stay (both windows, never a single "at most"), sign-in, and certification. Then the path of a file in four steps, the sections
// at one heading size, each heading beside its answer, and one closing with one action, since the reader here is usually a reviewer.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { DataTable } from "../parts.tsx";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";
import { Block, Closing, Facts, Head } from "../r2.tsx";
import { DEFECT_CLAIM_DAYS, DEFECT_REPAIR_BUSINESS_DAYS, DOWNLOAD_LINK_MINUTES, formatDays, REUPLOAD_NOTICE, RETENTION_ROWS } from "../retention.ts";
import { ROUTE } from "../site.ts";

const r = POLICY_SNAPSHOT.retention;

const PATH: ReadonlyArray<readonly [key: string, name: PublicCopyId, body: PublicCopyId]> = [
  ["seal", "security.path.seal.name", "security.path.seal.body"],
  ["measure", "security.path.measure.name", "security.path.measure.body"],
  ["prepare", "security.path.prepare.name", "security.path.prepare.body"],
  ["delete", "security.path.delete.name", "security.path.delete.body"],
];

export function SecurityPage(): ReactElement {
  return (
    <>
      <Head kind="reference" eyebrow={PUBLIC_COPY["nav.security.label"]} title={PUBLIC_COPY["security.title"]} lead={PUBLIC_COPY["security.lead"]}>
        <Facts
          variant="kauro-r2-facts--head"
          rows={[
            { key: "crm", label: PUBLIC_COPY["security.fact.crm.label"], value: PUBLIC_COPY["security.fact.crm.value"] },
            { key: "check", label: PUBLIC_COPY["security.fact.check.label"], value: copy("security.fact.check.value", { days: formatDays(r.unpaidDaysFromReady), hard: formatDays(r.unpaidDaysHardFromSeal) }) },
            { key: "paid", label: PUBLIC_COPY["security.fact.paid.label"], value: copy("security.fact.paid.value", { days: formatDays(r.paidDaysFromFirstPackage), hard: formatDays(r.paidDaysHardFromCapture) }) },
            { key: "sign-in", label: PUBLIC_COPY["security.fact.sign-in.label"], value: PUBLIC_COPY["security.fact.sign-in.value"] },
            { key: "certification", label: PUBLIC_COPY["security.fact.certification.label"], value: PUBLIC_COPY["security.fact.certification.value"] },
          ]}
        />
      </Head>
      <Block id="security-path" heading={PUBLIC_COPY["security.path.heading"]} tone="sunken">
        <ol className="kauro-r2-path">
          {PATH.map(([key, name, body]) => (
            <li key={key}>
              <h3>{PUBLIC_COPY[name]}</h3>
              <p>{PUBLIC_COPY[body]}</p>
            </li>
          ))}
        </ol>
      </Block>
      <Block id="security-processed" heading={PUBLIC_COPY["security.processed.heading"]} layout="split">
        <p>{PUBLIC_COPY["security.processed.body"]}</p>
        <p className="kauro-r2-callout kauro-r2-callout--warning">{PUBLIC_COPY["security.excluded.body"]}</p>
      </Block>
      <Block id="security-isolation" heading={PUBLIC_COPY["security.isolation.heading"]} layout="split">
        <p>{PUBLIC_COPY["security.isolation.body"]}</p>
        <div className="kauro-answer" aria-hidden="true">
          <span className="kauro-answer-ask">{PUBLIC_COPY["security.frag.request"]}</span>
          <span className="kauro-answer-stamp">{PUBLIC_COPY["security.frag.answer"]}</span>
        </div>
      </Block>
      <Block id="security-model" heading={PUBLIC_COPY["security.model.heading"]} layout="split">
        <p>{PUBLIC_COPY["security.model.body"]}</p>
      </Block>
      <Block id="security-authority" heading={PUBLIC_COPY["security.authority.heading"]} layout="split">
        <p>{PUBLIC_COPY["security.authority.body"]}</p>
      </Block>
      <Block id="security-retention" heading={PUBLIC_COPY["security.retention.heading"]} lead={PUBLIC_COPY["security.retention.lead"]} tone="sunken">
        <DataTable
          variant="kauro-r2-retention"
          caption={PUBLIC_COPY["security.retention.table.caption"]}
          columns={[PUBLIC_COPY["security.retention.subject.label"], PUBLIC_COPY["security.retention.rule.label"]]}
          rows={RETENTION_ROWS.map((row, index) => ({ key: `retention-${index}`, head: row.subject, cells: [row.rule] }))}
        />
        <ul className="kauro-r2-notes">
          <li>{copy("security.retention.links", { minutes: DOWNLOAD_LINK_MINUTES })}</li>
          <li>{copy("security.retention.defect", { days: DEFECT_CLAIM_DAYS, repair: DEFECT_REPAIR_BUSINESS_DAYS })}</li>
          <li>{REUPLOAD_NOTICE}</li>
        </ul>
      </Block>
      <Block id="security-residual" heading={PUBLIC_COPY["security.residual.heading"]} layout="split">
        <p>{PUBLIC_COPY["security.residual.body"]}</p>
      </Block>
      <Block id="security-claims" heading={PUBLIC_COPY["security.claims.heading"]} layout="split">
        <p>{PUBLIC_COPY["security.claims.body"]}</p>
      </Block>
      <Closing
        id="security-next"
        heading={PUBLIC_COPY["security.next.heading"]}
        body={PUBLIC_COPY["security.next.body"]}
        primary={{ href: ROUTE.contact, label: PUBLIC_COPY["security.next.ask.cta"] }}
        links={[
          { href: ROUTE.processing, label: PUBLIC_COPY["security.next.processing.cta"] },
          { href: ROUTE.privacy, label: PUBLIC_COPY["security.next.privacy.cta"] },
        ]}
      />
    </>
  );
}

// UI03 Supported services (A3 3.3): the capability publication shown as it is. CLEAN stands beside HubSpot and Salesforce as one of three
// peers; each card says whether its service can be bought now, and a service the publication does not list is never described as if it
// were open. CLEAN names as qualified only the destinations the publication lists, and no card claims compatibility with another CRM.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { availabilityOf, cleanQualifiesId, formatInstant, publishedModes, type Availability, type Publication } from "../capabilities.ts";
import { FileChips, ImportOrder, Pane, Settings } from "../artifacts.tsx";
import { INPUT_LIMITS } from "../limits.ts";
import { MANIFEST_FILES } from "../sample-data.ts";
import { LinkButton, MODE_ORDER, PageHead, Section, ServiceState, rich } from "../parts.tsx";
import type { ServiceMode } from "../pricing-bands.ts";
import { ROUTE } from "../site.ts";

const CARD_ID: Readonly<Record<ServiceMode, string>> = { CLEAN: "services-clean", HUBSPOT: "services-hubspot", SALESFORCE: "services-salesforce" };
const CARD_NAME: Readonly<Record<ServiceMode, string>> = {
  CLEAN: PUBLIC_COPY["services.clean.name"],
  HUBSPOT: PUBLIC_COPY["services.hubspot.name"],
  SALESFORCE: PUBLIC_COPY["services.salesforce.name"],
};

function Details({ mode, publication }: { readonly mode: ServiceMode; readonly publication: Publication }): ReactElement {
  switch (mode) {
    case "CLEAN":
      return (
        <>
          <p className="kauro-site-card-lead">{PUBLIC_COPY["services.clean.summary"]}</p>
          <p>{PUBLIC_COPY["services.clean.delivery"]}</p>
          <p>{PUBLIC_COPY[cleanQualifiesId(publication)]}</p>
          <Pane>
            <FileChips files={[...MANIFEST_FILES.map((file) => file.name), PUBLIC_COPY["home.delivery.report.name"], PUBLIC_COPY["home.delivery.manifest.name"]]} />
          </Pane>
          <p className="kauro-site-card-limit">{PUBLIC_COPY["services.clean.limit"]}</p>
        </>
      );
    case "HUBSPOT":
      return (
        <>
          <p className="kauro-site-card-lead">{PUBLIC_COPY["services.hubspot.summary"]}</p>
          <Pane>
            <Settings
              rows={[
                { label: PUBLIC_COPY["services.frag.marketing"], value: PUBLIC_COPY["services.frag.off"] },
                { label: PUBLIC_COPY["services.frag.enrichment"], value: PUBLIC_COPY["services.frag.off"] },
              ]}
            />
          </Pane>
          <p className="kauro-site-card-limit">{PUBLIC_COPY["services.hubspot.cost"]}</p>
        </>
      );
    case "SALESFORCE":
      return (
        <>
          <p className="kauro-site-card-lead">{PUBLIC_COPY["services.salesforce.summary"]}</p>
          <Pane title={PUBLIC_COPY["home.frag.order"]}>
            <ImportOrder plain files={[PUBLIC_COPY["services.frag.accounts"], PUBLIC_COPY["services.frag.contacts"], PUBLIC_COPY["services.frag.opportunities"]]} />
          </Pane>
          <p className="kauro-site-card-limit">{PUBLIC_COPY["services.salesforce.limit"]}</p>
        </>
      );
  }
}

function ServiceCard({ mode, publication }: { readonly mode: ServiceMode; readonly publication: Publication }): ReactElement {
  const availability: Availability = availabilityOf(publication, mode);
  const listed = publishedModes(publication).find((entry) => entry.mode === mode);
  const headingId = `${CARD_ID[mode]}-heading`;
  return (
    <article
      className={`kauro-site-card kauro-site-service kauro-site-service--${availability.toLowerCase()}${mode === "CLEAN" && (availability === "AVAILABLE" || availability === "LIMITED") ? " kauro-site-service--lead kauro-wine" : ""}`}
      aria-labelledby={headingId}
    >
      <div className="kauro-site-service-top">
        <h3 id={headingId}>{CARD_NAME[mode]}</h3>
        <ServiceState availability={availability} />
      </div>
      {availability === "CLOSED" ? null : <Details mode={mode} publication={publication} />}
      {listed === undefined ? null : <p className="kauro-site-meta">{copy("services.mode.version", { version: listed.version, time: formatInstant(listed.validFrom) })}</p>}
    </article>
  );
}

export function SupportedServicesPage({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  const someClosed = publication.kind === "READ" && MODE_ORDER.some((mode) => availabilityOf(publication, mode) === "CLOSED");
  return (
    <>
      <PageHead eyebrow={PUBLIC_COPY["nav.services.label"]} accent={3} title={PUBLIC_COPY["services.title"]} lead={PUBLIC_COPY["services.lead"]} size="compact" />
      <Section
        id="services-availability"
        heading={PUBLIC_COPY["services.availability.heading"]}
        headExtra={publication.kind === "READ" ? <p className="kauro-site-observed">{copy("services.availability.observed", { time: formatInstant(publication.observedAt) })}</p> : undefined}
      >
        {publication.kind === "READ" ? (
          modes.length === 0 ? <p className="kauro-site-callout">{PUBLIC_COPY["services.availability.none"]}</p> : null
        ) : (
          <p className="kauro-site-callout">{PUBLIC_COPY["services.availability.unknown"]}</p>
        )}
        <div className="kauro-site-cards kauro-site-cards--three">
          {MODE_ORDER.map((mode) => (
            <ServiceCard key={mode} mode={mode} publication={publication} />
          ))}
        </div>
        {someClosed ? <p className="kauro-site-muted">{PUBLIC_COPY["services.unavailable.body"]}</p> : null}
        {publication.kind === "READ" && modes.length === 0 ? <p className="kauro-site-muted">{PUBLIC_COPY["services.none.body"]}</p> : null}
      </Section>
      <Section id="services-scope" heading={PUBLIC_COPY["services.scope.heading"]} layout="split" tone="sunken">
        <div className="kauro-site-scope">
          <div className="kauro-site-scope-column kauro-site-scope-column--in">
            <p className="kauro-site-scope-label">{PUBLIC_COPY["services.scope.in.label"]}</p>
            <p>{PUBLIC_COPY["services.scope.objects"]}</p>
          </div>
          <div className="kauro-site-scope-column kauro-site-scope-column--out">
            <p className="kauro-site-scope-label">{PUBLIC_COPY["services.scope.out.label"]}</p>
            <p>{PUBLIC_COPY["services.scope.excluded"]}</p>
          </div>
        </div>
        <p className="kauro-site-statement kauro-site-statement--small">{PUBLIC_COPY["services.scope.unsupported"]}</p>
      </Section>
      <Section id="services-limits" heading={PUBLIC_COPY["services.limits.heading"]} layout="split">
        <ul className="kauro-site-specs">
          <li>{PUBLIC_COPY["services.limits.formats"]}</li>
          <li>{rich("services.limits.files", { files: INPUT_LIMITS.files, fileSize: INPUT_LIMITS.fileSize })}</li>
          <li>{rich("services.limits.set", { setSize: INPUT_LIMITS.setSize, columns: INPUT_LIMITS.columns })}</li>
          <li>{rich("services.limits.units", { units: INPUT_LIMITS.units })}</li>
        </ul>
      </Section>
      <Section id="services-next" heading={PUBLIC_COPY["services.next.heading"]} layout="split" tone="wine" variant="kauro-site-band-compact kauro-site-band-grain">
        <p>{PUBLIC_COPY["services.next.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.contact}>{PUBLIC_COPY["services.next.ask.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

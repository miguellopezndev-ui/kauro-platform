// A variant of UI03 Supported services (Order 11; review only, never in the application's bundle). The owner found the approved
// "Availability now" not good enough and asked for its purpose to be researched, the earlier solution restored if it was better, or three
// upright cards with real composition. Its purpose is one question a buyer asks before anything else: which of the three services can I buy
// now, and is it the one for me. The approved page answers the first half in its head and spreads the second over three wide sections; the
// earlier solutions (A10 §5 to §8) were spreads too. The variant answers both halves side by side: three cards of equal width, read in the
// same order (name and state, the piece of the product that shows it, who it is for, what you receive, its limit, its publication), so a
// buyer compares the three by reading across. It also carries the owner's service names of 2026-10-20 ("Clean your data", "Prepare for
// HubSpot", "Prepare for Salesforce"), each with one line that never implies enrichment, irreversible deletion or CRM compatibility.
//
// Everything else is the approved page's own: the publication it reads, the states, the scope, the limits, the next step. The copy that is
// new is held here, not in the application's catalogue, until the owner approves it.
import type { ReactElement, ReactNode } from "react";
import { PUBLIC_COPY, copy } from "@web/copy/public.ts";
import { availabilityOf, cleanQualifiesId, formatInstant, publishedModes, type Availability, type Publication } from "@web/public/capabilities.ts";
import { FileChips, ImportOrder, Pane, Settings } from "@web/public/artifacts.tsx";
import { INPUT_LIMITS } from "@web/public/limits.ts";
import { MANIFEST_FILES } from "@web/public/sample-data.ts";
import { LinkButton, MODE_ORDER, PageHead, Section, ServiceState, rich, stateText } from "@web/public/parts.tsx";
import type { ServiceMode } from "@web/public/pricing-bands.ts";
import { ROUTE } from "@web/public/site.ts";

const CARD_ID: Readonly<Record<ServiceMode, string>> = { CLEAN: "services-clean", HUBSPOT: "services-hubspot", SALESFORCE: "services-salesforce" };

/** The variant's words: the owner's names and one line each, then who each service is for (drafted in Order 11, commit 3b317427). */
const NAME: Readonly<Record<ServiceMode, string>> = { CLEAN: "Clean your data", HUBSPOT: "Prepare for HubSpot", SALESFORCE: "Prepare for Salesforce" };
const LINE: Readonly<Record<ServiceMode, string>> = {
  CLEAN: "Your own files, with duplicates and inconsistent values resolved and every change explained. Nothing is added from outside sources.",
  HUBSPOT: "Import files and ordered steps for HubSpot, checked against the settings of your account.",
  SALESFORCE: "Data Loader files and ordered steps for Salesforce, checked against the metadata of your organisation.",
};
const FOR: Readonly<Record<ServiceMode, string>> = {
  CLEAN: "Teams whose records go to another CRM, live only in spreadsheets or have no destination yet, and teams cleaning up before a migration.",
  HUBSPOT: "Teams whose records go into HubSpot through its own importer.",
  SALESFORCE: "Teams whose records go into a Salesforce organisation through Data Loader.",
};

function Part({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  const part = label === "Who it is for" ? "for" : "receive";
  return (
    <div className={`kauro-site-service-part kauro-site-service-part--${part}`}>
      <p className="kauro-site-service-label">{label}</p>
      {children}
    </div>
  );
}

function Details({ mode, publication }: { readonly mode: ServiceMode; readonly publication: Publication }): ReactElement {
  switch (mode) {
    case "CLEAN":
      return (
        <>
          <Pane>
            <FileChips files={[...MANIFEST_FILES.map((file) => file.name), PUBLIC_COPY["home.delivery.report.name"], PUBLIC_COPY["home.delivery.manifest.name"]]} />
          </Pane>
          <Part label="Who it is for">
            <p>{FOR.CLEAN}</p>
          </Part>
          <Part label="What you receive">
            <p>{PUBLIC_COPY["services.clean.delivery"]}</p>
            <p>{PUBLIC_COPY[cleanQualifiesId(publication)]}</p>
          </Part>
          <p className="kauro-site-card-limit">{PUBLIC_COPY["services.clean.limit"]}</p>
        </>
      );
    case "HUBSPOT":
      return (
        <>
          <Pane>
            <Settings
              rows={[
                { label: PUBLIC_COPY["services.frag.marketing"], value: PUBLIC_COPY["services.frag.off"] },
                { label: PUBLIC_COPY["services.frag.enrichment"], value: PUBLIC_COPY["services.frag.off"] },
              ]}
            />
          </Pane>
          <Part label="Who it is for">
            <p>{FOR.HUBSPOT}</p>
          </Part>
          <Part label="What you receive">
            <p>{PUBLIC_COPY["services.hubspot.summary"]}</p>
          </Part>
          <p className="kauro-site-card-limit">{PUBLIC_COPY["services.hubspot.cost"]}</p>
        </>
      );
    case "SALESFORCE":
      return (
        <>
          <Pane title={PUBLIC_COPY["home.frag.order"]}>
            <ImportOrder plain files={[PUBLIC_COPY["services.frag.accounts"], PUBLIC_COPY["services.frag.contacts"], PUBLIC_COPY["services.frag.opportunities"]]} />
          </Pane>
          <Part label="Who it is for">
            <p>{FOR.SALESFORCE}</p>
          </Part>
          <Part label="What you receive">
            <p>{PUBLIC_COPY["services.salesforce.summary"]}</p>
          </Part>
          <p className="kauro-site-card-limit">{PUBLIC_COPY["services.salesforce.limit"]}</p>
        </>
      );
  }
}

function AvailabilityList({ publication }: { readonly publication: Publication }): ReactElement {
  return (
    <div className="kauro-choose kauro-paper">
      <p className="kauro-choose-bar" aria-hidden="true">
        <span className="kauro-choose-brand">{PUBLIC_COPY["site.name"]}</span>
        <span className="kauro-choose-title">{PUBLIC_COPY["services.availability.heading"]}</span>
      </p>
      <ul className="kauro-choose-list">
        {MODE_ORDER.map((mode) => {
          const availability = availabilityOf(publication, mode);
          return (
            <li key={mode}>
              <a className={`kauro-choose-row kauro-choose-row--${availability.toLowerCase()}`} href={`#${CARD_ID[mode]}`}>
                <span className="kauro-choose-name">{NAME[mode]}</span>
                <span className={`kauro-site-state kauro-site-state--${availability.toLowerCase()}`}>{stateText(availability)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ServiceCard({ mode, publication }: { readonly mode: ServiceMode; readonly publication: Publication }): ReactElement {
  const availability: Availability = availabilityOf(publication, mode);
  const listed = publishedModes(publication).find((entry) => entry.mode === mode);
  const headingId = `${CARD_ID[mode]}-heading`;
  return (
    <article
      id={CARD_ID[mode]}
      className={`kauro-site-card kauro-site-service kauro-site-service--${availability.toLowerCase()}${mode === "CLEAN" && (availability === "AVAILABLE" || availability === "LIMITED") ? " kauro-site-service--lead kauro-wine" : ""}`}
      aria-labelledby={headingId}
    >
      <div className="kauro-site-service-top">
        <h3 id={headingId}>{NAME[mode]}</h3>
        <ServiceState availability={availability} />
        <p className="kauro-variant-line">{LINE[mode]}</p>
      </div>
      {availability === "CLOSED" ? null : <Details mode={mode} publication={publication} />}
      {listed === undefined ? null : <p className="kauro-site-meta">{copy("services.mode.version", { version: listed.version, time: formatInstant(listed.validFrom) })}</p>}
    </article>
  );
}

export function SupportedServicesCards({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  const someClosed = publication.kind === "READ" && MODE_ORDER.some((mode) => availabilityOf(publication, mode) === "CLOSED");
  return (
    <>
      <PageHead eyebrow={PUBLIC_COPY["nav.services.label"]} accent={3} title={PUBLIC_COPY["services.title"]} lead={PUBLIC_COPY["services.lead"]} size="compact" aside={<AvailabilityList publication={publication} />} />
      <Section id="services-availability" heading={PUBLIC_COPY["services.availability.heading"]}>
        {publication.kind === "READ" ? (
          modes.length === 0 ? <p className="kauro-site-callout">{PUBLIC_COPY["services.availability.none"]}</p> : null
        ) : (
          <p className="kauro-site-callout">{PUBLIC_COPY["services.availability.unknown"]}</p>
        )}
        <div className="kauro-site-trio">
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
        <ul className="kauro-site-specs kauro-site-specs--plate">
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

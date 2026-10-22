// UI03 Supported services (A3 3.3): the capability publication shown as it is. Clean your data stands beside the two qualified destinations
// as one of three peers; each card says whether its service can be bought now, and a service the publication does not list is never
// described as if it were open. Clean your data names as qualified only the destinations the publication lists, and no card claims
// compatibility with another CRM.
//
// Order 11 round 2 (owner: the services spread across the whole width "waste space beside the text"; the limits shown as four plates of
// mixed figure sizes "look horrible"): the three services are three equal cards in one row, read side by side, with the same rows in the
// same order on each (state, name, destination, what you receive, the one setting or limit of that service, the sample). The two qualified
// destinations come first and the cleanup without a destination last, all on one surface, so none is the headline. Prices stay on Pricing
// (each figure once on the site). The limits are one table at reading size, grouped by what they apply to.
//
// Owner's section review (2026-10-21), after the migration packages measured (SpotDev: a name, who it is for, three or four short points,
// one shared action): the section is headed by the choice it asks for (by where the data goes) rather than repeating the H1; what each
// service delivers is three short points, not one long sentence; and the sample delivery, which is one HubSpot project, is offered once
// under the cards beside pricing rather than on every card.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { availabilityOf, cleanQualifiesId, formatInstant, publishedModes, type Publication } from "../capabilities.ts";
import { INPUT_LIMITS } from "../limits.ts";
import type { ServiceMode } from "../pricing-bands.ts";
import { Block, CHECK_CTA, Closing, GroupedTable, Head, SERVICE_ORDER, StateTag } from "../r2.tsx";
import { ROUTE } from "../site.ts";

const CARD_ID: Readonly<Record<ServiceMode, string>> = { CLEAN: "services-clean", HUBSPOT: "services-hubspot", SALESFORCE: "services-salesforce" };
const NAME: Readonly<Record<ServiceMode, PublicCopyId>> = { CLEAN: "services.clean.name", HUBSPOT: "services.hubspot.name", SALESFORCE: "services.salesforce.name" };
const DESTINATION: Readonly<Record<ServiceMode, PublicCopyId>> = {
  CLEAN: "services.clean.destination",
  HUBSPOT: "services.hubspot.destination",
  SALESFORCE: "services.salesforce.destination",
};

/** What the service delivers, as three short points. */
function receives(mode: ServiceMode): readonly string[] {
  switch (mode) {
    case "CLEAN":
      return [PUBLIC_COPY["services.clean.receive.files"], PUBLIC_COPY["services.clean.receive.report"], PUBLIC_COPY["services.clean.receive.tools"]];
    case "HUBSPOT":
      return [PUBLIC_COPY["services.hubspot.receive.files"], PUBLIC_COPY["services.hubspot.receive.steps"], PUBLIC_COPY["services.hubspot.receive.checked"]];
    case "SALESFORCE":
      return [PUBLIC_COPY["services.salesforce.receive.files"], PUBLIC_COPY["services.salesforce.receive.steps"], PUBLIC_COPY["services.salesforce.receive.checked"]];
  }
}

/** The setting or limit that belongs to this service alone; Clean your data's names only the destinations the publication lists. */
function Particular({ mode, publication }: { readonly mode: ServiceMode; readonly publication: Publication }): ReactElement {
  switch (mode) {
    case "CLEAN":
      return (
        <p className="kauro-r2-card-note">
          {PUBLIC_COPY[cleanQualifiesId(publication)]} {PUBLIC_COPY["services.clean.limit"]}
        </p>
      );
    case "HUBSPOT":
      return <p className="kauro-r2-card-note">{PUBLIC_COPY["services.hubspot.cost"]}</p>;
    case "SALESFORCE":
      return <p className="kauro-r2-card-note">{PUBLIC_COPY["services.salesforce.limit"]}</p>;
  }
}

function ServiceCard({ mode, publication }: { readonly mode: ServiceMode; readonly publication: Publication }): ReactElement {
  const availability = availabilityOf(publication, mode);
  const listed = publishedModes(publication).find((entry) => entry.mode === mode);
  const headingId = `${CARD_ID[mode]}-heading`;
  const closed = availability === "CLOSED";
  return (
    <article id={CARD_ID[mode]} className={`kauro-r2-service kauro-r2-service--${availability.toLowerCase()}`} aria-labelledby={headingId}>
      <StateTag availability={availability} />
      <h3 id={headingId}>{PUBLIC_COPY[NAME[mode]]}</h3>
      {closed ? (
        <p className="kauro-r2-service-closed">{PUBLIC_COPY["services.closed.body"]}</p>
      ) : (
        <>
          <dl className="kauro-r2-service-row">
            <dt>{PUBLIC_COPY["services.destination.label"]}</dt>
            <dd>{PUBLIC_COPY[DESTINATION[mode]]}</dd>
          </dl>
          <dl className="kauro-r2-service-row">
            <dt>{PUBLIC_COPY["services.receive.label"]}</dt>
            <dd>
              <ul className="kauro-r2-service-list">
                {receives(mode).map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </dd>
          </dl>
          <div className="kauro-r2-service-particular">
            <Particular mode={mode} publication={publication} />
          </div>
        </>
      )}
      <div className="kauro-r2-service-foot">
        {listed === undefined ? null : <p className="kauro-r2-card-meta">{copy("services.mode.version", { version: listed.version, time: formatInstant(listed.validFrom) })}</p>}
      </div>
    </article>
  );
}

export function SupportedServicesPage({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  const someClosed = publication.kind === "READ" && SERVICE_ORDER.some((mode) => availabilityOf(publication, mode) === "CLOSED");
  return (
    <>
      <Head kind="path" accent={3} eyebrow={PUBLIC_COPY["nav.services.label"]} title={PUBLIC_COPY["services.title"]} lead={PUBLIC_COPY["services.lead"]} />
      <Block id="services-availability" heading={PUBLIC_COPY["services.availability.heading"]} variant="kauro-r2-block--first">
        {publication.kind === "READ" ? (
          modes.length === 0 ? <p className="kauro-r2-callout">{PUBLIC_COPY["services.availability.none"]}</p> : null
        ) : (
          <p className="kauro-r2-callout">{PUBLIC_COPY["services.availability.unknown"]}</p>
        )}
        <div className="kauro-r2-services">
          {SERVICE_ORDER.map((mode) => (
            <ServiceCard key={mode} mode={mode} publication={publication} />
          ))}
        </div>
        <div className="kauro-r2-services-after">
          <p className="kauro-r2-after">{PUBLIC_COPY["services.price.line"]}</p>
          <p className="kauro-r2-services-links">
            <a className="kauro-site-arrow" href={ROUTE.pricing}>
              {PUBLIC_COPY["services.price.cta"]}
            </a>
            <a className="kauro-site-arrow" href={ROUTE.sample}>
              {PUBLIC_COPY["services.sample.cta"]}
            </a>
          </p>
        </div>
        {someClosed ? <p className="kauro-r2-after">{PUBLIC_COPY["services.unavailable.body"]}</p> : null}
        {publication.kind === "READ" && modes.length === 0 ? <p className="kauro-r2-after">{PUBLIC_COPY["services.none.body"]}</p> : null}
      </Block>
      <Block id="services-scope" heading={PUBLIC_COPY["services.scope.heading"]} tone="sunken">
        <div className="kauro-r2-pair">
          <div className="kauro-r2-pair-item kauro-r2-pair-item--in">
            <h3>{PUBLIC_COPY["services.scope.in.label"]}</h3>
            <p>{PUBLIC_COPY["services.scope.objects"]}</p>
          </div>
          <div className="kauro-r2-pair-item kauro-r2-pair-item--out">
            <h3>{PUBLIC_COPY["services.scope.out.label"]}</h3>
            <p>{PUBLIC_COPY["services.scope.excluded"]}</p>
          </div>
        </div>
        <p className="kauro-r2-after">{PUBLIC_COPY["services.scope.unsupported"]}</p>
      </Block>
      <Block id="services-limits" heading={PUBLIC_COPY["services.limits.heading"]} lead={PUBLIC_COPY["services.limits.lead"]} layout="split">
        <GroupedTable
          caption={PUBLIC_COPY["services.limits.caption"]}
          groups={[
            {
              key: "file",
              label: PUBLIC_COPY["services.limits.group.file"],
              rows: [
                { key: "format", label: PUBLIC_COPY["services.limits.format.label"], value: PUBLIC_COPY["services.limits.format.value"] },
                { key: "structure", label: PUBLIC_COPY["services.limits.structure.label"], value: PUBLIC_COPY["services.limits.structure.value"] },
                { key: "size", label: PUBLIC_COPY["services.limits.size.label"], value: INPUT_LIMITS.fileSize },
                { key: "columns", label: PUBLIC_COPY["services.limits.columns.label"], value: INPUT_LIMITS.columns },
              ],
            },
            {
              key: "set",
              label: PUBLIC_COPY["services.limits.group.set"],
              rows: [
                { key: "files", label: PUBLIC_COPY["services.limits.files.label"], value: INPUT_LIMITS.files },
                { key: "total", label: PUBLIC_COPY["services.limits.total.label"], value: INPUT_LIMITS.setSize },
              ],
            },
            {
              key: "project",
              label: PUBLIC_COPY["services.limits.group.project"],
              rows: [{ key: "units", label: PUBLIC_COPY["services.limits.units.label"], value: INPUT_LIMITS.units }],
            },
          ]}
        />
        <ul className="kauro-r2-notes">
          <li>{PUBLIC_COPY["services.limits.unit.note"]}</li>
          <li>{PUBLIC_COPY["help.files.large"]}</li>
          <li>{PUBLIC_COPY["services.limits.larger"]}</li>
        </ul>
      </Block>
      <Closing
        id="services-next"
        heading={PUBLIC_COPY["home.closing.heading"]}
        body={PUBLIC_COPY["services.next.body"]}
        primary={CHECK_CTA}
        links={[
          { href: ROUTE.contact, label: PUBLIC_COPY["services.next.ask.cta"] },
          { href: ROUTE.pricing, label: PUBLIC_COPY["services.price.cta"] },
        ]}
      />
    </>
  );
}

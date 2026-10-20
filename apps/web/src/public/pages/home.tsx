// UI01 Home (A3 3.1, 3.2): the job line, one call to action, the sample and the prices beside it, what the team receives, the services open
// now (read from the capability publication and nothing else), what Kauro does not do, and the one sentence about AI, below the offer and the
// limits and never in a headline. The call to action leads to sign-in, where the free data health check is requested.
//
// The figures are the product's own, drawn from the synthetic sample (sample-data.ts, stamped synthetic as A3 3.6 asks): beside the headline,
// a project window with the phases a project really goes through and three invented records, one of them waiting for the customer's
// decision; under "What your team receives", the files of the sample delivery with their row counts. No invented dashboard, no logo.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { publishedModes, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { Audience } from "../audience.tsx";
import { Journey } from "../journey.tsx";
import { PackageFolder } from "../package-folder.tsx";
import { FileName, LinkButton, PageHead, PriceFigure, Section, ServiceState, Stamp } from "../parts.tsx";
import { bandRange, formatCount, formatUsd, startingPrice, type ServiceMode } from "../pricing-bands.ts";
import { MANIFEST_FILES, SAMPLE, SAMPLE_RECORDS, type RecordResult } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

export interface HomePageProps {
  readonly publication: Publication;
}

const RESULT: Readonly<Record<RecordResult, PublicCopyId>> = {
  valid: "home.app.result.valid",
  normalised: "home.app.result.normalised",
  candidate: "home.app.result.candidate",
};

/**
 * The synthetic project window beside the headline. It is an illustration of the sample, stamped as such in its caption; the window itself
 * is hidden from assistive technology, because the page says everything it shows in words.
 */
function ProductWindow(): ReactElement | null {
  const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  if (contacts === undefined) return null;
  const phases = [
    { label: PUBLIC_COPY["home.app.phase.check.label"], body: copy("home.app.phase.check.body", { count: formatCount(contacts.source) }) },
    { label: PUBLIC_COPY["home.app.phase.decide.label"], body: copy("home.app.phase.decide.body", { count: formatCount(contacts.unified) }) },
    { label: PUBLIC_COPY["home.app.phase.prepare.label"], body: PUBLIC_COPY["home.app.phase.prepare.body"] },
    { label: PUBLIC_COPY["home.app.phase.deliver.label"], body: PUBLIC_COPY["home.app.phase.deliver.body"] },
  ];
  return (
    <figure className="kauro-site-showcase">
      <div className="kauro-site-window" aria-hidden="true">
        <div className="kauro-site-window-bar">
          <span className="kauro-site-window-brand">{PUBLIC_COPY["site.name"]}</span>
          <span className="kauro-site-window-project">{PUBLIC_COPY["home.app.project.name"]}</span>
          <span className="kauro-site-window-state">{PUBLIC_COPY["home.app.state.label"]}</span>
        </div>
        <div className="kauro-site-window-body">
          <p className="kauro-site-window-file">
            <FileName>{SAMPLE.contactsFile}</FileName>
            <span className="kauro-site-window-count">{formatCount(contacts.rows)}</span>
          </p>
          <p className="kauro-site-window-label">{PUBLIC_COPY["home.app.phases.label"]}</p>
          <ol className="kauro-site-window-phases">
            {phases.map((phase) => (
              <li key={phase.label}>
                <span className="kauro-site-window-phase">{phase.label}</span>
                <span className="kauro-site-window-meta">{phase.body}</span>
              </li>
            ))}
          </ol>
          <p className="kauro-site-window-label">{PUBLIC_COPY["home.app.records.label"]}</p>
          <div className="kauro-site-window-records">
            <span className="kauro-site-window-head">{PUBLIC_COPY["home.app.contact.label"]}</span>
            <span className="kauro-site-window-head kauro-site-window-email">{PUBLIC_COPY["home.app.email.label"]}</span>
            <span className="kauro-site-window-head">{PUBLIC_COPY["home.app.result.label"]}</span>
            {SAMPLE_RECORDS.map((record) => (
              <div key={record.email} className={`kauro-site-window-row kauro-site-window-row--${record.result}`}>
                <span className="kauro-site-window-name">
                  {record.before === null ? null : <s>{record.before}</s>}
                  {record.name}
                </span>
                <span className="kauro-site-window-email">{record.email}</span>
                <span className={`kauro-site-outcome kauro-site-outcome--${record.result}`}>{PUBLIC_COPY[RESULT[record.result]]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="kauro-site-note-hand kauro-site-note-hand--decide" aria-hidden="true">
        {PUBLIC_COPY["home.note.decide"]}
      </p>
      <p className="kauro-site-note-hand kauro-site-note-hand--counts" aria-hidden="true">
        {PUBLIC_COPY["home.note.counts"]}
      </p>
      <figcaption>
        <Stamp>{PUBLIC_COPY["sample.badge.label"]}</Stamp>
      </figcaption>
    </figure>
  );
}

const FACTS = [
  { name: "home.facts.approve.name", body: "home.facts.approve.body", mark: "approve" },
  { name: "home.facts.trace.name", body: "home.facts.trace.body", mark: "trace" },
  { name: "home.facts.quote.name", body: "home.facts.quote.body", mark: "quote" },
] as const satisfies ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId; readonly mark: string }>;

/** What Kauro does not do: the three things that stay with the team, set as a permissions panel locked on "Never". */
const LIMITS = [
  { name: "home.limits.live.name", body: "home.limits.live" },
  { name: "home.limits.import.name", body: "home.limits.import" },
  { name: "home.limits.decide.name", body: "home.limits.decide" },
] as const satisfies ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId }>;

const CLEAN_FOR = ["home.modes.clean.for.crm", "home.modes.clean.for.sheets", "home.modes.clean.for.migration", "home.modes.clean.for.unchosen"] as const satisfies readonly PublicCopyId[];

const MODE_LINE: Readonly<Record<ServiceMode, PublicCopyId>> = {
  CLEAN: "home.modes.clean.line",
  HUBSPOT: "home.modes.hubspot.line",
  SALESFORCE: "home.modes.salesforce.line",
};

const MODE_FOR: Readonly<Record<Exclude<ServiceMode, "CLEAN">, PublicCopyId>> = {
  HUBSPOT: "home.modes.hubspot.for",
  SALESFORCE: "home.modes.salesforce.for",
};

/**
 * The services open now, as one board: a row per service with what it is, who it is made for and where its price starts. CLEAN leads on
 * wine: it is the one most buyers need (any data that is not going into a qualified destination) and it has the lowest starting price.
 * HubSpot and Salesforce follow as the two specialised preparations. The links lead to the pages that explain both.
 */
function ModesSection({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  const firstBand = formatCount(bandRange(0).to);
  const ordered = [...modes].sort((a, b) => (a.mode === "CLEAN" ? -1 : b.mode === "CLEAN" ? 1 : 0));
  return (
    <Section id="home-modes" heading={PUBLIC_COPY["home.modes.heading"]} lead={publication.kind === "READ" && modes.length > 0 ? PUBLIC_COPY["home.modes.published.lead"] : undefined} variant="kauro-site-offer">
      {publication.kind === "UNAVAILABLE" ? (
        <p className="kauro-site-callout">{PUBLIC_COPY["home.modes.unknown.body"]}</p>
      ) : modes.length === 0 ? (
        <p className="kauro-site-callout">{PUBLIC_COPY["home.modes.none.body"]}</p>
      ) : (
        <div className="kauro-board">
          <p className="kauro-board-head" aria-hidden="true">
            <span>{PUBLIC_COPY["home.modes.col.service"]}</span>
            <span>{PUBLIC_COPY["home.modes.col.what"]}</span>
            <span>{PUBLIC_COPY["home.modes.clean.for.label"]}</span>
            <span>{PUBLIC_COPY["home.modes.col.from"]}</span>
          </p>
          <ul className="kauro-board-rows">
            {ordered.map((published) => {
              const lead = published.mode === "CLEAN";
              return (
                <li key={published.mode} className={lead ? "kauro-board-row kauro-board-row--lead kauro-wine" : "kauro-board-row"}>
                  <div className="kauro-board-name">
                    <h3>{modeName(published.mode)}</h3>
                    <ServiceState availability={published.state === "AVAILABLE_LIMITED" ? "LIMITED" : "AVAILABLE"} />
                    {lead ? <p className="kauro-board-tag">{PUBLIC_COPY["home.modes.clean.tag"]}</p> : null}
                  </div>
                  <p className="kauro-board-what">{PUBLIC_COPY[MODE_LINE[published.mode]]}</p>
                  <div className="kauro-board-for">
                    <p className="kauro-board-label">{PUBLIC_COPY["home.modes.clean.for.label"]}</p>
                    {published.mode === "CLEAN" ? (
                      <ul className="kauro-board-chips">
                        {CLEAN_FOR.map((id) => (
                          <li key={id}>{PUBLIC_COPY[id]}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>{PUBLIC_COPY[MODE_FOR[published.mode]]}</p>
                    )}
                  </div>
                  <div className="kauro-board-price">
                    <PriceFigure amount={formatUsd(startingPrice(published.mode))} />
                    <p>{copy("home.modes.units", { units: firstBand })}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="kauro-site-links">
        <LinkButton href={ROUTE.pricing} kind="text">
          {PUBLIC_COPY["home.modes.more.cta"]}
        </LinkButton>
        <LinkButton href={ROUTE.services} kind="text">
          {PUBLIC_COPY["nav.services.label"]}
        </LinkButton>
      </p>
    </Section>
  );
}

export function HomePage({ publication }: HomePageProps): ReactElement {
  return (
    <>
      <PageHead
        variant="kauro-site-hero"
        eyebrow={PUBLIC_COPY["home.hero.eyebrow.label"]}
        title={PUBLIC_COPY["home.title"]}
        accent={2}
        lead={PUBLIC_COPY["home.hero.lead"]}
        aside={<ProductWindow />}
      >
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.contact} primary>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </LinkButton>
          <LinkButton href={ROUTE.sample}>{PUBLIC_COPY["home.hero.sample.cta"]}</LinkButton>
        </div>
        <p className="kauro-site-note kauro-site-note--check">{PUBLIC_COPY["home.hero.note"]}</p>
      </PageHead>
      <div className="kauro-site-facts">
        <ul className="kauro-site-wrap kauro-site-facts-list">
          {FACTS.map((fact) => (
            <li key={fact.name} className={`kauro-site-fact kauro-site-fact--${fact.mark}`}>
              <p className="kauro-site-fact-name">{PUBLIC_COPY[fact.name]}</p>
              <p className="kauro-site-fact-body">{PUBLIC_COPY[fact.body]}</p>
            </li>
          ))}
        </ul>
      </div>
      {/* How it works is one composition: its heading belongs to the held scene, not above it (journey.tsx) */}
      <section id="home-process" className="kauro-site-section kauro-inverse kauro-site-tone-band kauro-site-process" aria-labelledby="home-process-heading">
        <div className="kauro-site-wrap">
          <Journey eyebrow={PUBLIC_COPY["nav.how.label"]} heading={PUBLIC_COPY["home.process.heading"]} headingId="home-process-heading" />
        </div>
      </section>
      <Section id="home-buyer" heading={PUBLIC_COPY["home.buyer.heading"]} lead={PUBLIC_COPY["home.buyer.body"]} variant="kauro-site-buyer-section">
        <Audience />
      </Section>
      <Section id="home-delivery" heading={PUBLIC_COPY["home.delivery.heading"]} tone="sunken" variant="kauro-site-delivery">
        <PackageFolder sampleHref={ROUTE.sample} sampleLabel={PUBLIC_COPY["home.hero.sample.cta"]} />
      </Section>
      <Section id="home-limits" heading={PUBLIC_COPY["home.limits.heading"]} lead={PUBLIC_COPY["home.limits.lead"]} layout="split" variant="kauro-site-limits">
        <div className="kauro-locks kauro-inverse">
          <p className="kauro-locks-bar" aria-hidden="true">
            <span className="kauro-locks-brand">{PUBLIC_COPY["site.name"]}</span>
            <span className="kauro-locks-title">{PUBLIC_COPY["home.limits.panel"]}</span>
            <span className="kauro-locks-state">{PUBLIC_COPY["home.limits.locked"]}</span>
          </p>
          <ul className="kauro-locks-list">
            {LIMITS.map((limit) => (
              <li key={limit.name} className="kauro-lock">
                <h3>{PUBLIC_COPY[limit.name]}</h3>
                <p>{PUBLIC_COPY[limit.body]}</p>
                <span className="kauro-lock-state" aria-hidden="true">
                  {PUBLIC_COPY["home.limits.never"]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>
      <ModesSection publication={publication} />
      <Section id="home-context" heading={PUBLIC_COPY["home.context.heading"]} tone="wine" variant="kauro-site-quote">
        <p className="kauro-site-quote-text">{PUBLIC_COPY["home.context.body"]}</p>
      </Section>
      <Section
        id="home-start"
        heading={PUBLIC_COPY["home.closing.heading"]}
        layout="split"
        variant="kauro-site-start"
        lead={PUBLIC_COPY["home.closing.body"]}
        headExtra={
          <div className="kauro-site-actions">
            <LinkButton href={ROUTE.contact} primary>
              {PUBLIC_COPY["public.cta.request-health-check.cta"]}
            </LinkButton>
          </div>
        }
      >
        <div className="kauro-site-ticket-rock" aria-hidden="true">
          <div className="kauro-site-ticket">
            <span className="kauro-site-ticket-brand">{PUBLIC_COPY["site.name"]}</span>
            <span className="kauro-site-ticket-title">{PUBLIC_COPY["health-check.title"]}</span>
            <span className="kauro-site-ticket-line">{PUBLIC_COPY["home.ticket.measured"]}</span>
            <span className="kauro-site-ticket-line">{PUBLIC_COPY["home.ticket.obligation"]}</span>
            <span className="kauro-site-ticket-stamp">{PUBLIC_COPY["pricing.ladder.check.price"]}</span>
          </div>
        </div>
      </Section>
    </>
  );
}

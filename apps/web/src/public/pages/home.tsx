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
import { FileName, LinkButton, PageHead, PriceFigure, Section, ServiceState, Stamp } from "../parts.tsx";
import { bandRange, formatCount, formatUsd, startingPrice, type ServiceMode } from "../pricing-bands.ts";
import { MANIFEST_FILES, SAMPLE, SAMPLE_RECORDS, type RecordResult } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

export interface HomePageProps {
  readonly publication: Publication;
  readonly signInHref: string;
}

const PRICE_LINE: Readonly<Record<ServiceMode, PublicCopyId>> = {
  CLEAN: "pricing.ladder.clean.body",
  HUBSPOT: "pricing.ladder.hubspot.body",
  SALESFORCE: "pricing.ladder.salesforce.body",
};

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

const PROCESS = [
  { name: "home.process.measure.name", body: "home.process.measure.body" },
  { name: "home.process.decide.name", body: "home.process.decide.body" },
  { name: "home.process.prepare.name", body: "home.process.prepare.body" },
  { name: "home.process.import.name", body: "home.process.import.body" },
] as const satisfies ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId }>;

const DELIVERY = [
  { name: "home.delivery.report.name", body: "home.delivery.report" },
  { name: "home.delivery.files.name", body: "home.delivery.files" },
  { name: "home.delivery.manifest.name", body: "home.delivery.manifest" },
  { name: "home.delivery.steps.name", body: "home.delivery.steps" },
] as const satisfies ReadonlyArray<{ readonly name: PublicCopyId; readonly body: PublicCopyId }>;

/** The package of the sample delivery as a stack of sheets: the cleaned files with their rows, then the documents that explain them. */
function FileStack(): ReactElement {
  return (
    <div className="kauro-site-stack" aria-hidden="true">
      <ul className="kauro-site-stack-sheets">
        {MANIFEST_FILES.map((file) => (
          <li key={file.name} className="kauro-site-stack-sheet">
            <FileName>{file.name}</FileName>
            <span className="kauro-site-stack-meta">{copy("home.files.rows", { count: formatCount(file.rows) })}</span>
          </li>
        ))}
        {(["home.delivery.report.name", "home.delivery.manifest.name", "home.delivery.steps.name"] as const).map((name) => (
          <li key={name} className="kauro-site-stack-sheet kauro-site-stack-sheet--doc">
            <span className="kauro-site-stack-doc">{PUBLIC_COPY[name]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModesSection({ publication }: { readonly publication: Publication }): ReactElement {
  const modes = publishedModes(publication);
  const firstBand = formatCount(bandRange(0).to);
  return (
    <Section id="home-modes" heading={PUBLIC_COPY["home.modes.heading"]} lead={publication.kind === "READ" && modes.length > 0 ? PUBLIC_COPY["home.modes.published.lead"] : undefined}>
      {publication.kind === "UNAVAILABLE" ? (
        <p className="kauro-site-callout">{PUBLIC_COPY["home.modes.unknown.body"]}</p>
      ) : modes.length === 0 ? (
        <p className="kauro-site-callout">{PUBLIC_COPY["home.modes.none.body"]}</p>
      ) : (
        <ul className="kauro-site-modes">
          {modes.map((published) => (
            <li key={published.mode} className={`kauro-site-mode kauro-site-mode--${published.mode.toLowerCase()}`}>
              <h3>{modeName(published.mode)}</h3>
              <ServiceState availability={published.state === "AVAILABLE_LIMITED" ? "LIMITED" : "AVAILABLE"} />
              <PriceFigure amount={formatUsd(startingPrice(published.mode))} />
              <p className="kauro-site-mode-price">{copy(PRICE_LINE[published.mode], { price: formatUsd(startingPrice(published.mode)), units: firstBand })}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="kauro-site-links">
        <LinkButton href={ROUTE.services} kind="text">
          {PUBLIC_COPY["nav.services.label"]}
        </LinkButton>
        <LinkButton href={ROUTE.pricing} kind="text">
          {PUBLIC_COPY["home.hero.pricing.cta"]}
        </LinkButton>
      </p>
    </Section>
  );
}

export function HomePage({ publication, signInHref }: HomePageProps): ReactElement {
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
          <LinkButton href={signInHref} primary>
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
      <Section id="home-process" heading={PUBLIC_COPY["home.process.heading"]} eyebrow={PUBLIC_COPY["nav.how.label"]} tone="inverse" variant="kauro-site-process">
        <ol className="kauro-site-process-steps">
          {PROCESS.map((step) => (
            <li key={step.name} className="kauro-site-process-step">
              <h3>{PUBLIC_COPY[step.name]}</h3>
              <p>{PUBLIC_COPY[step.body]}</p>
            </li>
          ))}
        </ol>
        <p className="kauro-site-links">
          <LinkButton href={ROUTE.how} kind="text">
            {PUBLIC_COPY["nav.how.label"]}
          </LinkButton>
        </p>
      </Section>
      <Section id="home-buyer" heading={PUBLIC_COPY["home.buyer.heading"]} layout="split" lead={PUBLIC_COPY["home.buyer.body"]}>
        <ul className="kauro-site-buyers">
          <li className="kauro-site-buyer">
            <h3>{PUBLIC_COPY["home.buyer.agency.name"]}</h3>
            <p>{PUBLIC_COPY["home.buyer.agency.body"]}</p>
          </li>
          <li className="kauro-site-buyer">
            <h3>{PUBLIC_COPY["home.buyer.company.name"]}</h3>
            <p>{PUBLIC_COPY["pricing.in-house.body"]}</p>
          </li>
        </ul>
      </Section>
      <Section id="home-delivery" heading={PUBLIC_COPY["home.delivery.heading"]} tone="sunken" variant="kauro-site-delivery">
        <div className="kauro-site-delivery-grid">
          <FileStack />
          <div className="kauro-site-delivery-list">
            <ol className="kauro-site-deliverables">
              {DELIVERY.map((item) => (
                <li key={item.name} className="kauro-site-deliverable">
                  <h3>{PUBLIC_COPY[item.name]}</h3>
                  <p>{PUBLIC_COPY[item.body]}</p>
                </li>
              ))}
            </ol>
            <p className="kauro-site-links">
              <LinkButton href={ROUTE.sample} kind="text">
                {PUBLIC_COPY["home.hero.sample.cta"]}
              </LinkButton>
            </p>
          </div>
        </div>
      </Section>
      <Section id="home-limits" heading={PUBLIC_COPY["home.limits.heading"]} layout="split" tone="inverse" variant="kauro-site-limits">
        <ul className="kauro-site-statements">
          <li>{PUBLIC_COPY["home.limits.live"]}</li>
          <li>{PUBLIC_COPY["home.limits.import"]}</li>
          <li>{PUBLIC_COPY["home.limits.decide"]}</li>
        </ul>
      </Section>
      <ModesSection publication={publication} />
      <Section id="home-context" heading={PUBLIC_COPY["home.context.heading"]} tone="clay" variant="kauro-site-quote">
        <p className="kauro-site-quote-text">{PUBLIC_COPY["home.context.body"]}</p>
      </Section>
      <Section id="home-start" heading={PUBLIC_COPY["home.closing.heading"]} layout="split" tone="wine" variant="kauro-site-closing">
        <p className="kauro-site-closing-body">{PUBLIC_COPY["home.closing.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={signInHref} primary>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </LinkButton>
        </div>
      </Section>
    </>
  );
}

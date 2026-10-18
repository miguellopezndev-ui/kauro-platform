// UI04 Pricing (A3 3.4): the ladder is the policy's bands and nothing typed here. Every price is an indicative band until the server quotes
// from the sealed files; the band above the launch envelope is on the ladder but carries no price; the company sentence says a company buys on
// the same terms as an agency (D-33); the founding line is not here. What each service costs is shown beside whether it can be bought now, from the publication.
//
// The ladder reads in the order a buyer climbs it: the free check, the three services with their starting price, then the repeat discount.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { MarginNote, Pane } from "../artifacts.tsx";
import { BandEstimator } from "../band-estimator.tsx";
import { MANIFEST_FILES, SAMPLE } from "../sample-data.ts";
import { availabilityOf, type Availability, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { DataTable, LinkButton, MODE_ORDER, PageHead, PriceFigure, Section, ServiceState } from "../parts.tsx";
import { BANDS, bandLabel, bandOffered, bandRange, formatCount, formatUsd, priceOf, repeatDiscounts, startingPrice, type ServiceMode } from "../pricing-bands.ts";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";

export interface PricingPageProps {
  readonly publication: Publication;
  readonly signInHref: string;
}

const LADDER: Readonly<Record<ServiceMode, { readonly name: PublicCopyId; readonly body: PublicCopyId }>> = {
  CLEAN: { name: "pricing.ladder.clean.name", body: "pricing.ladder.clean.body" },
  HUBSPOT: { name: "pricing.ladder.hubspot.name", body: "pricing.ladder.hubspot.body" },
  SALESFORCE: { name: "pricing.ladder.salesforce.name", body: "pricing.ladder.salesforce.body" },
};

function percentOf(index: number): string {
  return `${repeatDiscounts()[index]?.percent ?? 0}%`;
}

export function PricingPage({ publication, signInHref }: PricingPageProps): ReactElement {
  const availability: Readonly<Record<ServiceMode, Availability>> = {
    CLEAN: availabilityOf(publication, "CLEAN"),
    HUBSPOT: availabilityOf(publication, "HUBSPOT"),
    SALESFORCE: availabilityOf(publication, "SALESFORCE"),
  };
  const firstBand = formatCount(bandRange(0).to);
  const tiers = repeatDiscounts();
  return (
    <>
      <PageHead size="compact" accent={4} eyebrow={PUBLIC_COPY["nav.pricing.label"]} title={PUBLIC_COPY["pricing.title"]} lead={PUBLIC_COPY["pricing.lead"]} />
      <Section id="pricing-ladder" heading={PUBLIC_COPY["pricing.ladder.heading"]}>
        <ul className="kauro-site-ladder">
          <li className="kauro-site-rung kauro-site-rung--free kauro-wine">
            <h3>{PUBLIC_COPY["pricing.ladder.check.name"]}</h3>
            <p className="kauro-site-price">{PUBLIC_COPY["pricing.ladder.check.price"]}</p>
            <p>{PUBLIC_COPY["pricing.ladder.check.body"]}</p>
          </li>
          {MODE_ORDER.map((mode) => (
            <li key={mode} className="kauro-site-rung">
              <h3>{PUBLIC_COPY[LADDER[mode].name]}</h3>
              <ServiceState availability={availability[mode]} />
              <PriceFigure amount={formatUsd(startingPrice(mode))} />
              <p>{copy(LADDER[mode].body, { price: formatUsd(startingPrice(mode)), units: firstBand })}</p>
            </li>
          ))}
          <li className="kauro-site-rung kauro-site-rung--repeat">
            <h3>{PUBLIC_COPY["pricing.ladder.repeat.name"]}</h3>
            <p className="kauro-site-price">{`${percentOf(0)}–${percentOf(tiers.length - 1)}`}</p>
            <p>{copy("pricing.ladder.repeat.body", { low: percentOf(0), mid: percentOf(1), high: percentOf(2) })}</p>
          </li>
        </ul>
        <DataTable
          variant="kauro-site-table-region--bands"
          caption={PUBLIC_COPY["pricing.table.caption"]}
          columns={[PUBLIC_COPY["pricing.table.units.label"], ...MODE_ORDER.map(modeName)]}
          rows={BANDS.map((_band, index) => ({
            key: `band-${index}`,
            head: bandLabel(index),
            cells: MODE_ORDER.map((mode) => (bandOffered(index) ? formatUsd(priceOf(index, mode)) : PUBLIC_COPY["pricing.table.not-offered"])),
          }))}
        />
        <p className="kauro-site-meta">{PUBLIC_COPY["pricing.table.note"]}</p>
        <p className="kauro-site-callout kauro-site-callout--accent">{PUBLIC_COPY["pricing.in-house.body"]}</p>
      </Section>
      <Section id="pricing-unit" heading={PUBLIC_COPY["pricing.unit.heading"]} layout="split" tone="sunken">
        <p className="kauro-site-statement kauro-site-statement--small">{PUBLIC_COPY["pricing.unit.body"]}</p>
        <Pane variant="kauro-site-frag--units">
          <span className="kauro-site-units-col">
            <span className="kauro-site-frag-title">{PUBLIC_COPY["pricing.frag.counted"]}</span>
            <span className="kauro-site-frag-figure">{formatCount(SAMPLE.contacts)}</span>
            <span className="kauro-site-frag-label">{PUBLIC_COPY["pricing.table.units.label"]}</span>
          </span>
          <span className="kauro-site-units-col kauro-site-units-col--not">
            <span className="kauro-site-frag-title">{PUBLIC_COPY["pricing.frag.not-counted"]}</span>
            <span className="kauro-site-frag-figure">{formatCount(MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile)?.rows ?? 0)}</span>
            <span className="kauro-site-frag-label">{PUBLIC_COPY["pricing.frag.output"]}</span>
          </span>
        </Pane>
        <MarginNote>{PUBLIC_COPY["pricing.note.split"]}</MarginNote>
        <p className="kauro-site-muted">{PUBLIC_COPY["pricing.unit.zero"]}</p>
      </Section>
      <Section id="pricing-quote" heading={PUBLIC_COPY["pricing.quote.heading"]} layout="split">
        <p>{copy("pricing.quote.body", { days: POLICY_SNAPSHOT.quoteDays })}</p>
        <p className="kauro-site-muted">{PUBLIC_COPY["pricing.tax.body"]}</p>
      </Section>
      <Section id="pricing-repeat" heading={PUBLIC_COPY["pricing.repeat.heading"]} layout="split">
        <p>{PUBLIC_COPY["pricing.repeat.body"]}</p>
        <DataTable
          variant="kauro-site-table-region--compact"
          caption={copy("pricing.repeat.table.caption", { days: POLICY_SNAPSHOT.repeatLookbackDays })}
          columns={[PUBLIC_COPY["pricing.repeat.projects.label"], PUBLIC_COPY["pricing.repeat.discount.label"]]}
          rows={tiers.map((tier) => ({ key: tier.range, head: copy("pricing.repeat.range", { range: tier.range }), cells: [`${tier.percent}%`] }))}
        />
      </Section>
      <Section id="pricing-estimate" heading={PUBLIC_COPY["pricing.estimate.heading"]} layout="split" tone="inverse" lead={PUBLIC_COPY["pricing.estimate.lead"]}>
        <BandEstimator availability={availability} />
      </Section>
      <Section id="pricing-account" heading={PUBLIC_COPY["pricing.account.heading"]} layout="split" variant="kauro-site-closing kauro-site-closing--plain">
        <p className="kauro-site-closing-body">{PUBLIC_COPY["pricing.account.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={signInHref} primary>
            {PUBLIC_COPY["pricing.account.cta"]}
          </LinkButton>
        </div>
      </Section>
    </>
  );
}

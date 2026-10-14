// UI04 Pricing (A3 3.4): the ladder is the policy's bands and nothing typed here. Every price is an indicative band until the server quotes
// from the sealed files; the band above the launch envelope is on the ladder but carries no price; the company sentence says a company buys on
// the same terms as an agency (D-33); the founding line is not here. What each service costs is shown beside whether it can be bought now, from the publication.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { BandEstimator } from "../band-estimator.tsx";
import { availabilityOf, type Availability, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { DataTable, LinkButton, MODE_ORDER, PageHead, Section, ServiceState } from "../parts.tsx";
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
  return (
    <>
      <PageHead title={PUBLIC_COPY["pricing.title"]} lead={PUBLIC_COPY["pricing.lead"]} />
      <Section id="pricing-ladder" heading={PUBLIC_COPY["pricing.ladder.heading"]}>
        <ul className="kauro-site-cards">
          <li className="kauro-site-card">
            <h3>{PUBLIC_COPY["pricing.ladder.check.name"]}</h3>
            <p>{PUBLIC_COPY["pricing.ladder.check.body"]}</p>
          </li>
          {MODE_ORDER.map((mode) => (
            <li key={mode} className="kauro-site-card">
              <h3>{PUBLIC_COPY[LADDER[mode].name]}</h3>
              <ServiceState availability={availability[mode]} />
              <p>{copy(LADDER[mode].body, { price: formatUsd(startingPrice(mode)), units: firstBand })}</p>
            </li>
          ))}
          <li className="kauro-site-card">
            <h3>{PUBLIC_COPY["pricing.ladder.repeat.name"]}</h3>
            <p>{copy("pricing.ladder.repeat.body", { low: percentOf(0), mid: percentOf(1), high: percentOf(2) })}</p>
          </li>
        </ul>
        <DataTable
          caption={PUBLIC_COPY["pricing.table.caption"]}
          columns={[PUBLIC_COPY["pricing.table.units.label"], ...MODE_ORDER.map(modeName)]}
          rows={BANDS.map((_band, index) => ({
            key: `band-${index}`,
            head: bandLabel(index),
            cells: MODE_ORDER.map((mode) => (bandOffered(index) ? formatUsd(priceOf(index, mode)) : PUBLIC_COPY["pricing.table.not-offered"])),
          }))}
        />
        <p className="kauro-site-note">{PUBLIC_COPY["pricing.table.note"]}</p>
        <p>{PUBLIC_COPY["pricing.in-house.body"]}</p>
      </Section>
      <Section id="pricing-unit" heading={PUBLIC_COPY["pricing.unit.heading"]}>
        <p>{PUBLIC_COPY["pricing.unit.body"]}</p>
        <p>{PUBLIC_COPY["pricing.unit.zero"]}</p>
      </Section>
      <Section id="pricing-quote" heading={PUBLIC_COPY["pricing.quote.heading"]}>
        <p>{copy("pricing.quote.body", { days: POLICY_SNAPSHOT.quoteDays })}</p>
        <p>{PUBLIC_COPY["pricing.tax.body"]}</p>
      </Section>
      <Section id="pricing-repeat" heading={PUBLIC_COPY["pricing.repeat.heading"]}>
        <p>{PUBLIC_COPY["pricing.repeat.body"]}</p>
        <DataTable
          caption={copy("pricing.repeat.table.caption", { days: POLICY_SNAPSHOT.repeatLookbackDays })}
          columns={[PUBLIC_COPY["pricing.repeat.projects.label"], PUBLIC_COPY["pricing.repeat.discount.label"]]}
          rows={repeatDiscounts().map((tier) => ({ key: tier.range, head: copy("pricing.repeat.range", { range: tier.range }), cells: [`${tier.percent}%`] }))}
        />
      </Section>
      <Section id="pricing-estimate" heading={PUBLIC_COPY["pricing.estimate.heading"]}>
        <p>{PUBLIC_COPY["pricing.estimate.lead"]}</p>
        <BandEstimator availability={availability} />
      </Section>
      <Section id="pricing-account" heading={PUBLIC_COPY["pricing.account.heading"]}>
        <p>{PUBLIC_COPY["pricing.account.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={signInHref} primary>
            {PUBLIC_COPY["pricing.account.cta"]}
          </LinkButton>
        </div>
      </Section>
    </>
  );
}

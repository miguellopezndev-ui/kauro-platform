// UI04 Pricing (A3 3.4): the prices are the policy's bands and nothing typed here. Every price is an indicative band until the server quotes
// from the sealed files; the band above the launch envelope is in the table but carries no price; the company sentence says a company buys
// on the same terms as an agency (D-33); the founding line is not here. Whether each service can be bought now comes from the publication.
//
// Order 11 round 2: a count-priced page asks for the count first (every count-priced page in the round-2 sample puts its estimator above the
// prices), so the estimator sits in the first screen and its result is the page's only large figure. The nine prices appear once, in one
// table, at reading size; the four-card ladder that repeated each price, the repeat band at the top and the second discount section are
// gone. What the price includes, how quotes, tax and repeat projects work, and the questions a buyer still has follow, then the closing band
// with the site's one call to action.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../../copy/public.ts";
import { MarginNote, Pane } from "../artifacts.tsx";
import { BandEstimator } from "../band-estimator.tsx";
import { availabilityOf, type Availability, type Publication } from "../capabilities.ts";
import { modeName } from "../estimate-text.ts";
import { DataTable } from "../parts.tsx";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";
import { BANDS, bandLabel, bandOffered, formatCount, formatUsd, priceOf, repeatDiscounts, type ServiceMode } from "../pricing-bands.ts";
import { Block, CHECK_CTA, Closing, Head, SERVICE_ORDER } from "../r2.tsx";
import { DEFECT_CLAIM_DAYS, DEFECT_REPAIR_BUSINESS_DAYS } from "../retention.ts";
import { MANIFEST_FILES, SAMPLE } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

export interface PricingPageProps {
  readonly publication: Publication;
  readonly signInHref: string;
}

/** A price as the table writes it: the figure alone, the currency in the caption ("1,295"). */
const figure = (minor: number): string => formatUsd(minor).replace(/^USD /, "");

export function PricingPage({ publication, signInHref }: PricingPageProps): ReactElement {
  const availability: Readonly<Record<ServiceMode, Availability>> = {
    CLEAN: availabilityOf(publication, "CLEAN"),
    HUBSPOT: availabilityOf(publication, "HUBSPOT"),
    SALESFORCE: availabilityOf(publication, "SALESFORCE"),
  };
  const tiers = repeatDiscounts();
  const percent = (index: number): string => `${tiers[index]?.percent ?? 0}%`;
  const firstTo = BANDS[0]?.maximum ?? 0;
  const contactsFile = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  return (
    <>
      <Head kind="path" accent={4} eyebrow={PUBLIC_COPY["nav.pricing.label"]} title={PUBLIC_COPY["pricing.title"]} lead={PUBLIC_COPY["pricing.lead"]}>
        <p className="kauro-r2-head-line">{PUBLIC_COPY["pricing.count.line"]}</p>
      </Head>
      <Block id="pricing-estimate" heading={PUBLIC_COPY["pricing.estimate.heading"]} lead={PUBLIC_COPY["pricing.estimate.lead"]} variant="kauro-r2-block--first">
        <BandEstimator availability={availability} order={SERVICE_ORDER} />
        <p className="kauro-r2-after">{copy("pricing.estimate.repeat", { low: percent(0), mid: percent(1), high: percent(tiers.length - 1) })}</p>
      </Block>
      <Block id="pricing-table" heading={PUBLIC_COPY["pricing.ladder.heading"]} tone="sunken">
        <DataTable
          variant="kauro-r2-prices"
          stack={false}
          caption={PUBLIC_COPY["pricing.table.caption"]}
          columns={[PUBLIC_COPY["pricing.table.units.label"], ...SERVICE_ORDER.map(modeName)]}
          rows={BANDS.map((_band, index) => ({
            key: `band-${index}`,
            head: bandLabel(index),
            cells: SERVICE_ORDER.map((mode) => (bandOffered(index) ? figure(priceOf(index, mode)) : PUBLIC_COPY["pricing.table.not-offered"])),
          }))}
        />
        <p className="kauro-r2-after">{PUBLIC_COPY["pricing.table.note"]}</p>
        <p className="kauro-r2-after">
          {copy("pricing.band.step", {
            units: formatCount(firstTo),
            next: formatCount(firstTo + 1),
            mode: modeName("HUBSPOT"),
            price: formatUsd(priceOf(0, "HUBSPOT")),
            nextPrice: formatUsd(priceOf(1, "HUBSPOT")),
          })}
        </p>
      </Block>
      <Block id="pricing-unit" heading={PUBLIC_COPY["pricing.unit.heading"]} layout="split">
        <p>{PUBLIC_COPY["pricing.unit.body"]}</p>
        <Pane variant="kauro-site-frag--units">
          <span className="kauro-site-units-col">
            <span className="kauro-site-frag-title">{PUBLIC_COPY["pricing.frag.counted"]}</span>
            <span className="kauro-site-frag-figure">{formatCount(SAMPLE.contacts)}</span>
            <span className="kauro-site-frag-label">{PUBLIC_COPY["pricing.table.units.label"]}</span>
          </span>
          <span className="kauro-site-units-col kauro-site-units-col--not">
            <span className="kauro-site-frag-title">{PUBLIC_COPY["pricing.frag.not-counted"]}</span>
            <span className="kauro-site-frag-figure">{formatCount(contactsFile?.rows ?? 0)}</span>
            <span className="kauro-site-frag-label">{PUBLIC_COPY["pricing.frag.output"]}</span>
          </span>
        </Pane>
        <MarginNote>{PUBLIC_COPY["pricing.note.split"]}</MarginNote>
        <p className="kauro-r2-after">{PUBLIC_COPY["pricing.unit.zero"]}</p>
      </Block>
      <Block id="pricing-includes" heading={PUBLIC_COPY["pricing.includes.heading"]} tone="sunken">
        <div className="kauro-r2-pair">
          <div className="kauro-r2-pair-item kauro-r2-pair-item--in">
            <h3>{PUBLIC_COPY["services.scope.in.label"]}</h3>
            <ul>
              <li>{PUBLIC_COPY["pricing.includes.check"]}</li>
              <li>{PUBLIC_COPY["pricing.includes.plan"]}</li>
              <li>{PUBLIC_COPY["pricing.includes.package"]}</li>
              <li>{PUBLIC_COPY["pricing.includes.report"]}</li>
              <li>{copy("pricing.includes.defect", { days: DEFECT_CLAIM_DAYS })}</li>
            </ul>
          </div>
          <div className="kauro-r2-pair-item kauro-r2-pair-item--out">
            <h3>{PUBLIC_COPY["services.scope.out.label"]}</h3>
            <ul>
              <li>{PUBLIC_COPY["pricing.excludes.connect"]}</li>
              <li>{PUBLIC_COPY["pricing.excludes.import"]}</li>
              <li>{PUBLIC_COPY["pricing.excludes.deploy"]}</li>
              <li>{PUBLIC_COPY["pricing.excludes.enrichment"]}</li>
              <li>{PUBLIC_COPY["pricing.excludes.ongoing"]}</li>
            </ul>
          </div>
        </div>
      </Block>
      <Block id="pricing-quote" heading={PUBLIC_COPY["pricing.quote.heading"]} layout="split">
        <p>{copy("pricing.quote.body", { days: POLICY_SNAPSHOT.quoteDays })}</p>
        <p>{PUBLIC_COPY["pricing.tax.body"]}</p>
        <p>{PUBLIC_COPY["pricing.repeat.body"]}</p>
        <DataTable
          variant="kauro-r2-compact-table"
          stack={false}
          caption={copy("pricing.repeat.table.caption", { days: POLICY_SNAPSHOT.repeatLookbackDays })}
          columns={[PUBLIC_COPY["pricing.repeat.projects.label"], PUBLIC_COPY["pricing.repeat.discount.label"]]}
          rows={tiers.map((tier) => ({ key: tier.range, head: copy("pricing.repeat.range", { range: tier.range }), cells: [`${tier.percent}%`] }))}
        />
      </Block>
      <Block id="pricing-questions" heading={PUBLIC_COPY["pricing.questions.heading"]} tone="sunken" layout="split">
        <div className="kauro-r2-questions">
          <details>
            <summary>{PUBLIC_COPY["pricing.question.free"]}</summary>
            <p>{PUBLIC_COPY["pricing.answer.free"]}</p>
          </details>
          <details>
            <summary>{PUBLIC_COPY["pricing.question.companies"]}</summary>
            <p>{PUBLIC_COPY["pricing.in-house.body"]}</p>
          </details>
          <details>
            <summary>{PUBLIC_COPY["pricing.question.larger"]}</summary>
            <p>{copy("pricing.estimate.not-offered", { units: formatCount(POLICY_SNAPSHOT.launchSourceUnits) })}</p>
          </details>
          <details>
            <summary>{PUBLIC_COPY["pricing.question.defect"]}</summary>
            <p>{copy("security.retention.defect", { days: DEFECT_CLAIM_DAYS, repair: DEFECT_REPAIR_BUSINESS_DAYS })}</p>
          </details>
        </div>
      </Block>
      <Closing
        id="pricing-account"
        heading={PUBLIC_COPY["home.closing.heading"]}
        body={PUBLIC_COPY["pricing.account.body"]}
        primary={CHECK_CTA}
        links={[
          { href: signInHref, label: PUBLIC_COPY["pricing.account.cta"] },
          { href: ROUTE.services, label: PUBLIC_COPY["how.next.services.cta"] },
        ]}
      />
    </>
  );
}

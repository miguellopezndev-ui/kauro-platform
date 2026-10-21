// A variant of UI04 Pricing (Order 11; review only, never in the application's bundle). The approved page, word for word, with two additions
// the research proposes (pricing-trust-agencies.md §1.3, proposals 1 and 7): what the price includes and what it does not, in words (ToS
// §7.6 and §3.5; the report "with your branding" is left out while branding is not available), and a short set of questions about the
// price, each answered only from a rule that exists (ToS §6.2, §7.1, §7.3, §7.5, §8.1, §10, §11; Annex A). The founding line stays out
// (D-COPY-1), and no payment route is named beyond "bank transfer in USD" (PV1 §5).
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "@web/copy/public.ts";
import { MarginNote, Pane } from "@web/public/artifacts.tsx";
import { BandEstimator } from "@web/public/band-estimator.tsx";
import { MANIFEST_FILES, SAMPLE } from "@web/public/sample-data.ts";
import { availabilityOf, type Availability, type Publication } from "@web/public/capabilities.ts";
import { modeName } from "@web/public/estimate-text.ts";
import { DataTable, LinkButton, MODE_ORDER, PageHead, PriceFigure, Section, ServiceState } from "@web/public/parts.tsx";
import { BANDS, bandLabel, bandOffered, bandRange, formatCount, formatUsd, priceOf, repeatDiscounts, startingPrice, type ServiceMode } from "@web/public/pricing-bands.ts";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";

interface PricingPageProps {
  readonly publication: Publication;
  readonly signInHref: string;
}

const LADDER: Readonly<Record<ServiceMode, { readonly name: PublicCopyId; readonly body: PublicCopyId }>> = {
  CLEAN: { name: "pricing.ladder.clean.name", body: "pricing.ladder.clean.body" },
  HUBSPOT: { name: "pricing.ladder.hubspot.name", body: "pricing.ladder.hubspot.body" },
  SALESFORCE: { name: "pricing.ladder.salesforce.name", body: "pricing.ladder.salesforce.body" },
};

const QUESTIONS: readonly { readonly q: string; readonly a: string }[] = [
  { q: "What is a billable source unit?", a: "An admitted record in the files you seal: a contact, an organisation or a deal. Splitting a file into several changes nothing." },
  { q: "Do duplicates count?", a: "Yes. Units are counted before any duplicates are unified." },
  { q: "How long is a quote valid?", a: `${POLICY_SNAPSHOT.quoteDays} days. Your files may be deleted sooner; the quote shows both dates.` },
  { q: "How do I pay?", a: "By bank transfer in USD, with the details on your quote. There are no card payments and no subscriptions." },
  { q: "Are taxes included?", a: "Prices are in USD, before tax. The quote shows the tax before you pay, and no quote is issued until the tax treatment is reviewed." },
  { q: "Do agencies and companies pay the same?", a: "Yes: the same prices and the same discounts." },
  { q: "Do discounts combine?", a: "No. Discounts do not stack; the larger one you are eligible for applies." },
  { q: `What if a project is larger than ${formatCount(POLICY_SNAPSHOT.launchSourceUnits)} units?`, a: "It is not offered at launch. Ask in writing, and describe the project." },
  { q: "What if something in the package is wrong?", a: "Report it within 30 days of completion. Kauro repairs it, with a target of 5 business days, and refunds when a repair is not reasonable." },
  { q: "Can I get a refund?", a: "Before the preparation starts, in full. Once it has started, Kauro evaluates the request in good faith." },
];

function percentOf(index: number): string {
  return `${repeatDiscounts()[index]?.percent ?? 0}%`;
}

export function PricingVariant({ publication, signInHref }: PricingPageProps): ReactElement {
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
      <Section id="pricing-includes" heading="What the price includes" layout="split">
        <div className="kauro-site-scope">
          <div className="kauro-site-scope-column kauro-site-scope-column--in">
            <p className="kauro-site-scope-label">Included</p>
            <ul className="kauro-variant-plain-list">
              <li>The free data health check of the files you seal.</li>
              <li>The plan your team approves, part by part.</li>
              <li>A package checked before it is released, with its report and the record of every change.</li>
              <li>The guide to import it with your own tool and, for an import in stages, each next stage after your team returns the result.</li>
              <li>The repair of a defect Kauro caused, reported within 30 days of completion.</li>
            </ul>
          </div>
          <div className="kauro-site-scope-column kauro-site-scope-column--out">
            <p className="kauro-site-scope-label">Not included</p>
            <ul className="kauro-variant-plain-list">
              <li>Connecting to your CRM or writing into it.</li>
              <li>Running the import: your team runs it with its own account.</li>
              <li>Creating fields, validation rules or automations.</li>
              <li>Paid enrichment from outside sources.</li>
              <li>Ongoing maintenance: each later cleanup is a new project.</li>
            </ul>
          </div>
        </div>
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
      <Section id="pricing-questions" heading="Questions about the price" layout="split" tone="sunken">
        <dl className="kauro-variant-faq">
          {QUESTIONS.map((item) => (
            <div key={item.q}>
              <dt>{item.q}</dt>
              <dd>{item.a}</dd>
            </div>
          ))}
        </dl>
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

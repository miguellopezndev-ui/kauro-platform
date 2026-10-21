// "For agencies" (Order 11; a public-site variant, review only). Agencies are Kauro's main channel (A3); the approved site speaks to them
// only in passing. The owner's answer of 2026-10-20 says what this page may state and with which limits:
//   (a) a free check on a prospect's files only with the data controller's documented authorisation and the data processing terms; never
//       anonymous or unlimited; Kauro never contacts the end client;
//   (b) the agency sets its own price; Kauro charges only its own price, manages no agency billing and guarantees no margin;
//   (c) reports with the agency's name and logo, as the branding available allows, never altering evidence or hiding Kauro's legal
//       identity, for future reports only, and verified before it is published as working: so it is shown as not available yet;
// and the benefits: work from exported files without CRM admin access, several clients kept apart, professional results, recurring work.
// Prices and discounts are the price list's own (the same for agencies and companies; the repeat ladder of the policy snapshot).
import type { ReactElement } from "react";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { LinkButton, PageHead, Section } from "@web/public/parts.tsx";
import { ROUTE } from "@web/public/site.ts";

const TIERS = POLICY_SNAPSHOT.repeatTiers.filter((tier) => tier.percent > 0);

export function ForAgenciesPage(): ReactElement {
  return (
    <>
      <PageHead
        eyebrow="For agencies"
        accent={2}
        title="Prepare your clients' data without their CRM passwords."
        lead="Your client exports the records. Kauro checks them, your team approves the plan, and the files come back ready for the import your team runs. Kauro never writes to a client's CRM."
        size="compact"
      />
      <Section id="agencies-why" heading="Why agencies use it" layout="split">
        <ul className="kauro-site-specs kauro-site-specs--plate">
          <li>No admin access to a client&apos;s CRM: the work starts from the files the client exports.</li>
          <li>Each client kept apart: its own projects and files, and its processing authority on record.</li>
          <li>Results you can show: every change listed with its reason, and every output row traced to the rows it came from.</li>
          <li>Recurring work: each periodic cleanup is a new project, and earlier projects bring the repeat discount below.</li>
        </ul>
      </Section>
      <Section id="agencies-price" heading="Your price, your client" layout="split" tone="sunken">
        <ul className="kauro-site-specs kauro-site-specs--plate">
          <li>You set the price you charge your client. Kauro charges you its own price and nothing else.</li>
          <li>Kauro never invoices your client and manages none of your billing, and it guarantees no margin.</li>
          <li>
            The same prices and discounts as a company buying direct. From earlier projects in the last {POLICY_SNAPSHOT.repeatLookbackDays} days:{" "}
            {TIERS.map((tier, index) => `${tier.percent}% from ${tier.minimum} ${tier.minimum === 1 ? "project" : "projects"}${index < TIERS.length - 1 ? ", " : ""}`).join("")}.{" "}
            <a href={ROUTE.pricing}>See the prices</a>
          </li>
        </ul>
      </Section>
      <Section id="agencies-prospects" heading="Checking a prospect's files" layout="split">
        <ul className="kauro-site-specs kauro-site-specs--plate">
          <li>The free data health check works on a prospect&apos;s files too, with that business&apos;s documented authorisation and the data processing terms in place.</li>
          <li>It is never anonymous and never unlimited: it runs in your workspace, under your account.</li>
          <li>Kauro never contacts your client or your prospect.</li>
        </ul>
      </Section>
      <Section id="agencies-branding" heading="Reports with your name" layout="split" tone="sunken">
        <p>
          <strong>Not available yet.</strong> Planned: your agency&apos;s name and logo on the reports Kauro delivers, for reports made after you set them. Branding never changes what a report
          proves and never hides that Kauro prepared it. This page will say when it works.
        </p>
      </Section>
      <Section id="agencies-start" heading="Start with one client's file" layout="split" tone="wine" variant="kauro-site-band-compact kauro-site-band-grain">
        <p>Create an account for your agency, add the client, and check a file free. A question first? Ask it: the answer comes in writing.</p>
        <div className="kauro-site-actions">
          <LinkButton href="/__variants/free-check" primary>
            Check a file free
          </LinkButton>
          <LinkButton href={ROUTE.contact} kind="text">
            Ask a question
          </LinkButton>
        </div>
      </Section>
    </>
  );
}

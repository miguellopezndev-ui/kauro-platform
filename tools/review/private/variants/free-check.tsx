// "Check a file free" (Order 11; a public-site variant, review only). The owner's answer of 2026-10-20: the main call to action opens a page
// on the free check, then the visitor creates an account or signs in and continues; a short, progressive eligibility check comes before any
// real file (agency or company, admitted scope, authority over the data, the agreements including the data processing terms, two-step
// verification); "Ask a question" stays as the alternative; budget and capacity are respected. It changes A3 §3.2 (a request through the
// contact form becomes a self-serve start): recorded as functional gap F-03, and drawn here for the owner to judge.
//
// Every statement is the approved site's or the policy's: the check is free and creates no obligation to buy (home.hero.note); it
// measures every row of the sealed set (how.stage.check.summary); no payment details are asked before a quote (billing details come at the
// first quote, UI09); files stay 7 days after the check is ready and never more than 14 days after sealing (policy retention, unpaid);
// the input limits are the policy's (INPUT_LIMITS). Nothing here promises a time to results, a number of free checks or a discount.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "@web/copy/public.ts";
import { INPUT_LIMITS } from "@web/public/limits.ts";
import { LinkButton, PageHead, Section } from "@web/public/parts.tsx";
import { ROUTE } from "@web/public/site.ts";

const STEPS: readonly { readonly title: string; readonly body: string }[] = [
  { title: "Create an account", body: "With Google, or with your email and a password. Kauro verifies the email and sets up its own two-step verification before any file." },
  { title: "Say who you are", body: "About a minute: an agency or a company, its name, what your files hold, and the agreements, accepted by someone who may accept them." },
  { title: "Upload and seal the files", body: "CSV or XLSX exports of customer records. Sealing fixes the set the check measures; nothing is changed in it." },
  { title: "Read what the check found", body: "Each finding with its count, what it is counted out of, examples and how a plan would fix it; then an estimate from the price list." },
];

export function FreeCheckPage(): ReactElement {
  return (
    <>
      <PageHead
        eyebrow={PUBLIC_COPY["health-check.title"]}
        accent={2}
        title="Check a file free, before you decide anything."
        lead="Kauro measures every row of the files you upload and shows what it finds: possible duplicates, values that are not valid, and what would block an import. The check is free and creates no obligation to buy."
        size="compact"
      />
      <Section id="free-check-steps" heading="What it takes" layout="split">
        <ol className="kauro-variant-steps">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="kauro-variant-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <p className="kauro-variant-step-title">{step.title}</p>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>
      <Section id="free-check-fit" heading="Is it for you?" layout="split" tone="sunken">
        <ul className="kauro-site-specs kauro-site-specs--plate">
          <li>For business use: an agency preparing its clients&apos; records, or a company preparing its own.</li>
          <li>Exports of customer records: contacts, companies, deals or similar. No passwords or keys, no full card numbers, no health data and no children&apos;s data.</li>
          <li>
            Up to {INPUT_LIMITS.files} files, {INPUT_LIMITS.fileSize} each, {INPUT_LIMITS.setSize} a set.
          </li>
          <li>An agency checking a client&apos;s or a prospect&apos;s files needs that business&apos;s documented authorisation and the data processing terms. Kauro never contacts your client.</li>
        </ul>
      </Section>
      <Section id="free-check-after" heading="What happens to your files" layout="split">
        <ul className="kauro-site-specs kauro-site-specs--plate">
          <li>No payment details are asked for the check. A price comes only as an estimate after it, and as a formal quote only if your team approves a plan.</li>
          <li>If you buy nothing, the files and the results are deleted 7 days after the check is ready, and never later than 14 days after the files were sealed.</li>
          <li>When the capacity for free checks is full, new checks wait, and the page you upload from says so.</li>
        </ul>
        <p className="kauro-site-muted">
          See a complete example first: <a href={ROUTE.sample}>{PUBLIC_COPY["nav.sample.label"]}</a>.
        </p>
      </Section>
      <Section id="free-check-start" heading="Start" layout="split" tone="wine" variant="kauro-site-band-compact kauro-site-band-grain">
        <p>Create an account to check a file, or sign in if your team already uses Kauro. A question first? Ask it: the answer comes in writing.</p>
        <div className="kauro-site-actions">
          <LinkButton href="/signup" primary>
            Create an account and check a file
          </LinkButton>
          <LinkButton href="/login" kind="secondary">
            {PUBLIC_COPY["nav.signin.label"]}
          </LinkButton>
          <LinkButton href="/__variants/contact" kind="text">
            Ask a question
          </LinkButton>
        </div>
      </Section>
    </>
  );
}

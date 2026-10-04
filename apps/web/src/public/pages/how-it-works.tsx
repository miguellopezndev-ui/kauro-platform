// UI02 How it works: six steps in one ordered list (A3 3.2: the check is free, bounded and never promised as immediate; approval and the quote
// are named; the import is the agency's own), then where the agency's responsibility starts.
import type { ReactElement } from "react";
import { PUBLIC_COPY } from "../../copy/public.ts";
import { LinkButton, PageHead, Section } from "../parts.tsx";
import { ROUTE } from "../site.ts";

const STEPS = [
  { heading: PUBLIC_COPY["how.step.upload.heading"], body: PUBLIC_COPY["how.step.upload.body"] },
  { heading: PUBLIC_COPY["how.step.check.heading"], body: PUBLIC_COPY["how.step.check.body"] },
  { heading: PUBLIC_COPY["how.step.decide.heading"], body: PUBLIC_COPY["how.step.decide.body"] },
  { heading: PUBLIC_COPY["how.step.purchase.heading"], body: PUBLIC_COPY["how.step.purchase.body"] },
  { heading: PUBLIC_COPY["how.step.prepare.heading"], body: PUBLIC_COPY["how.step.prepare.body"] },
  { heading: PUBLIC_COPY["how.step.import.heading"], body: PUBLIC_COPY["how.step.import.body"] },
] as const;

export function HowItWorksPage(): ReactElement {
  return (
    <>
      <PageHead title={PUBLIC_COPY["how.title"]} lead={PUBLIC_COPY["how.lead"]} />
      <Section id="how-steps" heading={PUBLIC_COPY["how.steps.heading"]}>
        <ol className="kauro-site-steps">
          {STEPS.map((step) => (
            <li key={step.heading}>
              <h3>{step.heading}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section id="how-responsibility" heading={PUBLIC_COPY["how.responsibility.heading"]}>
        <p>{PUBLIC_COPY["how.responsibility.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.services}>{PUBLIC_COPY["how.next.services.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

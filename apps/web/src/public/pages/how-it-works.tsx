// UI02 How it works: six steps in one ordered list (A3 3.2: the check is free, bounded and never promised as immediate; approval and the quote
// are named; the import is the team's own), then where the team's responsibility starts. Each step says who acts in it, so the page shows at
// a glance that the decisions and the import stay with the customer and the preparation is Kauro's.
import type { ReactElement } from "react";
import { PUBLIC_COPY, type PublicCopyId } from "../../copy/public.ts";
import { LinkButton, PageHead, Section } from "../parts.tsx";
import { ROUTE } from "../site.ts";

type Actor = "team" | "kauro";

const ACTOR_LABEL: Readonly<Record<Actor, PublicCopyId>> = { team: "how.actor.team.label", kauro: "how.actor.kauro.label" };

const STEPS: ReadonlyArray<{ readonly heading: PublicCopyId; readonly body: PublicCopyId; readonly actor: Actor }> = [
  { heading: "how.step.upload.heading", body: "how.step.upload.body", actor: "team" },
  { heading: "how.step.check.heading", body: "how.step.check.body", actor: "kauro" },
  { heading: "how.step.decide.heading", body: "how.step.decide.body", actor: "team" },
  { heading: "how.step.purchase.heading", body: "how.step.purchase.body", actor: "team" },
  { heading: "how.step.prepare.heading", body: "how.step.prepare.body", actor: "kauro" },
  { heading: "how.step.import.heading", body: "how.step.import.body", actor: "team" },
];

export function HowItWorksPage(): ReactElement {
  return (
    <>
      <PageHead
        eyebrow={PUBLIC_COPY["nav.how.label"]}
        title={PUBLIC_COPY["how.title"]}
        accent={3}
        lead={PUBLIC_COPY["how.lead"]}
        aside={
          <p className="kauro-site-bignum" aria-hidden="true">
            {String(STEPS.length).padStart(2, "0")}
          </p>
        }
      />
      <Section
        id="how-steps"
        heading={PUBLIC_COPY["how.steps.heading"]}
        layout="split"
        variant="kauro-site-how-steps"
        headExtra={
          <ul className="kauro-site-legend" aria-hidden="true">
            <li className="kauro-site-legend-item kauro-site-legend-item--team">{PUBLIC_COPY["how.actor.team.label"]}</li>
            <li className="kauro-site-legend-item kauro-site-legend-item--kauro">{PUBLIC_COPY["how.actor.kauro.label"]}</li>
          </ul>
        }
      >
        <ol className="kauro-site-timeline">
          {STEPS.map((step) => (
            <li key={step.heading} className={`kauro-site-timeline-step kauro-site-timeline-step--${step.actor}`}>
              <p className="kauro-site-actor">{PUBLIC_COPY[ACTOR_LABEL[step.actor]]}</p>
              <h3>{PUBLIC_COPY[step.heading]}</h3>
              <p>{PUBLIC_COPY[step.body]}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section id="how-responsibility" heading={PUBLIC_COPY["how.responsibility.heading"]} layout="split" tone="clay">
        <p className="kauro-site-statement">{PUBLIC_COPY["how.responsibility.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.services}>{PUBLIC_COPY["how.next.services.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

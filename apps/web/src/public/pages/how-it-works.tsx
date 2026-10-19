// UI02 How it works: six steps in one ordered list (A3 3.2: the check is free, bounded and never promised as immediate; approval and the quote
// are named; the import is the team's own), then where the team's responsibility starts. The head is wine and carries a card of who acts at
// each step, so the page shows at a glance that the decisions and the import stay with the customer and the preparation is Kauro's (A10
// §8). Each step sits beside a fragment of the product as it looks at that step (artifacts.tsx), from the synthetic sample and the policy; on a
// wide screen the fragments become one window that is brought up to date as the reader walks down the steps (how-flow.tsx).
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type PublicCopyId } from "../../copy/public.ts";
import { Approval, Counts, FileChips, ImportOrder, MarginNote, Pane, Reconcile } from "../artifacts.tsx";
import { HowFlow } from "../how-flow.tsx";
import { LinkButton, PageHead, PriceFigure, Section } from "../parts.tsx";
import { formatUsd, startingPrice } from "../pricing-bands.ts";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_SOURCES } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

type Actor = "team" | "kauro";
type StepKey = "upload" | "check" | "decide" | "purchase" | "prepare" | "import";

const ACTOR_LABEL: Readonly<Record<Actor, PublicCopyId>> = { team: "how.actor.team.label", kauro: "how.actor.kauro.label" };

const STEPS: ReadonlyArray<{ readonly key: StepKey; readonly heading: PublicCopyId; readonly body: PublicCopyId; readonly actor: Actor }> = [
  { key: "upload", heading: "how.step.upload.heading", body: "how.step.upload.body", actor: "team" },
  { key: "check", heading: "how.step.check.heading", body: "how.step.check.body", actor: "kauro" },
  { key: "decide", heading: "how.step.decide.heading", body: "how.step.decide.body", actor: "team" },
  { key: "purchase", heading: "how.step.purchase.heading", body: "how.step.purchase.body", actor: "team" },
  { key: "prepare", heading: "how.step.prepare.heading", body: "how.step.prepare.body", actor: "kauro" },
  { key: "import", heading: "how.step.import.heading", body: "how.step.import.body", actor: "team" },
];

const countOf = (label: PublicCopyId): number => REPORT_ROWS.find((row) => row.label === label)?.count ?? 0;

/** The product at one step. */
function StepPane({ step }: { readonly step: StepKey }): ReactElement | null {
  const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  if (contacts === undefined) return null;
  switch (step) {
    case "upload":
      return (
        <Pane>
          <FileChips files={SAMPLE_SOURCES} state={PUBLIC_COPY["how.frag.sealed"]} />
        </Pane>
      );
    case "check":
      return (
        <Pane>
          <Counts
            rows={[
              { value: countOf("sample.report.duplicates"), label: PUBLIC_COPY["home.frag.candidates"] },
              { value: countOf("sample.report.emails"), label: PUBLIC_COPY["home.frag.invalid"] },
            ]}
          />
        </Pane>
      );
    case "decide":
      return (
        <>
          <Pane>
            <Approval count={2} />
          </Pane>
          <MarginNote>{PUBLIC_COPY["how.note.enter"]}</MarginNote>
        </>
      );
    case "purchase":
      return (
        <Pane title={PUBLIC_COPY["how.frag.quote"]} variant="kauro-site-frag--quote">
          <PriceFigure amount={formatUsd(startingPrice("CLEAN"))} />
          <span className="kauro-site-frag-label">{copy("how.frag.valid", { days: POLICY_SNAPSHOT.quoteDays })}</span>
        </Pane>
      );
    case "prepare":
      return (
        <Pane>
          <Reconcile from={contacts.source} to={contacts.rows} label={PUBLIC_COPY["home.app.phase.prepare.body"]} />
        </Pane>
      );
    case "import":
      return (
        <Pane title={PUBLIC_COPY["home.frag.order"]}>
          <ImportOrder files={[...MANIFEST_FILES.map((file) => file.name).reverse(), PUBLIC_COPY["home.frag.links"]]} />
        </Pane>
      );
  }
}

/** Who acts at each step, as one card beside the heading: the team on one side, Kauro on the other. */
function WhoActs(): ReactElement {
  const column = (actor: Actor): ReactElement => (
    <div className={`kauro-acts-column kauro-acts-column--${actor}`}>
      <p className="kauro-acts-actor">{PUBLIC_COPY[ACTOR_LABEL[actor]]}</p>
      <ul>
        {STEPS.map((step, index) =>
          step.actor === actor ? (
            <li key={step.key}>
              <span className="kauro-acts-number">{String(index + 1).padStart(2, "0")}</span>
              {PUBLIC_COPY[step.heading]}
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
  return (
    <div className="kauro-acts kauro-paper" aria-hidden="true">
      <p className="kauro-acts-bar">
        <span className="kauro-acts-brand">{PUBLIC_COPY["site.name"]}</span>
        <span className="kauro-acts-title">{PUBLIC_COPY["how.acts.label"]}</span>
      </p>
      <div className="kauro-acts-columns">
        {column("team")}
        {column("kauro")}
      </div>
    </div>
  );
}

export function HowItWorksPage(): ReactElement {
  return (
    <>
      <PageHead eyebrow={PUBLIC_COPY["nav.how.label"]} title={PUBLIC_COPY["how.title"]} accent={3} lead={PUBLIC_COPY["how.lead"]} tone="wine" size="compact" variant="kauro-site-head-how" aside={<WhoActs />} />
      <Section
        id="how-steps"
        heading={PUBLIC_COPY["how.steps.heading"]}
        variant="kauro-site-how-steps"
        headExtra={
          <ul className="kauro-site-legend" aria-hidden="true">
            <li className="kauro-site-legend-item kauro-site-legend-item--team">{PUBLIC_COPY["how.actor.team.label"]}</li>
            <li className="kauro-site-legend-item kauro-site-legend-item--kauro">{PUBLIC_COPY["how.actor.kauro.label"]}</li>
          </ul>
        }
      >
        <HowFlow
          brand={PUBLIC_COPY["site.name"]}
          project={PUBLIC_COPY["home.app.project.name"]}
          steps={STEPS.map((step) => ({
            key: step.key,
            actor: step.actor,
            actorLabel: PUBLIC_COPY[ACTOR_LABEL[step.actor]],
            heading: PUBLIC_COPY[step.heading],
            body: PUBLIC_COPY[step.body],
            pane: <StepPane step={step.key} />,
          }))}
        />
      </Section>
      <Section id="how-responsibility" heading={PUBLIC_COPY["how.responsibility.heading"]} layout="split" tone="inverse" variant="kauro-site-band-grain">
        <p className="kauro-site-statement">{PUBLIC_COPY["how.responsibility.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.services}>{PUBLIC_COPY["how.next.services.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

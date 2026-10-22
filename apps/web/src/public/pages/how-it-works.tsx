// UI02 How it works: the buyer's guide to a project. Home shows the process as a film; this page is the reference behind it, so it plays
// nothing. A3 3.2: the check is free, bounded and never promised as immediate, and the call to action leads to the fit form. A3 3.6: no fixed
// duration. UI02's exceptions: nothing here implies that software approves or that Kauro writes to a production CRM. The destinations are
// named only by the capability publication (Supported services), so a stage says "a destination Kauro qualifies"; the example names its
// invented service. Every figure comes from the policy snapshot, the input limits or the sample.
//
// Order 11 round 2: a process page is understood before it reassures (eight of ten process pages in the round-2 sample use short numbered
// steps). Owner's section review (2026-10-21): the six stages are one section, not an overview followed by six sheets. They are a timeline
// that runs down (StagePath); choosing a stage opens what happens, what you get and what stops it, beside the timeline on a wide screen and
// under the stage on a narrow one. Who acts, what it needs and what happens at each stage sit once, folded, above the call to action
// that closes the section. The invented project is not retold here (Home and Sample delivery show it): the stage of the quote says the
// price counts the units sealed and leads to Pricing, and the stage of the delivery leads to the sample. What Kauro does not do is not a
// section of its own here (Home has it, and no process page in the round-3 sample has one): the stages say who acts at each step, and the
// closing band says what stays with your team.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type CopyValues, type PublicCopyId } from "../../copy/public.ts";
import { INPUT_LIMITS } from "../limits.ts";
import { formatCount } from "../pricing-bands.ts";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";
import { Block, CHECK_CTA, Closing, Head } from "../r2.tsx";
import { ROUTE } from "../site.ts";
import { StagePath, type PathStage } from "../stage-path.tsx";

type Actor = "team" | "kauro";
type StageKey = "files" | "check" | "decide" | "quote" | "prepare" | "import";
type Field = "who" | "needs" | "happens" | "gets" | "stops";

/** A line of a field: a message, or a message with the figures it states. */
type Line = PublicCopyId | { readonly id: PublicCopyId; readonly values: CopyValues };

interface Stage {
  readonly key: StageKey;
  readonly actor: Actor;
  readonly heading: PublicCopyId;
  readonly summary: PublicCopyId;
  readonly who: PublicCopyId;
  readonly needs: readonly Line[];
  readonly happens: readonly Line[];
  readonly gets: readonly Line[];
  readonly stops: readonly Line[];
  /** Where the card leads for more, at its foot. */
  readonly link?: { readonly href: string; readonly label: PublicCopyId };
}

const ACTOR_LABEL: Readonly<Record<Actor, PublicCopyId>> = { team: "how.actor.team.label", kauro: "how.actor.kauro.label" };
const FIELD_LABEL: Readonly<Record<Field, PublicCopyId>> = {
  who: "how.field.who",
  needs: "how.field.needs",
  happens: "how.field.happens",
  gets: "how.field.gets",
  stops: "how.field.stops",
};

const LIMITS: CopyValues = { files: INPUT_LIMITS.files, fileSize: INPUT_LIMITS.fileSize, setSize: INPUT_LIMITS.setSize, columns: INPUT_LIMITS.columns, units: INPUT_LIMITS.units };

const STAGES: readonly Stage[] = [
  {
    key: "files",
    actor: "team",
    heading: "how.stage.files.heading",
    summary: "how.stage.files.summary",
    who: "how.stage.files.who",
    needs: ["how.stage.files.needs.account", "how.stage.files.needs.exports", { id: "help.files.limits", values: LIMITS }, "how.stage.files.needs.right", "how.stage.files.needs.target"],
    happens: ["how.stage.files.happens.read", "how.stage.files.happens.inspect", "how.stage.files.happens.choose", "how.stage.files.happens.seal"],
    gets: ["how.stage.files.gets.count", "how.stage.files.gets.scope"],
    stops: ["how.stage.files.stops.format", "help.files.large", "how.stage.files.stops.excluded", "how.stage.files.stops.change"],
  },
  {
    key: "check",
    actor: "kauro",
    heading: "how.stage.check.heading",
    summary: "how.stage.check.summary",
    who: "how.stage.check.who",
    needs: ["how.stage.check.needs.sealed"],
    happens: ["how.stage.check.happens.measure", "how.stage.check.happens.propose", "how.stage.check.happens.signal"],
    gets: ["how.stage.check.gets.result", "how.stage.check.gets.apart"],
    stops: ["how.stage.check.stops.bounded", "how.stage.check.stops.budget", "how.stage.check.stops.scope"],
  },
  {
    key: "decide",
    actor: "team",
    heading: "how.stage.decide.heading",
    summary: "how.stage.decide.summary",
    who: "how.stage.decide.who",
    needs: ["how.stage.decide.needs.result", "how.stage.decide.needs.person"],
    happens: ["how.stage.decide.happens.propose", "how.stage.decide.happens.choose", "how.stage.decide.happens.validate", "how.stage.decide.happens.explicit"],
    gets: ["how.stage.decide.gets.plan"],
    stops: ["how.stage.decide.stops.open", "how.stage.decide.stops.changed", "how.stage.decide.stops.withdrawn"],
  },
  {
    key: "quote",
    actor: "team",
    heading: "how.stage.quote.heading",
    summary: "how.stage.quote.summary",
    who: "how.stage.quote.who",
    needs: ["how.stage.quote.needs.plan", "how.stage.quote.needs.units"],
    happens: [
      "how.stage.quote.happens.band",
      "how.stage.quote.happens.counted",
      "how.stage.quote.happens.lines",
      { id: "how.stage.quote.happens.valid", values: { days: POLICY_SNAPSHOT.quoteDays } },
      "how.stage.quote.happens.binding",
      "how.stage.quote.happens.paid",
    ],
    gets: ["how.stage.quote.gets.order"],
    stops: [
      "how.stage.quote.stops.expired",
      "how.stage.quote.stops.scope",
      "how.stage.quote.stops.tax",
      { id: "pricing.estimate.not-offered", values: { units: formatCount(POLICY_SNAPSHOT.launchSourceUnits) } },
    ],
    link: { href: ROUTE.pricing, label: "how.stage.quote.link" },
  },
  {
    key: "prepare",
    actor: "kauro",
    heading: "how.stage.prepare.heading",
    summary: "how.stage.prepare.summary",
    who: "how.stage.prepare.who",
    needs: ["how.stage.prepare.needs.paid"],
    happens: ["how.stage.prepare.happens.apply", "how.stage.prepare.happens.readback", "how.stage.prepare.happens.recompute", "how.stage.prepare.happens.follow"],
    gets: ["how.stage.prepare.gets.package"],
    stops: ["how.stage.prepare.stops.check", "how.stage.prepare.stops.authority"],
  },
  {
    key: "import",
    actor: "team",
    heading: "how.stage.import.heading",
    summary: "how.stage.import.summary",
    who: "how.stage.import.who",
    needs: ["how.stage.import.needs.account", "how.stage.import.needs.setup"],
    happens: ["how.stage.import.happens.order", "how.stage.import.happens.stages", "how.stage.import.happens.kept"],
    gets: ["how.stage.import.gets.package", "how.stage.import.gets.report", "how.stage.import.gets.instructions"],
    stops: ["how.stage.import.stops.receipt", "how.stage.import.stops.removed"],
    link: { href: ROUTE.sample, label: "services.sample.cta" },
  },
];

const textOf = (line: Line): string => (typeof line === "string" ? PUBLIC_COPY[line] : copy(line.id, line.values));
const keyOf = (line: Line): string => (typeof line === "string" ? line : line.id);
const numberOf = (index: number): string => String(index + 1).padStart(2, "0");

/** What each stage leaves your team with, in a few words: the overview's line under each stage. */
const OUTCOME: Readonly<Record<StageKey, PublicCopyId>> = {
  files: "how.stage.files.outcome",
  check: "how.stage.check.outcome",
  decide: "how.stage.decide.outcome",
  quote: "how.stage.quote.outcome",
  prepare: "how.stage.prepare.outcome",
  import: "how.stage.import.outcome",
};

function Lines({ lines }: { readonly lines: readonly Line[] }): ReactElement {
  return (
    <ul>
      {lines.map((line) => (
        <li key={keyOf(line)}>{textOf(line)}</li>
      ))}
    </ul>
  );
}

/**
 * The body of one stage, shown when the stage is chosen: the summary, then what you get and what stops it, always in view (a stop is a
 * disclosure a buyer must not have to open). Who acts, what it needs and what happens are the same three questions for every stage, so
 * they are answered once for all six under the stages (StageDetails), not inside each card.
 */
function StageSheet({ stage }: { readonly stage: Stage }): ReactElement {
  return (
    <article className="kauro-stage-sheet" aria-label={PUBLIC_COPY[stage.heading]}>
      <p className="kauro-r2-stage-summary">{PUBLIC_COPY[stage.summary]}</p>
      <dl className="kauro-r2-stage-keys">
        <div className="kauro-r2-stage-gets">
          <dt>{PUBLIC_COPY[FIELD_LABEL.gets]}</dt>
          <dd>
            <Lines lines={stage.gets} />
          </dd>
        </div>
        <div className="kauro-r2-stage-stops">
          <dt>{PUBLIC_COPY[FIELD_LABEL.stops]}</dt>
          <dd>
            <Lines lines={stage.stops} />
          </dd>
        </div>
      </dl>
      {stage.link === undefined ? null : (
        <a className="kauro-site-arrow kauro-r2-stage-link" href={stage.link.href}>
          {PUBLIC_COPY[stage.link.label]}
        </a>
      )}
    </article>
  );
}

/**
 * Who acts, what it needs and what happens at each stage: the detail a buyer reads once, for all six stages in order, folded under one
 * control above the call to action. On a wide screen each stage's name sits in the timeline's column and its answers beside it.
 */
function StageDetails(): ReactElement {
  return (
    <details className="kauro-path-details">
      <summary>{PUBLIC_COPY["how.details.summary"]}</summary>
      <ol className="kauro-path-details-list">
        {STAGES.map((stage, index) => (
          <li key={stage.key}>
            <h3 className="kauro-path-details-name">
              <span className="kauro-path-details-number" aria-hidden="true">
                {numberOf(index)}
              </span>
              {PUBLIC_COPY[stage.heading]}
            </h3>
            <dl className="kauro-r2-stage-detail">
              <div>
                <dt>{PUBLIC_COPY[FIELD_LABEL.who]}</dt>
                <dd>
                  <p>{PUBLIC_COPY[stage.who]}</p>
                </dd>
              </div>
              <div>
                <dt>{PUBLIC_COPY[FIELD_LABEL.needs]}</dt>
                <dd>
                  <Lines lines={stage.needs} />
                </dd>
              </div>
              <div>
                <dt>{PUBLIC_COPY[FIELD_LABEL.happens]}</dt>
                <dd>
                  <Lines lines={stage.happens} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </details>
  );
}

const PATH: readonly PathStage[] = STAGES.map((stage, index) => ({
  key: stage.key,
  number: numberOf(index),
  name: PUBLIC_COPY[stage.heading],
  actor: stage.actor,
  actorLabel: PUBLIC_COPY[ACTOR_LABEL[stage.actor]],
  outcome: PUBLIC_COPY[OUTCOME[stage.key]],
  sheet: <StageSheet stage={stage} />,
}));

/**
 * The closing band's object: a handover slip on the brand's rock, stamped "Prepared for import". It shows where Kauro's part ends and your
 * team's begins, in the stages' own actor labels. Decorative: the band's sentence says the same in words, so the slip is hidden from
 * assistive technology.
 */
function Handover(): ReactElement {
  const lines = [
    { key: "prepared", label: "how.handover.prepared", actor: "kauro" },
    { key: "decisions", label: "how.handover.decisions", actor: "team" },
    { key: "import", label: "how.handover.import", actor: "team" },
  ] as const satisfies ReadonlyArray<{ readonly key: string; readonly label: PublicCopyId; readonly actor: Actor }>;
  return (
    <div className="kauro-handover-rock" aria-hidden="true">
      <div className="kauro-handover">
        <span className="kauro-handover-brand">{PUBLIC_COPY["site.name"]}</span>
        <span className="kauro-handover-title">{PUBLIC_COPY["how.handover.title"]}</span>
        <ul>
          {lines.map((line) => (
            <li key={line.key}>
              <span>{PUBLIC_COPY[line.label]}</span>
              <span className={`kauro-r2-actor kauro-r2-actor--${line.actor}`}>{PUBLIC_COPY[ACTOR_LABEL[line.actor]]}</span>
            </li>
          ))}
        </ul>
        <span className="kauro-handover-stamp">{PUBLIC_COPY["how.handover.stamp"]}</span>
      </div>
    </div>
  );
}

export function HowItWorksPage(): ReactElement {
  return (
    <>
      <Head kind="path" accent={3} eyebrow={PUBLIC_COPY["nav.how.label"]} title={PUBLIC_COPY["how.title"]} lead={PUBLIC_COPY["how.lead"]} />
      <Block id="how-stages" heading={PUBLIC_COPY["how.stages.heading"]} lead={PUBLIC_COPY["how.stages.lead"]} tone="sunken">
        <StagePath stages={PATH} />
        <StageDetails />
        <div className="kauro-r2-inline-cta kauro-path-cta">
          <a className="kauro-site-button kauro-site-button--primary" href={ROUTE.contact}>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </a>
          <p className="kauro-r2-hint">{PUBLIC_COPY["pricing.answer.free"]}</p>
        </div>
      </Block>
      <Closing
        id="how-responsibility"
        heading={PUBLIC_COPY["how.responsibility.heading"]}
        body={PUBLIC_COPY["how.responsibility.body"]}
        primary={CHECK_CTA}
        links={[
          { href: ROUTE.services, label: PUBLIC_COPY["how.next.services.cta"] },
          { href: ROUTE.sample, label: PUBLIC_COPY["services.sample.cta"] },
        ]}
        art={<Handover />}
      />
    </>
  );
}

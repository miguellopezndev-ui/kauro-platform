// UI02 How it works: the buyer's guide to a project. Home shows the process as a film; this page is the reference behind it, so it plays
// nothing. A3 3.2: the check is free, bounded and never promised as immediate, and the call to action leads to the fit form. A3 3.6: no fixed
// duration. UI02's exceptions: nothing here implies that software approves or that Kauro writes to a production CRM. The destinations are
// named only by the capability publication (Supported services), so a stage says "a destination Kauro qualifies"; the example names its
// invented service. Every figure comes from the policy snapshot, the input limits or the sample.
//
// Order 11 round 2: a process page is understood before it reassures (eight of ten process pages in the round-2 sample use short numbered
// steps). Owner's section review (2026-10-21): the six stages are one section, not an overview followed by six sheets. They are a timeline
// that runs down (StagePath); choosing a stage opens what happens, what you get and what stops it, beside the timeline on a wide screen and
// under the stage on a narrow one, and the call to action closes the section. The rest of a stage's detail (who acts, what it needs, what
// happens step by step) stays folded under one control inside it. The duplicate counts moved to Sample delivery, beside the report they belong to; the example keeps the price, with its counting
// rule and the line saying it is invented directly under it.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type CopyValues, type PublicCopyId } from "../../copy/public.ts";
import { INPUT_LIMITS } from "../limits.ts";
import { modeName } from "../estimate-text.ts";
import { DataTable } from "../parts.tsx";
import { bandIndexOf, bandLabel, formatCount, formatUsd, priceOf } from "../pricing-bands.ts";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";
import { Block, CHECK_CTA, Closing, Head } from "../r2.tsx";
import { MANIFEST_FILES, SAMPLE, SAMPLE_MODE } from "../sample-data.ts";
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

/** The worked example: from the billable source units of the invented project to its price, with the counting rule right under it. */
function Example(): ReactElement | null {
  const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
  if (contacts === undefined || companies === undefined) return null;
  const units = contacts.source + companies.source;
  const band = bandIndexOf(units);
  if (band === null) return null;
  const n = formatCount;
  return (
    <div className="kauro-r2-example">
      <DataTable
        caption={PUBLIC_COPY["how.example.price.caption"]}
        columns={[PUBLIC_COPY["how.example.price.line"], PUBLIC_COPY["how.example.counts.figure"]]}
        variant="kauro-r2-compact-table kauro-r2-ledger"
        stack={false}
        rows={[
          { key: "contacts", head: PUBLIC_COPY["how.example.price.contacts"], cells: [n(contacts.source)] },
          { key: "companies", head: PUBLIC_COPY["how.example.price.companies"], cells: [n(companies.source)] },
          { key: "units", head: PUBLIC_COPY["how.example.price.units"], cells: [n(units)] },
          { key: "band", head: PUBLIC_COPY["how.example.price.band"], cells: [bandLabel(band)] },
          { key: "mode", head: PUBLIC_COPY["how.example.price.mode"], cells: [modeName(SAMPLE_MODE)] },
          { key: "total", head: PUBLIC_COPY["how.example.price.total"], cells: [formatUsd(priceOf(band, SAMPLE_MODE))] },
        ]}
      />
      <div className="kauro-r2-example-notes">
        <p>{copy("how.example.price.note", { units: n(units), output: n(contacts.rows + companies.rows) })}</p>
        <p className="kauro-r2-example-synthetic">{PUBLIC_COPY["how.example.synthetic"]}</p>
        <a className="kauro-site-arrow" href={ROUTE.sample}>
          {PUBLIC_COPY["how.example.duplicates.cta"]}
        </a>
      </div>
    </div>
  );
}

const NEVER = [
  { key: "live", name: "home.limits.live.name", body: "home.limits.live" },
  { key: "import", name: "home.limits.import.name", body: "home.limits.import" },
  { key: "decide", name: "home.limits.decide.name", body: "home.limits.decide" },
] as const satisfies ReadonlyArray<{ readonly key: string; readonly name: PublicCopyId; readonly body: PublicCopyId }>;

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
      <Block id="how-example" heading={PUBLIC_COPY["how.example.heading"]} lead={copy("how.example.lead", { mode: modeName(SAMPLE_MODE) })} layout="split">
        <Example />
      </Block>
      <Block id="how-never" heading={PUBLIC_COPY["home.limits.heading"]} lead={PUBLIC_COPY["home.limits.lead"]} tone="sunken">
        <ul className="kauro-r2-never">
          {NEVER.map((item) => (
            <li key={item.key}>
              <h3>{PUBLIC_COPY[item.name]}</h3>
              <p>{PUBLIC_COPY[item.body]}</p>
            </li>
          ))}
        </ul>
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
      />
    </>
  );
}

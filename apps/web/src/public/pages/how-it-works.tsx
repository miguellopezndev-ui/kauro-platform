// UI02 How it works: the buyer's operational guide to a project (Order 10, the owner's final decision). Home shows the process as a film;
// this page is the reference behind it, so it plays nothing. The head is wine and carries the card of who acts at each stage (A10 §8: the
// decisions and the import stay with the customer, the preparation is Kauro's). Then six stages in one ordered list, each with the same five
// fields (who acts, what it needs, what happens, what you get, what stops it), an index beside them on a wide screen as in Help, and a worked
// example on the synthetic sample that keeps apart the three counts a reader confuses (candidate groups, approved unifications, unified
// rows) and shows the price from the billable source units. Every figure comes from the policy snapshot, the input limits or the sample.
//
// A3 3.2: the check is free, bounded and never promised as immediate, and the call to action leads to the fit form. A3 3.6: no fixed
// duration. UI02's exceptions: nothing here implies that software approves or that Kauro writes to a production CRM.
import type { ReactElement } from "react";
import { PUBLIC_COPY, copy, type CopyValues, type PublicCopyId } from "../../copy/public.ts";
import { INPUT_LIMITS } from "../limits.ts";
import { DataTable, LinkButton, PageHead, Section } from "../parts.tsx";
import { bandIndexOf, bandLabel, formatCount, formatUsd, priceOf } from "../pricing-bands.ts";
import { POLICY_SNAPSHOT } from "../policy-snapshot.ts";
import { MANIFEST_FILES, SAMPLE, SAMPLE_GROUPS, SAMPLE_MODE } from "../sample-data.ts";
import { ROUTE } from "../site.ts";

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
const LIST_FIELDS = ["needs", "happens", "gets", "stops"] as const;

const LIMITS: CopyValues = { files: INPUT_LIMITS.files, fileSize: INPUT_LIMITS.fileSize, setSize: INPUT_LIMITS.setSize, columns: INPUT_LIMITS.columns, units: INPUT_LIMITS.units };

const STAGES: readonly Stage[] = [
  {
    key: "files",
    actor: "team",
    heading: "how.stage.files.heading",
    summary: "how.stage.files.summary",
    who: "how.stage.files.who",
    needs: ["how.stage.files.needs.exports", { id: "help.files.limits", values: LIMITS }, "how.stage.files.needs.right", "how.stage.files.needs.target"],
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
    needs: ["how.stage.check.needs.sealed", "how.stage.check.needs.one"],
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

/** Who acts at each stage, as one card beside the heading: the team on one side, Kauro on the other. */
function WhoActs(): ReactElement {
  const column = (actor: Actor): ReactElement => (
    <div className={`kauro-acts-column kauro-acts-column--${actor}`}>
      <p className="kauro-acts-actor">{PUBLIC_COPY[ACTOR_LABEL[actor]]}</p>
      <ul>
        {STAGES.map((stage, index) =>
          stage.actor === actor ? (
            <li key={stage.key}>
              <span className="kauro-acts-number">{numberOf(index)}</span>
              {PUBLIC_COPY[stage.heading]}
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

/** One stage: its number, heading and actor, a summary, then the five fields in the same order on every stage. */
function StageSheet({ stage, index }: { readonly stage: Stage; readonly index: number }): ReactElement {
  const headingId = `stage-${stage.key}-heading`;
  return (
    <li id={`stage-${stage.key}`} className={`kauro-stage kauro-stage--${stage.actor}`}>
      <article className="kauro-stage-sheet" aria-labelledby={headingId}>
        <header className="kauro-stage-head">
          <span className="kauro-stage-number" aria-hidden="true">
            {numberOf(index)}
          </span>
          <h3 id={headingId}>{PUBLIC_COPY[stage.heading]}</h3>
          <p className="kauro-stage-actor">{PUBLIC_COPY[ACTOR_LABEL[stage.actor]]}</p>
        </header>
        <p className="kauro-stage-summary">{PUBLIC_COPY[stage.summary]}</p>
        <dl className="kauro-stage-fields">
          <div className="kauro-stage-field kauro-stage-field--who">
            <dt>{PUBLIC_COPY[FIELD_LABEL.who]}</dt>
            <dd>
              <p>{PUBLIC_COPY[stage.who]}</p>
            </dd>
          </div>
          {LIST_FIELDS.map((field) => (
            <div key={field} className={`kauro-stage-field kauro-stage-field--${field}`}>
              <dt>{PUBLIC_COPY[FIELD_LABEL[field]]}</dt>
              <dd>
                <ul>
                  {stage[field].map((line) => (
                    <li key={keyOf(line)}>{textOf(line)}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      </article>
    </li>
  );
}

/** The worked example: the three duplicate counts kept apart, then the price from the billable source units. */
function Example(): ReactElement | null {
  const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
  const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
  if (contacts === undefined || companies === undefined) return null;
  const { pairs, triples, pairsKeptApart } = SAMPLE_GROUPS;
  const groups = pairs + triples;
  const units = contacts.source + companies.source;
  const band = bandIndexOf(units);
  if (band === null) return null;
  const n = formatCount;
  return (
    <div className="kauro-how-example">
      <DataTable
        caption={PUBLIC_COPY["how.example.counts.caption"]}
        columns={[PUBLIC_COPY["how.example.counts.what"], PUBLIC_COPY["how.example.counts.figure"], PUBLIC_COPY["how.example.counts.meaning"]]}
        stack
        variant="kauro-how-ledger"
        rows={[
          {
            key: "groups",
            head: PUBLIC_COPY["how.example.groups.label"],
            cells: [copy("how.example.groups.value", { count: n(groups), contacts: n(pairs * 2 + triples * 3) }), PUBLIC_COPY["how.example.groups.meaning"]],
          },
          {
            key: "approved",
            head: PUBLIC_COPY["how.example.approved.label"],
            cells: [copy("how.example.approved.value", { count: n(groups - pairsKeptApart), max: n(groups) }), copy("how.example.approved.meaning", { kept: n(pairsKeptApart) })],
          },
          {
            key: "unified",
            head: PUBLIC_COPY["how.example.unified.label"],
            cells: [n(contacts.unified), copy("how.example.unified.meaning", { source: n(contacts.source), output: n(contacts.rows) })],
          },
          {
            key: "companies",
            head: PUBLIC_COPY["how.example.companies.label"],
            cells: [n(companies.unified), copy("how.example.companies.meaning", { source: n(companies.source), output: n(companies.rows) })],
          },
        ]}
      />
      <DataTable
        caption={PUBLIC_COPY["how.example.price.caption"]}
        columns={[PUBLIC_COPY["how.example.price.line"], PUBLIC_COPY["how.example.counts.figure"]]}
        variant="kauro-how-ledger kauro-how-ledger--price"
        rows={[
          { key: "contacts", head: PUBLIC_COPY["how.example.price.contacts"], cells: [n(contacts.source)] },
          { key: "companies", head: PUBLIC_COPY["how.example.price.companies"], cells: [n(companies.source)] },
          { key: "units", head: PUBLIC_COPY["how.example.price.units"], cells: [n(units)] },
          { key: "band", head: PUBLIC_COPY["how.example.price.band"], cells: [bandLabel(band)] },
          { key: "mode", head: PUBLIC_COPY["how.example.price.mode"], cells: [PUBLIC_COPY["services.hubspot.name"]] },
          { key: "total", head: PUBLIC_COPY["how.example.price.total"], cells: [formatUsd(priceOf(band, SAMPLE_MODE))] },
        ]}
      />
      <p className="kauro-how-example-note">{copy("how.example.price.note", { units: n(units), output: n(contacts.rows + companies.rows) })}</p>
      <p className="kauro-site-meta">{PUBLIC_COPY["how.example.synthetic"]}</p>
    </div>
  );
}

export function HowItWorksPage(): ReactElement {
  return (
    <>
      <PageHead eyebrow={PUBLIC_COPY["nav.how.label"]} title={PUBLIC_COPY["how.title"]} accent={3} lead={PUBLIC_COPY["how.lead"]} tone="wine" size="compact" variant="kauro-site-head-how" aside={<WhoActs />} />
      <section id="how-steps" className="kauro-site-docs kauro-how-guide" aria-labelledby="how-steps-heading">
        <div className="kauro-site-wrap kauro-site-docs-inner">
          <nav className="kauro-site-toc kauro-how-toc" aria-label={PUBLIC_COPY["how.index.label"]}>
            <p className="kauro-site-toc-title" aria-hidden="true">
              {PUBLIC_COPY["how.index.label"]}
            </p>
            <ul>
              {STAGES.map((stage, index) => (
                <li key={stage.key} className={`kauro-how-toc-item--${stage.actor}`}>
                  <a href={`#stage-${stage.key}`}>
                    <span className="kauro-how-toc-number">{numberOf(index)}</span>
                    {PUBLIC_COPY[stage.heading]}
                  </a>
                </li>
              ))}
            </ul>
            <ul className="kauro-site-legend" aria-hidden="true">
              <li className="kauro-site-legend-item kauro-site-legend-item--team">{PUBLIC_COPY["how.actor.team.label"]}</li>
              <li className="kauro-site-legend-item kauro-site-legend-item--kauro">{PUBLIC_COPY["how.actor.kauro.label"]}</li>
            </ul>
          </nav>
          <div className="kauro-how-stages">
            <h2 id="how-steps-heading">{PUBLIC_COPY["how.steps.heading"]}</h2>
            <p className="kauro-site-guide-summary">{PUBLIC_COPY["how.steps.lead"]}</p>
            <ol className="kauro-stage-list">
              {STAGES.map((stage, index) => (
                <StageSheet key={stage.key} stage={stage} index={index} />
              ))}
            </ol>
          </div>
        </div>
      </section>
      <Section id="how-example" heading={PUBLIC_COPY["how.example.heading"]} lead={PUBLIC_COPY["how.example.lead"]} tone="sunken" variant="kauro-how-example-band">
        <Example />
      </Section>
      <Section id="how-responsibility" heading={PUBLIC_COPY["how.responsibility.heading"]} layout="split" tone="inverse" variant="kauro-site-band-grain">
        <p className="kauro-site-statement">{PUBLIC_COPY["how.responsibility.body"]}</p>
        <div className="kauro-site-actions">
          <LinkButton href={ROUTE.contact} primary>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </LinkButton>
          <LinkButton href={ROUTE.services}>{PUBLIC_COPY["how.next.services.cta"]}</LinkButton>
        </div>
      </Section>
    </>
  );
}

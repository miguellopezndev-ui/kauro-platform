"use client";
// P-07 Health check results (proposed, beside UI18; Order 11 round 2, research agency-workspace.md §3.3 and §5.7). The moment of truth: what
// the free check found in this data, what it means in the destination, and what deciding involves; the price comes after the findings.
//   1. The verdict as the page's sentence ("Your files can go into HubSpot once four things are settled"), then one summary line in words,
//      never a row of plates.
//   2. The findings, ordered by severity (Blocks import, Would import badly, For your decision: a word and an icon, never colour alone),
//      then by count. Every figure is one size and carries its denominator on its own line ("1,137 of 12,480 contacts · 9.1%"); a finding
//      about settings says its count in its sentence, never as a figure beside contact counts. Each has three examples, what happens if the
//      files are imported as they are (the consequence in the destination: not seen in the sample, Kauro's own), how the plan fixes it, and a
//      link to the exact part of the plan that decides it (Insycle's "Review", OneSchema's "show error").
//   3. The overlap said once: a contact can be in more than one finding, so the findings' sum is not the number of contacts affected.
//   4. The estimate, in a quieter block: "reserves nothing", the figure no larger than a finding's, the three money moments kept apart, and
//      no button inside it. The page's one primary action, "Review the plan", comes after it.
//   5. How long the files and results stay, as dates computed from the policy.
// A count is of the whole file, never a sample; a candidate group is a signal, never a confirmed duplicate. The api has no findings read (F-04)
// and no estimate read (F-05): this page is a proposal.
import { Banner, StatusBadge, type Tone } from "@kauro/ui";
import { type ReactElement } from "react";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { bandIndexOf, bandLabel, formatUsd, priceOf } from "@web/public/pricing-bands.ts";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE } from "./example.ts";
import { moment, ScreenButton, ScreenLink } from "./kit.tsx";
import { can } from "./people.ts";
import { n, PLAN, share } from "./plan.tsx";
import { SERVICE } from "./service.ts";
import { TIMELINE } from "./timeline.ts";

export const P07_STATES: readonly StateDef[] = [
  { key: "normal", label: "Results", note: "The check of contacts.csv and companies.xlsx: the verdict, four findings by severity with their counts and examples, the overlap, then the estimate and the three money moments." },
  { key: "unpaid", label: "Nothing bought yet", note: "Days later, nothing bought: the page says first when the files and results are deleted, and the one extension." },
];

type Severity = "blocks" | "badly" | "decide";
const SEVERITY: Readonly<Record<Severity, { readonly word: string; readonly cleanWord: string; readonly tone: Tone }>> = {
  blocks: { word: "Blocks import", cleanWord: "Blocks cleaning", tone: "danger" },
  badly: { word: "Would import badly", cleanWord: "Would mislead whoever uses the files", tone: "warning" },
  decide: { word: "For your decision", cleanWord: "For your decision", tone: "info" },
};
const RANK: readonly Severity[] = ["blocks", "badly", "decide"];

interface Finding {
  readonly key: string;
  readonly severity: Severity;
  readonly title: string;
  /** A count of contacts, shown as the finding's figure with its denominator; null for a finding whose count is in its title. */
  readonly count: number | null;
  readonly outOf?: string;
  readonly examples: readonly string[];
  readonly ifUsed: string;
  readonly fix: string;
  readonly fixScreen: string;
  readonly fixLabel: string;
}

function findingsFor(mode: PrototypeProps["project"]["mode"]): readonly Finding[] {
  const crm = SERVICE[mode].destination;
  const company = mode === "SALESFORCE" ? "account" : "company";
  const all: Finding[] = [
    {
      key: "duplicates",
      severity: "decide",
      title: "Contacts that may be the same person",
      count: EXAMPLE.report.inGroups,
      outOf: `of ${n(EXAMPLE.contacts)} contacts, in ${n(PLAN.groups)} groups`,
      examples: ["Maria Lopez and M. Lopez, both m.lopez@example.com", "Ana Ruiz, twice: one row with a company, one without", "Three rows for leo.park@example.org"],
      ifUsed: crm === null ? "Every list or report counts the same person more than once." : `${crm} keeps one contact per email address and refuses the rest, or splits one person's history across records.`,
      fix: "Your team decides each group: unify, or keep apart. Groups with strong evidence can be decided together; nothing is unified without a decision.",
      fixScreen: "UI20",
      fixLabel: "Decide in Duplicates",
    },
    {
      key: "company",
      severity: "badly",
      title: `Contacts with no ${company}`,
      count: EXAMPLE.report.noCompany,
      outOf: `of ${n(EXAMPLE.contacts)} contacts: the Company column is empty`,
      examples: ["M. Lopez, row 9,402", "Ana Ruiz, row 10,861", "Row 11,630"],
      ifUsed: crm === null ? "These contacts cannot be grouped by company, and nothing says why." : `These contacts arrive in ${crm} without a ${company}, and nothing in ${crm} says why.`,
      fix:
        crm === null
          ? `The plan never invents a company: ${n(PLAN.emptyUnified)} are unified into another record and ${n(PLAN.emptyFilled)} take a duplicate's company with your approval; the other ${n(PLAN.emptyCompany)} stay empty and listed.`
          : `The plan never invents a ${company}: ${n(PLAN.emptyUnified)} are unified into another record and ${n(PLAN.emptyFilled)} take a duplicate's ${company} with your approval; the other ${n(PLAN.emptyCompany)} are prepared without one and listed. Another ${n(PLAN.notFound)} contacts name a ${company} that companies.xlsx does not hold.`,
      fixScreen: crm === null ? "UI20" : "UI21",
      fixLabel: crm === null ? "Decide in Duplicates" : "Decide in Links between records",
    },
    {
      key: "emails",
      severity: "badly",
      title: "Email addresses that are not valid",
      count: EXAMPLE.report.emailsInvalid,
      outOf: `of ${n(EXAMPLE.contacts)} contacts`,
      examples: ["leo.park@example", "ana ruiz@example.com", "sales@@example.org"],
      ifUsed: crm === null ? "Messages to these contacts bounce, and nobody can write to them." : `${crm} rejects these rows, or imports contacts nobody can write to.`,
      fix: "The plan leaves each one empty and lists it with its row, so your team can correct it at the source.",
      fixScreen: "UI19",
      fixLabel: "Decide in Fields",
    },
    crm === null
      ? {
          key: "columns",
          severity: "decide",
          title: "Columns that disagree with each other",
          count: PLAN.columnsDisagree,
          outOf: `of ${n(EXAMPLE.contacts)} contacts`,
          examples: ["Two columns called E-mail", "ana@larch.example beside ana.ruiz@example.com", "JOHN SMITH beside John Smith"],
          ifUsed: "Whoever uses the files has to guess which column is right.",
          fix: "The plan keeps one column and lists the other values in the report; your team chooses which.",
          fixScreen: "UI19",
          fixLabel: "Decide in Fields",
        }
      : {
          key: "settings",
          severity: "blocks",
          title: `${n(EXAMPLE.report.blockers)} ${crm} settings to settle before an import`,
          count: null,
          examples: [
            `Whether an import may set ${mode === "SALESFORCE" ? "the record owner" : "Deal owner"} in this ${mode === "SALESFORCE" ? "org" : "account"}`,
            `12 phone numbers longer than ${crm} keeps`,
            mode === "SALESFORCE" ? "Which duplicate rules are active on Contact" : "Whether imported contacts count as marketing contacts",
          ],
          ifUsed: `An import could stop half way, or change what ${crm} counts, without anyone deciding it.`,
          fix: "Each is answered in Destination or Fields before the plan can be approved.",
          fixScreen: "UI17",
          fixLabel: "Answer in Destination",
        },
  ];
  return [...all].sort((a, b) => RANK.indexOf(a.severity) - RANK.indexOf(b.severity) || (b.count ?? Number.MAX_SAFE_INTEGER) - (a.count ?? Number.MAX_SAFE_INTEGER));
}

export function HealthResults({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const clean = words.destination === null;
  const findings = findingsFor(project.mode);
  const band = bandIndexOf(EXAMPLE.units);
  const estimate = band === null ? null : formatUsd(priceOf(band, project.mode));
  const range = band === null ? "" : bandLabel(band).toLowerCase();
  const counted = findings.reduce((sum, finding) => sum + (finding.count ?? 0), 0);
  const tally = RANK.map((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    if (count === 0) return null;
    const word = severity === "blocks" ? (clean ? "blocks cleaning" : count === 1 ? "blocks the import" : "block the import") : severity === "badly" ? (clean ? "would mislead" : "would import badly") : "for your decision";
    return `${count} ${word}`;
  }).filter((part) => part !== null);
  const operator = can(ctx, "operate");
  return (
    <>
      <ProjectHeader stage="check" title="Health check results" lead="What the free check found in every row of your files, and what deciding involves." status={{ tone: "success", text: "Results ready" }} />
      {state === "unpaid" ? (
        <Banner tone="warning" title={`The files and these results are deleted on ${moment(TIMELINE.filesKeptUntil)}`} announce="status">
          <p>
            Nothing has been bought yet. To keep them longer, ask once for up to 3 more days (until {moment(TIMELINE.filesExtendedUntil)}) in Data and deletion; after that, the files would be uploaded again.
          </p>
        </Banner>
      ) : null}
      <section className="kauro-pl-verdict-block" aria-labelledby="verdict-h">
        <p className="kauro-pl-label">Free data health check · every row measured</p>
        <h2 id="verdict-h">{clean ? "Your files can be cleaned once four things are decided" : `Your files can go into ${words.destination ?? ""} once four things are settled`}</h2>
        <p className="kauro-pl-summary">
          {n(EXAMPLE.contacts)} contacts · {n(EXAMPLE.companies)} companies · {findings.length} findings: {tally.join(", ")}.
        </p>
      </section>
      <ol className="kauro-pl-findings">
        {findings.map((finding) => (
          <li key={finding.key} className="kauro-pl-finding">
            <p className="kauro-pl-finding-severity">
              <StatusBadge tone={SEVERITY[finding.severity].tone}>{clean ? SEVERITY[finding.severity].cleanWord : SEVERITY[finding.severity].word}</StatusBadge>
            </p>
            <h3>{finding.title}</h3>
            {finding.count === null ? null : (
              <p className="kauro-pl-figure">
                <strong>{n(finding.count)}</strong>
                <span>
                  {finding.outOf} · {share(finding.count)}
                </span>
              </p>
            )}
            <p className="kauro-pl-examples">
              <span className="kauro-pl-examples-label">For example</span>
              {finding.examples.map((example) => (
                <span key={example} className="kauro-pl-example">
                  {example}
                </span>
              ))}
            </p>
            <dl className="kauro-pl-finding-facts">
              <div>
                <dt>{clean ? "If used as they are" : "If imported as it is"}</dt>
                <dd>{finding.ifUsed}</dd>
              </div>
              <div>
                <dt>How the plan fixes it</dt>
                <dd>{finding.fix}</dd>
              </div>
            </dl>
            <p className="kauro-pl-finding-link">
              <ScreenLink to={finding.fixScreen} ctx={ctx} project={project.projectId}>
                {finding.fixLabel}
              </ScreenLink>
            </p>
          </li>
        ))}
      </ol>
      <p className="kauro-pl-meta">
        A contact can appear in more than one finding: the findings above count {n(counted)} contacts, {n(counted - PLAN.countedTwice)} different ones. A group of possible duplicates is worth
        reviewing; it is not a confirmed duplicate.
      </p>

      <section className="kauro-pl-estimate" aria-labelledby="estimate-h">
        <h2 id="estimate-h">Estimate · reserves nothing</h2>
        <p className="kauro-pl-figure">
          <strong>{estimate ?? "Above the price list"}</strong>
          <span>
            {words.name}, for the {EXAMPLE.unitsText} billable source units this check counted ({range} units), at price list {POLICY_SNAPSHOT.scheduleVersion}. In USD, before tax.
          </span>
        </p>
        <dl className="kauro-pl-moments">
          <div className="is-current">
            <dt>Estimate · now</dt>
            <dd>Informative. It reserves nothing and commits you to nothing.</dd>
          </div>
          <div>
            <dt>Quote · after the plan is approved</dt>
            <dd>Formal, on the approved scope, valid {POLICY_SNAPSHOT.quoteDays} days. A repeat discount appears here when your workspace has earned one.</dd>
          </div>
          <div>
            <dt>Payment · after the quote</dt>
            <dd>By bank transfer. The preparation can start once the exact amount is matched.</dd>
          </div>
        </dl>
      </section>
      <div className="kauro-actions">
        <ScreenButton to="UI19" ctx={ctx} project={project.projectId} variant="primary">
          {operator ? "Review the plan" : "See the plan"}
        </ScreenButton>
      </div>
      <p className="kauro-pl-meta">
        If nothing is bought, the files and these results are kept until {moment(TIMELINE.filesKeptUntil)} ({POLICY_SNAPSHOT.retention.unpaidDaysFromReady} days after the check), and deleted no later
        than {moment(TIMELINE.filesHardLimit)} ({POLICY_SNAPSHOT.retention.unpaidDaysHardFromSeal} days after the files were sealed).
      </p>
    </>
  );
}

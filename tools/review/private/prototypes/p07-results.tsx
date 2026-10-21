"use client";
// P-07 Health check results (proposed, beside UI18). The free check's finding, as the team reads it when the check is ready: one sentence
// first, then each kind of issue with its count and what it is counted out of, three examples, what happens if the files are used as they
// are, and how the plan fixes it. The price comes after the findings, never before (research: onboarding-vs-discounts.md, a free sample
// that shows the value before the offer; navigation-copy-selling.md, a concrete promise beside the call to action).
//
// The price (the owner's decision of 2026-10-20): an ESTIMATE computed from the selected service, the units the check actually measured and
// the price policy in force, with what sets the price and what may change before the formal quote; three moments kept apart: the estimate
// now (informative, reserves nothing), the quote once the plan is approved (formal, valid 14 days), the payment (bank transfer). No discount
// is applied to an estimate: a repeat discount appears in the quote only when it is confirmed. Viewing results or reviewing a plan never
// commits anyone to anything.
//
// Every count is the public Sample delivery's (REPORT_ROWS). The check measures the whole file, not a sample, and a candidate group is a
// signal, not a confirmed duplicate. The api has no findings read (F-04) and no estimate read (F-05): this page is a proposal.
import { type ReactElement } from "react";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { bandIndexOf, bandLabel, formatUsd, priceOf } from "@web/public/pricing-bands.ts";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE, UNPAID_RETENTION } from "./example.ts";
import { PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { n } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const P07_STATES: readonly StateDef[] = [
  { key: "normal", label: "Results", note: "The check of contacts.csv: one sentence, four findings with their counts and examples, then an estimate and the three moments to a purchase." },
  { key: "unpaid", label: "Kept without buying", note: "Five days later, nothing bought: the results stay until their date, and the page says when they go." },
];

const share = (count: number): string => `${((count / EXAMPLE.contacts) * 100).toFixed(1)}%`;

interface Finding {
  readonly key: string;
  readonly title: string;
  readonly count: number;
  readonly outOf: string | null;
  readonly examples: readonly string[];
  readonly ifUsed: string;
  readonly fix: string;
  readonly fixScreen: string;
}

function findingsFor(mode: PrototypeProps["project"]["mode"]): readonly Finding[] {
  const crm = SERVICE[mode].destination;
  const base: Finding[] = [
    {
      key: "duplicates",
      title: "Contacts that may be the same person",
      count: EXAMPLE.report.inGroups,
      outOf: `of ${n(EXAMPLE.contacts)} contacts, in ${n(EXAMPLE.groups)} groups`,
      examples: ["Maria Lopez and M. Lopez, both m.lopez@example.com", "Ana Ruiz, twice, one with a company and one without", "Three rows for leo.park@example.org"],
      ifUsed: crm === null ? "Every list or report counts the same person more than once." : `${crm} keeps one contact per email address and refuses the rest, or splits one person's history across records.`,
      fix: "Your team decides each group in the plan: unify, or keep apart. Nothing is merged without that decision.",
      fixScreen: "UI20",
    },
    {
      key: "emails",
      title: "Email addresses that are not valid",
      count: EXAMPLE.report.emailsInvalid,
      outOf: `of ${n(EXAMPLE.contacts)} contacts`,
      examples: ["leo.park@example", "ana ruiz@example.com", "sales@@example.org"],
      ifUsed: crm === null ? "Messages to these contacts bounce, and nobody can write to them." : `${crm} rejects these rows, or imports contacts nobody can write to.`,
      fix: "The plan leaves each one empty and lists it with its row, so your team can correct it at the source.",
      fixScreen: "UI19",
    },
    {
      key: "company",
      title: "Contacts with no company",
      count: EXAMPLE.report.noCompany,
      outOf: `of ${n(EXAMPLE.contacts)} contacts`,
      examples: ["M. Lopez, row 9,402", "Row 4,118, Company empty", "Row 11,630, Company empty"],
      ifUsed: crm === null ? "These contacts cannot be grouped by company, and nothing says why." : "These contacts arrive without a company, and nothing in the CRM says why.",
      fix: crm === null ? "The plan never invents a company: some take a duplicate's company with your approval; the rest stay empty and listed." : "The plan never invents a company: some take a duplicate's company with your approval, the rest are imported without one and listed.",
      fixScreen: crm === null ? "UI20" : "UI21",
    },
  ];
  base.push(
    crm === null
      ? {
          key: "columns",
          title: "Columns that disagree with each other",
          count: 214,
          outOf: `of ${n(EXAMPLE.contacts)} contacts`,
          examples: ["Two columns called E-mail", "ana@larch.example beside ana.ruiz@example.com", "JOHN SMITH beside John Smith"],
          ifUsed: "Whoever uses the files has to guess which column is right.",
          fix: "The plan keeps one column and lists the other values in the report; your team chooses in Fields.",
          fixScreen: "UI19",
        }
      : {
          key: "settings",
          title: `${crm} settings to settle before an import`,
          count: EXAMPLE.report.blockers,
          outOf: null,
          examples: [
            `Whether an import may set ${mode === "SALESFORCE" ? "the record owner" : "Deal owner"} in this ${mode === "SALESFORCE" ? "org" : "account"}`,
            `12 phone numbers longer than ${crm} keeps`,
            mode === "SALESFORCE" ? "Which duplicate rules are active" : "Whether imported contacts count as marketing contacts",
          ],
          ifUsed: `An import could stop half way, or change what ${crm} counts, without anyone deciding it.`,
          fix: "Each is settled in Destination or Fields before the plan can be approved.",
          fixScreen: "UI17",
        },
  );
  return base;
}

export function HealthResults({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const findings = findingsFor(project.mode);
  const band = bandIndexOf(EXAMPLE.units);
  const estimate = band === null ? null : formatUsd(priceOf(band, project.mode));
  const range = band === null ? "" : bandLabel(band).toLowerCase();
  return (
    <>
      <ProjectHeader current="check" />
      <PageHead title="Health check results" lead="What the free check found in your files, and what fixing it involves." />
      <section className="kauro-verdict" aria-labelledby="verdict-h">
        <p className="kauro-next-label">The check of contacts.csv · {n(EXAMPLE.contacts)} contacts, every row measured</p>
        <h2 id="verdict-h">{words.destination === null ? "Your files can be cleaned once four things are decided" : `Your files can go into ${words.destination} once four things are settled`}</h2>
        <p>
          The largest is {n(EXAMPLE.report.noCompany)} contacts with no company ({share(EXAMPLE.report.noCompany)}). None of the four is fixed without your team&apos;s decision
          {words.destination === null ? "." : `, and Kauro never writes to ${words.destination}.`}
        </p>
      </section>
      <ol className="kauro-findings">
        {findings.map((finding) => (
          <li key={finding.key} className="kauro-finding">
            <div className="kauro-finding-figure">
              <strong>{n(finding.count)}</strong>
              <span>{finding.outOf === null ? "settings" : `${finding.outOf} · ${share(finding.count)}`}</span>
            </div>
            <div className="kauro-finding-body">
              <h3>{finding.title}</h3>
              <p className="kauro-finding-examples">
                <span>For example</span>
                {finding.examples.map((example) => (
                  <span key={example} className="kauro-finding-example">
                    {example}
                  </span>
                ))}
              </p>
              <dl>
                <div>
                  <dt>{words.destination === null ? "If used as they are" : "If imported as it is"}</dt>
                  <dd>{finding.ifUsed}</dd>
                </div>
                <div>
                  <dt>How the plan fixes it</dt>
                  <dd>
                    {finding.fix}{" "}
                    <ScreenLink to={finding.fixScreen} ctx={ctx} project={project.projectId}>
                      See where
                    </ScreenLink>
                  </dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ol>
      <p className="kauro-muted">A group of possible duplicates is worth reviewing; it is not a confirmed duplicate. Every share says out of what.</p>

      <section className="kauro-offer" aria-labelledby="offer-h">
        <div className="kauro-offer-figure">
          <p className="kauro-next-label">Estimate · {words.name}</p>
          <h2 id="offer-h">{estimate ?? "Above the price list"}</h2>
          <p>
            For the {EXAMPLE.unitsText} billable source units this check counted, at the price list in force ({range} units; policy {POLICY_SNAPSHOT.scheduleVersion}). In USD, before tax.
          </p>
        </div>
        <dl className="kauro-offer-facts">
          <div>
            <dt>What sets the price</dt>
            <dd>The service, the number of billable source units counted (contacts, organisations or deals, counted before duplicates are unified), and the price list.</dd>
          </div>
          <div>
            <dt>What can change before the quote</dt>
            <dd>The units, if you upload different files; a repeat discount, shown in the quote only once it is confirmed; the price list, if a new one is in force.</dd>
          </div>
        </dl>
        <ol className="kauro-moments" aria-label="From the estimate to the purchase">
          <li className="is-current">
            <strong>Estimate</strong>
            <span>Now. Informative; it reserves nothing and commits you to nothing.</span>
          </li>
          <li>
            <strong>Quote</strong>
            <span>Once your team approves the plan. Formal, on the approved scope, valid {POLICY_SNAPSHOT.quoteDays} days.</span>
          </li>
          <li>
            <strong>Payment</strong>
            <span>By bank transfer. Your team can start the preparation once the exact amount is matched.</span>
          </li>
        </ol>
        <div className="kauro-actions">
          <ScreenButton to="UI19" ctx={ctx} project={project.projectId} variant="primary">
            <span className="kauro-go">Review the plan</span>
          </ScreenButton>
        </div>
      </section>
      <p className="kauro-muted">
        {state === "unpaid"
          ? "Nothing bought yet: these results and the files are deleted on Oct 27, 2026, 7 days after the check was ready."
          : `Not ready to decide? The results and the files stay ${UNPAID_RETENTION.days} days after the check, and are deleted no later than ${UNPAID_RETENTION.hardDays} days after the files were sealed.`}
      </p>
    </>
  );
}

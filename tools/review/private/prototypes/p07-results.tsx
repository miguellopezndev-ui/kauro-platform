"use client";
// P-07 Health check results (proposed). The free check's finding, as the team reads it when the check is ready: one sentence first, then
// each kind of issue with its count and what it is counted out of, three examples, what happens if the files are imported as they are, and
// how the plan fixes it; the price comes after the findings, never before (research: onboarding-vs-discounts.md, a free sample that shows
// the value before the offer; navigation-copy-selling.md, a concrete promise beside the call to action). Every count is the public Sample
// delivery's (REPORT_ROWS): a visitor who read the site meets the same numbers here. The check measures the whole file, not a sample, and
// a candidate group is a signal, not a confirmed duplicate (the site's own words). The api has no findings view yet (UI18 shows the check's
// progress and its counts of rows), so this page is a proposal beside UI18.
import { type ReactElement } from "react";
import { ProjectStages } from "@web/screens/shared/project-stages.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE, UNPAID_RETENTION } from "./example.ts";
import { PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { n } from "./plan.tsx";

export const P07_STATES: readonly StateDef[] = [
  { key: "normal", label: "Results", note: "The check of contacts.csv: one sentence, four findings with their counts and examples, then what fixing them costs." },
  { key: "unpaid", label: "Kept without buying", note: "Five days later, nothing bought: the results stay until their date, and the page says when they go." },
];

const share = (count: number): string => `${((count / EXAMPLE.contacts) * 100).toFixed(1)}%`;

interface Finding {
  readonly key: string;
  readonly title: string;
  readonly count: number;
  readonly outOf: string | null;
  readonly examples: readonly string[];
  readonly ifImported: string;
  readonly fix: string;
  readonly fixScreen: string;
}

const FINDINGS: readonly Finding[] = [
  {
    key: "duplicates",
    title: "Contacts that may be the same person",
    count: EXAMPLE.report.inGroups,
    outOf: `of ${n(EXAMPLE.contacts)} contacts, in ${n(EXAMPLE.groups)} groups`,
    examples: ["Maria Lopez and M. Lopez, both m.lopez@example.com", "Ana Ruiz, twice, one with a company and one without", "Three rows for leo.park@example.org"],
    ifImported: "HubSpot keeps one contact per email address and refuses the rest, or splits one person's history across records.",
    fix: "Your team decides each group in the plan: unify, or keep apart. Nothing is merged without that decision.",
    fixScreen: "UI20",
  },
  {
    key: "emails",
    title: "Email addresses that are not valid",
    count: EXAMPLE.report.emailsInvalid,
    outOf: `of ${n(EXAMPLE.contacts)} contacts`,
    examples: ["leo.park@example", "ana ruiz@example.com", "sales@@example.org"],
    ifImported: "HubSpot rejects these rows, or imports contacts nobody can write to.",
    fix: "The plan leaves each one empty and lists it with its row, so your team can correct it at the source.",
    fixScreen: "UI19",
  },
  {
    key: "company",
    title: "Contacts with no company",
    count: EXAMPLE.report.noCompany,
    outOf: `of ${n(EXAMPLE.contacts)} contacts`,
    examples: ["M. Lopez, row 9,402", "Row 4,118, Company empty", "Row 11,630, Company empty"],
    ifImported: "These contacts arrive without a company, and nothing in HubSpot says why.",
    fix: "The plan never invents a company: some are filled by a duplicate's company with your approval, the rest are imported without one and listed.",
    fixScreen: "UI21",
  },
  {
    key: "settings",
    title: "HubSpot settings to settle before an import",
    count: EXAMPLE.report.blockers,
    outOf: null,
    examples: ["Whether an import may set Deal owner in this account", "12 phone numbers longer than HubSpot keeps", "Whether imported contacts count as marketing contacts"],
    ifImported: "An import could stop half way, or count contacts against your HubSpot subscription without anyone deciding it.",
    fix: "Each is settled in the target settings or the mapping before the plan can be approved.",
    fixScreen: "UI17",
  },
];

export function HealthResults({ ctx, state }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  return (
    <>
      <ProjectStages agencyId={agencyId} projectId={IDS.project} current="check" />
      <PageHead title="Health check results" lead="What the free check found in your files, and what fixing it involves." />
      <section className="kauro-verdict" aria-labelledby="verdict-h">
        <p className="kauro-next-label">The check of contacts.csv · {n(EXAMPLE.contacts)} contacts, every row measured</p>
        <h2 id="verdict-h">Your files can go into HubSpot once four things are settled</h2>
        <p>
          The largest is {n(EXAMPLE.report.noCompany)} contacts with no company ({share(EXAMPLE.report.noCompany)}). None of the four is fixed without your team&apos;s decision, and Kauro never writes to HubSpot.
        </p>
      </section>
      <ol className="kauro-findings">
        {FINDINGS.map((finding) => (
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
                  <span key={example} className="kauro-finding-example">{example}</span>
                ))}
              </p>
              <dl>
                <div>
                  <dt>If imported as it is</dt>
                  <dd>{finding.ifImported}</dd>
                </div>
                <div>
                  <dt>How the plan fixes it</dt>
                  <dd>
                    {finding.fix}{" "}
                    <ScreenLink to={finding.fixScreen} ctx={ctx}>
                      See where
                    </ScreenLink>
                  </dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ol>
      <p className="kauro-muted">
        A group of possible duplicates is worth reviewing; it is not a confirmed duplicate. Every share says out of what. The full report, with every row, is part of the delivery; this page and its counts stay with the project.
      </p>
      <section className="kauro-offer" aria-labelledby="offer-h">
        <div>
          <p className="kauro-next-label">Fixing it, prepared for HubSpot</p>
          <h2 id="offer-h">{EXAMPLE.price}</h2>
          <p>
            For {EXAMPLE.unitsText} billable source units (band: {EXAMPLE.band.toLowerCase()}). The exact quote comes after your team approves the plan, and nothing is charged before it is paid.
          </p>
        </div>
        <ul>
          <li>The plan: every change shown, decided by your team</li>
          <li>Cleaned files, a report and a manifest that traces every row</li>
          <li>Import steps for HubSpot, and each stage&apos;s result checked</li>
        </ul>
        <div className="kauro-actions">
          <ScreenButton to="UI19" ctx={ctx} variant="primary">
            <span className="kauro-go">Review the plan</span>
          </ScreenButton>
        </div>
      </section>
      <p className="kauro-muted">
        {state === "unpaid" ? "Nothing bought yet: these results and the files go on 27 Oct 2026, 7 days after the check was ready." : `Not ready to buy? The results and the files stay for ${UNPAID_RETENTION.days} days after the check, and go no later than ${UNPAID_RETENTION.hardDays} days after the files were sealed.`}
      </p>
    </>
  );
}

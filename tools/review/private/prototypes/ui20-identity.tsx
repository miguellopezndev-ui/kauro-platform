"use client";
// UI20 Identity, shown as "Duplicates" (registry: "Similarity is a signal; merging needs a decision."; Order 11 round 2, research
// agency-workspace.md §3.4 and §5.9). The candidate groups of contacts.csv (207 groups holding 428 contacts, found in every row) are decided
// by the team, fast where the evidence is strong and carefully where it is weak:
//   - one progress line, never a row of stat plates, whose three parts always add up to the total (C-2: 186 + 7 + 21 was 214);
//   - the groups by the reason Kauro grouped them, as a table. A strong class (the same email address) can be decided in bulk, with three of
//     its groups shown first and the effect in numbers beside the button ("76 contacts become 38"): DataGroomr shows the records a filter
//     affects before commit, Cloudingo advises checking more than one group. A weak class, and every group of three, is decided one by one
//     (Dedupely's merge safety keeps large groups and weak evidence out of bulk);
//   - one group at a time, field by field, with "Unify and next" and "Keep apart and next" as equal choices (no nudge), and the unified
//     record beside the two it comes from. Consent is never resolved by recency: the most restrictive choice is kept.
// Nothing is merged in anyone's CRM: these are decisions of a plan that can change until it is approved, and a bulk decision can be undone
// until then. A person whose role cannot change the plan reads everything and one line saying who can decide.
import { Banner, Button, type Tone } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Only, ScreenButton } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { CLASSES, n, PLAN, PlanTasks, tasksFor } from "./plan.tsx";

export const UI20_STATES: readonly StateDef[] = [
  { key: "normal", label: "One by one, 21 left", note: "The two strong classes were unified in bulk (and can be undone until approval); 7 of the 28 weak or larger groups are decided; one group is open, side by side." },
  { key: "first", label: "Nothing decided yet", note: "The check is ready and the plan drafted: every class waits for a decision. The strong ones offer a bulk decision with three examples and its effect in numbers." },
  { key: "conflict", label: "A consent conflict", note: "The open group's two records disagree on marketing consent: the unified record keeps the most restrictive choice, and the page says so." },
  { key: "decided", label: "All decided", note: "Every group is decided: 200 unified, 7 kept apart, 214 contact rows join another record. Duplicates is completed." },
];

export function Identity({ ctx, state, project }: PrototypeProps): ReactElement {
  const editor = can(ctx, "operate");
  const first = state === "first";
  const decidedAll = state === "decided";
  const [bulk, setBulk] = useState<Readonly<Record<string, boolean>>>({ "email-name": !first, "email-spelling": !first });
  const [made, setMade] = useState<{ readonly unify: number; readonly apart: number }>({ unify: 0, apart: 0 });
  const strongDone = CLASSES.filter((one) => one.bulk && bulk[one.key] === true);
  const strongGroups = strongDone.reduce((sum, one) => sum + one.groups, 0);
  const counts = decidedAll
    ? { unify: PLAN.unifyGroups, apart: PLAN.keptApart, left: 0 }
    : first
      ? { unify: strongGroups + made.unify, apart: made.apart, left: PLAN.groups - strongGroups - made.unify - made.apart }
      : { unify: PLAN.progress.unify - (179 - strongGroups) + made.unify, apart: PLAN.progress.apart + made.apart, left: PLAN.progress.left + (179 - strongGroups) - made.unify - made.apart };
  const oneByOneLeft = decidedAll ? 0 : PLAN.oneByOne - (first ? 0 : 7) - made.unify - made.apart;
  const reviewed = counts.left === 0;
  const status: { readonly tone: Tone; readonly text: string } = reviewed ? { tone: "success", text: "Duplicates decided" } : { tone: "info", text: "Plan in review" };
  const next = project.mode === "CLEAN" ? { to: "UI22", label: "Continue to approval" } : { to: "UI21", label: "Continue to links between records" };
  return (
    <>
      <ProjectHeader stage="plan" title="Duplicates" lead="Kauro groups records that may be the same person. A group is a signal: nothing is unified without your team's decision." status={status} />
      <PlanTasks ctx={ctx} project={project} current="identity" states={tasksFor("identity", decidedAll, project.mode)} />
      <p className="kauro-pl-progress">
        <span>
          {n(PLAN.groups)} candidate groups holding {n(PLAN.groupContacts)} contacts, found in all {n(PLAN.contacts)} rows of contacts.csv:
        </span>{" "}
        <strong>
          {n(counts.unify)} to unify · {n(counts.apart)} kept apart · {n(counts.left)} left to decide
        </strong>
      </p>

      <section className="kauro-pl-section" aria-labelledby="classes-h">
        <h2 id="classes-h">The groups, by why Kauro grouped them</h2>
        <table className="kauro-rtable kauro-pl-rtable kauro-pl-classes">
          <caption className="kauro-visually-hidden">Candidate groups by evidence, with the decision for each class</caption>
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col" className="kauro-num">
                Groups
              </th>
              <th scope="col" className="kauro-num">
                Contacts
              </th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {CLASSES.map((one) => {
              const done = decidedAll || (one.bulk && bulk[one.key] === true);
              return (
                <tr key={one.key}>
                  <th scope="row">
                    {one.evidence}
                    <span className="kauro-sub">{one.bulk ? "Strong evidence: can be decided together" : one.key === "three" ? "Three records: decided one group at a time" : "Weaker evidence: decided one group at a time"}</span>
                  </th>
                  <td data-label="Groups" className="kauro-num">
                    {n(one.groups)}
                  </td>
                  <td data-label="Contacts" className="kauro-num">
                    {n(one.contacts)}
                  </td>
                  <td data-label="Decision">
                    <span className="kauro-pl-decision">
                    {one.bulk ? (
                      done ? (
                        <span className="kauro-pl-decided">
                          All {n(one.groups)} unified
                          {editor && !decidedAll ? (
                            <button type="button" className="kauro-pl-link" onClick={() => setBulk((old) => ({ ...old, [one.key]: false }))}>
                              Undo<span className="kauro-visually-hidden"> for {one.evidence.toLowerCase()}</span>
                            </button>
                          ) : null}
                        </span>
                      ) : editor ? (
                        <span className="kauro-pl-bulk">
                          <Button variant="secondary" onClick={() => setBulk((old) => ({ ...old, [one.key]: true }))}>
                            Unify all {n(one.groups)}
                          </Button>
                          <span className="kauro-pl-effect">
                            {n(one.contacts)} contacts become {n(one.groups)}. Each is listed in the report.
                          </span>
                        </span>
                      ) : (
                        <span>Not decided yet</span>
                      )
                    ) : decidedAll ? (
                      <span className="kauro-pl-decided">{one.key === "three" ? `All ${n(one.groups)} unified` : `${n(one.groups - PLAN.keptApart)} unified, ${n(PLAN.keptApart)} kept apart`}</span>
                    ) : (
                      <span>One by one</span>
                    )}
                    {one.samples.length > 0 ? (
                      <details className="kauro-pl-samples">
                        <summary>See 3 of these groups</summary>
                        <ul>
                          {one.samples.map((sample) => (
                            <li key={sample}>{sample}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="kauro-pl-meta">
          companies.xlsx: {n(PLAN.companiesUnified)} rows share a domain and a name with another company; the plan unifies each into it, and the report lists them. Decisions are drafts until the plan
          is approved; a bulk decision can be undone until then.
        </p>
      </section>

      {decidedAll ? (
        <>
          <Banner tone="success" title="Every group is decided" announce="status">
            <p>
              {n(PLAN.unifyGroups)} groups unified and {n(PLAN.keptApart)} kept apart: {n(PLAN.unifiedRows)} contact rows join another record, so {n(PLAN.output)} contacts are prepared. The decisions
              can change until the plan is approved.
            </p>
          </Banner>
          {editor ? (
            <div className="kauro-actions">
              <ScreenButton to={next.to} ctx={ctx} project={project.projectId} variant="primary">
                {next.label}
              </ScreenButton>
            </div>
          ) : null}
        </>
      ) : (
        <section className="kauro-pl-section kauro-pl-group" aria-labelledby="group-h">
          <h2 id="group-h">{oneByOneLeft === 0 ? "No group left to decide one by one" : `One by one: group 1 of ${n(counts.left)} left`}</h2>
          {first ? <p className="kauro-pl-meta">Decide the two strong classes above first, or open the groups here one at a time; every group is decided either way.</p> : null}
          <p className="kauro-pl-proof">
            <strong>Why Kauro grouped them:</strong> the same name and the same phone number, <span className="kauro-pl-nowrap">+44 20 7946 0958</span>; the email addresses differ.
          </p>
          <table className="kauro-pl-compare">
            <caption className="kauro-visually-hidden">The two records of the group, field by field, and the unified record</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">
                  Row 2,207 <span className="kauro-pl-keep">Kept</span>
                </th>
                <th scope="col">Row 10,861</th>
                <th scope="col">If unified</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Name</th>
                <td data-label="Row 2,207, kept">Ana Ruiz</td>
                <td data-label="Row 10,861">Ana Ruiz</td>
                <td data-label="If unified">Ana Ruiz</td>
              </tr>
              <tr className="is-conflict">
                <th scope="row">Email</th>
                <td data-label="Row 2,207, kept">ana.ruiz@example.com</td>
                <td data-label="Row 10,861">ana@larch.example</td>
                <td data-label="If unified">ana.ruiz@example.com; the other address is listed in the report</td>
              </tr>
              <tr>
                <th scope="row">Phone</th>
                <td data-label="Row 2,207, kept">+44 20 7946 0958</td>
                <td data-label="Row 10,861">+44 20 7946 0958</td>
                <td data-label="If unified">+44 20 7946 0958</td>
              </tr>
              <tr className="is-conflict">
                <th scope="row">Company</th>
                <td data-label="Row 2,207, kept">Larch Studio</td>
                <td data-label="Row 10,861">
                  <span className="kauro-pl-empty">Empty</span>
                </td>
                <td data-label="If unified">Larch Studio, the only value given</td>
              </tr>
              <tr className={state === "conflict" ? "is-conflict" : undefined}>
                <th scope="row">Marketing consent</th>
                <td data-label="Row 2,207, kept">{state === "conflict" ? "Subscribed" : "Not subscribed"}</td>
                <td data-label="Row 10,861">Not subscribed</td>
                <td data-label="If unified">{state === "conflict" ? "Not subscribed, the most restrictive choice" : "Not subscribed"}</td>
              </tr>
            </tbody>
          </table>
          {state === "conflict" ? <p className="kauro-pl-consent">The two records disagree on consent. Consent is never resolved by the newer row: when records disagree, the unified record keeps the most restrictive choice.</p> : null}
          {editor ? (
            <div className="kauro-pl-decide">
              <Button variant="secondary" onClick={() => setMade((old) => ({ ...old, unify: old.unify + 1 }))}>
                Unify and next
              </Button>
              <Button variant="secondary" onClick={() => setMade((old) => ({ ...old, apart: old.apart + 1 }))}>
                Keep apart and next
              </Button>
              <span className="kauro-pl-meta">
                {made.unify + made.apart === 0 ? "Unify keeps row 2,207 and adds row 10,861 to it; keep apart prepares two contacts." : `${n(made.unify + made.apart)} decided in this visit. Saved as you go.`}
              </span>
            </div>
          ) : (
            <Only>{onlyLine(ctx, "operate", "decide duplicates")}</Only>
          )}
        </section>
      )}
    </>
  );
}

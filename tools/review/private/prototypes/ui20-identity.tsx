"use client";
// UI20 Identity (registry: "Similarity is a signal; merging needs a decision."). The duplicate candidate groups of contacts.csv, counted in
// full (207 groups holding 428 contacts), each decided by the team: unify the group into one record, or keep its records apart. A group's
// page shows the exact records side by side, the proof Kauro relies on (an identical address in the full data, never a sample), the record
// that is kept, and each field that conflicts with how it is resolved; marketing consent has its own explicit treatment, the most
// restrictive choice wins (registry information and exceptions). Nothing is merged in anyone's CRM: these are decisions of the plan, and
// they can change until it is approved (research: app-ui-patterns.md 4, against one-click merge-all).
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { PageHead, ScreenButton } from "./kit.tsx";
import { n, PLAN, PlanTasks } from "./plan.tsx";

export const UI20_STATES: readonly StateDef[] = [
  { key: "normal", label: "Groups to decide", note: "186 groups decided by the rule the team chose, 21 left: one is open, side by side." },
  { key: "decided", label: "All decided", note: "Every group decided: 200 unified, 7 kept apart; 214 contact rows unified." },
  { key: "conflict", label: "A consent conflict", note: "Two records disagree on marketing consent: the most restrictive choice is kept, and said so." },
];

const STATES = { mapping: "done", identity: "review", relationships: "review", approval: "waiting" } as const;

export function Identity({ ctx, state, project }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const decided = state === "decided";
  const [choice, setChoice] = useState<"unify" | "apart" | null>(null);
  const left = decided ? 0 : 21;
  return (
    <>
      <ProjectHeader current="plan" />
      <PageHead title="Duplicates" lead="Similarity is a signal; merging needs a decision." />
      <PlanTasks ctx={ctx} project={project} current="identity" states={decided ? { ...STATES, identity: "done" } : STATES} />
      <dl className="kauro-identity-counts">
        <div>
          <dt>Candidate groups</dt>
          <dd>{n(PLAN.groups)}</dd>
          <dd>
            {n(PLAN.pairs)} pairs and {n(PLAN.triples)} groups of three, holding {n(PLAN.groupContacts)} contacts, found in all {n(PLAN.contacts)} rows
          </dd>
        </div>
        <div>
          <dt>To unify</dt>
          <dd>{n(decided ? PLAN.unifyGroups : 186)}</dd>
          <dd>{decided ? `${n(PLAN.unifiedRows)} contact rows become part of another record` : "Decided so far"}</dd>
        </div>
        <div>
          <dt>Kept apart</dt>
          <dd>{n(PLAN.keptApart)}</dd>
          <dd>Their records stay separate</dd>
        </div>
        <div>
          <dt>Left to decide</dt>
          <dd>{n(left)}</dd>
          <dd>{left === 0 ? "Nothing left" : "Each needs a decision"}</dd>
        </div>
      </dl>
      {decided ? (
        <Banner tone="success" title="Every group is decided" announce="status">
          <p>
            {n(PLAN.unifyGroups)} groups unified and {n(PLAN.keptApart)} kept apart. The decisions can change until the plan is approved.
          </p>
        </Banner>
      ) : (
        <section className="kauro-group" aria-labelledby="group-h">
          <div className="kauro-group-head">
            <h2 id="group-h">Group 188 of {n(PLAN.groups)}</h2>
            <span className="kauro-muted-text">A pair</span>
          </div>
          <p className="kauro-group-proof">
            <strong>Why Kauro grouped them:</strong> the same address, <code>m.lopez@example.com</code>, in both rows of the full data.
          </p>
          <div className="kauro-table-region">
            <table className="kauro-table kauro-compare">
              <caption className="kauro-visually-hidden">The two records of the group, field by field</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">
                    Row 3,118 <span className="kauro-compare-keep">Kept</span>
                  </th>
                  <th scope="col">Row 9,402</th>
                  <th scope="col">The unified record</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Name</th>
                  <td data-label="Row 3,118, kept">Maria Lopez</td>
                  <td data-label="Row 9,402">M. Lopez</td>
                  <td data-label="The unified record">Maria Lopez</td>
                </tr>
                <tr>
                  <th scope="row">Email</th>
                  <td data-label="Row 3,118, kept">m.lopez@example.com</td>
                  <td data-label="Row 9,402">m.lopez@example.com</td>
                  <td data-label="The unified record">m.lopez@example.com</td>
                </tr>
                <tr className="is-conflict">
                  <th scope="row">Company</th>
                  <td data-label="Row 3,118, kept">Tidewell</td>
                  <td data-label="Row 9,402" className="kauro-compare-empty">Empty</td>
                  <td data-label="The unified record">Tidewell, the only value given</td>
                </tr>
                <tr className={state === "conflict" ? "is-conflict" : undefined}>
                  <th scope="row">Marketing consent</th>
                  <td data-label="Row 3,118, kept">{state === "conflict" ? "Subscribed" : "Not subscribed"}</td>
                  <td data-label="Row 9,402">Not subscribed</td>
                  <td data-label="The unified record">Not subscribed{state === "conflict" ? ", the most restrictive choice" : ""}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {state === "conflict" ? (
            <p className="kauro-group-consent">Consent is never resolved by recency: when records disagree, the unified record keeps the most restrictive choice.</p>
          ) : null}
          <fieldset className="kauro-choice kauro-group-choice">
            <legend>Your decision for this group</legend>
            <label>
              <input type="radio" name="group-188" checked={choice === "unify"} onChange={() => setChoice("unify")} />
              <span>
                <strong>Unify into one record</strong>
                <small>Row 3,118 is kept; row 9,402 becomes part of it. The report lists both.</small>
              </span>
            </label>
            <label>
              <input type="radio" name="group-188" checked={choice === "apart"} onChange={() => setChoice("apart")} />
              <span>
                <strong>Keep them apart</strong>
                <small>Both rows are prepared as two contacts.</small>
              </span>
            </label>
          </fieldset>
          <div className="kauro-actions">
            <Button variant="primary" disabled={choice === null}>
              <span className="kauro-go">Save and open the next group</span>
            </Button>
            <Button>Previous group</Button>
          </div>
          {choice === null ? <p className="kauro-muted">Choose one of the two to save this group.</p> : null}
        </section>
      )}
      <div className="kauro-actions">
        {decided ? (
          <ScreenButton to="UI21" ctx={ctx} project={project.projectId} variant="primary">
            <span className="kauro-go">Continue to links between records</span>
          </ScreenButton>
        ) : (
          <ScreenButton to="UI21" ctx={ctx} project={project.projectId}>
            Review links between records
          </ScreenButton>
        )}
      </div>
    </>
  );
}

"use client";
// UI22 Approval (registry: "Approve these exact preparation decisions."). A check-your-answers page (research: app-ui-patterns.md 3,
// GOV.UK): the sealed set and the destination, then every effect of the plan, part by part, each with its way back to change it; what is
// not included; the validation's result. Approving names this exact version of the plan, asks the person to confirm who they are again
// (step-up: Kauro's code), and is its own button outside any form, so the Enter key cannot approve a default nobody saw (registry
// exceptions). A newer version, or an effect not shown, blocks approval. Only an approver or an owner approves; Kauro proposes.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectStages } from "@web/screens/shared/project-stages.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { CodeField } from "./auth.tsx";
import { EXAMPLE } from "./example.ts";
import { PageHead, ScreenButton, ScreenLink, Stamp } from "./kit.tsx";
import { n, PLAN, PlanTasks } from "./plan.tsx";

export const UI22_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to approve", note: "Every part reviewed and validated: the whole plan, part by part, with what it does not include." },
  { key: "stepup", label: "Confirm who you are", note: "Approving asks for Kauro's code again; the code is valid for this one approval." },
  { key: "approved", label: "Approved", note: "Approved: the approval names this exact plan, set and destination. The next step is the quote." },
  { key: "stale", label: "A newer version", note: "The plan changed after this page was opened: approval is blocked until the new version is reviewed." },
  { key: "viewer", label: "Not an approver", note: "Seen by an operator: everything is visible, and an approver or an owner approves." },
];

const STATES = { mapping: "done", identity: "done", relationships: "done", approval: "review" } as const;

function Part({ title, rows, change, ctx }: { readonly title: string; readonly rows: readonly string[]; readonly change: string; readonly ctx: PrototypeProps["ctx"] }): ReactElement {
  return (
    <div className="kauro-answers-part">
      <h3>{title}</h3>
      <ul>
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
      <ScreenLink to={change} ctx={ctx}>
        Change<span className="kauro-visually-hidden"> {title.toLowerCase()}</span>
      </ScreenLink>
    </div>
  );
}

export function Approval({ ctx, state }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const approver = (ctx.agency?.permittedActions ?? []).includes("APPROVE_PLANS") && state !== "viewer";
  const [step, setStep] = useState(state);
  const [agreed, setAgreed] = useState(state === "stepup");
  const approved = step === "approved";
  const workspace = ctx.agency?.displayName ?? "Northwind Data";
  return (
    <>
      <ProjectStages agencyId={agencyId} projectId={IDS.project} current="decide" />
      <PageHead title="Approval" lead="Approve these exact preparation decisions." />
      <PlanTasks ctx={ctx} current="approval" states={approved ? { ...STATES, approval: "done" } : state === "stale" ? { ...STATES, identity: "review", approval: "blocked" } : STATES} />
      {state === "stale" ? (
        <Banner tone="warning" title="The plan changed after you opened this page" announce="alert">
          <p>Version 7 replaced version 6 at 12:31 UTC: 3 groups of duplicates were decided again. Review the new version before it can be approved.</p>
          <p>
            <ScreenLink to="UI20" ctx={ctx}>
              Review the duplicates again
            </ScreenLink>
          </p>
        </Banner>
      ) : null}
      <section className="kauro-answers" aria-labelledby="answers-h">
        <div className="kauro-answers-head">
          <h2 id="answers-h">The plan, version 6{state === "stale" ? ", replaced" : ""}</h2>
          <span className="kauro-muted-text">{state === "stale" ? "Version 7 is not validated yet" : "Validated 20 Oct 2026, 12:20 UTC · no blocker"}</span>
        </div>
        <Part title="Files" ctx={ctx} change="UI16" rows={[`${EXAMPLE.sources.join(" and ")}, sealed`, `${EXAMPLE.unitsText} billable source units`]} />
        <Part title="Destination" ctx={ctx} change="UI17" rows={["HubSpot account 24816309, through its own importer", "Its settings confirmed on 20 Oct 2026"]} />
        <Part
          title="Fields"
          ctx={ctx}
          change="UI19"
          rows={[`9 columns mapped, 1 left out (a second e-mail column)`, `Capitals made consistent in ${n(PLAN.namesCapitalised)} names; ${n(PLAN.emailsLowercased)} addresses made lower case`, `${n(PLAN.emailsInvalid)} invalid addresses left empty, each listed in the report`]}
        />
        <Part title="Duplicates" ctx={ctx} change="UI20" rows={[`${n(PLAN.unifyGroups)} groups unified, ${n(PLAN.keptApart)} kept apart`, `${n(PLAN.unifiedRows)} contact rows and 253 company rows become part of another record`, "Marketing consent: the most restrictive choice is kept"]} />
        <Part title="Links between records" ctx={ctx} change="UI21" rows={[`${n(PLAN.links)} contacts linked to their company`, `${n(PLAN.noCompany)} contacts imported without a company, on purpose`]} />
        <div className="kauro-answers-part kauro-answers-part--out">
          <h3>Not included</h3>
          <ul>
            <li>No field, rule or automation is created in HubSpot: your team imports the files with its own account.</li>
            <li>Deal owners, while it is not known whether an import may set them.</li>
            <li>Activities, notes and attachments are outside this service.</li>
          </ul>
        </div>
      </section>
      {approved ? (
        <section className="kauro-approved" aria-labelledby="approved-h">
          <h2 id="approved-h">The plan is approved</h2>
          <p>Approved by {ctx.who.split(",")[0]} on 20 Oct 2026 at 12:40 UTC. The approval names version 6 of the plan, the sealed set and the HubSpot settings it was checked against.</p>
          <ScreenButton to="UI23" ctx={ctx} variant="primary">
            <span className="kauro-go">See the quote</span>
          </ScreenButton>
          <Stamp>Approved</Stamp>
        </section>
      ) : !approver ? (
        <section className="kauro-next" aria-labelledby="approver-h">
          <p className="kauro-next-label">Who approves</p>
          <h2 id="approver-h">An approver or an owner approves this plan</h2>
          <p>Your role reviews the plan but does not approve it. In {workspace}, the people with the approver or owner role can; Team lists them.</p>
        </section>
      ) : state === "stale" ? null : (
        <section className="kauro-approve" aria-labelledby="approve-h">
          <h2 id="approve-h">Approve</h2>
          <label className="kauro-confirm">
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
            <span>I approve version 6 of this plan, exactly as listed above, for {workspace}.</span>
          </label>
          {step === "stepup" ? (
            <div className="kauro-approve-code">
              <CodeField id="approve-code" label="Your Kauro code" hint="Approving asks who you are again. The code works for this approval only." />
              <Button variant="primary" onClick={() => setStep("approved")}>
                Approve the plan
              </Button>
            </div>
          ) : (
            <Button variant="primary" disabled={!agreed} onClick={() => setStep("stepup")}>
              Continue to approve
            </Button>
          )}
          {agreed ? null : <p className="kauro-muted">Tick the box to approve this exact version.</p>}
          <p className="kauro-muted">Nothing is prepared, and nothing is charged, until the plan is approved and its quote is paid.</p>
        </section>
      )}
    </>
  );
}

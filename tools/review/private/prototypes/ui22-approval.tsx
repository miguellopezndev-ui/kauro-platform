"use client";
// UI22 Approval (registry: "Approve these exact preparation decisions."). A check-your-answers page (research: app-ui-patterns.md 3,
// GOV.UK): the sealed set (and, for a CRM, the destination), then every effect of the plan, part by part, each with its way back to change
// it; what is not included; the validation's result. Approving names this exact revision of the plan ("Approve revision 6"), asks for
// Kauro's code again with its reason said (research: app-operations-ux.md §2.3: re-asking at approval is rare, so the dialog says why), and is
// its own button outside any form, so the Enter key cannot approve a default nobody saw. The approver may instead request changes, with a
// reason; the plan stays open and no quote is issued. A newer revision voids the approval in progress. Only an approver or an owner approves.
//
// Adapted to the service: "Clean your data" has no destination and no links between records, and its "not included" says what cleaning
// never does (no enrichment from outside sources, nothing deleted without a trace, no promise about a CRM). Proposed (F-02): approving could
// issue the quote at once, so the person who pays finds it waiting.
import { Banner, Button, Field } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { CodeField } from "./auth.tsx";
import { EXAMPLE } from "./example.ts";
import { PageHead, ScreenButton, ScreenLink, Stamp } from "./kit.tsx";
import { n, PLAN, PlanTasks } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI22_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to approve", note: "Every part reviewed and validated: the whole plan, part by part, with what it does not include." },
  { key: "stepup", label: "Confirm it's you", note: "Approving revision 6 asks for Kauro's code, and says why; the code is valid for this one approval." },
  { key: "approved", label: "Approved", note: "Approved: the approval names revision 6, the set and the destination. The next step is the quote." },
  { key: "changes", label: "Request changes", note: "The approver writes what should change and why: the plan stays open, no quote is issued, the operator is told." },
  { key: "sent", label: "Changes requested", note: "Sent back: the plan stays open and no quote exists until a revision is approved." },
  { key: "stale", label: "A newer revision", note: "The plan changed after this page was opened: approval is blocked until the new revision is reviewed." },
  { key: "viewer", label: "Not an approver", note: "Seen by an operator: everything is visible, and an approver or an owner approves." },
];

const STATES = { mapping: "done", identity: "done", relationships: "done", approval: "review" } as const;

function Part({ title, rows, change, ctx, project }: { readonly title: string; readonly rows: readonly string[]; readonly change: string; readonly ctx: PrototypeProps["ctx"]; readonly project: PrototypeProps["project"] }): ReactElement {
  return (
    <div className="kauro-answers-part">
      <h3>{title}</h3>
      <ul>
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
      <ScreenLink to={change} ctx={ctx} project={project.projectId}>
        Change<span className="kauro-visually-hidden"> {title.toLowerCase()}</span>
      </ScreenLink>
    </div>
  );
}

export function Approval({ ctx, state, project }: PrototypeProps): ReactElement {
  const approver = (ctx.agency?.permittedActions ?? []).includes("APPROVE_PLANS") && state !== "viewer";
  const [step, setStep] = useState(state);
  const [agreed, setAgreed] = useState(state === "stepup");
  const approved = step === "approved";
  const workspace = ctx.agency?.displayName ?? "Northwind Data";
  const clean = project.mode === "CLEAN";
  const words = SERVICE[project.mode];
  const stale = state === "stale";
  return (
    <>
      <ProjectHeader current="plan" />
      <PageHead title="Approval" lead="Approve these exact preparation decisions." />
      <PlanTasks ctx={ctx} project={project} current="approval" states={approved ? { ...STATES, approval: "done" } : stale ? { ...STATES, identity: "review", approval: "blocked" } : STATES} />
      {stale ? (
        <Banner tone="warning" title="The plan changed after you opened this page" announce="alert">
          <p>Revision 7 replaced revision 6 at 12:31 PM UTC: 3 groups of duplicates were decided again. Review the new revision before it can be approved.</p>
          <p>
            <ScreenLink to="UI20" ctx={ctx} project={project.projectId}>
              Review the duplicates again
            </ScreenLink>
          </p>
        </Banner>
      ) : null}
      {step === "sent" ? (
        <Banner tone="info" title="Changes requested" announce="status">
          <p>Revision 6 goes back to Priya Nair with your reason. The plan stays open; no quote is issued until a revision is approved.</p>
        </Banner>
      ) : null}
      <section className="kauro-answers" aria-labelledby="answers-h">
        <div className="kauro-answers-head">
          <h2 id="answers-h">{stale ? "The plan, revision 6, replaced" : "The plan, revision 6"}</h2>
          <span className="kauro-muted-text">{stale ? "Revision 7 is not validated yet" : "Validated Oct 20, 2026, 12:20 PM UTC · no blocker"}</span>
        </div>
        <Part title="Files" ctx={ctx} project={project} change="UI16" rows={[`${EXAMPLE.sources.join(" and ")}, sealed`, `${EXAMPLE.unitsText} billable source units`]} />
        {clean ? null : (
          <Part title="Destination" ctx={ctx} project={project} change="UI17" rows={[`${words.destination ?? ""} ${project.mode === "SALESFORCE" ? "org" : "account"} 24816309, through ${words.importer ?? ""}`, "Its settings confirmed on Oct 20, 2026"]} />
        )}
        <Part
          title="Fields"
          ctx={ctx}
          project={project}
          change="UI19"
          rows={[clean ? "9 columns kept, 1 left out (a second e-mail column)" : "9 columns mapped, 1 left out (a second e-mail column)", `Capitals made consistent in ${n(PLAN.namesCapitalised)} names; ${n(PLAN.emailsLowercased)} addresses made lower case`, `${n(PLAN.emailsInvalid)} invalid addresses left empty, each listed in the report`]}
        />
        <Part
          title="Duplicates"
          ctx={ctx}
          project={project}
          change="UI20"
          rows={[`${n(PLAN.unifyGroups)} groups unified, ${n(PLAN.keptApart)} kept apart`, `${n(PLAN.unifiedRows)} contact rows and 253 company rows join another record; each is listed with the row it joined`, "Marketing consent: the most restrictive choice is kept"]}
        />
        {clean ? null : <Part title="Links between records" ctx={ctx} project={project} change="UI21" rows={[`${n(PLAN.links)} contacts linked to their company`, `${n(PLAN.noCompany)} contacts imported without a company, on purpose`]} />}
        <div className="kauro-answers-part kauro-answers-part--out">
          <h3>Not included</h3>
          <ul>
            {clean ? (
              <>
                <li>No data from outside sources is added: Kauro cleans what is in your files.</li>
                <li>No record is deleted without a trace: every row unified or left out is listed with its reason.</li>
                <li>No promise that the files fit a particular CRM: they are clean, standard files.</li>
              </>
            ) : (
              <>
                <li>No field, rule or automation is created in {words.destination}: your team imports the files with its own account.</li>
                <li>Deal owners, while it is not known whether an import may set them.</li>
                <li>Activities, notes and attachments are outside this service.</li>
              </>
            )}
          </ul>
        </div>
      </section>
      {approved ? (
        <section className="kauro-approved" aria-labelledby="approved-h">
          <h2 id="approved-h">Revision 6 is approved</h2>
          <p>
            Approved by {ctx.who.split(",")[0]} on Oct 20, 2026 at 12:40 PM UTC. The approval names revision 6 and the sealed set{clean ? "" : `, and the ${words.destination ?? ""} settings it was checked against`}. The quote is next.
          </p>
          <ScreenButton to="UI23" ctx={ctx} project={project.projectId} variant="primary">
            <span className="kauro-go">See the quote</span>
          </ScreenButton>
          <p className="kauro-proposed">Proposed — the quote issued at approval, waiting for whoever pays (F-02)</p>
          <Stamp>Approved</Stamp>
        </section>
      ) : !approver ? (
        <section className="kauro-next" aria-labelledby="approver-h">
          <p className="kauro-next-label">Who approves</p>
          <h2 id="approver-h">An approver or an owner approves this plan</h2>
          <p>Your role reviews the plan but does not approve it. In {workspace}, the people with the approver or owner role can; Team lists them.</p>
        </section>
      ) : stale || step === "sent" ? null : step === "changes" ? (
        <section className="kauro-approve" aria-labelledby="changes-h">
          <h2 id="changes-h">Request changes</h2>
          <Field id="changes-reason" label="What should change, and why" hint="Priya Nair, who prepared the plan, reads this beside it.">
            {(control) => <textarea {...control} rows={3} defaultValue="Keep group 112 apart: these are two people at the same company, sharing a team inbox." />}
          </Field>
          <div className="kauro-actions">
            <Button variant="primary" onClick={() => setStep("sent")}>
              Send back for changes
            </Button>
            <Button onClick={() => setStep("normal")}>Cancel</Button>
          </div>
        </section>
      ) : (
        <section className="kauro-approve" aria-labelledby="approve-h">
          <h2 id="approve-h">Approve</h2>
          <label className="kauro-confirm">
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
            <span>
              I approve revision 6 of this plan, exactly as listed above, for <bdi>{workspace}</bdi>.
            </span>
          </label>
          {step === "stepup" ? (
            <div className="kauro-approve-code">
              <CodeField id="approve-code" label="Your Kauro code" hint="Approving decides what is prepared from these records, so Kauro asks who you are again. The code works for this approval only." />
              <Button variant="primary" onClick={() => setStep("approved")}>
                Approve revision 6
              </Button>
            </div>
          ) : (
            <div className="kauro-actions">
              <Button variant="primary" disabled={!agreed} onClick={() => setStep("stepup")}>
                Continue to approve
              </Button>
              <Button onClick={() => setStep("changes")}>Request changes</Button>
            </div>
          )}
          {agreed ? null : <p className="kauro-muted">Tick the box to approve this exact revision.</p>}
          <p className="kauro-muted">Nothing is prepared, and nothing is charged, until the plan is approved and its quote is paid.</p>
        </section>
      )}
    </>
  );
}

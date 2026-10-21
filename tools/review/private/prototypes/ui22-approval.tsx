"use client";
// UI22 Approval (registry: "Approve these exact preparation decisions."; Order 11 round 2, research agency-workspace.md §5.11 and
// signed-in-notes.md). A check-your-answers page in one focused column (GOV.UK; HubSpot's import and Wise's flows hide the menu's pull for a
// consequential step): who approves is named before anything else, then the plan read back part by part (Files, Destination, Fields,
// Duplicates, Links, Not included), each with its way back to change it and with the very numbers its own page shows (C-3, C-4). At the foot:
// the declaration, the reason Kauro asks for the code again, the code field (one field, pasted or typed: WCAG 3.3.8), and the one button,
// named by its outcome, "Approve revision 6". Back is on the left, the action on the right; "Request changes" is a quiet link and asks for
// a reason. There is no intermediate "Continue to approve": the code is on the page (one step fewer). Pressing Enter never approves.
//
// Only an approver or an owner approves (roles.ts: an admin does not). Anyone else reads the whole plan, one line naming who can, and a way
// to send them the page; no dead button. The end is a confirmation page that says what happens next and who does it: the billing person
// requests the quote, or, when the approver is an owner, the button to request it.
import { Banner, Button, Field, type Tone } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXAMPLE } from "./example.ts";
import { moment, Only, ScreenButton, ScreenLink } from "./kit.tsx";
import { can, onlyLine, soloWorkspace, whoCan } from "./people.ts";
import { n, PLAN } from "./plan.tsx";
import { SERVICE } from "./service.ts";
import { TIMELINE } from "./timeline.ts";
import { CONFIRMED_AT } from "./ui17-target.tsx";

export const UI22_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to approve", note: "Every part reviewed and checked: who approves, the plan read back part by part, then the declaration, the code and Approve revision 6. A person who cannot approve reads it all and who can." },
  { key: "approved", label: "Approved", note: "The confirmation: revision 6 approved at 12:40 PM UTC, what happens next and who does it (the billing person requests the quote; an owner can request it here)." },
  { key: "changes", label: "Request changes", note: "The approver writes what should change and why: the plan stays open, no quote is issued." },
  { key: "sent", label: "Changes requested", note: "Sent back to the operator with the reason: the plan stays open and no quote exists until a revision is approved." },
  { key: "stale", label: "A newer revision", note: "The plan changed after the page was opened: revision 6 can no longer be approved; the new revision is reviewed first." },
];

/** When the plan was last checked against the sealed files and the destination (a review value, between proposal and approval). */
const CHECKED_AT = "2026-10-20T12:20:00Z";

function Answer({ term, change, ctx, project, children }: { readonly term: string; readonly change?: string; readonly ctx: PrototypeProps["ctx"]; readonly project: PrototypeProps["project"]; readonly children: ReactElement }): ReactElement {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
      {change === undefined ? (
        <dd className="kauro-answers-change" />
      ) : (
        <dd className="kauro-answers-change">
          <ScreenLink to={change} ctx={ctx} project={project.projectId}>
            Change<span className="kauro-visually-hidden"> {term.toLowerCase()}</span>
          </ScreenLink>
        </dd>
      )}
    </div>
  );
}

export function Approval({ ctx, state, project }: PrototypeProps): ReactElement {
  const approver = can(ctx, "approve");
  const payer = can(ctx, "pay");
  const solo = soloWorkspace(ctx);
  const [step, setStep] = useState(state);
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState("");
  const [tried, setTried] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reason, setReason] = useState("Keep the group of rows 2,207 and 10,861 apart: two people at Larch Studio share that phone line.");
  const workspace = ctx.agency?.displayName ?? "Northwind Data";
  const clean = project.mode === "CLEAN";
  const words = SERVICE[project.mode];
  const crm = words.destination ?? "";
  const stale = state === "stale";
  const approved = step === "approved";
  const me = ctx.who.split(",")[0] ?? "You";
  const status: { readonly tone: Tone; readonly text: string } = approved
    ? { tone: "success", text: "Plan approved" }
    : step === "sent"
      ? { tone: "warning", text: "Changes requested" }
      : stale
        ? { tone: "warning", text: "A newer revision to review" }
        : { tone: "info", text: "Ready for approval" };

  if (approved)
    return (
      <>
        <ProjectHeader stage="purchase" title={`Revision ${PLAN.revision} is approved`} status={status} />
        <div className="kauro-focused">
          <section className="kauro-pl-done" aria-labelledby="done-h">
            <h2 id="done-h">
              Approved by {solo ? "you" : approver ? me : "Samuel Osei (Approver)"} on {moment(TIMELINE.approvedAt)}
            </h2>
            <p>
              The approval names revision {PLAN.revision}, the sealed files{clean ? "" : `, and the ${crm} settings it was checked against`}. Kauro prepares exactly this, once the quote is paid.
            </p>
          </section>
          <section className="kauro-pl-section" aria-labelledby="next-h">
            <h2 id="next-h">What happens next</h2>
            {payer ? (
              <p>Request the quote. It is issued from this revision, with the repeat discount your workspace has earned, and is valid 14 days, or until the files are deleted if that comes first.</p>
            ) : (
              <p>
                {whoCan(ctx, "pay")} can now request the quote. It is issued from this revision and is valid 14 days, or until the files are deleted on {moment(TIMELINE.filesKeptUntil)} if that comes first.
              </p>
            )}
          </section>
          <div className="kauro-focused-foot">
            <ScreenLink to="UI13" ctx={ctx} project={project.projectId}>
              Back to the project
            </ScreenLink>
            {payer ? (
              <ScreenButton to="UI23" ctx={ctx} project={project.projectId} variant="primary">
                Request the quote
              </ScreenButton>
            ) : null}
          </div>
        </div>
      </>
    );

  const codeError = tried && !/^\d{6}$/.test(code.replace(/\s/g, "")) ? "Enter the 6 digits your authenticator app shows" : undefined;
  const agreeError = tried && !agreed ? "Tick the box to approve this exact revision" : undefined;
  const approve = (): void => {
    setTried(true);
    if (agreed && /^\d{6}$/.test(code.replace(/\s/g, ""))) setStep("approved");
  };
  const back = clean ? { to: "UI20", label: "Back to duplicates" } : { to: "UI21", label: "Back to links between records" };

  return (
    <>
      <ProjectHeader
        stage="plan"
        title={`Approve revision ${PLAN.revision} of the plan`}
        lead="Read the plan as it will be prepared. Approving it lets the quote be issued; nothing is prepared or charged before the quote is paid."
        status={status}
      />
      <div className="kauro-focused">
        {approver ? (
          <p className="kauro-pl-who">{solo ? "You approve this plan as the workspace's owner." : `Approved by an approver or an owner: ${whoCan(ctx, "approve")}.`}</p>
        ) : (
          <div className="kauro-pl-who-not">
            <Only>{onlyLine(ctx, "approve", "approve this plan")} The plan stays readable here for everyone.</Only>
            <p className="kauro-pl-copy">
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
                  setCopied(true);
                }}
              >
                Copy the link for Samuel Osei
              </Button>
              <span role="status" className="kauro-pl-meta">
                {copied ? "Link copied. It opens this page after Samuel signs in." : ""}
              </span>
            </p>
          </div>
        )}
        {stale ? (
          <Banner tone="warning" title="The plan changed after you opened this page" announce="alert">
            <p>Revision 7 replaced revision 6 at 12:31 PM UTC: three groups of duplicates were decided again. Review the new revision before it can be approved.</p>
            <p>
              <ScreenLink to="UI20" ctx={ctx} project={project.projectId}>
                Review the duplicates again
              </ScreenLink>
            </p>
          </Banner>
        ) : null}
        {step === "sent" ? (
          <Banner tone="info" title="Changes requested" announce="status">
            <p>Revision {PLAN.revision} goes back to Priya Nair (Operator) with your reason. The plan stays open; no quote is issued until a revision is approved.</p>
          </Banner>
        ) : null}
        <p className="kauro-pl-meta">
          {stale ? "Revision 7 is not checked yet." : `Checked against the sealed files${clean ? "" : ` and the ${crm} settings`} on ${moment(CHECKED_AT)}: nothing blocks it.`}
        </p>
        <dl className="kauro-answers kauro-pl-answers">
          <Answer term="Files" change="UI16" ctx={ctx} project={project}>
            <p>
              {EXAMPLE.sources.join(" and ")}, sealed {moment(TIMELINE.sealedAt)} · {EXAMPLE.unitsText} billable source units
            </p>
          </Answer>
          {clean ? null : (
            <Answer term="Destination" change="UI17" ctx={ctx} project={project}>
              <p>
                {project.mode === "SALESFORCE" ? "Salesforce org 00D5g000004XkL2, through Data Loader" : "HubSpot account 24816309, through HubSpot's importer"} · settings confirmed {moment(CONFIRMED_AT)}
              </p>
            </Answer>
          )}
          <Answer term="Fields" change="UI19" ctx={ctx} project={project}>
            <ul>
              <li>{clean ? "Contacts: 5 columns kept, 1 left out (a second E-mail column); companies: 4 kept" : "Contacts: 5 columns mapped, 1 left out (a second E-mail column); companies: 4 mapped"}</li>
              <li>
                Capitals made consistent in {n(PLAN.namesCapitalised)} names; {n(PLAN.emailsLowercased)} addresses made lower case; {n(PLAN.emailsInvalid)} invalid addresses left empty and listed
              </li>
            </ul>
          </Answer>
          <Answer term="Duplicates" change="UI20" ctx={ctx} project={project}>
            <ul>
              <li>
                Contacts: {n(PLAN.unifyGroups)} groups unified and {n(PLAN.keptApart)} kept apart, of {n(PLAN.groups)}; {n(PLAN.unifiedRows)} rows join another record
              </li>
              <li>Companies: {n(PLAN.companiesUnified)} rows join another company with the same domain and name</li>
              <li>Marketing consent: where records disagree, the most restrictive choice is kept</li>
            </ul>
          </Answer>
          {clean ? null : (
            <Answer term="Links" change="UI21" ctx={ctx} project={project}>
              <ul>
                <li>
                  {n(PLAN.links)} of {n(PLAN.output)} contacts linked to their {project.mode === "SALESFORCE" ? "account" : "company"}
                </li>
                <li>
                  {n(PLAN.noCompany)} prepared without one, on purpose: {n(PLAN.emptyCompany)} name none and {n(PLAN.notFound)} name one that is not in companies.xlsx
                </li>
              </ul>
            </Answer>
          )}
          <Answer term="Not included" ctx={ctx} project={project}>
            <ul>
              {clean ? (
                <>
                  <li>No data from outside sources is added: Kauro cleans what is in your files.</li>
                  <li>No record is deleted without a trace: every row unified or left out is listed with its reason.</li>
                  <li>No promise that the files fit a particular CRM.</li>
                </>
              ) : (
                <>
                  <li>No field, rule or automation is created in {crm}: your team imports the files with its own {project.mode === "SALESFORCE" ? "org" : "account"}.</li>
                  <li>{project.mode === "SALESFORCE" ? "Contacts that share an email stay apart while the org's duplicate rules are unknown." : "Deal owners, while it is unknown whether an import may set them."}</li>
                  <li>Activities, notes and attachments are outside this service.</li>
                </>
              )}
            </ul>
          </Answer>
        </dl>

        {!approver || stale || step === "sent" ? (
          <div className="kauro-focused-foot">
            <ScreenLink to={back.to} ctx={ctx} project={project.projectId}>
              {back.label}
            </ScreenLink>
          </div>
        ) : step === "changes" ? (
          <section className="kauro-pl-section" aria-labelledby="changes-h">
            <h2 id="changes-h">Request changes</h2>
            <Field id="changes-reason" label="What should change, and why" hint="Priya Nair (Operator), who prepared the plan, reads this beside it." error={tried && reason.trim() === "" ? "Write what should change, so the plan can be revised" : undefined}>
              {(control) => <textarea {...control} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />}
            </Field>
            <div className="kauro-focused-foot">
              <button type="button" className="kauro-pl-link" onClick={() => setStep("normal")}>
                Cancel
              </button>
              <Button
                variant="primary"
                onClick={() => {
                  setTried(true);
                  if (reason.trim() !== "") setStep("sent");
                }}
              >
                Send back for changes
              </Button>
            </div>
          </section>
        ) : (
          <section className="kauro-pl-section kauro-pl-approve" aria-labelledby="approve-h">
            <h2 id="approve-h">Approve</h2>
            <div className={agreeError === undefined ? "kauro-pl-declare" : "kauro-pl-declare is-error"}>
              {agreeError === undefined ? null : (
                <p className="kauro-pl-error" id="declare-error">
                  {agreeError}
                </p>
              )}
              <label>
                <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} aria-describedby={agreeError === undefined ? undefined : "declare-error"} />
                <span>
                  I approve revision {PLAN.revision} of this plan, exactly as listed above, for <bdi>{workspace}</bdi>.
                </span>
              </label>
            </div>
            <Field id="approve-code" label="Your Kauro code" hint="Approving decides what is prepared from these records, so Kauro asks who you are again." error={codeError}>
              {(control) => <input {...control} name="code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" className="kauro-pl-code" value={code} onChange={(event) => setCode(event.target.value)} />}
            </Field>
            <div className="kauro-focused-foot">
              <ScreenLink to={back.to} ctx={ctx} project={project.projectId}>
                {back.label}
              </ScreenLink>
              <span className="kauro-pl-foot-actions">
                <button type="button" className="kauro-pl-link" onClick={() => setStep("changes")}>
                  Request changes
                </button>
                <Button variant="primary" onClick={approve}>
                  Approve revision {PLAN.revision}
                </Button>
              </span>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

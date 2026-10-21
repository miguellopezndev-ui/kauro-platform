"use client";
// UI27 Import steps and UI28 Import results, one page (Order 11 round 2; research agency-workspace.md §5.16). Round 1 split the stages
// (one page) from each stage's result (another page), so a person importing went back and forth between two pages for one stage; the
// result belongs to its stage, so the stages are now one list and each stage holds its own steps, its result and its check:
//   - before the first stage, the prerequisites and their acknowledgement (Kauro cannot undo an import);
//   - each stage is a row with its file, its rows and the one setting that decides what it may do, and its state in words: Ready to import →
//     Waiting for your result file → Checking the file → Verified: all accounted for / Imported with errors / Cannot read this file;
//   - inside the open stage, the destination's own importer in its own words. For a "Prepare for HubSpot" package that is HubSpot's
//     four steps by their names, Type, Upload, Map, Details (signed-in-notes.md: the importer the operator sees), each saying what to choose
//     and which of Kauro's files goes in; for "Prepare for Salesforce" it is Data Loader's own steps (Insert, Log in, Select data objects,
//     Mapping with the .sdl file Kauro delivers, the directory for its success and error files, Finish). Then "Return the result";
//   - the check of a returned result: Planned, Created, Updated, Rejected, Unaccounted, and the rejected rows to download;
//   - who continues: going on to the next stage is an approver's or an owner's action (CMD041), named by person; operators return results
//     (CMD040). The separate "I have imported stage 1" button is gone: returning the result proves the import.
// A project is never called imported because of a download, and a CRM's success message alone is not proof. "Clean your data" has no import.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { IMPORT_TIMES, RECEIPT_DAYS, type Stage, stagesFor } from "./delivery.ts";
import { moment, Only, ScreenButton, ScreenLink } from "./kit.tsx";
import { can, teamOf, whoCan } from "./people.ts";
import { n } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI27_STATES: readonly StateDef[] = [
  { key: "normal", label: "Before the first stage", note: "The prerequisites to confirm; stage 1 is ready to import with HubSpot's or Data Loader's own steps; later stages cannot start yet." },
  { key: "waiting", label: "Waiting for a result", note: "Stage 1 is being imported by the team: the page waits for its result file, and says how to get it from the CRM." },
  { key: "checking", label: "Checking the result", note: "The result is received and being matched, record by record; nothing is needed meanwhile." },
  { key: "verified", label: "Stage 1 verified", note: "Every prepared row is accounted for; an approver or an owner continues to stage 2." },
  { key: "partial", label: "Imported with errors", note: "12 rows were rejected by the CRM: what that changes for the next stages, the rows to download, and the two ways on." },
  { key: "unreadable", label: "Cannot read the result", note: "The returned file is not the one asked for: the page says why and asks for it again." },
  { key: "second", label: "Stage 2 under way", note: "Stage 1 verified and continued; stage 2 is ready to import." },
  { key: "done", label: "All stages verified", note: "Every stage is verified: the project is completed." },
];

/** UI28's address opens the same list at the stage that waits for its result. */
export const UI28_STATES: readonly StateDef[] = [
  { key: "normal", label: "Waiting for a result", note: "The import page at the stage whose result is due: how to get it from the CRM, and where to return it." },
  { key: "checking", label: "Checking the result", note: "The result is received and being matched, record by record." },
  { key: "verified", label: "Verified", note: "Every prepared row is accounted for; an approver or an owner continues to the next stage." },
  { key: "partial", label: "Imported with errors", note: "Rows rejected by the CRM: the consequence, the rows to download, and the two ways on." },
  { key: "unreadable", label: "Cannot read the result", note: "The returned file is not the one asked for: the reason, and the way to return it again." },
];

type StageState = "ready" | "waiting" | "checking" | "verified" | "partial" | "unreadable" | "locked";

const WORD: Readonly<Record<StageState, string>> = {
  ready: "Ready to import",
  waiting: "Waiting for your result file",
  checking: "Checking the file",
  verified: "Verified: all accounted for",
  partial: "Imported with errors",
  unreadable: "Cannot read this file",
  locked: "Cannot start yet",
};

const REJECTED = 12;

/** The state of each stage in the page's state: the first stage carries the story, the rest wait or are done. */
function statesFor(state: string, count: number): readonly StageState[] {
  const rest = (from: number, value: StageState): StageState[] => Array.from({ length: Math.max(0, count - from) }, () => value);
  switch (state) {
    case "waiting":
      return ["waiting", ...rest(1, "locked")];
    case "checking":
      return ["checking", ...rest(1, "locked")];
    case "verified":
      return ["verified", ...rest(1, "locked")];
    case "partial":
      return ["partial", ...rest(1, "locked")];
    case "unreadable":
      return ["unreadable", ...rest(1, "locked")];
    case "second":
      return ["verified", "ready", ...rest(2, "locked")];
    case "done":
      return rest(0, "verified");
    default:
      return ["ready", ...rest(1, "locked")];
  }
}

const ORDINAL = ["", "one", "two", "three", "four"];

function Reconciliation({ stage, rejected, crm }: { readonly stage: Stage; readonly rejected: number; readonly crm: string }): ReactElement {
  const created = stage.operation.startsWith("Update") ? 0 : stage.rows - rejected;
  const updated = stage.operation.startsWith("Update") ? stage.rows - rejected : 0;
  return (
    <>
    <p className="kauro-im-recon-title" id={`recon-${stage.sequence}`}>
      Stage {stage.sequence}, {stage.name}: what {crm} holds against what was prepared
    </p>
    <table className="kauro-rtable kauro-im-recon" aria-labelledby={`recon-${stage.sequence}`}>
      <thead>
        <tr>
          <th scope="col" className="kauro-num">
            Planned (rows)
          </th>
          <th scope="col" className="kauro-num">
            Created
          </th>
          <th scope="col" className="kauro-num">
            Updated
          </th>
          <th scope="col" className="kauro-num">
            Rejected
          </th>
          <th scope="col" className="kauro-num">
            Unaccounted
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="kauro-num" data-label="Planned">
            {n(stage.rows)}
          </td>
          <td className="kauro-num" data-label="Created">
            {n(created)}
          </td>
          <td className="kauro-num" data-label="Updated">
            {n(updated)}
          </td>
          <td className="kauro-num" data-label="Rejected">
            {n(rejected)}
          </td>
          <td className="kauro-num" data-label="Unaccounted">
            0
          </td>
        </tr>
      </tbody>
    </table>
    </>
  );
}

export function ImportSteps({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const crm = words.destination ?? "";
  const salesforce = project.mode === "SALESFORCE";
  const place = salesforce ? "org" : "account";
  const stages = stagesFor(project.mode);
  const states = statesFor(state, stages.length);
  const operator = can(ctx, "operate");
  const approver = can(ctx, "approve");
  const [acknowledged, setAcknowledged] = useState(state !== "normal");
  const [ticked, setTicked] = useState(false);
  const [tried, setTried] = useState(false);
  const shown = states.map((one) => (one === "ready" && acknowledged ? "waiting" : one));
  const done = state === "done";
  const team = teamOf(ctx);
  const first = team.find((person) => person.role === "OPERATOR") ?? team[0];
  const confirmer = first === undefined ? "your team" : `${first.name} (${first.role === "OPERATOR" ? "Operator" : "Owner"})`;

  if (project.mode === "CLEAN")
    return (
      <>
        <ProjectHeader stage="delivery" title="Import" lead="Clean your data has no import: the cleaned files are yours to use in any tool." />
        <p>Kauro gives no import steps for a particular CRM and checks no import result for this service. The delivery holds the files, the report and the manifest.</p>
        <p>
          <ScreenButton to="UI26" ctx={ctx} project={project.projectId} variant="primary">
            <span className="kauro-go">Go to the delivery</span>
          </ScreenButton>
        </p>
      </>
    );

  // a verified stage is settled once the next one goes on (or every stage is done); until then it stays open with its "continue"
  const settled = (index: number): boolean => shown[index] === "verified" && (done || (shown[index + 1] !== undefined && shown[index + 1] !== "locked"));
  const current = shown.findIndex((_, index) => !settled(index));
  const status = done
    ? { tone: "success" as const, text: "Completed: every stage verified" }
    : shown[current] === "partial" || shown[current] === "unreadable"
      ? { tone: "warning" as const, text: `Stage ${current + 1} needs a decision` }
      : shown[current] === "checking"
        ? { tone: "info" as const, text: `Kauro is checking stage ${current + 1}` }
        : shown[current] === "verified"
          ? { tone: "info" as const, text: `Stage ${current + 1} verified · waiting to continue` }
          : { tone: "info" as const, text: `Stage ${current + 1} of ${stages.length} · prepared for import` };

  return (
    <>
      <ProjectHeader stage="delivery" title="Import" lead="Use the specified tool and settings for each stage." status={status} />

      {done ? (
        <Banner tone="success" title="Every stage is verified: the project is completed" announce="status">
          <p>
            {crm} holds {stages.map((stage) => `${n(stage.rows)} ${stage.name.toLowerCase()}`).join(", ")}, each matched to what was prepared. Each stage&apos;s result is kept {RECEIPT_DAYS} days after its
            check, then deleted. <ScreenLink to="UI13" ctx={ctx} project={project.projectId}>Back to the project</ScreenLink>
          </p>
        </Banner>
      ) : null}

      <section className="kauro-im-before" aria-labelledby="before-h">
        <h2 id="before-h">Before the first stage</h2>
        <ul>
          <li>
            Your team imports, with its own {crm} {place} and {words.importer}. Kauro never connects to {crm}.
          </li>
          <li>Kauro cannot undo an import. Keep a current export of your {words.companies.toLowerCase()} and contacts before stage 1.</li>
          <li>Import the {ORDINAL[stages.length] ?? stages.length} stages in order, with each stage&apos;s settings. After each one, return its result here; the next stage goes on once it is verified.</li>
        </ul>
        {acknowledged ? (
          <p className="kauro-im-ack">
            Confirmed by {confirmer} on {moment(IMPORT_TIMES.acknowledgedAt)}.
          </p>
        ) : operator ? (
          <div className="kauro-im-confirm">
            <label className="kauro-confirm">
              <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
              <span>
                We have read the steps and hold a current export of our {crm} {words.companies.toLowerCase()} and contacts.
              </span>
            </label>
            <Button variant="primary" onClick={() => (ticked ? setAcknowledged(true) : setTried(true))} aria-describedby={tried && !ticked ? "confirm-why" : undefined}>
              Start stage 1
            </Button>
            {tried && !ticked ? (
              <p id="confirm-why" className="kauro-im-hint" role="alert">
                Tick the confirmation first: it says your team holds a current export.
              </p>
            ) : null}
          </div>
        ) : (
          <Only>Only {whoCan(ctx, "operate")} can confirm this and start the import.</Only>
        )}
      </section>

      <section className="kauro-im-stages-wrap" aria-labelledby="stages-h">
        <h2 id="stages-h">The {ORDINAL[stages.length] ?? stages.length} stages</h2>
        <ol className="kauro-im-stages">
          {stages.map((stage, index) => {
            const at = shown[index] ?? "locked";
            const next = stages[index + 1];
            const open = at !== "locked" && !settled(index);
            const tone = at === "verified" ? "done" : at === "partial" || at === "unreadable" ? "attention" : at === "locked" ? "later" : "now";
            return (
              <li key={stage.sequence} className={`kauro-im-stage kauro-im-stage--${tone}`} aria-current={index === current ? "step" : undefined}>
                <div className="kauro-im-stage-head">
                  <h3>
                    <span className="kauro-im-stage-number">Stage {stage.sequence}</span> {stage.name}
                  </h3>
                  <span className="kauro-im-state">{at === "partial" ? `${WORD.partial}: ${REJECTED} rejected` : WORD[at]}</span>
                </div>
                <p className="kauro-im-stage-meta">
                  <code>{stage.file}</code> · {n(stage.rows)} rows · {stage.operation}
                  {stage.after === null ? null : <> · after {stage.after}</>}
                </p>
                {at === "verified" && !open ? (
                  <p className="kauro-im-closed">
                    All {n(stage.rows)} accounted for in {crm}, verified {moment(IMPORT_TIMES.verifiedAt)}.
                  </p>
                ) : null}
                {at === "locked" ? (
                  <p className="kauro-im-closed">
                    {stage.releasedAfter ? `Kauro releases this file once stage ${stage.sequence - 1} is verified, with each contact's AccountId from your stage ${stage.sequence - 1} success file.` : `Starts after stage ${stage.sequence - 1} is verified and continued.`}
                  </p>
                ) : null}

                {open && (at === "ready" || at === "waiting") ? (
                  <div className="kauro-im-body">
                    <h4>
                      In {salesforce ? "Data Loader" : "HubSpot's importer"}
                    </h4>
                    <ol className="kauro-im-steps">
                      {stage.steps.map((one, number) => (
                        <li key={one.name}>
                          <span className="kauro-im-step-name">
                            <span className="kauro-visually-hidden">Step {number + 1}: </span>
                            {one.name}
                          </span>
                          <span className="kauro-im-step-what">
                            {one.what}
                            {one.file === undefined ? null : (
                              <span className="kauro-im-step-file">
                                Kauro&apos;s file: <code>{one.file}</code>
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {at === "waiting" ? (
                      <ReturnResult stage={stage} salesforce={salesforce} operator={operator} who={whoCan(ctx, "operate")} />
                    ) : (
                      <p className="kauro-im-after">When the import finishes, return its result here: the page asks for it once stage 1 is started.</p>
                    )}
                  </div>
                ) : null}

                {open && at === "checking" ? (
                  <div className="kauro-im-body" role="status">
                    <p>
                      {salesforce ? "success.csv and error.csv" : "hubspot-companies-export.csv"}, received {moment(IMPORT_TIMES.resultAt)}. Each prepared row is being looked for in it by its identifying
                      values, never by its position in the file. Nothing is needed from your team meanwhile; this page updates by itself.
                    </p>
                  </div>
                ) : null}

                {open && at === "unreadable" ? (
                  <div className="kauro-im-body">
                    <p className="kauro-im-problem">
                      <strong>Cannot read this file:</strong> {salesforce ? "only the success file was returned; the error file is missing, so rejected rows cannot be counted." : "the export has no Record ID column, so the records cannot be matched to what was prepared."} Nothing was
                      counted from it, and it is deleted.
                    </p>
                    <ReturnResult stage={stage} salesforce={salesforce} operator={operator} who={whoCan(ctx, "operate")} again />
                  </div>
                ) : null}

                {open && (at === "verified" || at === "partial") ? (
                  <div className="kauro-im-body">
                    <Reconciliation stage={stage} rejected={at === "partial" ? REJECTED : 0} crm={crm} />
                    <p className="kauro-im-kept">
                      Checked {moment(IMPORT_TIMES.verifiedAt)}. The result file is kept until {moment(IMPORT_TIMES.resultKeptUntil)}, then deleted.
                    </p>
                    {at === "partial" ? (
                      <>
                        <p>
                          {crm} rejected {REJECTED} {stage.name.toLowerCase()}: 9 because a record with the same {salesforce ? "name" : "domain"} already existed, 3 because a value was not valid for {crm}. Their 41
                          contacts are still imported in stage 2, without {salesforce ? "their account" : "a link to their company"}.{" "}
                          <a href="#rejected" onClick={(event) => event.preventDefault()}>
                            Download the {REJECTED} rejected rows
                          </a>
                        </p>
                        {approver ? (
                          <fieldset className="kauro-choice kauro-im-choice">
                            <legend>How to go on</legend>
                            <label>
                              <input type="radio" name="partial" defaultChecked />
                              <span>
                                <strong>
                                  Continue with the {n(stage.rows - REJECTED)} {stage.name.toLowerCase()} {crm} holds
                                </strong>
                                <small>The 41 contacts go on without {salesforce ? "an account" : "the link"}; the report lists them. The plan allows this scope.</small>
                              </span>
                            </label>
                            <label>
                              <input type="radio" name="partial" />
                              <span>
                                <strong>Correct them in {crm}, then return a new result</strong>
                                <small>Stage {next?.sequence ?? 2} waits until the new result is checked.</small>
                              </span>
                            </label>
                            <Button variant="primary">Confirm how to go on</Button>
                          </fieldset>
                        ) : (
                          <Only>Only {whoCan(ctx, "approve")} can decide how to go on. Your team can correct the rows in {crm} and return a new result meanwhile.</Only>
                        )}
                      </>
                    ) : next === undefined ? null : approver ? (
                      <p className="kauro-im-continue">
                        <Button variant="primary">Continue to stage {next.sequence}</Button>
                        <span>
                          {next.releasedAfter ? `Kauro then releases ${next.file} with each contact's AccountId from this stage's success file.` : `Stage ${next.sequence}, ${next.name}, opens with its steps.`}
                        </span>
                      </p>
                    ) : (
                      <Only>Only {whoCan(ctx, "approve")} can continue to stage {next.sequence}.</Only>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
      <p className="kauro-im-foot">A download is not an import, and a success message from {crm} is not proof on its own: each stage is verified from the result your team returns.</p>
    </>
  );
}

/** Where the result of a stage comes from in the CRM, and the one way to return it. */
function ReturnResult({ stage, salesforce, operator, who, again = false }: { readonly stage: Stage; readonly salesforce: boolean; readonly operator: boolean; readonly who: string; readonly again?: boolean }): ReactElement {
  const id = `return-${stage.sequence}`;
  return (
    <div className="kauro-im-return" aria-labelledby={id}>
      <h4 id={id}>{again ? "Return the result again" : "Return the result"}</h4>
      <ol className="kauro-im-order">
        {salesforce ? (
          <>
            <li>When Data Loader finishes, it writes a success file and an error file in the folder you chose.</li>
            <li>Return both, exactly as Data Loader wrote them.</li>
          </>
        ) : (
          <>
            <li>
              In HubSpot, open the import named &quot;{stage.importName}&quot; from your past imports and view the {stage.name.toLowerCase()} it {stage.operation.startsWith("Update") ? "updated" : "created"}.
            </li>
            <li>Export them with the Record ID column and the column that identifies each record ({stage.name === "Contacts" ? "Email" : stage.sequence === 3 ? "Email and Company domain name" : "Company domain name"}).</li>
            <li>If HubSpot reports errors, download its error file too, and return both.</li>
          </>
        )}
      </ol>
      {operator ? (
        <label className="kauro-im-upload" htmlFor={`${id}-file`}>
          <span className="kauro-button kauro-button-primary">{salesforce ? "Choose the success and error files" : "Choose HubSpot's export"}</span>
          <span className="kauro-im-upload-hint">{salesforce ? "CSV files, as Data Loader wrote them" : "CSV or XLSX, as HubSpot gives it"}. Private to this project.</span>
          <input id={`${id}-file`} type="file" className="kauro-visually-hidden" accept=".csv,.xlsx" multiple />
        </label>
      ) : (
        <Only>Only {who} can return a result.</Only>
      )}
    </div>
  );
}

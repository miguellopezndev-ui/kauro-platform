"use client";
// UI27 Import steps and UI28 Import results, one page (Order 11 round 2; research agency-workspace.md §5.16). The stages are one list and
// each stage holds its own steps, its result and its check:
//   - before the first stage, the prerequisites and their acknowledgement (Kauro cannot undo an import);
//   - each stage is a row with its file, its rows and the one setting that decides what it may do, and its state in words;
//   - inside the open stage, the destination's own importer in its own words: HubSpot's four steps (Type, Upload, Map, Details) or Data
//     Loader's own steps, each saying which of Kauro's files goes in; then "Return the result";
//   - the check of a returned result, and who continues: going on is an approver's or an owner's action (CMD041), named by person;
//     operators return results (CMD040).
// Order 12 (the owner's decision on Salesforce and dependent records): nobody types a Salesforce ID. For each object the page says how its
// records find their parent. Where the org the team confirmed already has an External ID field that holds the source key, the files name the
// parent by that key and Data Loader resolves it (Upsert), so the dependent file is in the package and does not wait for Kauro. Otherwise the
// import is staged: the team imports the parents and returns Data Loader's success and error files; Kauro reconciles them row by row, proves
// each parent's ID from the success file, blocks what it cannot prove (rejected, ambiguous, unmatched, a source key imported twice) with the
// action each needs, and generates the dependent file only for the rows whose parent is proved. The same goes on down the chain: contacts
// and opportunities need their account; contact roles need their contact and their opportunity. HubSpot links records itself by a value both
// already hold (email, company domain), so it needs no generated file; Kauro still checks its error file and the export of each stage.
// Kauro never connects to Salesforce or HubSpot. A project is never called imported because of a download. "Clean your data" has no import.
import { Banner, Button } from "@kauro/ui";
import { Fragment, type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import { stateHref } from "../lib/links.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import { appPathOf } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { ACCOUNT_KEY_FIELD, HUBSPOT_LINK_ERRORS, ID_PREFIX, IMPORT_TIMES, type IdRoute, RECEIPT_DAYS, RECONCILED, STAGE1_BLOCKED, type Stage, stagesFor } from "./delivery.ts";
import { moment, Only, ScreenButton, ScreenLink } from "./kit.tsx";
import { can, teamOf, whoCan } from "./people.ts";
import { n } from "./plan.tsx";
import { SERVICE } from "./service.ts";

/** Osprey Freight's "Prepare for Salesforce" project, where the Salesforce states are drawn. */
const OSPREY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7202";

const SHARED: readonly StateDef[] = [
  { key: "normal", label: "Before the first stage", note: "The prerequisites to confirm; stage 1 is ready to import with HubSpot's or Data Loader's own steps; later stages cannot start yet. On a Salesforce project, the table above the stages says how each object finds its parent." },
  { key: "waiting", label: "Waiting for a result", note: "Stage 1 is being imported by the team: the page waits for its result file, and says how to get it from the CRM." },
  { key: "checking", label: "Checking the result", note: "The result is received and being matched, record by record; nothing is needed meanwhile." },
  { key: "verified", label: "Stage 1 verified", note: "Every prepared row is accounted for; an approver or an owner continues." },
  { key: "partial", label: "Imported with errors", note: "12 rows were rejected by the CRM: what that changes for the next stages, the rows to download, and the two ways on." },
  { key: "unreadable", label: "Cannot read the result", note: "The returned file is not the one asked for: the page says why and asks for it again." },
];

const SALESFORCE_STATES: readonly StateDef[] = [
  {
    key: "sf-external-id",
    label: "Salesforce: parents by an External ID",
    note: `Osprey Freight (Prepare for Salesforce). The org settings the team confirmed show ${ACCOUNT_KEY_FIELD} on Account: an External ID field, unique, that already holds the source key. Accounts are upserted on it; contacts and opportunities name their account by the key, so their files are in the package and do not wait for Kauro. Contact roles still need Salesforce IDs and are generated after stages 2 and 3. Kauro never asks for a new field.`,
  },
  {
    key: "sf-reconciled",
    label: "Salesforce: stage 1 reconciled, rows blocked",
    note: `Osprey Freight. No External ID holds the source key, so the import is staged. Stage 1's success and error files are reconciled: ${n(RECONCILED.proved)} accounts proved, ${n(RECONCILED.blocked)} blocked with their reason and action (rejected by Salesforce with its error, no row at all, a source key imported twice, an ambiguous match). Stages 2 and 3 are generated only for rows whose account is proved; their dependents of blocked accounts are held back.`,
  },
  {
    key: "sf-chain",
    label: "Salesforce: the chain down to contact roles",
    note: "Osprey Freight. Accounts, then contacts and opportunities (each needs only its account, either order), then contact roles (each needs its contact and its opportunity): stages 1 to 3 verified, stage 4 generated from stages 2 and 3's success files and waiting for its result.",
  },
];

const HUBSPOT_STATES: readonly StateDef[] = [
  {
    key: "hs-links",
    label: "HubSpot: links checked from the result",
    note: `Larch Studio (Prepare for HubSpot). HubSpot links contacts to companies itself by email and company domain, so no ID file is generated. Stage 3's result is still checked: HubSpot's error file lists ${HUBSPOT_LINK_ERRORS.rows} links it could not make, each with its row and the action.`,
  },
];

export const UI27_STATES: readonly StateDef[] = [
  ...SHARED,
  { key: "second", label: "Stage 2 under way", note: "Stage 1 verified and continued; the stages that need only stage 1 are ready to import." },
  { key: "done", label: "All stages verified", note: "Every stage is verified: the project is completed." },
  ...SALESFORCE_STATES,
  ...HUBSPOT_STATES,
];

/** UI28's address opens the same list at the stage that waits for its result. */
export const UI28_STATES: readonly StateDef[] = [
  { key: "normal", label: "Waiting for a result", note: "The import page at the stage whose result is due: how to get it from the CRM, and where to return it." },
  { key: "checking", label: "Checking the result", note: "The result is received and being matched, record by record." },
  { key: "verified", label: "Verified", note: "Every prepared row is accounted for; an approver or an owner continues to the next stage." },
  { key: "partial", label: "Imported with errors", note: "Rows rejected by the CRM: the consequence, the rows to download, and the two ways on." },
  { key: "unreadable", label: "Cannot read the result", note: "The returned file is not the one asked for: the reason, and the way to return it again." },
  SALESFORCE_STATES[1] as StateDef,
  ...HUBSPOT_STATES,
];

type StageState = "ready" | "waiting" | "after" | "checking" | "verified" | "partial" | "unreadable" | "reconciled" | "generated" | "locked";

const WORD: Readonly<Record<StageState, string>> = {
  ready: "Ready to import",
  waiting: "Waiting for your result file",
  after: "In the package · import after stage 1",
  checking: "Checking the file",
  verified: "Verified: all accounted for",
  partial: "Imported with errors",
  unreadable: "Cannot read this file",
  reconciled: `Reconciled: ${n(RECONCILED.blocked)} rows blocked`,
  generated: "Generated · waiting to be released",
  locked: "Cannot start yet",
};

const REJECTED = 12;
const ORDINAL = ["", "one", "two", "three", "four"];

/** The state of each stage in the page's state. */
function statesFor(state: string, stages: readonly Stage[]): readonly StageState[] {
  const all = (pick: (stage: Stage, index: number) => StageState): StageState[] => stages.map(pick);
  const first = (value: StageState): StageState[] => all((_, index) => (index === 0 ? value : "locked"));
  switch (state) {
    case "waiting":
      return first("waiting");
    case "checking":
      return first("checking");
    case "verified":
      return first("verified");
    case "partial":
      return first("partial");
    case "unreadable":
      return first("unreadable");
    case "second":
      return all((stage, index) => (index === 0 ? "verified" : stage.dependsOn.every((one) => one === 1) ? "ready" : "locked"));
    case "done":
      return all(() => "verified");
    case "sf-external-id":
      return all((stage, index) => (index === 0 ? "waiting" : !stage.generated && stage.dependsOn.every((one) => one === 1) ? "after" : "locked"));
    case "sf-reconciled":
      return all((stage, index) => (index === 0 ? "reconciled" : stage.generated && stage.dependsOn.every((one) => one === 1) ? "generated" : "locked"));
    case "sf-chain":
      return all((_, index) => (index === stages.length - 1 ? "waiting" : "verified"));
    case "hs-links":
      return all((_, index) => (index === stages.length - 1 ? "partial" : "verified"));
    default:
      return first("ready");
  }
}

/**
 * A Salesforce API name or status code ("OpportunityContactRole", "FIELD_CUSTOM_VALIDATION_EXCEPTION", "Osprey_Account_Key__c") in mono, allowed
 * to break only where it is read in parts: after an underscore, or before a capital that starts a word. Never in the middle of a word.
 */
function Api({ name, small = false }: { readonly name: string; readonly small?: boolean }): ReactElement {
  const parts = name.split(/(?<=_)(?!_)(?!c$)|(?<=[a-z])(?=[A-Z])/);
  return (
    <code className={small ? "kauro-im-api kauro-im-api--small" : "kauro-im-api"}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <wbr />}
          {part}
        </Fragment>
      ))}
    </code>
  );
}

const listOf = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

function Reconciliation({ stage, rejected, crm, proved }: { readonly stage: Stage; readonly rejected: number; readonly crm: string; readonly proved: boolean }): ReactElement {
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
            {proved ? (
              <th scope="col" className="kauro-num">
                ID proved
              </th>
            ) : null}
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
            {proved ? (
              <td className="kauro-num" data-label="ID proved">
                {n(stage.rows - rejected)}
              </td>
            ) : null}
          </tr>
        </tbody>
      </table>
    </>
  );
}

/** How each Salesforce object finds its parent, and so when its file is ready (the identifier route chosen per object). */
function Routes({ stages, route }: { readonly stages: readonly Stage[]; readonly route: IdRoute }): ReactElement {
  const name = (sequence: number): string => stages.find((stage) => stage.sequence === sequence)?.object ?? "";
  return (
    <section className="kauro-im-routes" aria-labelledby="routes-h">
      <h2 id="routes-h">How each record finds its parent</h2>
      {route === "EXTERNAL_ID" ? (
        <p>
          The org settings your team confirmed show <Api name={ACCOUNT_KEY_FIELD} /> on Account: an External ID field, unique, that already holds the key your source files use. Contacts and
          opportunities name their account by that key, and Data Loader finds it, so their files are in the package now. Contact and Opportunity have no such field in your org, so contact roles
          use the IDs Salesforce gives, and Kauro writes them for you.
        </p>
      ) : (
        <p>
          The org settings your team confirmed show no External ID field that holds your source keys, so links use the IDs Salesforce gives at import. Kauro reads each one from the success file
          your team returns, checks it, and writes it into the next stage&apos;s file. Nobody types an ID, and no new field is needed in Salesforce.
        </p>
      )}
      <table className="kauro-rtable kauro-im-routes-table">
        <thead>
          <tr>
            <th scope="col">Records</th>
            <th scope="col">Parent</th>
            <th scope="col">How the link is written</th>
            <th scope="col">File ready</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage) => (
            <tr key={stage.sequence}>
              <td data-label="">
                <strong>
                  {stage.sequence}. {stage.name}
                </strong>
                <Api name={stage.object} small />
              </td>
              <td data-label="Parent">{stage.dependsOn.length === 0 ? "None: imported first" : listOf(stage.dependsOn.map(name))}</td>
              <td data-label="Written as">
                {stage.links.length === 0 ? (
                  stage.operation.startsWith("Upsert") ? (
                    <>
                      Matched on <Api name={ACCOUNT_KEY_FIELD} />
                    </>
                  ) : (
                    "—"
                  )
                ) : (
                  <span className="kauro-im-route-links">
                    {stage.links.map((link) => (
                      <span key={link.field} className="kauro-im-route-link">
                        <Api name={link.field} /> from {link.from}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td data-label="File ready">{stage.generated ? `Generated by Kauro after stage${stage.dependsOn.length > 1 ? "s" : ""} ${listOf(stage.dependsOn.map(String))} ${stage.dependsOn.length > 1 ? "are" : "is"} verified` : "In the package now"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="kauro-im-order-note">
        Order: accounts first; then contacts and opportunities, in either order, since each needs only its account; contact roles last, since each needs its contact and its opportunity.
      </p>
    </section>
  );
}

/** Stage 1 reconciled with rows blocked: the proof, each reason with its action, and the dependent files generated for proved rows only. */
function Blocked({ approver, operator, ctx, stage, stages }: { readonly approver: boolean; readonly operator: boolean; readonly ctx: PrototypeProps["ctx"]; readonly stage: Stage; readonly stages: readonly Stage[] }): ReactElement {
  const dependents = stages.filter((one) => one.generated && one.dependsOn.every((parent) => parent === stage.sequence));
  return (
    <div className="kauro-im-body">
      <p className="kauro-im-recon-title" id="recon-sf">
        Stage 1, Accounts: what the success and error files prove
      </p>
      <table className="kauro-rtable kauro-im-recon" aria-labelledby="recon-sf">
        <thead>
          <tr>
            <th scope="col" className="kauro-num">
              Planned (rows)
            </th>
            <th scope="col" className="kauro-num">
              Created
            </th>
            <th scope="col" className="kauro-num">
              Rejected
            </th>
            <th scope="col" className="kauro-num">
              No row
            </th>
            <th scope="col" className="kauro-num">
              ID proved
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="kauro-num" data-label="Planned">
              {n(RECONCILED.planned)}
            </td>
            <td className="kauro-num" data-label="Created">
              {n(RECONCILED.created)}
            </td>
            <td className="kauro-num" data-label="Rejected">
              {n(RECONCILED.rejected)}
            </td>
            <td className="kauro-num" data-label="No row">
              {n(RECONCILED.noRow)}
            </td>
            <td className="kauro-num" data-label="ID proved">
              {n(RECONCILED.proved)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="kauro-im-kept">
        An account&apos;s ID is proved when exactly one success row carries its source key and an Account ID (it starts with {ID_PREFIX["Account"]}). Created counts every record Salesforce made, the two
        accounts imported twice counted twice. Checked {moment(IMPORT_TIMES.verifiedAt)}; the result files are kept until {moment(IMPORT_TIMES.resultKeptUntil)}, then deleted.
      </p>

      <h4 id="blocked-h">
        {n(RECONCILED.blocked)} accounts blocked, and what each needs
      </h4>
      <table className="kauro-rtable kauro-im-blocked" aria-labelledby="blocked-h">
        <thead>
          <tr>
            <th scope="col">Reason</th>
            <th scope="col" className="kauro-num">
              Rows
            </th>
            <th scope="col">What the files show</th>
            <th scope="col">What to do</th>
          </tr>
        </thead>
        <tbody>
          {STAGE1_BLOCKED.map((one) => (
            <tr key={one.key}>
              <td data-label="">
                <strong>{one.reason}</strong>
                <span className="kauro-sub">
                  For example <code>{one.example.sourceKey}</code> {one.example.name}
                </span>
              </td>
              <td className="kauro-num" data-label="Rows">
                {n(one.rows)}
              </td>
              <td data-label="The files show">
                {one.code === null ? null : (
                  <>
                    Error file: <Api name={one.code} />.{" "}
                  </>
                )}
                {one.evidence}
              </td>
              <td data-label="What to do">{one.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <a href="#blocked" onClick={(event) => event.preventDefault()}>
          Download the {n(RECONCILED.blocked)} blocked rows, each with its reason and action
        </a>
      </p>

      <div className="kauro-im-generated" aria-labelledby="generated-h">
        <h4 id="generated-h">Generated for the {n(RECONCILED.proved)} proved accounts</h4>
        <ul>
          {dependents.map((one) => {
            const made = one.object === "Contact" ? RECONCILED.generatedContacts : RECONCILED.generatedOpportunities;
            const held = one.object === "Contact" ? RECONCILED.heldContacts : RECONCILED.heldOpportunities;
            return (
              <li key={one.sequence}>
                <code>{one.file}</code>
                <span>
                  {n(made)} {one.name.toLowerCase()} · {n(held)} held back until their account is proved
                </span>
              </li>
            );
          })}
        </ul>
        <p className="kauro-im-kept">
          Each AccountId comes from the success file with fingerprint <code>{RECONCILED.evidence.slice(0, 12)}…</code>, appears once in it, and belongs to the row with the account&apos;s source key.
          A held-back row gets its own small file once a new result proves its account; nothing is written with a guessed ID.
        </p>
      </div>

      {operator ? (
        <ReturnResult stage={stage} salesforce operator={operator} who={whoCan(ctx, "operate")} again quiet title="Return a new result for the blocked rows" />
      ) : null}
      {approver ? (
        <p className="kauro-im-continue">
          <Button variant="primary">Release stages {listOf(dependents.map((one) => String(one.sequence)))}</Button>
          <span>For the proved accounts; the blocked rows follow when they are proved.</span>
        </p>
      ) : (
        <Only>Only {whoCan(ctx, "approve")} can release stages {listOf(dependents.map((one) => String(one.sequence)))}.</Only>
      )}
    </div>
  );
}

export function ImportSteps({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const crm = words.destination ?? "";
  const salesforce = project.mode === "SALESFORCE";
  const place = salesforce ? "org" : "account";
  const route: IdRoute = state === "sf-external-id" ? "EXTERNAL_ID" : "SALESFORCE_ID";
  const stages = stagesFor(project.mode, route);
  const states = statesFor(state, stages);
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

  // a review state that belongs to the other CRM's project points there, so its header, menu and data agree
  const wrongProject = (state.startsWith("sf-") && !salesforce) || (state.startsWith("hs-") && salesforce);
  if (wrongProject) {
    const target = state.startsWith("sf-") ? OSPREY : IDS.project;
    return (
      <>
        <ProjectHeader stage="delivery" title="Import" lead="Use the specified tool and settings for each stage." />
        <Banner tone="info" title={state.startsWith("sf-") ? "This state belongs to a Salesforce project" : "This state belongs to a HubSpot project"} announce="status">
          <p>
            It is drawn on {state.startsWith("sf-") ? "Osprey Freight's Prepare for Salesforce project" : "Larch Studio's Prepare for HubSpot project"}, so its header, menu and files agree.{" "}
            <a href={stateHref(appPathOf("UI27", ctx, target), ctx.key, state)}>Open it there</a>
          </p>
        </Banner>
      </>
    );
  }

  const dependents = (index: number): readonly number[] => stages.flatMap((stage, at) => (stage.dependsOn.includes(index + 1) ? [at] : []));
  // a verified stage is settled once every stage that needs it goes on (or every stage is done); until then it stays open
  const settled = (index: number): boolean =>
    shown[index] === "verified" && (done || (dependents(index).length > 0 && dependents(index).every((at) => shown[at] !== "locked")));
  const current = shown.findIndex((_, index) => !settled(index));
  const at0 = shown[current];
  const status = done
    ? { tone: "success" as const, text: "Completed: every stage verified" }
    : at0 === "partial" || at0 === "unreadable" || at0 === "reconciled"
      ? { tone: "warning" as const, text: `Stage ${current + 1} needs a decision` }
      : at0 === "checking"
        ? { tone: "info" as const, text: `Kauro is checking stage ${current + 1}` }
        : at0 === "verified"
          ? { tone: "info" as const, text: `Stage ${current + 1} verified · waiting to continue` }
          : { tone: "info" as const, text: `Stage ${current + 1} of ${stages.length} · prepared for import` };
  const exportOf = listOf(stages.filter((stage) => stage.dependsOn.length === 0 || stage.object !== "Contacts and Companies").map((stage) => stage.name.toLowerCase()));

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
          <li>Kauro cannot undo an import. Keep a current export of your {exportOf} before stage 1.</li>
          <li>Import the {ORDINAL[stages.length] ?? stages.length} stages in order, with each stage&apos;s settings. After each one, return its result here; a stage that needs it goes on once it is verified.</li>
        </ul>
        {acknowledged ? (
          <p className="kauro-im-ack">
            Confirmed by {confirmer} on {moment(IMPORT_TIMES.acknowledgedAt)}.
          </p>
        ) : operator ? (
          <div className="kauro-im-confirm">
            <label className="kauro-confirm">
              <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
              <span>We have read the steps and hold a current export of our {crm} {exportOf}.</span>
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

      {salesforce ? <Routes stages={stages} route={route} /> : null}

      <section className="kauro-im-stages-wrap" aria-labelledby="stages-h">
        <h2 id="stages-h">The {ORDINAL[stages.length] ?? stages.length} stages</h2>
        <ol className="kauro-im-stages">
          {stages.map((stage, index) => {
            const at = shown[index] ?? "locked";
            const open = at !== "locked" && at !== "generated" && at !== "after" && !settled(index);
            const tone = at === "verified" ? "done" : at === "partial" || at === "unreadable" || at === "reconciled" ? "attention" : at === "locked" || at === "generated" || at === "after" ? "later" : "now";
            const next = stages.find((one) => one.dependsOn.includes(stage.sequence));
            // the stages this one alone opens (Salesforce: contacts and opportunities both need only the accounts)
            const opens = stages.filter((one) => one.dependsOn.length > 0 && one.dependsOn.every((parent) => parent === stage.sequence));
            const opensText = `stage${opens.length > 1 ? "s" : ""} ${listOf(opens.map((one) => String(one.sequence)))}`;
            const waitFor = listOf(stage.dependsOn.map(String));
            const word = at === "partial" ? `${WORD.partial}: ${stage.object === "Contacts and Companies" ? HUBSPOT_LINK_ERRORS.rows : REJECTED} ${stage.object === "Contacts and Companies" ? "links not made" : "rejected"}` : at === "after" ? `In the package · import after stage ${waitFor}` : WORD[at];
            return (
              <li key={stage.sequence} className={`kauro-im-stage kauro-im-stage--${tone}`} aria-current={index === current ? "step" : undefined}>
                <div className="kauro-im-stage-head">
                  <h3>
                    <span className="kauro-im-stage-number">Stage {stage.sequence}</span> {stage.name}
                  </h3>
                  <span className="kauro-im-state">{word}</span>
                </div>
                <p className="kauro-im-stage-meta">
                  <code>{stage.file}</code> · {n(stage.rows)} rows · {stage.operation}
                  {stage.dependsOn.length === 0 ? null : <> · after {listOf(stage.dependsOn.map((one) => stages[one - 1]?.name ?? ""))}</>}
                </p>
                {at === "verified" && !open ? (
                  <p className="kauro-im-closed">
                    All {n(stage.rows)} accounted for in {crm}
                    {salesforce ? `, every ID proved from the success file` : ""}, verified {moment(IMPORT_TIMES.verifiedAt)}.
                  </p>
                ) : null}
                {at === "locked" ? (
                  <p className="kauro-im-closed">
                    {stage.generated
                      ? `Kauro generates this file once stage${stage.dependsOn.length > 1 ? "s" : ""} ${waitFor} ${stage.dependsOn.length > 1 ? "are" : "is"} verified, writing ${listOf(stage.links.map((link) => link.field))} from ${stage.dependsOn.length > 1 ? "their" : "its"} success file${stage.dependsOn.length > 1 ? "s" : ""}, for the rows whose parent${stage.links.length > 1 ? "s are" : " is"} proved.`
                      : `Starts after stage ${waitFor} ${stage.dependsOn.length > 1 ? "are" : "is"} verified and continued.`}
                  </p>
                ) : null}
                {at === "generated" ? (
                  <p className="kauro-im-closed">
                    Generated {moment(IMPORT_TIMES.verifiedAt)} for {n(stage.object === "Contact" ? RECONCILED.generatedContacts : RECONCILED.generatedOpportunities)} rows whose account is proved;{" "}
                    {n(stage.object === "Contact" ? RECONCILED.heldContacts : RECONCILED.heldOpportunities)} held back. Its steps open once stage {waitFor} releases it.
                  </p>
                ) : null}
                {at === "after" ? (
                  <details className="kauro-im-later">
                    <summary>In the package now: import right after stage {waitFor}</summary>
                    <p>
                      Each row names its account by <Api name={ACCOUNT_KEY_FIELD} />, so it does not wait for Kauro. Return its success and error files here when Data Loader finishes.
                    </p>
                    <Steps stage={stage} salesforce />
                  </details>
                ) : null}

                {open && (at === "ready" || at === "waiting") ? (
                  <div className="kauro-im-body">
                    {stage.generated ? (
                      <p className="kauro-im-kept">
                        Generated by Kauro: {listOf(stage.links.map((link) => link.field))} {stage.links.length > 1 ? "were" : "was"} written from the verified success file{stage.links.length > 1 ? "s" : ""} of stage
                        {stage.dependsOn.length > 1 ? "s" : ""} {waitFor}, each ID checked to appear once with its record&apos;s source key.
                      </p>
                    ) : null}
                    <Steps stage={stage} salesforce={salesforce} />
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
                      {salesforce ? "success.csv and error.csv" : "hubspot-companies-export.csv"}, received {moment(IMPORT_TIMES.resultAt)}. Each prepared row is being looked for in it by its source key, never by
                      its position in the file or by a name alone. Nothing is needed from your team meanwhile; this page updates by itself.
                    </p>
                  </div>
                ) : null}

                {open && at === "unreadable" ? (
                  <div className="kauro-im-body">
                    <p className="kauro-im-problem">
                      <strong>Cannot read this file:</strong>{" "}
                      {salesforce ? "only the success file was returned; the error file is missing, so rejected rows cannot be counted." : "the export has no Record ID column, so the records cannot be matched to what was prepared."}{" "}
                      Nothing was counted from it, and it is deleted.
                    </p>
                    <ReturnResult stage={stage} salesforce={salesforce} operator={operator} who={whoCan(ctx, "operate")} again />
                  </div>
                ) : null}

                {open && at === "reconciled" ? <Blocked approver={approver} operator={operator} ctx={ctx} stage={stage} stages={stages} /> : null}

                {open && at === "partial" && stage.object === "Contacts and Companies" ? (
                  <div className="kauro-im-body">
                    <Reconciliation stage={stage} rejected={HUBSPOT_LINK_ERRORS.rows} crm={crm} proved={false} />
                    <p>
                      HubSpot&apos;s error file lists {HUBSPOT_LINK_ERRORS.rows} links it could not make: {HUBSPOT_LINK_ERRORS.notFoundCompany} rows name a company domain HubSpot does not hold, and{" "}
                      {HUBSPOT_LINK_ERRORS.notFoundContact} rows an email it does not hold. Each row is in the file below with what to do: import the missing record, or correct the value, then return
                      this stage&apos;s new result.{" "}
                      <a href="#rejected" onClick={(event) => event.preventDefault()}>
                        Download the {HUBSPOT_LINK_ERRORS.rows} links not made
                      </a>
                    </p>
                    <p className="kauro-im-kept">
                      Checked {moment(IMPORT_TIMES.verifiedAt)}. The result files are kept until {moment(IMPORT_TIMES.resultKeptUntil)}, then deleted.
                    </p>
                  </div>
                ) : null}

                {open && (at === "verified" || (at === "partial" && stage.object !== "Contacts and Companies")) ? (
                  <div className="kauro-im-body">
                    <Reconciliation stage={stage} rejected={at === "partial" ? REJECTED : 0} crm={crm} proved={salesforce} />
                    <p className="kauro-im-kept">
                      Checked {moment(IMPORT_TIMES.verifiedAt)}. The result files are kept until {moment(IMPORT_TIMES.resultKeptUntil)}, then deleted.
                    </p>
                    {at === "partial" ? (
                      <>
                        <p>
                          {crm} rejected {REJECTED} {stage.name.toLowerCase()}: 9 because a record with the same {salesforce ? "name" : "domain"} already existed, 3 because a value was not valid for {crm}.{" "}
                          {salesforce
                            ? "Their contacts and opportunities are held back until each account is proved; nothing is written without its ID."
                            : "Their 41 contacts are still imported in stage 2, without a link to their company."}{" "}
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
                                <small>{salesforce ? "The held-back rows follow when their account is proved." : "The 41 contacts go on without the link; the report lists them. The plan allows this scope."}</small>
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
                        <Button variant="primary">Continue to {opens.length > 0 ? opensText : `stage ${next.sequence}`}</Button>
                        <span>
                          {next.generated
                            ? `Kauro then generates ${listOf(opens.map((one) => one.file))}, each ${listOf(next.links.map((link) => link.field))} written from this stage's success file.`
                            : `Stage ${next.sequence}, ${next.name}, opens with its steps.`}
                        </span>
                      </p>
                    ) : (
                      <Only>Only {whoCan(ctx, "approve")} can continue to {opens.length > 0 ? opensText : `stage ${next.sequence}`}.</Only>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      {salesforce ? null : (
        <section className="kauro-im-hubspot" aria-labelledby="hs-links-h">
          <h2 id="hs-links-h">How the links are checked in HubSpot</h2>
          <p>
            HubSpot&apos;s importer links a contact to its company itself, by a value both already hold: the contact&apos;s email and the company&apos;s domain name. So there is no ID for anyone to type and
            no file for Kauro to generate between stages. Kauro still checks every stage: the export of what it created, with each Record ID, and HubSpot&apos;s error file, where a link it could not make
            is listed with its row.
          </p>
        </section>
      )}

      <p className="kauro-im-foot">A download is not an import, and a success message from {crm} is not proof on its own: each stage is verified from the result your team returns.</p>
    </>
  );
}

/** The destination's own importer steps for a stage, each with the Kauro file it takes. */
function Steps({ stage, salesforce }: { readonly stage: Stage; readonly salesforce: boolean }): ReactElement {
  return (
    <>
      <h4>In {salesforce ? "Data Loader" : "HubSpot's importer"}</h4>
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
    </>
  );
}

/** Where the result of a stage comes from in the CRM, and the one way to return it. */
function ReturnResult({
  stage,
  salesforce,
  operator,
  who,
  again = false,
  quiet = false,
  title,
}: {
  readonly stage: Stage;
  readonly salesforce: boolean;
  readonly operator: boolean;
  readonly who: string;
  readonly again?: boolean;
  readonly quiet?: boolean;
  readonly title?: string;
}): ReactElement {
  const id = `return-${stage.sequence}${quiet ? "-blocked" : ""}`;
  return (
    <div className="kauro-im-return" aria-labelledby={id}>
      <h4 id={id}>{title ?? (again ? "Return the result again" : "Return the result")}</h4>
      <ol className="kauro-im-order">
        {salesforce ? (
          <>
            <li>When Data Loader finishes, it writes a success file and an error file in the folder you chose. Both keep Kauro&apos;s source key column as it was.</li>
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
          <span className={quiet ? "kauro-button kauro-button-secondary" : "kauro-button kauro-button-primary"}>{salesforce ? "Choose the success and error files" : "Choose HubSpot's export"}</span>
          <span className="kauro-im-upload-hint">{salesforce ? "CSV files, as Data Loader wrote them" : "CSV or XLSX, as HubSpot gives it"}. Private to this project.</span>
          <input id={`${id}-file`} type="file" className="kauro-visually-hidden" accept=".csv,.xlsx" multiple />
        </label>
      ) : (
        <Only>Only {who} can return a result.</Only>
      )}
    </div>
  );
}

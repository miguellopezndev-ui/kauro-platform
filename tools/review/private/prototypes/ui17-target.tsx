"use client";
// UI17 Destination (registry: "Confirm the destination and import method."; Order 11 round 2, research agency-workspace.md §5.5). The team
// gives Kauro its destination's own settings, exported from the CRM (CreateTargetContract: a metadata file and the importer's profile);
// Kauro reads them into a draft (TargetContractView); an approver or an owner confirms that exact draft (ConfirmTargetContract, CMD019);
// then the free data health check can start on it. Every fact Kauro read says whether it is Confirmed, Unknown or Needs your answer: an
// unknown fact holds back the part of the plan it affects and is never guessed (registry exceptions). The page names the person who
// confirms, and says when the settings were read and how long they can be confirmed (an observation is at most 24 hours old when it is
// confirmed: packages/domain/src/model/target-contract.ts). Nothing on the page suggests a connection to the CRM: Kauro reads an exported
// file and never signs in to HubSpot or Salesforce.
//
// "Clean your data" has no destination (the owner's decision of 2026-10-20; the backend still asks for a target contract, gap F-01): the
// page says so in the service's own name and what the service produces, and leads to the check.
import { Banner, Button, StatusBadge, type Tone } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { moment, Only, ScreenButton } from "./kit.tsx";
import { can, onlyLine, soloWorkspace, whoCan } from "./people.ts";
import { SERVICE } from "./service.ts";

export const UI17_STATES: readonly StateDef[] = [
  { key: "normal", label: "Read, to confirm", note: "Kauro read the exported settings: the account, three objects and the importer. One fact needs an answer; the approver or an owner confirms the rest." },
  { key: "provide", label: "Settings to give", note: "No settings yet: how to export them from the CRM, and where to upload the file. Kauro never connects to the CRM." },
  { key: "confirmed", label: "Confirmed", note: "The approver confirmed the exact settings: the free data health check can start." },
  { key: "stale", label: "Settings too old", note: "The settings were read more than 24 hours ago and can no longer be confirmed: export them again." },
];

/** When Kauro read the settings, and when the approver confirmed them (review values, before the files were sealed at 9:58 AM). */
const READ_AT = "2026-10-20T09:40:00Z";
export const CONFIRMED_AT = "2026-10-20T09:52:00Z";
const STALE_READ_AT = "2026-10-18T15:10:00Z";
/** An observation is confirmed within 24 hours of being read (target-contract.ts). */
const CONFIRM_HOURS = 24;

type FactState = "confirmed" | "unknown" | "answer";
const FACT_WORD: Readonly<Record<FactState, string>> = { confirmed: "Confirmed", unknown: "Unknown", answer: "Needs your answer" };
const FACT_TONE: Readonly<Record<FactState, Tone>> = { confirmed: "success", unknown: "warning", answer: "info" };

interface Fact {
  readonly what: string;
  readonly value: string;
  readonly state: FactState;
  /** What follows from it, for an unknown fact or a question. */
  readonly effect?: string;
}

function factsFor(mode: "HUBSPOT" | "SALESFORCE"): readonly Fact[] {
  if (mode === "SALESFORCE")
    return [
      { what: "Org", value: "Salesforce org 00D5g000004XkL2 (production)", state: "confirmed" },
      { what: "Import method", value: "Data Loader, insert", state: "confirmed" },
      { what: "Contact", value: "72 fields; Last Name required", state: "confirmed" },
      { what: "Account", value: "58 fields; Account Name required; names need not be unique", state: "confirmed" },
      { what: "Opportunity", value: "44 fields; Name, Stage and Close Date required", state: "confirmed" },
      { what: "Duplicate rules on Contact", value: "Not in the exported file", state: "unknown", effect: "Until it is known, contacts that share an email are kept apart in the files and listed. Ask your Salesforce administrator, then export the settings again." },
      { what: "Record owner", value: "Who owns the imported records", state: "answer", effect: "Choose the user who runs Data Loader, or one user for every record." },
    ];
  return [
    { what: "Account", value: "HubSpot account 24816309", state: "confirmed" },
    { what: "Import method", value: "HubSpot's importer, advanced import (several objects)", state: "confirmed" },
    { what: "Contacts", value: "94 properties; Email is unique", state: "confirmed" },
    { what: "Companies", value: "61 properties; Company domain name is not unique", state: "confirmed" },
    { what: "Deals", value: "48 properties; Sales pipeline, 7 stages", state: "confirmed" },
    { what: "Deal owner", value: "Whether an import may set it in this account", state: "unknown", effect: "Until it is known, the plan leaves deal owners out. Everything else can be prepared." },
    { what: "Marketing contacts", value: "Whether imported contacts count as marketing contacts", state: "answer", effect: "Kauro keeps them as non-marketing unless you choose otherwise; a paid setting stays off unless you turn it on." },
  ];
}

export function TargetSetup({ ctx, state, project }: PrototypeProps): ReactElement {
  const [confirmed, setConfirmed] = useState(state === "confirmed");
  const words = SERVICE[project.mode];
  if (project.mode === "CLEAN")
    return (
      <>
        <ProjectHeader stage="files" title="Destination" lead="Clean your data has no destination." />
        <section className="kauro-pl-section" aria-labelledby="clean-dest-h">
          <h2 id="clean-dest-h">Nothing to set up here</h2>
          <p>{words.line}</p>
          <p>There is no CRM to describe and nothing to confirm. Once the files are sealed, the free data health check starts on them.</p>
        </section>
        <div className="kauro-actions">
          <ScreenButton to="UI18" ctx={ctx} project={project.projectId} variant="primary">
            Go to the health check
          </ScreenButton>
        </div>
      </>
    );
  const mode = project.mode;
  const salesforce = mode === "SALESFORCE";
  const crm = words.destination ?? "";
  const fieldWord = salesforce ? "field definitions" : "properties";
  const approver = can(ctx, "approve");
  const operator = can(ctx, "operate");
  const solo = soloWorkspace(ctx);
  const confirmer = whoCan(ctx, "approve");
  const stale = state === "stale";
  const facts = factsFor(mode);
  const readAt = stale ? STALE_READ_AT : READ_AT;
  const status: { readonly tone: Tone; readonly text: string } =
    state === "provide" ? { tone: "info", text: "Settings to give" } : confirmed ? { tone: "success", text: "Destination confirmed" } : stale ? { tone: "warning", text: "Settings too old" } : { tone: "info", text: "Destination to confirm" };

  if (state === "provide")
    return (
      <>
        <ProjectHeader stage="files" title="Destination" lead={`Give Kauro your ${crm} settings, so the check and the plan use your ${crm}'s own fields.`} status={status} />
        <section className="kauro-pl-section" aria-labelledby="provide-h">
          <h2 id="provide-h">Export the settings, then upload the file</h2>
          <ol className="kauro-pl-steps">
            <li>
              <strong>Export the {fieldWord}</strong>
              <span>{salesforce ? "Export the field definitions of Account, Contact and Opportunity from your org; Help lists the ways to do it." : "In HubSpot, open Settings, then Data Management, then Properties, and choose Export all properties."}</span>
            </li>
            <li>
              <strong>Upload the exported file here</strong>
              <span>
                The file holds settings only, no records. Kauro reads it; it never signs in to your {crm} {salesforce ? "org" : "account"}.
              </span>
            </li>
            <li>
              <strong>{solo ? "Confirm what Kauro read" : `${confirmer} confirms what Kauro read`}</strong>
              <span>Within {CONFIRM_HOURS} hours of reading them, exactly as the plan will use them.</span>
            </li>
          </ol>
        </section>
        {operator ? (
          <label className="kauro-pl-drop">
            <span className="kauro-pl-drop-title">Choose the exported settings, or drop the file here</span>
            <span className="kauro-pl-drop-meta">
              {crm} {fieldWord} export · CSV or XLSX · kept up to {POLICY_SNAPSHOT.retention.targetMetadataDaysFromLastUse} days after its last use
            </span>
            <input type="file" accept=".csv,.xlsx" />
          </label>
        ) : (
          <Only>{onlyLine(ctx, "operate", "upload the settings")}</Only>
        )}
      </>
    );

  return (
    <>
      <ProjectHeader
        stage="files"
        title="Destination"
        lead={confirmed ? `The ${crm} settings are confirmed. The free data health check can start.` : "Confirm where the files will be imported."}
        status={status}
        action={
          confirmed && operator ? (
            <ScreenButton to="UI18" ctx={ctx} project={project.projectId} variant="primary">
              Start the free data health check
            </ScreenButton>
          ) : undefined
        }
      />
      {stale ? (
        <Banner tone="warning" title="These settings were read too long ago to confirm" announce="status">
          <p>
            Kauro read them on {moment(STALE_READ_AT)}. Settings are confirmed within {CONFIRM_HOURS} hours of being read, so export them again and upload the new file.
          </p>
        </Banner>
      ) : null}
      <p className="kauro-pl-meta">
        Read from the file you uploaded on {moment(readAt)}. {confirmed ? `Confirmed by ${solo ? "you" : "Samuel Osei (Approver)"} on ${moment(CONFIRMED_AT)}.` : `They can be confirmed until ${moment(new Date(Date.parse(readAt) + CONFIRM_HOURS * 3_600_000).toISOString())}.`}
      </p>
      <section className="kauro-pl-section" aria-labelledby="read-h">
        <h2 id="read-h">What Kauro read</h2>
        <table className="kauro-rtable kauro-pl-rtable kauro-pl-facts">
          <caption className="kauro-visually-hidden">The destination's settings, each with its state</caption>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">What Kauro read</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.what}>
                <th scope="row">{fact.what}</th>
                <td data-label="What Kauro read">
                  <span>
                    {fact.value}
                    {fact.effect === undefined ? null : <span className="kauro-sub">{fact.effect}</span>}
                  </span>
                </td>
                <td data-label="State">
                  <StatusBadge tone={confirmed && fact.state === "answer" ? "success" : FACT_TONE[fact.state]}>{confirmed && fact.state === "answer" ? "Answered" : FACT_WORD[fact.state]}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {confirmed || stale ? null : (
        <section className="kauro-pl-section" aria-labelledby="answer-h">
          <h2 id="answer-h">{facts.find((fact) => fact.state === "answer")?.what ?? "Your answer"}</h2>
          {approver ? (
            <fieldset className="kauro-pl-choice">
              <legend>{salesforce ? "Who owns the imported records" : "How imported contacts are counted"}</legend>
              <label>
                <input type="radio" name="answer" defaultChecked />
                <span>
                  <strong>{salesforce ? "The user who runs Data Loader" : "As non-marketing contacts"}</strong>
                  <small>{salesforce ? "Each record belongs to whoever imports it." : "Nothing changes what HubSpot counts or charges."}</small>
                </span>
              </label>
              <label>
                <input type="radio" name="answer" />
                <span>
                  <strong>{salesforce ? "One user for every record" : "As marketing contacts"}</strong>
                  <small>{salesforce ? "You give the user's ID; the files carry it." : "A paid HubSpot setting: only if your team chooses it."}</small>
                </span>
              </label>
            </fieldset>
          ) : (
            <p>{facts.find((fact) => fact.state === "answer")?.effect}</p>
          )}
        </section>
      )}
      {confirmed ? (
        <p className="kauro-pl-meta">If these settings change in a material way, Kauro stops using them and asks for them again. A new delivery can use them for {POLICY_SNAPSHOT.retention.targetExecutionFreshnessDays} days at most.</p>
      ) : stale ? (
        operator ? (
          <div className="kauro-actions">
            <ScreenButton to="UI17" ctx={ctx} project={project.projectId} variant="primary">
              Upload the settings again
            </ScreenButton>
          </div>
        ) : (
          <Only>{onlyLine(ctx, "operate", "upload the settings again")}</Only>
        )
      ) : approver ? (
        <div className="kauro-pl-confirm">
          <p>Confirming tells Kauro to prepare the files for exactly these settings. The unknown fact stays unknown, and the part it affects stays out until it is answered.</p>
          <Button variant="primary" onClick={() => setConfirmed(true)}>
            Confirm these settings
          </Button>
        </div>
      ) : (
        <Only>{onlyLine(ctx, "approve", "confirm the destination")} Send them this page when it is ready.</Only>
      )}
    </>
  );
}

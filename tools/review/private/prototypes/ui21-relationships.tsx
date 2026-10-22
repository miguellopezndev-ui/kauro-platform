"use client";
// UI21 Relationships, shown as "Links between records" (registry: "Confirm how records stay connected."; Order 11 round 2, research
// agency-workspace.md §5.10). One sentence first: how many contacts link to their company. Then the link rule as a short table of what it
// does to every contact prepared (linked, held back because the company named is not in the companies file, no company named), adding up
// to the contacts prepared after duplicates; the held-back names with the closest company as a hint, never a link; what happens to the
// contacts without a company; and the order the import takes. Kauro never creates a missing company and never shows a link it will not
// prepare (registry exceptions). The team accepts the rule; a person whose role cannot change the plan reads it and one line saying who can.
//
// "Clean your data" prepares no links: the Company column stays a column of the cleaned file, and the page says so.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Only, ScreenButton } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { n, PLAN, PlanTasks, tasksFor } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI21_STATES: readonly StateDef[] = [
  { key: "normal", label: "Links to accept", note: "11,045 of 12,266 contacts link to their company; 163 name a company that is not in the companies file and 1,058 name none, each listed. The team accepts the rule." },
  { key: "confirmed", label: "Accepted", note: "The rule is accepted: the contacts without a company are prepared without one, on purpose. Links is completed; approval can start." },
];

const NOT_FOUND = [
  { name: "Harbour Mill Ltd", rows: 52, near: "Harbor Mill" },
  { name: "Osprey Freight Group", rows: 41, near: "Osprey Freight" },
  { name: "Larch Studios", rows: 28, near: "Larch Studio" },
  { name: "Juniper & Co", rows: 19, near: null },
  { name: "17 other names", rows: 23, near: null },
] as const;
if (NOT_FOUND.reduce((sum, row) => sum + row.rows, 0) !== PLAN.notFound) throw new Error("the names not found do not add up");

export function Relationships({ ctx, state, project }: PrototypeProps): ReactElement {
  const words = SERVICE[project.mode];
  const [accepted, setAccepted] = useState(state === "confirmed");
  if (project.mode === "CLEAN")
    return (
      <>
        <ProjectHeader stage="plan" title="Links between records" lead="Clean your data prepares no links between records." status={{ tone: "info", text: "Plan in review" }} />
        <PlanTasks ctx={ctx} project={project} current="relationships" states={tasksFor("identity", true, project.mode)} />
        <section className="kauro-pl-section" aria-labelledby="clean-links-h">
          <h2 id="clean-links-h">The Company column stays a column</h2>
          <p>The cleaned files keep the company name beside each contact, with spellings of the same company made consistent where the plan says so. No link is prepared for any tool.</p>
        </section>
        <div className="kauro-actions">
          <ScreenButton to="UI22" ctx={ctx} project={project.projectId} variant="primary">
            Continue to approval
          </ScreenButton>
        </div>
      </>
    );
  const editor = can(ctx, "operate");
  const company = project.mode === "SALESFORCE" ? "account" : "company";
  const companies = words.companies.toLowerCase();
  const file = project.mode === "SALESFORCE" ? "accounts" : "companies";
  return (
    <>
      <ProjectHeader
        stage="plan"
        title="Links between records"
        lead={`Confirm how contacts stay connected to their ${companies} in ${words.destination ?? ""}.`}
        status={accepted ? { tone: "success", text: "Links accepted" } : { tone: "info", text: "Plan in review" }}
      />
      <PlanTasks ctx={ctx} project={project} current="relationships" states={tasksFor("relationships", accepted, project.mode)} />
      <p className="kauro-pl-verdict">
        {n(PLAN.links)} of {n(PLAN.output)} contacts link to their {company}.
      </p>
      <section className="kauro-pl-section" aria-labelledby="rule-h">
        <h2 id="rule-h">The link rule: contact to {company}, by the name in the Company column</h2>
        <table className="kauro-rtable kauro-pl-rtable kauro-pl-outcomes">
          <caption className="kauro-visually-hidden">What the rule does to each contact prepared</caption>
          <thead>
            <tr>
              <th scope="col">Outcome</th>
              <th scope="col" className="kauro-num">
                Contacts
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                Linked
                <span className="kauro-sub">The {company} named is in companies.xlsx</span>
              </th>
              <td data-label="Contacts" className="kauro-num">
                {n(PLAN.links)}
              </td>
            </tr>
            <tr>
              <th scope="row">
                Held back: {company} not found
                <span className="kauro-sub">The name is not in companies.xlsx; listed below with the closest name</span>
              </th>
              <td data-label="Contacts" className="kauro-num">
                {n(PLAN.notFound)}
              </td>
            </tr>
            <tr>
              <th scope="row">
                No {company} named
                <span className="kauro-sub">
                  The Company column is empty: {n(PLAN.emptySource)} in the file, less {n(PLAN.emptyUnified)} unified into another record and {n(PLAN.emptyFilled)} that took a duplicate&apos;s company
                </span>
              </th>
              <td data-label="Contacts" className="kauro-num">
                {n(PLAN.emptyCompany)}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Contacts prepared, after {n(PLAN.unifiedRows)} rows were unified</th>
              <td data-label="Contacts" className="kauro-num">
                {n(PLAN.output)}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
      <section className="kauro-pl-section" aria-labelledby="notfound-h">
        <h2 id="notfound-h">{project.mode === "SALESFORCE" ? "Accounts" : "Companies"} named but not found</h2>
        <table className="kauro-rtable kauro-pl-rtable">
          <caption className="kauro-visually-hidden">Names in contacts.csv that are not in companies.xlsx, with the closest name</caption>
          <thead>
            <tr>
              <th scope="col">Name in contacts.csv</th>
              <th scope="col" className="kauro-num">
                Contacts
              </th>
              <th scope="col">Closest name in companies.xlsx</th>
            </tr>
          </thead>
          <tbody>
            {NOT_FOUND.map((row) => (
              <tr key={row.name}>
                <th scope="row">
                  <bdi>{row.name}</bdi>
                </th>
                <td data-label="Contacts" className="kauro-num">
                  {n(row.rows)}
                </td>
                <td data-label="Closest name">{row.near === null ? "None close" : <bdi>{row.near}</bdi>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="kauro-pl-meta">A close name is a hint, not a link. To link these contacts, correct the names in the file and upload it again: the plan never links on a guess.</p>
      </section>
      <section className="kauro-pl-section" aria-labelledby="order-h">
        <h2 id="order-h">The order of the import</h2>
        <ol className="kauro-pl-order">
          <li>
            <strong>{words.companies}</strong> · {n(PLAN.companiesOutput)} records, from {file}-clean.csv
          </li>
          <li>
            <strong>Contacts</strong> · {n(PLAN.output)} records
          </li>
          {project.mode === "HUBSPOT" ? (
            <li>
              <strong>Links between them</strong> · {n(PLAN.links)} associations
            </li>
          ) : null}
        </ol>
        {project.mode === "SALESFORCE" ? <p className="kauro-pl-meta">Each contact carries its account&apos;s Salesforce ID, taken from the first stage&apos;s success file.</p> : null}
      </section>
      {accepted ? (
        <Banner tone="success" title="The link rule is accepted" announce="status">
          <p>
            {n(PLAN.links)} links go into the plan. {n(PLAN.noCompany)} contacts are prepared without a {company}, on purpose, and the report lists each with the name it carried.
          </p>
        </Banner>
      ) : editor ? (
        <fieldset className="kauro-pl-choice">
          <legend>The {n(PLAN.noCompany)} contacts without a {company}</legend>
          <label>
            <input type="radio" name="unlinked" defaultChecked />
            <span>
              <strong>Prepare them without a {company}</strong>
              <small>Each is listed in the report, with the name it carried.</small>
            </span>
          </label>
          <label>
            <input type="radio" name="unlinked" />
            <span>
              <strong>Leave them out of this delivery</strong>
              <small>They are not prepared; correct the file and add them in a later project.</small>
            </span>
          </label>
        </fieldset>
      ) : null}
      {!editor ? (
        <Only>{onlyLine(ctx, "operate", "accept the link rule")}</Only>
      ) : accepted ? (
        <div className="kauro-actions">
          <ScreenButton to="UI22" ctx={ctx} project={project.projectId} variant="primary">
            Continue to approval
          </ScreenButton>
        </div>
      ) : (
        <div className="kauro-actions">
          <Button variant="primary" onClick={() => setAccepted(true)}>
            Accept the link rule
          </Button>
        </div>
      )}
    </>
  );
}

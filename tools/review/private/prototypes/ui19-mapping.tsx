"use client";
// UI19 Mapping, shown as "Fields" (registry: "Choose where each field goes and what changes."). One row a source column: its position and
// name in the file, a few of its values, where it goes, what the plan would change in it, and how many rows that touches (registry
// information). Every choice is typed: a property or field the destination has, or Don't include; there is no free text that bypasses the
// choice, and a property the destination does not have cannot be invented (registry exceptions).
//
// Adapted to the service (the owner's decisions of 2026-10-20): "Prepare for HubSpot" maps to HubSpot properties, "Prepare for Salesforce"
// to Salesforce fields; "Clean your data" has no destination, so each column goes to a column of the cleaned file, under the name and in the
// format chosen, and a few output preferences are offered only where they add value (proposed: no contract holds them yet, F-09).
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { PageHead, ScreenButton } from "./kit.tsx";
import { n, PLAN, PlanTasks } from "./plan.tsx";
import { SERVICE } from "./service.ts";

export const UI19_STATES: readonly StateDef[] = [
  { key: "normal", label: "Fields to review", note: "contacts.csv's six columns: five mapped as Kauro proposes, a second e-mail column proposed as Don't include." },
  { key: "blocked", label: "A blocker", note: "Validation found values the destination refuses (or, when cleaning, a format that cannot hold them): the exact rows and the way to resolve them." },
  { key: "validated", label: "Validated", note: "Every field resolved and checked against the sealed set (and, for a CRM, the destination's settings)." },
];

interface Mapping {
  readonly position: number;
  readonly column: string;
  readonly samples: readonly string[];
  readonly target: Readonly<Record<"CLEAN" | "HUBSPOT" | "SALESFORCE", string>>;
  readonly change: string;
  readonly rows: string;
  readonly flag?: string;
}
const LEAVE = "Don't include";
const CONTACTS: readonly Mapping[] = [
  { position: 1, column: "First name", samples: ["Ana", "JOHN", "Maria"], target: { CLEAN: "First name", HUBSPOT: "First name", SALESFORCE: "First Name" }, change: "Capitals made consistent", rows: `${n(312)} rows` },
  { position: 2, column: "Last name", samples: ["Ruiz", "SMITH", "Lopez"], target: { CLEAN: "Last name", HUBSPOT: "Last name", SALESFORCE: "Last Name" }, change: "Capitals made consistent", rows: `${n(298)} rows` },
  { position: 3, column: "E-mail", samples: ["ana.ruiz@example.com", "m.lopez@example.com"], target: { CLEAN: "Email", HUBSPOT: "Email", SALESFORCE: "Email" }, change: "Lower case, spaces removed", rows: `${n(PLAN.emailsLowercased)} rows` },
  { position: 4, column: "Phone", samples: ["+44 20 7946 0958", "020 7946 0102"], target: { CLEAN: "Phone", HUBSPOT: "Phone number", SALESFORCE: "Phone" }, change: "No change", rows: "None" },
  { position: 5, column: "Company", samples: ["Larch Studio", "Osprey Freight", "Tidewell"], target: { CLEAN: "Company", HUBSPOT: "Associated company", SALESFORCE: "Account Name" }, change: "Linked to the company of the same name", rows: `${n(PLAN.links)} links` },
  { position: 6, column: "E-mail", samples: ["ana@larch.example", "—"], target: { CLEAN: LEAVE, HUBSPOT: LEAVE, SALESFORCE: LEAVE }, change: "A second e-mail column: 214 rows differ from column 3", rows: "Left out", flag: "Same label as column 3" },
];
const OPTIONS: Readonly<Record<"CLEAN" | "HUBSPOT" | "SALESFORCE", readonly string[]>> = {
  CLEAN: ["First name", "Last name", "Email", "Secondary email", "Phone", "Company", LEAVE],
  HUBSPOT: ["First name", "Last name", "Email", "Work email", "Phone number", "Mobile phone number", "Associated company", LEAVE],
  SALESFORCE: ["First Name", "Last Name", "Email", "Phone", "Mobile Phone", "Account Name", LEAVE],
};

const STATES = { mapping: "review", identity: "review", relationships: "review", approval: "waiting" } as const;

export function Mapping({ ctx, state, project }: PrototypeProps): ReactElement {
  const [file, setFile] = useState<"contacts" | "companies">("contacts");
  const mode = project.mode;
  const words = SERVICE[mode];
  const clean = mode === "CLEAN";
  const where = clean ? "In the cleaned file" : `Goes to (${words.destination ?? ""})`;
  return (
    <>
      <ProjectHeader current="plan" />
      <PageHead title="Fields" lead={clean ? "Choose what each column becomes in the cleaned file, and what changes." : "Choose where each field goes and what changes."} />
      <PlanTasks ctx={ctx} project={project} current="mapping" states={state === "validated" ? { ...STATES, mapping: "done" } : state === "blocked" ? { ...STATES, mapping: "blocked" } : STATES} />
      <div className="kauro-tabs" role="tablist" aria-label="Files">
        <button type="button" role="tab" aria-selected={file === "contacts"} className="kauro-tab" onClick={() => setFile("contacts")}>
          contacts.csv <span>{n(PLAN.contacts)} rows · Contacts</span>
        </button>
        <button type="button" role="tab" aria-selected={file === "companies"} className="kauro-tab" onClick={() => setFile("companies")}>
          companies.xlsx <span>{n(PLAN.companies)} rows · {words.companies}</span>
        </button>
      </div>
      {state === "blocked" ? (
        clean ? (
          <Banner tone="danger" title="12 phone numbers cannot be put in the international format you chose" announce="alert">
            <p>Rows 482, 1,204 and 10 others in contacts.csv hold phone numbers with no country. Keep phone numbers as in the file, or keep those 12 as they are; the report lists them.</p>
          </Banner>
        ) : (
          <Banner tone="danger" title={`12 phone numbers are longer than ${words.destination ?? ""} accepts`} announce="alert">
            <p>
              {words.destination} keeps phone numbers of up to 30 characters; rows 482, 1,204 and 10 others in contacts.csv hold longer ones. Choose Don&apos;t include for Phone, or keep the column and leave
              those 12 values out: the report lists them.
            </p>
          </Banner>
        )
      ) : null}
      {state === "validated" ? (
        <Banner tone="success" title="The fields are validated" announce="status">
          <p>{clean ? "Every column has a place in the cleaned file or is left out on purpose, checked against the sealed files." : `Every column has a destination or is left out on purpose, checked against the sealed files and ${words.destination ?? ""}'s settings read on Oct 20, 2026.`}</p>
        </Banner>
      ) : null}
      {file === "contacts" ? (
        <div className="kauro-table-region">
          <table className="kauro-table kauro-mapping">
            <caption className="kauro-visually-hidden">contacts.csv: where each column goes</caption>
            <thead>
              <tr>
                <th scope="col">Column in the file</th>
                <th scope="col">{where}</th>
                <th scope="col">What changes</th>
                <th scope="col" className="kauro-table-end">
                  Affects
                </th>
              </tr>
            </thead>
            <tbody>
              {CONTACTS.map((row) => {
                const target = row.target[mode];
                // without a destination, a company name is kept as a column: no link is prepared
                const change = clean && row.position === 5 ? "Kept as a column; spelling of the same company made consistent" : row.change;
                const rows = clean && row.position === 5 ? `${n(86)} rows` : row.rows;
                return (
                  <tr key={row.position} className={target === LEAVE ? "is-left-out" : undefined}>
                    <th scope="row">
                      <span className="kauro-mapping-column">
                        <span className="kauro-mapping-position">{row.position}</span> {row.column}
                      </span>
                      <span className="kauro-mapping-samples">{row.samples.join(" · ")}</span>
                      {row.flag === undefined ? null : <span className="kauro-mapping-flag">{row.flag}</span>}
                    </th>
                    <td data-label={where}>
                      <label className="kauro-visually-hidden" htmlFor={`map-${row.position}`}>
                        {clean ? `Column of the cleaned file for column ${row.position}, ${row.column}` : `Destination of column ${row.position}, ${row.column}`}
                      </label>
                      <select id={`map-${row.position}`} defaultValue={target}>
                        {OPTIONS[mode].map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      {row.position === 4 && state === "blocked" ? <span className="kauro-mapping-error">12 values {clean ? "without a country" : "too long"}</span> : null}
                    </td>
                    <td data-label="What changes">{change}</td>
                    <td className="kauro-table-end" data-label="Affects">
                      {rows}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="kauro-muted">
          companies.xlsx: Company, Domain, City and Industry, each {clean ? "kept as a column of the cleaned file" : `mapped to the ${words.destination ?? ""} ${mode === "SALESFORCE" ? "field" : "property"} of the same meaning`}. Domains are made lower case in 214 rows.
        </p>
      )}
      {clean ? (
        <section className="kauro-output-prefs" aria-labelledby="prefs-h">
          <h2 id="prefs-h">The cleaned files (optional)</h2>
          <p className="kauro-muted">Kauro keeps the shape of your files unless you choose otherwise. Change these only if the tool you will use needs it.</p>
          <div className="kauro-output-prefs-grid">
            <fieldset className="kauro-choice">
              <legend>File type</legend>
              <label>
                <input type="radio" name="filetype" defaultChecked />
                <span>
                  <strong>As uploaded</strong>
                  <small>CSV stays CSV, a workbook stays XLSX</small>
                </span>
              </label>
              <label>
                <input type="radio" name="filetype" />
                <span>
                  <strong>All CSV, UTF-8</strong>
                  <small>One CSV file a table</small>
                </span>
              </label>
            </fieldset>
            <fieldset className="kauro-choice">
              <legend>Phone numbers</legend>
              <label>
                <input type="radio" name="phones" defaultChecked={state !== "blocked"} />
                <span>
                  <strong>As in the file</strong>
                  <small>Spaces trimmed, nothing else</small>
                </span>
              </label>
              <label>
                <input type="radio" name="phones" defaultChecked={state === "blocked"} />
                <span>
                  <strong>International format</strong>
                  <small>Like +44 20 7946 0958, where the country is known</small>
                </span>
              </label>
            </fieldset>
          </div>
          <p className="kauro-proposed">Proposed — output preferences need a place in the plan&apos;s contract (F-09)</p>
        </section>
      ) : null}
      <p className="kauro-muted">
        {clean
          ? "Kauro proposes; your team decides. Nothing is deleted without a trace: a column left out is listed in the report."
          : `Kauro proposes; your team decides. A choice is a ${mode === "SALESFORCE" ? "field" : "property"} ${words.destination ?? ""} already has, or Don't include: Kauro never creates one in your account.`}
      </p>
      <div className="kauro-actions">
        {state === "validated" ? (
          <ScreenButton to="UI20" ctx={ctx} project={project.projectId} variant="primary">
            <span className="kauro-go">Continue to duplicates</span>
          </ScreenButton>
        ) : (
          <Button variant="primary">Validate the fields</Button>
        )}
        <ScreenButton to="UI20" ctx={ctx} project={project.projectId}>
          Review duplicates
        </ScreenButton>
      </div>
    </>
  );
}

"use client";
// UI19 Mapping, shown as "Fields" (registry: "Choose where each field goes and what changes."; Order 11 round 2, research agency-workspace.md
// §5.8). The plan's four parts first, as a GOV.UK task list inside stage 3; then one row a source column: its position and name, a few of
// its values, where it goes, what the plan changes in it and how many rows that touches, and its state in words: Needs a choice, Suggested
// (Kauro's proposal, not yet confirmed by a person: OneSchema stars its AI mappings until someone accepts them), Mapped, or Left out. The
// rows that need a choice come first. Every choice is typed: a property or field the destination has, or Don't include; there is no free
// text, and Kauro never creates a property in anyone's account (registry exceptions). A person whose role cannot change the plan reads the
// same table with the choices as words, and one line saying who can.
//
// Adapted to the service: "Prepare for HubSpot" maps to HubSpot properties, "Prepare for Salesforce" to Salesforce fields; "Clean your
// data" has no destination, so each column becomes a column of the cleaned file, and a few output preferences are offered (proposed: no
// contract holds them yet, F-09).
import { Banner, Button, type Tone, StatusBadge } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { moment, Only, ScreenButton } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { n, PLAN, PlanTasks, tasksFor } from "./plan.tsx";
import { SERVICE } from "./service.ts";
import { TIMELINE } from "./timeline.ts";

export const UI19_STATES: readonly StateDef[] = [
  { key: "normal", label: "Fields to review", note: "contacts.csv's six columns: one needs a choice (a second E-mail column), one suggestion to confirm, four mapped. The rows that need a person come first." },
  { key: "blocked", label: "A value the destination refuses", note: "Twelve phone numbers do not fit the destination (or, when cleaning, the format chosen): the rows are named and the way to resolve them." },
  { key: "validated", label: "Reviewed", note: "Every column resolved and checked against the sealed files (and, for a CRM, the destination's settings): Fields is completed." },
];

type Mode = "CLEAN" | "HUBSPOT" | "SALESFORCE";
type RowState = "choice" | "suggested" | "mapped" | "out";
const STATE_WORD: Readonly<Record<RowState, string>> = { choice: "Needs a choice", suggested: "Suggested", mapped: "Mapped", out: "Left out" };
const STATE_TONE: Readonly<Record<RowState, Tone>> = { choice: "warning", suggested: "info", mapped: "success", out: "neutral" };
const ORDER: readonly RowState[] = ["choice", "suggested", "mapped", "out"];

interface Mapping {
  readonly position: number;
  readonly column: string;
  readonly samples: readonly string[];
  readonly target: Readonly<Record<Mode, string>>;
  readonly change: string;
  readonly rows: number | null;
  readonly rowsWord?: string;
  readonly state: RowState;
  /** Why a person must choose (shown under the column's name). */
  readonly why?: string;
}
const LEAVE = "Don't include";
const CONTACTS: readonly Mapping[] = [
  { position: 1, column: "First name", samples: ["Ana", "JOHN", "Maria"], target: { CLEAN: "First name", HUBSPOT: "First name", SALESFORCE: "First Name" }, change: "Capitals made consistent", rows: 312, state: "mapped" },
  { position: 2, column: "Last name", samples: ["Ruiz", "SMITH", "Lopez"], target: { CLEAN: "Last name", HUBSPOT: "Last name", SALESFORCE: "Last Name" }, change: "Capitals made consistent", rows: 298, state: "mapped" },
  { position: 3, column: "E-mail", samples: ["ana.ruiz@example.com", "m.lopez@example.com"], target: { CLEAN: "Email", HUBSPOT: "Email", SALESFORCE: "Email" }, change: `Lower case, spaces removed; ${n(PLAN.emailsInvalid)} invalid left empty and listed`, rows: PLAN.emailsLowercased, state: "mapped" },
  { position: 4, column: "Phone", samples: ["+44 20 7946 0958", "020 7946 0102"], target: { CLEAN: "Phone", HUBSPOT: "Phone number", SALESFORCE: "Phone" }, change: "No change", rows: null, rowsWord: "None", state: "mapped" },
  { position: 5, column: "Company", samples: ["Larch Studio", "Osprey Freight", "Tidewell"], target: { CLEAN: "Company", HUBSPOT: "Associated company", SALESFORCE: "Account Name" }, change: "Linked to the company of the same name", rows: PLAN.links, rowsWord: "links", state: "suggested", why: "Suggested by Kauro: confirm it" },
  { position: 6, column: "E-mail", samples: ["ana@larch.example", "—"], target: { CLEAN: LEAVE, HUBSPOT: LEAVE, SALESFORCE: LEAVE }, change: `A second E-mail column: ${n(PLAN.columnsDisagree)} rows differ from column 3`, rows: null, rowsWord: "—", state: "choice", why: "Same label as column 3; Kauro suggests leaving it out" },
];
const OPTIONS: Readonly<Record<Mode, readonly string[]>> = {
  CLEAN: ["First name", "Last name", "Email", "Secondary email", "Phone", "Company", LEAVE],
  HUBSPOT: ["First name", "Last name", "Email", "Work email", "Phone number", "Mobile phone number", "Associated company", LEAVE],
  SALESFORCE: ["First Name", "Last Name", "Email", "Phone", "Mobile Phone", "Account Name", LEAVE],
};

export function Mapping({ ctx, state, project }: PrototypeProps): ReactElement {
  const mode = project.mode;
  const words = SERVICE[mode];
  const clean = mode === "CLEAN";
  const editor = can(ctx, "operate");
  const [file, setFile] = useState<"contacts" | "companies">("contacts");
  // a row a person settled in this visit (a choice made, or a suggestion confirmed)
  const [settled, setSettled] = useState<ReadonlySet<number>>(new Set(state === "validated" ? [5, 6] : []));
  const validated = state === "validated";
  const rowState = (row: Mapping): RowState => {
    if (state === "blocked" && row.position === 4 && !settled.has(4)) return "choice";
    if (validated || settled.has(row.position)) return row.target[mode] === LEAVE ? "out" : "mapped";
    return row.state;
  };
  const rows = [...CONTACTS].sort((a, b) => ORDER.indexOf(rowState(a)) - ORDER.indexOf(rowState(b)) || a.position - b.position);
  const choices = rows.filter((row) => rowState(row) === "choice").length;
  const suggestions = rows.filter((row) => rowState(row) === "suggested").length;
  const open = choices + suggestions;
  const where = clean ? "In the cleaned file" : `Goes to (${words.destination ?? ""})`;
  const summary =
    open === 0
      ? "Every column is mapped or left out on purpose."
      : [choices === 0 ? null : `${choices} ${choices === 1 ? "column needs" : "columns need"} a choice`, suggestions === 0 ? null : `${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"} to confirm`].filter((part) => part !== null).join(" · ");
  return (
    <>
      <ProjectHeader
        stage="plan"
        title="Fields"
        lead={clean ? "Choose what each column becomes in the cleaned file, and what changes." : "Choose where each field goes and what changes."}
        status={validated ? { tone: "success", text: "Fields reviewed" } : { tone: "info", text: "Plan in review" }}
      />
      <PlanTasks ctx={ctx} project={project} current="mapping" states={tasksFor("mapping", validated, mode)} />
      <div className="kauro-pl-tabs" role="tablist" aria-label="Files">
        <button type="button" role="tab" aria-selected={file === "contacts"} className="kauro-pl-tab" onClick={() => setFile("contacts")}>
          contacts.csv <span>{n(PLAN.contacts)} rows · 6 columns</span>
        </button>
        <button type="button" role="tab" aria-selected={file === "companies"} className="kauro-pl-tab" onClick={() => setFile("companies")}>
          companies.xlsx <span>{n(PLAN.companies)} rows · 4 columns</span>
        </button>
      </div>
      {state === "blocked" ? (
        <Banner tone="danger" title={clean ? "12 phone numbers cannot be written in the international format you chose" : `12 phone numbers are longer than ${words.destination ?? ""} accepts`} announce="alert">
          <p>
            {clean
              ? "Rows 482, 1,204 and 10 others in contacts.csv hold phone numbers with no country. Keep phone numbers as in the file, or keep those 12 as they are; the report lists them."
              : `${words.destination ?? ""} keeps phone numbers of up to 30 characters; rows 482, 1,204 and 10 others in contacts.csv hold longer ones. Choose Don't include for Phone, or keep the column and leave those 12 values out: the report lists them.`}
          </p>
        </Banner>
      ) : null}
      {file === "contacts" ? (
        <>
          <p className="kauro-pl-summary">
            <strong>{summary}</strong>
            {validated ? ` Checked against the sealed files${clean ? "" : ` and ${words.destination ?? ""}'s settings`} on ${moment(TIMELINE.planProposedAt)}.` : null}
          </p>
          <table className="kauro-pl-map">
            <caption className="kauro-visually-hidden">contacts.csv: where each column goes, the rows that need a person first</caption>
            <thead>
              <tr>
                <th scope="col">Column in the file</th>
                <th scope="col">{where}</th>
                <th scope="col">What changes</th>
                <th scope="col" className="kauro-pl-end">
                  Rows affected
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const one = rowState(row);
                const target = row.target[mode];
                // without a destination, a company name stays a column: no link is prepared
                const change = clean && row.position === 5 ? "Kept as a column; spellings of the same company made consistent" : row.change;
                const affected = clean && row.position === 5 ? n(86) : row.rows === null ? (row.rowsWord ?? "—") : `${n(row.rows)}${row.rowsWord === undefined ? "" : ` ${row.rowsWord}`}`;
                return (
                  <tr key={row.position} className={`kauro-pl-map-row kauro-pl-map-row--${one}`}>
                    <th scope="row">
                      <span className="kauro-pl-map-col">
                        <span className="kauro-pl-map-pos">{row.position}</span> {row.column}
                      </span>
                      <span className="kauro-pl-map-samples">{row.samples.join(" · ")}</span>
                      <span className="kauro-pl-map-state">
                        <StatusBadge tone={STATE_TONE[one]}>{STATE_WORD[one]}</StatusBadge>
                      </span>
                      {one === "choice" || one === "suggested" ? <span className="kauro-pl-map-why">{row.position === 4 ? `12 values ${clean ? "without a country" : "too long"}` : row.why}</span> : null}
                    </th>
                    <td data-label={where}>
                      {editor ? (
                        <span className="kauro-pl-map-pick">
                          <label className="kauro-visually-hidden" htmlFor={`map-${row.position}`}>
                            {clean ? `Column of the cleaned file for column ${row.position}, ${row.column}` : `Destination of column ${row.position}, ${row.column}`}
                          </label>
                          <select id={`map-${row.position}`} defaultValue={target} onChange={() => setSettled((old) => new Set([...old, row.position]))}>
                            {OPTIONS[mode].map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                          {one === "suggested" ? (
                            <button type="button" className="kauro-pl-link" onClick={() => setSettled((old) => new Set([...old, row.position]))}>
                              Confirm the suggestion<span className="kauro-visually-hidden"> for column {row.position}</span>
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        <span>{target}</span>
                      )}
                    </td>
                    <td data-label="What changes">{change}</td>
                    <td data-label="Rows affected" className="kauro-pl-end">
                      {affected}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <p className="kauro-pl-summary">
          companies.xlsx: Company, Domain, City and Industry, each {clean ? "kept as a column of the cleaned file" : `mapped to the ${words.destination ?? ""} ${mode === "SALESFORCE" ? "field" : "property"} of the same meaning`}. Domains are made lower case in{" "}
          {n(PLAN.companiesUnified)} rows. Nothing here needs a choice.
        </p>
      )}
      {clean ? (
        <section className="kauro-pl-section" aria-labelledby="prefs-h">
          <h2 id="prefs-h">The cleaned files (optional)</h2>
          <p className="kauro-pl-meta">Kauro keeps the shape of your files unless you choose otherwise. Change these only if the tool you will use needs it.</p>
          <div className="kauro-pl-prefs">
            <fieldset className="kauro-pl-choice">
              <legend>File type</legend>
              <label>
                <input type="radio" name="filetype" defaultChecked disabled={!editor} />
                <span>
                  <strong>As uploaded</strong>
                  <small>CSV stays CSV, a workbook stays XLSX</small>
                </span>
              </label>
              <label>
                <input type="radio" name="filetype" disabled={!editor} />
                <span>
                  <strong>All CSV, UTF-8</strong>
                  <small>One CSV file a table</small>
                </span>
              </label>
            </fieldset>
            <fieldset className="kauro-pl-choice">
              <legend>Phone numbers</legend>
              <label>
                <input type="radio" name="phones" defaultChecked={state !== "blocked"} disabled={!editor} />
                <span>
                  <strong>As in the file</strong>
                  <small>Spaces trimmed, nothing else</small>
                </span>
              </label>
              <label>
                <input type="radio" name="phones" defaultChecked={state === "blocked"} disabled={!editor} />
                <span>
                  <strong>International format</strong>
                  <small>Like +44 20 7946 0958, where the country is known</small>
                </span>
              </label>
            </fieldset>
          </div>
          <p className="kauro-pl-proposed">Proposed: output preferences need a place in the plan&apos;s contract (F-09)</p>
        </section>
      ) : null}
      <p className="kauro-pl-meta">
        {clean
          ? "Kauro proposes; your team decides. Nothing is deleted without a trace: a column left out is listed in the report."
          : `Kauro proposes; your team decides. A choice is a ${mode === "SALESFORCE" ? "field" : "property"} ${words.destination ?? ""} already has, or Don't include: Kauro never creates one in your ${mode === "SALESFORCE" ? "org" : "account"}.`}
      </p>
      {!editor ? (
        <Only>{onlyLine(ctx, "operate", "change the fields")}</Only>
      ) : validated || (open === 0 && state !== "blocked") ? (
        <div className="kauro-actions">
          <ScreenButton to="UI20" ctx={ctx} project={project.projectId} variant="primary">
            {validated ? "Continue to duplicates" : "Mark Fields as reviewed"}
          </ScreenButton>
        </div>
      ) : (
        <div className="kauro-actions">
          <Button variant="secondary" onClick={() => setSettled((old) => new Set([...old, ...CONTACTS.filter((row) => row.state !== "mapped").map((row) => row.position)]))}>
            Accept every suggestion
          </Button>
          <p className="kauro-pl-meta">Settle the rows marked above to mark Fields as reviewed. Your choices are saved as you make them.</p>
        </div>
      )}
    </>
  );
}

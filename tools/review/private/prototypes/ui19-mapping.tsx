"use client";
// UI19 Mapping (registry: "Choose where each field goes and what changes."). One row a source column: its position and name in the file,
// a few of its values, the HubSpot property Kauro proposes, what the plan would change in it, and how many rows that touches (registry
// information). Every choice is typed: a property the destination has, or Don't include; there is no free text that bypasses the choice,
// and a property the destination does not have cannot be invented (registry exceptions). Validating says exactly what blocks.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { PageHead, ScreenButton } from "./kit.tsx";
import { n, PLAN, PlanTasks } from "./plan.tsx";

export const UI19_STATES: readonly StateDef[] = [
  { key: "normal", label: "Fields to review", note: "contacts.csv's six columns: five mapped as Kauro proposes, a second e-mail column proposed as Don't include." },
  { key: "blocked", label: "A blocker", note: "Validation found values the destination refuses: the exact rows and the way to resolve them." },
  { key: "validated", label: "Validated", note: "Every field resolved and checked against the sealed set and HubSpot's settings." },
];

interface Mapping {
  readonly position: number;
  readonly column: string;
  readonly samples: readonly string[];
  readonly target: string;
  readonly change: string;
  readonly rows: string;
  readonly flag?: string;
}
const CONTACTS: readonly Mapping[] = [
  { position: 1, column: "First name", samples: ["Ana", "JOHN", "Maria"], target: "First name", change: "Capitals made consistent", rows: `${n(312)} rows` },
  { position: 2, column: "Last name", samples: ["Ruiz", "SMITH", "Lopez"], target: "Last name", change: "Capitals made consistent", rows: `${n(298)} rows` },
  { position: 3, column: "E-mail", samples: ["ana.ruiz@example.com", "m.lopez@example.com"], target: "Email", change: "Lower case, spaces removed", rows: `${n(PLAN.emailsLowercased)} rows` },
  { position: 4, column: "Phone", samples: ["+44 20 7946 0958", "020 7946 0102"], target: "Phone number", change: "No change", rows: "None" },
  { position: 5, column: "Company", samples: ["Larch Studio", "Osprey Freight", "Tidewell"], target: "Associated company", change: "Linked to the company of the same name", rows: `${n(PLAN.links)} links` },
  { position: 6, column: "E-mail", samples: ["ana@larch.example", "—"], target: "Don't include", change: "A second e-mail column: 214 rows differ from column 3", rows: "Left out", flag: "Same label as column 3" },
];
const PROPERTIES = ["First name", "Last name", "Email", "Work email", "Phone number", "Mobile phone number", "Associated company", "Don't include"] as const;

const STATES = { mapping: "review", identity: "review", relationships: "review", approval: "waiting" } as const;

export function Mapping({ ctx, state }: PrototypeProps): ReactElement {
  const [file, setFile] = useState<"contacts" | "companies">("contacts");
  const agencyId = ctx.agency?.agencyId ?? "";
  return (
    <>
      <ProjectHeader current="plan" />
      <PageHead title="Fields" lead="Choose where each field goes and what changes." />
      <PlanTasks ctx={ctx} current="mapping" states={state === "validated" ? { ...STATES, mapping: "done" } : state === "blocked" ? { ...STATES, mapping: "blocked" } : STATES} />
      <div className="kauro-tabs" role="tablist" aria-label="Files">
        <button type="button" role="tab" aria-selected={file === "contacts"} className="kauro-tab" onClick={() => setFile("contacts")}>
          contacts.csv <span>{n(PLAN.contacts)} rows · Contacts</span>
        </button>
        <button type="button" role="tab" aria-selected={file === "companies"} className="kauro-tab" onClick={() => setFile("companies")}>
          companies.xlsx <span>{n(PLAN.companies)} rows · Companies</span>
        </button>
      </div>
      {state === "blocked" ? (
        <Banner tone="danger" title="12 phone numbers are longer than HubSpot accepts" announce="alert">
          <p>
            HubSpot keeps phone numbers of up to 30 characters; rows 482, 1,204 and 10 others in contacts.csv hold longer ones. Choose Don&apos;t include for Phone, or keep the column and leave those 12 values out: the report lists them.
          </p>
        </Banner>
      ) : null}
      {state === "validated" ? (
        <Banner tone="success" title="The mapping is validated" announce="status">
          <p>Every column has a destination or is left out on purpose, checked against the sealed files and HubSpot&apos;s settings read on 20 Oct 2026.</p>
        </Banner>
      ) : null}
      {file === "contacts" ? (
        <div className="kauro-table-region">
          <table className="kauro-table kauro-mapping">
            <caption className="kauro-visually-hidden">contacts.csv: where each column goes</caption>
            <thead>
              <tr>
                <th scope="col">Column in the file</th>
                <th scope="col">Goes to (HubSpot)</th>
                <th scope="col">What changes</th>
                <th scope="col" className="kauro-table-end">
                  Affects
                </th>
              </tr>
            </thead>
            <tbody>
              {CONTACTS.map((row) => (
                <tr key={row.position} className={row.target === "Don't include" ? "is-left-out" : undefined}>
                  <th scope="row">
                    <span className="kauro-mapping-column">
                      <span className="kauro-mapping-position">{row.position}</span> {row.column}
                    </span>
                    <span className="kauro-mapping-samples">{row.samples.join(" · ")}</span>
                    {row.flag === undefined ? null : <span className="kauro-mapping-flag">{row.flag}</span>}
                  </th>
                  <td data-label="Goes to (HubSpot)">
                    <label className="kauro-visually-hidden" htmlFor={`map-${row.position}`}>
                      Destination of column {row.position}, {row.column}
                    </label>
                    <select id={`map-${row.position}`} defaultValue={row.target}>
                      {PROPERTIES.map((property) => (
                        <option key={property} value={property}>
                          {property}
                        </option>
                      ))}
                    </select>
                    {row.position === 4 && state === "blocked" ? <span className="kauro-mapping-error">12 values too long</span> : null}
                  </td>
                  <td data-label="What changes">{row.change}</td>
                  <td className="kauro-table-end" data-label="Affects">{row.rows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="kauro-muted">companies.xlsx: Company, Domain, City and Industry, each mapped to the HubSpot property of the same meaning. Domains are made lower case in 214 rows.</p>
      )}
      <p className="kauro-muted">Kauro proposes; your team decides. A choice is a property HubSpot already has, or Don&apos;t include: Kauro never creates a property in your account.</p>
      <div className="kauro-actions">
        {state === "validated" ? (
          <ScreenButton to="UI20" ctx={ctx} variant="primary">
            <span className="kauro-go">Continue to duplicates</span>
          </ScreenButton>
        ) : (
          <Button variant="primary">Validate the mapping</Button>
        )}
        <ScreenButton to="UI20" ctx={ctx}>
          Review duplicates
        </ScreenButton>
      </div>
    </>
  );
}

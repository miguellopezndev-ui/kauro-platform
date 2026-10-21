"use client";
// UI55 Support operations (registry: "Resolve the issue with scoped evidence."). The cases assigned, ordered by when the next answer is due
// (SupportCaseView: category, severity, state, next review). A case opens with what the customer wrote and the evidence they attached, as
// references to Kauro's own records (a project's stage, a check's counts), never their CRM rows. Answering needs the actual permission; when
// a case can only be solved by looking at data, emergency access is requested, prepared and approved, for 30 minutes and the smallest scope.
// A seller's access never includes CRM support material (registry exception).
import { Button, Field } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

export const UI55_STATES: readonly StateDef[] = [
  { key: "normal", label: "Cases", note: "Three open cases by when the next answer is due; the first opened, with a reply being written." },
  { key: "access", label: "Data access needed", note: "A case that needs one table's rows: emergency access prepared, 30 minutes, one table, waiting for approval." },
];

const CASES = [
  { id: "case-118", workspace: "Northwind Data", topic: "Import steps", summary: "How should we set the marketing contacts option in stage 2?", severity: "S3", due: "Today, 4:00 PM UTC", state: "Waiting for Kauro" },
  { id: "case-117", workspace: "Halden Outdoor", topic: "Billing", summary: "Our transfer was sent on Friday; the quote still shows unpaid.", severity: "S3", due: "Tomorrow, 10:00 AM UTC", state: "Waiting for Kauro" },
  { id: "case-115", workspace: "Coastline Analytics", topic: "Product defect", summary: "12 rows in exceptions.csv seem to have a valid email address.", severity: "S2", due: "Tomorrow, 12:00 PM UTC", state: "Triaged" },
] as const;

export function SupportOperations({ state }: PrototypeProps): ReactElement {
  const access = state === "access";
  const [open, setOpen] = useState<string>(access ? "case-115" : "case-118");
  const one = CASES.find((item) => item.id === open) ?? CASES[0];
  return (
    <>
      <PageHead title="Support cases" lead="Resolve the issue with scoped evidence." />
      <div className="kauro-table-region">
        <table className="kauro-table kauro-prospects">
          <caption className="kauro-visually-hidden">Open cases, by when the next answer is due</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Next answer due</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {CASES.map((item) => (
              <tr key={item.id} className={item.id === open ? "is-open" : undefined}>
                <th scope="row">
                  <button type="button" className="kauro-row-open" aria-expanded={item.id === open} onClick={() => setOpen(item.id)}>
                    {item.workspace} · {item.topic}
                  </button>
                  <span className="kauro-muted-text">{item.summary}</span>
                </th>
                <td data-label="Next answer due">{item.due}</td>
                <td data-label="State">
                  <Badge tone={item.severity === "S2" ? "warning" : "info"}>
                    {item.severity} · {item.state}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="kauro-prospect" aria-labelledby="case-h">
        <div className="kauro-prospect-head">
          <h2 id="case-h">
            {one.workspace} · {one.topic}
          </h2>
          <Badge tone={one.severity === "S2" ? "warning" : "info"}>{one.severity}</Badge>
        </div>
        <blockquote className="kauro-case-quote">{one.summary}</blockquote>
        <dl className="kauro-prospect-facts">
          <div>
            <dt>Evidence attached</dt>
            <dd>{one.id === "case-115" ? "The package's report and the exceptions count (12 rows); no row's content" : one.id === "case-117" ? "The quote and its payment instructions" : "The project's import steps, stage 2"}</dd>
          </div>
          <div>
            <dt>Answer due</dt>
            <dd>{one.due}</dd>
          </div>
        </dl>
        {one.id === "case-115" ? (
          <div className="kauro-approve">
            <h3>Seeing the 12 rows needs emergency access</h3>
            <p>Prepared: 30 minutes, the exceptions table of Coastline Analytics&apos; package only, read-only, recorded with this case as its reason. {access ? "Waiting for the owner's approval." : "Not requested yet."}</p>
            <div className="kauro-actions">{access ? <Button variant="primary">Approve the access</Button> : <Button variant="primary">Request the access</Button>}</div>
          </div>
        ) : (
          <div className="kauro-approve">
            <Field id="reply" label="Your reply" hint="It goes to the person who opened the case, and stays with it.">
              {(control) => <textarea {...control} rows={4} defaultValue={one.id === "case-118" ? "Choose the option your HubSpot subscription allows; the import steps say which one Kauro checked against. If you are unsure, leave contacts as non-marketing: you can change it later in HubSpot." : ""} />}
            </Field>
            <div className="kauro-actions">
              <Button variant="primary">Send the reply</Button>
              <Button>Mark as waiting for the customer</Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

"use client";
// UI55 Support cases (registry: "Resolve the issue with scoped evidence."). Round 2: support comes first in the Operations group because it
// has customer deadlines; the lead says how many answers are due today. The cases, ordered by when the next answer is due (SupportCaseView:
// category, severity, state, next review), in Bogotá time, the hours support works (Monday to Friday, 09:00 to 17:00). A case opens with
// what the customer wrote and the evidence attached, as references to Kauro's own records, never their CRM rows. When a case can only be
// solved by looking at data, emergency access is requested, prepared and approved, for 30 minutes and the smallest scope.
import { Button, Field } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { OpsHead, OpsPage, Word } from "./ops-kit.tsx";

export const UI55_STATES: readonly StateDef[] = [
  { key: "normal", label: "Cases", note: "Three open cases by when the next answer is due; the first opened, with a reply being written." },
  { key: "access", label: "Data access needed", note: "A defect report that needs one table's rows: emergency access prepared, 30 minutes, one table, waiting for approval." },
];

const CASES = [
  { id: "case-118", number: 118, workspace: "Northwind Data", topic: "Import steps", summary: "How should we set the marketing contacts option in stage 2?", severity: "S3", due: "Today, 11:00 AM", state: "Waiting for Kauro" },
  { id: "case-117", number: 117, workspace: "Halden Outdoor", topic: "Billing", summary: "Our transfer was sent on Friday; the quote still shows unpaid.", severity: "S3", due: "Tomorrow, 9:00 AM", state: "Waiting for Kauro" },
  { id: "case-115", number: 115, workspace: "Fjordline Media", topic: "Defect report", summary: "12 rows in exceptions.csv seem to have a valid email address.", severity: "S2", due: "Tomorrow, 11:00 AM", state: "Triaged" },
] as const;

export function SupportOperations({ state }: PrototypeProps): ReactElement {
  const access = state === "access";
  const [open, setOpen] = useState<string>(access ? "case-115" : "case-118");
  const one = CASES.find((item) => item.id === open) ?? CASES[0];
  return (
    <OpsPage>
      <OpsHead title="Support cases" lead="3 open · 1 answer due today, by 11:00 AM Bogotá." />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
            <caption className="kauro-visually-hidden">Open cases, by when the next answer is due</caption>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Next answer due (Bogotá)</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {CASES.map((item) => (
                <tr key={item.id} className={item.id === open ? "is-open" : undefined}>
                  <th scope="row">
                    <button type="button" className="kauro-ops-rowbutton" aria-expanded={item.id === open} onClick={() => setOpen(item.id)}>
                      {item.workspace} · {item.topic}
                    </button>
                    <span className="kauro-ops-sub">
                      Case {item.number} · {item.summary}
                    </span>
                  </th>
                  <td data-label="Next answer due">
                    <span>{item.due}</span>
                  </td>
                  <td data-label="State">
                    <span>
                      <Word tone={item.severity === "S2" ? "warning" : "info"}>
                        {item.severity} · {item.state}
                      </Word>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <section className="kauro-ops-decide" aria-labelledby="case-h">
        <div className="kauro-ops-head-title">
          <h2 id="case-h">
            {one.workspace} · {one.topic}
          </h2>
          <Word tone={one.severity === "S2" ? "warning" : "info"}>{one.severity}</Word>
        </div>
        <blockquote className="kauro-ops-quote">{one.summary}</blockquote>
        <dl className="kauro-ops-facts">
          <div>
            <dt>Evidence attached</dt>
            <dd>{one.id === "case-115" ? "The package's report and the exceptions count (12 rows); no row's content" : one.id === "case-117" ? "The quote and its payment instructions" : "The project's import steps, stage 2"}</dd>
          </div>
          <div>
            <dt>Answer due</dt>
            <dd>{one.due}, Bogotá</dd>
          </div>
          {one.id === "case-115" ? (
            <div>
              <dt>Also holds</dt>
              <dd>Amara Okafor&apos;s commission on this project, until it is resolved (review Nov 4)</dd>
            </div>
          ) : null}
        </dl>
        {one.id === "case-115" ? (
          <>
            <h3>Seeing the 12 rows needs emergency access</h3>
            <p>Prepared: 30 minutes, the exceptions table of Fjordline Media&apos;s package only, read-only, recorded with this case as its reason. {access ? "Waiting for your approval." : "Not requested yet."}</p>
            <div className="kauro-actions">{access ? <Button variant="primary">Approve the access</Button> : <Button variant="primary">Request the access</Button>}</div>
          </>
        ) : (
          <div className="kauro-ops-form">
            <Field id="reply" label="Your reply" hint="It goes to the person who opened the case, and stays with it">
              {(control) => <textarea {...control} rows={4} defaultValue={one.id === "case-118" ? "Choose the option your HubSpot subscription allows; the import steps say which one Kauro checked against. If you are unsure, leave contacts as non-marketing: you can change it later in HubSpot." : ""} />}
            </Field>
            <div className="kauro-actions">
              <Button variant="primary">Send the reply</Button>
              <Button>Mark as waiting for the customer</Button>
            </div>
          </div>
        )}
      </section>
    </OpsPage>
  );
}

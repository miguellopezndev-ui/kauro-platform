"use client";
// UI36 Commissions (registry: "Understand what was earned, held and paid."). One statement a month (CommissionStatementView), each line
// with its basis (the service collected, after discount, net of refunds, without tax), the rate (10% on a first project, 4% on a repeat),
// what is held and why, and what is payable. A held line says when it is reviewed; a stage released to the customer is not yet eligibility,
// and a transfer submitted is not a transfer received (registry exceptions): "Paid" is shown only with the bank's proof. A line can be
// contested; the seller never sees the company's cash, only their own statement.
import { Banner, Button, Field } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";
import { ELIGIBLE_DAYS, FIRST_RATE, REPEAT_RATE, STATEMENTS, sumOf, usd, WINDOW_MONTHS, type Statement } from "./sales.ts";

export const UI36_STATES: readonly StateDef[] = [
  { key: "normal", label: "Statements", note: "September paid with its proof; October still a draft, with one line held until the project is complete." },
  { key: "submitted", label: "Transfer submitted", note: "September approved and its transfer sent: not shown as paid until the bank confirms it." },
  { key: "contest", label: "Contesting a line", note: "The seller questions a line: what to say, and that the rest of the statement goes on." },
];

const STATE_WORD: Readonly<Record<Statement["state"], string>> = { DRAFT: "Draft", ISSUED: "Issued", DISPUTED: "Contested", APPROVED: "Approved", PAID: "Paid", CORRECTED: "Corrected" };

function StatementCard({ statement, submitted, contest }: { readonly statement: Statement; readonly submitted: boolean; readonly contest: boolean }): ReactElement {
  const shown: Statement["state"] = submitted && statement.state === "PAID" ? "APPROVED" : statement.state;
  const [asking, setAsking] = useState(contest && statement.state === "PAID");
  const payable = sumOf(statement.lines, "payableCents");
  return (
    <section className="kauro-statement" aria-labelledby={`st-${statement.period}`}>
      <div className="kauro-statement-head">
        <h2 id={`st-${statement.period}`}>{statement.period}</h2>
        <Badge tone={shown === "PAID" ? "success" : shown === "DRAFT" ? "neutral" : "info"}>{STATE_WORD[shown]}</Badge>
      </div>
      <dl className="kauro-statement-sum">
        <div>
          <dt>Payable</dt>
          <dd>{usd(payable)}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{usd(sumOf(statement.lines, "heldCents"))}</dd>
        </div>
        <div>
          <dt>{shown === "PAID" ? "Paid" : shown === "DRAFT" ? "Issued on" : "To be paid by"}</dt>
          <dd>{shown === "PAID" ? statement.paid : shown === "DRAFT" ? "9 Nov 2026" : statement.payDue}</dd>
        </div>
      </dl>
      {shown === "DRAFT" ? <p className="kauro-muted">A draft changes until it is issued: a refund or a correction this month changes it.</p> : null}
      {submitted && statement.state === "PAID" ? (
        <p className="kauro-statement-proof">Transfer sent on 15 Oct 2026. It shows as paid once the bank confirms it reached your account; until then, it is not.</p>
      ) : statement.state === "PAID" ? (
        <p className="kauro-statement-proof">Paid on {statement.paid}, to the account ending ··4821; the bank&apos;s confirmation is kept with the statement.</p>
      ) : null}
      <div className="kauro-table-region">
        <table className="kauro-table kauro-statement-lines">
          <caption className="kauro-visually-hidden">The lines of {statement.period}</caption>
          <thead>
            <tr>
              <th scope="col">Agency and project</th>
              <th scope="col" className="kauro-table-end">
                Basis
              </th>
              <th scope="col" className="kauro-table-end">
                Rate
              </th>
              <th scope="col" className="kauro-table-end">
                Held
              </th>
              <th scope="col" className="kauro-table-end">
                Payable
              </th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line) => (
              <tr key={`${line.agency}-${line.project}`}>
                <th scope="row">
                  <span className="kauro-statement-agency">{line.agency}</span>
                  <span className="kauro-muted-text">
                    {line.project} · {line.sequence === "FIRST" ? "first project" : "repeat"}
                  </span>
                  {line.hold === undefined ? null : <span className="kauro-statement-hold">{line.hold}</span>}
                </th>
                <td className="kauro-table-end" data-label="Basis">
                  {usd(line.basisCents)}
                </td>
                <td className="kauro-table-end" data-label="Rate">
                  {line.rate}%
                </td>
                <td className="kauro-table-end" data-label="Held">
                  {usd(line.heldCents)}
                </td>
                <td className="kauro-table-end" data-label="Payable">
                  {usd(line.payableCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {statement.state === "DRAFT" ? null : asking ? (
        <div className="kauro-approve-code">
          <Field id="contest-text" label="Which line, and what is wrong with it" hint="Say what you expected and why; the owner answers with the evidence.">
            {(control) => <textarea {...control} rows={3} defaultValue="Coastline Analytics: the basis shows USD 2,450.00, and the agency told me its quote was USD 2,580.00." />}
          </Field>
          <div className="kauro-actions">
            <Button variant="primary">Send to the owner</Button>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
          </div>
          <p className="kauro-muted">The rest of the statement is not affected.</p>
        </div>
      ) : (
        <Button onClick={() => setAsking(true)}>Contest a line</Button>
      )}
    </section>
  );
}

export function Commissions({ state }: PrototypeProps): ReactElement {
  return (
    <>
      <PageHead title="Commissions" lead="Understand what was earned, held and paid." />
      {state === "submitted" ? (
        <Banner tone="info" title="September's transfer is on its way" announce="status">
          <p>Sent on 15 Oct 2026. A transfer that has been sent is not yet money received: this page says paid when the bank confirms it.</p>
        </Banner>
      ) : null}
      <aside className="kauro-statement-rules" aria-label="How commissions are counted">
        <p>
          <strong>{FIRST_RATE}%</strong> of an agency&apos;s first project, <strong>{REPEAT_RATE}%</strong> of its repeats for {WINDOW_MONTHS} months after its first payment, counted on the service collected after discount, net of refunds and without tax. A line is payable {ELIGIBLE_DAYS} days after its project is complete.
        </p>
      </aside>
      {STATEMENTS.map((statement) => (
        <StatementCard key={statement.period} statement={statement} submitted={state === "submitted"} contest={state === "contest"} />
      ))}
    </>
  );
}

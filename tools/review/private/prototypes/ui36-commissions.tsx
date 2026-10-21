"use client";
// UI36 Commissions (registry: "Understand what was earned, held and paid."). One statement a month (CommissionStatementView), each line
// with its basis (the service collected, after discount, net of refunds, without tax), the rate (10% on a first project, 4% on a repeat),
// what is held and why, and what is payable. A held line says when it is reviewed; a stage released to the customer is not yet eligibility,
// and a transfer submitted is not a transfer received (registry exceptions): "Paid" is shown only with the bank's proof. A line can be
// contested; the seller never sees the company's cash, only their own statement.
//
// Order 11: the rules say when statements are issued and paid (5th and 10th business day, Bogotá calendar). Seen by the owner, the page
// names whose statements they are, with the way to the seller's page (UI37), and an agency opens its relationship (UI35): neither page had
// any way in.
import { Banner, Button, Field } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead, ScreenLink } from "./kit.tsx";
import { ELIGIBLE_DAYS, FIRST_RATE, PAYOUT_BUSINESS_DAY, REPEAT_RATE, SELLER, STATEMENT_BUSINESS_DAY, STATEMENTS, sumOf, usd, WINDOW_MONTHS, type Statement } from "./sales.ts";

/** The agency whose relationship page the review draws (UI35). */
const RELATIONSHIP_AGENCY = "Coastline Analytics";

export const UI36_STATES: readonly StateDef[] = [
  { key: "normal", label: "Statements", note: "September paid with its proof; October still a draft, with one line held until the project is complete." },
  { key: "submitted", label: "Transfer submitted", note: "September approved and its transfer sent: not shown as paid until the bank confirms it." },
  { key: "contest", label: "Contesting a line", note: "The seller asks about one line from its row: the form names the line, and the rest of the statement goes on." },
];

const STATE_WORD: Readonly<Record<Statement["state"], string>> = { DRAFT: "Draft", ISSUED: "Issued", DISPUTED: "Contested", APPROVED: "Approved", PAID: "Paid", CORRECTED: "Corrected" };

function StatementCard({ statement, submitted, contest, ctx }: { readonly statement: Statement; readonly submitted: boolean; readonly contest: boolean; readonly ctx: PrototypeProps["ctx"] }): ReactElement {
  const owner = ctx.key === "owner";
  const shown: Statement["state"] = submitted && statement.state === "PAID" ? "APPROVED" : statement.state;
  const keyOf = (line: Statement["lines"][number]): string => `${line.agency}-${line.project}`;
  const contested = statement.lines.find((line) => line.agency === RELATIONSHIP_AGENCY);
  // a line is asked about from its own row: the form names it, so nobody types which line they mean
  const [asking, setAsking] = useState<string | null>(contest && statement.state === "PAID" && contested !== undefined ? keyOf(contested) : null);
  const askable = !owner && statement.state !== "DRAFT";
  const asked = statement.lines.find((line) => keyOf(line) === asking);
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
          <dd>{shown === "PAID" ? statement.paid : shown === "DRAFT" ? "Nov 9, 2026" : statement.payDue}</dd>
        </div>
      </dl>
      {shown === "DRAFT" ? <p className="kauro-muted">A draft changes until it is issued: a refund or a correction this month changes it.</p> : null}
      {submitted && statement.state === "PAID" ? (
        <p className="kauro-statement-proof">Transfer sent on Oct 15, 2026. It shows as paid once the bank confirms it reached your account; until then, it is not.</p>
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
              {askable ? (
                <th scope="col">
                  <span className="kauro-visually-hidden">Question</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line) => (
              <tr key={keyOf(line)} className={keyOf(line) === asking ? "is-asked" : undefined}>
                <th scope="row">
                  <span className="kauro-statement-agency">
                    {owner && line.agency === RELATIONSHIP_AGENCY ? (
                      <ScreenLink to="UI35" ctx={ctx}>
                        {line.agency}
                      </ScreenLink>
                    ) : (
                      line.agency
                    )}
                  </span>
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
                {askable ? (
                  <td className="kauro-statement-ask">
                    <button type="button" className="kauro-text-button" onClick={() => setAsking(keyOf(line))} aria-pressed={keyOf(line) === asking}>
                      Ask about this line<span className="kauro-visually-hidden">: {line.agency}, {line.project}</span>
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {asked === undefined ? null : (
        <div className="kauro-approve-code">
          <p className="kauro-statement-asked">
            About <strong>{asked.agency}</strong>, {asked.project}: basis {usd(asked.basisCents)}, {asked.rate}%
          </p>
          <Field id={`ask-${statement.period.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} label="What is wrong with this line" hint="Say what you expected and why; the owner answers in writing, with the evidence.">
            {(control) => <textarea {...control} rows={3} defaultValue={asked.agency === RELATIONSHIP_AGENCY ? "The agency told me it paid more than USD 2,295.00 for this project." : ""} />}
          </Field>
          <div className="kauro-actions">
            <Button variant="primary">Send to the owner</Button>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
          </div>
          <p className="kauro-muted">The rest of the statement is not affected while the owner answers.</p>
        </div>
      )}
    </section>
  );
}

export function Commissions({ ctx, state }: PrototypeProps): ReactElement {
  return (
    <>
      <PageHead title="Commissions" lead="Understand what was earned, held and paid." />
      {ctx.key === "owner" ? (
        <p className="kauro-statement-of">
          Statements of{" "}
          <ScreenLink to="UI37" ctx={ctx}>
            {SELLER.name}
          </ScreenLink>
          , seller since Jul 1, 2026
        </p>
      ) : null}
      {state === "submitted" ? (
        <Banner tone="info" title="September's transfer is on its way" announce="status">
          <p>Sent on Oct 15, 2026. A transfer that has been sent is not yet money received: this page says paid when the bank confirms it.</p>
        </Banner>
      ) : null}
      <aside className="kauro-statement-rules" aria-label="How commissions are counted">
        <p>
          <strong>{FIRST_RATE}%</strong> of an agency&apos;s first project, <strong>{REPEAT_RATE}%</strong> of its repeats for {WINDOW_MONTHS} months after its first payment, counted on the service collected after discount, net of refunds and without tax. A line is payable {ELIGIBLE_DAYS} days after its project is complete. Each month&apos;s statement is issued on the {STATEMENT_BUSINESS_DAY}th business day of the next month and paid on the {PAYOUT_BUSINESS_DAY}th, on the Bogotá calendar.
        </p>
      </aside>
      {STATEMENTS.map((statement) => (
        <StatementCard key={statement.period} statement={statement} submitted={state === "submitted"} contest={state === "contest"} ctx={ctx} />
      ))}
    </>
  );
}

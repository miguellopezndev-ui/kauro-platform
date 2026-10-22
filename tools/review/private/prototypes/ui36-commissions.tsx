"use client";
// UI36 Commissions (registry: "Understand what was earned, held and paid."). Round 2 (seller-portal.md §3.3, §10; owner-console.md §6.3).
// The seller's page answers two questions: is every amount right, and when does it arrive. So it opens on one sentence with the next
// payment, then the lines earned and not on a statement yet, then the statements, newest first, each line with its own calculation and
// milestone dates one click away, so a seller never needs a spreadsheet to check it. The rules are there once, collapsed: they are
// reference, not news. One word per contract state (Earned, Held, Payable, On statement, Paid, Adjusted, Void), defined once.
//
// The owner sees the same page for one seller (the address names which), with the owner's acts in their fixed order: approve the payout
// (CMD052) once the statement is issued, make the transfer outside Kauro, record it as sent; "Paid" only with the bank's proof (CMD053, inert
// today, so the page says so). A seller contests a line from its row; the rest of the statement goes on. PDF and CSV are proposed (needs a
// contract: the api has no export of a statement).
import { Banner, Button, Field } from "@kauro/ui";
import { useSearchParams } from "next/navigation";
import { Fragment, type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Back, OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";
import {
  ELIGIBLE_DAYS,
  FIRST_RATE,
  REPEAT_RATE,
  SELLER,
  STATEMENT_TONE,
  STATEMENT_WORD,
  WINDOW_MONTHS,
  amount,
  earnedOf,
  heldOf,
  lineWord,
  linesOf,
  payableOf,
  sellerById,
  statementLines,
  statementsOf,
  usd,
  type Line,
  type Seller,
  type Statement,
  type StatementState,
} from "./sales.ts";

export const UI36_STATES: readonly StateDef[] = [
  { key: "normal", label: "Statements", note: "Oct 21: October is a draft until Nov 9, with a USD 30.00 offset after a refund and its balance; September paid; two lines not on a statement yet. As the owner, ?seller= opens another seller (Amara Okafor: a retainer)." },
  { key: "issued", label: "Statement issued", note: "Nov 10: October is issued. The owner approves the payout here; the seller reads the date it is paid by." },
  { key: "submitted", label: "Transfer sent", note: "September's transfer sent and not confirmed: never shown as paid until the bank confirms it." },
  { key: "contest", label: "Asking about a line", note: "The seller asks about one line from its row: the form names the line, and the rest of the statement goes on." },
];

const VOCABULARY: readonly (readonly [string, string])[] = [
  ["Earned", "The customer paid. It becomes payable 30 days after the project is complete."],
  ["Held", "Part or all of a line is kept back, with its reason and a review date."],
  ["Payable", "It goes on the next statement, issued on the 5th business day of the next month."],
  ["On statement", "The statement is issued; payment is scheduled by the 10th business day."],
  ["Paid", "The bank confirmed the transfer; its reference is kept with the statement."],
  ["Adjusted", "A refund or correction changed the basis; the earlier amount stays visible."],
  ["Void", "The service was fully reversed; nothing is owed on the line."],
];

function Rules({ open }: { readonly open: boolean }): ReactElement {
  return (
    <details className="kauro-ops-disclosure" open={open}>
      <summary>How commissions are counted</summary>
      <div className="kauro-ops-disclosure-body">
        <p>
          {FIRST_RATE}% of a customer&apos;s first project and {REPEAT_RATE}% of its repeats for {WINDOW_MONTHS} months after its first payment, counted on the service collected after discount, net of refunds and without tax. A line is payable {ELIGIBLE_DAYS} days after its project is complete. Each month&apos;s statement is issued on the 5th business day of the next month and paid by the 10th, on the Bogotá calendar.
        </p>
        <dl className="kauro-ops-facts">
          {VOCABULARY.map(([word, meaning]) => (
            <div key={word}>
              <dt>{word}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

const KIND: Readonly<Record<Line["sequence"], string>> = { FIRST: "First project", REPEAT: "Repeat", ADJUSTMENT: "Offset after a refund", RETAINER: "Fixed by the agreement" };

function LineDetail({ line }: { readonly line: Line }): ReactElement {
  if (line.sequence === "RETAINER")
    return (
      <dl className="kauro-ops-facts">
        <div>
          <dt>Retainer</dt>
          <dd>The fixed monthly payment the signed agreement sets for {line.project}: {usd(earnedOf(line))}. It is not a commission and does not depend on sales.</dd>
        </div>
      </dl>
    );
  if (line.offset !== undefined)
    return (
      <dl className="kauro-ops-facts">
        <div>
          <dt>Refund</dt>
          <dd>
            {line.offset.refund}: {usd(line.offset.refundCents)} paid back to {line.customer} for {line.project}, approved {line.offset.approvedOn}
          </dd>
        </div>
        <div>
          <dt>Rule</dt>
          <dd>{line.offset.rule}. Applied only as the agreement in force and the applicable rules allow.</dd>
        </div>
        <div>
          <dt>Calculation</dt>
          <dd>
            {line.rate}% of {usd(-line.basisCents)} refunded = {usd(-earnedOf(line))}, taken from this statement. The original line (paid in September) stays as it was.
          </dd>
        </div>
      </dl>
    );
  return (
    <dl className="kauro-ops-facts">
      <div>
        <dt>Calculation</dt>
        <dd>
          {line.rate}% of {usd(line.basisCents)} = {usd(earnedOf(line))}
        </dd>
      </div>
      <div>
        <dt>Milestones</dt>
        <dd>
          Customer paid {line.paidOn}
          {line.completedOn === null ? "; project not complete yet" : `; complete ${line.completedOn}; payable from ${line.payableFrom ?? ""}`}
        </dd>
      </div>
      {line.hold === undefined ? null : (
        <div>
          <dt>Held</dt>
          <dd>
            {line.hold.reason}. Review on {line.hold.review}.
          </dd>
        </div>
      )}
    </dl>
  );
}

/** A statement's balance in words, when an offset or a retainer makes it more than a sum of commissions. */
function Balance({ lines, paid }: { readonly lines: readonly Line[]; readonly paid: boolean }): ReactElement | null {
  const commission = lines.filter((one) => one.sequence === "FIRST" || one.sequence === "REPEAT").reduce((sum, one) => sum + earnedOf(one), 0);
  const offsets = lines.filter((one) => one.sequence === "ADJUSTMENT").reduce((sum, one) => sum + earnedOf(one), 0);
  const retainer = lines.filter((one) => one.sequence === "RETAINER").reduce((sum, one) => sum + earnedOf(one), 0);
  const held = heldOf(lines);
  if ((offsets === 0 && retainer === 0) || lines.length < 2) return null;
  const parts = [`commission earned ${amount(commission)}`, held > 0 ? `held ${amount(-held)}` : null, offsets !== 0 ? `offset ${amount(offsets)}` : null, retainer > 0 ? `retainer +${amount(retainer)}` : null].filter((part) => part !== null);
  return (
    <p className="kauro-ops-balance">
      Balance (USD): {parts.join(" · ")} = <strong>{amount(payableOf(lines))} {paid ? "paid" : "payable"}</strong>
    </p>
  );
}

function payoutSentence(statement: Statement, shown: StatementState, sent: boolean, seller: Seller): string {
  if (sent) return `The transfer was sent on ${statement.payDue} to the account ending ${seller.payout.label}. It is marked paid when the bank confirms it; do not expect a second transfer.`;
  switch (shown) {
    case "DRAFT":
      return `A draft until it is issued on ${statement.issuedOn}: a refund or a correction this month still changes it. Paid by ${statement.payDue}.`;
    case "ISSUED":
      return `Issued on ${statement.issuedOn}. Payment is scheduled by ${statement.payDue}.`;
    case "APPROVED":
      return `Kauro approved the payment of ${usd(payableOf(statementLines(statement)))} to the account ending ${seller.payout.label}.`;
    case "PAID":
      return `Paid on ${statement.paidOn ?? ""} to the account ending ${seller.payout.label}, reference ${statement.reference ?? ""}. The bank's confirmation is kept with the statement.`;
    default:
      return "";
  }
}

function StatementBlock({ statement, shown, sent, asking: initialAsk, owner, seller }: { readonly statement: Statement; readonly shown: StatementState; readonly sent: boolean; readonly asking: string | null; readonly owner: boolean; readonly seller: Seller }): ReactElement {
  const lines = statementLines(statement);
  const [open, setOpen] = useState<string | null>(initialAsk);
  const [asking, setAsking] = useState<string | null>(initialAsk);
  const asked = lines.find((one) => one.id === asking);
  const issued = shown !== "DRAFT";
  const id = `st-${statement.id}`;
  return (
    <section aria-labelledby={id}>
      <SectionHead
        id={id}
        title={
          <>
            {statement.period} <Word tone={sent ? "info" : STATEMENT_TONE[shown]}>{sent ? "Sent, not yet confirmed" : STATEMENT_WORD[shown]}</Word>
          </>
        }
        meta={payoutSentence(statement, shown, sent, seller)}
        aside={
          issued ? (
            <span className="kauro-ops-head-action">
              <button type="button" className="kauro-text-button">
                PDF<span className="kauro-visually-hidden"> of {statement.period}</span>
              </button>
              <button type="button" className="kauro-text-button">
                CSV<span className="kauro-visually-hidden"> of {statement.period}</span>
              </button>
            </span>
          ) : undefined
        }
      />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">The lines of {statement.period}</caption>
            <thead>
              <tr>
                <th scope="col">Customer and project</th>
                <th scope="col" className="kauro-table-end">
                  Basis (USD)
                </th>
                <th scope="col" className="kauro-table-end">
                  Rate
                </th>
                <th scope="col" className="kauro-table-end">
                  Earned (USD)
                </th>
                <th scope="col" className="kauro-table-end">
                  Held (USD)
                </th>
                <th scope="col" className="kauro-table-end">
                  This statement (USD)
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <Fragment key={line.id}>
                  <tr className={[line.id === open ? "is-open" : null, line.offset === undefined ? null : "is-offset", line.sequence === "RETAINER" ? "is-retainer" : null].filter((one) => one !== null).join(" ") || undefined}>
                    <th scope="row">
                      <button type="button" className="kauro-ops-rowbutton" aria-expanded={line.id === open} onClick={() => setOpen(line.id === open ? null : line.id)}>
                        {line.sequence === "RETAINER" ? "Monthly retainer" : line.customer}
                      </button>
                      <span className="kauro-ops-sub">
                        {line.project} · {KIND[line.sequence]}
                        {line.offset === undefined ? null : (
                          <>
                            {" · "}
                            <span className="kauro-ops-date">{line.offset.refund}</span>
                          </>
                        )}
                      </span>
                      {line.state === "HELD" ? (
                        <span className="kauro-ops-cell-badge">
                          <Word tone="warning">{lineWord(line)}</Word>
                        </span>
                      ) : null}
                    </th>
                    <td className="kauro-table-end" data-label="Basis (USD)">
                      <span>{line.sequence === "RETAINER" ? "—" : amount(line.basisCents)}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Rate">
                      <span>{line.sequence === "RETAINER" ? "—" : `${line.rate}%`}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Earned (USD)">
                      <span>{amount(earnedOf(line))}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Held (USD)">
                      <span>{line.state === "HELD" ? amount(earnedOf(line)) : <span className="kauro-ops-zero">0.00</span>}</span>
                    </td>
                    <td className="kauro-table-end" data-label="This statement (USD)">
                      <span>{line.state === "HELD" ? <span className="kauro-ops-zero">0.00</span> : amount(earnedOf(line))}</span>
                    </td>
                  </tr>
                  {line.id === open ? (
                    <tr className="kauro-ops-detailrow">
                      <td colSpan={6}>
                        <LineDetail line={line} />
                        {!owner && issued ? (
                          <button type="button" className="kauro-text-button" onClick={() => setAsking(line.id)}>
                            Ask about this line<span className="kauro-visually-hidden">: {line.customer}, {line.project}</span>
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
            {lines.length < 2 ? null : (
            <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="kauro-table-end" data-label="Basis (USD)">
                    <span>{amount(lines.reduce((sum, one) => sum + one.basisCents, 0))}</span>
                  </td>
                  <td />
                  <td className="kauro-table-end" data-label="Earned (USD)">
                    <span>{amount(lines.reduce((sum, one) => sum + earnedOf(one), 0))}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Held (USD)">
                    <span>{amount(heldOf(lines))}</span>
                  </td>
                  <td className="kauro-table-end" data-label="This statement (USD)">
                    <span>{amount(payableOf(lines))}</span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      <Balance lines={lines} paid={shown === "PAID"} />
      {asked === undefined ? null : (
        <div className="kauro-ops-decide kauro-ops-ask">
          <h3>
            About {asked.customer}, {asked.project}
          </h3>
          <p className="kauro-muted">
            Basis {usd(asked.basisCents)} · {asked.rate}% · earned {usd(earnedOf(asked))}
          </p>
          <Field id={`ask-${statement.id}`} label="What looks wrong" hint="Say what you expected and why; the owner answers in writing, with the evidence">
            {(control) => <textarea {...control} rows={3} defaultValue={asked.customer === "Coastline Analytics" ? "Coastline told me this project was larger than USD 2,295.00." : ""} />}
          </Field>
          <div className="kauro-actions">
            <Button variant="primary">Send to Kauro</Button>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
          </div>
          <p className="kauro-muted">The rest of the statement is not affected while Kauro answers.</p>
        </div>
      )}
      {owner && shown === "ISSUED" ? (
        <div className="kauro-ops-decide kauro-ops-ask">
          <h3>Approve this payout</h3>
          <p>
            {usd(payableOf(lines))} to {seller.name}, to the verified account ending {seller.payout.label}, by {statement.payDue}. Kauro pays the transfer fees. After approving, you make the transfer from the bank and record it here as sent.
          </p>
          <div className="kauro-actions">
            <Button variant="primary">Approve the payout</Button>
          </div>
          <p className="kauro-muted">Approving asks for a fresh confirmation of your identity.</p>
        </div>
      ) : null}
      {owner && shown === "DRAFT" && !sent ? <p className="kauro-muted">You approve it once it is issued, on {statement.issuedOn}.</p> : null}
      {owner && sent ? <p className="kauro-muted">Recording the bank&apos;s proof is not connected yet (payout reconciliation is inert in this build); until it is, this statement stays sent, never paid.</p> : null}
    </section>
  );
}

export function Commissions({ ctx, state }: PrototypeProps): ReactElement {
  const params = useSearchParams();
  const owner = ctx.key === "owner";
  const seller = (owner ? sellerById(params?.get("seller")) : undefined) ?? SELLER;
  const statements = statementsOf(seller.id);
  const accruing = linesOf(seller.id).filter((one) => one.state === "ACCRUED_PENDING");
  const next = statements.find((one) => one.state !== "PAID");
  const shownOf = (one: Statement): StatementState => (one.state === "DRAFT" && state === "issued" ? "ISSUED" : one.state === "PAID" && state === "submitted" ? "APPROVED" : one.state);
  const nextPayable = next === undefined ? 0 : payableOf(statementLines(next));
  const sentence =
    next === undefined
      ? "No payment is scheduled."
      : `Next payment: ${usd(nextPayable)} by ${next.payDue} (${next.period} statement, ${shownOf(next) === "DRAFT" ? `issued ${next.issuedOn}` : `issued on ${next.issuedOn}`}).`;
  return (
    <OpsPage>
      <OpsHead
        back={owner ? <Back href={OPS_PATH.payouts}>Payouts</Back> : undefined}
        title={owner ? `${seller.name}'s commissions` : "Commissions"}
        lead={sentence}
      />
      {state === "submitted" && !owner ? (
        <Banner tone="info" title="September's transfer is on its way" announce="status">
          <p>Sent on Oct 15, 2026. A transfer that has been sent is not yet money received: this page says paid when the bank confirms it.</p>
        </Banner>
      ) : null}
      <Rules open={false} />
      {accruing.length === 0 ? null : (
        <section aria-labelledby="accruing-h">
          <SectionHead id="accruing-h" title="Earned, not on a statement yet" meta={`Each becomes payable ${ELIGIBLE_DAYS} days after its project is complete, then goes on that month's statement`} />
          <div className="kauro-ops-tablewrap">
            <div className="kauro-table-region">
              <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
                <caption className="kauro-visually-hidden">Lines earned and not on a statement yet</caption>
                <thead>
                  <tr>
                    <th scope="col">Customer and project</th>
                    <th scope="col">Customer paid</th>
                    <th scope="col" className="kauro-table-end">
                      Basis (USD)
                    </th>
                    <th scope="col" className="kauro-table-end">
                      Rate
                    </th>
                    <th scope="col" className="kauro-table-end">
                      Earned (USD)
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {accruing.map((line) => (
                    <tr key={line.id}>
                      <th scope="row">
                        {line.customer}
                        <span className="kauro-ops-sub">
                          {line.project} · {line.sequence === "FIRST" ? "First project" : "Repeat"}
                        </span>
                      </th>
                      <td data-label="Customer paid">
                        <span className="kauro-ops-date">{line.paidOn}</span>
                      </td>
                      <td className="kauro-table-end" data-label="Basis (USD)">
                        <span>{amount(line.basisCents)}</span>
                      </td>
                      <td className="kauro-table-end" data-label="Rate">
                        <span>{line.rate}%</span>
                      </td>
                      <td className="kauro-table-end" data-label="Earned (USD)">
                        <span>{amount(earnedOf(line))}</span>
                      </td>
                      <td data-label="State">
                        <span>{lineWord(line)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
      {statements.map((statement) => (
        <StatementBlock
          key={statement.id}
          statement={statement}
          shown={shownOf(statement)}
          sent={state === "submitted" && statement.state === "PAID"}
          asking={state === "contest" && !owner && statement.state === "PAID" ? (statementLines(statement)[0]?.id ?? null) : null}
          owner={owner}
          seller={seller}
        />
      ))}
    </OpsPage>
  );
}

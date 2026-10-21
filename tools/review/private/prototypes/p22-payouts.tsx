"use client";
// P-22 Payouts (proposed; round 2, owner-console.md §6). The owner pays every seller, so this page is the payer's view: what is owed to
// whom, by when, and what holds it. A month is the unit (every product in the sample groups commissions into a monthly payout). The cycle
// is one dated sentence; then only the groups that have something in them (to approve, sent and not yet confirmed); then every statement in
// one table with a total; then what is coming, as facts only (no projected amount for a project not yet bought: that would be an invented
// number). The rules paragraph lives in Settings › Commissions; this page links to it once.
//
// Approve payout exists (CMD052, the owner, step-up). "Paid" needs the bank's proof (CMD053); recording that proof is inert today, so the
// page says so in words instead of drawing a disabled control. Needs a read (gap): statements across sellers by period
// (GetCommissionStatement reads one statement by id).
import { type ReactElement, useState } from "react";
import Link from "next/link";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, Queue, SectionHead, Word } from "./ops-kit.tsx";
import { AS_OF, LINES, STATEMENTS, STATEMENT_TONE, STATEMENT_WORD, amount, earnedOf, heldOf, payableOf, sellerById, statementLines, usd, type Statement, type StatementState } from "./sales.ts";

export const P22_STATES: readonly StateDef[] = [
  { key: "normal", label: "October in progress", note: "Oct 21: October's statements are drafts until Nov 9; nothing to approve yet." },
  { key: "approve", label: "Statements to approve", note: "Nov 10: October's statements are issued; each waits for your approval before the pay date, Nov 17." },
  { key: "sent", label: "Sent, not yet confirmed", note: "Nov 17: both transfers sent; each is paid only once the bank's proof is recorded." },
];

type Show = "all" | "open" | "paid";

export function Payouts({ state }: PrototypeProps): ReactElement {
  const [show, setShow] = useState<Show>("all");
  const stateOf = (statement: Statement): StatementState => (statement.state !== "DRAFT" ? statement.state : state === "approve" ? "ISSUED" : state === "sent" ? "APPROVED" : "DRAFT");
  const october = STATEMENTS.filter((one) => one.period === "October 2026");
  const rows = STATEMENTS.filter((one) => (show === "all" ? true : show === "paid" ? stateOf(one) === "PAID" : stateOf(one) !== "PAID"));
  const totals = rows.reduce((sum, one) => ({ held: sum.held + heldOf(statementLines(one)), payable: sum.payable + payableOf(statementLines(one)) }), { held: 0, payable: 0 });
  const owed = october.reduce((sum, one) => ({ held: sum.held + heldOf(statementLines(one)), payable: sum.payable + payableOf(statementLines(one)) }), { held: 0, payable: 0 });
  const accruing = LINES.filter((one) => one.state === "ACCRUED_PENDING");
  const heldLine = LINES.find((one) => one.state === "HELD");
  return (
    <OpsPage>
      <OpsHead title="Payouts" lead="What you owe sellers, when, and what is holding it." />
      <p className="kauro-ops-sentence">
        {state === "approve" ? (
          <>
            October 2026 statements were issued on Nov 9. Approve each before the pay date, <strong>Nov 17, 2026</strong>: <strong>{usd(owed.payable)}</strong> to pay, <strong>{usd(owed.held)}</strong> held.
          </>
        ) : state === "sent" ? (
          <>
            October 2026 statements were approved and both transfers sent on <strong>Nov 17, 2026</strong>: <strong>{usd(owed.payable)}</strong>. Each is paid once the bank confirms it.
          </>
        ) : (
          <>
            October 2026 statements are drafts until <strong>Nov 9, 2026</strong>, when they are issued, and are paid by <strong>Nov 17, 2026</strong>: <strong>{usd(owed.payable)}</strong> payable, <strong>{usd(owed.held)}</strong> held. Bogotá business days; as of {AS_OF}.
          </>
        )}
      </p>
      {state === "approve" ? (
        <section aria-labelledby="approve-h">
          <SectionHead id="approve-h" title="To approve" meta="Approving asks for a fresh confirmation of your identity; then you make the transfer from the bank" />
          <Queue
            label="Statements to approve"
            items={october.map((one, index) => {
              const lines = statementLines(one);
              const held = heldOf(lines);
              return {
                key: one.id,
                what: `${sellerById(one.sellerId)?.name ?? ""} · ${one.period}`,
                why: `${usd(payableOf(lines))} to pay${held > 0 ? ` · ${usd(held)} held until Nov 4` : ""} · ${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
                due: "Pay by Nov 17",
                urgent: index === 0,
                action: { label: "Review and approve", href: OPS_PATH.statements(one.sellerId) },
              };
            })}
          />
        </section>
      ) : null}
      {state === "sent" ? (
        <section aria-labelledby="sent-h">
          <SectionHead id="sent-h" title="Sent, not yet confirmed" />
          <ul className="kauro-ops-lines">
            {october.map((one) => (
              <li key={one.id}>
                <strong>{sellerById(one.sellerId)?.name}</strong>: {usd(payableOf(statementLines(one)))} sent on Nov 17 to the account ending {sellerById(one.sellerId)?.payout.label}. Not paid until the bank&apos;s proof is recorded.
              </li>
            ))}
          </ul>
          <p className="kauro-muted">Recording the bank&apos;s proof is not connected yet (payout reconciliation is inert in this build). Until it is, these stay sent, never paid.</p>
        </section>
      ) : null}
      <section aria-labelledby="statements-h">
        <SectionHead id="statements-h" title="Statements" aside={<Link href={`${OPS_PATH.settings}#commissions`}>How commissions are counted</Link>} />
        <Filter<Show>
          label="Show statements"
          value={show}
          onChange={setShow}
          options={[
            { key: "all", label: "All" },
            { key: "open", label: "Not paid yet" },
            { key: "paid", label: "Paid" },
          ]}
        />
        <div className="kauro-ops-tablewrap">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
              <caption className="kauro-visually-hidden">Every seller&apos;s statements, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Seller and period</th>
                  <th scope="col">State</th>
                  <th scope="col" className="kauro-table-end">
                    Held (USD)
                  </th>
                  <th scope="col" className="kauro-table-end">
                    Payable (USD)
                  </th>
                  <th scope="col">Pay by</th>
                  <th scope="col">Paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((one) => {
                  const lines = statementLines(one);
                  const shown = stateOf(one);
                  return (
                    <tr key={one.id}>
                      <th scope="row">
                        <Link href={OPS_PATH.statements(one.sellerId)} prefetch={false}>
                          {sellerById(one.sellerId)?.name}
                        </Link>
                        <span className="kauro-ops-sub">
                          {one.period} · {lines.length} {lines.length === 1 ? "line" : "lines"}
                        </span>
                      </th>
                      <td data-label="State">
                        <span>
                          <Word tone={STATEMENT_TONE[shown]}>{state === "sent" && shown === "APPROVED" ? "Sent, not yet confirmed" : STATEMENT_WORD[shown]}</Word>
                        </span>
                      </td>
                      <td className="kauro-table-end" data-label="Held (USD)">
                        <span>{heldOf(lines) === 0 ? <span className="kauro-ops-zero">0.00</span> : amount(heldOf(lines))}</span>
                      </td>
                      <td className="kauro-table-end" data-label="Payable (USD)">
                        <span>{amount(payableOf(lines))}</span>
                      </td>
                      <td data-label="Pay by">
                        <span className="kauro-ops-date">{one.payDue}</span>
                      </td>
                      <td data-label="Paid">
                        <span>
                          {one.paidOn ?? "—"}
                          {one.reference === null ? null : <span className="kauro-ops-sub">{one.reference}</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">
                    {rows.length} {rows.length === 1 ? "statement" : "statements"}
                  </th>
                  <td />
                  <td className="kauro-table-end" data-label="Held (USD)">
                    <span>{amount(totals.held)}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Payable (USD)">
                    <span>{amount(totals.payable)}</span>
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>
      <section aria-labelledby="coming-h">
        <SectionHead id="coming-h" title="Coming" meta="Facts only: Kauro does not forecast a project that has not been bought" />
        <ul className="kauro-ops-lines">
          <li>
            {usd(accruing.reduce((sum, one) => sum + earnedOf(one), 0))} earned by Daniel Kim on {accruing.length} paid projects not complete yet ({accruing.map((one) => one.customer).join(" and ")}). Each becomes payable 30 days after its project is complete.
          </li>
          {heldLine === undefined ? null : (
            <li>
              One held line, {sellerById(heldLine.sellerId)?.name}&apos;s on {heldLine.customer} ({usd(earnedOf(heldLine))}), is reviewed on {heldLine.hold?.review}.
            </li>
          )}
          <li>No repeat window ends in the next 90 days. The first, Quillon Partners&apos;, ends on Jul 20, 2027.</li>
        </ul>
      </section>
    </OpsPage>
  );
}

"use client";
// P-21 Sellers (proposed; round 2, owner-console.md §4; the owner's decisions of 2026-10-21). The owner's answer to "who sells for Kauro,
// what did each bring in, and what do I owe each": one row per seller, the identifier first, then four money figures that are never mixed:
//   - Net revenue: what the customers attributed to the seller actually paid for the service (collections, not invoices), net of refunds,
//     without tax (tax is never Kauro's revenue). Each collection is counted once, for one seller, in the month it happened; a refund counts
//     in the month of the refund.
//   - Commission generated: earned on that revenue, offsets after refunds included.
//   - Commission pending: generated and not yet paid (payable on a statement, held, or waiting for a project to finish).
//   - Commission paid: confirmed by the bank.
// A retainer (a fixed monthly payment a signed agreement may set; zero by default) is never hidden: it is named beside the seller and
// counted in what is owed, apart from commission. A period changes revenue, generated and paid; pending is always as of now.
//
// Not here, on purpose: clicks, visitors, conversion, rankings, medals or charts. Needs reads (gaps F-11, F-12): the api lists no sellers and
// aggregates nothing across them. This page is drawn from the review's fixture.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, Word } from "./ops-kit.tsx";
import { AS_OF, CLAIMS, CUSTOMERS, FIRST_RATE, REPEAT_RATE, SELLERS, SELLER_ID, SELLER_STATE_TONE, SELLER_STATE_WORD, WINDOW_MONTHS, amount, moneyOf, usd, type Seller } from "./sales.ts";

export const P21_STATES: readonly StateDef[] = [
  { key: "normal", label: "Sellers", note: "Four sellers since the start: net revenue, commission generated, pending and paid; one seller with a retainer; a total." },
  { key: "month", label: "This month", note: "October 2026 so far: revenue, generated and paid for the month (a refund counts in its month); pending stays as of now." },
];

type Period = "month" | "last" | "start";
const PERIOD: Readonly<Record<Period, { readonly label: string; readonly header: string; readonly month: string | null }>> = {
  month: { label: "This month", header: "Oct 1–21", month: "Oct" },
  last: { label: "Last month", header: "Sep 2026", month: "Sep" },
  start: { label: "Since start", header: "Since Jul 1", month: null },
};
type Tab = "all" | "needs" | "active" | "onboarding" | "ended";

/** What needs the owner, per seller (the same items Today's queue lists). */
const NEEDS: Readonly<Record<string, string>> = {
  [SELLER_ID.daniel]: "Needs you: a claim, a message",
  [SELLER_ID.lucia]: "Needs you: the assessment, Oct 23",
};

function customersOf(seller: Seller): string {
  const mine = CUSTOMERS.filter((one) => one.acquiredBy === seller.id);
  if (mine.length === 0) return "No customers yet";
  const agencies = mine.filter((one) => one.kind === "Agency").length;
  const companies = mine.length - agencies;
  const parts = [agencies > 0 ? `${agencies} ${agencies === 1 ? "agency" : "agencies"}` : null, companies > 0 ? `${companies} ${companies === 1 ? "company" : "companies"}` : null].filter((part) => part !== null);
  return `${mine.length} ${mine.length === 1 ? "customer" : "customers"}: ${parts.join(", ")}`;
}

function claimsLine(seller: Seller): string | null {
  const mine = CLAIMS.filter((one) => one.sellerId === seller.id);
  const accepted = mine.filter((one) => one.state === "ACCEPTED").length;
  const deciding = mine.filter((one) => one.state === "SUBMITTED" || one.state === "DISPUTED").length;
  const parts = [accepted > 0 ? `${accepted} accepted` : null, deciding > 0 ? `${deciding} to decide` : null].filter((part) => part !== null);
  return parts.length === 0 ? null : `Claims: ${parts.join(" · ")}`;
}

const cents = (value: number): ReactElement => (value === 0 ? <span className="kauro-ops-zero">0.00</span> : <>{amount(value)}</>);

export function SellersList({ state }: PrototypeProps): ReactElement {
  const [tab, setTab] = useState<Tab>("all");
  const [period, setPeriod] = useState<Period>(state === "month" ? "month" : "start");
  const inTab = (seller: Seller): boolean =>
    tab === "all" ? true : tab === "needs" ? NEEDS[seller.id] !== undefined : tab === "active" ? seller.state === "ACTIVE" : tab === "onboarding" ? seller.state === "CANDIDATE" : seller.state === "TERMINATED";
  const counts = {
    all: SELLERS.length,
    needs: SELLERS.filter((one) => NEEDS[one.id] !== undefined).length,
    active: SELLERS.filter((one) => one.state === "ACTIVE").length,
    onboarding: SELLERS.filter((one) => one.state === "CANDIDATE").length,
    ended: SELLERS.filter((one) => one.state === "TERMINATED").length,
  };
  const month = PERIOD[period].month;
  const rows = SELLERS.filter(inTab)
    .map((seller) => ({ seller, now: moneyOf(seller.id), money: moneyOf(seller.id, month) }))
    .sort((a, b) => b.now.pending + b.now.retainerPending - (a.now.pending + a.now.retainerPending) || b.money.collected - a.money.collected);
  const sum = rows.reduce(
    (acc, row) => ({
      collected: acc.collected + row.money.collected,
      earned: acc.earned + row.money.earned,
      pending: acc.pending + row.now.pending,
      paid: acc.paid + row.money.paid,
      retainerPending: acc.retainerPending + row.now.retainerPending,
      retainerPaid: acc.retainerPaid + row.money.retainerPaid,
    }),
    { collected: 0, earned: 0, pending: 0, paid: 0, retainerPending: 0, retainerPaid: 0 },
  );
  const all = SELLERS.map((one) => moneyOf(one.id));
  const owedCommission = all.reduce((total, one) => total + one.payable, 0);
  const owedRetainer = all.reduce((total, one) => total + one.retainerPending, 0);
  const held = all.reduce((total, one) => total + one.held, 0);
  const withRetainer = SELLERS.filter((one) => one.retainerCents > 0);
  return (
    <OpsPage>
      <OpsHead title="Sellers" lead="Who sells for Kauro, what they brought in and what you owe them." action={<Button variant="primary">Register a seller</Button>} />
      <p className="kauro-ops-sentence">
        You owe sellers <strong>{usd(owedCommission + owedRetainer)}</strong> by Nov 17, 2026: {usd(owedCommission)} of commission and a {usd(owedRetainer)} retainer. {usd(held)} of commission is held. As of {AS_OF}.{" "}
        <Link href={OPS_PATH.payouts}>Payouts</Link>
      </p>
      <div className="kauro-ops-toolbar">
        <Filter<Tab>
          label="Show sellers"
          value={tab}
          onChange={setTab}
          options={[
            { key: "all", label: "All", count: counts.all },
            { key: "needs", label: "Needs you", count: counts.needs },
            { key: "active", label: "Active", count: counts.active },
            { key: "onboarding", label: "Onboarding", count: counts.onboarding },
            { key: "ended", label: "Ended", count: counts.ended },
          ]}
        />
        <Filter<Period>
          label="Period of revenue, generated and paid"
          value={period}
          onChange={setPeriod}
          options={[
            { key: "month", label: PERIOD.month.label },
            { key: "last", label: PERIOD.last.label },
            { key: "start", label: PERIOD.start.label },
          ]}
        />
      </div>
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">Sellers: net revenue from their customers, and commission generated, pending and paid</caption>
            <thead>
              <tr>
                <th scope="col">Seller</th>
                <th scope="col" className="kauro-table-end">
                  Net revenue (USD)
                  <span className="kauro-ops-sub">{PERIOD[period].header}</span>
                </th>
                <th scope="col" className="kauro-table-end">
                  Commission generated (USD)
                  <span className="kauro-ops-sub">{PERIOD[period].header}</span>
                </th>
                <th scope="col" className="kauro-table-end" aria-sort="descending">
                  Commission pending (USD)
                  <span className="kauro-ops-sub">Now</span>
                </th>
                <th scope="col" className="kauro-table-end">
                  Commission paid (USD)
                  <span className="kauro-ops-sub">{PERIOD[period].header}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ seller, now, money }) => (
                <tr key={seller.id}>
                  <th scope="row">
                    <Link href={OPS_PATH.seller(seller.id)} prefetch={false}>
                      {seller.name}
                    </Link>
                    <span className="kauro-ops-cell-badge">
                      <Word tone={SELLER_STATE_TONE[seller.state]}>{SELLER_STATE_WORD[seller.state]}</Word>
                    </span>
                    <span className="kauro-ops-sub">{seller.state === "CANDIDATE" ? `Invited ${seller.since}` : seller.state === "TERMINATED" ? `Ended ${seller.endedOn ?? ""} · claims run to ${seller.tailUntil ?? ""}` : `Since ${seller.since}`}</span>
                    <span className="kauro-ops-sub">{customersOf(seller)}</span>
                    {claimsLine(seller) === null ? null : <span className="kauro-ops-sub">{claimsLine(seller)}</span>}
                    {seller.retainerCents > 0 ? <span className="kauro-ops-sub">Retainer {usd(seller.retainerCents)} a month, by its signed agreement</span> : null}
                    {NEEDS[seller.id] === undefined ? null : <span className="kauro-ops-sub kauro-ops-attention">{NEEDS[seller.id]}</span>}
                  </th>
                  <td className="kauro-table-end" data-label="Net revenue (USD)">
                    <span>{cents(money.collected)}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Commission generated (USD)">
                    <span>
                      {cents(money.earned)}
                      {money.offsets < 0 && month === null ? <span className="kauro-ops-sub">after {amount(-money.offsets)} offset</span> : null}
                    </span>
                  </td>
                  <td className="kauro-table-end" data-label="Commission pending (USD)">
                    <span>
                      {cents(now.pending)}
                      {now.payable !== 0 ? <span className="kauro-ops-sub">{amount(now.payable)} by Nov 17</span> : null}
                      {now.held > 0 ? <span className="kauro-ops-sub">{amount(now.held)} held</span> : null}
                      {now.accruing > 0 ? <span className="kauro-ops-sub">{amount(now.accruing)} waiting</span> : null}
                      {now.retainerPending > 0 ? <span className="kauro-ops-sub">+ retainer {amount(now.retainerPending)}</span> : null}
                    </span>
                  </td>
                  <td className="kauro-table-end" data-label="Commission paid (USD)">
                    <span>
                      {cents(money.paid)}
                      {money.retainerPaid > 0 ? <span className="kauro-ops-sub">+ retainer {amount(money.retainerPaid)}</span> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">
                  {rows.length} {rows.length === 1 ? "seller" : "sellers"}
                </th>
                <td className="kauro-table-end" data-label="Net revenue (USD)">
                  <span>{amount(sum.collected)}</span>
                </td>
                <td className="kauro-table-end" data-label="Commission generated (USD)">
                  <span>{amount(sum.earned)}</span>
                </td>
                <td className="kauro-table-end" data-label="Commission pending (USD)">
                  <span>
                    {amount(sum.pending)}
                    {sum.retainerPending > 0 ? <span className="kauro-ops-sub">+ retainer {amount(sum.retainerPending)}</span> : null}
                  </span>
                </td>
                <td className="kauro-table-end" data-label="Commission paid (USD)">
                  <span>
                    {amount(sum.paid)}
                    {sum.retainerPaid > 0 ? <span className="kauro-ops-sub">+ retainer {amount(sum.retainerPaid)}</span> : null}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <dl className="kauro-ops-facts kauro-ops-after-table">
        <div>
          <dt>Net revenue</dt>
          <dd>What the seller&apos;s customers actually paid for the service: collections, not invoices; net of refunds; without tax, which is never Kauro&apos;s revenue. Each collection counts once, for one seller, in the month it happened.</dd>
        </div>
        <div>
          <dt>Commission</dt>
          <dd>
            Generated on that revenue at the agreement&apos;s rates ({FIRST_RATE}% of a first project, {REPEAT_RATE}% of repeats for {WINDOW_MONTHS} months), after any offset for a refund. Pending: not paid yet (payable on a statement, held, or waiting for a project to finish). Paid: confirmed by the bank.
          </dd>
        </div>
        <div>
          <dt>Retainer</dt>
          <dd>
            {withRetainer.length === 0 ? "No agreement in force sets one." : withRetainer.map((one) => `${one.name}: ${usd(one.retainerCents)} a month since ${one.retainerFrom ?? ""}, by the signed ${one.agreement}`).join(" · ")}. It is owed apart from commission. New agreements start at USD 0.00.
          </dd>
        </div>
      </dl>
      <div className="kauro-actions">
        <Button>Download CSV</Button>
      </div>
    </OpsPage>
  );
}

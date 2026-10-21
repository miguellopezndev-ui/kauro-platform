"use client";
// P-21 Sellers (proposed; round 2, owner-console.md §4). The owner's answer to "who sells for Kauro, what did each bring in, and what do I
// owe each": one row per seller, the identifier first and the decision-driving figure (owed now) beside it, then the next date, the
// customers they brought by kind and count, what those customers paid (the commission base, so the two money columns agree), the
// commission earned, and the claims running. A total closes the table. Status is a filter with counts (Stripe's connected accounts); a
// status with no seller is not drawn. A period changes only the two money columns, and their headers say which period.
//
// Not here, on purpose: clicks, visitors, conversion, rankings, medals or charts (Kauro sellers use no tracking links; a ranking among a few
// independent contractors is noise). Rates: every agreement today carries the default rates, so they are one sentence, not a column of
// identical values; an agreement that differs would show its rates beside the name.
//
// Needs a read (gap): the api lists no sellers and aggregates nothing across them (owner-console.md §2.2). This page is drawn from the
// review's fixture.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, Word } from "./ops-kit.tsx";
import { AS_OF, CLAIMS, CUSTOMERS, FIRST_RATE, REPEAT_RATE, SELLERS, SELLER_ID, SELLER_STATE_TONE, SELLER_STATE_WORD, WINDOW_MONTHS, amount, earnedOf, linesOf, moneyOf, usd, type Seller } from "./sales.ts";

export const P21_STATES: readonly StateDef[] = [
  { key: "normal", label: "Sellers", note: "Four sellers: two active, one onboarding, one ended. Owed now first; a total closes the table." },
  { key: "month", label: "This month", note: "The same list for October 2026 so far: only the two money columns change, and their headers say so." },
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


function customersOf(seller: Seller): { readonly count: number; readonly kinds: string } {
  const mine = CUSTOMERS.filter((one) => one.acquiredBy === seller.id);
  const agencies = mine.filter((one) => one.kind === "Agency").length;
  const companies = mine.length - agencies;
  const parts = [agencies > 0 ? `${agencies} ${agencies === 1 ? "agency" : "agencies"}` : null, companies > 0 ? `${companies} ${companies === 1 ? "company" : "companies"}` : null].filter((part) => part !== null);
  return { count: mine.length, kinds: parts.join(", ") };
}

function claimsLine(seller: Seller): string {
  const mine = CLAIMS.filter((one) => one.sellerId === seller.id);
  const accepted = mine.filter((one) => one.state === "ACCEPTED").length;
  const deciding = mine.filter((one) => one.state === "SUBMITTED" || one.state === "DISPUTED").length;
  const parts = [accepted > 0 ? `${accepted} accepted` : null, deciding > 0 ? `${deciding} to decide` : null].filter((part) => part !== null);
  return parts.length === 0 ? "None" : parts.join(" · ");
}

function periodMoney(seller: Seller, period: Period): { readonly collected: number; readonly commission: number } {
  const month = PERIOD[period].month;
  const lines = linesOf(seller.id).filter((one) => month === null || one.paidOn.startsWith(month));
  return { collected: lines.reduce((sum, one) => sum + one.basisCents, 0), commission: lines.reduce((sum, one) => sum + earnedOf(one), 0) };
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
    suspended: SELLERS.filter((one) => one.state === "SUSPENDED").length,
    ended: SELLERS.filter((one) => one.state === "TERMINATED").length,
  };
  const rows = SELLERS.filter(inTab)
    .map((seller) => ({ seller, money: moneyOf(seller.id), period: periodMoney(seller, period), customers: customersOf(seller) }))
    .sort((a, b) => b.money.payable - a.money.payable || b.period.collected - a.period.collected);
  const sum = rows.reduce((acc, row) => ({ payable: acc.payable + row.money.payable, held: acc.held + row.money.held, customers: acc.customers + row.customers.count, collected: acc.collected + row.period.collected, commission: acc.commission + row.period.commission }), { payable: 0, held: 0, customers: 0, collected: 0, commission: 0 });
  const owed = SELLERS.map((one) => moneyOf(one.id)).reduce((acc, one) => ({ payable: acc.payable + one.payable, held: acc.held + one.held }), { payable: 0, held: 0 });
  return (
    <OpsPage>
      <OpsHead
        title="Sellers"
        lead="Who sells for Kauro, what they brought in and what you owe them."
        action={
          <Button variant="primary">Register a seller</Button>
        }
      />
      <p className="kauro-ops-sentence">
        You owe sellers <strong>{usd(owed.payable)}</strong>, payable by Nov 17, 2026, and <strong>{usd(owed.held)}</strong> is held. As of {AS_OF}. <Link href={OPS_PATH.payouts}>Payouts</Link>
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
          label="Period of the money columns"
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
            <caption className="kauro-visually-hidden">Sellers, what each brought in and what is owed, sorted by what is owed now</caption>
            <thead>
              <tr>
                <th scope="col">Seller</th>
                <th scope="col" className="kauro-table-end" aria-sort="descending">
                  Owed now (USD)
                </th>
                <th scope="col">Customers</th>
                <th scope="col" className="kauro-table-end">
                  Collected (USD)
                  <span className="kauro-ops-sub">{PERIOD[period].header}</span>
                </th>
                <th scope="col" className="kauro-table-end">
                  Commission (USD)
                  <span className="kauro-ops-sub">{PERIOD[period].header}</span>
                </th>
                <th scope="col">Claims</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ seller, money, period: inPeriod, customers }) => (
                <tr key={seller.id}>
                  <th scope="row">
                    <Link href={OPS_PATH.seller(seller.id)} prefetch={false}>
                      {seller.name}
                    </Link>
                    <span className="kauro-ops-cell-badge">
                      <Word tone={SELLER_STATE_TONE[seller.state]}>{SELLER_STATE_WORD[seller.state]}</Word>
                    </span>
                    <span className="kauro-ops-sub">{seller.state === "CANDIDATE" ? `Invited ${seller.since}` : seller.state === "TERMINATED" ? `Ended ${seller.endedOn ?? ""} · claims run to ${seller.tailUntil ?? ""}` : `Since ${seller.since}`}</span>
                    {NEEDS[seller.id] === undefined ? null : <span className="kauro-ops-sub kauro-ops-attention">{NEEDS[seller.id]}</span>}
                  </th>
                  <td className="kauro-table-end" data-label="Owed now (USD)">
                    <span>
                      {cents(money.payable)}
                      {money.payable > 0 ? <span className="kauro-ops-sub">pays Nov 17</span> : null}
                      {money.held > 0 ? <span className="kauro-ops-sub">{amount(money.held)} held</span> : null}
                    </span>
                  </td>
                  <td data-label="Customers">
                    <span>
                      {customers.count === 0 ? <span className="kauro-ops-zero">None yet</span> : customers.count}
                      {customers.count === 0 ? null : <span className="kauro-ops-sub">{customers.kinds}</span>}
                    </span>
                  </td>
                  <td className="kauro-table-end" data-label={`Collected (USD) · ${PERIOD[period].label.toLowerCase()}`}>
                    <span>{cents(inPeriod.collected)}</span>
                  </td>
                  <td className="kauro-table-end" data-label={`Commission (USD) · ${PERIOD[period].label.toLowerCase()}`}>
                    <span>{cents(inPeriod.commission)}</span>
                  </td>
                  <td data-label="Claims">
                    <span>{claimsLine(seller)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">
                  {rows.length} {rows.length === 1 ? "seller" : "sellers"}
                </th>
                <td className="kauro-table-end" data-label="Owed now (USD)">
                  <span>
                    {amount(sum.payable)}
                    {sum.held > 0 ? <span className="kauro-ops-sub">{amount(sum.held)} held</span> : null}
                  </span>
                </td>
                <td data-label="Customers">
                  <span>{sum.customers}</span>
                </td>
                <td className="kauro-table-end" data-label="Collected (USD)">
                  <span>{amount(sum.collected)}</span>
                </td>
                <td className="kauro-table-end" data-label="Commission (USD)">
                  <span>{amount(sum.commission)}</span>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div className="kauro-ops-toolbar kauro-ops-after-table">
        <p className="kauro-muted">
          Rates: every agreement in force sets the default, {FIRST_RATE}% of a customer&apos;s first project and {REPEAT_RATE}% of its repeats for {WINDOW_MONTHS} months. Collected is what those customers paid for the service, after discount, net of refunds and without tax: the base the commission is counted on.
        </p>
        <Button>Download CSV</Button>
      </div>
    </OpsPage>
  );
}

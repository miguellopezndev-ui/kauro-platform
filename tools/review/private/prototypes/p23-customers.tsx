"use client";
// P-23 Customers (proposed; round 2, owner-console.md §10.2). Every agency and company that has paid Kauro, with how it came (direct, or the
// seller whose claim converted), who serves it now, how many projects it paid and what it paid, so the owner can see the channels at a
// glance: who brought whom, and what each brought in. An agency's own clients are never listed here (D-33 §4.2: agency information is never
// used to reach its end clients). A row opens the customer's page (UI35).
//
// Needs a read (gap): the api lists no customers with their buyer type, channel, acquiring seller and money; the buyer type is read through
// each agency (CMD101). This page is drawn from the review's fixture.
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage } from "./ops-kit.tsx";
import { AS_OF, CUSTOMERS, amount, sellerById, type Customer } from "./sales.ts";

export const P23_STATES: readonly StateDef[] = [{ key: "normal", label: "Customers", note: "Seven customers: five agencies and two companies; one came direct, six through sellers." }];

type Show = "all" | "agencies" | "companies";

function cameThrough(customer: Customer): ReactElement {
  if (customer.acquiredBy === null) return <>Direct</>;
  const seller = sellerById(customer.acquiredBy);
  return (
    <>
      <Link href={OPS_PATH.seller(customer.acquiredBy)} prefetch={false}>
        {seller?.name}
      </Link>
      {seller?.state === "TERMINATED" ? <span className="kauro-ops-sub">Ended; repeats still owed</span> : null}
    </>
  );
}

export function CustomersList(_props: PrototypeProps): ReactElement {
  const [show, setShow] = useState<Show>("all");
  const agencies = CUSTOMERS.filter((one) => one.kind === "Agency").length;
  const direct = CUSTOMERS.filter((one) => one.acquiredBy === null).length;
  const rows = CUSTOMERS.filter((one) => (show === "all" ? true : show === "agencies" ? one.kind === "Agency" : one.kind === "Company")).sort((a, b) => b.collectedCents - a.collectedCents);
  const total = rows.reduce((sum, one) => ({ projects: sum.projects + one.projects, collected: sum.collected + one.collectedCents }), { projects: 0, collected: 0 });
  return (
    <OpsPage>
      <OpsHead title="Customers" lead="Every agency and company that has paid Kauro: how it came, who serves it and what it brought in." />
      <p className="kauro-ops-sentence">
        {CUSTOMERS.length} customers: {agencies} agencies and {CUSTOMERS.length - agencies} companies. {direct} came direct and {CUSTOMERS.length - direct} through sellers. As of {AS_OF}.
      </p>
      <Filter<Show>
        label="Show customers"
        value={show}
        onChange={setShow}
        options={[
          { key: "all", label: "All", count: CUSTOMERS.length },
          { key: "agencies", label: "Agencies", count: agencies },
          { key: "companies", label: "Companies", count: CUSTOMERS.length - agencies },
        ]}
      />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">Customers, by what they paid since the start</caption>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Came through</th>
                <th scope="col">Served by</th>
                <th scope="col" className="kauro-table-end">
                  Projects paid
                </th>
                <th scope="col" className="kauro-table-end">
                  Net revenue (USD)
                  <span className="kauro-ops-sub">Since the start</span>
                </th>
                <th scope="col">Last payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((customer) => (
                <tr key={customer.id}>
                  <th scope="row">
                    <Link href={OPS_PATH.customer(customer.id)} prefetch={false}>
                      {customer.name}
                    </Link>
                    <span className="kauro-ops-sub">{customer.kind}</span>
                  </th>
                  <td data-label="Came through">
                    <span>{cameThrough(customer)}</span>
                  </td>
                  <td data-label="Served by">
                    <span>{customer.servedBy === null ? "You" : sellerById(customer.servedBy)?.name}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Projects paid">
                    <span>{customer.projects}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Net revenue (USD)">
                    <span>{amount(customer.collectedCents)}</span>
                  </td>
                  <td data-label="Last payment">
                    <span className="kauro-ops-date">{customer.lastPaid}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">
                  {rows.length} {rows.length === 1 ? "customer" : "customers"}
                </th>
                <td />
                <td />
                <td className="kauro-table-end" data-label="Projects paid">
                  <span>{total.projects}</span>
                </td>
                <td className="kauro-table-end" data-label="Net revenue (USD)">
                  <span>{amount(total.collected)}</span>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="kauro-muted">Net revenue is what the customer actually paid for the service: collections, not invoices; after discount and refunds; without tax, which is never Kauro&apos;s revenue. An agency&apos;s own clients are never listed here.</p>
    </OpsPage>
  );
}

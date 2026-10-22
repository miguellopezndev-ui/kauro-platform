"use client";
// UI35 Customer (registry: "Assignment and acquisition entitlement are separate."). Round 2 (owner-console.md §10.2): the customer page the
// Customers list opens, for an agency or a company. Two facts side by side, as two equal cards: who serves the customer now (it can change,
// and changing it moves no money) and who acquired it (decided once, by the accepted claim and the agreement: the first-project rate, the
// repeat rate and its window, counted from the first confirmed payment). Then the projects it paid (service, date, amount, commission),
// never a file, a record or an agency's own client. Reassigning service never resets the first project or erases what the acquiring seller
// is still owed (registry exception). The permanent "Two facts, kept apart" banner is gone: the two cards already say it.
//
// Needs a read (gap): no read joins a customer to its buyer type, acquiring seller, serving seller and paid projects; drawn from the review's
// fixture. The customer is the one the address names.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Back, OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";
import { CLAIMS, CLAIM_DAYS, CUSTOMERS, FIRST_RATE, LINES, PAID_PROJECTS, REPEAT_RATE, SERVICE_NAME, WINDOW_MONTHS, amount, customerById, earnedOf, sellerById, usd, type Customer, type Line } from "./sales.ts";

export const UI35_STATES: readonly StateDef[] = [
  { key: "normal", label: "Customer", note: "Coastline Analytics: acquired and served by Daniel Kim, inside the 12-month window of repeats; its two paid projects." },
  { key: "reassign", label: "Preparing a reassignment", note: "Service moves to you; the acquisition entitlement stays with the seller who found them." },
];

export function AgencyRelationship({ state }: PrototypeProps): ReactElement {
  const pathname = usePathname();
  const customer: Customer = customerById(pathname?.split("/").pop()) ?? (CUSTOMERS[1] as Customer);
  const reassign = state === "reassign" && customer.servedBy !== null;
  const acquirer = sellerById(customer.acquiredBy);
  const server = sellerById(customer.servedBy);
  const claim = CLAIMS.find((one) => one.organisation === customer.name && one.state === "CONVERTED");
  const projects = PAID_PROJECTS.filter((one) => one.customerId === customer.id);
  const offsetOf = (name: string): Line | undefined => LINES.find((one) => one.customer === customer.name && one.project === name && one.offset !== undefined);
  const lineOf = (name: string, paidOn: string) => LINES.find((one) => one.customer === customer.name && one.project === name && one.paidOn === paidOn);
  const lead = `${customer.kind} · ${acquirer === undefined ? "came direct" : `came through ${acquirer.name}`} · first paid ${customer.firstPaid}`;
  return (
    <OpsPage>
      <OpsHead back={<Back href={OPS_PATH.customers}>Customers</Back>} title={customer.name} lead={lead} />
      <div className="kauro-ops-pair">
        <section className="kauro-ops-card" aria-labelledby="serve-h">
          <h2 id="serve-h" className="kauro-ops-card-label">
            Who serves them
          </h2>
          <p className="kauro-ops-card-value">
            {reassign ? (
              "You, from Nov 1, 2026"
            ) : server === undefined ? (
              "You"
            ) : (
              <Link href={OPS_PATH.seller(server.id)} prefetch={false}>
                {server.name}
              </Link>
            )}
          </p>
          <p className="kauro-muted">Answers their questions and prepares their next project. It can change; changing it moves no money.</p>
        </section>
        <section className="kauro-ops-card" aria-labelledby="acq-h">
          <h2 id="acq-h" className="kauro-ops-card-label">
            Who acquired them
          </h2>
          <p className="kauro-ops-card-value">
            {acquirer === undefined ? (
              "Nobody: they came direct"
            ) : (
              <Link href={OPS_PATH.seller(acquirer.id)} prefetch={false}>
                {acquirer.name}
              </Link>
            )}
          </p>
          {acquirer === undefined ? (
            <p className="kauro-muted">No commission is owed on this customer. A seller earns on a direct customer only through an assignment you make before the closing work.</p>
          ) : (
            <ul>
              <li>
                Claim accepted on {claim?.decided ?? "—"}, valid {CLAIM_DAYS} days
              </li>
              <li>
                First project: {FIRST_RATE}%, paid {customer.firstPaid}
              </li>
              <li>
                Repeats: {REPEAT_RATE}% until {customer.repeatsUntil ?? "—"}, {WINDOW_MONTHS} months after the first payment
              </li>
            </ul>
          )}
        </section>
      </div>
      <section aria-labelledby="projects-h">
        <SectionHead id="projects-h" title="Paid projects" meta={`${customer.projects} paid since ${customer.firstPaid} · Net revenue: what was actually paid for the service, after discount and refunds, without tax`} />
        <div className="kauro-ops-tablewrap">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
              <caption className="kauro-visually-hidden">{customer.name}&apos;s paid projects, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Paid on</th>
                  <th scope="col" className="kauro-table-end">
                    Net revenue (USD)
                  </th>
                  {acquirer === undefined ? null : (
                    <th scope="col" className="kauro-table-end">
                      Commission (USD)
                    </th>
                  )}
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const line = lineOf(project.name, project.paidOn);
                  return (
                    <tr key={`${project.name}-${project.paidOn}`}>
                      <th scope="row">
                        {project.name}
                        <span className="kauro-ops-sub">
                          {SERVICE_NAME[project.service]}
                          {project.discount === null ? "" : ` · ${project.discount}`}
                          {project.refund === undefined ? "" : ` · refund ${project.refund.reference} of ${usd(project.refund.cents)} on ${project.refund.on}`}
                        </span>
                      </th>
                      <td data-label="Paid on">
                        <span>{project.paidOn}</span>
                      </td>
                      <td className="kauro-table-end" data-label="Net revenue (USD)">
                        <span>{amount(project.collectedCents)}</span>
                      </td>
                      {acquirer === undefined ? null : (
                        <td className="kauro-table-end" data-label="Commission (USD)">
                          <span>
                            {line === undefined ? "—" : amount(earnedOf(line))}
                            {line === undefined ? null : <span className="kauro-ops-sub">{line.rate}% · {line.sequence === "FIRST" ? "first" : "repeat"}</span>}
                            {offsetOf(project.name) === undefined ? null : <span className="kauro-ops-sub">{amount(earnedOf(offsetOf(project.name) as Line))} offset, {offsetOf(project.name)?.offset?.approvedOn}</span>}
                          </span>
                        </td>
                      )}
                      <td data-label="State">
                        <span>
                          <Word tone={project.state === "Delivered" ? "success" : "info"}>{project.state}</Word>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      {reassign ? (
        <section className="kauro-ops-decide" aria-labelledby="re-h">
          <h2 id="re-h">Move their service to you</h2>
          <p>
            From Nov 1, 2026, you serve {customer.name}. {acquirer?.name} keeps the repeat rate on their projects until {customer.repeatsUntil}, and their first project stays theirs. {acquirer?.name} is told in writing.
          </p>
          <div className="kauro-actions">
            <Button variant="primary">Confirm the reassignment</Button>
            <Button>Keep {server?.name ?? "the seller"}</Button>
          </div>
        </section>
      ) : customer.servedBy === null ? null : (
        <section aria-labelledby="service-h">
          <SectionHead id="service-h" title="Change who serves them" />
          <p className="kauro-muted">Moving their service to you or to another seller changes who answers them; it never changes who acquired them or what that seller is owed.</p>
          <div className="kauro-actions">
            <Button>Prepare a reassignment</Button>
          </div>
        </section>
      )}
    </OpsPage>
  );
}

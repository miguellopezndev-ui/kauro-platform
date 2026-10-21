"use client";
// P-09 Billing overview (proposed, beside UI30). The menu's Billing opens UI30 without an order, which today can only say "choose an order":
// the api reads one order at a time (GetPaymentOrder) and lists none. A workspace needs the opposite view first: every quote and order of
// its projects, what is due and by when, what is paid and its fiscal document, and any refund (research: app-ui-patterns.md §7.4, an
// invoices list with a summary above it, after Mercury; Stripe's statuses kept apart: issued, waiting, paid, refunded). Each row opens the
// page that already exists for it: the quote (UI23), the payment (UI24) or the order's billing (UI30). Needs a list read (F-10).
//
// Every figure agrees with the page its row opens: the prices come from the price list in force (pricing-bands) at the review's unit
// count, the paid HubSpot order is the one UI24 and UI30 show, and no row carries a discount the quote it opens does not show. A refunded
// line (state REFUNDED, with its credit note) is drawn by the same row; this world has none.
import { formatMoney, StatusBadge, type Tone } from "@kauro/ui";
import { type ReactElement } from "react";
import { bandIndexOf, priceOf } from "@web/public/pricing-bands.ts";
import type { ServiceMode } from "@web/screens.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { WORLD_PROJECTS } from "../lib/world-projects.ts";
import { EXAMPLE } from "./example.ts";
import { PageHead, ScreenLink } from "./kit.tsx";
import { SERVICE } from "./service.ts";

export const P09_STATES: readonly StateDef[] = [
  { key: "normal", label: "Orders and quotes", note: "Every quote and order of the workspace: one waiting for a transfer, one quote to accept, one paid with its invoice." },
  { key: "empty", label: "Nothing yet", note: "A new workspace: the page says when the first quote will appear." },
];

type Kind = "QUOTE" | "WAITING" | "PAID" | "REFUNDED";
interface Line {
  readonly project: number;
  readonly kind: Kind;
  readonly document: string | null;
  readonly when: string;
  readonly whenLabel: string;
}
const KIND: Readonly<Record<Kind, { readonly label: string; readonly tone: Tone; readonly screen: string; }>> = {
  QUOTE: { label: "Quote issued", tone: "info", screen: "UI23" },
  WAITING: { label: "Waiting for your transfer", tone: "warning", screen: "UI24" },
  PAID: { label: "Paid", tone: "success", screen: "UI30" },
  REFUNDED: { label: "Refunded in full", tone: "neutral", screen: "UI30" },
};
// index into the agency's world projects; the company's lines name its own two projects
const AGENCY_LINES: readonly Line[] = [
  { project: 2, kind: "WAITING", document: null, when: "Oct 30, 2026", whenLabel: "Send by" },
  { project: 1, kind: "QUOTE", document: null, when: "Nov 3, 2026", whenLabel: "Valid until" },
  { project: 0, kind: "PAID", document: "Invoice KAU-2026-000123", when: "Oct 21, 2026", whenLabel: "Paid" },
];
const COMPANY_LINES: readonly Line[] = [
  { project: 1, kind: "QUOTE", document: null, when: "Nov 3, 2026", whenLabel: "Valid until" },
  { project: 0, kind: "PAID", document: "Invoice KAU-2026-000123", when: "Oct 21, 2026", whenLabel: "Paid" },
];

/** USD as the application writes it everywhere (the design system: "USD 1,295.00"). */
const usd = (cents: number): string => formatMoney(String(cents), "USD");

/** The amount in cents for a project of this service at the review's unit count, at the price list in force. */
const amountOf = (mode: ServiceMode): number => priceOf(bandIndexOf(EXAMPLE.units) ?? 0, mode);

export function BillingOverview({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.key === "company";
  const agencyId = ctx.agency?.agencyId ?? "";
  const projects = WORLD_PROJECTS[agencyId] ?? [];
  const lines = (company ? COMPANY_LINES : AGENCY_LINES).flatMap((line) => {
    const project = projects[line.project];
    return project === undefined ? [] : [{ ...line, name: project.name, client: project.clientLabel, projectId: project.projectId, mode: project.mode, cents: amountOf(project.mode) }];
  });
  const total = (kind: Kind): { readonly count: number; readonly cents: number } => {
    const of = lines.filter((line) => line.kind === kind);
    return { count: of.length, cents: of.reduce((sum, line) => sum + line.cents, 0) };
  };
  const figures: readonly { readonly key: Kind; readonly label: string; readonly fact: string }[] = [
    { key: "WAITING", label: "Waiting for a transfer", fact: "Send each by its date, with its reference" },
    { key: "QUOTE", label: "Quotes to accept", fact: "Nothing is due until a payment order exists" },
    { key: "PAID", label: "Paid in 2026", fact: "Each with its invoice" },
    { key: "REFUNDED", label: "Refunded", fact: "Each with its credit note" },
  ];
  return (
    <>
      <PageHead title="Billing" lead="Track quotes, payments, fiscal documents and refunds." />
      <p className="kauro-proposed kauro-proposed--page">Proposed — the list needs a read of the workspace&apos;s quotes and orders the API does not have yet (F-10)</p>
      {state === "empty" ? (
        <section className="kauro-screen-section" aria-labelledby="none-h">
          <h2 id="none-h">No quote or order yet</h2>
          <p className="kauro-muted">A project&apos;s quote appears here once its plan is approved; its payment, invoice and any refund follow on the same line. The free check never appears here: it costs nothing.</p>
          <ScreenLink to="UI11" ctx={ctx}>
            Go to projects
          </ScreenLink>
        </section>
      ) : (
        <>
          <dl className="kauro-identity-counts kauro-billing-figures">
            {figures
              .filter((figure) => total(figure.key).count > 0)
              .map((figure) => (
                <div key={figure.key} className={figure.key === "WAITING" ? "is-bad" : undefined}>
                  <dt>{figure.label}</dt>
                  <dd>{usd(total(figure.key).cents)}</dd>
                  <dd>
                    {total(figure.key).count} {total(figure.key).count === 1 ? "project" : "projects"} · {figure.fact}
                  </dd>
                </div>
              ))}
          </dl>
          <div className="kauro-table-region">
            <table className="kauro-table kauro-orders">
              <caption className="kauro-visually-hidden">Quotes and orders of {company ? "this company" : "this agency"}, the most urgent first</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">State</th>
                  <th scope="col" className="kauro-table-end">
                    Amount
                  </th>
                  <th scope="col">Date</th>
                  <th scope="col">Fiscal document</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={`${line.projectId}-${line.kind}`}>
                    <th scope="row">
                      <ScreenLink to={KIND[line.kind].screen} ctx={ctx} project={line.projectId}>
                        {line.name}
                      </ScreenLink>
                      <span className="kauro-orders-sub">
                        {company ? "" : `${line.client} · `}
                        {SERVICE[line.mode].name}
                      </span>
                    </th>
                    <td data-label="State">
                      <StatusBadge tone={KIND[line.kind].tone}>{KIND[line.kind].label}</StatusBadge>
                    </td>
                    <td data-label="Amount" className="kauro-table-end">
                      {usd(line.cents)}
                    </td>
                    <td data-label={line.whenLabel}>
                      <span className="kauro-orders-when">{line.whenLabel}</span> {line.when}
                    </td>
                    <td data-label="Fiscal document">{line.document ?? <span className="kauro-muted-text">None yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="kauro-muted">
            Amounts in USD. A quote is not a charge and an order is not an invoice: a fiscal document exists only where this list shows its number. {agencyId === "" ? "" : "Only owners and billing members see this page."}
          </p>
        </>
      )}
    </>
  );
}

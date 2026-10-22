"use client";
// P-09 Billing overview (proposed, beside UI30), rebuilt in Order 11 round 2 (research agency-workspace.md §5.19, §3.5; principles-craft.md
// V14, V20). The round-1 page opened on three stat plates that mixed an obligation, an offer and a history in identical boxes. It now opens
// on what needs action, in one sentence with its amount and date, and its one action; then every quote, order and refund in a table (most
// urgent first) whose foot carries what was paid this year; then the repeat discount as reachable progress (moved here from the projects
// board); then the billing details a first quote needs.
//
// Every figure agrees with the page it opens: the main project's order is the one the payment page draws (timeline.ts send-by date, the
// HubSpot band's price at the example's units), and each paid line carries the repeat discount its place in the workspace's history earns
// (policy repeatTiers: the first at the list price, later ones 5%). Every member reads this page; only owners and billing members request
// quotes, pay or ask for refunds (CMD027-CMD031), and the others read one line naming them. Needs a list read (F-10) and a billing-profile
// read.
import { StatusBadge, type Tone } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { day, moment, NextStep, Only, ScreenButton, ScreenLink } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { AGENCY_BOARD, AGENCY_MONEY, COMPANY_BOARD, COMPANY_MONEY, type MoneyKind, type MoneyLine, PAID_PROJECTS, repeatProgress, usd } from "./projects-data.ts";
import { SERVICE } from "./service.ts";

export const P09_STATES: readonly StateDef[] = [
  { key: "normal", label: "Orders and quotes", note: "One sentence of what needs action (a transfer to send, with its amount and date), then every quote, order and refund, the year's total in the table foot, the repeat discount and the billing details." },
  { key: "empty", label: "Nothing yet", note: "A new workspace: one heading, one sentence; the free check never appears here." },
];

const KIND: Readonly<Record<MoneyKind, { readonly label: string; readonly tone: Tone }>> = {
  WAITING: { label: "Waiting for your transfer", tone: "warning" },
  QUOTE: { label: "Quote issued", tone: "info" },
  PAID: { label: "Paid", tone: "success" },
  REFUNDED: { label: "Refunded", tone: "neutral" },
};

type View = "action" | "all" | "refunds";

export function BillingOverview({ ctx, state }: PrototypeProps): ReactElement {
  const company = ctx.buyerType === "in-house";
  const board = company ? COMPANY_BOARD : AGENCY_BOARD;
  const lines = state === "empty" ? [] : company ? COMPANY_MONEY : AGENCY_MONEY;
  const payer = can(ctx, "pay");
  const action = lines.filter((line) => line.kind === "WAITING" || line.kind === "QUOTE");
  const [view, setView] = useState<View>(action.length > 0 ? "action" : "all");
  const shown = view === "action" ? action : view === "refunds" ? lines.filter((line) => line.kind === "REFUNDED") : lines;
  const paid = lines.filter((line) => line.kind === "PAID");
  const paidCents = paid.reduce((sum, line) => sum + line.cents, 0);
  const nameOf = (line: MoneyLine): { readonly name: string; readonly sub: string } => {
    const project = board.find((one) => one.item.projectId === line.projectId);
    return { name: project?.name ?? "A project", sub: project === undefined ? "" : `${company ? "" : `${project.item.clientLabel} · `}${SERVICE[project.item.mode].name}` };
  };
  const repeat = repeatProgress(company ? PAID_PROJECTS.company : PAID_PROJECTS.agency);
  const count = company ? PAID_PROJECTS.company : PAID_PROJECTS.agency;
  const transfers = action.filter((line) => line.kind === "WAITING");
  const quotes = action.filter((line) => line.kind === "QUOTE");
  const first = transfers[0] ?? quotes[0];

  return (
    <>
      <ProjectHeader stage="purchase" title="Billing" lead="Track quotes, payments, fiscal documents and refunds." />
      <p className="kauro-proposed kauro-b-proposed kauro-b-proposed--page">Proposed: the list needs a read of the workspace&apos;s quotes and orders the API does not have yet (F-10)</p>
      {lines.length === 0 ? (
        <section className="kauro-empty" aria-labelledby="billing-none-h">
          <h2 id="billing-none-h">No quotes or payments yet</h2>
          <p>A project&apos;s quote appears here once its plan is approved; its payment, invoice and any refund follow on the same line. The free check never appears here: it costs nothing.</p>
        </section>
      ) : (
        <>
          {first === undefined ? (
            <p className="kauro-b-verdict">Nothing needs action. A quote appears here once a plan is approved.</p>
          ) : (
            <NextStep
              id="billing-next"
              label="Needs action"
              heading={[transfers.length > 0 ? `${transfers.length} ${transfers.length === 1 ? "transfer" : "transfers"} to send` : "", quotes.length > 0 ? `${quotes.length} ${quotes.length === 1 ? "quote" : "quotes"} to accept` : ""].filter((part) => part !== "").join(" · ")}
              action={
                payer ? (
                  <ScreenButton to={first.kind === "WAITING" ? "UI24" : "UI23"} ctx={ctx} project={first.projectId} variant="primary">
                    {first.kind === "WAITING" ? "Open the payment details" : "Open the quote"}
                  </ScreenButton>
                ) : (
                  <Only>Every member can read this page. {onlyLine(ctx, "pay", "pay, request quotes or ask for refunds")}</Only>
                )
              }
            >
              {action.map((line) => (
                <p key={line.projectId}>
                  {line.kind === "WAITING" ? "Send " : "Accept "}
                  <strong>{usd(line.cents)}</strong> for <bdi>{nameOf(line).name}</bdi> {line.kind === "WAITING" ? `by ${moment(line.at)}, with its reference` : `before ${moment(line.at)}`}.
                </p>
              ))}
            </NextStep>
          )}
          {payer || first !== undefined ? null : <Only>Every member can read this page. {onlyLine(ctx, "pay", "request quotes, pay or ask for refunds")}</Only>}
          <section className="kauro-b-section" aria-labelledby="billing-lines-h">
            <h2 id="billing-lines-h">Quotes, orders and refunds</h2>
            <div className="kauro-b-switch" role="group" aria-label="Which lines">
              {action.length === 0 ? null : (
                <button type="button" aria-pressed={view === "action"} onClick={() => setView("action")}>
                  Needs action ({action.length})
                </button>
              )}
              <button type="button" aria-pressed={view === "all"} onClick={() => setView("all")}>
                All ({lines.length})
              </button>
              <button type="button" aria-pressed={view === "refunds"} onClick={() => setView("refunds")}>
                Refunds
              </button>
            </div>
            {shown.length === 0 ? (
              <div className="kauro-empty">
                <h3>No refunds</h3>
                <p>A refund appears here with its credit note. It is asked for from the order&apos;s billing page, after the refund terms.</p>
              </div>
            ) : (
              <table className="kauro-rtable kauro-b-money">
                <caption className="kauro-visually-hidden">Quotes, orders and refunds, the most urgent first</caption>
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">State</th>
                    <th scope="col" className="kauro-num">
                      Amount (USD)
                    </th>
                    <th scope="col">Date</th>
                    <th scope="col">Document</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((line) => {
                    const named = nameOf(line);
                    return (
                      <tr key={`${line.projectId}-${line.kind}`}>
                        <td data-label="">
                          <ScreenLink to="UI13" ctx={ctx} project={line.projectId}>
                            <bdi>{named.name}</bdi>
                          </ScreenLink>
                          <span className="kauro-sub">{named.sub}</span>
                        </td>
                        <td data-label="State" className="kauro-b-nowrap">
                          <StatusBadge tone={KIND[line.kind].tone}>{KIND[line.kind].label}</StatusBadge>
                        </td>
                        <td data-label="Amount (USD)" className="kauro-num">
                          <span className="kauro-b-cell">
                            {usd(line.cents).replace(/^USD\s*/, "")}
                            {line.discount > 0 ? <span className="kauro-sub">{line.discount}% repeat discount</span> : null}
                          </span>
                        </td>
                        <td data-label="Date">
                          <span className="kauro-b-cell">
                            {line.dateLabel} {day(line.at)}
                            {line.kind === "WAITING" ? <span className="kauro-sub">{moment(line.at).replace(/^.*, (\d{1,2}:\d{2} [AP]M UTC)$/, "$1")}</span> : null}
                          </span>
                        </td>
                        <td data-label="Document" className="kauro-b-nowrap">
                          {line.kind === "WAITING" ? (
                            <ScreenLink to="UI24" ctx={ctx} project={line.projectId}>
                              Payment details
                            </ScreenLink>
                          ) : line.document === null ? (
                            "None yet"
                          ) : (
                            <ScreenLink to="UI30" ctx={ctx} project={line.projectId}>
                              {line.document}
                            </ScreenLink>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {view === "all" && paid.length > 0 ? (
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={2}>
                        Paid in 2026
                      </th>
                      <td className="kauro-num" data-label="Paid in 2026">
                        {usd(paidCents).replace(/^USD\s*/, "")}
                      </td>
                      <td colSpan={2} data-label="">
                        {paid.length} {paid.length === 1 ? "project" : "projects"}, each with its invoice
                      </td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            )}
            <p className="kauro-muted kauro-b-tablenote">A quote is not a charge and an order is not an invoice: a fiscal document exists only where this list names one.</p>
          </section>
          <section className="kauro-b-section" aria-labelledby="billing-repeat-h">
            <h2 id="billing-repeat-h">Repeat discount</h2>
            <p>
              {count} paid {count === 1 ? "project" : "projects"} in the last 365 days: {repeat.percent > 0 ? <>your next quote gets the <strong>{repeat.percent}% repeat discount</strong>.</> : "your second project gets the repeat discount."}
              {repeat.nextPercent === null ? null : ` ${repeat.toNext} more paid ${repeat.toNext === 1 ? "project reaches" : "projects reach"} ${repeat.nextPercent}%.`} Discounts do not stack; the larger one applies.
            </p>
          </section>
        </>
      )}
      <section className="kauro-b-section" aria-labelledby="billing-profile-h">
        <h2 id="billing-profile-h">Billing details</h2>
        <p className="kauro-muted">
          On every quote and invoice. Asked for before your first quote is issued; changes go through support. <span className="kauro-proposed kauro-b-proposed">Proposed: needs a billing-profile read</span>
        </p>
        <dl className="kauro-b-facts">
          <div>
            <dt>Legal name</dt>
            <dd>{company ? "Halden Outdoor Inc. (synthetic)" : "Northwind Data LLC (synthetic)"}</dd>
          </div>
          <div>
            <dt>Tax ID</dt>
            <dd>{company ? "EIN 98-7654321 (synthetic)" : "EIN 12-3456789 (synthetic)"}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{company ? "200 Example Avenue, Denver, CO 80202, United States" : "100 Example Street, Portland, OR 97201, United States"}</dd>
          </div>
          <div>
            <dt>Billing contact</dt>
            <dd>{company ? "Tomas Reyes, tomas.reyes@halden.example" : "Ines Duarte, ines.duarte@northwind.example"}</dd>
          </div>
        </dl>
        {payer ? (
          <ScreenLink to="UI52" ctx={ctx}>
            Ask support to change the billing details
          </ScreenLink>
        ) : null}
      </section>
    </>
  );
}

"use client";
// UI44 Operating review (registry: "Choose the next action from actual evidence."). A month read from what happened: the funnel of the
// month's new accounts, the support each paid project needed, what was collected and what it cost, how concentrated the money is, and what
// is owed. From that, the owner prepares one experiment with its budget and its stop rule. A draft is not running, and a scenario's
// arithmetic is not demand: both say so (registry exceptions). Observed figures and assumptions are never mixed in one number.
import { Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

export const UI44_STATES: readonly StateDef[] = [
  { key: "normal", label: "October so far", note: "The month's observed funnel, support, money and concentration; one experiment drafted, not running." },
];

const FUNNEL = [
  ["Accounts created", 38],
  ["Workspaces set up", 21],
  ["Free checks finished", 14],
  ["Plans approved", 6],
  ["Quotes paid", 4],
  ["Imports verified", 3],
] as const;

export function OperatingReview(_props: PrototypeProps): ReactElement {
  const top = FUNNEL[0][1];
  return (
    <>
      <PageHead title="Operating review" lead="Choose the next action from actual evidence." />
      <section className="kauro-screen-section" aria-labelledby="funnel-h">
        <h2 id="funnel-h">October&apos;s new accounts, so far</h2>
        <ol className="kauro-funnel">
          {FUNNEL.map(([label, count]) => (
            <li key={label}>
              <span className="kauro-funnel-label">{label}</span>
              <span className="kauro-funnel-bar" aria-hidden="true">
                <span style={{ inlineSize: `${(count / top) * 100}%` }} />
              </span>
              <strong>{count}</strong>
            </li>
          ))}
        </ol>
        <p className="kauro-muted">Observed, from 1 to Oct 20, 2026. The largest drop is between a finished check and an approved plan: 14 to 6.</p>
      </section>
      <dl className="kauro-identity-counts">
        <div>
          <dt>Collected</dt>
          <dd>USD 6,480.00</dd>
          <dd>Service, after discounts, without tax</dd>
        </div>
        <div>
          <dt>Direct costs</dt>
          <dd>USD 912.40</dd>
          <dd>Computing, storage, provider and bank fees</dd>
        </div>
        <div>
          <dt>Support</dt>
          <dd>11 cases</dd>
          <dd>2.75 a paid project; 7 about import steps</dd>
        </div>
        <div>
          <dt>Concentration</dt>
          <dd>40%</dd>
          <dd>Of the money from one agency: Northwind Data, 2 projects</dd>
        </div>
      </dl>
      <section className="kauro-screen-section" aria-labelledby="owed-h">
        <h2 id="owed-h">What is owed</h2>
        <ul>
          <li>Seller commissions: USD 129.50 payable on Nov 17, 2026; USD 49.21 held until a project is complete.</li>
          <li>Refunds: none requested.</li>
          <li>Taxes: October&apos;s issued invoices and credit notes are ready for the accountant; this page estimates no tax.</li>
        </ul>
      </section>
      <section className="kauro-approve" aria-labelledby="exp-h">
        <div className="kauro-prospect-head">
          <h2 id="exp-h">One experiment</h2>
          <Badge tone="neutral">Draft · not running</Badge>
        </div>
        <dl className="kauro-prospect-facts">
          <div>
            <dt>Because</dt>
            <dd>8 of 14 finished checks led to no plan; 5 of those 8 teams opened the results only once.</dd>
          </div>
          <div>
            <dt>Try</dt>
            <dd>Two days after a check, one email to the person who ran it, with the three findings that matter most for their destination.</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>No money; 2 hours of the owner&apos;s time to review the email</dd>
          </div>
          <div>
            <dt>Stop when</dt>
            <dd>After 20 checks, or on Nov 30, 2026: stop if fewer than 3 more plans are approved than the 6 in October.</dd>
          </div>
        </dl>
        <p className="kauro-muted">If every team that opened its results only once approved a plan, October would have 11. That is arithmetic, not demand.</p>
        <div className="kauro-actions">
          <Button variant="primary">Approve and start</Button>
          <Button>Edit the draft</Button>
        </div>
      </section>
    </>
  );
}

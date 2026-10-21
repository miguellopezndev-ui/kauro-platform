"use client";
// UI44 Operating review (registry: "Choose the next action from actual evidence."). Round 2 (owner-console.md §8, §12): the monthly,
// analytical page. The month's funnel (length encodes the count, each bar with its number), then the month's money in three equal figures of
// one kind (collected, direct costs, what is left), then support and concentration as facts: round 1's four plates mixed USD, cases and a
// percentage at one size, which read as comparable numbers. "What is owed" moved to Payouts and Finance (one fact, one home). From that,
// the owner prepares one experiment with its budget and its stop rule. A draft is not running, and a scenario's arithmetic is not demand:
// both say so (registry exceptions). Observed figures and assumptions are never mixed in one number.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Figures, OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";
import { usd } from "./sales.ts";

export const UI44_STATES: readonly StateDef[] = [{ key: "normal", label: "October so far", note: "The month's observed funnel, money, support and concentration; one experiment drafted, not running." }];

const FUNNEL = [
  ["Accounts created", 38],
  ["Workspaces set up", 21],
  ["Free data health checks finished", 14],
  ["Plans approved", 6],
  ["Quotes paid", 4],
  ["Imports verified", 3],
] as const;

export function OperatingReview(_props: PrototypeProps): ReactElement {
  const top = FUNNEL[0][1];
  return (
    <OpsPage>
      <OpsHead title="Operating review" lead="October 2026 so far, from what happened. Due on Nov 3." />
      <section aria-labelledby="funnel-h">
        <SectionHead id="funnel-h" title="New accounts this month" meta="Observed, Oct 1 to Oct 20, 2026" />
        <ol className="kauro-ops-funnel">
          {FUNNEL.map(([label, count]) => (
            <li key={label}>
              <span className="kauro-ops-funnel-label">{label}</span>
              <progress value={count} max={top} aria-hidden="true" />
              <strong>{count}</strong>
            </li>
          ))}
        </ol>
        <p className="kauro-muted">The largest drop is between a finished check and an approved plan: 14 to 6.</p>
      </section>
      <section aria-labelledby="money-h">
        <SectionHead id="money-h" title="Money this month" meta="Collections, not invoices: the service actually paid, after discounts and refunds, without tax; costs as invoiced" aside={<Link href={OPS_PATH.payouts}>What is owed to sellers</Link>} />
        <Figures
          label="Money this month"
          items={[
            { label: "Net revenue", value: usd(370_575), note: "4 paid projects, less a USD 300.00 refund" },
            { label: "Direct costs", value: usd(60_480), note: "Computing, storage, providers, bank fees" },
            { label: "Left after direct costs", value: usd(310_095), note: "Before seller commission and retainers" },
          ]}
        />
      </section>
      <section aria-labelledby="facts-h">
        <SectionHead id="facts-h" title="Support and concentration" />
        <dl className="kauro-ops-facts">
          <div>
            <dt>Support cases</dt>
            <dd>11 this month, 2.75 for each paid project; 7 of them about import steps</dd>
          </div>
          <div>
            <dt>Largest customer</dt>
            <dd>Northwind Data: 56% of the net revenue, from 2 projects</dd>
          </div>
          <div>
            <dt>Taxes</dt>
            <dd>October&apos;s invoices and credit notes are ready for the accountant. This page estimates no tax.</dd>
          </div>
        </dl>
      </section>
      <section className="kauro-ops-decide" aria-labelledby="exp-h">
        <div className="kauro-ops-head-title">
          <h2 id="exp-h">One experiment</h2>
          <Word tone="neutral">Draft · not running</Word>
        </div>
        <dl className="kauro-ops-facts">
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
            <dd>No money; 2 hours of your time to review the email</dd>
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
    </OpsPage>
  );
}

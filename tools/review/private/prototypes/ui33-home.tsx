"use client";
// UI33 Private home (registry: "Your permitted operational and commercial work."). Round 2 (owner-console.md §7, seller-portal.md §4).
//
// The owner's Today is an operational dashboard in Few's sense: it shows when action is needed, not the state of everything. So it opens on
// one queue of what needs the owner (ordered by when it is due, then by consequence; owner actions, decisions, deadlines and releases feed
// it), then one band of money in three equal figures, then the projects by stage with only the waiting and the stalled emphasised, then one
// line on sellers and customers, then health only where something is not normal. The nine tiles, the three group headings and the "Open"
// link on every tile are gone: a tile that says "None open" spends attention to say nothing, and mixed figure kinds ("2", "Not issued",
// "1 running") are the mixed sizes the owner rejected. No chart: Today monitors, it does not explore.
//
// The seller's Today answers three questions: the one thing to do now (chosen by fixed rules, seller-portal.md §4.2), when the next money
// arrives (three equal figures, one size; unknown is "Not available", never zero), and which claims are running out. Things waiting on Kauro
// appear once, as a line, never as tasks. A candidate sees the setup checklist and only the pages they can use.
import { LinkButton } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Rings } from "./kit.tsx";
import { Figures, OPS_PATH, OpsHead, OpsPage, Queue, type QueueItem, SectionHead, Word } from "./ops-kit.tsx";
import { AS_OF, CLAIMS, CLAIM_DAYS, ELIGIBLE_DAYS, FIRST_RATE, SELLER, SELLER_ID, TODAY, linesOf, moneyOf, statementsOf, usd } from "./sales.ts";

export const UI33_STATES: readonly StateDef[] = [
  { key: "normal", label: "Today", note: "Owner: seven things need you, then money, projects by stage and health. Seller: one next step, three money figures, claims." },
  { key: "quiet", label: "Nothing waiting", note: "Nothing needs the person today: one sentence says so, with the time it was checked; the facts below stay." },
  { key: "candidate", label: "A new seller (seller)", note: "Seen as a seller: a candidate's Today is the setup checklist, counting the steps really done. The owner's page is unchanged." },
];

const STAGES = [
  { name: "Upload and seal your files", open: 1, kauro: 0, customer: 1, stalled: 1 },
  { name: "The free data health check", open: 1, kauro: 1, customer: 0, stalled: 0 },
  { name: "Review and approve the plan", open: 2, kauro: 0, customer: 2, stalled: 0 },
  { name: "Quote and payment", open: 1, kauro: 1, customer: 0, stalled: 0 },
  { name: "Preparation and verification", open: 3, kauro: 3, customer: 0, stalled: 0 },
  { name: "Delivery and your import", open: 1, kauro: 0, customer: 1, stalled: 0 },
] as const;

const count = (value: number, strong = false): ReactElement => (value === 0 ? <span className="kauro-ops-zero">0</span> : strong ? <strong>{value}</strong> : <>{value}</>);

function OwnerToday({ quiet }: { readonly quiet: boolean }): ReactElement {
  const queue: readonly QueueItem[] = [
    { key: "credit", what: "Match a transfer to its order", why: "Northwind Data sent USD 1,295.00 with an order reference. Their Larch Studio project waits for it.", due: "Today", urgent: true, action: { label: "Match it in Finance", href: OPS_PATH.finance } },
    { key: "case", what: "Answer Northwind Data on import steps", why: "Support case 118. Support answers in writing, Monday to Friday.", due: "Today, 11:00 AM", urgent: true, action: { label: "Open the case", href: OPS_PATH.support } },
    { key: "assess", what: "Record Lucía Ferrer's assessment", why: "Scheduled for Oct 23. Activation also waits for the signed agreement.", due: "Oct 23", action: { label: "Open Lucía Ferrer", href: OPS_PATH.seller(SELLER_ID.lucia) } },
    { key: "domain", what: "Renew the kauro.example domain", why: "If it lapses, the site and every email address stop. Prepared, USD 18.00.", due: "By Nov 2", action: { label: "Open the action", href: OPS_PATH.actions } },
    { key: "claim", what: "Decide Daniel Kim's claim on Fernhill Growth Partners", why: "No other claim and no customer record matches it.", due: "Since Oct 20", action: { label: "Decide the claim", href: OPS_PATH.claims } },
    { key: "message", what: "Authorise Daniel Kim's follow-up to Saltmarsh Digital", why: "Prepared from the current resources, for one send.", due: "Since Oct 20", action: { label: "Review the message", href: OPS_PATH.outreach } },
    { key: "release", what: "Promote release 2026.10.3", why: "Every gate passed on this exact image.", due: "Since Oct 20", action: { label: "Open the release", href: OPS_PATH.releases } },
  ];
  const owed = [SELLER_ID.daniel, SELLER_ID.amara, SELLER_ID.tomas].map(moneyOf);
  const payable = owed.reduce((sum, one) => sum + one.payable, 0);
  const held = owed.reduce((sum, one) => sum + one.held, 0);
  const total = STAGES.reduce((sum, stage) => ({ open: sum.open + stage.open, kauro: sum.kauro + stage.kauro, customer: sum.customer + stage.customer, stalled: sum.stalled + stage.stalled }), { open: 0, kauro: 0, customer: 0, stalled: 0 });
  return (
    <>
      <OpsHead title="Today" lead={quiet ? `${TODAY} · nothing needs you` : `${TODAY} · ${queue.length} things need you`} />
      <section aria-labelledby="needs-h">
        <SectionHead id="needs-h" title="Needs you" meta={`By when it is due · checked at ${AS_OF}`} />
        {quiet ? <p className="kauro-ops-sentence">Nothing needs you today. Last checked at {AS_OF}.</p> : <Queue items={queue} label="What needs you, by when it is due" />}
      </section>
      <section aria-labelledby="money-h">
        <SectionHead id="money-h" title="Money this month" meta={`October 2026, to Oct 21 · as of ${AS_OF}, from the bank credits you entered`} />
        <Figures
          label="Money this month"
          items={[
            { label: "Received and matched", value: usd(400_575), note: "4 transfers, each matched to its order", href: OPS_PATH.finance },
            { label: "To match", value: quiet ? usd(0) : usd(227_500), note: quiet ? "Every transfer matched · checked 09:12" : "2 transfers received, not matched yet", href: OPS_PATH.finance },
            { label: "Owed to sellers", value: usd(payable), note: `Payable by Nov 17 · ${usd(held)} held`, href: OPS_PATH.payouts },
          ]}
        />
      </section>
      <section aria-labelledby="stage-h">
        <SectionHead id="stage-h" title="Projects by stage" meta="Every open project of every workspace" />
        <ul className="kauro-ops-stages-phone">
          {STAGES.map((stage) => (
            <li key={stage.name}>
              <span className="kauro-ops-stages-name">{stage.name}</span>
              <span className="kauro-ops-sub">
                {[`${stage.open} open`, stage.kauro > 0 ? `${stage.kauro} waiting on Kauro` : null, stage.customer > 0 ? `${stage.customer} on the customer` : null, stage.stalled > 0 ? `${stage.stalled} over 14 days` : null].filter((part) => part !== null).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
        <div className="kauro-ops-tablewrap kauro-ops-stages-wide">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
              <caption className="kauro-visually-hidden">Open projects by stage, and who each waits on</caption>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col" className="kauro-table-end">
                    Open
                  </th>
                  <th scope="col" className="kauro-table-end">
                    Waiting on Kauro
                  </th>
                  <th scope="col" className="kauro-table-end">
                    Waiting on the customer
                  </th>
                  <th scope="col" className="kauro-table-end">
                    In the stage over 14 days
                  </th>
                </tr>
              </thead>
              <tbody>
                {STAGES.map((stage) => (
                  <tr key={stage.name}>
                    <th scope="row">{stage.name}</th>
                    <td className="kauro-table-end" data-label="Open">
                      <span>{count(stage.open)}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Waiting on Kauro">
                      <span>{count(stage.kauro, true)}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Waiting on the customer">
                      <span>{count(stage.customer)}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Over 14 days">
                      <span>{count(stage.stalled, true)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">All stages</th>
                  <td className="kauro-table-end" data-label="Open">
                    <span>{total.open}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Waiting on Kauro">
                    <span>{total.kauro}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Waiting on the customer">
                    <span>{total.customer}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Over 14 days">
                    <span>{total.stalled}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <p className="kauro-muted">Over 14 days: Harbor Mill&apos;s files for Northwind Data, uploading since Oct 5.</p>
      </section>
      <section aria-labelledby="channels-h">
        <SectionHead id="channels-h" title="Sellers and customers this month" />
        <ul className="kauro-ops-lines">
          <li>
            New customers in October: 1, a company (Larkspur Home Goods), brought by Daniel Kim. Direct: none. <a href={OPS_PATH.customers}>Customers</a>
          </li>
          <li>
            Claims: {quiet ? "none to decide" : "1 to decide"}; 4 accepted and running, the next to end Brightwater Collective&apos;s on Nov 20. <a href={OPS_PATH.sellers}>Sellers</a>
          </li>
        </ul>
      </section>
      <section aria-labelledby="health-h">
        <SectionHead id="health-h" title="Health" />
        <ul className="kauro-ops-lines">
          {quiet ? null : (
            <li className="is-attention">
              <strong>Deletion:</strong> 1 file is still held by the storage provider after a retention deletion; asked again at 9:00 AM. <a href={OPS_PATH.deletion}>Deletion</a>
            </li>
          )}
          <li className="is-attention">
            <strong>Identity provider:</strong> not connected yet, so nobody can sign in outside this review. <a href={OPS_PATH.settings}>Settings</a>
          </li>
          <li>{quiet ? "Jobs, deletion and incidents: normal." : "Jobs and incidents: normal. No job failed in the last 7 days."}</li>
        </ul>
      </section>
    </>
  );
}

function CandidateToday(): ReactElement {
  const steps = [
    { key: "invite", name: "Invitation accepted", fact: "Oct 6", state: "done" as const },
    { key: "mfa", name: "Two-step verification set up", fact: "Oct 6", state: "done" as const },
    { key: "legal", name: "Legal review of the engagement", fact: "Kauro · Oct 9", state: "done" as const },
    { key: "agreement", name: "Sign the seller agreement", fact: "Waiting for you", state: "current" as const },
    { key: "confidentiality", name: "Accept the confidentiality terms", fact: "Waiting for you", state: "waiting" as const },
    { key: "assessment", name: "Product and English assessment", fact: "Kauro · Oct 23", state: "waiting" as const },
    { key: "payout", name: "Add your payout destination", fact: "Kauro checks it after 48 hours", state: "waiting" as const },
    { key: "tax", name: "Send your tax documents", fact: "Waiting for you", state: "waiting" as const },
    { key: "activate", name: "Activation", fact: "Kauro, after every step", state: "waiting" as const },
  ];
  return (
    <>
      <OpsHead title="Today" lead={TODAY} />
      <section className="kauro-ops-next" aria-labelledby="next-h">
        <p className="kauro-ops-next-label">Next</p>
        <h2 id="next-h">Sign your seller agreement</h2>
        <p>Kauro emailed you the seller agreement on Oct 12. Sign it and send it back; Kauro records it here. Prospects, outreach and commissions open once your account is active.</p>
      </section>
      <section aria-labelledby="setup-h">
        <SectionHead id="setup-h" title="Your setup" meta="3 of 9 steps done" />
        <Rings items={steps} />
      </section>
      <section aria-labelledby="how-h">
        <SectionHead id="how-h" title="How you are paid" />
        <p className="kauro-ops-sentence">
          Commission is earned when a customer you claimed pays for its first project: {FIRST_RATE}% of the service collected. It becomes payable {ELIGIBLE_DAYS} days after that project is complete, goes on the statement issued on the 5th business day of the next month, and is paid by the 10th business day (Bogotá calendar).
        </p>
      </section>
    </>
  );
}

function SellerToday({ quiet }: { readonly quiet: boolean }): ReactElement {
  const money = moneyOf(SELLER.id);
  const accruing = linesOf(SELLER.id).filter((one) => one.state === "ACCRUED_PENDING");
  const paid = statementsOf(SELLER.id).filter((one) => one.state === "PAID");
  const claims = CLAIMS.filter((one) => one.sellerId === SELLER.id && (one.state === "ACCEPTED" || one.state === "SUBMITTED" || one.state === "DISPUTED"));
  return (
    <>
      <OpsHead title="Today" lead={TODAY} />
      {quiet ? (
        <section className="kauro-ops-next" aria-labelledby="next-h">
          <p className="kauro-ops-next-label">Next</p>
          <h2 id="next-h">Nothing needs you today</h2>
          <p>Your next payment, {usd(money.payable)}, is due by Nov 17, 2026. Your first claim to end is Ostra Revenue Ops&apos;s, on Dec 31.</p>
        </section>
      ) : (
        <section className="kauro-ops-next" aria-labelledby="next-h">
          <p className="kauro-ops-next-label">Next</p>
          <h2 id="next-h">Send your authorised message to Ostra Revenue Ops by Oct 23</h2>
          <p>The worked example they asked for on Oct 16. Kauro authorised this exact text on Oct 20, for one send.</p>
          <div className="kauro-actions">
            <LinkButton href={OPS_PATH.outreach} variant="primary">
              Open the message
            </LinkButton>
          </div>
        </section>
      )}
      <section aria-labelledby="money-h">
        <SectionHead id="money-h" title="Your money" aside={<a href={OPS_PATH.statements()}>Commissions</a>} />
        <Figures
          label="Your money"
          items={[
            { label: "Next payment", value: usd(money.payable), note: "By Nov 17 · October statement, issued Nov 9" },
            { label: "Earned, not yet payable", value: usd(money.accruing), note: `${accruing.length} lines · each payable ${ELIGIBLE_DAYS} days after its project is complete` },
            { label: "Paid in 2026", value: usd(money.paid), note: `Last paid ${paid[0]?.paidOn ?? "—"}` },
          ]}
        />
      </section>
      <section aria-labelledby="claims-h">
        <SectionHead id="claims-h" title="Your claims" meta={`An accepted claim lasts ${CLAIM_DAYS} days`} aside={<a href={OPS_PATH.prospects}>All prospects</a>} />
        <div className="kauro-ops-tablewrap">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
              <caption className="kauro-visually-hidden">Your live claims, by when they end</caption>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Claim</th>
                  <th scope="col">Ends on</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((claim) => (
                  <tr key={claim.id}>
                    <th scope="row">
                      {claim.organisation}
                      <span className="kauro-ops-sub">{claim.kind}</span>
                    </th>
                    <td data-label="Claim">
                      <span>{claim.state === "ACCEPTED" ? <Word tone="success">Accepted</Word> : <Word tone="info">In review</Word>}</span>
                    </td>
                    <td data-label="Ends on">
                      <span className="kauro-ops-date">{claim.ends ?? "When Kauro decides"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section aria-labelledby="wait-h">
        <SectionHead id="wait-h" title="Waiting on Kauro" />
        <ul className="kauro-ops-lines">
          <li>Your claim on Fernhill Growth Partners, submitted Oct 20. You are told the outcome.</li>
          <li>Your follow-up to Saltmarsh Digital, waiting for authorisation since Oct 20.</li>
        </ul>
      </section>
      <p className="kauro-muted kauro-ops-footnote">You see your own prospects, messages and statements. Customer files and CRM data are not part of a seller&apos;s access.</p>
    </>
  );
}

export function PrivateHome({ ctx, state }: PrototypeProps): ReactElement {
  if (ctx.key === "seller")
    return <OpsPage>{state === "candidate" ? <CandidateToday /> : <SellerToday quiet={state === "quiet"} />}</OpsPage>;
  return (
    <OpsPage>
      <OwnerToday quiet={state === "quiet"} />
    </OpsPage>
  );
}

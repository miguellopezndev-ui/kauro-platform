"use client";
// UI37 Seller (registry: "Track the actual reviewed engagement."). Round 2 (owner-console.md §5): the page opens on money and work, not on
// onboarding. For one seller: what needs the owner (shown only when something does, Stripe's "Actions required"), four equal money
// figures (collected from their customers, commission earned, owed now, paid), the money by state (earned and waiting for a project to
// finish, held with its reason, payable by a date, paid with its reference), the statements, the customers they acquired by kind (agency or
// company), the claims and messages running, the agreement and its rates, and the history. Ending the engagement sits at the foot, as a
// text action, never beside routine ones. For a candidate the onboarding steps are the page's purpose, so they come first and the money
// sections are not drawn; for an ended seller the page says what Kauro still owes.
//
// Needs a read (gap): the api has no GET of a seller's record with its agreement, rates, customers, lines or statements across months
// (owner-console.md §2.2); this page is drawn from the review's fixture. The seller is the one the address names.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Rings } from "./kit.tsx";
import { Back, Figures, OPS_PATH, OpsHead, OpsPage, Queue, type QueueItem, SectionHead, Word } from "./ops-kit.tsx";
import {
  CLAIMS,
  CUSTOMERS,
  FIRST_RATE,
  PROSPECTS,
  REPEAT_RATE,
  SELLERS,
  SELLER_ID,
  SELLER_STATE_TONE,
  SELLER_STATE_WORD,
  STATEMENT_TONE,
  STATEMENT_WORD,
  TAIL_DAYS,
  WINDOW_MONTHS,
  amount,
  earnedOf,
  heldOf,
  linesOf,
  moneyOf,
  payableOf,
  sellerById,
  statementLines,
  statementsOf,
  usd,
  type Seller,
} from "./sales.ts";

export const UI37_STATES: readonly StateDef[] = [
  { key: "normal", label: "Active seller", note: "Daniel Kim: two things need you, money by state, three customers, claims and the agreement." },
  { key: "candidate", label: "Onboarding", note: "Lucía Ferrer, a candidate: the setup steps are the page's purpose and come first; no money section is drawn yet." },
  { key: "ended", label: "Ended", note: "Tomás Vidal, ended on Sep 30: what Kauro still owes, and the history, kept." },
  { key: "terminate", label: "Preparing a termination", note: "What ends at once, and what Kauro still owes and keeps paying." },
];

const NEEDS: Readonly<Record<string, readonly QueueItem[]>> = {
  [SELLER_ID.daniel]: [
    { key: "claim", what: "Decide the claim on Fernhill Growth Partners", why: "No other claim and no customer record matches it.", due: "Since Oct 20", action: { label: "Decide the claim", href: OPS_PATH.claims } },
    { key: "message", what: "Authorise the follow-up to Saltmarsh Digital", why: "Prepared from the current resources, for one send.", due: "Since Oct 20", action: { label: "Review the message", href: OPS_PATH.outreach } },
  ],
  [SELLER_ID.lucia]: [{ key: "assess", what: "Record the assessment", why: "Product and English, scheduled for Oct 23. Activation also waits for the signed agreement.", due: "Oct 23", action: { label: "Record the assessment", href: OPS_PATH.seller(SELLER_ID.lucia) } }],
};

const HISTORY: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  [SELLER_ID.daniel]: [
    ["Oct 20, 2026", "Claimed Fernhill Growth Partners"],
    ["Oct 19, 2026", "Larkspur Home Goods paid its first project"],
    ["Oct 15, 2026", "September statement paid: USD 229.50, reference KAU-CP-2026-09-001"],
    ["Oct 14, 2026", "Coastline Analytics paid a repeat project"],
    ["Sep 5, 2026", "Payout destination ··4821 verified"],
    ["Jul 1, 2026", "Agreement signed by both; account activated"],
  ],
  [SELLER_ID.amara]: [
    ["Oct 8, 2026", "Fjordline Media reported a defect; its line held until it is resolved"],
    ["Sep 18, 2026", "Halden Outdoor paid its first project"],
    ["Sep 2, 2026", "Fjordline Media paid its first project"],
    ["Aug 28, 2026", "Payout destination ··3307 verified"],
    ["Aug 17, 2026", "Agreement signed by both; account activated"],
  ],
  [SELLER_ID.lucia]: [
    ["Oct 12, 2026", "Seller agreement 2026-10 sent for signature"],
    ["Oct 9, 2026", "Legal review recorded: independent contractor in Colombia"],
    ["Oct 6, 2026", "Invitation accepted; two-step verification set up"],
  ],
  [SELLER_ID.tomas]: [
    ["Sep 30, 2026", "Engagement ended by notice; sending identity revoked"],
    ["Sep 14, 2026", "August statement paid: USD 199.50, reference KAU-CP-2026-08-001"],
    ["Sep 2, 2026", "Claim on Marlow & Pike accepted"],
    ["Jul 20, 2026", "Quillon Partners paid its first project"],
    ["Jul 1, 2026", "Agreement signed by both; account activated"],
  ],
};

const rates = `${FIRST_RATE}% first project · ${REPEAT_RATE}% repeats for ${WINDOW_MONTHS} months`;

function MoneyFigures({ seller }: { readonly seller: Seller }): ReactElement {
  const money = moneyOf(seller.id);
  const paid = statementsOf(seller.id).filter((one) => one.state === "PAID");
  const customers = CUSTOMERS.filter((one) => one.acquiredBy === seller.id).length;
  return (
    <section aria-labelledby="money-h">
      <SectionHead id="money-h" title="Money" meta={`Since ${seller.since} · as of 09:12 Bogotá`} />
      <Figures
        label="Money since the start"
        items={[
          { label: "Collected", value: usd(money.collected), note: `From ${customers} ${customers === 1 ? "customer" : "customers"}; the commission base` },
          { label: "Commission", value: usd(money.earned), note: "Earned on every line, whatever its state" },
          { label: "Owed now", value: usd(money.payable), note: money.payable > 0 ? `By Nov 17${money.held > 0 ? ` · ${usd(money.held)} held` : ""}` : "Nothing on an open statement" },
          { label: "Paid", value: usd(money.paid), note: paid[0]?.paidOn === undefined ? "No statement paid yet" : `Last paid ${paid[0].paidOn}` },
        ]}
      />
    </section>
  );
}

function ByState({ seller }: { readonly seller: Seller }): ReactElement {
  const lines = linesOf(seller.id);
  const accruing = lines.filter((one) => one.state === "ACCRUED_PENDING");
  const held = lines.filter((one) => one.state === "HELD");
  const statements = statementsOf(seller.id);
  const open = statements.filter((one) => one.state !== "PAID");
  const paid = statements.filter((one) => one.state === "PAID");
  return (
    <section aria-labelledby="state-h">
      <SectionHead id="state-h" title="Money by state" aside={<Link href={OPS_PATH.statements(seller.id)}>Statements and lines</Link>} />
      <dl className="kauro-ops-facts kauro-ops-money">
        {accruing.length === 0 ? null : (
          <div>
            <dt>Earned, waits for the projects to finish</dt>
            <dd>{usd(accruing.reduce((sum, one) => sum + earnedOf(one), 0))}</dd>
            <dd className="kauro-ops-sub">{accruing.map((one) => `${one.customer}, ${one.project}`).join("; ")}. Each becomes payable 30 days after its project is complete.</dd>
          </div>
        )}
        {held.map((one) => (
          <div key={one.id}>
            <dt>Held · review on {one.hold?.review}</dt>
            <dd>{usd(earnedOf(one))}</dd>
            <dd className="kauro-ops-sub">
              {one.customer}, {one.project}: {one.hold?.reason}.
            </dd>
          </div>
        ))}
        {open.map((statement) => (
          <div key={statement.id}>
            <dt>Payable by {statement.payDue}</dt>
            <dd>{usd(payableOf(statementLines(statement)))}</dd>
            <dd className="kauro-ops-sub">
              The {statement.period} statement, a draft until it is issued on {statement.issuedOn}.
            </dd>
          </div>
        ))}
        {paid.map((statement) => (
          <div key={statement.id}>
            <dt>Paid on {statement.paidOn}</dt>
            <dd>{usd(payableOf(statementLines(statement)))}</dd>
            <dd className="kauro-ops-sub">
              The {statement.period} statement · reference {statement.reference}, confirmed by the bank.
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Statements({ seller }: { readonly seller: Seller }): ReactElement {
  const statements = statementsOf(seller.id);
  return (
    <section aria-labelledby="statements-h">
      <SectionHead id="statements-h" title="Statements" meta="Issued on the 5th business day of the next month, paid by the 10th (Bogotá calendar)" />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">{seller.name}&apos;s statements, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">State</th>
                <th scope="col" className="kauro-table-end">
                  Held (USD)
                </th>
                <th scope="col" className="kauro-table-end">
                  Payable (USD)
                </th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((statement) => {
                const lines = statementLines(statement);
                return (
                  <tr key={statement.id}>
                    <th scope="row">
                      <Link href={OPS_PATH.statements(seller.id)} prefetch={false}>
                        {statement.period}
                      </Link>
                    </th>
                    <td data-label="State">
                      <span>
                        <Word tone={STATEMENT_TONE[statement.state]}>{STATEMENT_WORD[statement.state]}</Word>
                      </span>
                    </td>
                    <td className="kauro-table-end" data-label="Held (USD)">
                      <span>{heldOf(lines) === 0 ? <span className="kauro-ops-zero">0.00</span> : amount(heldOf(lines))}</span>
                    </td>
                    <td className="kauro-table-end" data-label="Payable (USD)">
                      <span>{amount(payableOf(lines))}</span>
                    </td>
                    <td data-label="Paid">
                      <span>
                        {statement.paidOn === null ? `Due by ${statement.payDue}` : statement.paidOn}
                        {statement.reference === null ? null : <span className="kauro-ops-sub">{statement.reference}</span>}
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
  );
}

function Customers({ seller }: { readonly seller: Seller }): ReactElement {
  const mine = CUSTOMERS.filter((one) => one.acquiredBy === seller.id);
  const agencies = mine.filter((one) => one.kind === "Agency").length;
  const lines = linesOf(seller.id);
  return (
    <section aria-labelledby="customers-h">
      <SectionHead id="customers-h" title="Customers they acquired" meta={`${mine.length} · ${agencies} ${agencies === 1 ? "agency" : "agencies"}, ${mine.length - agencies} ${mine.length - agencies === 1 ? "company" : "companies"}. An agency's own clients are never listed.`} />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">Customers {seller.name} acquired</caption>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">First project paid</th>
                <th scope="col">Repeats at {REPEAT_RATE}% until</th>
                <th scope="col" className="kauro-table-end">
                  Projects
                </th>
                <th scope="col" className="kauro-table-end">
                  Collected (USD)
                </th>
                <th scope="col" className="kauro-table-end">
                  Commission (USD)
                </th>
              </tr>
            </thead>
            <tbody>
              {mine.map((customer) => (
                <tr key={customer.id}>
                  <th scope="row">
                    <Link href={OPS_PATH.customer(customer.id)} prefetch={false}>
                      {customer.name}
                    </Link>
                    <span className="kauro-ops-sub">
                      {customer.kind}
                      {customer.servedBy === seller.id ? "" : ` · served by ${customer.servedBy === null ? "you" : (sellerById(customer.servedBy)?.name ?? "—")}`}
                    </span>
                  </th>
                  <td data-label="First project paid">
                    <span className="kauro-ops-date">{customer.firstPaid}</span>
                  </td>
                  <td data-label={`Repeats at ${REPEAT_RATE}% until`}>
                    <span>{customer.repeatsUntil ?? "—"}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Projects">
                    <span>{customer.projects}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Collected (USD)">
                    <span>{amount(customer.collectedCents)}</span>
                  </td>
                  <td className="kauro-table-end" data-label="Commission (USD)">
                    <span>{amount(lines.filter((one) => one.customer === customer.name).reduce((sum, one) => sum + earnedOf(one), 0))}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Pipeline({ seller }: { readonly seller: Seller }): ReactElement {
  const claims = CLAIMS.filter((one) => one.sellerId === seller.id);
  const accepted = claims.filter((one) => one.state === "ACCEPTED");
  const deciding = claims.filter((one) => one.state === "SUBMITTED" || one.state === "DISPUTED");
  const prospects = PROSPECTS.filter((one) => one.sellerId === seller.id);
  const working = prospects.filter((one) => one.state !== "WON" && one.state !== "LOST" && one.state !== "SUPPRESSED").length;
  return (
    <section aria-labelledby="pipeline-h">
      <SectionHead id="pipeline-h" title="Claims and work" aside={<Link href={OPS_PATH.claims}>Claims</Link>} />
      <dl className="kauro-ops-facts">
        <div>
          <dt>Claims accepted</dt>
          <dd>{accepted.length === 0 ? "None running" : accepted.map((one) => `${one.organisation}, until ${one.ends ?? "—"}`).join(" · ")}</dd>
        </div>
        {deciding.length === 0 ? null : (
          <div>
            <dt>Claims to decide</dt>
            <dd>{deciding.map((one) => `${one.organisation}, submitted ${one.submitted}`).join(" · ")}</dd>
          </div>
        )}
        <div>
          <dt>Prospects</dt>
          <dd>
            {prospects.length === 0 ? "None recorded" : `${working} being worked · ${prospects.filter((one) => one.state === "WON").length} won · ${prospects.filter((one) => one.state === "SUPPRESSED").length} do not contact`}
          </dd>
        </div>
        {seller.id === SELLER_ID.daniel ? (
          <div>
            <dt>Messages</dt>
            <dd>1 authorised, to send by Oct 23 · 1 waiting for your authorisation · 2 sent, 1 replied</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function Agreement({ seller }: { readonly seller: Seller }): ReactElement {
  const rows: (readonly [string, string])[] = [
    ["Agreement", seller.signed === null ? `${seller.agreement}, waiting for the seller's signature` : `${seller.agreement}, signed by both on ${seller.signed}`],
    ["Rates", `${FIRST_RATE}% of a customer's first project · ${REPEAT_RATE}% of its repeats for ${WINDOW_MONTHS} months after its first payment`],
    ["Legal review", seller.legalReview ?? "Not recorded"],
  ];
  if (seller.state !== "CANDIDATE") {
    rows.push(["Assessment", seller.assessment ?? "Not recorded"], ["Training", seller.training ?? "Not recorded"], ["Tax documents", seller.taxDocument ?? "Not on file"]);
    rows.push(["Payout destination", seller.payout.state === "VERIFIED" ? `Bank account ${seller.payout.label}, ${seller.payout.currency}, verified ${seller.payout.verifiedOn ?? ""}` : "Not verified"]);
    if (seller.sender !== undefined) rows.push(["Sending identity", `${seller.sender.address}, ${seller.sender.state === "VERIFIED" ? "verified" : seller.sender.state === "REVOKED" ? "revoked" : "waiting for verification"}`]);
    if (seller.pilot !== undefined) rows.push(["Pilot", seller.pilot]);
  }
  return (
    <section aria-labelledby="agreement-h">
      <SectionHead id="agreement-h" title={seller.state === "CANDIDATE" ? "Agreement" : "Agreement and onboarding"} />
      <dl className="kauro-ops-facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {seller.state === "ACTIVE" ? (
        <div className="kauro-actions">
          <Button>Prepare an amendment</Button>
          <p className="kauro-muted">A rate changes only through an amendment both sides sign; lines already earned keep their rate.</p>
        </div>
      ) : null}
    </section>
  );
}

function History({ seller }: { readonly seller: Seller }): ReactElement {
  return (
    <section aria-labelledby="history-h">
      <SectionHead id="history-h" title="History" />
      <ol className="kauro-ops-history">
        {(HISTORY[seller.id] ?? []).map(([date, what]) => (
          <li key={`${date}-${what}`}>
            <time>{date}</time>
            <span>{what}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Onboarding(): ReactElement {
  const steps = [
    { key: "invite", name: "Invitation accepted", fact: "Oct 6", state: "done" as const },
    { key: "mfa", name: "Two-step verification", fact: "Oct 6", state: "done" as const },
    { key: "legal", name: "Legal review", fact: "You · Oct 9", state: "done" as const },
    { key: "assessment", name: "Assessment", fact: "You · Oct 23", state: "current" as const },
    { key: "agreement", name: "Agreement signed by both", fact: "Waiting for the seller since Oct 12", state: "waiting" as const },
    { key: "confidentiality", name: "Confidentiality accepted", fact: "Waiting for the seller", state: "waiting" as const },
    { key: "payout", name: "Payout destination verified", fact: "Not added yet", state: "waiting" as const },
    { key: "tax", name: "Tax documents on file", fact: "Not sent yet", state: "waiting" as const },
    { key: "activate", name: "Activation", fact: "You, with a fresh confirmation", state: "waiting" as const },
  ];
  return (
    <section aria-labelledby="setup-h">
      <SectionHead id="setup-h" title="Setup" meta="3 of 9 steps done" />
      <Rings items={steps} />
      <p className="kauro-muted">Activation becomes possible once every step above is done. Money, customers and claims appear here once Lucía Ferrer is active.</p>
    </section>
  );
}

function StillOwed(): ReactElement {
  return (
    <section aria-labelledby="owed-h">
      <SectionHead id="owed-h" title="What Kauro still owes" />
      <ul className="kauro-ops-lines">
        <li>Repeats of Quillon Partners at {REPEAT_RATE}%, until Jul 20, 2027, on the normal statements.</li>
        <li>A first project of Marlow & Pike at {FIRST_RATE}%, if it buys before its claim ends on Dec 1, 2026 (claims already accepted run up to {TAIL_DAYS} days after the end, Dec 29).</li>
      </ul>
    </section>
  );
}

function Ending({ seller, terminate }: { readonly seller: Seller; readonly terminate: boolean }): ReactElement {
  if (terminate)
    return (
      <section className="kauro-ops-decide" aria-labelledby="end-h">
        <h2 id="end-h">End the engagement with {seller.name}</h2>
        <dl className="kauro-ops-facts">
          <div>
            <dt>Ends at once</dt>
            <dd>Access to the sales screens, new claims and every message not yet sent.</dd>
          </div>
          <div>
            <dt>Kauro still owes</dt>
            <dd>Every commission earned, on its normal statement; first projects of claims already accepted, for {TAIL_DAYS} days; repeats inside their windows, as the agreement says.</dd>
          </div>
          <div>
            <dt>Notice</dt>
            <dd>As the signed seller agreement sets, in writing, with the reason.</dd>
          </div>
        </dl>
        <div className="kauro-actions">
          <Button variant="danger">Prepare the notice</Button>
          <Button>Keep the engagement</Button>
        </div>
        <p className="kauro-muted">Preparing the notice sends nothing: you read it, and you send it. The final step asks for a fresh confirmation of your identity.</p>
      </section>
    );
  return (
    <section aria-labelledby="end-h">
      <SectionHead id="end-h" title="Pause or end" />
      <p className="kauro-muted">Suspending stops new claims and sending; statements stay readable and keep being paid. Ending keeps every lawful duty, including the tail of claims already accepted.</p>
      <div className="kauro-actions">
        <button type="button" className="kauro-text-button">
          Suspend {seller.name}
        </button>
        <button type="button" className="kauro-text-button">
          Prepare a termination
        </button>
      </div>
    </section>
  );
}

export function SellerLifecycle({ state }: PrototypeProps): ReactElement {
  const pathname = usePathname();
  const fromPath = sellerById(pathname?.split("/").pop());
  const seller = (state === "candidate" ? sellerById(SELLER_ID.lucia) : state === "ended" ? sellerById(SELLER_ID.tomas) : state === "terminate" ? sellerById(SELLER_ID.daniel) : fromPath) ?? (SELLERS[0] as Seller);
  const needs = NEEDS[seller.id] ?? [];
  const lead =
    seller.state === "CANDIDATE"
      ? `Invited ${seller.since} · ${seller.agreement} sent for signature · ${rates}`
      : seller.state === "TERMINATED"
        ? `Ended ${seller.endedOn ?? ""} · claims already accepted run until ${seller.tailUntil ?? ""} · ${seller.agreement}`
        : `${seller.agreement} · ${rates} · since ${seller.since}`;
  return (
    <OpsPage>
      <OpsHead back={<Back href={OPS_PATH.sellers}>Sellers</Back>} title={seller.name} badge={<Word tone={SELLER_STATE_TONE[seller.state]}>{SELLER_STATE_WORD[seller.state]}</Word>} lead={lead} />
      {needs.length === 0 ? null : (
        <section aria-labelledby="needs-h">
          <SectionHead id="needs-h" title="Needs you" />
          <Queue items={needs} label={`What ${seller.name} needs from you`} />
        </section>
      )}
      {seller.state === "CANDIDATE" ? (
        <>
          <Onboarding />
          <Agreement seller={seller} />
          <History seller={seller} />
        </>
      ) : (
        <>
          {seller.state === "TERMINATED" ? <StillOwed /> : null}
          <MoneyFigures seller={seller} />
          <ByState seller={seller} />
          <Statements seller={seller} />
          <Customers seller={seller} />
          <Pipeline seller={seller} />
          <Agreement seller={seller} />
          <History seller={seller} />
          {seller.state === "ACTIVE" ? <Ending seller={seller} terminate={state === "terminate"} /> : null}
        </>
      )}
    </OpsPage>
  );
}

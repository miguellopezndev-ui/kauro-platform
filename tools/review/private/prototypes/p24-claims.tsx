"use client";
// P-24 Claims (proposed; round 2, owner-console.md §10.2, §13; the owner's decisions of 2026-10-21). Sellers work prospects; the owner
// decides claims. The claims to decide come first; one opens with its evidence, what Kauro's records say, what accepting means in dates,
// and its history. Accept (CMD047, step-up) or refuse with a reason from a closed list. The owner sees the internal reason, its evidence
// and every decision; the seller reads only a neutral message that never reveals a commercial relationship or another seller's claim, and
// may ask for a review. "Other" is the one documented exception and needs a written note. The contractual claim rules are waiting for their
// legal validation, so this page marks them "Pending legal review" wherever it states them.
//
// Needs a read and storage (gaps F-13, F-14): the api decides claims by id (AcceptAttribution) but lists none, stores no closed reason
// list with evidence, and has no review request. This page is drawn from the review's fixture.
import { Button, Field } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, PendingLegal, SectionHead, Word } from "./ops-kit.tsx";
import { CLAIMS, CLAIM_DAYS, CLAIM_REASONS, FIRST_RATE, REPEAT_RATE, WINDOW_MONTHS, claimReason, sellerById, type Claim, type ClaimReasonKey, type ClaimState } from "./sales.ts";

export const P24_STATES: readonly StateDef[] = [
  { key: "normal", label: "A claim to decide", note: "Daniel Kim's claim on Fernhill Growth Partners: its evidence, the check against Kauro's records, what accepting means, its history." },
  { key: "refuse", label: "Refusing a claim", note: "A reason from the closed list; what the seller will read, shown before it is sent; 'Other' needs a written note." },
  { key: "refused", label: "A refused claim, reviewed", note: "Pinewood Analytics: the internal reason and its evidence for you, the neutral message the seller read, the review asked for and its outcome." },
];

type Show = "decide" | "accepted" | "converted" | "closed";
const SHOW_OF: Readonly<Record<ClaimState, Show>> = { SUBMITTED: "decide", DISPUTED: "decide", ACCEPTED: "accepted", CONVERTED: "converted", REJECTED: "closed", EXPIRED: "closed" };
const WORD: Readonly<Record<ClaimState, string>> = { SUBMITTED: "To decide", DISPUTED: "In review", ACCEPTED: "Accepted", CONVERTED: "Won", REJECTED: "Refused", EXPIRED: "Expired" };
const TONE: Readonly<Record<ClaimState, "info" | "warning" | "success" | "neutral">> = { SUBMITTED: "info", DISPUTED: "warning", ACCEPTED: "success", CONVERTED: "success", REJECTED: "neutral", EXPIRED: "neutral" };

function Refuse({ claim, onCancel }: { readonly claim: Claim; readonly onCancel: () => void }): ReactElement {
  const seller = sellerById(claim.sellerId);
  const [reason, setReason] = useState<ClaimReasonKey>("CUSTOMER_OR_DIRECT");
  const chosen = claimReason(reason);
  return (
    <div className="kauro-ops-form">
      <Field id="refuse-reason" label="Reason" hint="From the closed list; only you see it, with its evidence">
        {(control) => (
          <select {...control} value={reason} onChange={(event) => setReason(event.target.value as ClaimReasonKey)}>
            {CLAIM_REASONS.map((one) => (
              <option key={one.key} value={one.key}>
                {one.internal}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="refuse-evidence" label="Evidence" hint="What in Kauro's records supports the reason: a record, a date, a reference">
        {(control) => <textarea {...control} rows={2} />}
      </Field>
      <Field id="refuse-note" label={chosen?.note === true ? "Note (required for Other)" : "Note (optional)"} hint="In writing, kept with the decision; the seller does not read it">
        {(control) => <textarea {...control} rows={2} required={chosen?.note === true} />}
      </Field>
      <p className="kauro-ops-sentence">
        {seller?.name} will read: <strong>&ldquo;{chosen?.seller}.&rdquo;</strong> and can ask for a review.
      </p>
      <div className="kauro-actions">
        <Button variant="primary">Refuse the claim</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function Decide({ claim, refusing, onRefuse, onCancel }: { readonly claim: Claim; readonly refusing: boolean; readonly onRefuse: () => void; readonly onCancel: () => void }): ReactElement {
  const seller = sellerById(claim.sellerId);
  const deciding = claim.state === "SUBMITTED" || claim.state === "DISPUTED";
  const reason = claimReason(claim.reason);
  return (
    <section className="kauro-ops-decide" aria-labelledby="claim-h">
      <div className="kauro-ops-head-title">
        <h2 id="claim-h">{claim.organisation}</h2>
        <Word tone={TONE[claim.state]}>{WORD[claim.state]}</Word>
      </div>
      <dl className="kauro-ops-facts">
        <div>
          <dt>Claimed by</dt>
          <dd>
            <Link href={OPS_PATH.seller(claim.sellerId)} prefetch={false}>
              {seller?.name}
            </Link>
            , on {claim.submitted} · {claim.kind}
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{claim.evidence}</dd>
        </div>
        {deciding ? (
          <>
            <div>
              <dt>Kauro&apos;s records</dt>
              <dd>No other claim, no customer or workspace with this name or domain, and no fit inquiry from it.</dd>
            </div>
            <div>
              <dt>If you accept</dt>
              <dd>
                It is {seller?.name}&apos;s for {CLAIM_DAYS} days, until Jan 18, 2027. A first project bought in that time earns {FIRST_RATE}% of the service collected, and its repeats {REPEAT_RATE}% for {WINDOW_MONTHS} months. <PendingLegal />
              </dd>
            </div>
          </>
        ) : claim.state === "REJECTED" && reason !== undefined ? (
          <>
            <div>
              <dt>Internal reason</dt>
              <dd>{reason.internal}</dd>
            </div>
            <div>
              <dt>Its evidence</dt>
              <dd>{claim.reasonEvidence ?? "—"}</dd>
            </div>
            <div>
              <dt>What the seller read</dt>
              <dd>&ldquo;{reason.seller}.&rdquo; Nothing about a customer or another seller.</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>{claim.state === "CONVERTED" ? "Won" : "Ends"}</dt>
            <dd>{claim.state === "CONVERTED" ? `First project paid on ${claim.ends ?? ""}` : `${claim.ends ?? ""}, ${CLAIM_DAYS} days after it was accepted on ${claim.decided ?? ""}; alerts 14 and 3 days before`}</dd>
          </div>
        )}
      </dl>
      {claim.history === undefined ? null : (
        <>
          <h3>Decisions</h3>
          <ol className="kauro-ops-history">
            {claim.history.map(([date, event]) => (
              <li key={`${date}-${event}`}>
                <time>{date}</time>
                <span>{event}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {!deciding ? null : refusing ? (
        <Refuse claim={claim} onCancel={onCancel} />
      ) : (
        <>
          <div className="kauro-actions">
            <Button variant="primary">Accept the claim</Button>
            <Button onClick={onRefuse}>Refuse, with a reason</Button>
          </div>
          <p className="kauro-muted">Accepting asks for a fresh confirmation of your identity. {seller?.name} is told the outcome either way.</p>
        </>
      )}
    </section>
  );
}

export function Claims({ state }: PrototypeProps): ReactElement {
  const refused = state === "refused";
  const [show, setShow] = useState<Show>(refused ? "closed" : "decide");
  const [open, setOpen] = useState<string>(refused ? "c-12" : "c-01");
  const [refusing, setRefusing] = useState(state === "refuse");
  const counts = (key: Show): number => CLAIMS.filter((one) => SHOW_OF[one.state] === key).length;
  const rows = CLAIMS.filter((one) => SHOW_OF[one.state] === show);
  const claim = CLAIMS.find((one) => one.id === open) ?? CLAIMS[0];
  return (
    <OpsPage>
      <OpsHead
        title="Claims"
        lead={
          <>
            Decide which seller found a customer first. An accepted claim lasts {CLAIM_DAYS} days. <PendingLegal />
          </>
        }
      />
      <Filter<Show>
        label="Show claims"
        value={show}
        onChange={(key) => {
          setShow(key);
          const first = CLAIMS.find((one) => SHOW_OF[one.state] === key);
          if (first !== undefined) setOpen(first.id);
          setRefusing(false);
        }}
        options={[
          { key: "decide", label: "To decide", count: counts("decide") },
          { key: "accepted", label: "Accepted", count: counts("accepted") },
          { key: "converted", label: "Won", count: counts("converted") },
          { key: "closed", label: "Refused or expired", count: counts("closed") },
        ]}
      />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">Claims</caption>
            <thead>
              <tr>
                <th scope="col">Organisation</th>
                <th scope="col">Seller</th>
                <th scope="col">State</th>
                <th scope="col">Submitted</th>
                <th scope="col">Ends on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((one) => (
                <tr key={one.id} className={one.id === open ? "is-open" : undefined}>
                  <th scope="row">
                    <button type="button" className="kauro-ops-rowbutton" aria-expanded={one.id === open} onClick={() => setOpen(one.id)}>
                      {one.organisation}
                    </button>
                    <span className="kauro-ops-sub">{one.kind}</span>
                  </th>
                  <td data-label="Seller">
                    <span>{sellerById(one.sellerId)?.name}</span>
                  </td>
                  <td data-label="State">
                    <span>
                      <Word tone={TONE[one.state]}>{WORD[one.state]}</Word>
                    </span>
                  </td>
                  <td data-label="Submitted">
                    <span className="kauro-ops-date">{one.submitted}</span>
                  </td>
                  <td data-label="Ends on">
                    <span className="kauro-ops-date">{one.state === "ACCEPTED" ? one.ends : "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {claim === undefined ? null : <Decide claim={claim} refusing={refusing} onRefuse={() => setRefusing(true)} onCancel={() => setRefusing(false)} />}
      <section aria-labelledby="reasons-h">
        <SectionHead id="reasons-h" title="Reasons for a refusal" meta="A closed list. The seller reads only the right-hand message and can ask for a review." aside={<PendingLegal />} />
        <div className="kauro-ops-tablewrap">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
              <caption className="kauro-visually-hidden">The closed list of refusal reasons</caption>
              <thead>
                <tr>
                  <th scope="col">Internal reason (you)</th>
                  <th scope="col">What the seller reads</th>
                </tr>
              </thead>
              <tbody>
                {CLAIM_REASONS.map((one) => (
                  <tr key={one.key}>
                    <th scope="row">
                      {one.internal}
                      {one.note ? <span className="kauro-ops-sub">Needs a written note</span> : null}
                    </th>
                    <td data-label="The seller reads">
                      <span>{one.seller}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </OpsPage>
  );
}

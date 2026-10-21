"use client";
// P-24 Claims (proposed; round 2, owner-console.md §10.2, §13 "Decide a claim"). Claims leave Prospects: sellers work prospects, the owner
// decides claims. The claims to decide come first; one opens with its evidence, what Kauro's records say (another claim, an existing
// customer), and what accepting it means, in dates. Accept (CMD047, the owner, step-up) or refuse with a reason from a fixed list
// (seller-portal.md §5.6), which the seller reads. A seller is never told who else claimed: the refusal says "Not available to claim".
//
// Needs a read (gap): the api decides claims by id (AcceptAttribution) but lists none across sellers; this page is drawn from the review's
// fixture. The fixed list of refusal reasons is a proposal for the owner and counsel.
import { Button, Field } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, Word } from "./ops-kit.tsx";
import { CLAIMS, CLAIM_DAYS, FIRST_RATE, REPEAT_RATE, WINDOW_MONTHS, sellerById, type Claim, type ClaimState } from "./sales.ts";

export const P24_STATES: readonly StateDef[] = [
  { key: "normal", label: "A claim to decide", note: "Daniel Kim's claim on Fernhill Growth Partners: its evidence, the check against Kauro's records, and what accepting means." },
  { key: "refuse", label: "Refusing a claim", note: "A reason from the fixed list, and an optional note the seller reads." },
];

type Show = "decide" | "accepted" | "converted" | "closed";
const SHOW_OF: Readonly<Record<ClaimState, Show>> = { SUBMITTED: "decide", DISPUTED: "decide", ACCEPTED: "accepted", CONVERTED: "converted", REJECTED: "closed", EXPIRED: "closed" };
const WORD: Readonly<Record<ClaimState, string>> = { SUBMITTED: "To decide", DISPUTED: "In review", ACCEPTED: "Accepted", CONVERTED: "Won", REJECTED: "Refused", EXPIRED: "Expired" };
const TONE: Readonly<Record<ClaimState, "info" | "warning" | "success" | "neutral">> = { SUBMITTED: "info", DISPUTED: "warning", ACCEPTED: "success", CONVERTED: "success", REJECTED: "neutral", EXPIRED: "neutral" };
const REASONS = ["Not available to claim", "Not enough evidence of the seller's own work", "Outside the seller agreement", "Duplicate of the seller's own claim"] as const;

function Decide({ claim, refusing, onRefuse, onCancel }: { readonly claim: Claim; readonly refusing: boolean; readonly onRefuse: () => void; readonly onCancel: () => void }): ReactElement {
  const seller = sellerById(claim.sellerId);
  const deciding = claim.state === "SUBMITTED" || claim.state === "DISPUTED";
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
              <dd>No other claim, and no customer or workspace with this name or domain.</dd>
            </div>
            <div>
              <dt>If you accept</dt>
              <dd>
                It is {seller?.name}&apos;s for {CLAIM_DAYS} days, until Jan 18, 2027. A first project bought in that time earns {FIRST_RATE}% of the service collected, and its repeats {REPEAT_RATE}% for {WINDOW_MONTHS} months.
              </dd>
            </div>
          </>
        ) : (
          <div>
            <dt>{claim.state === "REJECTED" ? "Reason" : claim.state === "CONVERTED" ? "Won" : "Ends"}</dt>
            <dd>{claim.state === "REJECTED" ? `${claim.reason ?? ""}, on ${claim.decided ?? ""}` : claim.state === "CONVERTED" ? `First project paid on ${claim.ends ?? ""}` : `${claim.ends ?? ""}, ${CLAIM_DAYS} days after it was accepted on ${claim.decided ?? ""}`}</dd>
          </div>
        )}
      </dl>
      {!deciding ? null : refusing ? (
        <div className="kauro-ops-form">
          <Field id="refuse-reason" label="Reason" hint={`${seller?.name ?? "The seller"} reads it; it never names another seller or a customer`}>
            {(control) => (
              <select {...control} defaultValue={REASONS[0]}>
                {REASONS.map((reason) => (
                  <option key={reason}>{reason}</option>
                ))}
              </select>
            )}
          </Field>
          <Field id="refuse-note" label="Note (optional)" hint="One or two sentences, in writing">
            {(control) => <textarea {...control} rows={3} />}
          </Field>
          <div className="kauro-actions">
            <Button variant="primary">Refuse the claim</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
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
  const [show, setShow] = useState<Show>("decide");
  const [open, setOpen] = useState<string>("c-01");
  const [refusing, setRefusing] = useState(state === "refuse");
  const counts = (key: Show): number => CLAIMS.filter((one) => SHOW_OF[one.state] === key).length;
  const rows = CLAIMS.filter((one) => SHOW_OF[one.state] === show);
  const claim = CLAIMS.find((one) => one.id === open) ?? CLAIMS[0];
  return (
    <OpsPage>
      <OpsHead title="Claims" lead={`Decide which seller found a customer first. An accepted claim lasts ${CLAIM_DAYS} days.`} />
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
    </OpsPage>
  );
}

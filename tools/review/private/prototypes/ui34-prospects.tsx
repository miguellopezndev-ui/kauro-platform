"use client";
// UI34 Prospects (registry: "Work only qualified, permitted opportunities."). One row a prospect (ProspectView): the organisation, where it
// was found and when (a lawful, public source), whether it fits, whose it is, its state, and the next real action. A list is not qualified
// by being a list: a researched prospect needs its fit checked before any message. A suppressed prospect shows no way to contact it on any
// channel (registry exceptions). Claiming a prospect records who found it; the owner accepts or refuses the claim, and an accepted claim
// lasts 90 days (policy). People's names and personal addresses are not shown here: a seller works with organisations and role addresses.
//
// Order 11: the owner does not claim; the owner decides claims. Seen by the owner, the list says whose each prospect is, and a submitted
// claim is a decision: accept it (90 days start) or refuse it with a reason, told to the seller. A conflicting claim is shown to the owner
// only; a seller is never told who else claimed (research: app-operations-ux.md §5.1, PartnerStack).
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, PageHead, ScreenButton } from "./kit.tsx";
import { CLAIM_DAYS, PROSPECTS, SELLER, type Prospect, type ProspectState } from "./sales.ts";

export const UI34_STATES: readonly StateDef[] = [
  { key: "normal", label: "Prospects", note: "Five prospects in their states, one suppressed; one opened, with its source, fit and next action." },
  { key: "claim", label: "Claim submitted", note: "A claim on a qualified prospect: the seller sees it waiting; the owner sees the decision, accept or refuse with a reason." },
  { key: "suppressed", label: "A suppressed prospect", note: "Opened: suppressed on every channel, with no way to contact it." },
];

const WORD: Readonly<Record<ProspectState, string>> = {
  RESEARCHED: "To check",
  QUALIFIED: "Qualified",
  CONTACTED: "Contacted",
  ENGAGED: "In conversation",
  OPPORTUNITY: "Opportunity",
  WON: "Won",
  LOST: "Lost",
  SUPPRESSED: "Suppressed",
};
const TONE = (state: ProspectState): "neutral" | "info" | "success" | "warning" | "danger" =>
  state === "SUPPRESSED" ? "danger" : state === "RESEARCHED" ? "warning" : state === "ENGAGED" || state === "OPPORTUNITY" || state === "WON" ? "success" : "info";

function Detail({ prospect, ctx, claimed }: { readonly prospect: Prospect; readonly ctx: PrototypeProps["ctx"]; readonly claimed: boolean }): ReactElement {
  const suppressed = prospect.state === "SUPPRESSED";
  const owner = ctx.key === "owner";
  const claimText = claimed
    ? owner
      ? `Submitted by ${SELLER.name} today: yours to accept or refuse`
      : `Submitted today; if the owner accepts it, it lasts ${CLAIM_DAYS} days`
    : owner && prospect.claim !== undefined
      ? `${prospect.claim}, by ${SELLER.name}`
      : (prospect.claim ?? "Not claimed");
  return (
    <section className="kauro-prospect" aria-labelledby="prospect-h">
      <div className="kauro-prospect-head">
        <h2 id="prospect-h">{prospect.name}</h2>
        <Badge tone={TONE(prospect.state)}>{WORD[prospect.state]}</Badge>
      </div>
      <dl className="kauro-prospect-facts">
        <div>
          <dt>Found</dt>
          <dd>
            {prospect.source}, seen on {day(`${prospect.observed}T00:00:00Z`)}
          </dd>
        </div>
        <div>
          <dt>Kind and place</dt>
          <dd>
            {prospect.segment} · {prospect.jurisdiction}
          </dd>
        </div>
        <div>
          <dt>Fit</dt>
          <dd>{prospect.fit}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>{claimText}</dd>
        </div>
      </dl>
      {suppressed ? (
        <Banner tone="danger" title="Suppressed on every channel" announce="status">
          <p>Kestrel &amp; Lowe asked not to be contacted, on Oct 1, 2026. No message, call or social contact may be prepared or sent, by anyone, from any route.</p>
        </Banner>
      ) : owner && claimed ? (
        <div className="kauro-next">
          <p className="kauro-next-label">Your decision</p>
          <h3>Accept or refuse {SELLER.name}&apos;s claim</h3>
          <p>No other claim exists for this agency. Accepting starts {CLAIM_DAYS} days in which a first project is {SELLER.name}&apos;s under the seller agreement; refusing needs a reason, which {SELLER.name} reads.</p>
          <div className="kauro-actions">
            <Button variant="primary">Accept the claim</Button>
            <Button>Refuse, with a reason</Button>
          </div>
        </div>
      ) : (
        <div className="kauro-next">
          <p className="kauro-next-label">Next action</p>
          <h3>{prospect.next}</h3>
          <div className="kauro-actions">
            <ScreenButton to="UI54" ctx={ctx} variant="primary">
              <span className="kauro-go">Prepare a message</span>
            </ScreenButton>
            {prospect.claim === undefined && !claimed && !owner ? <Button>Claim this prospect</Button> : null}
          </div>
          <p className="kauro-muted">A message goes out only after review, from your verified sending identity, and never to a suppressed address.</p>
        </div>
      )}
    </section>
  );
}

export function Prospects({ ctx, state }: PrototypeProps): ReactElement {
  const owner = ctx.key === "owner";
  const initial = state === "suppressed" ? "p-05" : "p-01";
  const sellerOf = (one: Prospect): string => (one.claim !== undefined || (state === "claim" && one.id === "p-01") ? SELLER.name : "—");
  const [open, setOpen] = useState(initial);
  const prospect = PROSPECTS.find((one) => one.id === open) ?? PROSPECTS[0];
  return (
    <>
      <PageHead title="Prospects" lead="Work only qualified, permitted opportunities." />
      {state === "claim" && owner ? (
        <Banner tone="info" title={`${SELLER.name} claimed Fernhill Growth Partners`} announce="status">
          <p>Found on its own site and the HubSpot partner directory, on Oct 14, 2026. The decision is yours; it is opened below.</p>
        </Banner>
      ) : state === "claim" ? (
        <Banner tone="info" title="Your claim on Fernhill Growth Partners is with the owner" announce="status">
          <p>It records that you found them, from which source and when. Once accepted, it lasts {CLAIM_DAYS} days; a first project in that time is yours under the seller agreement.</p>
        </Banner>
      ) : null}
      <div className="kauro-table-region">
        <table className="kauro-table kauro-prospects">
          <caption className="kauro-visually-hidden">{owner ? "Every prospect, with its seller" : "Your prospects"}</caption>
          <thead>
            <tr>
              <th scope="col">Organisation</th>
              {owner ? <th scope="col">Seller</th> : null}
              <th scope="col">State</th>
              <th scope="col">Next action</th>
            </tr>
          </thead>
          <tbody>
            {PROSPECTS.map((one) => (
              <tr key={one.id} className={one.id === open ? "is-open" : undefined}>
                <th scope="row">
                  <button type="button" className="kauro-row-open" aria-expanded={one.id === open} onClick={() => setOpen(one.id)}>
                    {one.name}
                  </button>
                  <span className="kauro-muted-text">
                    {one.segment} · {one.jurisdiction}
                  </span>
                </th>
                {owner ? <td data-label="Seller">{sellerOf(one)}</td> : null}
                <td data-label="State">
                  <Badge tone={TONE(one.state)}>{WORD[one.state]}</Badge>
                </td>
                <td data-label="Next action">{one.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {prospect === undefined ? null : <Detail prospect={prospect} ctx={ctx} claimed={state === "claim" && prospect.id === "p-01"} />}
    </>
  );
}

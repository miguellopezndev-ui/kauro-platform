"use client";
// UI34 Prospects (registry: "Work only qualified, permitted opportunities."). One row a prospect (ProspectView): the organisation, where it
// was found and when (a lawful, public source), whether it fits, whose it is, its state, and the next real action. A list is not qualified
// by being a list: a researched prospect needs its fit checked before any message. A suppressed prospect shows no way to contact it on any
// channel (registry exceptions). Claiming a prospect records who found it; the owner accepts or refuses the claim, and an accepted claim
// lasts 90 days (policy). People's names and personal addresses are not shown here: a seller works with organisations and role addresses.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, day, PageHead, ScreenButton } from "./kit.tsx";
import { CLAIM_DAYS, PROSPECTS, type Prospect, type ProspectState } from "./sales.ts";

export const UI34_STATES: readonly StateDef[] = [
  { key: "normal", label: "Prospects", note: "Five prospects in their states, one suppressed; one opened, with its source, fit and next action." },
  { key: "claim", label: "Claim submitted", note: "A claim on a qualified prospect, waiting for the owner: what it records and how long it lasts." },
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
          <dd>{claimed ? `Submitted today; if the owner accepts it, it lasts ${CLAIM_DAYS} days` : (prospect.claim ?? "Not claimed")}</dd>
        </div>
      </dl>
      {suppressed ? (
        <Banner tone="danger" title="Suppressed on every channel" announce="status">
          <p>Kestrel &amp; Lowe asked not to be contacted, on 1 Oct 2026. No message, call or social contact may be prepared or sent, by anyone, from any route.</p>
        </Banner>
      ) : (
        <div className="kauro-next">
          <p className="kauro-next-label">Next action</p>
          <h3>{prospect.next}</h3>
          <div className="kauro-actions">
            <ScreenButton to="UI54" ctx={ctx} variant="primary">
              <span className="kauro-go">Prepare a message</span>
            </ScreenButton>
            {prospect.claim === undefined && !claimed ? <Button>Claim this prospect</Button> : null}
          </div>
          <p className="kauro-muted">A message goes out only after review, from your verified sending identity, and never to a suppressed address.</p>
        </div>
      )}
    </section>
  );
}

export function Prospects({ ctx, state }: PrototypeProps): ReactElement {
  const initial = state === "suppressed" ? "p-05" : "p-01";
  const [open, setOpen] = useState(initial);
  const prospect = PROSPECTS.find((one) => one.id === open) ?? PROSPECTS[0];
  return (
    <>
      <PageHead title="Prospects" lead="Work only qualified, permitted opportunities." />
      {state === "claim" ? (
        <Banner tone="info" title="Your claim on Fernhill Growth Partners is with the owner" announce="status">
          <p>It records that you found them, from which source and when. Once accepted, it lasts {CLAIM_DAYS} days; a first project in that time is yours under the seller agreement.</p>
        </Banner>
      ) : null}
      <div className="kauro-table-region">
        <table className="kauro-table kauro-prospects">
          <caption className="kauro-visually-hidden">Your prospects</caption>
          <thead>
            <tr>
              <th scope="col">Organisation</th>
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

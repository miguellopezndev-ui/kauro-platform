"use client";
// P-03 Seller settings (proposed; round 2, seller-portal.md §8). Opened from the account menu, never from the work menu. One page of
// sections, the label and its one-line purpose on the left, the facts and at most one action on the right. Friction only where money and
// identity move: changing the payout destination asks for a fresh confirmation of identity, and Kauro checks a new destination at least 48
// hours after the change (PayoutDestination machine); payments approved before the change still go to the old one. Money and access
// emails are always sent; only three reminders can be turned off. No full account number, token or mailbox secret is ever shown: a masked
// label and a state.
//
// Needs a read or a contract (gaps): a profile read (name, address); tax documents on file (only the owner records them); notification
// preferences (no contract). Exists: GetSellerHome (state, permitted actions, statements, support route), ChangePayoutDestination
// (seller, step-up), PayoutDestinationStatusView, SenderIdentityView.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { StepUpPanel } from "@web/screens/shared/step-up.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Kind, OpsHead, OpsPage, Word } from "./ops-kit.tsx";
import { SELLER } from "./sales.ts";

export const P03_STATES: readonly StateDef[] = [
  { key: "normal", label: "Seller settings", note: "An active seller with a verified payout destination and a verified sending identity." },
  { key: "payout-step-up", label: "Changing the payout destination", note: "Changing where commissions are paid asks for a fresh confirmation of identity first." },
  { key: "sender-pending", label: "Sending identity pending", note: "Kauro registered a sending identity that is not verified yet: no message can be sent from it." },
  { key: "suspended", label: "Seller suspended", note: "A suspended seller keeps reading statements; claims and sending stop." },
];

const NOTICES: readonly { readonly event: string; readonly optional: boolean }[] = [
  { event: "A claim accepted, refused or expired, with the reason", optional: false },
  { event: "A statement issued, with its amount and pay date", optional: false },
  { event: "A payment sent, paid with its reference, or not received", optional: false },
  { event: "Your payout destination changed, verified or not accepted", optional: false },
  { event: "A line held or released, with the reason and review date", optional: false },
  { event: "A message authorised, or its authorisation ending in 3 days", optional: true },
  { event: "A claim ending in 14 days, and in 3 days", optional: true },
  { event: "A new version of a resource you quoted in a draft", optional: true },
];

function Row({ id, title, purpose, children }: { readonly id: string; readonly title: string; readonly purpose: string; readonly children: ReactNode }): ReactElement {
  return (
    <section className="kauro-ops-split" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="kauro-ops-setting-purpose">{purpose}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SellerSettings({ state }: PrototypeProps): ReactElement {
  const [payout, setPayout] = useState(state === "payout-step-up");
  const suspended = state === "suspended";
  return (
    <OpsPage>
      <OpsHead title="Your seller settings" lead="These apply only to you, Daniel Kim." />
      {suspended ? (
        <Banner tone="warning" title="Your seller account is suspended" announce="status">
          <p>You can still read your statements, and earned commission is still paid. New claims and sending are stopped until Kauro lifts the suspension.</p>
        </Banner>
      ) : null}
      <Row id="status" title="Seller status" purpose="Your agreement with Kauro, and what it allows.">
        <dl className="kauro-ops-facts">
          <div>
            <dt>State</dt>
            <dd>{suspended ? <Word tone="warning">Suspended since Oct 20, 2026</Word> : <Word tone="success">Active since {SELLER.since}</Word>}</dd>
          </div>
          <div>
            <dt>Agreement</dt>
            <dd>
              {SELLER.agreement}, signed {SELLER.signed}
            </dd>
          </div>
        </dl>
      </Row>
      <Row id="security" title="Sign-in and security" purpose="How you sign in. Any change asks for a fresh confirmation of identity.">
        <dl className="kauro-ops-facts">
          <div>
            <dt>Sign-in</dt>
            <dd>Google · {SELLER.email}</dd>
          </div>
          <div>
            <dt>Kauro authenticator</dt>
            <dd>
              <Word tone="success">On</Word>
            </dd>
          </div>
          <div>
            <dt>Active sessions</dt>
            <dd>1, this browser</dd>
          </div>
        </dl>
        <div className="kauro-actions">
          <Button>Sign out other sessions</Button>
        </div>
      </Row>
      <Row id="payout" title="Payout destination" purpose="Where Kauro pays your commission. Kauro keeps only a masked label of the account.">
        <dl className="kauro-ops-facts">
          <div>
            <dt>Paid to</dt>
            <dd>
              Bank account {SELLER.payout.label} · {SELLER.payout.currency}
            </dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>
              <Word tone="success">Verified {SELLER.payout.verifiedOn}</Word>
            </dd>
          </div>
        </dl>
        <p className="kauro-muted">A new destination is checked by Kauro at least 48 hours after you change it. Payments approved before the change still go to {SELLER.payout.label}. You are emailed on every change.</p>
        <StepUpPanel result={payout ? { kind: "STEP_UP", cause: "NO_CREDENTIAL" } : null} onStepUp={() => setPayout(false)}>
          {suspended ? null : <Button onClick={() => setPayout(true)}>Change payout destination</Button>}
        </StepUpPanel>
      </Row>
      <Row id="tax" title="Tax and documents" purpose="What Kauro holds to pay you lawfully. The documents themselves are never shown here.">
        <dl className="kauro-ops-facts">
          <div>
            <dt>Tax document</dt>
            <dd>{SELLER.taxDocument}</dd>
          </div>
        </dl>
        <Kind kind="backend">Needs a read · only Kauro records documents today</Kind>
      </Row>
      <Row id="sender" title="Sending identity" purpose="The address your messages leave from. Kauro registers and verifies it.">
        <dl className="kauro-ops-facts">
          <div>
            <dt>Address</dt>
            <dd>{SELLER.sender?.address}</dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>Your workspace mailbox</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{state === "sender-pending" ? <Word tone="warning">Waiting for Kauro&apos;s check</Word> : suspended ? <Word tone="neutral">Paused while suspended</Word> : <Word tone="success">Verified</Word>}</dd>
          </div>
        </dl>
        {state === "sender-pending" ? <p className="kauro-muted">You cannot send messages until Kauro verifies this address.</p> : null}
      </Row>
      <Row id="notices" title="Notifications" purpose="Email only. Money and access messages are always sent.">
        <Kind kind="backend">Needs a contract · notification preferences</Kind>
        <ul className="kauro-ops-notices">
          {NOTICES.map((notice) => (
            <li key={notice.event}>
              {notice.optional ? (
                <label className="kauro-check-row">
                  <input type="checkbox" defaultChecked />
                  <span>{notice.event}</span>
                </label>
              ) : (
                <p>
                  <span>{notice.event}</span>
                  <span className="kauro-ops-sub">Always sent</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      </Row>
    </OpsPage>
  );
}

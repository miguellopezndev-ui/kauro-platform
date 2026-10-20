"use client";
// P-03 Seller settings (proposed; Order 11 §4 C). A seller's own account on the operations origin. What exists: the seller's state and
// permitted actions (GetSellerHome), changing the payout destination (ChangePayoutDestination, the seller, fresh step-up: only a masked label
// and a fingerprint are kept), and sending identities that the owner registers and verifies for the seller (SenderIdentityView: route and
// state). A profile read and notices have no contract. No bank number, token or mailbox secret is ever shown.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { StepUpPanel } from "@web/screens/shared/step-up.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, Facts, PageHead, ScreenLink } from "./kit.tsx";

export const P03_STATES: readonly StateDef[] = [
  { key: "normal", label: "Seller settings", note: "An active seller with a verified payout destination and a verified sending identity." },
  { key: "payout-step-up", label: "Changing the payout destination", note: "Changing where commissions are paid asks for a fresh confirmation of identity first." },
  { key: "sender-pending", label: "Sending identity pending", note: "The owner registered a sending identity that is not verified yet: no outreach can be sent from it." },
  { key: "suspended", label: "Seller suspended", note: "A suspended seller keeps read access to statements; outreach and new claims stop." },
];

export function SellerSettings({ ctx, state }: PrototypeProps): ReactElement {
  const [payout, setPayout] = useState(state === "payout-step-up");
  const suspended = state === "suspended";
  return (
    <>
      <PageHead eyebrow="Kauro sales" title="Your seller settings" lead="Your seller account, payouts and sending identity." />
      <div className="kauro-settings-split">
      {suspended ? (
        <Banner tone="warning" title="Your seller account is suspended" announce="status">
          <p>You can still read your statements. Outreach and new claims are stopped until Kauro lifts the suspension.</p>
        </Banner>
      ) : null}

      <section aria-labelledby="seller-account">
        <h2 id="seller-account">Account</h2>
        <Facts
          rows={[
            ["State", suspended ? <Badge key="s" tone="danger">Suspended</Badge> : <Badge key="s" tone="success">Active</Badge>],
            ["Seller agreement", "Signed on 3 Sep 2026"],
            ["Name", "Daniel Kim"],
            ["Email address", "daniel.kim@sellers.example"],
          ]}
        />
        <p className="kauro-proposed">Proposed — name and address need a profile read (D-P03-1)</p>
      </section>

      <section aria-labelledby="seller-security">
        <h2 id="seller-security">Security</h2>
        <Facts
          rows={[
            ["Two-step verification", <Badge key="m" tone="success">On</Badge>],
            ["Before a payout change", "Kauro asks you to confirm your identity again"],
          ]}
        />
      </section>

      <section aria-labelledby="seller-payout">
        <h2 id="seller-payout">Payouts</h2>
        <Facts
          rows={[
            ["Paid to", "Bank account ending ··4821"],
            ["Currency", "USD"],
            ["Destination", <Badge key="v" tone="success">Verified on 5 Sep 2026</Badge>],
          ]}
        />
        <p className="kauro-muted">Kauro keeps a masked label and a fingerprint of the account, never the full number.</p>
        <StepUpPanel result={payout ? { kind: "STEP_UP", cause: "NO_CREDENTIAL" } : null} onStepUp={() => setPayout(false)}>
          {suspended ? null : <Button onClick={() => setPayout(true)}>Change payout destination</Button>}
        </StepUpPanel>
      </section>

      <section aria-labelledby="seller-sender">
        <h2 id="seller-sender">Sending identity</h2>
        <p>Outreach goes out from an identity Kauro registers and verifies for you, and only after each message is reviewed.</p>
        <Facts
          rows={[
            ["Address", "daniel.kim@sales.kauro.example"],
            ["Route", "Workspace mailbox"],
            ["State", state === "sender-pending" ? <Badge key="p" tone="warning">Waiting for verification</Badge> : <Badge key="p" tone="success">Verified</Badge>],
          ]}
        />
        {state === "sender-pending" ? <p>Nothing can be sent from this identity until Kauro verifies it. You will see the change here.</p> : null}
        <p>
          <ScreenLink to="UI54" ctx={ctx}>
            Reviewed correspondence
          </ScreenLink>
        </p>
      </section>

      <section aria-labelledby="seller-notices">
        <h2 id="seller-notices">Notices</h2>
        <p className="kauro-proposed">Proposed — notices need a contract (D-P03-2)</p>
        <fieldset className="kauro-notice-form">
          <legend>Email me when</legend>
          {["A statement is ready", "A claim is accepted or refused", "A message I prepared is approved"].map((label) => (
            <label key={label} className="kauro-check-row">
              <input type="checkbox" defaultChecked />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      </section>
      </div>
    </>
  );
}

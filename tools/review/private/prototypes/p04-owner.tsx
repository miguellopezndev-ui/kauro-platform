"use client";
// P-04 Owner settings (proposed; Order 11 §4 D). How Kauro is connected, protected and recovered, as the owner sees it on the operations
// origin. Each provider is a state, an environment and dates, never a key, token, account number or password: the bank route from
// getBankRoute (state, environment, rollout, verified), sending identities from SenderIdentityView, the identity provider and the cloud
// from what is known today (not connected; A9 not opened). Operating parameters are the policy's own values, read-only here. Changes go
// through their own screens and commands with step-up. A recovery plan (contacts, succession) has no contract: marked proposed.
import { type ReactElement } from "react";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, Facts, ScreenButton, ScreenLink } from "./kit.tsx";

export const P04_STATES: readonly StateDef[] = [
  { key: "normal", label: "Owner settings", note: "Today's synthetic picture: the bank route verified in sandbox, sign-in and the cloud not connected." },
  { key: "alerts", label: "A provider needs attention", note: "The bank route's details expired and a sending identity was revoked: each says what to do." },
];

interface ProviderRow {
  readonly name: string;
  readonly what: string;
  readonly state: { readonly tone: "success" | "warning" | "danger" | "neutral" | "info"; readonly label: string };
  readonly detail: string;
  readonly to?: string;
}

export function OwnerSettings({ ctx, state }: PrototypeProps): ReactElement {
  const alerts = state === "alerts";
  const providers: readonly ProviderRow[] = [
    { name: "Identity provider", what: "Sign-in, two-step verification, identity confirmation", state: { tone: "warning", label: "Not connected" }, detail: "Sign-in is not available until it is connected (W-IDP-LIVE)." },
    {
      name: "Bank route",
      what: "USD receipts by bank transfer",
      state: alerts ? { tone: "danger", label: "Details expired" } : { tone: "success", label: "Verified · sandbox" },
      detail: alerts ? "Payments stop being offered until the route's details are confirmed again." : "Rollout: controlled. Account shown as ··US01 only. Last verified 18 Oct 2026.",
      to: "UI39",
    },
    {
      name: "Email sending",
      what: "Transactional email and reviewed outreach",
      state: alerts ? { tone: "danger", label: "1 identity revoked" } : { tone: "neutral", label: "Not configured" },
      detail: alerts ? "Outreach from the revoked identity has stopped; nothing more is sent from it." : "No sending route is configured; outreach cannot be sent.",
      to: "UI54",
    },
    { name: "Card payments", what: "Hosted checkout", state: { tone: "neutral", label: "Deferred" }, detail: "Not offered at launch; payments are bank transfers (Payments V1)." },
    { name: "Cloud", what: "Hosting, storage and processing", state: { tone: "neutral", label: "Not opened" }, detail: "Nothing is deployed; this review runs on your machine." },
  ];
  return (
    <>
      <h1>Owner settings</h1>
      <p className="kauro-lead">How Kauro is connected, protected and recovered.</p>
      <nav className="kauro-local-nav" aria-label="Sections">
        <a href="#owner-security">Your security</a>
        <a href="#owner-providers">Providers</a>
        <a href="#owner-parameters">Operating parameters</a>
        <a href="#owner-controls">Security controls</a>
        <a href="#owner-recovery">Recovery</a>
      </nav>

      <section id="owner-security" aria-labelledby="owner-security-h">
        <h2 id="owner-security-h">Your security</h2>
        <Facts
          rows={[
            ["Two-step verification", <Badge key="m" tone="success">On</Badge>],
            ["Sensitive actions", "Ask for a fresh confirmation of identity, valid 15 minutes"],
            ["Customer CRM data", "Never shown to the owner here; a break-glass grant is needed and recorded"],
          ]}
        />
      </section>

      <section id="owner-providers" aria-labelledby="owner-providers-h">
        <h2 id="owner-providers-h">Providers</h2>
        <p>Each provider as a state and dates. No key, token, account number or password is shown anywhere.</p>
        <ul className="kauro-provider-list">
          {providers.map((provider) => (
            <li key={provider.name}>
              <div>
                <span className="kauro-member-name">{provider.name}</span>
                <span className="kauro-member-sub">{provider.what}</span>
              </div>
              <Badge tone={provider.state.tone}>{provider.state.label}</Badge>
              <p>{provider.detail}</p>
              {provider.to === undefined ? null : (
                <ScreenButton to={provider.to} ctx={ctx}>
                  Open
                </ScreenButton>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section id="owner-parameters" aria-labelledby="owner-parameters-h">
        <h2 id="owner-parameters-h">Operating parameters</h2>
        <p>The values in force, from the policy registry. They change only through a reviewed policy version, never here.</p>
        <Facts
          rows={[
            ["A quote stays valid", `${POLICY_SNAPSHOT.quoteDays} days`],
            ["Largest project at launch", `${POLICY_SNAPSHOT.launchSourceUnits.toLocaleString("en-US")} billable source units`],
            ["Session ends after inactivity", "30 minutes"],
            ["Session ends at the latest", "12 hours after sign-in"],
            ["Identity confirmation lasts", "15 minutes"],
          ]}
        />
      </section>

      <section id="owner-controls" aria-labelledby="owner-controls-h">
        <h2 id="owner-controls-h">Security controls</h2>
        <Facts
          rows={[
            ["Break-glass grants", "None active"],
            ["Restricted capabilities", "None"],
          ]}
        />
        <div className="kauro-actions">
          <ScreenButton to="UI38" ctx={ctx}>
            Owner actions
          </ScreenButton>
          <ScreenButton to="UI42" ctx={ctx}>
            Incidents
          </ScreenButton>
          <ScreenButton to="UI44" ctx={ctx}>
            Operating review
          </ScreenButton>
        </div>
      </section>

      <section id="owner-recovery" aria-labelledby="owner-recovery-h">
        <h2 id="owner-recovery-h">Recovery</h2>
        <p className="kauro-proposed">Proposed — recovery contacts and succession need a contract (D-P04-1)</p>
        <Facts
          rows={[
            ["Recovery contact", "Not recorded"],
            ["Succession", "Not recorded"],
          ]}
        />
        <p className="kauro-muted">
          Restores and recovery of data follow the operating runbook; see <ScreenLink to="UI43" ctx={ctx}>Releases</ScreenLink> and <ScreenLink to="UI41" ctx={ctx}>Deletion</ScreenLink>.
        </p>
      </section>
    </>
  );
}

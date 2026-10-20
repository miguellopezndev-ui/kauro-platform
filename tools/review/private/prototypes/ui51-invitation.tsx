"use client";
// UI51 Accept invitation (registry: "Join the intended agency."). The link carries the invitation's id in the path and its token in the
// fragment, which never reaches a server log. Only the invited identity, signed in with a verified email and two-step verification, can
// accept (CMD004 AcceptInvitation); the agency comes from the invitation, never from the request. The api has no read of an invitation
// before it is accepted, so the agency's name and the role appear once the person has joined; showing them before is a proposed read.
// An expired, revoked, used or forwarded invitation grants nothing and says so without naming anyone.
//
// The page draws the invitation as what it is: a window of the product with the invitation's state in its bar. A stamp marks the
// verdict, and only the verdict (accepted, expired, withdrawn, used).
import { Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Eyebrow, Facts, ScreenButton, Stamp, Window } from "./kit.tsx";

export const UI51_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to accept", note: "Signed in as the invited identity: one explicit action joins the agency." },
  { key: "signed-out", label: "Not signed in", note: "The link opened without a session: sign in with the invited address first. Nothing about the agency is shown." },
  { key: "accepted", label: "Joined", note: "Accepted: the agency and the role come back from the api, and the person goes to the agency's projects." },
  { key: "unverified", label: "Identity not ready", note: "No verified email or no two-step verification yet: finish those first." },
  { key: "mismatch", label: "Different identity", note: "Signed in as someone else (a forwarded link): the invitation grants nothing and names no one." },
  { key: "expired", label: "Expired", note: "Invitations last seven days. A new one comes from the agency." },
  { key: "revoked", label: "Withdrawn", note: "The agency withdrew it." },
  { key: "used", label: "Already used", note: "It was accepted before; signing in again does not revive it." },
  { key: "missing", label: "Not available", note: "An unknown invitation and someone else's look exactly the same." },
  { key: "preview", label: "PROPOSED: preview before accepting", note: "Proposed: the agency and the role shown before accepting. Needs an invitation read the api does not have (D-UI51-1)." },
];

const REFUSAL: Readonly<Record<string, { readonly state: string; readonly stamp?: string; readonly title: string; readonly body: string }>> = {
  unverified: { state: "Waiting for your account", title: "Finish setting up your account first", body: "To join an agency your email address must be verified and two-step verification must be on. Complete both, then open this link again." },
  mismatch: { state: "Not for this account", title: "This invitation is for someone else", body: "You are signed in with a different identity from the one invited. Sign out and sign in with the invited address, or ask for a new invitation." },
  expired: { state: "Expired", stamp: "Expired", title: "This invitation has expired", body: "Invitations can be accepted for seven days. This one can no longer be used." },
  revoked: { state: "Withdrawn", stamp: "Withdrawn", title: "This invitation was withdrawn", body: "The agency withdrew it, so it can no longer be accepted." },
  used: { state: "Used", stamp: "Used", title: "This invitation has already been used", body: "It was accepted before. Signing in again does not make it usable." },
  missing: { state: "Not available", title: "This invitation is not available", body: "The link may be incomplete or no longer valid." },
};

export function Invitation({ ctx, state }: PrototypeProps): ReactElement {
  const [step, setStep] = useState(state);
  const [busy, setBusy] = useState(false);
  const accept = (): void => {
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      setStep("accepted");
    }, 700);
  };
  const refusal = REFUSAL[step];

  let windowState = "Waiting for you";
  let tone: "neutral" | "done" | "attention" = "neutral";
  let stamp: string | null = null;
  let body: ReactElement;
  if (refusal !== undefined) {
    windowState = refusal.state;
    stamp = refusal.stamp ?? null;
    body = (
      <>
        <h2 className="kauro-invite-title">{refusal.title}</h2>
        <p>{refusal.body}</p>
        <p className="kauro-muted">If you expected to join an agency, ask the person who invited you to send a new invitation.</p>
      </>
    );
  } else if (step === "accepted") {
    windowState = "Accepted";
    tone = "done";
    stamp = "Accepted";
    body = (
      <>
        <h2 className="kauro-invite-title">
          You joined <bdi>Northwind Data</bdi>
        </h2>
        <Facts
          rows={[
            ["Your role", "Operator: clients and projects, from upload to the run"],
            ["Joined", "20 Oct 2026, 14:02 UTC"],
          ]}
        />
        <p className="kauro-muted">A change of role is decided by the agency&apos;s owner.</p>
        <div className="kauro-actions">
          <ScreenButton to="UI11" ctx={ctx} variant="primary">
            <span className="kauro-go">Go to projects</span>
          </ScreenButton>
        </div>
      </>
    );
  } else if (step === "signed-out") {
    windowState = "Sign in to continue";
    body = (
      <>
        <h2 className="kauro-invite-title">Sign in with the invited address</h2>
        <p>The agency and the role are shown only to the person invited, once they have signed in.</p>
        <div className="kauro-actions">
          <ScreenButton to="UI50" ctx={ctx} variant="primary">
            <span className="kauro-go">Sign in</span>
          </ScreenButton>
        </div>
      </>
    );
  } else {
    body = (
      <>
        {step === "preview" ? (
          <>
            <p className="kauro-proposed">Proposed — needs an invitation read (D-UI51-1)</p>
            <h2 className="kauro-invite-title">
              <bdi>Northwind Data</bdi> invites you as Operator
            </h2>
          </>
        ) : (
          <h2 className="kauro-invite-title">An agency invites you to join it</h2>
        )}
        <p>{step === "preview" ? "Operators work on clients and projects, from upload to the run." : "You will see which agency, and the role it chose for you, as soon as you accept."}</p>
        <ul className="kauro-checklist" aria-label="Your account is ready">
          <li>Signed in as the invited identity</li>
          <li>Email address verified</li>
          <li>Two-step verification on</li>
        </ul>
        <div className="kauro-actions">
          <Button variant="primary" onClick={accept} disabled={busy} aria-describedby="invitation-once">
            {busy ? "Joining…" : <span className="kauro-go">Accept invitation</span>}
          </Button>
        </div>
        <p id="invitation-once" className="kauro-muted">
          An invitation can be used once, by the person invited, within seven days.
        </p>
      </>
    );
  }

  return (
    <div className="kauro-invite">
      <header className="kauro-invite-head">
        <Eyebrow>Invitation</Eyebrow>
        <h1>Accept invitation</h1>
        <p className="kauro-lead">Join the intended agency.</p>
      </header>
      <div className="kauro-invite-object">
        <Window title="Invitation to an agency" state={windowState} stateTone={tone}>
          <div aria-live="polite">{body}</div>
        </Window>
        {stamp === null ? null : <Stamp>{stamp}</Stamp>}
      </div>
    </div>
  );
}

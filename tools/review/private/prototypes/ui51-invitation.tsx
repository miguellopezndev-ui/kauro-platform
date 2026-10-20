"use client";
// UI51 Accept invitation (registry: "Join the intended agency."). The link carries the invitation's id in the path and its token in the
// fragment, which never reaches a server log. Only the invited identity, signed in with a verified email and two-step verification, can
// accept (CMD004 AcceptInvitation); the agency comes from the invitation, never from the request. The api has no read of an invitation
// before it is accepted, so the agency's name and the role appear once the person has joined; showing them before is a proposed read.
// An expired, revoked, used or forwarded invitation grants nothing and says so without naming anyone.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Facts, ScreenButton } from "./kit.tsx";

export const UI51_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to accept", note: "Signed in as the invited identity: one explicit action joins the agency." },
  { key: "signed-out", label: "Not signed in", note: "The link opened without a session: sign in with the invited address first. Nothing about the agency is shown." },
  { key: "accepted", label: "Joined", note: "Accepted: the agency and the role come back from the api, and the person goes to the agency's projects." },
  { key: "unverified", label: "Identity not ready", note: "The account has no verified email or no two-step verification: finish those first." },
  { key: "mismatch", label: "Different identity", note: "Signed in as someone else (a forwarded link): the invitation grants nothing and names no one." },
  { key: "expired", label: "Expired", note: "Invitations last seven days. A new one comes from the agency." },
  { key: "revoked", label: "Withdrawn", note: "The agency withdrew it." },
  { key: "used", label: "Already used", note: "It was accepted before; signing in again does not revive it." },
  { key: "missing", label: "Not available", note: "An unknown invitation and someone else's look exactly the same." },
  { key: "preview", label: "PROPOSED: preview before accepting", note: "Proposed design: the agency and the role shown before accepting. Needs an invitation read the api does not have (dependency D-UI51-1)." },
];

function Refusal({ title, children }: { readonly title: string; readonly children: string }): ReactElement {
  return (
    <>
      <Banner tone="warning" title={title} announce="alert">
        <p>{children}</p>
      </Banner>
      <p>If you expected to join an agency, ask the person who invited you to send a new invitation.</p>
    </>
  );
}

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

  let body: ReactElement;
  switch (step) {
    case "signed-out":
      body = (
        <>
          <p>Sign in with the email address this invitation was sent to. Once your identity is checked you can accept it.</p>
          <div className="kauro-actions">
            <ScreenButton to="UI50" ctx={ctx} variant="primary">
              Sign in to continue
            </ScreenButton>
          </div>
          <p className="kauro-muted">The agency and the role are shown only to the invited identity, after it signs in.</p>
        </>
      );
      break;
    case "accepted":
      body = (
        <>
          <Banner tone="success" title="You joined Northwind Data" announce="status">
            <p>Your role is Operator. You can work on clients and projects; the agency&apos;s owner decides any change of role.</p>
          </Banner>
          <Facts
            rows={[
              ["Agency", <bdi key="name">Northwind Data</bdi>],
              ["Your role", "Operator"],
              ["Joined", "20 Oct 2026, 14:02 UTC"],
            ]}
          />
          <div className="kauro-actions">
            <ScreenButton to="UI11" ctx={ctx} variant="primary">
              Go to projects
            </ScreenButton>
          </div>
        </>
      );
      break;
    case "unverified":
      body = (
        <Refusal title="Finish setting up your account first">
          To join an agency your email address must be verified and two-step verification must be on. Complete both, then open this link again.
        </Refusal>
      );
      break;
    case "mismatch":
      body = (
        <Refusal title="This invitation is for someone else">
          You are signed in with a different identity from the one invited. Sign out and sign in with the invited address, or ask for a new invitation.
        </Refusal>
      );
      break;
    case "expired":
      body = <Refusal title="This invitation has expired">Invitations can be accepted for seven days. This one can no longer be used.</Refusal>;
      break;
    case "revoked":
      body = <Refusal title="This invitation was withdrawn">The agency withdrew it, so it can no longer be accepted.</Refusal>;
      break;
    case "used":
      body = <Refusal title="This invitation has already been used">It was accepted before. Signing in again does not make it usable.</Refusal>;
      break;
    case "missing":
      body = <Refusal title="This invitation is not available">The link may be incomplete or no longer valid.</Refusal>;
      break;
    default:
      body = (
        <>
          {step === "preview" ? (
            <>
              <p className="kauro-proposed">Proposed — needs an invitation read (D-UI51-1)</p>
              <Facts
                rows={[
                  ["Agency", <bdi key="name">Northwind Data</bdi>],
                  ["Role offered", "Operator"],
                  ["Valid until", "27 Oct 2026"],
                ]}
              />
            </>
          ) : (
            <p>You are signed in with the identity this invitation was sent to. Accepting adds you to the agency that invited you, with the role it chose; you will see both as soon as you accept.</p>
          )}
          <ul className="kauro-checklist">
            <li>Email address verified</li>
            <li>Two-step verification on</li>
          </ul>
          <div className="kauro-actions">
            <Button variant="primary" onClick={accept} disabled={busy} aria-describedby="invitation-once">
              {busy ? "Accepting…" : "Accept invitation"}
            </Button>
          </div>
          <p id="invitation-once" className="kauro-muted">
            An invitation can be used once, by the invited identity, within seven days.
          </p>
        </>
      );
  }

  return (
    <div className="kauro-card-page">
      <section className="kauro-card-page-card" aria-labelledby="invitation-title">
        <p className="kauro-eyebrow">Invitation</p>
        <h1 id="invitation-title">Accept invitation</h1>
        <p className="kauro-lead">Join the intended agency.</p>
        <div aria-live="polite">{body}</div>
      </section>
    </div>
  );
}

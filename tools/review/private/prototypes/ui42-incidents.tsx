"use client";
// UI42 Incidents (registry: "Contain the affected scope and prove recovery."). One incident at a time (IncidentView): its severity, what is
// known to be affected (and only that), the three responsibilities (containment, recovery, communication) with who holds each, and the next
// review. The owner prepares what is needed: time-boxed emergency access (policy: 30 minutes, the smallest scope), a recovery, or a notice
// for review. Nothing is invented: no resolution that did not happen, no wider access than the scope, and no message to customers that was
// not actually sent (registry exceptions).
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

export const UI42_STATES: readonly StateDef[] = [
  { key: "normal", label: "None open", note: "No open incident: the last one, closed, with its timeline and what it affected." },
  { key: "open", label: "An open incident", note: "S2, download links failing: contained, recovery under way, a notice prepared for review and not sent." },
];

export function Incidents({ state }: PrototypeProps): ReactElement {
  const open = state === "open";
  return (
    <>
      <PageHead eyebrow="Kauro operations" title="Incidents" lead="Contain the affected scope and prove recovery." />
      {open ? null : (
        <Banner tone="success" title="No incident is open" announce="status">
          <p>The last one closed on 9 Oct 2026. Checks run every minute; a new incident opens here by itself.</p>
        </Banner>
      )}
      <section className="kauro-prospect" aria-labelledby="inc-h">
        <div className="kauro-prospect-head">
          <h2 id="inc-h">{open ? "Download links fail for some packages" : "Health checks delayed"}</h2>
          <Badge tone={open ? "danger" : "neutral"}>{open ? "S2 · open" : "S3 · closed"}</Badge>
        </div>
        <dl className="kauro-prospect-facts">
          <div>
            <dt>Started</dt>
            <dd>{open ? "20 Oct 2026, 15:20 UTC" : "9 Oct 2026, 08:12 UTC; closed 08:53 UTC"}</dd>
          </div>
          <div>
            <dt>Known to be affected</dt>
            <dd>{open ? "3 packages in 2 workspaces: their links return an error. No file was exposed." : "6 health checks started 41 minutes late. No result was wrong."}</dd>
          </div>
          <div>
            <dt>Next review</dt>
            <dd>{open ? "16:20 UTC, in 40 minutes" : "Review held on 10 Oct 2026"}</dd>
          </div>
        </dl>
      </section>
      <ol className="kauro-incident-duties">
        <li className={open ? "is-done" : "is-done"}>
          <strong>Containment</strong>
          <span>{open ? "Done at 15:31 UTC: new links for the 3 packages are paused; nothing else is affected." : "Done at 08:20 UTC: the queue was drained."}</span>
        </li>
        <li className={open ? "is-current" : "is-done"}>
          <strong>Recovery</strong>
          <span>{open ? "Under way: the signing key is being rotated. Proof of recovery: a test link for each package, downloaded and checked." : "Proved at 08:53 UTC: the 6 checks completed and were compared with a second run."}</span>
        </li>
        <li className={open ? "is-current" : "is-done"}>
          <strong>Communication</strong>
          <span>{open ? "A notice to the 2 workspaces is prepared for your review. It has not been sent." : "Not required: no customer saw a wrong result."}</span>
        </li>
      </ol>
      {open ? (
        <section className="kauro-approve" aria-labelledby="prep-h">
          <h2 id="prep-h">Prepared for you</h2>
          <div className="kauro-actions">
            <Button variant="primary">Review the notice</Button>
            <Button>Prepare emergency access</Button>
          </div>
          <p className="kauro-muted">Emergency access lasts 30 minutes, covers only the 3 packages&apos; storage records, never their contents, and is recorded with its reason.</p>
        </section>
      ) : null}
    </>
  );
}

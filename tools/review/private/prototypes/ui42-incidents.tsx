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
import { Badge, PageHead, ScreenLink } from "./kit.tsx";

export const UI42_STATES: readonly StateDef[] = [
  { key: "normal", label: "None open", note: "No open incident: the last one, closed, with its timeline and what it affected." },
  { key: "open", label: "An open incident", note: "S2, download links failing: contained, recovery under way, a notice prepared for review and not sent." },
];

export function Incidents({ ctx, state }: PrototypeProps): ReactElement {
  const open = state === "open";
  return (
    <>
      <PageHead title="Incidents" lead="Contain the affected scope and prove recovery." />
      {open ? null : (
        <Banner tone="success" title="No incident is open" announce="status">
          <p>The last one closed on Oct 9, 2026. A new incident appears here when it is recorded.</p>
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
            <dd>{open ? "Oct 20, 2026, 3:20 PM UTC" : "Oct 9, 2026, 8:12 AM UTC; closed 8:53 AM UTC"}</dd>
          </div>
          <div>
            <dt>Known to be affected</dt>
            <dd>
              {open ? (
                "3 packages in 2 workspaces: their links return an error. No file was exposed."
              ) : (
                <>
                  6 health checks started 41 minutes late. No result was wrong.{" "}
                  <ScreenLink to="UI40" ctx={ctx}>
                    See the jobs
                  </ScreenLink>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Next review</dt>
            <dd>{open ? "4:20 PM UTC, in 40 minutes" : "Review held on Oct 10, 2026"}</dd>
          </div>
        </dl>
      </section>
      <ol className="kauro-incident-duties">
        <li className="is-done">
          <strong>Containment</strong>
          <span>{open ? "Done at 3:31 PM UTC: new links for the 3 packages are paused; nothing else is affected." : "Done at 8:20 AM UTC: the queue was drained."}</span>
        </li>
        <li className={open ? "is-current" : "is-done"}>
          <strong>Recovery</strong>
          <span>{open ? "Under way: the signing key is being rotated. Proof of recovery: a test link for each package, downloaded and checked." : "Proved at 8:53 AM UTC: the 6 checks completed and were compared with a second run."}</span>
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

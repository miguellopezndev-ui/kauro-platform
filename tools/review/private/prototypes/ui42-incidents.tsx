"use client";
// UI42 Incidents (registry: "Contain the affected scope and prove recovery."). Round 2: with nothing open the page says so in one sentence
// (no success banner for an absence); the last incident stays below as the record. One incident at a time (IncidentView): its severity,
// what is known to be affected (and only that), the three duties (containment, recovery, communication) as a list of states, and the next
// review. The owner prepares what is needed: time-boxed emergency access (30 minutes, the smallest scope), or a notice for review. Nothing is
// invented: no resolution that did not happen, no wider access than the scope, no message to customers that was not sent. Times in UTC.
import { Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Rings } from "./kit.tsx";
import { OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";

export const UI42_STATES: readonly StateDef[] = [
  { key: "normal", label: "None open", note: "No open incident: one sentence, then the last one, closed, with its duties and what it affected." },
  { key: "open", label: "An open incident", note: "S2, download links failing: contained, recovery under way, a notice prepared for review and not sent." },
];

export function Incidents({ state }: PrototypeProps): ReactElement {
  const open = state === "open";
  return (
    <OpsPage>
      <OpsHead title="Incidents" lead={open ? "1 incident is open. Its next review is at 4:20 PM UTC." : "No incident is open. The last one closed on Oct 9, 2026."} />
      <section aria-labelledby="inc-h">
        <SectionHead id="inc-h" title={open ? "Download links fail for some packages" : "Last incident: health checks delayed"} aside={<Word tone={open ? "danger" : "neutral"}>{open ? "S2 · open" : "S3 · closed"}</Word>} />
        <dl className="kauro-ops-facts">
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
                  6 health checks started 41 minutes late. No result was wrong. <Link href={OPS_PATH.jobs}>Jobs</Link>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Next review</dt>
            <dd>{open ? "4:20 PM UTC, in 40 minutes" : "Held on Oct 10, 2026"}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="duties-h">
        <SectionHead id="duties-h" title="Duties" />
        <Rings
          items={[
            { key: "contain", name: "Containment", fact: open ? "Done 3:31 PM UTC: new links for the 3 packages paused" : "Done 8:20 AM UTC: the queue was drained", state: "done" },
            { key: "recover", name: "Recovery", fact: open ? "Under way: the signing key is being rotated" : "Proved 8:53 AM UTC: checks compared with a second run", state: open ? "current" : "done" },
            { key: "tell", name: "Communication", fact: open ? "A notice to the 2 workspaces, prepared, not sent" : "Not required: no customer saw a wrong result", state: open ? "current" : "done" },
          ]}
        />
      </section>
      {open ? (
        <section className="kauro-ops-decide" aria-labelledby="prep-h">
          <h2 id="prep-h">Prepared for you</h2>
          <p>The notice to the 2 workspaces says what failed, that no file was exposed, and when links work again. Proof of recovery: a test link for each package, downloaded and checked.</p>
          <div className="kauro-actions">
            <Button variant="primary">Review the notice</Button>
            <Button>Prepare emergency access</Button>
          </div>
          <p className="kauro-muted">Emergency access lasts 30 minutes, covers only the 3 packages&apos; storage records, never their contents, and is recorded with its reason.</p>
        </section>
      ) : null}
    </OpsPage>
  );
}

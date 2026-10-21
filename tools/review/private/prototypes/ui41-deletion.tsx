"use client";
// UI41 Deletion (registry: "Verify what was actually removed."). Round 2: the page leads with the one deletion that is not verified, in one
// sentence, then its evidence. One deletion as evidence: why, what it covers, the deadline, and class by class what Kauro's records marked
// removed and what the storage provider actually removed. A record marked "deleted" cannot hide an object the provider still holds
// (registry exception): such an object is shown with its retry. What a deletion never covers is said: copies the customer downloaded, and
// records already imported into the customer's CRM. Times in UTC: this is a technical page.
import { Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";

export const UI41_STATES: readonly StateDef[] = [
  { key: "normal", label: "A retry pending", note: "A retention deletion: every class removed but one storage object, asked again at 2:00 PM UTC." },
  { key: "verified", label: "Verified", note: "Every class removed at the provider too: the deletion is verified, with its receipt." },
];

export function Deletion({ state }: PrototypeProps): ReactElement {
  const verified = state === "verified";
  const rows = [
    { what: "Sealed source files", database: "Removed", provider: "14 of 14 objects removed", ok: true },
    { what: "Plan and decisions", database: "Removed", provider: "No provider object", ok: true },
    { what: "Package version 1", database: "Removed", provider: verified ? "7 of 7 objects removed" : "6 of 7 removed; manifest.json still held", ok: verified },
    { what: "Import results", database: "Removed", provider: "2 of 2 objects removed", ok: true },
    { what: "Model context", database: "Removed", provider: "Removed with the files", ok: true },
  ];
  return (
    <OpsPage>
      <OpsHead title="Deletion" lead={verified ? "Every deletion is verified at the storage provider. The last one is below, with its receipt." : "1 deletion is not verified: the storage provider still holds one file."} />
      <section className="kauro-ops-decide" aria-labelledby="del-h">
        <div className="kauro-ops-head-title">
          <h2 id="del-h">Ridge &amp; Fennel Consulting · Archive contacts</h2>
          <Word tone={verified ? "success" : "warning"}>{verified ? "Verified" : "1 object still held"}</Word>
        </div>
        <dl className="kauro-ops-facts">
          <div>
            <dt>Why</dt>
            <dd>The keeping period ended: 7 days after the first package</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>Oct 20, 2026, 11:05 AM UTC; started on time</dd>
          </div>
          <div>
            <dt>Covers</dt>
            <dd>1 sealed set, 3 retention records, 1 package version</dd>
          </div>
          <div>
            <dt>Never covers</dt>
            <dd>Copies the customer downloaded; records already imported into their CRM</dd>
          </div>
        </dl>
        <div className="kauro-ops-tablewrap">
          <div className="kauro-table-region">
            <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
              <caption className="kauro-visually-hidden">What was removed, class by class</caption>
              <thead>
                <tr>
                  <th scope="col">Class</th>
                  <th scope="col">Kauro&apos;s records</th>
                  <th scope="col">Storage provider</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.what}>
                    <th scope="row">
                      {row.what}
                      {row.ok ? null : (
                        <span className="kauro-ops-cell-badge">
                          <Word tone="warning">Not verified</Word>
                        </span>
                      )}
                    </th>
                    <td data-label="Kauro's records">
                      <span>{row.database}</span>
                    </td>
                    <td data-label="Storage provider">
                      <span>{row.provider}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {verified ? (
          <p className="kauro-ops-sentence">Every object was confirmed gone at the provider on Oct 20, 2026 at 2:02 PM UTC. The receipt lists each class and each object.</p>
        ) : (
          <>
            <p>The provider refused to remove manifest.json at 11:06 AM UTC (a temporary error) and was asked again at 2:00 PM UTC. Until it confirms, this deletion is not verified, whatever Kauro&apos;s records say.</p>
            <div className="kauro-actions">
              <Button variant="primary">Retry the removal now</Button>
              <Button>Read the provider&apos;s answer</Button>
            </div>
          </>
        )}
      </section>
      <section aria-labelledby="journal-h">
        <SectionHead id="journal-h" title="Restore journal" />
        <p>Backups made before the deletion would bring these files back on a restore. The journal records this deletion, so a restore removes them again before anything is served.</p>
      </section>
    </OpsPage>
  );
}

"use client";
// UI41 Deletion (registry: "Verify what was actually removed."). One deletion as evidence: why (DeletionRequestView: reason), what it covers
// (the files, the retention records, the package versions), the deadline, and then, class by class, what the database marked removed and
// what the storage provider actually removed. A database marked "deleted" cannot hide an object the provider still holds (registry
// exception): such an object is shown, with its retry. What a deletion never covers is said: copies the customer downloaded, and imports
// already in the customer's CRM.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

export const UI41_STATES: readonly StateDef[] = [
  { key: "normal", label: "A retry pending", note: "A retention deletion: every class removed but one storage object, retried at 2:00 PM UTC." },
  { key: "verified", label: "Verified", note: "Every class removed at the provider too: the deletion is verified, with its receipt." },
];

export function Deletion({ state }: PrototypeProps): ReactElement {
  const verified = state === "verified";
  const rows = [
    { what: "Sealed source files", database: "Removed", provider: "14 of 14 objects removed", ok: true },
    { what: "Plan and decisions", database: "Removed", provider: "No provider object", ok: true },
    { what: "Package version 1", database: "Removed", provider: verified ? "7 of 7 objects removed" : "6 of 7 objects removed; manifest.json still held", ok: verified },
    { what: "Import results", database: "Removed", provider: "2 of 2 objects removed", ok: true },
    { what: "Model context", database: "Removed", provider: "Removed with the files", ok: true },
  ];
  return (
    <>
      <PageHead title="Deletion" lead="Verify what was actually removed." />
      <section className="kauro-prospect" aria-labelledby="del-h">
        <div className="kauro-prospect-head">
          <h2 id="del-h">Ridge &amp; Fennel Consulting · Archive contacts</h2>
          <Badge tone={verified ? "success" : "warning"}>{verified ? "Verified" : "1 object to remove"}</Badge>
        </div>
        <dl className="kauro-prospect-facts">
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
      </section>
      <div className="kauro-table-region">
        <table className="kauro-table kauro-deletion">
          <caption className="kauro-visually-hidden">What was removed, class by class</caption>
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Kauro&apos;s database</th>
              <th scope="col">Storage provider</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.what} className={row.ok ? undefined : "is-attention"}>
                <th scope="row">{row.what}</th>
                <td data-label="Kauro's database">{row.database}</td>
                <td data-label="Storage provider">{row.provider}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {verified ? (
        <Banner tone="success" title="Removed everywhere, and verified" announce="status">
          <p>Every object was confirmed gone at the provider on Oct 20, 2026 at 2:02 PM UTC. The receipt lists each class and each object; the restore journal holds nothing of this project.</p>
        </Banner>
      ) : (
        <section className="kauro-approve" aria-labelledby="retry-h">
          <h2 id="retry-h">One object is still held</h2>
          <p>The provider refused to remove manifest.json at 11:06 AM UTC (a temporary error) and was asked again at 2:00 PM UTC. Until it confirms, this deletion is not verified, whatever the database says.</p>
          <div className="kauro-actions">
            <Button variant="primary">Retry the removal now</Button>
            <Button>Inspect the provider&apos;s answer</Button>
          </div>
        </section>
      )}
      <section className="kauro-screen-section" aria-labelledby="journal-h">
        <h2 id="journal-h">Restore journal</h2>
        <p>Backups made before the deletion would bring these files back on a restore. The journal records this deletion, so a restore removes them again before anything is served.</p>
      </section>
    </>
  );
}

"use client";
// UI29 Data lifecycle (registry: "See what remains and what will be deleted."). One row a class of data the project holds (RetentionView:
// class, soft and hard deadlines, state), in the words of Data handling's schedule, with the date each goes. The one soft extension a
// project may have (policy: one, at most 3 days) is offered only before the soft deadline, and the page shows where it would end; it never
// crosses the hard deadline and never revives expired data (registry exceptions). Deleting early is a request with its own confirmation.
// What deletion does not reach is said plainly: copies already downloaded, and financial and legal records kept apart from CRM content.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { IDS } from "../lib/ids.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { EXTENDED_DEADLINE, EXTENSION_DAYS, HARD_DEADLINE, RECEIPT_DAYS, SOFT_DEADLINE, TARGET_DAYS } from "./delivery.ts";
import { Badge, moment, PageHead } from "./kit.tsx";

export const UI29_STATES: readonly StateDef[] = [
  { key: "normal", label: "Kept", note: "What the project holds and when each goes; the one extension still available." },
  { key: "extended", label: "Extended", note: "The extension used: 3 more days, still inside the limit set by the payment date." },
  { key: "deletion", label: "Deletion requested", note: "The team asked to delete the project's files now: what goes, and what stays." },
  { key: "deleted", label: "Deleted", note: "The files and package are deleted; no extension can bring them back." },
];

interface Row {
  readonly what: string;
  readonly holds: string;
  readonly until: string;
  readonly rule: string;
  readonly state: "kept" | "deleting" | "deleted";
}

export function Lifecycle({ ctx, state, project }: PrototypeProps): ReactElement {
  const agencyId = ctx.agency?.agencyId ?? "";
  const extended = state === "extended";
  const gone = state === "deleted";
  const deleting = state === "deletion";
  const canDelete = (ctx.agency?.permittedActions ?? []).includes("REQUEST_DELETION");
  const [asking, setAsking] = useState(false);
  const files: Row["state"] = gone ? "deleted" : deleting ? "deleting" : "kept";
  const rows: readonly Row[] = [
    {
      what: "Files and delivery package",
      holds: "The sealed files, the plan, the package and its report",
      until: gone ? "Deleted Oct 27, 2026" : moment(extended ? EXTENDED_DEADLINE : SOFT_DEADLINE),
      rule: `7 days after the first package was ready; never later than ${moment(HARD_DEADLINE)}, 14 days after the payment`,
      state: files,
    },
    {
      what: "Import results",
      holds: "The exports your team returned, and their checks",
      until: `${RECEIPT_DAYS} days after each check is final`,
      rule: "Or with the project's files, while a stage still needs them",
      state: files,
    },
    {
      what: "Destination settings you confirmed",
      holds: "What Kauro read and you confirmed; never a password or a key",
      until: `Up to ${TARGET_DAYS} days after their last use`,
      rule: "Used for a new delivery for 30 days at most",
      state: "kept",
    },
    {
      what: "Financial and legal records",
      holds: "The quote, the order and the payment; no CRM content",
      until: "As long as the rules require",
      rule: "Stored apart from CRM content",
      state: "kept",
    },
  ];
  return (
    <>
      <ProjectHeader current="import" />
      <PageHead title="Data lifecycle" lead="See what remains and what will be deleted." />
      {deleting ? (
        <Banner tone="info" title="Deletion requested on Oct 22, 2026 at 10:30 AM UTC" announce="status">
          <p>The project&apos;s files, package and import results are being deleted from Kauro&apos;s storage, staging and derived files. This page says when it is done.</p>
        </Banner>
      ) : null}
      {gone ? (
        <Banner tone="neutral" title="The project's files are deleted" announce="status">
          <p>Deleted on Oct 27, 2026, at the end of their keeping period. No extension can bring them back; to work on the same data again, start a new project with the files.</p>
        </Banner>
      ) : null}
      <div className="kauro-table-region">
        <table className="kauro-table kauro-lifecycle">
          <caption className="kauro-visually-hidden">What the project holds and when each kind is deleted</caption>
          <thead>
            <tr>
              <th scope="col">What is kept</th>
              <th scope="col">Until</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.what}>
                <th scope="row">
                  <span className="kauro-lifecycle-what">{row.what}</span>
                  <span className="kauro-lifecycle-holds">{row.holds}</span>
                </th>
                <td data-label="Until">
                  <strong>{row.until}</strong>
                  <span className="kauro-lifecycle-rule">{row.rule}</span>
                </td>
                <td data-label="State">
                  {row.state === "deleted" ? <Badge tone="neutral">Deleted</Badge> : row.state === "deleting" ? <Badge tone="info">Being deleted</Badge> : <Badge tone="success">Kept</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {gone || deleting ? null : (
        <section className="kauro-lifecycle-actions" aria-labelledby="extend-h">
          <div className="kauro-lifecycle-card">
            <h2 id="extend-h">More time</h2>
            {extended ? (
              <p>
                The extension is used: the files now stay until <strong>{moment(EXTENDED_DEADLINE)}</strong>. A project has one, and none is left.
              </p>
            ) : (
              <>
                <p>
                  This project can have one extension of up to {EXTENSION_DAYS} days, asked for before <strong>{moment(SOFT_DEADLINE)}</strong>. The files would stay until <strong>{moment(EXTENDED_DEADLINE)}</strong>, still before the limit of {moment(HARD_DEADLINE)}.
                </p>
                <Button>Extend by {EXTENSION_DAYS} days</Button>
              </>
            )}
          </div>
          <div className="kauro-lifecycle-card">
            <h2>Delete now</h2>
            {canDelete ? (
              asking ? (
                <>
                  <p>The files, the package and the import results are deleted from Kauro, and the package cannot be downloaded again. This cannot be undone.</p>
                  <div className="kauro-actions">
                    <Button variant="danger">Delete the project&apos;s files</Button>
                    <Button onClick={() => setAsking(false)}>Keep them</Button>
                  </div>
                </>
              ) : (
                <>
                  <p>Your team does not have to wait for the dates above.</p>
                  <Button onClick={() => setAsking(true)}>Request deletion</Button>
                </>
              )
            ) : (
              <p>An owner or an admin of this workspace can request it.</p>
            )}
          </div>
        </section>
      )}
      <section className="kauro-screen-section" aria-labelledby="residual-h">
        <h2 id="residual-h">What deletion does not reach</h2>
        <ul>
          <li>Copies your team downloaded stay with your team.</li>
          <li>Financial and legal records stay for as long as the rules require, apart from CRM content.</li>
          <li>Nothing in your CRM: Kauro never had access to it.</li>
        </ul>
      </section>
    </>
  );
}

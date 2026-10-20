"use client";
// UI40 Jobs (registry: "Inspect safe execution and recovery facts."). The preparation jobs (JobView): which logical attempt, which phase,
// the plan version the customer approved, the resources it may use, the lease that proves it is alive, and any incident it belongs to.
// Nothing here edits a state by hand: cancelling, reconciling or retrying is prepared under the one authorisation the customer gave, and no
// manual change can stand in for an approval, a payment or a deletion (registry exception). No customer data is shown, only facts.
import { Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

export const UI40_STATES: readonly StateDef[] = [
  { key: "normal", label: "Jobs", note: "One job running with a live lease, one ready, one cancelled; the running one opened." },
  { key: "stalled", label: "A lease expired", note: "A job stopped renewing its lease: the facts, and the one recovery that may be prepared." },
];

const JOBS = [
  { id: "job-7c41", workspace: "Halden Outdoor", project: "Spring contacts", state: "RUNNING", attempt: 1, version: 3, queued: "20 Oct, 13:52 UTC", deadline: "22 Oct, 13:52 UTC" },
  { id: "job-5a10", workspace: "Northwind Data", project: "Larch Studio contacts", state: "READY", attempt: 1, version: 6, queued: "20 Oct, 14:00 UTC", deadline: "22 Oct, 14:00 UTC" },
  { id: "job-31e9", workspace: "Juniper Digital", project: "Second import", state: "CANCELLED", attempt: 1, version: 2, queued: "17 Oct, 09:10 UTC", deadline: "19 Oct, 09:10 UTC" },
] as const;
const WORD: Readonly<Record<string, string>> = { RUNNING: "Running", READY: "Ready", CANCELLED: "Cancelled" };

export function Jobs({ state }: PrototypeProps): ReactElement {
  const stalled = state === "stalled";
  const [open, setOpen] = useState<string>("job-7c41");
  const job = JOBS.find((one) => one.id === open) ?? JOBS[0];
  const running = job.state === "RUNNING";
  return (
    <>
      <PageHead eyebrow="Kauro operations" title="Jobs" lead="Inspect safe execution and recovery facts." />
      <div className="kauro-table-region">
        <table className="kauro-table kauro-prospects">
          <caption className="kauro-visually-hidden">Preparation jobs</caption>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">State</th>
              <th scope="col">Delivery due</th>
            </tr>
          </thead>
          <tbody>
            {JOBS.map((job) => (
              <tr key={job.id} className={job.id === open ? "is-open" : undefined}>
                <th scope="row">
                  <button type="button" className="kauro-row-open" aria-expanded={job.id === open} onClick={() => setOpen(job.id)}>
                    {job.workspace} · {job.project}
                  </button>
                  <span className="kauro-muted-text">
                    <code>{job.id}</code> · attempt {job.attempt} · plan version {job.version}
                  </span>
                </th>
                <td data-label="State">
                  <Badge tone={job.state === "READY" ? "success" : job.state === "RUNNING" ? (stalled ? "warning" : "info") : "neutral"}>{job.state === "RUNNING" && stalled ? "Lease expired" : (WORD[job.state] ?? job.state)}</Badge>
                </td>
                <td data-label="Delivery due">{job.deadline}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="kauro-prospect" aria-labelledby="job-h">
        <div className="kauro-prospect-head">
          <h2 id="job-h">
            {job.workspace} · {job.project}
          </h2>
          <Badge tone={running ? (stalled ? "warning" : "info") : job.state === "READY" ? "success" : "neutral"}>{running && stalled ? "Lease expired" : (WORD[job.state] ?? job.state)}</Badge>
        </div>
        <dl className="kauro-prospect-facts">
          <div>
            <dt>Attempt</dt>
            <dd>{job.attempt} of the one logical job; queued {job.queued}</dd>
          </div>
          <div>
            <dt>Phase</dt>
            <dd>{running ? "Applying the approved plan, then the read-back checks" : job.state === "READY" ? "Done: the package passed every check and was published" : "Stopped before it started: the customer withdrew the approval"}</dd>
          </div>
          <div>
            <dt>Approved plan</dt>
            <dd>Version {job.version}, as the customer approved it</dd>
          </div>
          <div>
            <dt>Resources</dt>
            <dd>4 vCPU, 16 GB, at most 2 hours</dd>
          </div>
          <div>
            <dt>Lease</dt>
            <dd>{!running ? "Released" : stalled ? "Last renewed 14:41 UTC; expired 14:43 UTC" : "Renewed 12 seconds ago; expires 14:44 UTC"}</dd>
          </div>
          <div>
            <dt>Incident</dt>
            <dd>{running && stalled ? "Opened automatically: S3, this job only" : "None"}</dd>
          </div>
        </dl>
        {!running ? null : stalled ? (
          <div className="kauro-approve">
            <p>The worker stopped renewing its lease. The job&apos;s output is not published, and nothing is charged twice. One recovery may be prepared: a second attempt under the same authorisation, from the sealed files.</p>
            <div className="kauro-actions">
              <Button variant="primary">Prepare a second attempt</Button>
              <Button>Prepare a cancellation</Button>
            </div>
          </div>
        ) : (
          <div className="kauro-actions">
            <Button>Prepare a cancellation</Button>
          </div>
        )}
        <p className="kauro-muted">There is no way to set a state by hand. Every recovery acts under the customer&apos;s one authorisation for this job.</p>
      </section>
    </>
  );
}

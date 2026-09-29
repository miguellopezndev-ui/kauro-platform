// CMD037 CancelJob through its route (package B08, mandate B08-COMMANDS-EXECUTION; docs/design/B08-audit-approval-jobs.md §5, §6, §7, §12;
// docs/design/B08-case-map.md CMD037-OK, CMD037-DENY, CMD037-RACE, S062): an OPERATOR of the agency asks for a live job to be cancelled at the
// version it read — one cancel_command under the job row lock, cancel version + 1, one processing_job.cancel_requested.v1 event to
// EXECUTION_CONTROL, which reconciles the provider and completes the cancellation (the control plane's steps are written through the product's
// adapters, execution-support.ts). The publication and CancelJob order on the job row: whichever commits first wins, never both.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { endJob, publishJob, waitForLockWait } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import {
  JOB_ROW_LOCK,
  cancel,
  endLiveJobs,
  footprint,
  heldPublication,
  jobEvents,
  jobRow,
  queuedThroughRoute,
  runningJob,
  verifyingJob,
  type JobView,
} from "./execution-support.js";
import { SimulatedCrash, asProblem, completed, freshKey, outcome, replayTextOf, waitForApiLockWait } from "./support.js";
import { reachedHold } from "./writers.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"] });
});
after(async () => {
  await pw.stop();
});
// every live job is ended by the control plane after each case: the platform's slots and the agency's bound are free again
afterEach(async () => {
  await endLiveJobs(pw);
});

const REASON = "The client asked to hold the migration";
const CONTROL_APPLICATION = "kauro-test-control";

/** The job's row as the oracle reads it, reduced to what a refused or crashed cancellation must leave alone. */
async function untouched(jobId: string): Promise<readonly [string, string, string, string | null]> {
  const row = await jobRow(pw, jobId);
  return [row.state, row.version, row.cancel_version, row.cancel_reason_code];
}

test("OK: CancelJob on a RUNNING job answers 200 with the job CANCEL_REQUESTED, its cancellation version advanced, the live attempt's provider state and no published package identified, and one processing_job.cancel_requested.v1 event to EXECUTION_CONTROL", async () => {
  const { w } = pw;
  const { jobId, sale } = await runningJob(pw, "cmd037-ok");
  const queued = await jobRow(pw, jobId);
  assert.deepEqual([queued.state, queued.holds, queued.attempt_count, queued.cancel_version], ["RUNNING", "ACTIVE", 1, "0"]);

  const key = freshKey("cmd037-ok");
  const reply = await cancel(pw, jobId, { expectedVersion: Number(queued.version), reasonCode: REASON }, { key });
  const done = completed<JobView>(reply, 200);
  const view = done.data;
  assert.equal(done.version, Number(queued.version) + 1);
  assert.equal(done.replayed, false);
  // the job as the cancellation left it: CANCEL_REQUESTED, its cancellation version advanced, the live attempt's provider state (from the
  // job row: the running provider job), no package published, the provider's identity and the fence nowhere
  assert.deepEqual([view.jobId, view.projectId, view.authorizationId], [jobId, sale.projectId, sale.authorizationId]);
  assert.deepEqual([view.state, view.version, view.attempt, view.cancelVersion], ["CANCEL_REQUESTED", Number(queued.version) + 1, 1, 1]);
  assert.equal(view.activeProviderState, "RUNNING");
  assert.equal(view.publishedPackageId, undefined);
  assert.equal(typeof view.cancelRequestedAt, "string");
  assert.deepEqual(view.permittedActions, [], "a job whose cancellation is requested offers no second cancellation");
  const cancelled = await jobRow(pw, jobId);
  assert.deepEqual([cancelled.state, cancelled.version, cancelled.holds, cancelled.cancel_version, cancelled.cancel_actor_kind, cancelled.cancel_actor_id], ["CANCEL_REQUESTED", String(Number(queued.version) + 1), "ACTIVE", "1", "USER", w.operator.userId]);
  assert.equal(cancelled.cancel_reason_code, REASON, "the reason label is the row's alone");
  assert.equal(cancelled.published_package_id, null);
  assert.ok(cancelled.cancel_requested_at instanceof Date, "the request is stamped");

  // one event at the job's new version, routed to EXECUTION_CONTROL only; the reason label is in no payload
  const events = await jobEvents(pw, jobId);
  const cancellation = events.filter((e) => e.type === "processing_job.cancel_requested.v1");
  assert.deepEqual(cancellation.map((e) => [e.version, e.consumers]), [[Number(queued.version) + 1, ["EXECUTION_CONTROL"]]]);
  assert.deepEqual(cancellation[0]?.payload, { jobId, agencyId: w.A.agencyId, cancelVersion: 1, previousState: "RUNNING", actorKind: "USER", state: "CANCEL_REQUESTED" });
  assert.equal(JSON.stringify(events).includes(REASON), false);
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 200, "processing_job", jobId]);
  // the platform's slot is still held: releasing it is EXECUTION_CONTROL's, once the provider job is reconciled (D8-CANCEL-1)
  assert.equal(cancelled.holds, "ACTIVE");

  // a further cancellation at the version the answer named finds the cancellation already requested: the job as it is, nothing written
  const settled = await footprint(pw);
  const again = completed<JobView>(await cancel(pw, jobId, { expectedVersion: view.version, reasonCode: "Another reason" }), 200);
  assert.deepEqual([again.data.state, again.data.version, again.data.cancelVersion], ["CANCEL_REQUESTED", view.version, 1]);
  assert.deepEqual({ ...(await footprint(pw)), command_journal: 0 }, { ...settled, command_journal: 0 });
  assert.equal((await jobRow(pw, jobId)).cancel_reason_code, REASON);
  assert.equal((await jobEvents(pw, jobId)).filter((e) => e.type === "processing_job.cancel_requested.v1").length, 1);
});

test("DENY: a VIEWER is 403, another agency's job 404, a stale version 409 STALE_VERSION, a CANCELLED or FAILED job 409 JOB_TERMINAL, and a READY job 409 JOB_ALREADY_READY naming its package with no promise of CRM rollback; nothing is written", async () => {
  const { w } = pw;
  const { jobId } = await queuedThroughRoute(pw, "cmd037-deny-live");
  const live = await jobRow(pw, jobId);
  // a refusal writes nothing: no event, outbox record, journal entry or ledger movement, and the job is as it was
  const refused = async (what: string, target: string, body: { readonly expectedVersion: number; readonly reasonCode: string }, options: Parameters<typeof cancel>[3], expected: string): Promise<Awaited<ReturnType<typeof cancel>>> => {
    const state = await untouched(target);
    const written = await footprint(pw);
    const reply = await cancel(pw, target, body, options);
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(pw), written, `${what}: nothing written`);
    assert.deepEqual(await untouched(target), state, `${what}: the job is untouched`);
    return reply;
  };

  // roles: a VIEWER (and an APPROVER, and a BILLING member) is not an operator; the denial is a durable fact of the agency's stream
  const denied = (await w.securityEvents("CMD037")).length;
  await refused("viewer", jobId, { expectedVersion: Number(live.version), reasonCode: REASON }, { token: w.viewer.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("approver", jobId, { expectedVersion: Number(live.version), reasonCode: REASON }, { token: w.approver.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD037")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId, f.actorId]), [
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.approver.userId],
  ]);
  // another agency's job is 404, the answer of a job that never existed
  const foreign = await refused("foreign job", jobId, { expectedVersion: Number(live.version), reasonCode: REASON }, { token: w.stranger.token, agency: w.B.agencyId }, "404 NOT_FOUND -");
  const unknown = await cancel(pw, "00000000-0000-4000-8000-000000000000", { expectedVersion: 1, reasonCode: REASON }, { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent job answer alike");

  // a stale version: the job moved since the caller read it; the answer names where it is
  const stale = await refused("stale version", jobId, { expectedVersion: Number(live.version) + 5, reasonCode: REASON }, {}, "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: Number(live.version), state: "QUEUED" });

  // a CANCELLED job (cancelled through the route and ended by the control plane) and a FAILED one (a running job its attempt lost): terminal
  const cancelled = await queuedThroughRoute(pw, "cmd037-deny-cancelled");
  const cancelledLive = await jobRow(pw, cancelled.jobId);
  assert.equal((await cancel(pw, cancelled.jobId, { expectedVersion: Number(cancelledLive.version), reasonCode: REASON })).status, 200);
  await endJob(w.h, w.A, cancelled.jobId);
  const cancelledRow = await jobRow(pw, cancelled.jobId);
  assert.equal(cancelledRow.state, "CANCELLED");
  const cancelledReply = await refused("a CANCELLED job", cancelled.jobId, { expectedVersion: Number(cancelledRow.version), reasonCode: REASON }, {}, "409 PRECONDITION_FAILED JOB_TERMINAL");
  assert.deepEqual(asProblem(w, cancelledReply).current, { version: Number(cancelledRow.version), state: "CANCELLED" });

  const failed = await runningJob(pw, "cmd037-deny-failed");
  await endJob(w.h, w.A, failed.jobId);
  const failedRow = await jobRow(pw, failed.jobId);
  assert.equal(failedRow.state, "FAILED");
  const failedReply = await refused("a FAILED job", failed.jobId, { expectedVersion: Number(failedRow.version), reasonCode: REASON }, {}, "409 PRECONDITION_FAILED JOB_TERMINAL");
  assert.deepEqual(asProblem(w, failedReply).current, { version: Number(failedRow.version), state: "FAILED" });

  // a READY job: delivered, so no longer cancellable; the answer names its package and promises no rollback of the CRM
  const ready = await verifyingJob(pw, "cmd037-deny-ready");
  const published = await publishJob(w.h, w.A, ready.jobId);
  assert.equal(published.kind, "PUBLISHED");
  const readyRow = await jobRow(pw, ready.jobId);
  assert.equal(readyRow.state, "READY");
  assert.equal(readyRow.published_package_id, ready.packageId);
  const readyReply = await refused("a READY job", ready.jobId, { expectedVersion: Number(readyRow.version), reasonCode: REASON }, {}, "409 PRECONDITION_FAILED JOB_ALREADY_READY");
  const readyProblem = asProblem(w, readyReply);
  assert.deepEqual(readyProblem.current, { version: Number(readyRow.version), state: "READY", successorId: ready.packageId });
  assert.equal(/roll ?back|revert|undo|restor/i.test(readyReply.text), false, "no promise of a rollback");
  assert.deepEqual(readyProblem.nextActions, [], "a delivered package is not a thing a retry changes");
});

test("RACE: an identical retry replays the 200, the same key with another reason is 409 IDEMPOTENCY_CONFLICT, two CancelJob calls on one version yield one cancellation and one 409 STALE_VERSION, and a crash before COMMIT leaves the job running", async () => {
  const { w } = pw;
  const { jobId } = await runningJob(pw, "cmd037-race");
  const initial = await jobRow(pw, jobId);
  const key = freshKey("cmd037-race");
  const body = { expectedVersion: Number(initial.version), reasonCode: REASON };

  // an identical retry replays the journaled 200, byte for byte, and cancels nothing again
  const first = await cancel(pw, jobId, body, { key });
  completed<JobView>(first, 200);
  const replay = await cancel(pw, jobId, body, { key });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(first));
  // the same key with another reason is another request: a typed conflict with no effect
  const settled = await footprint(pw);
  const conflicting = await cancel(pw, jobId, { ...body, reasonCode: "Another reason" }, { key });
  assert.equal(outcome(w, conflicting), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(pw), settled);
  assert.equal((await jobRow(pw, jobId)).cancel_reason_code, REASON);
  assert.equal((await jobEvents(pw, jobId)).filter((e) => e.type === "processing_job.cancel_requested.v1").length, 1);

  // two CancelJob calls on one version: the first held before its journal commit with the job row locked; the second is observed waiting on
  // that row (FOR UPDATE), then finds the cancellation committed and answers the version it read as stale — one cancellation, one 409
  await endLiveJobs(pw); // the control plane completes the cancellation: the platform slot the first job held is free again
  const racing = await runningJob(pw, "cmd037-race-two");
  const racingRow = await jobRow(pw, racing.jobId);
  const racingBody = { expectedVersion: Number(racingRow.version), reasonCode: REASON };
  const hold = w.holds.arm("journal.commit");
  const winner = cancel(pw, racing.jobId, racingBody);
  let loser: ReturnType<typeof cancel> | undefined;
  try {
    await reachedHold(hold, winner);
    loser = cancel(pw, racing.jobId, racingBody);
    await waitForApiLockWait(w, JOB_ROW_LOCK);
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser as ReturnType<typeof cancel>]);
  assert.equal(completed<JobView>(won, 200).data.state, "CANCEL_REQUESTED");
  assert.equal(outcome(w, lost), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, lost).current, { version: Number(racingRow.version) + 1, state: "CANCEL_REQUESTED" });
  const cancelled = (await jobEvents(pw, racing.jobId)).filter((e) => e.type === "processing_job.cancel_requested.v1");
  assert.equal(cancelled.length, 1, "one cancellation");
  assert.equal((await jobRow(pw, racing.jobId)).cancel_version, "1");

  // a crash before COMMIT leaves the job running: the cancel_command and its event were written and never committed; the same key then cancels once
  await endLiveJobs(pw);
  const crashing = await runningJob(pw, "cmd037-race-crash");
  const crashingRow = await jobRow(pw, crashing.jobId);
  const crashKey = freshKey("cmd037-race-crash");
  const beforeCrash = await footprint(pw);
  const stateBefore = await untouched(crashing.jobId);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await cancel(pw, crashing.jobId, { expectedVersion: Number(crashingRow.version), reasonCode: REASON }, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(pw), beforeCrash, "nothing left behind");
  assert.deepEqual(await untouched(crashing.jobId), stateBefore);
  assert.equal((await jobRow(pw, crashing.jobId)).state, "RUNNING", "the job is still running");
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<JobView>(await cancel(pw, crashing.jobId, { expectedVersion: Number(crashingRow.version), reasonCode: REASON }, { key: crashKey }), 200);
  assert.equal(retried.data.state, "CANCEL_REQUESTED");
  assert.equal((await jobEvents(pw, crashing.jobId)).filter((e) => e.type === "processing_job.cancel_requested.v1").length, 1);
});

test("RACE (S062): CancelJob through the route racing the publication — whichever commits first wins, observed by the lock wait, never both; after a publication the job is READY and CancelJob is 409 JOB_ALREADY_READY naming the package", async () => {
  const { w } = pw;

  // interleaving 1: the publication holds the job row (its edges written, not committed); CancelJob through the route is observed waiting on
  // that row, and when the publication commits it finds the job READY — 409 JOB_ALREADY_READY naming the package, nothing cancelled
  const one = await verifyingJob(pw, "s062-publication-first");
  const oneRow = await jobRow(pw, one.jobId);
  assert.equal(oneRow.state, "VERIFYING");
  const publishing = heldPublication(pw, one.jobId);
  await publishing.written;
  const late = cancel(pw, one.jobId, { expectedVersion: Number(oneRow.version), reasonCode: REASON });
  try {
    await waitForApiLockWait(w, JOB_ROW_LOCK);
  } finally {
    publishing.release();
  }
  assert.equal((await publishing.outcome).kind, "PUBLISHED");
  const lateReply = await late;
  assert.equal(outcome(w, lateReply), "409 PRECONDITION_FAILED JOB_ALREADY_READY");
  assert.deepEqual(asProblem(w, lateReply).current, { version: Number(oneRow.version) + 1, state: "READY", successorId: one.packageId });
  const readyRow = await jobRow(pw, one.jobId);
  assert.deepEqual([readyRow.state, readyRow.cancel_version, readyRow.published_package_id], ["READY", "0", one.packageId]);
  assert.deepEqual((await jobEvents(pw, one.jobId)).map((e) => e.type).filter((t) => t === "processing_job.cancel_requested.v1" || t === "processing_job.ready.v1"), ["processing_job.ready.v1"]);
  assert.equal((await pw.w.row<{ state: string }>("package_versions", "package_version_id = $1", [one.packageId]))?.state, "AVAILABLE");

  // after the publication the job is READY, and every CancelJob names the package: the same answer at the version it committed
  const later = await cancel(pw, one.jobId, { expectedVersion: Number(readyRow.version), reasonCode: REASON });
  assert.equal(outcome(w, later), "409 PRECONDITION_FAILED JOB_ALREADY_READY");
  assert.equal(asProblem(w, later).current?.successorId, one.packageId);

  // interleaving 2: CancelJob holds the job row (cancel_command written, its journal not committed); the publication is observed waiting on
  // that row, and when the cancellation commits it is refused — the package stays private, the job CANCEL_REQUESTED, the authorization not delivered
  const two = await verifyingJob(pw, "s062-cancel-first");
  const twoRow = await jobRow(pw, two.jobId);
  const hold = w.holds.arm("journal.commit");
  const cancelling = cancel(pw, two.jobId, { expectedVersion: Number(twoRow.version), reasonCode: REASON });
  let publication: ReturnType<typeof heldPublication> | undefined;
  try {
    await reachedHold(hold, cancelling);
    publication = heldPublication(pw, two.jobId);
    publication.release();
    await waitForLockWait(w.h.oracle, CONTROL_APPLICATION, JOB_ROW_LOCK);
  } finally {
    hold.release();
  }
  const cancelledReply = await cancelling;
  assert.equal(completed<JobView>(cancelledReply, 200).data.state, "CANCEL_REQUESTED");
  const refusal = await (publication as ReturnType<typeof heldPublication>).outcome;
  assert.deepEqual([refusal.kind, refusal.kind === "REFUSED" ? refusal.reason : null], ["REFUSED", "JOB_CANCELLED"], "a publication behind a committed cancellation is refused");
  const cancelledRow = await jobRow(pw, two.jobId);
  assert.deepEqual([cancelledRow.state, cancelledRow.cancel_version, cancelledRow.published_package_id], ["CANCEL_REQUESTED", "1", null]);
  assert.equal((await pw.w.row<{ state: string }>("package_versions", "package_version_id = $1", [two.packageId]))?.state, "VERIFIED_PRIVATE", "its package stays private");
  assert.equal((await pw.w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [cancelledRow.authorization_id]))?.state, "CONSUMED", "never DELIVERED");
  // never both: of the two jobs exactly one has a publication and only the other a cancellation
  const both = await Promise.all([jobEvents(pw, one.jobId), jobEvents(pw, two.jobId)]);
  assert.deepEqual(
    both.map((events) => events.map((e) => e.type).filter((t) => t === "processing_job.cancel_requested.v1" || t === "processing_job.ready.v1")),
    [["processing_job.ready.v1"], ["processing_job.cancel_requested.v1"]],
  );
});

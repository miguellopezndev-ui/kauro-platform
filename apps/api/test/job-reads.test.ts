// GetJob through its route (package B08, mandate B08-COMMANDS-EXECUTION; docs/design/B08-audit-approval-jobs.md §5, §12 D8-API-1, Q8-8;
// docs/design/B08-case-map.md GetJob): every live member of the agency reads a job's safe progress — its state, attempt ordinal,
// deadlines, cancellation version and, once READY, its package id — and nothing of the provider, the object store or the fence. The job is
// moved through its life by the control plane's steps written through the product's adapters (execution-support.ts); the reads are
// the real GET route.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { admitJob, endJob, launchJob, publishJob, stageJob, verifyJob } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { cancel, endLiveJobs, executionRoutes, forbiddenTokensOf, getJob, jobRow, queuedThroughRoute, runningJob, viewOf, type JobView } from "./execution-support.js";
import { asProblem, call, outcome } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"] });
});
after(async () => {
  await pw.stop();
});
afterEach(async () => {
  await endLiveJobs(pw);
});

/** Every member the JobView may carry (design §12): the rest of the registry Job contract is withheld with a reason. */
const JOB_VIEW_MEMBERS: ReadonlyArray<string> = [
  "jobId",
  "projectId",
  "authorizationId",
  "state",
  "attempt",
  "version",
  "queuedAt",
  "deliveryDeadlineAt",
  "executionDeadlineAt",
  "cancelVersion",
  "cancelRequestedAt",
  "activeProviderState",
  "publishedPackageId",
  "permittedActions",
];

/** Reads the job as a member and checks it against the row the control plane's steps left: what the customer sees is the row's safe part. */
async function seen(jobId: string, expected: { readonly state: string; readonly attempt: number; readonly activeProviderState?: string; readonly publishedPackageId?: string; readonly cancelVersion?: number }, token: string = pw.w.viewer.token): Promise<JobView> {
  const row = await jobRow(pw, jobId);
  const reply = await getJob(pw, jobId, token);
  const view = viewOf(reply);
  assert.deepEqual([view.jobId, view.projectId, view.authorizationId], [row.job_id, row.project_id, row.authorization_id]);
  assert.deepEqual([view.state, view.attempt, view.version, view.cancelVersion], [expected.state, expected.attempt, Number(row.version), expected.cancelVersion ?? 0]);
  assert.equal(row.state, expected.state, "the row is where the step left it");
  assert.equal(Date.parse(view.queuedAt), row.queued_at.getTime());
  assert.equal(Date.parse(view.deliveryDeadlineAt), row.delivery_deadline_at.getTime());
  assert.equal(view.executionDeadlineAt === undefined ? null : Date.parse(view.executionDeadlineAt), row.execution_deadline_at === null ? null : row.execution_deadline_at.getTime());
  assert.equal(view.cancelRequestedAt === undefined ? null : Date.parse(view.cancelRequestedAt), row.cancel_requested_at === null ? null : row.cancel_requested_at.getTime());
  assert.equal(view.activeProviderState, expected.activeProviderState);
  assert.equal(view.publishedPackageId, expected.publishedPackageId);
  // never a provider identity, an object name, the fence or the lease: no member outside the view, no token of the row's private part in the text
  assert.deepEqual(Object.keys(view).filter((k) => !JOB_VIEW_MEMBERS.includes(k)), [], "only the view's members");
  for (const token of await forbiddenTokensOf(pw, jobId)) assert.equal(reply.text.includes(token), false, `the view leaks ${token}`);
  return view;
}

test("GetJob answers the job's state, attempt ordinal, deadlines, cancellation version and, once READY, its package id to live members of the agency only, never a provider identity, an object name or another agency's job", async () => {
  const { w } = pw;

  // QUEUED: attempt zero, the delivery deadline the capture set (D8-RET-1), no execution deadline, no provider state, no package
  const { jobId, sale } = await queuedThroughRoute(pw, "get-job");
  const queued = await seen(jobId, { state: "QUEUED", attempt: 0 });
  assert.equal(queued.version, 1);
  assert.equal(queued.executionDeadlineAt, undefined);
  assert.equal(queued.projectId, sale.projectId);
  assert.deepEqual(queued.permittedActions, [], "a VIEWER reads and offers nothing");
  // the permitted actions are the reader's own (informative, never authority): an operating role may cancel a live job
  for (const person of [w.owner, w.admin, w.operator]) assert.deepEqual((await seen(jobId, { state: "QUEUED", attempt: 0 }, person.token)).permittedActions, ["CancelJob"]);
  for (const person of [w.approver, w.approver2, w.billing]) assert.deepEqual((await seen(jobId, { state: "QUEUED", attempt: 0 }, person.token)).permittedActions, []);

  // ADMITTED: attempt one with the execution deadline; the provider not yet launched
  await admitJob(w.h, w.A, jobId);
  const admitted = await seen(jobId, { state: "ADMITTED", attempt: 1, activeProviderState: "LAUNCHING" });
  assert.equal(typeof admitted.executionDeadlineAt, "string");

  // RUNNING: the provider job runs; VERIFYING: it finished and its output is being verified — no package is named before the publication
  await launchJob(w.h, w.A, jobId);
  await seen(jobId, { state: "RUNNING", attempt: 1, activeProviderState: "RUNNING" });
  await stageJob(w.h, w.A, jobId);
  await seen(jobId, { state: "VERIFYING", attempt: 1, activeProviderState: "FINISHED" });
  const verified = await verifyJob(w.h, w.A, jobId);
  await seen(jobId, { state: "VERIFYING", attempt: 1, activeProviderState: "FINISHED" });

  // READY: the package id, and only that (Q8-8) — the job no longer offers a cancellation
  const published = await publishJob(w.h, w.A, jobId);
  assert.equal(published.kind, "PUBLISHED");
  const ready = await seen(jobId, { state: "READY", attempt: 1, publishedPackageId: verified.packageVersionId }, w.operator.token);
  assert.deepEqual(ready.permittedActions, []);

  // CANCEL_REQUESTED: the cancellation version and its instant, the provider state of the live attempt until the control plane reconciles it
  const cancelling = await runningJob(pw, "get-job-cancelling");
  const requested = await cancel(pw, cancelling.jobId, { expectedVersion: Number((await jobRow(pw, cancelling.jobId)).version), reasonCode: "The client asked to hold the migration" });
  assert.equal(requested.status, 200);
  const cancelRequested = await seen(cancelling.jobId, { state: "CANCEL_REQUESTED", attempt: 1, activeProviderState: "RUNNING", cancelVersion: 1 }, w.operator.token);
  assert.equal(typeof cancelRequested.cancelRequestedAt, "string");
  assert.deepEqual(cancelRequested.permittedActions, []);
  // CANCELLED and FAILED: terminal, nothing live to report, no package
  await endJob(w.h, w.A, cancelling.jobId);
  await seen(cancelling.jobId, { state: "CANCELLED", attempt: 1, cancelVersion: 1 });
  const failing = await runningJob(pw, "get-job-failing");
  await endJob(w.h, w.A, failing.jobId);
  await seen(failing.jobId, { state: "FAILED", attempt: 1 });

  // the job of another agency is not this agency's to read: 404, the answer of a job that never existed; a stranger to the agency is no member
  const unknown = "0190c7a2-0000-7000-8000-0000000000bb";
  const foreign = await getJob(pw, jobId, w.stranger.token, w.B.agencyId);
  const missing = await getJob(pw, unknown, w.stranger.token, w.B.agencyId);
  assert.equal(outcome(w, foreign), "404 NOT_FOUND -");
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, missing), correlationId: "" }, "a foreign and a nonexistent job answer alike");
  assert.equal(outcome(w, await getJob(pw, unknown)), "404 NOT_FOUND -");
  const denied = (await w.securityEvents("GET_JOB")).length;
  assert.equal(outcome(w, await getJob(pw, jobId, w.stranger.token)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.deepEqual((await w.securityEvents("GET_JOB")).slice(denied).map((f) => [f.outcome, f.reason, f.actorId]), [["DENY", "NOT_A_MEMBER", w.stranger.userId]]);
  // only live members: a suspended member and an invitation never accepted read nothing, and an unauthenticated caller is refused
  assert.equal(outcome(w, await getJob(pw, jobId, w.suspended.token)), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.equal(outcome(w, await getJob(pw, jobId, w.invited.token)), "403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE");
  const anonymous = await call(w, { method: "GET", url: executionRoutes.getJob(jobId), token: null, key: null, contentType: null });
  assert.equal(outcome(w, anonymous), "401 AUTHENTICATION_REQUIRED -");
});

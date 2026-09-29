// STORAGE_LIFECYCLE, UPLOAD_DEADLINES, PROVIDER_SESSION_RECONCILIATION and OBJECT_INVENTORY (docs/design/B07-upload-source-lifecycle.md
// §12.3, §12.5; mandate B07-CONTROL; cases R2-051 and CMD015-OK of docs/design/B07-case-map.md) on a real PostgreSQL 17, through the
// package's dispatcher and sweepers (kauro_control_test, SYSTEM units of work bound to each item's agency). The providers are the
// labelled contract fakes of @kauro/application/testing — CONTRACT FAKES, evidence class SIMULATED: object storage (its resumable
// sessions live until a provider horizon unless a cancellation takes effect; its provider clock pinned by the test to the instants the
// fixtures stand at) and the session vault. Uploads that must be older than their application deadline are reserved in the past on
// the labelled TEST CLOCK of their own transactions; the sweepers run on the real server clock. Interleavings are fixed by the storage
// fake's hold points, never by time. The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ScriptedCancellation } from "@kauro/application/testing";
import { isDomainFailure, textDigest, type CausationId, type CorrelationId, type UploadId } from "@kauro/domain";
import { clock, ids, startControlEnv, type ControlEnv } from "./support/env.js";
import { asRequestHandler, cancel, eventsOf, issue, oracle, oracleRows, project, reserve, setSessionLimit, tenant, uploadAndReport, uploadThrough, type Upload } from "./support/fixtures.js";
import { buildCsv } from "./support/workbook.js";

let env: ControlEnv;

/** Twenty-five hours: the provider lifetime of this file's sessions — longer than the platform's 24 h, as a real provider's is. */
const SESSION_LIFETIME_SECONDS = 90_000;
const HOUR_MS = 3_600_000;
const RETENTION_SECONDS = 604_800;

before(async () => {
  env = await startControlEnv({ sessionLifetimeSeconds: SESSION_LIFETIME_SECONDS });
  await env.plane.sweepers.locationPolicy.sweep(env.plane.units, 10);
});

after(async () => {
  await env.stop();
});

function csv(label: string): Uint8Array {
  return buildCsv(["Email", "Name"], [[`${label}@example.test`, label]]);
}

async function uploadRow(uploadId: string): Promise<{ state: string; provider_cancellation_state: string; provider_cancellation_at: Date | null; expired_at: Date | null; application_expires_at: Date; terminal_reason: string | null; secrets: string }> {
  return oracle(
    env,
    `SELECT state, provider_cancellation_state, provider_cancellation_at, expired_at, application_expires_at, terminal_reason,
            (SELECT count(*) FROM kauro.upload_session_secrets s WHERE s.upload_id = u.upload_id)::text AS secrets
       FROM kauro.upload_sessions u WHERE upload_id = $1`,
    [uploadId],
  );
}

/**
 * Dispatches the due STORAGE_LIFECYCLE records one at a time; when a record reaches the provider cancellation (a hold point of the
 * storage fake), the answer scripted for that session — recognised by its digest in the fake's call log, never by the bearer
 * reference — is queued before the call proceeds.
 */
async function dispatchStorageLifecycle(answers: ReadonlyMap<string, ScriptedCancellation>): Promise<void> {
  let hold = env.storage.holdNext("cancelResumableSession");
  try {
    for (let round = 0; round < 50; round++) {
      const batch = env.plane.dispatcher.dispatchBatch(env.plane.consumers.storageLifecycle, 1, clock.now());
      const first = await Promise.race([hold.reached.then(() => "HELD" as const), batch.then(() => "SETTLED" as const)]);
      if (first === "HELD") {
        const digest = String(env.storage.calls("cancelResumableSession").at(-1)?.request["sessionDigest"]);
        const answer = answers.get(digest);
        if (answer !== undefined) env.storage.scriptCancellation(answer);
        hold.release();
        hold = env.storage.holdNext("cancelResumableSession");
      }
      const counts = await batch;
      assert.deepEqual([counts.retried, counts.deadLettered], [0, 0]);
      if (counts.delivered === 0) return;
    }
    throw new Error("STORAGE_LIFECYCLE did not drain");
  } finally {
    // the hold armed for a call that never came lets any later call through
    hold.release();
  }
}

test("R2-051: the deadline sweeper expires a reservation at 24 h on the server clock while the fake provider session stays usable; the provider cancellation is requested and recorded (CONFIRMED, UNSUPPORTED, UNCERTAIN reconciled to the horizon); a late completion through the session is registered RESIDUAL and deleted by generation; the requester's late completion report through the source store is refused and nothing of it is admitted", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "r2-051");
  await setSessionLimit(env, t, 10);
  const p = await project(env, t);
  const now = Date.now();
  // initiated more than twenty-four hours ago on the test clock (the provider's clock pinned to the same instants)
  const pastHorizon = new Date(now - 25 * HOUR_MS - 10 * 60_000);
  const pastDeadline = new Date(now - 24 * HOUR_MS - 5 * 60_000);
  const young = new Date(now - 23 * HOUR_MS);
  const sessions = new Map<string, { readonly up: Upload; readonly ref: string }>();
  for (const [label, at] of [["dead", pastHorizon], ["confirmed", pastDeadline], ["unsupported", pastDeadline], ["uncertain", pastDeadline], ["young", young]] as const) {
    const up = await reserve(env, t, p, csv(label).length, "CSV", at);
    sessions.set(label, { up, ref: await issue(env, t, up, at) });
  }
  const s = (label: string): { readonly up: Upload; readonly ref: string } => {
    const found = sessions.get(label);
    if (found === undefined) throw new Error(label);
    return found;
  };

  // UPLOAD_DEADLINES on the server clock: every live reservation past its deadline expires, the young one does not (never early)
  const swept = await env.plane.sweepers.uploadDeadlines.sweep(env.plane.units, 100);
  assert.deepEqual(swept.failed, []);
  for (const label of ["dead", "confirmed", "unsupported", "uncertain"]) {
    const u = await uploadRow(s(label).up.uploadId);
    assert.deepEqual([u.state, u.terminal_reason, u.provider_cancellation_state], ["EXPIRED", "RESERVATION_EXPIRED", "REQUESTED"], label);
    assert.ok(u.expired_at !== null && u.expired_at.getTime() >= u.application_expires_at.getTime(), `${label}: expired at or after its deadline, never early`);
    assert.equal(u.provider_cancellation_at?.getTime(), u.expired_at.getTime(), `${label}: the cancellation requested with the expiry, at its instant`);
    const anchor = await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.retention_anchors WHERE upload_id = $1 AND anchor_kind = 'INTAKE_EXPIRED'", [s(label).up.uploadId]);
    assert.equal(anchor.n, "1", `${label}: the INTAKE_EXPIRED anchor`);
    const expired = (await eventsOf(env, s(label).up.uploadId)).at(-1);
    assert.deepEqual([expired?.event_type, expired?.actor_kind, expired?.actor_id], ["upload_session.expired.v1", "SERVICE", "upload-deadlines"]);
  }
  assert.equal((await uploadRow(s("young").up.uploadId)).state, "UPLOADING", "a reservation inside its window is left alone");
  assert.deepEqual(
    await oracle(env, "SELECT reserved_bytes::text, file_count FROM kauro.revision_quota WHERE revision_id = $1", [p.revisionId]),
    { reserved_bytes: String(s("young").up.declaredBytes), file_count: 1 },
    "the quota of the expired reservations is released once",
  );
  // the application tombstoned acceptance, but the provider session outlives it: still usable until the provider horizon
  for (const label of ["confirmed", "unsupported", "uncertain"]) assert.equal(env.storage.sessionView(s(label).ref)?.usable, true, `${label}: the provider session outlives the reservation`);

  // STORAGE_LIFECYCLE: the provider cancellation carried out with the vault-opened reference and its answer recorded
  await dispatchStorageLifecycle(
    new Map<string, ScriptedCancellation>([
      [textDigest(s("confirmed").ref), "CONFIRMED"],
      [textDigest(s("unsupported").ref), "UNSUPPORTED"],
      [textDigest(s("uncertain").ref), { answer: "UNCERTAIN", sessionCancelled: false }],
    ]),
  );
  const answered = { confirmed: "CONFIRMED", unsupported: "UNSUPPORTED", uncertain: "UNCERTAIN" } as const;
  for (const [label, answer] of Object.entries(answered)) {
    const u = await uploadRow(s(label).up.uploadId);
    assert.equal(u.provider_cancellation_state, answer, `${label}: the provider's answer is recorded, never assumed`);
    assert.equal(u.secrets, answer === "UNCERTAIN" ? "1" : "0", `${label}: the bearer record is purged once the cancellation resolved`);
    const recorded = (await eventsOf(env, s(label).up.uploadId)).at(-1);
    assert.deepEqual([recorded?.event_type, recorded?.actor_kind, recorded?.actor_id], ["upload_session.provider_cancellation_recorded.v1", "SERVICE", "storage-lifecycle"]);
  }
  assert.equal(env.storage.sessionView(s("confirmed").ref)?.usable, false, "CONFIRMED: the session was cancelled");
  assert.equal(env.storage.sessionView(s("unsupported").ref)?.usable, true, "UNSUPPORTED: the session stays usable until its horizon");
  assert.equal(env.storage.sessionView(s("uncertain").ref)?.usable, true, "UNCERTAIN: the cancellation did not take effect");
  // past its provider horizon a session is dead: nothing to cancel, its bearer record purged, no answer invented
  const dead = await uploadRow(s("dead").up.uploadId);
  assert.deepEqual([dead.provider_cancellation_state, dead.secrets], ["REQUESTED", "0"]);
  assert.equal(env.storage.calls("cancelResumableSession").filter((c) => c.request["sessionDigest"] === textDigest(s("dead").ref)).length, 0);
  assert.ok(env.storage.calls().every((c) => !Object.values(c.request).some((v) => typeof v === "string" && v.includes(s("confirmed").ref))), "no provider call carries a bearer reference");

  // PROVIDER_SESSION_RECONCILIATION: the UNCERTAIN cancellation is attempted again until it resolves; past the horizon nothing is found
  env.storage.scriptCancellation({ answer: "UNCERTAIN", sessionCancelled: false });
  const first = await env.plane.sweepers.providerSessionReconciliation.sweep(env.plane.units, 100);
  assert.deepEqual([first.examined, first.acted, first.failed], [1, 0, []], "found while its horizon is ahead; an UNCERTAIN answer to UNCERTAIN records nothing");
  assert.equal((await uploadRow(s("uncertain").up.uploadId)).provider_cancellation_state, "UNCERTAIN");
  env.storage.scriptCancellation("CONFIRMED");
  const second = await env.plane.sweepers.providerSessionReconciliation.sweep(env.plane.units, 100);
  assert.deepEqual([second.examined, second.acted], [1, 1]);
  const reconciled = await uploadRow(s("uncertain").up.uploadId);
  assert.deepEqual([reconciled.provider_cancellation_state, reconciled.secrets], ["CONFIRMED", "0"]);
  assert.equal(env.storage.sessionView(s("uncertain").ref)?.usable, false);
  assert.deepEqual([(await env.plane.sweepers.providerSessionReconciliation.sweep(env.plane.units, 100)).examined], [0], "nothing pending is left");

  // a late completion through the session the provider did not cancel lands in quarantine; the requester's report of it is refused
  const late = csv("unsupported");
  const written = uploadThrough(env, s("unsupported").ref, late);
  assert.equal(env.storage.uploadThroughSession(s("confirmed").ref, csv("confirmed")).outcome, "REFUSED", "a cancelled session accepts nothing");
  const claim = env.storage.parseCompletionClaim(written.completionRef);
  assert.equal(claim.kind, "CLAIM");
  await assert.rejects(
    asRequestHandler(env, t, null, async (store) => {
      const current = await store.uploads.get(s("unsupported").up.uploadId);
      if (current === null || claim.kind !== "CLAIM") throw new Error("unreachable");
      return store.uploads.transition(current.uploadId, current.version, { event: "completion_reported", claimDigest: textDigest(written.completionRef), claim: claim.claim });
    }),
    // a tombstoned upload's claim is never recorded again (IMMUTABLE_COLUMN, KA004) and EXPIRED is terminal (KA008): refused either way
    (e: unknown) => isDomainFailure(e) && ((e.code === "INTEGRITY_FAILURE" && e.reason === "IMMUTABLE_COLUMN") || (e.code === "PRECONDITION_FAILED" && e.reason === "UNLISTED_TRANSITION")),
    "the late completion report is refused on the tombstoned upload",
  );
  assert.equal((await uploadRow(s("unsupported").up.uploadId)).state, "EXPIRED");

  // OBJECT_INVENTORY: the late object is an unregistered generation — registered RESIDUAL, late, and deleted by generation
  const inventory = await env.plane.sweepers.objectInventory.sweep(env.plane.units, 100);
  assert.deepEqual(inventory.failed, []);
  const residual = await oracle<{ zone: string; data_class: string; late: boolean; state: string; deletion_result: string; generation: string; residual_matches: boolean; provider_residual_basis: string; revision_id: string; upload_id: string }>(
    env,
    `SELECT zone, data_class, late, state, deletion_result, generation, provider_residual_basis, revision_id, upload_id,
            provider_residual_until = deleted_at + make_interval(secs => ${RETENTION_SECONDS}) AS residual_matches
       FROM kauro.stored_objects WHERE upload_id = $1 AND generation = $2`,
    [s("unsupported").up.uploadId, written.generation],
  );
  assert.deepEqual(
    [residual.zone, residual.data_class, residual.late, residual.state, residual.deletion_result, residual.provider_residual_basis, residual.residual_matches, residual.revision_id],
    ["QUARANTINE", "RESIDUAL", true, "DELETED", "DELETED", "LOCATION_POLICY", true, p.revisionId],
  );
  const held = env.storage.generationsOf(env.storage.location("QUARANTINE"), s("unsupported").up.objectName).find((g) => g.generation === written.generation);
  assert.equal(held?.status, "SOFT_DELETED", "deleted at the provider by its exact generation, kept soft-deleted for the location's retention");
  // nothing of it is ever admitted: no receipt, no file, no accepted generation, the upload EXPIRED for good
  for (const table of ["inspection_receipts", "source_files"]) {
    const column = table === "source_files" ? "origin_upload_id" : "upload_id";
    assert.equal((await oracle<{ n: string }>(env, `SELECT count(*)::text AS n FROM kauro.${table} WHERE ${column} = $1`, [s("unsupported").up.uploadId])).n, "0", table);
  }
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'ACCEPTED'", [s("unsupported").up.uploadId])).n, "0");
  // every registered name of the expired uploads is closed by an absence check or a deletion (the deletion inventory, G-UPLOAD)
  const open = await oracleRows(env, "SELECT object_id FROM kauro.stored_objects WHERE upload_id = ANY($1::uuid[]) AND state <> 'DELETED'", [["dead", "confirmed", "unsupported", "uncertain"].map((l) => s(l).up.uploadId)]);
  assert.deepEqual(open, []);
});

test("OK: STORAGE_LIFECYCLE cancels the provider session, records the result, purges the secret and deletes the quarantine objects by generation", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "cmd015");
  const p = await project(env, t);
  // one upload in progress (nothing finalized yet), one whose bytes the browser finalized before the requester cancelled
  const open = await reserve(env, t, p, csv("open").length, "CSV");
  const openRef = await issue(env, t, open);
  const finalized = await reserve(env, t, p, csv("finalized").length, "CSV");
  const finalizedRef = await issue(env, t, finalized);
  const written = uploadThrough(env, finalizedRef, csv("finalized"));
  for (const up of [open, finalized]) {
    const cancelled = await cancel(env, t, up);
    assert.equal(cancelled.providerCancellationState, "REQUESTED", "the database requests the provider cancellation with the tombstone (D-ROLE-3)");
  }

  const counts = await env.plane.drain(env.plane.consumers.storageLifecycle, clock.now());
  assert.deepEqual([counts.retried, counts.deadLettered], [0, 0]);
  assert.ok(counts.delivered >= 2);

  for (const [up, ref] of [[open, openRef], [finalized, finalizedRef]] as const) {
    const u = await uploadRow(up.uploadId);
    assert.deepEqual([u.state, u.provider_cancellation_state, u.secrets], ["CANCELLED", "CONFIRMED", "0"], "the answer recorded, the bearer record purged");
    assert.ok(u.provider_cancellation_at !== null);
    const events = (await eventsOf(env, up.uploadId)).map((e) => [e.event_type, e.actor_kind]);
    assert.deepEqual(events.at(-1), ["upload_session.provider_cancellation_recorded.v1", "SERVICE"]);
    assert.ok(env.storage.sessionView(ref)?.cancellationAnswers.includes("CONFIRMED"));
  }
  assert.equal(env.storage.sessionView(openRef)?.usable, false, "the open session is cancelled at the provider");
  // the finalized object under the quarantine name: observed as a late residual and deleted by its exact generation
  const late = await oracle<{ state: string; generation: string; late: boolean; data_class: string; deletion_result: string; deletion_reason: string }>(
    env,
    "SELECT state, generation, late, data_class, deletion_result, deletion_reason FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'QUARANTINE'",
    [finalized.uploadId],
  );
  assert.deepEqual([late.state, late.generation, late.late, late.data_class, late.deletion_result, late.deletion_reason], ["DELETED", written.generation, true, "RESIDUAL", "DELETED", "ACCEPTANCE_TOMBSTONED"]);
  assert.equal(env.storage.generationsOf(env.storage.location("QUARANTINE"), finalized.objectName)[0]?.status, "SOFT_DELETED");
  // the name reserved for the open upload held nothing: closed by the absence check
  const empty = await oracle<{ state: string; generation: string | null; deletion_result: string }>(env, "SELECT state, generation, deletion_result FROM kauro.stored_objects WHERE upload_id = $1", [open.uploadId]);
  assert.deepEqual([empty.state, empty.generation, empty.deletion_result], ["DELETED", null, "ALREADY_ABSENT"]);

  // a second delivery of a cancellation finds nothing pending and changes nothing (at least once, idempotent)
  const before = env.storage.calls().length;
  const again = await env.plane.consumers.storageLifecycle.forUpload({ serviceId: "storage-lifecycle", agencyId: t.ag.agencyId, correlationId: ids.next() as CorrelationId, causationId: ids.next() as CausationId }, env.plane.units, open.uploadId as UploadId, "CANCELLED");
  assert.deepEqual(again, { kind: "DONE" });
  assert.equal(env.storage.calls().length, before, "no provider call is made twice");
  // an event announcing a tombstone its subject does not carry is an integrity incident, dead-lettered (07; design §6)
  const young = await reserve(env, t, p, 10, "CSV");
  assert.deepEqual(
    await env.plane.consumers.storageLifecycle.forUpload({ serviceId: "storage-lifecycle", agencyId: t.ag.agencyId, correlationId: ids.next() as CorrelationId, causationId: ids.next() as CausationId }, env.plane.units, young.uploadId as UploadId, "CANCELLED"),
    { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_TOMBSTONED" },
  );
  assert.equal((await uploadRow(young.uploadId)).state, "RESERVED");
});

test("OBJECT_INVENTORY and DELETION_RETRIES: an admitted generation the provider no longer holds is revoked GENERATION_MISSING and its registry row closed by its absence; a deletion the provider failed is recorded DELETION_FAILED and completed by DELETION_RETRIES under its exact generation", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "inventory");
  const p = await project(env, t);
  const lost = await uploadAndReport(env, t, p, csv("lost"), "CSV");
  assert.equal((await env.plane.drain(env.plane.consumers.uploadInspection, clock.now())).deadLettered, 0);
  const admitted = await oracle<{ file_id: string; object_id: string; object_name: string; generation: string }>(
    env,
    "SELECT f.file_id, o.object_id, o.object_name, o.generation FROM kauro.source_files f JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id WHERE f.origin_upload_id = $1",
    [lost.up.uploadId],
  );
  // the provider loses the accepted generation outside the platform
  assert.equal(env.storage.deleteOutOfBand(env.storage.location("ACCEPTED"), admitted.object_name)?.generation, admitted.generation);
  const inventory = await env.plane.sweepers.objectInventory.sweep(env.plane.units, 100);
  assert.deepEqual([inventory.admissionsRevoked, inventory.failed], [1, []]);
  const revoked = await oracle<{ state: string; revocation_reason: string; object_state: string; deletion_result: string }>(
    env,
    "SELECT f.state, f.revocation_reason, o.state AS object_state, o.deletion_result FROM kauro.source_files f JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id WHERE f.file_id = $1",
    [admitted.file_id],
  );
  assert.deepEqual(revoked, { state: "ADMISSION_REVOKED", revocation_reason: "GENERATION_MISSING", object_state: "DELETED", deletion_result: "ALREADY_ABSENT" });
  const event = (await eventsOf(env, admitted.file_id)).at(-1);
  assert.deepEqual([event?.event_type, event?.actor_kind, event?.actor_id], ["source_file.admission_revoked.v1", "SERVICE", "object-inventory"]);
  assert.equal((await env.plane.sweepers.objectInventory.sweep(env.plane.units, 100)).acted, 0, "a second inventory finds nothing new");

  // a deletion the provider fails: recorded DELETION_FAILED, then retried by DELETION_RETRIES to DELETED
  const up = await reserve(env, t, p, csv("retried").length, "CSV");
  const ref = await issue(env, t, up);
  const written = uploadThrough(env, ref, csv("retried"));
  await cancel(env, t, up);
  env.storage.failNext("delete", { code: "UNAVAILABLE" });
  await env.plane.drain(env.plane.consumers.storageLifecycle, clock.now());
  const failed = await oracle<{ state: string; deletion_result: string; deletion_attempts: number; generation: string }>(env, "SELECT state, deletion_result, deletion_attempts, generation FROM kauro.stored_objects WHERE upload_id = $1", [up.uploadId]);
  assert.deepEqual([failed.state, failed.deletion_result, failed.deletion_attempts, failed.generation], ["DELETION_FAILED", "PROVIDER_ERROR", 1, written.generation]);
  const retried = await env.plane.sweepers.deletionRetries.sweep(env.plane.units, 100);
  assert.deepEqual([retried.acted, retried.failed], [1, []]);
  const deleted = await oracle<{ state: string; deletion_result: string; deletion_attempts: number }>(env, "SELECT state, deletion_result, deletion_attempts FROM kauro.stored_objects WHERE upload_id = $1", [up.uploadId]);
  assert.deepEqual([deleted.state, deleted.deletion_result, deleted.deletion_attempts], ["DELETED", "DELETED", 2]);
  assert.equal(env.storage.generationsOf(env.storage.location("QUARANTINE"), up.objectName).find((g) => g.generation === written.generation)?.status, "SOFT_DELETED");
  assert.equal((await env.plane.sweepers.deletionRetries.sweep(env.plane.units, 100)).examined, 0);
});

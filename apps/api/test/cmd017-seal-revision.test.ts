// CMD017 SealRevision — POST /api/v1/revisions/{revisionId}/seal — AGENCY_OPERATOR (registry cases CMD017-OK / -DENY / -RACE and the
// seal's generation re-check of S053; docs/design/B07-upload-source-lifecycle.md §11 CMD017, D-SEAL-1, D-HASH-1, D-HASH-4, D-RET-2,
// D-RET-3, D-ANCH-2, D-FILE-1, D-CLOCK-1, D-CMD-7, D-CMD-9). The real route and composition root over PostgreSQL 17. The revision is
// readied through the product's routes with the control plane's writes between them (source-support.ts); a revision whose past lies
// beyond a deadline (an intake window closed, a first seal fifteen days old) is written by the product's adapters or the
// source-lifecycle fixture of @kauro/persistence/testing on the labelled TEST CLOCK, never back-dated. The accepted generation that
// changes at the provider is the labelled storage fake's (SIMULATED). Interleavings by hold points and pg_stat_activity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { CreateRevisionView, SealRevisionView, SelectInputTablesView } from "@kauro/application";
import { canonicalize } from "@kauro/contracts";
import { acceptedObjectName, type AgencyId, type ProjectId, type SourceFileId } from "@kauro/domain";
import { admitSourceFile, readySourceRevision, sealSourceRevision } from "@kauro/persistence/testing";
import { SimulatedCrash, asProblem, completed, freshKey, ids, outcome, replayTextOf, rootCause, waitForApiLockWait, world, type Reply, type World } from "./support.js";
import { LOCKS, activate, controlStepOn, createRevision, evaluate, exactInstant, fixtureSessions, intakeExpiryWrites, inventoryHashOfRoute, manifestOf, readyRevision, reuseReadyAt, revokeAdmission, seal, select, setSessionLimit, storedManifest, type ReadyRevision } from "./source-support.js";
import { boundControlWriter, reachedHold, waitForWriterLockWait } from "./writers.js";

let w: World;
before(async () => {
  w = await world();
  await activate(w);
  await setSessionLimit(w, w.A, 16);
});
after(async () => {
  await w.stop();
});

const DAY_MS = 86_400_000;

/** An independent digest: SHA-256 over the canonical {domain, version, payload} wrapper (HASHING "Hash domain separation"). */
function digestOf(domain: string, payload: unknown): string {
  return createHash("sha256").update(canonicalize({ domain, version: 1, payload })).digest("hex");
}

/** What a seal writes, for one revision (superuser oracle). */
async function sealFacts(revisionId: string) {
  const r = await w.h.oracle.query<{ manifests: string; files: string; records: string; anchors: string; sealed_events: string }>(
    `SELECT (SELECT count(*) FROM kauro.sealed_manifests WHERE revision_id = $1)::text AS manifests,
            (SELECT count(*) FROM kauro.sealed_revision_files WHERE revision_id = $1)::text AS files,
            (SELECT count(*) FROM kauro.retention_records WHERE revision_id = $1)::text AS records,
            (SELECT count(*) FROM kauro.retention_anchors WHERE revision_id = $1 AND anchor_kind = 'REVISION_SEALED')::text AS anchors,
            (SELECT count(*) FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'dataset_revision.sealed.v1')::text AS sealed_events`,
    [revisionId],
  );
  const row = r.rows[0];
  assert.ok(row);
  return { manifests: Number(row.manifests), files: Number(row.files), records: Number(row.records), anchors: Number(row.anchors), sealedEvents: Number(row.sealed_events) };
}

const NOTHING_SEALED = { manifests: 0, files: 0, records: 0, anchors: 0, sealedEvents: 0 };

async function revisionState(revisionId: string): Promise<{ readonly state: string; readonly version: number }> {
  const row = await w.row<{ state: string; version: string }>("dataset_revisions", "revision_id = $1", [revisionId]);
  assert.ok(row);
  return { state: row.state, version: Number(row.version) };
}

/**
 * The labelled storage fake holds, at the accepted name, exactly the generation and length the source-lifecycle fixture of
 * @kauro/persistence/testing recorded for a file it admitted on the TEST CLOCK without the fake — what the seal observes (B07-R1).
 */
async function providerHoldsFixtureFile(projectId: string, fileId: string): Promise<void> {
  const file = await w.row<{ provider_generation: string; bytes: string }>("source_files", "file_id = $1", [fileId]);
  assert.ok(file);
  const objectName = acceptedObjectName(w.A.agencyId as AgencyId, projectId as ProjectId, fileId as SourceFileId);
  w.storage.plantGeneration(w.storage.location("ACCEPTED"), objectName, new Uint8Array(Number(file.bytes)), file.provider_generation);
}

function scopeOf(projectId: string) {
  return { agencyId: w.A.agencyId, projectId, ownerUserId: w.A.ownerUserId, ownerMembershipId: w.A.ownerMembershipId };
}

test("OK: an OPERATOR seals a READY_TO_SEAL revision — SEALED v5, the manifest (HASHING's preimage), the sealed subject and the file set with exact generations, the UNPAID record with hard deadline the first seal of the bytes + 14 days, one sealed event", async () => {
  const ready = await readyRevision(w);
  const { revisionId, file } = ready;
  const key = freshKey("cmd017-ok");
  const body = completed<SealRevisionView>(await seal(w, revisionId, ready.version, ready.selectionHash, { key }), 200);
  assert.deepEqual([body.version, body.replayed, body.data.revision.state, body.data.revision.version], [5, false, "SEALED", 5]);
  const sealedAt = await exactInstant(w, "SELECT sealed_at FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]);

  // the manifest is exactly HASHING's KAURO_SOURCE_REVISION_V1 preimage — four members — and its hash is recomputed here from the
  // stored manifest by an independent function; the included file at its exact accepted generation, digest and length
  const stored = await w.row<{ manifest: Record<string, unknown>; manifest_hash: string; projection_hash: string; subject: Record<string, unknown>; subject_hash: string; selection_hash: string; evaluation_hash: string }>("sealed_manifests", "revision_id = $1", [revisionId]);
  assert.ok(stored);
  assert.deepEqual(Object.keys(stored.manifest).sort(), ["files", "parserProfile", "projection", "tableSelection"]);
  assert.equal(digestOf("KAURO_SOURCE_REVISION_V1", stored.manifest), body.data.manifestHash);
  assert.equal(stored.manifest_hash, body.data.manifestHash);
  assert.equal(digestOf("KAURO_SOURCE_PROJECTION_V1", stored.manifest["projection"]), body.data.projectionHash);
  assert.deepEqual(stored.manifest["files"], [{ fileId: file.fileId, providerGeneration: file.acceptedGeneration, sha256: file.sha256, bytes: file.bytes }]);
  // the sealed subject binds the manifest to this revision with the frozen counts (D-HASH-4)
  assert.equal(digestOf("KAURO_SOURCE_SEALED_SUBJECT_V1", stored.subject), body.data.sealedSubjectHash);
  assert.deepEqual([stored.subject["revisionId"], stored.subject["manifestHash"], stored.subject["selectionHash"], stored.subject["populations"]], [revisionId, body.data.manifestHash, ready.selectionHash, { physicalSourceRows: 3, logicalSourceRecords: 3, billableSourceUnits: 3, associationEdges: 0 }]);
  assert.equal(stored.selection_hash, ready.selectionHash);
  assert.equal(await exactInstant(w, "SELECT sealed_at FROM kauro.sealed_manifests WHERE revision_id = $1", [revisionId]), sealedAt);
  // the file set equals the selection's dispositions at the exact generations the evaluation counted
  const fileSet = await w.h.oracle.query("SELECT file_id, ordinal, disposition, exclusion_reason, provider_generation, sha256, bytes::text AS bytes FROM kauro.sealed_revision_files WHERE revision_id = $1 ORDER BY ordinal", [revisionId]);
  assert.deepEqual(fileSet.rows, [{ file_id: file.fileId, ordinal: 0, disposition: "INCLUDED", exclusion_reason: null, provider_generation: file.acceptedGeneration, sha256: file.sha256, bytes: String(file.bytes) }]);
  // the revision records the seal at the server's instant with its hashes and counts
  const revision = await w.row<{ manifest_hash: string; projection_hash: string; sealed_file_count: number; sealed_bytes: string }>("dataset_revisions", "revision_id = $1", [revisionId]);
  assert.deepEqual(revision && [revision.manifest_hash, revision.projection_hash, revision.sealed_file_count, Number(revision.sealed_bytes)], [body.data.manifestHash, body.data.projectionHash, 1, file.bytes]);

  // the UNPAID record of new bytes: anchored on this seal's REVISION_SEALED anchor at the seal instant; hard = effective = that
  // first seal + fourteen exact days (1,209,600 s); no soft deadline yet (the audit package sets it, only earlier)
  const record = await w.row<{ retention_id: string; class: string; anchor_id: string; soft_deadline: string | null; state: string; policy_version: string }>("retention_records", "revision_id = $1", [revisionId]);
  assert.ok(record);
  assert.deepEqual([record.retention_id, record.class, record.soft_deadline, record.state], [body.data.retention.retentionId, "UNPAID", null, "ACTIVE"]);
  const anchor = await w.row<{ anchor_id: string; evidence_hash: string }>("retention_anchors", "revision_id = $1 AND anchor_kind = 'REVISION_SEALED'", [revisionId]);
  assert.equal(record.anchor_id, anchor?.anchor_id);
  assert.equal(await exactInstant(w, "SELECT occurred_at FROM kauro.retention_anchors WHERE anchor_id = $1", [record.anchor_id]), sealedAt);
  const hard = await exactInstant(w, "SELECT $1::timestamptz + interval '1209600 seconds'", [sealedAt]);
  assert.equal(await exactInstant(w, "SELECT hard_deadline FROM kauro.retention_records WHERE retention_id = $1", [record.retention_id]), hard);
  assert.equal(await exactInstant(w, "SELECT effective_deadline FROM kauro.retention_records WHERE retention_id = $1", [record.retention_id]), hard);
  assert.deepEqual([body.data.retention.class, body.data.retention.hardDeadline, body.data.retention.effectiveDeadline, body.data.retention.anchorEvidenceHash], ["UNPAID", new Date(Date.parse(hard)).toISOString(), new Date(Date.parse(hard)).toISOString(), anchor?.evidence_hash]);
  assert.equal(body.data.revision.dataAvailableUntil, new Date(Date.parse(hard)).toISOString());

  // one sealed event and one record event, and the journal row
  const events = (await w.events("dataset_revision", revisionId)).filter((e) => e.type === "dataset_revision.sealed.v1");
  assert.equal(events.length, 1);
  assert.deepEqual([events[0]?.version, events[0]?.payload["manifestHash"], events[0]?.payload["retentionId"], events[0]?.payload["fileCount"]], [5, body.data.manifestHash, record.retention_id, 1]);
  assert.deepEqual((await w.events("retention_record", record.retention_id)).map((e) => [e.version, e.type]), [[1, "retention_record.created.v1"]]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status, journal.resourceKind, journal.resourceId], ["COMMITTED", 200, "dataset_revision", revisionId]);

  // bytes sealed again by a successor that reuses them keep their first seal's cap: the successor's UNPAID record is anchored on
  // the first seal of the bytes, with the same hard deadline (D-RET-3) — the re-seal never restarts the clock
  const successor = completed<CreateRevisionView>(await createRevision(w, ready.projectId, 1, revisionId), 201).data.revision.revisionId;
  const reusing = manifestOf(successor, await inventoryHashOfRoute(w, successor), [{ file, origin: "REUSED" }]);
  const selected = completed<SelectInputTablesView>(await select(w, successor, 1, (await storedManifest(w, successor, reusing)).selectionManifestId), 200);
  assert.deepEqual([selected.data.revision.state, selected.data.selection.reusedFileIds], ["INSPECTING", [file.fileId]]);
  const counted = await evaluate(w, w.A.agencyId, successor, [file]);
  const resealed = completed<SealRevisionView>(await seal(w, successor, counted.version, selected.data.selection.selectionHash), 200);
  assert.equal(resealed.data.revision.state, "SEALED");
  assert.equal(resealed.data.retention.anchorEvidenceHash, anchor?.evidence_hash, "anchored on the bytes' first seal");
  assert.equal(await exactInstant(w, "SELECT hard_deadline FROM kauro.retention_records WHERE revision_id = $1", [successor]), hard);
  assert.notEqual(resealed.data.manifestHash, body.data.manifestHash, "two seals of the same bytes are two manifests (their projection ids)");
});

test("DENY: a revoked admission → 409 INPUT_NOT_ADMITTED; a changed generation → 409 GENERATION_CHANGED; reused bytes past their window → 409 REUSE_NOT_AVAILABLE; selectionHash of another selection → 409 STALE_VERSION HASH_MISMATCH; stale version → 409; VIEWER → 403; foreign → 404 — the revision stays READY_TO_SEAL", async () => {
  // a revoked admission: the object inventory found the accepted generation lost (GENERATION_MISSING)
  const revoked = await readyRevision(w);
  await revokeAdmission(w, w.A.agencyId, revoked.file.fileId, "GENERATION_MISSING");
  // a changed generation: the object inventory found another generation at the accepted name (GENERATION_CHANGED, D-CMD-9)
  const changed = await readyRevision(w);
  await revokeAdmission(w, w.A.agencyId, changed.file.fileId, "GENERATION_CHANGED");
  // reused bytes whose window closed after the agency selected them: sealed sixteen days ago (the source-lifecycle fixture), then
  // superseded, selected and counted fifteen days ago by a successor (reuseReadyAt) — sealed now, fourteen days after the bytes'
  // first seal have passed
  const old = await w.project(w.A, w.clientA);
  const oldSeal = await sealSourceRevision(fixtureSessions(w, w.A), scopeOf(old.projectId), { seed: "cmd017-deny-reuse", base: new Date(Date.now() - 16 * DAY_MS) });
  await providerHoldsFixtureFile(old.projectId, oldSeal.fileId);
  const reuse = await reuseReadyAt(w, old.projectId, { revisionId: oldSeal.revisionId, fileId: oldSeal.fileId }, new Date(Date.parse(oldSeal.sealedAt) + DAY_MS));
  // a ready revision for the version, hash, role and tenant refusals
  const ready: ReadyRevision = await readyRevision(w);
  const foreign = await w.project(w.B, w.clientB);
  const denialsBefore = (await w.securityEvents("CMD017")).length;
  const probe = async (reply: Reply, expected: string, revisionId: string, version: number): Promise<void> => {
    assert.equal(outcome(w, reply), expected);
    if (reply.status === 409) assert.deepEqual(asProblem(w, reply).current?.state, "READY_TO_SEAL");
    assert.deepEqual(await revisionState(revisionId), { state: "READY_TO_SEAL", version });
    assert.deepEqual(await sealFacts(revisionId), NOTHING_SEALED);
  };

  await probe(await seal(w, revoked.revisionId, revoked.version, revoked.selectionHash), "409 PRECONDITION_FAILED INPUT_NOT_ADMITTED", revoked.revisionId, revoked.version);
  await probe(await seal(w, changed.revisionId, changed.version, changed.selectionHash), "409 PRECONDITION_FAILED GENERATION_CHANGED", changed.revisionId, changed.version);
  await probe(await seal(w, reuse.revisionId, reuse.version, reuse.selectionHash), "409 PRECONDITION_FAILED REUSE_NOT_AVAILABLE", reuse.revisionId, reuse.version);
  const other = await seal(w, ready.revisionId, ready.version, changed.selectionHash);
  await probe(other, "409 STALE_VERSION HASH_MISMATCH", ready.revisionId, ready.version);
  assert.deepEqual(asProblem(w, other).current, { version: ready.version, state: "READY_TO_SEAL", mismatch: ["selectionHash"] });
  await probe(await seal(w, ready.revisionId, ready.version - 1, ready.selectionHash), "409 STALE_VERSION -", ready.revisionId, ready.version);
  await probe(await seal(w, ready.revisionId, ready.version, ready.selectionHash, { person: w.viewer }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT", ready.revisionId, ready.version);
  assert.equal(outcome(w, await seal(w, foreign.revisionId, 1, ready.selectionHash)), "404 NOT_FOUND -");
  assert.deepEqual((await w.securityEvents("CMD017")).slice(denialsBefore).map((f) => [f.outcome, f.reason, f.actorId]), [["DENY", "ROLE_INSUFFICIENT", w.viewer.userId]]);
  // the control: the ready revision seals once its caller names its version and selection
  assert.equal(completed<SealRevisionView>(await seal(w, ready.revisionId, ready.version, ready.selectionHash), 200).data.revision.state, "SEALED");
});

/** The accepted object of a readied revision's file at the labelled storage fake (its location and opaque name, D-OBJ-1). */
function acceptedOf(ready: ReadyRevision): { readonly location: ReturnType<World["storage"]["location"]>; readonly objectName: string } {
  return { location: w.storage.location("ACCEPTED"), objectName: acceptedObjectName(w.A.agencyId as AgencyId, ready.projectId as ProjectId, ready.file.fileId as SourceFileId) };
}

/** The storage port's hold placements on one accepted name, with their answers (the fake's call log; never a bearer reference). */
function placementsOf(accepted: { readonly objectName: string }): ReadonlyArray<string> {
  return w.storage.calls("placeHold").filter((c) => c.request["objectName"] === accepted.objectName).map((c) => c.outcome);
}

/** The storage port's hold releases on one accepted name, with their answers. */
function releasesOf(accepted: { readonly objectName: string }): ReadonlyArray<string> {
  return w.storage.calls("releaseHold").filter((c) => c.request["objectName"] === accepted.objectName).map((c) => c.outcome);
}

/** Whether the provider holds the live generation of an accepted name under a temporary hold (the labelled fake, SIMULATED). */
function heldAtProvider(accepted: { readonly location: ReturnType<World["storage"]["location"]>; readonly objectName: string }): boolean | undefined {
  return w.storage.generationsOf(accepted.location, accepted.objectName).find((g) => g.status === "LIVE")?.temporaryHold;
}

/** The seal holds recorded for a file (superuser oracle), oldest first: [state, close reason, release result]. */
async function holdsOf(fileId: string): Promise<ReadonlyArray<readonly [string, string | null, string | null]>> {
  const r = await w.h.oracle.query<{ state: string; close_reason: string | null; release_result: string | null }>(
    "SELECT state, close_reason, release_result FROM kauro.object_holds WHERE file_id = $1 ORDER BY intended_at, hold_id",
    [fileId],
  );
  return r.rows.map((x) => [x.state, x.close_reason, x.release_result] as const);
}

/** A refused seal leaves nothing: no manifest, file set, record, anchor or event, the revision READY_TO_SEAL at its version, the file ADMITTED. */
async function assertNothingSealed(ready: ReadyRevision, eventsBefore: number): Promise<void> {
  assert.deepEqual(await sealFacts(ready.revisionId), NOTHING_SEALED);
  assert.deepEqual(await revisionState(ready.revisionId), { state: "READY_TO_SEAL", version: ready.version });
  assert.equal(await w.count("domain_events", "aggregate_id = $1", [ready.revisionId]), eventsBefore);
  assert.equal(await w.count("sealed_revision_files", "file_id = $1", [ready.file.fileId]), 0, "no executable sealed revision names the file");
  const file = await w.row<{ state: string; revocation_reason: string | null }>("source_files", "file_id = $1", [ready.file.fileId]);
  assert.deepEqual(file && [file.state, file.revocation_reason], ["ADMITTED", null], "no object inventory ran: the admission still stands in the database");
}

test("DENY (B07-R1): the provider replaced or lost an included file's accepted generation after the evaluation and before any object inventory revoked it — the file still ADMITTED, the stored file and evaluation still agreeing — so the seal's provider hold, placed with the counted generation as its precondition, is refused and the seal answers 409 GENERATION_CHANGED; a provider that cannot answer is 503 CAPACITY_UNAVAILABLE GENERATION_NOT_OBSERVED; nothing is sealed, each refused attempt's hold record is closed and released, and the same key seals once the provider holds the counted generation", async () => {
  // (a) replaced: after the evaluation counted the admitted generation, another generation replaces it at the provider (out of band);
  //     no object inventory runs, so nothing in the database knows
  const replaced = await readyRevision(w);
  const accepted = acceptedOf(replaced);
  const planted = w.storage.plantObject(accepted.location, accepted.objectName, new TextEncoder().encode("Email,Name\nsomeone@example.com,Someone Else\n"), { overwrite: true });
  assert.notEqual(planted.generation, replaced.file.acceptedGeneration, "the provider now holds another generation at the accepted name");
  const replacedEvents = await w.count("domain_events", "aggregate_id = $1", [replaced.revisionId]);
  const refused = await seal(w, replaced.revisionId, replaced.version, replaced.selectionHash);
  assert.equal(refused.status, 409, `the seal of a replaced generation answered ${refused.status}: ${refused.text.slice(0, 160)}`);
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED GENERATION_CHANGED");
  assert.deepEqual(asProblem(w, refused).current, { version: replaced.version, state: "READY_TO_SEAL" });
  assert.deepEqual(placementsOf(accepted), ["GENERATION_NOT_LIVE"], "the seal's hold, placed on the counted generation, found another one live");
  assert.equal(heldAtProvider(accepted), false, "nothing is held: the replacing generation is not the seal's");
  assert.deepEqual(await holdsOf(replaced.file.fileId), [["RELEASED", "REFUSED", "ABSENT"]], "the refused attempt's hold is closed and its release answered ABSENT");
  await assertNothingSealed(replaced, replacedEvents);

  // (b) lost: the provider no longer holds any generation at the accepted name
  const lost = await readyRevision(w);
  const lostObject = acceptedOf(lost);
  assert.equal(w.storage.deleteOutOfBand(lostObject.location, lostObject.objectName)?.generation, lost.file.acceptedGeneration);
  const lostEvents = await w.count("domain_events", "aggregate_id = $1", [lost.revisionId]);
  assert.equal(outcome(w, await seal(w, lost.revisionId, lost.version, lost.selectionHash)), "409 PRECONDITION_FAILED GENERATION_CHANGED");
  assert.deepEqual(placementsOf(lostObject), ["GENERATION_NOT_LIVE"]);
  assert.deepEqual(await holdsOf(lost.file.fileId), [["RELEASED", "REFUSED", "ABSENT"]]);
  await assertNothingSealed(lost, lostEvents);

  // (c) unobserved: the provider refuses the placement; nothing is sealed and the answer is retryable under the same key, which
  //     seals once the provider holds exactly the counted generation (the positive control)
  const unobserved = await readyRevision(w);
  const unobservedObject = acceptedOf(unobserved);
  const unobservedEvents = await w.count("domain_events", "aggregate_id = $1", [unobserved.revisionId]);
  const key = freshKey("cmd017-unobserved");
  w.storage.failNext("placeHold", { code: "UNAVAILABLE" });
  const unavailable = await seal(w, unobserved.revisionId, unobserved.version, unobserved.selectionHash, { key });
  assert.equal(outcome(w, unavailable), "503 CAPACITY_UNAVAILABLE GENERATION_NOT_OBSERVED");
  assert.equal(await w.journal(key), null, "a refusal leaves no journal row: the same key executes again");
  assert.deepEqual(await holdsOf(unobserved.file.fileId), [["RELEASED", "REFUSED", "RELEASED"]], "the unanswered attempt's hold is closed and released all the same");
  await assertNothingSealed(unobserved, unobservedEvents);
  const sealed = completed<SealRevisionView>(await seal(w, unobserved.revisionId, unobserved.version, unobserved.selectionHash, { key }), 200);
  assert.deepEqual([sealed.replayed, sealed.data.revision.state], [false, "SEALED"]);
  assert.deepEqual(placementsOf(unobservedObject), ["FAILED UNAVAILABLE", `HELD ${unobserved.file.acceptedGeneration}`]);
  assert.deepEqual(await holdsOf(unobserved.file.fileId), [["RELEASED", "REFUSED", "RELEASED"], ["SEALED", null, null]]);
  assert.equal(heldAtProvider(unobservedObject), true, "the sealed generation stays held");
  const fileSet = await w.h.oracle.query<{ provider_generation: string }>("SELECT provider_generation FROM kauro.sealed_revision_files WHERE revision_id = $1", [unobserved.revisionId]);
  assert.deepEqual(fileSet.rows, [{ provider_generation: unobserved.file.acceptedGeneration }], "the sealed generation is the one the provider holds and the evaluation counted");
  // an identical retry replays the journaled seal without asking the provider again
  const replay = await seal(w, unobserved.revisionId, unobserved.version, unobserved.selectionHash, { key });
  assert.equal(replay.status, 200);
  assert.equal(replay.json<{ replayed: boolean }>().replayed, true);
  assert.equal(placementsOf(unobservedObject).length, 2, "a replay performs no provider call");
  assert.equal(releasesOf(unobservedObject).length, 1);
});

test("RACE (B07-R1): the seal's hold placement held at the storage port while the provider replaces the accepted generation — released, the placement's generation precondition fails and the seal answers 409 GENERATION_CHANGED with nothing sealed; the seal never answers from what the provider held before the replacement", async () => {
  const ready = await readyRevision(w);
  const accepted = acceptedOf(ready);
  const eventsBefore = await w.count("domain_events", "aggregate_id = $1", [ready.revisionId]);
  const hold = w.storage.holdNext("placeHold");
  const sealing = seal(w, ready.revisionId, ready.version, ready.selectionHash);
  let planted: { readonly generation: string } | undefined;
  try {
    // the storage fake's hold point: the seal's placement arrived and waits (never a timer)
    const first = await Promise.race([hold.reached.then(() => "REACHED" as const), sealing.then(() => "FINISHED" as const, () => "FINISHED" as const)]);
    assert.equal(first, "REACHED", "the seal asks the provider before it answers");
    // the seal is asking the provider; the provider replaces the accepted generation before the hold lands
    planted = w.storage.plantObject(accepted.location, accepted.objectName, new TextEncoder().encode("Email,Name\nraced@example.com,Raced\n"), { overwrite: true });
  } finally {
    hold.release();
  }
  const refused = await sealing;
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED GENERATION_CHANGED");
  assert.deepEqual(placementsOf(accepted), ["GENERATION_NOT_LIVE"]);
  assert.deepEqual(liveGenerationsOf(accepted), [planted?.generation]);
  assert.equal(heldAtProvider(accepted), false);
  assert.deepEqual(await holdsOf(ready.file.fileId), [["RELEASED", "REFUSED", "ABSENT"]]);
  await assertNothingSealed(ready, eventsBefore);
});

/** The generations the labelled storage fake holds LIVE under an accepted name (the provider's truth, SIMULATED). */
function liveGenerationsOf(accepted: { readonly location: ReturnType<World["storage"]["location"]>; readonly objectName: string }): ReadonlyArray<string> {
  return w.storage
    .generationsOf(accepted.location, accepted.objectName)
    .filter((g) => g.status === "LIVE")
    .map((g) => g.generation);
}

/** Replaces the accepted object at the provider out of band; the provider's refusal (or null when it replaced it). */
function replaceAtProvider(accepted: { readonly location: ReturnType<World["storage"]["location"]>; readonly objectName: string }, label: string): { readonly refusal: string | null } {
  try {
    w.storage.plantObject(accepted.location, accepted.objectName, new TextEncoder().encode(`Email,Name\n${label}@example.com,Replaced\n`), { overwrite: true });
    return { refusal: null };
  } catch (e) {
    return { refusal: String((e as { code?: unknown }).code ?? (e instanceof Error ? e.message : e)) };
  }
}

test("RACE (B07-R1, provider hold): the seal stopped AFTER its provider observation and hold and BEFORE its commit — (a) at its journal commit, the whole seal written; (b) waiting on the revision row another transaction holds — while the provider is asked to replace the accepted generation: the held generation refuses the replacement (OBJECT_HELD), the seal commits, and what it sealed is the generation the provider still holds live; nothing seals a generation that vanished", async () => {
  // (a) the seal held at its journal commit: the provider was asked, the manifest, file set, record and transition are written
  const ready = await readyRevision(w);
  const accepted = acceptedOf(ready);
  const hold = w.holds.arm("journal.commit");
  const sealing = seal(w, ready.revisionId, ready.version, ready.selectionHash);
  let replaced: { readonly refusal: string | null } = { refusal: null };
  try {
    await reachedHold(hold, sealing);
    replaced = replaceAtProvider(accepted, "after-hold");
  } finally {
    hold.release();
  }
  const sealed = completed<SealRevisionView>(await sealing, 200);
  assert.equal(sealed.data.revision.state, "SEALED");
  const fileSet = await w.h.oracle.query<{ provider_generation: string }>("SELECT provider_generation FROM kauro.sealed_revision_files WHERE revision_id = $1", [ready.revisionId]);
  assert.deepEqual(fileSet.rows, [{ provider_generation: ready.file.acceptedGeneration }]);
  assert.deepEqual(liveGenerationsOf(accepted), [ready.file.acceptedGeneration], "the sealed generation is the generation the provider holds live: it did not vanish under the seal");
  assert.equal(replaced.refusal, "OBJECT_HELD", "the provider refused to replace the held generation");

  // (b) the reviewer's interleaving: the revision row held by another transaction, the seal observed waiting on it after its
  //     provider call; the replacement is attempted there; the other transaction ends unchanged and the seal commits
  const waiting = await readyRevision(w);
  const waitingObject = acceptedOf(waiting);
  const writer = await boundControlWriter(w, w.A);
  let sealingB: Promise<Reply> | undefined;
  let replacedB: { readonly refusal: string | null } = { refusal: null };
  try {
    await writer.query("SELECT revision_id FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [waiting.revisionId]);
    sealingB = seal(w, waiting.revisionId, waiting.version, waiting.selectionHash);
    await waitForApiLockWait(w, LOCKS.revision);
    replacedB = replaceAtProvider(waitingObject, "while-waiting");
  } finally {
    await writer.close();
  }
  const sealedB = completed<SealRevisionView>(await (sealingB as Promise<Reply>), 200);
  assert.equal(sealedB.data.revision.state, "SEALED");
  assert.deepEqual(liveGenerationsOf(waitingObject), [waiting.file.acceptedGeneration], "the sealed generation is still the provider's live generation");
  assert.equal(replacedB.refusal, "OBJECT_HELD");
});

test("B07-R1 hold record: a seal that commits keeps its provider hold SEALED (the generation held at the provider, OBJECT_HELD to a deletion); a seal refused after its hold was placed (reused bytes past their window, 409) and a seal that failed before its COMMIT (500) close their attempt's hold REFUSED and release it at the provider — the same key then holds again and seals; the loser of two seals on one version closes its hold and releases nothing the committed seal retains; the database refuses a hold of a revoked file, a second seal of a closed hold, and a release while a seal retains the generation", async () => {
  // committed: the hold is SEALED in the seal's own transaction; the provider holds the generation and refuses its deletion
  const committed = await readyRevision(w);
  const committedObject = acceptedOf(committed);
  completed<SealRevisionView>(await seal(w, committed.revisionId, committed.version, committed.selectionHash), 200);
  assert.deepEqual(await holdsOf(committed.file.fileId), [["SEALED", null, null]]);
  assert.equal(heldAtProvider(committedObject), true);
  await assert.rejects(w.storage.delete(committedObject.location, committedObject.objectName, committed.file.acceptedGeneration), (e: { code?: string }) => e.code === "OBJECT_HELD");
  const sealedHold = await w.row<{ hold_id: string; attempt_expires_at: Date; intended_at: Date; sealed_at: Date; placed_by_user_id: string; generation: string; reason: string; hold_kind: string }>("object_holds", "file_id = $1", [committed.file.fileId]);
  assert.ok(sealedHold);
  assert.deepEqual([sealedHold.generation, sealedHold.reason, sealedHold.hold_kind, sealedHold.placed_by_user_id], [committed.file.acceptedGeneration, "SEAL_INTEGRITY", "TEMPORARY", w.operator.userId]);
  assert.equal(sealedHold.attempt_expires_at.getTime() - sealedHold.intended_at.getTime(), 900_000, "the attempt's bound");
  assert.equal(await exactInstant(w, "SELECT sealed_at FROM kauro.object_holds WHERE hold_id = $1", [sealedHold.hold_id]), await exactInstant(w, "SELECT sealed_at FROM kauro.dataset_revisions WHERE revision_id = $1", [committed.revisionId]), "sealed with the seal, at its instant");

  // refused after the placement: the reused bytes' window closed (sealed sixteen days ago by the fixture, reused and counted
  // fifteen days ago); the placement held the generation, the seal refused REUSE_NOT_AVAILABLE, and the hold is released
  const old = await w.project(w.A, w.clientA);
  const oldSeal = await sealSourceRevision(fixtureSessions(w, w.A), scopeOf(old.projectId), { seed: "cmd017-hold-reuse", base: new Date(Date.now() - 16 * DAY_MS) });
  await providerHoldsFixtureFile(old.projectId, oldSeal.fileId);
  const reuse = await reuseReadyAt(w, old.projectId, { revisionId: oldSeal.revisionId, fileId: oldSeal.fileId }, new Date(Date.parse(oldSeal.sealedAt) + DAY_MS));
  const reuseObject = { location: w.storage.location("ACCEPTED"), objectName: acceptedObjectName(w.A.agencyId as AgencyId, old.projectId, oldSeal.fileId as SourceFileId) };
  assert.equal(outcome(w, await seal(w, reuse.revisionId, reuse.version, reuse.selectionHash)), "409 PRECONDITION_FAILED REUSE_NOT_AVAILABLE");
  const reusePlacements = placementsOf(reuseObject);
  assert.equal(reusePlacements.length, 1);
  assert.match(reusePlacements[0] ?? "", /^HELD /, "the hold was placed before the unit of work refused");
  assert.deepEqual(await holdsOf(oldSeal.fileId), [["RELEASED", "REFUSED", "RELEASED"]]);
  assert.equal(heldAtProvider(reuseObject), false, "the refused seal released its hold at the provider");

  // failed before COMMIT: the whole seal written, then a crash; the attempt's hold is closed and released; the same key seals
  const failing = await readyRevision(w);
  const failingObject = acceptedOf(failing);
  const key = freshKey("cmd017-hold-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT, after the provider hold") });
  assert.equal(outcome(w, await seal(w, failing.revisionId, failing.version, failing.selectionHash, { key })), "500 INTERNAL_ERROR -");
  assert.deepEqual(await holdsOf(failing.file.fileId), [["RELEASED", "REFUSED", "RELEASED"]]);
  assert.equal(heldAtProvider(failingObject), false);
  assert.deepEqual(await sealFacts(failing.revisionId), NOTHING_SEALED);
  completed<SealRevisionView>(await seal(w, failing.revisionId, failing.version, failing.selectionHash, { key }), 200);
  assert.deepEqual(await holdsOf(failing.file.fileId), [["RELEASED", "REFUSED", "RELEASED"], ["SEALED", null, null]]);
  assert.equal(heldAtProvider(failingObject), true);

  // two seals on one version: the loser's hold is closed, and nothing the committed seal retains is released
  const racing = await readyRevision(w);
  const racingObject = acceptedOf(racing);
  const first = w.holds.arm("journal.commit");
  const a = seal(w, racing.revisionId, racing.version, racing.selectionHash);
  let b: Promise<Reply> | undefined;
  try {
    await reachedHold(first, a);
    b = seal(w, racing.revisionId, racing.version, racing.selectionHash);
    await waitForApiLockWait(w, LOCKS.revision);
  } finally {
    first.release();
  }
  completed<SealRevisionView>(await a, 200);
  assert.equal(outcome(w, await (b as Promise<Reply>)), "409 STALE_VERSION -");
  assert.deepEqual(await holdsOf(racing.file.fileId), [["SEALED", null, null], ["CLOSED", "REFUSED", null]]);
  assert.equal(heldAtProvider(racingObject), true, "the committed seal's generation stays held");
  assert.deepEqual(releasesOf(racingObject), [], "no release was even asked for");

  // the database's own refusals (the guards are the backstop of the adapter's reads)
  const tenant = async (sql: string, params: ReadonlyArray<unknown>): Promise<unknown> => w.asTenant(w.A, (c) => c.query(sql, [...params]));
  const revoked = await readyRevision(w);
  await revokeAdmission(w, w.A.agencyId, revoked.file.fileId, "GENERATION_MISSING");
  const revokedFile = await w.row<{ accepted_object_id: string }>("source_files", "file_id = $1", [revoked.file.fileId]);
  await assert.rejects(
    tenant(
      `INSERT INTO kauro.object_holds (hold_id, attempt_id, agency_id, project_id, revision_id, file_id, object_id, generation, hold_kind, reason, placed_by_user_id, state, intended_at, attempt_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TEMPORARY', 'SEAL_INTEGRITY', $9, 'INTENDED', kauro.server_now(), kauro.server_now() + interval '900 seconds', now(), now())`,
      [ids.next(), ids.next(), w.A.agencyId, revoked.projectId, revoked.revisionId, revoked.file.fileId, revokedFile?.accepted_object_id, revoked.file.acceptedGeneration, w.A.ownerUserId],
    ),
    (e: { code?: string }) => e.code === "KA072",
    "no hold of a file whose admission ended",
  );
  const closedHold = await w.row<{ hold_id: string }>("object_holds", "file_id = $1 AND state = 'CLOSED'", [racing.file.fileId]);
  await assert.rejects(tenant("UPDATE kauro.object_holds SET state = 'SEALED', sealed_at = kauro.server_now() WHERE hold_id = $1", [closedHold?.hold_id]), (e: { code?: string }) => e.code === "KA008", "a closed hold never seals");
  await assert.rejects(
    tenant("UPDATE kauro.object_holds SET state = 'RELEASING', release_requested_at = kauro.server_now() WHERE hold_id = $1", [closedHold?.hold_id]),
    (e: { code?: string }) => e.code === "KA071",
    "no release while a seal retains the generation",
  );
});

test("RACE: two seals on one version → one 200, one 409; identical retry replays; the same key with another hash → 409; a crash leaves the revision READY_TO_SEAL; a seal racing the intake-expiry sweeper through the product", async () => {
  // two seals of version 4: the first held before its journal commit (the revision row locked, the seal written), the second
  // observed waiting on the revision row; the first commits, the second reads version 5
  const ready = await readyRevision(w);
  const keyA = freshKey("cmd017-race-a");
  const hold = w.holds.arm("journal.commit");
  const a = seal(w, ready.revisionId, ready.version, ready.selectionHash, { key: keyA });
  let b: Promise<Reply> | undefined;
  try {
    await reachedHold(hold, a);
    b = seal(w, ready.revisionId, ready.version, ready.selectionHash, { key: freshKey("cmd017-race-b") });
    await waitForApiLockWait(w, LOCKS.revision);
  } finally {
    hold.release();
  }
  const [first, second] = await Promise.all([a, b as Promise<Reply>]);
  assert.equal(completed<SealRevisionView>(first, 200).data.revision.version, 5);
  assert.equal(outcome(w, second), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, second).current, { version: 5, state: "SEALED" });
  assert.deepEqual(await sealFacts(ready.revisionId), { manifests: 1, files: 1, records: 1, anchors: 1, sealedEvents: 1 });
  // identical retry replays; the same key with another hash is a typed conflict with no effect
  const replay = await seal(w, ready.revisionId, ready.version, ready.selectionHash, { key: keyA });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(outcome(w, await seal(w, ready.revisionId, ready.version, "0".repeat(64), { key: keyA })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await sealFacts(ready.revisionId), { manifests: 1, files: 1, records: 1, anchors: 1, sealedEvents: 1 });

  // a crash after the whole seal was written and before COMMIT: nothing of it exists, the revision READY_TO_SEAL; the same key
  // then seals once
  const fresh = await readyRevision(w);
  const crashKey = freshKey("cmd017-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await seal(w, fresh.revisionId, fresh.version, fresh.selectionHash, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.deepEqual(await revisionState(fresh.revisionId), { state: "READY_TO_SEAL", version: fresh.version });
  assert.deepEqual(await sealFacts(fresh.revisionId), NOTHING_SEALED);
  assert.equal(await w.journal(crashKey), null);
  assert.equal(completed<SealRevisionView>(await seal(w, fresh.revisionId, fresh.version, fresh.selectionHash, { key: crashKey }), 200).replayed, false);
  assert.deepEqual(await sealFacts(fresh.revisionId), { manifests: 1, files: 1, records: 1, anchors: 1, sealedEvents: 1 });

  // a seal racing the upload-deadline sweeper (§12.5 UPLOAD_DEADLINES), whose intake-expiry revocation reaches a file no seal included
  // once its upload's window closed: a revision readied from an upload initiated twenty-six hours ago (the source-lifecycle fixture).
  // Both take the revision row first (D-LOCK-1, D-LOCK-2): exactly one of the seal and the revocation commits.
  const past = new Date(Date.now() - 26 * 3_600_000);
  const sealFirst = await w.project(w.A, w.clientA);
  const readyA = await readySourceRevision(fixtureSessions(w, w.A), scopeOf(sealFirst.projectId), await admitSourceFile(fixtureSessions(w, w.A), scopeOf(sealFirst.projectId), { seed: "cmd017-race-sweeper-a", base: past }));
  await providerHoldsFixtureFile(sealFirst.projectId, readyA.fileId);
  // (a) the seal first: held before its journal commit; the sweeper, bound to the agency, is observed waiting on the revision row;
  //     the seal commits; the sweeper then reads a file a real seal includes and leaves it as it is — and the database refuses the
  //     revocation all the same (a sealed file's admission follows the seal's retention, KA072)
  const holdSeal = w.holds.arm("journal.commit");
  const sealing = seal(w, readyA.revisionId, readyA.revisionVersion, readyA.selectionHash);
  const sweeperA = await boundControlWriter(w, w.A);
  try {
    const { step, emit } = controlStepOn(sweeperA, w.A.agencyId);
    let sweepA: Promise<"EXPIRED" | "SEALED"> | undefined;
    try {
      await reachedHold(holdSeal, sealing);
      sweepA = intakeExpiryWrites(step, emit, w.A.agencyId, readyA.uploadId);
      await waitForWriterLockWait(w, sweeperA, LOCKS.revision);
    } finally {
      holdSeal.release();
    }
    assert.equal(completed<SealRevisionView>(await sealing, 200).data.revision.state, "SEALED");
    assert.equal(await (sweepA as Promise<"EXPIRED" | "SEALED">), "SEALED", "the sweeper leaves a sealed file to its seal's retention");
    const file = await step.sources.files.get(readyA.fileId as SourceFileId);
    assert.ok(file && file.state === "ADMITTED");
    await assert.rejects(step.sources.files.revokeAdmission(file.fileId, file.version, "INTAKE_EXPIRED"), (e: { code?: string; reason?: string }) => e.code === "INTEGRITY_FAILURE" && e.reason === "LIFECYCLE_BINDING_MISSING");
  } finally {
    await sweeperA.close();
  }
  assert.equal((await w.row<{ state: string }>("source_files", "file_id = $1", [readyA.fileId]))?.state, "ADMITTED");

  // (b) the sweeper first: it expires the upload and revokes the file INTAKE_EXPIRED, uncommitted, holding the revision row; the seal
  //     is observed waiting on the revision row; the sweeper commits; the seal reads the revoked admission: 409 INPUT_NOT_ADMITTED and
  //     the revision stays READY_TO_SEAL with nothing sealed
  const sweepFirst = await w.project(w.A, w.clientA);
  const readyB = await readySourceRevision(fixtureSessions(w, w.A), scopeOf(sweepFirst.projectId), await admitSourceFile(fixtureSessions(w, w.A), scopeOf(sweepFirst.projectId), { seed: "cmd017-race-sweeper-b", base: past }));
  let sealingB: Promise<Reply> | undefined;
  const sweeperB = await boundControlWriter(w, w.A);
  try {
    const { step, emit } = controlStepOn(sweeperB, w.A.agencyId);
    assert.equal(await intakeExpiryWrites(step, emit, w.A.agencyId, readyB.uploadId), "EXPIRED");
    sealingB = seal(w, readyB.revisionId, readyB.revisionVersion, readyB.selectionHash);
    await waitForApiLockWait(w, LOCKS.revision);
    await sweeperB.commit();
  } finally {
    await sweeperB.close();
  }
  const refused = await (sealingB as Promise<Reply>);
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED INPUT_NOT_ADMITTED");
  assert.deepEqual(await revisionState(readyB.revisionId), { state: "READY_TO_SEAL", version: readyB.revisionVersion });
  assert.deepEqual(await sealFacts(readyB.revisionId), NOTHING_SEALED);
  const revokedB = await w.row<{ state: string; revocation_reason: string }>("source_files", "file_id = $1", [readyB.fileId]);
  assert.deepEqual(revokedB && [revokedB.state, revokedB.revocation_reason], ["ADMISSION_REVOKED", "INTAKE_EXPIRED"]);
});

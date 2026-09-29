// The labelled contract fakes of the provider ports of the source lifecycle (B07 mandate B07-PROVIDER-FAKES; design §2, §15; case
// map R2-051): object storage, the session vault and the authority journal, each against its port's documented contract and each
// reporting evidence class SIMULATED with a contract-fake-* provider token. Everything proven here is SIMULATED — a local contract
// with fakes (21 "Evidence classes"), never EXECUTED_PROVIDER; the real adapters are B15's. Time is the fakes' injected provider
// clock, moved explicitly by the test (no sleeps); interleavings use the fakes' hold points.
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat as statFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalBytes, isSha256Hex, rawDigest } from "@kauro/contracts";
import type { AgencyId, Clock, ProjectId, RevisionId, SourceFileId, UploadId, UserId } from "@kauro/domain";
import {
  PROVIDER_CALL_TIMEOUT_MS,
  PROVIDER_SESSION_LIFETIME_SECONDS,
  SOURCE_RETENTION,
  acceptedObjectName,
  authorityTombstoneHashOf,
  quarantineObjectName,
  textDigest,
  toUtcInstant,
} from "@kauro/domain";
import type { AuthorityTombstone, AuthorityTombstoneKind, AuthorityTombstoneState, SessionSecretBinding } from "../src/index.js";
import { AUTHORITY_TOMBSTONES } from "../src/index.js";
import {
  CONTRACT_FAKES,
  CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES,
  CONTRACT_FAKE_DEFAULT_RETENTION,
  CONTRACT_FAKE_JOURNAL_PROVIDER,
  CONTRACT_FAKE_SESSION_REF_PREFIX,
  CONTRACT_FAKE_STORAGE_PROVIDER,
  CONTRACT_FAKE_VAULT_AAD_PURPOSE,
  CONTRACT_FAKE_VAULT_KEY_REF,
  CONTRACT_FAKE_VAULT_PROVIDER,
  ContractFakeAuthorityJournal,
  ContractFakeJournalError,
  ContractFakeObjectStorage,
  ContractFakeSessionVault,
  ContractFakeStorageError,
  ContractFakeVaultRefusal,
  completionRefOf,
  contractFakeVaultTestKey,
  crc32cOf,
  providerChecksumsOf,
  type ContractFakeJournalErrorCode,
  type ContractFakeStorageErrorCode,
  type ContractFakeVaultRefusalReason,
} from "../src/testing/index.js";

/** 2026-09-01T00:00:00.000Z on the provider's clock. */
const T0 = Date.UTC(2026, 8, 1);
const HOUR_MS = 3_600_000;
const APPLICATION_DEADLINE_MS = SOURCE_RETENTION.uploadReservationSeconds * 1000;
const HORIZON_MS = PROVIDER_SESSION_LIFETIME_SECONDS * 1000;
const CHUNK = CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES;
const ORIGIN = "https://app.kauro.test";
/** The registry grammar of a provider token (stored_objects.provider, storage_location_policies.provider). */
const PROVIDER_TOKEN = /^[a-z][a-z0-9_-]{1,63}$/;

/** The provider's clock, moved only by the test. */
function providerClock(startMs = T0): { readonly clock: Clock; advance(ms: number): void; set(ms: number): void } {
  let now = startMs;
  return {
    clock: { now: () => toUtcInstant(now), nowMs: () => now },
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

/** A deterministic UUIDv7 per ordinal. */
function v7(n: number): string {
  return `0192a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

const AGENCY = v7(1) as AgencyId;
const OTHER_AGENCY = v7(2) as AgencyId;
const PROJECT = v7(3) as ProjectId;
const REVISION = v7(4) as RevisionId;

function quarantineName(upload: number, agency: AgencyId = AGENCY): string {
  return quarantineObjectName(agency, PROJECT, REVISION, v7(1000 + upload) as UploadId);
}

function content(bytes: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + seed) % 251);
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

function storageError(code: ContractFakeStorageErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ContractFakeStorageError && error.code === code && error.evidenceClass === "SIMULATED" && error.provider === CONTRACT_FAKE_STORAGE_PROVIDER;
}

function vaultRefusal(reason: ContractFakeVaultRefusalReason): (error: unknown) => boolean {
  return (error) => error instanceof ContractFakeVaultRefusal && error.reason === reason && error.evidenceClass === "SIMULATED";
}

function journalError(code: ContractFakeJournalErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ContractFakeJournalError && error.code === code && error.evidenceClass === "SIMULATED";
}

async function newSession(storage: ContractFakeObjectStorage, objectName: string, declaredBytes: number) {
  return storage.createResumableSession({ location: storage.location("QUARANTINE"), objectName, declaredBytes, contentType: "text/csv", origin: ORIGIN }, PROVIDER_CALL_TIMEOUT_MS);
}

test("the labelled object-storage fake keeps a resumable session usable past the application deadline until its provider horizon, answers cancellation CONFIRMED, UNSUPPORTED or UNCERTAIN as scripted, refuses an overwrite by generation precondition and reports its evidence class SIMULATED", async () => {
  const t = providerClock();
  const storage = new ContractFakeObjectStorage({ clock: t.clock });
  const quarantine = storage.location("QUARANTINE");
  assert.equal(storage.evidenceClass, "SIMULATED");
  assert.equal(storage.provider, CONTRACT_FAKE_STORAGE_PROVIDER);
  assert.match(storage.provider, /^contract-fake-/);
  assert.deepEqual(quarantine, { provider: "contract-fake-storage", locationRef: "QUARANTINE_PRIMARY" });
  assert.deepEqual(storage.capabilities(), { sessionCancellation: "SUPPORTED", sessionLifetimeSeconds: PROVIDER_SESSION_LIFETIME_SECONDS });

  // 1. The provider knows nothing of the application deadline (24 h from initiation): the bearer session stays usable past it and
  //    until the provider horizon (D-SESSION-3, 604,800 s by default), and not one instant longer.
  const declared = 2 * CHUNK + 10;
  const session = await newSession(storage, quarantineName(1), declared);
  assert.ok(session.sessionRef.startsWith(CONTRACT_FAKE_SESSION_REF_PREFIX), "an https session URI on the reserved .invalid domain");
  assert.equal(new URL(session.sessionRef).protocol, "https:");
  assert.equal(session.providerExpiresAt, toUtcInstant(T0 + HORIZON_MS));
  assert.equal(session.chunkMultipleBytes, CHUNK);
  t.advance(APPLICATION_DEADLINE_MS + 1);
  assert.equal(storage.sessionView(session.sessionRef)?.usable, true, "usable one millisecond past the application deadline");
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, content(CHUNK), { final: false }), { outcome: "IN_PROGRESS", receivedBytes: CHUNK });
  t.set(T0 + HORIZON_MS - 1);
  assert.equal(storage.sessionView(session.sessionRef)?.usable, true, "usable one millisecond before the horizon");
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, content(CHUNK, 2), { final: false }), { outcome: "IN_PROGRESS", receivedBytes: 2 * CHUNK });
  t.set(T0 + HORIZON_MS);
  assert.equal(storage.sessionView(session.sessionRef)?.usable, false, "unusable at the horizon");
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, content(10), { final: true }), { outcome: "REFUSED", reason: "SESSION_EXPIRED" });
  assert.equal(await storage.stat(quarantine, quarantineName(1)), null, "nothing was finalized");

  // The horizon is configurable, and a late object finalized through a session past the application deadline is an ordinary
  // provider object: it is the platform, not the provider, that must register it RESIDUAL and delete it (R2-051).
  const t2 = providerClock();
  const shortLived = new ContractFakeObjectStorage({ clock: t2.clock, sessionLifetimeSeconds: 2 * 86_400 });
  assert.deepEqual(shortLived.capabilities(), { sessionCancellation: "SUPPORTED", sessionLifetimeSeconds: 172_800 });
  const lateSession = await newSession(shortLived, quarantineName(2), 1_000);
  assert.equal(lateSession.providerExpiresAt, toUtcInstant(T0 + 172_800_000));
  t2.advance(APPLICATION_DEADLINE_MS + HOUR_MS);
  const late = shortLived.uploadThroughSession(lateSession.sessionRef, content(1_000, 7));
  assert.equal(late.outcome, "FINALIZED");
  const lateStat = await shortLived.stat(shortLived.location("QUARANTINE"), quarantineName(2));
  assert.equal(lateStat?.generation, late.outcome === "FINALIZED" ? late.generation : undefined);
  const expired = await newSession(shortLived, quarantineName(3), 10);
  t2.advance(172_800_000);
  assert.deepEqual(shortLived.uploadThroughSession(expired.sessionRef, content(10)), { outcome: "REFUSED", reason: "SESSION_EXPIRED" });

  // 2. Cancellation answers exactly what is scripted, and only a cancellation that took effect closes the session.
  t.set(T0);
  const unscripted = await newSession(storage, quarantineName(10), 10);
  assert.equal(await storage.cancelResumableSession(unscripted.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "CONFIRMED", "a SUPPORTED provider confirms by default");
  assert.deepEqual(storage.uploadThroughSession(unscripted.sessionRef, content(10)), { outcome: "REFUSED", reason: "SESSION_CANCELLED" });
  const [s1, s2, s3, s4] = [await newSession(storage, quarantineName(11), CHUNK + 1), await newSession(storage, quarantineName(12), CHUNK + 1), await newSession(storage, quarantineName(13), 10), await newSession(storage, quarantineName(14), 10)];
  storage.scriptCancellation("UNSUPPORTED", "UNCERTAIN", { answer: "UNCERTAIN", sessionCancelled: true }, "CONFIRMED");
  assert.equal(await storage.cancelResumableSession(s1.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "UNSUPPORTED");
  assert.equal(await storage.cancelResumableSession(s2.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "UNCERTAIN");
  assert.equal(await storage.cancelResumableSession(s3.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "UNCERTAIN");
  assert.equal(await storage.cancelResumableSession(s4.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "CONFIRMED");
  t.advance(APPLICATION_DEADLINE_MS + 1);
  // UNSUPPORTED and an UNCERTAIN answer that did not take effect leave a bearer session a holder can still write through until the
  // horizon — which is why the control plane reconciles them until then (§12.5 PROVIDER_SESSION_RECONCILIATION)
  assert.deepEqual(storage.writeThroughSession(s1.sessionRef, content(CHUNK), { final: false }), { outcome: "IN_PROGRESS", receivedBytes: CHUNK });
  assert.deepEqual(storage.writeThroughSession(s2.sessionRef, content(CHUNK), { final: false }), { outcome: "IN_PROGRESS", receivedBytes: CHUNK });
  assert.deepEqual(storage.uploadThroughSession(s3.sessionRef, content(10)), { outcome: "REFUSED", reason: "SESSION_CANCELLED" }, "UNCERTAIN whose cancellation took effect");
  assert.deepEqual(storage.uploadThroughSession(s4.sessionRef, content(10)), { outcome: "REFUSED", reason: "SESSION_CANCELLED" });
  assert.deepEqual(
    [s1, s2, s3, s4].map((s) => {
      const view = storage.sessionView(s.sessionRef);
      return [view?.state, view?.usable, view?.cancellationAnswers];
    }),
    [
      ["OPEN", true, ["UNSUPPORTED"]],
      ["OPEN", true, ["UNCERTAIN"]],
      ["CANCELLED", false, ["UNCERTAIN"]],
      ["CANCELLED", false, ["CONFIRMED"]],
    ],
  );
  t.set(T0 + HORIZON_MS);
  assert.deepEqual(storage.writeThroughSession(s2.sessionRef, content(1), { final: true }), { outcome: "REFUSED", reason: "SESSION_EXPIRED" }, "reconciled by the horizon");
  // a provider without session cancellation answers UNSUPPORTED, and can be scripted to answer nothing it cannot answer
  const t3 = providerClock();
  const noCancel = new ContractFakeObjectStorage({ clock: t3.clock, sessionCancellation: "UNSUPPORTED" });
  assert.equal(noCancel.capabilities().sessionCancellation, "UNSUPPORTED");
  const ns = await newSession(noCancel, quarantineName(20), 10);
  assert.equal(await noCancel.cancelResumableSession(ns.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "UNSUPPORTED");
  assert.throws(() => noCancel.scriptCancellation("CONFIRMED"), RangeError);
  assert.throws(() => noCancel.scriptCancellation({ answer: "UNCERTAIN", sessionCancelled: true }), RangeError);
  noCancel.scriptCancellation("UNCERTAIN");
  assert.equal(await noCancel.cancelResumableSession(ns.sessionRef, PROVIDER_CALL_TIMEOUT_MS), "UNCERTAIN");
  t3.advance(APPLICATION_DEADLINE_MS + 1);
  assert.equal(noCancel.uploadThroughSession(ns.sessionRef, content(10)).outcome, "FINALIZED", "a session the provider cannot cancel outlives the deadline");
  assert.throws(() => storage.failNext("cancelResumableSession", { code: "UNAVAILABLE" }), RangeError, "a cancellation answers; its loss is UNCERTAIN");
  await assert.rejects(storage.cancelResumableSession(`${CONTRACT_FAKE_SESSION_REF_PREFIX}${v7(99)}`, PROVIDER_CALL_TIMEOUT_MS), storageError("UNKNOWN_SESSION"));

  // 3. Every platform write carries a no-overwrite precondition: a second session to a name that holds a live object fails at
  //    finalization, a copy to such a name is refused, and a delete of another generation than the live one is PRECONDITION_FAILED.
  t.set(T0);
  const first = await newSession(storage, quarantineName(30), 64);
  const firstDone = storage.uploadThroughSession(first.sessionRef, content(64, 3));
  assert.equal(firstDone.outcome, "FINALIZED");
  const g1 = firstDone.outcome === "FINALIZED" ? firstDone.generation : "";
  const second = await newSession(storage, quarantineName(30), 64);
  assert.deepEqual(storage.uploadThroughSession(second.sessionRef, content(64, 4)), { outcome: "REFUSED", reason: "PRECONDITION_FAILED" });
  assert.equal(storage.sessionView(second.sessionRef)?.state, "FAILED");
  assert.deepEqual(storage.uploadThroughSession(second.sessionRef, content(64, 4)), { outcome: "REFUSED", reason: "SESSION_CLOSED" });
  const accepted = storage.location("ACCEPTED");
  const acceptedName = acceptedObjectName(AGENCY, PROJECT, v7(500) as SourceFileId);
  const promoted = await storage.copy({ location: quarantine, objectName: quarantineName(30), generation: g1 }, { location: accepted, objectName: acceptedName });
  assert.notEqual(promoted.generation, g1);
  assert.deepEqual(await drain(storage.read(accepted, acceptedName, promoted.generation)), content(64, 3));
  await assert.rejects(storage.copy({ location: quarantine, objectName: quarantineName(30), generation: g1 }, { location: accepted, objectName: acceptedName }), storageError("PRECONDITION_FAILED"));
  assert.equal(await storage.delete(quarantine, quarantineName(30), String(BigInt(g1) + 1n)), "PRECONDITION_FAILED");
  assert.deepEqual(
    storage.generationsOf(quarantine, quarantineName(30)).map((g) => [g.generation, g.status, g.origin]),
    [[g1, "LIVE", "SESSION"]],
    "the refused session, copy and delete changed nothing",
  );
  assert.deepEqual(storage.generationsOf(accepted, acceptedName).map((g) => [g.generation, g.status, g.origin]), [[promoted.generation, "LIVE", "COPY"]]);

  // 4. Labelled SIMULATED everywhere: the port, every location, every logged call, every error and every view.
  for (const call of storage.calls()) assert.deepEqual([call.provider, call.evidenceClass], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED"]);
  for (const view of storage.sessionViews()) assert.deepEqual([view.provider, view.evidenceClass], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED"]);
  for (const g of storage.generationsOf(accepted, acceptedName)) assert.deepEqual([g.provider, g.evidenceClass], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED"]);
  assert.match(storage.provider, PROVIDER_TOKEN);
  // the call log never holds a bearer session reference: only its SHA-256
  const log = JSON.stringify(storage.calls());
  for (const s of [session, s1, s2, s3, s4, first, second]) assert.ok(!log.includes(s.sessionRef), "no bearer reference in the call log");
  assert.ok(log.includes(textDigest(s1.sessionRef)));
});

test("the labelled object-storage fake reads and copies only an exact generation, deletes by generation (DELETED, ALREADY_ABSENT, PRECONDITION_FAILED) and keeps a deleted generation soft-deleted for the retention its read-back reports; a later policy change never shortens a retention already applied", async () => {
  const t = providerClock();
  const storage = new ContractFakeObjectStorage({ clock: t.clock });
  const quarantine = storage.location("QUARANTINE");
  const name = quarantineName(1);

  // the retention read-back: the location's policy and the SHA-256 of the raw read-back document, labelled
  const defaultReadBack = await storage.readRetentionPolicy(quarantine);
  assert.deepEqual(
    { seconds: defaultReadBack.softDeleteRetentionSeconds, versioning: defaultReadBack.objectVersioning, observedAt: defaultReadBack.observedAt },
    { seconds: CONTRACT_FAKE_DEFAULT_RETENTION.softDeleteRetentionSeconds, versioning: false, observedAt: toUtcInstant(T0) },
  );
  assert.ok(isSha256Hex(defaultReadBack.evidenceHash));
  const document = storage.retentionReadBack(defaultReadBack.evidenceHash);
  assert.ok(document);
  assert.equal(rawDigest(canonicalBytes(document)), defaultReadBack.evidenceHash);
  assert.deepEqual([document.provider, document.evidenceClass, document.locationRef], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED", "QUARANTINE_PRIMARY"]);
  storage.setRetentionPolicy("QUARANTINE", { softDeleteRetentionSeconds: 86_400, objectVersioning: false });
  const dayReadBack = await storage.readRetentionPolicy(quarantine);
  assert.equal(dayReadBack.softDeleteRetentionSeconds, 86_400);
  assert.notEqual(dayReadBack.evidenceHash, defaultReadBack.evidenceHash);
  assert.throws(() => storage.setRetentionPolicy("QUARANTINE", { softDeleteRetentionSeconds: 7_776_001, objectVersioning: false }), RangeError, "the registry bound: 0..90 days");

  // stat reports the live generation with the provider checksums (CRC32C big-endian and MD5, base64)
  const bytes = content(5_000, 9);
  const { generation: g1 } = storage.plantObject(quarantine, name, bytes);
  const observed = await storage.stat(quarantine, name);
  assert.deepEqual(observed, { generation: g1, bytes: 5_000, ...providerChecksumsOf(bytes), observedAt: toUtcInstant(T0), temporaryHold: false });
  assert.equal(crc32cOf(new TextEncoder().encode("123456789")), 0xe3069283, "the CRC-32C check value");
  // reads and copies name an exact generation
  assert.deepEqual(await drain(storage.read(quarantine, name, g1)), bytes);
  await assert.rejects(drain(storage.read(quarantine, name, String(BigInt(g1) + 1n))), storageError("GENERATION_NOT_FOUND"));
  await assert.rejects(storage.copy({ location: quarantine, objectName: name, generation: String(BigInt(g1) + 1n) }, { location: storage.location("ACCEPTED"), objectName: acceptedObjectName(AGENCY, PROJECT, v7(501) as SourceFileId) }), storageError("GENERATION_NOT_FOUND"));

  // delete by generation: the generation is soft-deleted for the retention at the instant of its deletion
  t.advance(HOUR_MS);
  const deletedAt = T0 + HOUR_MS;
  assert.equal(await storage.delete(quarantine, name, g1), "DELETED");
  assert.equal(await storage.stat(quarantine, name), null, "a missing object is a successful absence check");
  await assert.rejects(drain(storage.read(quarantine, name, g1)), storageError("GENERATION_NOT_FOUND"), "a soft-deleted generation is not served");
  assert.equal(await storage.delete(quarantine, name, g1), "ALREADY_ABSENT");
  storage.setRetentionPolicy("QUARANTINE", { softDeleteRetentionSeconds: 0, objectVersioning: false });
  const prefix = `quarantine/${AGENCY}/`;
  assert.deepEqual((await storage.listSoftDeleted(quarantine, prefix)).objects, [{ objectName: name, generation: g1, softDeletedAt: toUtcInstant(deletedAt), expiresAt: toUtcInstant(deletedAt + 86_400_000) }], "the retention applied at deletion, never shortened by a later policy");
  // a name that now holds another generation: deleting the old one is PRECONDITION_FAILED, never reported as a deletion
  storage.setRetentionPolicy("QUARANTINE", { softDeleteRetentionSeconds: 86_400, objectVersioning: false });
  const { generation: g2 } = storage.plantObject(quarantine, name, content(10, 2));
  assert.equal(await storage.delete(quarantine, name, g1), "PRECONDITION_FAILED");
  assert.equal((await storage.stat(quarantine, name))?.generation, g2);
  // at the provider's expiry the soft-deleted generation is purged
  t.set(deletedAt + 86_400_000 - 1);
  assert.equal((await storage.listSoftDeleted(quarantine, prefix)).objects.length, 1);
  t.set(deletedAt + 86_400_000);
  assert.deepEqual((await storage.listSoftDeleted(quarantine, prefix)).objects, []);
  assert.deepEqual(storage.generationsOf(quarantine, name).map((g) => [g.generation, g.status]), [[g1, "PURGED"], [g2, "LIVE"]]);
  // zero retention: a deletion leaves nothing soft-deleted (the registry records no provider residual, D-OBJ-2)
  storage.setRetentionPolicy("QUARANTINE", { softDeleteRetentionSeconds: 0, objectVersioning: false });
  assert.equal((await storage.readRetentionPolicy(quarantine)).softDeleteRetentionSeconds, 0);
  assert.equal(await storage.delete(quarantine, name, g2), "DELETED");
  assert.deepEqual((await storage.listSoftDeleted(quarantine, prefix)).objects, []);
  assert.deepEqual(storage.generationsOf(quarantine, name).map((g) => g.status), ["PURGED", "PURGED"]);

  // versioning: an overwritten generation stays readable as noncurrent until deleted by its generation
  const accepted = storage.location("ACCEPTED");
  storage.setRetentionPolicy("ACCEPTED", { softDeleteRetentionSeconds: 604_800, objectVersioning: true });
  const acceptedName = acceptedObjectName(AGENCY, PROJECT, v7(502) as SourceFileId);
  const { generation: a1 } = storage.plantObject(accepted, acceptedName, content(20, 1));
  const { generation: a2 } = storage.plantObject(accepted, acceptedName, content(20, 2), { overwrite: true });
  assert.equal((await storage.stat(accepted, acceptedName))?.generation, a2);
  assert.deepEqual(await drain(storage.read(accepted, acceptedName, a1)), content(20, 1), "noncurrent, exact generation");
  assert.equal(await storage.delete(accepted, acceptedName, a1), "DELETED");
  assert.deepEqual(storage.generationsOf(accepted, acceptedName).map((g) => [g.generation, g.status]), [[a1, "SOFT_DELETED"], [a2, "LIVE"]]);
  assert.throws(() => storage.plantObject(accepted, acceptedName, content(1)), storageError("PRECONDITION_FAILED"));
  // a location this provider never handed out
  await assert.rejects(storage.stat({ provider: "another-provider", locationRef: "QUARANTINE_PRIMARY" }, name), storageError("UNKNOWN_LOCATION"));
  await assert.rejects(storage.readRetentionPolicy({ provider: CONTRACT_FAKE_STORAGE_PROVIDER, locationRef: "NOT_A_LOCATION" }), storageError("UNKNOWN_LOCATION"));
});

test("the labelled object-storage fake lists live objects and soft-deleted generations by prefix in pages, logs every provider call without the bearer session reference, holds a call until the test releases it and applies scripted faults — UNAVAILABLE before any effect, TIMEOUT with or without its effect", async () => {
  const t = providerClock();
  const storage = new ContractFakeObjectStorage({ clock: t.clock, listPageSize: 2 });
  const quarantine = storage.location("QUARANTINE");
  const names = [5, 3, 1, 4, 2].map((n) => quarantineName(n));
  for (const n of names) storage.plantObject(quarantine, n, content(n.length));
  storage.plantObject(quarantine, quarantineName(9, OTHER_AGENCY), content(1));
  const prefix = `quarantine/${AGENCY}/`;
  const listed: string[] = [];
  let page: string | undefined;
  let pages = 0;
  do {
    const answer = await storage.list(quarantine, prefix, page);
    listed.push(...answer.objects.map((o) => o.objectName));
    page = answer.next;
    if (page !== undefined) assert.match(page, /^contract-fake-storage:page:/);
    pages += 1;
  } while (page !== undefined);
  assert.equal(pages, 3);
  assert.deepEqual(listed, [...names].sort(), "every live object of the prefix once, in name order; the other agency's never");
  await assert.rejects(storage.list(quarantine, prefix, "not-a-token"), storageError("INVALID_REQUEST"));
  for (const n of names.slice(0, 3)) {
    const live = await storage.stat(quarantine, n);
    assert.equal(await storage.delete(quarantine, n, live!.generation), "DELETED");
  }
  const first = await storage.listSoftDeleted(quarantine, prefix);
  assert.equal(first.objects.length, 2);
  const rest = await storage.listSoftDeleted(quarantine, prefix, first.next);
  assert.deepEqual([...first.objects, ...rest.objects].map((o) => o.objectName), names.slice(0, 3).sort());
  assert.equal(rest.next, undefined);

  // a hold point pauses the call on arrival: the test fixes what the provider holds when the call proceeds
  const name = quarantineName(40);
  const hold = storage.holdNext("stat");
  const pending = storage.stat(quarantine, name);
  await hold.reached;
  assert.equal(storage.calls("stat").at(-1)?.outcome, "PENDING");
  const { generation } = storage.plantObject(quarantine, name, content(3));
  hold.release();
  assert.equal((await pending)?.generation, generation);
  assert.equal(storage.calls("stat").at(-1)?.outcome, `PRESENT ${generation}`);

  // scripted faults: UNAVAILABLE and an unapplied TIMEOUT leave nothing; an applied TIMEOUT lost only the answer, and the retry is
  // refused by the no-overwrite precondition instead of creating a second generation
  const accepted = storage.location("ACCEPTED");
  const target = acceptedObjectName(AGENCY, PROJECT, v7(600) as SourceFileId);
  const source = { location: quarantine, objectName: name, generation };
  storage.failNext("copy", { code: "UNAVAILABLE" });
  await assert.rejects(storage.copy(source, { location: accepted, objectName: target }), (e: unknown) => storageError("UNAVAILABLE")(e) && (e as ContractFakeStorageError).transient);
  assert.equal(await storage.stat(accepted, target), null);
  storage.failNext("copy", { code: "TIMEOUT", applied: false });
  await assert.rejects(storage.copy(source, { location: accepted, objectName: target }), storageError("TIMEOUT"));
  assert.equal(await storage.stat(accepted, target), null);
  storage.failNext("copy", { code: "TIMEOUT", applied: true });
  await assert.rejects(storage.copy(source, { location: accepted, objectName: target }), storageError("TIMEOUT"));
  const applied = await storage.stat(accepted, target);
  assert.ok(applied, "the provider acted and the answer was lost");
  await assert.rejects(storage.copy(source, { location: accepted, objectName: target }), storageError("PRECONDITION_FAILED"));
  assert.deepEqual(
    storage.calls("copy").map((c) => c.outcome),
    ["FAILED UNAVAILABLE", "FAILED TIMEOUT", `COPIED ${applied.generation}; answer lost (TIMEOUT)`, "FAILED PRECONDITION_FAILED"],
  );

  // the call log: every provider call in arrival order, labelled, never a bearer session reference
  const session = await newSession(storage, quarantineName(50), 10);
  await storage.cancelResumableSession(session.sessionRef, PROVIDER_CALL_TIMEOUT_MS);
  const calls = storage.calls();
  assert.deepEqual(calls.map((c) => c.sequence), calls.map((_, i) => i + 1));
  const created = storage.calls("createResumableSession").at(-1);
  assert.equal(created?.outcome, `SESSION ${textDigest(session.sessionRef)}`);
  assert.equal(created?.request["origin"], ORIGIN);
  assert.equal(storage.calls("cancelResumableSession").at(-1)?.request["sessionDigest"], textDigest(session.sessionRef));
  assert.ok(!JSON.stringify(calls).includes(session.sessionRef));
  for (const c of calls) assert.deepEqual([c.provider, c.evidenceClass], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED"]);
});

test("the labelled object-storage fake answers a finalized session with the completion reference the storage port parses into a claim — a forged generation, size or hash is still only a claim the observation contradicts, a foreign or malformed reference is MALFORMED — and refuses a misaligned chunk, a length other than declared and a destination outside the platform grammar", async () => {
  const t = providerClock();
  const storage = new ContractFakeObjectStorage({ clock: t.clock });
  const quarantine = storage.location("QUARANTINE");
  const bytes = content(CHUNK + 100, 5);
  const session = await newSession(storage, quarantineName(1), bytes.length);
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, bytes.subarray(0, CHUNK - 1), { final: false }), { outcome: "REFUSED", reason: "CHUNK_NOT_ALIGNED" });
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, bytes.subarray(0, 10), { final: true }), { outcome: "REFUSED", reason: "LENGTH_MISMATCH" });
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, content(bytes.length + 1), { final: true }), { outcome: "REFUSED", reason: "LENGTH_MISMATCH" });
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, bytes.subarray(0, CHUNK), { final: false }), { outcome: "IN_PROGRESS", receivedBytes: CHUNK });
  const done = storage.writeThroughSession(session.sessionRef, bytes.subarray(CHUNK), { final: true });
  assert.equal(done.outcome, "FINALIZED");
  if (done.outcome !== "FINALIZED") return;
  assert.deepEqual(storage.writeThroughSession(session.sessionRef, content(1), { final: true }), { outcome: "REFUSED", reason: "SESSION_CLOSED" });
  assert.deepEqual(storage.uploadThroughSession(`${CONTRACT_FAKE_SESSION_REF_PREFIX}${v7(77)}`, content(1)), { outcome: "REFUSED", reason: "UNKNOWN_SESSION" });
  const observed = await storage.stat(quarantine, quarantineName(1));
  assert.deepEqual(await drain(storage.read(quarantine, quarantineName(1), done.generation)), bytes);

  const parsed = storage.parseCompletionClaim(done.completionRef);
  assert.deepEqual(parsed, { kind: "CLAIM", claim: { generation: done.generation, bytes: bytes.length, crc32c: observed?.crc32c, md5: observed?.md5 } });
  // S053: a forged reference parses as a claim — the server's own observation (stat, read, digest) is what decides
  const forged = storage.parseCompletionClaim(completionRefOf({ generation: String(BigInt(done.generation) + 5n), bytes: 1, md5: providerChecksumsOf(content(1)).md5 }));
  assert.equal(forged.kind, "CLAIM");
  assert.notEqual(forged.kind === "CLAIM" ? forged.claim.generation : "", observed?.generation);
  const malformed = [
    "",
    "x".repeat(4_097),
    "not json",
    '{"generation":"1","kind":"storage#object","size":"1"}',
    '{"generation":"1","generation":"2","kind":"contract-fake-storage#object","size":"1"}',
    '{"extra":"1","generation":"1","kind":"contract-fake-storage#object","size":"1"}',
    '{"generation":"0","kind":"contract-fake-storage#object","size":"1"}',
    '{"generation":"1","kind":"contract-fake-storage#object","size":"-1"}',
    '{"generation":"1","kind":"contract-fake-storage#object","size":1}',
    '{"crc32c":"AAAA","generation":"1","kind":"contract-fake-storage#object","size":"1"}',
    "[]",
  ];
  for (const ref of malformed) assert.deepEqual(storage.parseCompletionClaim(ref), { kind: "MALFORMED" }, ref.slice(0, 60));
  // the platform's own grammar: an opaque object name, a positive length, a URL origin
  await assert.rejects(storage.createResumableSession({ location: quarantine, objectName: "quarantine/customer-file.csv", declaredBytes: 1, contentType: "text/csv", origin: ORIGIN }, 1), storageError("INVALID_REQUEST"));
  await assert.rejects(storage.createResumableSession({ location: quarantine, objectName: quarantineName(2), declaredBytes: 0, contentType: "text/csv", origin: ORIGIN }, 1), storageError("INVALID_REQUEST"));
  await assert.rejects(storage.createResumableSession({ location: quarantine, objectName: quarantineName(2), declaredBytes: 1, contentType: "text/csv", origin: `${ORIGIN}/path` }, 1), storageError("INVALID_REQUEST"));
});

test("the labelled object-storage fake places a temporary hold on exactly the live generation under a generation precondition (another generation or none: GENERATION_NOT_LIVE, nothing held) and, while it is held, refuses every deletion and replacement of it — the port's delete, an out-of-band overwrite or deletion, a session finalizing or a copy onto its name — with OBJECT_HELD and nothing changed; released (idempotently, never another generation), the same deletion proceeds; the hold calls take hold points and scripted faults like every call (B07-R1, D-HOLD-1)", async () => {
  const t = providerClock();
  const storage = new ContractFakeObjectStorage({ clock: t.clock });
  const accepted = storage.location("ACCEPTED");
  const quarantine = storage.location("QUARANTINE");
  const name = acceptedObjectName(AGENCY, PROJECT, v7(700) as SourceFileId);
  const first = storage.plantObject(accepted, name, content(64, 1));

  // the precondition: a generation that is not the live one, or a name without a live object, is never held
  assert.deepEqual(await storage.placeHold(accepted, name, "123456"), { outcome: "GENERATION_NOT_LIVE" });
  assert.deepEqual(await storage.placeHold(accepted, acceptedObjectName(AGENCY, PROJECT, v7(701) as SourceFileId), first.generation), { outcome: "GENERATION_NOT_LIVE" });
  assert.deepEqual(storage.generationsOf(accepted, name).map((g) => g.temporaryHold), [false]);
  await assert.rejects(storage.placeHold(accepted, name, "not-a-generation"), storageError("INVALID_REQUEST"));

  // held: the answer observes the held generation and its length; placing it again is HELD again (a flag, not a count)
  const held = await storage.placeHold(accepted, name, first.generation);
  assert.equal(held.outcome, "HELD");
  if (held.outcome !== "HELD") throw new Error("unreachable");
  assert.deepEqual([held.observation.generation, held.observation.bytes, held.observation.observedAt], [first.generation, 64, toUtcInstant(T0)]);
  assert.equal((await storage.placeHold(accepted, name, first.generation)).outcome, "HELD");
  assert.deepEqual(storage.generationsOf(accepted, name).map((g) => [g.generation, g.status, g.temporaryHold]), [[first.generation, "LIVE", true]]);

  // every deletion and replacement of the held generation is refused, and nothing changed
  await assert.rejects(storage.delete(accepted, name, first.generation), storageError("OBJECT_HELD"));
  assert.throws(() => storage.plantObject(accepted, name, content(8, 2), { overwrite: true }), storageError("OBJECT_HELD"));
  assert.throws(() => storage.deleteOutOfBand(accepted, name), storageError("OBJECT_HELD"));
  await assert.rejects(storage.copy({ location: accepted, objectName: name, generation: first.generation }, { location: accepted, objectName: name }), storageError("PRECONDITION_FAILED"));
  const onto = await storage.createResumableSession({ location: accepted, objectName: name, declaredBytes: 4, contentType: "text/csv", origin: ORIGIN }, PROVIDER_CALL_TIMEOUT_MS);
  assert.deepEqual(storage.uploadThroughSession(onto.sessionRef, content(4, 3)), { outcome: "REFUSED", reason: "PRECONDITION_FAILED" });
  assert.deepEqual(storage.generationsOf(accepted, name).map((g) => [g.generation, g.status, g.temporaryHold]), [[first.generation, "LIVE", true]]);
  assert.deepEqual((await storage.stat(accepted, name))?.generation, first.generation);
  assert.deepEqual(await drain(storage.read(accepted, name, first.generation)), content(64, 1), "a hold changes no byte and still serves reads");
  assert.deepEqual(storage.calls("delete").map((c) => c.outcome), ["FAILED OBJECT_HELD"]);

  // releasing another generation touches nothing; releasing the held one clears it (idempotently), then the deletion proceeds
  assert.equal(await storage.releaseHold(accepted, name, "123456"), "ABSENT");
  assert.equal(storage.generationsOf(accepted, name)[0]?.temporaryHold, true);
  assert.equal(await storage.releaseHold(accepted, name, first.generation), "RELEASED");
  assert.equal(await storage.releaseHold(accepted, name, first.generation), "RELEASED");
  assert.equal(storage.generationsOf(accepted, name)[0]?.temporaryHold, false);
  assert.equal(await storage.delete(accepted, name, first.generation), "DELETED");
  assert.equal(await storage.releaseHold(accepted, name, first.generation), "ABSENT", "a deleted generation has nothing to release");
  assert.deepEqual(storage.generationsOf(accepted, name).map((g) => [g.status, g.temporaryHold]), [["SOFT_DELETED", false]]);

  // a replacement before the hold is placed wins, and the hold's precondition then fails: the provider never holds a vanished generation
  const other = acceptedObjectName(AGENCY, PROJECT, v7(702) as SourceFileId);
  const original = storage.plantObject(accepted, other, content(16, 4));
  const hold = storage.holdNext("placeHold");
  const placing = storage.placeHold(accepted, other, original.generation);
  await hold.reached;
  assert.equal(storage.calls("placeHold").at(-1)?.outcome, "PENDING");
  const replacement = storage.plantObject(accepted, other, content(16, 5), { overwrite: true });
  hold.release();
  assert.deepEqual(await placing, { outcome: "GENERATION_NOT_LIVE" });
  assert.deepEqual(storage.generationsOf(accepted, other).map((g) => [g.generation, g.status, g.temporaryHold]), [[original.generation, "SOFT_DELETED", false], [replacement.generation, "LIVE", false]]);

  // scripted faults: UNAVAILABLE holds nothing; an applied TIMEOUT held it and lost the answer (the caller releases what it may have held)
  storage.failNext("placeHold", { code: "UNAVAILABLE" });
  await assert.rejects(storage.placeHold(accepted, other, replacement.generation), storageError("UNAVAILABLE"));
  assert.equal(storage.generationsOf(accepted, other).at(-1)?.temporaryHold, false);
  storage.failNext("placeHold", { code: "TIMEOUT", applied: true });
  await assert.rejects(storage.placeHold(accepted, other, replacement.generation), storageError("TIMEOUT"));
  assert.equal(storage.generationsOf(accepted, other).at(-1)?.temporaryHold, true, "the provider acted and the answer was lost");
  storage.failNext("releaseHold", { code: "UNAVAILABLE" });
  await assert.rejects(storage.releaseHold(accepted, other, replacement.generation), storageError("UNAVAILABLE"));
  assert.equal(storage.generationsOf(accepted, other).at(-1)?.temporaryHold, true);
  assert.equal(await storage.releaseHold(accepted, other, replacement.generation), "RELEASED");
  assert.deepEqual(
    storage.calls("placeHold").map((c) => c.outcome).slice(-3),
    ["GENERATION_NOT_LIVE", "FAILED UNAVAILABLE", `HELD ${replacement.generation}; answer lost (TIMEOUT)`],
  );
  // a hold is a property of the accepted generation, not of a zone: a quarantine object takes one the same way
  const q = storage.plantObject(quarantine, quarantineName(70), content(4, 6));
  assert.equal((await storage.placeHold(quarantine, quarantineName(70), q.generation)).outcome, "HELD");
  for (const c of storage.calls()) assert.deepEqual([c.provider, c.evidenceClass], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED"]);
});

test("the labelled object-storage fake reports a generation's temporary hold as the provider's object resource does — stat and a HELD placement carry temporaryHold — and keeps the hold a flag with no incarnation, exactly the provider's: a release held at the provider (hold point on releaseHold) that lands after a newer placement clears that newer hold, so the platform claims every release and waits out its in-flight bound before it intends a hold (B07-R1 second re-check, D-HOLD-2, D-HOLD-3)", async () => {
  const t = providerClock();
  const storage = new ContractFakeObjectStorage({ clock: t.clock });
  const accepted = storage.location("ACCEPTED");
  const name = acceptedObjectName(AGENCY, PROJECT, v7(710) as SourceFileId);
  const planted = storage.plantObject(accepted, name, content(32, 7));

  // the hold is reported: unheld, held (the placement's own observation and a later stat), released
  assert.equal((await storage.stat(accepted, name))?.temporaryHold, false);
  const held = await storage.placeHold(accepted, name, planted.generation);
  assert.equal(held.outcome === "HELD" && held.observation.temporaryHold, true);
  assert.deepEqual([(await storage.stat(accepted, name))?.generation, (await storage.stat(accepted, name))?.temporaryHold], [planted.generation, true]);
  assert.equal(storage.calls("stat").at(-1)?.outcome, `PRESENT ${planted.generation} HELD`);

  // a release sent earlier and held at the provider lands after a newer placement: it clears the newer hold (no incarnation)
  const late = storage.holdNext("releaseHold");
  const releasing = storage.releaseHold(accepted, name, planted.generation);
  await late.reached;
  assert.equal(storage.calls("releaseHold").at(-1)?.outcome, "PENDING");
  assert.equal((await storage.placeHold(accepted, name, planted.generation)).outcome, "HELD", "the newer placement");
  late.release();
  assert.equal(await releasing, "RELEASED");
  assert.equal((await storage.stat(accepted, name))?.temporaryHold, false, "the late release cleared the newer hold");
  const replaced = storage.plantObject(accepted, name, content(32, 8), { overwrite: true });
  assert.deepEqual(storage.generationsOf(accepted, name).map((g) => [g.generation, g.status]), [[planted.generation, "SOFT_DELETED"], [replaced.generation, "LIVE"]]);
});

test("the labelled session-vault fake seals a session reference with AES-256-GCM under its test key, the binding — agency, upload, requester, attempt — as associated data, and refuses to open it under another binding, another key or a tampered secret, never returning another upload's plaintext; evidence class SIMULATED", async () => {
  const vault = new ContractFakeSessionVault();
  assert.deepEqual([vault.provider, vault.evidenceClass, vault.keyRef], [CONTRACT_FAKE_VAULT_PROVIDER, "SIMULATED", CONTRACT_FAKE_VAULT_KEY_REF]);
  assert.match(vault.keyRef, /^[a-z][a-z0-9_.:/-]{2,127}$/, "the registry grammar of upload_session_secrets.key_ref");
  const binding: SessionSecretBinding = { agencyId: AGENCY, uploadId: v7(1001) as UploadId, requestedByUserId: "6f1c2d3e-4b5a-5c6d-8e7f-0123456789ab" as UserId, sessionAttempt: 1 };
  const sessionRef = `${CONTRACT_FAKE_SESSION_REF_PREFIX}${v7(4242)}`;
  const sealed = await vault.seal(sessionRef, binding);
  const plaintext = new TextEncoder().encode(sessionRef);
  assert.equal(sealed.keyRef, CONTRACT_FAKE_VAULT_KEY_REF);
  assert.equal(sealed.nonce.length, 12);
  assert.equal(sealed.ciphertext.length, plaintext.length + 16, "ciphertext and the 16-byte tag");
  assert.ok(!Buffer.from(sealed.ciphertext).includes(Buffer.from(plaintext.subarray(0, 16))), "no plaintext in the sealed secret");
  assert.equal(await vault.open(sealed, binding), sessionRef);
  // independently: AES-256-GCM under the labelled test key, the associated data exactly the key identity and the binding
  const decipher = createDecipheriv("aes-256-gcm", contractFakeVaultTestKey(CONTRACT_FAKE_VAULT_KEY_REF), sealed.nonce, { authTagLength: 16 });
  decipher.setAAD(canonicalBytes({ purpose: CONTRACT_FAKE_VAULT_AAD_PURPOSE, keyRef: CONTRACT_FAKE_VAULT_KEY_REF, agencyId: binding.agencyId, uploadId: binding.uploadId, requestedByUserId: binding.requestedByUserId, sessionAttempt: binding.sessionAttempt }));
  decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - 16));
  assert.equal(Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16)), decipher.final()]).toString("utf8"), sessionRef);
  // a fresh nonce per seal
  const again = await vault.seal(sessionRef, binding);
  assert.notDeepEqual(again.nonce, sealed.nonce);
  assert.notDeepEqual(again.ciphertext, sealed.ciphertext);

  // another binding member each: authentication fails and no plaintext is returned
  const others: ReadonlyArray<[string, SessionSecretBinding]> = [
    ["agency", { ...binding, agencyId: OTHER_AGENCY }],
    ["upload", { ...binding, uploadId: v7(1002) as UploadId }],
    ["requester", { ...binding, requestedByUserId: "6f1c2d3e-4b5a-5c6d-8e7f-0123456789ac" as UserId }],
    ["attempt", { ...binding, sessionAttempt: 2 }],
  ];
  for (const [member, other] of others) {
    await assert.rejects(vault.open(sealed, other), (e: unknown) => vaultRefusal("AUTHENTICATION_FAILED")(e) && !(e as Error).message.includes(sessionRef), member);
  }
  // another upload's secret under this upload's binding (a swapped row) never opens
  const neighbour = { ...binding, uploadId: v7(1003) as UploadId };
  const neighbourSealed = await vault.seal(`${CONTRACT_FAKE_SESSION_REF_PREFIX}${v7(4343)}`, neighbour);
  await assert.rejects(vault.open(neighbourSealed, binding), vaultRefusal("AUTHENTICATION_FAILED"));
  // another key: the other vault does not hold this key; relabelled, the tag still fails
  const otherVault = new ContractFakeSessionVault({ keyRef: "contract-fake-vault/aes-256-gcm/test-key-2" });
  await assert.rejects(otherVault.open(sealed, binding), vaultRefusal("UNKNOWN_KEY"));
  await assert.rejects(otherVault.open({ ...sealed, keyRef: otherVault.keyRef }, binding), vaultRefusal("AUTHENTICATION_FAILED"));
  assert.throws(() => new ContractFakeSessionVault({ keyRef: "kms/production-key" }), RangeError, "a fake key ref is labelled");
  // tampering
  const flipped = new Uint8Array(sealed.ciphertext);
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  await assert.rejects(vault.open({ ...sealed, ciphertext: flipped }, binding), vaultRefusal("AUTHENTICATION_FAILED"));
  const nonce = new Uint8Array(sealed.nonce);
  nonce[11] = (nonce[11] ?? 0) ^ 1;
  await assert.rejects(vault.open({ ...sealed, nonce }, binding), vaultRefusal("AUTHENTICATION_FAILED"));
  await assert.rejects(vault.open({ ...sealed, nonce: sealed.nonce.subarray(0, 11) }, binding), vaultRefusal("MALFORMED"));
  await assert.rejects(vault.open({ ...sealed, ciphertext: sealed.ciphertext.subarray(0, 16) }, binding), vaultRefusal("MALFORMED"));
  await assert.rejects(vault.seal(sessionRef, { ...binding, sessionAttempt: 0 }), vaultRefusal("MALFORMED"));
  // the registry bounds of a sealed secret: 17..8,192 bytes with the tag
  await assert.rejects(vault.seal("", binding), vaultRefusal("PLAINTEXT_OUT_OF_BOUNDS"));
  await assert.rejects(vault.seal("x".repeat(8_177), binding), vaultRefusal("PLAINTEXT_OUT_OF_BOUNDS"));
  assert.equal((await vault.seal("x".repeat(8_176), binding)).ciphertext.length, 8_192);
  // the vault's log names uploads and attempts only
  const log = vault.calls();
  assert.ok(!JSON.stringify(log).includes(sessionRef));
  assert.deepEqual(log.slice(0, 3).map((c) => [c.operation, c.outcome]), [["seal", "SEALED"], ["open", "OPENED"], ["seal", "SEALED"]]);
  assert.ok(log.some((c) => c.operation === "open" && c.outcome === "AUTHENTICATION_FAILED" && c.uploadId === v7(1002)));
});

function tombstone(members: { readonly id: number; readonly agency?: AgencyId; readonly event: keyof typeof AUTHORITY_TOMBSTONES; readonly subject: number; readonly sequence: number; readonly occurredAt?: string }): AuthorityTombstone {
  const { kind, state } = AUTHORITY_TOMBSTONES[members.event] as { readonly kind: AuthorityTombstoneKind; readonly state: AuthorityTombstoneState };
  const body = {
    tombstoneId: v7(members.id),
    kind,
    agencyId: members.agency ?? AGENCY,
    revisionId: REVISION,
    subjectId: v7(members.subject),
    state,
    occurredAt: members.occurredAt ?? "2026-09-02T10:00:00.123456Z",
    sequence: members.sequence,
  };
  return { ...body, evidenceHash: authorityTombstoneHashOf(body) };
}

test("the labelled authority-journal fake is an append-only file outside the database, idempotent by event id — a replay is ALREADY_PRESENT and writes nothing, the same id with other members or another id with a journaled sequence is refused — and lists an agency's tombstones after a sequence in sequence order whatever the append order, to a new instance over the same file too; evidence class SIMULATED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kauro-contract-fake-journal-"));
  try {
    const path = join(dir, "authority-journal.jsonl");
    const journal = new ContractFakeAuthorityJournal({ path });
    assert.deepEqual([journal.provider, journal.evidenceClass], [CONTRACT_FAKE_JOURNAL_PROVIDER, "SIMULATED"]);
    assert.deepEqual(await journal.list(AGENCY, 0), [], "an absent file is an empty journal");

    const expiredRevision = tombstone({ id: 30, event: "dataset_revision.expired.v1", subject: 4, sequence: 30 });
    const cancelledUpload = tombstone({ id: 10, event: "upload_session.cancelled.v1", subject: 1001, sequence: 10 });
    const revokedFile = tombstone({ id: 20, event: "source_file.admission_revoked.v1", subject: 500, sequence: 20 });
    const otherAgency = tombstone({ id: 15, agency: OTHER_AGENCY, event: "upload_session.expired.v1", subject: 1009, sequence: 15 });
    assert.equal(revokedFile.state, "ADMISSION_REVOKED", "the SourceFile machine's own terminal state (D-RESTORE-2)");
    let before = "";
    for (const t of [expiredRevision, cancelledUpload, otherAgency, revokedFile]) {
      assert.equal(await journal.append(t), "APPENDED");
      const after = await readFile(path, "utf8");
      assert.ok(after.startsWith(before) && after.length > before.length, "append-only: every earlier byte is kept");
      before = after;
    }
    const lines = before.trimEnd().split("\n").map((line) => JSON.parse(line) as { provider: string; evidenceClass: string; tombstone: AuthorityTombstone });
    assert.deepEqual(lines.map((l) => [l.provider, l.evidenceClass, l.tombstone.tombstoneId]), [
      [CONTRACT_FAKE_JOURNAL_PROVIDER, "SIMULATED", expiredRevision.tombstoneId],
      [CONTRACT_FAKE_JOURNAL_PROVIDER, "SIMULATED", cancelledUpload.tombstoneId],
      [CONTRACT_FAKE_JOURNAL_PROVIDER, "SIMULATED", otherAgency.tombstoneId],
      [CONTRACT_FAKE_JOURNAL_PROVIDER, "SIMULATED", revokedFile.tombstoneId],
    ]);

    // idempotent by event id: a replay writes nothing; a divergent version of a fact or a reused sequence is refused
    assert.equal(await journal.append({ ...cancelledUpload }), "ALREADY_PRESENT");
    await assert.rejects(journal.append(tombstone({ id: 10, event: "upload_session.cancelled.v1", subject: 1001, sequence: 10, occurredAt: "2026-09-02T10:00:01Z" })), journalError("CONFLICT"));
    await assert.rejects(journal.append(tombstone({ id: 11, event: "upload_session.expired.v1", subject: 1002, sequence: 20 })), journalError("CONFLICT"));
    // the port's contract on a tombstone
    await assert.rejects(journal.append({ ...tombstone({ id: 12, event: "upload_session.expired.v1", subject: 1003, sequence: 12 }), evidenceHash: expiredRevision.evidenceHash }), journalError("INVALID_TOMBSTONE"));
    const preFix = { tombstoneId: v7(13), kind: "FILE_ADMISSION_REVOKED", agencyId: AGENCY, revisionId: REVISION, subjectId: v7(501), state: "REVOKED", occurredAt: "2026-09-02T10:00:00Z", sequence: 13 };
    await assert.rejects(journal.append({ ...preFix, evidenceHash: authorityTombstoneHashOf(preFix) } as unknown as AuthorityTombstone), journalError("INVALID_TOMBSTONE"), "a state the SourceFile machine does not have");
    await assert.rejects(journal.append({ ...tombstone({ id: 14, event: "upload_session.expired.v1", subject: 1004, sequence: 14 }), note: "customer text" } as unknown as AuthorityTombstone), journalError("INVALID_TOMBSTONE"));
    await assert.rejects(journal.append(tombstone({ id: 16, event: "upload_session.expired.v1", subject: 1005, sequence: 0 })), journalError("INVALID_TOMBSTONE"));
    await assert.rejects(journal.append(tombstone({ id: 17, event: "upload_session.expired.v1", subject: 1006, sequence: 17, occurredAt: "2026-09-02 10:00:00" })), journalError("INVALID_TOMBSTONE"));
    assert.equal(await readFile(path, "utf8"), before, "nothing refused or replayed was written");

    // listed in sequence order after a sequence, per agency
    assert.deepEqual(await journal.list(AGENCY, 0), [cancelledUpload, revokedFile, expiredRevision]);
    assert.deepEqual(await journal.list(AGENCY, 10), [revokedFile, expiredRevision]);
    assert.deepEqual(await journal.list(AGENCY, 30), []);
    assert.deepEqual(await journal.list(OTHER_AGENCY, 0), [otherAgency]);
    await assert.rejects(journal.list("not-an-agency" as AgencyId, 0), journalError("INVALID_REQUEST"));
    await assert.rejects(journal.list(AGENCY, -1), journalError("INVALID_REQUEST"));

    // at-least-once delivery: the same tombstone delivered twice concurrently is journaled once. The first delivery is held on
    // arrival; the second overtakes it and appends; the first then finds it present.
    const lateEarlier = tombstone({ id: 5, event: "dataset_revision.rejected.v1", subject: 4, sequence: 5 });
    const hold = journal.holdNextAppend();
    const firstDelivery = journal.append(lateEarlier);
    await hold.reached;
    assert.equal(await journal.append(lateEarlier), "APPENDED");
    hold.release();
    assert.equal(await firstDelivery, "ALREADY_PRESENT");
    assert.equal((await readFile(path, "utf8")).split("\n").filter((l) => l.includes(lateEarlier.tombstoneId)).length, 1);
    // appended last, listed first: restore reconciliation applies tombstones in domain-event sequence order
    assert.deepEqual((await journal.list(AGENCY, 0)).map((t) => t.sequence), [5, 10, 20, 30]);

    // outside the restore boundary: the process after a database restore opens the same file and finds every tombstone
    const reopened = new ContractFakeAuthorityJournal({ path });
    assert.deepEqual(await reopened.list(AGENCY, 0), await journal.list(AGENCY, 0));
    assert.equal(await reopened.append(expiredRevision), "ALREADY_PRESENT");
    assert.deepEqual(
      journal.calls().filter((c) => c.operation === "append").map((c) => c.outcome),
      ["APPENDED", "APPENDED", "APPENDED", "APPENDED", "ALREADY_PRESENT", "FAILED CONFLICT", "FAILED CONFLICT", ...Array<string>(5).fill("FAILED INVALID_TOMBSTONE"), "ALREADY_PRESENT", "APPENDED"],
    );
    for (const c of journal.calls()) assert.deepEqual([c.provider, c.evidenceClass], [CONTRACT_FAKE_JOURNAL_PROVIDER, "SIMULATED"]);

    // a line the journal did not write is never read as a tombstone
    await appendFile(path, '{"provider":"somebody-else","tombstone":{}}\n', "utf8");
    await assert.rejects(reopened.list(AGENCY, 0), journalError("CORRUPT_JOURNAL"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the provider fakes are published only through the test-only subpath @kauro/application/testing — the package exports ./testing, the main entry exports no fake, no production source imports one — and each of the three is labelled SIMULATED with a contract-fake-* provider token the registry accepts", async () => {
  const root = new URL("../../../../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("packages/application/package.json", root), "utf8")) as { exports: Readonly<Record<string, unknown>> };
  assert.deepEqual(manifest.exports["./testing"], { types: "./dist/src/testing/index.d.ts", default: "./dist/src/testing/index.js" });
  const rules = JSON.parse(await readFile(new URL("architecture.rules.json", root), "utf8")) as { testOnlySubpaths: ReadonlyArray<string> };
  assert.ok(rules.testOnlySubpaths.includes("/testing"), "the architecture gate refuses /testing outside test/ directories");
  const main = await import("../src/index.js");
  assert.deepEqual(Object.keys(main).filter((k) => /contract.?fake/i.test(k)), [], "the main entry exports no contract fake");
  // no production source — any package's or app's src/ outside this subpath — reaches a fake, by package name or by path
  const offenders: string[] = [];
  const walk = async (dir: URL, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), path);
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !path.startsWith("packages/application/src/testing/")) {
        const text = await readFile(new URL(entry.name, dir), "utf8");
        if (/\b(?:from|import)\s*\(?\s*["'](?:@kauro\/application\/testing|[^"']*\/testing\/index\.js|[^"']*contract-fake-(?:object-storage|session-vault|authority-journal)\.js)["']/.test(text)) offenders.push(path);
      }
    }
  };
  for (const group of ["packages", "apps"]) {
    for (const pkg of await readdir(new URL(`${group}/`, root), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = new URL(`${group}/${pkg.name}/src/`, root);
      if (await statFile(src).then(() => true, () => false)) await walk(src, `${group}/${pkg.name}/src`);
    }
  }
  assert.deepEqual(offenders, [], "no production source imports a provider fake");
  // the three fakes of this subpath, one owner, labelled
  const instances = { ObjectStoragePort: new ContractFakeObjectStorage(), SessionVaultPort: new ContractFakeSessionVault(), AuthorityJournalPort: new ContractFakeAuthorityJournal({ path: join(tmpdir(), "never-written.jsonl") }) };
  assert.deepEqual(CONTRACT_FAKES.map((f) => f.port), ["ObjectStoragePort", "SessionVaultPort", "AuthorityJournalPort"]);
  for (const entry of CONTRACT_FAKES) {
    const fake = instances[entry.port];
    assert.deepEqual([fake.provider, fake.evidenceClass, fake.contractFake, fake.constructor.name], [entry.provider, "SIMULATED", true, entry.fake]);
    assert.deepEqual([entry.evidenceClass, entry.owner], ["SIMULATED", "B07-PROVIDER-FAKES"]);
    assert.match(entry.provider, /^contract-fake-[a-z]+$/);
    assert.match(entry.provider, PROVIDER_TOKEN);
  }
});

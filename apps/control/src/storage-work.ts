/**
 * The storage effects the control-plane pipelines share (docs/design/B07-upload-source-lifecycle.md §12.3, §12.5; decisions D-OBJ-1,
 * D-OBJ-2, D-ROLE-3, D-SESSION-1, D-SESSION-3, D-CLOCK-1): the deletion of a registered generation, the discard of a promotion a
 * stale attempt made, and the cancellation of a provider session with its recorded answer.
 *
 * No transaction spans a provider call (07): each effect reads what it needs in one unit of work, calls the provider outside any
 * transaction, and records the provider's answer in another unit of work — at the server's instant, bound to the object's agency.
 * A provider failure leaves the registry as it was (the deletion stays requested, the cancellation stays pending): the sweepers
 * DELETION_RETRIES and PROVIDER_SESSION_RECONCILIATION pick it up again.
 */
import type { ObjectStoragePort, ProviderCancellationResult, SessionVaultPort, StorageLocation } from "@kauro/application";
import type { DeletionResult, SourceUnitOfWorkFactory, StoredObjectId, StoredObjectRecord, UploadId } from "@kauro/domain";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { applied, boundTo, isAfter, publish, type WorkItem } from "./work.js";

/** The registry's location of an object, as the storage port names it (a provider token and a registry key; never a bucket). */
export function locationOf(object: Pick<StoredObjectRecord, "provider" | "locationRef">): StorageLocation {
  return { provider: object.provider, locationRef: object.locationRef };
}

/** What one deletion attempt ended with. */
export type DeletionOutcome =
  /** The provider result is recorded (DELETED with its residual, or DELETION_FAILED with the provider's refusal). */
  | { readonly kind: "RECORDED"; readonly result: DeletionResult; readonly record: StoredObjectRecord }
  /** Nothing to do: the object is not awaiting a deletion (already deleted, or never requested). */
  | { readonly kind: "NOT_PENDING" }
  /** The provider call or the record failed; the deletion stays requested for DELETION_RETRIES. */
  | { readonly kind: "PENDING"; readonly cause: string };

/**
 * Deletes one requested object by its exact generation and records the provider's answer at the server's instant with the residual
 * the location's latest read-back implies (D-OBJ-2; the database refuses a deletion at a location never read back). A failed
 * deletion (DELETION_FAILED) is requested again first. An intent that never received a generation holds no object the registry
 * observed: its deletion is recorded ALREADY_ABSENT — an object that arrives under its name later is an unregistered generation,
 * registered RESIDUAL and deleted by OBJECT_INVENTORY (09 "periodic provider inventory detects objects missing from that registry").
 */
export async function executeDeletion(storage: ObjectStoragePort, units: SourceUnitOfWorkFactory, item: WorkItem, objectId: StoredObjectId): Promise<DeletionOutcome> {
  const pending = await units.runSource(boundTo(item), async (uow) => {
    const object = await uow.sources.objects.get(objectId);
    if (object === null) return null;
    if (object.state === "DELETION_FAILED") return uow.sources.objects.retryDeletion(objectId, await uow.serverInstant());
    return object.state === "DELETION_REQUESTED" ? object : null;
  });
  if (pending === null) return { kind: "NOT_PENDING" };
  let result: DeletionResult;
  if (pending.generation === undefined) result = "ALREADY_ABSENT";
  else {
    try {
      result = await storage.delete(locationOf(pending), pending.objectName, pending.generation);
    } catch {
      result = "PROVIDER_ERROR";
    }
  }
  try {
    const record = await units.runSource(boundTo(item), (uow) => uow.sources.objects.recordDeletion(objectId, result));
    return { kind: "RECORDED", result, record };
  } catch (e) {
    return { kind: "PENDING", cause: e instanceof Error ? e.name : "UNRECORDED" };
  }
}

/**
 * Requests the deletion of registered objects and deletes each: an intent the provider now holds an object for is first observed
 * as a late residual (INTENDED → PRESENT, RESIDUAL for good; D-OBJ-1: "a late object is RESIDUAL for good"), so the deletion names
 * that exact generation. Objects already deleted are left as they are. Returns every outcome.
 */
export async function requestAndDelete(
  storage: ObjectStoragePort,
  units: SourceUnitOfWorkFactory,
  item: WorkItem,
  objects: ReadonlyArray<StoredObjectRecord>,
  reason: string,
): Promise<ReadonlyArray<{ readonly objectId: StoredObjectId; readonly outcome: DeletionOutcome }>> {
  const candidates = objects.filter((o) => o.state !== "DELETED");
  if (candidates.length === 0) return [];
  // the provider's view of every name the registry reserved but never observed (outside any transaction)
  const found = new Map<StoredObjectId, { readonly generation: string; readonly bytes: number; readonly observedAt: string }>();
  for (const o of candidates) {
    if (o.state !== "INTENDED") continue;
    try {
      const seen = await storage.stat(locationOf(o), o.objectName);
      if (seen !== null) found.set(o.objectId, seen);
    } catch {
      // the absence check failed: the intent is requested as it is and recorded ALREADY_ABSENT; an object that is there after all is
      // an unregistered generation for OBJECT_INVENTORY
    }
  }
  await units.runSource(boundTo(item), async (uow) => {
    for (const [objectId, seen] of found) {
      const current = await uow.sources.objects.get(objectId);
      if (current?.state === "INTENDED") await uow.sources.objects.observe(objectId, { generation: seen.generation, bytes: seen.bytes, observedAt: seen.observedAt, late: true });
    }
    await uow.sources.objects.requestDeletion(
      candidates.filter((o) => o.state !== "DELETION_REQUESTED" && o.state !== "DELETION_FAILED").map((o) => o.objectId),
      reason,
      await uow.serverInstant(),
    );
  });
  const out: Array<{ readonly objectId: StoredObjectId; readonly outcome: DeletionOutcome }> = [];
  for (const o of candidates) out.push({ objectId: o.objectId, outcome: await executeDeletion(storage, units, item, o.objectId) });
  return out;
}

/** What the reconciliation of one provider session did. */
export type CancellationOutcome =
  /** Nothing pending: the upload's provider cancellation is not REQUESTED or UNCERTAIN. */
  | { readonly kind: "NOT_PENDING" }
  /** The session's provider horizon passed on the server clock: it cannot be used any more; its bearer record was purged. */
  | { readonly kind: "HORIZON_PASSED" }
  /** No bearer record is held for the upload (purged, or a session that was never stored): nothing can be cancelled. */
  | { readonly kind: "NO_SECRET" }
  /** The provider answered; RECORDED when the answer moved the state forward (an UNCERTAIN answer to an UNCERTAIN state does not). */
  | { readonly kind: "ANSWERED"; readonly answer: ProviderCancellationResult; readonly recorded: boolean }
  /** The vault or the provider failed: the cancellation stays pending (retry within the provider horizon). */
  | { readonly kind: "FAILED"; readonly cause: string };

/**
 * Cancels the provider session of a tombstoned upload whose cancellation is REQUESTED (stamped by the database with the tombstone,
 * D-ROLE-3) or UNCERTAIN, and records the answer — CONFIRMED, UNSUPPORTED or UNCERTAIN — with
 * upload_session.provider_cancellation_recorded.v1 (09 "Resumable session security": the provider cancellation result is recorded;
 * an unconfirmed one is reconciled until the provider lifetime ends). The bearer reference is opened by the vault under exactly the
 * binding it was sealed with and never leaves this function; once the cancellation resolved (CONFIRMED or UNSUPPORTED) or the
 * horizon passed, the temporary control record is purged (D-SESSION-1).
 */
export async function cancelProviderSession(
  storage: ObjectStoragePort,
  vault: SessionVaultPort,
  units: SourceUnitOfWorkFactory,
  item: WorkItem,
  uploadId: UploadId,
  timeoutMs: number = PROVIDER_CALL_TIMEOUT_MS,
): Promise<CancellationOutcome> {
  const read = await units.runSource(boundTo(item), async (uow) => {
    const peek = await uow.sources.uploads.get(uploadId);
    if (peek === null) return { kind: "NOT_PENDING" as const };
    await uow.sources.revisions.lock(peek.revisionId);
    const upload = await uow.sources.uploads.lock(uploadId);
    if (upload === null || (upload.providerCancellationState !== "REQUESTED" && upload.providerCancellationState !== "UNCERTAIN")) return { kind: "NOT_PENDING" as const };
    const now = await uow.serverInstant();
    if (upload.providerSessionExpiresAt !== undefined && !isAfter(upload.providerSessionExpiresAt, now)) {
      await uow.sources.sessionSecrets.purge(uploadId);
      return { kind: "HORIZON_PASSED" as const };
    }
    const secret = await uow.sources.sessionSecrets.readForRevocation(uploadId);
    return secret === null ? { kind: "NO_SECRET" as const } : { kind: "PENDING" as const, secret };
  });
  if (read.kind !== "PENDING") return read;
  const { secret } = read;
  let answer: ProviderCancellationResult;
  try {
    const sessionRef = await vault.open(secret, { agencyId: secret.agencyId, uploadId, requestedByUserId: secret.requestedByUserId, sessionAttempt: secret.sessionAttempt });
    answer = await storage.cancelResumableSession(sessionRef, timeoutMs);
  } catch (e) {
    return { kind: "FAILED", cause: e instanceof Error ? e.name : "PROVIDER_FAILURE" };
  }
  const recorded = await units.runSource(boundTo(item), async (uow) => {
    const peek = await uow.sources.uploads.get(uploadId);
    if (peek === null) return false;
    await uow.sources.revisions.lock(peek.revisionId);
    const upload = await uow.sources.uploads.lock(uploadId);
    if (upload === null) return false;
    const state = upload.providerCancellationState;
    // the state only moves forward (NOT_REQUESTED -> REQUESTED -> CONFIRMED | UNSUPPORTED | UNCERTAIN; UNCERTAIN -> CONFIRMED | UNSUPPORTED)
    const moves = state === "REQUESTED" || (state === "UNCERTAIN" && answer !== "UNCERTAIN");
    if (!moves) return false;
    const record = applied(await uow.sources.uploads.recordProviderCancellation(uploadId, upload.version, answer), "provider cancellation");
    await publish(uow, item, "upload_session", uploadId, record.version, "upload_session.provider_cancellation_recorded.v1", {
      uploadId,
      agencyId: item.agencyId,
      revisionId: record.revisionId,
      providerCancellationState: answer,
    });
    if (answer !== "UNCERTAIN") await uow.sources.sessionSecrets.purge(uploadId);
    return true;
  });
  return { kind: "ANSWERED", answer, recorded };
}

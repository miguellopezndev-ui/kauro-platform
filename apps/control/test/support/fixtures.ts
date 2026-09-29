// The request-handler side of the source lifecycle the control-plane tests start from (design §11; the commands are mandate
// B07-COMMANDS'): each write by the request handlers' role (kauro_app_test) under the tenant owner's context, through the persistence
// adapters of the source-store ports, with the events the EventPublisher writes (and their outbox records, which the control plane
// then dispatches). A write that stands in the past positions the labelled TEST CLOCK of its own transaction (clockAt); the storage
// fake's provider clock is pinned to the same instant for the provider calls between the two units of work of CMD013 (D-RUN-2).
import type { Sha256Hex } from "@kauro/contracts";
import {
  PROVIDER_CALL_TIMEOUT_MS,
  inventoryHashOf,
  selectionHashOf,
  quarantineObjectName,
  textDigest,
  type ActorRef,
  type AggregateKind,
  type CausationId,
  type ClientId,
  type CorrelationId,
  type DeclaredFormat,
  type EventPayload,
  type EventType,
  type ProjectId,
  type RetentionAnchorId,
  type RevisionId,
  type SelectionManifestDocument,
  type SelectionManifestId,
  type SourceFileId,
  type SourceTableId,
  type StoredObjectId,
  type TenantContext,
  type UploadId,
  type UploadSessionRecord,
} from "@kauro/domain";
import { PgEventPublisher, PgSourceStore } from "@kauro/persistence";
import { clockAt, fixtureSelection, sealSourceRevision, type AgencyFixture, type SealedSourceFixture, type SourceFixtureSessions } from "@kauro/persistence/testing";
import { clock, ids, rawTx, type ControlEnv, type RawClient } from "./env.js";

export interface Tenant {
  readonly ag: AgencyFixture;
  readonly clientId: ClientId;
}

let tenants = 0;

/** An agency of its own (its capacity ledger decides nothing for another test) with its owner and one client. */
export async function tenant(env: ControlEnv, label: string): Promise<Tenant> {
  const owner = await env.h.person(`b07-control-${label}-${++tenants}`);
  const ag = await env.h.createAgency(owner, `Agency ${label}`);
  const clientId = await env.h.endClient(ag, await env.h.processingAuthority(ag));
  return { ag, clientId };
}

export function asOwner(env: ControlEnv, t: Tenant): TenantContext {
  return env.h.tenant(t.ag.agencyId, t.ag.ownerUserId);
}

export interface ProjectFixture {
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
}

/** A project of the tenant with its DRAFT revision (CMD011 as its handler writes it, with both events). */
export async function project(env: ControlEnv, t: Tenant): Promise<ProjectFixture> {
  return env.h.app.run(asOwner(env, t), async (uow) => {
    const projectId = uow.ids.next() as ProjectId;
    const revisionId = uow.ids.next() as RevisionId;
    await uow.projects.insertWithDraftRevision({ projectId, agencyId: t.ag.agencyId, clientId: t.clientId, mode: "CLEAN", purpose: "Control plane", capabilityId: env.capabilityId as never, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: t.ag.ownerMembershipId, createdAt: clock.now() });
    const actor = { kind: "USER", userId: t.ag.ownerUserId } as const;
    await uow.events.publish({ aggregateKind: "project", aggregateId: projectId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { projectId, agencyId: t.ag.agencyId, clientId: t.clientId, mode: "CLEAN", initialRevisionId: revisionId } });
    await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { revisionId, agencyId: t.ag.agencyId, projectId, state: "DRAFT" } });
    return { projectId, revisionId };
  });
}

export type Emit = (kind: AggregateKind, id: string, version: number, type: EventType, payload: EventPayload) => Promise<void>;

/**
 * One request-handler transaction (kauro_app_test, the tenant owner's context) at `at` on the TEST CLOCK (null: the real clock),
 * with the source store of the persistence adapters and the event publisher on that transaction.
 */
export async function asRequestHandler<T>(env: ControlEnv, t: Tenant, at: Date | null, fn: (s: PgSourceStore, emit: Emit, c: RawClient) => Promise<T>): Promise<T> {
  return rawTx(env.h.appPool, t.ag.agencyId, t.ag.ownerUserId, async (c) => {
    if (at !== null) await clockAt(c, at);
    const actor: ActorRef = { kind: "USER", userId: t.ag.ownerUserId };
    const publisher = new PgEventPublisher(c, ids, clock);
    const correlationId = ids.next() as CorrelationId;
    const emit: Emit = async (kind, id, version, type, payload) => {
      await publisher.publish({ aggregateKind: kind, aggregateId: id, aggregateVersion: version, agencyId: t.ag.agencyId, eventType: type, actor, causationId: ids.next() as CausationId, correlationId, payload });
    };
    return fn(new PgSourceStore(c, "REQUEST"), emit, c);
  });
}

/** An operations change of the agency's concurrent-session limit (the control plane's column, D-UP-3). */
export async function setSessionLimit(env: ControlEnv, t: Tenant, limit: number): Promise<void> {
  await rawTx(env.h.controlPool, t.ag.agencyId, "", (c) =>
    c.query("INSERT INTO kauro.upload_capacity (agency_id, active_sessions, session_limit, updated_at) VALUES ($1, 0, $2, now()) ON CONFLICT (agency_id) DO UPDATE SET session_limit = EXCLUDED.session_limit, updated_at = now()", [t.ag.agencyId, limit]),
  );
}

export interface Upload {
  readonly uploadId: UploadId;
  readonly objectId: StoredObjectId;
  readonly objectName: string;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly declaredBytes: number;
  readonly declaredFormat: DeclaredFormat;
}

/**
 * CMD013's first unit of work: the revision row first (D-LOCK-1), the quarantine intent, the RESERVED upload with its event and
 * UPLOAD_INITIATED anchor, and — for the revision's first upload — DRAFT → UPLOADING.
 */
export async function reserve(env: ControlEnv, t: Tenant, p: ProjectFixture, declaredBytes: number, declaredFormat: DeclaredFormat, at: Date | null = null): Promise<Upload> {
  return asRequestHandler(env, t, at, async (s, emit) => {
    const uploadId = ids.next() as UploadId;
    const objectId = ids.next() as StoredObjectId;
    const objectName = quarantineObjectName(t.ag.agencyId, p.projectId, p.revisionId, uploadId);
    const revision = await s.revisions.lock(p.revisionId);
    if (revision === null) throw new Error("fixture: the revision is not visible");
    const location = env.storage.location("QUARANTINE");
    await s.objects.register({
      objectId,
      agencyId: t.ag.agencyId,
      projectId: p.projectId,
      revisionId: p.revisionId,
      uploadId,
      zone: "QUARANTINE",
      dataClass: "RAW",
      provider: location.provider,
      locationRef: location.locationRef,
      objectName,
      createdBy: { kind: "MEMBERSHIP", membershipId: t.ag.ownerMembershipId },
      createdAt: clock.now(),
    });
    await s.uploads.insert({ uploadId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, displayName: `contacts ${declaredFormat === "CSV" ? "export.csv" : "workbook.xlsx"}`, declaredFormat, reservedBytes: declaredBytes, quarantineObjectId: objectId, requestedByMembershipId: t.ag.ownerMembershipId, requestedByUserId: t.ag.ownerUserId });
    await emit("upload_session", uploadId, 1, "upload_session.reserved.v1", { uploadId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, reservedBytes: declaredBytes, declaredFormat, requestedByMembershipId: t.ag.ownerMembershipId, state: "RESERVED" });
    await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, uploadId, kind: "UPLOAD_INITIATED", sourceEvidenceHash: null });
    if (revision.state === "DRAFT") {
      const moved = await s.revisions.transition(p.revisionId, revision.version, { event: "upload_reserved", firstUploadId: uploadId });
      if (moved.kind !== "APPLIED") throw new Error("fixture: upload_reserved did not apply");
      await emit("dataset_revision", p.revisionId, moved.record.version, "dataset_revision.uploading.v1", { revisionId: p.revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, firstUploadId: uploadId, state: "UPLOADING" });
    }
    return { uploadId, objectId, objectName, projectId: p.projectId, revisionId: p.revisionId, declaredBytes, declaredFormat };
  });
}

/**
 * CMD013's provider call and second unit of work: a resumable session for exactly the quarantine name (the storage fake's provider
 * clock at `at`), sealed by the vault for this upload, requester and attempt, stored for the requester; RESERVED → UPLOADING.
 * Returns the bearer reference the requester's browser holds.
 */
export async function issue(env: ControlEnv, t: Tenant, up: Upload, at: Date | null = null): Promise<string> {
  env.providerClock.at(at);
  try {
    const session = await env.storage.createResumableSession(
      { location: env.storage.location("QUARANTINE"), objectName: up.objectName, declaredBytes: up.declaredBytes, contentType: up.declaredFormat === "CSV" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", origin: "https://app.kauro.test" },
      PROVIDER_CALL_TIMEOUT_MS,
    );
    const sealed = await env.vault.seal(session.sessionRef, { agencyId: t.ag.agencyId, uploadId: up.uploadId, requestedByUserId: t.ag.ownerUserId, sessionAttempt: 1 });
    await asRequestHandler(env, t, at === null ? null : new Date(at.getTime() + 1_000), async (s, emit) => {
      const providerSessionDigest = textDigest(session.sessionRef);
      const issued = await s.uploads.transition(up.uploadId, 1, { event: "session_issued", sessionAttempt: 1, providerSessionDigest, providerSessionLifetimeSeconds: env.storage.capabilities().sessionLifetimeSeconds });
      if (issued.kind !== "APPLIED") throw new Error("fixture: session_issued did not apply");
      await s.sessionSecrets.store({ uploadId: up.uploadId, agencyId: t.ag.agencyId, requestedByUserId: t.ag.ownerUserId, sessionAttempt: 1, keyRef: sealed.keyRef, nonce: sealed.nonce, ciphertext: sealed.ciphertext, createdAt: clock.now() });
      await emit("upload_session", up.uploadId, issued.record.version, "upload_session.session_issued.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, sessionAttempt: 1, providerSessionDigest });
    });
    return session.sessionRef;
  } finally {
    env.providerClock.at(null);
  }
}

/** The browser's side: the whole object written through the session; answers the completion reference the browser forwards. */
export function uploadThrough(env: ControlEnv, sessionRef: string, content: Uint8Array): { readonly generation: string; readonly completionRef: string } {
  const written = env.storage.uploadThroughSession(sessionRef, content);
  if (written.outcome !== "FINALIZED") throw new Error(`fixture: the session did not finalize the upload (${"reason" in written ? written.reason : written.outcome})`);
  return { generation: written.generation, completionRef: written.completionRef };
}

/**
 * CMD014: the browser's completion reference parsed into a claim (the storage port's `parseCompletionClaim`) and recorded as a claim
 * (UPLOADING → VERIFYING, upload_session.completion_reported.v1 → UPLOAD_INSPECTION); nothing is admitted by the request.
 */
export async function report(env: ControlEnv, t: Tenant, up: Upload, completionRef: string, at: Date | null = null): Promise<UploadSessionRecord> {
  const parsed = env.storage.parseCompletionClaim(completionRef);
  if (parsed.kind !== "CLAIM") throw new Error("fixture: a malformed completion reference");
  return asRequestHandler(env, t, at, async (s, emit) => {
    const current = await s.uploads.get(up.uploadId);
    if (current === null) throw new Error("fixture: the upload is not visible");
    const claimDigest = textDigest(completionRef) as Sha256Hex;
    const reported = await s.uploads.transition(up.uploadId, current.version, { event: "completion_reported", claimDigest, claim: parsed.claim });
    if (reported.kind !== "APPLIED") throw new Error("fixture: completion_reported did not apply");
    await emit("upload_session", up.uploadId, reported.record.version, "upload_session.completion_reported.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, completionClaimDigest: claimDigest, reportedByMembershipId: t.ag.ownerMembershipId });
    return reported.record;
  });
}

/** CMD015: the requester's cancellation — its event and INTAKE_CANCELLED anchor; the database requests the provider cancellation. */
export async function cancel(env: ControlEnv, t: Tenant, up: Upload): Promise<UploadSessionRecord> {
  return asRequestHandler(env, t, null, async (s, emit) => {
    await s.revisions.lock(up.revisionId);
    const current = await s.uploads.lock(up.uploadId);
    if (current === null) throw new Error("fixture: the upload is not visible");
    const cancelled = await s.uploads.transition(up.uploadId, current.version, { event: "cancel_upload", byMembershipId: t.ag.ownerMembershipId, reason: "CANCELLED_BY_REQUESTER" });
    if (cancelled.kind !== "APPLIED") throw new Error("fixture: cancel_upload did not apply");
    await emit("upload_session", up.uploadId, cancelled.record.version, "upload_session.cancelled.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, cancelledByMembershipId: t.ag.ownerMembershipId, reasonCode: "CANCELLED_BY_REQUESTER", providerCancellationState: cancelled.record.providerCancellationState });
    await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: up.projectId, revisionId: up.revisionId, uploadId: up.uploadId, kind: "INTAKE_CANCELLED", sourceEvidenceHash: null });
    return cancelled.record;
  });
}

/** Reserve, issue, upload the bytes through the session and report completion with `completionRef(real)` (default: the real one). */
export async function uploadAndReport(
  env: ControlEnv,
  t: Tenant,
  p: ProjectFixture,
  content: Uint8Array,
  format: DeclaredFormat,
  options: { readonly completionRef?: (real: { readonly generation: string; readonly completionRef: string }) => string } = {},
): Promise<{ readonly up: Upload; readonly generation: string; readonly sessionRef: string }> {
  const up = await reserve(env, t, p, content.length, format);
  const sessionRef = await issue(env, t, up);
  const written = uploadThrough(env, sessionRef, content);
  await report(env, t, up, options.completionRef === undefined ? written.completionRef : options.completionRef(written));
  return { up, generation: written.generation, sessionRef };
}

/** One row of the oracle (the superuser: every tenant, every column). */
export async function oracle<T extends Record<string, unknown>>(env: ControlEnv, sql: string, params: unknown[] = []): Promise<T> {
  const r = await env.h.oracle.query<T>(sql, params);
  if (r.rows.length !== 1) throw new Error(`oracle: ${r.rows.length} rows for ${sql}`);
  return r.rows[0] as T;
}

export async function oracleRows<T extends Record<string, unknown>>(env: ControlEnv, sql: string, params: unknown[] = []): Promise<ReadonlyArray<T>> {
  return (await env.h.oracle.query<T>(sql, params)).rows;
}

/** The events of an aggregate in sequence order, with the kind of actor each was appended by. */
export async function eventsOf(env: ControlEnv, aggregateId: string): Promise<ReadonlyArray<{ readonly event_type: string; readonly actor_kind: string; readonly actor_id: string | null; readonly aggregate_version: string }>> {
  return oracleRows(env, "SELECT event_type, actor_kind, actor_id, aggregate_version::text FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY sequence", [aggregateId]);
}


/**
 * The selection manifest intake and CMD016 on the revision (D-SEL-2, D-INTAKE-1): a manifest made against the revision's current
 * inventory, including the one admitted CSV table with a ROW projection of its first two columns, stored content-idempotently and
 * bound after the revision row — from UPLOADING that is the agency's explicit closing of the intake (all_uploads_completed).
 */
export async function bindSelection(
  env: ControlEnv,
  t: Tenant,
  p: ProjectFixture,
  file: { readonly fileId: SourceFileId; readonly tableId: SourceTableId; readonly structureHash: string },
  amend: (selection: SelectionManifestDocument) => SelectionManifestDocument = (x) => x,
): Promise<{ readonly selectionHash: Sha256Hex; readonly version: number }> {
  return asRequestHandler(env, t, null, async (s, emit) => {
    const inventoryHash = inventoryHashOf(await s.revisions.inventory(p.revisionId));
    const selection = amend(fixtureSelection(p.revisionId, { ...file, origin: "THIS_REVISION" }, inventoryHash));
    const selectionHash = selectionHashOf(selection);
    const { record } = await s.selections.put({ selectionManifestId: ids.next() as SelectionManifestId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, body: selection, bodyHash: selectionHash, createdByMembershipId: t.ag.ownerMembershipId, createdAt: clock.now() });
    const revision = await s.revisions.lock(p.revisionId);
    if (revision === null) throw new Error("fixture: the revision is not visible");
    const binding = { selectionManifestId: record.selectionManifestId, selectionHash, inventoryHash };
    const bound = await s.revisions.transition(p.revisionId, revision.version, revision.state === "UPLOADING" ? { event: "all_uploads_completed", selection: binding } : { event: "selection_rebound", selection: binding });
    if (bound.kind !== "APPLIED") throw new Error("fixture: the selection did not bind");
    await emit("dataset_revision", p.revisionId, bound.record.version, "dataset_revision.selection_changed.v1", {
      revisionId: p.revisionId,
      agencyId: t.ag.agencyId,
      projectId: p.projectId,
      selectionManifestId: record.selectionManifestId,
      selectionHash,
      inventoryHash,
      previousState: revision.state,
      state: "INSPECTING",
      includedFileCount: 1,
      includedTableCount: 1,
      reusedFileIds: [],
    });
    return { selectionHash, version: bound.record.version };
  });
}

/**
 * A revision of the project sealed through the persistence package's source-lifecycle fixture (each write by the role that owns it,
 * at the TEST CLOCK instants the fixture positions), its intake begun at `base` (default: fifteen days ago, so its UNPAID record's
 * hard deadline — the seal + fourteen days — has passed). Its events carry no outbox records: nothing of it is dispatched.
 */
export async function sealedRevision(env: ControlEnv, t: Tenant, p: ProjectFixture, seed: string, base?: Date): Promise<SealedSourceFixture> {
  const sessions: SourceFixtureSessions = {
    app: (fn) => rawTx(env.h.appPool, t.ag.agencyId, t.ag.ownerUserId, (c) => fn(c)),
    control: (fn) => rawTx(env.h.controlPool, t.ag.agencyId, "", (c) => fn(c)),
  };
  return sealSourceRevision(sessions, { agencyId: t.ag.agencyId, projectId: p.projectId, ownerUserId: t.ag.ownerUserId, ownerMembershipId: t.ag.ownerMembershipId }, { seed, ...(base === undefined ? {} : { base }) });
}

/**
 * CMD012 through the adapters (the command is B07-COMMANDS'): project row, then the predecessor (D-LOCK-1); a SEALED predecessor is
 * superseded by the successor, a mutable one cancelled (cancel_revision, naming its successor); the successor DRAFT is inserted and
 * becomes the project's current revision — each with its event.
 */
export async function replaceRevision(env: ControlEnv, t: Tenant, p: ProjectFixture, predecessorId: RevisionId): Promise<RevisionId> {
  return env.h.app.runSource(asOwner(env, t), async (uow) => {
    const actor: ActorRef = { kind: "USER", userId: t.ag.ownerUserId };
    const emit: Emit = async (kind, id, version, type, payload) => {
      await uow.events.publish({ aggregateKind: kind, aggregateId: id, aggregateVersion: version, agencyId: t.ag.agencyId, eventType: type, actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload });
    };
    const owner = t.ag.ownerMembershipId;
    const projectRecord = await uow.projects.lock(p.projectId);
    const predecessor = await uow.sources.revisions.lock(predecessorId);
    if (projectRecord === null || predecessor === null) throw new Error("fixture: the project or its revision is not visible");
    const successorId = uow.ids.next() as RevisionId;
    if (predecessor.state === "SEALED") {
      await uow.sources.revisions.insertSuccessor({ revisionId: successorId, agencyId: t.ag.agencyId, projectId: p.projectId, supersedesRevisionId: predecessorId, createdByMembershipId: owner, createdAt: clock.now() });
      const superseded = await uow.sources.revisions.transition(predecessorId, predecessor.version, { event: "new_revision_explicitly_supersedes", successorRevisionId: successorId });
      if (superseded.kind !== "APPLIED") throw new Error("fixture: the supersession did not apply");
      await emit("dataset_revision", predecessorId, superseded.record.version, "dataset_revision.superseded.v1", { revisionId: predecessorId, agencyId: t.ag.agencyId, projectId: p.projectId, successorRevisionId: successorId, manifestHash: predecessor.manifestHash ?? "", affectedPlanIds: [], affectedApprovalIds: [], affectedCommercialAuthorizationIds: [] });
    } else {
      const cancelled = await uow.sources.revisions.transition(predecessorId, predecessor.version, { event: "cancel_revision", reason: "REPLACED_BY_NEW_REVISION", successorRevisionId: successorId });
      if (cancelled.kind !== "APPLIED") throw new Error("fixture: cancel_revision did not apply");
      await emit("dataset_revision", predecessorId, cancelled.record.version, "dataset_revision.cancelled.v1", { revisionId: predecessorId, agencyId: t.ag.agencyId, projectId: p.projectId, previousState: predecessor.state, reasonCode: "REPLACED_BY_NEW_REVISION", successorRevisionId: successorId, cancelledUploadIds: [] });
      await uow.sources.revisions.insertSuccessor({ revisionId: successorId, agencyId: t.ag.agencyId, projectId: p.projectId, supersedesRevisionId: predecessorId, createdByMembershipId: owner, createdAt: clock.now() });
    }
    await emit("dataset_revision", successorId, 1, "dataset_revision.created.v1", { revisionId: successorId, agencyId: t.ag.agencyId, projectId: p.projectId, state: "DRAFT", supersedesRevisionId: predecessorId, createdByMembershipId: owner });
    const moved = await uow.sources.projects.switchCurrentRevision(p.projectId, projectRecord.version, successorId, clock.now());
    if (moved.kind !== "APPLIED") throw new Error("fixture: the project pointer did not move");
    await emit("project", p.projectId, moved.record.version, "project.current_revision_changed.v1", { projectId: p.projectId, agencyId: t.ag.agencyId, currentRevisionId: successorId, previousRevisionId: predecessorId, changedByMembershipId: owner });
    return successorId;
  });
}

/**
 * CMD013 ReserveUpload — POST /api/v1/revisions/{revisionId}/uploads — AGENCY_OPERATOR (design §11 CMD013; the two-phase runtime
 * D-RUN-2; D-SESSION-1, D-SESSION-2, D-SESSION-4, D-SRC-1, D-PAIR-1, D-UP-2, D-UP-3, D-CLOCK-1, D-SAPI-6; catalogue "Reserves bytes
 * and creates a narrowly scoped resumable session with an application acceptance deadline"; failure "A provider session is returned
 * only to its authorized requester; quota races cannot oversubscribe the revision").
 *
 * B06's pipeline (D-PIPE-1: authenticate → access decision → journal reserve or replay → execute) split around the one provider
 * call, because no transaction may span it (07; the catalogue's shared contract: external calls through recoverable intent/journal
 * boundaries; 10 "Provider adapter contract": the prepared intent is durable before dispatch):
 *
 *   unit of work 1  access decision → journal reserve (a replay answers the journaled view, hydrated; a conflicting digest is
 *                   IDEMPOTENCY_CONFLICT; a PENDING entry younger than PENDING_RESUME_GRACE_SECONDS is OPERATION_PENDING, an older
 *                   one resumes under a new issuance fence — or, when its upload is already terminal or past its deadline on the
 *                   server clock, commits the journal with that upload's view) → the revision row (NOT_FOUND) → its version
 *                   (STALE_VERSION) → the agency ACTIVE after its transition lock (AGENCY_NOT_ACTIVE), the project OPEN
 *                   (PROJECT_NOT_OPEN), its mode still offered after its transition lock (MODE_NOT_OFFERED) → the revision DRAFT or
 *                   UPLOADING (REVISION_NOT_ACCEPTING_UPLOADS) → the declaration (EMPTY_DECLARATION, FILE_TOO_LARGE) and the ledgers
 *                   read for the messages (REVISION_QUOTA_EXCEEDED, REVISION_FILE_LIMIT, UPLOAD_CONCURRENCY_LIMITED — the database
 *                   decides on the committed ledgers, R2-052) → the quarantine intent (INTENDED), the upload RESERVED holding
 *                   issuance fence 1 (created at the server's instant, deadline 86,400 s later; requested by the acting person
 *                   through their own live operator membership, D-PAIR-1), its UPLOAD_INITIATED anchor, upload_session.reserved.v1,
 *                   DRAFT → UPLOADING with dataset_revision.uploading.v1 → the journal entry attached to the upload → COMMIT with the
 *                   entry still RESERVED;
 *   provider call   ObjectStoragePort.createResumableSession for exactly the quarantine name, bounded by PROVIDER_CALL_TIMEOUT_MS; a
 *                   failure answers 503 CAPACITY_UNAVAILABLE / SESSION_ISSUE_FAILED and leaves the reservation pending for a retry
 *                   with the key; SessionVaultPort.seal binds the reference to agency, upload, requester and attempt;
 *   unit of work 2  the access decision again (a revoked membership ends the attempt) → the revision row, then the upload: still
 *                   RESERVED, still this attempt's fence, its deadline not reached on the server clock — otherwise the attempt is
 *                   abandoned (another attempt holding the fence: OPERATION_PENDING; a terminal or expired upload: the journal
 *                   commits its view) → the sealed secret, RESERVED → UPLOADING (session_issued, the fence, the digest of the
 *                   reference, the provider horizon on the server clock) with upload_session.session_issued.v1 → the journal commits
 *                   the view with the session placeholder (the bearer value is never journaled, D-SESSION-2) → the ALLOW fact
 *                   SESSION_DELIVERED of the delivery (D-SESSION-4), in the same transaction.
 *
 * A session created by an attempt that does not complete is never delivered and is cancelled best-effort (compensation). The
 * answer carries the session only to its requester: the journaled placeholder is hydrated from the attempt's own reference, or, on a
 * replay, from the sealed secret the requester's row policy lets it read while UPLOADING and unexpired (the delivery's fact recorded
 * after the vault opened it); anything else reads delivery UNAVAILABLE.
 */
import type { Id, Sha256Hex } from "@kauro/contracts";
import type {
  AgencyId,
  CausationId,
  CommandJournalEntry,
  IdentityContext,
  JournalEntryId,
  MembershipId,
  ProjectId,
  ResolvedMembership,
  RetentionAnchorId,
  RevisionId,
  SourceRevisionRecord,
  SourceUnitOfWork,
  StoredObjectId,
  TenantContext,
  UploadId,
  UploadSessionRecord,
  UserId,
} from "@kauro/domain";
import {
  DomainFailure,
  IdempotencyConflictFailure,
  INPUT_ENVELOPE,
  PENDING_RESUME_GRACE_SECONDS,
  PROVIDER_CALL_TIMEOUT_MS,
  REVISION_UPLOAD_STATES,
  commandRequestDigest,
  effectNowOf,
  isOffered,
  quarantineObjectName,
  textDigest,
} from "@kauro/domain";
import { judgedUnderHold } from "../../api/authority.js";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { applied, checkExpectedVersion } from "../../commands/handlers/shared.js";
import { AuthorizationDenied, contextOf, identityOf, resultOf, settleCommandFailure } from "../../commands/runtime.js";
import { AUTHORIZATION_POLICY_VERSION, type AllowDecision, type AuthorizationRequest } from "../../ports/authorizer.js";
import type { ResumableSession, StorageLocation } from "../../ports/source-providers.js";
import { RESERVE_UPLOAD, type ReserveUploadBody, type ReserveUploadHandler, type ReserveUploadView } from "../contracts.js";
import type { JournaledSessionPlaceholder, ProtectedSessionView } from "../views.js";
import { quotaView, revisionSummary, uploadView } from "./projections.js";
import { reachedOnServer, requireProviders, utc, type B07Collaborators, type SourceProviders, type SourceRuntime } from "./shared.js";

/** The reason token of the ALLOW fact of a session delivery (D-SESSION-4). */
export const SESSION_DELIVERED = "SESSION_DELIVERED";

/** The content type a resumable session is created for, by declared format. */
const CONTENT_TYPES = Object.freeze({ CSV: "text/csv", XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

/** What unit of work 1 leaves behind: the durable intent of this attempt, or an answer the journal already holds. */
type FirstPhase =
  | { readonly kind: "REPLAY"; readonly entry: CommandJournalEntry }
  | { readonly kind: "ANSWERED"; readonly view: ReserveUploadView; readonly membership: ResolvedMembership }
  | { readonly kind: "INTENT"; readonly entryId: JournalEntryId; readonly upload: UploadSessionRecord; readonly attempt: number; readonly membership: ResolvedMembership };

/** What unit of work 2 decided for the dispatched session: delivered, or the attempt abandoned (the session to be cancelled). */
type SecondPhase = { readonly kind: "ISSUED"; readonly view: ReserveUploadView } | { readonly kind: "ABANDONED"; readonly view: ReserveUploadView };

function placeholderOf(uploadId: UploadId, chunkMultipleBytes?: number): JournaledSessionPlaceholder {
  return { delivery: "PROTECTED_RESPONSE", sessionRef: uploadId, ...(chunkMultipleBytes !== undefined ? { chunkMultipleBytes } : {}) };
}

function unavailable(reason: NonNullable<ProtectedSessionView["unavailableReason"]>): ProtectedSessionView {
  return { delivery: "UNAVAILABLE", unavailableReason: reason };
}

function quarantineOf(storage: SourceProviders["storage"], upload: Pick<UploadSessionRecord, "agencyId" | "projectId" | "revisionId" | "uploadId">): { readonly location: StorageLocation; readonly objectName: string } {
  return { location: storage.location("QUARANTINE"), objectName: quarantineObjectName(upload.agencyId, upload.projectId, upload.revisionId, upload.uploadId) };
}

/** The view a journal entry records: the upload, the revision, the committed envelope and the session placeholder. */
async function journaledView(uow: SourceUnitOfWork, upload: UploadSessionRecord, revision: Pick<SourceRevisionRecord, "revisionId" | "agencyId" | "version" | "state">, membership: ResolvedMembership, chunkMultipleBytes?: number): Promise<ReserveUploadView> {
  return {
    upload: uploadView(upload, membership),
    revision: revisionSummary(revision),
    quota: await quotaView(uow, revision),
    session: placeholderOf(upload.uploadId, chunkMultipleBytes),
  };
}

export function reserveUploadHandler(runtime: SourceRuntime, collaborators: B07Collaborators): ReserveUploadHandler {
  return { spec: RESERVE_UPLOAD, execute: (envelope) => reserveUpload(runtime, collaborators, envelope) };
}

async function reserveUpload(runtime: SourceRuntime, collaborators: B07Collaborators, envelope: CommandEnvelope<ReserveUploadBody>): Promise<CommandResult<ReserveUploadView>> {
  const spec = RESERVE_UPLOAD;
  const correlationId = envelope.correlationId;
  let context: TenantContext | IdentityContext;
  try {
    context = contextOf(spec, envelope);
  } catch (e) {
    if (e instanceof DomainFailure) return resultOf<ReserveUploadView>(e, correlationId);
    throw e;
  }
  const identity = identityOf(spec, envelope);
  const digest = commandRequestDigest({ operation: spec.id, aggregate: envelope.path, body: envelope.body });
  const request: AuthorizationRequest = { command: spec.id, identity: envelope.subject.identity, agencyId: identity.agencyId };
  const actor = { kind: "USER", userId: envelope.userId as UserId } as const;
  const run = <T>(work: (uow: SourceUnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.runSource(context, work);

  /** The access decision of a unit of work of this command: its live ACTIVE operating membership, or the recorded denial. */
  const authorized = async (uow: SourceUnitOfWork): Promise<{ readonly access: AllowDecision; readonly membership: ResolvedMembership }> => {
    const access = await runtime.authorizer.authorize(uow, request);
    if (access.kind === "DENY") throw new AuthorizationDenied(spec.id, access);
    if (access.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a tenant command was authorized without a membership");
    return { access, membership: access.membership };
  };

  let session: ResumableSession | null = null;
  let providers: SourceProviders | null = null;
  try {
    // --- unit of work 1: the access decision, the journal, the durable intent ------------------------------------------------
    const first = await run(async (uow): Promise<FirstPhase> => {
      const { access, membership } = await authorized(uow);
      const reservation = await uow.journal.reserve(identity, digest, correlationId);
      if (reservation.kind === "REPLAY") return { kind: "REPLAY", entry: reservation.entry };
      if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
      if (reservation.kind === "PENDING") {
        // D-RUN-2: an intent committed by an earlier attempt of this key; a young one is still in flight
        if (runtime.clock.nowMs() - Date.parse(reservation.entry.reservedAt) < PENDING_RESUME_GRACE_SECONDS * 1000) {
          throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
        }
        return resume(uow, reservation.entry, membership);
      }
      const decision = await runtime.authorizer.assure(uow, request, access);
      if (decision.kind === "DENY") throw new AuthorizationDenied(spec.id, decision);
      return intent(uow, reservation.entryId, membership);
    });
    if (first.kind === "REPLAY") return await replayed(first.entry);
    if (first.kind === "ANSWERED") return completed(await hydrateFromSecret(first.view), false);

    // --- the provider call, outside any transaction ---------------------------------------------------------------------------
    providers = requireProviders(collaborators);
    const upload = first.upload;
    const { location, objectName } = quarantineOf(providers.storage, upload);
    try {
      session = await providers.storage.createResumableSession({ location, objectName, declaredBytes: upload.reservedBytes, contentType: CONTENT_TYPES[upload.declaredFormat], origin: providers.origin }, PROVIDER_CALL_TIMEOUT_MS);
    } catch (cause) {
      const failure = new DomainFailure("CAPACITY_UNAVAILABLE", "the provider did not issue the session within its bound; the reservation stays pending", { reason: "SESSION_ISSUE_FAILED", retryAfterSeconds: PENDING_RESUME_GRACE_SECONDS }, true);
      failure.cause = cause;
      throw failure;
    }
    const issued = session;
    let sealed: Awaited<ReturnType<SourceProviders["vault"]["seal"]>>;
    try {
      sealed = await providers.vault.seal(issued.sessionRef, { agencyId: upload.agencyId, uploadId: upload.uploadId, requestedByUserId: upload.requestedByUserId, sessionAttempt: first.attempt });
    } catch (cause) {
      const failure = new DomainFailure("CAPACITY_UNAVAILABLE", "the session could not be sealed; the reservation stays pending", { reason: "SESSION_ISSUE_FAILED", retryAfterSeconds: PENDING_RESUME_GRACE_SECONDS }, true);
      failure.cause = cause;
      throw failure;
    }
    const lifetime = providers.storage.capabilities().sessionLifetimeSeconds;

    // --- unit of work 2: the access decision again, the fence, the session issued, the journal commit ----------------------
    const second = await run(async (uow): Promise<SecondPhase> => {
      const { membership } = await authorized(uow);
      const revision = await uow.sources.revisions.lock(upload.revisionId);
      const current = await uow.sources.uploads.lock(upload.uploadId);
      if (!revision || !current) throw new DomainFailure("INTEGRITY_FAILURE", "the reserved upload of a pending entry is not visible");
      // the deadline is judged at the effect instant, after the unit's last await (the locks above; CLOCK-SWEEP-B07 S2). The one await
      // before the effect (the session secret's INSERT) takes no lock this unit waits on; the database re-judges at the edge (KA072).
      const effectNow = await effectNowOf(uow);
      if (current.state !== "RESERVED" || current.sessionAttempt !== first.attempt || reachedOnServer(current.applicationExpiresAt, effectNow)) {
        if (current.state === "RESERVED" && current.sessionAttempt !== first.attempt && !reachedOnServer(current.applicationExpiresAt, effectNow)) {
          // a later attempt of the same key resumed the intent and holds the fence: it completes the operation (D-RUN-2)
          throw new DomainFailure("PRECONDITION_FAILED", "a later attempt of this operation holds its fence", { reason: "OPERATION_PENDING" }, true);
        }
        const view = await journaledView(uow, current, revision, membership);
        await commitJournal(uow, first.entryId, view, current.uploadId);
        return { kind: "ABANDONED", view };
      }
      await uow.sources.sessionSecrets.store({
        uploadId: current.uploadId,
        agencyId: current.agencyId,
        requestedByUserId: current.requestedByUserId,
        sessionAttempt: first.attempt,
        keyRef: sealed.keyRef,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        createdAt: runtime.clock.now(),
      });
      const providerSessionDigest: Sha256Hex = textDigest(issued.sessionRef);
      const moved = applied(await uow.sources.uploads.transition(current.uploadId, current.version, { event: "session_issued", sessionAttempt: first.attempt, providerSessionDigest, providerSessionLifetimeSeconds: lifetime }));
      await uow.events.publish({
        aggregateKind: "upload_session",
        aggregateId: moved.uploadId,
        aggregateVersion: moved.version,
        agencyId: moved.agencyId,
        eventType: "upload_session.session_issued.v1",
        actor,
        causationId: first.entryId as Id as CausationId,
        correlationId,
        payload: { uploadId: moved.uploadId, agencyId: moved.agencyId, revisionId: moved.revisionId, sessionAttempt: first.attempt, providerSessionDigest },
      });
      // rule 16 (Order 15 F-04, review R-01): the session is issued and its bearer credential delivered only under a credential that still
      // authenticates the request, fenced as this unit's last lock (a logout committed meanwhile rolls the issuance back; the session the
      // provider created is then cancelled, as for any attempt that did not complete)
      await judgedUnderHold(envelope.authority, uow, runtime.clock);
      const journaled = await commitJournal(uow, first.entryId, await journaledView(uow, moved, revision, membership, issued.chunkMultipleBytes), moved.uploadId);
      // the delivery of the bearer credential is a fact of the agency's stream, committed with the answer that carries it
      await recordDelivery(uow, membership.agencyId, spec.id);
      return { kind: "ISSUED", view: { ...journaled, session: sessionView(issued.sessionRef, moved, issued.chunkMultipleBytes) } };
    });
    if (second.kind === "ABANDONED") {
      await compensate(providers, issued);
      return completed(await hydrateFromSecret(second.view), false);
    }
    return completed(second.view, false);
  } catch (e) {
    // a session created by an attempt that did not complete is never delivered: cancelled best-effort (D-RUN-2)
    if (session !== null && providers !== null) await compensate(providers, session);
    return settleCommandFailure<ReserveUploadView>(runtime, context, spec.id, correlationId, e);
  }

  /** A fresh reservation: every precondition on the locked rows, then the intent (design §11 CMD013 steps 1–7). */
  async function intent(uow: SourceUnitOfWork, entryId: JournalEntryId, membership: ResolvedMembership): Promise<FirstPhase> {
    const storage = requireProviders(collaborators).storage;
    const agencyId = membership.agencyId;
    const revisionId = envelope.path["revisionId"] as RevisionId;
    const revision = await uow.sources.revisions.lock(revisionId);
    if (!revision || revision.agencyId !== agencyId) throw new DomainFailure("NOT_FOUND", "revision not visible");
    checkExpectedVersion(revision, envelope.body.expectedVersion);
    const agency = await uow.agencies.lockShared(agencyId);
    if (!agency) throw new DomainFailure("NOT_FOUND", "revision not visible");
    if (agency.state !== "ACTIVE") {
      throw new DomainFailure("PRECONDITION_FAILED", "customer data enters only an ACTIVE agency", { reason: "AGENCY_NOT_ACTIVE", currentVersion: agency.version, currentState: agency.state });
    }
    const project = await uow.projects.get(revision.projectId);
    if (!project) throw new DomainFailure("INTEGRITY_FAILURE", "a visible revision's project is not visible");
    if (project.state === "DELETION_REQUESTED" || project.state === "DELETED") {
      throw new DomainFailure("PRECONDITION_FAILED", "the project's deletion was requested", { reason: "PROJECT_DELETION_REQUESTED", currentVersion: project.version, currentState: project.state });
    }
    if (project.state !== "OPEN") {
      throw new DomainFailure("PRECONDITION_FAILED", "the project takes no new upload", { reason: "PROJECT_NOT_OPEN", currentVersion: project.version, currentState: project.state });
    }
    const capability = await uow.capabilities.lockMode(project.mode);
    if (!capability || !isOffered(capability)) throw new DomainFailure("CAPABILITY_UNAVAILABLE", "the project's mode is no longer offered", { reason: "MODE_NOT_OFFERED" });
    if (!REVISION_UPLOAD_STATES.has(revision.state)) {
      throw new DomainFailure("PRECONDITION_FAILED", "the revision accepts no upload", { reason: "REVISION_NOT_ACCEPTING_UPLOADS", currentVersion: revision.version, currentState: revision.state });
    }
    const declaredBytes = envelope.body.declaredBytes;
    if (declaredBytes < 1) {
      throw new DomainFailure("INVALID_REQUEST", "an upload declares its length", { reason: "EMPTY_DECLARATION", fields: [{ field: "declaredBytes", code: "RANGE" }] });
    }
    if (declaredBytes > INPUT_ENVELOPE.fileBytes) throw new DomainFailure("PRECONDITION_FAILED", "the declaration exceeds the per-file envelope", { reason: "FILE_TOO_LARGE" });
    // the messages of the envelope, before a provider session exists (09); the database decides on the committed ledgers (R2-052)
    const quota = await uow.sources.uploads.quota(revisionId);
    if (quota.reservedBytes + declaredBytes > INPUT_ENVELOPE.revisionBytes) throw new DomainFailure("PRECONDITION_FAILED", "the revision envelope cannot hold the declaration", { reason: "REVISION_QUOTA_EXCEEDED" });
    if (quota.fileCount + 1 > INPUT_ENVELOPE.files) throw new DomainFailure("PRECONDITION_FAILED", "the revision holds its fifty files", { reason: "REVISION_FILE_LIMIT" });
    const capacity = await uow.sources.uploads.capacity(agencyId);
    if (capacity.activeSessions >= capacity.sessionLimit) {
      throw new DomainFailure("ADMISSION_LIMITED", "the agency holds its concurrent upload sessions", { reason: "UPLOAD_CONCURRENCY_LIMITED" }, true);
    }
    const uploadId = uow.ids.next() as UploadId;
    const objectId = uow.ids.next() as StoredObjectId;
    const quarantine = quarantineOf(storage, { agencyId, projectId: revision.projectId, revisionId, uploadId });
    await uow.sources.objects.register({
      objectId,
      agencyId,
      projectId: revision.projectId,
      revisionId,
      uploadId,
      zone: "QUARANTINE",
      dataClass: "RAW",
      provider: quarantine.location.provider,
      locationRef: quarantine.location.locationRef,
      objectName: quarantine.objectName,
      createdBy: { kind: "MEMBERSHIP", membershipId: membership.membershipId as MembershipId },
      createdAt: runtime.clock.now(),
    });
    const upload = await uow.sources.uploads.insert({
      uploadId,
      agencyId,
      projectId: revision.projectId as ProjectId,
      revisionId,
      displayName: envelope.body.displayName,
      declaredFormat: envelope.body.declaredFormat,
      reservedBytes: declaredBytes,
      quarantineObjectId: objectId,
      requestedByMembershipId: membership.membershipId,
      requestedByUserId: envelope.userId as UserId,
    });
    const causationId = entryId as Id as CausationId;
    await uow.events.publish({
      aggregateKind: "upload_session",
      aggregateId: uploadId,
      aggregateVersion: upload.version,
      agencyId,
      eventType: "upload_session.reserved.v1",
      actor,
      causationId,
      correlationId,
      payload: { uploadId, agencyId, projectId: revision.projectId, revisionId, reservedBytes: declaredBytes, declaredFormat: upload.declaredFormat, requestedByMembershipId: membership.membershipId, state: upload.state },
    });
    await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId, projectId: revision.projectId, revisionId, uploadId, kind: "UPLOAD_INITIATED", sourceEvidenceHash: null });
    if (revision.state === "DRAFT") {
      const uploading = applied(await uow.sources.revisions.transition(revisionId, revision.version, { event: "upload_reserved", firstUploadId: uploadId }));
      await uow.events.publish({
        aggregateKind: "dataset_revision",
        aggregateId: revisionId,
        aggregateVersion: uploading.version,
        agencyId,
        eventType: "dataset_revision.uploading.v1",
        actor,
        causationId,
        correlationId,
        payload: { revisionId, agencyId, projectId: revision.projectId, firstUploadId: uploadId, state: uploading.state },
      });
    }
    // the intent is linked to the business object it created, so a retry of the key finds it (10: records are linked)
    await uow.sources.operations.attach(entryId, "upload_session", uploadId as Id);
    return { kind: "INTENT", entryId, upload, attempt: upload.sessionAttempt, membership };
  }

  /**
   * D-RUN-2: a PENDING entry older than the grace. Its upload still RESERVED and unexpired on the server clock is resumed under a
   * new issuance fence (a stale attempt can no longer issue a session, KA071); otherwise the intent cannot complete, and the journal
   * commits the upload's current view.
   */
  async function resume(uow: SourceUnitOfWork, entry: CommandJournalEntry, membership: ResolvedMembership): Promise<FirstPhase> {
    if (entry.resourceKind !== "upload_session" || entry.resourceId === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a pending entry of ReserveUpload is linked to no upload");
    const found = await uow.sources.uploads.get(entry.resourceId as UploadId);
    if (!found) throw new DomainFailure("INTEGRITY_FAILURE", "the reserved upload of a pending entry is not visible");
    const revision = await uow.sources.revisions.lock(found.revisionId);
    const upload = await uow.sources.uploads.lock(found.uploadId);
    if (!revision || !upload) throw new DomainFailure("INTEGRITY_FAILURE", "the reserved upload of a pending entry is not visible");
    // judged at the effect instant, after the resume's last await (the locks above; CLOCK-SWEEP-B07 S3)
    const effectNow = await effectNowOf(uow);
    if (upload.state === "RESERVED" && !reachedOnServer(upload.applicationExpiresAt, effectNow)) {
      const attempt = await uow.sources.uploads.claimSessionAttempt(upload.uploadId);
      if (attempt !== null) return { kind: "INTENT", entryId: entry.entryId, upload, attempt, membership };
    }
    const view = await journaledView(uow, upload, revision, membership);
    await commitJournal(uow, entry.entryId, view, upload.uploadId);
    return { kind: "ANSWERED", view, membership };
  }

  /** A replay: the journaled view, its session hydrated for the requester (a lost response is recovered by the same key). */
  async function replayed(entry: CommandJournalEntry): Promise<CommandResult<ReserveUploadView>> {
    if (entry.responseStatus !== 201 || entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
    return completed(await hydrateFromSecret(entry.responseBody as ReserveUploadView), true);
  }

  /**
   * The session member of a journaled view for its requester: the sealed secret the requester's row policy lets it read — only while
   * the upload is UPLOADING and unexpired on the server clock — opened by the vault outside any transaction, the delivery recorded
   * as an ALLOW fact; UNAVAILABLE otherwise (SESSION_PENDING before the session exists, SESSION_NOT_ACTIVE after).
   */
  async function hydrateFromSecret(view: ReserveUploadView): Promise<ReserveUploadView> {
    const uploadId = view.upload.uploadId as UploadId;
    const found = await run(async (uow) => {
      const upload = await uow.sources.uploads.get(uploadId);
      if (!upload) throw new DomainFailure("INTEGRITY_FAILURE", "a journaled upload is not visible");
      // a journaled answer hands out the upload's bearer credential: only under a credential that still authenticates the request (rule 16)
      await judgedUnderHold(envelope.authority, uow, runtime.clock);
      return { upload, secret: await uow.sources.sessionSecrets.readOwn(uploadId) };
    });
    if (found.secret === null) {
      return { ...view, session: unavailable(found.upload.requestedByUserId !== envelope.userId ? "NOT_REQUESTER" : found.upload.state === "RESERVED" ? "SESSION_PENDING" : "SESSION_NOT_ACTIVE") };
    }
    const vault = requireProviders(collaborators).vault;
    const sessionRef = await vault.open(found.secret, { agencyId: found.secret.agencyId, uploadId, requestedByUserId: found.secret.requestedByUserId, sessionAttempt: found.secret.sessionAttempt });
    await run((uow) => recordDelivery(uow, found.upload.agencyId, spec.id));
    const placeholder = view.session as Partial<JournaledSessionPlaceholder>;
    return { ...view, session: sessionView(sessionRef, found.upload, placeholder.chunkMultipleBytes) };
  }

  function completed(view: ReserveUploadView, replay: boolean): CommandResult<ReserveUploadView> {
    return { kind: "COMPLETED", status: 201, view, version: view.upload.version, replayed: replay };
  }

  async function commitJournal(uow: SourceUnitOfWork, entryId: JournalEntryId, view: ReserveUploadView, uploadId: UploadId): Promise<ReserveUploadView> {
    const committed = await uow.journal.commit(entryId, { responseStatus: 201, responseBody: view, resourceKind: "upload_session", resourceId: uploadId });
    if (committed.state !== "COMMITTED" || committed.responseStatus !== 201 || committed.responseBody === undefined) {
      throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
    }
    return committed.responseBody as ReserveUploadView;
  }

  async function recordDelivery(uow: SourceUnitOfWork, agencyId: AgencyId, action: string): Promise<void> {
    await uow.securityEvents.append({
      agencyId,
      requestedAgencyId: null,
      actor,
      action,
      outcome: "ALLOW",
      reasonCode: SESSION_DELIVERED,
      policyVersion: AUTHORIZATION_POLICY_VERSION,
      assuranceClass: "SESSION",
      correlationId,
      occurredAt: runtime.clock.now(),
    });
  }
}

/** The protected session view of a delivered reference (the one view that carries the URL, D-SESSION-2). */
export function sessionView(sessionRef: string, upload: Pick<UploadSessionRecord, "applicationExpiresAt">, chunkMultipleBytes: number | undefined): ProtectedSessionView {
  return {
    delivery: "PROTECTED_RESPONSE",
    uploadUrl: sessionRef,
    method: "PUT",
    ...(chunkMultipleBytes !== undefined ? { chunkMultipleBytes } : {}),
    applicationExpiresAt: utc(upload.applicationExpiresAt),
  };
}

/** Best-effort cancellation of a session no answer delivered (its result is not recorded: nobody ever held the reference). */
async function compensate(providers: SourceProviders, session: ResumableSession): Promise<void> {
  try {
    await providers.storage.cancelResumableSession(session.sessionRef, PROVIDER_CALL_TIMEOUT_MS);
  } catch {
    // best effort (D-RUN-2): an undelivered session is unusable without its reference and ends at the provider horizon
  }
}

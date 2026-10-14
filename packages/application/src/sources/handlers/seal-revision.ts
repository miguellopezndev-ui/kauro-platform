/**
 * CMD017 SealRevision — POST /api/v1/revisions/{revisionId}/seal — AGENCY_OPERATOR (design §11 CMD017; D-SEAL-1, D-HASH-1, D-HASH-4,
 * D-RET-2, D-RET-3, D-ANCH-2, D-FILE-1, D-CLOCK-1; catalogue "Atomically seals manifest, bytes, parser settings and billable-unit
 * interpretation"; failure "A changed generation, incomplete scan or version conflict leaves no executable sealed revision").
 *
 * Order: authorize → reserve → the revision row (NOT_FOUND) → its version (STALE_VERSION) → READY_TO_SEAL (SEALED → REVISION_SEALED,
 * otherwise REVISION_NOT_READY_TO_SEAL) → selectionHash is the bound selection's (STALE_VERSION / HASH_MISMATCH, mismatch
 * [selectionHash]) → no upload in flight (UPLOADS_UNRESOLVED) → the complete evaluation of the bound selection, and every included
 * file read after its transition lock (D-FILE-1): ADMITTED (INPUT_NOT_ADMITTED) at the generation, digest and length the evaluation
 * counted (GENERATION_CHANGED) → the revision manifest — HASHING's exact KAURO_SOURCE_REVISION_V1 preimage: the accepted files, the
 * table selection, the parser profile, the projection with the ProjectionIds this seal mints (D-HASH-1) — and the sealed subject
 * binding it to this revision with the frozen counts (D-HASH-4) → the first seal of the bytes (this seal for new bytes, an earlier
 * real seal for reused ones; a hard cap already behind this seal → REUSE_NOT_AVAILABLE, D-RET-3) → the sealed manifest and file set
 * at the server's instant (bound at COMMIT to this very seal, D-SEAL-1), the REVISION_SEALED anchor, the UNPAID record anchored on the
 * first seal (hard = effective = that seal + fourteen days, retention_record.created.v1), READY_TO_SEAL → SEALED with the manifest,
 * projection and counts at the server's instant (dataset_revision.sealed.v1) → journal 200 SealRevisionView. The database checks the
 * whole sealed subject at COMMIT (dataset_revisions_sealed_subject).
 *
 * The provider's accepted generations, held from before the unit of work through the retention of the sealed bytes (B07-R1;
 * S053 "observe actual bytes/generation before admission or sealing"; catalogue CMD017 failure "a changed generation ... leaves no
 * executable sealed revision"; decisions D-HOLD-1..D-HOLD-3). Neither the stored file nor the evaluation changes when the provider
 * replaces or loses an accepted object out of band, and no transaction spans a provider call (§5), so the seal cannot lock the
 * provider inside its unit of work. Instead, before it, the seal places a provider hold on the exact accepted generation of every
 * included file of the bound selection: a unit of work behind the same access decision as the command records each hold INTENDED
 * under one attempt id (nothing when the caller is refused or the revision is not the READY_TO_SEAL revision of the body's version
 * and selection: the pipeline then answers its own refusal and no provider is asked), then `ObjectStoragePort.placeHold` with a
 * generation precondition, bounded by PROVIDER_CALL_TIMEOUT_MS. From a HELD answer on, the provider refuses to replace or delete that
 * generation. Inside the unit of work each included file, after its transition lock and the recorded checks, must be exactly what
 * the provider held: GENERATION_NOT_LIVE (another generation, or none) or another length is 409 GENERATION_CHANGED; an unanswered
 * placement (or a file the placement did not reach, a release of its object in progress, or a hold the control plane abandoned
 * past its bound) is 503 CAPACITY_UNAVAILABLE / GENERATION_NOT_OBSERVED, retryable under the same key since a refusal leaves no
 * journal row. No hold is intended while a release of the object may still land at the provider (a hold RELEASING, or a release claim
 * neither answered nor past its in-flight bound — the provider's hold is a flag, and a late release would clear the new one): the file
 * is then not placed (503 GENERATION_NOT_OBSERVED, retry). The seal marks its holds SEALED in its own transaction, after its sealed
 * file set, and after its commit re-asserts each of them at the provider and records what it found (D-HOLD-2): a hold missing on the
 * live generation is placed again, a generation that is not live any more is handed to OBJECT_INVENTORY's revocation. A sealed subject
 * keeps its holds until its retention ends (the RETENTION sweeper releases them with the file's admission, D-RET-3). A seal that is
 * refused, fails or is answered by a replay closes its attempt's holds (REFUSED) and releases what nothing else needs, each release
 * under its own claim (D-HOLD-3); a crash between the hold and the commit leaves them INTENDED, and RETENTION abandons and releases
 * them past their bound (SEAL_HOLD_ATTEMPT_SECONDS). Every hold records the metageneration its placement answered (SEALED with the
 * seal, or as its attempt closes) and every release names the greatest one recorded (ifMetagenerationMatch, D-HOLD-4): a release that
 * lands late — a timed-out call is not cancelled — fails its precondition once a newer hold was placed, and clears nothing. The clauses
 * that rest on the provider honouring the hold and its preconditions are SIMULATED (the labelled storage fake) until B15 binds Cloud
 * Storage. Unbound providers answer SOURCE_SERVICES_UNAVAILABLE (D-SAPI-6).
 */
import type { CommandId, Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  EvaluatedTable,
  HoldReassertionId,
  HoldReleaseAnswer,
  HoldReleaseId,
  ObjectHoldId,
  ProjectionId,
  RetentionAnchorId,
  RetentionId,
  RevisionId,
  SealAttemptId,
  SealedFileEntry,
  SealedProjection,
  SealedSubjectDocument,
  SourceFileId,
  SourceFileRecord,
  SourceRevisionManifest,
  SourceTableId,
  SourceTableRecord,
  StoredObjectId,
  UserId,
} from "@kauro/domain";
import { DomainFailure, INPUT_ENVELOPE, RETENTION_POLICY_VERSION, StaleVersionFailure, UPLOAD_LIVE_STATES, effectNowOf, projectionHashOf, sealedSubjectHashOf, sourceRevisionManifestHashOf, unpaidSealedDeadlines } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { contextOf, identityOf } from "../../commands/runtime.js";
import type { ObjectStoragePort, StorageLocation } from "../../ports/source-providers.js";
import { boundedProviderCall, claimStillHeld, monotonicMs, reassertHold, releaseUnderClaim, type HoldReassertion, type ReleaseTarget } from "../provider-holds.js";
import { SEAL_REVISION, type SealRevisionBody, type SealRevisionHandler, type SealRevisionView } from "../contracts.js";
import { readRevisionView, retentionView } from "./projections.js";
import { reachedOnServer, requireProviders, runSourceCommand, versionAt, type B07Collaborators, type SourceRuntime } from "./shared.js";

/** What the provider answered the hold placement on the accepted generation of one included file at seal time (B07-R1, D-HOLD-1). */
type PlacedHold =
  | {
      readonly kind: "HELD";
      readonly holdId: ObjectHoldId;
      readonly objectId: StoredObjectId;
      readonly location: StorageLocation;
      readonly objectName: string;
      readonly generation: string;
      readonly bytes: number;
      /** The metageneration the placement answered: the hold incarnation its release names (D-HOLD-4). */
      readonly metageneration: string;
    }
  | { readonly kind: "GENERATION_NOT_LIVE"; readonly holdId: ObjectHoldId }
  | { readonly kind: "UNOBSERVED" };

/** One execution's holds: the attempt id they are recorded under, and the placement of each included file (by file id). */
interface SealAttempt {
  readonly attemptId: SealAttemptId;
  readonly placed: Map<string, PlacedHold>;
  /** Whether any hold was recorded INTENDED (then a seal that did not commit closes and releases them). */
  intended: boolean;
}

export function sealRevisionHandler(runtime: SourceRuntime, collaborators: B07Collaborators): SealRevisionHandler {
  return {
    spec: SEAL_REVISION,
    execute: async (envelope) => {
      const attempt = await holdIncludedGenerations(runtime, collaborators, envelope);
      const sealing = runSourceCommand<SealRevisionBody, SealRevisionView>(
        SEAL_REVISION,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          requireProviders(collaborators);
          const agencyId = membership.agencyId;
          const revisionId = envelope.path["revisionId"] as RevisionId;
          const revision = await uow.sources.revisions.lock(revisionId);
          if (!revision || revision.agencyId !== agencyId) throw new DomainFailure("NOT_FOUND", "revision not visible");
          checkExpectedVersion(revision, envelope.body.expectedVersion);
          const current = { currentVersion: revision.version, currentState: revision.state };
          if (revision.state === "SEALED") throw new DomainFailure("PRECONDITION_FAILED", "the revision is already sealed", { reason: "REVISION_SEALED", ...current });
          if (revision.state !== "READY_TO_SEAL") throw new DomainFailure("PRECONDITION_FAILED", "the revision's selected scope is not ready to seal", { reason: "REVISION_NOT_READY_TO_SEAL", ...current });
          if (envelope.body.selectionHash !== revision.selectionHash) throw new StaleVersionFailure(revision.version, revision.state, { reason: "HASH_MISMATCH", mismatch: ["selectionHash"] });
          const live = await uow.sources.uploads.inStates(revisionId, [...UPLOAD_LIVE_STATES] as ReadonlyArray<"RESERVED" | "UPLOADING" | "VERIFYING">);
          if (live.length > 0) throw new DomainFailure("PRECONDITION_FAILED", "a reservation, session or verification of the revision is still open", { reason: "UPLOADS_UNRESOLVED", ...current });
          if (revision.selectionManifestId === undefined || revision.evaluationId === undefined || revision.populations === undefined || revision.evaluationHash === undefined) {
            throw new DomainFailure("INTEGRITY_FAILURE", "a READY_TO_SEAL revision binds no counted selection");
          }
          const manifestRecord = await uow.sources.selections.get(revisionId, revision.selectionManifestId);
          const evaluation = await uow.sources.evaluations.get(revision.evaluationId);
          const project = await uow.projects.get(revision.projectId);
          if (!manifestRecord || !evaluation || evaluation.result !== "COMPLETE" || evaluation.selectionHash !== revision.selectionHash || !project) {
            throw new DomainFailure("INTEGRITY_FAILURE", "the counted selection of a READY_TO_SEAL revision is not readable");
          }
          const selection = manifestRecord.body;

          // every included file after its transition lock (D-FILE-1): admitted, at exactly the counted generation, digest and length
          const files = new Map<string, SourceFileRecord>();
          for (const entry of selection.files) {
            const file = await (entry.disposition === "INCLUDE" ? uow.sources.files.lockShared(entry.fileId) : uow.sources.files.get(entry.fileId));
            if (!file) throw new DomainFailure("INTEGRITY_FAILURE", "a file of the bound selection is not visible");
            files.set(file.fileId, file);
            if (entry.disposition !== "INCLUDE") continue;
            // the object inventory revokes a file whose accepted generation changed at the provider (D-FILE-1): that is the changed
            // generation of step 6; any other revocation (an expired intake, an ended retention, a lost generation) is a revoked
            // admission (decision D-CMD-9)
            if (file.state === "ADMISSION_REVOKED" && file.revocationReason === "GENERATION_CHANGED") {
              throw new DomainFailure("PRECONDITION_FAILED", "an included file's accepted generation changed after the evaluation", { reason: "GENERATION_CHANGED", ...current });
            }
            if (file.state !== "ADMITTED" || !file.admitted) throw new DomainFailure("PRECONDITION_FAILED", "an included file's admission was revoked", { reason: "INPUT_NOT_ADMITTED", ...current });
            const counted = evaluation.files.find((f) => f.fileId === file.fileId);
            if (counted === undefined || counted.generation !== file.providerGeneration || counted.sha256 !== file.sha256 || counted.bytes !== file.bytes) {
              throw new DomainFailure("PRECONDITION_FAILED", "an included file is not the generation the evaluation counted", { reason: "GENERATION_CHANGED", ...current });
            }
            // B07-R1: the provider holds exactly the counted generation (placed before this unit of work, D-HOLD-1)
            const placed = attempt.placed.get(file.fileId);
            if (placed === undefined || placed.kind === "UNOBSERVED") throw generationNotObserved("the provider's hold on the generation of an included file was not placed at seal time");
            if (placed.kind === "GENERATION_NOT_LIVE" || placed.generation !== file.providerGeneration || placed.bytes !== file.bytes) {
              throw new DomainFailure("PRECONDITION_FAILED", "the provider no longer holds the counted generation of an included file", { reason: "GENERATION_CHANGED", ...current });
            }
          }
          const tablesOf = new Map<string, ReadonlyArray<SourceTableRecord>>();
          for (const fileId of files.keys()) tablesOf.set(fileId, await uow.sources.files.tables(fileId as SourceFileId));
          const choiceOf = new Map(selection.tables.map((t) => [t.tableId as string, t]));
          const included = selection.files.filter((f) => f.disposition === "INCLUDE").map((f) => files.get(f.fileId) as SourceFileRecord);

          // the revision manifest: HASHING's four members exactly (D-HASH-1), projection ids minted by this seal
          const projectionIds = new Map(selection.projections.map((p) => [p.projectionKey, uow.ids.next() as ProjectionId]));
          const counts = new Map(evaluation.projections.map((p) => [p.projectionKey, p]));
          const projections: Array<Omit<SealedProjection, "logicalRecords">> = selection.projections.map((p) => ({
            projectionId: projectionIds.get(p.projectionKey) as ProjectionId,
            projectionKey: p.projectionKey,
            tableId: p.tableId,
            objectKind: p.objectKind,
            kind: p.kind,
            fieldOrdinals: [...p.fieldOrdinals],
            ...(p.keyOrdinals !== undefined ? { keyOrdinals: [...p.keyOrdinals] } : {}),
            billable: counts.get(p.projectionKey)?.billable ?? false,
          }));
          const projection: SourceRevisionManifest["projection"] = {
            projections,
            associations: selection.associations.map((a) => ({
              associationKey: a.associationKey,
              tableId: a.tableId,
              fromProjectionId: projectionIds.get(a.fromProjectionKey) as ProjectionId,
              toProjectionId: projectionIds.get(a.toProjectionKey) as ProjectionId,
              relationType: a.relationType,
            })),
            pricingDefinition: evaluation.pricingDefinition,
          };
          const manifest: SourceRevisionManifest = {
            files: included.map((f) => ({ fileId: f.fileId, providerGeneration: f.providerGeneration, sha256: f.sha256, bytes: f.bytes })),
            tableSelection: selection.files.map((entry) => ({
              fileId: entry.fileId,
              disposition: entry.disposition === "INCLUDE" ? "INCLUDED" : "EXCLUDED",
              exclusionReason: entry.exclusionReason ?? null,
              tables: (tablesOf.get(entry.fileId) ?? [])
                .filter((t) => choiceOf.has(t.tableId))
                .map((t) => {
                  const choice = choiceOf.get(t.tableId);
                  return {
                    tableId: t.tableId,
                    ordinal: t.ordinal,
                    structureHash: t.structureHash,
                    visibility: t.visibility,
                    disposition: choice?.disposition === "INCLUDE" ? "INCLUDED" : "EXCLUDED",
                    exclusionReason: choice?.exclusionReason ?? null,
                    selectedColumns: choice?.selectedColumns === undefined ? null : [...choice.selectedColumns],
                  } as const;
                }),
            })),
            parserProfile: included.map((f) => ({
              fileId: f.fileId,
              format: f.format,
              parserProfileHash: f.parserProfileHash,
              tables: (tablesOf.get(f.fileId) ?? []).filter((t) => choiceOf.get(t.tableId)?.disposition === "INCLUDE").map((t) => ({ tableId: t.tableId, parser: choiceOf.get(t.tableId)?.parser ?? null })),
            })),
            projection,
          };
          const manifestHash = sourceRevisionManifestHashOf(manifest);
          const projectionHash = projectionHashOf(projection);

          // the sealed subject (D-HASH-4): this revision and its lineage, the frozen counts, the admitting receipts, the rejected uploads
          const tableCounts = new Map(evaluation.tables.map((t) => [t.tableId as string, t]));
          const rejected = await uow.sources.uploads.inStates(revisionId, ["REJECTED"]);
          const subject: SealedSubjectDocument = {
            canonicalVersion: 1,
            revisionId,
            projectId: revision.projectId,
            supersedesRevisionId: revision.supersedesRevisionId ?? null,
            manifestHash,
            projectionHash,
            selectionHash: revision.selectionHash as Sha256Hex,
            evaluationHash: revision.evaluationHash,
            populations: revision.populations,
            files: included.map((f) => ({
              fileId: f.fileId,
              inspectionReceiptHash: f.inspectionReceiptHash,
              tables: (tablesOf.get(f.fileId) ?? []).filter((t) => choiceOf.get(t.tableId)?.disposition === "INCLUDE").map((t) => ({ tableId: t.tableId as SourceTableId, physicalRows: tableCounts.get(t.tableId)?.physicalRows ?? null })),
            })),
            projections: projections.map((p) => ({ projectionId: p.projectionId, logicalRecords: counts.get(p.projectionKey)?.logicalRecords ?? 0, billable: p.billable })),
            associations: associationEdges(selection.associations.map((a) => a.associationKey), evaluation.tables, revision.populations.associationEdges),
            rejectedUploads: rejected.map((u) => ({ uploadId: u.uploadId, rejectionClass: u.terminalReason as SealedSubjectDocument["rejectedUploads"][number]["rejectionClass"] })),
            inputEnvelope: { files: INPUT_ENVELOPE.files, fileBytes: INPUT_ENVELOPE.fileBytes, revisionBytes: INPUT_ENVELOPE.revisionBytes },
          };
          const subjectHash = sealedSubjectHashOf(subject);

          // D-RET-3: the hard cap belongs to the bytes — the first real seal of any included file, else this seal
          const earlier = await uow.sources.seals.firstSeals(included.map((f) => f.fileId));
          const first = [...earlier].sort((a, b) => (a.sealedAt < b.sealedAt ? -1 : a.sealedAt > b.sealedAt ? 1 : 0))[0];
          // judged at the effect instant, after the unit's last await before it (CLOCK-SWEEP-B07 S4); the deferred COMMIT trigger
          // re-judges the bytes' cap at kauro.effect_now() (0011:565 as replaced)
          const effectNow = await effectNowOf(uow);
          if (first !== undefined && reachedOnServer(unpaidSealedDeadlines(first.sealedAt as UtcInstant).hardDeadline, effectNow)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the reused bytes' window closed before this seal; reuse needs a new upload", { reason: "REUSE_NOT_AVAILABLE", ...current });
          }

          const fileSet: SealedFileEntry[] = selection.files.map((entry, ordinal) => {
            const f = files.get(entry.fileId) as SourceFileRecord;
            return {
              fileId: f.fileId,
              ordinal,
              disposition: entry.disposition === "INCLUDE" ? "INCLUDED" : "EXCLUDED",
              ...(entry.disposition === "EXCLUDE" && entry.exclusionReason !== undefined ? { exclusionReason: entry.exclusionReason } : {}),
              providerGeneration: f.providerGeneration,
              sha256: f.sha256,
              bytes: f.bytes,
            };
          });
          await uow.sources.seals.insert(
            { revisionId, agencyId, projectId: revision.projectId, manifestHash, projectionHash, selectionHash: revision.selectionHash as Sha256Hex, evaluationHash: revision.evaluationHash, subjectHash, manifest, subject },
            fileSet,
          );
          // the holds this seal commits with (D-HOLD-2): SEALED in this transaction, after the sealed file set names each generation, in
          // object-id order, each with the metageneration its placement answered (D-HOLD-4); one the control plane abandoned past its
          // bound is not the seal's any more
          const held = included.map((f) => attempt.placed.get(f.fileId)).filter((h): h is Extract<PlacedHold, { kind: "HELD" }> => h !== undefined && h.kind === "HELD");
          for (const hold of [...held].sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0))) {
            if ((await uow.sources.holds.seal(hold.holdId, hold.metageneration)).kind !== "APPLIED") throw generationNotObserved("the provider hold of an included file is no longer this seal's (past its bound)");
          }
          const anchor = await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId, projectId: revision.projectId, revisionId, kind: "REVISION_SEALED", sourceEvidenceHash: manifestHash });
          const record = await uow.sources.retention.insertUnpaidRecord({
            retentionId: uow.ids.next() as RetentionId,
            agencyId,
            clientId: project.clientId,
            projectId: revision.projectId,
            revisionId,
            anchorId: first?.anchorId ?? anchor.anchorId,
            policyVersion: RETENTION_POLICY_VERSION,
          });
          const actor = { kind: "USER", userId: envelope.userId as UserId } as const;
          await uow.events.publish({
            aggregateKind: "retention_record",
            aggregateId: record.retentionId,
            aggregateVersion: record.version,
            agencyId,
            eventType: "retention_record.created.v1",
            actor,
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: { retentionId: record.retentionId, agencyId, projectId: revision.projectId, revisionId, retentionClass: record.class, anchorEvidenceHash: record.anchorEvidenceHash, policyVersion: record.policyVersion },
          });
          const sealedFileCount = included.length;
          const sealedBytes = included.reduce((n, f) => n + f.bytes, 0);
          const sealed = applied(await uow.sources.revisions.transition(revisionId, revision.version, { event: "seal_command", manifestHash, projectionHash, sealedFileCount, sealedBytes }));
          const p = revision.populations;
          await uow.events.publish({
            aggregateKind: "dataset_revision",
            aggregateId: revisionId,
            aggregateVersion: sealed.version,
            agencyId,
            eventType: "dataset_revision.sealed.v1",
            actor,
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: {
              revisionId,
              agencyId,
              projectId: revision.projectId,
              manifestHash,
              projectionHash,
              selectionHash: revision.selectionHash as Sha256Hex,
              evaluationHash: revision.evaluationHash,
              physicalSourceRows: p.physicalSourceRows,
              logicalSourceRecords: p.logicalSourceRecords,
              billableSourceUnits: p.billableSourceUnits,
              associationEdges: p.associationEdges,
              fileCount: sealedFileCount,
              sealedBytes,
              retentionId: record.retentionId,
            },
          });
          const view: SealRevisionView = { revision: await readRevisionView(uow, sealed, membership.role), manifestHash, projectionHash, sealedSubjectHash: subjectHash, retention: retentionView(record) };
          return { status: 200, view, version: sealed.version, resourceKind: "dataset_revision", resourceId: revisionId as Id };
        },
        versionAt("revision"),
      );
      return settleAttempt(runtime, collaborators, envelope, attempt, sealing);
    },
  };
}

/**
 * The seal's answer, once its holds are settled (D-HOLD-2, D-HOLD-3): a seal that committed now marked its holds SEALED and re-asserts
 * them at the provider before it answers; any other end — a refusal, a replay of another execution, a failure — closes and releases
 * the attempt's holds before the answer (or the failure) leaves the handler.
 */
async function settleAttempt(runtime: SourceRuntime, collaborators: B07Collaborators, envelope: CommandEnvelope<SealRevisionBody>, attempt: SealAttempt, sealing: Promise<CommandResult<SealRevisionView>>): Promise<CommandResult<SealRevisionView>> {
  const providers = collaborators.providers;
  let result: CommandResult<SealRevisionView>;
  try {
    result = await sealing;
  } catch (e) {
    if (attempt.intended && providers !== null) await releaseAttemptHolds(runtime, providers.storage, envelope, attempt);
    throw e;
  }
  const committed = result.kind === "COMPLETED" && !result.replayed;
  if (providers === null) return result;
  if (committed) await reassertSealedHolds(runtime, providers.storage, envelope, attempt);
  else if (attempt.intended) await releaseAttemptHolds(runtime, providers.storage, envelope, attempt);
  return result;
}

/** 503 CAPACITY_UNAVAILABLE / GENERATION_NOT_OBSERVED: retryable under the same key (a refusal leaves no journal row). */
function generationNotObserved(message: string): DomainFailure {
  return new DomainFailure("CAPACITY_UNAVAILABLE", message, { reason: "GENERATION_NOT_OBSERVED", retryAfterSeconds: 1 }, true);
}

/** The id-ordered comparison of two ids (the hold locks' order, D-HOLD-2). */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * B07-R1 (D-HOLD-1, D-HOLD-2): the provider hold on the exact accepted generation of every included file of the bound selection,
 * placed outside any transaction (see the module comment). The holds are recorded INTENDED first — in a unit of work behind the
 * command's own access decision, under this execution's attempt id, in object-id order — so a crash after a placement leaves a
 * record the control plane reconciles; nothing is recorded and no provider is asked when the caller is refused, no provider is
 * bound, or the revision is not the READY_TO_SEAL revision of the body's version and selection (the pipeline then answers its
 * refusal, or replays a journaled seal). A file whose admission no longer stands is left to the seal's own refusal; a file whose
 * object is being released, or whose last release may still land at the provider (D-HOLD-3), is not placed (UNOBSERVED: retry). A
 * DomainFailure of that unit of work (no connection, a context the pipeline refuses, a hold the database refuses because the file
 * was revoked meanwhile) records nothing: the pipeline meets the same condition and answers it.
 */
async function holdIncludedGenerations(runtime: SourceRuntime, collaborators: B07Collaborators, envelope: CommandEnvelope<SealRevisionBody>): Promise<SealAttempt> {
  const attempt: SealAttempt = { attemptId: runtime.ids.next() as SealAttemptId, placed: new Map(), intended: false };
  if (collaborators.providers === null) return attempt;
  const storage = collaborators.providers.storage;
  type Intent = { readonly fileId: string; readonly holdId: ObjectHoldId; readonly objectId: StoredObjectId; readonly location: StorageLocation; readonly objectName: string; readonly generation: string } | { readonly fileId: string; readonly releasePending: true };
  let intents: ReadonlyArray<Intent>;
  try {
    const context = contextOf(SEAL_REVISION, envelope);
    const agencyId = identityOf(SEAL_REVISION, envelope).agencyId;
    intents = await runtime.unitOfWork.runSource(context, async (uow) => {
      const access = await runtime.authorizer.authorize(uow, { command: SEAL_REVISION.id as CommandId, identity: envelope.subject.identity, agencyId });
      if (access.kind === "DENY") return [];
      const revision = await uow.sources.revisions.get(envelope.path["revisionId"] as RevisionId);
      if (
        revision === null ||
        revision.agencyId !== agencyId ||
        revision.state !== "READY_TO_SEAL" ||
        revision.version !== envelope.body.expectedVersion ||
        revision.selectionHash !== envelope.body.selectionHash ||
        revision.selectionManifestId === undefined
      ) {
        return [];
      }
      const manifest = await uow.sources.selections.get(revision.revisionId, revision.selectionManifestId);
      if (manifest === null) return [];
      const candidates: Array<{ readonly file: SourceFileRecord; readonly objectId: StoredObjectId; readonly location: StorageLocation; readonly objectName: string }> = [];
      for (const entry of manifest.body.files) {
        if (entry.disposition !== "INCLUDE") continue;
        const file = await uow.sources.files.get(entry.fileId);
        if (file === null || file.state !== "ADMITTED") continue;
        const object = await uow.sources.objects.get(file.storageRef);
        if (object === null) continue;
        candidates.push({ file, objectId: object.objectId, location: { provider: object.provider, locationRef: object.locationRef }, objectName: object.objectName });
      }
      const out: Intent[] = [];
      for (const c of candidates.sort((a, b) => byId(a.objectId, b.objectId))) {
        const holdId = uow.ids.next() as ObjectHoldId;
        const intended = await uow.sources.holds.intend({
          holdId,
          attemptId: attempt.attemptId,
          agencyId: revision.agencyId,
          projectId: revision.projectId,
          revisionId: revision.revisionId,
          fileId: c.file.fileId,
          objectId: c.objectId,
          generation: c.file.providerGeneration,
          placedByUserId: envelope.userId as UserId,
        });
        out.push(intended.kind === "INTENDED" ? { fileId: c.file.fileId, holdId, objectId: c.objectId, location: c.location, objectName: c.objectName, generation: c.file.providerGeneration } : { fileId: c.file.fileId, releasePending: true });
      }
      return out;
    });
  } catch (e) {
    if (e instanceof DomainFailure) return attempt;
    throw e;
  }
  for (const intent of intents) {
    if ("releasePending" in intent) {
      attempt.placed.set(intent.fileId, { kind: "UNOBSERVED" });
      continue;
    }
    attempt.intended = true;
    attempt.placed.set(intent.fileId, await place(storage, intent));
  }
  return attempt;
}

/**
 * One hold placement of the storage port with its generation precondition, bounded by PROVIDER_CALL_TIMEOUT_MS; a failure or no answer
 * in time is UNOBSERVED (the placement may still have landed: the attempt's release covers it, D-HOLD-3).
 */
async function place(storage: ObjectStoragePort, intent: { readonly holdId: ObjectHoldId; readonly objectId: StoredObjectId; readonly location: StorageLocation; readonly objectName: string; readonly generation: string }): Promise<PlacedHold> {
  const answer = await boundedProviderCall(storage.placeHold(intent.location, intent.objectName, intent.generation));
  if (!answer.answered) return { kind: "UNOBSERVED" };
  if (answer.value.outcome === "GENERATION_NOT_LIVE") return { kind: "GENERATION_NOT_LIVE", holdId: intent.holdId };
  const { observation, metageneration } = answer.value;
  return { kind: "HELD", holdId: intent.holdId, objectId: intent.objectId, location: intent.location, objectName: intent.objectName, generation: observation.generation, bytes: observation.bytes, metageneration };
}

/**
 * D-HOLD-3: a seal that did not commit — refused, failed, or answered by a replay of another execution — closes the holds its attempt
 * recorded (REFUSED, each placed one with the metageneration its placement answered, D-HOLD-4) and releases, at the provider, every
 * object whose hold nothing else needs any more (no other attempt in flight, no seal retaining it), recording the provider's answer.
 * Each release is this execution's only under the claim the database recorded for it (its fence token): the provider call names the
 * claim's metageneration (`releaseUnderClaim`: re-observed and re-based under the live claim when none is recorded or the provider
 * refuses it, 412), is issued only while the claim holds and bounded by PROVIDER_CALL_TIMEOUT_MS, and the answer is recorded under the
 * same claim (a claim another caller superseded records nothing). Best effort and never the command's answer: whatever it does not
 * finish (a lost connection, an unanswered release) stays recorded — INTENDED past its bound, or RELEASING under a claim that lapses —
 * and the RETENTION sweeper abandons, claims again and releases it; a timed-out call that lands later names an incarnation a newer
 * hold has superseded, and clears nothing.
 */
async function releaseAttemptHolds(runtime: SourceRuntime, storage: ObjectStoragePort, envelope: CommandEnvelope<SealRevisionBody>, attempt: SealAttempt): Promise<void> {
  try {
    const context = contextOf(SEAL_REVISION, envelope);
    const started = monotonicMs();
    const placed = [...attempt.placed.values()].filter((h): h is Extract<PlacedHold, { kind: "HELD" }> => h.kind === "HELD").map((h) => ({ holdId: h.holdId, metageneration: h.metageneration }));
    const releases = await runtime.unitOfWork.runSource(context, async (uow) => {
      const closed = await uow.sources.holds.closeAttempt(attempt.attemptId, placed);
      const out: Array<{ readonly releaseId: HoldReleaseId; readonly target: ReleaseTarget }> = [];
      for (const objectId of [...new Set(closed.map((h) => h.objectId))].sort(byId)) {
        const decision = await uow.sources.holds.requestRelease(objectId, uow.ids.next() as HoldReleaseId);
        if (decision.kind !== "RELEASE") continue;
        const object = await uow.sources.objects.get(objectId);
        if (object === null) continue;
        const location: StorageLocation = { provider: object.provider, locationRef: object.locationRef };
        out.push({ releaseId: decision.releaseId, target: { location, objectName: object.objectName, generation: decision.generation, ...(decision.metageneration === undefined ? {} : { metageneration: decision.metageneration }) } });
      }
      return out;
    });
    const answers: Array<{ readonly releaseId: HoldReleaseId; readonly result: HoldReleaseAnswer }> = [];
    for (const r of releases) {
      const answer = await releaseUnderClaim(storage, r.target, {
        // a claim that lapsed before its call is issued is left to the next claimant (D-HOLD-3)
        stillHeld: () => claimStillHeld(started),
        rebase: async (metageneration) => {
          try {
            return (await runtime.unitOfWork.runSource(context, (uow) => uow.sources.holds.rebaseRelease(r.releaseId, metageneration))).kind === "REBASED";
          } catch {
            return false;
          }
        },
      });
      if (answer.answered) answers.push({ releaseId: r.releaseId, result: answer.value });
    }
    if (answers.length === 0) return;
    await runtime.unitOfWork.runSource(context, async (uow) => {
      for (const a of answers) await uow.sources.holds.recordRelease(a.releaseId, a.result);
    });
  } catch {
    // left recorded for the RETENTION sweeper (D-HOLD-3)
  }
}

/**
 * D-HOLD-2: after its commit the seal re-asserts every hold it sealed — the idempotent placement with the generation precondition,
 * then a re-observation of the generation and its hold flag; a hold found missing on the live generation is placed again
 * (`reassertHold`) — and records each finding (HELD with the metageneration observed with the hold, the hold's latest incarnation a
 * release names, D-HOLD-4; or GENERATION_NOT_LIVE) before it answers. A generation that is not live any more is never a silent
 * success: its finding is recorded for OBJECT_INVENTORY, which revokes the file's admission
 * (GENERATION_CHANGED, GENERATION_MISSING — whatever retains it, the sealed revision included). The seal's answer stays the journaled
 * 200 (the seal committed, and a replay answers the same); whatever is not answered or not recorded (the provider silent, the process
 * gone) is re-asserted by OBJECT_INVENTORY once the attempt bound passed.
 */
async function reassertSealedHolds(runtime: SourceRuntime, storage: ObjectStoragePort, envelope: CommandEnvelope<SealRevisionBody>, attempt: SealAttempt): Promise<void> {
  try {
    const held = [...attempt.placed.values()].filter((h): h is Extract<PlacedHold, { kind: "HELD" }> => h.kind === "HELD").sort((a, b) => byId(a.objectId, b.objectId));
    const findings: Array<{ readonly holdId: ObjectHoldId; readonly found: HoldReassertion }> = [];
    for (const hold of held) {
      const found = await reassertHold(storage, hold.location, hold.objectName, hold.generation);
      if (found !== null) findings.push({ holdId: hold.holdId, found });
    }
    if (findings.length === 0) return;
    await runtime.unitOfWork.runSource(contextOf(SEAL_REVISION, envelope), async (uow) => {
      for (const f of findings) {
        const metageneration = f.found.result === "HELD" ? f.found.metageneration : undefined;
        await uow.sources.holds.recordReassertion({ reassertionId: uow.ids.next() as HoldReassertionId, holdId: f.holdId, result: f.found.result, reassertedBy: "SEAL", ...(metageneration === undefined ? {} : { metageneration }) });
      }
    });
  } catch {
    // unrecorded: OBJECT_INVENTORY re-asserts the hold once the attempt bound passed (D-HOLD-2)
  }
}

/**
 * The edges of each declared association (the sealed subject's per-association counts). The SELECTION_EVALUATION consumer records
 * the evaluator's measured edges of every declared association with its table (B07-R2), under the evaluation hash; they are read as
 * is, and together they must be exactly the evaluation's frozen association population. An evaluation without the split states
 * the edges of a single declared association as its total; several associations without their split, a split that does not add
 * up, or an association measured twice are an integrity failure — the subject never states a count nobody measured (D-CMD-8).
 */
function associationEdges(keys: ReadonlyArray<string>, tables: ReadonlyArray<EvaluatedTable>, total: number): SealedSubjectDocument["associations"] {
  if (keys.length === 0) return [];
  const measured = new Map<string, number>();
  for (const t of tables) {
    for (const a of t.associations ?? []) {
      if (measured.has(a.associationKey)) throw new DomainFailure("INTEGRITY_FAILURE", "the evaluation measures an association twice");
      measured.set(a.associationKey, a.edges);
    }
  }
  if (measured.size === 0 && keys.length === 1) return [{ associationKey: keys[0] as string, edges: total }];
  if (measured.size !== keys.length || !keys.every((k) => measured.has(k))) {
    throw new DomainFailure("INTEGRITY_FAILURE", "the evaluation records no per-association edges for the associations the selection declares");
  }
  const edges = keys.map((k) => ({ associationKey: k, edges: measured.get(k) as number }));
  if (edges.reduce((n, a) => n + a.edges, 0) !== total) throw new DomainFailure("INTEGRITY_FAILURE", "the per-association edges are not the evaluation's association population");
  return edges;
}

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
 * The provider's current generation (B07-R1; S053 "observe actual bytes/generation before admission or sealing"; catalogue CMD017
 * failure "a changed generation ... leaves no executable sealed revision"). Neither the stored file nor the evaluation changes when
 * the provider replaces or loses an accepted object out of band; until OBJECT_INVENTORY revokes the file (§12.5), only the provider
 * knows. So before its unit of work — no transaction spans a provider call (§5) — the seal observes, through the storage port, the
 * current generation of the accepted name of every included file of the bound selection: a read-only unit of work behind the same
 * access decision as the command reads which names (nothing when the caller is refused or the revision is not the READY_TO_SEAL
 * revision of the body's version and selection: the pipeline then answers its own refusal and no provider is asked), then
 * `ObjectStoragePort.stat` bounded by PROVIDER_CALL_TIMEOUT_MS. Inside the unit of work each included file, after its transition
 * lock and the recorded checks, must be exactly what the provider answered: another generation or length, or no object, is
 * 409 GENERATION_CHANGED; an unanswered observation (or a file the observation did not reach, the revision having become ready
 * between the two) is 503 CAPACITY_UNAVAILABLE / GENERATION_NOT_OBSERVED, retryable under the same key since a refusal leaves no
 * journal row. A replacement after the observation is the object inventory's incident (GENERATION_CHANGED revokes the file
 * whatever retains it, migration 0010). Unbound providers answer SOURCE_SERVICES_UNAVAILABLE (D-SAPI-6).
 */
import type { CommandId, Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  EvaluatedTable,
  ProjectionId,
  RetentionAnchorId,
  RetentionId,
  RevisionId,
  SealedFileEntry,
  SealedProjection,
  SealedSubjectDocument,
  SourceFileId,
  SourceFileRecord,
  SourceRevisionManifest,
  SourceTableId,
  SourceTableRecord,
  UserId,
} from "@kauro/domain";
import { DomainFailure, INPUT_ENVELOPE, PROVIDER_CALL_TIMEOUT_MS, RETENTION_POLICY_VERSION, StaleVersionFailure, UPLOAD_LIVE_STATES, projectionHashOf, sealedSubjectHashOf, sourceRevisionManifestHashOf, unpaidSealedDeadlines } from "@kauro/domain";
import type { CommandEnvelope } from "../../api/envelope.js";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { contextOf, identityOf } from "../../commands/runtime.js";
import type { ObjectStoragePort, StorageLocation } from "../../ports/source-providers.js";
import { SEAL_REVISION, type SealRevisionBody, type SealRevisionHandler, type SealRevisionView } from "../contracts.js";
import { readRevisionView, retentionView } from "./projections.js";
import { reachedOnServer, requireProviders, runSourceCommand, versionAt, type B07Collaborators, type SourceRuntime } from "./shared.js";

/** What the storage port answered for the accepted name of one included file at seal time (B07-R1). */
type GenerationObservation = { readonly kind: "PRESENT"; readonly generation: string; readonly bytes: number } | { readonly kind: "ABSENT" } | { readonly kind: "UNOBSERVED" };

export function sealRevisionHandler(runtime: SourceRuntime, collaborators: B07Collaborators): SealRevisionHandler {
  return {
    spec: SEAL_REVISION,
    execute: async (envelope) => {
      const observed = await observeIncludedGenerations(runtime, collaborators, envelope);
      return runSourceCommand<SealRevisionBody, SealRevisionView>(
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
            // B07-R1: the provider's current generation of the accepted name, observed at seal time, is exactly the counted one
            const seen = observed.get(file.fileId);
            if (seen === undefined || seen.kind === "UNOBSERVED") {
              throw new DomainFailure("CAPACITY_UNAVAILABLE", "the provider's current generation of an included file was not observed at seal time", { reason: "GENERATION_NOT_OBSERVED", retryAfterSeconds: 1 }, true);
            }
            if (seen.kind === "ABSENT" || seen.generation !== file.providerGeneration || seen.bytes !== file.bytes) {
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
          const serverNow = await uow.serverInstant();
          const earlier = await uow.sources.seals.firstSeals(included.map((f) => f.fileId));
          const first = [...earlier].sort((a, b) => (a.sealedAt < b.sealedAt ? -1 : a.sealedAt > b.sealedAt ? 1 : 0))[0];
          if (first !== undefined && reachedOnServer(unpaidSealedDeadlines(first.sealedAt as UtcInstant).hardDeadline, serverNow)) {
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
    },
  };
}

/**
 * B07-R1: the provider's current generation of the accepted name of every included file of the bound selection, observed through
 * the storage port outside any transaction (see the module comment). The names are read in a read-only unit of work behind the
 * command's own access decision; nothing is observed — and no provider is asked — when the caller is refused, no provider is bound,
 * or the revision is not the READY_TO_SEAL revision of the body's version and selection (the pipeline then answers its refusal, or
 * replays a journaled seal). A DomainFailure of that read (no connection, a context the pipeline refuses) observes nothing either:
 * the pipeline meets the same condition and answers it.
 */
async function observeIncludedGenerations(runtime: SourceRuntime, collaborators: B07Collaborators, envelope: CommandEnvelope<SealRevisionBody>): Promise<ReadonlyMap<string, GenerationObservation>> {
  const observed = new Map<string, GenerationObservation>();
  if (collaborators.providers === null) return observed;
  const storage = collaborators.providers.storage;
  let names: ReadonlyArray<{ readonly fileId: string; readonly location: StorageLocation; readonly objectName: string }>;
  try {
    const context = contextOf(SEAL_REVISION, envelope);
    const agencyId = identityOf(SEAL_REVISION, envelope).agencyId;
    names = await runtime.unitOfWork.runSource(context, async (uow) => {
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
      const out: Array<{ readonly fileId: string; readonly location: StorageLocation; readonly objectName: string }> = [];
      for (const entry of manifest.body.files) {
        if (entry.disposition !== "INCLUDE") continue;
        const file = await uow.sources.files.get(entry.fileId);
        const object = file === null ? null : await uow.sources.objects.get(file.storageRef);
        if (file === null || object === null) continue;
        out.push({ fileId: file.fileId, location: { provider: object.provider, locationRef: object.locationRef }, objectName: object.objectName });
      }
      return out;
    });
  } catch (e) {
    if (e instanceof DomainFailure) return observed;
    throw e;
  }
  for (const name of names) observed.set(name.fileId, await observe(storage, name.location, name.objectName));
  return observed;
}

/** One stat of the storage port, bounded by PROVIDER_CALL_TIMEOUT_MS; a failure or no answer in time is UNOBSERVED. */
async function observe(storage: ObjectStoragePort, location: StorageLocation, objectName: string): Promise<GenerationObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), PROVIDER_CALL_TIMEOUT_MS);
  });
  try {
    const seen = await Promise.race([storage.stat(location, objectName), bound]);
    if (seen === "TIMEOUT") return { kind: "UNOBSERVED" };
    return seen === null ? { kind: "ABSENT" } : { kind: "PRESENT", generation: seen.generation, bytes: seen.bytes };
  } catch {
    return { kind: "UNOBSERVED" };
  } finally {
    clearTimeout(timer);
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

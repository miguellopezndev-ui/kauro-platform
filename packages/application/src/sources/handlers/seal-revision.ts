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
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
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
import { DomainFailure, INPUT_ENVELOPE, RETENTION_POLICY_VERSION, StaleVersionFailure, UPLOAD_LIVE_STATES, projectionHashOf, sealedSubjectHashOf, sourceRevisionManifestHashOf, unpaidSealedDeadlines } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { SEAL_REVISION, type SealRevisionBody, type SealRevisionHandler, type SealRevisionView } from "../contracts.js";
import { readRevisionView, retentionView } from "./projections.js";
import { reachedOnServer, runSourceCommand, versionAt, type SourceRuntime } from "./shared.js";

export function sealRevisionHandler(runtime: SourceRuntime): SealRevisionHandler {
  return {
    spec: SEAL_REVISION,
    execute: (envelope) =>
      runSourceCommand<SealRevisionBody, SealRevisionView>(
        SEAL_REVISION,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
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
      ),
  };
}

/**
 * The edges of each declared association (the sealed subject's per-association counts). The evaluation record keeps per-table
 * counts; an evaluation whose table entries carry the evaluator's per-association edges is read as is; with one declared
 * association its edges are the evaluation's total; several associations without their split are an integrity failure — the
 * subject never states a count nobody measured (decision D-CMD-8).
 */
function associationEdges(keys: ReadonlyArray<string>, tables: ReadonlyArray<unknown>, total: number): SealedSubjectDocument["associations"] {
  if (keys.length === 0) return [];
  const measured = new Map<string, number>();
  for (const t of tables) {
    const list = (t as { readonly associations?: ReadonlyArray<{ readonly associationKey?: unknown; readonly edges?: unknown }> }).associations;
    for (const a of list ?? []) if (typeof a.associationKey === "string" && typeof a.edges === "number") measured.set(a.associationKey, (measured.get(a.associationKey) ?? 0) + a.edges);
  }
  if (keys.every((k) => measured.has(k))) return keys.map((k) => ({ associationKey: k, edges: measured.get(k) as number }));
  if (keys.length === 1) return [{ associationKey: keys[0] as string, edges: total }];
  throw new DomainFailure("INTEGRITY_FAILURE", "the evaluation records no per-association edges for a selection that declares several associations");
}

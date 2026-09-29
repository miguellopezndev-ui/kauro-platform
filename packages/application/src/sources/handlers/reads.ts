/**
 * The reads of the source lifecycle (design §9.1; D-SAPI-1, D-SESSION-2, D-SESSION-4, D-SAPI-7; 10 "Upload and target routes": GET
 * returns safe progress without exposing the session URI to unrelated readers; GET inspection lists files, detected worksheets,
 * parser choices and structured problems; a preview endpoint returns a bounded authorized sample with safe display escaping and no
 * shared caching). Each runs B06's read pipeline (runReadIn: the subject, the identity status, the ACTIVE live membership after its
 * transition lock — every role reads, AGENCY_READER — then the projection; every denial a durable fact) in a `runSource` unit of
 * work. A foreign and a nonexistent resource answer alike (NOT_FOUND).
 *
 * Two reads reach a provider or a parser, which no transaction may span (§5): the session read opens the sealed reference with the
 * vault after its unit of work and records the delivery's ALLOW fact in another (D-SESSION-4); the preview reads the admitted
 * generation through the storage port and parses it with the bounded preview reader after its unit of work (D-SAPI-7).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { ProjectId, ResolvedMembership, RevisionId, SelectionManifestId, SourceFileRecord, SourceTableId, SourceUnitOfWork, SourceUnitOfWorkFactory, StoredObjectRecord, UploadId, UploadSessionRecord } from "@kauro/domain";
import { DomainFailure, inventoryHashOf, roleSatisfies } from "@kauro/domain";
import type { CursorBinding } from "../../api/cursor.js";
import { openCursor, sealCursor } from "../../api/cursor.js";
import { problemOf } from "../../api/problems.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import type { ReadContext, ReadHandler, ReadRequest, ReadResult, ReadRuntime } from "../../queries/reads.js";
import { runReadIn } from "../../queries/reads.js";
import { SOURCE_ROUTES } from "../contracts.js";
import { SOURCE_READ_ROUTES } from "../read-specs.js";
import type { InspectionFileView, InspectionView, ProtectedSessionView, SelectionManifestView, SourceRevisionView, TablePreviewView, UploadPage, UploadView } from "../views.js";
import { decidedReceipt, inspectionColumnView, inspectionFileView, revisionFacts, sourceRevisionView, uploadView, uploadViews } from "./projections.js";
import { sessionView } from "./reserve-upload.js";
import { requireProviders, utc, type B07Collaborators } from "./shared.js";

/** The read runtime over a source unit-of-work factory. */
export interface SourceReadRuntime extends ReadRuntime {
  readonly unitOfWork: SourceUnitOfWorkFactory;
}

export interface SourceReadHandlers {
  readonly GetSelectionManifest: ReadHandler<SelectionManifestView>;
  readonly GetRevision: ReadHandler<SourceRevisionView>;
  readonly GetInspection: ReadHandler<InspectionView>;
  readonly ListUploads: ReadHandler<UploadPage>;
  readonly GetUpload: ReadHandler<UploadView>;
  readonly GetUploadSession: ReadHandler<ProtectedSessionView>;
  readonly PreviewTable: ReadHandler<TablePreviewView>;
}

/** The reason token of the DENY fact of a session read by another member than its requester (D-SESSION-4: a refused delivery). */
export const NOT_REQUESTER = "NOT_REQUESTER";

function member(ctx: ReadContext): ResolvedMembership {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency read was authorized without a membership");
  return ctx.membership;
}

async function visibleRevision(uow: SourceUnitOfWork, membership: ResolvedMembership, revisionId: string) {
  const revision = await uow.sources.revisions.get(revisionId as RevisionId);
  if (!revision || revision.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "revision not visible");
  return revision;
}

async function visibleUpload(uow: SourceUnitOfWork, membership: ResolvedMembership, uploadId: string): Promise<UploadSessionRecord> {
  const upload = await uow.sources.uploads.get(uploadId as UploadId);
  if (!upload || upload.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "upload not visible");
  return upload;
}

export function createSourceReadHandlers(runtime: SourceReadRuntime, collaborators: B07Collaborators): SourceReadHandlers {
  const run = <T>(context: Parameters<SourceUnitOfWorkFactory["runSource"]>[0], work: (uow: SourceUnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.runSource(context, work);
  const read = <View>(operationId: keyof typeof SOURCE_READ_ROUTES, request: ReadRequest, body: (uow: SourceUnitOfWork, ctx: ReadContext) => Promise<View>): Promise<ReadResult<View>> =>
    runReadIn<View, SourceUnitOfWork>(SOURCE_READ_ROUTES[operationId], runtime, request, run, body);
  const failed = <View>(request: ReadRequest, failure: DomainFailure): ReadResult<View> => ({ kind: "PROBLEM", problem: problemOf(failure, request.correlationId) });

  const getSelectionManifest: ReadHandler<SelectionManifestView> = {
    spec: SOURCE_READ_ROUTES.GetSelectionManifest,
    execute: (request) =>
      read("GetSelectionManifest", request, async (uow, ctx) => {
        const membership = member(ctx);
        const revision = await visibleRevision(uow, membership, request.path["revisionId"] as string);
        const manifest = await uow.sources.selections.get(revision.revisionId, request.path["selectionManifestId"] as SelectionManifestId);
        if (!manifest) throw new DomainFailure("NOT_FOUND", "selection manifest not visible");
        return {
          selectionManifestId: manifest.selectionManifestId,
          revisionId: manifest.revisionId,
          bodyHash: manifest.bodyHash,
          createdByMembershipId: manifest.createdByMembershipId,
          createdAt: utc(manifest.createdAt),
          document: manifest.body,
        };
      }),
  };

  const getRevision: ReadHandler<SourceRevisionView> = {
    spec: SOURCE_READ_ROUTES.GetRevision,
    execute: (request) =>
      read("GetRevision", request, async (uow, ctx) => {
        const membership = member(ctx);
        const revision = await visibleRevision(uow, membership, request.path["revisionId"] as string);
        return sourceRevisionView(await revisionFacts(uow, revision), membership.role);
      }),
  };

  const getInspection: ReadHandler<InspectionView> = {
    spec: SOURCE_READ_ROUTES.GetInspection,
    execute: (request) =>
      read("GetInspection", request, async (uow, ctx) => {
        const membership = member(ctx);
        const revision = await visibleRevision(uow, membership, request.path["revisionId"] as string);
        const facts = await revisionFacts(uow, revision);
        const files: InspectionFileView[] = [];
        for (const file of facts.files) files.push(await inspectionFileView(uow, file, "THIS_REVISION"));
        for (const file of await uow.sources.files.listReusable(revision.projectId)) {
          if (file.originRevisionId !== revision.revisionId) files.push(await inspectionFileView(uow, file, "REUSABLE"));
        }
        const manifest = revision.selectionManifestId === undefined ? null : await uow.sources.selections.get(revision.revisionId, revision.selectionManifestId);
        const evaluation = facts.evaluation;
        return {
          revision: sourceRevisionView(facts, membership.role),
          inventoryHash: facts.inventoryHash ?? inventoryHashOf(await uow.sources.revisions.inventory(revision.revisionId)),
          uploads: await uploadViews(uow, facts.uploads, membership),
          files,
          ...(manifest !== null
            ? {
                selection: {
                  selectionManifestId: manifest.selectionManifestId,
                  selectionHash: manifest.bodyHash,
                  tables: manifest.body.tables.map((t) => ({ tableId: t.tableId, disposition: t.disposition, ...(t.exclusionReason !== undefined ? { exclusionReason: t.exclusionReason } : {}) })),
                },
              }
            : {}),
          ...(evaluation !== null
            ? {
                evaluation: {
                  evaluationHash: evaluation.evaluationHash,
                  result: evaluation.result,
                  ...(evaluation.populations !== undefined ? { populations: evaluation.populations } : {}),
                  failures: evaluation.failures.map((f) => ({ code: f.code, ...(f.tableId !== undefined ? { tableId: f.tableId } : {}) })),
                },
              }
            : {}),
        };
      }),
  };

  const listUploads: ReadHandler<UploadPage> = {
    spec: SOURCE_READ_ROUTES.ListUploads,
    execute: (request) =>
      read("ListUploads", request, async (uow, ctx) => {
        const membership = member(ctx);
        const revision = await visibleRevision(uow, membership, request.path["revisionId"] as string);
        // the cursor is bound to the caller, the agency and this revision's list (R2-060): another list's cursor never verifies
        const binding: CursorBinding = { operation: "ListUploads", userId: membership.userId, agencyId: membership.agencyId, filter: revision.revisionId };
        let after: { readonly createdAt: UtcInstant; readonly uploadId: UploadId } | undefined;
        if (request.query.cursor !== null) {
          const position = openCursor(runtime.cursorKey, binding, request.query.cursor);
          if (position === null) throw new DomainFailure("INVALID_REQUEST", "the cursor was not issued for this request", { reason: "CURSOR_INVALID" });
          after = { createdAt: position.createdAt as UtcInstant, uploadId: position.id as UploadId };
        }
        const rows = await uow.sources.uploads.listByRevision(revision.revisionId, { limit: request.query.limit, ...(after !== undefined ? { after } : {}) });
        const last = rows.at(-1);
        return {
          items: await uploadViews(uow, rows, membership),
          ...(rows.length === request.query.limit && last !== undefined ? { nextCursor: sealCursor(runtime.cursorKey, binding, { createdAt: last.createdAt, id: last.uploadId }) } : {}),
        };
      }),
  };

  const getUpload: ReadHandler<UploadView> = {
    spec: SOURCE_READ_ROUTES.GetUpload,
    execute: (request) =>
      read("GetUpload", request, async (uow, ctx) => {
        const membership = member(ctx);
        const upload = await visibleUpload(uow, membership, request.path["uploadId"] as string);
        return uploadView(upload, membership, await decidedReceipt(uow, upload));
      }),
  };

  const getUploadSession: ReadHandler<ProtectedSessionView> = {
    spec: SOURCE_READ_ROUTES.GetUploadSession,
    async execute(request) {
      type Found = { readonly kind: "VIEW"; readonly view: ProtectedSessionView } | { readonly kind: "SECRET"; readonly upload: UploadSessionRecord; readonly secret: NonNullable<Awaited<ReturnType<SourceUnitOfWork["sources"]["sessionSecrets"]["readOwn"]>>> };
      const found = await read<Found>("GetUploadSession", request, async (uow, ctx) => {
        const membership = member(ctx);
        // the session read follows the command's own role (AGENCY_OPERATOR, D-SAPI-1)
        if (!roleSatisfies(SOURCE_ROUTES.GetUploadSession.role, membership.role)) throw new DomainFailure("NOT_AUTHORIZED", "the session read needs an operating role", { reason: "ROLE_INSUFFICIENT" });
        const upload = await visibleUpload(uow, membership, request.path["uploadId"] as string);
        if (upload.requestedByUserId !== membership.userId) {
          // another member never reads the bearer credential: UNAVAILABLE, and the refused delivery is a durable fact (D-SESSION-4)
          await uow.securityEvents.append({
            agencyId: membership.agencyId,
            requestedAgencyId: null,
            actor: { kind: "USER", userId: membership.userId },
            action: SOURCE_READ_ROUTES.GetUploadSession.action,
            outcome: "DENY",
            reasonCode: NOT_REQUESTER,
            policyVersion: AUTHORIZATION_POLICY_VERSION,
            assuranceClass: "SESSION",
            correlationId: request.correlationId,
            occurredAt: runtime.clock.now(),
          });
          return { kind: "VIEW", view: { delivery: "UNAVAILABLE", unavailableReason: "NOT_REQUESTER" } };
        }
        // the requester's own row, readable only while UPLOADING and unexpired on the server clock (the row policy decides)
        const secret = await uow.sources.sessionSecrets.readOwn(upload.uploadId);
        if (secret === null) return { kind: "VIEW", view: { delivery: "UNAVAILABLE", unavailableReason: upload.state === "RESERVED" ? "SESSION_PENDING" : "SESSION_NOT_ACTIVE" } };
        return { kind: "SECRET", upload, secret };
      });
      if (found.kind === "PROBLEM") return found;
      if (found.view.kind === "VIEW") return { kind: "READ", view: found.view.view };
      const { upload, secret } = found.view;
      if (collaborators.providers === null) return failed(request, new DomainFailure("INTEGRITY_FAILURE", "a sealed session exists but no vault is bound"));
      // the vault opens the reference outside any transaction; the delivery is then recorded in the agency's stream
      const sessionRef = await collaborators.providers.vault.open(secret, { agencyId: secret.agencyId, uploadId: upload.uploadId, requestedByUserId: secret.requestedByUserId, sessionAttempt: secret.sessionAttempt });
      const context = { kind: "TENANT", agencyId: upload.agencyId, userId: request.subject.identity.userId, correlationId: request.correlationId } as const;
      await runtime.unitOfWork.run(context, (uow) =>
        uow.securityEvents.append({
          agencyId: upload.agencyId,
          requestedAgencyId: null,
          actor: { kind: "USER", userId: request.subject.identity.userId },
          action: SOURCE_READ_ROUTES.GetUploadSession.action,
          outcome: "ALLOW",
          reasonCode: "SESSION_DELIVERED",
          policyVersion: AUTHORIZATION_POLICY_VERSION,
          assuranceClass: "SESSION",
          correlationId: request.correlationId,
          occurredAt: runtime.clock.now(),
        }),
      );
      // the chunk multiple is known only to the answer that created the session (its journaled placeholder); a read omits it
      return { kind: "READ", view: sessionView(sessionRef, upload, undefined) };
    },
  };

  const previewTable: ReadHandler<TablePreviewView> = {
    spec: SOURCE_READ_ROUTES.PreviewTable,
    async execute(request) {
      type Found = { readonly file: SourceFileRecord; readonly object: StoredObjectRecord; readonly ordinal: number; readonly columnCount: number; readonly columns: TablePreviewView["columns"] };
      const found = await read<Found>("PreviewTable", request, async (uow, ctx) => {
        const membership = member(ctx);
        const revision = await visibleRevision(uow, membership, request.path["revisionId"] as string);
        const tableId = request.path["tableId"] as SourceTableId;
        // the table of a file of this revision, or of a file of its project the revision may reuse
        const candidates = [...(await uow.sources.files.listForRevision(revision.revisionId)), ...(await uow.sources.files.listReusable(revision.projectId as ProjectId))];
        for (const file of candidates) {
          const table = (await uow.sources.files.tables(file.fileId)).find((t) => t.tableId === tableId);
          if (table === undefined) continue;
          if (file.state !== "ADMITTED") throw new DomainFailure("PRECONDITION_FAILED", "the table's file is not an admitted file of the project", { reason: "INPUT_NOT_ADMITTED" });
          const object = await uow.sources.objects.get(file.storageRef);
          if (!object) throw new DomainFailure("INTEGRITY_FAILURE", "the accepted generation of an admitted file is not registered");
          const columns = (await uow.sources.files.columns(tableId)).slice(0, 50).map(inspectionColumnView);
          return { file, object, ordinal: table.ordinal, columnCount: table.columnCount, columns };
        }
        throw new DomainFailure("NOT_FOUND", "table not visible");
      });
      if (found.kind === "PROBLEM") return found;
      const { file, object, ordinal, columnCount, columns } = found.view;
      if (collaborators.providers === null || collaborators.preview === null) {
        return failed(request, new DomainFailure("INTEGRITY_FAILURE", "no object-storage adapter is bound in this edition", { reason: "SOURCE_SERVICES_UNAVAILABLE" }));
      }
      const storage = requireProviders(collaborators).storage;
      const preview = collaborators.preview;
      let sample;
      try {
        // the exact admitted generation, re-verified by the reader against the admitted digest and length (D-SAPI-7)
        sample = await preview.reader.preview({
          open: () => storage.read({ provider: object.provider, locationRef: object.locationRef }, object.objectName, file.providerGeneration),
          sha256: file.sha256,
          bytes: file.bytes,
          format: file.format,
          ordinal,
          limits: preview.limits,
          scratchDir: preview.scratchDir,
        });
      } catch (cause) {
        const failure = new DomainFailure("INTEGRITY_FAILURE", "the admitted generation could not be previewed as admitted");
        failure.cause = cause;
        return failed(request, failure);
      }
      return { kind: "READ", view: { tableId: request.path["tableId"] as string, fileId: file.fileId, columns, rows: sample.rows, truncated: sample.truncated || columnCount > columns.length } };
    },
  };

  return Object.freeze({
    GetSelectionManifest: getSelectionManifest,
    GetRevision: getRevision,
    GetInspection: getInspection,
    ListUploads: listUploads,
    GetUpload: getUpload,
    GetUploadSession: getUploadSession,
    PreviewTable: previewTable,
  });
}

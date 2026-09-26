/**
 * The reads of the source lifecycle as served manual-10 reads (B07; docs/design/B07-upload-source-lifecycle.md §9.1, decisions
 * D-SAPI-1, D-SESSION-2, D-SAPI-7): GET routes without a body or an idempotency key, scope AGENCY_HEADER, each with the action
 * token its security facts carry. They are SOURCE_ROUTES' GET routes, specified with the routes, and join B06's READ_ROUTES
 * (queries/reads) so the transport, the OpenAPI document and the matrix treat them as every other read. The access decision is
 * the reads' (authorizeRead: an ACTIVE live membership, any role, AGENCY_READER); the session read adds the command's own role
 * (AGENCY_OPERATOR) in its handler (sources/handlers/reads).
 */
import type { ReadSpec } from "../queries/reads.js";
import { SOURCE_ROUTES } from "./contracts.js";
import type { SourceReadId } from "./outcomes.js";

function readSpec(operationId: SourceReadId, action: string, summary: string): ReadSpec {
  const route = SOURCE_ROUTES[operationId];
  if (route.method !== "GET") throw new TypeError(`${operationId} is not a read`);
  return Object.freeze({
    operationId,
    method: "GET",
    path: route.path,
    action,
    scope: "AGENCY_HEADER",
    paginated: operationId === "ListUploads",
    summary,
    authority: route.authority,
  });
}

/** The seven reads of the source lifecycle, in route order (action tokens: security_events.action). */
export const SOURCE_READ_ROUTES: Readonly<Record<SourceReadId, ReadSpec>> = Object.freeze({
  GetSelectionManifest: readSpec("GetSelectionManifest", "GET_SELECTION_MANIFEST", "A stored selection manifest of a revision"),
  GetRevision: readSpec("GetRevision", "GET_REVISION", "A dataset revision with its lifecycle, lineage, selection, populations, seal and retention"),
  GetInspection: readSpec("GetInspection", "GET_INSPECTION", "The inspection of a revision: uploads, admitted files, detected tables, the inventory hash, the bound selection and its evaluation"),
  ListUploads: readSpec("ListUploads", "LIST_UPLOADS", "The uploads of a revision, as safe progress"),
  GetUpload: readSpec("GetUpload", "GET_UPLOAD", "One upload's safe progress (the status path of CompleteUpload's ACCEPTED answer)"),
  GetUploadSession: readSpec("GetUploadSession", "READ_UPLOAD_SESSION", "The resumable provider session of an upload, delivered to its requester only"),
  PreviewTable: readSpec("PreviewTable", "PREVIEW_TABLE", "A bounded preview of an admitted table (20 rows of 50 columns, 200 characters a cell)"),
});

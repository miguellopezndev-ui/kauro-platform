/**
 * The B07 handlers (design §11): the six source-lifecycle commands on B06's pipeline, the source reads and the selection manifest
 * intake. The composition root builds them once over the same runtime B06's handlers use (its unit-of-work factory also opens
 * source units of work) and the B07 collaborators (the provider ports or none, the preview reader or none, the commercial-scope
 * inspector, the application origin).
 */
import type { B07Handlers } from "../contracts.js";
import { cancelUploadHandler } from "./cancel-upload.js";
import { completeUploadHandler } from "./complete-upload.js";
import { createRevisionHandler } from "./create-revision.js";
import { reserveUploadHandler } from "./reserve-upload.js";
import { sealRevisionHandler } from "./seal-revision.js";
import { selectInputTablesHandler } from "./select-input-tables.js";
import type { B07Collaborators, SourceRuntime } from "./shared.js";

export function createB07Handlers(runtime: SourceRuntime, collaborators: B07Collaborators): B07Handlers {
  return Object.freeze({
    CMD012: createRevisionHandler(runtime, collaborators),
    CMD013: reserveUploadHandler(runtime, collaborators),
    CMD014: completeUploadHandler(runtime, collaborators),
    CMD015: cancelUploadHandler(runtime),
    CMD016: selectInputTablesHandler(runtime),
    CMD017: sealRevisionHandler(runtime),
  });
}

export type { B07Collaborators, SourcePreview, SourceProviders, SourceRuntime } from "./shared.js";
export { createSourceReadHandlers, NOT_REQUESTER, type SourceReadHandlers, type SourceReadRuntime } from "./reads.js";
export { createSourceIntakeHandlers, SOURCE_INTAKE_ROUTES, type IntakeHandler, type IntakeRequest, type IntakeResult, type IntakeSpec, type SourceIntakeHandlers } from "./intake.js";
export { SESSION_DELIVERED } from "./reserve-upload.js";
export { CANCELLED_BY_REQUESTER } from "./cancel-upload.js";
export { REVISION_REPLACED, REPLACED_BY_NEW_REVISION } from "./create-revision.js";
export { uploadStatusPath } from "./complete-upload.js";

/**
 * The read of the execution package as a served manual-10 read (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1): a GET
 * route without a body or an idempotency key, scope AGENCY_HEADER, with the action token its security facts carry. It is
 * EXECUTION_ROUTES' GET route, specified with the routes, and joins B06's READ_ROUTES (queries/reads) so the transport, the OpenAPI
 * document and the matrix treat it as every other read. The access decision is the reads' (authorizeRead: an ACTIVE live
 * membership, any role, AGENCY_READER).
 */
import type { ReadSpec } from "../queries/reads.js";
import { EXECUTION_ROUTES, type ExecutionRouteId } from "./contracts.js";

function readSpec(operationId: ExecutionRouteId, action: string, summary: string): ReadSpec {
  const route = EXECUTION_ROUTES[operationId];
  return Object.freeze({
    operationId,
    method: "GET",
    path: route.path,
    action,
    scope: "AGENCY_HEADER",
    paginated: false,
    summary,
    authority: route.authority,
  });
}

/** The reads of the execution package (action tokens: security_events.action). */
export const EXECUTION_READ_ROUTES: Readonly<Record<ExecutionRouteId, ReadSpec>> = Object.freeze({
  GetJob: readSpec("GetJob", "GET_JOB", "A processing job's safe progress: state, attempt ordinal, deadlines, cancellation version and, once READY, its package id"),
});

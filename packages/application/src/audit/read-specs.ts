/**
 * The read of the audit package as a served manual-10 read (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1): a GET route
 * without a body or an idempotency key, scope AGENCY_HEADER, with the action token its security facts carry. It is AUDIT_ROUTES' GET
 * route, specified with the routes, and joins B06's READ_ROUTES (queries/reads) so the transport, the OpenAPI document and the matrix
 * treat it as every other read. The access decision is the reads' (authorizeRead: an ACTIVE live membership, any role, AGENCY_READER).
 */
import type { ReadSpec } from "../queries/reads.js";
import { AUDIT_ROUTES, type AuditRouteId } from "./contracts.js";

function readSpec(operationId: AuditRouteId, action: string, summary: string): ReadSpec {
  const route = AUDIT_ROUTES[operationId];
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

/** The reads of the audit package (action tokens: security_events.action). */
export const AUDIT_READ_ROUTES: Readonly<Record<AuditRouteId, ReadSpec>> = Object.freeze({
  GetAudit: readSpec("GetAudit", "GET_AUDIT", "An audit's safe progress: durable phase, deadlines, grant classification, pending decisions or unsupported capabilities, cancellation version and draft plan"),
});

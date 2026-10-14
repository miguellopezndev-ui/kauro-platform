/**
 * PreviewTableUnderBreakglass — GET /api/v1/operations/breakglass-grants/{grantId}/tables/{tableId}/preview — the grant's holder, a
 * KAURO_OWNER — scope CORPORATE (registry CMD054 effect "least-privilege time-boxed access"; 08 "Breakglass"; case S071; GAP-BG-1..8).
 *
 * Two OPERATOR units of work of the holder around the provider read, the grant row the one lock (GAP-BG-1):
 *   1. the owner's ACTIVE KAURO_OWNER grant (CORPORATE_ROLE_MISSING, the denial recorded) → the holder's own grant FOR SHARE (NOT_FOUND
 *      for another owner's grant and an unknown id alike), judged after the lock: ACTIVE (BREAKGLASS_GRANT_NOT_ACTIVE; a lapsed one
 *      BREAKGLASS_GRANT_EXPIRED), not expired (BREAKGLASS_GRANT_EXPIRED), its authorization, project and agency live
 *      (BREAKGLASS_GRANT_UNUSABLE) → the admitted table of the grant's project, read through the breakglass policies only (NOT_FOUND).
 *   2. outside any transaction: the exact admitted generation through the object-storage adapter and the bounded preview reader.
 *   3. the grant FOR SHARE again, judged again (a revocation or the expiry that landed meanwhile refuses the release, no row leaves), the
 *      access recorded (refused by the database unless the grant still covers the row) and its ALLOW fact, in one COMMIT; then the rows.
 * Nothing is cached or logged; nothing widens the bounded sample (no query).
 */
import type { BreakglassGrantId, BreakglassPreviewSubject, BreakglassRepository, CommerceUnitOfWork, JudgedBreakglassGrant, UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import { COMMERCIAL_READ_ROUTES } from "../response-schemas.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { BreakglassPreviewView } from "../views.js";
import type { OperationsRequestCollaborators } from "./runtime.js";

/** The preview's column bound (the bounded sample: at most 50 cells per row). */
const PREVIEW_COLUMNS = 50;

/** The grant's judgment after its lock: the refusal, or nothing when the grant may be read under. */
function refusalOf(judged: JudgedBreakglassGrant): DomainFailure | null {
  const { grant } = judged;
  if (grant.state === "EXPIRED" || (grant.state === "ACTIVE" && judged.expired)) return new DomainFailure("PRECONDITION_FAILED", "the breakglass grant expired", { reason: "BREAKGLASS_GRANT_EXPIRED" });
  if (grant.state !== "ACTIVE") return new DomainFailure("PRECONDITION_FAILED", "the breakglass grant is no longer active", { reason: "BREAKGLASS_GRANT_NOT_ACTIVE" });
  if (!judged.live) return new DomainFailure("PRECONDITION_FAILED", "the grant's authorization, project or agency no longer justifies it", { reason: "BREAKGLASS_GRANT_UNUSABLE" });
  return null;
}

async function lockedGrant(breakglass: BreakglassRepository, grantId: BreakglassGrantId, holder: UserId): Promise<JudgedBreakglassGrant> {
  const judged = await breakglass.lockForRead(grantId, holder);
  if (judged === null) throw new NotFoundFailure("breakglass_grant");
  const refusal = refusalOf(judged);
  if (refusal !== null) throw refusal;
  return judged;
}

export function breakglassPreviewHandler(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators): CommercialReadHandler<BreakglassPreviewView> {
  const spec = COMMERCIAL_READ_ROUTES.PreviewTableUnderBreakglass;
  const admission: ReadSpec<string> = Object.freeze({ operationId: "PreviewTableUnderBreakglass", method: "GET", path: spec.path, action: spec.action, scope: "NONE", paginated: false, summary: spec.summary, authority: spec.authority });
  return {
    operationId: "PreviewTableUnderBreakglass",
    admission,
    async execute(request: ReadRequest): Promise<ReadResult<BreakglassPreviewView>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      const grantId = request.path["grantId"] as BreakglassGrantId;
      const tableId = request.path["tableId"] as BreakglassPreviewSubject["tableId"];
      let denied = false;
      try {
        const authorize = async (uow: CommerceUnitOfWork): Promise<void> => {
          const owner = await co.authorizer.authorizeCorporateOwner(uow, { identity: request.subject.identity });
          if (owner.kind === "DENY") {
            denied = true;
            throw CommerceAccessDenied.of(spec.action, owner);
          }
        };
        const found = await runtime.unitOfWork.run(context, async (uow) => {
          await authorize(uow);
          const breakglass = co.breakglass(uow);
          const judged = await lockedGrant(breakglass, grantId, userId);
          const subject = await breakglass.previewSubject(tableId);
          if (subject === null) throw new NotFoundFailure("source_table");
          return { grant: judged.grant, subject };
        });
        const sources = co.sources;
        if (sources === undefined || sources.providers === null || sources.preview === null) {
          throw new DomainFailure("INTEGRITY_FAILURE", "no object-storage adapter or preview reader is bound in this edition", { reason: "SOURCE_SERVICES_UNAVAILABLE" });
        }
        const { subject } = found;
        const storage = sources.providers.storage;
        const preview = sources.preview;
        let sample;
        try {
          // the exact admitted generation, re-verified by the reader against the admitted digest and length (D-SAPI-7), outside every transaction
          sample = await preview.reader.preview({
            open: () => storage.read({ provider: subject.provider, locationRef: subject.locationRef }, subject.objectName, subject.providerGeneration),
            sha256: subject.sha256,
            bytes: subject.bytes,
            format: subject.format,
            ordinal: subject.ordinal,
            limits: preview.limits,
            scratchDir: preview.scratchDir,
          });
        } catch (cause) {
          const failure = new DomainFailure("INTEGRITY_FAILURE", "the admitted generation could not be previewed as admitted");
          failure.cause = cause;
          throw failure;
        }
        // the release: the grant locked and judged again, the access recorded and its ALLOW fact, in one COMMIT; only then the rows leave
        const grant = await runtime.unitOfWork.run(context, async (uow) => {
          await authorize(uow);
          const breakglass = co.breakglass(uow);
          const judged = await lockedGrant(breakglass, grantId, userId);
          await breakglass.recordAccess({ accessId: uow.ids.next(), grant: judged.grant, subject, by: userId });
          await uow.securityEvents.append({
            agencyId: null,
            requestedAgencyId: judged.grant.agencyId,
            actor: { kind: "USER", userId },
            action: spec.action,
            outcome: "ALLOW",
            reasonCode: "BREAKGLASS_GRANT_LIVE",
            policyVersion: AUTHORIZATION_POLICY_VERSION,
            assuranceClass: "SESSION",
            correlationId: request.correlationId,
            occurredAt: runtime.clock.now(),
          });
          return judged.grant;
        });
        return { kind: "READ", view: { grantId: grant.grantId, tableId: subject.tableId, fileId: subject.fileId, rows: sample.rows, truncated: sample.truncated || subject.columnCount > PREVIEW_COLUMNS, expiresAt: grant.expiresAt } };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied) await recordOperatorDenial(runtime, context, spec.action, e, e instanceof CommerceAccessDenied ? e.policyVersion : "", null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
      }
    },
  };
}

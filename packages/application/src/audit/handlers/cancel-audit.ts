/**
 * CMD021 CancelAudit — POST /api/v1/audits/{auditId}/cancel — AGENCY_OPERATOR (design B08 §3, §12; D8-CANCEL-1, D8-AUD-2, D8-LOCK-1;
 * Audit machine edge `cancellation_wins` from QUEUED, PROFILING, INTERPRETING and VALIDATING to CANCELLED; catalogue "Cancel a live
 * audit; work in flight is fenced out").
 *
 * Order: authorize → reserve → the audit row (NOT_FOUND; a foreign and a nonexistent audit answer alike) and its row lock (FOR UPDATE:
 * the one serialization point CancelAudit shares with the orchestration's edges, so exactly one of a cancellation and a step's edge wins,
 * never both) → the audit decided on the locked record:
 *
 *   - any state the machine lists no cancellation_wins edge for (DRAFT_READY, NEEDS_DECISION, UNSUPPORTED, FAILED, CANCELLED, EXPIRED):
 *     409 PRECONDITION_FAILED AUDIT_TERMINAL naming where the audit stands — a cancellation has nothing left to stop, and the loser of
 *     a race between two cancellations is told what became of the audit;
 *   - a version other than the one read: 409 STALE_VERSION naming the current version and state;
 *   - otherwise cancellation_wins at that version: CANCELLED, the cancellation version + 1, the reason on the row and the store's
 *     audit.cancelled.v1 → journal 200 with the audit.
 *
 * A finished audit is answered before the version is compared, so a retry that read the audit before it ended is told what became of
 * it rather than that it is stale. The handler holds no other lock: the audit row is the fence, and the step in flight finds its fence
 * refused (KA080) when it records.
 */
import type { AuditId } from "@kauro/domain";
import { DomainFailure, findTransition } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { CANCEL_AUDIT, type CancelAuditBody, type CancelAuditHandler } from "../contracts.js";
import type { AuditView } from "../views.js";
import { auditView } from "./projections.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

/** The reason recorded on an audit its agency cancelled (a machine token the server chooses). */
export const AGENCY_CANCELLED_REASON = "AGENCY_CANCELLED";

export function cancelAuditHandler(runtime: AuditRuntime): CancelAuditHandler {
  return {
    spec: CANCEL_AUDIT,
    execute: (envelope) =>
      runAuditCommand<CancelAuditBody, AuditView>(
        CANCEL_AUDIT,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const auditId = envelope.path["auditId"] as AuditId;

          // the audit row under its lock; an audit of another agency is the answer of one that never existed
          const found = await uow.audits.getAudit(auditId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "audit not visible");
          const audit = await uow.audits.lockAudit(auditId);
          if (!audit) throw new DomainFailure("NOT_FOUND", "audit not visible");

          if (findTransition("Audit", audit.state, "cancellation_wins") === null) {
            throw new DomainFailure("PRECONDITION_FAILED", "the audit already ended", { reason: "AUDIT_TERMINAL", currentVersion: audit.version, currentState: audit.state });
          }
          checkExpectedVersion(audit, envelope.body.expectedVersion);

          const cancelled = applied(
            await uow.audits.cancelAudit(auditId, envelope.body.expectedVersion, { actor: { kind: "USER", userId: envelope.userId }, reasonCode: AGENCY_CANCELLED_REASON }),
          );
          const grant = await uow.audits.getGrant(cancelled.grantId);
          if (!grant) throw new DomainFailure("INTEGRITY_FAILURE", "an audit's grant is not visible");
          return { status: 200 as const, view: auditView(cancelled, grant, membership.role), version: cancelled.version, resourceKind: "audit", resourceId: cancelled.auditId };
        },
        versionAt(),
      ),
  };
}

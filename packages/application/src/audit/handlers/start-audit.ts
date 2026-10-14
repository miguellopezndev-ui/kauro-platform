/**
 * CMD020 StartAudit — POST /api/v1/revisions/{revisionId}/audits — AGENCY_OPERATOR (design B08 §3, §12; D8-GRANT-1, D8-AUD-1,
 * D8-LOCK-1, D8-STALE-1, D8-CMA-9; R2-044; catalogue "Verify the sealed, available revision and the confirmed, current target; queue
 * the audit on a free grant").
 *
 * Order: authorize → reserve → the revision (NOT_FOUND; a foreign and a nonexistent revision answer alike) and its shared transition
 * lock (D-TX-2: a retention expiry or a supersession issued meanwhile waits, one committed first is what is read) → the revision
 * SEALED (EXPIRED and DELETED are SOURCE_EXPIRED; any other state is REVISION_NOT_SEALED naming where it stands) and still available
 * on the database's clock (a retention that ended is SOURCE_EXPIRED, D8-STALE-1, D8-CMA-9) → the target contract after its shared
 * transition lock (D8-LOCK-1: source before target), confirmed, current and of this revision's project (TARGET_STALE) → the store's
 * StartAudit: the agency's one live audit and the subject's one audit (its constraints answer AUDIT_CONCURRENCY_LIMITED and
 * AUDIT_EXISTS), the AUDIT grant carved from the platform's pool under the pool's row lock — or BUDGET_EXHAUSTED NO_FUNDED_GRANT with
 * nothing written (R2-044) — and the audit born QUEUED with the store's audit.queued.v1 to AUDIT_ORCHESTRATION → journal 202
 * ACCEPTED (operationId = the audit, statusPath = its read).
 *
 * The handler publishes nothing itself: the store writes the event and its outbox record in the statement that inserts the audit.
 * The request calls no core: profiling and interpretation are the orchestration's, after commit (D8-AUD-2).
 */
import type { AuditId, CostGrantId, RevisionId, TargetContractId, AuditRecord } from "@kauro/domain";
import { AUDIT_POLICY, AUDIT_PRICE_PROFILE_HASH, DomainFailure, effectNowOf } from "@kauro/domain";
import type { AcceptedOutcome } from "../../commands/runtime.js";
import { requireMembership } from "../../commands/handlers/shared.js";
import { AUDIT_POLL_AFTER_SECONDS, START_AUDIT, type StartAuditBody, type StartAuditHandler } from "../contracts.js";
import { reachedOnServer, runAuditCommand, type AuditRuntime } from "./shared.js";

/** The ACCEPTED answer for an audit: the operation is the audit, its status path the audit read (design §12). */
function acceptedFor(audit: AuditRecord): AcceptedOutcome {
  return {
    status: 202,
    accepted: { operationId: audit.auditId, state: audit.state, statusPath: `/api/v1/audits/${audit.auditId}`, pollAfterSeconds: AUDIT_POLL_AFTER_SECONDS },
    resourceKind: "audit",
    resourceId: audit.auditId,
  };
}

export function startAuditHandler(runtime: AuditRuntime): StartAuditHandler {
  return {
    spec: START_AUDIT,
    execute: (envelope) =>
      runAuditCommand<StartAuditBody, never>(
        START_AUDIT,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const revisionId = envelope.path["revisionId"] as RevisionId;
          const targetContractId = envelope.body.targetContractId as TargetContractId;

          // the revision, then its shared transition lock; a revision of another agency is the answer of one that never existed
          const found = await uow.revisions.get(revisionId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "revision not visible");
          await uow.execution.awaitTransition({ kind: "REVISION", key: revisionId });
          const revision = await uow.revisions.get(revisionId);
          if (!revision) throw new DomainFailure("NOT_FOUND", "revision not visible");
          if (revision.state === "EXPIRED" || revision.state === "DELETED") throw new DomainFailure("SOURCE_EXPIRED", "the revision's source is no longer available");
          if (revision.state !== "SEALED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the revision is not sealed", { reason: "REVISION_NOT_SEALED", currentVersion: revision.version, currentState: revision.state });
          }
          // still available: SEALED with an ACTIVE retention whose deadline is ahead of the database's clock (D8-STALE-1, D8-CLOCK-1)
          const availability = await uow.sources.availability.availabilityOf(revisionId);
          if (!availability || availability.manifestHash === null || revision.manifestHash === undefined || availability.manifestHash !== revision.manifestHash) {
            throw new DomainFailure("INTEGRITY_FAILURE", "a sealed revision has no manifest hash its own records agree on");
          }
          // the target contract after its shared transition lock (source before target, D8-LOCK-1), the last await; then the effect clock
          // (r15/r25, B17 L1 section 4 STA): the retention is judged at that one instant, SOURCE_EXPIRED before TARGET_STALE as before
          await uow.execution.awaitTransition({ kind: "TARGET_CONTRACT", key: targetContractId });
          const target = await uow.targetContracts.get(targetContractId);
          const now = await effectNowOf(uow);
          if (availability.availableUntil === null || reachedOnServer(availability.availableUntil, now)) {
            throw new DomainFailure("SOURCE_EXPIRED", "the revision's source is no longer available");
          }
          if (!target || target.agencyId !== membership.agencyId || target.projectId !== revision.projectId || target.confirmedAt === undefined || target.supersededAt !== undefined) {
            throw new DomainFailure("TARGET_STALE", "the target contract is not confirmed and current");
          }

          const started = await uow.audits.startAudit({
            auditId: uow.ids.next() as AuditId,
            grantId: uow.ids.next() as CostGrantId,
            agencyId: membership.agencyId,
            projectId: revision.projectId,
            revisionId,
            revisionHash: revision.manifestHash,
            targetContractId,
            targetContractHash: target.bodyHash,
            auditPolicyVersion: envelope.body.auditPolicyVersion,
            requestedByMembershipId: membership.membershipId,
            ceilingCents: BigInt(AUDIT_POLICY.freeAuditCeilingCents),
            priceProfileHash: AUDIT_PRICE_PROFILE_HASH,
          });
          return acceptedFor(started.audit);
        },
        // a 202 has no aggregate version: it is answered from the journaled ACCEPTED members, never through a COMPLETED view
        () => {
          throw new DomainFailure("INTEGRITY_FAILURE", "an ACCEPTED answer carries no aggregate version");
        },
      ),
  };
}

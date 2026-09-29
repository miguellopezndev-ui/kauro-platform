/**
 * EXECUTION_CONTROL's half of audit authority (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §6,
 * §8.1 cancellation_wins, §11; decisions D8-CANCEL-1, D8-CANCEL-2): a lost source — a superseded or expired revision, or a revoked
 * admission of a file its seal includes — cancels the agency's live, uncancelled audits of that revision through cancellation_wins,
 * as EXECUTION_CONTROL's SERVICE actor with the loss's reason token (SOURCE_SUPERSEDED, SOURCE_EXPIRED, SOURCE_ADMISSION_REVOKED), each
 * under the audit's row lock. The step in flight then records nothing (the next unit reads the cancellation), and the cancellation's
 * own event reaches AUDIT_ORCHESTRATION, which settles the system draft's open intent. Cancellation is never a CRM rollback.
 */
import { LIVE_AUDIT_STATES, type AgencyId, type RevisionId } from "@kauro/domain";
import { EXECUTION_SERVICES, applied, refused, type ExecutionStep } from "../execution/work.js";
import { guarded, inAgency, type AuditWorkDependencies } from "./work.js";

const SERVICE = EXECUTION_SERVICES.EXECUTION_CONTROL;

export class AuditCancellations {
  constructor(private readonly deps: AuditWorkDependencies) {}

  /** The live audits of the lost revision cancelled with the loss's reason (header); one step per audit. */
  async cancelOfRevision(agencyId: AgencyId, revisionId: RevisionId, reason: string): Promise<ReadonlyArray<ExecutionStep>> {
    const audits = await inAgency(this.deps, SERVICE, agencyId, (uow) => uow.auditDiscovery.liveAuditsOfRevision(agencyId, revisionId));
    const steps: ExecutionStep[] = [];
    for (const ref of audits) {
      steps.push(
        await guarded(this.deps.retryAfterSeconds, () =>
          inAgency(this.deps, SERVICE, ref.agencyId, async (uow) => {
            const audit = await uow.audits.lockAudit(ref.auditId);
            if (audit === null || audit.cancelVersion !== 0 || !LIVE_AUDIT_STATES.includes(audit.state)) return refused("AUDIT_NOT_LIVE");
            const cancelled = await uow.audits.cancelAudit(audit.auditId, audit.version, { actor: { kind: "SERVICE", serviceId: SERVICE }, reasonCode: reason });
            return cancelled.kind === "APPLIED" ? applied("AUDIT_CANCELLED") : refused("STALE_VERSION");
          }),
        ),
      );
    }
    return steps;
  }
}

/**
 * AUDIT_DEADLINES (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1 absolute_deadline, §11;
 * decisions D8-DL-1, D8-AUD-1, D8-AUD-4, D8-CAU-8): a live audit whose absolute deadline (creation + 86,400 s) is at or before the
 * server clock — never early: the discovery compares with kauro.server_now() and the database refuses an early expiry (KA081) — is
 * EXPIRED with ABSOLUTE_DEADLINE_REACHED, even while a step's core call is outstanding (that step's late result is then refused), and in
 * the same unit the system draft's open intent settles CANCELLED, so a later VALID receipt stays evidence and promotes nothing. No retry,
 * worker or redelivery restarts the clock.
 */
import type { ExecutionSweeper, ExecutionUnits } from "@kauro/application";
import { LIVE_AUDIT_STATES, type AgencyId, type AuditId } from "@kauro/domain";
import { SweepRun, type SweepResult } from "../sweepers/sweep.js";
import { EXECUTION_SERVICES, refusalOf } from "../execution/work.js";
import { StepRefused, acrossAgencies, inAgency, reached, type AuditWorkDependencies } from "./work.js";

const SERVICE = EXECUTION_SERVICES.AUDIT_DEADLINES;

/** The terminal reason of an audit that reached its absolute deadline (a token). */
export const ABSOLUTE_DEADLINE_REACHED = "ABSOLUTE_DEADLINE_REACHED";

export class AuditDeadlines implements ExecutionSweeper {
  readonly name = "AUDIT_DEADLINES" as const;

  constructor(private readonly deps: AuditWorkDependencies) {}

  async sweep(_units: ExecutionUnits, limit: number): Promise<SweepResult> {
    const run = new SweepRun(SERVICE, this.deps.ids);
    const due = await acrossAgencies(this.deps, SERVICE, (uow) => uow.auditDiscovery.auditsPastDeadline(limit));
    let acted = 0;
    for (const audit of due) {
      if (await run.attempt(audit.auditId, () => this.expire(audit.auditId, audit.agencyId))) acted += 1;
    }
    return { examined: due.length, acted, failed: run.failures };
  }

  /** absolute_deadline for one audit, with its system draft's open intent settled CANCELLED (header); false when nothing was due. */
  async expire(auditId: AuditId, agencyId: AgencyId): Promise<boolean> {
    try {
      return await this.expireIn(auditId, agencyId);
    } catch (e) {
      // the audit moved under another writer (a cancellation, a step's edge) between the discovery and the lock: nothing to expire
      if (refusalOf(e) !== null) return false;
      throw e;
    }
  }

  private expireIn(auditId: AuditId, agencyId: AgencyId): Promise<boolean> {
    return inAgency(this.deps, SERVICE, agencyId, async (uow) => {
      const audit = await uow.audits.lockAudit(auditId);
      if (audit === null || !LIVE_AUDIT_STATES.includes(audit.state)) return false;
      if (!reached(await uow.executionDiscovery.serverNow(), audit.absoluteDeadlineAt)) return false;
      const expired = await uow.audits.advanceAudit(auditId, audit.version, { to: "EXPIRED", reasonCode: ABSOLUTE_DEADLINE_REACHED });
      if (expired.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
      for (const draft of await uow.auditDiscovery.openDraftValidations(auditId)) {
        await uow.audits.settleValidation(draft.validation.validationId, { result: "CANCELLED", receiptHash: null });
      }
      return true;
    });
  }
}

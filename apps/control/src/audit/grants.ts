/**
 * GRANT_RECONCILIATION (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1 CostGrant, §11;
 * decisions D8-GRANT-1, D8-GRANT-2, D8-DL-1, D8-PAU-3, D8-PAU-4, D8-CAU-10; supporting B03's IC-12).
 *
 * The database names the grants with work (a known usage to reconcile, an intent it can no longer send, an edge due on its clock, a
 * scope closed with nothing uncertain left); each is settled in one unit — bound to the agency of an AUDIT grant, unbound for the
 * platform's pool — under the grant's row lock and its requests' (FOR UPDATE), so a send, a reservation and another reconciliation
 * of the grant are ordered before or after it:
 *
 *   1. a KNOWN usage joins the grant's spend and leaves its reservation (reconciled once);
 *   2. a RESERVED dispatch intent the database can no longer send — the check before SEND_STARTED would refuse it: its audit no longer
 *      interprets, its interpretation deadline passed on the server clock, or its MODEL_TASK lease moved to another fence — is
 *      CANCELLED and reconciled with nothing spent: the only amount ever released unused;
 *   3. every other usage (in flight, UNCERTAIN, a stored response of unknown usage, ESTIMATED) stays reserved;
 *   4. then the edges the grant's state admits, on the server clock and never early: an AUTHORIZED grant CLOSES once its scope closed
 *      (its audit ended; a pool's scope closes with its expiry) and nothing it funds is uncertain or live, EXPIRES at its expiry, is
 *      EXHAUSTED when known spend plus reserved reaches its ceiling; an EXHAUSTED one EXPIRES, or is AUTHORIZED again with room; an
 *      EXPIRED one CLOSES once nothing is uncertain. An AUDIT grant's close releases its pool's hold into the pool's spend (the
 *      database's hold, a trigger level deeper).
 */
import type { ExecutionSweeper, ExecutionUnits } from "@kauro/application";
import { LIVE_AUDIT_STATES, type AuditUnitOfWork, type CostGrantRecord, type GrantEdge, type GrantRef } from "@kauro/domain";
import { SweepRun, type SweepResult } from "../sweepers/sweep.js";
import { EXECUTION_SERVICES, boundSystem, refusalOf } from "../execution/work.js";
import { StepRefused, acrossAgencies, reached, type AuditWorkDependencies } from "./work.js";

const SERVICE = EXECUTION_SERVICES.GRANT_RECONCILIATION;

/** A request whose effect is not settled: in flight, uncertain, or a stored response not consumed (0023 cost_grants_workflow). */
const OPEN_STATES: ReadonlySet<string> = new Set(["RESERVED", "DISPATCHING", "UNCERTAIN", "RESPONSE_STORED"]);
/** At most the edges one pass can take (EXHAUSTED -> AUTHORIZED -> CLOSED). */
const MAX_EDGES = 3;

export class GrantReconciliation implements ExecutionSweeper {
  readonly name = "GRANT_RECONCILIATION" as const;

  constructor(private readonly deps: AuditWorkDependencies) {}

  async sweep(_units: ExecutionUnits, limit: number): Promise<SweepResult> {
    const run = new SweepRun(SERVICE, this.deps.ids);
    const due = await acrossAgencies(this.deps, SERVICE, (uow) => uow.auditDiscovery.grantsToReconcile(limit));
    let acted = 0;
    for (const grant of due) {
      if (await run.attempt(grant.grantId, () => this.reconcile(grant))) acted += 1;
    }
    return { examined: due.length, acted, failed: run.failures };
  }

  /** One grant settled under its row lock (header); true when anything moved. */
  async reconcile(ref: GrantRef): Promise<boolean> {
    const context = ref.agencyId === null ? { kind: "SYSTEM" as const, serviceId: SERVICE, correlationId: this.deps.ids.next() as never } : boundSystem(SERVICE, ref.agencyId, this.deps.ids.next() as never);
    try {
      return await this.deps.units.run(context, (uow) => this.settle(uow, ref));
    } catch (e) {
      // the grant moved under another writer between the discovery and the lock (a stale version, a listed edge refused): next run
      if (refusalOf(e) !== null) return false;
      throw e;
    }
  }

  private async settle(uow: AuditUnitOfWork, ref: GrantRef): Promise<boolean> {
    const scope = await uow.auditDiscovery.lockGrant(ref.grantId);
    if (scope === null || scope.grant.state === "PREPARED" || scope.grant.state === "CLOSED") return false;
    let grant: CostGrantRecord = scope.grant;
    let acted = false;
    let open = 0;
    const now = await uow.executionDiscovery.serverNow();
    for (const usage of await uow.auditDiscovery.grantUsage(grant.grantId)) {
      if (usage.usageState === "KNOWN" && usage.actualCents !== null) {
        // 1. a known usage joins the spend
        grant = await uow.audits.reconcileRequest(usage.requestId, usage.actualCents);
        acted = true;
        if (OPEN_STATES.has(usage.state)) open += 1;
      } else if (usage.provablyUnsent) {
        // 2. an intent the database can no longer send: CANCELLED at its fence, reconciled with nothing spent
        const cancelled = await uow.requestJournal.markCancelled(usage.requestId, usage.fence, now);
        if (cancelled === null) throw new StepRefused("REQUEST_FENCED");
        grant = await uow.audits.reconcileRequest(usage.requestId, 0n);
        acted = true;
      } else {
        // 3. unknown or uncertain usage stays reserved
        open += 1;
      }
    }
    // 4. the edges, on the server clock
    const expired = reached(now, grant.expiresAt);
    const scopeClosed = grant.kind === "AUDIT" && (scope.auditState === null || !LIVE_AUDIT_STATES.includes(scope.auditState));
    const settled = open === 0 && scope.liveCarves === 0;
    for (let i = 0; i < MAX_EDGES; i++) {
      const full = grant.reservedCents + grant.reconciledSpendCents >= grant.ceilingCents;
      let to: GrantEdge | null = null;
      if (grant.state === "AUTHORIZED") to = scopeClosed && settled ? "CLOSED" : expired ? "EXPIRED" : full ? "EXHAUSTED" : null;
      else if (grant.state === "EXHAUSTED") to = expired ? "EXPIRED" : full ? null : "AUTHORIZED";
      else if (grant.state === "EXPIRED") to = settled ? "CLOSED" : null;
      if (to === null) break;
      const moved = await uow.audits.transitionGrant(grant.grantId, grant.version, to);
      if (moved.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
      grant = moved.record;
      acted = true;
    }
    return acted;
  }
}

/**
 * The control plane's discovery of audit work over `pg` (package B08, mandate B08-CONTROL-AUDIT; @kauro/domain ports/audit-discovery.ts;
 * docs/design/B08-audit-approval-jobs.md §3, §6, §8.1, §11; decision D8-CAU-1).
 *
 * Reads only, under the policies and grants of migrations 0021 to 0023 and B06's and B07's — nothing is granted here: the control plane
 * reads the audits, grants, model tasks, validation intents, leases and request journal of every agency from an unbound SYSTEM unit
 * (their control reads admit one), and a plan's body, a revision's sealed file set and its accepted objects only in a unit bound to the
 * agency (plans_control_execution_read and B07's source reads). The grant and its requests are read under their row locks (FOR UPDATE:
 * the control plane holds UPDATE on both and their update policies admit its unit), so GRANT_RECONCILIATION's settlement is ordered with
 * a send, a reservation and another reconciliation. Deadlines are compared with kauro.server_now() in SQL (D8-CLOCK-1). "Provably
 * unsent" is exactly the refusal of migration 0023's check before SEND_STARTED (request_journal_model_task_send): the task's audit no
 * longer interprets, its interpretation deadline passed, or its MODEL_TASK lease is at another fence. Ids, states and hashes only.
 */
import {
  LIVE_AUDIT_STATES,
  type AgencyId,
  type AuditDiscovery,
  type AuditId,
  type AuditRecord,
  type AuditRef,
  type AuditSource,
  type AuditState,
  type CostGrantId,
  type DraftValidation,
  type GrantRef,
  type GrantScope,
  type GrantUsage,
  type PlanId,
  type RequestId,
  type RequestJournalRecord,
  type RevisionId,
  type ValidationSubject,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { pageLimit, str } from "../source/rows.js";
import { GRANT_COLUMNS, VALIDATION_COLUMNS, cents, grantRecord, validationRecord, type Row } from "./rows.js";

const LIVE = `a.state IN (${LIVE_AUDIT_STATES.map((s) => `'${s}'`).join(", ")})`;

/**
 * The refusal of the check before SEND_STARTED, for a RESERVED intent `r` of model task `m` whose audit is `a` (0023); for a DISPATCHING
 * row the same predicate names a send its owner can no longer make (B05 D5-18 branch (a)). Not widened by B05 (D5-18 grant expiry).
 */
const UNSENDABLE = `(a.state IS DISTINCT FROM 'INTERPRETING' OR m.interpretation_deadline_at <= kauro.server_now()
  OR NOT EXISTS (SELECT 1 FROM kauro.leases l WHERE l.resource_kind = 'MODEL_TASK' AND l.resource_id = r.task_id AND l.fence = r.fence AND l.cost_authority_id = m.grant_id))`;

/** A request whose effect is not settled: in flight, uncertain, a stored response not consumed, or a usage not reconciled. */
const OPEN_REQUEST = `(r.usage_state <> 'RECONCILED' OR r.state IN ('RESERVED', 'DISPATCHING', 'UNCERTAIN', 'RESPONSE_STORED'))`;

function auditRefs(rows: ReadonlyArray<{ audit_id: unknown; agency_id: unknown }>): ReadonlyArray<AuditRef> {
  return rows.map((r) => ({ auditId: str<AuditId>(r.audit_id), agencyId: str<AgencyId>(r.agency_id) }));
}

export class PgAuditDiscovery implements AuditDiscovery {
  constructor(private readonly db: Queryable) {}

  async auditsPastDeadline(limit: number): Promise<ReadonlyArray<AuditRef>> {
    // the database's own bound for absolute_deadline (audits_workflow): at or after the absolute deadline, never early (D8-DL-1)
    const r = await execute<{ audit_id: string; agency_id: string }>(
      this.db,
      `SELECT a.audit_id, a.agency_id FROM kauro.audits a WHERE ${LIVE} AND a.absolute_deadline_at <= kauro.server_now()
        ORDER BY a.absolute_deadline_at, a.audit_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return auditRefs(r.rows);
  }

  async liveAuditsOfRevision(agencyId: AgencyId, revisionId: RevisionId): Promise<ReadonlyArray<AuditRef>> {
    const r = await execute<{ audit_id: string; agency_id: string }>(
      this.db,
      `SELECT a.audit_id, a.agency_id FROM kauro.audits a WHERE a.agency_id = $1 AND a.revision_id = $2 AND ${LIVE} AND a.cancel_version = 0 ORDER BY a.created_at, a.audit_id`,
      [agencyId, revisionId],
    );
    return auditRefs(r.rows);
  }

  async auditSource(audit: AuditRecord): Promise<AuditSource> {
    const revision = await execute<{ state: string }>(
      this.db,
      "SELECT r.state FROM kauro.dataset_revisions r WHERE r.agency_id = $1 AND r.project_id = $2 AND r.revision_id = $3 AND r.manifest_hash = $4",
      [audit.agencyId, audit.projectId, audit.revisionId, audit.revisionHash],
    );
    const files = await execute<{ object_name: string; generation: string; sha256: string; bytes: string }>(
      this.db,
      `SELECT o.object_name, f.provider_generation AS generation, f.sha256, f.bytes::text AS bytes
         FROM kauro.dataset_revisions r
         JOIN kauro.sealed_revision_files s ON s.agency_id = r.agency_id AND s.revision_id = r.revision_id AND s.disposition = 'INCLUDED'
         JOIN kauro.source_files f ON f.agency_id = s.agency_id AND f.file_id = s.file_id
         JOIN kauro.stored_objects o ON o.agency_id = f.agency_id AND o.object_id = f.accepted_object_id
        WHERE r.agency_id = $1 AND r.revision_id = $2 AND r.manifest_hash = $3
        ORDER BY s.ordinal`,
      [audit.agencyId, audit.revisionId, audit.revisionHash],
    );
    return {
      revisionState: revision.rows[0]?.state ?? "NOT_VISIBLE",
      acceptedGenerations: files.rows.map((f) => ({ objectName: str(f.object_name), generation: str(f.generation), sha256: str(f.sha256), byteLength: int(f.bytes) })),
    };
  }

  async openDraftValidations(auditId: AuditId): Promise<ReadonlyArray<DraftValidation>> {
    const intents = await execute<Row>(this.db, `SELECT ${VALIDATION_COLUMNS} FROM kauro.plan_validations WHERE audit_id = $1 AND origin = 'AUDIT' AND result IS NULL ORDER BY requested_at, validation_id`, [auditId]);
    const out: DraftValidation[] = [];
    for (const row of intents.rows) {
      const validation = validationRecord(row);
      const plan = await execute<{ state: string; version: string; body: unknown }>(
        this.db,
        "SELECT p.state, p.version::text AS version, p.body FROM kauro.plans p WHERE p.agency_id = $1 AND p.plan_id = $2 AND p.body_hash = $3",
        [validation.agencyId, validation.planId, validation.planHash],
      );
      const p = plan.rows[0];
      if (p) out.push({ validation, planState: str(p.state), planVersion: int(p.version), body: p.body });
    }
    return out;
  }

  async validationSubject(planId: PlanId): Promise<ValidationSubject | null> {
    const plan = await execute<{ plan_id: string; agency_id: string; state: string; version: string; body: unknown; body_hash: string; revision_hash: string; target_contract_hash: string }>(
      this.db,
      "SELECT p.plan_id, p.agency_id, p.state, p.version::text AS version, p.body, p.body_hash, p.revision_hash, p.target_contract_hash FROM kauro.plans p WHERE p.plan_id = $1",
      [planId],
    );
    const p = plan.rows[0];
    if (!p) return null;
    const latest = await execute<Row>(this.db, `SELECT ${VALIDATION_COLUMNS} FROM kauro.plan_validations WHERE agency_id = $1 AND plan_id = $2 ORDER BY fence DESC LIMIT 1`, [p.agency_id, planId]);
    return {
      planId: str<PlanId>(p.plan_id),
      agencyId: str<AgencyId>(p.agency_id),
      planState: str(p.state),
      planVersion: int(p.version),
      body: p.body,
      bodyHash: str(p.body_hash),
      revisionHash: str(p.revision_hash),
      targetContractHash: str(p.target_contract_hash),
      current: latest.rows[0] ? validationRecord(latest.rows[0]) : null,
    };
  }

  async grantsToReconcile(limit: number): Promise<ReadonlyArray<GrantRef>> {
    const r = await execute<{ grant_id: string; agency_id: string | null }>(
      this.db,
      `SELECT g.grant_id, g.agency_id FROM kauro.cost_grants g
        WHERE g.state IN ('AUTHORIZED', 'EXHAUSTED', 'EXPIRED') AND (
              EXISTS (SELECT 1 FROM kauro.request_journal r WHERE r.cost_grant_id = g.grant_id AND r.usage_state = 'KNOWN')
           OR EXISTS (
                SELECT 1 FROM kauro.request_journal r
                  JOIN kauro.model_tasks m ON m.model_task_id = r.task_id
                  LEFT JOIN kauro.audits a ON a.agency_id = m.agency_id AND a.audit_id = m.audit_id
                 WHERE r.cost_grant_id = g.grant_id AND r.state IN ('RESERVED', 'DISPATCHING') AND r.usage_state <> 'RECONCILED' AND ${UNSENDABLE})
           OR EXISTS (
                SELECT 1 FROM kauro.request_journal r
                 WHERE r.cost_grant_id = g.grant_id AND r.state = 'FAILED' AND r.non_acceptance_evidence IS NOT NULL AND r.usage_state = 'UNKNOWN')
           OR (g.state IN ('AUTHORIZED', 'EXHAUSTED') AND g.expires_at <= kauro.server_now())
           OR (g.state = 'AUTHORIZED' AND g.reserved_cents + g.reconciled_spend_cents >= g.ceiling_cents)
           OR (g.state = 'EXHAUSTED' AND g.reserved_cents + g.reconciled_spend_cents < g.ceiling_cents AND g.expires_at > kauro.server_now())
           OR (
                (g.state = 'EXPIRED' OR (g.state = 'AUTHORIZED' AND g.grant_kind = 'AUDIT' AND NOT EXISTS (SELECT 1 FROM kauro.audits a WHERE a.grant_id = g.grant_id AND ${LIVE})))
                AND NOT EXISTS (SELECT 1 FROM kauro.request_journal r WHERE r.cost_grant_id = g.grant_id AND ${OPEN_REQUEST})
                AND NOT EXISTS (SELECT 1 FROM kauro.cost_grants c WHERE c.pool_grant_id = g.grant_id AND c.state <> 'CLOSED')
              )
        )
        ORDER BY g.updated_at, g.grant_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((g) => ({ grantId: str<CostGrantId>(g.grant_id), agencyId: g.agency_id === null ? null : str<AgencyId>(g.agency_id) }));
  }

  async lockGrant(grantId: CostGrantId): Promise<GrantScope | null> {
    const locked = await execute<Row>(this.db, `SELECT ${GRANT_COLUMNS} FROM kauro.cost_grants WHERE grant_id = $1 FOR UPDATE`, [grantId]);
    const row = locked.rows[0];
    if (!row) return null;
    const grant = grantRecord(row);
    if (grant.kind === "AUDIT") {
      const audit = await execute<{ state: string }>(this.db, "SELECT a.state FROM kauro.audits a WHERE a.grant_id = $1", [grantId]);
      return { grant, auditState: audit.rows[0] ? str<AuditState>(audit.rows[0].state) : null, liveCarves: 0 };
    }
    const carves = await execute<{ n: string }>(this.db, "SELECT count(*)::text AS n FROM kauro.cost_grants c WHERE c.pool_grant_id = $1 AND c.state <> 'CLOSED'", [grantId]);
    return { grant, auditState: null, liveCarves: int(carves.rows[0]?.n ?? "0") };
  }

  async grantUsage(grantId: CostGrantId): Promise<ReadonlyArray<GrantUsage>> {
    const r = await execute<{ request_id: string; fence: string; state: string; usage_state: string; reserved: string; actual: string | null; provably_unsent: boolean; stale_dispatch: boolean; non_accepted: boolean }>(
      this.db,
      `SELECT r.request_id, r.fence::text AS fence, r.state, r.usage_state, r.reserved_cents::text AS reserved, r.actual_cents::text AS actual,
              (r.state = 'RESERVED' AND m.model_task_id IS NOT NULL AND ${UNSENDABLE}) AS provably_unsent,
              (r.state = 'DISPATCHING' AND m.model_task_id IS NOT NULL AND ${UNSENDABLE}) AS stale_dispatch,
              (r.state = 'FAILED' AND r.non_acceptance_evidence IS NOT NULL AND r.usage_state = 'UNKNOWN') AS non_accepted
         FROM kauro.request_journal r
         LEFT JOIN kauro.model_tasks m ON m.model_task_id = r.task_id
         LEFT JOIN kauro.audits a ON a.agency_id = m.agency_id AND a.audit_id = m.audit_id
        WHERE r.cost_grant_id = $1 AND r.usage_state <> 'RECONCILED'
        ORDER BY r.reserved_at, r.request_id
        FOR UPDATE OF r`,
      [grantId],
    );
    return r.rows.map((u) => ({
      requestId: str<RequestId>(u.request_id),
      fence: int(u.fence),
      state: str<RequestJournalRecord["state"]>(u.state),
      usageState: str<RequestJournalRecord["usageState"]>(u.usage_state),
      reservedCents: cents(u.reserved),
      actualCents: u.actual === null ? null : cents(u.actual),
      provablyUnsent: u.provably_unsent === true,
      staleDispatch: u.stale_dispatch === true,
      nonAccepted: u.non_accepted === true,
    }));
  }
}

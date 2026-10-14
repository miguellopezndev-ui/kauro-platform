/**
 * The agency app's tables and reads (package B11 lane A1): the agency's recorded buyer type (migration 0062, CMD101 SetBuyerType, read by
 * B10's BuyerTypeReader port) and the project dashboard query (ListProjects, R2 11 "Project dashboard"). Both run on the unit of work's
 * own connection under its context, so the row-level policies scope them: the agency's tenant context, or the corporate owner's operator
 * context for the buyer type CMD047 reads (agency_buyer_types_owner_read).
 *
 * The dashboard derives every member from a durable fact of the project, never from a label it would have to infer: the client's display
 * name and state, the current revision, the latest live plan, the latest open quote, the latest ACTIVE commercial authorization and the
 * latest processing job. The first rule that holds decides the phase and the required action (the order is documented in
 * apps/api/test/b11-list-projects.test.ts and in the ListProjects read spec); the filter is applied to the derived phase in the same
 * statement, so a keyset page of a filter never skips or repeats a row of that filter.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, MembershipId, UserId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { execute, instant, type Queryable } from "../sql.js";

export type RecordedBuyerType = "agency" | "in-house";

export interface PgBuyerTypeRecord {
  readonly agencyId: AgencyId;
  readonly buyerType: RecordedBuyerType;
  readonly forEconomicActivity: true;
  readonly recordedByUserId: UserId;
  readonly recordedByMembershipId: MembershipId;
  readonly recordedAt: UtcInstant;
  readonly version: 1;
}

interface BuyerTypeRow {
  agency_id: string;
  buyer_type: string;
  for_economic_activity: boolean;
  recorded_by_user_id: string;
  recorded_by_membership_id: string;
  recorded_at: Date;
  version: string;
}

function recordOf(row: BuyerTypeRow): PgBuyerTypeRecord {
  if ((row.buyer_type !== "agency" && row.buyer_type !== "in-house") || row.for_economic_activity !== true || row.version !== "1") {
    throw new DomainFailure("INTEGRITY_FAILURE", "a recorded buyer type is not of the schema's shape");
  }
  return {
    agencyId: row.agency_id as AgencyId,
    buyerType: row.buyer_type,
    forEconomicActivity: true,
    recordedByUserId: row.recorded_by_user_id as UserId,
    recordedByMembershipId: row.recorded_by_membership_id as MembershipId,
    recordedAt: instant(row.recorded_at),
    version: 1,
  };
}

const BUYER_TYPE_COLUMNS = "agency_id, buyer_type, for_economic_activity, recorded_by_user_id, recorded_by_membership_id, recorded_at, version::text AS version";

/** kauro.agency_buyer_types (append-only: one row per agency, version 1). */
export class PgBuyerTypes {
  constructor(private readonly client: Queryable) {}

  async get(agencyId: AgencyId): Promise<PgBuyerTypeRecord | null> {
    const r = await execute<BuyerTypeRow>(this.client, `SELECT ${BUYER_TYPE_COLUMNS} FROM kauro.agency_buyer_types WHERE agency_id = $1`, [agencyId]);
    const row = r.rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async insert(record: PgBuyerTypeRecord): Promise<PgBuyerTypeRecord> {
    const r = await execute<BuyerTypeRow>(
      this.client,
      `INSERT INTO kauro.agency_buyer_types (agency_id, buyer_type, for_economic_activity, recorded_by_user_id, recorded_by_membership_id, recorded_at, version)
       VALUES ($1, $2, true, $3, $4, $5, 1) RETURNING ${BUYER_TYPE_COLUMNS}`,
      [record.agencyId, record.buyerType, record.recordedByUserId, record.recordedByMembershipId, record.recordedAt],
    );
    return recordOf(r.rows[0]!);
  }
}

export type PgDashboardFilter = "active" | "awaiting_agency" | "delivered" | "failed" | "archived";

export interface PgProjectDashboardRow {
  readonly projectId: string;
  readonly clientId: string;
  readonly clientLabel: string;
  readonly mode: string;
  readonly revisionId: string;
  readonly revisionState: string;
  readonly phase: "SOURCES" | "HEALTH_CHECK" | "PLAN" | "PURCHASE" | "PROCESSING" | "DELIVERED" | "FAILED" | "ARCHIVED";
  readonly requiredAction: "UPLOAD_SOURCES" | "START_HEALTH_CHECK" | "VALIDATE_PLAN" | "APPROVE_PLAN" | "REQUEST_QUOTE" | "PAY_QUOTE" | "START_PROCESSING" | "NONE";
  readonly deadline: UtcInstant | null;
  readonly lastActivityAt: UtcInstant;
  readonly version: number;
  readonly position: { readonly createdAt: string; readonly id: string };
}

interface DashboardRow {
  project_id: string;
  client_id: string;
  client_label: string;
  mode: string;
  version: string;
  revision_id: string;
  revision_state: string;
  position_at: string;
  phase: PgProjectDashboardRow["phase"];
  required_action: PgProjectDashboardRow["requiredAction"];
  deadline: Date | null;
  activity: Date;
}

/**
 * The rule that decides a project's phase, first match wins: ARCHIVED (the project is not OPEN or its client is ARCHIVED); the latest job
 * READY (DELIVERED), FAILED/EXPIRED/CANCELLED (FAILED) or live (PROCESSING); an ACTIVE authorization (START_PROCESSING); an ISSUED or
 * checkout-accepted quote (PAY_QUOTE); the latest live plan APPROVED (REQUEST_QUOTE), VALIDATED (APPROVE_PLAN), DRAFT or
 * VALIDATION_REQUIRED (VALIDATE_PLAN), VALIDATING (no agency action); the current revision SEALED (START_HEALTH_CHECK); else
 * UPLOAD_SOURCES. The agency's projects lead the statement (the CTE), so the start of its text — what pg_stat_activity keeps of a long
 * query — names the table a waiting dashboard read waits on.
 */
const DASHBOARD = `
WITH p AS (SELECT * FROM kauro.projects WHERE agency_id = $1)
SELECT d.project_id::text AS project_id, d.client_id::text AS client_id, d.client_label, d.mode, d.version::text AS version,
       d.revision_id::text AS revision_id, d.revision_state, d.position_at, d.phase, d.required_action, d.deadline, d.activity
FROM (
  SELECT p.project_id, p.client_id, c.display_name AS client_label, p.mode, p.version, p.current_revision_id AS revision_id, r.state AS revision_state,
         p.created_at, to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position_at,
         CASE
           WHEN k.rule IN ('ARCHIVED', 'DELIVERED', 'FAILED', 'PROCESSING') THEN k.rule
           WHEN k.rule IN ('START_PROCESSING', 'PAY_QUOTE', 'REQUEST_QUOTE') THEN 'PURCHASE'
           WHEN k.rule IN ('APPROVE_PLAN', 'VALIDATE_PLAN', 'VALIDATING') THEN 'PLAN'
           WHEN k.rule = 'START_HEALTH_CHECK' THEN 'HEALTH_CHECK'
           ELSE 'SOURCES'
         END AS phase,
         CASE WHEN k.rule IN ('ARCHIVED', 'DELIVERED', 'FAILED', 'PROCESSING', 'VALIDATING') THEN 'NONE' ELSE k.rule END AS required_action,
         CASE k.rule WHEN 'PROCESSING' THEN j.delivery_deadline_at WHEN 'PAY_QUOTE' THEN q.expires_at END AS deadline,
         CASE
           WHEN k.rule = 'ARCHIVED' THEN GREATEST(p.updated_at, c.updated_at)
           WHEN k.rule IN ('DELIVERED', 'FAILED', 'PROCESSING') THEN j.updated_at
           WHEN k.rule = 'START_PROCESSING' THEN a.updated_at
           WHEN k.rule = 'PAY_QUOTE' THEN q.updated_at
           WHEN k.rule IN ('REQUEST_QUOTE', 'APPROVE_PLAN', 'VALIDATE_PLAN', 'VALIDATING') THEN l.updated_at
           ELSE r.updated_at
         END AS activity
  FROM p
  JOIN kauro.end_clients c ON c.client_id = p.client_id AND c.agency_id = p.agency_id
  JOIN kauro.dataset_revisions r ON r.revision_id = p.current_revision_id AND r.agency_id = p.agency_id
  LEFT JOIN LATERAL (
    SELECT x.state, x.delivery_deadline_at, x.updated_at FROM kauro.processing_jobs x
    WHERE x.agency_id = p.agency_id AND x.project_id = p.project_id ORDER BY x.created_at DESC, x.job_id DESC LIMIT 1
  ) j ON true
  LEFT JOIN LATERAL (
    SELECT x.updated_at FROM kauro.commercial_authorizations x
    WHERE x.agency_id = p.agency_id AND x.project_id = p.project_id AND x.state = 'ACTIVE' ORDER BY x.created_at DESC, x.authorization_id DESC LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT x.expires_at, x.updated_at FROM kauro.quotes x
    WHERE x.agency_id = p.agency_id AND x.project_id = p.project_id AND x.state IN ('ISSUED', 'ACCEPTED_FOR_CHECKOUT') ORDER BY x.created_at DESC, x.quote_id DESC LIMIT 1
  ) q ON true
  LEFT JOIN LATERAL (
    SELECT x.state, x.updated_at FROM kauro.plans x
    WHERE x.agency_id = p.agency_id AND x.project_id = p.project_id AND x.state NOT IN ('SUPERSEDED', 'WITHDRAWN') ORDER BY x.created_at DESC, x.plan_id DESC LIMIT 1
  ) l ON true
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN p.state <> 'OPEN' OR c.state = 'ARCHIVED' THEN 'ARCHIVED'
      WHEN j.state = 'READY' THEN 'DELIVERED'
      WHEN j.state IN ('FAILED', 'EXPIRED', 'CANCELLED') THEN 'FAILED'
      WHEN j.state IS NOT NULL THEN 'PROCESSING'
      WHEN a.updated_at IS NOT NULL THEN 'START_PROCESSING'
      WHEN q.expires_at IS NOT NULL THEN 'PAY_QUOTE'
      WHEN l.state = 'APPROVED' THEN 'REQUEST_QUOTE'
      WHEN l.state = 'VALIDATED' THEN 'APPROVE_PLAN'
      WHEN l.state IN ('DRAFT', 'VALIDATION_REQUIRED') THEN 'VALIDATE_PLAN'
      WHEN l.state = 'VALIDATING' THEN 'VALIDATING'
      WHEN r.state = 'SEALED' THEN 'START_HEALTH_CHECK'
      ELSE 'UPLOAD_SOURCES'
    END AS rule
  ) k
) d
WHERE CASE $2::text
        WHEN 'active' THEN d.phase NOT IN ('ARCHIVED', 'DELIVERED', 'FAILED')
        WHEN 'awaiting_agency' THEN d.phase NOT IN ('ARCHIVED', 'DELIVERED', 'FAILED') AND d.required_action <> 'NONE'
        WHEN 'delivered' THEN d.phase = 'DELIVERED'
        WHEN 'failed' THEN d.phase = 'FAILED'
        WHEN 'archived' THEN d.phase = 'ARCHIVED'
        ELSE false
      END
  AND ($4::timestamptz IS NULL OR (d.created_at, d.project_id) < ($4::timestamptz, $5::uuid))
ORDER BY d.created_at DESC, d.project_id DESC
LIMIT $3`;

/** The project dashboard (ListProjects): newest first, keyset pages over (created_at, project_id) descending. */
export class PgProjectDashboard {
  constructor(private readonly client: Queryable) {}

  async page(agencyId: AgencyId, filter: PgDashboardFilter, options: { readonly limit: number; readonly after?: { readonly createdAt: string; readonly id: string } }): Promise<ReadonlyArray<PgProjectDashboardRow>> {
    const r = await execute<DashboardRow>(this.client, DASHBOARD, [agencyId, filter, options.limit, options.after?.createdAt ?? null, options.after?.id ?? null]);
    return r.rows.map((row) => ({
      projectId: row.project_id,
      clientId: row.client_id,
      clientLabel: row.client_label,
      mode: row.mode,
      revisionId: row.revision_id,
      revisionState: row.revision_state,
      phase: row.phase,
      requiredAction: row.required_action,
      deadline: row.deadline === null ? null : instant(row.deadline),
      lastActivityAt: instant(row.activity),
      version: Number(row.version),
      position: { createdAt: row.position_at, id: row.project_id },
    }));
  }
}

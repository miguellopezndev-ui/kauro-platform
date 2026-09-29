/**
 * Support cases over `pg` (B11 CMD044; migration 0023, D-SUP-6). A case belongs to one agency and to one of its projects: the
 * composite foreign keys refuse another agency's project or membership, and the tenant policy hides other agencies' rows, so the
 * repository relies on both instead of re-checking ownership in code.
 *
 * Pagination (07): a total ordering with a unique tie-breaker inside the tenant, (created_at, case_id) of one project.
 */
import {
  DomainFailure,
  type AgencyId,
  type KeysetPage,
  type MembershipId,
  type NewSupportCase,
  type ProjectId,
  type SupportCaseId,
  type SupportCaseRecord,
  type SupportCaseRepository,
  type SupportCaseState,
  type SupportCategory,
  type SupportSeverity,
  type UserId,
} from "@kauro/domain";
import { execute, instant, int, type Queryable } from "../sql.js";

interface CaseRow {
  case_id: string;
  agency_id: string;
  project_id: string;
  category: SupportCategory;
  severity: SupportSeverity;
  state: SupportCaseState;
  summary: string;
  evidence_refs: string[];
  created_by_user_id: string;
  created_by_membership_id: string;
  next_review_at: Date;
  version: string;
  created_at: Date;
  updated_at: Date;
}

const CASE_COLUMNS =
  "case_id, agency_id, project_id, category, severity, state, summary, evidence_refs, created_by_user_id, created_by_membership_id, next_review_at, version, created_at, updated_at";

function caseRecord(r: CaseRow): SupportCaseRecord {
  return {
    caseId: r.case_id as SupportCaseId,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    category: r.category,
    severity: r.severity,
    state: r.state,
    summary: r.summary,
    evidenceRefs: [...r.evidence_refs],
    createdByUserId: r.created_by_user_id as UserId,
    createdByMembershipId: r.created_by_membership_id as MembershipId,
    nextReviewAt: instant(r.next_review_at),
    version: int(r.version),
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
}

export class PgSupportCaseRepository implements SupportCaseRepository {
  constructor(private readonly db: Queryable) {}

  async get(caseId: SupportCaseId): Promise<SupportCaseRecord | null> {
    const r = await execute<CaseRow>(this.db, `SELECT ${CASE_COLUMNS} FROM kauro.support_cases WHERE case_id = $1`, [caseId]);
    return r.rows[0] ? caseRecord(r.rows[0]) : null;
  }

  async insert(input: NewSupportCase): Promise<SupportCaseRecord> {
    const r = await execute<CaseRow>(
      this.db,
      `INSERT INTO kauro.support_cases
         (case_id, agency_id, project_id, category, severity, state, summary, evidence_refs, created_by_user_id, created_by_membership_id, next_review_at, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7::uuid[], $8, $9, $10, 1, $11, $11) RETURNING ${CASE_COLUMNS}`,
      [
        input.caseId,
        input.agencyId,
        input.projectId,
        input.category,
        input.severity,
        input.summary,
        [...input.evidenceRefs],
        input.createdByUserId,
        input.createdByMembershipId,
        input.nextReviewAt,
        input.createdAt,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "support case insert returned no row");
    return caseRecord(row);
  }

  async listByProject(agencyId: AgencyId, projectId: ProjectId, page: KeysetPage<SupportCaseId>): Promise<ReadonlyArray<SupportCaseRecord>> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new DomainFailure("INVALID_REQUEST", "page limit must be 1..100 (R2 policy api)");
    const params: unknown[] = [agencyId, projectId, page.limit];
    let where = "agency_id = $1 AND project_id = $2";
    if (page.after) {
      params.push(page.after.createdAt, page.after.id);
      where += " AND (created_at, case_id) > ($4, $5)";
    }
    const r = await execute<CaseRow>(this.db, `SELECT ${CASE_COLUMNS} FROM kauro.support_cases WHERE ${where} ORDER BY created_at, case_id LIMIT $3`, params);
    return r.rows.map(caseRecord);
  }
}

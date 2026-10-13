/**
 * The operations and recovery records of packages B16/B18 over `pg` (migration 0059; registry commands CMD056 RecordIncident and CMD057
 * AuthorizeRecovery): the incident with its responsibilities, the restore candidate read FOR UPDATE and its one authorization with the
 * recovery row. Every instant is the database's (the birth triggers of 0059). RecordIncident runs under the owner's request session
 * (kauro_app, recorded by the person) or the operations service (kauro_commission's group, recorded by the service); AuthorizeRecovery
 * under the owner's only.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  isUtcInstant,
  type IncidentId,
  type IncidentIntakeSeverity,
  type IncidentRecord,
  type IncidentResponsibility,
  type IncidentSeverity,
  type OperationsActor,
  type OperationsRepository,
  type RecoveryId,
  type RecoveryRecord,
  type RestoreCandidateId,
  type RestoreCandidateRecord,
  type UserId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";

const CANONICAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function instantOf(v: unknown): UtcInstant {
  if (typeof v !== "string" || !isUtcInstant(v)) throw new TypeError("expected a canonical instant column value");
  return v;
}

interface IncidentRow {
  incident_id: string;
  kind: "ACTUAL" | "FALSE_POSITIVE";
  severity: IncidentSeverity | null;
  state: "DETECTED" | "CLOSED";
  affected_scopes: string[];
  communication_state: "NOT_REQUIRED" | "REVIEW_REQUIRED";
  started_at: string;
  review_at: string;
}
interface CandidateRow {
  candidate_id: string;
  state: "PREPARED" | "AUTHORIZED";
  plan_hash: string;
  deletion_journal_hash: string;
  revision: number;
}

export class PgOperationsRepository implements OperationsRepository {
  constructor(private readonly db: Queryable) {}

  async recordIncident(input: {
    readonly incidentId: IncidentId;
    readonly severity: IncidentIntakeSeverity;
    readonly affectedScopes: ReadonlyArray<string>;
    readonly summary: string;
    readonly by: OperationsActor;
  }): Promise<IncidentRecord> {
    const falsePositive = input.severity === "FALSE_POSITIVE";
    const inserted = await execute<IncidentRow>(
      this.db,
      `INSERT INTO kauro.incidents (incident_id, kind, severity, state, affected_scopes, summary, ${input.by.kind === "USER" ? "recorded_by_user_id" : "recorded_by_service"})
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING incident_id, kind, severity, state, affected_scopes, communication_state,
         to_char(started_at AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS started_at, to_char(review_at AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS review_at`,
      [
        input.incidentId,
        falsePositive ? "FALSE_POSITIVE" : "ACTUAL",
        falsePositive ? null : input.severity,
        falsePositive ? "CLOSED" : "DETECTED",
        JSON.stringify(input.affectedScopes),
        input.summary,
        input.by.kind === "USER" ? input.by.userId : input.by.serviceId,
      ],
    );
    const row = inserted.rows[0]!;
    let responsibilities: IncidentResponsibility[] = [];
    if (row.kind === "ACTUAL") {
      const opened = await execute<{ responsibility: IncidentResponsibility; state: string }>(
        this.db,
        `INSERT INTO kauro.incident_responsibilities (incident_id, responsibility, state, due_at)
         SELECT i.incident_id, r.responsibility, CASE WHEN r.responsibility = 'COMMUNICATION' AND i.communication_state = 'NOT_REQUIRED' THEN 'NOT_REQUIRED' ELSE 'OPEN' END, i.review_at
           FROM kauro.incidents i CROSS JOIN unnest(ARRAY['CONTAINMENT', 'RECOVERY', 'COMMUNICATION']) AS r(responsibility)
          WHERE i.incident_id = $1
         RETURNING responsibility, state`,
        [input.incidentId],
      );
      responsibilities = opened.rows.filter((r) => r.state === "OPEN").map((r) => r.responsibility);
    }
    return {
      incidentId: row.incident_id as IncidentId,
      kind: row.kind,
      severity: row.severity,
      state: row.state,
      affectedScopes: row.affected_scopes,
      communicationState: row.communication_state,
      responsibilities,
      startedAt: instantOf(row.started_at),
      reviewAt: instantOf(row.review_at),
    };
  }

  async lockCandidate(candidateId: RestoreCandidateId): Promise<RestoreCandidateRecord | null> {
    const r = await execute<CandidateRow>(this.db, "SELECT candidate_id, state, plan_hash, deletion_journal_hash, revision FROM kauro.restore_candidates WHERE candidate_id = $1 FOR UPDATE", [candidateId]);
    const row = r.rows[0];
    return row ? { candidateId: row.candidate_id as RestoreCandidateId, state: row.state, planHash: row.plan_hash as Sha256Hex, deletionJournalHash: row.deletion_journal_hash as Sha256Hex, revision: Number(row.revision) } : null;
  }

  async authorizeRecovery(input: {
    readonly recoveryId: RecoveryId;
    readonly candidate: RestoreCandidateRecord;
    readonly authorizationRef: string;
    readonly by: UserId;
  }): Promise<VersionedWrite<RecoveryRecord>> {
    const moved = await execute<{ revision: number }>(
      this.db,
      "UPDATE kauro.restore_candidates SET state = 'AUTHORIZED', revision = revision + 1 WHERE candidate_id = $1 AND revision = $2 AND state = 'PREPARED' RETURNING revision",
      [input.candidate.candidateId, input.candidate.revision],
    );
    const next = moved.rows[0];
    if (!next) {
      const now = await this.lockCandidate(input.candidate.candidateId);
      return { kind: "STALE", currentVersion: now?.revision ?? 0, currentState: now?.state ?? "UNKNOWN" };
    }
    const r = await execute<{ recovery_id: string; candidate_id: string; deletion_journal_hash: string; authorization_ref: string; authorized_at: string }>(
      this.db,
      `INSERT INTO kauro.recoveries (recovery_id, candidate_id, deletion_journal_hash, authorization_ref, authorized_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING recovery_id, candidate_id, deletion_journal_hash, authorization_ref, to_char(authorized_at AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS authorized_at`,
      [input.recoveryId, input.candidate.candidateId, input.candidate.deletionJournalHash, input.authorizationRef, input.by],
    );
    const row = r.rows[0]!;
    return {
      kind: "APPLIED",
      record: {
        recoveryId: row.recovery_id as RecoveryId,
        candidateId: row.candidate_id as RestoreCandidateId,
        deletionJournalHash: row.deletion_journal_hash as Sha256Hex,
        authorizationRef: row.authorization_ref,
        authorizedAt: instantOf(row.authorized_at),
        candidateRevision: Number(next.revision),
      },
    };
  }
}

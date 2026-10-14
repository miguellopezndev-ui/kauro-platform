/**
 * The restore run's database side (package B16 lane L6; migration 0076). Three adapters, each over a connection it is handed (none is a
 * connection site):
 *
 *   PgRestoreOwnerStore   the migration owner on the RESTORED database: closes the recovery gate as its first statement (S3), keeps the
 *                         run, its applied entries and its provider observations, and opens the gate in the release transaction (S8);
 *   restoreControlOf(uow) the control plane's unit of work on the RESTORED database: suppresses a dispatched notification's outbox
 *                         record, expires every lease (S5), reads a capture's state (S6) and a tombstoned subject's state (S4/S7);
 *   recoveryAuthorityOf(uow) the control plane's unit of work on the PRIMARY: prepares a restore candidate (S1) and reads the owner's
 *                         CMD057 authorization of it (S8);
 *   journalTailOf(uow)    the control plane's unit of work on the database the journal tail follows: the committed events after a
 *                         transaction-id horizon (commit-safe: only transactions older than every snapshot's xmin are read).
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import type { Queryable } from "../sql.js";
import { PgUnitOfWork } from "../unit-of-work.js";
import type { RecoveryJournalKind } from "./pg-authority-journal.js";

export type RestoreRunState = "GATED" | "APPLYING" | "APPLIED" | "FENCED" | "RECONCILED" | "PAUSED" | "CHECKED" | "RELEASED";
export type AppliedOutcome = "APPLIED" | "ALREADY_APPLIED" | "SUPPRESSED" | "ABSENT" | "VERIFIED" | "DEFERRED";

export interface RestoreRunRow {
  readonly runId: string;
  readonly candidateId: string;
  readonly planHash: string;
  readonly deletionJournalHash: string;
  readonly journalThrough: number;
  readonly state: RestoreRunState;
  readonly appliedThrough: number;
  readonly failedAtEntry: number | null;
  readonly failureCode: string | null;
  readonly revision: number;
}

export interface ObservationRow {
  readonly observationId: string;
  readonly journalSeq: number;
  readonly entryId: string;
  readonly subjectKind: "CAPTURE" | "REFUND";
  readonly subjectId: string;
  readonly mismatch: string;
  readonly state: "OPEN" | "ANSWERED" | "TIMED_OUT";
  readonly deadlineReached: boolean;
}

interface RunSqlRow {
  readonly run_id: string;
  readonly candidate_id: string;
  readonly plan_hash: string;
  readonly deletion_journal_hash: string;
  readonly journal_through: string;
  readonly state: RestoreRunState;
  readonly applied_through: string;
  readonly failed_at_entry: string | null;
  readonly failure_code: string | null;
  readonly revision: string;
}

const RUN_COLUMNS = "run_id, candidate_id, plan_hash, deletion_journal_hash, journal_through::text, state, applied_through::text, failed_at_entry::text, failure_code, revision::text";

function runOf(r: RunSqlRow): RestoreRunRow {
  return {
    runId: r.run_id,
    candidateId: r.candidate_id,
    planHash: r.plan_hash,
    deletionJournalHash: r.deletion_journal_hash,
    journalThrough: Number(r.journal_through),
    state: r.state,
    appliedThrough: Number(r.applied_through),
    failedAtEntry: r.failed_at_entry === null ? null : Number(r.failed_at_entry),
    failureCode: r.failure_code,
    revision: Number(r.revision),
  };
}

/** A hold inside the release transaction, after its writes and before its COMMIT (the interleaving tests; no production caller arms it). */
export type ReleaseHold = () => Promise<void>;

export class PgRestoreOwnerStore {
  constructor(private readonly owner: Queryable) {}

  async #tx<T>(work: () => Promise<T>): Promise<T> {
    await this.owner.query("BEGIN");
    try {
      const out = await work();
      await this.owner.query("COMMIT");
      return out;
    } catch (e) {
      await this.owner.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  }

  async run(candidateId: string): Promise<RestoreRunRow | null> {
    const r = await this.owner.query<RunSqlRow>(`SELECT ${RUN_COLUMNS} FROM kauro.restore_runs WHERE candidate_id = $1`, [candidateId]);
    return r.rows[0] === undefined ? null : runOf(r.rows[0]);
  }

  async gate(): Promise<{ readonly state: "OPEN" | "CLOSED"; readonly runId: string | null }> {
    const r = await this.owner.query<{ state: "OPEN" | "CLOSED"; run_id: string | null }>("SELECT state, run_id FROM kauro.recovery_gate WHERE gate_id");
    return { state: r.rows[0]!.state, runId: r.rows[0]!.run_id };
  }

  /**
   * S3: the gate closes as the transaction's first statement (an in-flight claim that read it OPEN holds its share lock to its commit,
   * so this UPDATE waits for it); the domain-event identity is moved above every sequence the journal already holds (a restored
   * database's new events never reuse a journaled tombstone's sequence); then the run is born GATED behind the gate it closed.
   */
  async closeGate(input: { readonly runId: string; readonly candidateId: string; readonly planHash: string; readonly deletionJournalHash: string; readonly journalThrough: number; readonly eventSequenceFloor: number }): Promise<RestoreRunRow> {
    return this.#tx(async () => {
      const closed = await this.owner.query(
        "UPDATE kauro.recovery_gate SET state = 'CLOSED', run_id = $1, revision = revision + 1 WHERE gate_id AND state = 'OPEN'",
        [input.runId],
      );
      if ((closed.rowCount ?? 0) !== 1) throw new DomainFailure("PRECONDITION_FAILED", "the recovery gate is already closed by another restore run", { reason: "CONSEQUENCES_UNRECONCILED" });
      await this.owner.query(
        // from the sequence itself, never max(sequence): FORCE RLS hides rows from the owner, and a smaller max would move it backwards
        "SELECT setval(x.s, greatest(coalesce(pg_sequence_last_value(x.s), 0), $1::bigint, 1)) FROM (SELECT pg_get_serial_sequence('kauro.domain_events', 'sequence')::regclass AS s) x",
        [input.eventSequenceFloor],
      );
      const r = await this.owner.query<RunSqlRow>(
        `INSERT INTO kauro.restore_runs (run_id, candidate_id, plan_hash, deletion_journal_hash, journal_through, started_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, kauro.server_now(), kauro.server_now()) RETURNING ${RUN_COLUMNS}`,
        [input.runId, input.candidateId, input.planHash, input.deletionJournalHash, input.journalThrough],
      );
      return runOf(r.rows[0]!);
    });
  }

  /** S4: entry k applied (its effect committed first, idempotently): its row, and the run's progress to k, in one transaction. */
  async recordApplied(run: RestoreRunRow, entry: { readonly journalSeq: number; readonly entryId: string; readonly kind: RecoveryJournalKind }, outcome: AppliedOutcome): Promise<RestoreRunRow> {
    return this.#tx(async () => {
      if (run.failedAtEntry !== null) {
        await this.owner.query("UPDATE kauro.restore_runs SET failed_at_entry = NULL, failure_code = NULL, state = 'APPLYING', revision = revision + 1 WHERE run_id = $1", [run.runId]);
      }
      await this.owner.query("INSERT INTO kauro.restore_applied_entries (run_id, journal_seq, entry_id, kind, outcome, recorded_at) VALUES ($1, $2, $3, $4, $5, kauro.server_now())", [
        run.runId,
        entry.journalSeq,
        entry.entryId,
        entry.kind,
        outcome,
      ]);
      const r = await this.owner.query<RunSqlRow>(
        `UPDATE kauro.restore_runs SET applied_through = $2, state = 'APPLYING', revision = revision + 1 WHERE run_id = $1 AND applied_through = $2 - 1 RETURNING ${RUN_COLUMNS}`,
        [run.runId, entry.journalSeq],
      );
      if (r.rows[0] === undefined) throw new DomainFailure("PRECONDITION_FAILED", `journal entry ${entry.journalSeq} is not the next one of run ${run.runId}`, { reason: "CONSEQUENCES_UNRECONCILED" });
      return runOf(r.rows[0]);
    });
  }

  /** S4: entry k could not be applied; the run records k and its code, and stays APPLYING (the gate stays closed). */
  async recordFailure(run: RestoreRunRow, journalSeq: number, code: string): Promise<RestoreRunRow> {
    const r = await this.owner.query<RunSqlRow>(
      `UPDATE kauro.restore_runs SET failed_at_entry = $2, failure_code = $3, state = 'APPLYING', revision = revision + 1 WHERE run_id = $1 RETURNING ${RUN_COLUMNS}`,
      [run.runId, journalSeq, code],
    );
    return runOf(r.rows[0]!);
  }

  async move(run: RestoreRunRow, to: RestoreRunState, checksHash?: string): Promise<RestoreRunRow> {
    const r = await this.owner.query<RunSqlRow>(
      `UPDATE kauro.restore_runs SET state = $3, checks_hash = coalesce($4, checks_hash), revision = revision + 1 WHERE run_id = $1 AND state = $2 RETURNING ${RUN_COLUMNS}`,
      [run.runId, run.state, to, checksHash ?? null],
    );
    if (r.rows[0] === undefined) throw new DomainFailure("PRECONDITION_FAILED", `restore run ${run.runId} is no longer ${run.state}`, { reason: "CONSEQUENCES_UNRECONCILED" });
    return runOf(r.rows[0]);
  }

  async openObservation(input: { readonly observationId: string; readonly run: RestoreRunRow; readonly journalSeq: number; readonly entryId: string; readonly subjectKind: "CAPTURE" | "REFUND"; readonly subjectId: string; readonly mismatch: string; readonly seconds: number }): Promise<void> {
    await this.owner.query(
      `INSERT INTO kauro.restore_observations (observation_id, run_id, journal_seq, entry_id, subject_kind, subject_id, mismatch, opened_at, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kauro.server_now(), kauro.server_now() + make_interval(secs => $8)) ON CONFLICT (run_id, entry_id) DO NOTHING`,
      [input.observationId, input.run.runId, input.journalSeq, input.entryId, input.subjectKind, input.subjectId, input.mismatch, input.seconds],
    );
  }

  async observations(runId: string): Promise<ReadonlyArray<ObservationRow>> {
    const r = await this.owner.query<{ observation_id: string; journal_seq: string; entry_id: string; subject_kind: "CAPTURE" | "REFUND"; subject_id: string; mismatch: string; state: ObservationRow["state"]; reached: boolean }>(
      "SELECT o.observation_id, o.journal_seq::text AS journal_seq, o.entry_id, o.subject_kind, o.subject_id, o.mismatch, o.state, o.deadline_at <= kauro.server_now() AS reached FROM kauro.restore_observations o WHERE o.run_id = $1 ORDER BY o.journal_seq",
      [runId],
    );
    return r.rows.map((x) => ({ observationId: x.observation_id, journalSeq: Number(x.journal_seq), entryId: x.entry_id, subjectKind: x.subject_kind, subjectId: x.subject_id, mismatch: x.mismatch, state: x.state, deadlineReached: x.reached }));
  }

  /** An observation whose deadline passed on the database clock closes TIMED_OUT (the database refuses an early timeout, KA092). */
  async timeOut(observationId: string): Promise<boolean> {
    const r = await this.owner.query("UPDATE kauro.restore_observations SET state = 'TIMED_OUT', closed_at = kauro.server_now() WHERE observation_id = $1 AND state = 'OPEN'", [observationId]);
    return (r.rowCount ?? 0) === 1;
  }

  /**
   * S8: in one transaction the run becomes RELEASED (naming the owner's recovery and its proof) and the gate opens; the database
   * refuses the gate's opening for any other run or before RELEASED (KA092).
   */
  async release(run: RestoreRunRow, recovery: { readonly recoveryId: string; readonly authorizationRef: string }, hold?: ReleaseHold): Promise<RestoreRunRow> {
    return this.#tx(async () => {
      const r = await this.owner.query<RunSqlRow>(
        `UPDATE kauro.restore_runs SET state = 'RELEASED', recovery_id = $2, authorization_ref = $3, revision = revision + 1 WHERE run_id = $1 AND state = 'CHECKED' RETURNING ${RUN_COLUMNS}`,
        [run.runId, recovery.recoveryId, recovery.authorizationRef],
      );
      if (r.rows[0] === undefined) throw new DomainFailure("PRECONDITION_FAILED", `restore run ${run.runId} is not CHECKED`, { reason: "CONSEQUENCES_UNRECONCILED" });
      await this.owner.query("UPDATE kauro.recovery_gate SET state = 'OPEN', revision = revision + 1 WHERE gate_id AND run_id = $1", [run.runId]);
      if (hold !== undefined) await hold();
      return runOf(r.rows[0]);
    });
  }

  /** The restored database's transaction-id horizon: a journal tail that follows it from now on starts here. */
  async horizon(): Promise<string> {
    return (await this.owner.query<{ h: string }>("SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h")).rows[0]!.h;
  }
}

// --- the control plane's side on the restored database ------------------------------------------------------------------------------

function clientOf(uow: UnitOfWork, what: string): Queryable {
  if (!(uow instanceof PgUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", `${what} is read in a unit of work of @kauro/persistence`);
  return (uow as unknown as { readonly client: Queryable }).client;
}

export type TombstonedSubjectKind = "upload_session" | "dataset_revision" | "source_file" | "retention_extension" | "retention_record";

const SUBJECT_STATE: Readonly<Record<TombstonedSubjectKind, string>> = Object.freeze({
  upload_session: "SELECT state FROM kauro.upload_sessions WHERE upload_id = $1",
  dataset_revision: "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1",
  source_file: "SELECT state FROM kauro.source_files WHERE file_id = $1",
  retention_extension: "SELECT 'EXTENDED' AS state FROM kauro.retention_extensions WHERE retention_id = $1",
  retention_record: "SELECT state FROM kauro.retention_records WHERE retention_id = $1",
});

export class PgRestoreControl {
  constructor(private readonly db: Queryable) {}

  /** R2-074: the outbox record of a dispatched notification identity is settled DELIVERED, never dispatched again from the restore. */
  async suppress(eventId: string, consumer: string): Promise<"SUPPRESSED" | "ALREADY_APPLIED" | "ABSENT"> {
    const moved = await this.db.query(
      "UPDATE kauro.outbox_records SET state = 'DELIVERED', delivered_at = kauro.server_now() WHERE event_id = $1 AND consumer = $2 AND state <> 'DELIVERED'",
      [eventId, consumer],
    );
    if ((moved.rowCount ?? 0) === 1) return "SUPPRESSED";
    const present = await this.db.query("SELECT 1 FROM kauro.outbox_records WHERE event_id = $1 AND consumer = $2", [eventId, consumer]);
    return (present.rowCount ?? 0) === 1 ? "ALREADY_APPLIED" : "ABSENT";
  }

  /** S5: no restored holder is live — every lease ends now on the database clock, so its next claim is a takeover at fence + 1. */
  async expireLeases(): Promise<number> {
    const r = await this.db.query("UPDATE kauro.leases SET expires_at = kauro.server_now() WHERE expires_at > kauro.server_now()");
    return r.rowCount ?? 0;
  }

  async liveLeases(): Promise<number> {
    return Number((await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.leases WHERE expires_at > kauro.server_now()")).rows[0]!.n);
  }

  /** S6: the restored capture's status (the unit is bound to the capture's agency), or null when the backup does not hold it. */
  async captureStatus(captureId: string): Promise<string | null> {
    return (await this.db.query<{ status: string }>("SELECT status FROM kauro.capture_facts WHERE capture_id = $1", [captureId])).rows[0]?.status ?? null;
  }

  /** S4/S7: the restored state of a tombstoned subject (null: the backup does not hold it). */
  async subjectState(kind: TombstonedSubjectKind, subjectId: string): Promise<string | null> {
    return (await this.db.query<{ state: string }>(SUBJECT_STATE[kind], [subjectId])).rows[0]?.state ?? null;
  }
}

const restoreBound = new WeakMap<object, PgRestoreControl>();
export function restoreControlOf(uow: UnitOfWork): PgRestoreControl {
  let a = restoreBound.get(uow);
  if (a === undefined) {
    a = new PgRestoreControl(clientOf(uow, "the restore's control side"));
    restoreBound.set(uow, a);
  }
  return a;
}

// --- the control plane's side on the primary ----------------------------------------------------------------------------------------

export interface CandidateRow {
  readonly candidateId: string;
  readonly state: "PREPARED" | "AUTHORIZED";
  readonly planHash: string;
  readonly deletionJournalHash: string;
}

export interface RecoveryRow {
  readonly recoveryId: string;
  readonly candidateId: string;
  readonly deletionJournalHash: string;
  readonly authorizationRef: string;
}

export class PgRecoveryAuthority {
  constructor(private readonly db: Queryable) {}

  async prepare(input: { readonly candidateId: string; readonly planHash: string; readonly deletionJournalHash: string }): Promise<void> {
    await this.db.query("INSERT INTO kauro.restore_candidates (candidate_id, state, plan_hash, deletion_journal_hash) VALUES ($1, 'PREPARED', $2, $3)", [input.candidateId, input.planHash, input.deletionJournalHash]);
  }

  async candidate(candidateId: string): Promise<CandidateRow | null> {
    const r = await this.db.query<{ candidate_id: string; state: CandidateRow["state"]; plan_hash: string; deletion_journal_hash: string }>(
      "SELECT candidate_id, state, plan_hash, deletion_journal_hash FROM kauro.restore_candidates WHERE candidate_id = $1",
      [candidateId],
    );
    const x = r.rows[0];
    return x === undefined ? null : { candidateId: x.candidate_id, state: x.state, planHash: x.plan_hash, deletionJournalHash: x.deletion_journal_hash };
  }

  async recovery(candidateId: string): Promise<RecoveryRow | null> {
    const r = await this.db.query<{ recovery_id: string; candidate_id: string; deletion_journal_hash: string; authorization_ref: string }>(
      "SELECT recovery_id, candidate_id, deletion_journal_hash, authorization_ref FROM kauro.recoveries WHERE candidate_id = $1",
      [candidateId],
    );
    const x = r.rows[0];
    return x === undefined ? null : { recoveryId: x.recovery_id, candidateId: x.candidate_id, deletionJournalHash: x.deletion_journal_hash, authorizationRef: x.authorization_ref };
  }
}

const authorityBound = new WeakMap<object, PgRecoveryAuthority>();
export function recoveryAuthorityOf(uow: UnitOfWork): PgRecoveryAuthority {
  let a = authorityBound.get(uow);
  if (a === undefined) {
    a = new PgRecoveryAuthority(clientOf(uow, "the recovery authority"));
    authorityBound.set(uow, a);
  }
  return a;
}

// --- the journal tail -----------------------------------------------------------------------------------------------------------

export interface TailedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly agencyId: string | null;
  readonly aggregateId: string;
  readonly actorId: string | null;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /** For retention_record.extended.v1: the extension row's replay members (null otherwise). */
  readonly extension: Readonly<Record<string, unknown>> | null;
}

export class PgJournalTail {
  constructor(private readonly db: Queryable) {}

  /**
   * The events of `types` committed by transactions in [from, horizon), horizon = the snapshot's xmin: every transaction below it has
   * ended, so nothing committed there can appear later (a commit-safe tail; a sequence cursor is not: identities are taken at insert,
   * not at commit). A row's 32-bit xmin is widened with the snapshot's epoch. `from` null reads from the beginning.
   */
  async read(types: ReadonlyArray<string>, from: string | null): Promise<{ readonly events: ReadonlyArray<TailedEvent>; readonly horizon: string }> {
    const r = await this.db.query<{ horizon: string; events: ReadonlyArray<{ event_id: string; event_type: string; agency_id: string | null; aggregate_id: string; actor_id: string | null; sequence: string; payload: Record<string, unknown>; extension: Record<string, unknown> | null }> }>(
      `WITH s AS (
         SELECT pg_snapshot_xmin(pg_current_snapshot())::text::numeric AS lo, pg_snapshot_xmax(pg_current_snapshot())::text::numeric AS hi
       ), e AS (
         SELECT d.event_id, d.event_type, d.agency_id, d.aggregate_id, d.actor_id, d.sequence, d.payload,
                (floor(s.hi / 4294967296) * 4294967296 + d.xmin::text::numeric
                 - CASE WHEN d.xmin::text::numeric > s.hi % 4294967296 THEN 4294967296 ELSE 0 END) AS full_xid, s.lo
           FROM kauro.domain_events d, s
          WHERE d.event_type = ANY($1::text[]) AND d.xmin::text::numeric >= 3
       ), t AS (
         SELECT e.*, CASE WHEN e.event_type = 'retention_record.extended.v1' THEN (
                  SELECT jsonb_build_object('extensionId', x.extension_id, 'retentionId', x.retention_id, 'projectId', x.project_id,
                           'requestedSeconds', x.requested_seconds, 'purpose', x.purpose, 'termsVersion', x.terms_version,
                           'membershipId', x.requested_by_membership_id, 'userId', x.requested_by_user_id)
                    FROM kauro.retention_extensions x WHERE x.extension_id = (e.payload ->> 'extensionId')::uuid) END AS extension
           FROM e
          WHERE e.full_xid < e.lo AND ($2::numeric IS NULL OR e.full_xid >= $2::numeric)
       )
       SELECT (SELECT lo::text FROM s) AS horizon,
              coalesce((SELECT jsonb_agg(jsonb_build_object('event_id', t.event_id, 'event_type', t.event_type, 'agency_id', t.agency_id,
                          'aggregate_id', t.aggregate_id, 'actor_id', t.actor_id, 'sequence', t.sequence::text, 'payload', t.payload,
                          'extension', t.extension) ORDER BY t.sequence) FROM t), '[]'::jsonb) AS events`,
      [types, from],
    );
    const row = r.rows[0]!;
    return {
      horizon: row.horizon,
      events: row.events.map((x) => ({
        eventId: x.event_id,
        eventType: x.event_type,
        agencyId: x.agency_id,
        aggregateId: x.aggregate_id,
        actorId: x.actor_id,
        sequence: Number(x.sequence),
        payload: x.payload,
        extension: x.extension,
      })),
    };
  }
}

const tailBound = new WeakMap<object, PgJournalTail>();
export function journalTailOf(uow: UnitOfWork): PgJournalTail {
  let a = tailBound.get(uow);
  if (a === undefined) {
    a = new PgJournalTail(clientOf(uow, "the journal tail"));
    tailBound.set(uow, a);
  }
  return a;
}

/**
 * The durable authority journal outside the restore boundary (package B16 lane L6; R2 14 "External-effect recovery journal", 09
 * "Deletion receipts and restoration"; plan conflict C2): a SEPARATE PostgreSQL database — never a table of the platform's own, which a
 * restore would roll back with everything else — holding one append-only table under its own writer role. Five kinds of entry:
 *
 *   TOMBSTONE     the AUTHORITY_JOURNAL consumer's tombstones (AuthorityJournalPort.append): terminal states and extensions of sources;
 *   REVOCATION    a membership revoked (the journal tail of membership.revoked.v1);
 *   EXTENSION     a retention extension granted, with what a replay needs (the tail of retention_record.extended.v1);
 *   PAYMENT       a provider capture state the platform recorded (the tail of capture.completed.v1 / capture.reversed.v1);
 *   NOTIFICATION  a notification identity that was dispatched (the NOTIFICATIONS consumer, R2-074).
 *
 * The entry id is the subject's own identity, so every writer is idempotent (a second record of the same entry is ALREADY_PRESENT; the
 * same id with another body is a CONFLICT, never an overwrite). journal_seq is dense and in commit order: each append takes the table's
 * EXCLUSIVE lock (readers are never blocked) and writes max + 1, so a restore applies the entries 1..n in exactly the order they were
 * committed and records the k it stopped at. A candidate names the journal by its hash through n (hashThrough).
 *
 * The adapter is handed ONE dedicated connection to the journal database (it opens none: the deployment's connection site owns that)
 * and serializes its own calls on it. Evidence class SIMULATED: the local adapter is a PostgreSQL database on the same host; the
 * provider half (an Object Lock bucket outside the restore boundary) is package B14.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import { canonicalize } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import type { Queryable } from "../sql.js";

export type RecoveryJournalKind = "TOMBSTONE" | "REVOCATION" | "EXTENSION" | "PAYMENT" | "NOTIFICATION";
export const RECOVERY_JOURNAL_KINDS: ReadonlyArray<RecoveryJournalKind> = Object.freeze(["TOMBSTONE", "REVOCATION", "EXTENSION", "PAYMENT", "NOTIFICATION"]);

export interface RecoveryJournalRecord {
  readonly entryId: string;
  readonly kind: RecoveryJournalKind;
  readonly agencyId: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface RecoveryJournalEntry extends RecoveryJournalRecord {
  readonly journalSeq: number;
  readonly bodyHash: Sha256Hex;
}

/** The tombstone members the AUTHORITY_JOURNAL consumer appends (@kauro/application AuthorityTombstone, structurally). */
export interface JournalTombstone {
  readonly tombstoneId: string;
  readonly kind: string;
  readonly agencyId: string;
  readonly revisionId: string;
  readonly subjectId: string;
  readonly state: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly evidenceHash: string;
}

export class RecoveryJournalConflict extends DomainFailure {
  constructor(message: string) {
    super("INTEGRITY_FAILURE", `authority journal (SIMULATED): CONFLICT: ${message}`);
  }
}

/**
 * The journal database's schema, applied by its owner (provisionAuthorityJournal). Append-only by trigger (no UPDATE, DELETE or
 * TRUNCATE of an entry, whoever asks); the tail cursors are the one mutable table (a compare-and-set horizon per source).
 */
export const AUTHORITY_JOURNAL_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS kauro_journal;
CREATE TABLE IF NOT EXISTS kauro_journal.entries (
  journal_seq     bigint PRIMARY KEY CHECK (journal_seq >= 1),
  entry_id        text NOT NULL UNIQUE CHECK (char_length(entry_id) BETWEEN 1 AND 128),
  kind            text NOT NULL CHECK (kind IN ('TOMBSTONE', 'REVOCATION', 'EXTENSION', 'PAYMENT', 'NOTIFICATION')),
  agency_id       uuid,
  event_sequence  bigint CHECK (event_sequence IS NULL OR event_sequence >= 1),
  body            jsonb NOT NULL,
  body_hash       text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT entries_tombstone_sequence CHECK ((kind = 'TOMBSTONE') = (event_sequence IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_tombstone_event_sequence ON kauro_journal.entries (event_sequence) WHERE kind = 'TOMBSTONE';
CREATE OR REPLACE FUNCTION kauro_journal.forbid_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS
$f$
BEGIN
  RAISE EXCEPTION 'JOURNAL: the authority journal is append-only (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'KA007';
END
$f$;
DROP TRIGGER IF EXISTS entries_append_only ON kauro_journal.entries;
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON kauro_journal.entries FOR EACH ROW EXECUTE FUNCTION kauro_journal.forbid_change();
DROP TRIGGER IF EXISTS entries_no_truncate ON kauro_journal.entries;
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON kauro_journal.entries FOR EACH STATEMENT EXECUTE FUNCTION kauro_journal.forbid_change();
CREATE TABLE IF NOT EXISTS kauro_journal.tail_cursors (
  source      text PRIMARY KEY CHECK (source ~ '^[a-z][a-z0-9_-]{0,62}$'),
  horizon     xid8 NOT NULL,
  revision    bigint NOT NULL CHECK (revision >= 1),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON SCHEMA kauro_journal FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA kauro_journal FROM PUBLIC;
`;

const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Applies the journal schema as the journal database's owner and grants the writer role exactly what the adapter does. */
export async function provisionAuthorityJournal(owner: Queryable, writerRole: string): Promise<void> {
  if (!ROLE_NAME.test(writerRole)) throw new RangeError("the journal writer role is a plain lower-case role name");
  await owner.query(AUTHORITY_JOURNAL_SCHEMA);
  await owner.query(`GRANT USAGE ON SCHEMA kauro_journal TO ${writerRole}`);
  // UPDATE only so the writer may take LOCK TABLE ... IN EXCLUSIVE MODE (PostgreSQL requires it); entries_append_only refuses every UPDATE
  await owner.query(`GRANT SELECT, INSERT, UPDATE ON kauro_journal.entries TO ${writerRole}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE ON kauro_journal.tail_cursors TO ${writerRole}`);
}

function hashOf(body: unknown): Sha256Hex {
  return createHash("sha256").update(`KAURO_RECOVERY_JOURNAL_ENTRY_V1\n${canonicalize(body)}`).digest("hex") as Sha256Hex;
}

interface EntryRow {
  readonly journal_seq: string;
  readonly entry_id: string;
  readonly kind: RecoveryJournalKind;
  readonly agency_id: string | null;
  readonly body: Record<string, unknown>;
  readonly body_hash: string;
}

function entryOf(row: EntryRow): RecoveryJournalEntry {
  return { journalSeq: Number(row.journal_seq), entryId: row.entry_id, kind: row.kind, agencyId: row.agency_id, body: row.body, bodyHash: row.body_hash as Sha256Hex };
}

const TOMBSTONE_MEMBERS = ["agencyId", "evidenceHash", "kind", "occurredAt", "revisionId", "sequence", "state", "subjectId", "tombstoneId"] as const;

/** T: the caller's own tombstone type (@kauro/application AuthorityTombstone), so the class satisfies its port without a cast. */
export class PgAuthorityJournal<T extends JournalTombstone = JournalTombstone> {
  readonly evidenceClass = "SIMULATED" as const;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Queryable) {}

  /** One call at a time on the one connection (a transaction of record() never interleaves with another call). */
  #serial<R>(work: () => Promise<R>): Promise<R> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // --- AuthorityJournalPort (the AUTHORITY_JOURNAL consumer) -------------------------------------------------------------------

  async append(tombstone: T): Promise<"APPENDED" | "ALREADY_PRESENT"> {
    const body: Record<string, unknown> = {};
    for (const m of TOMBSTONE_MEMBERS) body[m] = tombstone[m];
    return this.#record({ entryId: tombstone.tombstoneId, kind: "TOMBSTONE", agencyId: tombstone.agencyId, body }, tombstone.sequence);
  }

  async list(agencyId: string, afterSequence: number): Promise<ReadonlyArray<T>> {
    return this.#serial(async () => {
      const r = await this.db.query<{ body: T }>(
        "SELECT body FROM kauro_journal.entries WHERE kind = 'TOMBSTONE' AND agency_id = $1 AND event_sequence > $2 ORDER BY event_sequence",
        [agencyId, afterSequence],
      );
      return r.rows.map((x) => x.body);
    });
  }

  // --- RecoveryJournalPort (the tails, the NOTIFICATIONS consumer, the restore runner) -------------------------------------------

  record(entry: RecoveryJournalRecord): Promise<"APPENDED" | "ALREADY_PRESENT"> {
    if (entry.kind === "TOMBSTONE") throw new RangeError("a tombstone is appended through append(), with its event sequence");
    return this.#record(entry, null);
  }

  #record(entry: RecoveryJournalRecord, eventSequence: number | null): Promise<"APPENDED" | "ALREADY_PRESENT"> {
    if (!RECOVERY_JOURNAL_KINDS.includes(entry.kind)) throw new RangeError(`unknown journal kind ${String(entry.kind)}`);
    const bodyHash = hashOf(entry.body);
    return this.#serial(async () => {
      await this.db.query("BEGIN");
      try {
        // dense and in commit order: writers queue on the table, readers never wait
        await this.db.query("LOCK TABLE kauro_journal.entries IN EXCLUSIVE MODE");
        const present = await this.db.query<{ kind: string; body_hash: string; event_sequence: string | null }>(
          "SELECT kind, body_hash, event_sequence FROM kauro_journal.entries WHERE entry_id = $1",
          [entry.entryId],
        );
        const row = present.rows[0];
        if (row !== undefined) {
          await this.db.query("ROLLBACK");
          if (row.kind !== entry.kind || row.body_hash !== bodyHash || (row.event_sequence === null ? null : Number(row.event_sequence)) !== eventSequence) {
            throw new RecoveryJournalConflict(`entry ${entry.entryId} is already journaled with other members`);
          }
          return "ALREADY_PRESENT";
        }
        if (eventSequence !== null) {
          const taken = await this.db.query("SELECT 1 FROM kauro_journal.entries WHERE kind = 'TOMBSTONE' AND event_sequence = $1", [eventSequence]);
          if ((taken.rowCount ?? 0) > 0) {
            await this.db.query("ROLLBACK");
            throw new RecoveryJournalConflict(`event sequence ${eventSequence} already holds another tombstone`);
          }
        }
        await this.db.query(
          `INSERT INTO kauro_journal.entries (journal_seq, entry_id, kind, agency_id, event_sequence, body, body_hash)
           SELECT coalesce(max(journal_seq), 0) + 1, $1, $2, $3, $4, $5::jsonb, $6 FROM kauro_journal.entries`,
          [entry.entryId, entry.kind, entry.agencyId, eventSequence, JSON.stringify(entry.body), bodyHash],
        );
        await this.db.query("COMMIT");
        return "APPENDED";
      } catch (e) {
        await this.db.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  has(entryId: string): Promise<boolean> {
    return this.#serial(async () => ((await this.db.query("SELECT 1 FROM kauro_journal.entries WHERE entry_id = $1", [entryId])).rowCount ?? 0) > 0);
  }

  /** The entries after `after` through `through`, in journal order. */
  entries(after: number, through: number): Promise<ReadonlyArray<RecoveryJournalEntry>> {
    return this.#serial(async () => {
      const r = await this.db.query<EntryRow>(
        // ORDER BY the column, not the text output of the same name (a text order puts 10 before 2)
        "SELECT e.journal_seq::text AS journal_seq, e.entry_id, e.kind, e.agency_id::text AS agency_id, e.body, e.body_hash FROM kauro_journal.entries e WHERE e.journal_seq > $1 AND e.journal_seq <= $2 ORDER BY e.journal_seq",
        [after, through],
      );
      return r.rows.map(entryOf);
    });
  }

  /** The last journal sequence committed (0 for an empty journal). */
  head(): Promise<number> {
    return this.#serial(async () => Number((await this.db.query<{ n: string }>("SELECT coalesce(max(journal_seq), 0)::text AS n FROM kauro_journal.entries")).rows[0]!.n));
  }

  /** The highest domain-event sequence a tombstone names (0 when none): a restored database's events continue above it. */
  maxEventSequence(): Promise<number> {
    return this.#serial(async () => Number((await this.db.query<{ n: string }>("SELECT coalesce(max(event_sequence), 0)::text AS n FROM kauro_journal.entries")).rows[0]!.n));
  }

  /** The chained hash of entries 1..through (the deletion journal hash a restore candidate names). */
  async hashThrough(through: number): Promise<Sha256Hex> {
    const rows = await this.entries(0, through);
    if (rows.length !== through) throw new RecoveryJournalConflict(`the journal holds ${rows.length} entries, not ${through}`);
    let chain = createHash("sha256").update("KAURO_RECOVERY_JOURNAL_CHAIN_V1").digest("hex");
    for (const e of rows) chain = createHash("sha256").update(`${chain}\n${e.journalSeq}\n${e.entryId}\n${e.kind}\n${e.bodyHash}`).digest("hex");
    return chain as Sha256Hex;
  }

  // --- the tail cursors ---------------------------------------------------------------------------------------------------------

  cursor(source: string): Promise<string | null> {
    return this.#serial(async () => (await this.db.query<{ horizon: string }>("SELECT horizon::text FROM kauro_journal.tail_cursors WHERE source = $1", [source])).rows[0]?.horizon ?? null);
  }

  /** Moves a source's horizon from `from` (null: none yet) to `to`, compare-and-set; false when another tail moved it first. */
  advanceCursor(source: string, from: string | null, to: string): Promise<boolean> {
    return this.#serial(async () => {
      const r =
        from === null
          ? await this.db.query("INSERT INTO kauro_journal.tail_cursors (source, horizon, revision) VALUES ($1, $2::xid8, 1) ON CONFLICT (source) DO NOTHING", [source, to])
          : await this.db.query("UPDATE kauro_journal.tail_cursors SET horizon = $3::xid8, revision = revision + 1, updated_at = clock_timestamp() WHERE source = $1 AND horizon = $2::xid8", [source, from, to]);
      return (r.rowCount ?? 0) === 1;
    });
  }

  /** A released restore re-bases its source's horizon on the restored database's own transaction ids (S8). */
  rebaseCursor(source: string, to: string): Promise<void> {
    return this.#serial(async () => {
      await this.db.query(
        `INSERT INTO kauro_journal.tail_cursors (source, horizon, revision) VALUES ($1, $2::xid8, 1)
         ON CONFLICT (source) DO UPDATE SET horizon = EXCLUDED.horizon, revision = kauro_journal.tail_cursors.revision + 1, updated_at = clock_timestamp()`,
        [source, to],
      );
    });
  }
}

/**
 * The agency lock-order cells of CMD002 ActivateAgency and CMD043 CloseAgency (B10 kit; D10-TX-1; adversary ADV-1, ADV-2, ADV-4 of
 * 593c47f). An agency transition writer takes the agency's row lock and its exclusive transition half; an agency reader takes the
 * shared half and, through every insert that references the agency, the row's KEY SHARE. Readers come in the two orders production
 * has:
 *  - SHARED_THEN_KEY_SHARE: the shared half, then an insert (CMD028's continuation: the claim and the payment service's settlement
 *    read the purchased subject, then insert their events);
 *  - KEY_SHARE_THEN_SHARED: an insert, then the shared half (every journaled tenant command: the command_journal reservation's
 *    agency foreign key, then the subject read — CMD028's intent, CMD009, CMD011, CMD027, ReserveUpload).
 * The writer's row lock must be FOR NO KEY UPDATE: FOR UPDATE conflicts with the KEY SHARE, and with the transition halves that
 * closes a cycle for one reader order or the other whichever half the writer takes first (40P01).
 *
 * Each cell fixes one interleaving with hold points and observes waits by backend pid in pg_stat_activity (pg_blocking_pids): which
 * session waited for which is part of the outcome, never "some session waited" (ADV-4). The raw reader is a tenant transaction on the
 * request-handler role (writers.ts) issuing exactly the statements production issues, in production's order: the shared half is
 * kauro.await_transition('kauro.agencies'), the insert is CMD009's first write (a processing authority of the agency).
 */
import type { AgencyFixture } from "@kauro/persistence/testing";
import { API_APPLICATION_NAME } from "../src/index.js";
import { ids, type HoldName, type Reply, type World } from "./support.js";
import { tenantWriter, type HeldTransaction } from "./writers.js";

export type ReaderShape = "SHARED_THEN_KEY_SHARE" | "KEY_SHARE_THEN_SHARED";
export type First = "READER_FIRST" | "WRITER_FIRST";

const POLL_ATTEMPTS = 400;
const POLL_INTERVAL_MS = 25;

interface Tracked<T> {
  readonly settled: Promise<PromiseSettledResult<T>>;
  done(): boolean;
}

export function track<T>(p: Promise<T>): Tracked<T> {
  let done = false;
  const settled = p.then(
    (value): PromiseSettledResult<T> => {
      done = true;
      return { status: "fulfilled", value };
    },
    (reason: unknown): PromiseSettledResult<T> => {
      done = true;
      return { status: "rejected", reason };
    },
  );
  return { settled, done: () => done };
}

/** Polls `test` until it holds, bounded (the harness's 400 x 25 ms window); throws naming `what` instead of hanging. */
export async function until(what: string, test: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`not observed within ${POLL_ATTEMPTS * POLL_INTERVAL_MS} ms: ${what}`);
}

/** The pids blocking `pid` (pg_blocking_pids), from a fresh pg_stat_activity snapshot. */
export async function blockersOf(w: World, pid: number): Promise<ReadonlyArray<number>> {
  await w.h.oracle.query("SELECT pg_stat_clear_snapshot()");
  const r = await w.h.oracle.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [pid]);
  return r.rows[0]?.blockers ?? [];
}

/** The pids waiting on `pid`. */
export async function waitersOn(w: World, pid: number): Promise<ReadonlyArray<number>> {
  await w.h.oracle.query("SELECT pg_stat_clear_snapshot()");
  const r = await w.h.oracle.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
  return r.rows.map((x) => x.pid);
}

/** The api backends idle inside an open transaction (a request paused at a hold point), by pid. */
export async function apiIdleInTransaction(w: World): Promise<ReadonlyArray<number>> {
  await w.h.oracle.query("SELECT pg_stat_clear_snapshot()");
  const r = await w.h.oracle.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state LIKE 'idle in transaction%' ORDER BY pid", [API_APPLICATION_NAME]);
  return r.rows.map((x) => x.pid);
}

/** The api backends inside a request (active, or idle inside an open transaction), by pid. */
export async function apiBusy(w: World): Promise<ReadonlyArray<number>> {
  await w.h.oracle.query("SELECT pg_stat_clear_snapshot()");
  const r = await w.h.oracle.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state <> 'idle' ORDER BY pid", [API_APPLICATION_NAME]);
  return r.rows.map((x) => x.pid);
}

/**
 * Whether `waiter` is blocked by exactly `holder` (pg_blocking_pids = [holder]): both ends of the wait are named (ADV-4, ADV-9). A
 * waiter blocked by any other backend is not this interleaving and throws, naming the blockers.
 */
export async function waitsExactlyOn(w: World, waiter: number, holder: number): Promise<boolean> {
  const blockers = await blockersOf(w, waiter);
  if (blockers.length === 0) return false;
  if (blockers.length === 1 && blockers[0] === holder) return true;
  throw new Error(`backend ${waiter} waits for ${JSON.stringify(blockers)}, not for exactly ${holder}`);
}

/** The single api backend inside a request (the writer under test); throws when there is not exactly one. */
export async function soleApiBackend(w: World, what: string): Promise<number> {
  const busy = await apiBusy(w);
  if (busy.length !== 1) throw new Error(`${what}: expected exactly one api backend inside a request, found ${JSON.stringify(busy)}`);
  return busy[0]!;
}

export interface WriterUnderTest {
  readonly agency: AgencyFixture;
  /** Starts the transition command through its route. */
  readonly start: () => Promise<Reply>;
  /**
   * The hold at which the writer, started first, holds the agency: "collaborator" for CMD043 (its active-work inspection, holding the
   * row and the exclusive half), "journal.commit" for CMD002 (its state change is written: the row and, through the trigger, the
   * exclusive half).
   */
  readonly rowHold: HoldName;
}

export interface CellOutcome {
  readonly writer: string;
  /** "OK", or the SQLSTATE the reader's statements failed with (40P01: a deadlock). */
  readonly reader: string;
  /** The reader's backend was observed blocked by exactly the writer's backend while it took its locks. */
  readonly readerWaited: boolean;
  /** The writer's backend was observed blocked by exactly the reader's backend. */
  readonly writerWaited: boolean;
}

const sqlState = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : String(e));

/**
 * One cell: `writer` (CMD002 or CMD043) against a raw reader of the agency of `shape`, in the interleaving `first`. The outcome names
 * the writer's answer (status and code), the reader's result and who was observed waiting for whom, by both backend pids.
 */
export async function readerCell(w: World, writer: WriterUnderTest, shape: ReaderShape, first: First, describe: (reply: Reply) => string): Promise<CellOutcome> {
  const agencyId = writer.agency.agencyId;
  const shared = (r: HeldTransaction) => r.query("SELECT kauro.await_transition('kauro.agencies', $1)", [agencyId]);
  const keyShare = (r: HeldTransaction) =>
    r.query("INSERT INTO kauro.processing_authorities (processing_authority_id, agency_id, recorded_by_membership_id, recorded_at) VALUES ($1, $2, $3, now())", [
      ids.next(),
      agencyId,
      writer.agency.ownerMembershipId,
    ]);
  const [firstLock, secondLock] = shape === "SHARED_THEN_KEY_SHARE" ? [shared, keyShare] : [keyShare, shared];
  const reader = await tenantWriter(w, writer.agency);
  const answerOf = (answer: PromiseSettledResult<Reply>): string => (answer.status === "fulfilled" ? describe(answer.value) : `threw ${String(answer.reason)}`);
  try {
    const readerPid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let readerWaited = false;
    let writerWaited = false;
    if (first === "WRITER_FIRST") {
      // the writer holds the agency at its hold; the reader then takes both of its locks
      const hold = w.holds.arm(writer.rowHold);
      const request = track(writer.start());
      await Promise.race([hold.reached, request.settled]);
      if (request.done()) throw new Error(`the writer answered before it reached ${writer.rowHold}: ${answerOf(await request.settled)}`);
      const writerPid = await soleApiBackend(w, `the writer at ${writer.rowHold}`);
      const steps = track((async () => {
        await firstLock(reader);
        await secondLock(reader);
      })());
      await until("the reader takes both locks or waits for the writer", async () => steps.done() || (readerWaited = await waitsExactlyOn(w, readerPid, writerPid)));
      hold.release();
      const r = await steps.settled;
      await reader.close();
      return { writer: answerOf(await request.settled), reader: r.status === "fulfilled" ? "OK" : sqlState(r.reason), readerWaited, writerWaited };
    }
    // the reader first: it holds its first lock; the writer runs until it waits for exactly the reader or reaches its commit
    await firstLock(reader);
    const hold = w.holds.arm("journal.commit");
    const reached = track(hold.reached);
    const request = track(writer.start());
    let writerPid: number | null = null;
    await until("the writer waits for the reader or reaches its commit", async () => {
      if (reached.done() || request.done()) return true;
      const busy = await apiBusy(w);
      if (busy.length !== 1) return false;
      writerPid = busy[0]!;
      return (writerWaited = await waitsExactlyOn(w, writerPid, readerPid));
    });
    if (writerPid === null || !writerWaited) writerPid = reached.done() ? await soleApiBackend(w, "the writer at its commit") : writerPid;
    const second = track(secondLock(reader));
    await until("the reader's second lock is taken or waits", async () => second.done() || (writerPid !== null && (readerWaited = await waitsExactlyOn(w, readerPid, writerPid))));
    // a reader waiting for the writer can only be waiting for a writer paused at its commit (otherwise this is a cycle and PostgreSQL
    // ends it): let the writer commit
    if (readerWaited) hold.release();
    const r = await second.settled;
    await reader.close();
    hold.release();
    const answer = await request.settled;
    await disarm(w, "journal.commit", reached.done());
    return { writer: answerOf(answer), reader: r.status === "fulfilled" ? "OK" : sqlState(r.reason), readerWaited, writerWaited };
  } finally {
    await reader.close();
  }
}

/**
 * Consumes a one-shot hold the request never reached (it answered before it: a deadlock victim, a refusal), so the next cell can arm
 * it again; a reached hold is left alone (it was passed).
 */
export async function disarm(w: World, name: HoldName, reached: boolean): Promise<void> {
  if (reached || !w.holds.armedNames.includes(name)) return;
  const pass = w.holds.pass(name);
  await pass.catch(() => undefined);
}

/** The one api backend inside a request other than `known`, or null when there is none; throws when there are several. */
export async function otherApiBackend(w: World, known: number): Promise<number | null> {
  const others = (await apiBusy(w)).filter((pid) => pid !== known);
  if (others.length > 1) throw new Error(`expected at most one api backend besides ${known}, found ${JSON.stringify(others)}`);
  return others[0] ?? null;
}

/** Whether `waiter` (the other api backend besides `holder`, once there is one) is blocked by exactly `holder`. */
export async function otherWaitsExactlyOn(w: World, holder: number): Promise<boolean> {
  const waiter = await otherApiBackend(w, holder);
  return waiter !== null && (await waitsExactlyOn(w, waiter, holder));
}

/** Whether `waiter` is blocked by exactly the other api backend besides it. */
export async function waitsExactlyOnOther(w: World, waiter: number): Promise<boolean> {
  const holder = await otherApiBackend(w, waiter);
  return holder !== null && (await waitsExactlyOn(w, waiter, holder));
}

/**
 * Whether exactly one backend (of any application: the payment service's settlement runs on its own pool) waits on `holder`, blocked by
 * exactly `holder`; throws when several do or the waiter is blocked by another backend too.
 */
export async function oneWaiterOn(w: World, holder: number): Promise<boolean> {
  const waiters = await waitersOn(w, holder);
  if (waiters.length === 0) return false;
  if (waiters.length > 1) throw new Error(`several backends wait on ${holder}: ${JSON.stringify(waiters)}`);
  return waitsExactlyOn(w, waiters[0]!, holder);
}

// PV1R-07 r4 (docs/review/pv1-route-pv1r07-design.md §3.1, §3.2, §5): the session fence. The request handlers' role (kauro_app) locks the one
// web session its own transaction presents FOR SHARE, inside the transaction that commits the effect, and reads its liveness in that same
// locking statement; every writer of the row (revoke, resume touch, step-up) takes FOR UPDATE on kauro_assurance and so waits until that
// transaction ends. Written test-first: on 7bc2745 kauro_app holds no privilege on kauro.web_sessions, so every fence statement is refused
// 42501 (permission denied for table web_sessions). The fence is the §3.2 statement pair verbatim, run on a kauro_app_test connection; the
// writers are the product's own PgWebSessionStore on a kauro_assurance_test pool (its 5 s statement bound, WEB_SESSION_STATEMENT_TIMEOUT_MS).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { Sha256Hex } from "@kauro/contracts";
import { toUtcInstant, type CorrelationId, type UserId } from "@kauro/domain";
import { createPool, PgWebSessionStore, WEB_SESSION_STATEMENT_TIMEOUT_MS, type KauroPool } from "../src/index.js";
import { INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_OBSERVATION_MS, startTemporaryPostgres, type TemporaryPostgres, testDatabaseEnvironment } from "../src/testing/index.js";
import { bind, ids, person, sha, sqlState } from "./support.js";

let pg: TemporaryPostgres;
let oracle: Client;
let app: Client;
let assurancePool: KauroPool;
let store: PgWebSessionStore;
before(async () => {
  pg = await startTemporaryPostgres();
  oracle = await pg.connect("postgres");
  app = await pg.connect("kauro_app_test");
  assurancePool = createPool({ environment: testDatabaseEnvironment("LOCAL"), host: "127.0.0.1", port: pg.port, database: "kauro", user: "kauro_assurance_test", max: 4, applicationName: "session-fence-test-assurance" });
  store = new PgWebSessionStore(assurancePool);
});
after(async () => {
  await app?.end();
  await oracle?.end();
  await assurancePool?.end();
  await pg?.stop();
});

const IDLE_S = 1_800;
const TOUCH_S = 60;
const now = () => toUtcInstant(Date.now());
let seq = 0;

interface Session {
  readonly userId: string;
  readonly hash: Sha256Hex;
}
/** A live session of a fresh person, opened through the product's store; `lastSeenAgoMs` back-dates it (a touch is due past 60 s). */
async function session(label: string, lastSeenAgoMs = 0): Promise<Session> {
  const subject = `fence-${label}-${++seq}-${Date.now()}`;
  const { userId } = await person(app, subject);
  const hash = sha(`secret-${subject}`) as Sha256Hex;
  const at = Date.now() - lastSeenAgoMs;
  await store.open(
    { sessionId: ids.next(), userId: userId as UserId, provider: "identity-platform", subjectHash: sha(subject) as Sha256Hex, emailVerifiedAt: toUtcInstant(at), mfaAt: toUtcInstant(at), createdAt: toUtcInstant(at), lastSeenAt: toUtcInstant(at), idleExpiresAt: toUtcInstant(at + IDLE_S * 1000), absoluteExpiresAt: toUtcInstant(at + 12 * 3_600_000) },
    hash,
    `corr-${seq}` as CorrelationId,
  );
  return { userId, hash };
}

interface FenceRow {
  readonly revoked_at: Date | null;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
}
/** The §3.2 fence, verbatim: bind the presented hash transaction-locally, then lock and read the row FOR SHARE (no clock in the statement). */
async function fence(c: Client, s: Session, userId = s.userId): Promise<FenceRow | null> {
  await c.query("SELECT set_config('kauro.session_sha256', $1, true)", [s.hash]);
  const r = await c.query<FenceRow>("SELECT revoked_at, idle_expires_at, absolute_expires_at FROM kauro.web_sessions WHERE secret_sha256 = $1 AND user_id = $2 FOR SHARE", [s.hash, userId]);
  return r.rows[0] ?? null;
}
/** A kauro_app transaction bound to the session's person (the unit's context binding), with an optional statement bound. */
async function appTx(s: Session, statementTimeoutMs?: number): Promise<Client> {
  const c = await pg.connect("kauro_app_test");
  c.on("error", () => undefined);
  await c.query("BEGIN");
  if (statementTimeoutMs !== undefined) await c.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
  await bind(c, { userId: s.userId });
  return c;
}
const pidOf = async (c: Client): Promise<number> => Number((await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
/** The effect's own write in the fence's transaction (the person's identity row: a column kauro_app may update). */
const effectWrite = (c: Client, s: Session): Promise<unknown> => c.query("UPDATE kauro.identities SET email_verified_at = now() - interval '1 day' WHERE user_id = $1", [s.userId]);
const verifiedAt = async (s: Session): Promise<number> => (await oracle.query<{ at: Date }>("SELECT email_verified_at AS at FROM kauro.identities WHERE user_id = $1", [s.userId])).rows[0]!.at.getTime();
interface RowState {
  readonly revokedAt: number | null;
  readonly lastSeen: number;
}
async function rowOf(s: Session): Promise<RowState> {
  const [row] = (await oracle.query<{ revoked_at: Date | null; last_seen_at: Date }>("SELECT revoked_at, last_seen_at FROM kauro.web_sessions WHERE secret_sha256 = $1", [s.hash])).rows;
  assert.ok(row !== undefined, "the session row exists");
  return { revokedAt: row.revoked_at === null ? null : row.revoked_at.getTime(), lastSeen: row.last_seen_at.getTime() };
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The backends observed waiting on a lock `holderPid` holds (pg_blocking_pids), with their login; empty if none within `timeoutMs`. */
async function waitersOf(holderPid: number, timeoutMs = 4_000): Promise<Array<{ pid: number; usename: string }>> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await oracle.query<{ pid: number; usename: string }>("SELECT pid, usename FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holderPid]);
    if (r.rows.length > 0) return r.rows;
    await pause(10);
  }
  return [];
}
/** A store failure as "<code> <retryable|final> <SQLSTATE of its cause>" (the store maps a statement timeout to a retryable CAPACITY_UNAVAILABLE). */
const failureOf = (e: unknown): string => {
  const f = e as { code?: unknown; retryable?: unknown; cause?: { code?: unknown } } | null;
  return [String(f?.code), f?.retryable === true ? "retryable" : "final", String(f?.cause?.code ?? sqlState(e))].join(" ");
};
const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> => p.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
async function terminate(pid: number): Promise<void> {
  assert.equal((await oracle.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [pid])).rows[0]!.ok, true, `backend ${pid} terminated`);
  for (let i = 0; i < 400; i++) {
    if ((await oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rows.length === 0) return;
    await pause(10);
  }
  throw new Error(`backend ${pid} survived pg_terminate_backend`);
}

test("F1 RACE PV1R-07 r4 (fence vs revoke started after the lock): a revocation started while kauro_app holds the presented session FOR SHARE waits on that transaction (kauro_assurance blocked behind the app backend) until the effect commits, then revokes", async () => {
  const s = await session("f1");
  const c = await appTx(s);
  try {
    const row = await fence(c, s);
    assert.ok(row !== null && row.revoked_at === null, "the fence returns the live row (revoked_at null)");
    const before = await verifiedAt(s);
    const pid = await pidOf(c);
    const revoking = settle(store.revoke(s.hash, now, "LOGOUT"));
    const waiters = await waitersOf(pid);
    assert.deepEqual(waiters.map((w) => w.usename), ["kauro_assurance_test"], "the revocation (kauro_assurance) is observed waiting behind the fence's own backend");
    assert.equal((await rowOf(s)).revokedAt, null, "nothing revoked while the fence holds");
    await effectWrite(c, s);
    await c.query("COMMIT");
    const done = await revoking;
    assert.equal(done.status, "fulfilled");
    assert.equal((done as PromiseFulfilledResult<{ outcome: string }>).value.outcome, "REVOKED", "the revocation commits after the effect");
    assert.ok((await rowOf(s)).revokedAt !== null, "the session is revoked");
    assert.notEqual(await verifiedAt(s), before, "the effect committed under the fence");
  } finally {
    await c.end().catch(() => undefined);
  }
});

test("F2 RACE PV1R-07 r4 (crash before COMMIT of the fence holder): the effect write and the lock die together; the waiting revoke commits", async () => {
  const s = await session("f2");
  const before = await verifiedAt(s);
  const c = await appTx(s);
  try {
    const row = await fence(c, s);
    assert.ok(row !== null && row.revoked_at === null, "the fence returns the live row");
    await effectWrite(c, s);
    const pid = await pidOf(c);
    const revoking = settle(store.revoke(s.hash, now, "LOGOUT"));
    assert.deepEqual((await waitersOf(pid)).map((w) => w.usename), ["kauro_assurance_test"], "the revocation waits on the fence's backend");
    await terminate(pid);
    const done = await revoking;
    assert.equal(done.status, "fulfilled", "the revocation proceeds once the fence's backend is gone");
    assert.equal((done as PromiseFulfilledResult<{ outcome: string }>).value.outcome, "REVOKED");
    assert.equal(await verifiedAt(s), before, "the effect written beside the fence died with it (identity row unchanged)");
    assert.ok((await rowOf(s)).revokedAt !== null, "the session is revoked");
  } finally {
    await c.end().catch(() => undefined);
  }
});

test("F3 DENY PV1R-07 r4 (lock-only privileges of kauro_app on web_sessions): kauro_app locks and reads only the liveness of the session its transaction presents for the person it binds, and changes, inserts, deletes or reads nothing else; the binding ends with the transaction", async () => {
  const s = await session("f3");
  const other = await session("f3-other");
  const c = await appTx(s);
  try {
    const own = await fence(c, s);
    assert.ok(own !== null && own.revoked_at === null && own.idle_expires_at.getTime() > Date.now(), "own session: the live row with its deadlines");
    await c.query("COMMIT");
    const refusals: Array<[string, (x: Client) => Promise<unknown>, string]> = [
      ["UPDATE revoked_at", (x) => x.query("UPDATE kauro.web_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE secret_sha256 = $1", [s.hash]), "42501"],
      ["UPDATE session_id = session_id", (x) => x.query("UPDATE kauro.web_sessions SET session_id = session_id WHERE secret_sha256 = $1", [s.hash]), "42501"],
      ["SELECT provider", (x) => x.query("SELECT provider FROM kauro.web_sessions WHERE secret_sha256 = $1", [s.hash]), "42501"],
      ["SELECT last_seen_at", (x) => x.query("SELECT last_seen_at FROM kauro.web_sessions WHERE secret_sha256 = $1", [s.hash]), "42501"],
      ["INSERT", (x) => x.query("INSERT INTO kauro.web_sessions (session_id, secret_sha256, user_id, provider, subject_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at) SELECT $2::uuid, $3, user_id, provider, subject_hash, now(), now(), now() + interval '1 minute', now() + interval '1 hour' FROM kauro.identities WHERE user_id = $1", [s.userId, ids.next(), sha(`x-${seq}`)]), "42501"],
      ["DELETE", (x) => x.query("DELETE FROM kauro.web_sessions WHERE secret_sha256 = $1", [s.hash]), "42501"],
    ];
    for (const [what, run, code] of refusals) {
      const x = await appTx(s);
      try {
        await x.query("SELECT set_config('kauro.session_sha256', $1, true)", [s.hash]);
        await assert.rejects(run(x), (e: unknown) => sqlState(e) === code, `${what}: refused ${code}`);
      } finally {
        await x.query("ROLLBACK").catch(() => undefined);
        await x.end();
      }
    }
    // other hash, other user, unbound: the fence sees no row
    const y = await appTx(s);
    try {
      assert.equal(await fence(y, other, s.userId), null, "another session's hash under this person: no row");
      assert.equal(await fence(y, s, other.userId), null, "this hash under another person: no row");
      await y.query("SELECT set_config('kauro.session_sha256', '', true)");
      assert.equal((await y.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR SHARE", [s.hash])).rows.length, 0, "unbound hash: no row");
      await y.query("ROLLBACK");
      // binding cleared after ROLLBACK, after COMMIT and on the reused connection (same backend)
      const pid = await pidOf(y);
      for (const end of ["ROLLBACK", "COMMIT"] as const) {
        await y.query("BEGIN");
        await bind(y, { userId: s.userId });
        assert.ok((await fence(y, s)) !== null, `${end}: bound, the row is seen`);
        await y.query(end);
        await y.query("BEGIN");
        await bind(y, { userId: s.userId });
        assert.equal((await y.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR SHARE", [s.hash])).rows.length, 0, `after ${end}: the reused connection presents no session`);
        await y.query("ROLLBACK");
      }
      assert.equal(await pidOf(y), pid, "the same backend served every transaction (pooled reuse)");
    } finally {
      await y.end();
    }
  } finally {
    await c.end().catch(() => undefined);
  }
});

test("F4 RACE PV1R-07 r4 (fence waits behind a committing revoke): the row returns revoked", async () => {
  const s = await session("f4");
  const holder = await pg.connect("kauro_assurance_test");
  const c = await appTx(s);
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT set_config('kauro.session_sha256', $1, true)", [s.hash]);
    assert.equal((await holder.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE", [s.hash])).rowCount, 1);
    const revokedAt = new Date(Date.now()).toISOString();
    await holder.query("UPDATE kauro.web_sessions SET revoked_at = $2::timestamptz, revoke_reason = 'LOGOUT' WHERE secret_sha256 = $1", [s.hash, revokedAt]);
    const fencing = settle(fence(c, s));
    const waiters = await waitersOf(await pidOf(holder));
    if (waiters.length === 0) {
      // a fence that never waited answered at once: surface its own answer (a refusal names its SQLSTATE)
      const early = await fencing;
      if (early.status === "rejected") throw early.reason;
    }
    assert.deepEqual(waiters.map((w) => w.usename), ["kauro_app_test"], "the fence is observed waiting behind the revoking transaction");
    await holder.query("COMMIT");
    const got = await fencing;
    assert.equal(got.status, "fulfilled", `the fence completes once the revoke commits (${got.status === "rejected" ? sqlState(got.reason) : "ok"})`);
    const row = (got as PromiseFulfilledResult<FenceRow | null>).value;
    assert.equal(row?.revoked_at?.getTime() ?? null, Date.parse(revokedAt), "the fence returns the row as the revocation committed it (revoked)");
  } finally {
    await holder.end();
    await c.end().catch(() => undefined);
  }
});

test("F5 RACE PV1R-07 r4 (timeout, fence): a fence that waits on a revoking transaction past its unit's statement bound fails 57014 at the bound and nothing of its transaction commits", async () => {
  const s = await session("f5");
  const before = await verifiedAt(s);
  const holder = await pg.connect("kauro_assurance_test");
  const BOUND_MS = INJECTED_STATEMENT_TIMEOUT_MS;
  const c = await appTx(s, BOUND_MS);
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT set_config('kauro.session_sha256', $1, true)", [s.hash]);
    await holder.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE", [s.hash]);
    await effectWrite(c, s);
    const started = Date.now();
    const got = await settle(fence(c, s));
    const waited = Date.now() - started;
    assert.equal(got.status === "rejected" ? sqlState(got.reason) : `fulfilled ${JSON.stringify((got as PromiseFulfilledResult<unknown>).value)}`, "57014", "the fence fails at the unit's statement bound (query_canceled)");
    assert.ok(waited >= BOUND_MS && waited < BOUND_MS + LOCK_WAIT_OBSERVATION_MS, `the bound fired after ${waited} ms (bound ${BOUND_MS} ms)`);
    await c.query("ROLLBACK");
    assert.equal(await verifiedAt(s), before, "the effect written before the fence is not committed");
    await holder.query("ROLLBACK");
    assert.equal((await rowOf(s)).revokedAt, null, "the session stands as it was");
  } finally {
    await holder.end();
    await c.end().catch(() => undefined);
  }
});

test("F6 RACE PV1R-07 r4 (retry): re-lock in one transaction never waits; re-taken after ROLLBACK", async () => {
  const s = await session("f6");
  const c = await appTx(s, 2_000);
  try {
    assert.ok((await fence(c, s)) !== null, "first fence");
    const started = Date.now();
    const again = await fence(c, s);
    assert.ok(again !== null && again.revoked_at === null, "the second fence of the same transaction returns the live row");
    assert.ok(Date.now() - started < 1_000, `the second fence did not wait on its own lock (${Date.now() - started} ms)`);
    await c.query("ROLLBACK");
    // after the ROLLBACK a new transaction of the same connection fences again, and a revoke waits on it
    await c.query("BEGIN");
    await bind(c, { userId: s.userId });
    assert.ok((await fence(c, s)) !== null, "the fence is taken again after ROLLBACK");
    const pid = await pidOf(c);
    const revoking = settle(store.revoke(s.hash, now, "LOGOUT"));
    assert.deepEqual((await waitersOf(pid)).map((w) => w.usename), ["kauro_assurance_test"], "the re-taken fence holds the row (a revoke waits on it)");
    await c.query("COMMIT");
    assert.equal(((await revoking) as PromiseFulfilledResult<{ outcome: string }>).value?.outcome, "REVOKED");
  } finally {
    await c.end().catch(() => undefined);
  }
});

test("T2 RACE PV1R-07 r4 (timeout, revoke behind a fence past 5 s): 57014, session unrevoked, retry revokes", async () => {
  const s = await session("t2");
  const c = await appTx(s);
  try {
    assert.ok((await fence(c, s)) !== null, "the fence holds the live row");
    const started = Date.now();
    const first = await settle(store.revoke(s.hash, now, "LOGOUT"));
    const waited = Date.now() - started;
    assert.equal(first.status === "rejected" ? failureOf(first.reason) : `fulfilled ${JSON.stringify((first as PromiseFulfilledResult<unknown>).value)}`, "CAPACITY_UNAVAILABLE retryable 57014", "the revoke fails at its statement bound (57014, answered as a retryable refusal)");
    assert.ok(waited >= WEB_SESSION_STATEMENT_TIMEOUT_MS && waited < WEB_SESSION_STATEMENT_TIMEOUT_MS + 3_000, `the 5 s bound fired after ${waited} ms`);
    assert.equal((await rowOf(s)).revokedAt, null, "the session is not revoked by the timed-out attempt");
    await c.query("COMMIT");
    const retry = await store.revoke(s.hash, now, "LOGOUT");
    assert.equal(retry.outcome, "REVOKED", "the retry after the fence ended revokes");
    assert.ok((await rowOf(s)).revokedAt !== null);
  } finally {
    await c.end().catch(() => undefined);
  }
});

test("T3 RACE PV1R-07 r4 (timeout, resume behind a fence past 5 s): 57014, session not touched, retry touches", async () => {
  const s = await session("t3", 120_000);
  const before = await rowOf(s);
  const c = await appTx(s);
  try {
    assert.ok((await fence(c, s)) !== null, "the fence holds the live row");
    const started = Date.now();
    const first = await settle(store.resume(s.hash, now, IDLE_S, TOUCH_S));
    const waited = Date.now() - started;
    assert.equal(first.status === "rejected" ? failureOf(first.reason) : `fulfilled ${JSON.stringify((first as PromiseFulfilledResult<unknown>).value)}`, "CAPACITY_UNAVAILABLE retryable 57014", "the resume fails at its statement bound (57014, answered as a retryable refusal)");
    assert.ok(waited >= WEB_SESSION_STATEMENT_TIMEOUT_MS && waited < WEB_SESSION_STATEMENT_TIMEOUT_MS + 3_000, `the 5 s bound fired after ${waited} ms`);
    assert.deepEqual(await rowOf(s), before, "the session is not touched by the timed-out attempt");
    await c.query("COMMIT");
    const retry = await store.resume(s.hash, now, IDLE_S, TOUCH_S);
    assert.ok(retry !== null && retry.revokedAt === null, "the retry resumes the live session");
    assert.ok((await rowOf(s)).lastSeen > before.lastSeen, "the retry touches it (last-seen moved forward)");
  } finally {
    await c.end().catch(() => undefined);
  }
});

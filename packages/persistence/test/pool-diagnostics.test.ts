// A database outage is visible without exposing credentials (14 "Monitoring and service health"; review finding R38). An
// idle pooled connection the server terminates must reach the pool's error sink as a safe classification — the pool's
// application name, the error class and the SQLSTATE — never the message, the host, the user or a password; with no sink
// configured the same classification is written to stderr. Real PostgreSQL 17: the server itself terminates the backend.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { identityUserId, isDomainFailure } from "@kauro/domain";
import { classifyError, createPool, createUnitOfWorkFactory, type PoolErrorEvent } from "../src/index.js";
import { clock, correlation } from "../src/testing/harness.js";
import { ROLES, startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres();
});
after(async () => {
  await pg.stop();
});

const PASSWORD = "runtime-secret-value";

/** Fails loudly when `promise` has not settled within `ms`: a bounded wait, never a synchronization point. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens one connection through the pool, returns it idle, and has the server terminate its backend. */
async function terminateIdleConnection(pool: ReturnType<typeof createPool>, applicationName: string): Promise<void> {
  const { client } = await pool.acquire();
  client.release();
  const oracle = await pg.connect("postgres");
  try {
    const r = await oracle.query<{ terminated: boolean }>("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
    assert.deepEqual(r.rows.map((x) => x.terminated), [true], "exactly the pool's idle backend is terminated");
  } finally {
    await oracle.end();
  }
}

test("R38: an idle connection the server terminates reaches the pool's error sink as pool name, class and SQLSTATE — never the message or a connection parameter", async () => {
  let deliver: (event: PoolErrorEvent) => void = () => undefined;
  const delivered = new Promise<PoolErrorEvent>((resolve) => {
    deliver = resolve;
  });
  const events: PoolErrorEvent[] = [];
  const pool = createPool({
    environment: "LOCAL",
    host: "127.0.0.1",
    port: pg.port,
    database: ROLES.database,
    user: ROLES.appLogin,
    password: PASSWORD,
    max: 1,
    applicationName: "kauro-pool-sink",
    onError: (event) => {
      events.push(event);
      deliver(event);
    },
  });
  try {
    await terminateIdleConnection(pool, "kauro-pool-sink");
    const event = await within(delivered, 10_000, "the pool error sink");
    // 57P01 admin_shutdown: "terminating connection due to administrator command"
    assert.deepEqual(event, { pool: "kauro-pool-sink", connection: "IDLE", errorClass: "DatabaseError", code: "57P01" });
    const text = JSON.stringify(events);
    for (const secret of [PASSWORD, ROLES.appLogin, "127.0.0.1", String(pg.port), "terminating", "administrator"]) assert.ok(!text.includes(secret), `the event carries no ${secret}`);
    // the pool dropped the dead connection and serves the next acquire with a fresh one
    const { client } = await pool.acquire();
    assert.equal((await client.query<{ one: number }>("SELECT 1 AS one")).rows[0]?.one, 1);
    client.release();
  } finally {
    await pool.end();
  }
});

test("R38: without a configured sink the classification is written to stderr, one line, and nothing is swallowed", async () => {
  const lines: string[] = [];
  let deliver: () => void = () => undefined;
  const written = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.startsWith("kauro-db ")) {
      lines.push(text);
      deliver();
      return true;
    }
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const pool = createPool({ environment: "LOCAL", host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.appLogin, password: PASSWORD, max: 1, applicationName: "kauro-pool-default" });
  try {
    await terminateIdleConnection(pool, "kauro-pool-default");
    await within(written, 10_000, "the default pool error line");
    assert.deepEqual(lines, ["kauro-db pool=kauro-pool-default idle connection error class=DatabaseError code=57P01\n"]);
  } finally {
    process.stderr.write = original;
    await pool.end();
  }
  // the classification reads classes and codes only
  assert.deepEqual(classifyError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432"), { code: "ECONNREFUSED" })), { errorClass: "Error", code: "ECONNREFUSED" });
  assert.deepEqual(classifyError(Object.assign(new Error("password authentication failed for user kauro_api"), { code: "not a code" })), { errorClass: "Error" });
  assert.deepEqual(classifyError("a string"), { errorClass: "string" });
});

test("R38: a connection the server terminates while a unit of work holds it fails that unit of work and reaches the sink as an in-use connection error — no error event is left unhandled, and the pool then serves a fresh connection", async () => {
  // the lost connection of a request in flight (a failover, an administrator termination): pg emits `error` on the checked-out
  // client, where pg-pool's idle listener is detached; with no listener of its own the process would raise an uncaught error
  let deliver: (event: PoolErrorEvent) => void = () => undefined;
  const delivered = new Promise<PoolErrorEvent>((resolve) => {
    deliver = resolve;
  });
  const events: PoolErrorEvent[] = [];
  const pool = createPool({
    environment: "LOCAL",
    host: "127.0.0.1",
    port: pg.port,
    database: ROLES.database,
    user: ROLES.appLogin,
    password: PASSWORD,
    max: 1,
    applicationName: "kauro-pool-in-use",
    onError: (event) => {
      events.push(event);
      deliver(event);
    },
  });
  const oracle = await pg.connect("postgres");
  const unitOfWork = createUnitOfWorkFactory(pool, { clock });
  const userId = identityUserId("test", "r38-in-use");
  try {
    const outcome = unitOfWork.run({ kind: "IDENTITY", userId, correlationId: correlation() }, async (uow) => {
      // the unit of work holds its connection, idle inside its transaction, when the server terminates the backend
      const r = await oracle.query<{ terminated: boolean }>("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1", ["kauro-pool-in-use"]);
      assert.deepEqual(r.rows.map((x) => x.terminated), [true], "exactly the unit of work's backend is terminated");
      await within(delivered, 10_000, "the in-use connection error");
      // the next statement of the unit of work fails: the transaction is gone with its connection
      await uow.identities.getOwn(userId);
      assert.fail("a statement on a terminated connection cannot succeed");
    });
    await assert.rejects(outcome, (e: unknown) => isDomainFailure(e) && e.code === "INTERNAL_ERROR", "the unit of work answers the loss, never a success");
    assert.deepEqual(events[0], { pool: "kauro-pool-in-use", connection: "IN_USE", errorClass: "DatabaseError", code: "57P01" });
    const text = JSON.stringify(events);
    for (const secret of [PASSWORD, ROLES.appLogin, "127.0.0.1", String(pg.port), "terminating", "administrator"]) assert.ok(!text.includes(secret), `the events carry no ${secret}`);
    // the lost connection was destroyed, not pooled: the next unit of work runs on a fresh one
    assert.equal(await unitOfWork.run({ kind: "IDENTITY", userId, correlationId: correlation() }, async (uow) => (await uow.identities.getOwn(userId)) === null), true);
  } finally {
    await oracle.end();
    await pool.end();
  }
});

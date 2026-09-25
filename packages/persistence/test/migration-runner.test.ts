// The migration runner under concurrency and failure (07 "Restoration and migration": checksums and applied versions are
// recorded, migration roles are separate from runtime, lock timeouts are explicit; 07 "Connection budget": two API instances
// are planned, and each may migrate on start). Review findings R33 (two runners started at once must both succeed: one
// applies, the other finds the work done) and R37 (the migrator's connection, statements and lock waits are bounded, so a
// start fails instead of hanging). Real PostgreSQL 17 throughout; the interleaving is fixed by a held runner lock observed in
// pg_stat_activity, never by a sleep.
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { MIGRATION_RUNNER_LOCK, applyMigrationsAs, listMigrations, type ApplyResult } from "../src/index.js";
import { ROLES, startTemporaryPostgres, waitForLockWait } from "../src/testing/index.js";

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

function counts(r: ApplyResult): readonly [number, number] {
  return [r.applied.length, r.skipped.length];
}

test("R33: two runners started at once on a fresh database serialize on the runner lock — both succeed, one applies every migration, the other re-reads the ledger under the lock and skips them", async () => {
  const pg = await startTemporaryPostgres({ migrate: false });
  const oracle = await pg.connect("postgres");
  try {
    const total = listMigrations().length;
    const connection = { host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.owner };
    // left to the scheduler, on a fresh database of the cluster: three runners at once, no failed start
    await oracle.query(`CREATE DATABASE kauro_second OWNER ${ROLES.owner}`);
    const second = { ...connection, database: "kauro_second" };
    const unscripted = await within(Promise.allSettled([applyMigrationsAs(second), applyMigrationsAs(second), applyMigrationsAs(second)]), 60_000, "three unscripted runners");
    const unscriptedOutcomes = unscripted.map((s) => (s.status === "fulfilled" ? counts(s.value) : `rejected: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`));
    assert.deepEqual([...unscriptedOutcomes].sort(), [[0, total], [0, total], [total, 0]].sort(), "every runner succeeds; exactly one applies");

    // a fixed interleaving: a third session holds the runner lock, both runners are observed waiting on it, then it is released
    await oracle.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_RUNNER_LOCK.classId, MIGRATION_RUNNER_LOCK.objectId]);
    let held = true;
    const runs = Promise.allSettled([
      applyMigrationsAs({ ...connection, applicationName: "kauro-migrator-a" }),
      applyMigrationsAs({ ...connection, applicationName: "kauro-migrator-b" }),
    ]);
    try {
      await waitForLockWait(oracle, "kauro-migrator-a", "pg_advisory_lock");
      await waitForLockWait(oracle, "kauro-migrator-b", "pg_advisory_lock");
      await oracle.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_RUNNER_LOCK.classId, MIGRATION_RUNNER_LOCK.objectId]);
      held = false;
    } finally {
      if (held) await oracle.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_RUNNER_LOCK.classId, MIGRATION_RUNNER_LOCK.objectId]);
    }
    const settled = await within(runs, 60_000, "two runners");
    const outcomes = settled.map((s) => (s.status === "fulfilled" ? counts(s.value) : `rejected: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`));
    assert.deepEqual([...outcomes].sort(), [[0, total], [total, 0]].sort(), "both runners succeed; exactly one applies");
    const ledger = await oracle.query<{ version: number; n: string }>("SELECT version, count(*)::text AS n FROM kauro_meta.schema_migrations GROUP BY version ORDER BY version");
    assert.deepEqual(ledger.rows.map((r) => [r.version, r.n]), listMigrations().map((f) => [f.version, "1"]), "every migration recorded exactly once");
    const locks = await oracle.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2", [MIGRATION_RUNNER_LOCK.classId, MIGRATION_RUNNER_LOCK.objectId]);
    assert.equal(locks.rows.length, 0, "the runner lock is released after both runs");
  } finally {
    await oracle.end();
    await pg.stop();
  }
});

test("R37: the migrator is bounded — a host that accepts and never answers refuses within the connect timeout, and a lock held on the ledger refuses within the lock timeout instead of hanging the start", async () => {
  // a TCP endpoint that accepts the connection and never speaks the protocol (an unreachable or wedged database)
  const sockets: Socket[] = [];
  const silent: Server = createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  const silentPort = typeof address === "object" && address ? address.port : 0;
  try {
    await within(
      assert.rejects(applyMigrationsAs({ host: "127.0.0.1", port: silentPort, database: ROLES.database, user: ROLES.owner }, { connectTimeoutMs: 300 }), (e: unknown) => e instanceof Error && /timeout/i.test(e.message)),
      10_000,
      "migrator connecting to a silent host",
    );
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }

  const pg = await startTemporaryPostgres();
  const oracle = await pg.connect("postgres");
  try {
    // another session holds the ledger: the runner's own reads outside a migration file are bounded by the lock timeout too
    await oracle.query("BEGIN");
    await oracle.query("LOCK TABLE kauro_meta.schema_migrations IN ACCESS EXCLUSIVE MODE");
    await within(
      assert.rejects(
        applyMigrationsAs({ host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.owner }, { lockTimeoutMs: 200 }),
        (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "55P03",
      ),
      10_000,
      "migrator reading a locked ledger",
    );
    await oracle.query("ROLLBACK");
    // with the lock gone the same runner succeeds and applies nothing new
    const again = await applyMigrationsAs({ host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.owner }, { lockTimeoutMs: 200 });
    assert.deepEqual(counts(again), [0, listMigrations().length]);
  } finally {
    await oracle.end();
    await pg.stop();
  }
});

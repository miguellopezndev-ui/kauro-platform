// R2-046: ledger waiters restart their transaction rather than changing its clock.
// Real PG17, runtime control units, barriers and observed lock waits; no timing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExecutionUnitOfWork, ProcessingAttemptId, ProcessingJobId } from "@kauro/domain";
import { barrier, handled, waitForLockWait } from "../src/testing/harness.js";
import { admitJob, controlOf, endJob, queueJob } from "../src/testing/execution-fixtures.js";
import { service } from "./commerce-support.js";
import { asControl, causeState, closeExecutionEnv, openExecutionEnv, oracle, purchase, refusedTransaction, type ExecutionEnv } from "./execution-support.js";

let env: ExecutionEnv;
before(async () => { env = await openExecutionEnv("admission-instants"); });
after(async () => { if (env !== undefined) await closeExecutionEnv(env); });

// Also matches the original store's row-lock SQL when this regression runs on 454153e.
const LEDGER_LOCK = "FROM kauro.execution_capacity WHERE ledger_id = 1 FOR UPDATE";

async function admitLocked(uow: ExecutionUnitOfWork, jobId: ProcessingJobId) {
  const job = await uow.execution.lockJob(jobId, "SKIP_LOCKED");
  assert.ok(job);
  return uow.execution.admit(job, uow.ids.next() as ProcessingAttemptId);
}

async function assertInstants(holderId: string, waiterId: string, olderStart: string) {
  const [order] = await oracle<{ waiter_started_first: boolean; admission_later: boolean; ledger_later: boolean; stamps_match: boolean }>(env, `
    SELECT $3::timestamptz < h.admitted_at AS waiter_started_first,
           w.admitted_at > h.admitted_at AS admission_later,
           wl.last_admitted_at > hl.last_admitted_at AS ledger_later,
           w.admitted_at = wl.last_admitted_at AND h.admitted_at = hl.last_admitted_at
             AND wa.consumed_at = w.admitted_at AND ha.consumed_at = h.admitted_at
             AND wt.claimed_at = w.admitted_at AND wt.created_at = w.admitted_at
             AND ht.claimed_at = h.admitted_at AND ht.created_at = h.admitted_at
             AND x.occurred_at = w.admitted_at AND x.created_at = w.admitted_at
             AND r.created_at = w.admitted_at AND c.last_admission_at = w.admitted_at AS stamps_match
      FROM kauro.processing_jobs h JOIN kauro.processing_jobs w ON w.job_id = $2
      JOIN kauro.processing_attempts ht ON ht.attempt_id = h.current_attempt_id
      JOIN kauro.processing_attempts wt ON wt.attempt_id = w.current_attempt_id
      JOIN kauro.agency_execution_capacity hl ON hl.agency_id = h.agency_id
      JOIN kauro.agency_execution_capacity wl ON wl.agency_id = w.agency_id
      JOIN kauro.commercial_authorizations ha ON ha.authorization_id = h.authorization_id
      JOIN kauro.commercial_authorizations wa ON wa.authorization_id = w.authorization_id
      JOIN kauro.dataset_revisions d ON d.project_id = w.project_id AND d.manifest_hash = w.revision_hash
      JOIN kauro.retention_anchors x ON x.revision_id = d.revision_id AND x.anchor_kind = 'EXECUTION_ADMITTED'
      JOIN kauro.retention_records r ON r.anchor_id = x.anchor_id AND r.class = 'PAID_ORDINARY'
      JOIN kauro.execution_capacity c ON c.ledger_id = 1
     WHERE h.job_id = $1`, [holderId, waiterId, olderStart]);
  assert.ok(order?.waiter_started_first, "the waiter's original transaction starts before the holder's");
  assert.ok(order.admission_later, "waiter admitted_at must be later than holder admitted_at after the ledger wait");
  assert.ok(order.ledger_later, "waiter last_admitted_at must be later than holder last_admitted_at after the ledger wait");
  assert.ok(order.stamps_match, "jobs, attempts, retention, ledgers and consumption share the exact transaction instants");
}

test("R2-046 regression: an older ledger waiter is refused with 40001 at the lock and admits later on retry", async () => {
  const holderPurchase = await purchase(env, env.A, "instant-holder");
  const waiterPurchase = await purchase(env, env.B, "instant-waiter");
  const holderJob = await queueJob(env.h, env.A, holderPurchase.authorizationId);
  const waiterJob = await queueJob(env.h, env.B, waiterPurchase.authorizationId);
  const started = barrier();
  const takeLedger = barrier();
  const holderWritten = barrier();
  const commitHolder = barrier();
  let olderStart = "";
  let passedLock = false;
  const waiter = handled(env.h.execution.run(controlOf(env.B.agencyId), async (uow) => {
    olderStart = await uow.executionDiscovery.serverNow();
    started.open();
    await takeLedger.wait;
    await uow.execution.lockGlobalLedger();
    passedLock = true;
  }, { maxRetries: 0 }));
  await Promise.race([started.wait, waiter]);
  const holder = handled(env.h.execution.run(controlOf(env.A.agencyId), async (uow) => {
    await uow.execution.lockGlobalLedger();
    const admitted = await admitLocked(uow, holderJob.jobId);
    holderWritten.open();
    await commitHolder.wait;
    return admitted;
  }, { maxRetries: 2 }));
  try {
    try {
      await Promise.race([holderWritten.wait, holder]);
      takeLedger.open();
      await waitForLockWait(env.h.oracle, "kauro-test-control", LEDGER_LOCK);
    } finally {
      takeLedger.open();
      commitHolder.open();
    }
    await holder;
    await assert.rejects(waiter, (e: unknown) => causeState(e) === "40001",
      "older ledger waiter must be refused with SQLSTATE 40001 (R2-046)");
    assert.equal(passedLock, false, "the old transaction is refused before any admission work");
    await env.h.execution.run(controlOf(env.B.agencyId), async (uow) => {
      await uow.execution.lockGlobalLedger();
      return admitLocked(uow, waiterJob.jobId);
    }, { maxRetries: 2 });
    await assertInstants(holderJob.jobId, waiterJob.jobId, olderStart);
  } finally {
    await Promise.allSettled([holder, waiter]);
    await endJob(env.h, env.A, holderJob.jobId);
    await endJob(env.h, env.B, waiterJob.jobId);
  }
});

test("two schedulers retry an older unit of work and admit strictly in fair order A1, B1, A2", async () => {
  const a1 = await queueJob(env.h, env.A, (await purchase(env, env.A, "fair-a1")).authorizationId);
  const a2 = await queueJob(env.h, env.A, (await purchase(env, env.A, "fair-a2")).authorizationId);
  const b1 = await queueJob(env.h, env.B, (await purchase(env, env.B, "fair-b1")).authorizationId);
  const started = barrier();
  const takeLedger = barrier();
  const holderWritten = barrier();
  const commitHolder = barrier();
  const starts: string[] = [];
  let passedLock = 0;
  const admitFirst = async (uow: ExecutionUnitOfWork, expected: ProcessingJobId) => {
    const first = (await uow.execution.admissionCandidates(10))[0];
    assert.equal(first?.jobId, expected, "the scheduler re-reads the fair candidate order under the ledger");
    return admitLocked(uow, expected);
  };
  const schedulerB = handled(env.h.execution.run(controlOf(env.B.agencyId), async (uow) => {
    starts.push(await uow.executionDiscovery.serverNow());
    started.open();
    await takeLedger.wait;
    await uow.execution.lockGlobalLedger();
    passedLock++;
    return admitFirst(uow, b1.jobId);
  }, { maxRetries: 2 }));
  await Promise.race([started.wait, schedulerB]);
  const schedulerA = handled((async () => {
    const first = await env.h.execution.run(controlOf(env.A.agencyId), async (uow) => {
      await uow.execution.lockGlobalLedger();
      const admitted = await admitFirst(uow, a1.jobId);
      holderWritten.open();
      await commitHolder.wait;
      return admitted;
    }, { maxRetries: 2 });
    // The holder commits before waiting for the other scheduler's admission.
    await schedulerB;
    await assertInstants(a1.jobId, b1.jobId, starts[0]!);
    const second = await env.h.execution.run(controlOf(env.A.agencyId), async (uow) => {
      await uow.execution.lockGlobalLedger();
      return admitFirst(uow, a2.jobId);
    }, { maxRetries: 2 });
    return [first.job.jobId, second.job.jobId];
  })());
  try {
    try {
      await Promise.race([holderWritten.wait, schedulerA]);
      takeLedger.open();
      await waitForLockWait(env.h.oracle, "kauro-test-control", LEDGER_LOCK);
    } finally {
      takeLedger.open();
      commitHolder.open();
    }
    const [a, b] = await Promise.all([schedulerA, schedulerB]);
    assert.deepEqual(a, [a1.jobId, a2.jobId]);
    assert.equal(b.job.jobId, b1.jobId);
    assert.equal(starts.length, 2, "40001 reruns the unit of work once with the bounded retry budget");
    assert.equal(passedLock, 1, "only the fresh transaction reaches admission");
    const [order] = await oracle<{ fair: boolean; fresh: boolean }>(env, `
      SELECT a1.admitted_at < b1.admitted_at AND b1.admitted_at < a2.admitted_at AS fair,
             $4::timestamptz < a1.admitted_at AND $5::timestamptz = b1.admitted_at AS fresh
        FROM kauro.processing_jobs a1 JOIN kauro.processing_jobs b1 ON b1.job_id = $2
        JOIN kauro.processing_jobs a2 ON a2.job_id = $3 WHERE a1.job_id = $1`,
      [a1.jobId, b1.jobId, a2.jobId, starts[0], starts[1]]);
    assert.ok(order?.fair, "admitted_at strictly follows the fair order A1 < B1 < A2");
    assert.ok(order.fresh, "the retry uses a fresh server_now while the original transaction started first");
  } finally {
    await Promise.allSettled([schedulerA, schedulerB]);
    await endJob(env.h, env.A, a1.jobId);
    await endJob(env.h, env.A, a2.jobId);
    await endJob(env.h, env.B, b1.jobId);
  }
});

test("an admission starting after the last admission proceeds without retry", async () => {
  const previous = await queueJob(env.h, env.A, (await purchase(env, env.A, "instant-before-no-retry")).authorizationId);
  const job = await queueJob(env.h, env.A, (await purchase(env, env.A, "instant-no-retry")).authorizationId);
  await admitJob(env.h, env.A, previous.jobId);
  const [last] = await oracle<{ at: string }>(env, "SELECT last_admission_at::text AS at FROM kauro.execution_capacity WHERE ledger_id = 1");
  assert.ok(last?.at, "a previous admission is committed");
  let calls = 0;
  try {
    const admitted = await env.h.execution.run(controlOf(env.A.agencyId), async (uow) => {
      calls++;
      const start = await uow.executionDiscovery.serverNow();
      const [order] = await oracle<{ later: boolean }>(env, "SELECT $1::timestamptz > $2::timestamptz AS later", [start, last.at]);
      assert.ok(order?.later, "the new transaction starts strictly after the last admission");
      await uow.execution.lockGlobalLedger();
      return admitLocked(uow, job.jobId);
    }, { maxRetries: 2 });
    assert.equal(calls, 1, "a fresh transaction does not spend its retry budget");
    assert.equal(admitted.job.jobId, job.jobId);
  } finally {
    await endJob(env.h, env.A, job.jobId);
    await endJob(env.h, env.A, previous.jobId);
  }
});

test("the ledger lock refuses the same clock tick and exposes EXECUTE only to control", async () => {
  // a real admission sets the platform's last admission; a later transaction whose labelled test clock reads exactly that
  // instant (the same clock tick on a ms-granular runner) is refused at the lock
  const p = await purchase(env, env.A, "instant-same-tick");
  const job = await queueJob(env.h, env.A, p.authorizationId);
  await admitJob(env.h, env.A, job.jobId);
  try {
    const [last] = await oracle<{ at: string }>(env, "SELECT last_admission_at::text AS at FROM kauro.execution_capacity WHERE ledger_id = 1");
    assert.ok(last?.at, "the admission recorded the platform's last admission");
    await refusedTransaction(env.control, service(env.A.agencyId), async (c) => {
      await c.query("SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)", [last.at]);
      await c.query("SELECT kauro.lock_execution_ledger()");
    }, "40001", "R2-046 also refuses a transaction at the same clock tick");
    // the column itself: no runtime role writes it directly, neither forward-blocking nor switching the check off
    for (const value of ["'infinity'::timestamptz", "NULL", "kauro.server_now()"]) {
      await refusedTransaction(env.control, service(env.A.agencyId), async (c) => {
        await c.query(`UPDATE kauro.execution_capacity SET last_admission_at = ${value} WHERE ledger_id = 1`);
      }, "KA082", `a direct write of last_admission_at = ${value} is refused`);
    }
    // depth is no provenance: a pg_temp trigger (one level deeper) still cannot write a future instant or move an agency ahead
    await refusedTransaction(env.control, service(env.A.agencyId), async (c) => {
      await c.query(`CREATE FUNCTION pg_temp.stamp() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        UPDATE kauro.execution_capacity SET last_admission_at = 'infinity' WHERE ledger_id = 1; RETURN NULL; END $f$`);
      await c.query("CREATE TEMP TABLE stamp_probe (x int) ON COMMIT DROP");
      await c.query("CREATE TRIGGER stamp_probe AFTER INSERT ON stamp_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.stamp()");
      await c.query("INSERT INTO stamp_probe VALUES (1)");
    }, "KA082", "a nested (depth 2) write of a future last_admission_at is refused");
    await refusedTransaction(env.control, service(env.A.agencyId), async (c) => {
      await c.query(`CREATE FUNCTION pg_temp.ahead() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        UPDATE kauro.agency_execution_capacity SET last_admitted_at = now() - interval '1 year' WHERE agency_id = '${env.A.agencyId}'; RETURN NULL; END $f$`);
      await c.query("CREATE TEMP TABLE ahead_probe (x int) ON COMMIT DROP");
      await c.query("CREATE TRIGGER ahead_probe AFTER INSERT ON ahead_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.ahead()");
      await c.query("INSERT INTO ahead_probe VALUES (1)");
    }, "KA082", "a nested (depth 2) write moving an agency ahead in the fair order is refused");
    // ... nor, without admitting one of its jobs, push an agency back to "now" (starvation of a competitor; A has a ledger row from
    // the admission above, an UPDATE of a row-less agency would be vacuous) or stamp the platform "now"
    for (const [name, sql] of [
      ["demote", `UPDATE kauro.agency_execution_capacity SET last_admitted_at = kauro.server_now() WHERE agency_id = '${env.A.agencyId}'`],
      ["platform", "UPDATE kauro.execution_capacity SET last_admission_at = kauro.server_now() WHERE ledger_id = 1"],
    ] as const) {
      await refusedTransaction(env.control, service(env.A.agencyId), async (c) => {
        await c.query(`CREATE FUNCTION pg_temp.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${sql}; RETURN NULL; END $f$`);
        await c.query(`CREATE TEMP TABLE ${name}_probe (x int) ON COMMIT DROP`);
        await c.query(`CREATE TRIGGER ${name}_probe AFTER INSERT ON ${name}_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.${name}()`);
        await c.query(`INSERT INTO ${name}_probe VALUES (1)`);
      }, "KA082", `a nested "now" stamp with no admission in the transaction is refused (${name})`);
    }
  } finally {
    await endJob(env.h, env.A, job.jobId);
  }
  const roles = await oracle<{ rolname: string; allowed: boolean }>(env, `
    SELECT rolname, has_function_privilege(oid, 'kauro.lock_execution_ledger()', 'EXECUTE') AS allowed
      FROM pg_roles WHERE rolname IN ('kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator',
        'kauro_ingress', 'kauro_payment', 'kauro_commission') ORDER BY rolname`);
  assert.equal(roles.length, 7);
  for (const role of roles) assert.equal(role.allowed, role.rolname === "kauro_control", role.rolname);
  const [fn] = await oracle<{ invoker: boolean; path: string[]; override_absent: boolean }>(env, `
    SELECT NOT prosecdef AS invoker, proconfig AS path, to_regprocedure('kauro.admission_now()') IS NULL AS override_absent
      FROM pg_proc WHERE oid = 'kauro.lock_execution_ledger()'::regprocedure`);
  assert.deepEqual(fn, { invoker: true, path: ["search_path=pg_catalog"], override_absent: true });
});

test("the consumption guard refuses admission evidence from a different transaction (KA081)", async () => {
  const p = await purchase(env, env.A, "instant-cross-transaction");
  const job = await queueJob(env.h, env.A, p.authorizationId);
  await admitJob(env.h, env.A, job.jobId);
  try {
    // Invoke the actual deferred guard functions as the runtime role against the
    // committed rows copied into temporary probes. This isolates the temporal
    // proof from immutability/event guards, without disabling any production guard.
    for (const [table, guard, idColumn, id] of [
      ["commercial_authorizations", "commercial_authorizations_consumption_bound", "authorization_id", p.authorizationId],
      // processing_jobs_admission_bound proves the PAIR (a CONSUMED authorization naming the job at the same instant); the
      // same-transaction half of the proof is the consumption guard above (admitted_at = server_now()), so the job-side guard
      // alone is not expected to refuse committed rows replayed in another transaction.
    ] as const) {
      await refusedTransaction(env.control, service(env.A.agencyId), async (c) => {
        await c.query(`CREATE TEMP TABLE admission_probe (LIKE kauro.${table}) ON COMMIT DROP`);
        await c.query(`CREATE CONSTRAINT TRIGGER admission_probe_guard AFTER INSERT ON admission_probe
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.${guard}()`);
        await c.query(`INSERT INTO admission_probe SELECT * FROM kauro.${table} WHERE ${idColumn} = $1`, [id]);
      }, "KA081", `${guard} refuses an admission recorded in a different transaction`);
    }
  } finally {
    await endJob(env.h, env.A, job.jobId);
  }
});

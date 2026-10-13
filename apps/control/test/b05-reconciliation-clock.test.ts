// B05 lane L3t, L19b (RCK; docs/design/B05-cores.md D5-20, J15; migration 0062 provisional): GRANT_RECONCILIATION reads its instant
// at the start of its transaction (grants.ts serverNow), so an EXHAUSTED grant with room whose pass waited on a request row across the
// grant's expiry is re-AUTHORIZED on that early instant; 0062's commit-time judgement of 0023:178 refuses the pass at COMMIT (KA083),
// the whole pass rolls back, SweepRun records the failure, and the next pass moves the grant EXPIRED. Every interleaving is fixed by a
// FaultPoint and the reconciler's lock wait observed in pg_stat_activity (waitForLockWait), never by a sleep; time is the labelled TEST
// CLOCK of the control plane's units, one offset for every unit.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Id } from "@kauro/contracts";
import { centsOfMicros, type AgencyId, type AuditId, type AuditStepId, type AuditUnitOfWork, type CoreAdmission, type CorrelationId, type LeaseOwnerId, type ModelTaskId, type RequestId, type SystemContext } from "@kauro/domain";
import { FaultPoints, crashableFactory, crashedAt, fundPlatformPool, waitForLockWait, type AgencyFixture } from "@kauro/persistence/testing";
import type { GrantReconciliation } from "../src/audit/grants.js";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { ids, sha, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;
let funding: Awaited<ReturnType<ExecutionWorld["h"]["pg"]["connect"]>>;

before(async () => {
  w = await startExecutionWorld("b05-recon-clock");
  a = await openAuditWorld(w);
  funding = await w.h.pg.connect("kauro_control_test");
});

after(async () => {
  await funding.end();
  await w.stop();
});

const CONTROL_APP = "kauro-test-control";
/** The head of the reconciler's grantUsage read (discovery.ts; pg_stat_activity keeps only the first 1 kB of a query). */
const GRANT_USAGE = "SELECT r.request_id, r.fence::text AS fence";

interface Run {
  readonly ag: AgencyFixture;
  readonly auditId: string;
  readonly grantId: string;
  readonly stepFence: number;
  readonly owner: LeaseOwnerId;
  readonly manifest: string;
  readonly deadline: string;
}

/** One audit INTERPRETING (AUDIT_ORCHESTRATION's PROFILE over the labelled fakes) with its INTERPRET step claimed, funded from `pool`. */
async function interpreting(label: string, pool: string): Promise<Run> {
  const ag = await w.agency(label);
  const subject = await w.subject(ag, label);
  const started = await a.start(subject);
  assert.equal(started.pool.grantId, pool, "the scenario's pool funds the audit (the earliest expiry)");
  const auditId = started.audit.auditId as string;
  assert.deepEqual(await w.redeliver(w.x.consumers.auditOrchestration, await w.eventOf(auditId, "audit.queued.v1")), { kind: "DONE" });
  const row = await a.audit(auditId);
  assert.equal(row.state, "INTERPRETING");
  assert.ok(row.candidate_manifest_hash !== null && row.interpretation_deadline_at !== null);
  const step = await a.control(ag.agencyId, (uow) => uow.audits.claimStep(auditId as AuditId, "INTERPRET", ids.next() as AuditStepId));
  return { ag, auditId, grantId: started.grant.grantId as string, stepFence: step.step.fence, owner: step.step.stepId as string as LeaseOwnerId, manifest: row.candidate_manifest_hash, deadline: row.interpretation_deadline_at };
}

interface Adm {
  readonly run: Run;
  readonly requestId: RequestId;
  readonly taskId: ModelTaskId;
  readonly core: CoreAdmission;
}

let reservationSeq = 0;
/** One core admission of the run (createModelTask, then beginDispatch with the core's run, reservation and maximum). */
async function admit(run: Run, maxChargeMicros: bigint): Promise<Adm> {
  reservationSeq += 1;
  const x: Adm = {
    run,
    requestId: ids.next() as RequestId,
    taskId: ids.next() as ModelTaskId,
    core: { runId: run.auditId as Id, reservationId: `rck-${reservationSeq}`, requestKey: sha(`rck-key-${reservationSeq}-${run.auditId}`), maxChargeMicros },
  };
  const out = await a.control(run.ag.agencyId, async (uow: AuditUnitOfWork) => {
    await uow.audits.createModelTask({
      modelTaskId: x.taskId,
      auditId: run.auditId as AuditId,
      stepFence: run.stepFence,
      taskKey: sha(`task-${x.core.reservationId}`),
      candidateManifestHash: run.manifest as never,
      policyHash: sha("model-policy"),
      minimizedRequestHash: sha(`request-${x.core.reservationId}`),
      core: { runId: x.core.runId, requestKey: x.core.requestKey },
      providerProfileId: ids.next() as Id,
      maximumCostCents: 40n,
    });
    return uow.audits.beginDispatch(x.taskId, { requestId: x.requestId, ownerId: run.owner, requestHash: sha(`request-${x.core.reservationId}`), reservedCents: centsOfMicros(maxChargeMicros), stepFence: run.stepFence, core: x.core });
  });
  assert.deepEqual(out.kind === "RESERVED" ? [out.kind, out.request.fence] : [out.kind], ["RESERVED", 1]);
  return x;
}

/** The SYSTEM context the Intelligence core adapter's stand-in runs in (audit-world.ts control). */
const adapterContext = (agencyId: string): SystemContext => ({ kind: "SYSTEM", serviceId: "audit-orchestration", correlationId: ids.next() as CorrelationId, agencyId: agencyId as AgencyId }) as SystemContext;

const sweep = () => (w.x.sweepers.grantReconciliation as GrantReconciliation).sweep(w.units, 50);

async function grantOf(grantId: string): Promise<{ state: string; reserved: number; spent: number; version: string }> {
  const g = await a.grant(grantId);
  return { state: g.state, reserved: g.reserved, spent: g.spent, version: g.version };
}
async function requestOf(x: Adm): Promise<[string, string, number | null]> {
  const r = await w.h.oracle.query("SELECT state, usage_state, actual_cents::int AS actual FROM kauro.request_journal WHERE request_id = $1", [x.requestId]);
  return [r.rows[0].state, r.rows[0].usage_state, r.rows[0].actual];
}
const liabilityCount = async (grantId: string): Promise<number> =>
  (await w.h.oracle.query("SELECT count(*)::int AS n FROM kauro.dispatch_liabilities l JOIN kauro.request_journal r ON r.request_id = l.request_id WHERE r.cost_grant_id = $1", [grantId])).rows[0].n;

const offsetBefore = (instant: string, beforeSeconds: number): number => Math.floor((Date.parse(instant) - Date.now()) / 1000) - beforeSeconds;
const standAt = (offset: number): void => w.advance(offset - w.units.offsetSeconds);

test("L19b (RCK) RACE (reconciliation clock, EXHAUSTED grant, one test-clock offset): an EXHAUSTED AUDIT grant with room whose GRANT_RECONCILIATION pass read its instant (grants.ts:67) before a request-row wait that crossed the grant's expiry moves EXHAUSTED -> AUTHORIZED on the early instant and is refused KA083 at COMMIT by the commit-time re-judgement of 0023:178: the whole pass rolls back (no release, no posting, no liability; reserved cents, spend and the grant's version unchanged) and is recorded as a sweep failure; the next pass moves the grant EXPIRED and posts the stored request's spend exactly once", async () => {
  // a pool ending inside the interpretation window caps the AUDIT grant's expiry (StartAudit), so the grant expires while its audit
  // still interprets and its lease is live
  const r = await w.h.oracle.query<{ s: number | null }>("SELECT extract(epoch FROM min(expires_at) - kauro.server_now())::float8 AS s FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED' AND expires_at > kauro.server_now()");
  assert.ok(r.rows[0]?.s === null || (r.rows[0]?.s ?? 0) > 900, "a 900 s pool is the earliest");
  const pool = await fundPlatformPool(funding, { ceilingCents: 5_000n, expiresInSeconds: 900 });
  const run = await interpreting("l19b", pool);
  const expiresAt = (await a.grant(run.grantId)).expires_at;
  assert.ok(Date.parse(expiresAt) < Date.parse(run.deadline), "the grant expires before the interpretation deadline");
  try {
    // one offset K for every unit: twelve seconds before the grant's expiry
    const K = offsetBefore(expiresAt, 12);
    standAt(K);
    // the grant's ceiling (150 cents) reserved whole: p (40, sent), three fillers (40, 40, 25) and q (5)
    const p = await admit(run, 400_000n);
    const sent = await a.control(run.ag.agencyId, (uow) => uow.requestJournal.markDispatching(p.requestId, 1, "provider-l19b-p", w.now()));
    assert.equal(sent?.state, "DISPATCHING");
    for (const micros of [400_000n, 400_000n, 250_000n]) await admit(run, micros);
    const q = await admit(run, 50_000n);
    // pass 0: the grant is full: EXHAUSTED
    assert.deepEqual((await sweep()).failed.filter((f) => f.subject === run.grantId), []);
    const exhausted = await grantOf(run.grantId);
    assert.deepEqual([exhausted.state, exhausted.reserved, exhausted.spent], ["EXHAUSTED", 150, 0]);
    // p's stored response of known usage (3 of 40 cents) makes the grant due, with room once it is posted
    await a.control(run.ag.agencyId, (uow) => uow.requestJournal.storeResponse(p.requestId, 1, sha("l19b-p"), { usageState: "KNOWN", actualCents: "3" as never }, w.now()));
    // H: the edge on q, its row held at a FaultPoint before COMMIT across the expiry, then crashed (q stays RESERVED)
    const points = new FaultPoints();
    const pause = points.pause("l19b-edge.before-commit");
    const edge = crashableFactory(w.units, points, "l19b-edge").run(adapterContext(run.ag.agencyId), (uow) => uow.requestJournal.markDispatching(q.requestId, 1, "provider-l19b-q", w.now()));
    await pause.reachedBy(edge);
    // R: the reconciler locks the grant, reads its instant, then waits on q's row (grantUsage FOR UPDATE OF r)
    const pass1 = sweep();
    await waitForLockWait(w.h.oracle, CONTROL_APP, GRANT_USAGE);
    // the shifted database clock passes the expiry while R waits: wait the measured remainder (at most the 12 s of K), then check
    const remainder = (await w.h.oracle.query<{ ms: number }>("SELECT extract(epoch FROM ($2::timestamptz + interval '250 milliseconds') - (clock_timestamp() + make_interval(secs => $1))) * 1000 AS ms", [K, expiresAt])).rows[0]!.ms;
    assert.ok(remainder <= 13_250, `the expiry is at most K's 12 s ahead (${remainder} ms)`);
    await new Promise((res) => setTimeout(res, Math.max(0, Math.ceil(remainder))));
    for (let i = 0; ; i++) {
      const past = (await w.h.oracle.query("SELECT clock_timestamp() + make_interval(secs => $1) >= $2::timestamptz + interval '250 milliseconds' AS past", [K, expiresAt])).rows[0].past;
      if (past === true) break;
      assert.ok(i < 40, "the shifted clock reaches the expiry");
      await new Promise((res) => setTimeout(res, 25));
    }
    pause.crash();
    await assert.rejects(edge, crashedAt("l19b-edge.before-commit"));
    const failed = (await pass1).failed.filter((f) => f.subject === run.grantId);
    assert.equal(failed.length, 1, `pass 1 is recorded as a sweep failure (${JSON.stringify((await sweepFailures(failed)))})`);
    assert.deepEqual(await grantOf(run.grantId), exhausted, "pass 1 rolled back whole: EXHAUSTED, reserved, spend and version unchanged");
    assert.deepEqual(await requestOf(p), ["RESPONSE_STORED", "KNOWN", 3], "p not posted");
    assert.deepEqual(await requestOf(q), ["RESERVED", "UNKNOWN", null], "the crashed edge sent nothing");
    assert.equal(await liabilityCount(run.grantId), 0, "no liability");
    // pass 2, a fresh transaction after the expiry: EXPIRED, p posted once
    assert.deepEqual((await sweep()).failed.filter((f) => f.subject === run.grantId), []);
    const expired = await grantOf(run.grantId);
    assert.deepEqual([expired.state, expired.reserved, expired.spent], ["EXPIRED", 110, 3], "pass 2: EXPIRED, p posted once");
    assert.deepEqual(await requestOf(p), ["RESPONSE_STORED", "RECONCILED", 3]);
    // a third pass posts nothing again
    assert.deepEqual((await sweep()).failed.filter((f) => f.subject === run.grantId), []);
    const again = await grantOf(run.grantId);
    assert.deepEqual([again.state, again.reserved, again.spent], ["EXPIRED", 110, 3], "p posted exactly once");
    assert.equal(await liabilityCount(run.grantId), 0, "no liability");
  } finally {
    standAt(0);
  }
});

/** The recorded failures' printable form (a diagnostic of the assertion only). */
async function sweepFailures(failed: ReadonlyArray<unknown>): Promise<unknown> {
  return failed.map((f) => (typeof f === "object" && f !== null ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])) : f));
}

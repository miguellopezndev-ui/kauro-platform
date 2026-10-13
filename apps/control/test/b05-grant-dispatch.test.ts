// B05 dispatch settlement under GRANT_RECONCILIATION (lane L3m, GDR titles; docs/design/B05-cores.md D5-18 branches (a) and (b),
// D5-19, D5-20, LOCK-B05-1; migration 0061 provisional): the sweeper of this package against the core admissions the Intelligence
// core adapter's beginDispatch writes, IC's settlement (settleDispatch) and the journal's edges, on real PostgreSQL 17 through the
// control plane's own units. Every interleaving is fixed by a hold inside a unit of work (or a FaultPoint) and the other side's lock
// wait observed in pg_stat_activity (waitForLockWait), never by a sleep. Time is the labelled TEST CLOCK of the control plane's units.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Id } from "@kauro/contracts";
import {
  centsOfMicros,
  type AgencyId,
  type AuditId,
  type AuditStepId,
  type AuditUnitOfWork,
  type CoreAdmission,
  type CorrelationId,
  type LeaseOwnerId,
  type ModelTaskId,
  type RequestId,
  type SystemContext,
} from "@kauro/domain";
import { FaultPoints, crashableFactory, crashedAt, fundPlatformPool, waitForLockWait, type AgencyFixture } from "@kauro/persistence/testing";
import { GrantReconciliation } from "../src/audit/grants.js";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { heldAuditUnits, ids, sha, startExecutionWorld, type AuditSubject, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;
let funding: Awaited<ReturnType<ExecutionWorld["h"]["pg"]["connect"]>>;

before(async () => {
  w = await startExecutionWorld("b05-grants");
  a = await openAuditWorld(w);
  funding = await w.h.pg.connect("kauro_control_test");
});

after(async () => {
  await funding.end();
  await w.stop();
});

const CONTROL_APP = "kauro-test-control";
/** The head of the reconciler's grantUsage read (discovery.ts; pg_stat_activity keeps only the first 1 kB of a query, not its FOR UPDATE OF r). */
const GRANT_USAGE = "SELECT r.request_id, r.fence::text AS fence";
const EVIDENCE = "PROVIDER_DOCUMENTED_NON_ACCEPTANCE:ThrottlingException" as const;

/** A platform pool expiring before every AUTHORIZED unexpired one, so the next StartAudit draws on it (an hour less each time). */
let poolSeq = 0;
async function freshPool(ceilingCents = 5_000n, expiresInSeconds?: number): Promise<string> {
  poolSeq += 1;
  const r = await w.h.oracle.query<{ s: number | null }>(
    "SELECT extract(epoch FROM min(expires_at) - kauro.server_now())::float8 AS s FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED' AND expires_at > kauro.server_now()",
  );
  const earliest = r.rows[0]?.s ?? null;
  const seconds = expiresInSeconds ?? Math.min(20 * 86_400 - poolSeq * 3_600, earliest === null ? Infinity : Math.floor(earliest) - 60);
  assert.ok(seconds > 60 && (earliest === null || seconds < earliest), `a pool expiring in ${seconds} s is the earliest (${earliest})`);
  return fundPlatformPool(funding, { ceilingCents, expiresInSeconds: seconds });
}

/** One audit INTERPRETING (AUDIT_ORCHESTRATION's PROFILE over the labelled fakes) with its INTERPRET step claimed. */
interface Run {
  readonly ag: AgencyFixture;
  readonly subject: AuditSubject;
  readonly auditId: string;
  readonly grantId: string;
  readonly stepFence: number;
  readonly owner: LeaseOwnerId;
  readonly manifest: string;
  readonly deadline: string;
}

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
  return { ag, subject, auditId, grantId: started.grant.grantId as string, stepFence: step.step.fence, owner: step.step.stepId as string as LeaseOwnerId, manifest: row.candidate_manifest_hash, deadline: row.interpretation_deadline_at };
}

/** One core admission of the run (createModelTask, then beginDispatch with the core's run, reservation and maximum). */
interface Adm {
  readonly run: Run;
  readonly requestId: RequestId;
  readonly taskId: ModelTaskId;
  readonly core: CoreAdmission;
}

let reservationSeq = 0;
function admissionOf(run: Run, maxChargeMicros: bigint): Adm {
  reservationSeq += 1;
  return {
    run,
    requestId: ids.next() as RequestId,
    taskId: ids.next() as ModelTaskId,
    core: { runId: run.auditId as Id, reservationId: `gdr-${reservationSeq}`, requestKey: sha(`gdr-key-${reservationSeq}-${run.auditId}`), maxChargeMicros },
  };
}

function admitIn(uow: AuditUnitOfWork, x: Adm) {
  return (async () => {
    await uow.audits.createModelTask({
      modelTaskId: x.taskId,
      auditId: x.run.auditId as AuditId,
      stepFence: x.run.stepFence,
      taskKey: sha(`task-${x.core.reservationId}`),
      candidateManifestHash: x.run.manifest as never,
      policyHash: sha("model-policy"),
      minimizedRequestHash: sha(`minimized-${x.core.reservationId}`),
      providerProfileId: ids.next() as Id,
      maximumCostCents: 40n,
    });
    return uow.audits.beginDispatch(x.taskId, { requestId: x.requestId, ownerId: x.run.owner, requestHash: sha(`request-${x.core.reservationId}`), reservedCents: centsOfMicros(x.core.maxChargeMicros), stepFence: x.run.stepFence, core: x.core });
  })();
}

async function admit(run: Run, maxChargeMicros: bigint): Promise<Adm> {
  const x = admissionOf(run, maxChargeMicros);
  const out = await a.control(run.ag.agencyId, (uow) => admitIn(uow, x));
  assert.deepEqual(out.kind === "RESERVED" ? [out.kind, out.request.fence] : [out.kind], ["RESERVED", 1]);
  return x;
}

/** The SYSTEM context the Intelligence core adapter's stand-in runs in (audit-world.ts control). */
const adapterContext = (agencyId: string): SystemContext => ({ kind: "SYSTEM", serviceId: "audit-orchestration", correlationId: ids.next() as CorrelationId, agencyId: agencyId as AgencyId }) as SystemContext;

const settlementOf = (x: Adm, state: "COMMITTED" | "AMBIGUOUS" | "RELEASED", chargeMicros: bigint, usageKnown = true) => ({ runId: x.core.runId, reservationId: x.core.reservationId, state, chargeMicros, usageKnown }) as const;
const settle = (x: Adm, state: "COMMITTED" | "AMBIGUOUS" | "RELEASED", chargeMicros: bigint) => a.control(x.run.ag.agencyId, (uow) => uow.audits.settleDispatch(settlementOf(x, state, chargeMicros)));
const dispatch = async (x: Adm): Promise<void> => {
  const r = await a.control(x.run.ag.agencyId, (uow) => uow.requestJournal.markDispatching(x.requestId, 1, `provider-${x.core.reservationId}`, w.now()));
  assert.equal(r?.state, "DISPATCHING");
};

/** One GRANT_RECONCILIATION run of the plane (every grant due). */
async function sweep(recon: GrantReconciliation = w.x.sweepers.grantReconciliation as GrantReconciliation) {
  return recon.sweep(w.units, 50);
}
/** A GRANT_RECONCILIATION of its own over other units (held or crashable), the plane's dependencies otherwise. */
const reconOn = (units: object) => new GrantReconciliation({ units: units as never, ids, retryAfterSeconds: 30 });

async function money(grantId: string): Promise<[string, number, number]> {
  const g = await a.grant(grantId);
  return [g.state, g.reserved, g.spent];
}
async function request(x: Adm): Promise<[string, string, number | null, string | null]> {
  const r = await w.h.oracle.query("SELECT state, usage_state, actual_cents::int AS actual, settlement_state FROM kauro.request_journal WHERE request_id = $1", [x.requestId]);
  assert.ok(r.rows[0], `request ${x.requestId}`);
  return [r.rows[0].state, r.rows[0].usage_state, r.rows[0].actual, r.rows[0].settlement_state];
}
const grantVersion = async (grantId: string): Promise<string> => (await a.grant(grantId)).version;

/** A unit of the adapter's stand-in held open after `work` (its locks and writes stand, uncommitted) until released or crashed. */
function heldUnit<T>(agencyId: string, work: (uow: AuditUnitOfWork) => Promise<T>): { readonly reached: Promise<void>; readonly done: Promise<T>; release(): void; crash(): void } {
  let signal: () => void = () => undefined;
  let release: () => void = () => undefined;
  let crash: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (signal = resolve));
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    crash = () => reject(new Error("SimulatedCrash: held unit"));
  });
  const done = w.units.run(adapterContext(agencyId), async (uow) => {
    const out = await work(uow);
    signal();
    await gate;
    return out;
  });
  done.catch(() => undefined);
  return { reached, done, release, crash };
}

/** The TEST CLOCK offset (whole seconds) that stands the control plane's units `beforeSeconds` before `instant`. */
const offsetBefore = (instant: string, beforeSeconds: number): number => Math.floor((Date.parse(instant) - Date.now()) / 1000) - beforeSeconds;
const standAt = (offset: number): void => w.advance(offset - w.units.offsetSeconds);

test("S13 (GDR) RACE (crash after markFailed with evidence, both orders): with IC's RELEASED lost, GRANT_RECONCILIATION releases a FAILED request carrying non-acceptance evidence at 0 under the grant then request locks; IC's late RELEASED is a replay; spend and reserved cents equal the hand-computed values", async () => {
  const pool = await freshPool();
  /** An admission of 24.5 cents (25 reserved) sent and failed with provider evidence, the unit's acknowledgement lost after COMMIT. */
  const failedWithEvidence = async (label: string): Promise<Adm> => {
    const run = await interpreting(label, pool);
    const x = await admit(run, 245_000n);
    await dispatch(x);
    const points = new FaultPoints();
    points.crash(`${label}.after-commit`);
    await assert.rejects(
      crashableFactory(w.units, points, label).run(adapterContext(run.ag.agencyId), (uow) => uow.requestJournal.markFailed(x.requestId, 1, w.now(), EVIDENCE)),
      crashedAt(`${label}.after-commit`),
    );
    assert.deepEqual(await request(x), ["FAILED", "UNKNOWN", null, null], "committed, IC's settlement never sent");
    assert.deepEqual(await money(run.grantId), ["AUTHORIZED", 25, 0]);
    return x;
  };
  // the sweep first: released at 0; IC's late RELEASED is a replay
  {
    const x = await failedWithEvidence("s13-sweep-first");
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual(await request(x), ["FAILED", "RECONCILED", 0, "RELEASED"]);
    assert.deepEqual(await money(x.run.grantId), ["AUTHORIZED", 0, 0], "25 reserved, 0 spent: released whole");
    const version = await grantVersion(x.run.grantId);
    const late = await settle(x, "RELEASED", 0n);
    assert.equal(late.kind, "REPLAYED");
    assert.deepEqual([await money(x.run.grantId), await grantVersion(x.run.grantId)], [["AUTHORIZED", 0, 0], version], "the replay moves no cent");
  }
  // IC first: its RELEASED settles; the sweep then finds nothing to release
  {
    const x = await failedWithEvidence("s13-ic-first");
    assert.equal((await settle(x, "RELEASED", 0n)).kind, "RECORDED");
    assert.deepEqual(await money(x.run.grantId), ["AUTHORIZED", 0, 0]);
    const version = await grantVersion(x.run.grantId);
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual(await request(x), ["FAILED", "RECONCILED", 0, "RELEASED"]);
    assert.deepEqual([await money(x.run.grantId), await grantVersion(x.run.grantId)], [["AUTHORIZED", 0, 0], version]);
  }
  // concurrent, the sweep's release held after its grant and request locks: IC's RELEASED waits on the grant, then replays
  {
    const x = await failedWithEvidence("s13-sweep-holds");
    const held = heldAuditUnits(w.units, "releaseNonAccepted", "AFTER");
    const sweeping = sweep(reconOn(held.units));
    await held.hold.reached;
    const ic = settle(x, "RELEASED", 0n);
    ic.catch(() => undefined);
    await waitForLockWait(w.h.oracle, CONTROL_APP, "FOR UPDATE");
    held.hold.release();
    assert.deepEqual((await sweeping).failed, []);
    assert.equal((await ic).kind, "REPLAYED", "IC's RELEASED after the release is a replay");
    assert.deepEqual(await money(x.run.grantId), ["AUTHORIZED", 0, 0]);
  }
  // concurrent, IC's RELEASED held after its grant and request locks: the sweep's grant lock waits, then nothing is left to release
  {
    const x = await failedWithEvidence("s13-ic-holds");
    const ic = heldUnit(x.run.ag.agencyId, (uow) => uow.audits.settleDispatch(settlementOf(x, "RELEASED", 0n)));
    await ic.reached;
    const sweeping = sweep();
    await waitForLockWait(w.h.oracle, CONTROL_APP, "FOR UPDATE");
    ic.release();
    assert.equal((await ic.done).kind, "RECORDED");
    assert.deepEqual((await sweeping).failed, []);
    assert.deepEqual(await request(x), ["FAILED", "RECONCILED", 0, "RELEASED"]);
    assert.deepEqual(await money(x.run.grantId), ["AUTHORIZED", 0, 0], "one release, nothing posted");
  }
});

test("S14 (GDR) RACE (crash after the DISPATCHING commit): GRANT_RECONCILIATION moves a DISPATCHING request whose fence moved, audit stopped interpreting or interpretation deadline passed to UNCERTAIN with its reservation held, never a live owner's in-time request; a storeResponse and that move serialize on the request row in both orders and the response lands", async () => {
  const pool = await freshPool();
  /** An admission sent, the edge's acknowledgement lost after its COMMIT (the owner never learns it was sent). */
  const sentAndLost = async (run: Run, label: string): Promise<Adm> => {
    const x = await admit(run, 245_000n);
    const points = new FaultPoints();
    points.crash(`${label}.after-commit`);
    await assert.rejects(
      crashableFactory(w.units, points, label).run(adapterContext(run.ag.agencyId), (uow) => uow.requestJournal.markDispatching(x.requestId, 1, `provider-${label}`, w.now())),
      crashedAt(`${label}.after-commit`),
    );
    assert.deepEqual(await request(x), ["DISPATCHING", "UNKNOWN", null, null]);
    return x;
  };
  try {
    // a live owner's in-time request is never moved (its audit interprets, its lease at its fence, before the deadline)
    const liveRun = await interpreting("s14-live", pool);
    const live = await sentAndLost(liveRun, "s14-live");
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual(await request(live), ["DISPATCHING", "UNKNOWN", null, null], "a live owner's in-time request");
    // the audit stopped interpreting
    const cancelledRun = await interpreting("s14-cancelled", pool);
    const cancelled = await sentAndLost(cancelledRun, "s14-cancelled");
    await a.cancel(cancelledRun.subject, cancelledRun.auditId);
    // the reconciler's unit of the grant crashes before its COMMIT: DISPATCHING stays; the next run repeats the move
    {
      const points = new FaultPoints();
      points.crash("s14-rec.before-commit");
      await assert.rejects(reconOn(crashableFactory(w.units, points, "s14-rec")).reconcile({ grantId: cancelledRun.grantId as never, agencyId: cancelledRun.ag.agencyId as AgencyId }), (e: unknown) => /s14-rec\.before-commit/.test(String((e as { cause?: unknown }).cause ?? e)));
      assert.deepEqual(await request(cancelled), ["DISPATCHING", "UNKNOWN", null, null], "crash before COMMIT: nothing moved");
    }
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual(await request(cancelled), ["UNCERTAIN", "UNKNOWN", null, null], "audit no longer interpreting");
    assert.deepEqual(await money(cancelledRun.grantId), ["AUTHORIZED", 25, 0], "the reservation held for provider evidence");
    const second = await grantVersion(cancelledRun.grantId);
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual([await request(cancelled), await grantVersion(cancelledRun.grantId)], [["UNCERTAIN", "UNKNOWN", null, null], second], "a second pass changes nothing");
    // the lease's fence moved: the lease expired and another owner took the task over (fence 2, its own intent)
    const movedRun = await interpreting("s14-moved", pool);
    const moved = await sentAndLost(movedRun, "s14-moved");
    standAt(130);
    const takeover = await a.control(movedRun.ag.agencyId, async (uow) =>
      uow.audits.beginDispatch(moved.taskId, { requestId: ids.next() as RequestId, ownerId: ids.next() as LeaseOwnerId, requestHash: sha("s14-takeover"), reservedCents: 10n, stepFence: movedRun.stepFence, core: { ...admissionOf(movedRun, 100_000n).core } }),
    );
    assert.deepEqual(takeover.kind === "RESERVED" ? [takeover.kind, takeover.request.fence] : [takeover.kind], ["RESERVED", 2]);
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual(await request(moved), ["UNCERTAIN", "UNKNOWN", null, null], "the fence moved");
    assert.deepEqual(await money(movedRun.grantId), ["AUTHORIZED", 35, 0], "25 held for the lost send, 10 for the new owner's intent");
    assert.deepEqual(await request(live), ["DISPATCHING", "UNKNOWN", null, null], "the live owner's lease expired but stands at its fence: not moved");
    // the interpretation deadline passed (on the server clock)
    standAt(offsetBefore(liveRun.deadline, -30));
    assert.deepEqual((await sweep()).failed, []);
    assert.deepEqual(await request(live), ["UNCERTAIN", "UNKNOWN", null, null], "the interpretation deadline passed");
    assert.deepEqual(await money(liveRun.grantId), ["AUTHORIZED", 25, 0]);
    standAt(0);
    // a storeResponse and the move serialize on the request row, both orders; the response lands
    for (const first of ["MOVE", "RESPONSE"] as const) {
      const run = await interpreting(`s14-${first.toLowerCase()}`, pool);
      const x = await sentAndLost(run, `s14-${first.toLowerCase()}-sent`);
      await a.cancel(run.subject, run.auditId);
      const respond = (uow: AuditUnitOfWork) => uow.requestJournal.storeResponse(x.requestId, 1, sha(`s14-response-${first}`), { usageState: "KNOWN", actualCents: "20" as never }, w.now());
      if (first === "MOVE") {
            const held = heldAuditUnits(w.units, "markStaleDispatchUncertain", "AFTER");
        const sweeping = sweep(reconOn(held.units));
        await held.hold.reached;
        const response = a.control(run.ag.agencyId, respond);
        response.catch(() => undefined);
        await waitForLockWait(w.h.oracle, CONTROL_APP, "RESPONSE_STORED");
        held.hold.release();
        assert.deepEqual((await sweeping).failed, []);
        assert.equal((await response)?.state, "RESPONSE_STORED", "the response lands on the UNCERTAIN request");
      } else {
        const response = heldUnit(run.ag.agencyId, respond);
        await response.reached;
        const sweeping = sweep();
        await waitForLockWait(w.h.oracle, CONTROL_APP, GRANT_USAGE);
        response.release();
        assert.equal((await response.done)?.state, "RESPONSE_STORED");
        assert.deepEqual((await sweeping).failed, []);
      }
      const [state, usage, actual] = await request(x);
      assert.deepEqual([state, actual], ["RESPONSE_STORED", 20], `${first} first: the response landed`);
      assert.ok(usage === "KNOWN" || usage === "RECONCILED");
    }
  } finally {
    standAt(0);
  }
});

test("L16c (GDR) DENY gate absent (forged, rule 12): with the pool's gate row deleted by the migration owner, a GRANT_RECONCILIATION posting of known usage with excess over the core's maximum is refused at COMMIT (KA006 pool_liability_gate_absent), recorded as a sweep failure, and moves nothing (reservation held, usage KNOWN, no liability); with the row restored the next run posts it and opens the liability", async () => {
  const pool = await freshPool();
  const run = await interpreting("l16c-gdr", pool);
  const x = await admit(run, 245_000n);
  await dispatch(x);
  await a.control(run.ag.agencyId, (uow) => uow.requestJournal.storeResponse(x.requestId, 1, sha("l16c-gdr-response"), { usageState: "KNOWN", actualCents: "30" as never }, w.now()));
  const owner = await w.h.pg.connect("kauro_owner");
  const asOwner = async (sql: string) => {
    await owner.query("BEGIN");
    await owner.query("ALTER TABLE kauro.pool_liability_gates NO FORCE ROW LEVEL SECURITY");
    await owner.query(sql, [pool]);
    await owner.query("ALTER TABLE kauro.pool_liability_gates FORCE ROW LEVEL SECURITY");
    await owner.query("COMMIT");
  };
  const liabilities = async () => (await w.h.oracle.query("SELECT request_id, excess_micros::text AS excess, state FROM kauro.dispatch_liabilities WHERE pool_id = $1", [pool])).rows;
  try {
    await asOwner("DELETE FROM kauro.pool_liability_gates WHERE pool_grant_id = $1");
    const refused = await sweep();
    assert.deepEqual(
      refused.failed.filter((f) => f.subject === run.grantId),
      [{ subject: run.grantId, cause: refused.failed.find((f) => f.subject === run.grantId)?.cause }],
      "recorded as a sweep failure of the grant",
    );
    assert.match(refused.failed.find((f) => f.subject === run.grantId)!.cause, /INTEGRITY_FAILURE|KA006|DomainFailure/);
    assert.deepEqual(await request(x), ["RESPONSE_STORED", "KNOWN", 30, null], "nothing posted");
    assert.deepEqual(await money(run.grantId), ["AUTHORIZED", 25, 0], "the reservation held");
    assert.deepEqual(await liabilities(), []);
    await asOwner("INSERT INTO kauro.pool_liability_gates (pool_grant_id) VALUES ($1)");
    const posted = await sweep();
    assert.deepEqual(posted.failed.filter((f) => f.subject === run.grantId), []);
    assert.deepEqual(await money(run.grantId), ["AUTHORIZED", 0, 25], "min(30, 25 reserved) cents posted within the ceiling");
    assert.deepEqual(await liabilities(), [{ request_id: x.requestId, excess: "55000", state: "OPEN" }], "30 cents = 300,000 micros over the 245,000 maximum");
  } finally {
    await owner.end();
  }
});

test("L19 (GDR) RACE (reconciliation clock, monotone): a GRANT_RECONCILIATION pass whose server instant was read before a request lock wait that crossed the grant's expiry leaves the grant AUTHORIZED in that pass and moves it EXPIRED in the next, and no reservation lands on it after the expiry meanwhile", async () => {
  // a pool ending inside the interpretation window caps the AUDIT grant's expiry (StartAudit), so the grant expires while its audit
  // still interprets and its lease is live
  const pool = await freshPool(5_000n, 900);
  const run = await interpreting("l19", pool);
  const expiresAt = (await a.grant(run.grantId)).expires_at;
  assert.ok(Date.parse(expiresAt) < Date.parse(run.deadline), "the grant expires before the interpretation deadline");
  try {
    // one offset K for every unit: four seconds before the grant's expiry
    const K = offsetBefore(expiresAt, 4);
    standAt(K);
    // p: a stored response of known usage (3 cents of 5 reserved) makes the grant due for the reconciler
    const p = await admit(run, 50_000n);
    await dispatch(p);
    await a.control(run.ag.agencyId, (uow) => uow.requestJournal.storeResponse(p.requestId, 1, sha("l19-p"), { usageState: "KNOWN", actualCents: "3" as never }, w.now()));
    const q = await admit(run, 50_000n);
    // H: the edge on q, its row held at a FaultPoint before COMMIT across the expiry, then crashed (q stays RESERVED)
    const points = new FaultPoints();
    const pause = points.pause("l19-edge.before-commit");
    const edge = crashableFactory(w.units, points, "l19-edge").run(adapterContext(run.ag.agencyId), (uow) => uow.requestJournal.markDispatching(q.requestId, 1, "provider-l19", w.now()));
    await pause.reachedBy(edge);
    // R: the reconciler locks the grant, reads its instant, then waits on q's row (grantUsage FOR UPDATE OF r)
    const pass1 = sweep();
    await waitForLockWait(w.h.oracle, CONTROL_APP, GRANT_USAGE);
    for (let i = 0; ; i++) {
      const past = (await w.h.oracle.query("SELECT clock_timestamp() + make_interval(secs => $1) >= $2::timestamptz + interval '250 milliseconds' AS past", [K, expiresAt])).rows[0].past;
      if (past === true) break;
      assert.ok(i < 400, "the shifted clock reaches the expiry");
      await new Promise((res) => setTimeout(res, 25));
    }
    pause.crash();
    await assert.rejects(edge, crashedAt("l19-edge.before-commit"));
    assert.deepEqual((await pass1).failed.filter((f) => f.subject === run.grantId), []);
    assert.deepEqual(await money(run.grantId), ["AUTHORIZED", 5, 3], "pass 1 posted p and judged its own (earlier) instant: still AUTHORIZED");
    assert.deepEqual(await request(q), ["RESERVED", "UNKNOWN", null, null], "the crashed edge sent nothing");
    // meanwhile no reservation lands on the grant after its expiry (refused at its COMMIT)
    const late = admissionOf(run, 50_000n);
    await assert.rejects(a.control(run.ag.agencyId, (uow) => admitIn(uow, late)), (e: unknown) => {
      const codes: string[] = [];
      for (let c: unknown = e; c !== null && typeof c === "object"; c = (c as { cause?: unknown }).cause) codes.push(`${String((c as { code?: unknown }).code)}:${String((c as { constraint?: unknown }).constraint)}`);
      return codes.includes("KA083:grant_expired_at_dispatch");
    });
    assert.equal((await w.h.oracle.query("SELECT count(*)::int AS n FROM kauro.request_journal WHERE request_id = $1", [late.requestId])).rows[0].n, 0);
    // pass 2, a fresh transaction after the expiry: EXPIRED
    assert.deepEqual((await sweep()).failed.filter((f) => f.subject === run.grantId), []);
    assert.deepEqual(await money(run.grantId), ["EXPIRED", 5, 3], "pass 2: EXPIRED, p posted once");
  } finally {
    standAt(0);
  }
});

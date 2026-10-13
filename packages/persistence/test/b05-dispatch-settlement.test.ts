// B05 dispatch settlement, liabilities and the pool liability gate (lane L3m, LDG titles; docs/design/B05-cores.md D5-11, D5-18,
// D5-19, D5-19b, LOCK-B05-1; migration 0059 provisional): the admission of a core reservation through beginDispatch, its settlement
// (settleDispatch), GRANT_RECONCILIATION's micros evidence (reconcileRequestMicros), the journal's send and response edges, and the
// pool's liability gate taken at COMMIT, on real PostgreSQL 17 through the control plane's login. Every interleaving is fixed by a
// FaultPoint or an open transaction and the other side's lock wait observed in pg_stat_activity (mustWait), never by a sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, type RequestId } from "@kauro/domain";
import { FaultPoints, bothOrders, connectionPid, crashableFactory, crashedAt, mustWait } from "../src/testing/index.js";
import { settlesOrWaits } from "../src/testing/harness.js";
import { controlOf } from "../src/testing/execution-fixtures.js";
import { clockAt } from "../src/testing/source-lifecycle.js";
import { bindCommerce, service, within } from "./commerce-support.js";
import { failureOf } from "./audit-support.js";
import {
  admissionOf,
  admit,
  admitWith,
  closeDispatchEnv,
  dispatch,
  freshPool,
  interpretingRun,
  liabilities,
  money,
  gateSetting,
  openDispatchEnv,
  preparedAudit,
  rawJournal,
  rawStore,
  requestRow,
  settlementOf,
  type Admission,
  type DispatchEnv,
  type Run,
  withConnections,
} from "./b05-dispatch-support.js";
import { clock, sha, sqlState } from "./support.js";

let env: DispatchEnv;
before(async () => {
  env = await openDispatchEnv();
});
after(async () => {
  await closeDispatchEnv(env);
});

const constraintOf = (e: unknown): string | undefined => (e as { constraint?: string }).constraint;
/** A raw statement's refusal (SQLSTATE, constraint) in a control-plane transaction bound to the agency, rolled back either way. */
async function refusal(agencyId: string, sql: string, params: unknown[]): Promise<[string, string | undefined]> {
  await env.control.query("BEGIN");
  try {
    await bindCommerce(env.control, service(agencyId));
    await env.control.query(sql, params);
    return ["NONE", undefined];
  } catch (e) {
    return [sqlState(e), constraintOf(e)];
  } finally {
    await env.control.query("ROLLBACK");
  }
}

const settle = (a: Admission, state: "COMMITTED" | "AMBIGUOUS" | "RELEASED", chargeMicros: bigint, usageKnown = true) =>
  env.h.audit.run(controlOf(a.run.ag.agencyId), (uow) => uow.audits.settleDispatch(settlementOf(a, state, chargeMicros, usageKnown)));

const journal = <T>(a: Admission, fn: (j: Parameters<Parameters<typeof env.h.audit.run>[1]>[0]["requestJournal"]) => Promise<T>) =>
  env.h.audit.run(controlOf(a.run.ag.agencyId), (uow) => fn(uow.requestJournal));

/** The owner cancels the run's audit (INTERPRETING is the audit's version 3). */
async function cancel(run: Run): Promise<void> {
  const out = await env.h.audit.run(env.h.tenant(run.ag.agencyId as never, run.ag.ownerUserId as never), (uow) => uow.audits.cancelAudit(run.auditId as never, 3, { actor: { kind: "USER", userId: run.ag.ownerUserId as never }, reasonCode: "AGENCY_CANCELLED" }));
  assert.equal(out.kind, "APPLIED");
}

/** An admission dispatched and its complete response stored with known usage (`actualCents`), ready to settle. */
async function answered(a: Admission, actualCents = "1"): Promise<void> {
  await dispatch(env, a);
  const r = await journal(a, (j) => j.storeResponse(a.requestId, 1, sha(`response-${a.core.reservationId}`), { usageState: "KNOWN", actualCents: actualCents as never }, clock.now()));
  assert.equal(r?.state, "RESPONSE_STORED");
}

test("L01 RACE (crash before COMMIT): admission rolled back after the model task insert leaves no task, no intent and no reserved cents", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l01", pool);
  const points = new FaultPoints();
  const factory = crashableFactory(env.h.audit, points, "adm");
  const a = admissionOf(run, 245_000n);
  points.crash("adm.before-commit");
  await assert.rejects(factory.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, a)), crashedAt("adm.before-commit"));
  const left = (await env.h.oracle.query("SELECT (SELECT count(*)::int FROM kauro.model_tasks WHERE model_task_id = $1) AS tasks, (SELECT count(*)::int FROM kauro.request_journal WHERE request_id = $2 OR core_run_id = $3) AS intents", [a.taskId, a.requestId, a.core.runId])).rows[0];
  assert.deepEqual(left, { tasks: 0, intents: 0 }, "no task, no intent");
  assert.deepEqual(await money(env, run.grantId), { reserved: 0, spent: 0, state: "AUTHORIZED" }, "no reserved cents");
  // the same admission afterwards is admitted once
  const again = await admit(env, run, 245_000n);
  assert.deepEqual(await money(env, run.grantId), { reserved: Number(again.reservedCents), spent: 0, state: "AUTHORIZED" });
});

test("L02 RACE (retry, crash after COMMIT): admit and settle replayed with the same key return the recorded result with one reservation and one posting; another body is SETTLEMENT_CONFLICT with no write", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l02", pool);
  const points = new FaultPoints();
  const factory = crashableFactory(env.h.audit, points, "l02");
  const a = admissionOf(run, 245_000n);
  // the admission commits and its answer is lost; the retry with the same (run, reservation) is the recorded result
  points.crash("l02.after-commit");
  await assert.rejects(factory.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, a)), crashedAt("l02.after-commit"));
  const retry = await env.h.audit.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, { ...a, requestId: "00000000-0000-7000-8000-000000000001" as RequestId }));
  assert.deepEqual(retry.kind === "REPLAYED" ? [retry.kind, retry.request.requestId, retry.request.reservedCents] : [retry.kind], ["REPLAYED", a.requestId, "25"]);
  assert.deepEqual(await money(env, run.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" }, "one reservation");
  // another body under the same key: a conflict, nothing written
  await assert.rejects(
    env.h.audit.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, { ...a, core: { ...a.core, maxChargeMicros: 255_000n }, reservedCents: 26n })),
    (e: unknown) => failureOf(e)[0] === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await env.h.oracle.query("SELECT count(*)::int AS n FROM kauro.request_journal WHERE core_run_id = $1", [a.core.runId])).rows[0].n, 1);
  assert.deepEqual(await money(env, run.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" });

  await answered(a, "20");
  // the settlement commits and its answer is lost; the retry is a replay with one posting
  points.crash("l02.after-commit");
  await assert.rejects(factory.run(controlOf(run.ag.agencyId), (uow) => uow.audits.settleDispatch(settlementOf(a, "COMMITTED", 199_999n))), crashedAt("l02.after-commit"));
  const replay = await settle(a, "COMMITTED", 199_999n);
  assert.deepEqual([replay.kind, replay.kind === "NO_REQUEST" ? null : replay.recorded], ["REPLAYED", "COMMITTED"]);
  assert.deepEqual(await money(env, run.grantId), { reserved: 0, spent: 20, state: "AUTHORIZED" }, "one posting of ceil(199,999 / 10,000) = 20 cents");
  const settledRow = await requestRow(env, a.requestId);
  for (const other of [settlementOf(a, "COMMITTED", 200_000n), settlementOf(a, "COMMITTED", 199_999n, false), settlementOf(a, "RELEASED", 0n), settlementOf(a, "AMBIGUOUS", 245_000n)]) {
    await assert.rejects(
      env.h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.settleDispatch(other)),
      (e: unknown) => isDomainFailure(e) && e.code === "IDEMPOTENCY_CONFLICT" && e.message.startsWith("SETTLEMENT_CONFLICT"),
      `${other.state} ${other.chargeMicros} is another body`,
    );
  }
  assert.deepEqual(await requestRow(env, a.requestId), settledRow, "no write");
  assert.deepEqual(await money(env, run.grantId), { reserved: 0, spent: 20, state: "AUTHORIZED" });
  assert.deepEqual(await liabilities(env, pool), []);
});

test("L03 RACE (partial): a failure at the grant update or the liability insert rolls back the request row, the grant and the liability", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l03", pool);
  const a = await admit(env, run, 245_000n);
  await answered(a, "25");
  const before = await requestRow(env, a.requestId);
  // (1) the grant update fails (a forged failure of the posting statement) after the request row and the liability were written
  const failingGrantUpdate = (c: Client): Client =>
    new Proxy(c, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: unknown, ...rest: unknown[]) => {
          if (typeof sql === "string" && sql.includes("UPDATE kauro.cost_grants SET reserved_cents = reserved_cents -")) return Promise.reject(new Error("forged failure at the grant update"));
          return (target.query as (...args: unknown[]) => unknown).call(target, sql, ...rest);
        };
      },
    });
  await assert.rejects(within(env.control, service(run.ag.agencyId), (c) => rawStore(failingGrantUpdate(c)).settleDispatch(settlementOf(a, "COMMITTED", 300_000n))), /forged failure at the grant update/);
  assert.deepEqual(await requestRow(env, a.requestId), before, "the request row rolled back");
  assert.deepEqual(await money(env, run.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" }, "the grant rolled back");
  assert.deepEqual(await liabilities(env, pool), [], "the liability rolled back");
  // (2) the liability insert fails (its gate registration meets another pool's setting: KA006 scope) after the request row was written
  await assert.rejects(
    within(env.control, service(run.ag.agencyId), async (c) => {
      await c.query("SELECT set_config('kauro.liability_gate_pool', $1, true), set_config('kauro.liability_gate_mode', 'UPDATE', true)", ["00000000-0000-7000-8000-00000000beef"]);
      return rawStore(c).settleDispatch(settlementOf(a, "COMMITTED", 300_000n));
    }),
    (e: unknown) => failureOf(e)[0] === "INTEGRITY_FAILURE" && failureOf(e)[1] === "COMMITMENT_ISOLATION" && /pool_liability_gate_scope/.test((e as Error).message),
  );
  assert.deepEqual(await requestRow(env, a.requestId), before);
  assert.deepEqual(await money(env, run.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" });
  assert.deepEqual(await liabilities(env, pool), []);
  // the same settlement then commits whole
  const out = await settle(a, "COMMITTED", 300_000n);
  assert.deepEqual(out.kind === "RECORDED" ? [out.kind, out.liabilityMicros] : [out.kind], ["RECORDED", 55_000n]);
  assert.deepEqual(await money(env, run.grantId), { reserved: 0, spent: 25, state: "AUTHORIZED" });
  assert.deepEqual(await liabilities(env, pool), [{ request_id: a.requestId, excess: "55000", state: "OPEN" }]);
});

test("L05 RACE (liability): a charge 1 micro above max_charge_micros opens a liability of exactly 1 micro even when the rounded-up cents would cover it; spend stays within the ceiling and any reservation on the pool is refused NO_FUNDED_GRANT", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l05", pool);
  const other = await interpretingRun(env, "l05-other", pool);
  // the admitted maximum is 24.5 cents: 25 cents reserved, so ceil(245,001 / 10,000) = 25 cents is covered by the reservation
  const a = await admit(env, run, 245_000n);
  const waiting = await admit(env, other, 100_000n);
  await answered(a, "25");
  const out = await settle(a, "COMMITTED", 245_001n);
  assert.deepEqual(out.kind === "RECORDED" ? [out.kind, out.recorded, out.liabilityMicros] : [out.kind], ["RECORDED", "COMMITTED", 1n]);
  assert.deepEqual(await liabilities(env, pool), [{ request_id: a.requestId, excess: "1", state: "OPEN" }], "exactly 1 micro, from the micros, not the cents");
  assert.deepEqual(await money(env, run.grantId), { reserved: 0, spent: 25, state: "AUTHORIZED" }, "min(ceil, reserved) cents: within the ceiling");
  assert.deepEqual(await requestRow(env, a.requestId), { state: "RESPONSE_STORED", usage: "RECONCILED", actual: 25, settlement: "COMMITTED", charge: "245001", evidence: null });
  // any reservation on the pool: the audit's next admission and another grant's admission are refused at COMMIT
  for (const r of [run, other]) {
    const b = admissionOf(r, 100_000n);
    await assert.rejects(env.h.audit.run(controlOf(r.ag.agencyId), (uow) => admitWith(uow.audits as never, b)), (e: unknown) => failureOf(e)[0] === "BUDGET_EXHAUSTED" && failureOf(e)[1] === "NO_FUNDED_GRANT");
    assert.equal((await env.h.oracle.query("SELECT count(*)::int AS n FROM kauro.request_journal WHERE request_id = $1", [b.requestId])).rows[0].n, 0);
  }
  // and the DISPATCHING edge of a request admitted before the liability
  await assert.rejects(journal(waiting, (j) => j.markDispatching(waiting.requestId, 1, "provider-l05", clock.now())), (e: unknown) => failureOf(e)[0] === "BUDGET_EXHAUSTED" && failureOf(e)[1] === "NO_FUNDED_GRANT");
  assert.equal((await requestRow(env, waiting.requestId)).state, "RESERVED");
  assert.deepEqual(await money(env, other.grantId), { reserved: 10, spent: 0, state: "AUTHORIZED" });
});

test("L06 DENY settlement: RELEASED for a request that reached DISPATCHING without non-acceptance evidence stays AMBIGUOUS; usage_known false posts ESTIMATED and the grant cannot close", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l06", pool);
  const a = await admit(env, run, 245_000n);
  await dispatch(env, a);
  const released = await settle(a, "RELEASED", 0n);
  assert.deepEqual(released.kind === "RECORDED" ? [released.kind, released.recorded] : [released.kind], ["RECORDED", "AMBIGUOUS"]);
  assert.deepEqual(await requestRow(env, a.requestId), { state: "DISPATCHING", usage: "UNKNOWN", actual: null, settlement: "AMBIGUOUS", charge: "0", evidence: null });
  assert.deepEqual(await money(env, run.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" }, "the reservation is held");
  // an estimate: posted, usage ESTIMATED, and the grant cannot close over it (its only request CONSUMED, its audit cancelled)
  const pool2 = await freshPool(env);
  const run2 = await interpretingRun(env, "l06-estimate", pool2);
  const b = await admit(env, run2, 100_000n);
  await answered(b, "9");
  const estimated = await settle(b, "COMMITTED", 90_000n, false);
  assert.equal(estimated.kind === "RECORDED" ? estimated.recorded : estimated.kind, "COMMITTED");
  assert.deepEqual(await requestRow(env, b.requestId), { state: "RESPONSE_STORED", usage: "ESTIMATED", actual: 9, settlement: "COMMITTED", charge: "90000", evidence: null });
  assert.deepEqual(await money(env, run2.grantId), { reserved: 0, spent: 9, state: "AUTHORIZED" });
  await journal(b, (j) => j.markConsumed(b.requestId, 1, clock.now()));
  await cancel(run2);
  const close = async () => {
    const g = await env.h.audit.run(controlOf(run2.ag.agencyId), (uow) => uow.audits.getGrant(run2.grantId as never));
    assert.ok(g);
    return env.h.audit.run(controlOf(run2.ag.agencyId), (uow) => uow.audits.transitionGrant(run2.grantId as never, g.version, "CLOSED"));
  };
  await assert.rejects(close(), (e: unknown) => failureOf(e)[0] === "BUDGET_EXHAUSTED", "no close over ESTIMATED usage");
  assert.equal((await money(env, run2.grantId)).state, "AUTHORIZED");
  // provider evidence ends the estimate (the spend corrected by the difference), and the grant closes
  await env.h.audit.run(controlOf(run2.ag.agencyId), (uow) => uow.audits.reconcileRequestMicros(b.requestId, 70_000n));
  assert.deepEqual(await requestRow(env, b.requestId), { state: "CONSUMED", usage: "RECONCILED", actual: 7, settlement: "COMMITTED", charge: "90000", evidence: null });
  assert.equal((await close()).kind, "APPLIED");
  assert.deepEqual(await money(env, run2.grantId), { reserved: 0, spent: 7, state: "CLOSED" });
});

test("L07 RACE (late settlement): a COMMITTED settlement after audit cancellation or interpretation expiry posts its cents and opens the excess-over-max liability by the same rule", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l07", pool);
  const a = await admit(env, run, 245_000n);
  await answered(a, "25");
  await cancel(run);
  const out = await settle(a, "COMMITTED", 250_000n);
  assert.deepEqual(out.kind === "RECORDED" ? [out.recorded, out.liabilityMicros] : [out.kind], ["COMMITTED", 5_000n]);
  assert.deepEqual(await money(env, run.grantId), { reserved: 0, spent: 25, state: "AUTHORIZED" });
  assert.deepEqual(await liabilities(env, pool), [{ request_id: a.requestId, excess: "5000", state: "OPEN" }]);

  // after the interpretation deadline (the settlement's transaction on a clock past it): the same rule
  const pool2 = await freshPool(env);
  const run2 = await interpretingRun(env, "l07-expired", pool2);
  const b = await admit(env, run2, 100_000n);
  await answered(b, "10");
  const deadline = (await env.h.oracle.query("SELECT interpretation_deadline_at AS at FROM kauro.audits WHERE audit_id = $1", [run2.auditId])).rows[0].at as Date;
  const late = await within(env.control, service(run2.ag.agencyId), async (c) => {
    await clockAt(c, new Date(deadline.getTime() + 60_000));
    return rawStore(c).settleDispatch(settlementOf(b, "COMMITTED", 100_001n));
  });
  assert.deepEqual(late.kind === "RECORDED" ? [late.recorded, late.liabilityMicros] : [late.kind], ["COMMITTED", 1n]);
  assert.deepEqual(await money(env, run2.grantId), { reserved: 0, spent: 10, state: "AUTHORIZED" });
  assert.deepEqual(await liabilities(env, pool2), [{ request_id: b.requestId, excess: "1", state: "OPEN" }]);
});

test("L08 RACE (reconciliation): GRANT_RECONCILIATION evidence in micros above max_charge_micros opens the liability; an equal replay is idempotent; cents evidence is compared as cents*10000", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "l08", pool);
  const recon = <T>(fn: (s: Parameters<Parameters<typeof env.h.audit.run>[1]>[0]["audits"]) => Promise<T>) => env.h.audit.run(controlOf(run.ag.agencyId), (uow) => fn(uow.audits));
  // micros evidence above the maximum
  const a = await admit(env, run, 245_000n);
  await answered(a, "25");
  const g1 = await recon((s) => s.reconcileRequestMicros(a.requestId, 245_010n));
  assert.deepEqual([g1.reservedCents, g1.reconciledSpendCents], [0n, 25n]);
  assert.deepEqual(await liabilities(env, pool), [{ request_id: a.requestId, excess: "10", state: "OPEN" }]);
  const replay = await recon((s) => s.reconcileRequestMicros(a.requestId, 245_010n));
  assert.deepEqual([replay.reservedCents, replay.reconciledSpendCents], [0n, 25n], "an equal replay is idempotent");
  await assert.rejects(recon((s) => s.reconcileRequestMicros(a.requestId, 245_011n)), (e: unknown) => failureOf(e)[0] === "PRECONDITION_FAILED");
  assert.deepEqual(await liabilities(env, pool), [{ request_id: a.requestId, excess: "10", state: "OPEN" }], "one liability");
  // cents evidence: 25 cents is 250,000 micros, 5,000 above the 245,000 maximum, although 25 cents equal the 25 reserved
  const pool2 = await freshPool(env);
  const run2 = await interpretingRun(env, "l08-cents", pool2);
  const b = await admit(env, run2, 245_000n);
  await answered(b, "25");
  const g2 = await env.h.audit.run(controlOf(run2.ag.agencyId), (uow) => uow.audits.reconcileRequest(b.requestId, 25n));
  assert.deepEqual([g2.reservedCents, g2.reconciledSpendCents], [0n, 25n]);
  assert.deepEqual(await liabilities(env, pool2), [{ request_id: b.requestId, excess: "5000", state: "OPEN" }]);
  assert.deepEqual(await requestRow(env, b.requestId), { state: "RESPONSE_STORED", usage: "RECONCILED", actual: 25, settlement: "COMMITTED", charge: "250000", evidence: null });
  const again = await env.h.audit.run(controlOf(run2.ag.agencyId), (uow) => uow.audits.reconcileRequest(b.requestId, 25n));
  assert.deepEqual([again.reservedCents, again.reconciledSpendCents], [0n, 25n], "the equal cents evidence again is idempotent");
  // and evidence at or under the maximum opens nothing
  const pool3 = await freshPool(env);
  const run3 = await interpretingRun(env, "l08-under", pool3);
  const c3 = await admit(env, run3, 245_000n);
  await answered(c3, "24");
  await env.h.audit.run(controlOf(run3.ag.agencyId), (uow) => uow.audits.reconcileRequestMicros(c3.requestId, 245_000n));
  assert.deepEqual(await liabilities(env, pool3), []);
  assert.deepEqual(await money(env, run3.grantId), { reserved: 0, spent: 25, state: "AUTHORIZED" });
});

test("S08 DENY send edge: markDispatching on a DISPATCHING, UNCERTAIN, RESPONSE_STORED, FAILED or CANCELLED request returns null, a direct UPDATE into DISPATCHING from any state but RESERVED is refused KA007, and an edge retried after its first COMMIT and an audit cancellation sends nothing", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "s08", pool);
  const at = async (state: string): Promise<Admission> => {
    const a = await admit(env, run, 50_000n);
    if (state === "RESERVED") return a;
    if (state === "CANCELLED") {
      await settle(a, "RELEASED", 0n);
      return a;
    }
    await dispatch(env, a);
    if (state === "UNCERTAIN") await journal(a, (j) => j.markUncertain(a.requestId, 1, clock.now()));
    if (state === "RESPONSE_STORED") await journal(a, (j) => j.storeResponse(a.requestId, 1, sha(`s08-${a.requestId}`), { usageState: "KNOWN", actualCents: "1" as never }, clock.now()));
    if (state === "FAILED") await journal(a, (j) => j.markFailed(a.requestId, 1, clock.now()));
    return a;
  };
  const rows = new Map<string, Admission>();
  for (const s of ["DISPATCHING", "UNCERTAIN", "RESPONSE_STORED", "FAILED", "CANCELLED"]) rows.set(s, await at(s));
  for (const [s, a] of rows) {
    assert.equal((await requestRow(env, a.requestId)).state, s);
    assert.equal(await journal(a, (j) => j.markDispatching(a.requestId, 1, "provider-again", clock.now())), null, `markDispatching on ${s} returns null`);
    assert.equal((await requestRow(env, a.requestId)).state, s, `${s} unchanged`);
    assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET state = 'DISPATCHING' WHERE request_id = $1", [a.requestId]), ["KA007", undefined], `a direct UPDATE from ${s} into DISPATCHING`);
  }
  // the edge retried after its first COMMIT sends nothing (the DISPATCHING row above answered null); after the audit's cancellation a
  // RESERVED request's edge is refused
  const reserved = await at("RESERVED");
  await cancel(run);
  await assert.rejects(journal(reserved, (j) => j.markDispatching(reserved.requestId, 1, "provider-after-cancel", clock.now())), (e: unknown) => failureOf(e)[1] === "EXECUTION_AUTHORITY_LOST");
  assert.equal((await requestRow(env, reserved.requestId)).state, "RESERVED");
  assert.equal(await journal(rows.get("DISPATCHING")!, (j) => j.markDispatching(rows.get("DISPATCHING")!.requestId, 1, "provider-again", clock.now())), null);
});

test("S11 DENY release: RELEASED for a DISPATCHING or UNCERTAIN request or a FAILED one without evidence is recorded AMBIGUOUS with the reservation held; evidence written on any edge but DISPATCHING -> FAILED with usage UNKNOWN, rewritten, or outside the three literals is refused", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "s11", pool);
  const sent = async (): Promise<Admission> => {
    const a = await admit(env, run, 50_000n);
    await dispatch(env, a);
    return a;
  };
  const dispatching = await sent();
  const uncertain = await sent();
  await journal(uncertain, (j) => j.markUncertain(uncertain.requestId, 1, clock.now()));
  const failed = await sent();
  await journal(failed, (j) => j.markFailed(failed.requestId, 1, clock.now()));
  for (const a of [dispatching, uncertain, failed]) {
    const before = await requestRow(env, a.requestId);
    const out = await settle(a, "RELEASED", 0n);
    assert.equal(out.kind === "RECORDED" ? out.recorded : out.kind, "AMBIGUOUS", `${before.state}: recorded AMBIGUOUS`);
    assert.deepEqual(await requestRow(env, a.requestId), { ...before, settlement: "AMBIGUOUS", charge: "0" }, `${before.state}: the reservation held, usage unchanged`);
  }
  assert.deepEqual(await money(env, run.grantId), { reserved: 15, spent: 0, state: "AUTHORIZED" });
  // evidence on any edge but DISPATCHING -> FAILED with usage UNKNOWN
  const reserved = await admit(env, run, 50_000n);
  const ev = "TRANSPORT_NEVER_SENT";
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET state = 'FAILED', non_acceptance_evidence = $2 WHERE request_id = $1", [reserved.requestId, ev]), ["KA007", undefined], "RESERVED -> FAILED");
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET state = 'FAILED', non_acceptance_evidence = $2 WHERE request_id = $1", [uncertain.requestId, ev]), ["KA007", undefined], "UNCERTAIN -> FAILED");
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET non_acceptance_evidence = $2 WHERE request_id = $1", [dispatching.requestId, ev]), ["KA007", undefined], "no edge");
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET non_acceptance_evidence = $2 WHERE request_id = $1", [failed.requestId, ev]), ["KA007", undefined], "on a FAILED row without evidence");
  assert.deepEqual(
    await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET state = 'FAILED', usage_state = 'KNOWN', actual_cents = 1, non_acceptance_evidence = $2 WHERE request_id = $1", [dispatching.requestId, ev]),
    ["KA007", undefined],
    "DISPATCHING -> FAILED with usage KNOWN",
  );
  // outside the three literals
  const [code, constraint] = await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET state = 'FAILED', non_acceptance_evidence = 'PROVIDER_SAID_SO' WHERE request_id = $1", [dispatching.requestId]);
  assert.equal(code, "23514", `a literal outside the three (${constraint ?? ""})`);
  // rewritten
  const evidenced = await sent();
  await journal(evidenced, (j) => j.markFailed(evidenced.requestId, 1, clock.now(), "PROVIDER_DOCUMENTED_NON_ACCEPTANCE:ThrottlingException"));
  assert.equal((await requestRow(env, evidenced.requestId)).evidence, "PROVIDER_DOCUMENTED_NON_ACCEPTANCE:ThrottlingException");
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET non_acceptance_evidence = $2 WHERE request_id = $1", [evidenced.requestId, ev]), ["KA004", undefined], "rewritten");
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET non_acceptance_evidence = NULL WHERE request_id = $1", [evidenced.requestId]), ["KA004", undefined], "erased");
  // the evidenced FAILED request is the one RELEASED returns the cents of
  const out = await settle(evidenced, "RELEASED", 0n);
  assert.equal(out.kind === "RECORDED" ? out.recorded : out.kind, "RELEASED");
  assert.deepEqual(await money(env, run.grantId), { reserved: 20, spent: 0, state: "AUTHORIZED" }, "15 held + 5 of the RESERVED one; the evidenced 5 back");
});

test("S15 DENY response edge (B06 contract kept): storeResponse at the request's fence on a CONSUMED, FAILED, CANCELLED or RESERVED request is refused PRECONDITION_FAILED and on a RESPONSE_STORED one with another hash INTEGRITY_FAILURE, a same-hash replay carrying usage KNOWN and actualCents 999 returns the stored row with usage_state and actual_cents as first stored, a wrong fence returns null, a direct UPDATE into RESPONSE_STORED from RESERVED is refused KA007, and adapters-journals-outbox.test.ts:259-263 passes unchanged", async () => {
  const pool = await freshPool(env);
  const run = await interpretingRun(env, "s15", pool);
  const store = (a: Admission, hash: string, usage: { usageState: "KNOWN" | "UNKNOWN"; actualCents?: string }, fence = 1) =>
    journal(a, (j) => j.storeResponse(a.requestId, fence, sha(hash), usage as never, clock.now()));
  const stored = await admit(env, run, 50_000n);
  await dispatch(env, stored);
  const first = await store(stored, "s15-first", { usageState: "UNKNOWN" });
  assert.deepEqual([first?.state, first?.usageState, first?.actualCents ?? null], ["RESPONSE_STORED", "UNKNOWN", null]);
  const consumed = await admit(env, run, 50_000n);
  await answered(consumed);
  await journal(consumed, (j) => j.markConsumed(consumed.requestId, 1, clock.now()));
  const failed = await admit(env, run, 50_000n);
  await dispatch(env, failed);
  await journal(failed, (j) => j.markFailed(failed.requestId, 1, clock.now()));
  const cancelled = await admit(env, run, 50_000n);
  await settle(cancelled, "RELEASED", 0n);
  const reserved = await admit(env, run, 50_000n);
  for (const [name, a] of [["CONSUMED", consumed], ["FAILED", failed], ["CANCELLED", cancelled], ["RESERVED", reserved]] as const) {
    const before = await requestRow(env, a.requestId);
    assert.equal(before.state, name);
    await assert.rejects(store(a, `s15-${name}`, { usageState: "KNOWN", actualCents: "1" }), (e: unknown) => failureOf(e)[0] === "PRECONDITION_FAILED", `${name}: PRECONDITION_FAILED`);
    assert.deepEqual(await requestRow(env, a.requestId), before);
  }
  await assert.rejects(store(stored, "s15-other", { usageState: "UNKNOWN" }), (e: unknown) => failureOf(e)[0] === "INTEGRITY_FAILURE", "another hash on RESPONSE_STORED");
  const replay = await store(stored, "s15-first", { usageState: "KNOWN", actualCents: "999" });
  assert.deepEqual([replay?.state, replay?.usageState, replay?.actualCents ?? null], ["RESPONSE_STORED", "UNKNOWN", null], "the stored row as first stored");
  assert.deepEqual(await requestRow(env, stored.requestId), { state: "RESPONSE_STORED", usage: "UNKNOWN", actual: null, settlement: null, charge: null, evidence: null });
  assert.equal(await store(stored, "s15-first", { usageState: "UNKNOWN" }, 2), null, "a wrong fence returns null");
  assert.deepEqual(await refusal(run.ag.agencyId, "UPDATE kauro.request_journal SET state = 'RESPONSE_STORED', response_artifact_hash = $2 WHERE request_id = $1", [reserved.requestId, sha("s15-direct")]), ["KA007", undefined]);
});

/** The PostgreSQL error under a refusal: the raw error, or the cause a unit of work's DomainFailure carries. */
function pgErr(e: unknown): { code?: string; constraint?: string } {
  const x = e as { code?: unknown; constraint?: string; cause?: unknown } | null;
  if (x !== null && typeof x === "object" && typeof x.code === "string" && /^[0-9A-Z]{5}$/.test(x.code)) return { code: x.code, ...(x.constraint === undefined ? {} : { constraint: x.constraint }) };
  return x !== null && typeof x === "object" && x.cause !== undefined ? pgErr(x.cause) : {};
}
const refusedBy = (code: string, constraint?: string) => (e: unknown): boolean => {
  const p = pgErr(e);
  return p.code === code && (constraint === undefined || p.constraint === constraint);
};
const rejection = (o: PromiseSettledResult<unknown> | undefined): unknown => {
  assert.equal(o?.status, "rejected", "the operation was refused");
  return (o as PromiseRejectedResult).reason;
};
const valueOf = <T>(o: PromiseSettledResult<unknown> | undefined): T => {
  assert.equal(o?.status, "fulfilled", o?.status === "rejected" ? String((o as PromiseRejectedResult).reason) : "fulfilled");
  return (o as PromiseFulfilledResult<T>).value;
};

/** One transaction of its own on a raw connection, bound to the agency (or to no agency), committed; rolled back and rethrown on error. */
async function unit<T>(c: Client, agencyId: string | null, work: (c: Client) => Promise<T>, at?: Date): Promise<T> {
  await c.query("BEGIN");
  try {
    await bindCommerce(c, agencyId === null ? {} : service(agencyId));
    if (at !== undefined) await clockAt(c, at);
    const out = await work(c);
    const r = await c.query("COMMIT");
    if (r.command !== "COMMIT") throw new Error(`COMMIT was answered ${r.command}`);
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

/** GRANT_RECONCILIATION's grant lock (PgAuditDiscovery.lockGrant's row lock), first in its unit (LOCK-B05-1). */
const lockGrantRow = (c: Client, grantId: string) => c.query("SELECT 1 FROM kauro.cost_grants WHERE grant_id = $1 FOR UPDATE", [grantId]);

async function closeOn(c: Client, grantId: string, to: "CLOSED" | "EXPIRED" = "CLOSED") {
  await lockGrantRow(c, grantId);
  const store = rawStore(c);
  const g = await store.getGrant(grantId as never);
  assert.ok(g);
  return store.transitionGrant(grantId as never, g.version, to);
}

const requestCount = async (requestId: string): Promise<number> => (await env.h.oracle.query("SELECT count(*)::int AS n FROM kauro.request_journal WHERE request_id = $1", [requestId])).rows[0].n;

interface One {
  readonly pool: string;
  readonly run: Run;
  readonly a: Admission;
}

test("L04 RACE (settle vs GRANT_RECONCILIATION, both orders): one posting, the other a replay or conflict; spend and reserved cents equal the hand-computed values", async () => {
  await withConnections(env, 2, async ([x, y]) => {
    // the same evidence (the other a replay), then another value (the other a conflict)
    for (const [setCharge, recCharge] of [
      [250_000n, 250_000n],
      [250_000n, 260_000n],
    ] as const) {
      await bothOrders<One>({
        oracle: env.h.oracle,
        actors: [
          { name: "SET", client: x!, begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)), act: (c, st) => rawStore(c).settleDispatch(settlementOf(st.a, "COMMITTED", setCharge)) },
          { name: "REC", client: y!, begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)), act: (c, st) => rawStore(c).reconcileRequestMicros(st.a.requestId, recCharge) },
        ],
        async setup() {
          const pool = await freshPool(env);
          const run = await interpretingRun(env, "l04", pool);
          const a = await admit(env, run, 245_000n);
          await answered(a, "25");
          return { pool, run, a };
        },
        async verify({ order, state, outcomes }) {
          const [first, second] = order;
          assert.equal(outcomes[first]?.committed, true, `${first} holds the grant first and commits`);
          const winner = first === "SET" ? setCharge : recCharge;
          if (setCharge === recCharge) {
            assert.equal(outcomes[second]?.committed, true, `${second} replays`);
            if (second === "SET") assert.equal(valueOf<{ kind: string }>(outcomes["SET"]?.act).kind, "REPLAYED");
          } else {
            assert.equal(outcomes[second]?.committed, false);
            assert.equal(failureOf(rejection(outcomes[second]?.act))[0], second === "SET" ? "IDEMPOTENCY_CONFLICT" : "PRECONDITION_FAILED");
          }
          // 25 cents reserved, min(ceil(charge / 10,000), 25) = 25 posted once; the excess over 245,000 micros once
          assert.deepEqual(await money(env, state.run.grantId), { reserved: 0, spent: 25, state: "AUTHORIZED" });
          assert.deepEqual(await liabilities(env, state.pool), [{ request_id: state.a.requestId, excess: String(winner - 245_000n), state: "OPEN" }]);
          assert.equal((await requestRow(env, state.a.requestId)).charge, String(winner));
        },
      });
    }
  });
});

test("L05b [NON-REGRESSION: green under r4's pool row lock too; D01's proof is L05] RACE (liability, both orders): a settlement or a GRANT_RECONCILIATION posting that opens a liability and an admission or a DISPATCHING edge by another run or grant of the same pool serialize on the pool's liability gate at COMMIT (FOR UPDATE vs KEY SHARE); after the liability commits no reservation and no DISPATCHING edge on the pool commits, and one that held the share first commits first", async () => {
  const noFunds = (e: unknown) => failureOf(e)[0] === "BUDGET_EXHAUSTED" && failureOf(e)[1] === "NO_FUNDED_GRANT" && refusedBy("KA083", "pool_liability_open")(e);
  // sequential, both orders, product actors; the posting is a settlement, then GRANT_RECONCILIATION's micros evidence
  for (const posting of ["SET", "REC"] as const) {
    for (const liabilityFirst of [true, false]) {
      const pool = await freshPool(env);
      const settler = await interpretingRun(env, "l05b-post", pool);
      const other = await interpretingRun(env, "l05b-other", pool);
      const s = await admit(env, settler, 245_000n);
      await answered(s, "25");
      const edge = await admit(env, other, 50_000n);
      const post = () =>
        posting === "SET" ? settle(s, "COMMITTED", 250_000n) : env.h.audit.run(controlOf(settler.ag.agencyId), (uow) => uow.audits.reconcileRequestMicros(s.requestId, 250_000n));
      const adm = admissionOf(other, 50_000n);
      const admitOther = () => env.h.audit.run(controlOf(other.ag.agencyId), (uow) => admitWith(uow.audits as never, adm));
      const edgeOther = () => journal(edge, (j) => j.markDispatching(edge.requestId, 1, "provider-l05b", clock.now()));
      if (liabilityFirst) {
        await post();
        await assert.rejects(admitOther(), noFunds);
        await assert.rejects(edgeOther(), noFunds);
        assert.equal((await requestRow(env, edge.requestId)).state, "RESERVED");
        assert.equal(await requestCount(adm.requestId), 0);
        assert.deepEqual(await money(env, other.grantId), { reserved: 5, spent: 0, state: "AUTHORIZED" });
      } else {
        assert.equal((await admitOther()).kind, "RESERVED");
        assert.equal((await edgeOther())?.state, "DISPATCHING");
        await post();
        const late = admissionOf(other, 50_000n);
        await assert.rejects(env.h.audit.run(controlOf(other.ag.agencyId), (uow) => admitWith(uow.audits as never, late)), noFunds);
        assert.deepEqual(await money(env, other.grantId), { reserved: 10, spent: 0, state: "AUTHORIZED" });
      }
      assert.deepEqual(await liabilities(env, pool), [{ request_id: s.requestId, excess: "5000", state: "OPEN" }], `${posting} ${liabilityFirst ? "first" : "after"}`);
    }
  }
  // the wait inside COMMIT (SIMULATED: a raw unit takes the gate as its COMMIT would and holds it; a FaultPoint cannot pause inside COMMIT)
  await withConnections(env, 3, async ([holder, w1, w2]) => {
    // the share first: the admission holding the gate FOR KEY SHARE commits first, the settlement's COMMIT waits for it, then opens the liability
    {
      const pool = await freshPool(env);
      const settler = await interpretingRun(env, "l05b-k-post", pool);
      const other = await interpretingRun(env, "l05b-k-other", pool);
      const s = await admit(env, settler, 245_000n);
      await answered(s, "25");
      const adm = admissionOf(other, 50_000n);
      await holder!.query("BEGIN");
      await bindCommerce(holder!, service(other.ag.agencyId));
      await holder!.query("SELECT 1 FROM kauro.pool_liability_gates WHERE pool_grant_id = $1 FOR KEY SHARE", [pool]);
      assert.equal((await admitWith(rawStore(holder!), adm)).kind, "RESERVED");
      const waiting = await mustWait(env.h.oracle, { waiter: w1!, holder: connectionPid(holder!) }, (c) => unit(c, settler.ag.agencyId, (cc) => rawStore(cc).settleDispatch(settlementOf(s, "COMMITTED", 250_000n))), "the settlement's COMMIT behind the admission's gate share");
      await holder!.query("COMMIT");
      const out = valueOf<{ kind: string; liabilityMicros?: bigint }>(await waiting.pending);
      assert.deepEqual([out.kind, out.liabilityMicros], ["RECORDED", 5_000n]);
      assert.equal((await requestRow(env, adm.requestId)).state, "RESERVED", "the share's holder committed first");
      assert.deepEqual(await liabilities(env, pool), [{ request_id: s.requestId, excess: "5000", state: "OPEN" }]);
    }
    // the liability first: the admission's and the edge's COMMITs wait on the gate FOR UPDATE and are refused once the liability commits
    {
      const pool = await freshPool(env);
      const settler = await interpretingRun(env, "l05b-u-post", pool);
      const other = await interpretingRun(env, "l05b-u-other", pool);
      const s = await admit(env, settler, 245_000n);
      await answered(s, "25");
      const edge = await admit(env, other, 50_000n);
      const adm = admissionOf(other, 50_000n);
      await holder!.query("BEGIN");
      await bindCommerce(holder!, service(settler.ag.agencyId));
      await holder!.query("SELECT 1 FROM kauro.pool_liability_gates WHERE pool_grant_id = $1 FOR UPDATE", [pool]);
      await rawStore(holder!).reconcileRequestMicros(s.requestId, 250_000n);
      const admWaiting = await mustWait(env.h.oracle, { waiter: w1!, holder: connectionPid(holder!) }, (c) => unit(c, other.ag.agencyId, (cc) => admitWith(rawStore(cc), adm)), "the admission's COMMIT behind the liability's gate");
      const edgeWaiting = await mustWait(env.h.oracle, { waiter: w2!, holder: connectionPid(holder!) }, (c) => unit(c, other.ag.agencyId, (cc) => rawJournal(cc).markDispatching(edge.requestId, 1, "provider-l05b-u", clock.now())), "the edge's COMMIT behind the liability's gate");
      await holder!.query("COMMIT");
      assert.ok(refusedBy("KA083", "pool_liability_open")(rejection(await admWaiting.pending)));
      assert.ok(refusedBy("KA083", "pool_liability_open")(rejection(await edgeWaiting.pending)));
      assert.equal(await requestCount(adm.requestId), 0);
      assert.equal((await requestRow(env, edge.requestId)).state, "RESERVED");
      assert.deepEqual(await money(env, other.grantId), { reserved: 5, spent: 0, state: "AUTHORIZED" });
    }
  });
});

test("L09 RACE (lock order, both orders): an AUDIT grant's close (grant, then pool) and a settlement replay or a late reconciliation with excess on one of its requests (grant, request, then pool) serialize on the grant row; 40P01 never; spend, reserved cents and the liability equal the hand-computed values", async () => {
  await withConnections(env, 2, async ([x, y]) => {
    // (1) the close vs the settlement's replay
    await bothOrders<One>({
      oracle: env.h.oracle,
      actors: [
        { name: "CLOSE", client: x!, begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)), act: (c, st) => closeOn(c, st.run.grantId) },
        { name: "SET", client: y!, begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)), act: (c, st) => rawStore(c).settleDispatch(settlementOf(st.a, "COMMITTED", 245_000n)) },
      ],
      async setup() {
        const pool = await freshPool(env);
        const run = await interpretingRun(env, "l09-replay", pool);
        const a = await admit(env, run, 245_000n);
        await answered(a, "25");
        await settle(a, "COMMITTED", 245_000n);
        await journal(a, (j) => j.markConsumed(a.requestId, 1, clock.now()));
        await cancel(run);
        return { pool, run, a };
      },
      async verify({ state, outcomes }) {
        assert.equal(outcomes["CLOSE"]?.committed, true);
        assert.equal(outcomes["SET"]?.committed, true);
        assert.equal(valueOf<{ kind: string }>(outcomes["SET"]?.act).kind, "REPLAYED");
        assert.deepEqual(await money(env, state.run.grantId), { reserved: 0, spent: 25, state: "CLOSED" });
        assert.deepEqual(await money(env, state.pool), { reserved: 0, spent: 25, state: "AUTHORIZED" }, "the pool's hold released with the final spend");
        assert.deepEqual(await liabilities(env, state.pool), []);
      },
    });
    // (2) GRANT_RECONCILIATION posting excess evidence then closing vs IC's late settlement with excess
    await bothOrders<One>({
      oracle: env.h.oracle,
      actors: [
        {
          name: "REC",
          client: x!,
          begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)),
          act: async (c, st) => {
            await lockGrantRow(c, st.run.grantId);
            await rawStore(c).reconcileRequestMicros(st.a.requestId, 250_000n);
            return closeOn(c, st.run.grantId);
          },
        },
        { name: "SET", client: y!, begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)), act: (c, st) => rawStore(c).settleDispatch(settlementOf(st.a, "COMMITTED", 250_000n)) },
      ],
      async setup() {
        const pool = await freshPool(env);
        const run = await interpretingRun(env, "l09-late", pool);
        const a = await admit(env, run, 245_000n);
        await answered(a, "25");
        await journal(a, (j) => j.markConsumed(a.requestId, 1, clock.now()));
        await cancel(run);
        return { pool, run, a };
      },
      async verify({ order, state, outcomes }) {
        assert.equal(outcomes["REC"]?.committed, true);
        assert.equal(outcomes["SET"]?.committed, true);
        assert.equal(valueOf<{ kind: string }>(outcomes["SET"]?.act).kind, order[0] === "REC" ? "REPLAYED" : "RECORDED");
        assert.deepEqual(await money(env, state.run.grantId), { reserved: 0, spent: 25, state: "CLOSED" });
        assert.deepEqual(await money(env, state.pool), { reserved: 0, spent: 25, state: "AUTHORIZED" });
        assert.deepEqual(await liabilities(env, state.pool), [{ request_id: state.a.requestId, excess: "5000", state: "OPEN" }]);
      },
    });
  });
});

test("L10 RACE (lock order, both orders): an admission (beginDispatch, store.ts:501-539) on an AUDIT grant that read INTERPRETING (audit share, lease, grant; gate at COMMIT) and that grant's close or a StartAudit carve from its pool never deadlock; an admission after the close is refused NO_FUNDED_GRANT", async () => {
  // An AUDIT grant whose audit is INTERPRETING cannot be CLOSED (0023 cost_grants_workflow: no live audit); the edge that ends it under
  // that audit is GRANT_RECONCILIATION's EXPIRED, on a clock past the grant's expiry.
  await withConnections(env, 2, async ([x, y]) => {
    await bothOrders<One & { expiresAt: Date }>({
      oracle: env.h.oracle,
      actors: [
        { name: "ADM", client: x!, begin: (c, st) => bindCommerce(c, service(st.run.ag.agencyId)), act: (c, st) => admitWith(rawStore(c), st.a) },
        {
          name: "END",
          client: y!,
          begin: async (c, st) => {
            await bindCommerce(c, service(st.run.ag.agencyId));
            await clockAt(c, new Date(st.expiresAt.getTime() + 60_000));
          },
          act: (c, st) => closeOn(c, st.run.grantId, "EXPIRED"),
        },
      ],
      async setup() {
        const pool = await freshPool(env);
        const run = await interpretingRun(env, "l10", pool);
        const expiresAt = (await env.h.oracle.query("SELECT expires_at FROM kauro.cost_grants WHERE grant_id = $1", [run.grantId])).rows[0].expires_at as Date;
        return { pool, run, a: admissionOf(run, 50_000n), expiresAt };
      },
      async verify({ order, state, outcomes }) {
        assert.equal(outcomes["END"]?.committed, true, "the grant's end commits in both orders");
        if (order[0] === "ADM") {
          assert.equal(outcomes["ADM"]?.committed, true);
          assert.deepEqual(await money(env, state.run.grantId), { reserved: 5, spent: 0, state: "EXPIRED" });
        } else {
          const e = rejection(outcomes["ADM"]?.act);
          assert.deepEqual(failureOf(e), ["BUDGET_EXHAUSTED", "NO_FUNDED_GRANT"], "behind the grant's end: no funded grant");
          assert.equal(await requestCount(state.a.requestId), 0);
          assert.deepEqual(await money(env, state.run.grantId), { reserved: 0, spent: 0, state: "EXPIRED" });
        }
        // an admission after the end is refused NO_FUNDED_GRANT
        const late = admissionOf(state.run, 50_000n);
        await assert.rejects(env.h.audit.run(controlOf(state.run.ag.agencyId), (uow) => admitWith(uow.audits as never, late)), (e: unknown) => failureOf(e)[1] === "NO_FUNDED_GRANT");
      },
    });
  });
  // the admission and a StartAudit carve from its pool: no wait between them (the admission takes no pool row, the carve no grant of it)
  await withConnections(env, 1, async ([holder]) => {
    await withConnections(
      env,
      1,
      async ([carver]) => {
        const pool = await freshPool(env);
        const run = await interpretingRun(env, "l10-carve", pool);
        const prepared = await preparedAudit(env, "l10-carver");
        const a = admissionOf(run, 50_000n);
        await holder!.query("BEGIN");
        await bindCommerce(holder!, service(run.ag.agencyId));
        assert.equal((await admitWith(rawStore(holder!), a)).kind, "RESERVED");
        const carve = await settlesOrWaits(
          env.h.oracle,
          connectionPid(carver!),
          unit(carver!, null, async (c) => {
            await bindCommerce(c, { agencyId: prepared.ag.agencyId, userId: prepared.ag.ownerUserId });
            return rawStore(c, { kind: "USER", userId: prepared.ag.ownerUserId }).startAudit(prepared.input);
          }),
          "a StartAudit carve while an admission on the pool is open",
        );
        assert.equal(carve.kind, "SETTLED", "the carve does not wait on the admission");
        assert.equal(carve.kind === "SETTLED" ? valueOf<{ pool: { grantId: string } }>(carve.outcome).pool.grantId : null, pool);
        await holder!.query("COMMIT");
        assert.deepEqual(await money(env, run.grantId), { reserved: 5, spent: 0, state: "AUTHORIZED" });
      },
      "kauro_app_test",
    );
  });
});

test("L12 [NON-REGRESSION] RACE (hot row bound): settlements and admissions take no pool row lock: with a settlement without excess held at a named FaultPoint before COMMIT, admissions on other grants of the pool and a StartAudit carve complete without waiting; only a liability takes the gate FOR UPDATE, at COMMIT, and admissions share it", async () => {
  const pool = await freshPool(env);
  const runA = await interpretingRun(env, "l12-a", pool);
  const runB = await interpretingRun(env, "l12-b", pool);
  const s = await admit(env, runA, 245_000n);
  await answered(s, "24");
  const points = new FaultPoints();
  const factory = crashableFactory(env.h.audit, points, "l12-set");
  const pause = points.pause("l12-set.before-commit");
  const settling = factory.run(controlOf(runA.ag.agencyId), (uow) => uow.audits.settleDispatch(settlementOf(s, "COMMITTED", 240_000n)));
  await pause.reachedBy(settling);
  await withConnections(env, 1, async ([c1]) => {
    const b = admissionOf(runB, 50_000n);
    const adm = await settlesOrWaits(env.h.oracle, connectionPid(c1!), unit(c1!, runB.ag.agencyId, (c) => admitWith(rawStore(c), b)), "an admission on another grant of the pool");
    assert.equal(adm.kind, "SETTLED", "the admission does not wait on the settlement");
    assert.equal(adm.kind === "SETTLED" ? valueOf<{ kind: string }>(adm.outcome).kind : null, "RESERVED");
  });
  await withConnections(
    env,
    1,
    async ([c2]) => {
      const prepared = await preparedAudit(env, "l12-carver");
      const carve = await settlesOrWaits(
        env.h.oracle,
        connectionPid(c2!),
        unit(c2!, null, async (c) => {
          await bindCommerce(c, { agencyId: prepared.ag.agencyId, userId: prepared.ag.ownerUserId });
          return rawStore(c, { kind: "USER", userId: prepared.ag.ownerUserId }).startAudit(prepared.input);
        }),
        "a StartAudit carve from the pool",
      );
      assert.equal(carve.kind, "SETTLED", "the carve does not wait on the settlement");
    },
    "kauro_app_test",
  );
  pause.release();
  const out = await settling;
  assert.deepEqual(out.kind === "RECORDED" ? [out.recorded, out.liabilityMicros] : [out.kind], ["COMMITTED", 0n]);
  assert.deepEqual(await liabilities(env, pool), []);
  // only a liability takes the gate FOR UPDATE: with the gate shared (SIMULATED holder, FOR KEY SHARE), an admission's COMMIT completes
  // and a settlement with excess waits for the share
  await withConnections(env, 3, async ([holder, c3, c4]) => {
    const t = await admit(env, runA, 50_000n);
    await answered(t, "5");
    await holder!.query("BEGIN");
    await bindCommerce(holder!, service(runB.ag.agencyId));
    await holder!.query("SELECT 1 FROM kauro.pool_liability_gates WHERE pool_grant_id = $1 FOR KEY SHARE", [pool]);
    const b2 = admissionOf(runB, 50_000n);
    const adm2 = await settlesOrWaits(env.h.oracle, connectionPid(c3!), unit(c3!, runB.ag.agencyId, (c) => admitWith(rawStore(c), b2)), "an admission's COMMIT while the gate is shared");
    assert.equal(adm2.kind, "SETTLED", "admissions share the gate");
    const excess = await settlesOrWaits(env.h.oracle, connectionPid(c4!), unit(c4!, runA.ag.agencyId, (c) => rawStore(c).settleDispatch(settlementOf(t, "COMMITTED", 50_001n))), "a settlement with excess while the gate is shared");
    assert.equal(excess.kind, "WAITING", "a liability takes the gate FOR UPDATE at COMMIT");
    await holder!.query("COMMIT");
    if (excess.kind === "WAITING") assert.equal((await excess.pending).status, "fulfilled");
    assert.deepEqual(await liabilities(env, pool), [{ request_id: t.requestId, excess: "1", state: "OPEN" }]);
  });
});

test("L13 RACE (four-party ring): an admission holding its audit share and waiting on the grant, GRANT_RECONCILIATION holding the grant and waiting on a request, markDispatching on that request and a cancellation queued on the audit complete in every order without 40P01, markDispatching taking the audit share and then the MODEL_TASK lease share before the request row", async () => {
  const ring = async (tag: string) => {
    const pool = await freshPool(env);
    const run = await interpretingRun(env, tag, pool);
    const q = await admit(env, run, 50_000n);
    // the second task of the audit, planned (its admission is the ring's beginDispatch)
    const t2 = admissionOf(run, 50_000n);
    await env.h.audit.run(controlOf(run.ag.agencyId), (uow) =>
      uow.audits.createModelTask({ modelTaskId: t2.taskId, auditId: run.auditId as never, stepFence: run.stepFence, taskKey: sha(`task-${t2.core.reservationId}`), candidateManifestHash: run.candidateManifestHash, policyHash: sha("model-policy"), minimizedRequestHash: sha(`minimized-${t2.core.reservationId}`), providerProfileId: t2.requestId as never, maximumCostCents: 40n }),
    );
    return { pool, run, q, t2 };
  };
  const begin2 = (c: Client, t2: Admission) => rawStore(c).beginDispatch(t2.taskId, { requestId: t2.requestId, ownerId: t2.owner, requestHash: sha(`request-${t2.core.reservationId}`), reservedCents: t2.reservedCents, stepFence: t2.run.stepFence, core: t2.core });
  const recPass = (run: Run, q: Admission) => async (c: Client) => {
    await lockGrantRow(c, run.grantId);
    await c.query("SELECT 1 FROM kauro.request_journal WHERE request_id = $1 FOR UPDATE", [q.requestId]);
    return rawStore(c).markStaleDispatchUncertain(q.requestId);
  };
  const cancelUnit = (run: Run) => async (c: Client) => {
    await bindCommerce(c, { agencyId: run.ag.agencyId, userId: run.ag.ownerUserId });
    return rawStore(c, { kind: "USER", userId: run.ag.ownerUserId }).cancelAudit(run.auditId as never, 3, { actor: { kind: "USER", userId: run.ag.ownerUserId as never }, reasonCode: "AGENCY_CANCELLED" });
  };
  const no40P01 = (o: PromiseSettledResult<unknown>) => assert.ok(o.status === "fulfilled" || pgErr(o.reason).code !== "40P01", "never a deadlock");
  await withConnections(env, 3, async ([e, r, m]) => {
    await withConnections(
      env,
      1,
      async ([k]) => {
        // order 1: the edge holds the request row; the reconciler waits on it holding the grant; the admission waits on the grant holding
        // the audit share; the cancellation queues behind both shares. The edge waits on nothing a waiter holds.
        {
          const { run, q, t2 } = await ring("l13-edge-first");
          await e!.query("BEGIN");
          await bindCommerce(e!, service(run.ag.agencyId));
          assert.equal((await rawJournal(e!).markDispatching(q.requestId, 1, "provider-l13", clock.now()))?.state, "DISPATCHING");
          const rec = await mustWait(env.h.oracle, { waiter: r!, holder: connectionPid(e!) }, (c) => unit(c, run.ag.agencyId, recPass(run, q)), "the reconciler on the request row");
          const adm = await mustWait(env.h.oracle, { waiter: m!, holder: connectionPid(r!) }, (c) => unit(c, run.ag.agencyId, (cc) => begin2(cc, t2)), "the admission on the grant");
          const can = await mustWait(env.h.oracle, { waiter: k!, holder: connectionPid(e!) }, (c) => unit(c, null, cancelUnit(run)), "the cancellation on the audit");
          await e!.query("COMMIT");
          const outs = [await rec.pending, await adm.pending, await can.pending];
          outs.forEach(no40P01);
          assert.equal(valueOf<boolean>(outs[0]), false, "a live owner's in-time DISPATCHING request is not moved");
          assert.equal(valueOf<{ kind: string }>(outs[1]).kind, "RESERVED");
          assert.equal(valueOf<{ kind: string }>(outs[2]).kind, "APPLIED");
          assert.deepEqual([(await requestRow(env, q.requestId)).state, (await requestRow(env, t2.requestId)).state], ["DISPATCHING", "RESERVED"]);
        }
        // order 2: the cancellation holds the audit first; the edge and the admission wait on it; the reconciler waits on nothing
        {
          const { run, q, t2 } = await ring("l13-cancel-first");
          await k!.query("BEGIN");
          assert.equal((await cancelUnit(run)(k!)).kind, "APPLIED");
          const edge = await mustWait(env.h.oracle, { waiter: e!, holder: connectionPid(k!) }, (c) => unit(c, run.ag.agencyId, (cc) => rawJournal(cc).markDispatching(q.requestId, 1, "provider-l13", clock.now())), "the edge on the audit share");
          const adm = await mustWait(env.h.oracle, { waiter: m!, holder: connectionPid(k!) }, (c) => unit(c, run.ag.agencyId, (cc) => begin2(cc, t2)), "the admission on the audit share");
          const rec = await settlesOrWaits(env.h.oracle, connectionPid(r!), unit(r!, run.ag.agencyId, recPass(run, q)), "the reconciler");
          assert.equal(rec.kind, "SETTLED", "the reconciler takes no audit lock");
          await k!.query("COMMIT");
          const outs = [await edge.pending, await adm.pending];
          outs.forEach(no40P01);
          assert.equal(failureOf(rejection(outs[0]))[1], "EXECUTION_AUTHORITY_LOST", "the edge after the cancellation sends nothing");
          assert.equal(failureOf(rejection(outs[1]))[1], "EXECUTION_AUTHORITY_LOST", "the admission after the cancellation reserves nothing");
          assert.equal((await requestRow(env, q.requestId)).state, "RESERVED");
          assert.equal(await requestCount(t2.requestId), 0);
        }
      },
      "kauro_app_test",
    );
  });
});

test("L16 DENY gate scope: a transaction whose gate events name two pools, or one pool in both modes (a reservation or a DISPATCHING edge and a liability), or whose second event finds exactly one of the two gate settings set (the other reset to ''), is refused KA006 pool_liability_gate_scope (INTEGRITY_FAILURE COMMITMENT_ISOLATION) in that event's statement before any gate lock is requested and commits nothing; an admission, a settlement and a GRANT_RECONCILIATION unit each take one gate in one mode", async () => {
  const scope = (e: unknown) => failureOf(e)[0] === "INTEGRITY_FAILURE" && failureOf(e)[1] === "COMMITMENT_ISOLATION" && refusedBy("KA006", "pool_liability_gate_scope")(e);
  const P = await freshPool(env);
  const runP = await interpretingRun(env, "l16-p", P);
  const Q = await freshPool(env);
  const runQ = await interpretingRun(env, "l16-q", Q);
  const gateLocks = async (pid: number): Promise<number> =>
    (await env.h.oracle.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND relation = 'kauro.pool_liability_gates'::regclass", [pid])).rows[0].n;
  await withConnections(env, 1, async ([c]) => {
    const refusedIn = async (label: string, first: (c: Client) => Promise<unknown>, second: (c: Client) => Promise<unknown>, written: string[]) => {
      await c!.query("BEGIN");
      try {
        await bindCommerce(c!, service(runP.ag.agencyId));
        await first(c!);
        await assert.rejects(second(c!), scope, label);
        assert.equal(await gateLocks(connectionPid(c!)), 0, `${label}: no gate lock requested`);
      } finally {
        await c!.query("ROLLBACK");
      }
      for (const id of written) assert.equal(await requestCount(id), 0, `${label}: nothing committed`);
    };
    // two pools
    const p1 = admissionOf(runP, 50_000n);
    const q1 = admissionOf(runQ, 50_000n);
    await refusedIn("two pools", (cc) => admitWith(rawStore(cc), p1), async (cc) => {
      await bindCommerce(cc, service(runQ.ag.agencyId));
      return admitWith(rawStore(cc), q1);
    }, [p1.requestId, q1.requestId]);
    // one pool in both modes: a reservation then a liability, a liability then a reservation, an edge then a liability
    const s = await admit(env, runP, 245_000n);
    await answered(s, "25");
    const p2 = admissionOf(runP, 50_000n);
    await refusedIn("reservation, then liability", (cc) => admitWith(rawStore(cc), p2), (cc) => rawStore(cc).settleDispatch(settlementOf(s, "COMMITTED", 250_000n)), [p2.requestId]);
    const p3 = admissionOf(runP, 50_000n);
    await refusedIn("liability, then reservation", (cc) => rawStore(cc).reconcileRequestMicros(s.requestId, 250_000n), (cc) => admitWith(rawStore(cc), p3), [p3.requestId]);
    const e = await admit(env, runP, 50_000n);
    await refusedIn("edge, then liability", (cc) => rawJournal(cc).markDispatching(e.requestId, 1, "provider-l16", clock.now()), (cc) => rawStore(cc).settleDispatch(settlementOf(s, "COMMITTED", 250_000n)), []);
    await refusedIn("liability, then edge", (cc) => rawStore(cc).reconcileRequestMicros(s.requestId, 250_000n), (cc) => rawJournal(cc).markDispatching(e.requestId, 1, "provider-l16", clock.now()), []);
    assert.equal((await requestRow(env, e.requestId)).state, "RESERVED");
    // exactly one of the two settings set at the second event
    for (const reset of ["kauro.liability_gate_mode", "kauro.liability_gate_pool"]) {
      const p4 = admissionOf(runP, 50_000n);
      const p5 = admissionOf(runP, 50_000n);
      await refusedIn(`${reset} reset to ''`, async (cc) => {
        await admitWith(rawStore(cc), p4);
        await cc.query("SELECT set_config($1, '', true)", [reset]);
      }, (cc) => admitWith(rawStore(cc), p5), [p4.requestId, p5.requestId]);
    }
    assert.deepEqual(await liabilities(env, P), []);
    assert.deepEqual(await requestRow(env, s.requestId), { state: "RESPONSE_STORED", usage: "KNOWN", actual: 25, settlement: null, charge: null, evidence: null });
    // each product unit takes one gate in one mode
    const p6 = admissionOf(runP, 50_000n);
    assert.deepEqual(await unit(c!, runP.ag.agencyId, async (cc) => (await admitWith(rawStore(cc), p6), gateSetting(cc))), { pool: P, mode: "KEY_SHARE" }, "an admission");
    assert.deepEqual(await unit(c!, runP.ag.agencyId, async (cc) => (await rawStore(cc).settleDispatch(settlementOf(s, "COMMITTED", 250_000n)), gateSetting(cc))), { pool: P, mode: "UPDATE" }, "a settlement with excess");
    const r = await admit(env, runQ, 245_000n);
    await answered(r, "25");
    assert.deepEqual(await unit(c!, runQ.ag.agencyId, async (cc) => (await lockGrantRow(cc, runQ.grantId), await rawStore(cc).reconcileRequestMicros(r.requestId, 250_000n), gateSetting(cc))), { pool: Q, mode: "UPDATE" }, "a GRANT_RECONCILIATION posting with excess");
  });
});

test("L16b RACE (pooled connection reuse): two consecutive gate units on one pooled connection both commit (an admission on pool P, then a settlement with excess on P; and two admissions, on P and then on pool Q): a gate setting left '' by the first transaction reads as missing in the second, which registers its own pool and mode", async () => {
  await withConnections(env, 1, async ([c]) => {
    const raw = async (sql: string) => (await c!.query(sql)).rows[0];
    {
      const P = await freshPool(env);
      const run = await interpretingRun(env, "l16b-p", P);
      const s = await admit(env, run, 245_000n);
      await answered(s, "25");
      const a = admissionOf(run, 50_000n);
      assert.deepEqual(await unit(c!, run.ag.agencyId, async (cc) => (await admitWith(rawStore(cc), a), gateSetting(cc))), { pool: P, mode: "KEY_SHARE" });
      // the first transaction's settings are left '' on the connection, not unset
      assert.deepEqual(await raw("SELECT current_setting('kauro.liability_gate_pool', true) AS pool, current_setting('kauro.liability_gate_mode', true) AS mode"), { pool: "", mode: "" });
      const out = await unit(c!, run.ag.agencyId, async (cc) => {
        assert.deepEqual(await gateSetting(cc), { pool: null, mode: null }, "'' reads as missing");
        const o = await rawStore(cc).settleDispatch(settlementOf(s, "COMMITTED", 250_000n));
        assert.deepEqual(await gateSetting(cc), { pool: P, mode: "UPDATE" });
        return o;
      });
      assert.equal(out.kind === "RECORDED" ? out.liabilityMicros : out.kind, 5_000n);
      assert.equal((await requestRow(env, a.requestId)).state, "RESERVED");
    }
    {
      const P = await freshPool(env);
      const runP = await interpretingRun(env, "l16b-p2", P);
      const Q = await freshPool(env);
      const runQ = await interpretingRun(env, "l16b-q", Q);
      const a = admissionOf(runP, 50_000n);
      const b = admissionOf(runQ, 50_000n);
      assert.equal((await unit(c!, runP.ag.agencyId, (cc) => admitWith(rawStore(cc), a))).kind, "RESERVED");
      assert.deepEqual(await unit(c!, runQ.ag.agencyId, async (cc) => (await admitWith(rawStore(cc), b), gateSetting(cc))), { pool: Q, mode: "KEY_SHARE" });
      assert.deepEqual([(await requestRow(env, a.requestId)).state, (await requestRow(env, b.requestId)).state], ["RESERVED", "RESERVED"]);
    }
  });
});

test("L16c DENY gate absent (forged, rule 12): with the pool's gate row deleted by the migration owner, a reservation (beginDispatch), a markDispatching edge and a settlement with excess on that pool are each refused KA006 pool_liability_gate_absent (INTEGRITY_FAILURE LIFECYCLE_BINDING_MISSING) at COMMIT with nothing reserved, sent or posted and no liability; the settlement's request keeps its reservation with usage UNKNOWN, a GRANT_RECONCILIATION run records the same refusal as a sweep failure and moves nothing; with the row restored each commits", async () => {
  const absent = (e: unknown) => failureOf(e)[0] === "INTEGRITY_FAILURE" && failureOf(e)[1] === "LIFECYCLE_BINDING_MISSING" && refusedBy("KA006", "pool_liability_gate_absent")(e);
  const P = await freshPool(env);
  const run = await interpretingRun(env, "l16c", P);
  const edge = await admit(env, run, 50_000n);
  const s = await admit(env, run, 245_000n);
  await dispatch(env, s);
  await journal(s, (j) => j.storeResponse(s.requestId, 1, sha("l16c-response"), { usageState: "UNKNOWN" }, clock.now()));
  const owner = await env.h.pg.connect("kauro_owner");
  const asOwner = async (sql: string) => {
    await owner.query("BEGIN");
    await owner.query("ALTER TABLE kauro.pool_liability_gates NO FORCE ROW LEVEL SECURITY");
    await owner.query(sql, [P]);
    await owner.query("ALTER TABLE kauro.pool_liability_gates FORCE ROW LEVEL SECURITY");
    await owner.query("COMMIT");
  };
  try {
    await asOwner("DELETE FROM kauro.pool_liability_gates WHERE pool_grant_id = $1");
    const before = await money(env, run.grantId);
    const a = admissionOf(run, 50_000n);
    await assert.rejects(env.h.audit.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, a)), absent, "a reservation");
    assert.equal(await requestCount(a.requestId), 0);
    await assert.rejects(journal(edge, (j) => j.markDispatching(edge.requestId, 1, "provider-l16c", clock.now())), absent, "an edge");
    assert.equal((await requestRow(env, edge.requestId)).state, "RESERVED");
    await assert.rejects(settle(s, "COMMITTED", 250_000n), absent, "a settlement with excess");
    assert.deepEqual(await requestRow(env, s.requestId), { state: "RESPONSE_STORED", usage: "UNKNOWN", actual: null, settlement: null, charge: null, evidence: null }, "the reservation kept, usage UNKNOWN");
    // the reconciler's posting of the same evidence is refused the same way (apps/control records it as a sweep failure: GDR L16c)
    await assert.rejects(env.h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.reconcileRequestMicros(s.requestId, 250_000n)), absent, "a GRANT_RECONCILIATION posting");
    assert.deepEqual(await money(env, run.grantId), before, "nothing reserved or posted");
    assert.deepEqual(await liabilities(env, P), []);
    // restored: each commits
    await asOwner("INSERT INTO kauro.pool_liability_gates (pool_grant_id) VALUES ($1)");
    assert.equal((await env.h.audit.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, a))).kind, "RESERVED");
    assert.equal((await journal(edge, (j) => j.markDispatching(edge.requestId, 1, "provider-l16c", clock.now())))?.state, "DISPATCHING");
    const out = await settle(s, "COMMITTED", 250_000n);
    assert.equal(out.kind === "RECORDED" ? out.liabilityMicros : out.kind, 5_000n);
    assert.deepEqual(await liabilities(env, P), [{ request_id: s.requestId, excess: "5000", state: "OPEN" }]);
  } finally {
    await owner.end();
  }
});

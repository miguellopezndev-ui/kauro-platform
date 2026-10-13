// B05 dispatch settlement, liabilities and the pool liability gate (lane L3m, LDG titles; docs/design/B05-cores.md D5-11, D5-18,
// D5-19, D5-19b, LOCK-B05-1; migration 0059 provisional): the admission of a core reservation through beginDispatch, its settlement
// (settleDispatch), GRANT_RECONCILIATION's micros evidence (reconcileRequestMicros), the journal's send and response edges, and the
// pool's liability gate taken at COMMIT, on real PostgreSQL 17 through the control plane's login. Every interleaving is fixed by a
// FaultPoint or an open transaction and the other side's lock wait observed in pg_stat_activity (mustWait), never by a sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, type RequestId } from "@kauro/domain";
import { FaultPoints, crashableFactory, crashedAt, mustWait, openConnection } from "../src/testing/index.js";
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
  openDispatchEnv,
  rawStore,
  requestRow,
  settlementOf,
  type Admission,
  type DispatchEnv,
  type Run,
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

// mustWait and openConnection are used by the race titles below
void mustWait;
void openConnection;

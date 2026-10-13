// B05 dispatch settlement, liabilities and the pool liability gate (lane L3m, LDG titles; docs/design/B05-cores.md D5-11, D5-18,
// D5-19, D5-19b, LOCK-B05-1; migration 0061 provisional): the admission of a core reservation through beginDispatch, its settlement
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
import { clock, ids, sha, sqlState } from "./support.js";

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
    if (state === "RELEASED" || state === "CANCELLED") {
      // IC's RELEASED leaves the row RESERVED (S09); GRANT_RECONCILIATION's cancel at its fence then makes it CANCELLED
      await settle(a, "RELEASED", 0n);
      if (state === "CANCELLED") await journal(a, (j) => j.markCancelled(a.requestId, 1, clock.now()));
      return a;
    }
    await dispatch(env, a);
    if (state === "UNCERTAIN") await journal(a, (j) => j.markUncertain(a.requestId, 1, clock.now()));
    if (state === "RESPONSE_STORED") await journal(a, (j) => j.storeResponse(a.requestId, 1, sha(`s08-${a.requestId}`), { usageState: "KNOWN", actualCents: "1" as never }, clock.now()));
    if (state === "FAILED") await journal(a, (j) => j.markFailed(a.requestId, 1, clock.now()));
    return a;
  };
  // and a RESERVED request its core already RELEASED (S09: it stays RESERVED, settled): no edge either
  const rows = new Map<string, Admission>();
  for (const s of ["DISPATCHING", "UNCERTAIN", "RESPONSE_STORED", "FAILED", "CANCELLED", "RELEASED"]) rows.set(s, await at(s));
  for (const [s, a] of rows) {
    const state = s === "RELEASED" ? "RESERVED" : s;
    assert.equal((await requestRow(env, a.requestId)).state, state);
    assert.equal(await journal(a, (j) => j.markDispatching(a.requestId, 1, "provider-again", clock.now())), null, `markDispatching on ${s} returns null`);
    assert.equal((await requestRow(env, a.requestId)).state, state, `${s} unchanged`);
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
  await journal(cancelled, (j) => j.markCancelled(cancelled.requestId, 1, clock.now()));
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

// --- PORT-CONTRACT reservations (PgRequestJournal.reserve; no product caller names an upstream or funds from the pool) ---------------

/** A reservation of a task that is no model task, funded by `grantId`, naming `upstreams` (PgRequestJournal.reserve). */
function portReservation(agencyId: string, grantId: string, cents: number, upstreams: ReadonlyArray<RequestId>) {
  return { requestId: ids.next() as RequestId, taskId: ids.next() as never, agencyId: agencyId as never, requestHash: sha(`port-${grantId}-${cents}-${ids.next()}`), fence: 1, reservedCents: String(cents) as never, costGrantId: grantId, upstreamRequestIds: upstreams, reservedAt: clock.now() };
}

/** A CONSUMED port request funded by `grantId` (reserved, sent, answered with known usage, consumed). */
async function consumedPort(agencyId: string, grantId: string, cents = 40): Promise<RequestId> {
  return env.h.audit.run(controlOf(agencyId), async (uow) => {
    const r = portReservation(agencyId, grantId, cents, []);
    await uow.requestJournal.reserve(r);
    await uow.requestJournal.markDispatching(r.requestId, 1, null, clock.now());
    await uow.requestJournal.storeResponse(r.requestId, 1, sha(`port-response-${r.requestId}`), { usageState: "KNOWN", actualCents: "30" as never }, clock.now());
    assert.equal((await uow.requestJournal.markConsumed(r.requestId, 1, clock.now()))?.state, "CONSUMED");
    return r.requestId;
  });
}

/** A core admission of `run` answered with known usage and consumed (an upstream a dependent may name). */
async function consumedCore(run: Run, maxChargeMicros: bigint, cents: string): Promise<Admission> {
  const a = await admit(env, run, maxChargeMicros);
  await answered(a, cents);
  await journal(a, (j) => j.markConsumed(a.requestId, 1, clock.now()));
  return a;
}

/** Two AUDIT grants of one agency on one pool: the first audit (G1's) cancelled after `before` ran on it, the second INTERPRETING. */
async function twoGrants(tag: string, pool: string, before: (run: Run) => Promise<Admission>): Promise<{ first: Run; second: Run; u: Admission }> {
  const first = await interpretingRun(env, `${tag}-first`, pool);
  const u = await before(first);
  await cancel(first);
  const second = await interpretingRun(env, `${tag}-second`, pool, first.ag);
  return { first, second, u };
}

const unresolved = (e: unknown) => failureOf(e)[0] === "PRECONDITION_FAILED" && failureOf(e)[1] === "UPSTREAM_UNRESOLVED" && refusedBy("KA009")(e);

test("L11 [PORT-CONTRACT: PgRequestJournal.reserve; no product caller, beginDispatch store.ts:527-536 funds only from the AUDIT grant] RACE (pool-funded reservations): two concurrent PgRequestJournal.reserve calls on requests funded directly by the pool take its row FOR UPDATE at the grant position before their same-grant upstreams and never upgrade a lower lock; one waits, both land within the ceiling, 40P01 never", async () => {
  const agency = await env.h.createAgency(await env.h.person("l11-owner"), "l11");
  await withConnections(env, 2, async ([x, y]) => {
    await bothOrders<{ pool: string; u1: RequestId; u2: RequestId }>({
      oracle: env.h.oracle,
      actors: [
        { name: "D1", client: x!, begin: (c) => bindCommerce(c, service(agency.agencyId)), act: (c, st) => rawJournal(c).reserve(portReservation(agency.agencyId, st.pool, 90, [st.u1, st.u2])) },
        { name: "D2", client: y!, begin: (c) => bindCommerce(c, service(agency.agencyId)), act: (c, st) => rawJournal(c).reserve(portReservation(agency.agencyId, st.pool, 90, [st.u2, st.u1])) },
      ],
      async setup() {
        const pool = await freshPool(env, 300n);
        return { pool, u1: await consumedPort(agency.agencyId, pool), u2: await consumedPort(agency.agencyId, pool) };
      },
      async verify({ state, outcomes }) {
        assert.equal(outcomes["D1"]?.committed, true);
        assert.equal(outcomes["D2"]?.committed, true);
        // 40 + 40 held by the upstreams, 90 + 90 by the dependents: 260 within the 300 ceiling
        assert.deepEqual(await money(env, state.pool), { reserved: 260, spent: 0, state: "AUTHORIZED" });
      },
    });
  });
  // a third that would pass the ceiling is refused, whichever order
  const pool = await freshPool(env, 200n);
  const u = await consumedPort(agency.agencyId, pool, 100);
  await env.h.audit.run(controlOf(agency.agencyId), (uow) => uow.requestJournal.reserve(portReservation(agency.agencyId, pool, 90, [u])));
  await assert.rejects(env.h.audit.run(controlOf(agency.agencyId), (uow) => uow.requestJournal.reserve(portReservation(agency.agencyId, pool, 20, [u]))), (e: unknown) => failureOf(e)[1] === "NO_FUNDED_GRANT");
  assert.deepEqual(await money(env, pool), { reserved: 190, spent: 0, state: "AUTHORIZED" });
});

test("L14 [NON-REGRESSION: same-grant orders serialize on the funding grant under r4's rules too; PORT-CONTRACT: the dependents are PgRequestJournal.reserve calls naming upstreams, no product caller, store.ts:535 passes []] RACE (pool/upstream ring, both orders): with same-agency grants G1 and G2 on pool P and a CONSUMED upstream U funded by G1, an excess settlement of U held after its request lock and a dependent reservation on G1 naming U held after its grant lock, the same with GRANT_RECONCILIATION posting the excess, and a pool-funded dependent on P naming a P-funded upstream, complete without 40P01; Codex r3's setup (U funded by G2, dependent on G1) is refused KA009 without waiting; ledger amounts and the liability equal the hand-computed values and an admission (beginDispatch) committing after the liability is refused NO_FUNDED_GRANT", async () => {
  type S = { pool: string; first: Run; second: Run; u: Admission };
  await withConnections(env, 2, async ([x, y]) => {
    for (const posting of ["SET", "REC"] as const) {
      await bothOrders<S>({
        oracle: env.h.oracle,
        actors: [
          {
            name: posting,
            client: x!,
            begin: (c, st) => bindCommerce(c, service(st.first.ag.agencyId)),
            act: async (c, st) => {
              if (posting === "SET") return rawStore(c).settleDispatch(settlementOf(st.u, "COMMITTED", 250_000n));
              await lockGrantRow(c, st.first.grantId);
              return rawStore(c).reconcileRequestMicros(st.u.requestId, 250_000n);
            },
          },
          { name: "PRT", client: y!, begin: (c, st) => bindCommerce(c, service(st.first.ag.agencyId)), act: (c, st) => rawJournal(c).reserve(portReservation(st.first.ag.agencyId, st.first.grantId, 20, [st.u.requestId])) },
        ],
        async setup() {
          const pool = await freshPool(env);
          const { first, second, u } = await twoGrants(`l14-${posting.toLowerCase()}`, pool, (run) => consumedCore(run, 245_000n, "25"));
          return { pool, first, second, u };
        },
        async verify({ order, state, outcomes }) {
          assert.equal(outcomes[posting]?.committed, true, "the posting commits in both orders");
          if (order[0] === posting) {
            assert.ok(refusedBy("KA083", "pool_liability_open")(rejection(outcomes["PRT"]?.act)), "after the liability the dependent reserves nothing");
            assert.deepEqual(await money(env, state.first.grantId), { reserved: 0, spent: 25, state: "AUTHORIZED" });
          } else {
            assert.equal(outcomes["PRT"]?.committed, true, "the dependent that held the grant first commits");
            assert.deepEqual(await money(env, state.first.grantId), { reserved: 20, spent: 25, state: "AUTHORIZED" });
          }
          for (const o of Object.values(outcomes)) assert.ok(o.act.status === "fulfilled" || pgErr(o.act.reason).code !== "40P01");
          assert.deepEqual(await liabilities(env, state.pool), [{ request_id: state.u.requestId, excess: "5000", state: "OPEN" }]);
          const late = admissionOf(state.second, 50_000n);
          await assert.rejects(env.h.audit.run(controlOf(state.second.ag.agencyId), (uow) => admitWith(uow.audits as never, late)), (e: unknown) => failureOf(e)[1] === "NO_FUNDED_GRANT");
        },
      });
    }
    // a pool-funded dependent on P naming a P-funded upstream V, against the posting of V's usage (both on P first)
    const agency = await env.h.createAgency(await env.h.person("l14-pool-owner"), "l14 pool");
    await bothOrders<{ pool: string; v: RequestId }>({
      oracle: env.h.oracle,
      actors: [
        { name: "REC", client: x!, begin: (c) => bindCommerce(c, service(agency.agencyId)), act: (c, st) => rawStore(c).reconcileRequestMicros(st.v, 300_000n) },
        { name: "PRT", client: y!, begin: (c) => bindCommerce(c, service(agency.agencyId)), act: (c, st) => rawJournal(c).reserve(portReservation(agency.agencyId, st.pool, 20, [st.v])) },
      ],
      async setup() {
        const pool = await freshPool(env, 1_000n);
        return { pool, v: await consumedPort(agency.agencyId, pool, 40) };
      },
      async verify({ state, outcomes }) {
        assert.equal(outcomes["REC"]?.committed, true);
        assert.equal(outcomes["PRT"]?.committed, true);
        // V: 40 reserved -> 30 posted (300,000 micros); the dependent's 20 reserved
        assert.deepEqual(await money(env, state.pool), { reserved: 20, spent: 30, state: "AUTHORIZED" });
        assert.deepEqual(await liabilities(env, state.pool), [], "a request without a core admission owes no liability");
      },
    });
  });
  // Codex r3's setup: U funded by G2, the dependent on G1: refused KA009 without waiting while U's settlement holds G2 and U
  const pool = await freshPool(env);
  const { first, second } = await twoGrants("l14-r3", pool, (run) => consumedCore(run, 245_000n, "25"));
  const u2 = await consumedCore(second, 245_000n, "25");
  await withConnections(env, 2, async ([holder, c]) => {
    await holder!.query("BEGIN");
    await bindCommerce(holder!, service(second.ag.agencyId));
    await rawStore(holder!).settleDispatch(settlementOf(u2, "COMMITTED", 250_000n));
    const d = portReservation(first.ag.agencyId, first.grantId, 20, [u2.requestId]);
    const obs = await settlesOrWaits(env.h.oracle, connectionPid(c!), unit(c!, first.ag.agencyId, (cc) => rawJournal(cc).reserve(d)), "a dependent on G1 naming an upstream of G2");
    assert.equal(obs.kind, "SETTLED", "refused without waiting");
    assert.ok(obs.kind === "SETTLED" && unresolved(rejection(obs.outcome)));
    await holder!.query("COMMIT");
    assert.equal(await requestCount(d.requestId), 0);
  });
});

test("L14a [PORT-CONTRACT: PgRequestJournal.reserve; the dependent D has no product caller] RACE (cross-grant upstream, D15 regression proof, both orders): a dependent reservation funded by pool P (or by G1 on P, Codex r3's setup) naming a CONSUMED upstream U funded by AUDIT grant G2 on P, while GRANT_RECONCILIATION closing G2 (or an excess settlement of U) is held at a FaultPoint after locking U, is refused KA009 before any upstream lock and without waiting; the other transaction then completes (G2 closed through the pool, or the liability committed); no transaction ends 40P01 and ledger amounts equal the hand-computed values", async () => {
  for (const holderKind of ["CLOSE", "SET"] as const) {
    for (const dependentFirst of [false, true]) {
      const pool = await freshPool(env);
      // G2 is the cancelled first audit's grant (U's); G1 the second audit's
      const { first, second, u } = await twoGrants(`l14a-${holderKind.toLowerCase()}`, pool, (run) => consumedCore(run, 250_000n, "25"));
      const g2 = first.grantId;
      const g1 = second.grantId;
      const dependents = [portReservation(first.ag.agencyId, pool, 20, [u.requestId]), portReservation(first.ag.agencyId, g1, 20, [u.requestId])];
      await withConnections(env, 2, async ([holder, c]) => {
        const refuse = async (label: string) => {
          for (const d of dependents) {
            const obs = await settlesOrWaits(env.h.oracle, connectionPid(c!), unit(c!, first.ag.agencyId, (cc) => rawJournal(cc).reserve(d)), `${label}: a dependent naming U of G2`);
            assert.equal(obs.kind, "SETTLED", `${label}: refused without waiting`);
            assert.ok(obs.kind === "SETTLED" && unresolved(rejection(obs.outcome)), `${label}: KA009`);
            assert.equal(await requestCount(d.requestId), 0);
          }
        };
        if (dependentFirst) await refuse("before the holder");
        await holder!.query("BEGIN");
        await bindCommerce(holder!, service(first.ag.agencyId));
        await lockGrantRow(holder!, g2);
        await holder!.query("SELECT 1 FROM kauro.request_journal WHERE request_id = $1 FOR UPDATE", [u.requestId]);
        if (!dependentFirst) await refuse("behind the holder's lock of U");
        if (holderKind === "CLOSE") {
          await rawStore(holder!).reconcileRequestMicros(u.requestId, 250_000n);
          assert.equal((await closeOn(holder!, g2)).kind, "APPLIED");
        } else {
          await rawStore(holder!).settleDispatch(settlementOf(u, "COMMITTED", 260_000n));
        }
        await holder!.query("COMMIT");
      });
      if (holderKind === "CLOSE") {
        assert.deepEqual(await money(env, g2), { reserved: 0, spent: 25, state: "CLOSED" }, "G2 closed through the pool");
        // the pool holds the second audit's 150 and the closed grant's 25 spent
        assert.deepEqual(await money(env, pool), { reserved: 150, spent: 25, state: "AUTHORIZED" });
        assert.deepEqual(await liabilities(env, pool), []);
      } else {
        assert.deepEqual(await money(env, g2), { reserved: 0, spent: 25, state: "AUTHORIZED" });
        assert.deepEqual(await liabilities(env, pool), [{ request_id: u.requestId, excess: "10000", state: "OPEN" }], "the liability committed");
      }
      assert.deepEqual(await money(env, g1), { reserved: 0, spent: 0, state: "AUTHORIZED" });
    }
  }
});

test("L15 [PORT-CONTRACT: PgRequestJournal.reserve; no product caller names an upstream] DENY cross-grant upstream: a reservation naming an upstream funded by another grant (same agency, same pool, or the pool itself) is refused KA009 before any upstream lock and moves no cent, while every same-grant upstream case of S089 still commits", async () => {
  const pool = await freshPool(env);
  const { first, second, u } = await twoGrants("l15", pool, (run) => consumedCore(run, 250_000n, "25"));
  const v = await consumedPort(first.ag.agencyId, pool, 40);
  const same = await consumedCore(second, 100_000n, "10");
  const before = { pool: await money(env, pool), g1: await money(env, second.grantId), g2: await money(env, first.grantId) };
  await withConnections(env, 2, async ([holder, c]) => {
    // the upstreams' rows held FOR UPDATE: a refusal before any upstream lock never waits on them
    await holder!.query("BEGIN");
    await holder!.query("SELECT 1 FROM kauro.request_journal WHERE request_id = ANY ($1::uuid[]) FOR UPDATE", [[u.requestId, v, same.requestId]]);
    const cases: ReadonlyArray<readonly [string, string, RequestId]> = [
      ["G1 naming U of G2 (same agency, same pool)", second.grantId, u.requestId],
      ["G1 naming V of the pool itself", second.grantId, v],
      ["the pool naming U of G2", pool, u.requestId],
      ["G2 naming V of the pool", first.grantId, v],
    ];
    for (const [label, grant, up] of cases) {
      const d = portReservation(first.ag.agencyId, grant, 10, [up]);
      const obs = await settlesOrWaits(env.h.oracle, connectionPid(c!), unit(c!, first.ag.agencyId, (cc) => rawJournal(cc).reserve(d)), label);
      assert.equal(obs.kind, "SETTLED", `${label}: no wait`);
      assert.ok(obs.kind === "SETTLED" && unresolved(rejection(obs.outcome)), `${label}: KA009`);
      assert.equal(await requestCount(d.requestId), 0);
    }
    await holder!.query("ROLLBACK");
  });
  assert.deepEqual({ pool: await money(env, pool), g1: await money(env, second.grantId), g2: await money(env, first.grantId) }, before, "no cent moved");
  // same-grant upstreams still commit (S089: adapters-journals-outbox.test.ts runs unchanged)
  await env.h.audit.run(controlOf(first.ag.agencyId), (uow) => uow.requestJournal.reserve(portReservation(first.ag.agencyId, pool, 10, [v])));
  await env.h.audit.run(controlOf(second.ag.agencyId), (uow) => uow.requestJournal.reserve(portReservation(second.ag.agencyId, second.grantId, 10, [same.requestId])));
  assert.deepEqual((await money(env, second.grantId)).reserved, before.g1.reserved + 10);
});

// --- the commit order (L21), the migration on a live pool (L22) --------------------------------------------------------------------

/** The one product backend paused inside its transaction (a unit of work held at its FaultPoint before COMMIT). */
async function pausedProductPid(): Promise<number> {
  const r = await env.h.oracle.query("SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND application_name IN ('kauro-test-control', 'kauro-test-api') AND pid <> pg_backend_pid()");
  assert.equal(r.rows.length, 1, "exactly one paused product transaction");
  return r.rows[0].pid as number;
}

/** Polls the oracle (bounded) until the database clock shifted by `offsetSeconds` is at or past `instant`. */
async function untilPast(offsetSeconds: number, instant: Date): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await env.h.oracle.query("SELECT clock_timestamp() + make_interval(secs => $1) >= $2::timestamptz + interval '250 milliseconds' AS past", [offsetSeconds, instant]);
    if (r.rows[0].past === true) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`the shifted clock never reached ${instant.toISOString()}`);
}

/** The test clock offset that puts the database clock `beforeMs` before `instant` now. */
const offsetBefore = (instant: Date, beforeMs: number): number => (instant.getTime() - beforeMs - Date.now()) / 1000;
const at = (offsetSeconds: number): Date => new Date(Date.now() + offsetSeconds * 1000);

async function interpretationDeadlineOf(run: Run): Promise<Date> {
  return (await env.h.oracle.query("SELECT interpretation_deadline_at AS at FROM kauro.audits WHERE audit_id = $1", [run.auditId])).rows[0].at as Date;
}

/**
 * A DISPATCHING edge or an admission whose COMMIT waits on the pool's gate (SIMULATED holder FOR UPDATE) across `instant`: the work runs
 * at the clock `beforeMs` before it, the holder rolls back after the instant passed, and the outcome says whether the work itself
 * completed (so a refusal is the COMMIT's).
 */
async function gateWaitAcross(pool: string, agencyId: string, instant: Date, work: (c: Client) => Promise<unknown>): Promise<{ outcome: PromiseSettledResult<unknown>; workDone: boolean }> {
  return withConnections(env, 2, async ([holder, c]) => {
    const offset = offsetBefore(instant, 1_500);
    let workDone = false;
    await holder!.query("BEGIN");
    await holder!.query("SELECT 1 FROM kauro.pool_liability_gates WHERE pool_grant_id = $1 FOR UPDATE", [pool]);
    const waiting = await mustWait(
      env.h.oracle,
      { waiter: c!, holder: connectionPid(holder!) },
      (cc) =>
        unit(
          cc,
          agencyId,
          async (x) => {
            const out = await work(x);
            workDone = true;
            return out;
          },
          at(offset),
        ),
      "the COMMIT behind the gate across the instant",
    );
    await untilPast(offset, instant);
    await holder!.query("ROLLBACK");
    return { outcome: await waiting.pending, workDone };
  });
}

test("L21 DENY commit order (sabotage): request_journal carries exactly two deferred constraint triggers, request_journal_commit_gate_reserve (AFTER INSERT) and request_journal_commit_gate_dispatch (AFTER UPDATE OF state WHEN OLD.state = 'RESERVED' AND NEW.state = 'DISPATCHING'), both executing kauro.request_journal_commit_gate, and dispatch_liabilities exactly one, dispatch_liabilities_commit_gate; each function takes the gate in its first statement, before any liability read or effect_now() judgement; the five gate constraint names are each raised by one clause of the live schema and mapped once in sqlstate.ts; with a test-only body that judges the time before the gate (every effect_now() of the body read once in DECLARE), a DISPATCHING edge whose gate wait (SIMULATED holder) crosses the interpretation deadline commits, and with the shipped body it is refused KA081 with nothing sent", async () => {
  const deferred = async (table: string) =>
    (
      await env.h.oracle.query(
        `SELECT t.tgname AS name, p.proname AS fn, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = $1::regclass AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred ORDER BY t.tgname`,
        [table],
      )
    ).rows as Array<{ name: string; fn: string; def: string }>;
  const rj = await deferred("kauro.request_journal");
  assert.deepEqual(rj.map((t) => [t.name, t.fn]), [
    ["request_journal_commit_gate_dispatch", "request_journal_commit_gate"],
    ["request_journal_commit_gate_reserve", "request_journal_commit_gate"],
  ]);
  assert.match(rj[0]!.def, /AFTER UPDATE OF state ON kauro\.request_journal .*WHEN \(\(\(old\.state = 'RESERVED'::text\) AND \(new\.state = 'DISPATCHING'::text\)\)\)/);
  assert.match(rj[1]!.def, /AFTER INSERT ON kauro\.request_journal /);
  assert.deepEqual((await deferred("kauro.dispatch_liabilities")).map((t) => [t.name, t.fn]), [["dispatch_liabilities_commit_gate", "dispatch_liabilities_commit_gate"]]);
  // the gate in each function's first statement, before any liability read or effect_now()
  for (const [fn, mode] of [["request_journal_commit_gate", "FOR KEY SHARE"], ["dispatch_liabilities_commit_gate", "FOR UPDATE"]] as const) {
    const src = (await env.h.oracle.query("SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'kauro'::regnamespace", [fn])).rows[0].prosrc as string;
    const body = src.slice(src.indexOf("BEGIN") + "BEGIN".length);
    const firstStatement = body.slice(0, body.indexOf(";"));
    assert.ok(firstStatement.includes("kauro.pool_liability_gates") && firstStatement.includes(mode), `${fn}: the first statement takes the gate ${mode}`);
    const after = body.slice(body.indexOf(";"));
    assert.ok(!firstStatement.includes("effect_now") && !firstStatement.includes("dispatch_liabilities d"), `${fn}: nothing judged in the gate statement`);
    if (fn === "request_journal_commit_gate") assert.ok(after.indexOf("dispatch_liabilities") < after.indexOf("effect_now"), "the liability read, then the clock");
  }
  // the five names: raised by the live schema, mapped once
  const live = (await env.h.oracle.query("SELECT string_agg(prosrc, ' ') AS src FROM pg_proc WHERE pronamespace = 'kauro'::regnamespace")).rows[0].src as string;
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const sqlstateSource = readFileSync(fileURLToPath(new URL("../../src/sqlstate.ts", import.meta.url)), "utf8");
  for (const name of ["pool_liability_open", "grant_expired_at_dispatch", "pool_expired_at_dispatch", "pool_liability_gate_absent", "pool_liability_gate_scope"]) {
    assert.ok(live.includes(`CONSTRAINT = '${name}'`), `${name} raised by the live schema`);
    assert.equal(sqlstateSource.split(`  ${name}: {`).length - 1, 1, `${name} mapped once in sqlstate.ts`);
  }
  // sabotage: a test-only body that reads the clock before the gate
  const owner = await env.h.pg.connect("kauro_owner");
  const shipped = (await env.h.oracle.query("SELECT pg_get_functiondef('kauro.request_journal_commit_gate()'::regprocedure) AS def")).rows[0].def as string;
  const edgeAcross = async (tag: string) => {
    const pool = await freshPool(env);
    const run = await interpretingRun(env, tag, pool);
    const deadline = await interpretationDeadlineOf(run);
    // admitted ten seconds before the deadline (its lease claimed at that clock, so the lease outlives the edge's clock)
    const e = admissionOf(run, 50_000n);
    assert.equal((await withConnections(env, 1, ([c]) => unit(c!, run.ag.agencyId, (x) => admitWith(rawStore(x), e), at(offsetBefore(deadline, 10_000))))).kind, "RESERVED");
    const r = await gateWaitAcross(pool, run.ag.agencyId, deadline, (c) => rawJournal(c).markDispatching(e.requestId, 1, "provider-l21", clock.now()));
    return { ...r, e };
  };
  try {
    // every judgement of the body reads the instant captured before the gate (DECLARE runs before the first statement)
    const [head, ...rest] = shipped.split("BEGIN");
    const sabotaged = head!.replace("  pool_expires timestamptz;\n", "  pool_expires timestamptz;\n  early timestamptz := kauro.effect_now();\n") + "BEGIN" + rest.join("BEGIN").replaceAll("kauro.effect_now()", "early");
    assert.notEqual(sabotaged, shipped, "the sabotage applies");
    await owner.query(sabotaged);
    const s = await edgeAcross("l21-sabotaged");
    assert.equal(s.outcome.status, "fulfilled", `judged before the gate, the edge commits past the deadline (${s.outcome.status === "rejected" ? String((s.outcome as PromiseRejectedResult).reason) + JSON.stringify(pgErr((s.outcome as PromiseRejectedResult).reason)) : ""})`);
    assert.equal((await requestRow(env, s.e.requestId)).state, "DISPATCHING");
  } finally {
    await owner.query(shipped);
    await owner.end();
  }
  const r = await edgeAcross("l21-shipped");
  assert.ok(r.workDone, "the edge's statement passed before the deadline");
  assert.ok(refusedBy("KA081")(rejection(r.outcome)), "the shipped body refuses it at COMMIT");
  assert.equal((await requestRow(env, r.e.requestId)).state, "RESERVED", "nothing sent");
});

test("L22 OK migration on a live pool: 00NN applied by the migration runner as the owner to a cluster at 00NN-1 that holds a PLATFORM_MONTHLY pool, an AUDIT grant and a RESERVED request gives that pool exactly one gate row, leaves cost_grants and pool_liability_gates with FORCE ROW LEVEL SECURITY, and the pool's next admission and DISPATCHING edge commit; a pool funded after the migration gets its row from the birth trigger", async () => {
  const { mkdtempSync, copyFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { MIGRATIONS_DIR, applyMigrations, listMigrations } = await import("../src/migrations/runner.js");
  const all = listMigrations(MIGRATIONS_DIR);
  const target = all.find((m) => m.name === "b05_dispatch_settlement");
  assert.ok(target, "00NN is the dispatch-settlement migration");
  assert.equal(all[all.length - 1], target, "00NN is the last migration");
  const dir = mkdtempSync(join(tmpdir(), "kauro-l22-"));
  try {
    for (const m of all.slice(0, -1)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
    const at58 = await openDispatchEnv({ migrationsDir: dir });
    try {
      const e2 = at58;
      assert.equal((await e2.h.oracle.query("SELECT to_regclass('kauro.pool_liability_gates') AS t")).rows[0].t, null, "the cluster is at 00NN-1");
      const pool = await freshPool(e2);
      const run = await interpretingRun(e2, "l22", pool);
      // a RESERVED request on the pool, as 00NN-1 writes it (no step fence, no core admission)
      const requestId = ids.next();
      await within(e2.control, service(run.ag.agencyId), (c) =>
        c.query(
          `INSERT INTO kauro.request_journal (request_id, task_id, agency_id, request_hash, fence, state, usage_state, reserved_cents, cost_grant_id, upstream_request_ids, reserved_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, 'RESERVED', 'UNKNOWN', 10, $5, '{}', now(), now())`,
          [requestId, ids.next(), run.ag.agencyId, sha(`l22-${requestId}`), pool],
        ),
      );
      copyFileSync(join(MIGRATIONS_DIR, target.file), join(dir, target.file));
      const owner = await e2.h.pg.connect("kauro_owner");
      try {
        const applied = await applyMigrations(owner, { dir });
        assert.deepEqual(applied.applied.map((m) => m.file), [target.file]);
      } finally {
        await owner.end();
      }
      assert.deepEqual((await e2.h.oracle.query("SELECT count(*)::int AS n FROM kauro.pool_liability_gates WHERE pool_grant_id = $1", [pool])).rows[0], { n: 1 }, "one gate row");
      assert.deepEqual(
        (await e2.h.oracle.query("SELECT relname, relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('kauro.cost_grants'::regclass, 'kauro.pool_liability_gates'::regclass) ORDER BY relname")).rows,
        [
          { relname: "cost_grants", forced: true },
          { relname: "pool_liability_gates", forced: true },
        ],
      );
      // the pool's next admission and DISPATCHING edge commit
      const a = await admit(e2, run, 50_000n);
      await dispatch(e2, a);
      assert.equal((await e2.h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.requestJournal.markDispatching(requestId as RequestId, 1, null, clock.now())))?.state, "DISPATCHING");
      const later = await freshPool(e2);
      assert.deepEqual((await e2.h.oracle.query("SELECT count(*)::int AS n FROM kauro.pool_liability_gates WHERE pool_grant_id = $1", [later])).rows[0], { n: 1 }, "the birth trigger");
    } finally {
      await closeDispatchEnv(at58);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L17 RACE (deadline at COMMIT, every session on one test-clock offset): a reservation or a markDispatching begun before the interpretation deadline, the grant's or pool's expiry or the lease's expiry whose last lock wait (audit share, lease share, grant row; [PORT-CONTRACT: PgRequestJournal.reserve] an upstream request) is held across that instant by a real product actor paused at a FaultPoint and then crashed (no state or fence change) is refused at COMMIT (KA081; KA083 for a grant or pool; KA080 for the lease) with nothing reserved or sent; the liability-gate wait variant is SIMULATED (a raw harness session holds the gate FOR UPDATE across the instant) and is refused the same way after the gate is granted; recorded instants stay the transaction's", async () => {
  // The judgement after each lock wait is the reservation's or the edge's own trigger (judged := effect_now() after its locks), and the
  // commit gate judges again at COMMIT; a product holder's wait refuses in the statement after the wait, the gate wait at COMMIT.
  const acrossHolder = async <T>(
    tag: string,
    instantOf: (run: Run, a: Admission) => Promise<Date>,
    hold: (run: Run, a: Admission, points: FaultPoints) => { point: string; run: Promise<unknown> },
    work: (c: Client, run: Run, a: Admission) => Promise<T>,
    poolSeconds?: number,
  ) => {
    const pool = await freshPool(env, 5_000n, poolSeconds);
    const run = await interpretingRun(env, tag, pool);
    const a = await admit(env, run, 50_000n);
    const instant = await instantOf(run, a);
    const offset = offsetBefore(instant, 1_500);
    const points = new FaultPoints();
    const held = hold(run, a, points);
    const pause = points.pause(held.point);
    await pause.reachedBy(held.run);
    const outcome = await withConnections(env, 1, async ([c]) => {
      const waiting = await mustWait(env.h.oracle, { waiter: c!, holder: await pausedProductPid() }, (cc) => unit(cc, run.ag.agencyId, (x) => work(x, run, a), at(offset)), `${tag}: the last lock wait across the instant`);
      await untilPast(offset, instant);
      pause.crash();
      await assert.rejects(held.run, crashedAt(held.point));
      return waiting.pending;
    });
    return { run, a, outcome, pool };
  };
  // (1) the interpretation deadline across the audit share: the owner's cancellation holds the audit FOR UPDATE and crashes
  {
    const { run, outcome } = await acrossHolder(
      "l17-deadline",
      (run) => interpretationDeadlineOf(run),
      (run, _a, points) => ({
        point: "l17-cancel.before-commit",
        run: crashableFactory(env.h.audit, points, "l17-cancel").run(env.h.tenant(run.ag.agencyId as never, run.ag.ownerUserId as never), (uow) => uow.audits.cancelAudit(run.auditId as never, 3, { actor: { kind: "USER", userId: run.ag.ownerUserId as never }, reasonCode: "AGENCY_CANCELLED" })),
      }),
      (c, run) => admitWith(rawStore(c), admissionOf(run, 50_000n)),
    );
    assert.ok(refusedBy("KA081")(rejection(outcome)), "the deadline judged after the audit share");
    assert.deepEqual(await money(env, run.grantId), { reserved: 5, spent: 0, state: "AUTHORIZED" }, "nothing reserved beyond the first admission");
    assert.equal((await env.h.oracle.query("SELECT state FROM kauro.audits WHERE audit_id = $1", [run.auditId])).rows[0].state, "INTERPRETING", "the crashed cancellation changed nothing");
  }
  // (2) the lease's expiry across the lease share: another owner's beginDispatch holds the lease row (HELD) and crashes
  {
    const { a, outcome } = await acrossHolder(
      "l17-lease",
      async (_run, a) => (await env.h.oracle.query("SELECT expires_at FROM kauro.leases WHERE resource_kind = 'MODEL_TASK' AND resource_id = $1", [a.taskId])).rows[0].expires_at as Date,
      (run, a, points) => ({
        point: "l17-held.before-commit",
        run: crashableFactory(env.h.audit, points, "l17-held").run(controlOf(run.ag.agencyId), (uow) => uow.audits.beginDispatch(a.taskId, { requestId: ids.next() as RequestId, ownerId: ids.next() as never, requestHash: sha("l17-held"), reservedCents: 5n, stepFence: run.stepFence })),
      }),
      (c, _run, a) => rawJournal(c).markDispatching(a.requestId, 1, "provider-l17", clock.now()),
    );
    assert.ok(refusedBy("KA080")(rejection(outcome)), "the lease's expiry judged after the lease share");
    assert.equal((await requestRow(env, a.requestId)).state, "RESERVED", "nothing sent");
  }
  // (3) SIMULATED gate waits: an admission across the interpretation deadline, an edge across the lease's expiry, refused at COMMIT
  {
    const pool = await freshPool(env);
    const run = await interpretingRun(env, "l17-gate-deadline", pool);
    const b = admissionOf(run, 50_000n);
    const r = await gateWaitAcross(pool, run.ag.agencyId, await interpretationDeadlineOf(run), (c) => admitWith(rawStore(c), b));
    assert.ok(r.workDone && refusedBy("KA081")(rejection(r.outcome)), "refused at COMMIT after the gate");
    assert.equal(await requestCount(b.requestId), 0);
    const e = await admit(env, run, 50_000n);
    const leaseEnd = (await env.h.oracle.query("SELECT expires_at FROM kauro.leases WHERE resource_kind = 'MODEL_TASK' AND resource_id = $1", [e.taskId])).rows[0].expires_at as Date;
    const r2 = await gateWaitAcross(pool, run.ag.agencyId, leaseEnd, (c) => rawJournal(c).markDispatching(e.requestId, 1, "provider-l17-gate", clock.now()));
    assert.ok(r2.workDone && refusedBy("KA080")(rejection(r2.outcome)), "the lease judged at COMMIT after the gate");
    assert.equal((await requestRow(env, e.requestId)).state, "RESERVED");
  }
  // recorded instants stay the transaction's: an admission that committed before an instant records its reservation at its own clock
  {
    const pool = await freshPool(env);
    const run = await interpretingRun(env, "l17-instants", pool);
    const deadline = await interpretationDeadlineOf(run);
    const b = admissionOf(run, 50_000n);
    const offset = offsetBefore(deadline, 60_000);
    const startedAt = await withConnections(env, 1, ([c]) => unit(c!, run.ag.agencyId, async (x) => ((await admitWith(rawStore(x), b)), (await x.query("SELECT kauro.server_now() AS t")).rows[0].t as Date), at(offset)));
    const row = (await env.h.oracle.query("SELECT reserved_at FROM kauro.request_journal WHERE request_id = $1", [b.requestId])).rows[0].reserved_at as Date;
    assert.ok(row.getTime() <= startedAt.getTime() && row.getTime() < deadline.getTime(), "reserved_at is the transaction's instant");
  }
  // (4) the grant's expiry (an AUDIT grant capped by a pool that ends inside the interpretation window): the grant row held by a
  // settlement that crashes; an upstream request held by a usage write that crashes [PORT-CONTRACT]; and the gate wait
  {
    const { run, outcome } = await acrossHolder(
      "l17-grant",
      async (run) => (await env.h.oracle.query("SELECT expires_at FROM kauro.cost_grants WHERE grant_id = $1", [run.grantId])).rows[0].expires_at as Date,
      (run, a, points) => ({ point: "l17-set.before-commit", run: crashableFactory(env.h.audit, points, "l17-set").run(controlOf(run.ag.agencyId), (uow) => uow.audits.settleDispatch(settlementOf(a, "RELEASED", 0n))) }),
      (c, run) => admitWith(rawStore(c), admissionOf(run, 50_000n)),
      900,
    );
    assert.ok(refusedBy("KA083", "grant_expired_at_dispatch")(rejection(outcome)), "the grant's expiry judged after the grant row");
    assert.deepEqual(await money(env, run.grantId), { reserved: 5, spent: 0, state: "AUTHORIZED" });
    const u = await consumedCore(run, 50_000n, "5");
    const instant = (await env.h.oracle.query("SELECT expires_at FROM kauro.cost_grants WHERE grant_id = $1", [run.grantId])).rows[0].expires_at as Date;
    const offset = offsetBefore(instant, 1_500);
    const points = new FaultPoints();
    const usage = crashableFactory(env.h.audit, points, "l17-usage").run(controlOf(run.ag.agencyId), (uow) => uow.requestJournal.reconcileUsage(u.requestId, "5" as never, clock.now()));
    const pause = points.pause("l17-usage.before-commit");
    await pause.reachedBy(usage);
    const d = portReservation(run.ag.agencyId, run.grantId, 5, [u.requestId]);
    const out = await withConnections(env, 1, async ([c]) => {
      const waiting = await mustWait(env.h.oracle, { waiter: c!, holder: await pausedProductPid() }, (cc) => unit(cc, run.ag.agencyId, (x) => rawJournal(x).reserve(d), at(offset)), "the dependent behind the upstream row");
      await untilPast(offset, instant);
      pause.crash();
      await assert.rejects(usage, crashedAt("l17-usage.before-commit"));
      return waiting.pending;
    });
    assert.ok(refusedBy("KA083", "grant_expired_at_dispatch")(rejection(out)), "judged after the upstream share");
    assert.equal(await requestCount(d.requestId), 0);
    const b = admissionOf(run, 50_000n);
    const r = await gateWaitAcross(run.pool, run.ag.agencyId, instant, (c) => admitWith(rawStore(c), b));
    assert.ok(r.workDone && refusedBy("KA083", "grant_expired_at_dispatch")(rejection(r.outcome)), "the grant judged at COMMIT after the gate");
    assert.equal(await requestCount(b.requestId), 0);
  }
});

test("S19b DENY pool clause alone (forged, rule 12): in the temporary cluster the migration owner disables the AUDIT grant's cap (cost_grants_workflow, cost_grants_immutable and its version bump cost_grants_version, ALTER TABLE ... DISABLE TRIGGER, re-enabled after) and gives the grant an expires_at after its pool's; after the pool expires and before the grant does, markDispatching is refused KA083 pool_expired_at_dispatch in the edge's statement and, with that BEFORE clause also disabled, at COMMIT, with nothing sent; [PORT-CONTRACT: PgRequestJournal.reserve] a reservation funded by the pool itself after the pool's expiry is refused pool_expired_at_dispatch", async () => {
  const pool = await freshPool(env, 5_000n, 600);
  const run = await interpretingRun(env, "s19b", pool);
  const poolEnd = (await env.h.oracle.query("SELECT expires_at FROM kauro.cost_grants WHERE grant_id = $1", [pool])).rows[0].expires_at as Date;
  const owner = await env.h.pg.connect("kauro_owner");
  try {
    await owner.query("BEGIN");
    await owner.query("ALTER TABLE kauro.cost_grants DISABLE TRIGGER cost_grants_workflow");
    await owner.query("ALTER TABLE kauro.cost_grants DISABLE TRIGGER cost_grants_immutable");
    await owner.query("ALTER TABLE kauro.cost_grants DISABLE TRIGGER cost_grants_version");
    await owner.query("ALTER TABLE kauro.cost_grants NO FORCE ROW LEVEL SECURITY");
    await owner.query("UPDATE kauro.cost_grants SET expires_at = $2::timestamptz + interval '1 day' WHERE grant_id = $1", [run.grantId, poolEnd]);
    await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
    await owner.query("ALTER TABLE kauro.cost_grants FORCE ROW LEVEL SECURITY");
    await owner.query("ALTER TABLE kauro.cost_grants ENABLE TRIGGER cost_grants_version");
    await owner.query("ALTER TABLE kauro.cost_grants ENABLE TRIGGER cost_grants_immutable");
    await owner.query("ALTER TABLE kauro.cost_grants ENABLE TRIGGER cost_grants_workflow");
    await owner.query("COMMIT");
    assert.ok(((await env.h.oracle.query("SELECT expires_at FROM kauro.cost_grants WHERE grant_id = $1", [run.grantId])).rows[0].expires_at as Date).getTime() > poolEnd.getTime(), "the forged grant outlives its pool");
    // admitted before the pool's end (the lease claimed at that clock), sent after it
    const before = (poolEnd.getTime() - 30_000 - Date.now()) / 1000;
    const after = (poolEnd.getTime() + 1_000 - Date.now()) / 1000;
    const a = admissionOf(run, 50_000n);
    await withConnections(env, 1, async ([c]) => {
      assert.equal((await unit(c!, run.ag.agencyId, (x) => admitWith(rawStore(x), a), at(before))).kind, "RESERVED");
      // in the edge's statement
      await assert.rejects(unit(c!, run.ag.agencyId, (x) => rawJournal(x).markDispatching(a.requestId, 1, "provider-s19b", clock.now()), at(after)), refusedBy("KA083", "pool_expired_at_dispatch"));
      assert.equal((await requestRow(env, a.requestId)).state, "RESERVED");
      // with the edge's pool clause disabled (test-only body), at COMMIT
      const shipped = (await env.h.oracle.query("SELECT pg_get_functiondef('kauro.request_journal_model_task_send()'::regprocedure) AS def")).rows[0].def as string;
      const clause = /\n\s*IF g\.pool_expires_at IS NULL OR g\.pool_expires_at <= judged THEN\n[^\n]*\n\s*END IF;/;
      assert.match(shipped, clause);
      try {
        await owner.query(shipped.replace(clause, ""));
        let statementPassed = false;
        await assert.rejects(
          unit(
            c!,
            run.ag.agencyId,
            async (x) => {
              const r = await rawJournal(x).markDispatching(a.requestId, 1, "provider-s19b", clock.now());
              statementPassed = r?.state === "DISPATCHING";
              return r;
            },
            at(after),
          ),
          refusedBy("KA083", "pool_expired_at_dispatch"),
        );
        assert.ok(statementPassed, "the statement passed: the refusal is the COMMIT's");
      } finally {
        await owner.query(shipped);
      }
      assert.equal((await requestRow(env, a.requestId)).state, "RESERVED", "nothing sent");
      // [PORT-CONTRACT] a reservation funded by the pool itself after the pool's expiry
      const d = portReservation(run.ag.agencyId, pool, 10, []);
      await assert.rejects(unit(c!, run.ag.agencyId, (x) => rawJournal(x).reserve(d), at(after)), refusedBy("KA083", "pool_expired_at_dispatch"));
      assert.equal(await requestCount(d.requestId), 0);
    });
  } finally {
    await owner.end();
  }
});

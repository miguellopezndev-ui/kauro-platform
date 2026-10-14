// Lane L-REFUND, case tests of REFUND-GENERIC-V1 (mandate PAYMENTS-V1-REPLAN §4; ACH-ROUTE r12 DV1-08..DV1-11, §7.22d, §7.27 FC-RAIL) and of
// lane B09-TAX-ROUNDING (the KP012 remainder after a failed booked refund; the chargeback path). Real api, real PostgreSQL 17, CONTRACT_FAKE
// evidence (SIMULATED). Owner rules: never COMPLETED without classified execution evidence; no double refund; NEVER-RESEND; an uncertain
// refund waits for the owner (D-24 A). The refund-lane driver (refund-lane-support.ts) fixes the lane's HTTP contract and its seams.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { laneTest as test } from "./refund-lane-support.js";
import { fileURLToPath } from "node:url";
import { refundTaxFor, type RefundComponents, type TaxRuleSnapshot } from "@kauro/domain";
import { dispatch, execute, reconcile, storeQuery } from "./payment-support.js";
import { sellingAgency, oracleRows } from "./commission-support.js";
import { bought, replacementPlanOf, type Agent } from "./integration-support.js";
import { paymentRoutes } from "./commerce-support.js";
import { call, completed, freshKey, ids, outcome, type Reply } from "./support.js";
import {
  L,
  SCOPES,
  approved,
  assertRefused,
  attemptsOf,
  bounceG3,
  cmd033,
  dataOf,
  declareX1,
  declareX4,
  declared,
  holdAndWait,
  footprint,
  lapsed,
  ownerQueue,
  providerRefundSends,
  q,
  recordG2,
  recorded,
  refundOf,
  resolveX3,
  sourceReserved,
  startLane,
  stopLane,
  storeExecution,
  valueOf,
  type DeclareView,
  type QueueItem,
  type RecordView,
  type ResolveView,
} from "./refund-lane-support.js";
import { runCell } from "@kauro/persistence/testing";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

// --- RFG-01..03 ---------------------------------------------------------------------------------------------------------------------

test("RFG-01 OK: a manual-rail refund is declared, executed outside Kauro and recorded once with its evidence - refund.completed once, revenue/cash, seller commission and credit-note draft adjusted by exact cents, receipt kept", async () => {
  for (const scope of SCOPES) {
    const { src, attempt } = await declared(scope, `rfg01-${scope}`);
    assert.equal(attempt.state, "DECLARED");
    assert.equal(attempt.reference, `kauro-refund-${src.refundId}-1`, "the reference is frozen before money moves");
    assert.equal(BigInt(attempt.amountCents), src.totalCents, `the attempt freezes the approved ${src.totalCents} cents`);
    assert.equal((await refundOf(src))?.state, "SUBMITTING");
    const receipt = await storeExecution(attempt);
    const view = dataOf<RecordView>(await recordG2(attempt, receipt), 200, `G2 records ${scope}`);
    assert.deepEqual([view.attempt.state, view.refund?.state], ["RECORDED", "COMPLETED"]);
    const fp = await footprint(src);
    // the scope's completion: refund.completed.v1 of the agency refund; the route-scope treasury refund (D-ACH-19, an aggregate kind of the
    // Refund machine) completes as treasury_refund.completed.v1 and never publishes an agency refund.completed
    const done = scope === "BANK_CREDIT" ? "treasury_refund.completed.v1" : "refund.completed.v1";
    assert.deepEqual(fp.events.filter((e) => e === done), [done], `${scope}: ${done} exactly once`);
    if (scope === "BANK_CREDIT") assert.deepEqual(fp.events.filter((e) => e === "refund.completed.v1"), [], "a treasury refund publishes no agency refund.completed");
    assert.equal((await q<{ evidence_hash: string }>("SELECT evidence_hash FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [attempt.attemptId]))[0]?.evidence_hash, receipt.evidenceHash, "the receipt is kept: the attempt binds its stored bytes");
    assert.ok((await L().bw.evidence.get(receipt.artifactRef)) !== null, "the receipt artifact stays in the restricted store");
    if (scope === "CAPTURE") {
      await dispatch(L().iw.pw, "FINANCE");
      await dispatch(L().iw.pw, "FISCAL");
      const lines = await q<{ direction: string; cents: string }>(
        "SELECT l.direction, sum(l.amount_cents)::text AS cents FROM kauro.ledger_entries l JOIN kauro.domain_events e ON e.event_id = l.domain_event_id WHERE e.aggregate_id = $1 AND e.event_type = 'refund.completed.v1' GROUP BY l.direction ORDER BY l.direction",
        [src.refundId],
      );
      assert.deepEqual(lines, [{ direction: "CREDIT", cents: src.totalCents.toString() }, { direction: "DEBIT", cents: src.totalCents.toString() }], `the REFUND posting set moves exactly ${src.totalCents} cents, balanced`);
      const notes = await q<{ kind: string; n: string }>("SELECT kind, count(*)::text AS n FROM kauro.tax_documents WHERE refund_id = $1 GROUP BY kind", [src.refundId]);
      assert.deepEqual(notes, [{ kind: "CREDIT_NOTE", n: "1" }], "one credit-note draft corrects the invoice");
      const consumers = await q<{ consumer: string }>("SELECT o.consumer FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE e.aggregate_id = $1 AND e.event_type = 'refund.completed.v1' ORDER BY o.consumer", [src.refundId]);
      assert.ok(consumers.some((c) => c.consumer === "COMMISSIONS"), `the seller-commission consumer receives refund.completed: ${JSON.stringify(consumers)}`);
    }
    // a replay of the record, an identical second offer under another key, adds no completion
    const again = await recordG2({ ...attempt, state: "RECORDED" }, receipt);
    assert.ok(again.status === 200 || again.status === 409, `the second record is a replay or a refusal: ${again.status}`);
    assert.deepEqual((await footprint(src)).events.filter((e) => e === done).length, 1, `${scope}: still one ${done}`);
  }
});

test("RFG-02 DENY: no path marks a refund COMPLETED without classified execution evidence, and no execution id completes two refunds", async () => {
  for (const scope of SCOPES) {
    const a = await declared(scope, `rfg02-a-${scope}`);
    // unclassifiable bytes: the evidence store holds a corrupted artifact (HASH_MISMATCH)
    const receipt = await storeExecution(a.attempt);
    L().bw.evidence.corrupt(receipt.artifactRef, new TextEncoder().encode("not a receipt"));
    const forged = await recordG2(a.attempt, receipt);
    assertRefused(forged, "409 HASH_MISMATCH", `${scope}: a corrupted receipt completes nothing`);
    assert.deepEqual([(await refundOf(a.src))?.state, (await attemptsOf(a.src))[0]?.state], ["SUBMITTING", "DECLARED"], `${scope}: still SUBMITTING with its attempt DECLARED`);
    // CMD033 (the automated executor) cannot complete a manual-rail refund either
    assertRefused(await cmd033(a.src, 3), "409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND", `${scope}: CMD033`);
    // a good receipt completes A; the same execution id offered for B is refused across scopes
    const used = await storeExecution(a.attempt, { bankExecutionId: `rfg02-shared-${scope}` });
    dataOf<RecordView>(await recordG2(a.attempt, used), 200, `${scope}: A recorded`);
    const b = await declared(scope === "CAPTURE" ? "BANK_CREDIT" : "CAPTURE", `rfg02-b-${scope}`);
    const reused = await recordG2(b.attempt, await storeExecution(b.attempt, { bankExecutionId: `rfg02-shared-${scope}` }));
    assertRefused(reused, "409 EXECUTION_ID_INVALID", `${scope}: one execution id completes one refund`);
    assert.equal((await refundOf(b.src))?.state, "SUBMITTING", "B is not completed by A's money");
  }
});

test("RFG-03 OK (D-24 A): an UNCERTAIN refund stays reserved until the owner resolves it with evidence", async () => {
  await runCell({ id: "RFG-03", step: "X2 then X3 EXECUTED", fault: "expiry", expect: "UNCERTAIN keeps the share until the owner resolves with DP-FULL evidence" }, async (ctx) => {
    for (const scope of SCOPES) {
      const { src, attempt } = await lapsed(ctx, scope, "RETURN", `rfg03-${scope}`);
      const reserved = await sourceReserved(src);
      assert.equal(reserved, src.totalCents, `${scope}: the whole ${src.totalCents} cents stay reserved while UNCERTAIN`);
      assert.equal((await refundOf(src))?.state, "UNCERTAIN");
      // the next sweep pass changes nothing; a second approval cannot take the held share
      await L().iw.pw.service.runSweepPass();
      assert.equal(await sourceReserved(src), reserved, "the next pass releases nothing");
      const resolved = dataOf<ResolveView>(await resolveX3(attempt, "EXECUTED", await storeExecution(attempt)), 200, `${scope}: X3 EXECUTED`);
      assert.deepEqual([resolved.attempt.state, resolved.refund?.state], ["RECORDED", "COMPLETED"]);
      assert.equal(await sourceReserved(src), src.totalCents, "the completed refund keeps its components");
      const cases = (await footprint(src)).cases;
      assert.ok(cases.some(([k, s]) => k === "UNCERTAIN_EFFECT" && s === "RESOLVED"), `the UNCERTAIN_EFFECT case is EXPLAINED: ${JSON.stringify(cases)}`);
    }
  });
});

test("DENY CMD033 on a manual-rail refund: 409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND, nothing written", async () => {
  for (const scope of SCOPES) {
    const src = await approved(scope, `fc-rail-${scope}`);
    const sends = providerRefundSends();
    const before = await footprint(src);
    assertRefused(await cmd033(src, 2), "409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND", `${scope}: APPROVED`);
    const view = dataOf<DeclareView>(await declareX1(src), 201, `${scope}: X1`);
    const declaredFp = await footprint(src);
    assertRefused(await cmd033(src, 3), "409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND", `${scope}: SUBMITTING`);
    assert.deepEqual(await footprint(src), declaredFp, `${scope}: CMD033 wrote nothing (refund, attempt, events, outbox, journal)`);
    assert.equal(providerRefundSends(), sends, `${scope}: no provider refund was dispatched (${sends} before and after)`);
    assert.equal(before.attempts.length, 0);
    assert.equal(view.attempt.state, "DECLARED");
  }
});

// --- NEVER-RESEND (owner rule) -------------------------------------------------------------------------------------------------------

const BANK_COMMAND_DIRS = ["packages/application/src/commerce/bank"];
const repoRoot = (): string => fileURLToPath(new URL("../../../../", import.meta.url));

test("NEVER-RESEND: no path re-sends the refund of an attempt that was dispatched", async () => {
  await runCell({ id: "NEVER-RESEND", step: "every entry point while the attempt is DECLARED then UNCERTAIN", fault: "retry", expect: "exactly one instruction, zero provider sends" }, async (ctx) => {
    for (const scope of SCOPES) {
      const src = await approved(scope, `never-resend-${scope}`);
      const sends = providerRefundSends();
      const key = freshKey(`never-resend-${scope}`);
      const first = dataOf<DeclareView>(await declareX1(src, { key }), 201, `${scope}: X1`);
      const entryPoints = async (phase: string): Promise<void> => {
        // X1 replay: the one attempt; X1 under a new key: refused
        const replay = dataOf<DeclareView>(await ctx.attempt(() => declareX1(src, { key })), 201, `${phase} X1 replay`);
        assert.equal(replay.attempt.attemptId, first.attempt.attemptId, `${phase}: the replay returns the one attempt`);
        assertRefused(await ctx.attempt(() => declareX1(src)), "409 EXECUTION_ATTEMPT_OPEN", `${phase}: X1 new key`);
        // CMD033: refused; a second approval of the source cannot reserve the held share
        const v = (await refundOf(src))!.version;
        assertRefused(await ctx.attempt(() => cmd033(src, v)), "409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND", `${phase}: CMD033`);
        assert.equal(await sourceReserved(src), src.totalCents, `${phase}: one reserved share of ${src.totalCents} cents`);
        // the owner queue offers send details for at most the one DECLARED attempt, never twice
        const queue = dataOf<{ items: QueueItem[] }>(await ownerQueue(), 200, `${phase}: queue`).items.filter((i) => i.attemptId === first.attempt.attemptId || i.reference.startsWith(`kauro-refund-${src.refundId}`));
        assert.ok(queue.length <= 1, `${phase}: the queue never lists the refund twice: ${JSON.stringify(queue)}`);
        // every redelivery of the refund's events emits no instruction
        await dispatch(L().iw.pw, "FINANCE");
        await dispatch(L().iw.pw, "FISCAL");
        const attempts = await attemptsOf(src);
        assert.equal(attempts.length, 1, `${phase}: exactly one execution instruction exists for the source`);
        assert.equal(providerRefundSends(), sends, `${phase}: Kauro dispatched no provider refund`);
      };
      await entryPoints(`${scope} DECLARED`);
      const { manualExecutionWindowMs } = (await import("./refund-lane-support.js")).routeTiming();
      ctx.clock.set(new Date(Date.parse(first.attempt.declaredAt) + manualExecutionWindowMs + 1));
      await ctx.operation(`${scope}: X2`, async (op) => {
        L().iw.faults.clock = op.clock;
        try {
          await L().iw.pw.service.runSweepPass();
        } finally {
          L().iw.faults.clock = null;
        }
      });
      assert.equal((await attemptsOf(src))[0]?.state, "UNCERTAIN");
      await entryPoints(`${scope} UNCERTAIN`);
      const queue = dataOf<{ items: QueueItem[] }>(await ownerQueue(), 200, "queue").items.filter((i) => i.attemptId === first.attempt.attemptId);
      assert.deepEqual(queue, [], `${scope}: an UNCERTAIN attempt shows no send details`);
    }
  });
  // structural: the lane's bank commands exist and none of them can reach an automated outbound dispatch
  const files = BANK_COMMAND_DIRS.flatMap((d) => {
    const dir = join(repoRoot(), d);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)) : [];
  });
  assert.ok(files.length >= 5, `the lane's bank commands exist (declare, record, bounce, resend, resolve): ${files.length} files`);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /\.dispatch\(|prepareRefund\(|ExecuteRefund|createTransfer|fundTransfer/, `${f} reaches no outbound executor`);
});

// --- B09-TAX-ROUNDING ----------------------------------------------------------------------------------------------------------------

const RULE: TaxRuleSnapshot = { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 };
const rh = (cents: bigint): bigint => (cents * 1900n + 5000n) / 10000n;

async function taxedAgent(label: string): Promise<Agent> {
  const { iw } = L();
  const s = await sellingAgency(iw as never, label, RULE as TaxRuleSnapshot & { treatment: "DOMESTIC_TAXABLE" });
  iw.buyers.set(s.agency.agencyId, "AGENCY");
  const billing = await iw.w.person(`${label}-billing`);
  await iw.h.addMember(s.agency, billing.userId, "BILLING");
  return { s, billing } as Agent;
}
async function requestOn(a: Agent, projectId: string, label: string): Promise<string> {
  const r = completed<{ refund: { refundId: string } }>(
    await call(L().iw.w, { url: paymentRoutes.requestRefund(projectId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey(label), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }),
    201,
  );
  return r.data.refund.refundId;
}
const approveAs = async (refundId: string, serviceCents: bigint, taxCents: bigint): Promise<Reply> =>
  call(L().iw.w, { url: paymentRoutes.approveRefund(refundId), token: L().owner.token, agency: null, key: freshKey("tax-rounding-approve"), body: { expectedVersion: 1, serviceCents: serviceCents.toString(), taxCents: taxCents.toString(), authorizationRef: await L().iw.w.stepUp(L().owner) } });
async function committed(captureId: string): Promise<RefundComponents> {
  const r = (await q<{ s: string; t: string; e: string }>("SELECT coalesce(sum(approved_service_cents),0)::text AS s, coalesce(sum(approved_tax_cents),0)::text AS t, coalesce(sum(approved_excess_cents),0)::text AS e FROM kauro.refunds WHERE capture_id = $1 AND state IN ('APPROVED','SUBMITTING','UNCERTAIN','COMPLETED')", [captureId]))[0]!;
  return { serviceCents: BigInt(r.s), taxCents: BigInt(r.t), excessCents: BigInt(r.e) };
}
const authorizationState = async (authorizationId: string): Promise<string> => (await oracleRows<{ state: string }>(L().iw as never, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [authorizationId]))[0]!.state;
const quoteCall = (a: Agent, plan: { readonly planId: string; readonly projectId: string }, key: string): Promise<Reply> =>
  call(L().iw.w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: a.s.profileId } });

test("DENY B09-TAX-ROUNDING (KP012 remainder after a failed booked refund): once every service cent of a taxed capture is refunded, the entitlement and CreateQuote agree — REVOKED only with the quote releasable (201), never 422 RESPONSE_CONTRACT_VIOLATION while a rounding cent of tax is unreturned", async () => {
  const { iw } = L();
  const a = await taxedAgent("tax-rounding");
  const paid = await bought(iw, a, "tax-rounding-paid", { units: 50_000 });
  const p = paid.purchase;
  const S = p.serviceCents;
  const T = p.taxCents;
  assert.ok(T > 0n, `a taxed purchase: ${S} service, ${T} tax`);
  // the smallest service s1 whose two consecutive approvals book tax t1 then t2 < t1: R1 failing leaves the booked set short by d = t1 - t2
  let s1 = 0n;
  let t1 = 0n;
  let t2 = 0n;
  for (let s = 1n; s * 2n < S; s++) {
    const x1 = T - rh(S - s);
    const x2 = T - rh(S - 2n * s) - x1;
    if (x2 < x1) {
      [s1, t1, t2] = [s, x1, x2];
      break;
    }
  }
  assert.ok(s1 > 0n, "a path-dependent pair exists for this purchase");
  const allocation: RefundComponents = { serviceCents: S, taxCents: T, excessCents: 0n };
  // one customer request is open at a time (REFUND_REQUEST_OPEN): each is requested once the previous one is approved
  const r1 = await requestOn(a, p.projectId, "tax-r1");
  assert.equal((await approveAs(r1, s1, t1)).status, 200, `R1 books ${s1} service, ${t1} tax`);
  const r2 = await requestOn(a, p.projectId, "tax-r2");
  assert.equal((await approveAs(r2, s1, t2)).status, 200, `R2 books ${s1} service, ${t2} tax`);
  iw.pw.paypal.program("CAPTURES_V2_REFUND", { kind: "REFUND_OBSERVED", status: "FAILED" });
  await execute(iw.pw, r1, { expectedVersion: 2 });
  assert.equal((await q<{ state: string }>("SELECT state FROM kauro.refunds WHERE refund_id = $1", [r1]))[0]?.state, "FAILED", "R1 FAILED: the provider refused it");
  // R3, a service-0 refund, is approved with whatever tax KP012 requires of it now; it then fails at the provider
  const r3 = await requestOn(a, p.projectId, "tax-r3");
  const t3 = refundTaxFor(allocation, await committed(p.captureId), 0n, RULE);
  assert.equal(t3, 0n, "a refund with no service carries no tax (KP012)");
  // an all-zero refund is no refund: it is refused (400 REFUND_COMPONENT_INVALID) and the open request is reused by R4
  const r3Approved = await approveAs(r3, 0n, t3);
  assert.ok(r3Approved.status === 200 || r3Approved.status === 409 || (r3Approved.status === 400 && r3Approved.text.includes("REFUND_COMPONENT_INVALID")), `R3 (0 service, ${t3} tax) is approved or refused with a catalogued reason: ${r3Approved.text}`);
  // R4 books every remaining service cent with the tax KP012 gives it (the still-open R3 request itself when R3 was refused)
  const r4 = r3Approved.status === 200 ? await requestOn(a, p.projectId, "tax-r4") : r3;
  const s4 = S - (await committed(p.captureId)).serviceCents;
  const t4 = refundTaxFor(allocation, await committed(p.captureId), s4, RULE);
  assert.equal((await approveAs(r4, s4, t4)).status, 200, `R4 books the remaining ${s4} service with ${t4} tax`);
  if (r3Approved.status === 200) {
    iw.pw.paypal.program("CAPTURES_V2_REFUND", { kind: "REFUND_OBSERVED", status: "FAILED" });
    await execute(iw.pw, r3, { expectedVersion: 2 });
  }
  completed(await execute(iw.pw, r2, { expectedVersion: 2 }), 200);
  completed(await execute(iw.pw, r4, { expectedVersion: 2 }), 200);
  const done = (await q<{ s: string; t: string }>("SELECT coalesce(sum(approved_service_cents),0)::text AS s, coalesce(sum(approved_tax_cents),0)::text AS t FROM kauro.refunds WHERE capture_id = $1 AND state = 'COMPLETED'", [p.captureId]))[0]!;
  assert.equal(BigInt(done.s), S, `every service cent refunded (${S})`);
  const authorization = await authorizationState(p.authorizationId);
  const plan = await replacementPlanOf(iw, a, { purchase: p, plan: paid.plan }, { units: 45_000, seed: "tax-rounding-next" });
  const reply = await quoteCall(a, plan, freshKey("tax-rounding-quote"));
  assert.notEqual(reply.status >= 400 ? outcome(iw.w, reply) : `${reply.status}`, "422 INTEGRITY_FAILURE RESPONSE_CONTRACT_VIOLATION", `CreateQuote never answers an integrity violation (R1 ${s1}/${t1} FAILED, R2 ${s1}/${t2}, R3 0/${t3}, R4 ${s4}/${t4}; completed tax ${done.t} of ${T})`);
  if (authorization === "REVOKED") assert.equal(reply.status, 201, `REVOKED entitlement: the wholly refunded quote is released and superseded: ${reply.text}`);
  else assert.equal(reply.status, 409, `ACTIVE entitlement: CreateQuote refuses with a catalogued reason: ${reply.text}`);
});

test("OK B09-TAX-ROUNDING chargeback (capture REVERSED): the provider's reversal revokes the entitlement and CreateQuote on the project supersedes the reversed quote exactly once (201, the same key replays), with no refund, capture or ledger row written by CreateQuote", async () => {
  const { iw } = L();
  const a = await taxedAgent("chargeback");
  const paid = await bought(iw, a, "chargeback-paid", { units: 50_000 });
  const p = paid.purchase;
  iw.pw.paypal.updateCapture(p.providerCaptureId, { status: "REVERSED" });
  completed(await reconcile(iw.pw, p.orderId, { observationRef: await storeQuery(iw.pw, p.providerOrderId) }), 200);
  assert.equal((await q<{ status: string }>("SELECT status FROM kauro.capture_facts WHERE capture_id = $1", [p.captureId]))[0]?.status, "REVERSED", "the capture is REVERSED");
  assert.equal(await authorizationState(p.authorizationId), "REVOKED", "the reversal revokes the entitlement");
  const plan = await replacementPlanOf(iw, a, { purchase: p, plan: paid.plan }, { units: 45_000, seed: "chargeback-next" });
  const money = async () => q<{ n: string }>("SELECT ((SELECT count(*) FROM kauro.refunds WHERE capture_id = $1) + (SELECT count(*) FROM kauro.capture_facts WHERE capture_id = $1) + (SELECT count(*) FROM kauro.ledger_entries))::text AS n", [p.captureId]);
  const before = await money();
  const key = freshKey("chargeback-quote");
  const first = await quoteCall(a, plan, key);
  assert.equal(first.status, 201, `the reversed purchase no longer blocks a new quote: ${first.text}`);
  const view = first.json<{ data: { quote: { quoteId: string }; supersededQuoteId?: string } }>().data;
  assert.equal(view.supersededQuoteId, p.quoteId, "the reversed quote is superseded");
  const again = await quoteCall(a, plan, key);
  assert.equal(again.json<{ data: { quote: { quoteId: string } } }>().data.quote.quoteId, view.quote.quoteId, "superseded exactly once: the same key replays");
  assert.deepEqual(await money(), before, "CreateQuote wrote no refund, capture or ledger row");
});

test("RFG-04 RACE: a bounced refund is re-sent only through a new declared attempt after the bounce is recorded, never while an attempt of the source is DECLARED or UNCERTAIN", async () => {
  await runCell({ id: "RFG-04", step: "X4 vs X4 after a recorded bounce", fault: "race", expect: "one resend attempt at a time" }, async (ctx) => {
    for (const scope of SCOPES) {
      const r = await recorded(scope, `rfg04-${scope}`);
      // before the bounce is recorded: no resend
      assertRefused(await declareX4(r.attempt, BigInt(r.attempt.amountCents)), "409 NO_RECORDED_BOUNCE", `${scope}: no bounce recorded yet`);
      const back = await storeExecution(r.attempt, { bankExecutionId: r.executionId, status: "BOUNCED", returnedCents: BigInt(r.attempt.amountCents) });
      assert.equal((await bounceG3(r.attempt, back, BigInt(r.attempt.amountCents))).status, 200, `${scope}: G3 records the bounce`);
      // two resend declarations race at L1: one DECLARED attempt, the other EXECUTION_ATTEMPT_OPEN
      const raced = await holdAndWait(ctx, `${scope}: X4 vs X4`, () => declareX4(r.attempt, BigInt(r.attempt.amountCents), { key: freshKey("rfg04-a") }), () => declareX4(r.attempt, BigInt(r.attempt.amountCents), { key: freshKey("rfg04-b") }));
      const resend = dataOf<DeclareView>(valueOf(raced.held), 201, `${scope}: the holder declares the resend`);
      assertRefused(valueOf(raced.waited), "409 EXECUTION_ATTEMPT_OPEN", `${scope}: the waiter`);
      assert.equal(resend.attempt.reference, `kauro-refund-${r.src.refundId}-2`, `${scope}: a new attempt with its own reference`);
      assert.equal((await refundOf(r.src))?.state, "COMPLETED", `${scope}: the refund stays COMPLETED`);
      // the resend is recorded (G4); the payable is settled and no further resend exists
      dataOf<RecordView>(await recordG2(resend.attempt, await storeExecution(resend.attempt)), 200, `${scope}: G4`);
      assertRefused(await declareX4(r.attempt, 1n), "409 NO_RECORDED_BOUNCE", `${scope}: the payable is settled`);
      assert.deepEqual((await attemptsOf(r.src)).map((a) => [a.kind, a.state, a.amount_cents]), [["RETURN", "RECORDED", r.attempt.amountCents], ["RESEND", "RECORDED", r.attempt.amountCents]], `${scope}: exactly two executions of ${r.attempt.amountCents} cents`);
    }
  });
});

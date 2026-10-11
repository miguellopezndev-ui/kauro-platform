// Lane B09-TAX-ROUNDING (KP012): the tax of a refund follows its service. After a failed booked refund the cumulative rule used to force
// one rounding cent of tax onto a service-0 refund; the full service then completed first, the entitlement was REVOKED with the
// completed tax one cent short, the quote's release guard kept the quote and CreateQuote (CMD027) answered 422 until that cent was
// refunded. Real api, real PostgreSQL 17, CONTRACT_FAKE evidence (SIMULATED). Case reused from branch pv1/refund (6c19b99).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { refundTaxFor, type RefundComponents, type TaxRuleSnapshot } from "@kauro/domain";
import { execute } from "./payment-support.js";
import { sellingAgency, oracleRows } from "./commission-support.js";
import { bought, integrationWorld, replacementPlanOf, type Agent, type IntegrationWorld } from "./integration-support.js";
import { paymentRoutes } from "./commerce-support.js";
import { call, completed, freshKey, ids, outcome, type Reply } from "./support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
});
after(async () => {
  await iw.stop();
});
const L = () => ({ iw, owner: iw.owner });
const q = <T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> => oracleRows<T>(iw as never, sql, params);

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

test("DENY B09-TAX-ROUNDING CMD027 (defence, forced state): an entitlement REVOKED over a purchase whose completed refunds are one tax cent short never dead-ends CreateQuote in 422 RESPONSE_CONTRACT_VIOLATION — it is the declared 409 PRECONDITION_FAILED UNLISTED_TRANSITION, nothing written", async () => {
  const a = await taxedAgent("tax-rounding-forced");
  const paid = await bought(iw, a, "tax-rounding-forced-paid", { units: 50_000 });
  const p = paid.purchase;
  const refundId = await requestOn(a, p.projectId, "forced-r1");
  assert.equal((await approveAs(refundId, p.serviceCents, p.taxCents)).status, 200);
  completed(await execute(iw.pw, refundId, { expectedVersion: 2 }), 200);
  assert.equal(await authorizationState(p.authorizationId), "REVOKED");
  // the forced state (an injected writer; no product path produces it any more): the completed tax is one cent short of the collected tax
  await q(`ALTER TABLE kauro.refunds DISABLE TRIGGER USER; UPDATE kauro.refunds SET approved_tax_cents = approved_tax_cents - 1 WHERE refund_id = '${refundId}'; ALTER TABLE kauro.refunds ENABLE TRIGGER USER`);
  const plan = await replacementPlanOf(iw, a, { purchase: p, plan: paid.plan }, { units: 45_000, seed: "tax-rounding-forced-next" });
  const reply = await quoteCall(a, plan, freshKey("tax-rounding-forced-quote"));
  assert.equal(outcome(iw.w, reply), "409 PRECONDITION_FAILED UNLISTED_TRANSITION", reply.text);
});

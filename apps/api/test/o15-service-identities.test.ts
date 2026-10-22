// Order 15 F-03 (08 "a service account has only its technical role"; OWASP API5 BFLA): a verified service identity presented on another
// service's command — the payment service's credential on the commission and operations services' routes, the commission, finance,
// operations and outreach services' credentials on the payment service's routes — is refused SERVICE_NOT_PERMITTED, with the durable DENY fact
// of the presented service in the service stream and nothing else written. Before the fix the refusal was decided but its fact was recorded
// in a unit of the PRESENTED service's runtime group, which these routes' units never bind: the answer was INTEGRITY_FAILURE (422) or
// INTERNAL_ERROR (500) and the attempt left no fact. Real routes, real composition root, real PostgreSQL 17.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bankWorld, type BankWorld } from "./bank-support.js";
import { serviceToken } from "./payment-support.js";
import { asProblem, call, freshKey, ids, sha, type Reply } from "./support.js";

let bw: BankWorld;
before(async () => {
  bw = await bankWorld();
});
after(async () => {
  await bw?.stop();
});

interface ServiceRoute {
  readonly name: string;
  readonly url: () => string;
  readonly body: () => Record<string, unknown>;
  /** The services whose credential must be refused here. */
  readonly foreign: ReadonlyArray<string>;
}

const ROUTES: ReadonlyArray<ServiceRoute> = [
  { name: "CMD051 CloseCommissionPeriod", url: () => `/api/v1/sales/commission-periods/${ids.next()}/close`, body: () => ({ ledgerCutoffHash: sha("o15-cutoff") }), foreign: ["payment-service", "finance-service", "operations-service", "outreach-service"] },
  { name: "CMD053 ReconcileCommissionPayout", url: () => `/api/v1/sales/statements/${ids.next()}/reconcile-payout`, body: () => ({ providerPayoutEvidenceRef: ids.next() }), foreign: ["payment-service", "commission-service", "operations-service"] },
  { name: "CMD056 RecordIncident (service path)", url: () => "/api/v1/operations/incidents", body: () => ({ severity: "S4", affectedScopeRefs: ["platform:o15"], summary: "Order fifteen probe" }), foreign: ["payment-service", "commission-service", "finance-service", "outreach-service"] },
  { name: "CMD059 RestrictCapability (service path)", url: () => `/api/v1/operations/capabilities/${ids.next()}/restrict`, body: () => ({ expectedVersion: 1, incidentRef: ids.next() }), foreign: ["payment-service", "commission-service"] },
  { name: "CMD034 ReconcilePayment", url: () => `/api/v1/payment-orders/${ids.next()}/reconcile`, body: () => ({ observationRef: ids.next() }), foreign: ["commission-service", "finance-service", "operations-service", "outreach-service", "fiscal-service"] },
  { name: "CMD033 ExecuteRefund", url: () => `/api/v1/refunds/${ids.next()}/execute`, body: () => ({ expectedVersion: 2 }), foreign: ["commission-service", "operations-service", "fiscal-service"] },
];

async function factOf(reply: Reply): Promise<ReadonlyArray<{ readonly outcome: string; readonly reason: string | null; readonly actor: string | null }>> {
  const r = await bw.iw.w.h.oracle.query<{ outcome: string; reason_code: string | null; actor_id: string | null }>(
    "SELECT outcome, reason_code, actor_id FROM kauro.security_events WHERE correlation_id = $1",
    [String(reply.headers["x-correlation-id"])],
  );
  return r.rows.map((x) => ({ outcome: x.outcome, reason: x.reason_code, actor: x.actor_id }));
}

test("O15 F-03: every service command refuses another service's verified identity SERVICE_NOT_PERMITTED, recording the presented service's DENY fact and nothing else", async () => {
  const w = bw.iw.w;
  const failures: string[] = [];
  for (const route of ROUTES) {
    for (const serviceId of route.foreign) {
      const journalBefore = await w.count("command_journal");
      const reply = await call(w, { url: route.url(), token: serviceToken(bw.iw.pw, { serviceId }), agency: null, key: freshKey("o15-svc"), body: route.body() });
      const what = `${route.name} by ${serviceId}`;
      const p = reply.status >= 400 ? asProblem(w, reply) : null;
      const got = p === null ? `${reply.status}` : `${reply.status} ${p.code} ${p.reason ?? "-"}`;
      if (got !== "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED") failures.push(`${what}: ${got}`);
      const facts = await factOf(reply);
      if (facts.length !== 1 || facts[0]?.outcome !== "DENY" || facts[0].reason !== "SERVICE_NOT_PERMITTED" || facts[0].actor !== serviceId) failures.push(`${what}: the durable denial is ${JSON.stringify(facts)}`);
      if ((await w.count("command_journal")) !== journalBefore) failures.push(`${what}: a journal entry was written`);
    }
  }
  assert.deepEqual(failures, []);
});

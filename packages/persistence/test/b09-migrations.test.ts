// The schema of the payments and fiscal workflow (package B09, migrations 0013..0017) on real PostgreSQL 17 (07 "Acceptance
// obligations": real PostgreSQL for tenant constraints, transactions, migrations and concurrency). The seeds equal the registry and
// the domain; every guard is proven by the forbidden write performed AS THE RUNTIME ROLE that would perform it and refused, beside
// the legitimate write that commits (21 "Positive and negative symmetry"; 08 "Database isolation": application checks improve
// messages but cannot be the sole protection). Design: docs/design/B09-payments-fiscal.md §3, §6, §7; case map
// docs/design/B09-case-map.md.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { STATE_MACHINES, policy, registryJson } from "@kauro/contracts";
import { AGGREGATE_KINDS, COMMERCE_EVENT_TYPES, COMMERCE_PLATFORM_MACHINES, EVENT_TYPES, LEDGER_ACCOUNTS, type UserId } from "@kauro/domain";
import { start, backendPid, settlesOrWaits, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import {
  ENVIRONMENT,
  PAYMENT_SERVICE,
  PROVIDER,
  activateAgency,
  approveRefund,
  approvedSubject,
  commerceEvent,
  createdOrder,
  fiscalProfile,
  grantKauroOwner,
  insertAuthorization,
  insertCapture,
  issuedQuote,
  observedCapture,
  operator,
  qualifiedRoutes,
  requestRefund,
  service,
  tenant,
  within,
  type OrderFixture,
  type Routes,
  expireSource,
} from "./commerce-support.js";
import { constraintOf, ids, project, sha, sqlState } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let assurance: Client;
let validator: Client;
let payment: Client;
let ingress: Client;
let alice: UserId;
let bob: UserId;
let kora: UserId;
let A: AgencyFixture;
let B: AgencyFixture;
let routes: Routes;
let hubspot: string;
let clientA: string;
let clientB: string;
let profileA: string;
let profileB: string;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  validator = await h.pg.connect("kauro_validator_test");
  payment = await h.pg.connect("kauro_payment_test");
  ingress = await h.pg.connect("kauro_ingress_test");
  alice = await h.person("alice-b09");
  bob = await h.person("bob-b09");
  kora = await h.person("kora-corporate-owner");
  A = await h.createAgency(alice, "Payments A");
  B = await h.createAgency(bob, "Payments B");
  await activateAgency(app, A);
  await activateAgency(app, B);
  clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  clientB = await h.endClient(B, await h.processingAuthority(B), "Client B");
  hubspot = await h.offeredCapability("HUBSPOT");
  routes = await qualifiedRoutes(control);
  await grantKauroOwner(control, kora);
  profileA = await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT");
  profileB = await fiscalProfile(app, kora, B, routes.issuerRef, "REVIEW_REQUIRED");
});
after(async () => {
  for (const c of [app, control, assurance, validator, payment, ingress]) await c.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);

/** A HUBSPOT project of the agency with an approved subject and an issued R2-077 quote (discount 32375, service 97125, tax 0). */
async function quotedProject(ag: AgencyFixture, clientId: string, seed: string, profileId: string = profileA) {
  const { projectId } = await project(app, ag, clientId, hubspot, "HUBSPOT");
  const subject = await approvedSubject({ app, control }, validator, assurance, ag, projectId, seed);
  return issuedQuote(app, ag, subject, profileId, routes.issuerRef);
}

async function paidOrder(seed: string): Promise<{ order: OrderFixture; captureId: string; authorizationId: string }> {
  const quote = await quotedProject(A, clientA, seed);
  const order = await createdOrder(app, A, quote, routes, { payment });
  const paid = await observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, hubspot);
  return { order, captureId: paid.captureId, authorizationId: paid.authorizationId as string };
}

interface RegistryContract {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

function registryEnum(contract: string, field: string): string[] {
  const f = registryJson<RegistryContract[]>("contracts.json").find((c) => c.name === contract)?.fields.find((x) => x.name === field);
  assert.ok(f && f.type.startsWith("enum:"), `${contract}.${field}`);
  return f.type.slice(5).split(",");
}

test("B09 seeds: the machines, edges and initial states equal the registry (PaymentAttempt, TaxDocument) and the platform machines; the event types, the aggregate-kind registry and the R2-INITIAL price tables equal the domain and the registry policy", async () => {
  const su = h.oracle;
  const registry = ["PaymentAttempt", "TaxDocument"].map((name) => STATE_MACHINES.find((m) => m.contract === name)!);
  for (const m of [...registry, ...COMMERCE_PLATFORM_MACHINES]) {
    const edges = await su.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [m.contract]);
    assert.deepEqual(edges.rows.map((r) => r.edge), [...new Set(m.transitions.map((t) => `${t.from}>${t.to}`))].sort(), m.contract);
    const initial = await su.query<{ initial_state: string }>("SELECT initial_state FROM kauro.state_machines WHERE machine = $1", [m.contract]);
    assert.equal(initial.rows[0]?.initial_state, m.initial, m.contract);
  }
  const types = await su.query<{ event_type: string }>("SELECT event_type FROM kauro.event_types ORDER BY 1");
  assert.deepEqual(types.rows.map((r) => r.event_type), [...EVENT_TYPES].sort());
  for (const t of COMMERCE_EVENT_TYPES) assert.ok(types.rows.some((r) => r.event_type === t), t);
  // D-EVT-B1: every aggregate kind the domain publishes is registered, with the table and id column the binding reads
  const kinds = await su.query<{ aggregate_kind: string; table_name: string; id_column: string }>("SELECT aggregate_kind, table_name, id_column FROM kauro.aggregate_kinds ORDER BY 1");
  assert.deepEqual(kinds.rows.map((k) => k.aggregate_kind), [...AGGREGATE_KINDS].sort());
  for (const k of kinds.rows) {
    const col = await su.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'kauro' AND table_name = $1 AND column_name IN ($2, 'version', 'agency_id')", [k.table_name, k.id_column]);
    assert.equal(col.rowCount, k.id_column === "agency_id" || k.aggregate_kind === "outreach_send_intent" ? 2 : 3, `${k.aggregate_kind}: ${k.table_name}.${k.id_column}, version and agency_id exist`);
  }
  // the R2-INITIAL bands and tiers of the database are the vendored registry policy's, band by band and at every boundary
  const pricing = (policy() as { pricing: { bands: Array<Record<string, number>>; repeatTiers: Array<{ minimum: number; bps: number }>; foundingDiscountBps: number } }).pricing;
  let previous = 0;
  for (const band of pricing.bands) {
    for (const mode of ["CLEAN", "HUBSPOT", "SALESFORCE"]) {
      for (const units of [previous + 1, band["maximum"]!]) {
        const r = await su.query<{ base: string }>("SELECT kauro.r2_initial_base_cents($1, $2) AS base", [mode, units]);
        assert.equal(Number(r.rows[0]!.base), band[mode], `${mode} ${units}`);
      }
    }
    previous = band["maximum"]!;
  }
  const outside = await su.query<{ zero: string | null; beyond: string | null }>("SELECT kauro.r2_initial_base_cents('CLEAN', 0) AS zero, kauro.r2_initial_base_cents('CLEAN', $1) AS beyond", [previous + 1]);
  assert.deepEqual(outside.rows[0], { zero: null, beyond: null });
  for (const count of [0, 1, 9, 10, 24, 25, 400]) {
    const expected = pricing.repeatTiers.filter((t) => count >= t.minimum).at(-1)!.bps;
    const r = await su.query<{ bps: number }>("SELECT kauro.r2_initial_repeat_bps($1) AS bps", [count]);
    assert.equal(r.rows[0]!.bps, expected, `tier of ${count}`);
  }
  assert.equal(pricing.foundingDiscountBps, 2500);
  // R2-077 and R2-078 through the database's rounding primitive: floor((B x r + 5000) / 10000)
  const money = await su.query<{ discount: string; fee: string }>("SELECT kauro.round_half_up_bps(129500, 2500) AS discount, kauro.round_half_up_bps(97125, 540) + 30 AS fee");
  assert.deepEqual(money.rows[0], { discount: "32375", fee: "5275" });
  const accounts = await su.query<{ def: string }>("SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'kauro.ledger_entries'::regclass AND pg_get_constraintdef(c.oid) LIKE 'CHECK ((account_code = ANY%'");
  assert.deepEqual([...accounts.rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]), [...LEDGER_ACCOUNTS]);
});

test("B09 enum CHECK constraints carry exactly the registry vocabularies of the contracts the tables store", async () => {
  const expect: Array<[string, string, string, string]> = [
    ["quotes", "mode", "Quote", "mode"],
    ["quotes", "currency", "Quote", "currency"],
    ["fiscal_profiles", "tax_treatment", "FiscalProfile", "taxTreatment"],
    ["payment_orders", "state", "PaymentOrder", "state"],
    ["payment_orders", "environment", "PaymentOrder", "environment"],
    ["payment_orders", "currency", "PaymentOrder", "currency"],
    ["payment_attempts", "operation", "PaymentAttempt", "operation"],
    ["payment_attempts", "state", "PaymentAttempt", "state"],
    ["capture_facts", "status", "CaptureFact", "status"],
    ["capture_facts", "environment", "CaptureFact", "environment"],
    ["capture_facts", "currency", "CaptureFact", "currency"],
    ["refunds", "state", "Refund", "state"],
    ["tax_documents", "kind", "TaxDocument", "kind"],
    ["tax_documents", "state", "TaxDocument", "state"],
    ["ledger_entries", "direction", "LedgerEntry", "direction"],
  ];
  for (const [table, column, contract, field] of expect) {
    const r = await h.oracle.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'kauro' AND t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ ('^CHECK \\(\\(' || $2 || ' = (ANY|''[A-Z_]+''::text\\)\\)$)')`,
      [table, column],
    );
    // a one-value vocabulary (currency USD) is printed by the server as an equality, every other one as = ANY (ARRAY[...])
    assert.equal(r.rows.length, 1, `${table}.${column} has one enum CHECK`);
    assert.deepEqual([...r.rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]), registryEnum(contract, field), `${table}.${column}`);
  }
});

test("D-CTX-B1: the payment service is an unprivileged group of its own that sees only the agency it adopted, commerce rows and column-scoped prerequisites — never a plan body, a client, a membership or a person", async () => {
  const role = await h.oracle.query("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'kauro_payment'");
  assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false });
  const quote = await quotedProject(A, clientA, "ctx-b1");
  // nothing is visible before an agency is adopted, and only the adopted agency's rows after
  await within(payment, {}, async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.quotes")).rowCount, 0);
  });
  await within(payment, service(B.agencyId), async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.quotes WHERE quote_id = $1", [quote.quoteId])).rowCount, 0);
  });
  await within(payment, service(A.agencyId), async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.quotes WHERE quote_id = $1", [quote.quoteId])).rowCount, 1);
    assert.equal((await c.query("SELECT state FROM kauro.plans WHERE plan_id = $1", [quote.subject.planId])).rowCount, 1);
  });
  // customer workspace content and people are outside its grants (08 "a service account has only its technical role")
  for (const probe of [
    "SELECT body FROM kauro.plans LIMIT 1",
    "SELECT purpose FROM kauro.projects LIMIT 1",
    "SELECT display_name FROM kauro.end_clients LIMIT 1",
    "SELECT 1 FROM kauro.memberships LIMIT 1",
    "SELECT 1 FROM kauro.identities LIMIT 1",
    "SELECT 1 FROM kauro.corporate_roles LIMIT 1",
    "SELECT display_name FROM kauro.agencies LIMIT 1",
  ]) {
    await assert.rejects(within(payment, service(A.agencyId), (c) => c.query(probe)), refusedWith("42501"), probe);
  }
  // it never creates an order (checkout is the agency's) and never writes a B06 aggregate's event
  await assert.rejects(
    within(payment, service(A.agencyId), (c) =>
      c.query("INSERT INTO kauro.payment_orders (order_id, agency_id, project_id, quote_id, approval_id, provider, environment, route_id, merchant_ref, payee_digest, expected_amount_cents, expected_service_cents, expected_tax_cents, currency, terms_hash, idempotency_hash, created_by_membership_id, intent_entry_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'paypal', 'SANDBOX', $6, $7, $8, 1, 1, 0, 'USD', $9, $9, $10, $11, now(), now())", [
        ids.next(), A.agencyId, quote.projectId, quote.quoteId, quote.subject.approvalId, routes.routeId, routes.merchantRef, routes.payeeDigest, quote.termsHash, A.ownerMembershipId, ids.next(),
      ]),
    ),
    refusedWith("42501"),
  );
  await assert.rejects(within(payment, service(A.agencyId), (c) => commerceEvent(c, "plan", quote.subject.planId, 5, A.agencyId, "plan.approved.v1", PAYMENT_SERVICE)), refusedWith("42501"));
  // the aggregate-kind registry refuses an unregistered kind (D-EVT-B1); a foreign order id is refused like an unknown one (KA006)
  await assert.rejects(within(app, tenant(A), (c) => commerceEvent(c, "invoice_batch", ids.next(), 1, A.agencyId, "quote.drafted.v1", { kind: "USER", id: alice })), (e) => ["KA006", "23503"].includes(sqlState(e)));
  await assert.rejects(within(app, tenant(B, bob), (c) => commerceEvent(c, "quote", quote.quoteId, 3, B.agencyId, "quote.expired.v1", { kind: "USER", id: bob })), refusedWith("KA006"));
});

test("R2-077 and D-QUOTE-B1: a quote carries the exact rounded arithmetic of the registry schedule, the approved plan's own subject, its profile's reviewed rule and its snapshot's applied rate", async () => {
  const quote = await quotedProject(A, clientA, "r2-077");
  const row = await h.oracle.query("SELECT base_service_cents, discount_bps, discount_cents, service_cents, tax_cents, total_cents, state, version FROM kauro.quotes WHERE quote_id = $1", [quote.quoteId]);
  assert.deepEqual(row.rows[0], { base_service_cents: "129500", discount_bps: 2500, discount_cents: "32375", service_cents: "97125", tax_cents: "0", total_cents: "97125", state: "ISSUED", version: "2" });
  const { projectId } = await project(app, A, clientA, hubspot, "HUBSPOT");
  const subject = await approvedSubject({ app, control }, validator, assurance, A, projectId, "r2-077-drift");
  // one cent of drift in the discount is refused (never a float, never a second rounding)
  await assert.rejects(issuedQuote(app, A, subject, profileA, routes.issuerRef, { discountCents: 32376 }), refusedWith("23514", "quotes_discount_arithmetic"));
  // a quote cannot be priced with an unreviewed treatment: the profile's explicit unknown carries no rule (R2-082, R2-128)
  const { projectId: projectB } = await project(app, B, clientB, hubspot, "HUBSPOT");
  const subjectB = await approvedSubject({ app, control }, validator, assurance, B, projectB, "r2-128-quote");
  await assert.rejects(issuedQuote(app, B, subjectB, profileB, routes.issuerRef), refusedWith("23503", "quotes_fiscal_fk"));
  // a second live quote of the same project is refused: the previous one must be superseded first
  await assert.rejects(issuedQuote(app, A, quote.subject, profileA, routes.issuerRef), refusedWith("23505", "quotes_one_live_per_project"));
});

test("CMD028/D-PROTO-B1: an order is the quote's exact amounts through the qualified route's merchant, one open checkout per project; a later attempt follows only a proved no-effect", async () => {
  const quote = await quotedProject(A, clientA, "cmd028");
  const order = await createdOrder(app, A, quote, routes, { payment });
  const row = await h.oracle.query("SELECT state, version, provider_order_id IS NOT NULL AS known, expected_amount_cents FROM kauro.payment_orders WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(row.rows[0], { state: "CREATED", version: "3", known: true, expected_amount_cents: "97125" });
  // a second open order of the project (a concurrent checkout under another key) is refused by the index (CMD028-RACE)
  await assert.rejects(createdOrder(app, A, quote, routes, { acceptQuote: false, payment }), refusedWith("23505", "payment_orders_one_open_per_project"));
  // the provider order identity is learned once (by the payment service, the only writer of provider facts) and never re-pointed
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.payment_orders SET provider_order_id = 'PO-OTHER' WHERE order_id = $1", [order.orderId])), refusedWith("KA004"));
  await assert.rejects(within(app, tenant(A), (c) => c.query("UPDATE kauro.payment_orders SET provider_order_id = 'PO-OTHER' WHERE order_id = $1", [order.orderId])), refusedWith("42501"));
  // the attempt's provider idempotency identity is its own; a second CREATE_ORDER attempt without a proved no-effect is refused
  await assert.rejects(
    within(app, tenant(A), (c) =>
      c.query("INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, 'CAPTURE', 1, $4, $5, $6, $7, now(), now(), now(), now())", [
        ids.next(), A.agencyId, order.orderId, PROVIDER, ENVIRONMENT, sha("again"), `kauro-${ids.next()}`,
      ]),
    ),
    refusedWith("23514", "payment_attempts_request_identity"),
  );
  const second = ids.next();
  await assert.rejects(
    within(app, tenant(A), (c) =>
      c.query("INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, 'CREATE_ORDER', 2, $4, $5, $6, $7, now(), now(), now(), now())", [
        second, A.agencyId, order.orderId, PROVIDER, ENVIRONMENT, sha("again"), `kauro-${second}`,
      ]),
    ),
    refusedWith("KA008"),
  );
});

test("S058/S057: a capture of another payee is never a capture of the order; the obligation is allocated once and exactly; the authorization needs a completed capture that alone pays it", async () => {
  const quote = await quotedProject(A, clientA, "s058");
  const order = await createdOrder(app, A, quote, routes, { payment });
  const full = { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 };
  // S058: a wrong payee cannot be recorded as this order's capture (it becomes a provider event exception instead)
  await assert.rejects(within(payment, service(A.agencyId), (c) => insertCapture(c, A, order, routes, { ...full, payeeDigest: sha("someone-else") }, PAYMENT_SERVICE)), refusedWith("23503", "capture_facts_order_fk"));
  // S057: no authorization without a completed capture — a pending capture carries none (KP004)
  await assert.rejects(
    within(payment, service(A.agencyId), async (c) => {
      const pending = await insertCapture(c, A, order, routes, { amountCents: quote.totalCents, serviceCents: 0, taxCents: 0, excessCents: 0, status: "PENDING" }, PAYMENT_SERVICE);
      await insertAuthorization(c, A, order, pending, hubspot, PAYMENT_SERVICE);
    }),
    refusedWith("KP004"),
  );
  // an allocation that is not exactly min(amount, owed) is refused (KP002), and nobody writes the order's allocation directly
  await assert.rejects(within(payment, service(A.agencyId), (c) => insertCapture(c, A, order, routes, { ...full, serviceCents: quote.serviceCents - 1, excessCents: 1 }, PAYMENT_SERVICE)), refusedWith("KP002"));
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.payment_orders SET allocated_cents = 1 WHERE order_id = $1", [order.orderId])), refusedWith("KP002"));
  await assert.rejects(within(app, tenant(A), (c) => c.query("UPDATE kauro.payment_orders SET allocated_cents = 1 WHERE order_id = $1", [order.orderId])), refusedWith("42501"));
  // the legitimate capture completes the order and carries the authorization in the same transaction
  const paid = await observedCapture(payment, A, order, routes, full, hubspot);
  const allocation = await h.oracle.query("SELECT allocated_cents FROM kauro.payment_orders WHERE order_id = $1", [order.orderId]);
  assert.equal(allocation.rows[0]!.allocated_cents, "97125");
  // one authorization per quote and per capture: a second issuance is refused
  await assert.rejects(within(payment, service(A.agencyId), (c) => insertAuthorization(c, A, order, paid.captureId, hubspot, PAYMENT_SERVICE)), refusedWith("23505"));
  // facts only move forward: COMPLETED never returns to PENDING (KA008), its allocation never changes (KP005)
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.capture_facts SET status = 'PENDING', version = 2 WHERE capture_id = $1", [paid.captureId])), refusedWith("KA008"));
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.capture_facts SET excess_cents = 1, allocated_service_cents = allocated_service_cents - 1, version = 2 WHERE capture_id = $1", [paid.captureId])), refusedWith("KP005"));
});

test("R2-140: a second real capture of a paid obligation is recorded in full as excess — one entitlement, the basis capped to the obligation", async () => {
  const { order, captureId } = await paidOrder("r2-140");
  const quote = order.quote;
  // the second capture applies nothing to the obligation: a claim of service above what is owed is refused
  await assert.rejects(within(payment, service(A.agencyId), (c) => insertCapture(c, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: 0, excessCents: 0 }, PAYMENT_SERVICE)), refusedWith("KP002"));
  const second = await within(payment, service(A.agencyId), (c) => insertCapture(c, A, order, routes, { amountCents: quote.totalCents, serviceCents: 0, taxCents: 0, excessCents: quote.totalCents }, PAYMENT_SERVICE));
  // an excess capture never carries an entitlement (KP004), and the order still has exactly one
  await assert.rejects(within(payment, service(A.agencyId), (c) => insertAuthorization(c, A, order, second, hubspot, PAYMENT_SERVICE)), refusedWith("KP004"));
  const facts = await h.oracle.query("SELECT sum(allocated_service_cents)::text AS service, sum(excess_cents)::text AS excess, count(*)::int AS n FROM kauro.capture_facts WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(facts.rows[0], { service: "97125", excess: "97125", n: 2 });
  const authorizations = await h.oracle.query("SELECT capture_id FROM kauro.commercial_authorizations WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(authorizations.rows, [{ capture_id: captureId }]);
  // the same provider capture identity is one fact across the platform (a repeated event deduplicates)
  const dup = await h.oracle.query("SELECT provider_capture_id FROM kauro.capture_facts WHERE capture_id = $1", [second]);
  await assert.rejects(
    within(payment, service(A.agencyId), (c) =>
      c.query(
        `INSERT INTO kauro.capture_facts (capture_id, agency_id, order_id, status, provider, environment, provider_capture_id, merchant_ref, payee_digest, amount_cents, currency, allocated_service_cents, allocated_tax_cents, excess_cents, provider_completed_at, first_observation_source, first_observed_at, observed_at, evidence_hash, created_at, updated_at)
         VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7, $8, 1, 'USD', 0, 0, 1, now(), 'WEBHOOK', now(), now(), $9, now(), now())`,
        [ids.next(), A.agencyId, order.orderId, PROVIDER, ENVIRONMENT, dup.rows[0]!.provider_capture_id, routes.merchantRef, routes.payeeDigest, sha("dup")],
      ),
    ),
    refusedWith("23505", "capture_facts_provider_identity"),
  );
});

test("S059/D-AUTH-B2: a reversal cannot commit while the entitlement it paid for is live; revoked with the phase of the state it leaves, it commits", async () => {
  const { order, captureId, authorizationId } = await paidOrder("s059");
  const reverse = (c: Client) => c.query("UPDATE kauro.capture_facts SET status = 'REVERSED', observed_at = now(), version = 2 WHERE capture_id = $1", [captureId]).then(() => commerceEvent(c, "capture", captureId, 2, A.agencyId, "capture.reversed.v1", PAYMENT_SERVICE));
  await assert.rejects(within(payment, service(A.agencyId), reverse), refusedWith("KP006"));
  // a revocation must record the phase of the state it leaves (ACTIVE -> PRE_EXECUTION)
  await assert.rejects(
    within(payment, service(A.agencyId), async (c) => {
      await reverse(c);
      await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'POST_DELIVERY', revocation_code = 'CAPTURE_REVERSED', version = 2 WHERE authorization_id = $1", [authorizationId]);
    }),
    refusedWith("KA008"),
  );
  await within(payment, service(A.agencyId), async (c) => {
    await reverse(c);
    await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'CAPTURE_REVERSED', version = 2 WHERE authorization_id = $1", [authorizationId]);
    await commerceEvent(c, "commercial_authorization", authorizationId, 2, A.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
  });
  const state = await h.oracle.query("SELECT a.state, a.revocation_phase, c.status, c.allocated_service_cents FROM kauro.commercial_authorizations a JOIN kauro.capture_facts c ON c.capture_id = a.capture_id WHERE a.authorization_id = $1", [authorizationId]);
  assert.deepEqual(state.rows[0], { state: "REVOKED", revocation_phase: "PRE_EXECUTION", status: "REVERSED", allocated_service_cents: "97125" });
  // the order is never charged again: its allocation stays (a new order of the quote is the agency's deliberate new purchase)
  const allocation = await h.oracle.query("SELECT state, allocated_cents FROM kauro.payment_orders WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(allocation.rows[0], { state: "CAPTURED", allocated_cents: "97125" });
});

test("S060: a price-valid quote whose source expired can be paid for but carries no authorization (the capture is reconciled, the entitlement refused)", async () => {
  const quote = await quotedProject(A, clientA, "s060");
  const order = await createdOrder(app, A, quote, routes, { payment });
  // the source lifecycle's retention_expires edge, as B07's retention sweeper writes it (control plane, server clock past the cap)
  await expireSource({ app, control }, A, quote.projectId, quote.subject.revisionId);
  await assert.rejects(observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, hubspot), refusedWith("KP004"));
  const paid = await observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, null);
  assert.equal(paid.authorizationId, null);
  const facts = await h.oracle.query("SELECT status FROM kauro.capture_facts WHERE capture_id = $1", [paid.captureId]);
  assert.deepEqual(facts.rows, [{ status: "COMPLETED" }]);
});

test("D-MACH-B1: a quote leaves ACCEPTED_FOR_CHECKOUT only when no capture of it is completed, in flight or uncertain", async () => {
  const { order } = await paidOrder("quote-release");
  await assert.rejects(
    within(app, tenant(A), async (c) => {
      await c.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = 4 WHERE quote_id = $1 AND version = 3", [order.quote.quoteId]);
      await commerceEvent(c, "quote", order.quote.quoteId, 4, A.agencyId, "quote.withdrawn.v1", { kind: "USER", id: alice });
    }),
    refusedWith("KA008"),
  );
  const free = await quotedProject(A, clientA, "quote-release-free");
  await createdOrder(app, A, free, routes, { payment });
  await within(app, tenant(A), async (c) => {
    await c.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = 4 WHERE quote_id = $1 AND version = 3", [free.quoteId]);
    await commerceEvent(c, "quote", free.quoteId, 4, A.agencyId, "quote.withdrawn.v1", { kind: "USER", id: alice });
  });
});

test("CMD031/CMD032 boundaries: the agency files its own request; only a corporate owner in the finance scope reviews it, never the requester, never beyond the remaining capture, never outside READ COMMITTED", async () => {
  const { order, captureId } = await paidOrder("refund-boundaries");
  const refundId = await requestRefund(app, A, order, captureId, { serviceCents: 97125, taxCents: 0 });
  // a second open request of the capture is refused (CMD031-RACE)
  await assert.rejects(requestRefund(app, A, order, captureId, { serviceCents: 1, taxCents: 0 }), refusedWith("23505", "refunds_one_requested_per_origin"));
  // the reason is a label: a control character is refused under the field's own constraint name (LABEL_CONSTRAINT_FIELDS)
  await assert.rejects(requestRefund(app, A, order, captureId, { serviceCents: 1, taxCents: 0 }, "bad\u0007reason"), refusedWith("23514", "refunds_reason_code_label"));
  // the agency cannot approve its own request, and the payment service cannot review at all: the row is not theirs to update
  const agencyReview = await within(app, tenant(A), (c) => c.query("UPDATE kauro.refunds SET state = 'REJECTED', version = 2, rejection_code = 'NOPE', rejected_by_user_id = $2, rejected_at = now() WHERE refund_id = $1", [refundId, alice]));
  assert.equal(agencyReview.rowCount, 0, "the agency reviews none of its refunds");
  const serviceReview = await within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.refunds SET state = 'REJECTED', version = 2 WHERE refund_id = $1", [refundId])).catch((e: unknown) => e);
  // since 0080 the payment service may APPROVE with an owner act of its own transaction; a rejection is refused by the review trigger (KP007), never applied
  assert.ok(sqlState(serviceReview) === "42501" || sqlState(serviceReview) === "KP007" || (serviceReview as { rowCount?: number }).rowCount === 0, `the payment service reviews nothing: ${String(sqlState(serviceReview))}`);
  // a person without an ACTIVE KAURO_OWNER grant sees nothing in a finance scope (NOT_FOUND alike), the requester is refused
  // (KP008), a REPEATABLE READ approval is refused before it waits (KP009), an amount above the capture is refused (KP003)
  await assert.rejects(approveRefund(app, assurance, bob, A, refundId, { serviceCents: 97125, taxCents: 0 }), (e) => (e as { code?: string }).code === "NO_ROW");
  await grantKauroOwner(control, alice);
  await assert.rejects(approveRefund(app, assurance, alice, A, refundId, { serviceCents: 97125, taxCents: 0 }), refusedWith("KP008"));
  await assert.rejects(approveRefund(app, assurance, kora, A, refundId, { serviceCents: 97125, taxCents: 0 }, { isolation: "REPEATABLE READ" }), refusedWith("KP009"));
  await assert.rejects(approveRefund(app, assurance, kora, A, refundId, { serviceCents: 97126, taxCents: 0 }), refusedWith("KP003"));
  // a step-up proof of someone else is not the approver's (the key binds the proof to its owner)
  await approveRefund(app, assurance, kora, A, refundId, { serviceCents: 97125, taxCents: 0 });
  const approved = await h.oracle.query("SELECT state, approved_service_cents, approved_by_user_id FROM kauro.refunds WHERE refund_id = $1", [refundId]);
  assert.deepEqual(approved.rows[0], { state: "APPROVED", approved_service_cents: "97125", approved_by_user_id: kora });
  // the intent is immutable once recorded (since 0080 the payment service holds the column for the approval; the immutability trigger refuses the re-pointing, KA004)
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.refunds SET approved_service_cents = 1 WHERE refund_id = $1", [refundId])), refusedWith("KA004"));
});

test("CMD032-RACE (D-REF-B3): an approval and a reversal of the same capture are ordered — the approval that waited for the reversal sees it and commits nothing", async () => {
  const { order, captureId, authorizationId } = await paidOrder("refund-race");
  const refundId = await requestRefund(app, A, order, captureId, { serviceCents: 97125, taxCents: 0 });
  const reverser = await h.pg.connect("kauro_payment_test");
  const approver = await h.pg.connect("kauro_app_test");
  try {
    await reverser.query("BEGIN");
    await reverser.query("SELECT set_config('kauro.agency_id', $1, true)", [A.agencyId]);
    await reverser.query("UPDATE kauro.capture_facts SET status = 'REVERSED', observed_at = now(), version = 2 WHERE capture_id = $1", [captureId]);
    await commerceEvent(reverser, "capture", captureId, 2, A.agencyId, "capture.reversed.v1", PAYMENT_SERVICE);
    await reverser.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'CAPTURE_REVERSED', version = 2 WHERE authorization_id = $1", [authorizationId]);
    await commerceEvent(reverser, "commercial_authorization", authorizationId, 2, A.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
    const pid = await backendPid(approver);
    const observed = await settlesOrWaits(h.oracle, pid, approveRefund(approver, assurance, kora, A, refundId, { serviceCents: 97125, taxCents: 0 }), "the approval racing a reversal");
    if (observed.kind !== "WAITING") assert.fail(`the approval did not wait for the reversal in flight: ${JSON.stringify(observed.outcome.status)}`);
    await reverser.query("COMMIT");
    const outcome = await observed.pending;
    assert.equal(outcome.status, "rejected");
    assert.equal(sqlState((outcome as PromiseRejectedResult).reason), "KP003");
  } finally {
    await reverser.end();
    await approver.end();
  }
  const refund = await h.oracle.query("SELECT state FROM kauro.refunds WHERE refund_id = $1", [refundId]);
  assert.deepEqual(refund.rows, [{ state: "REQUESTED" }]);
});

test("D-REF-B5: a completed refund of the whole service cannot commit while the entitlement is live (KP006); revoked in the same transaction, it commits", async () => {
  const { order, captureId, authorizationId } = await paidOrder("full-refund");
  const refundId = await requestRefund(app, A, order, captureId, { serviceCents: 97125, taxCents: 0 });
  await approveRefund(app, assurance, kora, A, refundId, { serviceCents: 97125, taxCents: 0 });
  const attemptId = ids.next();
  await within(payment, service(A.agencyId), async (c) => {
    await c.query("INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, refund_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'REFUND', 1, $5, $6, $7, $8, now(), now(), now(), now())", [
      attemptId, A.agencyId, order.orderId, refundId, PROVIDER, ENVIRONMENT, sha(`refund-request-${refundId}`), `kauro-${attemptId}`,
    ]);
    await commerceEvent(c, "payment_attempt", attemptId, 1, A.agencyId, "payment_attempt.prepared.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_attempts SET state = 'DISPATCHING', dispatch_deadline_at = now() + interval '60 seconds', version = 2 WHERE attempt_id = $1", [attemptId]);
    await commerceEvent(c, "payment_attempt", attemptId, 2, A.agencyId, "payment_attempt.dispatching.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'SUBMITTING', version = 3 WHERE refund_id = $1", [refundId]);
    await commerceEvent(c, "refund", refundId, 3, A.agencyId, "refund.submitting.v1", PAYMENT_SERVICE);
  });
  const complete = async (c: Client) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, version = 3 WHERE attempt_id = $1", [attemptId, sha("refund-evidence")]);
    await commerceEvent(c, "payment_attempt", attemptId, 3, A.agencyId, "payment_attempt.confirmed.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'COMPLETED', provider_refund_id = 'RF-1', evidence_hash = $2, completed_at = now(), version = 4 WHERE refund_id = $1", [refundId, sha("refund-evidence")]);
    await commerceEvent(c, "refund", refundId, 4, A.agencyId, "refund.completed.v1", PAYMENT_SERVICE);
  };
  await assert.rejects(within(payment, service(A.agencyId), complete), refusedWith("KP006"));
  await within(payment, service(A.agencyId), async (c) => {
    await complete(c);
    await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'SERVICE_FULLY_REFUNDED', version = 2 WHERE authorization_id = $1", [authorizationId]);
    await commerceEvent(c, "commercial_authorization", authorizationId, 2, A.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
  });
});

test("R2-128/D-FISC-B1: an unreviewed treatment stays a blocked draft that cannot be validated, while the capture's reconciliation is untouched; a reviewed one validates only with the collected amounts", async () => {
  const { order, captureId } = await paidOrder("r2-128");
  const draft = async (profileId: string, treatment: string, rule: string, blocked: string | null, agencyId = A.agencyId) => {
    const documentId = ids.next();
    await within(payment, service(agencyId), async (c) => {
      await c.query(
        `INSERT INTO kauro.tax_documents (document_id, agency_id, order_id, capture_id, kind, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, service_cents, tax_cents, currency, blocked_reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'INVOICE', $5, $6, $7, $8, 0, 97125, 0, 'USD', $9, now(), now())`,
        [documentId, agencyId, order.orderId, captureId, profileId, routes.issuerRef, treatment, rule, blocked],
      );
      await commerceEvent(c, "tax_document", documentId, 1, agencyId, "tax_document.drafted.v1", PAYMENT_SERVICE);
    });
    return documentId;
  };
  // an unreviewed draft must name its blocker; a profile of another agency cannot be cited
  await assert.rejects(draft(profileB, "REVIEW_REQUIRED", "UNRESOLVED", null), (e) => ["23514", "23503"].includes(sqlState(e)));
  // A's own blocked draft: the agency's profile is re-reviewed to REVIEW_REQUIRED while the capture stays COMPLETED
  const reReviewed = await fiscalProfile(app, kora, A, routes.issuerRef, "REVIEW_REQUIRED", profileA);
  const blocked = await draft(reReviewed, "REVIEW_REQUIRED", "UNRESOLVED", "FISCAL_TREATMENT_UNREVIEWED");
  await assert.rejects(
    within(payment, service(A.agencyId), async (c) => {
      await c.query("UPDATE kauro.tax_documents SET state = 'VALIDATED', blocked_reason = NULL, version = 2 WHERE document_id = $1", [blocked]);
    }),
    (e) => ["23514", "KA004", "KP011"].includes(sqlState(e)),
  );
  const capture = await h.oracle.query("SELECT status FROM kauro.capture_facts WHERE capture_id = $1", [captureId]);
  assert.deepEqual(capture.rows, [{ status: "COMPLETED" }]);
  // restored to the priced treatment by a new review, the draft is re-pointed and validates with the collected amounts
  const restored = await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT", reReviewed);
  await within(payment, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.tax_documents SET fiscal_profile_id = $2, tax_treatment = 'EXEMPT_EXPORT', tax_rule = 'ZERO_REVIEWED', blocked_reason = NULL, version = 2 WHERE document_id = $1", [blocked, restored]);
    await commerceEvent(c, "tax_document", blocked, 2, A.agencyId, "tax_document.drafted.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.tax_documents SET state = 'VALIDATED', version = 3 WHERE document_id = $1", [blocked]);
    await commerceEvent(c, "tax_document", blocked, 3, A.agencyId, "tax_document.validated.v1", PAYMENT_SERVICE);
  });
  // a legal number exists only with authenticated issuance evidence
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.tax_documents SET legal_number = 'SETP-1', version = 4 WHERE document_id = $1", [blocked])), refusedWith("23514"));
});

test("R2-078/D-LEDGER-B1: postings balance per source and currency at COMMIT, a replayed source posts nothing, and bank cash needs a bank statement", async () => {
  const { captureId } = await paidOrder("r2-078");
  // the capture's completion event is the posting set's source (its idempotency identity)
  const source = await h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_kind = 'capture' AND aggregate_id = $1", [captureId]);
  const eventId = source.rows[0]!.event_id;
  const post = async (c: Client, lines: Array<[number, string, "DEBIT" | "CREDIT", number]>): Promise<void> => {
    for (const [lineNo, account, direction, amount] of lines) {
      await c.query(
        `INSERT INTO kauro.ledger_entries (entry_id, agency_id, domain_event_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, effective_at, observed_at, posted_at, evidence_hash, policy_version)
         VALUES ($1, $2, $3, $4, $5, 'OPS-1', $6, $7, 'USD', 'CAPTURE', $8, now(), now(), now(), $9, 'B09-1')`,
        [ids.next(), A.agencyId, eventId, lineNo, account, direction, amount, captureId, sha(`posting-${captureId}`)],
      );
    }
  };
  // commerce/ledger capturePostings + providerFeePostings of the provider's actual fee (the illustration's 5275 here)
  const lines: Array<[number, string, "DEBIT" | "CREDIT", number]> = [
    [1, "PSP_RECEIVABLE", "DEBIT", 97125],
    [2, "CONTRACT_LIABILITY", "CREDIT", 97125],
    [3, "PROCESSOR_EXPENSE", "DEBIT", 5275],
    [4, "PSP_RECEIVABLE", "CREDIT", 5275],
  ];
  await assert.rejects(within(payment, service(A.agencyId), (c) => post(c, [[1, "PSP_RECEIVABLE", "DEBIT", 97125], [2, "CONTRACT_LIABILITY", "CREDIT", 97124]])), refusedWith("KP001"));
  await within(payment, service(A.agencyId), (c) => post(c, lines));
  // a replayed delivery of the same event posts nothing: the source and line identity is taken
  await assert.rejects(within(payment, service(A.agencyId), (c) => post(c, lines)), refusedWith("23505"));
  // another agency's adopted scope can neither post for A nor read A's postings
  // (the source event of another agency is not visible to it: the source binding refuses before row security would, KP001)
  await assert.rejects(within(payment, service(B.agencyId), (c) => post(c, [[5, "PSP_RECEIVABLE", "DEBIT", 1], [6, "PSP_RECEIVABLE", "CREDIT", 1]])), refusedWith("KP001"));
  const net = await within(payment, service(A.agencyId), async (c) => {
    const r = await c.query<{ net: string }>("SELECT sum(CASE direction WHEN 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS net FROM kauro.ledger_entries WHERE account_code = 'PSP_RECEIVABLE' AND source_ref = $1", [captureId]);
    return r.rows[0]!.net;
  });
  assert.equal(net, "91850", "R2-078: the net receivable after the actual fee");
  // a provider-available balance is not bank cash: a bank-available amount without a bank statement is refused (CMD034-DENY)
  const settle = (bank: number, evidence: string | null) =>
    within(payment, {}, (c) =>
      c.query(
        `INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents, bank_evidence_hash, period_start, period_end, observed_at, evidence_hash, created_at)
         VALUES ($1, $2, $3, 'USD', 97125, 5275, 0, 91850, $4, $5, now() - interval '1 day', now(), now(), $6, now())`,
        [ids.next(), routes.routeId, ids.next(), bank, evidence, sha("settlement")],
      ),
    );
  await assert.rejects(settle(91850, null), refusedWith("23514", "settlements_bank_evidence"));
  await settle(91850, sha("bank-statement"));
});

test("D-SCOPE-B1/D-ING-B1: the scope index maps stored operations to their agency for the payment service and REFUND rows for owners only; the ingress records its own CMD030 facts; the payment service settles only payment providers' inbox records", async () => {
  const { order } = await paidOrder("scope-index");
  await within(payment, {}, async (c) => {
    const r = await c.query<{ agency_id: string }>("SELECT agency_id FROM kauro.commerce_scopes WHERE scope_kind = 'PAYMENT_ORDER' AND scope_key = $1", [order.orderId]);
    assert.deepEqual(r.rows, [{ agency_id: A.agencyId }]);
  });
  await within(app, tenant(B, bob), async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.commerce_scopes WHERE scope_key = $1", [order.orderId])).rowCount, 0, "another agency cannot see the order's scope");
  });
  await within(app, operator(kora, A.agencyId), async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.commerce_scopes WHERE scope_kind = 'PAYMENT_ORDER'")).rowCount, 0, "an owner resolves refunds only");
  });
  await assert.rejects(within(app, tenant(A), (c) => c.query("UPDATE kauro.commerce_scopes SET agency_id = $2 WHERE scope_key = $1", [order.orderId, B.agencyId])), (e) => ["42501", "KA004"].includes(sqlState(e)));
  // the ingress: an anonymous denial and a provider acceptance of CMD030, nothing else
  const fact = (actorKind: string, actorId: string | null, outcome: string, action = "CMD030") =>
    ingress.query(
      "INSERT INTO kauro.security_events (security_event_id, actor_kind, actor_id, action, outcome, reason_code, policy_version, assurance_class, correlation_id, occurred_at) VALUES ($1, $2, $3, $4, $5, NULL, 'B09-1', 'NONE', $6, now())",
      [ids.next(), actorKind, actorId, action, outcome, ids.next()],
    );
  await fact("ANONYMOUS", null, "DENY");
  await fact("SERVICE", PROVIDER, "ALLOW");
  await assert.rejects(fact("SERVICE", PROVIDER, "ALLOW", "CMD029"), refusedWith("42501"));
  await assert.rejects(fact("ANONYMOUS", null, "ALLOW"), (e) => ["42501", "23514"].includes(sqlState(e)));
  // the payment service settles the records of providers that have a merchant route, and sees no other provider's
  const inboxOf = async (provider: string) => {
    const inboxId = ids.next();
    await ingress.query("INSERT INTO kauro.inbox_records (inbox_id, provider, environment, external_event_id, body_hash, state, received_at, updated_at) VALUES ($1, $2, 'SANDBOX', $3, $4, 'RECEIVED', now(), now())", [inboxId, provider, `evt-${inboxId}`, sha(inboxId)]);
    return inboxId;
  };
  const ours = await inboxOf(PROVIDER);
  const theirs = await inboxOf("other-provider");
  await within(payment, {}, async (c) => {
    assert.equal((await c.query("UPDATE kauro.inbox_records SET state = 'IGNORED' WHERE inbox_id = $1", [ours])).rowCount, 1);
    assert.equal((await c.query("UPDATE kauro.inbox_records SET state = 'IGNORED' WHERE inbox_id = $1", [theirs])).rowCount, 0);
  });
  // a verified event no order can take is an exception of the platform, kept for the owner's review (S058)
  await within(payment, {}, (c) =>
    c.query("INSERT INTO kauro.provider_event_exceptions (exception_id, source, inbox_id, provider, environment, kind, provider_ref, evidence_hash, observed_at, created_at) VALUES ($1, 'WEBHOOK', $2, $3, 'SANDBOX', 'UNKNOWN_PROVIDER_REFERENCE', 'PO-UNKNOWN', $4, now(), now())", [ids.next(), ours, PROVIDER, sha("exception")]),
  );
  await within(app, operator(kora, A.agencyId), async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.provider_event_exceptions WHERE inbox_id = $1", [ours])).rowCount, 1);
  });
  await within(app, tenant(B, bob), async (c) => {
    assert.equal((await c.query("SELECT 1 FROM kauro.provider_event_exceptions")).rowCount, 0, "an agency never sees the platform's exceptions");
  });
});

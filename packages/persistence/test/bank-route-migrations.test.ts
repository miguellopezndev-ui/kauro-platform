// Payments V1 bank-transfer route, lane L-ROUTE (migration 0046; coordinator decisions #1 and #2 amended (a)): the agency-less route events are
// visible to an acting corporate owner only, never to an agency session; agency events bind exactly as before; the payment_routes row of a
// bank route is written only through kauro.register_bank_payment_route, by an ACTIVE KAURO_OWNER acting as itself, CONFIGURED only; a request
// handler can never insert into payment_routes directly; the transfer reference is immutable for every role.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { UserId } from "@kauro/domain";
import { startHarness, type AgencyFixture, type Harness } from "../src/testing/index.js";
import { event, ids, sha, sqlState, tx } from "./support.js";

let h: Harness;
let app: Client;
let owner: UserId;
let stranger: UserId;
let A: AgencyFixture;

before(async () => {
  h = await startHarness();
  app = await h.pg.connect("kauro_app_test");
  owner = await h.person("route-owner");
  await h.grantKauroOwner(owner);
  stranger = await h.person("route-stranger");
  A = await h.createAgency(stranger, "Route Agency");
});
after(async () => {
  await app.end();
  await h.stop();
});

const register = (c: Client, routeId: string, cls = "CONTRACT_FAKE") =>
  c.query("SELECT kauro.register_bank_payment_route($1, 'contract-fake-bank', 'SANDBOX', $1, $2, $3)", [routeId, sha(`payee-${routeId}`), cls]);

/** A route configured by the owner in its own OPERATOR session (agency NULL): its payment route, the route row and its first event. */
async function configuredRoute(): Promise<string> {
  const routeId = ids.next();
  const paymentRouteId = ids.next();
  await tx(app, { userId: owner }, async (c) => {
    await c.query("SELECT kauro.register_bank_payment_route($1, 'contract-fake-bank', 'SANDBOX', $2, $3, 'CONTRACT_FAKE')", [paymentRouteId, routeId, sha(`payee-${routeId}`)]);
    await c.query(
      "INSERT INTO kauro.bank_routes (route_id, agency_id, environment, account_ref, provider, integration_class, currency, payment_route_id, created_by) VALUES ($1, NULL, 'SANDBOX', $2, 'contract-fake-bank', 'CONTRACT_FAKE', 'USD', $3, $4)",
      [routeId, `acct-${routeId}`, paymentRouteId, owner],
    );
    await event(c, { aggregateKind: "bank_route", aggregateId: routeId, aggregateVersion: 1, agencyId: null as never, eventType: "bank_route.configured.v1", actorUserId: owner, payload: { routeId } });
  });
  return routeId;
}

test("an agency-less route event is visible to the acting corporate owner only, never to an agency session; the event binding refuses one ahead of the route's version", async () => {
  const routeId = await configuredRoute();
  const asOwner = await tx(app, { userId: owner }, async (c) => (await c.query("SELECT 1 FROM kauro.domain_events WHERE aggregate_id = $1", [routeId])).rowCount);
  assert.equal(asOwner, 1, "the owner reads the route's event");
  const asAgency = await tx(app, { agencyId: A.agencyId, userId: stranger }, async (c) => (await c.query("SELECT 1 FROM kauro.domain_events WHERE aggregate_id = $1", [routeId])).rowCount);
  assert.equal(asAgency, 0, "an agency session never sees an agency-less event");
  const asNobody = await tx(app, { userId: stranger }, async (c) => (await c.query("SELECT 1 FROM kauro.domain_events WHERE aggregate_id = $1", [routeId])).rowCount);
  assert.equal(asNobody, 0, "a person without the grant does not either");
  const outboxAsAgency = await tx(app, { agencyId: A.agencyId, userId: stranger }, async (c) => (await c.query("SELECT 1 FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE e.aggregate_id = $1", [routeId])).rowCount);
  assert.equal(outboxAsAgency, 0);
  // the binding: version 2 of a route at version 1 is refused (KA002), and an agency session cannot write an agency-less event at all
  await assert.rejects(
    tx(app, { userId: owner }, (c) => event(c, { aggregateKind: "bank_route", aggregateId: routeId, aggregateVersion: 2, agencyId: null as never, eventType: "bank_route.verified.v1", actorUserId: owner, payload: { routeId } })),
    (e) => sqlState(e) === "KA002",
  );
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: stranger }, (c) => event(c, { aggregateKind: "bank_route", aggregateId: routeId, aggregateVersion: 1, agencyId: null as never, eventType: "bank_route.configured.v1", actorUserId: stranger, payload: { routeId } })),
    (e) => sqlState(e) === "42501" || sqlState(e) === "KA006",
  );
});

test("agency events bind exactly as before: an event of the agency's own aggregate passes, one naming it under another agency is KA006", async () => {
  const projectEvent = await h.oracle.query<{ aggregate_id: string; aggregate_version: string }>("SELECT aggregate_id, aggregate_version FROM kauro.domain_events WHERE agency_id = $1 AND aggregate_kind = 'agency' ORDER BY aggregate_version DESC LIMIT 1", [A.agencyId]);
  assert.equal(projectEvent.rows.length, 1, "the agency's own events were bound");
  await assert.rejects(
    tx(app, { userId: owner }, (c) => event(c, { aggregateKind: "agency", aggregateId: A.agencyId, aggregateVersion: 1, agencyId: null as never, eventType: "agency.created.v1", actorUserId: owner, payload: { agencyId: A.agencyId } })),
    (e) => sqlState(e) === "42501" || sqlState(e) === "KA006",
    "an agency aggregate never binds an agency-less event",
  );
});

test("payment_routes: a request handler never inserts directly; the registration function refuses a non-owner, an agency session and any class but CONTRACT_FAKE or PROVIDER, and writes CONFIGURED rows only", async () => {
  await assert.rejects(
    tx(app, { userId: owner }, (c) =>
      c.query("INSERT INTO kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, state, created_at, updated_at) VALUES ($1, 'contract-fake-bank', 'SANDBOX', $1, $2, 'USD', 'CONTRACT_FAKE', 'CONFIGURED', now(), now())", [ids.next(), sha("direct")]),
    ),
    (e) => sqlState(e) === "42501",
    "kauro_app holds no INSERT on payment_routes",
  );
  await assert.rejects(tx(app, { userId: stranger }, (c) => register(c, ids.next())), (e) => sqlState(e) === "42501", "a person without the KAURO_OWNER grant");
  await assert.rejects(tx(app, { agencyId: A.agencyId, userId: owner }, (c) => register(c, ids.next())), (e) => sqlState(e) === "42501", "the owner inside an agency session");
  await assert.rejects(tx(app, { userId: owner }, (c) => register(c, ids.next(), "QUALIFIED")), (e) => sqlState(e) === "22023", "no other class");
  const routeId = ids.next();
  await tx(app, { userId: owner }, (c) => register(c, routeId));
  const row = await h.oracle.query<{ state: string; integration_class: string; qualification_evidence_hashes: unknown[] }>("SELECT state, integration_class, qualification_evidence_hashes FROM kauro.payment_routes WHERE route_id = $1", [routeId]);
  assert.deepEqual(row.rows, [{ state: "CONFIGURED", integration_class: "CONTRACT_FAKE", qualification_evidence_hashes: [] }]);
  // the function signature carries no state, evidence or validity: a registered row can only be CONFIGURED
  const args = await h.oracle.query<{ args: string }>("SELECT pg_get_function_identity_arguments('kauro.register_bank_payment_route'::regproc) AS args");
  assert.equal(args.rows[0]!.args, "p_route_id uuid, p_provider text, p_environment text, p_merchant_ref uuid, p_payee_digest text, p_integration_class text");
});

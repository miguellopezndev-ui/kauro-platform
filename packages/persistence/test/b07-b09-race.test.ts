// The one cross-package race of the B07 + B09 merge (docs/design/B07-B09-merge.md; B07 design §17 item 4, B09 design §15): the
// source lifecycle's retention expiry of a sealed revision (B07's retention sweeper, retention_expires, under kauro_control bound to
// the agency, on the server clock past the governing record's deadline) and the payment service's issuance of a commercial
// authorization bound to that revision (B09, under kauro_payment; KP004 "the purchased subject still binds", which requires the
// quoted revision SEALED). Both writers name the revision's B06 transition lock: the expiry takes its exclusive half (the lifecycle
// guard of the state change), the issuance its shared half (commercial_authorizations_require_capture, kauro.await_transition). So
// the two serialize in either order, on real PostgreSQL 17 through the runtime login roles: the second writer is seen waiting on
// the advisory lock in pg_stat_activity (never a sleep), and each order ends in exactly one consistent outcome — expiry first, the
// issuance is refused KP004 and nothing of the capture's transaction remains; issuance first, the authorization stands (issued
// while the revision was SEALED) and the expiry then commits behind it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { UserId } from "@kauro/domain";
import { backendPid, barrier, settlesOrWaits, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { clockAt, expireSealedRevision } from "../src/testing/source-lifecycle.js";
import { activateAgency, approvedSubject, createdOrder, fiscalProfile, grantKauroOwner, issuedQuote, observedCapture, qualifiedRoutes, type Routes } from "./commerce-support.js";
import { project, sqlState } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let assurance: Client;
let validator: Client;
let payment: Client;
let A: AgencyFixture;
let routes: Routes;
let hubspot: string;
let clientA: string;
let profileA: string;

const DAY_MS = 86_400_000;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  validator = await h.pg.connect("kauro_validator_test");
  payment = await h.pg.connect("kauro_payment_test");
  const alice = (await h.person("alice-b07-b09-race")) as UserId;
  const kora = (await h.person("kora-b07-b09-race")) as UserId;
  A = await h.createAgency(alice, "Race A");
  await activateAgency(app, A);
  clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  hubspot = await h.offeredCapability("HUBSPOT");
  routes = await qualifiedRoutes(control);
  await grantKauroOwner(control, kora);
  profileA = await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT");
});
after(async () => {
  for (const c of [app, control, assurance, validator, payment]) await c.end();
  await h.stop();
});

/** An order of a HUBSPOT project whose quote names a revision sealed through the source lifecycle an hour ago, not yet paid. */
async function unpaidOrder(seed: string) {
  const { projectId } = await project(app, A, clientA, hubspot, "HUBSPOT");
  const subject = await approvedSubject({ app, control }, validator, assurance, A, projectId, seed);
  const quote = await issuedQuote(app, A, subject, profileA, routes.issuerRef);
  const order = await createdOrder(app, A, quote, routes, { payment });
  return { projectId, revisionId: subject.revisionId, quote, order };
}

/** Opens the retention sweeper's transaction: kauro_control bound to the agency, its TEST CLOCK fifteen days ahead (past the cap). */
async function openExpiry(): Promise<void> {
  await control.query("BEGIN");
  await control.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [A.agencyId]);
  await clockAt(control, new Date(Date.now() + 15 * DAY_MS));
}

async function oracle<R extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown>): Promise<R[]> {
  return (await h.oracle.query<R>(sql, params as unknown[])).rows;
}

async function waitsOnTransitionLock(pid: number): Promise<void> {
  const seen = await oracle<{ wait_event_type: string; wait_event: string }>("SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1", [pid]);
  assert.deepEqual(seen, [{ wait_event_type: "Lock", wait_event: "advisory" }], "waiting on the revision's advisory transition lock");
}

test("B07+B09 RACE: a retention expiry and a commercial authorization issuance of one revision serialize on its transition lock in either order — expiry first, the issuance waits (pg_stat_activity) and is refused KP004 with nothing of its capture left; issuance first, the expiry waits and commits behind the authorization issued while the revision was SEALED", async () => {
  // --- interleaving 1: the retention sweeper's expiry holds the exclusive half first ---------------------------------------------
  const first = await unpaidOrder("race-expiry-first");
  const scope1 = { agencyId: A.agencyId, projectId: first.projectId, ownerUserId: A.ownerUserId, ownerMembershipId: A.ownerMembershipId };
  await openExpiry();
  let expired = false;
  try {
    await expireSealedRevision(control, scope1, first.revisionId);
    const issuerPid = await backendPid(payment);
    const issuance = observedCapture(payment, A, first.order, routes, { amountCents: first.quote.totalCents, serviceCents: first.quote.serviceCents, taxCents: first.quote.taxCents, excessCents: 0 }, hubspot);
    const seen = await settlesOrWaits(h.oracle, issuerPid, issuance, "the issuance behind the uncommitted expiry");
    assert.equal(seen.kind, "WAITING", "the issuance waits for the expiry");
    if (seen.kind !== "WAITING") return;
    await waitsOnTransitionLock(issuerPid);
    await control.query("COMMIT");
    expired = true;
    const settled = await seen.pending;
    assert.equal(settled.status, "rejected", "the issuance is refused once the revision EXPIRED");
    assert.equal(sqlState(settled.status === "rejected" ? settled.reason : null), "KP004");
  } finally {
    if (!expired) await control.query("ROLLBACK");
  }
  assert.deepEqual(await oracle("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [first.revisionId]), [{ state: "EXPIRED" }]);
  assert.deepEqual(await oracle("SELECT count(*)::int AS n FROM kauro.commercial_authorizations WHERE quote_id = $1", [first.quote.quoteId]), [{ n: 0 }]);
  assert.deepEqual(await oracle("SELECT count(*)::int AS n FROM kauro.capture_facts WHERE order_id = $1", [first.order.orderId]), [{ n: 0 }], "the issuance's transaction left nothing");
  assert.deepEqual(await oracle("SELECT state FROM kauro.retention_records WHERE revision_id = $1", [first.revisionId]), [{ state: "EXPIRED" }]);

  // --- interleaving 2: the payment service's issuance holds the shared half first ------------------------------------------------
  const second = await unpaidOrder("race-issuance-first");
  const scope2 = { agencyId: A.agencyId, projectId: second.projectId, ownerUserId: A.ownerUserId, ownerMembershipId: A.ownerMembershipId };
  const issued = barrier();
  const release = barrier();
  const issuance = observedCapture(payment, A, second.order, routes, { amountCents: second.quote.totalCents, serviceCents: second.quote.serviceCents, taxCents: second.quote.taxCents, excessCents: 0 }, hubspot, 3, async () => {
    issued.open();
    await release.wait;
  });
  await issued.wait;
  await openExpiry();
  let committed = false;
  try {
    const sweeperPid = await backendPid(control);
    const expiry = expireSealedRevision(control, scope2, second.revisionId);
    const seen = await settlesOrWaits(h.oracle, sweeperPid, expiry, "the expiry behind the uncommitted issuance");
    assert.equal(seen.kind, "WAITING", "the expiry waits for the issuance");
    if (seen.kind !== "WAITING") return;
    await waitsOnTransitionLock(sweeperPid);
    release.open();
    const paid = await issuance;
    assert.ok(paid.authorizationId !== null, "the authorization is issued while the revision is SEALED");
    const settled = await seen.pending;
    assert.equal(settled.status, "fulfilled", "the expiry commits behind the issuance");
    await control.query("COMMIT");
    committed = true;
    assert.deepEqual(await oracle("SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [paid.authorizationId]), [{ state: "ACTIVE" }]);
  } finally {
    release.open();
    if (!committed) await control.query("ROLLBACK");
  }
  assert.deepEqual(await oracle("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [second.revisionId]), [{ state: "EXPIRED" }]);
  const events = await oracle<{ event_type: string }>("SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version DESC LIMIT 1", [second.revisionId]);
  assert.deepEqual(events, [{ event_type: "dataset_revision.expired.v1" }]);
});

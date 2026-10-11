// The sales and attribution adapters of package B10 (mandate B10-ADAPTERS-SALES; docs/design/B10-commercial-domain.md §2, §5, §10,
// §11, §12; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime login roles: the corporate owner and the
// sellers in OPERATOR units of work of the commerce factory (kauro_app_test), the commission service on its own login
// (kauro_commission_test) in the agency it adopted, the payment service reconciling the purchases (kauro_payment_test). The superuser
// only reads (row digests, exact instants) and never writes a row under test. The setup of the sales rows is the test-only fixtures of
// @kauro/persistence/testing (sales-fixtures.ts), each row written by the role that owns it; the purchases and the accrued lines are
// the schema support's (b10-commission-support.ts), written as the payment and commission services write them.
import { invariantsAfterEach } from "../src/testing/invariants.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgencyId, AssistanceAgreementId, CommissionEntitlementId, ProjectId, SellerId } from "@kauro/domain";
import { PgAttributionRepository, PgSalesRepository, attributionOf, salesOf, type PgCommerceUnitOfWork } from "../src/index.js";
import { clock } from "../src/testing/harness.js";
import { recordActiveSeller, recordAssistanceAgreement, recordClaim, recordConversion, recordFrozenAllocation, recordProspect, recordServiceAssignment } from "../src/testing/index.js";
import {
  accrue,
  agencyWith,
  closeWorld,
  digest,
  ids,
  openWorld,
  orderOf,
  purchase,
  quoteOf,
  refusedWith,
  service,
  settle,
  subjectOf,
  within,
  type Purchase,
  type World,
} from "./b10-commission-support.js";

let w: World;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => w.h.oracle);

before(async () => {
  w = await openWorld("b10-sales-adapters");
});
after(async () => {
  await closeWorld(w);
});

/** The corporate owner's OPERATOR unit of work (its person bound, no agency; an ACTIVE KAURO_OWNER grant). */
const asOwner = <T>(work: (uow: PgCommerceUnitOfWork) => Promise<T>): Promise<T> => w.h.commerce.run(w.h.operator(w.kora), (uow) => work(uow as PgCommerceUnitOfWork));
/** A person's own OPERATOR unit of work (a seller's). */
const asPerson = <T>(userId: string, work: (uow: PgCommerceUnitOfWork) => Promise<T>): Promise<T> =>
  w.h.commerce.run(w.h.operator(userId as Parameters<typeof w.h.operator>[0]), (uow) => work(uow as PgCommerceUnitOfWork));

/** A column read by the oracle as the domain's canonical instant (UTC, milliseconds), as the adapters read it (commercial-sales-rows.ts). */
async function exactInstant(sql: string, params: ReadonlyArray<unknown>): Promise<string> {
  const r = await w.h.oracle.query<{ at: string }>(`SELECT to_char(x.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM (${sql}) x`, [...params]);
  assert.equal(r.rows.length, 1, "one instant");
  return r.rows[0]!.at;
}

/** The order creation instant and confirmation sequence of a qualifying purchase, as the designation recorded them. */
async function purchaseFacts(p: Purchase): Promise<{ readonly orderCreatedAt: string; readonly seq: number }> {
  const orderCreatedAt = await exactInstant("SELECT order_created_at AS at FROM kauro.qualifying_purchases WHERE authorization_id = $1", [p.authorizationId]);
  const seq = await w.h.oracle.query<{ confirmation_seq: number }>("SELECT confirmation_seq FROM kauro.qualifying_purchases WHERE authorization_id = $1", [p.authorizationId]);
  return { orderCreatedAt, seq: seq.rows[0]!.confirmation_seq };
}

// --- R2-095 ------------------------------------------------------------------------------------------------------------------------------

test("R2-095 (example 12): reassigning seller A's acquired agency to seller B appends B's current assignment and service assignment while A's entitlement, allocation, window and accrued lines are unchanged row for row", async () => {
  const { h } = w;
  const A = await recordActiveSeller(h, { ownerUserId: w.kora, subject: "r095-a" });
  const B = await recordActiveSeller(h, { ownerUserId: w.kora, subject: "r095-b" });
  // Seller A acquired the agency (example 1): its prospect, claim and accepted single-share allocation, the founding first purchase
  // (129500 - 32375 = 97125) and the conversion into A's entitlement
  const ag = await agencyWith(w, "B10 R2-095");
  const prospect = await recordProspect(h, { by: A, domain: "r095-agency.example" });
  const claim = await recordClaim(h, { seller: A, prospectId: prospect.prospectId });
  const { allocationId } = await recordFrozenAllocation(h, { ownerUserId: w.kora, agencyId: ag.agencyId, prospectId: prospect.prospectId, shares: [{ seller: A, claimId: claim.claimId, shareBps: 10000 }] });
  const first = await purchase(w, ag, "r095-first", { foundingFixture: true });
  const entitlementA = (await recordConversion(h, { agencyId: ag.agencyId, allocationId })).get(A.sellerId);
  assert.ok(entitlementA, "A's entitlement");
  // A's accrued lines: 9713 on the first purchase (example 1) and 4921 on the second project, for another end client, inside the
  // window at 400 bps (example 2: 129500 - 6475 = 123025)
  await accrue(w, ag, first, allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [{ sellerId: A.sellerId, entitlementId: entitlementA.entitlementId, shareBps: 10000, cents: 9713 }]);
  const second = await purchase(w, ag, "r095-second", { qualifying: [first.projectId], client: 1 });
  await accrue(w, ag, second, allocationId, { rateKind: "REPEAT", rateBps: 400, basisCents: 123025, poolCents: 4921, sequence: 2 }, [{ sellerId: A.sellerId, entitlementId: entitlementA.entitlementId, shareBps: 10000, cents: 4921 }]);

  // A is the agency's current operational owner: its first link opens the sales account (no version yet)
  const serviceOfA = await recordServiceAssignment(h, { ownerUserId: w.kora, agencyId: ag.agencyId, sellerId: A.sellerId });
  const opened = await asOwner((uow) => salesOf(uow).assignAccount({ assignmentId: uow.ids.next() as never, agencyId: ag.agencyId, sellerId: A.sellerId, serviceAssignmentRef: serviceOfA, effectiveAt: clock.now() }, null, clock.now()));
  assert.equal(opened.kind, "APPLIED");
  assert.equal(opened.kind === "APPLIED" && opened.record.version, 1);
  const firstLink = opened.kind === "APPLIED" ? opened.record.currentAssignmentId : undefined;

  // B's compensation for its new work is agreed prospectively (example 12): a signed assistance agreement for the agency's next
  // purchase, stated by the service assignment the owner prepares before the reassignment
  const assistance = await recordAssistanceAgreement(h, { ownerUserId: w.kora, agencyId: ag.agencyId, seller: B, scope: "NEXT_PURCHASE" });
  const serviceOfB = await recordServiceAssignment(h, { ownerUserId: w.kora, agencyId: ag.agencyId, sellerId: B.sellerId, assistanceAgreementId: assistance });

  // A's acquisition rows, row for row: entitlement (first capture, window, share, agreement), allocation and shares, claim, pools, lines,
  // the first designation and the qualifying purchases
  const rowsOfA = async () => ({
    entitlements: await digest(w, "SELECT * FROM kauro.commission_entitlements WHERE agency_id = $1", [ag.agencyId]),
    allocation: await digest(w, "SELECT * FROM kauro.attribution_allocations WHERE agency_id = $1", [ag.agencyId]),
    shares: await digest(w, "SELECT * FROM kauro.allocation_shares WHERE allocation_id = $1", [allocationId]),
    claims: await digest(w, "SELECT * FROM kauro.attribution_claims WHERE prospect_id = $1", [prospect.prospectId]),
    pools: await digest(w, "SELECT * FROM kauro.commission_pools WHERE agency_id = $1", [ag.agencyId]),
    lines: await digest(w, "SELECT * FROM kauro.commission_lines WHERE agency_id = $1", [ag.agencyId]),
    recurrence: await digest(w, "SELECT * FROM kauro.agency_recurrence WHERE agency_id = $1", [ag.agencyId]),
    purchases: await digest(w, "SELECT * FROM kauro.qualifying_purchases WHERE agency_id = $1", [ag.agencyId]),
  });
  const before = await rowsOfA();
  const linesBefore = await w.h.oracle.query<{ seller_id: string; cents: string; state: string }>(
    "SELECT seller_id, cumulative_entitlement_cents::text AS cents, state FROM kauro.commission_lines WHERE agency_id = $1 ORDER BY cumulative_entitlement_cents DESC",
    [ag.agencyId],
  );
  assert.deepEqual(linesBefore.rows, [
    { seller_id: A.sellerId, cents: "9713", state: "ACCRUED_PENDING" },
    { seller_id: A.sellerId, cents: "4921", state: "ACCRUED_PENDING" },
  ]);

  // the reassignment: CAS on the sales account, one ASSIGNED link naming B and its service assignment, superseding A's link
  const moved = await asOwner((uow) => salesOf(uow).assignAccount({ assignmentId: uow.ids.next() as never, agencyId: ag.agencyId, sellerId: B.sellerId, serviceAssignmentRef: serviceOfB, effectiveAt: clock.now() }, 1, clock.now()));
  assert.equal(moved.kind, "APPLIED");
  assert.ok(moved.kind === "APPLIED");
  assert.equal(moved.record.version, 2);
  assert.notEqual(moved.record.currentAssignmentId, firstLink);
  const chain = await asOwner(async (uow) => ({
    current: await salesOf(uow).currentAssignment(ag.agencyId),
    account: await salesOf(uow).getSalesAccount(ag.agencyId),
    serviceOfB: await salesOf(uow).getServiceAssignment(serviceOfB),
  }));
  assert.equal(chain.current?.assignmentId, moved.record.currentAssignmentId);
  assert.deepEqual(
    { reason: chain.current?.reason, sellerId: chain.current?.sellerId, serviceAssignmentRef: chain.current?.serviceAssignmentRef, supersedes: chain.current?.supersedesAssignmentId },
    { reason: "ASSIGNED", sellerId: B.sellerId, serviceAssignmentRef: serviceOfB, supersedes: firstLink },
  );
  assert.deepEqual({ version: chain.account?.version, current: chain.account?.currentAssignmentId }, { version: 2, current: moved.record.currentAssignmentId });
  assert.deepEqual({ seller: chain.serviceOfB?.sellerId, compensation: chain.serviceOfB?.compensation, assistance: chain.serviceOfB?.assistanceAgreementId }, { seller: B.sellerId, compensation: "ASSISTANCE_AGREEMENT", assistance });
  const links = await w.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.account_assignments WHERE agency_id = $1", [ag.agencyId]);
  assert.equal(links.rows[0]!.n, 2, "the chain appended one link; A's link is kept");

  // A's acquisition rows are unchanged row for row: the reassignment has no path to them (R2-095)
  assert.deepEqual(await rowsOfA(), before);

  // B gains no row of A's: B's own session reads no entitlement of its own and none of A's, and no line names B; A's session still
  // reads its entitlement with the window from the first designation to twelve calendar months later in America/Bogota
  const seenByB = await asPerson(B.userId, async (uow) => ({ own: await attributionOf(uow).entitlementsOfSeller(B.sellerId), ofA: await attributionOf(uow).entitlementsOfSeller(A.sellerId) }));
  assert.deepEqual(seenByB, { own: [], ofA: [] });
  const linesOfB = await w.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.commission_lines WHERE seller_id = $1", [B.sellerId]);
  assert.equal(linesOfB.rows[0]!.n, 0);
  const seenByA = await asPerson(A.userId, (uow) => attributionOf(uow).entitlementsOfSeller(A.sellerId));
  const windowStartsAt = await exactInstant("SELECT first_confirmed_at AS at FROM kauro.agency_recurrence WHERE agency_id = $1", [ag.agencyId]);
  const windowEndsAt = await exactInstant("SELECT ((first_confirmed_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota' AS at FROM kauro.agency_recurrence WHERE agency_id = $1", [ag.agencyId]);
  assert.deepEqual(
    seenByA.map((e) => ({ id: e.entitlementId, state: e.state, source: e.source, firstCaptureId: e.firstCaptureId, windowStartsAt: e.windowStartsAt, windowEndsAt: e.windowEndsAt, shareBps: e.shareBps, agreementId: e.agreementId })),
    [{ id: entitlementA.entitlementId, state: "ACTIVE", source: "ACQUISITION", firstCaptureId: first.captureId, windowStartsAt, windowEndsAt, shareBps: 10000, agreementId: A.agreementId }],
  );

  // a second reassignment on the stale version changes nothing: STALE with the current version, the chain and A's rows as they were
  const stale = await asOwner((uow) => salesOf(uow).assignAccount({ assignmentId: uow.ids.next() as never, agencyId: ag.agencyId, sellerId: A.sellerId, serviceAssignmentRef: serviceOfA, effectiveAt: clock.now() }, 1, clock.now()));
  assert.deepEqual(stale, { kind: "STALE", currentVersion: 2, currentState: "ASSIGNED" });
  assert.equal((await w.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.account_assignments WHERE agency_id = $1", [ag.agencyId])).rows[0]!.n, 2);
  assert.deepEqual(await rowsOfA(), before);
});

// --- R2-099 ------------------------------------------------------------------------------------------------------------------------------

test("R2-099: an assistance agreement records its seller, agency, project or next purchase, 400 bps and signing instant before any work, and an agreement signed after a purchase's order was created applies to no pool of that purchase", async () => {
  const { h } = w;
  const S = await recordActiveSeller(h, { ownerUserId: w.kora, subject: "r099-s" });
  const ag = await agencyWith(w, "B10 R2-099");
  // project X's order is created before any agreement is signed
  const x = await subjectOf(w, ag, "r099-x");
  const xOrder = await orderOf(w, ag, await quoteOf(w, ag, x));
  // project Y exists before the PROJECT agreement names it; the NEXT_PURCHASE agreement names the agency's next purchase
  const y = await subjectOf(w, ag, "r099-y", 1);
  const forY = await recordAssistanceAgreement(h, { ownerUserId: w.kora, agencyId: ag.agencyId, seller: S, scope: "PROJECT", projectId: y.projectId as ProjectId });
  const forNext = await recordAssistanceAgreement(h, { ownerUserId: w.kora, agencyId: ag.agencyId, seller: S, scope: "NEXT_PURCHASE" });

  // the agreements as recorded: seller, agency, the agreement they are signed under, project or next purchase, 400 bps and the signing
  // instant — before any work: no entitlement, pool or line names them yet
  const read = await asOwner(async (uow) => ({ forY: await salesOf(uow).getAssistanceAgreement(forY), forNext: await salesOf(uow).getAssistanceAgreement(forNext) }));
  const signedAtOf = (id: string) => exactInstant("SELECT signed_at AS at FROM kauro.assistance_agreements WHERE assistance_agreement_id = $1", [id]);
  const terms = (a: typeof read.forY) => (a === null ? null : { sellerId: a.sellerId, agencyId: a.agencyId, agreementId: a.agreementId, agreementVersion: a.agreementVersion, scope: a.scope, projectId: a.projectId, rateBps: a.rateBps, signedAt: a.signedAt });
  assert.deepEqual(terms(read.forY), { sellerId: S.sellerId, agencyId: ag.agencyId, agreementId: S.agreementId, agreementVersion: S.agreementVersion, scope: "PROJECT", projectId: y.projectId, rateBps: 400, signedAt: await signedAtOf(forY) });
  assert.deepEqual(terms(read.forNext), { sellerId: S.sellerId, agencyId: ag.agencyId, agreementId: S.agreementId, agreementVersion: S.agreementVersion, scope: "NEXT_PURCHASE", projectId: undefined, rateBps: 400, signedAt: await signedAtOf(forNext) });
  const work = await w.h.oracle.query<{ entitlements: number; pools: number }>(
    "SELECT (SELECT count(*)::int FROM kauro.commission_entitlements WHERE assistance_agreement_id = ANY ($1::uuid[])) AS entitlements, (SELECT count(*)::int FROM kauro.commission_pools WHERE assistance_agreement_id = ANY ($1::uuid[])) AS pools",
    [[forY, forNext]],
  );
  assert.deepEqual(work.rows, [{ entitlements: 0, pools: 0 }], "an agreement is signed before any work");
  const xCreated = await exactInstant("SELECT created_at AS at FROM kauro.payment_orders WHERE order_id = $1", [xOrder.orderId]);
  assert.ok(xCreated < (read.forNext?.signedAt ?? ""), "X's order was created before the signing");

  /** The applicability query as the commission service runs it, in the agency it adopted: the agreement ids, in order. */
  const applicable = (projectId: string, orderCreatedAt: string) =>
    within(w.commission, service(ag.agencyId), async (c) => (await new PgSalesRepository(c, ids).assistanceAgreementsFor(ag.agencyId as AgencyId, projectId as ProjectId, orderCreatedAt)).map((a) => a.assistanceAgreementId as string));

  // X's purchase settles after the signing, but its order was created before it: no agreement applies to it — not the next-purchase
  // agreement, and not a project agreement either, even one naming the project whose order was created at that instant
  const px = await settle(w, ag, xOrder);
  const pxFacts = await purchaseFacts(px);
  assert.equal(pxFacts.orderCreatedAt, xCreated);
  assert.deepEqual(await applicable(px.projectId, pxFacts.orderCreatedAt), []);
  assert.deepEqual(await applicable(y.projectId, pxFacts.orderCreatedAt), []);
  // and the ledger admits no pool of that purchase under the agreement (commission_pools_terms)
  await assert.rejects(
    within(w.commission, service(ag.agencyId), (c) =>
      c.query(
        `INSERT INTO kauro.commission_pools (pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, assistance_agreement_id, rate_kind, rate_bps, initial_basis_cents, basis_cents, pool_cents, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ASSISTANCE', $7, 'ASSISTANCE', 400, 129500, 129500, 5180, 'R2-INITIAL', now(), now())`,
        [ids.next(), ag.agencyId, px.authorizationId, px.captureId, pxFacts.seq, px.projectId, forNext],
      ),
    ),
    refusedWith("23514", "commission_pools_terms"),
  );

  // Y's purchase, ordered after the signing, is the one both apply to: the agreement naming Y and the agency's next purchase
  const py = await settle(w, ag, await orderOf(w, ag, await quoteOf(w, ag, y)));
  const pyFacts = await purchaseFacts(py);
  assert.deepEqual(await applicable(py.projectId, pyFacts.orderCreatedAt), [forY, forNext]);
  // the nearby valid control: the next-purchase agreement's ASSISTANCE entitlement (10000 bps, no window) and its pool on Y's
  // purchase at 400 bps of 129500 = 5180 cents, beside any acquisition pool
  const entitlement = await within(w.commission, service(ag.agencyId), async (c) => {
    const created = await new PgAttributionRepository(c).createEntitlement({
      entitlementId: ids.next() as CommissionEntitlementId,
      agencyId: ag.agencyId as AgencyId,
      sellerId: S.sellerId as SellerId,
      source: "ASSISTANCE",
      assistanceAgreementId: forNext as AssistanceAgreementId,
      agreementId: S.agreementId,
      agreementVersion: S.agreementVersion,
      shareBps: 10000,
      createdAt: clock.now(),
    });
    const poolId = ids.next();
    await c.query(
      `INSERT INTO kauro.commission_pools (pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, assistance_agreement_id, rate_kind, rate_bps, initial_basis_cents, basis_cents, pool_cents, policy_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ASSISTANCE', $7, 'ASSISTANCE', 400, 129500, 129500, 5180, 'R2-INITIAL', now(), now())`,
      [poolId, ag.agencyId, py.authorizationId, py.captureId, pyFacts.seq, py.projectId, forNext],
    );
    await c.query(
      `INSERT INTO kauro.commission_lines (line_id, agency_id, pool_id, entitlement_id, seller_id, authorization_id, capture_id, share_bps, rate_bps, net_service_basis_cents, cumulative_entitlement_cents,
         previous_posted_cents, policy_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, 400, 129500, 5180, 5180, 'R2-INITIAL', now(), now())`,
      [ids.next(), ag.agencyId, poolId, created.record.entitlementId, S.sellerId, py.authorizationId, py.captureId],
    );
    return created;
  });
  assert.equal(entitlement.created, true);
  assert.deepEqual(
    { source: entitlement.record.source, assistance: entitlement.record.assistanceAgreementId, shareBps: entitlement.record.shareBps, window: entitlement.record.windowEndsAt, firstCapture: entitlement.record.firstCaptureId },
    { source: "ASSISTANCE", assistance: forNext, shareBps: 10000, window: undefined, firstCapture: undefined },
  );

  // Z's purchase, ordered after Y's: the next-purchase agreement covered Y's and the project agreement names Y — none applies
  const z = await subjectOf(w, ag, "r099-z");
  const pz = await settle(w, ag, await orderOf(w, ag, await quoteOf(w, ag, z)));
  assert.deepEqual(await applicable(pz.projectId, (await purchaseFacts(pz)).orderCreatedAt), []);
});

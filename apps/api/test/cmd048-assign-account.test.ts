// CMD048 AssignAccount — POST /api/v1/sales/agencies/{agencyId}/assignment — KAURO_OWNER — scope CORPORATE (package B10, mandate
// B10-COMMANDS-SELLERS; docs/design/B10-case-map.md CMD048-OK, CMD048-DENY, CMD048-RACE and R2-095; design §5, §10, §12; decision
// D10-ASSIGN-1: "Assignment changes only the current operational owner; new work is compensated only by a prepared service assignment").
// The real route, the real authorizers, the sales adapters and PostgreSQL 17 through the runtime login roles; the superuser only reads.
// The sellers, allocations, entitlements and lines are the adapter-written fixtures of @kauro/persistence/testing, each written by the
// role that owns it; the purchase behind R2-095 is B09's. The provider is B09's labelled contract fake (SIMULATED): nothing here is a
// provider fact. Money is integer cents written in the test: 1000 bps of the service basis 52125 is 5212.5, rounded half up once to 5213.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SalesAccountView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { recordAcquisition, recordActiveSeller, recordAssistanceAgreement, recordFirstPurchaseLine, recordServiceAssignment, type AgencyFixture } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { asPerson, candidateSeller, digest, paidProject, sellingAgency, terminateDirectly } from "./sellers-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Reply } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const assignUrl = (agencyId: string): string => `/api/v1/sales/agencies/${agencyId}/assignment`;
const ownerId = (): UserId => pw.kora.userId as UserId;

/** The corporate owner's call (no agency selector: the scope is corporate). */
async function assign(agencyId: string, body: Record<string, unknown>, options: { readonly token?: string; readonly key?: string; readonly agency?: string | null } = {}): Promise<Reply> {
  return call(pw.w, { url: assignUrl(agencyId), token: options.token ?? pw.kora.token, agency: options.agency ?? null, key: options.key ?? freshKey("cmd048"), body });
}

const accountOf = async (agencyId: string) =>
  (await pw.w.h.oracle.query<{ version: string; current_assignment_id: string }>("SELECT version::text, current_assignment_id FROM kauro.sales_accounts WHERE agency_id = $1", [agencyId])).rows[0] ?? null;

/** The agency's append-only chain of assignment links in the order they superseded each other. */
async function chainOf(agencyId: string): Promise<ReadonlyArray<{ readonly reason: string; readonly sellerId: string | null; readonly serviceAssignmentRef: string | null; readonly supersedes: string | null; readonly assignmentId: string }>> {
  const r = await pw.w.h.oracle.query<{ assignment_id: string; reason: string; seller_id: string | null; service_assignment_id: string | null; supersedes_assignment_id: string | null }>(
    "SELECT assignment_id, reason, seller_id, service_assignment_id, supersedes_assignment_id FROM kauro.account_assignments WHERE agency_id = $1 ORDER BY effective_at, assignment_id",
    [agencyId],
  );
  return r.rows.map((x) => ({ assignmentId: x.assignment_id, reason: x.reason, sellerId: x.seller_id, serviceAssignmentRef: x.service_assignment_id, supersedes: x.supersedes_assignment_id }));
}

/** Every row of the agency's acquisition the assignment must not touch: allocation and shares, claims, entitlements, the first designation, pools and lines. */
async function acquisitionRows(agencyId: string, allocationId: string): Promise<ReadonlyArray<string>> {
  const { h } = pw.w;
  return [
    await digest(h, "SELECT * FROM kauro.attribution_allocations WHERE agency_id = $1", [agencyId]),
    await digest(h, "SELECT * FROM kauro.allocation_shares WHERE allocation_id = $1", [allocationId]),
    await digest(h, "SELECT * FROM kauro.attribution_claims WHERE allocation_id = $1", [allocationId]),
    await digest(h, "SELECT * FROM kauro.commission_entitlements WHERE agency_id = $1", [agencyId]),
    await digest(h, "SELECT * FROM kauro.agency_recurrence WHERE agency_id = $1", [agencyId]),
    await digest(h, "SELECT * FROM kauro.commission_pools WHERE agency_id = $1", [agencyId]),
    await digest(h, "SELECT * FROM kauro.commission_lines WHERE agency_id = $1", [agencyId]),
  ];
}

async function plainAgency(label: string): Promise<AgencyFixture> {
  const { w } = pw;
  return w.h.createAgency((await w.person(`${label}-owner`)).userId, `Agency ${label}`);
}

test("R2-095: AssignAccount to seller B with a prepared assistance agreement answers the new operational owner and B's compensation for new work, while seller A's entitlement, allocation share, window and accrued lines stay A's and B gains no row of them", async () => {
  const { w } = pw;
  // seller A acquired the agency (example 1): its accepted allocation, the founding first purchase whose service basis is 52125 and the
  // conversion into A's entitlement with the line of 5213 (1000 bps, 5212.5 half up)
  const s = await sellingAgency(pw, "cmd048-r095");
  const acquired = await recordAcquisition(w.h, { agency: s.agency, ownerUserId: ownerId(), name: "cmd048-r095" });
  const purchase = await paidProject(pw, s, "cmd048-r095-first");
  assert.equal(purchase.serviceCents, 52125n);
  const line = await recordFirstPurchaseLine(w.h, { acquired, authorizationId: purchase.authorizationId, captureId: purchase.captureId, projectId: purchase.projectId, basisCents: 52125n, poolCents: 5213n });
  const B = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd048-r095-b" });
  const serviceOfA = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: s.agency.agencyId, sellerId: acquired.sellerId });
  const opened = completed<SalesAccountView>(await assign(s.agency.agencyId, { expectedVersion: 0, sellerId: acquired.sellerId, serviceAssignmentRef: serviceOfA }), 200);
  assert.deepEqual([opened.data.version, opened.data.sellerId, opened.data.newWorkCompensation], [1, acquired.sellerId, "NONE"]);
  // B's compensation for its new work is agreed prospectively (example 12): a signed assistance agreement for the agency's next purchase,
  // stated by the service assignment the owner prepares before the reassignment
  const assistance = await recordAssistanceAgreement(w.h, { ownerUserId: ownerId(), agencyId: s.agency.agencyId, seller: B, scope: "NEXT_PURCHASE" });
  const serviceOfB = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: s.agency.agencyId, sellerId: B.sellerId, assistanceAgreementId: assistance });
  const before = await acquisitionRows(s.agency.agencyId, acquired.allocationId);
  const lineBefore = await w.h.oracle.query("SELECT state, cumulative_entitlement_cents::text, seller_id FROM kauro.commission_lines WHERE line_id = $1", [line.lineId]);
  assert.deepEqual(lineBefore.rows, [{ state: "ACCRUED_PENDING", cumulative_entitlement_cents: "5213", seller_id: acquired.sellerId }]);

  const moved = completed<SalesAccountView>(await assign(s.agency.agencyId, { expectedVersion: 1, sellerId: B.sellerId, serviceAssignmentRef: serviceOfB }), 200);
  // the answer: the new operational owner and B's compensation for new work (the assistance agreement the service assignment states)
  assert.deepEqual([moved.data.agencyId, moved.data.version, moved.data.sellerId, moved.data.newWorkCompensation, moved.data.assistanceAgreementId], [s.agency.agencyId, 2, B.sellerId, "ASSISTANCE_AGREEMENT", assistance]);
  assert.equal(moved.version, 2);
  const chain = await chainOf(s.agency.agencyId);
  assert.deepEqual(chain.map((l) => [l.reason, l.sellerId, l.serviceAssignmentRef]), [["ASSIGNED", acquired.sellerId, serviceOfA], ["ASSIGNED", B.sellerId, serviceOfB]]);
  assert.equal(chain[1]!.supersedes, chain[0]!.assignmentId);
  assert.equal((await accountOf(s.agency.agencyId))?.current_assignment_id, chain[1]!.assignmentId);
  // A's entitlement, allocation share, window and accrued line stay A's, row for row; B gains none of them
  assert.deepEqual(await acquisitionRows(s.agency.agencyId, acquired.allocationId), before);
  assert.deepEqual((await w.h.oracle.query("SELECT state, cumulative_entitlement_cents::text, seller_id FROM kauro.commission_lines WHERE line_id = $1", [line.lineId])).rows, lineBefore.rows);
  const seenBy = async (userId: string) =>
    asPerson(w.h, userId, async (c) => ({
      entitlements: (await c.query("SELECT seller_id FROM kauro.commission_entitlements WHERE agency_id = $1", [s.agency.agencyId])).rows.map((r: { seller_id: string }) => r.seller_id),
      lines: (await c.query("SELECT seller_id FROM kauro.commission_lines WHERE agency_id = $1", [s.agency.agencyId])).rows.map((r: { seller_id: string }) => r.seller_id),
    }));
  assert.deepEqual(await seenBy(acquired.sellerUserId), { entitlements: [acquired.sellerId], lines: [acquired.sellerId] }, "A's own session still reads its entitlement and its line");
  assert.deepEqual(await seenBy(B.userId), { entitlements: [], lines: [] }, "B's own session reads none of them");
  assert.equal(await w.count("commission_entitlements", "seller_id = $1", [B.sellerId]), 0);
  assert.equal(await w.count("commission_lines", "seller_id = $1", [B.sellerId]), 0);
});

test("OK: the owner assigns an agency to an ACTIVE seller with a prepared service assignment — 200 with one current account assignment and the previous one ended, the agency's allocation, entitlements, window and first designation unchanged row for row", async () => {
  const { w } = pw;
  const ag = await plainAgency("cmd048-ok");
  const acquired = await recordAcquisition(w.h, { agency: ag, ownerUserId: ownerId(), name: "cmd048-ok" });
  const B = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd048-ok-b" });
  const serviceOfA = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: acquired.sellerId });
  const serviceOfB = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: B.sellerId });
  const before = await acquisitionRows(ag.agencyId, acquired.allocationId);
  assert.equal(await accountOf(ag.agencyId), null, "the agency has no sales account before its first assignment");

  // the first assignment opens the account (no version to expect: 0) and has no link to end
  const first = completed<SalesAccountView>(await assign(ag.agencyId, { expectedVersion: 0, sellerId: acquired.sellerId, serviceAssignmentRef: serviceOfA }), 200);
  assert.deepEqual([first.data.agencyId, first.data.version, first.data.sellerId, first.data.newWorkCompensation, first.data.assistanceAgreementId], [ag.agencyId, 1, acquired.sellerId, "NONE", undefined]);
  assert.equal(first.replayed, false);
  assert.match(first.data.assignedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

  // the second assignment appends B's link superseding A's: one current link, the previous one ended
  const second = completed<SalesAccountView>(await assign(ag.agencyId, { expectedVersion: 1, sellerId: B.sellerId, serviceAssignmentRef: serviceOfB }), 200);
  assert.deepEqual([second.data.version, second.data.sellerId, second.data.newWorkCompensation], [2, B.sellerId, "NONE"]);
  assert.ok(second.data.assignedAt >= first.data.assignedAt);
  const chain = await chainOf(ag.agencyId);
  assert.deepEqual(chain.map((l) => [l.reason, l.sellerId, l.supersedes]), [["ASSIGNED", acquired.sellerId, null], ["ASSIGNED", B.sellerId, chain[0]!.assignmentId]]);
  assert.equal((await accountOf(ag.agencyId))?.current_assignment_id, chain[1]!.assignmentId, "the account names the last link: the only current assignment");
  assert.equal(await w.count("account_assignments", "agency_id = $1 AND supersedes_assignment_id = $2", [ag.agencyId, chain[0]!.assignmentId]), 1, "the first link has exactly one successor: it is ended");

  // the allocation, entitlements, window and first designation: no path from the assignment, unchanged row for row
  assert.deepEqual(await acquisitionRows(ag.agencyId, acquired.allocationId), before);
});

test("DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — a CANDIDATE or TERMINATED seller SELLER_NOT_ACTIVE, no prepared service assignment SERVICE_ASSIGNMENT_UNPREPARED, a stale version — and no request shape resets the window or the first designation", async () => {
  const { w } = pw;
  const ag = await plainAgency("cmd048-deny");
  const acquired = await recordAcquisition(w.h, { agency: ag, ownerUserId: ownerId(), name: "cmd048-deny" });
  const A = acquired.sellerId;
  const sellerPerson = await w.person("seller-cmd048-deny-b");
  const B = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd048-deny-b" });
  assert.equal(sellerPerson.userId, B.userId, "the seller is the person the token names");
  const serviceOfA = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: A });
  const serviceOfB = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: B.sellerId });
  completed<SalesAccountView>(await assign(ag.agencyId, { expectedVersion: 0, sellerId: A, serviceAssignmentRef: serviceOfA }), 200);
  const rows = async () => ({
    acquisition: await acquisitionRows(ag.agencyId, acquired.allocationId),
    chain: await chainOf(ag.agencyId),
    account: await accountOf(ag.agencyId),
  });
  const before = await rows();
  const refused = async (what: string, reply: Promise<Reply>, expected: string): Promise<Reply> => {
    const r = await reply;
    assert.equal(outcome(w, r), expected, what);
    assert.deepEqual(await rows(), before, `${what}: nothing was written`);
    return r;
  };
  const good = { expectedVersion: 1, sellerId: B.sellerId, serviceAssignmentRef: serviceOfB };

  // an agency member's tenant session is a foreign scope, a seller (a person with no corporate grant) a wrong role: the same refusal,
  // a durable fact of the caller's identity stream
  const member = await w.person("cmd048-deny-member");
  await w.h.addMember(ag, member.userId, "BILLING");
  const denials = (await w.securityEvents("CMD048")).length;
  await refused("an agency member", assign(ag.agencyId, good, { token: member.token, agency: ag.agencyId }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await refused("an agency owner", assign(ag.agencyId, good, { token: w.owner.token, agency: w.A.agencyId }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await refused("a seller", assign(ag.agencyId, good, { token: sellerPerson.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD048")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);

  // one missing prerequisite at a time: a CANDIDATE seller, a TERMINATED seller, no prepared service assignment (an unknown one, another
  // seller's, another agency's), a stale version
  const candidate = await candidateSeller(w.h, ownerId(), "cmd048-deny-candidate");
  const serviceOfCandidate = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: candidate.sellerId });
  await refused("a CANDIDATE seller", assign(ag.agencyId, { ...good, sellerId: candidate.sellerId, serviceAssignmentRef: serviceOfCandidate }), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVE");
  const departed = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd048-deny-departed" });
  const serviceOfDeparted = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: departed.sellerId });
  await terminateDirectly(w.h, ownerId(), departed.sellerId);
  await refused("a TERMINATED seller", assign(ag.agencyId, { ...good, sellerId: departed.sellerId, serviceAssignmentRef: serviceOfDeparted }), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVE");
  await refused("an unknown seller", assign(ag.agencyId, { ...good, sellerId: ids.next() }), "404 NOT_FOUND -");
  await refused("an unknown service assignment", assign(ag.agencyId, { ...good, serviceAssignmentRef: ids.next() }), "409 PRECONDITION_FAILED SERVICE_ASSIGNMENT_UNPREPARED");
  await refused("another seller's service assignment", assign(ag.agencyId, { ...good, serviceAssignmentRef: serviceOfA }), "409 PRECONDITION_FAILED SERVICE_ASSIGNMENT_UNPREPARED");
  const other = await plainAgency("cmd048-deny-other");
  const serviceOfOther = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: other.agencyId, sellerId: B.sellerId });
  await refused("another agency's service assignment", assign(ag.agencyId, { ...good, serviceAssignmentRef: serviceOfOther }), "409 PRECONDITION_FAILED SERVICE_ASSIGNMENT_UNPREPARED");
  const stale = await refused("a stale version", assign(ag.agencyId, { ...good, expectedVersion: 0 }), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: 1, state: "ASSIGNED" });

  // no request shape resets the window or the first designation: the schema is closed, so a body naming either is refused at admission
  for (const extra of [{ windowStartsAt: "2026-10-03T00:00:00Z" }, { resetWindow: true }, { firstPurchaseDesignation: ids.next() }, { allocationId: acquired.allocationId }]) {
    const reply = await assign(ag.agencyId, { ...good, ...extra });
    assert.match(outcome(w, reply), /^400 INVALID_REQUEST /, JSON.stringify(extra));
    assert.deepEqual(await rows(), before, "a refused shape wrote nothing");
  }
  // and at the database no runtime role rewrites an allocation's freeze: the assignment holds no path to it
  await assert.rejects(asPerson(w.h, ownerId(), (c) => c.query("UPDATE kauro.attribution_allocations SET frozen_at = frozen_at + interval '1 day' WHERE agency_id = $1", [ag.agencyId])));

  // the same request, correct, is accepted: the refusals above were the only obstacle
  completed<SalesAccountView>(await assign(ag.agencyId, good), 200);
});

test("RACE: an identical retry replays the 200, the same key with another sellerId is 409 IDEMPOTENCY_CONFLICT, two assignments on one version yield one and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the previous assignment current", async () => {
  const { w } = pw;
  const ag = await plainAgency("cmd048-race");
  const acquired = await recordAcquisition(w.h, { agency: ag, ownerUserId: ownerId(), name: "cmd048-race" });
  const A = acquired.sellerId;
  const B = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd048-race-b" });
  const C = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd048-race-c" });
  const serviceOfA = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: A });
  const serviceOfB = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: B.sellerId });
  const serviceOfC = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: ag.agencyId, sellerId: C.sellerId });

  // an identical retry replays the 200 byte for byte and appends no second link; the same key with another sellerId is another request
  const key = freshKey("cmd048-race");
  const body = { expectedVersion: 0, sellerId: A, serviceAssignmentRef: serviceOfA };
  const first = await assign(ag.agencyId, body, { key });
  completed<SalesAccountView>(first, 200);
  const replay = await assign(ag.agencyId, body, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await chainOf(ag.agencyId)).length, 1, "the replay appended no link");
  const conflict = await assign(ag.agencyId, { ...body, sellerId: B.sellerId, serviceAssignmentRef: serviceOfB }, { key });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await chainOf(ag.agencyId)).length, 1, "the conflicting request had no effect");

  // two assignments on one version: the first holds the account's row until its commit; the second waits for it (observed in
  // pg_stat_activity), reads the moved version and is stale
  const hold = w.holds.arm("journal.commit");
  const winner = assign(ag.agencyId, { expectedVersion: 1, sellerId: B.sellerId, serviceAssignmentRef: serviceOfB });
  await hold.reached;
  const loser = assign(ag.agencyId, { expectedVersion: 1, sellerId: C.sellerId, serviceAssignmentRef: serviceOfC });
  try {
    await waitForApiLockWait(w, "FROM kauro.sales_accounts");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<SalesAccountView>(won, 200);
  assert.equal(outcome(w, lost), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, lost).current, { version: 2, state: "ASSIGNED" });
  const afterRace = await chainOf(ag.agencyId);
  assert.deepEqual(afterRace.map((l) => l.sellerId), [A, B.sellerId], "one assignment of the two, in the order the account serialized them");

  // a crash at the intent/commit boundary: the link and the account's move were written and never committed; the previous assignment stays current
  const crashKey = freshKey("cmd048-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await assign(ag.agencyId, { expectedVersion: 2, sellerId: C.sellerId, serviceAssignmentRef: serviceOfC }, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await chainOf(ag.agencyId), afterRace, "the previous assignment is still the current one");
  assert.equal((await accountOf(ag.agencyId))?.version, "2");
  assert.equal(await w.journal(crashKey), null);
  // the retry under the same key completes once
  completed<SalesAccountView>(await assign(ag.agencyId, { expectedVersion: 2, sellerId: C.sellerId, serviceAssignmentRef: serviceOfC }, { key: crashKey }), 200);
  assert.deepEqual((await chainOf(ag.agencyId)).map((l) => l.sellerId), [A, B.sellerId, C.sellerId]);
});

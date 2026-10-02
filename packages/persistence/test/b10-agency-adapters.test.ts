// The agency lifecycle adapter of package B10 (mandate B10-AGENCY-LIFECYCLE; docs/design/B10-commercial-domain.md §4, §8.1, §10, §11,
// §12; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime login roles: the agency's own members and the
// corporate owner in units of work of the commerce factory (kauro_app_test), the control plane (kauro_control_test) publishing and
// retiring the reviewed agreement versions. The superuser only reads (row digests) and, for the one support operation no runtime role
// holds — an agency's display name and its owner's verification fact are the platform's own records, edited by no B10 command — the
// rename of R2-141. Interleavings are fixed by a held transaction and the lock wait observed in pg_stat_activity, never by a sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgencyFixture } from "../src/testing/harness.js";
import type { AgreementAcceptanceId, CausationId, RelationshipDecisionId, UserId } from "@kauro/domain";
import { PgAgencyLifecycleRepository, agencyLifecycleOf, type PgCommerceUnitOfWork } from "../src/index.js";
import { barrier, clock, waitForLockWait } from "../src/testing/harness.js";
import {
  accrue,
  acquired,
  activeSeller,
  agencyWith,
  closeWorld,
  digest,
  ids,
  openWorld,
  purchase,
  refusedWith,
  sha,
  subjectOf,
  within,
  type World,
} from "./b10-commission-support.js";

let w: World;

before(async () => {
  w = await openWorld("b10-agency-adapters");
});
after(async () => {
  await closeWorld(w);
});

/** A member's own TENANT unit of work of an agency (the request handlers' session). */
const asMember = <T>(agency: AgencyFixture, userId: string, work: (uow: PgCommerceUnitOfWork) => Promise<T>): Promise<T> =>
  w.h.commerce.run(w.h.tenant(agency.agencyId, userId as UserId), (uow) => work(uow as PgCommerceUnitOfWork));
/** The corporate owner's OPERATOR unit of work (its person bound, no agency; an ACTIVE KAURO_OWNER grant). */
const asCorporateOwner = <T>(work: (uow: PgCommerceUnitOfWork) => Promise<T>): Promise<T> => w.h.commerce.run(w.h.operator(w.kora), (uow) => work(uow as PgCommerceUnitOfWork));

/** The control plane publishes a reviewed agreement version (B19's texts; one PUBLISHED version per kind). */
const publish = (kind: "TERMS" | "PRIVACY", version: string) =>
  within(w.control, {}, (c) =>
    c.query("INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ($1, $2, $3, now(), now(), now())", [kind, version, sha(`${kind}-${version}`)]),
  );

// --- CMD002 ------------------------------------------------------------------------------------------------------------------------------

test("CMD002 through the adapters: the published agreement versions are read after their shared locks, the acceptance is appended once, and B06's agencies_authority admits the activation only for the agency's current OWNER", async () => {
  const { h } = w;
  await publish("TERMS", "TERMS-ADP-1");
  await publish("PRIVACY", "PRIVACY-ADP-1");
  const owner = await h.person("b10-adp-owner");
  const D = await h.createAgency(owner, "B10 CMD002 adapters");
  const billing = await h.person("b10-adp-billing");
  const billingMembership = await h.addMember(D, billing, "BILLING");

  // the lock order: the control plane retires TERMS-ADP-1 and holds the transaction open; the reader of the version waits for the
  // writer's transition lock (observed in pg_stat_activity), is then ordered after it and finds the version no longer PUBLISHED
  const retiring = barrier();
  const retired = barrier();
  const retire = within(w.control, {}, async (c) => {
    await c.query("UPDATE kauro.service_agreement_versions SET state = 'RETIRED', retired_at = now() WHERE agreement_kind = 'TERMS' AND version = 'TERMS-ADP-1'");
    retiring.open();
    await retired.wait;
  });
  await retiring.wait;
  const reading = asMember(D, owner, (uow) => agencyLifecycleOf(uow).publishedVersion("TERMS", "TERMS-ADP-1"));
  await waitForLockWait(h.oracle, "kauro-test-api", "await_transition");
  retired.open();
  await retire;
  assert.equal(await reading, null, "a version retired before the read is not offered: no default, no implicit signature");
  await publish("TERMS", "TERMS-ADP-2");

  // the published versions as recorded; an unknown, a retired and a kind-crossed version are none
  const seen = await asMember(D, owner, async (uow) => {
    const life = agencyLifecycleOf(uow);
    return { terms: await life.publishedVersion("TERMS", "TERMS-ADP-2"), privacy: await life.publishedVersion("PRIVACY", "PRIVACY-ADP-1"), unknown: await life.publishedVersion("TERMS", "TERMS-UNKNOWN"), crossed: await life.publishedVersion("PRIVACY", "TERMS-ADP-2") };
  });
  assert.deepEqual([seen.terms?.kind, seen.terms?.version, seen.terms?.documentHash, seen.terms?.state], ["TERMS", "TERMS-ADP-2", sha("TERMS-TERMS-ADP-2"), "PUBLISHED"]);
  assert.deepEqual([seen.privacy?.kind, seen.privacy?.version, seen.privacy?.documentHash, seen.privacy?.state], ["PRIVACY", "PRIVACY-ADP-1", sha("PRIVACY-PRIVACY-ADP-1"), "PUBLISHED"]);
  assert.deepEqual([seen.unknown, seen.crossed], [null, null]);

  // another member cannot accept for the owner: the acceptance is the session's own person's (42501), and a BILLING member's activation
  // is refused by B06's agencies_authority (KA010) beside the owner's, which commits
  const refusedAcceptance = within(w.app, { agencyId: D.agencyId, userId: billing }, async (c) => {
    const life = new PgAgencyLifecycleRepository(c, ids);
    const terms = await life.publishedVersion("TERMS", "TERMS-ADP-2");
    const privacy = await life.publishedVersion("PRIVACY", "PRIVACY-ADP-1");
    assert.ok(terms !== null && privacy !== null);
    return life.recordAcceptance({ acceptanceId: ids.next() as AgreementAcceptanceId, agencyId: D.agencyId as never, membershipId: D.ownerMembershipId, terms, privacy, legalProfileRef: ids.next(), acceptedAt: clock.now() });
  });
  await assert.rejects(refusedAcceptance, refusedWith("42501"));
  const refusedActivation = within(w.app, { agencyId: D.agencyId, userId: billing }, (c) =>
    c.query("UPDATE kauro.agencies SET state = 'ACTIVE', version = 2, terms_version = 'TERMS-ADP-2', privacy_agreement_version = 'PRIVACY-ADP-1', legal_profile_ref = $2 WHERE agency_id = $1", [D.agencyId, ids.next()]),
  );
  await assert.rejects(refusedActivation, refusedWith("KA010"));
  assert.equal((await h.oracle.query("SELECT 1 FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [D.agencyId])).rowCount, 0, "nothing was accepted");
  assert.equal((await h.oracle.query<{ state: string }>("SELECT state FROM kauro.agencies WHERE agency_id = $1", [D.agencyId])).rows[0]?.state, "DRAFT");
  assert.ok(billingMembership !== D.ownerMembershipId);

  // the OWNER accepts and activates in one unit of work: the acceptance appended once, the agency ACTIVE with the versions
  const profile = ids.next();
  const activated = await asMember(D, owner, async (uow) => {
    const life = agencyLifecycleOf(uow);
    const terms = await life.publishedVersion("TERMS", "TERMS-ADP-2");
    const privacy = await life.publishedVersion("PRIVACY", "PRIVACY-ADP-1");
    assert.ok(terms !== null && privacy !== null);
    const acceptance = await life.recordAcceptance({ acceptanceId: uow.ids.next() as AgreementAcceptanceId, agencyId: D.agencyId as never, membershipId: D.ownerMembershipId, terms, privacy, legalProfileRef: profile, acceptedAt: clock.now() });
    const agency = await uow.agencies.transition(D.agencyId as never, 1, { state: "ACTIVE", termsVersion: terms.version, privacyAgreementVersion: privacy.version, legalProfileRef: profile }, clock.now());
    assert.equal(agency.kind, "APPLIED");
    if (agency.kind !== "APPLIED") throw new Error("the activation did not apply");
    await uow.events.publish({
      aggregateKind: "agency",
      aggregateId: D.agencyId,
      aggregateVersion: agency.record.version,
      agencyId: D.agencyId as never,
      eventType: "agency.activated.v1",
      actor: { kind: "USER", userId: owner },
      causationId: uow.context.correlationId as unknown as CausationId,
      correlationId: uow.context.correlationId,
      payload: { agencyId: D.agencyId },
    });
    return { acceptance, version: agency.record.version, again: await life.acceptancesOf(D.agencyId as never) };
  });
  assert.equal(activated.version, 2);
  assert.deepEqual(activated.again.map((a) => a.acceptanceId), [activated.acceptance.acceptanceId], "one acceptance, read back in the same unit of work");
  const rows = await h.oracle.query<{ membership_id: string; user_id: string; terms_version: string; terms_document_hash: string; privacy_version: string; privacy_document_hash: string }>(
    "SELECT membership_id, user_id, terms_version, terms_document_hash, privacy_version, privacy_document_hash FROM kauro.agency_agreement_acceptances WHERE agency_id = $1",
    [D.agencyId],
  );
  assert.deepEqual(rows.rows, [{ membership_id: D.ownerMembershipId, user_id: owner, terms_version: "TERMS-ADP-2", terms_document_hash: sha("TERMS-TERMS-ADP-2"), privacy_version: "PRIVACY-ADP-1", privacy_document_hash: sha("PRIVACY-PRIVACY-ADP-1") }]);
  const recorded = activated.acceptance;
  assert.deepEqual([recorded.agencyId, recorded.membershipId, recorded.userId, recorded.termsVersion, recorded.termsDocumentHash, recorded.privacyAgreementVersion, recorded.privacyDocumentHash, recorded.legalProfileRef], [D.agencyId, D.ownerMembershipId, owner, "TERMS-ADP-2", sha("TERMS-TERMS-ADP-2"), "PRIVACY-ADP-1", sha("PRIVACY-PRIVACY-ADP-1"), profile]);
  const stored = await h.oracle.query<{ at: string; agency_at: string }>("SELECT to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS agency_at FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [D.agencyId]);
  assert.equal(recorded.acceptedAt, stored.rows[0]?.at, "the acceptance is stamped by the database's server instant, not by the caller's clock");
  const agency = await h.oracle.query<{ state: string; terms_version: string; privacy_agreement_version: string; legal_profile_ref: string; version: string }>(
    "SELECT state, terms_version, privacy_agreement_version, legal_profile_ref, version::text FROM kauro.agencies WHERE agency_id = $1",
    [D.agencyId],
  );
  assert.deepEqual(agency.rows, [{ state: "ACTIVE", terms_version: "TERMS-ADP-2", privacy_agreement_version: "PRIVACY-ADP-1", legal_profile_ref: profile, version: "2" }]);
});

// --- R2-141 ------------------------------------------------------------------------------------------------------------------------------

test("R2-141 (example 24): a display-name and owner e-mail change leaves the agency's id, first designation, consumed slot, recurrence set, attribution and ledger rows unchanged, and a recorded consolidation decision of two agencies merges no dataset, membership, designation or attribution and changes neither's quote eligibility", async () => {
  const { h } = w;
  // agency R acquired by seller S1 (example 1): the founding first purchase (129500 - 32375 = 97125), its first designation, its consumed
  // founding slot, one accrued line of 9713 at 1000 bps, and a second project of its own in the eligibility set
  const S1 = await activeSeller(w, "r141-seller");
  const R = await acquired(w, "B10 R2-141 R", [{ seller: S1, shareBps: 10000 }], { foundingFixture: true });
  await accrue(w, R.ag, R.first, R.allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [
    { sellerId: S1.sellerId, entitlementId: R.entitlements.get(S1.sellerId)!, shareBps: 10000, cents: 9713 },
  ]);
  const second = await subjectOf(w, R.ag, "r141-r-second", 1);
  // agency T, a separate legal agency of the same holding, with a purchase of its own
  const T = await agencyWith(w, "B10 R2-141 T");
  await purchase(w, T, "r141-t-first");
  const ticket = await subjectOf(w, T, "r141-t-second", 1);

  const keyed = ["agency_recurrence", "qualifying_purchases", "founding_slot_reservations", "quote_issuances", "agency_agreement_acceptances", "agency_closures", "quotes", "price_eligibility_snapshots", "memberships", "end_clients", "projects", "dataset_revisions", "plans", "approvals", "payment_orders", "capture_facts", "commercial_authorizations", "attribution_allocations", "commission_entitlements", "commission_pools", "commission_lines"];
  const rowsOf = async (agencyId: string) => {
    const out: Record<string, string> = {};
    for (const t of keyed) out[t] = await digest(w, `SELECT * FROM kauro.${t} WHERE agency_id = $1`, [agencyId]);
    return out;
  };
  const slotOf = (agencyId: string) => digest(w, "SELECT slot_no, held, live_reservation_id, live_agency_id FROM kauro.founding_slots WHERE live_agency_id = $1", [agencyId]);
  const eligibility = async (ag: AgencyFixture, projectId: string): Promise<string[]> =>
    within(w.app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, async (c) => (await c.query<{ s: string[] }>("SELECT array(SELECT f.project_id::text FROM kauro.qualifying_projects_at($1, now(), $2) AS f ORDER BY 1) AS s", [ag.agencyId, projectId])).rows[0]!.s);
  const identityOf = async (agencyId: string) => (await h.oracle.query("SELECT agency_id, first_qualifying_capture_id, created_by_user_id, created_at FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows;
  const snapshot = async () => ({
    r: { rows: await rowsOf(R.ag.agencyId), slot: await slotOf(R.ag.agencyId), identity: await identityOf(R.ag.agencyId), set: await eligibility(R.ag, second.projectId) },
    t: { rows: await rowsOf(T.agencyId), slot: await slotOf(T.agencyId), identity: await identityOf(T.agencyId), set: await eligibility(T, ticket.projectId) },
  });
  const before = await snapshot();
  assert.deepEqual(before.r.set, [R.first.projectId], "R's first purchase is the one project that makes its second repeat");
  assert.equal(before.r.identity[0]?.first_qualifying_capture_id, R.first.captureId, "R's first designation");
  assert.equal((await h.oracle.query("SELECT 1 FROM kauro.founding_slots WHERE live_agency_id = $1 AND held", [R.ag.agencyId])).rowCount, 1, "R's founding slot is consumed");

  // the rename: the agency's display name and its owner's verification fact change (the platform's own records; no B10 row names either).
  // No runtime role edits them and no B10 command is the rename, so the support operation is made by the oracle with triggers off
  await h.oracle.query("BEGIN");
  try {
    await h.oracle.query("SET LOCAL session_replication_role = replica");
    await h.oracle.query("UPDATE kauro.agencies SET display_name = 'B10 R2-141 R renamed', updated_at = now() WHERE agency_id = $1", [R.ag.agencyId]);
    await h.oracle.query("UPDATE kauro.identities SET email_verified_at = now(), updated_at = now() WHERE user_id = $1", [R.ag.ownerUserId]);
    await h.oracle.query("COMMIT");
  } catch (e) {
    await h.oracle.query("ROLLBACK");
    throw e;
  }
  assert.equal((await h.oracle.query<{ display_name: string }>("SELECT display_name FROM kauro.agencies WHERE agency_id = $1", [R.ag.agencyId])).rows[0]?.display_name, "B10 R2-141 R renamed");
  assert.deepEqual(await snapshot(), before, "a rename changes no id, designation, slot, set, attribution or ledger row");

  // the reviewed consolidation decision of the two legal agencies, recorded by the corporate owner through the adapter
  const evidenceHash = sha("r141-consolidation-evidence");
  const decision = await asCorporateOwner(async (uow) => {
    const life = agencyLifecycleOf(uow);
    const recorded = await life.recordRelationshipDecision({
      decisionId: uow.ids.next() as RelationshipDecisionId,
      agencyId: R.ag.agencyId as never,
      relatedAgencyId: T.agencyId as never,
      treatment: "LEGAL_SUCCESSOR_RECORDED",
      evidenceHash: evidenceHash as never,
      reviewedBy: w.kora,
      effectiveAt: clock.now(),
      decidedAt: clock.now(),
    });
    return { recorded, ofR: await life.relationshipDecisionsOf(R.ag.agencyId as never) };
  });
  assert.deepEqual([decision.recorded.agencyId, decision.recorded.relatedAgencyId, decision.recorded.treatment, decision.recorded.evidenceHash, decision.recorded.reviewedBy], [R.ag.agencyId, T.agencyId, "LEGAL_SUCCESSOR_RECORDED", evidenceHash, w.kora]);
  assert.deepEqual(decision.ofR.map((d) => d.decisionId), [decision.recorded.decisionId]);
  assert.equal((await h.oracle.query("SELECT 1 FROM kauro.agency_relationship_decisions WHERE agency_id = $1 AND related_agency_id = $2", [R.ag.agencyId, T.agencyId])).rowCount, 1);
  // the agency's own session cannot record one (42501): a consolidation is the corporate owner's reviewed record
  await assert.rejects(
    within(w.app, { agencyId: R.ag.agencyId, userId: R.ag.ownerUserId }, (c) =>
      new PgAgencyLifecycleRepository(c, ids).recordRelationshipDecision({ decisionId: ids.next() as RelationshipDecisionId, agencyId: R.ag.agencyId as never, relatedAgencyId: T.agencyId as never, treatment: "COMMON_CONTROL_RECORDED", evidenceHash: evidenceHash as never, reviewedBy: R.ag.ownerUserId as never, effectiveAt: clock.now(), decidedAt: clock.now() }),
    ),
    refusedWith("42501"),
  );

  // the decision merges nothing: no dataset, membership, designation, attribution or ledger row of either agency moved, neither's
  // quote eligibility set changed, and the agency that was not the decision's subject still reads none of the other's
  assert.deepEqual(await snapshot(), before, "a recorded consolidation changes neither agency's rows or eligibility");
  assert.deepEqual(await eligibility(T, ticket.projectId), before.t.set, "T's set does not include R's purchase");
  const memberOfBoth = await h.oracle.query("SELECT 1 FROM kauro.memberships WHERE user_id = $1 AND agency_id = $2", [R.ag.ownerUserId, T.agencyId]);
  assert.equal(memberOfBoth.rowCount, 0, "R's owner gained no membership of T");
});

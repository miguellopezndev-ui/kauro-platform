// The schema of B10's sellers, prospects, claims, allocations, entitlements, assignments and termination tail (migration 0029;
// docs/design/B10-commercial-domain.md §5, §8.2, §9; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime
// login roles: the corporate owner and the sellers (kauro_app_test, OPERATOR sessions of their own identities), the agencies' request
// handlers (kauro_app_test, TENANT sessions), the payment service (kauro_payment_test), the commission service
// (kauro_commission_test) and the control plane (kauro_control_test); the superuser only reads, and probes a refusal that no grant
// stands in front of. Every guard is shown by the forbidden write refused beside the legitimate write that commits (21 "Positive and
// negative symmetry"). The tests assert the raw KC SQLSTATEs; their translation into failure reasons is the stage-2 lanes' (design
// §12).
import { invariantsAfterEach } from "../src/testing/invariants.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { COMMERCIAL_PLATFORM_MACHINES } from "@kauro/domain";
import { RUNTIME_ROLES } from "../src/index.js";
import {
  acquired,
  activate,
  activeSeller,
  agencyWith,
  agreement,
  assertSeeded,
  assessment,
  acceptAttribution,
  candidate,
  changeDestination,
  closeWorld,
  confidentiality,
  convert,
  corporate,
  digest,
  freezeAndAccept,
  ids,
  legalReview,
  openWorld,
  oracleProbe,
  ownerOf,
  personOf,
  prepareAllocation,
  purchase,
  refusedWith,
  registerProspect,
  service,
  settle,
  sha,
  submitClaim,
  taxDocumentation,
  tenant,
  verifyDestination,
  within,
  orderOf,
  quoteOf,
  subjectOf,
  type Seller,
  type World,
} from "./b10-commission-support.js";
import { commerceEvent } from "./commerce-support.js";
import { stepUpProof } from "./support.js";

let w: World;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => w.h.oracle);

before(async () => {
  w = await openWorld("b10-sales");
});
after(async () => {
  await closeWorld(w);
});

const machineOf = (name: string) => {
  const m = COMMERCIAL_PLATFORM_MACHINES.find((x) => x.contract === name);
  assert.ok(m, `${name} is a platform machine of @kauro/domain`);
  return m;
};

/** A KC005 refusal naming the missing activation fact. */
const notActivatable = (fact: string) => (e: unknown): boolean => refusedWith("KC005")(e) && String((e as Error).message).includes(fact);

// --- R2-094 ------------------------------------------------------------------------------------------------------------------------------

/**
 * An agency acquired by a seller whose first qualifying purchase is designated exactly at `confirmedAt` (the payment service's
 * reconciliation stands its TEST CLOCK there): the claim submitted before the purchase's order, accepted at `acceptedAt`.
 */
async function acquiredAt(name: string, seller: Seller, acceptedAt: string, confirmedAt: string) {
  const ag = await agencyWith(w, name);
  const prospect = await registerProspect(w, seller, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`);
  // the whole acquisition sits at test-clock instants in order: claim submitted < order created < accepted < confirmed (KC021 judges the
  // review deadline at COMMIT, 0048; the conversion needs the claim submitted before the first purchase's order, 0029)
  const before = (hours: number) => new Date(Date.parse(acceptedAt) - hours * 3_600_000).toISOString();
  const claimId = await submitClaim(w, seller, prospect, { at: before(24) });
  const allocationId = await prepareAllocation(w, ag, prospect, [{ seller, claimId, shareBps: 10000 }]);
  const order = await orderOf(w, ag, await quoteOf(w, ag, await subjectOf(w, ag, `${name}-first`)), { at: before(12) });
  await acceptAttribution(w, ag, allocationId, [claimId], { at: acceptedAt });
  const first = await settle(w, ag, order, { confirmedAt });
  return { ag, prospect, claimId, allocationId, first };
}

test("R2-094 at the database: an entitlement's window_ends_at must equal twelve calendar months after window_starts_at at the America/Bogota wall time with the day clamped, and its first capture, window, share and agreement cannot change", async () => {
  await assertSeeded(w, machineOf("CommissionEntitlement"));
  const s = await activeSeller(w, "r094-s");
  /** The conversion (D10-ATTR-2) writing the window it is given, in the agency the commission service adopted. */
  const convertWith = (ag: { readonly agencyId: string }, allocationId: string, claimId: string, windowEnd: string, at: string) =>
    within(w.commission, service(ag.agencyId), async (c) => {
      await c.query("SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)", [at]);
      await c.query("UPDATE kauro.attribution_claims SET state = 'CONVERTED', converted_at = kauro.server_now(), version = version + 1 WHERE claim_id = $1", [claimId]);
      const entitlementId = ids.next();
      await c.query(
        `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, agreement_id, agreement_version, share_bps, first_capture_id, window_starts_at, window_ends_at, created_at, updated_at)
         SELECT $1, r.agency_id, $2, 'ACQUISITION', $3, $4, $5, $6, 10000, r.first_capture_id, r.first_confirmed_at, $7::timestamptz, now(), now() FROM kauro.agency_recurrence r WHERE r.agency_id = $8`,
        [entitlementId, s.sellerId, allocationId, claimId, s.agreementId, s.agreementVersion, windowEnd, ag.agencyId],
      );
      return entitlementId;
    });

  // worked example 11 at the leap boundary: a first confirmation at 2028-02-29T15:00:00Z (10:00 America/Bogota)
  const leap = await acquiredAt("B10 R2-094 leap", s, "2028-02-20T12:00:00Z", "2028-02-29T15:00:00Z");
  const anchor = await w.h.oracle.query<{ first_confirmed_at: Date }>("SELECT first_confirmed_at FROM kauro.agency_recurrence WHERE agency_id = $1", [leap.ag.agencyId]);
  assert.equal(anchor.rows[0]!.first_confirmed_at.toISOString(), "2028-02-29T15:00:00.000Z", "the first designation is confirmed exactly at the example's instant");
  // 366 days (the naive year that lands on 1 March), one microsecond late and a UTC-calendar year are all refused ...
  for (const wrong of ["2029-03-01T15:00:00Z", "2029-02-28T15:00:00.000001Z", "2029-02-28T14:59:59Z"]) {
    await assert.rejects(convertWith(leap.ag, leap.allocationId, leap.claimId, wrong, "2028-02-29T15:00:01Z"), refusedWith("23514", "commission_entitlements_window"), wrong);
  }
  // ... and twelve calendar months at the same Bogota wall time with the day clamped is the window's exclusive end
  const leapEntitlement = await convertWith(leap.ag, leap.allocationId, leap.claimId, "2029-02-28T15:00:00Z", "2028-02-29T15:00:01Z");
  const stored = await w.h.oracle.query<{ window_starts_at: Date; window_ends_at: Date; first_capture_id: string }>("SELECT window_starts_at, window_ends_at, first_capture_id FROM kauro.commission_entitlements WHERE entitlement_id = $1", [leapEntitlement]);
  assert.deepEqual(
    [stored.rows[0]!.window_starts_at.toISOString(), stored.rows[0]!.window_ends_at.toISOString(), stored.rows[0]!.first_capture_id],
    ["2028-02-29T15:00:00.000Z", "2029-02-28T15:00:00.000Z", leap.first.captureId],
  );

  // the wall time is Bogota's, not UTC's: a confirmation at 2028-02-29T02:00:00Z is 2028-02-28 21:00 in Bogota, so its window ends at
  // 2029-02-28 21:00 in Bogota = 2029-03-01T02:00:00Z, never at the UTC calendar's 2029-02-28T02:00:00Z
  const evening = await acquiredAt("B10 R2-094 evening", s, "2028-02-20T12:00:00Z", "2028-02-29T02:00:00Z");
  await assert.rejects(convertWith(evening.ag, evening.allocationId, evening.claimId, "2029-02-28T02:00:00Z", "2028-02-29T02:00:01Z"), refusedWith("23514", "commission_entitlements_window"));
  // the window starts at the agency's first designation and nowhere else: a consistent twelve-month window from another instant is
  // refused by its anchor key
  await assert.rejects(
    within(w.commission, service(evening.ag.agencyId), (c) =>
      c.query(
        `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, agreement_id, agreement_version, share_bps, first_capture_id, window_starts_at, window_ends_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACQUISITION', $4, $5, $6, $7, 10000, $8, '2028-03-01T02:00:00Z', '2029-03-01T02:00:00Z', now(), now())`,
        [ids.next(), evening.ag.agencyId, s.sellerId, evening.allocationId, evening.claimId, s.agreementId, s.agreementVersion, evening.first.captureId],
      ),
    ),
    refusedWith("23503", "commission_entitlements_window_anchor_fk"),
  );
  await convertWith(evening.ag, evening.allocationId, evening.claimId, "2029-03-01T02:00:00Z", "2028-02-29T02:00:01Z");

  // first capture, window, share and agreement cannot change: no runtime role holds the column (42501), and the table refuses the
  // change to anyone (kauro.forbid_column_change, KA004)
  const changes = [
    ["first_capture_id", "gen_random_uuid()"],
    ["window_starts_at", "window_starts_at - interval '1 day'"],
    ["window_ends_at", "window_ends_at + interval '1 day'"],
    ["share_bps", "5000"],
    ["agreement_id", "gen_random_uuid()"],
  ] as const;
  for (const [column, value] of changes) {
    const sql = `UPDATE kauro.commission_entitlements SET ${column} = ${value}, version = version + 1 WHERE entitlement_id = $1`;
    await assert.rejects(within(w.commission, service(leap.ag.agencyId), (c) => c.query(sql, [leapEntitlement])), refusedWith("42501"), `commission service ${column}`);
    await assert.rejects(within(w.app, ownerOf(w), (c) => c.query(sql, [leapEntitlement])), refusedWith("42501"), `owner ${column}`);
    await oracleProbe(w, sql, [leapEntitlement], refusedWith("KA004"), `table ${column}`);
  }
  // the entitlement's history is a corporate record: no agency, never readable by the agency's session
  const history = await w.h.oracle.query("SELECT agency_id, from_state, to_state FROM kauro.commercial_transitions WHERE machine = 'CommissionEntitlement' AND subject_id = $1", [leapEntitlement]);
  assert.deepEqual(history.rows, [{ agency_id: null, from_state: null, to_state: "ACTIVE" }]);
  assert.equal((await within(w.app, tenant(leap.ag), (c) => c.query("SELECT 1 FROM kauro.commission_entitlements UNION ALL SELECT 1 FROM kauro.commercial_transitions WHERE subject_id = $1", [leapEntitlement]))).rowCount, 0);
});

// --- R2-100 ------------------------------------------------------------------------------------------------------------------------------

test("R2-100 at the database: a tail entry exists only for an ACCEPTED unexpired claim of the terminated seller whose agency has no qualifying purchase (KC011), and ends 2160 hours after the termination's effective instant", async () => {
  const s = await activeSeller(w, "r100-s");
  const t = await activeSeller(w, "r100-t");
  /** A claim of `seller` on a new prospect, accepted for a new agency (at `acceptedAt` when given; submitted before it). */
  const opportunity = async (label: string, seller: Seller, options: { readonly accept?: boolean; readonly submittedAt?: string; readonly acceptedAt?: string } = {}) => {
    const ag = await agencyWith(w, `B10 R2-100 ${label}`);
    const prospect = await registerProspect(w, seller, `r100-${label}.example`);
    const claimId = await submitClaim(w, seller, prospect, options.submittedAt === undefined ? {} : { at: options.submittedAt });
    if (options.accept !== false) {
      const allocationId = await prepareAllocation(w, ag, prospect, [{ seller, claimId, shareBps: 10000 }]);
      await acceptAttribution(w, ag, allocationId, [claimId], options.acceptedAt === undefined ? {} : { at: options.acceptedAt });
    }
    return { ag, claimId };
  };
  const now = Date.now();
  const listed = await opportunity("listed", s);
  const second = await opportunity("second", s);
  const purchased = await opportunity("purchased", s);
  await purchase(w, purchased.ag, "r100-purchased");
  const submitted = await opportunity("submitted", s, { accept: false });
  const expired = await opportunity("expired", s, { submittedAt: new Date(now - 2300 * 3_600_000).toISOString(), acceptedAt: new Date(now - 2200 * 3_600_000).toISOString() });
  const foreign = await opportunity("foreign", t);
  const unlisted = await opportunity("unlisted", s);

  // the owner's prepared termination terms and the manifest of the seller's handed-over opportunities
  const terminationId = ids.next();
  const manifestId = ids.next();
  const manifest = [listed, second, purchased, submitted, expired, foreign].map((o) => o.claimId);
  await within(w.app, ownerOf(w), async (c) => {
    await c.query("INSERT INTO kauro.seller_terminations (termination_id, seller_id, terms_hash, prepared_by_user_id, prepared_at, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now(), now())", [terminationId, s.sellerId, sha(`termination-terms-${terminationId}`), w.kora]);
    await c.query("INSERT INTO kauro.termination_manifests (manifest_id, seller_id, claim_ids, manifest_hash, prepared_by_user_id, prepared_at, created_at) VALUES ($1, $2, $3::uuid[], $4, $5, now(), now())", [manifestId, s.sellerId, manifest, sha(`manifest-${manifestId}`), w.kora]);
  });
  const entry = (c: import("pg").Client, claimId: string, agencyId: string, hours = 2160) =>
    c.query(
      "INSERT INTO kauro.termination_tail_entries (termination_id, claim_id, seller_id, agency_id, effective_at, ends_at, created_at) SELECT t.termination_id, $2, t.seller_id, $3, t.effective_at, t.effective_at + make_interval(hours => $4), now() FROM kauro.seller_terminations t WHERE t.termination_id = $1",
      [terminationId, claimId, agencyId, hours],
    );
  // CMD050's writes: the termination effective at the server's instant, the seller TERMINATED at it, the listed opportunity's tail
  await within(w.app, ownerOf(w), async (c) => {
    await c.query("UPDATE kauro.seller_terminations SET manifest_id = $2, effective_at = kauro.server_now(), terminated_by_user_id = $3, version = 2 WHERE termination_id = $1", [terminationId, manifestId, w.kora]);
    await c.query("UPDATE kauro.sellers SET state = 'TERMINATED', terminated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1", [s.sellerId]);
    await entry(c, listed.claimId, listed.ag.agencyId);
  });
  const recorded = await w.h.oracle.query<{ seconds: string; same: boolean }>(
    "SELECT extract(epoch FROM e.ends_at - t.effective_at)::bigint::text AS seconds, e.effective_at = t.effective_at AS same FROM kauro.termination_tail_entries e JOIN kauro.seller_terminations t USING (termination_id) WHERE e.claim_id = $1",
    [listed.claimId],
  );
  assert.deepEqual(recorded.rows, [{ seconds: String(2160 * 3600), same: true }], "the tail ends 2160 hours after the effective instant");

  // the end instant is exactly 2160 hours after the effective instant (a 2159-hour tail is refused), then the listed second opportunity
  await assert.rejects(within(w.app, ownerOf(w), (c) => entry(c, second.claimId, second.ag.agencyId, 2159)), refusedWith("23514", "termination_tail_entries_tail_hours"));
  await within(w.app, ownerOf(w), (c) => entry(c, second.claimId, second.ag.agencyId));
  // KC011 for every opportunity the termination did not enumerate: an agency that already purchased, a claim never accepted, an
  // accepted claim already expired at the effective instant, another seller's claim, and a claim missing from the manifest
  for (const [what, o] of [["purchased", purchased], ["submitted", submitted], ["expired", expired], ["foreign", foreign], ["unlisted", unlisted]] as const) {
    await assert.rejects(within(w.app, ownerOf(w), (c) => entry(c, o.claimId, o.ag.agencyId)), refusedWith("KC011"), what);
  }
  assert.deepEqual(
    (await w.h.oracle.query<{ claim_id: string }>("SELECT claim_id FROM kauro.termination_tail_entries WHERE termination_id = $1 ORDER BY claim_id", [terminationId])).rows.map((r) => r.claim_id),
    [listed.claimId, second.claimId].sort(),
  );
  // the unlisted open claim lapses at the termination; the listed ones stay ACCEPTED for their tail
  await within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.attribution_claims SET state = 'EXPIRED', lapsed_at = kauro.server_now(), version = version + 1 WHERE claim_id = $1", [unlisted.claimId]));
  await assert.rejects(
    within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.attribution_claims SET state = 'EXPIRED', lapsed_at = kauro.server_now(), version = version + 1 WHERE claim_id = $1", [listed.claimId])),
    refusedWith("23514", "attribution_claims_lapse"),
  );
  // entries are append-only records: no runtime role rewrites or deletes one, and the table refuses it to anyone
  await assert.rejects(within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.termination_tail_entries SET ends_at = ends_at + interval '1 day' WHERE termination_id = $1", [terminationId])), refusedWith("42501"));
  await oracleProbe(w, "DELETE FROM kauro.termination_tail_entries WHERE termination_id = $1", [terminationId], refusedWith("KA004"), "tail entries are append-only");
});

// --- R2-103 ------------------------------------------------------------------------------------------------------------------------------

test("R2-103 at the database: a payout destination becomes VERIFIED only with the seller's own step-up proof at the change and an owner verification at least 172800 seconds later; a change without that proof stays PENDING_VERIFICATION", async () => {
  await assertSeeded(w, machineOf("PayoutDestination"));
  const s = await candidate(w, "r103-s");
  const other = await candidate(w, "r103-other");
  const stateOf = async (destinationId: string) => (await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.seller_payout_destinations WHERE destination_id = $1", [destinationId])).rows[0]!.state;

  // the seller's own change with its own fresh step-up: the owner's verification 172799 seconds later is refused, 172800 later admitted
  const first = await changeDestination(w, s);
  assert.equal(await stateOf(first.destinationId), "PENDING_VERIFICATION");
  await assert.rejects(verifyDestination(w, first.destinationId, 172799), refusedWith("23514", "seller_payout_destinations_verification"));
  assert.equal(await stateOf(first.destinationId), "PENDING_VERIFICATION");
  await verifyDestination(w, first.destinationId, 172800);
  assert.equal(await stateOf(first.destinationId), "VERIFIED");
  const verified = await w.h.oracle.query<{ seconds: string }>("SELECT extract(epoch FROM verified_at - changed_at)::text AS seconds FROM kauro.seller_payout_destinations WHERE destination_id = $1", [first.destinationId]);
  assert.deepEqual(verified.rows, [{ seconds: "172800.000000" }]);

  // a change without the seller's step-up (an unauthenticated e-mail) never verifies, however long the owner waits
  const unproved = await changeDestination(w, s, { stepUp: false });
  for (const seconds of [172800, 172800 * 10]) {
    await assert.rejects(verifyDestination(w, unproved.destinationId, seconds, first.destinationId), refusedWith("23514", "seller_payout_destinations_verification"));
  }
  assert.equal(await stateOf(unproved.destinationId), "PENDING_VERIFICATION");
  // the step-up must be the changer's own fresh proof (another person's: 23514), and the change the seller's own (the owner, or
  // another seller, recording it for the seller: 42501)
  const foreignProof = await stepUpProof(w.assurance, { userId: other.userId });
  await assert.rejects(
    within(w.app, personOf(s.userId), (c) =>
      c.query(
        "INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at) VALUES ($1, $2, 9, 'Bank ****0009', $3, 'USD', $4, $5, kauro.server_now(), now(), now())",
        [ids.next(), s.sellerId, sha("foreign-proof"), s.userId, foreignProof],
      ),
    ),
    refusedWith("23514", "seller_payout_destinations_step_up"),
  );
  for (const recorder of [w.kora, other.userId]) {
    await assert.rejects(
      within(w.app, personOf(recorder), (c) =>
        c.query(
          "INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, changed_at, created_at, updated_at) VALUES ($1, $2, 9, 'Bank ****0009', $3, 'USD', $4, kauro.server_now(), now(), now())",
          [ids.next(), s.sellerId, sha(`recorded-by-${recorder}`), recorder],
        ),
      ),
      refusedWith("42501"),
    );
  }
  // the seller cannot verify its own change: no policy lets its session touch the row
  const second = await changeDestination(w, s);
  const selfVerify = await within(w.app, personOf(s.userId), (c) =>
    c.query("UPDATE kauro.seller_payout_destinations SET state = 'VERIFIED', verified_by_user_id = $2, verified_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [second.destinationId, s.userId]),
  );
  assert.equal(selfVerify.rowCount, 0);
  // one VERIFIED version per seller: a later version verifies only while superseding the earlier one, which is kept SUPERSEDED
  await assert.rejects(verifyDestination(w, second.destinationId, 172800), refusedWith("23505", "seller_payout_destinations_one_verified"));
  await verifyDestination(w, second.destinationId, 172800, first.destinationId);
  assert.deepEqual([await stateOf(first.destinationId), await stateOf(second.destinationId), await stateOf(unproved.destinationId)], ["SUPERSEDED", "VERIFIED", "PENDING_VERIFICATION"]);
  // a version never gives way except to a later VERIFIED one (checked at COMMIT)
  const third = await changeDestination(w, s);
  await assert.rejects(
    within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.seller_payout_destinations SET state = 'SUPERSEDED', superseded_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [second.destinationId])),
    refusedWith("23514", "seller_payout_destinations_verification"),
  );
  assert.equal(await stateOf(third.destinationId), "PENDING_VERIFICATION");
  // a destination's identity, digest and change record never change
  for (const column of ["destination_digest", "changed_at", "change_proof_ref"]) {
    await oracleProbe(w, `UPDATE kauro.seller_payout_destinations SET ${column} = NULL WHERE destination_id = $1`, [second.destinationId], refusedWith("KA004"), column);
  }
});

// --- CMD045 ------------------------------------------------------------------------------------------------------------------------------

test("CMD045 at the database: source evidence admits only the AGENCY segment, one live prospect exists per normalized organization key, and a prospect whose organization or contact key is suppressed is refused KC016", async () => {
  await assertSeeded(w, machineOf("Prospect"));
  const s = await activeSeller(w, "cmd045-s");
  const t = await activeSeller(w, "cmd045-t");
  const evidence = (userId: string, sellerId: string | null, segment: string) =>
    within(w.app, personOf(userId), (c) =>
      c.query(
        "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', $6, now())",
        [ids.next(), userId, sellerId, sha(`evidence-${segment}-${ids.next()}`), sha("https://directory.example/"), segment],
      ),
    );
  // A3 3.7, D58: the only segment the table admits is AGENCY
  for (const segment of ["IN_HOUSE", "END_CLIENT", "CONSUMER"]) await assert.rejects(evidence(s.userId, s.sellerId, segment), refusedWith("23514", "prospect_source_evidence_agency_segment"), segment);
  await evidence(s.userId, s.sellerId, "AGENCY");

  // one live prospect per organization key, however the second registrar spells the organization
  const north = await registerProspect(w, s, "north.example");
  await assert.rejects(
    within(w.app, personOf(t.userId), async (c) => {
      const evidenceHash = sha(`t-north-${ids.next()}`);
      await c.query("INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())", [ids.next(), t.userId, t.sellerId, evidenceHash, sha("https://www.north.example/")]);
      await c.query(
        "INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at) VALUES ($1, 'NORTH Agency Inc.', $2, $3, 'United States', $4, $5, $5, now(), now())",
        [ids.next(), north.organizationKey, evidenceHash, t.userId, t.sellerId],
      );
    }),
    refusedWith("23505", "prospects_one_live_per_organization"),
  );
  // a prospect cites its registrar's own source evidence and contact (23503), and is owned by the seller that registers it (42501)
  await assert.rejects(
    within(w.app, personOf(t.userId), (c) =>
      c.query(
        "INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at) VALUES ($1, 'Borrowed evidence', $2, $3, 'United States', $4, $5, $5, now(), now())",
        [ids.next(), sha("organization:borrowed.example"), north.evidenceHash, t.userId, t.sellerId],
      ),
    ),
    refusedWith("23503", "prospects_source_evidence_fk"),
  );
  await assert.rejects(
    within(w.app, personOf(t.userId), async (c) => {
      const evidenceHash = sha(`t-given-${ids.next()}`);
      await c.query("INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())", [ids.next(), t.userId, t.sellerId, evidenceHash, sha("https://given.example/")]);
      await c.query(
        "INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at) VALUES ($1, 'Given away', $2, $3, 'United States', $4, $5, $6, now(), now())",
        [ids.next(), sha("organization:given.example"), evidenceHash, t.userId, t.sellerId, s.sellerId],
      );
    }),
    refusedWith("42501"),
  );

  // suppression by organization key and by contact key refuses the registration (KC016); a neighbour with another contact registers
  await within(w.app, ownerOf(w), async (c) => {
    await c.query("INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_at, created_at) VALUES ($1, 'ORGANIZATION', $2, 'OPTED_OUT', $3, kauro.server_now(), now())", [ids.next(), sha("organization:south.example"), w.kora]);
    await c.query("INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_at, created_at) VALUES ($1, 'CONTACT', $2, 'OPTED_OUT', $3, kauro.server_now(), now())", [ids.next(), sha("contact:ops@east.example"), w.kora]);
  });
  await assert.rejects(registerProspect(w, s, "south.example"), refusedWith("KC016"), "a suppressed organization, whatever its label");
  await assert.rejects(registerProspect(w, t, "east.example", { contactKey: sha("contact:ops@east.example") }), refusedWith("KC016"), "a suppressed contact");
  await registerProspect(w, t, "west.example", { contactKey: sha("contact:ops@west.example") });
  // a seller records a suppression too (an opt-out it received); a suppression is never removed
  await within(w.app, personOf(t.userId), (c) =>
    c.query("INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_at, created_at) VALUES ($1, 'ORGANIZATION', $2, 'OPTED_OUT', $3, kauro.server_now(), now())", [ids.next(), sha("organization:quiet.example"), t.userId]),
  );
  await assert.rejects(registerProspect(w, s, "quiet.example"), refusedWith("KC016"));
  await assert.rejects(within(w.app, ownerOf(w), (c) => c.query("DELETE FROM kauro.prospect_suppressions")), refusedWith("42501"));
  await oracleProbe(w, "DELETE FROM kauro.prospect_suppressions", [], refusedWith("KA004"), "suppressions survive");

  // a CANDIDATE seller registers nothing; a prospect is born RESEARCHED and owned by its registrar
  const pending = await candidate(w, "cmd045-candidate");
  await assert.rejects(registerProspect(w, { ...s, sellerId: pending.sellerId, userId: pending.userId }, "candidate.example"), refusedWith("42501"));
  assert.deepEqual((await w.h.oracle.query("SELECT state, suppressed, owner_seller_id, registered_by_seller_id FROM kauro.prospects WHERE prospect_id = $1", [north.prospectId])).rows, [{ state: "RESEARCHED", suppressed: false, owner_seller_id: s.sellerId, registered_by_seller_id: s.sellerId }]);
  // no agency session reads a prospect, a contact, an evidence or a suppression (D10-CTX-3)
  const ag = await agencyWith(w, "B10 CMD045 tenant");
  const seen = await within(w.app, tenant(ag), (c) =>
    c.query("SELECT 1 FROM kauro.prospects UNION ALL SELECT 1 FROM kauro.prospect_contacts UNION ALL SELECT 1 FROM kauro.prospect_source_evidence UNION ALL SELECT 1 FROM kauro.prospect_suppressions"),
  );
  assert.equal(seen.rowCount, 0);
});

// --- CMD046 ------------------------------------------------------------------------------------------------------------------------------

test("CMD046 at the database: a claim needs its seller ACTIVE with that agreement version, one live claim exists per seller and prospect, and a claim's evidence and deadlines cannot change", async () => {
  await assertSeeded(w, machineOf("AttributionClaim"));
  const s = await activeSeller(w, "cmd046-s");
  const t = await activeSeller(w, "cmd046-t");
  const prospect = await registerProspect(w, s, "cmd046.example");
  // a later agreement of the seller, signed but not the one it acts under
  const later = await agreement(w, s.sellerId, s.reviewId, { version: "SA-CMD046-LATER" });
  await assert.rejects(submitClaim(w, s, prospect, { agreement: later }), refusedWith("23514", "attribution_claims_active_agreement"));
  // the claim under its active agreement version: SUBMITTED with a review deadline exactly 2160 hours after its submission
  const claimId = await submitClaim(w, s, prospect);
  const row = await w.h.oracle.query<{ state: string; seconds: string }>("SELECT state, extract(epoch FROM review_deadline_at - submitted_at)::bigint::text AS seconds FROM kauro.attribution_claims WHERE claim_id = $1", [claimId]);
  assert.deepEqual(row.rows, [{ state: "SUBMITTED", seconds: String(2160 * 3600) }]);
  // one live claim per seller and prospect
  await assert.rejects(submitClaim(w, s, prospect), refusedWith("23505", "attribution_claims_one_live_per_seller"));
  // another seller's claim on the same prospect is its own record, which its seller writes DISPUTED in the same transaction when a
  // conflict is found (CMD046); it owns nothing
  const competing = await submitClaim(w, t, prospect);
  await within(w.app, personOf(t.userId), (c) => c.query("UPDATE kauro.attribution_claims SET state = 'DISPUTED', conflict_reason = 'LIVE_COMPETING_CLAIM', version = version + 1 WHERE claim_id = $1", [competing]));
  // a deadline that is not exactly 2160 hours after the submission is refused
  const other = await registerProspect(w, t, "cmd046-short.example");
  await assert.rejects(
    within(w.app, personOf(t.userId), async (c) => {
      const evidenceHash = sha(`short-deadline-${ids.next()}`);
      await c.query(
        "INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at) VALUES ($1, $2, $3, $4, 'DISCOVERY_CALL', kauro.server_now(), $5, ARRAY['DISCOVERY_CALL']::text[], kauro.server_now(), now())",
        [ids.next(), t.sellerId, other.prospectId, evidenceHash, sha("need")],
      );
      await c.query(
        "INSERT INTO kauro.attribution_claims (claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, submitted_at, review_deadline_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.server_now() + interval '2159 hours', now(), now())",
        [ids.next(), other.prospectId, t.sellerId, t.agreementId, t.agreementVersion, evidenceHash],
      );
    }),
    refusedWith("23514", "attribution_claims_review_deadline"),
  );
  // a suspended seller submits nothing (its writes are admitted only while ACTIVE, D10-CTX-2)
  await within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.sellers SET state = 'SUSPENDED', version = version + 1 WHERE seller_id = $1", [s.sellerId]));
  await assert.rejects(submitClaim(w, s, await registerProspect(w, t, "cmd046-suspended.example")), refusedWith("42501"));

  // a claim's evidence and deadlines cannot change: no runtime role holds those columns (42501), the table refuses the change to anyone
  // (KA004), and its evidence record is append-only
  for (const [column, value] of [["evidence_hash", `'${sha("rewritten")}'`], ["review_deadline_at", "review_deadline_at + interval '1 day'"], ["submitted_at", "submitted_at - interval '1 day'"]] as const) {
    const sql = `UPDATE kauro.attribution_claims SET ${column} = ${value}, version = version + 1 WHERE claim_id = $1`;
    await assert.rejects(within(w.app, ownerOf(w), (c) => c.query(sql, [claimId])), refusedWith("42501"), `owner ${column}`);
    await assert.rejects(within(w.commission, corporate, (c) => c.query(sql, [claimId])), refusedWith("42501"), `commission ${column}`);
    await oracleProbe(w, sql, [claimId], refusedWith("KA004"), `table ${column}`);
  }
  await assert.rejects(within(w.app, personOf(t.userId), (c) => c.query("UPDATE kauro.claim_evidence SET qualified_need_hash = $2 WHERE seller_id = $1", [t.sellerId, sha("rewritten need")])), refusedWith("42501"));
  await oracleProbe(w, "UPDATE kauro.claim_evidence SET qualified_need_hash = $1", [sha("rewritten need")], refusedWith("KA004"), "claim evidence is append-only");
  // the claim's history is corporate (no agency), from its birth
  const history = await w.h.oracle.query("SELECT agency_id, coalesce(from_state, '-') || '>' || to_state AS edge FROM kauro.commercial_transitions WHERE machine = 'AttributionClaim' AND subject_id = $1 ORDER BY subject_version", [competing]);
  assert.deepEqual(history.rows, [{ agency_id: null, edge: "->SUBMITTED" }, { agency_id: null, edge: "SUBMITTED>DISPUTED" }]);
});

// --- CMD047 ------------------------------------------------------------------------------------------------------------------------------

test("CMD047 at the database: one frozen allocation exists per agency, its shares sum to 10000 bps at COMMIT (KC003) with each beneficiary's pool terms equal to its signed agreement, and no assignment row can reference or alter it", async () => {
  const s = await activeSeller(w, "cmd047-s");
  const t = await activeSeller(w, "cmd047-t");
  const u = await activeSeller(w, "cmd047-u", { firstBps: 800 });
  const ag = await agencyWith(w, "B10 CMD047");
  const prospect = await registerProspect(w, s, "cmd047.example");
  const cs = await submitClaim(w, s, prospect);
  const ct = await submitClaim(w, t, prospect);
  const cu = await submitClaim(w, u, prospect);
  const freeze = (allocationId: string, claimIds: ReadonlyArray<string>) => within(w.app, ownerOf(w), (c) => freezeAndAccept(c, w, ag, allocationId, claimIds));

  // shares of 6000 and 3999 bps are refused at COMMIT, and nothing is frozen or accepted (KC003)
  const short = await prepareAllocation(w, ag, prospect, [{ seller: s, claimId: cs, shareBps: 6000 }, { seller: t, claimId: ct, shareBps: 3999 }]);
  await assert.rejects(freeze(short, [cs, ct]), refusedWith("KC003"));
  assert.deepEqual((await w.h.oracle.query("SELECT frozen_at FROM kauro.attribution_allocations WHERE allocation_id = $1", [short])).rows, [{ frozen_at: null }]);
  // a share whose pool terms are not its beneficiary's signed agreement, or not the allocation's, is refused
  await assert.rejects(prepareAllocation(w, ag, prospect, [{ seller: u, claimId: cu, shareBps: 10000 }]), refusedWith("23503", "allocation_shares_agreement_terms_fk"), "u signed 800 bps, the allocation says 1000");
  await assert.rejects(prepareAllocation(w, ag, prospect, [{ seller: u, claimId: cu, shareBps: 10000 }], { firstBps: 900 }), refusedWith("23503"), "a pool nobody signed");
  // a share's claim is its beneficiary's own claim on the allocation's prospect, under the agreement the share names
  await assert.rejects(prepareAllocation(w, ag, prospect, [{ seller: s, claimId: ct, shareBps: 10000 }]), refusedWith("23503", "allocation_shares_claim_fk"));
  const unsigned = await agreement(w, t.sellerId, t.reviewId, { version: "SA-CMD047-UNSIGNED" }, { signed: false });
  await assert.rejects(prepareAllocation(w, ag, prospect, [{ seller: { ...t, ...unsigned }, claimId: ct, shareBps: 10000 }]), refusedWith("23503", "allocation_shares_claim_fk"), "an agreement the claim does not name");

  // 6000/4000 under their signed agreements: frozen once, both claims ACCEPTED at the freeze, running 2160 hours
  const split = await prepareAllocation(w, ag, prospect, [{ seller: s, claimId: cs, shareBps: 6000 }, { seller: t, claimId: ct, shareBps: 4000 }]);
  await freeze(split, [cs, ct]);
  const accepted = await w.h.oracle.query<{ claim_id: string; state: string; hours: string; same: boolean }>(
    "SELECT c.claim_id, c.state, (extract(epoch FROM c.expires_at - c.accepted_at) / 3600)::int::text AS hours, c.accepted_at = a.frozen_at AS same FROM kauro.attribution_claims c JOIN kauro.attribution_allocations a ON a.allocation_id = c.allocation_id WHERE c.claim_id IN ($1, $2) ORDER BY 1",
    [cs, ct],
  );
  assert.deepEqual(accepted.rows, [cs, ct].sort().map((id) => ({ claim_id: id, state: "ACCEPTED", hours: "2160", same: true })));
  // a claim is accepted only by the frozen allocation whose shares name it (KC003)
  await assert.rejects(
    within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.attribution_claims SET state = 'ACCEPTED', agency_id = $2, allocation_id = $3, accepted_at = kauro.server_now(), expires_at = kauro.server_now() + interval '2160 hours', version = version + 1 WHERE claim_id = $1", [cu, ag.agencyId, split])),
    refusedWith("KC003"),
  );
  // one frozen allocation per agency: a second one — even of another beneficiary's full pool — is refused ("the pool does not
  // become 10% for each seller")
  const second = await prepareAllocation(w, ag, prospect, [{ seller: u, claimId: cu, shareBps: 10000 }], { firstBps: 800 });
  await assert.rejects(freeze(second, [cu]), refusedWith("23505", "attribution_allocations_one_per_agency"));
  // the frozen allocation never changes: no share is added (KC003), no column rewritten by the owner, and the table refuses it to anyone
  await assert.rejects(
    within(w.app, ownerOf(w), (c) =>
      c.query("INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at) VALUES ($1, $2, $3, $4, $5, $6, 1, 800, 400, 12, now())", [split, u.sellerId, cu, prospect.prospectId, u.agreementId, u.agreementVersion]),
    ),
    refusedWith("KC003"),
  );
  const frozenRewrite = await within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = $2, version = version + 1 WHERE allocation_id = $1", [split, w.kora]));
  assert.equal(frozenRewrite.rowCount, 0, "a frozen allocation is out of the owner's reach");
  for (const sql of ["UPDATE kauro.attribution_allocations SET first_bps = 900 WHERE allocation_id = $1", "UPDATE kauro.attribution_allocations SET frozen_at = frozen_at + interval '1 second', version = version + 1 WHERE allocation_id = $1", "UPDATE kauro.allocation_shares SET share_bps = 5000 WHERE allocation_id = $1"]) {
    await oracleProbe(w, sql, [split], refusedWith("KA004"), sql);
  }

  // no assignment row can reference it: no key of sales_accounts, service_assignments or account_assignments names an allocation, a
  // share, a claim or an entitlement, and none has such a column ...
  const keys = await w.h.oracle.query<{ rel: string; target: string }>(
    `SELECT c.conrelid::regclass::text AS rel, c.confrelid::regclass::text AS target FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid IN ('kauro.sales_accounts'::regclass, 'kauro.service_assignments'::regclass, 'kauro.account_assignments'::regclass) ORDER BY 1, 2`,
  );
  const targets = new Set(keys.rows.map((k) => k.target));
  for (const forbidden of ["kauro.attribution_allocations", "kauro.allocation_shares", "kauro.attribution_claims", "kauro.commission_entitlements"]) assert.equal(targets.has(forbidden), false, forbidden);
  const columns = await w.h.oracle.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'kauro' AND table_name IN ('sales_accounts', 'service_assignments', 'account_assignments') AND column_name IN ('allocation_id', 'claim_id', 'entitlement_id', 'share_bps')",
  );
  assert.deepEqual(columns.rows, []);
  // ... and assigning the agency changes nothing of it
  const before_ = await digest(w, "SELECT * FROM kauro.attribution_allocations a JOIN kauro.allocation_shares s USING (allocation_id) WHERE a.allocation_id = $1", [split]);
  const serviceAssignmentId = ids.next();
  const assignmentId = ids.next();
  await within(w.app, ownerOf(w), async (c) => {
    await c.query("INSERT INTO kauro.service_assignments (service_assignment_id, agency_id, seller_id, compensation, terms_hash, prepared_by_user_id, prepared_at, created_at) VALUES ($1, $2, $3, 'NONE', $4, $5, now(), now())", [serviceAssignmentId, ag.agencyId, u.sellerId, sha("service-u"), w.kora]);
    await c.query("INSERT INTO kauro.account_assignments (assignment_id, agency_id, seller_id, service_assignment_id, reason, effective_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, 'ASSIGNED', kauro.server_now(), $5, now())", [assignmentId, ag.agencyId, u.sellerId, serviceAssignmentId, w.kora]);
    await c.query("INSERT INTO kauro.sales_accounts (agency_id, current_assignment_id, created_at, updated_at) VALUES ($1, $2, now(), now())", [ag.agencyId, assignmentId]);
  });
  assert.equal(await digest(w, "SELECT * FROM kauro.attribution_allocations a JOIN kauro.allocation_shares s USING (allocation_id) WHERE a.allocation_id = $1", [split]), before_);
});

// --- CMD048 ------------------------------------------------------------------------------------------------------------------------------

test("CMD048 at the database: account assignments are append-only with one current per agency, and no runtime role can update an entitlement's first capture, window or share or the agency's first designation", async () => {
  const s = await activeSeller(w, "cmd048-s");
  const t = await activeSeller(w, "cmd048-t");
  const { ag, first, entitlements } = await acquired(w, "B10 CMD048", [{ seller: s, shareBps: 10000 }]);
  const entitlementId = entitlements.get(s.sellerId)!;
  const serviceOf = async (seller: Seller) => {
    const id = ids.next();
    await within(w.app, ownerOf(w), (c) =>
      c.query("INSERT INTO kauro.service_assignments (service_assignment_id, agency_id, seller_id, compensation, terms_hash, prepared_by_user_id, prepared_at, created_at) VALUES ($1, $2, $3, 'NONE', $4, $5, now(), now())", [id, ag.agencyId, seller.sellerId, sha(`service-${id}`), w.kora]),
    );
    return id;
  };
  const assign = (c: import("pg").Client, seller: Seller, serviceAssignmentId: string, supersedes: string | null) => {
    const id = ids.next();
    return c
      .query(
        "INSERT INTO kauro.account_assignments (assignment_id, agency_id, seller_id, service_assignment_id, supersedes_assignment_id, reason, effective_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, $5, 'ASSIGNED', kauro.server_now(), $6, now())",
        [id, ag.agencyId, seller.sellerId, serviceAssignmentId, supersedes, w.kora],
      )
      .then(() => id);
  };
  const serviceS = await serviceOf(s);
  const serviceT = await serviceOf(t);
  const rightsBefore = await digest(w, "SELECT * FROM kauro.commission_entitlements WHERE agency_id = $1", [ag.agencyId]);
  // the first assignment opens the sales account naming it
  const a1 = await within(w.app, ownerOf(w), async (c) => {
    const id = await assign(c, s, serviceS, null);
    await c.query("INSERT INTO kauro.sales_accounts (agency_id, current_assignment_id, created_at, updated_at) VALUES ($1, $2, now(), now())", [ag.agencyId, id]);
    return id;
  });
  // CMD048: the next assignment supersedes the current one and the account moves to it
  const a2 = await within(w.app, ownerOf(w), async (c) => {
    const id = await assign(c, t, serviceT, a1);
    await c.query("UPDATE kauro.sales_accounts SET current_assignment_id = $2, version = version + 1 WHERE agency_id = $1", [ag.agencyId, id]);
    return id;
  });
  // one current per agency: a second successor of one row, a second first row, an assignment the account does not name, and an
  // account moving back are all refused
  await assert.rejects(within(w.app, ownerOf(w), (c) => assign(c, s, serviceS, a1)), refusedWith("23505", "account_assignments_one_successor"));
  await assert.rejects(within(w.app, ownerOf(w), (c) => assign(c, s, serviceS, null)), refusedWith("23505", "account_assignments_one_first"));
  await assert.rejects(within(w.app, ownerOf(w), (c) => assign(c, s, serviceS, a2)), refusedWith("23514", "account_assignments_current"));
  await assert.rejects(within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.sales_accounts SET current_assignment_id = $2, version = version + 1 WHERE agency_id = $1", [ag.agencyId, a1])), refusedWith("23514", "account_assignments_current"));
  // a seller's assignment names its own prepared service assignment
  await assert.rejects(within(w.app, ownerOf(w), (c) => assign(c, s, serviceT, a2)), refusedWith("23503", "account_assignments_service_fk"));
  const chain = await w.h.oracle.query<{ current_assignment_id: string }>("SELECT current_assignment_id FROM kauro.sales_accounts WHERE agency_id = $1", [ag.agencyId]);
  assert.deepEqual(chain.rows, [{ current_assignment_id: a2 }]);
  // append-only: no runtime role rewrites or deletes an assignment, and the table refuses it to anyone
  for (const [client, ctx] of [[w.app, ownerOf(w)], [w.commission, corporate]] as const) {
    await assert.rejects(within(client, ctx, (c) => c.query("UPDATE kauro.account_assignments SET seller_id = $2 WHERE assignment_id = $1", [a1, t.sellerId])), refusedWith("42501"));
    await assert.rejects(within(client, ctx, (c) => c.query("DELETE FROM kauro.account_assignments WHERE assignment_id = $1", [a1])), refusedWith("42501"));
  }
  await oracleProbe(w, "UPDATE kauro.account_assignments SET effective_at = now() WHERE assignment_id = $1", [a1], refusedWith("KA004"), "append-only");
  // the reassignment left the acquisition rights row for row as they were (R2-095)
  assert.equal(await digest(w, "SELECT * FROM kauro.commission_entitlements WHERE agency_id = $1", [ag.agencyId]), rightsBefore);

  // no runtime role can update an entitlement's first capture, window or share: the owner, the seller, the commission service, the
  // payment service and the control plane are each refused (42501), and the table refuses it to anyone (KA004)
  const sessions = [
    [w.app, ownerOf(w), "owner"],
    [w.app, personOf(s.userId), "seller"],
    [w.app, tenant(ag), "agency"],
    [w.commission, service(ag.agencyId), "commission service"],
    [w.payment, service(ag.agencyId), "payment service"],
    [w.control, corporate, "control plane"],
  ] as const;
  for (const [column, value] of [["first_capture_id", "gen_random_uuid()"], ["window_starts_at", "now()"], ["window_ends_at", "now()"], ["share_bps", "1"]] as const) {
    const sql = `UPDATE kauro.commission_entitlements SET ${column} = ${value}, version = version + 1 WHERE entitlement_id = $1`;
    for (const [client, ctx, who] of sessions) await assert.rejects(within(client, ctx, (c) => c.query(sql, [entitlementId])), refusedWith("42501"), `${who} ${column}`);
    await oracleProbe(w, sql, [entitlementId], refusedWith("KA004"), column);
  }
  // ... nor the agency's first designation: once the commission service mirrored it, nothing rewrites it (KC001)
  const mirror = (captureId: string) =>
    within(w.commission, service(ag.agencyId), async (c) => {
      const version = Number((await c.query<{ version: string }>("SELECT version FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId])).rows[0]!.version) + 1;
      await c.query("UPDATE kauro.agencies SET first_qualifying_capture_id = $2, version = $3 WHERE agency_id = $1", [ag.agencyId, captureId, version]);
      await commerceEvent(c, "agency", ag.agencyId, version, ag.agencyId, "agency.first_purchase_designated.v1", { kind: "SERVICE", id: "commission-service" });
    });
  await mirror(first.captureId);
  const later = await purchase(w, ag, "cmd048-later", { qualifying: [first.projectId] });
  await assert.rejects(mirror(later.captureId), refusedWith("KC001"));
  await oracleProbe(w, "UPDATE kauro.agencies SET first_qualifying_capture_id = $2 WHERE agency_id = $1", [ag.agencyId, later.captureId], refusedWith("KC001"), "the first designation");
  assert.deepEqual((await w.h.oracle.query("SELECT first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId])).rows, [{ first_qualifying_capture_id: first.captureId }]);
});

// --- CMD049 ------------------------------------------------------------------------------------------------------------------------------

test("CMD049 at the database: a seller becomes ACTIVE only with a signed agreement, a confirming legal review, assessment and confidentiality records, a VERIFIED destination and tax documentation (KC005), and a seller's session reads only its own sales rows", async () => {
  await assertSeeded(w, machineOf("Seller"));
  type Missing = "SIGNED_AGREEMENT" | "CONFIRMING_LEGAL_REVIEW" | "PASSED_ASSESSMENT" | "CONFIDENTIALITY_ACCEPTANCE" | "VERIFIED_DESTINATION" | "TAX_DOCUMENTATION" | "VERIFIED_IDENTITY_WITH_MFA" | null;
  /** A candidate with every activation fact but `missing`; returns its activation attempt. */
  const attempt = async (label: string, missing: Missing) => {
    const cand = await candidate(w, `cmd049-${label}`, { verifiedIdentity: missing !== "VERIFIED_IDENTITY_WITH_MFA" });
    const reviewId = await legalReview(w, cand.sellerId, missing === "CONFIRMING_LEGAL_REVIEW" ? "NOT_CONFIRMED" : "CONFIRMED");
    const signed = await agreement(w, cand.sellerId, reviewId, {}, { signed: missing !== "SIGNED_AGREEMENT" });
    const assessmentId = await assessment(w, cand.sellerId, missing === "PASSED_ASSESSMENT" ? "NOT_PASSED" : "PASSED");
    if (missing !== "CONFIDENTIALITY_ACCEPTANCE") await confidentiality(w, cand.sellerId);
    if (missing !== "TAX_DOCUMENTATION") await taxDocumentation(w, cand.sellerId);
    const destination = await changeDestination(w, cand);
    if (missing !== "VERIFIED_DESTINATION") await verifyDestination(w, destination.destinationId, 172800);
    return { cand, run: () => activate(w, cand.sellerId, signed.agreementId, assessmentId) };
  };
  for (const missing of ["SIGNED_AGREEMENT", "CONFIRMING_LEGAL_REVIEW", "PASSED_ASSESSMENT", "CONFIDENTIALITY_ACCEPTANCE", "VERIFIED_DESTINATION", "TAX_DOCUMENTATION", "VERIFIED_IDENTITY_WITH_MFA"] as const) {
    const { cand, run } = await attempt(missing.toLowerCase().replace(/_/g, "-"), missing);
    await assert.rejects(run(), notActivatable(missing), missing);
    assert.deepEqual((await w.h.oracle.query("SELECT state FROM kauro.sellers WHERE seller_id = $1", [cand.sellerId])).rows, [{ state: "CANDIDATE" }], `${missing} leaves it CANDIDATE`);
  }
  // every fact recorded: ACTIVE on its agreement; the owner's own step-up must be fresh at the activation instant
  const ready = await attempt("ready", null);
  const staleProof = await stepUpProof(w.assurance, { userId: w.kora });
  await assert.rejects(
    within(w.app, ownerOf(w), async (c) => {
      await c.query("SELECT set_config('kauro_test.clock_offset_seconds', '1000', true)");
      const signed = await c.query<{ agreement_id: string }>("SELECT agreement_id FROM kauro.seller_agreements WHERE seller_id = $1", [ready.cand.sellerId]);
      const passed = await c.query<{ assessment_id: string }>("SELECT assessment_id FROM kauro.seller_assessments WHERE seller_id = $1", [ready.cand.sellerId]);
      await c.query(
        "UPDATE kauro.sellers SET state = 'ACTIVE', agreement_id = $2, activation_assessment_id = $3, activated_by_user_id = $4, activation_proof_ref = $5, activated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1",
        [ready.cand.sellerId, signed.rows[0]!.agreement_id, passed.rows[0]!.assessment_id, w.kora, staleProof],
      );
    }),
    notActivatable("OWNER_STEP_UP"),
  );
  await ready.run();
  assert.deepEqual((await w.h.oracle.query("SELECT state FROM kauro.sellers WHERE seller_id = $1", [ready.cand.sellerId])).rows, [{ state: "ACTIVE" }]);
  // a seller never activates itself (its session has no policy over the row), and a reinstatement repeats the facts (KC005)
  const self = await within(w.app, personOf(ready.cand.userId), (c) => c.query("UPDATE kauro.sellers SET state = 'SUSPENDED', version = version + 1 WHERE seller_id = $1", [ready.cand.sellerId]));
  assert.equal(self.rowCount, 0);

  // a seller's session reads only its own sales rows; owner-only records it never reads; the agency reads none; the owner and the
  // commission service read what they work with
  const s1 = await activeSeller(w, "cmd049-s1");
  const s2 = await activeSeller(w, "cmd049-s2");
  const p1 = await registerProspect(w, s1, "cmd049-one.example");
  const p2 = await registerProspect(w, s2, "cmd049-two.example");
  const c1 = await submitClaim(w, s1, p1);
  const c2 = await submitClaim(w, s2, p2);
  const own: ReadonlyArray<readonly [string, string, string, string]> = [
    ["sellers", "seller_id", s1.sellerId, s2.sellerId],
    ["seller_agreements", "agreement_id", s1.agreementId, s2.agreementId],
    ["seller_payout_destinations", "destination_id", s1.destinationId, s2.destinationId],
    ["prospects", "prospect_id", p1.prospectId, p2.prospectId],
    ["prospect_contacts", "contact_id", p1.contactId, p2.contactId],
    ["prospect_source_evidence", "evidence_hash", p1.evidenceHash, p2.evidenceHash],
    ["claim_evidence", "seller_id", s1.sellerId, s2.sellerId],
    ["attribution_claims", "claim_id", c1, c2],
  ];
  for (const [table, column, mine, theirs] of own) {
    const seen = await within(w.app, personOf(s1.userId), (c) => c.query<{ id: string }>(`SELECT ${column}::text AS id FROM kauro.${table} WHERE ${column} IN ($1, $2)`, [mine, theirs]));
    assert.deepEqual([...new Set(seen.rows.map((r) => r.id))], [mine], `${table}: the seller's own row only`);
    const owner = await within(w.app, ownerOf(w), (c) => c.query(`SELECT 1 FROM kauro.${table} WHERE ${column} IN ($1, $2)`, [mine, theirs]));
    assert.ok((owner.rowCount ?? 0) >= 2, `${table}: the owner reads both`);
  }
  for (const table of ["seller_legal_reviews", "seller_assessments", "seller_confidentiality_acceptances", "seller_tax_documents", "service_assignments", "sales_accounts"]) {
    assert.equal((await within(w.app, personOf(s1.userId), (c) => c.query(`SELECT 1 FROM kauro.${table}`))).rowCount, 0, `${table}: owner-only to the seller`);
  }
  const ag = await agencyWith(w, "B10 CMD049 tenant");
  for (const [table] of own) assert.equal((await within(w.app, tenant(ag), (c) => c.query(`SELECT 1 FROM kauro.${table}`))).rowCount, 0, `${table}: no tenant reads it`);
  assert.ok(((await within(w.commission, corporate, (c) => c.query("SELECT 1 FROM kauro.sellers WHERE seller_id IN ($1, $2)", [s1.sellerId, s2.sellerId]))).rowCount ?? 0) === 2, "the commission service reads the sellers");
  // the seller reads its identity's own row and no other seller's identity
  assert.deepEqual((await within(w.app, personOf(s1.userId), (c) => c.query<{ user_id: string }>("SELECT user_id FROM kauro.identities WHERE user_id IN ($1, $2)", [s1.userId, s2.userId]))).rows.map((r) => r.user_id), [s1.userId]);
  // nobody but the owner records a seller or its onboarding records (42501)
  await assert.rejects(within(w.app, personOf(s1.userId), (c) => c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'Self-made', $2, now(), now())", [ids.next(), s1.userId])), refusedWith("42501"));
  for (const role of RUNTIME_ROLES) {
    const deletes = await w.h.oracle.query<{ allowed: boolean }>("SELECT has_table_privilege($1, 'kauro.sellers', 'DELETE') AS allowed", [role]);
    assert.deepEqual(deletes.rows, [{ allowed: false }], role);
  }
});

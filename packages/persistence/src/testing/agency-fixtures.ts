/**
 * Test-only fixtures of the agency lifecycle of package B10 (mandate B10-AGENCY-LIFECYCLE; docs/design/B10-commercial-domain.md §4;
 * @kauro/persistence/testing), each row written by the runtime role that owns it, like the B09 fixtures beside them:
 *
 *  - the reviewed agreement versions the control plane publishes (kauro_control; B19's texts, R2-111): one PUBLISHED version per kind,
 *    the previous one RETIRED;
 *  - the founding slot a quote's reservation holds, taken and recorded by the agency's own request handlers (kauro_app, a TENANT
 *    session) exactly as CMD027's issuance writes it (design §3.3), so that CloseAgency has a reservation to release;
 *  - the commission lines of a closing agency, written as the commission service writes them (kauro_commission): a seller activated
 *    by the corporate owner with every fact of "Activation prerequisites", a prospect, a claim and the accepted single-share
 *    allocation that precede the agency's first purchase (kauro_app), then the conversion and the accrual of the first purchase's
 *    pool and line at 1000 bps of the service basis (example 1), and the ELIGIBILITY sweep that moves the line ELIGIBLE.
 *
 * Instants are the server's (kauro.server_now()); a fixture stands at another instant only through the labelled TEST CLOCK
 * (D10-CLOCK-1), set exactly in SQL. Nothing here is imported by a deployment (architecture.rules.json testOnlySubpaths).
 */
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { createIdGenerator, toUtcInstant, type AgencyId, type UserId } from "@kauro/domain";
import { randomBytes } from "node:crypto";
import type { AgencyFixture, Harness } from "./harness.js";

const ids = createIdGenerator({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }, (n) => new Uint8Array(randomBytes(n)));

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The settings a transaction binds: a TENANT (agency and user), an OPERATOR (user) or a SERVICE (agency). */
interface Binding {
  readonly agencyId?: string;
  readonly userId?: string;
}

/** One transaction of `client` under a binding; commits when `fn` returns, rolls back and rethrows otherwise. */
async function within<T>(client: Client, binding: Binding, fn: (c: Client) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', '', true)", [binding.agencyId ?? "", binding.userId ?? ""]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Runs `fn` on a connection of a runtime login role, closed afterwards. */
async function asRole<T>(h: Harness, role: "kauro_app_test" | "kauro_control_test" | "kauro_commission_test", fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await h.pg.connect(role);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Stands the transaction's TEST CLOCK exactly `seconds` after the instant the query (one row, column `at`) selects. */
async function clockAfter(c: Client, instantSql: string, params: ReadonlyArray<unknown>, seconds: number): Promise<void> {
  const r = await c.query(
    `SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + $${params.length + 1}::numeric)::text, true) FROM (${instantSql}) x`,
    [...params, seconds],
  );
  if (r.rowCount !== 1) throw new Error("the reference instant is not visible to the session");
}

// --- agreement versions -------------------------------------------------------------------------------------------------------------

export interface PublishedAgreement {
  readonly kind: "TERMS" | "PRIVACY";
  readonly version: string;
  /** The document hash of the version (the digest the acceptance names). */
  readonly documentHash: string;
}

export interface PublishedAgreements {
  readonly terms: PublishedAgreement;
  readonly privacy: PublishedAgreement;
}

/**
 * The control plane publishes a terms version and a privacy version (service_agreement_versions): the PUBLISHED version of each kind,
 * if any, is retired first (one PUBLISHED per kind), so an agency can accept exactly the versions named here.
 */
export async function publishAgreementVersions(h: Harness, versions: { readonly terms: string; readonly privacy: string }): Promise<PublishedAgreements> {
  return asRole(h, "kauro_control_test", async (control) => {
    const publish = async (kind: "TERMS" | "PRIVACY", version: string): Promise<PublishedAgreement> => {
      const documentHash = sha(`${kind}-${version}`);
      await within(control, {}, async (c) => {
        await c.query("UPDATE kauro.service_agreement_versions SET state = 'RETIRED', retired_at = now() WHERE agreement_kind = $1 AND state = 'PUBLISHED'", [kind]);
        await c.query("INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ($1, $2, $3, now(), now(), now())", [kind, version, documentHash]);
      });
      return { kind, version, documentHash };
    };
    return { terms: await publish("TERMS", versions.terms), privacy: await publish("PRIVACY", versions.privacy) };
  });
}

// --- founding reservation -----------------------------------------------------------------------------------------------------------

/**
 * The founding reservation of an ISSUED quote, written by the agency's request handlers as CMD027's issuance writes it (design §3.3):
 * the slot taken while it is not held and the reservation RESERVED until the quote's expiry. The quote's eligibility snapshot must
 * name `reservationId` (issueQuote's `foundingReservationId`); the database checks it at COMMIT.
 */
export async function reserveFoundingSlot(h: Harness, input: { readonly agency: AgencyFixture; readonly quoteId: string; readonly reservationId: string; readonly slotNo?: number }): Promise<{ readonly reservationId: string; readonly slotNo: number }> {
  const slotNo = input.slotNo ?? 1;
  await asRole(h, "kauro_app_test", (app) =>
    within(app, { agencyId: input.agency.agencyId, userId: input.agency.ownerUserId }, async (c) => {
      const took = await c.query(
        "UPDATE kauro.founding_slots SET held = true, live_reservation_id = $2, live_agency_id = kauro.current_agency_id(), updated_at = now() WHERE policy_version = 'R2-INITIAL' AND slot_no = $1 AND NOT held",
        [slotNo, input.reservationId],
      );
      if (took.rowCount !== 1) throw new Error(`founding slot ${slotNo} is not free`);
      await c.query(
        `INSERT INTO kauro.founding_slot_reservations (reservation_id, agency_id, quote_id, policy_version, slot_no, ends_at, created_at, updated_at)
         SELECT $1, $2, $3, 'R2-INITIAL', $4, q.expires_at, now(), now() FROM kauro.quotes q WHERE q.quote_id = $3`,
        [input.reservationId, input.agency.agencyId, input.quoteId, slotNo],
      );
    }),
  );
  return { reservationId: input.reservationId, slotNo };
}

// --- the commission lines of an agency ----------------------------------------------------------------------------------------------

export interface AcquiredAgency {
  readonly agencyId: AgencyId;
  readonly sellerId: string;
  readonly sellerUserId: string;
  readonly allocationId: string;
  readonly claimId: string;
}

/**
 * The attribution that precedes an agency's first purchase (design §5): an ACTIVE seller — every fact of the activation recorded by the
 * corporate owner `ownerUserId` (kauro_app, OPERATOR) — a RESEARCHED prospect, the seller's SUBMITTED claim and the single-share
 * allocation the owner freezes, which accepts the claim for the agency.
 */
export async function recordAcquisition(h: Harness, input: { readonly agency: AgencyFixture; readonly ownerUserId: UserId; readonly name: string }): Promise<AcquiredAgency> {
  const { agency, ownerUserId, name } = input;
  const sellerUserId = await h.person(`seller-${name}`);
  const sellerId = ids.next();
  const reviewId = ids.next();
  const agreementId = ids.next();
  const agreementVersion = `SA-${agreementId.slice(-8)}`;
  const assessmentId = ids.next();
  const destinationId = ids.next();
  const prospectId = ids.next();
  const claimId = ids.next();
  const allocationId = ids.next();
  const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`;
  const stepUpOfOwner = await h.recordStepUp(ownerUserId);
  const stepUpOfSeller = await h.recordStepUp(sellerUserId as UserId);
  await asRole(h, "kauro_app_test", async (app) => {
    await within(app, { userId: ownerUserId }, async (c) => {
      await c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())", [sellerId, sellerUserId, `Seller ${name}`, ownerUserId]);
      await c.query(
        "INSERT INTO kauro.seller_legal_reviews (review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, reviewed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'INDEPENDENT_COLLABORATION', 'CONFIRMED', $3, 'Reviewing counsel', $4, now(), $5, now())",
        [reviewId, sellerId, sha(`substance-${reviewId}`), sha(`review-${reviewId}`), ownerUserId],
      );
      await c.query(
        `INSERT INTO kauro.seller_agreements (agreement_id, seller_id, agreement_version, classification, legal_review_id, starts_at, first_bps, repeat_bps, recurring_months, offset_terms,
           retainer_cents_per_month, compensation_policy_version, signed_terms_hash, prepared_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'INDEPENDENT_COLLABORATION', $4, now(), 1000, 400, 12, 'NONE', 0, 'R2-INITIAL', $5, $6, now(), now())`,
        [agreementId, sellerId, agreementVersion, reviewId, sha(`terms-${agreementId}`), ownerUserId],
      );
      await c.query("UPDATE kauro.seller_agreements SET signed_at = now(), signature_evidence_hash = $2, version = 2 WHERE agreement_id = $1", [agreementId, sha(`signature-${agreementId}`)]);
      await c.query("INSERT INTO kauro.seller_assessments (assessment_id, seller_id, outcome, evidence_hash, assessed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'PASSED', $3, now(), $4, now())", [assessmentId, sellerId, sha(`assessment-${assessmentId}`), ownerUserId]);
      await c.query(
        "INSERT INTO kauro.seller_confidentiality_acceptances (acceptance_id, seller_id, terms_hash, evidence_hash, accepted_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, now(), $5, now())",
        [ids.next(), sellerId, sha("confidentiality-and-data-handling-v1"), sha(`acceptance-${sellerId}`), ownerUserId],
      );
      await c.query(
        "INSERT INTO kauro.seller_tax_documents (document_id, seller_id, jurisdiction, requirements_hash, evidence_hash, verified_at, verified_by_user_id, created_at) VALUES ($1, $2, 'CO', $3, $4, now(), $5, now())",
        [ids.next(), sellerId, sha(`requirements-${sellerId}`), sha(`tax-${sellerId}`), ownerUserId],
      );
    });
    // the seller's own payout destination, verified by the owner two days later (the TEST CLOCK stands there), then the owner's activation
    await within(app, { userId: sellerUserId }, (c) =>
      c.query(
        `INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
         VALUES ($1, $2, 1, $3, $4, 'USD', $5, $6, kauro.server_now(), now(), now())`,
        [destinationId, sellerId, `Bank ****${destinationId.slice(-4)}`, sha(`destination-${destinationId}`), sellerUserId, stepUpOfSeller],
      ),
    );
    await within(app, { userId: ownerUserId }, async (c) => {
      await clockAfter(c, "SELECT changed_at AS at FROM kauro.seller_payout_destinations WHERE destination_id = $1", [destinationId], 172_800);
      await c.query("UPDATE kauro.seller_payout_destinations SET state = 'VERIFIED', verified_by_user_id = $2, verified_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [destinationId, ownerUserId]);
    });
    await within(app, { userId: ownerUserId }, (c) =>
      c.query(
        "UPDATE kauro.sellers SET state = 'ACTIVE', agreement_id = $2, activation_assessment_id = $3, activated_by_user_id = $4, activation_proof_ref = $5, activated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1",
        [sellerId, agreementId, assessmentId, ownerUserId, stepUpOfOwner],
      ),
    );
    // the seller's prospect and claim (CMD045, CMD046)
    const contactId = ids.next();
    const evidenceHash = sha(`source-evidence-${prospectId}`);
    await within(app, { userId: sellerUserId }, async (c) => {
      await c.query(
        "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
        [ids.next(), sellerUserId, sellerId, evidenceHash, sha(`https://${domain}/`)],
      );
      await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, sellerUserId, sha(`contact:${domain}:${contactId}`)]);
      await c.query(
        `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'United States', $6, $7, $7, now(), now())`,
        [prospectId, `${domain} agency`, sha(`organization:${domain}`), contactId, evidenceHash, sellerUserId, sellerId],
      );
      const claimEvidence = sha(`claim-evidence-${claimId}`);
      await c.query(
        `INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at)
         VALUES ($1, $2, $3, $4, 'DISCOVERY_CALL', kauro.server_now() - interval '2 days', $5, ARRAY['DISCOVERY_CALL', 'QUALIFIED_NEED']::text[], kauro.server_now(), now())`,
        [ids.next(), sellerId, prospectId, claimEvidence, sha(`need-${claimId}`)],
      );
      await c.query(
        `INSERT INTO kauro.attribution_claims (claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, submitted_at, review_deadline_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.server_now() + interval '2160 hours', now(), now())`,
        [claimId, prospectId, sellerId, agreementId, agreementVersion, claimEvidence],
      );
    });
    // the owner prepares the allocation of the claim to the agency, freezes it and accepts the claim (CMD047)
    await within(app, { userId: ownerUserId }, async (c) => {
      await c.query(
        `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Qualified discovery and first meaningful contact by the claimant', $5, 1000, 400, 12, $6, now(), now(), now())`,
        [allocationId, agency.agencyId, prospectId, sha(`identity-${allocationId}`), sha(`ruling-${allocationId}`), ownerUserId],
      );
      await c.query(
        `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 10000, 1000, 400, 12, now())`,
        [allocationId, sellerId, claimId, prospectId, agreementId, agreementVersion],
      );
      await c.query("UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = $2, version = version + 1 WHERE allocation_id = $1", [allocationId, ownerUserId]);
      await c.query(
        `UPDATE kauro.attribution_claims SET state = 'ACCEPTED', agency_id = $2, allocation_id = $3, accepted_at = kauro.server_now(), expires_at = kauro.server_now() + interval '2160 hours',
           decided_by_user_id = $4, version = version + 1 WHERE claim_id = $1`,
        [claimId, agency.agencyId, allocationId, ownerUserId],
      );
    });
  });
  return { agencyId: agency.agencyId, sellerId, sellerUserId, allocationId, claimId };
}

export interface RecordedLine {
  readonly poolId: string;
  readonly lineId: string;
  readonly entitlementId: string;
}

/**
 * The COMMISSIONS consumer's work for the agency's first purchase, as the commission service writes it in the agency it adopted: the
 * claim CONVERTED into its ACQUISITION entitlement (the window from the first designation to twelve calendar months later in
 * America/Bogota), and the pool and the ACCRUED_PENDING line of the first purchase at 1000 bps of the service basis the caller states —
 * the pool's integer cents are the caller's too (a worked example's cents are written in the test, never computed here).
 */
export async function recordFirstPurchaseLine(h: Harness, input: { readonly acquired: AcquiredAgency; readonly authorizationId: string; readonly captureId: string; readonly projectId: string; readonly basisCents: bigint; readonly poolCents: bigint }): Promise<RecordedLine> {
  const { acquired } = input;
  const entitlementId = ids.next();
  const poolId = ids.next();
  const lineId = ids.next();
  await asRole(h, "kauro_commission_test", (commission) =>
    within(commission, { agencyId: acquired.agencyId }, async (c) => {
      await c.query("UPDATE kauro.attribution_claims SET state = 'CONVERTED', converted_at = kauro.server_now(), version = version + 1 WHERE claim_id = $1", [acquired.claimId]);
      await c.query(
        `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, agreement_id, agreement_version, share_bps, first_capture_id,
           window_starts_at, window_ends_at, created_at, updated_at)
         SELECT $1, s.agency_id, sh.seller_id, 'ACQUISITION', sh.allocation_id, sh.claim_id, sh.agreement_id, sh.agreement_version, sh.share_bps, r.first_capture_id, r.first_confirmed_at,
                ((r.first_confirmed_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota', now(), now()
           FROM kauro.allocation_shares sh JOIN kauro.attribution_allocations s ON s.allocation_id = sh.allocation_id JOIN kauro.agency_recurrence r ON r.agency_id = s.agency_id
          WHERE sh.allocation_id = $2 AND sh.seller_id = $3`,
        [entitlementId, acquired.allocationId, acquired.sellerId],
      );
      await c.query(
        `INSERT INTO kauro.commission_pools (pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, allocation_id, rate_kind, rate_bps, initial_basis_cents, basis_cents, pool_cents,
           policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, 'ACQUISITION', $6, 'FIRST', 1000, $7, $7, $8, 'R2-INITIAL', now(), now())`,
        [poolId, acquired.agencyId, input.authorizationId, input.captureId, input.projectId, acquired.allocationId, input.basisCents.toString(), input.poolCents.toString()],
      );
      await c.query(
        `INSERT INTO kauro.commission_lines (line_id, agency_id, pool_id, entitlement_id, seller_id, authorization_id, capture_id, share_bps, rate_bps, net_service_basis_cents, cumulative_entitlement_cents,
           previous_posted_cents, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, 1000, $8, $9, $9, 'R2-INITIAL', now(), now())`,
        [lineId, acquired.agencyId, poolId, entitlementId, acquired.sellerId, input.authorizationId, input.captureId, input.basisCents.toString(), input.poolCents.toString()],
      );
    }),
  );
  return { poolId, lineId, entitlementId };
}

/**
 * The ELIGIBILITY sweep of a line: the purchase's FINAL completion recorded, the capture's funds observed AVAILABLE and the line moved
 * ELIGIBLE 720 hours after the completion (the TEST CLOCK stands there), by the commission service. `captureVersion` is the capture
 * fact's current version (the funds observation names it).
 */
export async function makeLineEligible(h: Harness, input: { readonly agencyId: string; readonly lineId: string; readonly authorizationId: string; readonly captureId: string; readonly captureVersion: number }): Promise<void> {
  const completionId = ids.next();
  await asRole(h, "kauro_commission_test", async (commission) => {
    await within(commission, { agencyId: input.agencyId }, async (c) => {
      await c.query(
        "INSERT INTO kauro.purchase_completions (completion_id, agency_id, authorization_id, kind, stage_ref, completed_at, evidence_hash, source, recorded_at, created_at) VALUES ($1, $2, $3, 'FINAL', NULL, kauro.server_now(), $4, 'AUTHORIZATION_DELIVERY', kauro.server_now(), now())",
        [completionId, input.agencyId, input.authorizationId, sha(`completion-${completionId}`)],
      );
      await c.query(
        "INSERT INTO kauro.capture_funds_observations (observation_id, agency_id, capture_id, capture_version, funds_state, review_at, source_event_id, observed_at, created_at) VALUES ($1, $2, $3, $4, 'AVAILABLE', NULL, $5, now(), now())",
        [ids.next(), input.agencyId, input.captureId, input.captureVersion, ids.next()],
      );
    });
    await within(commission, {}, async (c) => {
      await clockAfter(c, "SELECT pc.completed_at AS at FROM kauro.commission_lines l JOIN kauro.purchase_completions pc ON pc.agency_id = l.agency_id AND pc.authorization_id = l.authorization_id AND pc.kind = 'FINAL' WHERE l.line_id = $1", [input.lineId], 720 * 3600);
      await c.query(
        `UPDATE kauro.commission_lines l SET state = 'ELIGIBLE', eligible_at = pc.completed_at + interval '720 hours', final_completion_id = pc.completion_id, version = l.version + 1
           FROM kauro.purchase_completions pc WHERE l.line_id = $1 AND pc.agency_id = l.agency_id AND pc.authorization_id = l.authorization_id AND pc.kind = 'FINAL'`,
        [input.lineId],
      );
    });
  });
}

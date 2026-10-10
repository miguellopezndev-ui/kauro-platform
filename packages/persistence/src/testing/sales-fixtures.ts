/**
 * Fixtures of package B10's sales and attribution adapters (@kauro/persistence/testing; mandate B10-ADAPTERS-SALES; design §5, §6,
 * D10-SELL-1..3, D10-PROS-1, D10-CLAIM-1, D10-ATTR-1..2): an ACTIVE seller with every activation fact, a prospect with its evidence,
 * a claim, a frozen allocation, the conversion into entitlements, a service assignment and an assistance agreement. Each row is
 * written by the runtime role that owns it, under its real context, so the fixtures themselves prove that the policies admit the
 * legitimate writes: the corporate owner and the sellers through kauro_app (an OPERATOR session: its person bound, no agency), the
 * commission service through kauro_commission in the agency it adopted. Instants are the server's (kauro.server_now()); the labelled
 * TEST CLOCK (D10-CLOCK-1) stands the destination's owner verification at 172800 s after its change. No fixture writes as the
 * superuser.
 */
import type { Client } from "pg";
import type { AssistanceAgreementId, ProspectId, SellerAgreementId, SellerId, ServiceAssignmentRef, UserId } from "@kauro/domain";
import { ids, sha, type Harness } from "./harness.js";

/** A person's OPERATOR session (a seller's, the owner's) or the commission service's adopted agency. */
interface Context {
  readonly userId?: string;
  readonly agencyId?: string;
}

async function within<T>(client: Client, ctx: Context, fn: (c: Client) => Promise<T>): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', '', true)", [ctx.agencyId ?? "", ctx.userId ?? ""]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** One connection of a runtime role for the duration of a fixture. */
async function asRole<T>(h: Harness, role: "kauro_app_test" | "kauro_commission_test", ctx: Context, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await h.pg.connect(role);
  try {
    return await within(client, ctx, fn);
  } finally {
    await client.end();
  }
}

export interface RecordedSeller {
  readonly sellerId: SellerId;
  readonly userId: UserId;
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly reviewId: string;
  readonly assessmentId: string;
  readonly destinationId: string;
  readonly destinationDigest: string;
}

export interface SellerTerms {
  readonly offsetTerms?: "NONE" | "SIGNED_FUTURE_OFFSET";
  readonly firstBps?: number;
  readonly repeatBps?: number;
  readonly retainerCentsPerMonth?: number;
}

/**
 * An ACTIVE seller of a new corporate identity with every activation fact of design 17 recorded by its owner: a confirming legal
 * review, a signed agreement (1000/400 bps, twelve months), a passed assessment, the confidentiality acceptance, tax documentation
 * and a VERIFIED payout destination (the seller's own step-up at the change, the owner's verification 172800 s later), then CMD049's
 * write with the owner's own fresh step-up.
 */
export async function recordActiveSeller(h: Harness, options: { readonly ownerUserId: UserId; readonly subject: string; readonly terms?: SellerTerms }): Promise<RecordedSeller> {
  const owner = options.ownerUserId;
  const terms = options.terms ?? {};
  const userId = await h.person(`seller-${options.subject}`);
  const sellerId = ids.next() as SellerId;
  const reviewId = ids.next();
  const agreementId = ids.next() as SellerAgreementId;
  const agreementVersion = `SA-${agreementId.slice(-8)}`;
  const assessmentId = ids.next();
  const destinationId = ids.next();
  const destinationDigest = sha(`destination-${destinationId}`);
  const sellerProof = await h.recordStepUp(userId);
  await asRole(h, "kauro_app_test", { userId: owner }, async (c) => {
    await c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())", [sellerId, userId, `Seller ${options.subject}`, owner]);
    await c.query(
      "INSERT INTO kauro.seller_legal_reviews (review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, reviewed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'INDEPENDENT_COLLABORATION', 'CONFIRMED', $3, 'Reviewing counsel', $4, now(), $5, now())",
      [reviewId, sellerId, sha(`substance-${reviewId}`), sha(`review-${reviewId}`), owner],
    );
    await c.query(
      `INSERT INTO kauro.seller_agreements (agreement_id, seller_id, agreement_version, classification, legal_review_id, starts_at, first_bps, repeat_bps, recurring_months, offset_terms,
         retainer_cents_per_month, compensation_policy_version, signed_terms_hash, prepared_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'INDEPENDENT_COLLABORATION', $4, now(), $5, $6, 12, $7, $8, 'R2-INITIAL', $9, $10, now(), now())`,
      [agreementId, sellerId, agreementVersion, reviewId, terms.firstBps ?? 1000, terms.repeatBps ?? 400, terms.offsetTerms ?? "NONE", terms.retainerCentsPerMonth ?? 0, sha(`terms-${agreementId}`), owner],
    );
    await c.query("UPDATE kauro.seller_agreements SET signed_at = now(), signature_evidence_hash = $2, version = 2 WHERE agreement_id = $1", [agreementId, sha(`signature-${agreementId}`)]);
    await c.query("INSERT INTO kauro.seller_assessments (assessment_id, seller_id, outcome, evidence_hash, assessed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'PASSED', $3, now(), $4, now())", [assessmentId, sellerId, sha(`assessment-${assessmentId}`), owner]);
    await c.query(
      "INSERT INTO kauro.seller_confidentiality_acceptances (acceptance_id, seller_id, terms_hash, evidence_hash, accepted_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, now(), $5, now())",
      [ids.next(), sellerId, sha("confidentiality-and-data-handling-v1"), sha(`acceptance-${sellerId}`), owner],
    );
    await c.query(
      "INSERT INTO kauro.seller_tax_documents (document_id, seller_id, jurisdiction, requirements_hash, evidence_hash, verified_at, verified_by_user_id, created_at) VALUES ($1, $2, 'CO', $3, $4, now(), $5, now())",
      [ids.next(), sellerId, sha(`requirements-${sellerId}`), sha(`tax-${sellerId}`), owner],
    );
  });
  // the seller's own change of its destination, with its own step-up
  await asRole(h, "kauro_app_test", { userId }, (c) =>
    c.query(
      `INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, 'USD', $5, $6, kauro.server_now(), now(), now())`,
      [destinationId, sellerId, `Bank ****${destinationId.slice(-4)}`, destinationDigest, userId, sellerProof],
    ),
  );
  // the owner's verification at least 172800 s later (the labelled TEST CLOCK stands there), then the activation with its own step-up
  const ownerProof = await h.recordStepUp(owner);
  await asRole(h, "kauro_app_test", { userId: owner }, async (c) => {
    await c.query(
      "SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + 172800)::text, true) FROM (SELECT changed_at AS at FROM kauro.seller_payout_destinations WHERE destination_id = $1) x",
      [destinationId],
    );
    await c.query("UPDATE kauro.seller_payout_destinations SET state = 'VERIFIED', verified_by_user_id = $2, verified_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [destinationId, owner]);
    await c.query("SELECT set_config('kauro_test.clock_offset_seconds', '0', true)");
    await c.query(
      "UPDATE kauro.sellers SET state = 'ACTIVE', agreement_id = $2, activation_assessment_id = $3, activated_by_user_id = $4, activation_proof_ref = $5, activated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1",
      [sellerId, agreementId, assessmentId, owner, ownerProof],
    );
  });
  return { sellerId, userId, agreementId, agreementVersion, reviewId, assessmentId, destinationId, destinationDigest };
}

export interface RecordedProspect {
  readonly prospectId: ProspectId;
  readonly organizationKey: string;
  readonly contactId: string;
  readonly contactKey: string;
  readonly evidenceHash: string;
}

/**
 * CMD045's writes by an ACTIVE seller (or, with `by` null, by the owner `ownerUserId`): the AGENCY-segment source evidence, the
 * restricted business contact and the RESEARCHED prospect of an organization key (a digest of the normalized business domain).
 */
export async function recordProspect(h: Harness, options: { readonly by: RecordedSeller | null; readonly domain: string; readonly ownerUserId?: UserId }): Promise<RecordedProspect> {
  const userId = options.by === null ? options.ownerUserId : options.by.userId;
  if (userId === undefined) throw new Error("recordProspect needs a seller or the owner's identity");
  const sellerId = options.by?.sellerId ?? null;
  const prospectId = ids.next() as ProspectId;
  const organizationKey = sha(`organization:${options.domain}`);
  const contactId = ids.next();
  const contactKey = sha(`contact:${options.domain}:${contactId}`);
  const evidenceHash = sha(`source-evidence-${prospectId}`);
  await asRole(h, "kauro_app_test", { userId }, async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
      [ids.next(), userId, sellerId, evidenceHash, sha(`https://${options.domain}/`)],
    );
    await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, userId, contactKey]);
    await c.query(
      `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'United States', $6, $7, $7, now(), now())`,
      [prospectId, `${options.domain} agency`, organizationKey, contactId, evidenceHash, userId, sellerId],
    );
  });
  return { prospectId, organizationKey, contactId, contactKey, evidenceHash };
}

/** CMD046's writes by an ACTIVE seller: substantive claim evidence and the SUBMITTED claim under its agreement version in force. */
export async function recordClaim(h: Harness, options: { readonly seller: RecordedSeller; readonly prospectId: string; readonly at?: string }): Promise<{ readonly claimId: string }> {
  const { seller } = options;
  const claimId = ids.next();
  const evidenceHash = sha(`claim-evidence-${claimId}`);
  await asRole(h, "kauro_app_test", { userId: seller.userId }, async (c) => {
    // the labelled TEST CLOCK stands the whole claim (evidence, submission, review deadline) at one instant when given
    if (options.at !== undefined) await c.query("SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)", [options.at]);
    await c.query(
      `INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, 'DISCOVERY_CALL', kauro.server_now() - interval '2 days', $5, ARRAY['DISCOVERY_CALL', 'QUALIFIED_NEED']::text[], kauro.server_now(), now())`,
      [ids.next(), seller.sellerId, options.prospectId, evidenceHash, sha(`need-${claimId}`)],
    );
    await c.query(
      `INSERT INTO kauro.attribution_claims (claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, submitted_at, review_deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.server_now() + interval '2160 hours', now(), now())`,
      [claimId, options.prospectId, seller.sellerId, seller.agreementId, seller.agreementVersion, evidenceHash],
    );
  });
  return { claimId };
}

/**
 * The owner's allocation of the claims on a prospect to an agency (the beneficiaries' shares under their agreements, 1000/400 bps,
 * twelve months), frozen with every claim it names ACCEPTED at that instant (CMD047).
 */
export async function recordFrozenAllocation(
  h: Harness,
  options: { readonly ownerUserId: UserId; readonly agencyId: string; readonly prospectId: string; readonly shares: ReadonlyArray<{ readonly seller: RecordedSeller; readonly claimId: string; readonly shareBps: number }> },
): Promise<{ readonly allocationId: string }> {
  const owner = options.ownerUserId;
  const allocationId = ids.next();
  await asRole(h, "kauro_app_test", { userId: owner }, async (c) => {
    await c.query(
      `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Qualified discovery and first meaningful contact by the claimant', $5, 1000, 400, 12, $6, now(), now(), now())`,
      [allocationId, options.agencyId, options.prospectId, sha(`identity-${allocationId}`), sha(`ruling-${allocationId}`), owner],
    );
    for (const s of options.shares) {
      await c.query(
        `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, 400, 12, now())`,
        [allocationId, s.seller.sellerId, s.claimId, options.prospectId, s.seller.agreementId, s.seller.agreementVersion, s.shareBps],
      );
    }
    await c.query("SELECT set_config('kauro.finance_agency_id', $1, true)", [options.agencyId]);
    await c.query("UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = $2, version = version + 1 WHERE allocation_id = $1", [allocationId, owner]);
    for (const s of options.shares) {
      await c.query(
        `UPDATE kauro.attribution_claims SET state = 'ACCEPTED', agency_id = $2, allocation_id = $3, accepted_at = kauro.server_now(), expires_at = kauro.server_now() + interval '2160 hours',
           decided_by_user_id = $4, version = version + 1 WHERE claim_id = $1`,
        [s.claimId, options.agencyId, allocationId, owner],
      );
    }
  });
  return { allocationId };
}

/**
 * The COMMISSIONS consumer's conversion at the agency's first qualifying purchase (D10-ATTR-2), in the agency the commission service
 * adopted: each share's claim CONVERTED and its ACQUISITION entitlement, the window from the first designation's confirmation to
 * twelve calendar months later at the same America/Bogota wall time. Returns each beneficiary's entitlement by seller id.
 */
export async function recordConversion(h: Harness, options: { readonly agencyId: string; readonly allocationId: string }): Promise<Map<string, { readonly entitlementId: string }>> {
  return asRole(h, "kauro_commission_test", { agencyId: options.agencyId }, async (c) => {
    const shares = await c.query<{ seller_id: string; claim_id: string }>("SELECT seller_id, claim_id FROM kauro.allocation_shares WHERE allocation_id = $1 ORDER BY seller_id", [options.allocationId]);
    const out = new Map<string, { readonly entitlementId: string }>();
    for (const s of shares.rows) {
      await c.query("UPDATE kauro.attribution_claims SET state = 'CONVERTED', converted_at = kauro.server_now(), version = version + 1 WHERE claim_id = $1", [s.claim_id]);
      const entitlementId = ids.next();
      await c.query(
        `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, agreement_id, agreement_version, share_bps, first_capture_id,
           window_starts_at, window_ends_at, created_at, updated_at)
         SELECT $1, s.agency_id, sh.seller_id, 'ACQUISITION', sh.allocation_id, sh.claim_id, sh.agreement_id, sh.agreement_version, sh.share_bps, r.first_capture_id, r.first_confirmed_at,
                ((r.first_confirmed_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota', now(), now()
           FROM kauro.allocation_shares sh JOIN kauro.attribution_allocations s ON s.allocation_id = sh.allocation_id JOIN kauro.agency_recurrence r ON r.agency_id = s.agency_id
          WHERE sh.allocation_id = $2 AND sh.seller_id = $3`,
        [entitlementId, options.allocationId, s.seller_id],
      );
      out.set(s.seller_id, { entitlementId });
    }
    return out;
  });
}

/**
 * The owner's service assignment of a seller to an agency (design §5): compensation NONE, or the signed assistance agreement
 * `assistanceAgreementId` states for the work. Returns its id (the reference an account assignment cites).
 */
export async function recordServiceAssignment(h: Harness, options: { readonly ownerUserId: UserId; readonly agencyId: string; readonly sellerId: string; readonly assistanceAgreementId?: string }): Promise<ServiceAssignmentRef> {
  const id = ids.next() as ServiceAssignmentRef;
  await asRole(h, "kauro_app_test", { userId: options.ownerUserId }, (c) =>
    c.query(
      "INSERT INTO kauro.service_assignments (service_assignment_id, agency_id, seller_id, compensation, assistance_agreement_id, terms_hash, prepared_by_user_id, prepared_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, kauro.server_now(), now())",
      [id, options.agencyId, options.sellerId, options.assistanceAgreementId === undefined ? "NONE" : "ASSISTANCE_AGREEMENT", options.assistanceAgreementId ?? null, sha(`service-${id}`), options.ownerUserId],
    ),
  );
  return id;
}

/**
 * The owner's assistance agreement (R2-099, D10-ASSIST-1): signed now under the seller's agreement in force, for a project or the
 * agency's next purchase, at 400 bps. Returns its id.
 */
export async function recordAssistanceAgreement(
  h: Harness,
  options: { readonly ownerUserId: UserId; readonly agencyId: string; readonly seller: RecordedSeller; readonly scope: "PROJECT" | "NEXT_PURCHASE"; readonly projectId?: string },
): Promise<AssistanceAgreementId> {
  const id = ids.next() as AssistanceAgreementId;
  await asRole(h, "kauro_app_test", { userId: options.ownerUserId }, (c) =>
    c.query(
      `INSERT INTO kauro.assistance_agreements (assistance_agreement_id, agency_id, seller_id, agreement_id, agreement_version, scope, project_id, rate_bps, terms_hash, signed_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 400, $8, kauro.server_now(), $9, now())`,
      [id, options.agencyId, options.seller.sellerId, options.seller.agreementId, options.seller.agreementVersion, options.scope, options.projectId ?? null, sha(`assistance-${id}`), options.ownerUserId],
    ),
  );
  return id;
}

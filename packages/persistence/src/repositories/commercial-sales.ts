/**
 * The sales records of package B10 over `pg` (mandate B10-ADAPTERS-SALES; migration 0029; docs/design/B10-commercial-domain.md §2,
 * §5, §10, §11; decisions D10-CTX-2, D10-CTX-3, D10-SELL-1..4, D10-PROS-1, D10-ASSIGN-1, D10-ASSIGN-2, D10-ASSIST-1, D10-ASSIST-2,
 * D10-TERM-1, D10-TX-1): sellers and the facts they are activated on, payout destinations, prospects with their source evidence,
 * contacts and suppressions, sales accounts and the assignment chain, assistance agreements and their applicability, termination
 * terms, manifests and tail entries (the SalesRepository port of @kauro/domain), and the CommercialPrincipalReader the commercial
 * authorizer of @kauro/application reads (its shape written structurally here: the persistence adapter depends on no application
 * module, as B09's purchased subject).
 *
 * These are corporate records (D10-CTX-3): every read goes through the policies of the unit of work's own session — the corporate
 * owner reads all, a seller its own rows, the commission service what it works with — so a row the caller may not read answers null,
 * never an error that tells it exists. The writes are the owner's and the sellers' (kauro_app OPERATOR sessions); the rows the owner
 * prepares before a command (agreements, reviews, service assignments, assistance agreements, termination terms and manifests) are
 * recorded by the owner's own tools (B12), read here. Every instant the adapter records is `kauro.server_now()` (commercial-sales-rows).
 * The database repeats each rule: KC005 (activation facts), KC016 (suppression), KC011 (tail), the unique indexes of design §12
 * (sqlstate.ts COMMERCIAL_UNIQUE_FAILURES), and the deferred chain check of the assignments.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AccountAssignmentId,
  type AccountAssignmentRecord,
  type AgencyId,
  type AssignmentReason,
  type AssistanceAgreementId,
  type AssistanceAgreementRecord,
  type AssistanceScope,
  type AssuranceProofId,
  type AttributionClaimId,
  type DestinationCurrency,
  type IdGenerator,
  type NewAccountAssignment,
  type NewProspect,
  type NewSellerTermination,
  type OffsetTerms,
  type PayoutDestinationId,
  type PayoutDestinationRecord,
  type PayoutDestinationState,
  type ProjectId,
  type ProspectContactRecord,
  type ProspectContactRef,
  type ProspectId,
  type ProspectRecord,
  type ProspectSegment,
  type ProspectSourceEvidenceRecord,
  type ProspectState,
  type ProspectSuppressionId,
  type ProspectSuppressionRecord,
  type SalesAccountRecord,
  type SalesRepository,
  type SellerActivationFacts,
  type SellerAgreementId,
  type SellerAgreementRecord,
  type SellerAssessmentId,
  type SellerAssessmentRecord,
  type SellerChange,
  type SellerClassification,
  type SellerConfidentialityAcceptanceId,
  type SellerConfidentialityAcceptanceRecord,
  type SellerId,
  type SellerLegalReviewId,
  type SellerLegalReviewRecord,
  type SellerRecord,
  type SellerState,
  type SellerTaxDocumentationId,
  type SellerTaxDocumentationRecord,
  type SellerTerminationRecord,
  type ServiceAssignmentRecord,
  type ServiceAssignmentRef,
  type ServiceCompensation,
  type SuppressionKeyKind,
  type TerminationManifestRecord,
  type TerminationManifestRef,
  type TerminationTailEntryRecord,
  type LegalReviewOutcome,
  type AssessmentOutcome,
  type TerminationTermsRef,
  type UserId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { cents, defined } from "./commerce-shared.js";
import { awaitSalesTransition, canonical, holdSalesTransition, instantOf, optionalInstantOf, optionalString, staleRow } from "./commercial-sales-rows.js";

// --- rows ---------------------------------------------------------------------------------------------------------------------------

const SELLER = `seller_id, user_id, display_label, state, version, agreement_id, activation_assessment_id, ${canonical("created_at")}, ${canonical("activated_at")}, ${canonical("terminated_at")}`;
interface SellerRow {
  seller_id: string;
  user_id: string;
  display_label: string;
  state: SellerState;
  version: string;
  agreement_id: string | null;
  activation_assessment_id: string | null;
  created_at: string;
  activated_at: string | null;
  terminated_at: string | null;
}
function sellerRecord(r: SellerRow): SellerRecord {
  return defined<SellerRecord>(
    { sellerId: r.seller_id as SellerId, userId: r.user_id as UserId, displayLabel: r.display_label, state: r.state, version: int(r.version), createdAt: instantOf(r.created_at) },
    {
      activeAgreementId: optionalString<SellerAgreementId>(r.agreement_id),
      activationAssessmentId: optionalString<SellerAssessmentId>(r.activation_assessment_id),
      activatedAt: optionalInstantOf(r.activated_at),
      terminatedAt: optionalInstantOf(r.terminated_at),
    },
  );
}

const AGREEMENT = `agreement_id, seller_id, agreement_version, classification, legal_review_id, ${canonical("starts_at")}, ${canonical("ends_at")}, first_bps, repeat_bps, recurring_months,
  signed_terms_hash, ${canonical("signed_at")}, signature_evidence_hash, offset_terms, retainer_cents_per_month::text AS retainer_cents_per_month, compensation_policy_version, version`;
interface AgreementRow {
  agreement_id: string;
  seller_id: string;
  agreement_version: string;
  classification: SellerClassification;
  legal_review_id: string;
  starts_at: string;
  ends_at: string | null;
  first_bps: number;
  repeat_bps: number;
  recurring_months: number;
  signed_terms_hash: string;
  signed_at: string | null;
  signature_evidence_hash: string | null;
  offset_terms: OffsetTerms;
  retainer_cents_per_month: string;
  compensation_policy_version: string;
  version: string;
}
function agreementRecord(r: AgreementRow): SellerAgreementRecord {
  return defined<SellerAgreementRecord>(
    {
      agreementId: r.agreement_id as SellerAgreementId,
      sellerId: r.seller_id as SellerId,
      agreementVersion: r.agreement_version,
      classification: r.classification,
      legalReviewId: r.legal_review_id as SellerLegalReviewId,
      startsAt: instantOf(r.starts_at),
      firstBps: r.first_bps,
      repeatBps: r.repeat_bps,
      recurringMonths: r.recurring_months,
      signedTermsHash: r.signed_terms_hash,
      offsetTerms: r.offset_terms,
      retainerCentsPerMonth: cents(r.retainer_cents_per_month),
      compensationPolicyVersion: r.compensation_policy_version,
      version: int(r.version),
    },
    { endsAt: optionalInstantOf(r.ends_at), signedAt: optionalInstantOf(r.signed_at), signatureEvidenceHash: optionalString<Sha256Hex>(r.signature_evidence_hash) },
  );
}

const DESTINATION = `destination_id, seller_id, destination_version, masked_label, destination_digest, currency, state, version, change_proof_ref, ${canonical("changed_at")}, ${canonical("verified_at")}, verified_by_user_id`;
interface DestinationRow {
  destination_id: string;
  seller_id: string;
  destination_version: number;
  masked_label: string;
  destination_digest: string;
  currency: DestinationCurrency;
  state: PayoutDestinationState;
  version: string;
  change_proof_ref: string | null;
  changed_at: string;
  verified_at: string | null;
  verified_by_user_id: string | null;
}
function destinationRecord(r: DestinationRow): PayoutDestinationRecord {
  return defined<PayoutDestinationRecord>(
    {
      destinationId: r.destination_id as PayoutDestinationId,
      sellerId: r.seller_id as SellerId,
      destinationVersion: r.destination_version,
      maskedLabel: r.masked_label,
      destinationDigest: r.destination_digest,
      currency: r.currency,
      state: r.state,
      version: int(r.version),
      changedAt: instantOf(r.changed_at),
    },
    { changeProofId: optionalString<AssuranceProofId>(r.change_proof_ref), verifiedAt: optionalInstantOf(r.verified_at), verifiedBy: optionalString<UserId>(r.verified_by_user_id) },
  );
}

const PROSPECT = `prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, state, suppressed, owner_seller_id, registered_by_user_id, version, ${canonical("created_at")}`;
interface ProspectRow {
  prospect_id: string;
  organization_label: string;
  organization_key: string;
  business_contact_id: string | null;
  source_evidence_hash: string;
  jurisdiction: string;
  state: ProspectState;
  suppressed: boolean;
  owner_seller_id: string | null;
  registered_by_user_id: string;
  version: string;
  created_at: string;
}
function prospectRecord(r: ProspectRow): ProspectRecord {
  return defined<ProspectRecord>(
    {
      prospectId: r.prospect_id as ProspectId,
      organizationLabel: r.organization_label,
      organizationKey: r.organization_key,
      sourceEvidenceHash: r.source_evidence_hash,
      jurisdiction: r.jurisdiction,
      state: r.state,
      suppressed: r.suppressed,
      registeredByUserId: r.registered_by_user_id as UserId,
      version: int(r.version),
      createdAt: instantOf(r.created_at),
    },
    { businessContactRef: optionalString<ProspectContactRef>(r.business_contact_id), ownerSellerId: optionalString<SellerId>(r.owner_seller_id) },
  );
}

const ACCOUNT = `agency_id, version, current_assignment_id, ${canonical("created_at")}`;
interface AccountRow {
  agency_id: string;
  version: string;
  current_assignment_id: string;
  created_at: string;
}
function accountRecord(r: AccountRow): SalesAccountRecord {
  return { agencyId: r.agency_id as AgencyId, version: int(r.version), currentAssignmentId: r.current_assignment_id as AccountAssignmentId, createdAt: instantOf(r.created_at) };
}

const LINK = (alias: string) =>
  `${alias}.assignment_id, ${alias}.agency_id, ${alias}.reason, ${alias}.seller_id, ${alias}.service_assignment_id, ${alias}.supersedes_assignment_id, ${canonical(`${alias}.effective_at`)}`;
interface LinkRow {
  assignment_id: string;
  agency_id: string;
  reason: AssignmentReason;
  seller_id: string | null;
  service_assignment_id: string | null;
  supersedes_assignment_id: string | null;
  effective_at: string;
}
function linkRecord(r: LinkRow): AccountAssignmentRecord {
  return defined<AccountAssignmentRecord>(
    { assignmentId: r.assignment_id as AccountAssignmentId, agencyId: r.agency_id as AgencyId, reason: r.reason, effectiveAt: instantOf(r.effective_at) },
    {
      sellerId: optionalString<SellerId>(r.seller_id),
      serviceAssignmentRef: optionalString<ServiceAssignmentRef>(r.service_assignment_id),
      supersedesAssignmentId: optionalString<AccountAssignmentId>(r.supersedes_assignment_id),
    },
  );
}

const ASSISTANCE = `a.assistance_agreement_id, a.seller_id, a.agency_id, a.agreement_id, a.agreement_version, a.scope, a.project_id, a.rate_bps, a.terms_hash, ${canonical("a.signed_at")}`;
interface AssistanceRow {
  assistance_agreement_id: string;
  seller_id: string;
  agency_id: string;
  agreement_id: string;
  agreement_version: string;
  scope: AssistanceScope;
  project_id: string | null;
  rate_bps: number;
  terms_hash: string;
  signed_at: string;
}
function assistanceRecord(r: AssistanceRow): AssistanceAgreementRecord {
  return defined<AssistanceAgreementRecord>(
    {
      assistanceAgreementId: r.assistance_agreement_id as AssistanceAgreementId,
      sellerId: r.seller_id as SellerId,
      agencyId: r.agency_id as AgencyId,
      agreementId: r.agreement_id as SellerAgreementId,
      agreementVersion: r.agreement_version,
      scope: r.scope,
      rateBps: r.rate_bps,
      termsHash: r.terms_hash,
      signedAt: instantOf(r.signed_at),
    },
    { projectId: optionalString<ProjectId>(r.project_id) },
  );
}

const TERMINATION = `termination_id, seller_id, terms_hash, ${canonical("prepared_at")}, manifest_id, ${canonical("effective_at")}, terminated_by_user_id, version`;
interface TerminationRow {
  termination_id: string;
  seller_id: string;
  terms_hash: string;
  prepared_at: string;
  manifest_id: string | null;
  effective_at: string | null;
  terminated_by_user_id: string | null;
  version: string;
}
function terminationRecord(r: TerminationRow): SellerTerminationRecord {
  return defined<SellerTerminationRecord>(
    { terminationId: r.termination_id as TerminationTermsRef, sellerId: r.seller_id as SellerId, termsHash: r.terms_hash, preparedAt: instantOf(r.prepared_at), version: int(r.version) },
    { manifestRef: optionalString<TerminationManifestRef>(r.manifest_id), effectiveAt: optionalInstantOf(r.effective_at), terminatedBy: optionalString<UserId>(r.terminated_by_user_id) },
  );
}

const TAIL = `termination_id, claim_id, seller_id, agency_id, ${canonical("effective_at")}, ${canonical("ends_at")}`;
interface TailRow {
  termination_id: string;
  claim_id: string;
  seller_id: string;
  agency_id: string;
  effective_at: string;
  ends_at: string;
}
function tailRecord(r: TailRow): TerminationTailEntryRecord {
  return {
    terminationId: r.termination_id as TerminationTermsRef,
    claimId: r.claim_id as AttributionClaimId,
    sellerId: r.seller_id as SellerId,
    agencyId: r.agency_id as AgencyId,
    effectiveAt: instantOf(r.effective_at),
    endsAt: instantOf(r.ends_at),
  };
}

// --- the repository -------------------------------------------------------------------------------------------------------------------

export class PgSalesRepository implements SalesRepository {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
  ) {}

  // sellers ------------------------------------------------------------------------------------------------------------------------

  /**
   * The seller row of an identity (the session's own, kauro.current_seller_id(), or any the owner reads), read after the shared half
   * of its transition lock (D10-CTX-2, D10-TX-1): a suspension or termination in flight is ordered before or after the reader.
   */
  async sellerOfIdentity(userId: UserId): Promise<SellerRecord | null> {
    const found = await execute<{ seller_id: string }>(this.db, "SELECT seller_id FROM kauro.sellers WHERE user_id = $1", [userId]);
    const sellerId = found.rows[0]?.seller_id;
    if (sellerId === undefined) return null;
    await awaitSalesTransition(this.db, "kauro.sellers", sellerId);
    return this.getSeller(sellerId as SellerId);
  }

  async getSeller(sellerId: SellerId): Promise<SellerRecord | null> {
    const r = await execute<SellerRow>(this.db, `SELECT ${SELLER} FROM kauro.sellers WHERE seller_id = $1`, [sellerId]);
    return r.rows[0] ? sellerRecord(r.rows[0]) : null;
  }

  /**
   * The agencies the seller's open claims and current operational assignments name, ascending (D10-GAP-20): what CMD050 locks, with
   * `lockAgencies`, before its first claim lock, so the agency comes before the claim in every writer.
   */
  async agenciesOfSeller(sellerId: SellerId): Promise<ReadonlyArray<AgencyId>> {
    const r = await execute<{ agency_id: string }>(
      this.db,
      `SELECT agency_id FROM (
         SELECT c.agency_id FROM kauro.attribution_claims c WHERE c.seller_id = $1 AND c.state IN ('SUBMITTED', 'DISPUTED', 'ACCEPTED') AND c.agency_id IS NOT NULL
         UNION
         SELECT s.agency_id FROM kauro.sales_accounts s JOIN kauro.account_assignments l ON l.agency_id = s.agency_id AND l.assignment_id = s.current_assignment_id WHERE l.seller_id = $1
         UNION
         SELECT e.agency_id FROM kauro.commission_entitlements e WHERE e.seller_id = $1 AND e.state IN ('ACTIVE', 'DISPUTED')) x
        ORDER BY agency_id`,
      [sellerId],
    );
    return r.rows.map((x) => x.agency_id as AgencyId);
  }

  /** The seller row FOR NO KEY UPDATE (the foreign keys of claims, entitlements and links take KEY SHARE on it, D10-GAP-20), then the writer's half of kauro.sellers (CMD049, CMD050): the owner's session only (sellers_owner_update). */
  async lockSeller(sellerId: SellerId): Promise<SellerRecord | null> {
    const r = await execute<SellerRow>(this.db, `SELECT ${SELLER} FROM kauro.sellers WHERE seller_id = $1 FOR NO KEY UPDATE`, [sellerId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    await holdSalesTransition(this.db, "kauro.sellers", sellerId);
    return sellerRecord(row);
  }

  /**
   * A compare-and-swap of the seller's state along the Seller machine. seller_activated records the agreement, the assessment and the
   * owner's own step-up with the activating person and instant as the database sees them (KC005 repeats every fact); seller_terminated
   * records the server's instant, which must be the recorded termination's (recordTermination, same unit of work).
   */
  async transitionSeller(sellerId: SellerId, expectedVersion: number, change: SellerChange, _now: UtcInstant): Promise<VersionedWrite<SellerRecord>> {
    const params: unknown[] = [sellerId, expectedVersion, change.state];
    const sets = ["version = s.version + 1", "state = $3"];
    if (change.activeAgreementId !== undefined) {
      params.push(change.activeAgreementId);
      sets.push(`agreement_id = $${params.length}`);
    }
    if (change.activationAssessmentId !== undefined || change.activationProofId !== undefined) {
      if (change.activationAssessmentId === undefined || change.activationProofId === undefined || change.state !== "ACTIVE" || change.activeAgreementId === undefined) {
        throw new DomainFailure("INTEGRITY_FAILURE", "an activation names its agreement, its assessment and the owner's step-up together, to ACTIVE");
      }
      params.push(change.activationAssessmentId);
      sets.push(`activation_assessment_id = $${params.length}`);
      params.push(change.activationProofId);
      sets.push(`activation_proof_ref = $${params.length}`, "activated_by_user_id = kauro.current_user_id()", "activated_at = kauro.server_now()");
    }
    if (change.state === "TERMINATED") sets.push("terminated_at = kauro.server_now()");
    const r = await execute<SellerRow>(this.db, `UPDATE kauro.sellers AS s SET ${sets.join(", ")} WHERE s.seller_id = $1 AND s.version = $2 RETURNING ${SELLER}`, params);
    const row = r.rows[0];
    if (row === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.sellers WHERE seller_id = $1", sellerId, "seller");
    return { kind: "APPLIED", record: sellerRecord(row) };
  }

  async getAgreement(agreementId: SellerAgreementId): Promise<SellerAgreementRecord | null> {
    const r = await execute<AgreementRow>(this.db, `SELECT ${AGREEMENT} FROM kauro.seller_agreements WHERE agreement_id = $1`, [agreementId]);
    return r.rows[0] ? agreementRecord(r.rows[0]) : null;
  }

  /** The seller's signed agreement in force at `at` (started, not ended), the latest started one when several are. */
  async agreementInForce(sellerId: SellerId, at: UtcInstant): Promise<SellerAgreementRecord | null> {
    const r = await execute<AgreementRow>(
      this.db,
      `SELECT ${AGREEMENT} FROM kauro.seller_agreements
        WHERE seller_id = $1 AND signed_at IS NOT NULL AND starts_at <= $2::timestamptz AND (ends_at IS NULL OR ends_at > $2::timestamptz)
        ORDER BY starts_at DESC, agreement_id DESC LIMIT 1`,
      [sellerId, at],
    );
    return r.rows[0] ? agreementRecord(r.rows[0]) : null;
  }

  /**
   * Each fact of 17 "Activation prerequisites" as the owner's session reads it (D10-SELL-1, D10-SELL-3): the agreement (the seller's
   * own), the legal review it names, the assessment CMD049 names (or the latest passed one), the latest confidentiality acceptance and
   * tax documentation, the VERIFIED destination, and whether the identity is ACTIVE with a verified e-mail and MFA — read after the
   * identity's transition lock. The database repeats them all at the activation (KC005).
   */
  async activationFacts(sellerId: SellerId, agreementId: SellerAgreementId, assessmentId?: SellerAssessmentId): Promise<SellerActivationFacts> {
    const agreementRow = (await execute<AgreementRow>(this.db, `SELECT ${AGREEMENT} FROM kauro.seller_agreements WHERE agreement_id = $1 AND seller_id = $2`, [agreementId, sellerId])).rows[0];
    const agreement = agreementRow ? agreementRecord(agreementRow) : null;
    const review =
      agreement === null
        ? undefined
        : (
            await execute<{ review_id: string; seller_id: string; classification: SellerClassification; outcome: LegalReviewOutcome; substance_hash: string; reviewer_label: string; evidence_hash: string; reviewed_at: string }>(
              this.db,
              `SELECT review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, ${canonical("reviewed_at")} FROM kauro.seller_legal_reviews WHERE seller_id = $1 AND review_id = $2`,
              [sellerId, agreement.legalReviewId],
            )
          ).rows[0];
    const legalReview: SellerLegalReviewRecord | null =
      review === undefined
        ? null
        : { reviewId: review.review_id as SellerLegalReviewId, sellerId: review.seller_id as SellerId, classification: review.classification, outcome: review.outcome, substanceHash: review.substance_hash, reviewerLabel: review.reviewer_label, evidenceHash: review.evidence_hash, reviewedAt: instantOf(review.reviewed_at) };
    const assessmentRow = (
      await execute<{ assessment_id: string; seller_id: string; outcome: AssessmentOutcome; evidence_hash: string; assessed_at: string }>(
        this.db,
        assessmentId === undefined
          ? `SELECT assessment_id, seller_id, outcome, evidence_hash, ${canonical("assessed_at")} FROM kauro.seller_assessments WHERE seller_id = $1 AND outcome = 'PASSED' ORDER BY assessed_at DESC, assessment_id DESC LIMIT 1`
          : `SELECT assessment_id, seller_id, outcome, evidence_hash, ${canonical("assessed_at")} FROM kauro.seller_assessments WHERE seller_id = $1 AND assessment_id = $2`,
        assessmentId === undefined ? [sellerId] : [sellerId, assessmentId],
      )
    ).rows[0];
    const assessment: SellerAssessmentRecord | null =
      assessmentRow === undefined
        ? null
        : { assessmentId: assessmentRow.assessment_id as SellerAssessmentId, sellerId: assessmentRow.seller_id as SellerId, outcome: assessmentRow.outcome, evidenceHash: assessmentRow.evidence_hash, assessedAt: instantOf(assessmentRow.assessed_at) };
    const acceptanceRow = (
      await execute<{ acceptance_id: string; terms_hash: string; evidence_hash: string; accepted_at: string }>(
        this.db,
        `SELECT acceptance_id, terms_hash, evidence_hash, ${canonical("accepted_at")} FROM kauro.seller_confidentiality_acceptances WHERE seller_id = $1 ORDER BY accepted_at DESC, acceptance_id DESC LIMIT 1`,
        [sellerId],
      )
    ).rows[0];
    const confidentialityAcceptance: SellerConfidentialityAcceptanceRecord | null =
      acceptanceRow === undefined
        ? null
        : { acceptanceId: acceptanceRow.acceptance_id as SellerConfidentialityAcceptanceId, sellerId, termsHash: acceptanceRow.terms_hash, evidenceHash: acceptanceRow.evidence_hash, acceptedAt: instantOf(acceptanceRow.accepted_at) };
    const taxRow = (
      await execute<{ document_id: string; jurisdiction: string; requirements_hash: string; evidence_hash: string; verified_at: string; verified_by_user_id: string }>(
        this.db,
        `SELECT document_id, jurisdiction, requirements_hash, evidence_hash, ${canonical("verified_at")}, verified_by_user_id FROM kauro.seller_tax_documents WHERE seller_id = $1 ORDER BY verified_at DESC, document_id DESC LIMIT 1`,
        [sellerId],
      )
    ).rows[0];
    const taxDocumentation: SellerTaxDocumentationRecord | null =
      taxRow === undefined
        ? null
        : {
            documentationId: taxRow.document_id as SellerTaxDocumentationId,
            sellerId,
            jurisdiction: taxRow.jurisdiction,
            requirementsHash: taxRow.requirements_hash,
            evidenceHash: taxRow.evidence_hash,
            verifiedAt: instantOf(taxRow.verified_at),
            verifiedBy: taxRow.verified_by_user_id as UserId,
          };
    const destinationRow = (await execute<DestinationRow>(this.db, `SELECT ${DESTINATION} FROM kauro.seller_payout_destinations WHERE seller_id = $1 AND state = 'VERIFIED'`, [sellerId])).rows[0];
    const seller = (await execute<{ user_id: string }>(this.db, "SELECT user_id FROM kauro.sellers WHERE seller_id = $1", [sellerId])).rows[0];
    let identityVerifiedWithMfa = false;
    if (seller !== undefined) {
      // an identity change in flight commits before this read, but the read holds nothing to COMMIT: the identity's reader half is held from
      // the write on, by sellers_activation_guard (KC005), so a withdrawal between this read and the write is judged there, and one arriving
      // after the write waits for the activation's COMMIT (0049 identities_assurance_transition_lock; SELLER_IDENT_RACE)
      // A transaction-level wait inside a savepoint (ADV-5): rolling back to it releases the reader half at once, and a cancelled statement
      // aborts the transaction, which releases it too; a session-level lock could outlive both on a pooled connection.
      await execute(this.db, "SAVEPOINT kauro_identity_wait");
      await execute(this.db, "SELECT pg_advisory_xact_lock_shared(kauro.transition_key('kauro.identities', $1))", [seller.user_id]);
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_identity_wait");
      await execute(this.db, "RELEASE SAVEPOINT kauro_identity_wait");
      const identity = await execute<{ verified: boolean }>(
        this.db,
        "SELECT state = 'ACTIVE' AND email_verified_at IS NOT NULL AND mfa_enrolled_at IS NOT NULL AS verified FROM kauro.identities WHERE user_id = $1",
        [seller.user_id],
      );
      identityVerifiedWithMfa = identity.rows[0]?.verified === true;
    }
    return { agreement, legalReview, assessment, confidentialityAcceptance, taxDocumentation, verifiedDestination: destinationRow ? destinationRecord(destinationRow) : null, identityVerifiedWithMfa };
  }

  async getDestination(destinationId: PayoutDestinationId): Promise<PayoutDestinationRecord | null> {
    const r = await execute<DestinationRow>(this.db, `SELECT ${DESTINATION} FROM kauro.seller_payout_destinations WHERE destination_id = $1`, [destinationId]);
    return r.rows[0] ? destinationRecord(r.rows[0]) : null;
  }

  /** The seller's latest destination version that is pending verification or verified (a rejected or superseded one never is). */
  async currentDestination(sellerId: SellerId): Promise<PayoutDestinationRecord | null> {
    // read after the shared half of the seller's transition lock, held to COMMIT: a destination change or verification (0035) is ordered
    // before this read, or after the unit that holds it (D10-GAP-3)
    await awaitSalesTransition(this.db, "kauro.sellers", sellerId);
    const r = await execute<DestinationRow>(
      this.db,
      `SELECT ${DESTINATION} FROM kauro.seller_payout_destinations WHERE seller_id = $1 AND state IN ('PENDING_VERIFICATION', 'VERIFIED') ORDER BY destination_version DESC LIMIT 1`,
      [sellerId],
    );
    return r.rows[0] ? destinationRecord(r.rows[0]) : null;
  }

  // prospects ---------------------------------------------------------------------------------------------------------------------

  /** The session's own source evidence by hash, of either segment (CMD045 accepts no other recorder's: SOURCE_EVIDENCE_INVALID). */
  async sourceEvidence(evidenceHash: Sha256Hex): Promise<ProspectSourceEvidenceRecord | null> {
    const r = await execute<{ evidence_hash: string; seller_id: string | null; recorded_by_user_id: string; source_url_digest: string; observed_on: string; lawful_basis: string; segment: ProspectSegment; recorded_at: string }>(
      this.db,
      `SELECT evidence_hash, seller_id, recorded_by_user_id, source_url_digest, observed_on::text AS observed_on, lawful_basis, segment, ${canonical("created_at", "recorded_at")}
         FROM kauro.prospect_source_evidence WHERE recorded_by_user_id = kauro.current_user_id() AND evidence_hash = $1`,
      [evidenceHash],
    );
    const e = r.rows[0];
    if (e === undefined) return null;
    return defined<ProspectSourceEvidenceRecord>(
      { evidenceHash: e.evidence_hash, recordedByUserId: e.recorded_by_user_id as UserId, sourceUrlDigest: e.source_url_digest, observedOn: e.observed_on, lawfulBasis: e.lawful_basis, segment: e.segment, recordedAt: instantOf(e.recorded_at) },
      { recordedBySellerId: optionalString<SellerId>(e.seller_id) },
    );
  }

  /** The session's own restricted contact (a prospect names only its registrar's contact, prospects_contact_fk): its key, never its details. */
  async getContact(contactRef: ProspectContactRef): Promise<ProspectContactRecord | null> {
    const r = await execute<{ contact_id: string; contact_key: string; recorded_at: string }>(
      this.db,
      `SELECT contact_id, contact_key, ${canonical("created_at", "recorded_at")} FROM kauro.prospect_contacts WHERE contact_id = $1 AND recorded_by_user_id = kauro.current_user_id()`,
      [contactRef],
    );
    const c = r.rows[0];
    return c === undefined ? null : { contactRef: c.contact_id as ProspectContactRef, contactKey: c.contact_key, recordedAt: instantOf(c.recorded_at) };
  }

  /** The first suppression by the organization key, or by the contact key when one is given (KC016 repeats both). */
  async suppressionOf(organizationKey: Sha256Hex, contactKey: Sha256Hex | null): Promise<ProspectSuppressionRecord | null> {
    const r = await execute<{ suppression_id: string; key_kind: SuppressionKeyKind; suppression_key: string; reason: string; evidence_hash: string | null; recorded_at: string }>(
      this.db,
      `SELECT suppression_id, key_kind, suppression_key, reason, evidence_hash, ${canonical("recorded_at")} FROM kauro.prospect_suppressions
        WHERE (key_kind = 'ORGANIZATION' AND suppression_key = $1) OR ($2::text IS NOT NULL AND key_kind = 'CONTACT' AND suppression_key = $2)
        ORDER BY recorded_at, suppression_id LIMIT 1`,
      [organizationKey, contactKey],
    );
    const s = r.rows[0];
    if (s === undefined) return null;
    return defined<ProspectSuppressionRecord>(
      { suppressionId: s.suppression_id as ProspectSuppressionId, keyKind: s.key_kind, key: s.suppression_key, reasonCode: s.reason, recordedAt: instantOf(s.recorded_at) },
      { evidenceHash: optionalString<Sha256Hex>(s.evidence_hash) },
    );
  }

  /** The live prospect of an organization key the session may read (a seller's own; the unique index answers for the others). */
  async liveProspectOf(organizationKey: Sha256Hex): Promise<ProspectRecord | null> {
    const r = await execute<ProspectRow>(this.db, `SELECT ${PROSPECT} FROM kauro.prospects WHERE organization_key = $1 AND state <> 'SUPPRESSED'`, [organizationKey]);
    return r.rows[0] ? prospectRecord(r.rows[0]) : null;
  }

  /**
   * CMD045: the prospect born RESEARCHED at version 1 and the server's instant, registered by the session's person and — registered by a
   * seller — owned by it (prospects_register). A second live prospect of the key is PROSPECT_EXISTS, a suppressed organization or
   * contact PROSPECT_SUPPRESSED (KC016).
   */
  async registerProspect(prospect: NewProspect): Promise<ProspectRecord> {
    const r = await execute<ProspectRow>(
      this.db,
      `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, kauro.server_now(), kauro.server_now())
       RETURNING ${PROSPECT}`,
      [prospect.prospectId, prospect.organizationLabel, prospect.organizationKey, prospect.businessContactRef ?? null, prospect.sourceEvidenceHash, prospect.jurisdiction, prospect.registeredByUserId, prospect.ownerSellerId ?? null],
    );
    return prospectRecord(r.rows[0] as ProspectRow);
  }

  async getProspect(prospectId: ProspectId): Promise<ProspectRecord | null> {
    const r = await execute<ProspectRow>(this.db, `SELECT ${PROSPECT} FROM kauro.prospects WHERE prospect_id = $1`, [prospectId]);
    return r.rows[0] ? prospectRecord(r.rows[0]) : null;
  }

  /**
   * The writer's half of kauro.attribution_claims for the prospect (claims of one prospect serialize, D10-TX-1), then the prospect as
   * the session reads it. The row itself is not locked FOR UPDATE: a seller holds no update policy on prospects, so a locking read
   * would hide its own prospect; nothing a claim writes changes the prospect row.
   */
  async lockProspect(prospectId: ProspectId): Promise<ProspectRecord | null> {
    await holdSalesTransition(this.db, "kauro.attribution_claims", prospectId);
    return this.getProspect(prospectId);
  }

  async prospectsOwnedBy(sellerId: SellerId): Promise<ReadonlyArray<ProspectRecord>> {
    const r = await execute<ProspectRow>(this.db, `SELECT ${PROSPECT} FROM kauro.prospects WHERE owner_seller_id = $1 ORDER BY created_at, prospect_id`, [sellerId]);
    return r.rows.map(prospectRecord);
  }

  /** CMD050: every prospect the seller owns is left unowned, one version each (the owner's session, prospects_owner_update). */
  async unassignProspects(sellerId: SellerId, _now: UtcInstant): Promise<number> {
    const r = await execute(this.db, "UPDATE kauro.prospects SET owner_seller_id = NULL, version = version + 1 WHERE owner_seller_id = $1", [sellerId]);
    return r.rowCount ?? 0;
  }

  // sales accounts and the assignment chain (D10-ASSIGN-1, D10-ASSIGN-2) -------------------------------------------------------------

  async getSalesAccount(agencyId: AgencyId): Promise<SalesAccountRecord | null> {
    const r = await execute<AccountRow>(this.db, `SELECT ${ACCOUNT} FROM kauro.sales_accounts WHERE agency_id = $1`, [agencyId]);
    return r.rows[0] ? accountRecord(r.rows[0]) : null;
  }

  async lockSalesAccount(agencyId: AgencyId): Promise<SalesAccountRecord | null> {
    const r = await execute<AccountRow>(this.db, `SELECT ${ACCOUNT} FROM kauro.sales_accounts WHERE agency_id = $1 FOR UPDATE`, [agencyId]);
    return r.rows[0] ? accountRecord(r.rows[0]) : null;
  }

  async getServiceAssignment(ref: ServiceAssignmentRef): Promise<ServiceAssignmentRecord | null> {
    const r = await execute<{ service_assignment_id: string; agency_id: string; seller_id: string; compensation: ServiceCompensation; assistance_agreement_id: string | null; terms_hash: string; prepared_at: string }>(
      this.db,
      `SELECT service_assignment_id, agency_id, seller_id, compensation, assistance_agreement_id, terms_hash, ${canonical("prepared_at")} FROM kauro.service_assignments WHERE service_assignment_id = $1`,
      [ref],
    );
    const s = r.rows[0];
    if (s === undefined) return null;
    return defined<ServiceAssignmentRecord>(
      { serviceAssignmentRef: s.service_assignment_id as ServiceAssignmentRef, agencyId: s.agency_id as AgencyId, sellerId: s.seller_id as SellerId, compensation: s.compensation, termsHash: s.terms_hash, preparedAt: instantOf(s.prepared_at) },
      { assistanceAgreementId: optionalString<AssistanceAgreementId>(s.assistance_agreement_id) },
    );
  }

  async currentAssignment(agencyId: AgencyId): Promise<AccountAssignmentRecord | null> {
    const r = await execute<LinkRow>(
      this.db,
      `SELECT ${LINK("c")} FROM kauro.sales_accounts s JOIN kauro.account_assignments c ON c.agency_id = s.agency_id AND c.assignment_id = s.current_assignment_id WHERE s.agency_id = $1`,
      [agencyId],
    );
    return r.rows[0] ? linkRecord(r.rows[0]) : null;
  }

  /**
   * CMD048 (D10-ASSIGN-1, D10-ASSIGN-2): under the sales account's row lock, one ASSIGNED link naming the seller and its prepared
   * service assignment, superseding the current link, and the account moved to it with its version bumped — or, with no version
   * expected, the account opened on the agency's first link. A version that is not the account's is STALE with its current version
   * and the reason of its current link; nothing else is touched: no assignment row names an allocation, share, claim or entitlement.
   */
  async assignAccount(assignment: NewAccountAssignment, expectedVersion: number | null, _now: UtcInstant): Promise<VersionedWrite<SalesAccountRecord>> {
    const current = (
      await execute<{ version: string; current_assignment_id: string; reason: AssignmentReason }>(
        this.db,
        `SELECT s.version, s.current_assignment_id, c.reason FROM kauro.sales_accounts s JOIN kauro.account_assignments c ON c.agency_id = s.agency_id AND c.assignment_id = s.current_assignment_id
          WHERE s.agency_id = $1 FOR UPDATE OF s`,
        [assignment.agencyId],
      )
    ).rows[0];
    if (expectedVersion === null) {
      if (current !== undefined) return { kind: "STALE", currentVersion: int(current.version), currentState: current.reason };
      await this.#appendLink({ assignmentId: assignment.assignmentId, agencyId: assignment.agencyId, reason: "ASSIGNED", sellerId: assignment.sellerId, serviceAssignmentRef: assignment.serviceAssignmentRef, supersedes: null });
      const opened = await execute<AccountRow>(
        this.db,
        `INSERT INTO kauro.sales_accounts (agency_id, current_assignment_id, created_at, updated_at) VALUES ($1, $2, kauro.server_now(), kauro.server_now()) RETURNING ${ACCOUNT}`,
        [assignment.agencyId, assignment.assignmentId],
      );
      return { kind: "APPLIED", record: accountRecord(opened.rows[0] as AccountRow) };
    }
    if (current === undefined) throw new DomainFailure("NOT_FOUND", "the agency has no sales account visible in this context");
    if (int(current.version) !== expectedVersion) return { kind: "STALE", currentVersion: int(current.version), currentState: current.reason };
    await this.#appendLink({ assignmentId: assignment.assignmentId, agencyId: assignment.agencyId, reason: "ASSIGNED", sellerId: assignment.sellerId, serviceAssignmentRef: assignment.serviceAssignmentRef, supersedes: current.current_assignment_id });
    const moved = await execute<AccountRow>(
      this.db,
      `UPDATE kauro.sales_accounts SET current_assignment_id = $2, version = version + 1 WHERE agency_id = $1 AND version = $3 RETURNING ${ACCOUNT}`,
      [assignment.agencyId, assignment.assignmentId, expectedVersion],
    );
    return { kind: "APPLIED", record: accountRecord(moved.rows[0] as AccountRow) };
  }

  /**
   * CMD050: under each sales account's row lock, a SELLER_TERMINATED link (nobody) superseding every current link that names the
   * seller, the account moved to it; returns the new links. The seller's earlier links stay in the chain.
   */
  async endAssignmentsOf(sellerId: SellerId, _now: UtcInstant): Promise<ReadonlyArray<AccountAssignmentRecord>> {
    const current = await execute<{ agency_id: string; current_assignment_id: string }>(
      this.db,
      `SELECT s.agency_id, s.current_assignment_id FROM kauro.sales_accounts s JOIN kauro.account_assignments c ON c.agency_id = s.agency_id AND c.assignment_id = s.current_assignment_id
        WHERE c.seller_id = $1 ORDER BY s.agency_id FOR UPDATE OF s`,
      [sellerId],
    );
    const links: AccountAssignmentRecord[] = [];
    for (const account of current.rows) {
      const assignmentId = this.ids.next() as AccountAssignmentId;
      links.push(await this.#appendLink({ assignmentId, agencyId: account.agency_id as AgencyId, reason: "SELLER_TERMINATED", sellerId: null, serviceAssignmentRef: null, supersedes: account.current_assignment_id }));
      await execute(this.db, "UPDATE kauro.sales_accounts SET current_assignment_id = $2, version = version + 1 WHERE agency_id = $1", [account.agency_id, assignmentId]);
    }
    return links;
  }

  async #appendLink(link: {
    readonly assignmentId: AccountAssignmentId;
    readonly agencyId: AgencyId;
    readonly reason: AssignmentReason;
    readonly sellerId: SellerId | null;
    readonly serviceAssignmentRef: ServiceAssignmentRef | null;
    readonly supersedes: string | null;
  }): Promise<AccountAssignmentRecord> {
    const r = await execute<LinkRow>(
      this.db,
      `INSERT INTO kauro.account_assignments AS l (assignment_id, agency_id, seller_id, service_assignment_id, supersedes_assignment_id, reason, effective_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.current_user_id(), kauro.server_now())
       RETURNING ${LINK("l")}`,
      [link.assignmentId, link.agencyId, link.sellerId, link.serviceAssignmentRef, link.supersedes, link.reason],
    );
    return linkRecord(r.rows[0] as LinkRow);
  }

  // assistance agreements (D10-ASSIST-1, D10-ASSIST-2) -----------------------------------------------------------------------------

  async getAssistanceAgreement(id: AssistanceAgreementId): Promise<AssistanceAgreementRecord | null> {
    const r = await execute<AssistanceRow>(this.db, `SELECT ${ASSISTANCE} FROM kauro.assistance_agreements a WHERE a.assistance_agreement_id = $1`, [id]);
    return r.rows[0] ? assistanceRecord(r.rows[0]) : null;
  }

  /**
   * The assistance agreements that apply to the agency's purchase of `projectId` whose order was created at `orderCreatedAt` (R2-099;
   * 17 "prospective project-specific assistance"): signed strictly before that order was created, naming that project or the agency's
   * next purchase, and not yet spent — an agreement applies to the first qualifying purchase ordered after its signing (of its
   * project, or of the agency for NEXT_PURCHASE), one pool per agreement (commission_pools_one_per_assistance). Oldest signing first.
   * An agreement signed after the order was created applies to no pool of that purchase (the ledger repeats it, commission_pools_terms).
   */
  async assistanceAgreementsFor(agencyId: AgencyId, projectId: ProjectId, orderCreatedAt: UtcInstant): Promise<ReadonlyArray<AssistanceAgreementRecord>> {
    const r = await execute<AssistanceRow>(
      this.db,
      `SELECT ${ASSISTANCE} FROM kauro.assistance_agreements a
        WHERE a.agency_id = $1 AND a.signed_at < $3::timestamptz AND (a.scope = 'NEXT_PURCHASE' OR a.project_id = $2)
          AND NOT EXISTS (
            SELECT 1 FROM kauro.qualifying_purchases q
             WHERE q.agency_id = a.agency_id AND q.order_created_at > a.signed_at AND q.order_created_at < $3::timestamptz
               AND (a.scope = 'NEXT_PURCHASE' OR q.project_id = a.project_id))
        ORDER BY a.signed_at, a.assistance_agreement_id`,
      [agencyId, projectId, orderCreatedAt],
    );
    return r.rows.map(assistanceRecord);
  }

  // termination (D10-TERM-1) -----------------------------------------------------------------------------------------------------

  async getTerminationTerms(ref: TerminationTermsRef): Promise<SellerTerminationRecord | null> {
    const r = await execute<TerminationRow>(this.db, `SELECT ${TERMINATION} FROM kauro.seller_terminations WHERE termination_id = $1`, [ref]);
    return r.rows[0] ? terminationRecord(r.rows[0]) : null;
  }

  async getTerminationManifest(ref: TerminationManifestRef): Promise<TerminationManifestRecord | null> {
    const r = await execute<{ manifest_id: string; seller_id: string; claim_ids: string[]; manifest_hash: string; prepared_at: string }>(
      this.db,
      `SELECT manifest_id, seller_id, claim_ids, manifest_hash, ${canonical("prepared_at")} FROM kauro.termination_manifests WHERE manifest_id = $1`,
      [ref],
    );
    const m = r.rows[0];
    if (m === undefined) return null;
    return { manifestRef: m.manifest_id as TerminationManifestRef, sellerId: m.seller_id as SellerId, claimIds: m.claim_ids.map((id) => id as AttributionClaimId), manifestHash: m.manifest_hash, preparedAt: instantOf(m.prepared_at) };
  }

  /**
   * CMD050: the prepared termination made effective at the server's instant by the session's owner with the manifest it enumerated
   * (a compare-and-swap on its version), and one tail entry per listed opportunity ending 2160 hours after that instant. The database
   * refuses an entry that is not an enumerated, ACCEPTED and unexpired claim of the seller whose agency has no qualifying purchase
   * (TAIL_NOT_ENUMERATED, KC011). The seller's own transition to TERMINATED follows in the same unit of work (transitionSeller).
   */
  async recordTermination(termination: NewSellerTermination): Promise<VersionedWrite<SellerTerminationRecord>> {
    const r = await execute<TerminationRow>(
      this.db,
      `UPDATE kauro.seller_terminations SET manifest_id = $3, effective_at = kauro.server_now(), terminated_by_user_id = kauro.current_user_id(), version = version + 1
        WHERE termination_id = $1 AND version = $2 AND effective_at IS NULL
       RETURNING ${TERMINATION}`,
      [termination.terminationId, termination.expectedVersion, termination.manifestRef],
    );
    const row = r.rows[0];
    if (row === undefined) {
      return staleRow(this.db, "SELECT version, CASE WHEN effective_at IS NULL THEN 'PREPARED' ELSE 'EFFECTIVE' END AS state FROM kauro.seller_terminations WHERE termination_id = $1", termination.terminationId, "termination terms");
    }
    for (const entry of termination.tailEntries) {
      if (entry.terminationId !== termination.terminationId || entry.sellerId !== row.seller_id) throw new DomainFailure("INTEGRITY_FAILURE", "a tail entry names its own termination and seller");
      await execute(
        this.db,
        `INSERT INTO kauro.termination_tail_entries (termination_id, claim_id, seller_id, agency_id, effective_at, ends_at, created_at)
         SELECT t.termination_id, $2, t.seller_id, $3, t.effective_at, t.effective_at + interval '2160 hours', kauro.server_now() FROM kauro.seller_terminations t WHERE t.termination_id = $1`,
        [termination.terminationId, entry.claimId, entry.agencyId],
      );
    }
    return { kind: "APPLIED", record: terminationRecord(row) };
  }

  async tailEntriesOf(sellerId: SellerId): Promise<ReadonlyArray<TerminationTailEntryRecord>> {
    const r = await execute<TailRow>(this.db, `SELECT ${TAIL} FROM kauro.termination_tail_entries WHERE seller_id = $1 ORDER BY ends_at, claim_id`, [sellerId]);
    return r.rows.map(tailRecord);
  }

  async tailEntryOfClaim(claimId: AttributionClaimId): Promise<TerminationTailEntryRecord | null> {
    const r = await execute<TailRow>(this.db, `SELECT ${TAIL} FROM kauro.termination_tail_entries WHERE claim_id = $1 ORDER BY ends_at DESC LIMIT 1`, [claimId]);
    return r.rows[0] ? tailRecord(r.rows[0]) : null;
  }
}

// --- the commercial principals (design §2, D10-CTX-1, D10-CTX-2) ------------------------------------------------------------------------

/** @kauro/application SellerPrincipal, structurally. */
export interface SellerPrincipalFacts {
  readonly sellerId: string;
  readonly userId: UserId;
  readonly state: SellerState;
  readonly version: number;
}

/** @kauro/application OwnerGrantPrincipal, structurally. */
export interface OwnerGrantFacts {
  readonly userId: UserId;
  readonly state: "ACTIVE" | "REVOKED";
}

/**
 * The seller row and the corporate KAURO_OWNER grant of an identity, each read after the shared half of its transition lock in the
 * decision's own unit of work (B06 D-TX-2): a suspension, termination or revocation in flight is ordered before or after the decision,
 * never beside it. The api binds @kauro/application's CommercialPrincipalReader to it (commercialPrincipalsOf); nothing is cached.
 */
export class PgCommercialPrincipalReader {
  readonly #sales: PgSalesRepository;

  constructor(
    private readonly db: Queryable,
    ids: IdGenerator,
  ) {
    this.#sales = new PgSalesRepository(db, ids);
  }

  async sellerOf(userId: UserId): Promise<SellerPrincipalFacts | null> {
    const seller = await this.#sales.sellerOfIdentity(userId);
    return seller === null ? null : { sellerId: seller.sellerId, userId: seller.userId, state: seller.state, version: seller.version };
  }

  /** The identity's ACTIVE KAURO_OWNER grant, else its latest revoked one, as the session's own policies show it (corporate_roles). */
  async ownerGrantOf(userId: UserId): Promise<OwnerGrantFacts | null> {
    await awaitSalesTransition(this.db, "kauro.corporate_roles", userId);
    const r = await execute<{ user_id: string; state: "ACTIVE" | "REVOKED" }>(
      this.db,
      "SELECT user_id, state FROM kauro.corporate_roles WHERE user_id = $1 AND role = 'KAURO_OWNER' ORDER BY (state = 'ACTIVE') DESC, granted_at DESC LIMIT 1",
      [userId],
    );
    const g = r.rows[0];
    return g === undefined ? null : { userId: g.user_id as UserId, state: g.state };
  }
}

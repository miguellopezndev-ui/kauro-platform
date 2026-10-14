/**
 * The SQL of package B12's owner tools (lane L-OWNER; plan companion §P; migrations 0029, 0035, 0040 and 0087): the producers of the
 * seller's onboarding records, its agreement, its payout destination, its assignments and termination inputs, the seller's claim
 * evidence and the owner's prepared allocation with its shares. Every statement that writes one of those rows lives here; the handlers
 * (@kauro/application commercial/sellers/owner-tools) take the locks through this adapter, judge, and only then write.
 *
 * Instants: every instant recorded is the database's (kauro.server_now(), written in SQL; commercial-sales-rows). A guard against the
 * clock is judged in SQL (the destination's cooling period, a contact that precedes its record, a claim's acceptance window), never
 * with an instant fed back from JavaScript.
 *
 * Locks (plan §P, D10-TX-1, D10-GAP-20): an owner tool on a seller takes the seller row FOR NO KEY UPDATE and then the writer's half of
 * kauro.sellers, CMD049's and CMD050's order; the seller's own destination change takes only the writer's half (the seller has no UPDATE
 * policy on its row, so a row lock would hide it); the verification takes the seller row, the writer's half, then the destination row
 * FOR NO KEY UPDATE, so a change and a verification of one seller serialize whichever comes first. The claims of a prospect are locked by
 * their subject kauro.attribution_claims (prospect), in ascending prospect order.
 *
 * The control plane (corporate_roles, service_agreement_versions) is written only by kauro_control (0013, 0028 grants and FOR ALL
 * policies): PgControlPlaneRecords runs on a kauro_control connection and has no HTTP route; kauro_app holds SELECT only, so a request
 * session can never reach it.
 *
 * D-33: nothing here reads a segment or a buyer type, and nothing ranks. No CRM is written.
 */
import { createHash } from "node:crypto";
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, type IdGenerator, type UnitOfWork } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { PgCommerceUnitOfWork } from "../unit-of-work.js";
import { canonical, holdSalesTransition, instantOf, optionalInstantOf } from "./commercial-sales-rows.js";

export type OwnerToolSellerState = "CANDIDATE" | "ACTIVE" | "SUSPENDED" | "TERMINATED";

export interface OwnerToolSeller {
  readonly sellerId: string;
  readonly userId: string;
  readonly state: OwnerToolSellerState;
  readonly version: number;
}

export interface OwnerToolAgreement {
  readonly agreementId: string;
  readonly sellerId: string;
  readonly agreementVersion: string;
  readonly signedTermsHash: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly version: number;
  readonly signedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
}

export type PayoutDestinationState = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "SUPERSEDED";

export interface OwnerToolDestination {
  readonly destinationId: string;
  readonly sellerId: string;
  readonly destinationVersion: number;
  readonly version: number;
  readonly state: PayoutDestinationState;
  readonly maskedLabel: string;
  readonly currency: "USD" | "COP";
  readonly changedByUserId: string;
  readonly changeProofCarried: boolean;
  /** The 172 800 s cooling period has passed at this transaction's database instant (Q10-5). */
  readonly coolingPassed: boolean;
  /** A later version of the seller's destination exists. */
  readonly superseded: boolean;
  readonly changedAt: UtcInstant;
  readonly verifiableFrom: UtcInstant;
  readonly verifiedAt?: UtcInstant;
  readonly rejectedAt?: UtcInstant;
}

export interface OwnerToolRecord {
  readonly recordId: string;
  readonly sellerId: string;
  readonly recordedAt: UtcInstant;
}

export interface ShareClaim {
  readonly claimId: string;
  readonly sellerId: string;
  readonly state: string;
  readonly agreementId: string;
  readonly agreementVersion: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  /** The claim's agreement is signed and in force at this transaction's database instant. */
  readonly agreementInForce: boolean;
}

export interface NewAgreement {
  readonly agreementVersion: string;
  readonly legalReviewId: string;
  readonly classification: string;
  readonly startsAt: UtcInstant;
  readonly endsAt: UtcInstant | null;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly offsetTerms: "NONE" | "SIGNED_FUTURE_OFFSET";
  readonly retainerCentsPerMonth: number;
  readonly compensationPolicyVersion: string;
  readonly signedTermsHash: string;
}

export interface NewAllocation {
  readonly prospectId: string;
  readonly agencyId: string;
  readonly identityEvidenceHash: string;
  readonly rulingReason: string;
  readonly rulingEvidenceHash: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly shares: ReadonlyArray<{ readonly claim: ShareClaim; readonly shareBps: number }>;
}

const SELLER = "seller_id, user_id, state, version";
interface SellerRow {
  seller_id: string;
  user_id: string;
  state: OwnerToolSellerState;
  version: string;
}
const sellerOf = (r: SellerRow): OwnerToolSeller => ({ sellerId: r.seller_id, userId: r.user_id, state: r.state, version: int(r.version) });

const AGREEMENT = `agreement_id, seller_id, agreement_version, signed_terms_hash, first_bps, repeat_bps, version, ${canonical("signed_at")}, ${canonical("created_at")}`;
interface AgreementRow {
  agreement_id: string;
  seller_id: string;
  agreement_version: string;
  signed_terms_hash: string;
  first_bps: number;
  repeat_bps: number;
  version: string;
  signed_at: string | null;
  created_at: string;
}
function agreementOf(r: AgreementRow): OwnerToolAgreement {
  const signedAt = optionalInstantOf(r.signed_at);
  return {
    agreementId: r.agreement_id,
    sellerId: r.seller_id,
    agreementVersion: r.agreement_version,
    signedTermsHash: r.signed_terms_hash,
    firstBps: r.first_bps,
    repeatBps: r.repeat_bps,
    version: int(r.version),
    ...(signedAt !== undefined ? { signedAt } : {}),
    createdAt: instantOf(r.created_at),
  };
}

const DESTINATION = (d: string): string =>
  `${d}.destination_id, ${d}.seller_id, ${d}.destination_version, ${d}.version, ${d}.state, ${d}.masked_label, ${d}.currency, ${d}.changed_by_user_id,
   ${d}.change_proof_ref IS NOT NULL AS change_proof_carried, kauro.server_now() >= ${d}.changed_at + interval '172800 seconds' AS cooling_passed,
   EXISTS (SELECT 1 FROM kauro.seller_payout_destinations l WHERE l.seller_id = ${d}.seller_id AND l.destination_version > ${d}.destination_version) AS superseded,
   ${canonical(`${d}.changed_at`)}, ${canonical(`${d}.changed_at + interval '172800 seconds'`, "verifiable_from")}, ${canonical(`${d}.verified_at`)}, ${canonical(`${d}.rejected_at`)}`;
interface DestinationRow {
  destination_id: string;
  seller_id: string;
  destination_version: number;
  version: string;
  state: PayoutDestinationState;
  masked_label: string;
  currency: "USD" | "COP";
  changed_by_user_id: string;
  change_proof_carried: boolean;
  cooling_passed: boolean;
  superseded: boolean;
  changed_at: string;
  verifiable_from: string;
  verified_at: string | null;
  rejected_at: string | null;
}
function destinationOf(r: DestinationRow): OwnerToolDestination {
  const verifiedAt = optionalInstantOf(r.verified_at);
  const rejectedAt = optionalInstantOf(r.rejected_at);
  return {
    destinationId: r.destination_id,
    sellerId: r.seller_id,
    destinationVersion: r.destination_version,
    version: int(r.version),
    state: r.state,
    maskedLabel: r.masked_label,
    currency: r.currency,
    changedByUserId: r.changed_by_user_id,
    changeProofCarried: r.change_proof_carried,
    coolingPassed: r.cooling_passed,
    superseded: r.superseded,
    changedAt: instantOf(r.changed_at),
    verifiableFrom: instantOf(r.verifiable_from),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    ...(rejectedAt !== undefined ? { rejectedAt } : {}),
  };
}

function record(row: { record_id: string; seller_id: string; recorded_at: string } | undefined, what: string): OwnerToolRecord {
  if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `${what} was not recorded`);
  return { recordId: row.record_id, sellerId: row.seller_id, recordedAt: instantOf(row.recorded_at) };
}

/** The digest of a termination manifest: SHA-256 of its claim ids, ascending, one per line. */
export function manifestHashOf(claimIds: ReadonlyArray<string>): string {
  return createHash("sha256").update([...claimIds].sort().join("\n"), "utf8").digest("hex");
}

export class PgOwnerToolStore {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
  ) {}

  // --- locks ----------------------------------------------------------------------------------------------------------------------

  /** The seller row FOR NO KEY UPDATE, then the writer's half of kauro.sellers (CMD049's and CMD050's order): the owner's session only. */
  async lockSeller(sellerId: string): Promise<OwnerToolSeller | null> {
    const r = await execute<SellerRow>(this.db, `SELECT ${SELLER} FROM kauro.sellers WHERE seller_id = $1 FOR NO KEY UPDATE`, [sellerId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    await holdSalesTransition(this.db, "kauro.sellers", sellerId);
    return sellerOf(row);
  }

  /** The seller's own session: the writer's half of kauro.sellers only (no row lock, the seller has no UPDATE policy on its row), then its row. */
  async holdOwnSeller(sellerId: string): Promise<OwnerToolSeller | null> {
    await holdSalesTransition(this.db, "kauro.sellers", sellerId);
    const r = await execute<SellerRow>(this.db, `SELECT ${SELLER} FROM kauro.sellers WHERE seller_id = $1`, [sellerId]);
    return r.rows[0] ? sellerOf(r.rows[0]) : null;
  }

  /** The writer's half of each prospect's claims subject, in ascending prospect order (no deadlock between two multi-prospect writers). */
  async lockProspectClaims(prospectIds: ReadonlyArray<string>): Promise<void> {
    for (const prospectId of [...new Set(prospectIds)].sort()) await holdSalesTransition(this.db, "kauro.attribution_claims", prospectId);
  }

  // --- reads ----------------------------------------------------------------------------------------------------------------------

  async identityExists(userId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.identities WHERE user_id = $1", [userId]);
    return r.rowCount === 1;
  }

  async sellerOfIdentity(userId: string): Promise<string | null> {
    const r = await execute<{ seller_id: string }>(this.db, "SELECT seller_id FROM kauro.sellers WHERE user_id = $1", [userId]);
    return r.rows[0]?.seller_id ?? null;
  }

  async legalReview(sellerId: string, reviewId: string): Promise<{ readonly classification: string; readonly outcome: string } | null> {
    const r = await execute<{ classification: string; outcome: string }>(this.db, "SELECT classification, outcome FROM kauro.seller_legal_reviews WHERE seller_id = $1 AND review_id = $2", [sellerId, reviewId]);
    return r.rows[0] ?? null;
  }

  async agreementVersionTaken(sellerId: string, agreementVersion: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.seller_agreements WHERE seller_id = $1 AND agreement_version = $2", [sellerId, agreementVersion]);
    return r.rowCount === 1;
  }

  /** The agreement row (FOR NO KEY UPDATE when it will be signed). */
  async agreement(agreementId: string, lock: boolean): Promise<OwnerToolAgreement | null> {
    const r = await execute<AgreementRow>(this.db, `SELECT ${AGREEMENT} FROM kauro.seller_agreements WHERE agreement_id = $1${lock ? " FOR NO KEY UPDATE" : ""}`, [agreementId]);
    return r.rows[0] ? agreementOf(r.rows[0]) : null;
  }

  /** The seller's latest destination version, as the session's policies show it. */
  async latestDestination(sellerId: string): Promise<OwnerToolDestination | null> {
    const r = await execute<DestinationRow>(this.db, `SELECT ${DESTINATION("d")} FROM kauro.seller_payout_destinations d WHERE d.seller_id = $1 ORDER BY d.destination_version DESC LIMIT 1`, [sellerId]);
    return r.rows[0] ? destinationOf(r.rows[0]) : null;
  }

  /** The seller of a destination (owner session), before its locks. */
  async sellerOfDestination(destinationId: string): Promise<string | null> {
    const r = await execute<{ seller_id: string }>(this.db, "SELECT seller_id FROM kauro.seller_payout_destinations WHERE destination_id = $1", [destinationId]);
    return r.rows[0]?.seller_id ?? null;
  }

  /** The destination row FOR NO KEY UPDATE (after the seller's locks). */
  async lockDestination(destinationId: string): Promise<OwnerToolDestination | null> {
    const r = await execute<DestinationRow>(this.db, `SELECT ${DESTINATION("d")} FROM kauro.seller_payout_destinations d WHERE d.destination_id = $1 FOR NO KEY UPDATE OF d`, [destinationId]);
    return r.rows[0] ? destinationOf(r.rows[0]) : null;
  }

  async agencyExists(agencyId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.agencies WHERE agency_id = $1", [agencyId]);
    return r.rowCount === 1;
  }

  async assistanceAgreementExists(agencyId: string, assistanceAgreementId: string, sellerId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.assistance_agreements WHERE agency_id = $1 AND assistance_agreement_id = $2 AND seller_id = $3", [agencyId, assistanceAgreementId, sellerId]);
    return r.rowCount === 1;
  }

  async projectOfAgency(agencyId: string, projectId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.projects WHERE agency_id = $1 AND project_id = $2", [agencyId, projectId]);
    return r.rowCount === 1;
  }

  async effectiveTermination(sellerId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.seller_terminations WHERE seller_id = $1 AND effective_at IS NOT NULL", [sellerId]);
    return r.rowCount === 1;
  }

  /** The prospects of the seller's open claims and of the named claims: the claims subjects a manifest locks. */
  async prospectsOfClaims(sellerId: string, claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const r = await execute<{ prospect_id: string }>(
      this.db,
      "SELECT DISTINCT prospect_id FROM kauro.attribution_claims WHERE (seller_id = $1 AND state = 'ACCEPTED') OR claim_id = ANY ($2::uuid[]) ORDER BY prospect_id",
      [sellerId, claimIds],
    );
    return r.rows.map((x) => x.prospect_id);
  }

  /** The seller's ACCEPTED, unexpired claims at this transaction's database instant (read after the claims locks). */
  async acceptedLiveClaims(sellerId: string): Promise<ReadonlyArray<string>> {
    const r = await execute<{ claim_id: string }>(
      this.db,
      "SELECT claim_id FROM kauro.attribution_claims WHERE seller_id = $1 AND state = 'ACCEPTED' AND expires_at > kauro.server_now() ORDER BY claim_id",
      [sellerId],
    );
    return r.rows.map((x) => x.claim_id);
  }

  async prospectExists(prospectId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.prospects WHERE prospect_id = $1", [prospectId]);
    return r.rowCount === 1;
  }

  /** The named claims of the prospect with their agreement's pool terms (read after the prospect's claims lock). */
  async shareClaims(prospectId: string, claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<ShareClaim>> {
    const r = await execute<{ claim_id: string; seller_id: string; state: string; agreement_id: string; agreement_version: string; first_bps: number; repeat_bps: number; in_force: boolean }>(
      this.db,
      `SELECT c.claim_id, c.seller_id, c.state, c.agreement_id, c.agreement_version, g.first_bps, g.repeat_bps,
              (g.signed_at IS NOT NULL AND (g.ends_at IS NULL OR g.ends_at > kauro.server_now())) AS in_force
         FROM kauro.attribution_claims c JOIN kauro.seller_agreements g ON g.seller_id = c.seller_id AND g.agreement_id = c.agreement_id
        WHERE c.prospect_id = $1 AND c.claim_id = ANY ($2::uuid[])`,
      [prospectId, claimIds],
    );
    return r.rows.map((x) => ({ claimId: x.claim_id, sellerId: x.seller_id, state: x.state, agreementId: x.agreement_id, agreementVersion: x.agreement_version, firstBps: x.first_bps, repeatBps: x.repeat_bps, agreementInForce: x.in_force }));
  }

  async frozenAllocationOfAgency(agencyId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.attribution_allocations WHERE agency_id = $1 AND frozen_at IS NOT NULL", [agencyId]);
    return r.rowCount === 1;
  }

  // --- writes ---------------------------------------------------------------------------------------------------------------------

  async registerSeller(userId: string, displayLabel: string): Promise<{ readonly sellerId: string; readonly version: number; readonly createdAt: UtcInstant }> {
    const sellerId = this.ids.next();
    const r = await execute<{ seller_id: string; version: string; created_at: string }>(
      this.db,
      `INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, kauro.current_user_id(), kauro.server_now(), kauro.server_now())
       RETURNING seller_id, version, ${canonical("created_at")}`,
      [sellerId, userId, displayLabel],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the seller was not recorded");
    return { sellerId: row.seller_id, version: int(row.version), createdAt: instantOf(row.created_at) };
  }

  async recordLegalReview(sellerId: string, b: { classification: string; outcome: string; substanceHash: string; reviewerLabel: string; evidenceHash: string; reviewedAt: string }): Promise<OwnerToolRecord> {
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.seller_legal_reviews (review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, reviewed_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, kauro.current_user_id(), kauro.server_now())
       RETURNING review_id AS record_id, seller_id, ${canonical("created_at", "recorded_at")}`,
      [this.ids.next(), sellerId, b.classification, b.outcome, b.substanceHash, b.reviewerLabel, b.evidenceHash, b.reviewedAt],
    );
    return record(r.rows[0], "the legal review");
  }

  async prepareAgreement(sellerId: string, a: NewAgreement): Promise<OwnerToolAgreement> {
    const r = await execute<AgreementRow>(
      this.db,
      `INSERT INTO kauro.seller_agreements (agreement_id, seller_id, agreement_version, classification, legal_review_id, starts_at, ends_at, first_bps, repeat_bps, recurring_months,
                                            offset_terms, retainer_cents_per_month, compensation_policy_version, signed_terms_hash, prepared_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, 12, $10, $11, $12, $13, kauro.current_user_id(), kauro.server_now(), kauro.server_now())
       RETURNING ${AGREEMENT}`,
      [this.ids.next(), sellerId, a.agreementVersion, a.classification, a.legalReviewId, a.startsAt, a.endsAt, a.firstBps, a.repeatBps, a.offsetTerms, a.retainerCentsPerMonth, a.compensationPolicyVersion, a.signedTermsHash],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the agreement was not recorded");
    return agreementOf(row);
  }

  /** The signature, once, by compare-and-swap on the version read (null when the version moved). */
  async signAgreement(agreementId: string, expectedVersion: number, signatureEvidenceHash: string): Promise<OwnerToolAgreement | null> {
    const r = await execute<AgreementRow>(
      this.db,
      `UPDATE kauro.seller_agreements SET signed_at = kauro.server_now(), signature_evidence_hash = $3, version = version + 1
        WHERE agreement_id = $1 AND version = $2 AND signed_at IS NULL
       RETURNING ${AGREEMENT}`,
      [agreementId, expectedVersion, signatureEvidenceHash],
    );
    return r.rows[0] ? agreementOf(r.rows[0]) : null;
  }

  async recordAssessment(sellerId: string, b: { outcome: string; evidenceHash: string; assessedAt: string }): Promise<OwnerToolRecord> {
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.seller_assessments (assessment_id, seller_id, outcome, evidence_hash, assessed_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, kauro.current_user_id(), kauro.server_now())
       RETURNING assessment_id AS record_id, seller_id, ${canonical("created_at", "recorded_at")}`,
      [this.ids.next(), sellerId, b.outcome, b.evidenceHash, b.assessedAt],
    );
    return record(r.rows[0], "the assessment");
  }

  async recordConfidentialityAcceptance(sellerId: string, b: { termsHash: string; evidenceHash: string; acceptedAt: string }): Promise<OwnerToolRecord> {
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.seller_confidentiality_acceptances (acceptance_id, seller_id, terms_hash, evidence_hash, accepted_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, kauro.current_user_id(), kauro.server_now())
       RETURNING acceptance_id AS record_id, seller_id, ${canonical("created_at", "recorded_at")}`,
      [this.ids.next(), sellerId, b.termsHash, b.evidenceHash, b.acceptedAt],
    );
    return record(r.rows[0], "the confidentiality acceptance");
  }

  /** Content-addressed: the same (seller, jurisdiction, requirements, evidence) answers the row already recorded. */
  async recordTaxDocument(sellerId: string, b: { jurisdiction: string; requirementsHash: string; evidenceHash: string }): Promise<OwnerToolRecord> {
    const existing = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `SELECT document_id AS record_id, seller_id, ${canonical("created_at", "recorded_at")} FROM kauro.seller_tax_documents
        WHERE seller_id = $1 AND jurisdiction = $2 AND requirements_hash = $3 AND evidence_hash = $4 ORDER BY created_at LIMIT 1`,
      [sellerId, b.jurisdiction, b.requirementsHash, b.evidenceHash],
    );
    if (existing.rows[0] !== undefined) return record(existing.rows[0], "the tax document");
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.seller_tax_documents (document_id, seller_id, jurisdiction, requirements_hash, evidence_hash, verified_at, verified_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, kauro.server_now(), kauro.current_user_id(), kauro.server_now())
       RETURNING document_id AS record_id, seller_id, ${canonical("created_at", "recorded_at")}`,
      [this.ids.next(), sellerId, b.jurisdiction, b.requirementsHash, b.evidenceHash],
    );
    return record(r.rows[0], "the tax document");
  }

  /** The seller's own change: version + 1 of its destination, PENDING_VERIFICATION, with its own step-up, at the database's instant. */
  async changeDestination(sellerId: string, destinationVersion: number, b: { maskedLabel: string; destinationDigest: string; currency: string; proofId: string }): Promise<OwnerToolDestination> {
    const destinationId = this.ids.next();
    await execute(
      this.db,
      `INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.current_user_id(), $7, kauro.server_now(), kauro.server_now(), kauro.server_now())`,
      [destinationId, sellerId, destinationVersion, b.maskedLabel, b.destinationDigest, b.currency, b.proofId],
    );
    const r = await execute<DestinationRow>(this.db, `SELECT ${DESTINATION("d")} FROM kauro.seller_payout_destinations d WHERE d.destination_id = $1`, [destinationId]);
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the destination change was not recorded");
    return destinationOf(row);
  }

  /**
   * The owner's verification, after the seller's and the destination's locks: the seller's previous VERIFIED version SUPERSEDED, its older
   * PENDING versions REJECTED, then this version VERIFIED with the owner's own step-up (0087), all at the database's instant. Null when the
   * compare-and-swap missed.
   */
  async verifyDestination(destination: OwnerToolDestination, expectedVersion: number, proofId: string): Promise<OwnerToolDestination | null> {
    await execute(
      this.db,
      "UPDATE kauro.seller_payout_destinations SET state = 'SUPERSEDED', superseded_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1 AND state = 'VERIFIED' AND destination_version < $2",
      [destination.sellerId, destination.destinationVersion],
    );
    await execute(
      this.db,
      "UPDATE kauro.seller_payout_destinations SET state = 'REJECTED', rejected_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1 AND state = 'PENDING_VERIFICATION' AND destination_version < $2",
      [destination.sellerId, destination.destinationVersion],
    );
    const r = await execute(
      this.db,
      `UPDATE kauro.seller_payout_destinations
          SET state = 'VERIFIED', verified_by_user_id = kauro.current_user_id(), verified_at = kauro.server_now(), verification_proof_ref = $3, version = version + 1
        WHERE destination_id = $1 AND version = $2 AND state = 'PENDING_VERIFICATION'`,
      [destination.destinationId, expectedVersion, proofId],
    );
    if (r.rowCount !== 1) return null;
    return this.lockDestination(destination.destinationId);
  }

  /** The owner's rejection, by compare-and-swap (null when it missed). */
  async rejectDestination(destinationId: string, expectedVersion: number): Promise<OwnerToolDestination | null> {
    const r = await execute(
      this.db,
      "UPDATE kauro.seller_payout_destinations SET state = 'REJECTED', rejected_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1 AND version = $2 AND state = 'PENDING_VERIFICATION'",
      [destinationId, expectedVersion],
    );
    if (r.rowCount !== 1) return null;
    return this.lockDestination(destinationId);
  }

  async prepareServiceAssignment(sellerId: string, b: { agencyId: string; compensation: string; assistanceAgreementId: string | null; termsHash: string }): Promise<OwnerToolRecord> {
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.service_assignments (service_assignment_id, agency_id, seller_id, compensation, assistance_agreement_id, terms_hash, prepared_by_user_id, prepared_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.current_user_id(), kauro.server_now(), kauro.server_now())
       RETURNING service_assignment_id AS record_id, seller_id, ${canonical("prepared_at", "recorded_at")}`,
      [this.ids.next(), b.agencyId, sellerId, b.compensation, b.assistanceAgreementId, b.termsHash],
    );
    return record(r.rows[0], "the service assignment");
  }

  async recordAssistanceAgreement(sellerId: string, b: { agencyId: string; agreement: OwnerToolAgreement; scope: string; projectId: string | null; rateBps: number; termsHash: string }): Promise<OwnerToolRecord> {
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.assistance_agreements (assistance_agreement_id, agency_id, seller_id, agreement_id, agreement_version, scope, project_id, rate_bps, terms_hash, signed_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, kauro.server_now(), kauro.current_user_id(), kauro.server_now())
       RETURNING assistance_agreement_id AS record_id, seller_id, ${canonical("signed_at", "recorded_at")}`,
      [this.ids.next(), b.agencyId, sellerId, b.agreement.agreementId, b.agreement.agreementVersion, b.scope, b.projectId, b.rateBps, b.termsHash],
    );
    return record(r.rows[0], "the assistance agreement");
  }

  async prepareTerminationTerms(sellerId: string, termsHash: string): Promise<OwnerToolRecord> {
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.seller_terminations (termination_id, seller_id, terms_hash, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, kauro.current_user_id(), kauro.server_now(), kauro.server_now(), kauro.server_now())
       RETURNING termination_id AS record_id, seller_id, ${canonical("prepared_at", "recorded_at")}`,
      [this.ids.next(), sellerId, termsHash],
    );
    return record(r.rows[0], "the termination terms");
  }

  async prepareTerminationManifest(sellerId: string, claimIds: ReadonlyArray<string>): Promise<OwnerToolRecord> {
    const sorted = [...claimIds].sort();
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.termination_manifests (manifest_id, seller_id, claim_ids, manifest_hash, prepared_by_user_id, prepared_at, created_at)
       VALUES ($1, $2, $3::uuid[], $4, kauro.current_user_id(), kauro.server_now(), kauro.server_now())
       RETURNING manifest_id AS record_id, seller_id, ${canonical("prepared_at", "recorded_at")}`,
      [this.ids.next(), sellerId, sorted, manifestHashOf(sorted)],
    );
    return record(r.rows[0], "the termination manifest");
  }

  /**
   * The ACTIVE seller's evidence on a prospect (claim_evidence_seller_record), at the database's instant; refused (null) when the first
   * meaningful contact is after it (17: backdated notes create no entitlement). The same evidence of the same seller and prospect answers
   * the row already recorded; the same evidence on another prospect is refused (null).
   */
  async recordClaimEvidence(sellerId: string, prospectId: string, b: { evidenceHash: string; sourceChannel: string; firstMeaningfulContactAt: string; qualifiedNeedHash: string; activityKinds: ReadonlyArray<string> }): Promise<OwnerToolRecord | null> {
    const existing = await execute<{ record_id: string; seller_id: string; prospect_id: string; recorded_at: string }>(
      this.db,
      `SELECT evidence_id AS record_id, seller_id, prospect_id, ${canonical("recorded_at")} FROM kauro.claim_evidence WHERE seller_id = $1 AND evidence_hash = $2`,
      [sellerId, b.evidenceHash],
    );
    const found = existing.rows[0];
    if (found !== undefined) return found.prospect_id === prospectId ? record(found, "the claim evidence") : null;
    const r = await execute<{ record_id: string; seller_id: string; recorded_at: string }>(
      this.db,
      `INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at)
       SELECT $1, $2, $3, $4, $5, $6::timestamptz, $7, $8::text[], kauro.server_now(), kauro.server_now()
        WHERE $6::timestamptz <= kauro.server_now()
       RETURNING evidence_id AS record_id, seller_id, ${canonical("recorded_at")}`,
      [this.ids.next(), sellerId, prospectId, b.evidenceHash, b.sourceChannel, b.firstMeaningfulContactAt, b.qualifiedNeedHash, [...new Set(b.activityKinds)].sort()],
    );
    return r.rows[0] === undefined ? null : record(r.rows[0], "the claim evidence");
  }

  /** The owner's prepared ruling and its shares (CMD047 freezes it; the shares' sum is judged again at the freeze, KC003). */
  async prepareAllocation(a: NewAllocation): Promise<{ readonly allocationId: string; readonly version: number; readonly preparedAt: UtcInstant }> {
    const allocationId = this.ids.next();
    const r = await execute<{ allocation_id: string; version: string; prepared_at: string }>(
      this.db,
      `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 12, kauro.current_user_id(), kauro.server_now(), kauro.server_now(), kauro.server_now())
       RETURNING allocation_id, version, ${canonical("prepared_at")}`,
      [allocationId, a.agencyId, a.prospectId, a.identityEvidenceHash, a.rulingReason, a.rulingEvidenceHash, a.firstBps, a.repeatBps],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the allocation was not recorded");
    for (const s of a.shares) {
      await execute(
        this.db,
        `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 12, kauro.server_now())`,
        [allocationId, s.claim.sellerId, s.claim.claimId, a.prospectId, s.claim.agreementId, s.claim.agreementVersion, s.shareBps, a.firstBps, a.repeatBps],
      );
    }
    return { allocationId: row.allocation_id, version: int(row.version), preparedAt: instantOf(row.prepared_at) };
  }
}

const bound = new WeakMap<PgCommerceUnitOfWork, PgOwnerToolStore>();

/** The owner tools' store of a commerce unit of work of this package (commercial-sales-access's pattern: one per unit of work, a foreign unit of work refused). */
export function ownerToolsOf(uow: UnitOfWork): PgOwnerToolStore {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the owner tools are run in a commerce unit of work of @kauro/persistence");
  let store = bound.get(uow);
  if (store === undefined) {
    store = new PgOwnerToolStore((uow as unknown as { readonly client: Queryable }).client, uow.ids);
    bound.set(uow, store);
  }
  return store;
}

/**
 * The control-plane records no request session reaches: the corporate owner grant (0013 corporate_roles) and the published versions of
 * the service agreement (0028 service_agreement_versions). It runs on a kauro_control connection: the grants of those tables admit no
 * other writer, so the database, not this class, is the guard. Each method is one statement, at the database's instant.
 */
export class PgControlPlaneRecords {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
  ) {}

  async grantOwnerRole(userId: string, evidenceHash: string): Promise<string> {
    const grantId = this.ids.next();
    await execute(
      this.db,
      "INSERT INTO kauro.corporate_roles (grant_id, user_id, role, evidence_hash, granted_at, created_at, updated_at) VALUES ($1, $2, 'KAURO_OWNER', $3, kauro.server_now(), kauro.server_now(), kauro.server_now())",
      [grantId, userId, evidenceHash],
    );
    return grantId;
  }

  /** Revokes the identity's ACTIVE grant (its transition lock is taken by 0013's trigger); false when none was ACTIVE. */
  async revokeOwnerRole(userId: string): Promise<boolean> {
    const r = await execute(this.db, "UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = kauro.server_now() WHERE user_id = $1 AND role = 'KAURO_OWNER' AND state = 'ACTIVE'", [userId]);
    return r.rowCount === 1;
  }

  /** Publishes a version of the terms or the privacy notice, retiring the published one first (one PUBLISHED per kind). */
  async publishAgreementVersion(kind: "TERMS" | "PRIVACY", version: string, documentHash: string): Promise<void> {
    await execute(this.db, "UPDATE kauro.service_agreement_versions SET state = 'RETIRED', retired_at = kauro.server_now() WHERE agreement_kind = $1 AND state = 'PUBLISHED'", [kind]);
    await execute(
      this.db,
      "INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ($1, $2, $3, kauro.server_now(), kauro.server_now(), kauro.server_now())",
      [kind, version, documentHash],
    );
  }
}

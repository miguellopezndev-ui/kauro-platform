/**
 * Commercial ports (package B10; docs/design/B10-commercial-domain.md §11): the domain repositories of migrations 0028–0031 and the
 * commercial unit of work. They extend B09's commerce ports, never fork them: a CommercialUnitOfWork IS a CommerceUnitOfWork (the
 * same transaction on the same connection, the same context binding, event publisher, command journal and security events), with
 * the commercial repositories on that connection and one more capability — adopting an agency from a durable work item
 * (`adoptAgency`, SERVICE only; D10-CTX-1).
 *
 * The persistence mandates implement them (B10-ADAPTERS-RECURRENCE: recurrence, founding and the unit of work; B10-AGENCY-LIFECYCLE:
 * the agency lifecycle; B10-ADAPTERS-SALES: sales and attribution; B10-ADAPTERS-LEDGER: the ledger and statements), each reached
 * through an accessor over the unit of work until the stage-2 integrator binds them into one factory (D10-STAGE-1).
 *
 * The B06 and B09 conventions hold: a read returns null for a row the policies hide; versioned writes are compare-and-swap and
 * answer STALE with the current safe version and state (B06 D-VER-1); a read of a fact a command relies on without changing it
 * happens after that fact's transition lock (B06 D-TX-2), in the global order of §10 (D10-TX-1); a lock method waits for a
 * concurrent writer, as `pg_stat_activity` shows; money crosses as `bigint` minor units; every instant is `kauro.server_now()`.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyRecord, ServiceMode } from "../model/aggregates.js";
import type { AgencyId, ApprovalId, AssuranceProofId, EventId, JournalEntryId, MembershipId, PlanId, ProjectId, UserId } from "../model/ids.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { CaptureId, EligibilitySnapshotId, FiscalIssuerRef, FiscalProfileId, FundsState, QuoteId, TaxRuleSnapshot } from "../commerce/records.js";
import type { CommerceUnitOfWork, CommerceUnitOfWorkFactory } from "./commerce.js";
import type { VersionedWrite } from "./repositories.js";
import type { UnitOfWorkOptions } from "./unit-of-work.js";
import type {
  AccountAssignmentId,
  AccountAssignmentRecord,
  AdjustmentReason,
  AgencyClosureId,
  AgencyClosureRecord,
  AgencyRecurrenceRecord,
  ClosureFromState,
  CommissionOffsetRecord,
  CommissionRateKind,
  CompletionSource,
  AgreementAcceptanceId,
  AgreementAcceptanceRecord,
  AssistanceAgreementId,
  AssistanceAgreementRecord,
  AttributionAllocationId,
  AttributionAllocationRecord,
  AttributionClaimId,
  AttributionClaimRecord,
  AttributionClaimState,
  BankingCalendarRecord,
  BankingCalendarVersionId,
  BuyerType,
  CalendarSource,
  CaptureFundsObservationRecord,
  ClaimEvidenceRecord,
  ClosureObligations,
  CommissionAdjustmentRecord,
  CommissionEntitlementId,
  CommissionEntitlementRecord,
  CommissionEntitlementState,
  CommissionHoldId,
  CommissionHoldRecord,
  CommissionHoldState,
  CommissionLineId,
  CommissionLineRecord,
  CommissionLineState,
  CommissionPeriodId,
  CommissionPeriodRecord,
  CommissionPoolId,
  CommissionPoolRecord,
  CommissionSource,
  CommissionStatementId,
  CommissionStatementRecord,
  CommissionStatementState,
  CompensationGuardReviewRecord,
  CompletionKind,
  EligibilityFinding,
  FoundingOfferView,
  FoundingReservationId,
  FoundingReservationRecord,
  FoundingSlotRecord,
  HoldReason,
  PayoutDestinationId,
  PayoutDestinationRecord,
  PayoutIntentId,
  PayoutIntentRecord,
  PayoutIntentState,
  PayoutReconciliationRecord,
  ProspectContactRecord,
  ProspectContactRef,
  ProspectId,
  ProspectRecord,
  ProspectSourceEvidenceRecord,
  ProspectSuppressionRecord,
  PurchaseCompletionRecord,
  QualifyingPurchaseId,
  QualifyingPurchaseRecord,
  QuoteIssuance,
  QuoteIssuanceRecord,
  RelationshipDecisionRecord,
  SalesAccountRecord,
  SellerActivationFacts,
  SellerAgreementId,
  SellerAgreementRecord,
  SellerId,
  SellerRecord,
  SellerState,
  SellerTerminationRecord,
  ServiceAgreementKind,
  ServiceAgreementVersionRecord,
  ServiceAssignmentRecord,
  ServiceAssignmentRef,
  StatementItemRecord,
  TerminationManifestRecord,
  TerminationManifestRef,
  TerminationTailEntryRecord,
  TerminationTermsRef,
} from "../commercial/records.js";

// --- recurrence and quote issuance (§3; B10-ADAPTERS-RECURRENCE) -------------------------------------------------------------------

/**
 * What CMD027's handler hands the issuance core after its own checks and the shared halves of agency, capability, approval, source
 * revision, target contract and fiscal profile (§3.4). The core takes the rest of the lock order itself.
 */
export interface QuoteIssuanceRequest {
  readonly journalEntryId: JournalEntryId;
  readonly quoteId: QuoteId;
  readonly snapshotId: EligibilitySnapshotId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly pricePolicyVersion: string;
  readonly fiscalProfileId: FiscalProfileId;
  readonly issuerRef: FiscalIssuerRef;
  readonly tax: TaxRuleSnapshot;
  readonly termsVersion: string;
  /** The agency's recorded buyer type (BuyerTypeReader, read in this unit of work); founding eligibility needs one (D10-FOUND-3). */
  readonly buyerType: BuyerType;
  /** B07's effective deadline of the sealed revision (SourceAvailabilityReader, D10-SRC-1); the quote promises the earlier of it and its expiry. */
  readonly sourceDeadline: UtcInstant;
  readonly createdByMembershipId: MembershipId;
  readonly issuedAt: UtcInstant;
}

export interface RecurrenceRepository {
  /**
   * Takes the shared half of the transition subject `kauro.agency_recurrence` (agency) and reads the recurrence row, null before the
   * agency's first qualifying purchase (D10-REC-2): a designation, refund completion or reversal committing meanwhile is wholly seen
   * or wholly not.
   */
  lockShared(agencyId: AgencyId): Promise<AgencyRecurrenceRecord | null>;
  get(agencyId: AgencyId): Promise<AgencyRecurrenceRecord | null>;
  /** `kauro.qualifying_projects_at(agency, as_of, project)`, the one definition (D10-REC-1), ascending project ids. */
  qualifyingProjectsAt(agencyId: AgencyId, asOf: UtcInstant, projectId: ProjectId): Promise<ReadonlyArray<ProjectId>>;
  getPurchase(purchaseId: QualifyingPurchaseId): Promise<QualifyingPurchaseRecord | null>;
  purchaseOfCapture(captureId: CaptureId): Promise<QualifyingPurchaseRecord | null>;
  /** The agency's qualifying purchases by confirmation sequence. */
  purchasesOf(agencyId: AgencyId): Promise<ReadonlyArray<QualifyingPurchaseRecord>>;
  /**
   * The CMD027 issuance core, one call in the lock order of §3.4 and §10: the project's live quote FOR UPDATE, the recurrence lock's
   * shared half, the snapshot's INSERT … SELECT of `kauro.qualifying_projects_at` with its count and tier, the founding slot taken in
   * ascending order when the agency is eligible (FoundingRepository.reserve), the price over B09's quote model and money kernel, the
   * quote DRAFT → ISSUED with its KAURO_QUOTE_TERMS_V1 terms hash, the previous unpaid quote SUPERSEDED with its reservation
   * released, and `quote_issuances` naming the journal entry, the quote and the reservation (D10-QUOTE-1). The caller publishes
   * quote.drafted.v1, quote.issued.v1 and quote.superseded.v1.
   */
  issueQuote(request: QuoteIssuanceRequest): Promise<QuoteIssuance>;
  /** The issuance a journal entry recorded (resume after a lost response or a crash, D10-QUOTE-4). */
  issuanceOfEntry(journalEntryId: JournalEntryId): Promise<QuoteIssuanceRecord | null>;
  /** Records the issuance of a replacement quote issued through B09's QuoteRepository (the included replacement, §3.5). */
  recordIssuance(issuance: QuoteIssuanceRecord): Promise<QuoteIssuanceRecord>;
  /**
   * The COMMISSIONS consumer's mirror of sequence 1 into `agencies.first_qualifying_capture_id` (D10-FIRST-2): agency row first,
   * version bumped, set once; `mirrored` is false when it was already set (the caller then publishes nothing).
   */
  mirrorFirstDesignation(agencyId: AgencyId, now: UtcInstant): Promise<{ readonly mirrored: boolean; readonly agency: AgencyRecord }>;
  /** `kauro.eligibility_findings()` (D10-REC-3). */
  eligibilityFindings(): Promise<ReadonlyArray<EligibilityFinding>>;
}

export interface NewFoundingReservation {
  readonly reservationId: FoundingReservationId;
  readonly policyVersion: string;
  readonly agencyId: AgencyId;
  readonly quoteId: QuoteId;
  /** The quote's expiry: the reservation's end, never extended (D10-FOUND-3). */
  readonly endsAt: UtcInstant;
  readonly createdAt: UtcInstant;
}

export interface FoundingRepository {
  /** The cohort's reservable slots, with no agency data and reserving nothing (FoundingOfferReader; R2-091, R2-127). */
  offer(policyVersion: string): Promise<FoundingOfferView>;
  slots(policyVersion: string): Promise<ReadonlyArray<FoundingSlotRecord>>;
  getReservation(reservationId: FoundingReservationId): Promise<FoundingReservationRecord | null>;
  lockReservation(reservationId: FoundingReservationId): Promise<FoundingReservationRecord | null>;
  reservationOfQuote(quoteId: QuoteId): Promise<FoundingReservationRecord | null>;
  /** The agency's one reservation of the cohort, in any state (one per agency per cohort, ever; D10-FOUND-1). */
  reservationOfAgency(policyVersion: string, agencyId: AgencyId): Promise<FoundingReservationRecord | null>;
  /**
   * Takes the first free slot in ascending order (`UPDATE founding_slots … WHERE slot_no = $n AND NOT held`): a contender for the
   * same row waits for the first transaction, re-checks and moves to the next slot or to none (D10-FOUND-2). Null when none is free.
   */
  reserve(reservation: NewFoundingReservation): Promise<FoundingReservationRecord | null>;
  /** RESERVED or RECONCILIATION_HOLD → RELEASED with the slot freed; refused KC014 unless the quote is EXPIRED, SUPERSEDED or WITHDRAWN. */
  release(reservationId: FoundingReservationId, expectedVersion: number, now: UtcInstant): Promise<VersionedWrite<FoundingReservationRecord>>;
  /** RESERVED → RECONCILIATION_HOLD: the reservation ended while its quote has a payment in flight (D10-FOUND-4; R2-127). */
  holdForReconciliation(reservationId: FoundingReservationId, expectedVersion: number, now: UtcInstant): Promise<VersionedWrite<FoundingReservationRecord>>;
  /** The QUOTE_EXPIRY sweep's work: live reservations whose end has passed, oldest first. */
  endedReservations(now: UtcInstant, limit: number): Promise<ReadonlyArray<FoundingReservationRecord>>;
}

// --- agency lifecycle (§4; B10-AGENCY-LIFECYCLE) -------------------------------------------------------------------------------

export interface NewAgreementAcceptance {
  readonly acceptanceId: AgreementAcceptanceId;
  readonly agencyId: AgencyId;
  readonly membershipId: MembershipId;
  readonly terms: ServiceAgreementVersionRecord;
  readonly privacy: ServiceAgreementVersionRecord;
  readonly legalProfileRef: string;
  readonly acceptedAt: UtcInstant;
}

export interface NewAgencyClosure {
  readonly closureId: AgencyClosureId;
  readonly agencyId: AgencyId;
  readonly membershipId: MembershipId;
  readonly assuranceProofId: AssuranceProofId;
  /** The state the agency leaves for CLOSING (read after its row lock). */
  readonly fromState: ClosureFromState;
  readonly obligations: ClosureObligations;
  readonly withdrawnQuoteIds: ReadonlyArray<QuoteId>;
  readonly deletionScheduledAt: UtcInstant;
  readonly requestedAt: UtcInstant;
}

export interface AgencyLifecycleRepository {
  /** The PUBLISHED version of a kind, read after its shared lock; null for any other version (no default; D10-AGY-1). */
  publishedVersion(kind: ServiceAgreementKind, version: string): Promise<ServiceAgreementVersionRecord | null>;
  /** Appends an acceptance (append-only; the database checks the accepting OWNER membership and the published versions). */
  recordAcceptance(acceptance: NewAgreementAcceptance): Promise<AgreementAcceptanceRecord>;
  acceptancesOf(agencyId: AgencyId): Promise<ReadonlyArray<AgreementAcceptanceRecord>>;
  /** The obligations inventory of a closure, read after the agency's row lock and exclusive half (D10-AGY-2, D10-AGY-4). */
  closureObligations(agencyId: AgencyId): Promise<ClosureObligations>;
  recordClosure(closure: NewAgencyClosure): Promise<AgencyClosureRecord>;
  closureOf(agencyId: AgencyId): Promise<AgencyClosureRecord | null>;
  /** Appends a reviewed relationship decision; it merges no dataset, membership, designation or attribution (R2-141). */
  recordRelationshipDecision(decision: RelationshipDecisionRecord): Promise<RelationshipDecisionRecord>;
  relationshipDecisionsOf(agencyId: AgencyId): Promise<ReadonlyArray<RelationshipDecisionRecord>>;
}

// --- sales: sellers, prospects, accounts, termination (§5; B10-ADAPTERS-SALES) -------------------------------------------------------

export interface SellerChange {
  readonly state: SellerState;
  readonly activeAgreementId?: SellerAgreementId;
}

export interface NewProspect {
  readonly prospectId: ProspectId;
  readonly organizationLabel: string;
  readonly organizationKey: Sha256Hex;
  readonly businessContactRef?: ProspectContactRef;
  readonly sourceEvidenceHash: Sha256Hex;
  readonly jurisdiction: string;
  /** The registering seller, who owns it; absent when the owner registers. */
  readonly ownerSellerId?: SellerId;
  readonly registeredByUserId: UserId;
  readonly createdAt: UtcInstant;
}

/** An ASSIGNED link appended to the agency's assignment chain (D10-ASSIGN-2): the seller under its prepared service assignment. */
export interface NewAccountAssignment {
  readonly assignmentId: AccountAssignmentId;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly serviceAssignmentRef: ServiceAssignmentRef;
  readonly effectiveAt: UtcInstant;
}

/** CMD050's completion of the prepared termination (seller_terminations, CAS on its version) with its tail entries. */
export interface NewSellerTermination {
  /** The prepared terms (CMD050 terminationTermsRef). */
  readonly terminationId: TerminationTermsRef;
  readonly expectedVersion: number;
  readonly manifestRef: TerminationManifestRef;
  readonly effectiveAt: UtcInstant;
  /** One entry per listed accepted, unexpired claim whose agency has no qualifying purchase (KC011), ending effectiveAt + 2160 h. */
  readonly tailEntries: ReadonlyArray<TerminationTailEntryRecord>;
}

export interface SalesRepository {
  /** The caller's own seller row (`kauro.current_seller_id()`; D10-CTX-2), after its transition lock, or null. */
  sellerOfIdentity(userId: UserId): Promise<SellerRecord | null>;
  getSeller(sellerId: SellerId): Promise<SellerRecord | null>;
  /** The seller row FOR UPDATE with the exclusive half of `kauro.sellers` (CMD049, CMD050). */
  lockSeller(sellerId: SellerId): Promise<SellerRecord | null>;
  transitionSeller(sellerId: SellerId, expectedVersion: number, change: SellerChange, now: UtcInstant): Promise<VersionedWrite<SellerRecord>>;
  getAgreement(agreementId: SellerAgreementId): Promise<SellerAgreementRecord | null>;
  /** The seller's agreement in force at `at` (claims cite its version; entitlements bind it). */
  agreementInForce(sellerId: SellerId, at: UtcInstant): Promise<SellerAgreementRecord | null>;
  /** The CMD049 prerequisites the database repeats (KC005), read after the seller's lock. */
  activationFacts(sellerId: SellerId, agreementId: SellerAgreementId): Promise<SellerActivationFacts>;
  getDestination(destinationId: PayoutDestinationId): Promise<PayoutDestinationRecord | null>;
  /** The seller's latest destination version (PENDING_VERIFICATION or VERIFIED), or null. */
  currentDestination(sellerId: SellerId): Promise<PayoutDestinationRecord | null>;

  /** The caller's own evidence by hash (a seller's, or the owner's), or null (CMD045 SOURCE_EVIDENCE_INVALID). */
  sourceEvidence(evidenceHash: Sha256Hex): Promise<ProspectSourceEvidenceRecord | null>;
  getContact(contactRef: ProspectContactRef): Promise<ProspectContactRecord | null>;
  /** A suppression matching the organization key or the contact key, or null (KC016). */
  suppressionOf(organizationKey: Sha256Hex, contactKey: Sha256Hex | null): Promise<ProspectSuppressionRecord | null>;
  /** The live prospect of an organization key (prospects_one_live_per_organization), or null. */
  liveProspectOf(organizationKey: Sha256Hex): Promise<ProspectRecord | null>;
  /** Inserts RESEARCHED at version 1; a second live prospect of the key fails the unique index (PROSPECT_EXISTS). */
  registerProspect(prospect: NewProspect): Promise<ProspectRecord>;
  getProspect(prospectId: ProspectId): Promise<ProspectRecord | null>;
  /** The prospect row FOR UPDATE with the exclusive half of `kauro.attribution_claims` (claims of one prospect serialize). */
  lockProspect(prospectId: ProspectId): Promise<ProspectRecord | null>;
  prospectsOwnedBy(sellerId: SellerId): Promise<ReadonlyArray<ProspectRecord>>;
  /** CMD050: every prospect the seller owns becomes unassigned; returns how many. */
  unassignProspects(sellerId: SellerId, now: UtcInstant): Promise<number>;

  getSalesAccount(agencyId: AgencyId): Promise<SalesAccountRecord | null>;
  /** The sales account FOR UPDATE (CMD048), or null while the agency has none: its first assignment opens it (D10-ASSIGN-2). */
  lockSalesAccount(agencyId: AgencyId): Promise<SalesAccountRecord | null>;
  getServiceAssignment(ref: ServiceAssignmentRef): Promise<ServiceAssignmentRecord | null>;
  /** The last link of the agency's assignment chain (the one its sales account names), or null. */
  currentAssignment(agencyId: AgencyId): Promise<AccountAssignmentRecord | null>;
  /**
   * Appends an ASSIGNED link superseding the current one and moves the sales account to it, bumping its version (CAS; D10-ASSIGN-1,
   * D10-ASSIGN-2); `expectedVersion` null opens the account with the agency's first link.
   */
  assignAccount(assignment: NewAccountAssignment, expectedVersion: number | null, now: UtcInstant): Promise<VersionedWrite<SalesAccountRecord>>;
  /** CMD050: appends a SELLER_TERMINATED link after each current link naming the seller and moves those accounts to it; returns the new links. */
  endAssignmentsOf(sellerId: SellerId, now: UtcInstant): Promise<ReadonlyArray<AccountAssignmentRecord>>;
  getAssistanceAgreement(id: AssistanceAgreementId): Promise<AssistanceAgreementRecord | null>;
  /** The assistance agreements of the agency signed before `orderCreatedAt` that cover `projectId` or its next purchase (R2-099). */
  assistanceAgreementsFor(agencyId: AgencyId, projectId: ProjectId, orderCreatedAt: UtcInstant): Promise<ReadonlyArray<AssistanceAgreementRecord>>;

  /** The prepared termination terms (a seller_terminations row, effective or not), or null. */
  getTerminationTerms(ref: TerminationTermsRef): Promise<SellerTerminationRecord | null>;
  getTerminationManifest(ref: TerminationManifestRef): Promise<TerminationManifestRecord | null>;
  /** Makes the prepared termination effective and records its tail entries (the database refuses an unenumerable entry, KC011). */
  recordTermination(termination: NewSellerTermination): Promise<VersionedWrite<SellerTerminationRecord>>;
  tailEntriesOf(sellerId: SellerId): Promise<ReadonlyArray<TerminationTailEntryRecord>>;
  /** The tail entry of a claim, if its seller was terminated with it listed. */
  tailEntryOfClaim(claimId: AttributionClaimId): Promise<TerminationTailEntryRecord | null>;
}

// --- attribution: claims, allocations, entitlements (§5; B10-ADAPTERS-SALES) -----------------------------------------------------

export interface NewAttributionClaim {
  readonly claimId: AttributionClaimId;
  readonly prospectId: ProspectId;
  readonly sellerId: SellerId;
  /** The seller's agreement in force, whose version the claim cites. */
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly evidenceHash: Sha256Hex;
  /** SUBMITTED, or DISPUTED when a conflict was found in the same transaction (D10-CLAIM-1). */
  readonly state: "SUBMITTED" | "DISPUTED";
  /** The conflict a DISPUTED claim was born with (a token). */
  readonly conflictReason?: string;
  readonly submittedAt: UtcInstant;
  /** submittedAt + 2160 h. */
  readonly reviewDeadlineAt: UtcInstant;
}

/** What makes a new claim DISPUTED (CMD046 conflict review), read after the prospect's claims lock. */
export interface ClaimConflicts {
  readonly acceptedClaimOnOrganization: boolean;
  readonly otherSellersLiveClaim: boolean;
  /** The prospect is linked to an agency with a payment order or a qualifying purchase. */
  readonly customerHistory: boolean;
}

export interface ClaimChange {
  readonly state: AttributionClaimState;
  /** The ruling of an acceptance or rejection (CMD047): the agency the prospect is and the allocation that decided it. */
  readonly agencyId?: AgencyId;
  readonly allocationId?: AttributionAllocationId;
  readonly acceptedAt?: UtcInstant;
  readonly expiresAt?: UtcInstant;
}

/**
 * An entitlement to create (D10-ATTR-2, D10-ASSIST-2): ACQUISITION with its allocation, claim, first capture and window; ASSISTANCE
 * with its assistance agreement only, at 10 000 bps.
 */
export interface NewCommissionEntitlement {
  readonly entitlementId: CommissionEntitlementId;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly source: CommissionSource;
  readonly allocationId?: AttributionAllocationId;
  readonly claimId?: AttributionClaimId;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly firstCaptureId?: CaptureId;
  readonly windowStartsAt?: UtcInstant;
  /** Twelve calendar months later at the same America/Bogota wall time (commercial recurrenceWindowEndsAt); the database checks it. */
  readonly windowEndsAt?: UtcInstant;
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly shareBps: number;
  readonly createdAt: UtcInstant;
}

export interface AttributionRepository {
  /** The caller's own claim evidence of a prospect by hash, or null. */
  claimEvidence(evidenceHash: Sha256Hex): Promise<ClaimEvidenceRecord | null>;
  claimConflicts(prospectId: ProspectId, sellerId: SellerId): Promise<ClaimConflicts>;
  /** Inserts the claim; a second live claim of the seller on the prospect fails attribution_claims_one_live_per_seller (CLAIM_EXISTS). */
  submitClaim(claim: NewAttributionClaim): Promise<AttributionClaimRecord>;
  getClaim(claimId: AttributionClaimId): Promise<AttributionClaimRecord | null>;
  /** The claim FOR UPDATE, after its prospect's claims lock (CMD047, CMD050). */
  lockClaim(claimId: AttributionClaimId): Promise<AttributionClaimRecord | null>;
  claimsOfProspect(prospectId: ProspectId): Promise<ReadonlyArray<AttributionClaimRecord>>;
  /** The seller's open claims (SUBMITTED, DISPUTED, ACCEPTED): CMD050 expires the unlisted ones. */
  openClaimsOf(sellerId: SellerId): Promise<ReadonlyArray<AttributionClaimRecord>>;
  transitionClaim(claimId: AttributionClaimId, expectedVersion: number, change: ClaimChange, now: UtcInstant): Promise<VersionedWrite<AttributionClaimRecord>>;
  /** The CLAIM_WINDOWS sweep's work: live claims past their review deadline, acceptance window or tail. */
  lapsedClaims(now: UtcInstant, limit: number): Promise<ReadonlyArray<AttributionClaimRecord>>;

  getAllocation(allocationId: AttributionAllocationId): Promise<AttributionAllocationRecord | null>;
  /** The agency's frozen allocation (one per agency; ATTRIBUTION_EXISTS), or null. */
  frozenAllocationOf(agencyId: AgencyId): Promise<AttributionAllocationRecord | null>;
  /** Freezes a prepared allocation once; its shares sum to 10 000 bps at COMMIT (KC003). */
  freezeAllocation(allocationId: AttributionAllocationId, now: UtcInstant): Promise<AttributionAllocationRecord>;

  /** Creates an entitlement once per (allocation or assistance agreement, seller); `created` is false for the existing one. */
  createEntitlement(entitlement: NewCommissionEntitlement): Promise<{ readonly created: boolean; readonly record: CommissionEntitlementRecord }>;
  getEntitlement(entitlementId: CommissionEntitlementId): Promise<CommissionEntitlementRecord | null>;
  entitlementsOfAgency(agencyId: AgencyId): Promise<ReadonlyArray<CommissionEntitlementRecord>>;
  entitlementsOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionEntitlementRecord>>;
  transitionEntitlement(entitlementId: CommissionEntitlementId, expectedVersion: number, state: CommissionEntitlementState, now: UtcInstant): Promise<VersionedWrite<CommissionEntitlementRecord>>;
  /** The ENTITLEMENT_WINDOWS sweep's work: live entitlements whose window has ended. */
  endedEntitlements(now: UtcInstant, limit: number): Promise<ReadonlyArray<CommissionEntitlementRecord>>;
}

// --- the commission ledger (§6; B10-ADAPTERS-LEDGER) ---------------------------------------------------------------------------

export interface NewPurchaseCompletion {
  readonly completionId: PurchaseCompletionRecord["completionId"];
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly kind: CompletionKind;
  /** The stage a STAGE completion completes (required for STAGE, absent for FINAL; purchase_completions_stage). */
  readonly stageRef?: string;
  readonly completedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly source: CompletionSource;
  readonly recordedAt: UtcInstant;
}

/** One beneficiary line of a new pool, born ACCRUED_PENDING (or HELD with a reason: the birth walks ACCRUED_PENDING → HELD). */
export interface NewCommissionLine {
  readonly lineId: CommissionLineId;
  readonly entitlementId: CommissionEntitlementId;
  readonly sellerId: SellerId;
  readonly shareBps: number;
  /** The allocation of the pool to this beneficiary (commercial allocatePool). */
  readonly cumulativeEntitlementCents: bigint;
  readonly heldReason?: HoldReason;
  readonly reviewAt?: UtcInstant;
}

export interface NewCommissionPool {
  readonly poolId: CommissionPoolId;
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly captureId: CaptureId;
  readonly source: CommissionSource;
  /** FIRST for the sticky first designation, REPEAT inside the window, ASSISTANCE for an assistance pool (commercial acquisitionRate). */
  readonly rateKind: CommissionRateKind;
  readonly allocationId?: AttributionAllocationId;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly basisCents: bigint;
  readonly rateBps: number;
  /** round_half_up_bps(basis, rate) once; the lines' allocations sum to it (KC002). */
  readonly poolCents: bigint;
  readonly policyVersion: string;
  readonly lines: ReadonlyArray<NewCommissionLine>;
  readonly createdAt: UtcInstant;
}

/** One adjustment to append (commercial recomputePool's LineAdjustment with its identity and source). */
export interface NewCommissionAdjustment {
  readonly adjustmentId: CommissionAdjustmentRecord["adjustmentId"];
  readonly commissionLineId: CommissionLineId;
  readonly reason: AdjustmentReason;
  readonly signedCents: bigint;
  readonly newCumulativeEntitlementCents: bigint;
  readonly sourceEventId: EventId;
  readonly agreementVersion: string;
  readonly createdAt: UtcInstant;
}

export interface CommissionLineChange {
  readonly state: CommissionLineState;
  readonly eligibleAt?: UtcInstant;
  readonly heldReason?: HoldReason;
  readonly reviewAt?: UtcInstant;
  readonly paidCents?: bigint;
}

export interface NewCommissionHold {
  readonly holdId: CommissionHoldId;
  readonly lineId: CommissionLineId;
  readonly amountCents: bigint;
  readonly reason: HoldReason;
  readonly reviewAt: UtcInstant;
  readonly openedAt: UtcInstant;
}

export interface CommissionLedgerRepository {
  /** Records a completion once — one FINAL per purchase, one STAGE per purchase and stage; `recorded` is false for the existing one. */
  recordCompletion(completion: NewPurchaseCompletion): Promise<{ readonly recorded: boolean; readonly record: PurchaseCompletionRecord }>;
  completionsOf(purchaseId: QualifyingPurchaseId): Promise<ReadonlyArray<PurchaseCompletionRecord>>;
  /** Records a funds observation of a capture (capture.funds_observed.v1), once per source event and capture version. */
  recordFundsObservation(observation: CaptureFundsObservationRecord): Promise<{ readonly recorded: boolean; readonly record: CaptureFundsObservationRecord }>;
  /** The capture's latest observed funds state (UNKNOWN when none). */
  fundsStateOf(captureId: CaptureId): Promise<FundsState>;
  /** Accrues a pool with its lines once per (purchase, source); `created` is false for the existing pool (a replay accrues nothing). */
  accrue(pool: NewCommissionPool): Promise<{ readonly created: boolean; readonly pool: CommissionPoolRecord; readonly lines: ReadonlyArray<CommissionLineRecord> }>;
  poolsOfPurchase(purchaseId: QualifyingPurchaseId): Promise<ReadonlyArray<CommissionPoolRecord>>;
  /** The pools of a capture FOR UPDATE, with their lines, before a basis change (commercial recomputePool). */
  lockPoolsOfCapture(captureId: CaptureId): Promise<ReadonlyArray<{ readonly pool: CommissionPoolRecord; readonly lines: ReadonlyArray<CommissionLineRecord> }>>;
  /**
   * Applies one basis change to a pool: its new basis and cents, one adjustment per changed line UNIQUE (line, source event) — a
   * replay appends nothing (`applied` false) — and each changed line's new cumulative; the database checks the cumulative
   * difference (KC015) and the pool's sums (KC002). The caller moves lines to VOID or ADJUSTED through transitionLine.
   */
  applyBasisChange(poolId: CommissionPoolId, basisCents: bigint, poolCents: bigint, adjustments: ReadonlyArray<NewCommissionAdjustment>): Promise<{ readonly applied: boolean; readonly adjustments: ReadonlyArray<CommissionAdjustmentRecord> }>;
  getLine(lineId: CommissionLineId): Promise<CommissionLineRecord | null>;
  lockLine(lineId: CommissionLineId): Promise<CommissionLineRecord | null>;
  linesOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionLineRecord>>;
  transitionLine(lineId: CommissionLineId, expectedVersion: number, change: CommissionLineChange, now: UtcInstant): Promise<VersionedWrite<CommissionLineRecord>>;
  adjustmentsOfLine(lineId: CommissionLineId): Promise<ReadonlyArray<CommissionAdjustmentRecord>>;
  /** Opens a hold of at most the line's unpaid cents with its reason and review date (D10-HOLD-1). */
  openHold(hold: NewCommissionHold): Promise<CommissionHoldRecord>;
  resolveHold(holdId: CommissionHoldId, expectedVersion: number, state: Exclude<CommissionHoldState, "OPEN">, now: UtcInstant): Promise<VersionedWrite<CommissionHoldRecord>>;
  holdsOfLine(lineId: CommissionLineId): Promise<ReadonlyArray<CommissionHoldRecord>>;
  /** The ELIGIBILITY sweep's work: ACCRUED_PENDING and HELD lines whose purchase has a FINAL completion due at `now`. */
  linesDueForEligibility(now: UtcInstant, limit: number): Promise<ReadonlyArray<CommissionLineRecord>>;
  /** The ACCRUAL_RECONCILIATION sweep's work: purchases lacking the pool of an applicable entitlement. */
  purchasesLackingPools(limit: number): Promise<ReadonlyArray<QualifyingPurchaseRecord>>;
  /**
   * Offsets a negative position against a later unpaid line of the same seller (commission_offsets; D10-NEG-2): refused KC017 without
   * the SIGNED_FUTURE_OFFSET terms of the negative line's agreement, and never beyond either amount.
   */
  recordOffset(offset: CommissionOffsetRecord): Promise<CommissionOffsetRecord>;
  offsetsOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionOffsetRecord>>;
}

// --- periods, statements and payouts (§7; B10-ADAPTERS-LEDGER) --------------------------------------------------------------------

/** What a period close reads at its cutoff: the included rows and the COMMISSIONS records still undelivered before it. */
export interface PeriodInputs {
  readonly lines: ReadonlyArray<CommissionLineRecord>;
  readonly adjustments: ReadonlyArray<CommissionAdjustmentRecord>;
  readonly holds: ReadonlyArray<CommissionHoldRecord>;
  /** COMMISSIONS outbox records with occurred_at before the cutoff not yet delivered (CMD051 INPUTS_UNRECONCILED). */
  readonly undeliveredBeforeCutoff: number;
}

export interface NewCommissionStatement {
  readonly statement: Omit<CommissionStatementRecord, "state" | "version" | "payoutEvidenceHash">;
  readonly items: ReadonlyArray<StatementItemRecord>;
}

export interface StatementChange {
  readonly state: CommissionStatementState;
  readonly payoutEvidenceHash?: Sha256Hex;
}

export interface NewPayoutIntent {
  readonly intent: Omit<PayoutIntentRecord, "state" | "version">;
}

/** The cash CMD052 needs (D10-PAY-1): bank-available cash of the latest settlement with bank evidence, and what intents already claim. */
export interface PayoutCash {
  readonly bankAvailableCents: bigint;
  readonly unsettledAuthorizedCents: bigint;
}

export interface StatementRepository {
  /** The latest recorded calendar version of a jurisdiction and source (RecordedBankingCalendarSource reads VERIFIED_FEED). */
  latestCalendar(jurisdiction: "CO", source: CalendarSource): Promise<BankingCalendarRecord | null>;
  getCalendar(calendarVersionId: BankingCalendarVersionId): Promise<BankingCalendarRecord | null>;
  recordCalendar(calendar: BankingCalendarRecord): Promise<BankingCalendarRecord>;
  getPeriod(periodId: CommissionPeriodId): Promise<CommissionPeriodRecord | null>;
  /** The period FOR UPDATE (CMD051: a close and an adjustment serialize on it). */
  lockPeriod(periodId: CommissionPeriodId): Promise<CommissionPeriodRecord | null>;
  periodOfMonth(month: string): Promise<CommissionPeriodRecord | null>;
  /** Opens a month's period once (the PERIODS sweep), dated or not; `created` is false for the existing one. */
  openPeriod(period: Omit<CommissionPeriodRecord, "state" | "version" | "cutoffHash" | "closedAt">): Promise<{ readonly created: boolean; readonly record: CommissionPeriodRecord }>;
  /**
   * Dates an undated period once with a recorded calendar version and the close and pay dates it gives (commercial
   * commissionPeriodOf; the database checks them against kauro.banking_day_after over the version's coverage).
   */
  datePeriod(periodId: CommissionPeriodId, expectedVersion: number, dates: { readonly calendarVersionId: BankingCalendarVersionId; readonly calendarSource: CalendarSource; readonly closeDueOn: string; readonly payDueOn: string }, now: UtcInstant): Promise<VersionedWrite<CommissionPeriodRecord>>;
  periodInputs(periodId: CommissionPeriodId, cutoffAt: UtcInstant): Promise<PeriodInputs>;
  /** OPEN → CLOSED with the ledger cutoff hash it closed on (CMD051; the period must be dated). */
  closePeriod(periodId: CommissionPeriodId, expectedVersion: number, cutoffHash: Sha256Hex, now: UtcInstant): Promise<VersionedWrite<CommissionPeriodRecord>>;
  /** Issues a statement with its items, DRAFT → ISSUED in one transaction; one per period and seller (the replayed row otherwise). */
  issueStatement(statement: NewCommissionStatement): Promise<{ readonly issued: boolean; readonly record: CommissionStatementRecord }>;
  getStatement(statementId: CommissionStatementId): Promise<CommissionStatementRecord | null>;
  /** The statement FOR UPDATE (CMD052, CMD053: approvals and settlements of one statement serialize). */
  lockStatement(statementId: CommissionStatementId): Promise<CommissionStatementRecord | null>;
  statementsOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionStatementRecord>>;
  itemsOf(statementId: CommissionStatementId): Promise<ReadonlyArray<StatementItemRecord>>;
  transitionStatement(statementId: CommissionStatementId, expectedVersion: number, change: StatementChange, now: UtcInstant): Promise<VersionedWrite<CommissionStatementRecord>>;
  payoutCash(): Promise<PayoutCash>;
  /** Authorizes one intent of exactly the payable (payout_intents_one_live_per_statement; KC009 for an unverified payee). */
  authorizeIntent(intent: NewPayoutIntent): Promise<{ readonly authorized: boolean; readonly record: PayoutIntentRecord }>;
  getIntent(intentId: PayoutIntentId): Promise<PayoutIntentRecord | null>;
  liveIntentOf(statementId: CommissionStatementId): Promise<PayoutIntentRecord | null>;
  transitionIntent(intentId: PayoutIntentId, expectedVersion: number, state: PayoutIntentState, now: UtcInstant): Promise<VersionedWrite<PayoutIntentRecord>>;
  recordReconciliation(reconciliation: PayoutReconciliationRecord): Promise<PayoutReconciliationRecord>;
  reconciliationsOf(intentId: PayoutIntentId): Promise<ReadonlyArray<PayoutReconciliationRecord>>;
  recordGuardReview(review: CompensationGuardReviewRecord): Promise<CompensationGuardReviewRecord>;
  guardReviewsOf(periodId: CommissionPeriodId): Promise<ReadonlyArray<CompensationGuardReviewRecord>>;
}

// --- the commercial unit of work ---------------------------------------------------------------------------------------------

export interface CommercialRepositories {
  readonly recurrence: RecurrenceRepository;
  readonly founding: FoundingRepository;
  readonly agencyLifecycle: AgencyLifecycleRepository;
  readonly sales: SalesRepository;
  readonly attribution: AttributionRepository;
  readonly ledger: CommissionLedgerRepository;
  readonly statements: StatementRepository;
}

export interface CommercialUnitOfWork extends CommerceUnitOfWork {
  readonly commercial: CommercialRepositories;
  /**
   * SERVICE contexts only (commission-service, finance-service on `kauro_commission`), at most once per unit of work and never after
   * adoptScope: binds the agency of a durable work item — an event's agency, a reservation's — so the agency-scoped B10 rows of that
   * agency pass their policies (D10-CTX-1). Never an agency a request names. Any other use is INTEGRITY_FAILURE.
   */
  adoptAgency(agencyId: AgencyId): Promise<void>;
}

export interface CommercialUnitOfWorkFactory extends CommerceUnitOfWorkFactory {
  run<T>(context: ExecutionContext, work: (uow: CommercialUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}


/**
 * What the bank-transfer route's commands and reads run on (lane L-ROUTE; docs/design/ACH-ROUTE.md r12 §7.1-§7.3): the route tables of the
 * caller's commerce unit of work (the persistence adapter's PgBankRoutes, bound by the api composition), the unit's effect instant, the
 * restricted evidence store (late-bound: a deployment before the route's adapter binds none and every route command answers
 * CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE), the account-details classifier of the bound integration, the B06 step-up verifier and the
 * provider-call bound the store read runs under.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { BankRouteDetails, BankRouteRecord, BankRouteVersionRecord, BankTransferInstructionRecord, CommerceUnitOfWork, EvidenceClassification } from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { ProviderCallTimer } from "../../commercial/ports.js";
import type { BankEvidenceStore, DestinationFingerprinter, StoredBankEvidence } from "../ports.js";
import type { DestinationFingerprintRecord, IncomingCredit } from "@kauro/domain";

export interface NewBankRouteInput {
  readonly routeId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly provider: string;
  readonly integrationClass: "PROVIDER" | "CONTRACT_FAKE";
  readonly paymentRouteId: string;
  readonly createdBy: string;
}

export interface NewBankRouteVersionInput {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly detailsArtifactRef: string;
  readonly detailsEvidenceHash: string;
  readonly payeeDigest: string | null;
  readonly acceptedRails: ReadonlyArray<string>;
  readonly minimumTransferWindowMs: number;
  readonly instructionLifetimeMs: number;
  readonly providerTimeToleranceMs: number;
  readonly feePolicyVersion: string;
  readonly timingSourceUrl: string;
  readonly timingSourceAccessedOn: string;
  readonly createdBy: string;
}

export interface NewTransferInstructionsInput {
  readonly orderId: string;
  readonly agencyId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly transferExpiresAt: UtcInstant;
  readonly sendBy: UtcInstant;
  readonly issuedAt: UtcInstant;
}

/** The route tables in the caller's unit of work (persistence PgBankRoutes). */
export interface BankRouteRepository {
  read(routeId: string): Promise<BankRouteRecord | null>;
  lockForUpdate(routeId: string): Promise<BankRouteRecord | null>;
  lockShare(routeId: string): Promise<BankRouteRecord | null>;
  findByAccount(environment: string, accountRef: string): Promise<BankRouteRecord | null>;
  version(routeId: string, routeVersion: number): Promise<BankRouteVersionRecord | null>;
  registerPaymentRoute(input: { readonly paymentRouteId: string; readonly provider: string; readonly environment: string; readonly merchantRef: string; readonly payeeDigest: string; readonly integrationClass: string }): Promise<void>;
  insertRoute(route: NewBankRouteInput): Promise<BankRouteRecord>;
  insertVersion(v: NewBankRouteVersionInput): Promise<void>;
  update(routeId: string, expectedVersion: number, to: { readonly state: BankRouteRecord["state"]; readonly rollout: BankRouteRecord["rollout"]; readonly currentVersion: number; readonly participantsVersion?: number }): Promise<BankRouteRecord>;
  /** Marks the version verified with the validity of the details evidence the verify classified (set once, with the verification). */
  markVerified(routeId: string, routeVersion: number, evidenceRef: string, userId: string, at: UtcInstant, detailsValidUntil: UtcInstant): Promise<void>;
  appendParticipants(routeId: string, setVersion: number, agencyIds: ReadonlyArray<string>): Promise<void>;
  isParticipant(route: Pick<BankRouteRecord, "routeId" | "participantsVersion">, agencyId: string): Promise<boolean>;
  /** The issuance's project lock (FOR NO KEY UPDATE), taken before the purchased subject's shared halves; false: not visible. */
  lockProject(agencyId: string, projectId: string): Promise<boolean>;
  /** Runs `work` under a savepoint rolled back once it settled: every lock it took is released, nothing it wrote survives. */
  released<T>(work: () => Promise<T>): Promise<T>;
  insertInstructions(i: NewTransferInstructionsInput): Promise<BankTransferInstructionRecord | null>;
  instructionsOf(orderId: string): Promise<BankTransferInstructionRecord | null>;
}

/** Classifies an owner-supplied account-details artifact (R1): pure, fail-closed, never a partial value. */
export interface BankDetailsClassifier {
  classifyAccountDetails(evidence: StoredBankEvidence): EvidenceClassification<BankRouteDetails>;
}

// --- the manual-assisted refunds of the route (lane L-REFUND; ACH-ROUTE r12 §7.13-§7.22, D-24 A) ------------------------------------------

/** The corporate owner's authority as kauro.bank_owner_authority judged it at the database clock (OK records this transaction's act). */
export interface OwnerAuthorityVerdict {
  readonly verdict: "OK" | "IDENTITY_DISABLED" | "CORPORATE_ROLE_MISSING" | "STEP_UP_MISSING" | "STEP_UP_NOT_OWNED" | "STEP_UP_STALE";
  readonly issuedAt: UtcInstant | null;
  readonly expiresAt: UtcInstant | null;
}

/** A treasury refund of an unassigned credit (route scope, agency NULL; excess-only: one amount). */
export interface TreasuryRefundRecord {
  readonly treasuryRefundId: string;
  readonly routeId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly bankCreditId: string;
  readonly amountCents: bigint;
  readonly state: "REQUESTED" | "APPROVED" | "SUBMITTING" | "UNCERTAIN" | "COMPLETED" | "FAILED" | "REJECTED";
  readonly version: number;
  readonly approvedByUserId: string | null;
  readonly approvedAt: UtcInstant | null;
}

export interface NewRefundDestinationInput {
  readonly destinationId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly agencyId: string | null;
  readonly refundId: string | null;
  readonly treasuryRefundId: string | null;
  readonly evidenceArtifactRef: string;
  readonly evidenceHash: string;
  readonly fingerprint: DestinationFingerprintRecord["fingerprint"];
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  readonly accountLast4: string;
  readonly holderName: string;
  readonly capturedBy: string;
}

export interface CapturedDestination {
  readonly destinationId: string;
  readonly fingerprint: DestinationFingerprintRecord["fingerprint"];
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  readonly accountLast4: string;
}

/** The refund tables in the caller's SERVICE unit of work (persistence PgBankRefunds). */
export interface BankRefundRepository {
  lockOutboundStream(environment: string, accountRef: string): Promise<void>;
  ownerAuthority(userId: string, proofId: string | null, freshnessSeconds: number): Promise<OwnerAuthorityVerdict>;
  treasuryRefund(treasuryRefundId: string): Promise<TreasuryRefundRecord | null>;
  lockTreasuryRefund(treasuryRefundId: string): Promise<TreasuryRefundRecord | null>;
  approveTreasuryRefund(
    treasuryRefundId: string,
    expectedVersion: number,
    approval: { readonly approvedByUserId: string; readonly authorizationProofRef: string; readonly authorizationHash: DestinationFingerprintRecord["fingerprint"]; readonly approvedAt: UtcInstant },
  ): Promise<TreasuryRefundRecord | null>;
  destinationOf(sourceKind: "CAPTURE" | "BANK_CREDIT", id: string): Promise<CapturedDestination | null>;
  insertDestination(d: NewRefundDestinationInput): Promise<void>;
}

/** Classifies a stored credit artifact (the payer evidence a destination is proven by): pure, fail-closed. */
export interface BankCreditClassifier {
  classifyCredit(evidence: StoredBankEvidence): EvidenceClassification<IncomingCredit>;
}

export interface BankRouteCollaborators {
  readonly routes: (uow: CommerceUnitOfWork) => BankRouteRepository;
  /** The unit's effect instant, read after the caller's locks (kauro.effect_now()). */
  readonly effectNow: (uow: CommerceUnitOfWork) => Promise<UtcInstant>;
  /** The restricted evidence store, read at call time (null: none bound). */
  readonly evidence: () => BankEvidenceStore | null;
  /** The bound integration's classifier (null: none bound). */
  readonly classifier: () => BankDetailsClassifier | null;
  readonly assurance: AssuranceVerifier;
  readonly timer: ProviderCallTimer;
  readonly random: (n: number) => Uint8Array;
  /** Lane L-REFUND: the refund tables of the caller's unit of work (absent: every owner refund command answers CAPACITY_UNAVAILABLE). */
  readonly refunds?: (uow: CommerceUnitOfWork) => BankRefundRepository;
  /** The destination fingerprinter (DV1-10, DV1-11), read at call time (null: none bound, CAPACITY_UNAVAILABLE). */
  readonly fingerprinter?: () => DestinationFingerprinter | null;
  /** The bound integration's credit classifier for the payer evidence a destination is proven by (null: none bound). */
  readonly creditClassifier?: () => BankCreditClassifier | null;
  /** The payment service's verified identity the owner refund commands run their SERVICE units under (kauro_payment). */
  readonly paymentServiceId?: string;
  /** A named point an owner refund command passes after its evidence read and before its unit (test harness: a cell pauses there). */
  readonly hold?: (point: string) => Promise<void>;
}

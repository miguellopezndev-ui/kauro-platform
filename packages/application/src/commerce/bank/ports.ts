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
import type { BankEvidenceStore, StoredBankEvidence } from "../ports.js";

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
}

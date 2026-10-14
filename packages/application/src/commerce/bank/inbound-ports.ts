/**
 * What the inbound side of the bank-transfer route runs on (Payments V1, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.5-§7.12, §7.23,
 * §7.28): the credit tables of the caller's unit of work (the persistence adapter's PgBankCredits, bound by the api composition), the
 * classifier of the bound integration's credit and statement artifacts and the product's registered hold (BANK_HOLD_POINTS).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { BankCreditRecord, BankTransferInstructionRecord, EvidenceClassification, IncomingCredit, StatementPage } from "@kauro/domain";
import type { StoredBankEvidence } from "../ports.js";
import type { BankDetailsClassifier, BankRouteCollaborators } from "./ports.js";
import type { SettlementEvidenceClassifier } from "./settlement.js";

export type BankStreamName = "INBOUND" | "OUTBOUND";

/** The columns a credit's change may set; unnamed ones stay. */
export interface BankCreditChangeInput {
  readonly state: BankCreditRecord["state"];
  readonly netCents?: bigint | null;
  readonly feeCents?: bigint | null;
  readonly payerDigest?: string | null;
  readonly payeeDigest?: string | null;
  readonly reference?: string | null;
  readonly bookedAt?: string | null;
  readonly orderId?: string;
  readonly captureId?: string;
}

export interface NewBankCreditInput {
  readonly creditId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly bankTransactionId: string;
  readonly state: "DRAFT_MANUAL" | "OBSERVED";
  readonly rail: BankCreditRecord["rail"];
  readonly grossCents: bigint;
  readonly netCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly reference: string | null;
  readonly bookedAt: string | null;
  readonly evidenceHash: string;
  readonly payerDigest: string | null;
  readonly payeeDigest: string | null;
  readonly artifactRef: string | null;
  readonly createdBy: string | null;
}

export interface NewStatementImportInput {
  readonly importId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly normalizerVersion: string;
  readonly idempotencyKey: string;
  readonly importedBy: string;
}

/** One statement line as the classified artifact states it (destination: digests, last digits and provider references only). */
export interface NewStatementLineInput {
  readonly lineId: string;
  readonly importId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly lineKind: "CREDIT" | "DEBIT";
  readonly bankLineId: string;
  readonly bankExecutionId: string | null;
  readonly amountCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly currency: string;
  readonly reference: string | null;
  readonly status: string;
  readonly executedAt: string | null;
  readonly bookedAt: string | null;
  readonly observedAt: string;
  readonly destinationAccountDigest: string | null;
  readonly destinationAccountLast4: string | null;
  readonly destinationRoutingDigest: string | null;
  readonly recipientRef: string | null;
  readonly recipientVersion: string | null;
  readonly evidenceHash: string;
}

export type StatementLineWriteResult = { readonly kind: "NEW" | "SAME"; readonly lineId: string; readonly linkedAttemptId: string | null } | { readonly kind: "DIFFERENT" };

/** The credit tables in the caller's unit of work (persistence PgBankCredits). */
export interface BankCreditRepository {
  lockStream(environment: string, accountRef: string, stream: BankStreamName): Promise<void>;
  credit(creditId: string): Promise<BankCreditRecord | null>;
  /** B12 GAP-API-9: the credits in one state, oldest first, keyset (created_at, bank_credit_id) after `after`, at most `limit`. */
  listCredits(state: string, after: { readonly createdAt: string; readonly id: string } | null, limit: number): Promise<ReadonlyArray<{ readonly credit: BankCreditRecord; readonly position: { readonly createdAt: string; readonly id: string } }>>;
  lockCredit(creditId: string): Promise<BankCreditRecord | null>;
  creditByTransaction(environment: string, accountRef: string, bankTransactionId: string, lock?: boolean): Promise<BankCreditRecord | null>;
  insertCredit(c: NewBankCreditInput): Promise<BankCreditRecord | null>;
  transitionCredit(creditId: string, expectedVersion: number, change: BankCreditChangeInput): Promise<{ readonly kind: "APPLIED"; readonly record: BankCreditRecord } | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }>;
  instructionByReference(environment: string, accountRef: string, reference: string): Promise<BankTransferInstructionRecord | null>;
  instruction(orderId: string, lock?: boolean): Promise<BankTransferInstructionRecord | null>;
  acceptedPayerDigestOf(orderId: string): Promise<string | null>;
  /** The bank order to EXPIRED with its cause (STALE_VERSION when the version moved); the caller holds the order's and the instruction's locks. */
  expireOrder(orderId: string, expectedVersion: number, cause: "DEADLINE" | "RETIRED"): Promise<BankTransferInstructionRecord>;
  /** Releases the project's open checkout of an order whose bank state is EXPIRED (set once). */
  releaseBankSlot(orderId: string): Promise<void>;
  /** CMD214: the order's recorded retirement, if any (D-INB-CTX-2). */
  retirementOf(orderId: string): Promise<{ readonly orderId: string; readonly requestedAt: UtcInstant; readonly consumedAt: UtcInstant | null } | null>;
  /** CMD214: records the member's retirement (the database stamps its instant); the caller holds the order's lock. */
  recordRetirement(r: { readonly orderId: string; readonly agencyId: string; readonly requestedBy: string; readonly reasonCode: string }): Promise<{ readonly orderId: string; readonly requestedAt: UtcInstant }>;
  environmentsOfAccount(accountRef: string): Promise<ReadonlyArray<"SANDBOX" | "LIVE">>;
  openCreditCase(caseId: string, kind: "MATCH_REVIEW" | "PROVIDER_TIME_UNVERIFIED", credit: Pick<BankCreditRecord, "creditId" | "environment" | "accountRef" | "evidenceHash">, detailCode: string): Promise<boolean>;
  resolveCreditCases(creditId: string): Promise<number>;
  // statement imports (SI2)
  importOfArtifact(environment: string, accountRef: string, evidenceHash: string): Promise<string | null>;
  /** The earliest instant a statement of the account may cover (its first route version less that version's provider-time tolerance). */
  coverageFloorOf(environment: string, accountRef: string): Promise<UtcInstant | null>;
  insertImport(i: NewStatementImportInput): Promise<void>;
  insertCoverage(importId: string, stream: BankStreamName, from: string, to: string): Promise<void>;
  recordLine(l: NewStatementLineInput): Promise<StatementLineWriteResult>;
  recordedAttemptOf(environment: string, accountRef: string, bankExecutionId: string): Promise<string | null>;
  attemptDeclaredWith(reference: string): Promise<boolean>;
  linkLine(lineId: string, attemptId: string): Promise<void>;
  openLineCase(caseId: string, kind: "RECORD_REQUIRED" | "UNDECLARED_OUTBOUND", line: { readonly environment: string; readonly accountRef: string; readonly lineId: string; readonly evidenceHash: string }, detailCode: string): Promise<boolean>;
  /** Runs `work` under a savepoint rolled back once it settled: every lock it took is released, nothing it wrote survives. */
  released<T>(work: () => Promise<T>): Promise<T>;
}

/** Classifies an owner-supplied credit or statement artifact (R1): pure, fail-closed, never a partial value. */
export interface BankEvidenceClassifier extends BankDetailsClassifier, SettlementEvidenceClassifier {
  classifyCredit(evidence: StoredBankEvidence): EvidenceClassification<IncomingCredit>;
  classifyStatement(evidence: StoredBankEvidence): EvidenceClassification<StatementPage>;
}

export interface BankInboundCollaborators extends BankRouteCollaborators {
  readonly credits: (uow: import("@kauro/domain").CommerceUnitOfWork) => BankCreditRepository;
  readonly classifier: () => BankEvidenceClassifier | null;
  /** The product's registered hold (a test pauses, crashes or fails here; production: a no-op). */
  readonly hold: (point: string) => Promise<void>;
  /** The list cursors' HMAC key (the api's configured cursor key; absent: a per-process random key, cursors die with the process). */
  readonly cursorKey?: Uint8Array;
}

export const BANK_HOLD_GATE_READ = "bank:gate-read";
export const BANK_HOLD_STATEMENT_LOCKED = "bank:statement-locked";

export type { UtcInstant };

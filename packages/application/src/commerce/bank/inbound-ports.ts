/**
 * What the inbound side of the bank-transfer route runs on (Payments V1, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.5-§7.12, §7.23,
 * §7.28): the credit tables of the caller's unit of work (the persistence adapter's PgBankCredits, bound by the api composition), the
 * classifier of the bound integration's credit and statement artifacts and the product's registered hold (BANK_HOLD_POINTS).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { BankCreditRecord, BankTransferInstructionRecord, EvidenceClassification, IncomingCredit, StatementPage } from "@kauro/domain";
import type { StoredBankEvidence } from "../ports.js";
import type { BankDetailsClassifier, BankRouteCollaborators } from "./ports.js";

export type BankStreamName = "INBOUND" | "OUTBOUND";

/** The columns a credit's change may set; unnamed ones stay. */
export interface BankCreditChangeInput {
  readonly state: BankCreditRecord["state"];
  readonly netCents?: bigint | null;
  readonly feeCents?: bigint | null;
  readonly payerDigest?: string | null;
  readonly payeeDigest?: string | null;
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

/** The credit tables in the caller's unit of work (persistence PgBankCredits). */
export interface BankCreditRepository {
  lockStream(environment: string, accountRef: string, stream: BankStreamName): Promise<void>;
  credit(creditId: string): Promise<BankCreditRecord | null>;
  lockCredit(creditId: string): Promise<BankCreditRecord | null>;
  creditByTransaction(environment: string, accountRef: string, bankTransactionId: string, lock?: boolean): Promise<BankCreditRecord | null>;
  insertCredit(c: NewBankCreditInput): Promise<BankCreditRecord | null>;
  transitionCredit(creditId: string, expectedVersion: number, change: BankCreditChangeInput): Promise<{ readonly kind: "APPLIED"; readonly record: BankCreditRecord } | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }>;
  instructionByReference(environment: string, accountRef: string, reference: string): Promise<BankTransferInstructionRecord | null>;
  instruction(orderId: string, lock?: boolean): Promise<BankTransferInstructionRecord | null>;
  acceptedPayerDigestOf(orderId: string): Promise<string | null>;
  environmentsOfAccount(accountRef: string): Promise<ReadonlyArray<"SANDBOX" | "LIVE">>;
  openCreditCase(caseId: string, kind: "MATCH_REVIEW" | "PROVIDER_TIME_UNVERIFIED", credit: Pick<BankCreditRecord, "creditId" | "environment" | "accountRef" | "evidenceHash">, detailCode: string): Promise<boolean>;
  resolveCreditCases(creditId: string): Promise<number>;
  /** Runs `work` under a savepoint rolled back once it settled: every lock it took is released, nothing it wrote survives. */
  released<T>(work: () => Promise<T>): Promise<T>;
}

/** Classifies an owner-supplied credit or statement artifact (R1): pure, fail-closed, never a partial value. */
export interface BankEvidenceClassifier extends BankDetailsClassifier {
  classifyCredit(evidence: StoredBankEvidence): EvidenceClassification<IncomingCredit>;
  classifyStatement(evidence: StoredBankEvidence): EvidenceClassification<StatementPage>;
}

export interface BankInboundCollaborators extends BankRouteCollaborators {
  readonly credits: (uow: import("@kauro/domain").CommerceUnitOfWork) => BankCreditRepository;
  readonly classifier: () => BankEvidenceClassifier | null;
  /** The product's registered hold (a test pauses, crashes or fails here; production: a no-op). */
  readonly hold: (point: string) => Promise<void>;
}

export const BANK_HOLD_GATE_READ = "bank:gate-read";
export const BANK_HOLD_STATEMENT_LOCKED = "bank:statement-locked";

export type { UtcInstant };

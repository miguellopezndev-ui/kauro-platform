/**
 * The settlement observation of the bank-transfer route (Payments V1, lane PV1-SETTLE; docs/design/PV1-SETTLE.md; ACH-ROUTE r7 §7.25;
 * R2 15 "Settlement and withdrawal"; R2-085).
 *
 *   ST1 the provider's settlement record of the route account and, when the money arrived, the receiving bank's receipt are read
 *       from the restricted store under the provider-call bound (EVIDENCE_UNAVAILABLE past it, nothing written), re-verified by hash,
 *       classified purely and fail closed, and checked for consistency (D-SET-3) before any lock or write; never cached.
 *
 * No money figure is ever typed by the owner: every amount, instant and identity comes from the classified artifacts (21 "never grade
 * from a screenshot"). Bank-available money exists only with a receipt (D-LEDGER-B5).
 */
import type { BankAccountRef, BankReceiptEvidence, CommerceFailureReason, EvidenceClassification, PaymentEnvironment, SettlementEvidence } from "@kauro/domain";
import { DomainFailure, PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import type { ProviderCallTimer } from "../../commercial/ports.js";
import type { BankEvidenceStore, StoredBankEvidence } from "../ports.js";
import { evidenceUnavailable } from "./route-config.js";

/** The pure classifiers of the two settlement artifacts (the bound integration's evidence port). */
export interface SettlementEvidenceClassifier {
  classifySettlement(evidence: StoredBankEvidence): EvidenceClassification<SettlementEvidence>;
  classifyBankReceipt(evidence: StoredBankEvidence): EvidenceClassification<BankReceiptEvidence>;
}

/** What ST1 needs: the restricted store, the classifier (null: none bound, fail closed) and the provider-call timer. */
export interface SettlementEvidenceCollaborators {
  readonly evidence: () => BankEvidenceStore | null;
  readonly settlementClassifier: () => SettlementEvidenceClassifier | null;
  readonly timer: ProviderCallTimer;
}

/** The two artifacts a settlement observation cites (CMD215's body, D-SET-1). */
export interface SettlementArtifacts {
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly receipt: { readonly artifactRef: string; readonly evidenceHash: string } | null;
}

export interface VerifiedSettlement {
  readonly settlement: SettlementEvidence;
  readonly receipt: BankReceiptEvidence | null;
  readonly normalizerVersion: string;
}

/** V1 settles USD only and has no FX (D-SET-3: `fx_rate` stays NULL). */
export const SETTLEMENT_CURRENCY = "USD";

const precondition = (reason: CommerceFailureReason, message: string): DomainFailure => new DomainFailure("PRECONDITION_FAILED", message, { reason });
const unknownEvidence = (): DomainFailure => new DomainFailure("INTEGRITY_FAILURE", "the artifact is not settlement evidence of this account", { reason: "UNKNOWN_EVIDENCE" });

async function boundedRead(co: SettlementEvidenceCollaborators, store: BankEvidenceStore, ref: string, expectedHash: string): Promise<StoredBankEvidence> {
  const bound = co.timer.start(PROVIDER_CALL_TIMEOUT_MS);
  let read: { readonly evidence: StoredBankEvidence | null } | null;
  try {
    read = await Promise.race([store.get(ref).then((evidence) => ({ evidence })), bound.elapsed.then(() => null)]);
  } finally {
    bound.cancel();
  }
  if (read === null) throw evidenceUnavailable();
  if (read.evidence === null) throw new DomainFailure("NOT_FOUND", "the artifact is not in the restricted store", { reason: "EVIDENCE_NOT_FOUND" });
  if (read.evidence.sha256 !== expectedHash) throw new DomainFailure("INTEGRITY_FAILURE", "the artifact is not the evidence the observation cites", { reason: "HASH_MISMATCH" });
  return read.evidence;
}

function classified<T extends { readonly evidenceHash: string }>(c: EvidenceClassification<T>, expectedHash: string): T {
  if (c.kind === "REJECTED") {
    // a document of another kind is not settlement evidence; any other refusal keeps its own code
    if (c.code === "UNKNOWN_EVIDENCE") throw unknownEvidence();
    throw new DomainFailure("INTEGRITY_FAILURE", `the settlement evidence was refused: ${c.code}`, { reason: c.code });
  }
  if (c.value.evidenceHash !== expectedHash) throw new DomainFailure("INTEGRITY_FAILURE", "the classification is not of the cited bytes", { reason: "MALFORMED_EVIDENCE" });
  return c.value;
}

/**
 * ST1: reads, verifies, classifies and checks the cited artifacts outside every lock. Throws a DomainFailure the command answers as it is
 * (the refusal precedes any write); a store or classifier that is not bound is EVIDENCE_UNAVAILABLE, never a guess.
 */
export async function readSettlementEvidence(co: SettlementEvidenceCollaborators, accountRef: BankAccountRef | string, environment: PaymentEnvironment, body: SettlementArtifacts): Promise<VerifiedSettlement> {
  const store = co.evidence();
  const classifier = co.settlementClassifier();
  if (store === null || classifier === null) throw evidenceUnavailable();
  const stored = await boundedRead(co, store, body.artifactRef, body.evidenceHash);
  // another account's or environment's artifact is not evidence of this route
  if (stored.accountRef !== accountRef || stored.environment !== environment) throw unknownEvidence();
  const settlement = classified(classifier.classifySettlement(stored), body.evidenceHash);
  let receipt: BankReceiptEvidence | null = null;
  if (body.receipt !== null) {
    const storedReceipt = await boundedRead(co, store, body.receipt.artifactRef, body.receipt.evidenceHash);
    if (storedReceipt.accountRef !== accountRef || storedReceipt.environment !== environment) throw unknownEvidence();
    receipt = classified(classifier.classifyBankReceipt(storedReceipt), body.receipt.evidenceHash);
  }
  // D-SET-3: consistent before any write
  if (settlement.currency !== SETTLEMENT_CURRENCY || (receipt !== null && receipt.currency !== settlement.currency)) throw precondition("CURRENCY_MISMATCH", "V1 settles USD only, without FX");
  if (settlement.withdrawnCents === 0n) throw precondition("SETTLEMENT_INCONSISTENT", "the settlement record releases no withdrawal");
  if (receipt !== null) {
    if (receipt.withdrawalId !== settlement.withdrawalId) throw precondition("RECEIPT_MISMATCH", "the receipt cites another withdrawal");
    if (receipt.receivedCents > settlement.withdrawnCents) throw precondition("SETTLEMENT_INCONSISTENT", "the bank received more than the provider released");
    if (receipt.bankAvailableCents < receipt.receivedCents) throw precondition("SETTLEMENT_INCONSISTENT", "the bank balance is below the receipt it shows");
  }
  return { settlement, receipt, normalizerVersion: stored.normalizerVersion };
}

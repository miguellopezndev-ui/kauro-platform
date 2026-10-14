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
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { BankAccountRef, BankReceiptEvidence, CommerceFailureReason, CommerceUnitOfWork, EvidenceClassification, OperatorContext, PaymentEnvironment, SettlementEvidence, SettlementId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, PROVIDER_CALL_TIMEOUT_MS, actorOf, settlementPostings } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import type { ProviderCallTimer } from "../../commercial/ports.js";
import type { BankEvidenceStore, StoredBankEvidence } from "../ports.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../request/runtime.js";
import { BANK_INBOUND_COMMAND_IDS, inboundCommandOf, inboundEnvelopeOf } from "./inbound.js";
import type { BankInboundCollaborators } from "./inbound-ports.js";
import { STEP_UP_ALLOW, assuredAt, evidenceUnavailable, judgedAtCommit, type BankRouteRequest } from "./route-config.js";

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

// --- ST2: CMD215 RecordSettlementObservation (D-SET-1, D-SET-4..D-SET-7) ----------------------------------------------------------------

/** The settlement tables of the caller's unit of work (the persistence adapter's PgBankSettlements, bound by the api composition). */
export interface BankSettlementRepository {
  routeOfAccount(environment: string, accountRef: string): Promise<{ readonly bankRouteId: string; readonly paymentRouteId: string; readonly currency: string } | null>;
  /** The payout cash basis lock (CMD052's, 0043), held to COMMIT. */
  lockFunds(): Promise<void>;
  providerAvailableCents(paymentRouteId: string, currency: string): Promise<bigint>;
  settledAs(environment: string, accountRef: string, withdrawalId: string, receipt: { readonly receivingAccountRef: string; readonly bankTransactionId: string } | null): Promise<string | null>;
  insert(s: NewBankSettlementInput): Promise<void>;
}
export interface NewBankSettlementInput {
  readonly settlementId: string;
  readonly paymentRouteId: string;
  readonly bankRouteId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly currency: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint;
  readonly heldCents: bigint;
  readonly withdrawnCents: bigint;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly observedAt: string;
  readonly normalizerVersion: string;
  readonly recordedBy: string;
  readonly receipt: { readonly receivingAccountRef: string; readonly bankTransactionId: string; readonly artifactRef: string; readonly evidenceHash: string; readonly receivedCents: bigint; readonly bankAvailableCents: bigint } | null;
  readonly createdAt: UtcInstant;
}

export interface BankSettlementCollaborators extends BankInboundCollaborators {
  readonly settlements: (uow: CommerceUnitOfWork) => BankSettlementRepository;
}

/** CMD215's body: the two stored artifacts (no figure is typed) and the owner's step-up. */
export interface RecordSettlementBody extends SettlementArtifacts {
  readonly authorizationRef: string;
}
export interface SettlementView {
  readonly settlementId: string;
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly withdrawnCents: string;
  readonly feeCents: string;
  readonly receivedCents: string | null;
  readonly bankAvailableCents: string;
  readonly bankEvidence: boolean;
  readonly observedAt: string;
}
export interface SettlementCommandView {
  readonly settlement: SettlementView;
}
export interface BankSettlementHandlers {
  /** CMD215 ST1+ST2: the owner records the settlement of one withdrawal of the route account. */
  record(request: BankRouteRequest<RecordSettlementBody>): Promise<CommandResult<SettlementCommandView>>;
}

/** The registered hold under the settlement's locks (a test pauses, crashes or fails here; production: a no-op). */
export const BANK_HOLD_SETTLEMENT_LOCKED = "bank:settlement-locked";

const inFuture = (instant: string, at: string): boolean => Date.parse(instant) > Date.parse(at);

export function createBankSettlementHandlers(runtime: CommerceRequestRuntime, co: BankSettlementCollaborators): BankSettlementHandlers {
  const collaborators: SettlementEvidenceCollaborators = { evidence: co.evidence, settlementClassifier: co.classifier, timer: co.timer };

  async function authorizeOwner(uow: CommerceUnitOfWork, envelope: CommandEnvelope<unknown>, what: string): Promise<void> {
    const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: envelope.subject.identity, role: "KAURO_OWNER" });
    if (decision.kind === "DENY") throw CommerceAccessDenied.of(what, decision);
  }

  return {
    async record(request) {
      const id = BANK_INBOUND_COMMAND_IDS.settle;
      const envelope = inboundEnvelopeOf(id, request);
      const context = operatorContextOf(envelope);
      const accountRef = request.path["accountRef"]!;
      let environment: "SANDBOX" | "LIVE" | null = null;
      let verified: VerifiedSettlement | null = null;
      let deferred: DomainFailure | null = null;
      return runCommerceCommand<RecordSettlementBody, SettlementCommandView>(runtime, {
        command: inboundCommandOf(id),
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const credits = co.credits(uow);
          const environments = await credits.environmentsOfAccount(accountRef);
          environment = environments.includes(envelope.environment as "SANDBOX" | "LIVE") ? (envelope.environment as "SANDBOX" | "LIVE") : (environments[0] ?? null);
          // the decision first, in a unit-local scope (its share locks released): ST2 re-judges the owner under the locks
          await credits.released(() => authorizeOwner(uow, envelope, id));
          if (environment === null) return;
          // ST1: both artifacts are read, hash-verified, classified and checked outside every lock (no lock is held yet); never cached
          try {
            verified = await readSettlementEvidence(collaborators, accountRef, environment, envelope.body);
          } catch (e) {
            if (!(e instanceof DomainFailure)) throw e;
            deferred = e;
          }
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const credits = co.credits(uow);
          const repo = co.settlements(uow);
          if (environment === null) throw new NotFoundFailure("bank account");
          // §7.28 and D-SET-5: L1 (the OUTBOUND stream: the withdrawal is a debit of the account), then INBOUND, then the payout cash
          // basis lock (CMD052's): a payout approval and a settlement serialize in both orders
          await credits.lockStream(environment, accountRef, "OUTBOUND");
          await credits.lockStream(environment, accountRef, "INBOUND");
          await repo.lockFunds();
          await co.hold(BANK_HOLD_SETTLEMENT_LOCKED);
          // the owner is judged again under the locks (a withdrawal while the command read or waited is seen)
          await authorizeOwner(uow, envelope, id);
          if (deferred !== null) throw deferred;
          const evidence: VerifiedSettlement | null = verified;
          if (evidence === null) throw new DomainFailure("INTEGRITY_FAILURE", "the settlement evidence was not verified");
          const { settlement, receipt } = evidence;
          // the effect instant: the database clock read after the last lock wait (the step-up is judged at it, and again at COMMIT)
          const at = await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          // no instant of the evidence lies after the effect instant: a period never ends after it, nor an observation or a booking
          if (inFuture(settlement.periodEnd, at) || inFuture(settlement.observedAt, at) || (receipt !== null && (inFuture(receipt.bookedAt, at) || inFuture(receipt.observedAt, at)))) {
            throw precondition("COVERAGE_END_IN_FUTURE", "the settlement evidence states an instant after the effect instant");
          }
          const route = await repo.routeOfAccount(environment, accountRef);
          if (route === null) throw new NotFoundFailure("bank account");
          if (route.currency !== settlement.currency) throw precondition("CURRENCY_MISMATCH", "the settlement is not in the route's currency");
          // D-SET-4: one settlement per withdrawal and per bank transaction
          const receiptIdentity = receipt === null ? null : { receivingAccountRef: receipt.accountRef, bankTransactionId: receipt.bankTransactionId };
          if ((await repo.settledAs(environment, accountRef, settlement.withdrawalId, receiptIdentity)) !== null) throw precondition("WITHDRAWAL_ALREADY_SETTLED", "the withdrawal or its bank transaction is already settled");
          // D-SET-5: no settlement of imaginary liquidity, judged under the funds lock
          const available = await repo.providerAvailableCents(route.paymentRouteId, settlement.currency);
          if (settlement.withdrawnCents + settlement.feeCents > available) {
            throw new DomainFailure("PRECONDITION_FAILED", "the provider-available balance does not cover the withdrawal and its fee", { reason: "FUNDS_UNAVAILABLE" });
          }
          const settlementId = uow.ids.next();
          const observedAt = (receipt?.observedAt ?? settlement.observedAt) as UtcInstant;
          const receivedCents = receipt?.receivedCents ?? null;
          await repo.insert({
            settlementId,
            paymentRouteId: route.paymentRouteId,
            bankRouteId: route.bankRouteId,
            environment,
            accountRef,
            withdrawalId: settlement.withdrawalId,
            artifactRef: body.artifactRef,
            evidenceHash: settlement.evidenceHash,
            currency: settlement.currency,
            grossCents: settlement.grossCents,
            feeCents: settlement.feeCents,
            heldCents: settlement.heldCents,
            withdrawnCents: settlement.withdrawnCents,
            periodStart: settlement.periodStart,
            periodEnd: settlement.periodEnd,
            observedAt,
            normalizerVersion: evidence.normalizerVersion,
            recordedBy: envelope.userId,
            receipt:
              receipt === null || body.receipt === null
                ? null
                : { receivingAccountRef: receipt.accountRef, bankTransactionId: receipt.bankTransactionId, artifactRef: body.receipt.artifactRef, evidenceHash: receipt.evidenceHash, receivedCents: receipt.receivedCents, bankAvailableCents: receipt.bankAvailableCents },
            createdAt: at,
          });
          await uow.events.publish({
            aggregateKind: "settlement" as never,
            aggregateId: settlementId as never,
            aggregateVersion: 1,
            agencyId: null,
            eventType: "settlement.recorded.v1" as never,
            actor: actorOf(uow.context as OperatorContext),
            causationId,
            correlationId: envelope.correlationId,
            payload: { settlementId, withdrawnCents: Number(settlement.withdrawnCents), feeCents: Number(settlement.feeCents), receivedCents: Number(receivedCents ?? 0n), bankEvidence: receipt !== null },
          });
          // D-SET-6: one balanced SETTLEMENT set, agency-less, its source the observation (UNIQUE (event_id, line_no))
          await uow.commerce.ledger.post(
            {
              agencyId: null,
              source: { kind: "SETTLEMENT", settlementId: settlementId as unknown as SettlementId },
              sourceKind: "SETTLEMENT",
              sourceRef: settlementId,
              currency: settlement.currency,
              effectiveAt: (receipt?.bookedAt ?? settlement.periodEnd) as UtcInstant,
              observedAt,
              evidenceHash: (receipt?.evidenceHash ?? settlement.evidenceHash) as Sha256Hex,
              lines: settlementPostings(settlement.withdrawnCents, settlement.feeCents, receivedCents ?? 0n),
            },
            at,
          );
          const view: SettlementView = {
            settlementId,
            accountRef,
            withdrawalId: settlement.withdrawalId,
            currency: settlement.currency,
            periodStart: settlement.periodStart,
            periodEnd: settlement.periodEnd,
            withdrawnCents: settlement.withdrawnCents.toString(),
            feeCents: settlement.feeCents.toString(),
            receivedCents: receivedCents === null ? null : receivedCents.toString(),
            bankAvailableCents: (receipt?.bankAvailableCents ?? 0n).toString(),
            bankEvidence: receipt !== null,
            observedAt,
          };
          return { status: 201, view: { settlement: view }, version: 1, resourceKind: "settlement", resourceId: settlementId, allowFact: STEP_UP_ALLOW };
        },
      });
    },
  };
}

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
import type { BankAccountRef, BankReceiptEvidence, CausationId, CommerceFailureReason, CommerceUnitOfWork, EvidenceClassification, OperatorContext, PaymentEnvironment, SettlementEvidence, SettlementId, UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, PROVIDER_CALL_TIMEOUT_MS, actorOf, settlementPostings } from "@kauro/domain";
import { judgedUnderHold } from "../../api/authority.js";
import { openCursor, sealCursor } from "../../api/cursor.js";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { problemOf } from "../../api/problems.js";
import type { ProviderCallTimer } from "../../commercial/ports.js";
import type { BankEvidenceStore, StoredBankEvidence } from "../ports.js";
import { CommerceAccessDenied, operatorContextOf, recordCommerceDenial, runCommerceCommand, type CommerceRequestRuntime } from "../request/runtime.js";
import { BANK_INBOUND_COMMAND_IDS, inboundCommandOf, inboundEnvelopeOf, type InboundReadAnswer, type InboundReadRequest } from "./inbound.js";
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

// --- ST2 CMD215 records the owner's intent; ST3 the payment service applies it (D-SET-10, docs/design/PV1-SETTLE-two-step.md §3.2-§3.5) --

export type SettlementRequestOutcome = "APPLIED" | "REFUSED";
export type SettlementRefusalReason = "EVIDENCE_MISMATCH" | "REQUEST_STALE" | "COVERAGE_END_IN_FUTURE" | "CURRENCY_MISMATCH" | "WITHDRAWAL_ALREADY_SETTLED" | "FUNDS_UNAVAILABLE";

/** The receipt facts an intent freezes (all or none). */
export interface SettlementRequestReceiptInput {
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly receivingAccountRef: string;
  readonly bankTransactionId: string;
  readonly receivedCents: bigint;
  readonly bankAvailableCents: bigint;
  readonly bookedAt: string;
  readonly observedAt: string;
}
/** The facts CMD215 freezes in the owner's intent: what the classified artifacts state (no figure is typed). */
export interface NewSettlementRequestInput {
  readonly requestId: string;
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
  readonly receipt: SettlementRequestReceiptInput | null;
}
/** An intent as recorded (instants to the millisecond). */
export interface SettlementRequestRecord extends NewSettlementRequestInput {
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly consumedAt: string | null;
  readonly outcome: SettlementRequestOutcome | null;
  readonly refusalReason: SettlementRefusalReason | null;
  readonly settlementId: string | null;
  readonly reviewCaseId: string | null;
}
export interface SettlementRecordSummary {
  readonly settlementId: string;
  readonly withdrawalId: string;
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly withdrawnCents: bigint;
  readonly feeCents: bigint;
  readonly receivedCents: bigint | null;
  readonly bankAvailableCents: bigint;
  readonly bankEvidence: boolean;
  readonly observedAt: string;
}
export interface SettlementRequestOutcomeRecord {
  readonly request: SettlementRequestRecord;
  /** The PAYMENT_SERVICE outbox state of the intent's recorded.v1. */
  readonly delivery: string;
  readonly settlement: SettlementRecordSummary | null;
}
export interface SettlementInTransitRecord {
  readonly requestId: string;
  readonly withdrawalId: string;
  readonly state: "RECORDED" | "REFUSED" | "APPLIED";
  readonly reason: SettlementRefusalReason | null;
  readonly withdrawnCents: bigint;
  readonly receivedCents: bigint | null;
  readonly feeCents: bigint;
  readonly requestedAt: string;
  readonly ageSeconds: number;
  readonly delivery: string;
  readonly reviewCaseId: string | null;
}

/** The settlement tables of the caller's unit of work (the persistence adapter's PgBankSettlements, bound by the api composition). */
export interface BankSettlementRepository {
  routeOfAccount(environment: string, accountRef: string): Promise<{ readonly bankRouteId: string; readonly paymentRouteId: string; readonly currency: string } | null>;
  /** The payout cash basis lock (CMD052's, 0043), held to COMMIT. */
  lockFunds(): Promise<void>;
  providerAvailableCents(paymentRouteId: string, currency: string): Promise<bigint>;
  settledAs(environment: string, accountRef: string, withdrawalId: string, receipt: { readonly receivingAccountRef: string; readonly bankTransactionId: string } | null): Promise<string | null>;
  liveRequestOf(environment: string, accountRef: string, withdrawalId: string, receipt: { readonly receivingAccountRef: string; readonly bankTransactionId: string } | null): Promise<string | null>;
  insertRequest(s: NewSettlementRequestInput): Promise<{ readonly requestedAt: string }>;
  requestOf(requestId: string): Promise<SettlementRequestRecord | null>;
  lockRequest(requestId: string): Promise<SettlementRequestRecord | null>;
  timeRefusal(requestId: string, at: string, staleAfterSeconds: number): Promise<SettlementRefusalReason | null>;
  openRefusalCase(caseId: string, request: Pick<SettlementRequestRecord, "requestId" | "environment" | "accountRef" | "evidenceHash">, reason: SettlementRefusalReason): Promise<void>;
  refuse(requestId: string, reason: SettlementRefusalReason, caseId: string): Promise<void>;
  markApplied(requestId: string, settlementId: string): Promise<void>;
  resolveRefusedCases(environment: string, accountRef: string, withdrawalId: string): Promise<number>;
  insert(s: NewBankSettlementInput): Promise<void>;
  outcomeOf(environment: string, accountRef: string, requestId: string): Promise<SettlementRequestOutcomeRecord | null>;
  inTransit(environment: string, accountRef: string, after: { readonly requestedAt: string; readonly requestId: string } | null, limit: number): Promise<ReadonlyArray<SettlementInTransitRecord>>;
}
export interface NewBankSettlementInput {
  readonly settlementId: string;
  readonly requestId: string;
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
  /** The apply's exact effect instant (µs); the row keeps it to the millisecond. */
  readonly createdAt: string;
}

export interface BankSettlementCollaborators extends BankInboundCollaborators {
  readonly settlements: (uow: CommerceUnitOfWork) => BankSettlementRepository;
  /** The server's cursor key (the in-transit page's sealed cursor, bound to the caller and the account). */
  readonly cursorKey: Uint8Array;
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
/** CMD215's 201: the recorded intent (never a settlement: the payment service applies it). */
export interface SettlementRequestCommandView {
  readonly settlementRequest: { readonly requestId: string; readonly accountRef: string; readonly withdrawalId: string; readonly state: "RECORDED"; readonly requestedAt: string };
}
export interface SettlementRequestView {
  readonly requestId: string;
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly state: "RECORDED" | SettlementRequestOutcome;
  readonly reason: SettlementRefusalReason | null;
  readonly requestedAt: string;
  readonly consumedAt: string | null;
  readonly reviewCaseId: string | null;
  readonly delivery: string;
  readonly settlement: SettlementView | null;
}
export interface SettlementInTransitItemView {
  readonly requestId: string;
  readonly withdrawalId: string;
  readonly state: "RECORDED" | "REFUSED" | "APPLIED";
  readonly reason: SettlementRefusalReason | null;
  readonly withdrawnCents: string;
  readonly receivedCents: string | null;
  readonly feeCents: string;
  readonly requestedAt: string;
  readonly ageSeconds: number;
  readonly delivery: string;
  readonly reviewCaseId: string | null;
}
export interface SettlementInTransitView {
  readonly items: ReadonlyArray<SettlementInTransitItemView>;
  readonly nextCursor: string | null;
}
export interface SettlementReadRequest extends InboundReadRequest {
  readonly environment: string;
  readonly accountRef: string;
}
export interface BankSettlementHandlers {
  /** CMD215 ST1+ST2: the owner records the intent to settle one withdrawal of the route account. */
  record(request: BankRouteRequest<RecordSettlementBody>): Promise<CommandResult<SettlementRequestCommandView>>;
  /** getBankSettlementRequest: one intent of the account and its outcome. */
  get(request: SettlementReadRequest & { readonly requestId: string }): Promise<InboundReadAnswer<{ readonly settlementRequest: SettlementRequestView }>>;
  /** listBankSettlementsInTransit: the account's intents not yet applied, whose refusal is not resolved, or applied without a receipt (money still in BANK_IN_TRANSIT). */
  list(request: SettlementReadRequest & { readonly cursor: string | null }): Promise<InboundReadAnswer<SettlementInTransitView>>;
}

/** The registered hold under the record's lock (a test pauses, crashes or fails here; production: a no-op). */
export const BANK_HOLD_SETTLEMENT_LOCKED = "bank:settlement-locked";
/** An intent older than this at the apply's effect instant is refused REQUEST_STALE (plan §3.3 A7, rule C1). */
export const SETTLEMENT_REQUEST_STALE_SECONDS = 900;
/** The in-transit page's size (plan §3.5). */
export const SETTLEMENT_IN_TRANSIT_PAGE = 100;
const IN_TRANSIT_OPERATION = "listBankSettlementsInTransit";

const inFuture = (instant: string, at: string): boolean => Date.parse(instant) > Date.parse(at);
const alreadySettled = (): DomainFailure => precondition("WITHDRAWAL_ALREADY_SETTLED", "the withdrawal or its bank transaction is already settled or has a live intent");

function settlementView(accountRef: string, s: SettlementRecordSummary): SettlementView {
  return {
    settlementId: s.settlementId,
    accountRef,
    withdrawalId: s.withdrawalId,
    currency: s.currency,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    withdrawnCents: s.withdrawnCents.toString(),
    feeCents: s.feeCents.toString(),
    receivedCents: s.receivedCents === null ? null : s.receivedCents.toString(),
    bankAvailableCents: s.bankAvailableCents.toString(),
    bankEvidence: s.bankEvidence,
    observedAt: s.observedAt,
  };
}

/** The environment of an account the command or read acts in: the deployment's when the account has a route there, else its only one. */
async function environmentOf(co: BankSettlementCollaborators, uow: CommerceUnitOfWork, accountRef: string, requested: string): Promise<"SANDBOX" | "LIVE" | null> {
  const environments = await co.credits(uow).environmentsOfAccount(accountRef);
  return environments.includes(requested as "SANDBOX" | "LIVE") ? (requested as "SANDBOX" | "LIVE") : (environments[0] ?? null);
}

export function createBankSettlementHandlers(runtime: CommerceRequestRuntime, co: BankSettlementCollaborators): BankSettlementHandlers {
  const collaborators: SettlementEvidenceCollaborators = { evidence: co.evidence, settlementClassifier: co.classifier, timer: co.timer };

  async function authorizeOwner(uow: CommerceUnitOfWork, envelope: CommandEnvelope<unknown>, what: string): Promise<void> {
    const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: envelope.subject.identity, role: "KAURO_OWNER" });
    if (decision.kind === "DENY") throw CommerceAccessDenied.of(what, decision);
  }

  async function ownerRead<View>(request: SettlementReadRequest, what: string, read: (uow: CommerceUnitOfWork, environment: "SANDBOX" | "LIVE") => Promise<View>): Promise<InboundReadAnswer<View>> {
    const context: OperatorContext = { kind: "OPERATOR", userId: request.subject.identity.userId as UserId, correlationId: request.correlationId };
    let denied = false;
    try {
      const view = await runtime.unitOfWork.run(context, async (uow) => {
        const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: request.subject.identity, role: "KAURO_OWNER" });
        if (decision.kind === "DENY") {
          denied = true;
          throw CommerceAccessDenied.of(what, decision);
        }
        const environment = await environmentOf(co, uow, request.accountRef, request.environment);
        if (environment === null) throw new NotFoundFailure("bank account");
        const out = await read(uow, environment);
        await judgedUnderHold(request.authority, uow, runtime.clock);
        return out;
      });
      return { kind: "READ", view };
    } catch (e) {
      if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
      if (denied || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, what, e, null);
      return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
    }
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
      return runCommerceCommand<RecordSettlementBody, SettlementRequestCommandView>(runtime, {
        command: inboundCommandOf(id),
        envelope,
        context,
        replayVersion: () => 1,
        // R1: the environment, the owner's decision (released) and ST1, all outside every lock
        async access(uow) {
          const credits = co.credits(uow);
          environment = await environmentOf(co, uow, accountRef, envelope.environment);
          // the decision first, in a unit-local scope (its share locks released): R4 re-judges the owner under the lock
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
          // R2: the account's INBOUND stream, the record's only lock (C6's place): two records of one withdrawal serialize here, and a
          // record waits for an apply of the account (which holds OUTBOUND, INBOUND and the payout cash lock)
          await credits.lockStream(environment, accountRef, "INBOUND");
          await co.hold(BANK_HOLD_SETTLEMENT_LOCKED);
          // R4: the owner judged again under the lock (a withdrawal while the command read or waited is seen)
          await authorizeOwner(uow, envelope, id);
          if (deferred !== null) throw deferred;
          const evidence: VerifiedSettlement | null = verified;
          if (evidence === null) throw new DomainFailure("INTEGRITY_FAILURE", "the settlement evidence was not verified");
          const { settlement, receipt } = evidence;
          // R5: the route, its currency, and one live intent or settlement per withdrawal and per bank transaction (D-SET-4)
          const route = await repo.routeOfAccount(environment, accountRef);
          if (route === null) throw new NotFoundFailure("bank account");
          if (route.currency !== settlement.currency) throw precondition("CURRENCY_MISMATCH", "the settlement is not in the route's currency");
          const receiptIdentity = receipt === null ? null : { receivingAccountRef: receipt.accountRef, bankTransactionId: receipt.bankTransactionId };
          if ((await repo.liveRequestOf(environment, accountRef, settlement.withdrawalId, receiptIdentity)) !== null) throw alreadySettled();
          if ((await repo.settledAs(environment, accountRef, settlement.withdrawalId, receiptIdentity)) !== null) throw alreadySettled();
          // R6: the step-up at the effect instant (rounded up: conservative for its expiry); the coverage end is advisory here (the
          // apply's microsecond judgment binds); R7: both again at COMMIT
          const at = await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          if (inFuture(settlement.periodEnd, at) || inFuture(settlement.observedAt, at) || (receipt !== null && (inFuture(receipt.bookedAt, at) || inFuture(receipt.observedAt, at)))) {
            throw precondition("COVERAGE_END_IN_FUTURE", "the settlement evidence states an instant after the effect instant");
          }
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          // R8: the intent (the person and the database clock stamped by the table), its recorded.v1 and the journal; no money
          const requestId = uow.ids.next();
          const { requestedAt } = await repo.insertRequest({
            requestId,
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
            observedAt: settlement.observedAt,
            normalizerVersion: evidence.normalizerVersion,
            receipt:
              receipt === null || body.receipt === null
                ? null
                : {
                    artifactRef: body.receipt.artifactRef,
                    evidenceHash: receipt.evidenceHash,
                    receivingAccountRef: receipt.accountRef,
                    bankTransactionId: receipt.bankTransactionId,
                    receivedCents: receipt.receivedCents,
                    bankAvailableCents: receipt.bankAvailableCents,
                    bookedAt: receipt.bookedAt,
                    observedAt: receipt.observedAt,
                  },
          });
          await uow.events.publish({
            aggregateKind: "settlement_request" as never,
            aggregateId: requestId as never,
            aggregateVersion: 1,
            agencyId: null,
            eventType: "settlement_request.recorded.v1" as never,
            actor: actorOf(uow.context as OperatorContext),
            causationId,
            correlationId: envelope.correlationId,
            payload: { requestId, evidenceHash: settlement.evidenceHash },
          });
          const view: SettlementRequestCommandView = { settlementRequest: { requestId, accountRef, withdrawalId: settlement.withdrawalId, state: "RECORDED", requestedAt } };
          return { status: 201, view, version: 1, resourceKind: "settlement_request", resourceId: requestId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    get: (request) =>
      ownerRead(request, "READ_BANK_SETTLEMENT", async (uow, environment) => {
        const read = await co.settlements(uow).outcomeOf(environment, request.accountRef, request.requestId);
        if (read === null) throw new NotFoundFailure("settlement request");
        const r = read.request;
        const settlementRequest: SettlementRequestView = {
          requestId: r.requestId,
          accountRef: r.accountRef,
          withdrawalId: r.withdrawalId,
          state: r.outcome ?? "RECORDED",
          reason: r.refusalReason,
          requestedAt: r.requestedAt,
          consumedAt: r.consumedAt,
          reviewCaseId: r.reviewCaseId,
          delivery: read.delivery,
          settlement: read.settlement === null ? null : settlementView(r.accountRef, read.settlement),
        };
        return { settlementRequest };
      }),

    list: (request) =>
      ownerRead(request, "READ_BANK_SETTLEMENT", async (uow, environment): Promise<SettlementInTransitView> => {
        const binding = { operation: IN_TRANSIT_OPERATION, userId: request.subject.identity.userId, agencyId: null, filter: `${environment}|${request.accountRef}` };
        let after: { readonly requestedAt: string; readonly requestId: string } | null = null;
        if (request.cursor !== null) {
          const position = openCursor(co.cursorKey, binding, request.cursor);
          if (position === null) throw new DomainFailure("INVALID_REQUEST", "the cursor was not issued for this list", { reason: "CURSOR_INVALID" });
          after = { requestedAt: position.createdAt, requestId: position.id };
        }
        // one row more than the page: a next page exists only when it has a row
        const rows = await co.settlements(uow).inTransit(environment, request.accountRef, after, SETTLEMENT_IN_TRANSIT_PAGE + 1);
        const page = rows.slice(0, SETTLEMENT_IN_TRANSIT_PAGE);
        const last = page[page.length - 1];
        const items = page.map((x): SettlementInTransitItemView => ({
          requestId: x.requestId,
          withdrawalId: x.withdrawalId,
          state: x.state,
          reason: x.reason,
          withdrawnCents: x.withdrawnCents.toString(),
          receivedCents: x.receivedCents === null ? null : x.receivedCents.toString(),
          feeCents: x.feeCents.toString(),
          requestedAt: x.requestedAt,
          ageSeconds: x.ageSeconds,
          delivery: x.delivery,
          reviewCaseId: x.reviewCaseId,
        }));
        return { items, nextCursor: rows.length > SETTLEMENT_IN_TRANSIT_PAGE && last !== undefined ? sealCursor(co.cursorKey, binding, { createdAt: last.requestedAt, id: last.requestId }) : null };
      }),
  };
}

// --- ST3 the payment service applies an intent (plan §3.3, SERVICE unit of kauro_payment) -------------------------------------------------

/** What the apply runs on, all of the payment service's own unit of work. */
export interface SettlementApplyPorts {
  readonly settlements: BankSettlementRepository;
  readonly lockStream: (environment: string, accountRef: string, stream: "INBOUND" | "OUTBOUND") => Promise<void>;
  /** The exact (µs) effect instant of the unit, read after its last lock wait (A6). */
  readonly effectNow: () => Promise<string>;
  /** The restricted store and classifier the apply re-reads (A1b); either null is CAPACITY_UNAVAILABLE (retried). */
  readonly evidence: SettlementEvidenceCollaborators;
}
export type SettlementApplyOutcome = "APPLIED" | "DUPLICATE" | "NOT_APPLICABLE";

const sameInstant = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

/** Whether the frozen facts of the intent are exactly what the re-classified artifacts state (A1b). */
function factsMatch(r: SettlementRequestRecord, v: VerifiedSettlement): boolean {
  const s = v.settlement;
  if (s.evidenceHash !== r.evidenceHash || s.currency !== r.currency || s.withdrawalId !== r.withdrawalId || s.grossCents !== r.grossCents || s.feeCents !== r.feeCents || s.heldCents !== r.heldCents || s.withdrawnCents !== r.withdrawnCents) return false;
  if (!sameInstant(s.periodStart, r.periodStart) || !sameInstant(s.periodEnd, r.periodEnd) || !sameInstant(s.observedAt, r.observedAt) || v.normalizerVersion !== r.normalizerVersion) return false;
  const x = v.receipt;
  const y = r.receipt;
  if (x === null || y === null) return x === null && y === null;
  return (
    x.evidenceHash === y.evidenceHash &&
    x.accountRef === y.receivingAccountRef &&
    x.bankTransactionId === y.bankTransactionId &&
    x.receivedCents === y.receivedCents &&
    x.bankAvailableCents === y.bankAvailableCents &&
    sameInstant(x.bookedAt, y.bookedAt) &&
    sameInstant(x.observedAt, y.observedAt)
  );
}

/** ADV-9: a cents figure into an event payload (a count: safe integers only); a bigint that Number() would round throws instead of publishing a wrong amount. */
function exactCents(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || BigInt(n) !== v) throw new DomainFailure("INTEGRITY_FAILURE", "a settlement figure does not fit an exact event count");
  return n;
}

/**
 * ST3: applies the owner's intent on delivery of its recorded.v1, in the payment service's unit of work. A1 the intent (absent:
 * NOT_APPLICABLE; consumed: DUPLICATE); A1b its artifacts re-read and re-classified outside the locks (an unbound store is
 * CAPACITY_UNAVAILABLE and propagates: retried; any other refusal, or a frozen fact the bytes do not state, is EVIDENCE_MISMATCH); A2 L1
 * OUTBOUND, A3 INBOUND, A4 the payout cash lock, A5 the intent's row (never waits: every writer of it holds A2-A4); A6 the exact effect
 * instant; A7 the refusals in order; A8 the settlement, its event, its posting set, the intent APPLIED and the earlier refusals' cases
 * resolved. A refusal writes its review case, the intent REFUSED and refused.v1, and is the delivery's applied outcome.
 */
export async function applySettlementRequest(uow: CommerceUnitOfWork, ports: SettlementApplyPorts, delivery: { readonly eventId: string; readonly requestId: string }): Promise<SettlementApplyOutcome> {
  const repo = ports.settlements;
  const seen = await repo.requestOf(delivery.requestId);
  if (seen === null) return "NOT_APPLICABLE";
  if (seen.consumedAt !== null) return "DUPLICATE";
  // A1b: the facts are immutable (forbid_column_change), so this verdict, reached outside the locks, cannot go stale
  let mismatch: boolean;
  try {
    const verified = await readSettlementEvidence(ports.evidence, seen.accountRef, seen.environment, { artifactRef: seen.artifactRef, evidenceHash: seen.evidenceHash, receipt: seen.receipt === null ? null : { artifactRef: seen.receipt.artifactRef, evidenceHash: seen.receipt.evidenceHash } });
    mismatch = !factsMatch(seen, verified);
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "CAPACITY_UNAVAILABLE" || e.code === "INTERNAL_ERROR") throw e;
    mismatch = true;
  }
  await ports.lockStream(seen.environment, seen.accountRef, "OUTBOUND");
  await ports.lockStream(seen.environment, seen.accountRef, "INBOUND");
  await repo.lockFunds();
  const request = await repo.lockRequest(delivery.requestId);
  if (request === null || request.consumedAt !== null) return "DUPLICATE";
  const at = await ports.effectNow();
  const receipt = request.receipt;
  // A7: the refusals, in order
  let reason: SettlementRefusalReason | null = mismatch ? "EVIDENCE_MISMATCH" : await repo.timeRefusal(request.requestId, at, SETTLEMENT_REQUEST_STALE_SECONDS);
  const route = await repo.routeOfAccount(request.environment, request.accountRef);
  if (route === null) throw new DomainFailure("INTEGRITY_FAILURE", "the intent's account has no bank route");
  if (reason === null && route.currency !== request.currency) reason = "CURRENCY_MISMATCH";
  const receiptIdentity = receipt === null ? null : { receivingAccountRef: receipt.receivingAccountRef, bankTransactionId: receipt.bankTransactionId };
  if (reason === null && (await repo.settledAs(request.environment, request.accountRef, request.withdrawalId, receiptIdentity)) !== null) reason = "WITHDRAWAL_ALREADY_SETTLED";
  // D-SET-5: no settlement of imaginary liquidity, the balance read under the payout cash lock
  if (reason === null && request.withdrawnCents + request.feeCents > (await repo.providerAvailableCents(route.paymentRouteId, request.currency))) reason = "FUNDS_UNAVAILABLE";
  const context = uow.context;
  if (context.kind === "ANONYMOUS") throw new DomainFailure("INTEGRITY_FAILURE", "a settlement apply is never anonymous");
  const causationId = delivery.eventId as unknown as CausationId;
  if (reason !== null) {
    const caseId = uow.ids.next();
    await repo.openRefusalCase(caseId, request, reason);
    await repo.refuse(request.requestId, reason, caseId);
    await uow.events.publish({
      aggregateKind: "settlement_request" as never,
      aggregateId: request.requestId as never,
      aggregateVersion: 2,
      agencyId: null,
      eventType: "settlement_request.refused.v1" as never,
      actor: actorOf(context),
      causationId,
      correlationId: context.correlationId,
      payload: { requestId: request.requestId, reason, reviewCaseId: caseId, withdrawnCents: exactCents(request.withdrawnCents), receivedCents: exactCents(receipt?.receivedCents ?? 0n), feeCents: exactCents(request.feeCents) },
    });
    return "APPLIED";
  }
  // A8: the settlement copies its intent (0071 settlements_request_birth), its event, its posting set (D-SET-6), the intent APPLIED
  const settlementId = uow.ids.next();
  const observedAt = receipt?.observedAt ?? request.observedAt;
  const receivedCents = receipt?.receivedCents ?? null;
  await repo.insert({
    settlementId,
    requestId: request.requestId,
    paymentRouteId: route.paymentRouteId,
    bankRouteId: route.bankRouteId,
    environment: request.environment,
    accountRef: request.accountRef,
    withdrawalId: request.withdrawalId,
    artifactRef: request.artifactRef,
    evidenceHash: request.evidenceHash,
    currency: request.currency,
    grossCents: request.grossCents,
    feeCents: request.feeCents,
    heldCents: request.heldCents,
    withdrawnCents: request.withdrawnCents,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    observedAt,
    normalizerVersion: request.normalizerVersion,
    recordedBy: request.requestedBy,
    receipt:
      receipt === null
        ? null
        : { receivingAccountRef: receipt.receivingAccountRef, bankTransactionId: receipt.bankTransactionId, artifactRef: receipt.artifactRef, evidenceHash: receipt.evidenceHash, receivedCents: receipt.receivedCents, bankAvailableCents: receipt.bankAvailableCents },
    createdAt: at,
  });
  await uow.events.publish({
    aggregateKind: "settlement" as never,
    aggregateId: settlementId as never,
    aggregateVersion: 1,
    agencyId: null,
    eventType: "settlement.recorded.v1" as never,
    actor: actorOf(context),
    causationId,
    correlationId: context.correlationId,
    payload: { settlementId, withdrawnCents: exactCents(request.withdrawnCents), feeCents: exactCents(request.feeCents), receivedCents: exactCents(receivedCents ?? 0n), bankEvidence: receipt !== null },
  });
  await uow.commerce.ledger.post(
    {
      agencyId: null,
      source: { kind: "SETTLEMENT", settlementId: settlementId as unknown as SettlementId },
      sourceKind: "SETTLEMENT",
      sourceRef: settlementId,
      currency: request.currency,
      effectiveAt: (receipt?.bookedAt ?? request.periodEnd) as UtcInstant,
      observedAt: observedAt as UtcInstant,
      evidenceHash: (receipt?.evidenceHash ?? request.evidenceHash) as Sha256Hex,
      lines: settlementPostings(request.withdrawnCents, request.feeCents, receivedCents ?? 0n),
    },
    at as UtcInstant,
  );
  await repo.markApplied(request.requestId, settlementId);
  await uow.events.publish({
    aggregateKind: "settlement_request" as never,
    aggregateId: request.requestId as never,
    aggregateVersion: 2,
    agencyId: null,
    eventType: "settlement_request.applied.v1" as never,
    actor: actorOf(context),
    causationId,
    correlationId: context.correlationId,
    payload: { requestId: request.requestId, settlementId },
  });
  // the apply decided the withdrawal: the open cases of its earlier refused intents are resolved
  await repo.resolveRefusedCases(request.environment, request.accountRef, request.withdrawalId);
  return "APPLIED";
}

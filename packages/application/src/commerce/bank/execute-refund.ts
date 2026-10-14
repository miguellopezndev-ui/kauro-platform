/**
 * The manual execution of a bank-route refund (Payments V1, lane L-REFUND slice 2; docs/design/ACH-ROUTE.md r12 §7.21-§7.22d, DV1-08, D-24 A):
 * the corporate owner declares the transfer the owner is about to send (X1), records the send receipt that proves it was sent (G2 for a
 * RETURN, G4 for a RESEND), and reads the queue of what to send. Every command runs in units of work of the payment service (kauro_payment).
 *
 *   X1  CMD221 DeclareRefundExecution  one unit: the source located (CAPTURE: the refund's scope adopted, the account of its transfer
 *       instructions; BANK_CREDIT: the treasury row), L1 (the account's OUTBOUND stream lock), the owner's authority at the database clock,
 *       the owner's journal entry, L2 (the source booking lock), the refund's row, then NEVER-RESEND (an open attempt of the source refuses
 *       EXECUTION_ATTEMPT_OPEN), the captured destination, the version, APPROVED, the exact approved amount; then the refund → SUBMITTING,
 *       the DECLARED attempt (reference kauro-refund-<id>-<n>, the destination fingerprint copied from the captured row), its event, ALLOW.
 *   G2  CMD222 RecordExecution         unit 1 (Koffer): L1, the authority, the attempt's lock, the durable offer of this key (another body
 *       under the key is BODY_CONFLICT); COMMIT. Then the execution artifact read from the restricted store under the provider-call bound,
 *       outside any unit. Unit 2 (the outcome): L1, the authority again, L2, the attempt, the gate over the bytes actually read (hash,
 *       account, classification) and the predicates (E-ID, E-AMT, E-TIME, E-REF, the destination proof); a refusal commits the offer's
 *       REVIEW outcome and its review case and answers the refusal; a proof commits the RECORDED outcome, the RECORDED attempt, its event,
 *       the refund's completion (CAPTURE RETURN: refund COMPLETED citing the execution, the live entitlement revoked when the service is fully
 *       refunded; BANK_CREDIT: treasury refund COMPLETED) and the owner's journal response. A RECORDED refund always cites a RECORDED attempt
 *       (KP014), so a refund is never COMPLETED without the evidence of its execution.
 *   X3  CMD223 ResolveUncertainExecution  the owner's resolution of an UNCERTAIN attempt (D-24 A). EXECUTED: the G2/G4 path above with the
 *       offer command RESOLVE_EXECUTED, admitted only while the attempt is UNCERTAIN (else REFUND_NOT_UNCERTAIN). NOT_EXECUTED: one unit
 *       under L1 -> L2 -> L3: the authority, the journal, then UNCERTAIN, no execution offer of the attempt (CORR-OFFERED: CONTRADICTORY_EVIDENCE),
 *       NX-LAG (effectNow >= declaredAt + window + coverageLag, else NOT_EXECUTED_TOO_EARLY), NX-COVERAGE (the imported OUTBOUND coverage is
 *       contiguous over [declaredAt, effectNow - coverageLag], else COVERAGE_INCOMPLETE) and NX-NO-POTENTIAL (no debit of that interval
 *       correlated with the attempt: CONTRADICTORY_EVIDENCE; every other one explained by another RECORDED attempt, else UNEXPLAINED_DEBIT);
 *       then the attempt NOT_EXECUTED and, for a RETURN, its refund FAILED owner_attested_no_effect (the share released), the
 *       UNCERTAIN_EFFECT case resolved, the ALLOW fact and the journal's answer. Nothing is ever re-sent (NEVER-RESEND).
 *   The queue: the DECLARED attempts with what to send (last four and holder only), for the corporate owner (kauro_app, OPERATOR).
 *
 * GAP (reported): the cookie-session fence of rule 16 is not taken in these SERVICE units (see approve-destination.ts).
 * DP-RECIPIENT (DV1-10, DV1-11): X1/X4 may bind a provider recipient record (id + version) with its recipient-record artifact, read outside any
 * unit and re-verified by hash under the locks; its full details must give exactly the captured fingerprint, else RECIPIENT_ALIAS. G2/G4/X3
 * then accept, without full details, a receipt carrying the same recipient id AND version; anything weaker stays DESTINATION_UNPROVEN.
 */
import type { CommandId, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { rawDigest } from "@kauro/contracts";
import type { AgencyId, CausationId, FailureReason, CommerceUnitOfWork, CommerceUnitOfWorkFactory, CorrelationId, OperatorContext, OutboundEvidence, RefundId, ServiceContext, UserId } from "@kauro/domain";
import {
  COMMERCE_POLICY_VERSION,
  DomainFailure,
  NotFoundFailure,
  PROVIDER_CALL_TIMEOUT_MS,
  StaleVersionFailure,
  actorOf,
  beforeCommitOf,
  commandRequestDigest,
  componentsTotal,
  formatMoney,
  InvalidRequestFailure,
  isUuid,
  normalizeDestination,
  outboundReference,
  revocationPhaseOf,
  toUtcInstant,
} from "@kauro/domain";
import { judgedUnderHold, type RequestAuthority } from "../../api/authority.js";
import type { AuthenticatedSubject, CommandResult } from "../../api/envelope.js";
import { problemOf, type Problem } from "../../api/problems.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { STEP_UP_FRESHNESS_SECONDS } from "../../ports/assurance-and-admission.js";
import type { DestinationFingerprinter, StoredBankEvidence } from "../ports.js";
import { CommerceAccessDenied, DENIAL_CODES, recordCommerceDenial, resultOf } from "../request/runtime.js";
import { BANK_REFUND_COMMAND_IDS, approveTreasuryHandler, freshAt, integrity, stepUpStale, verdictFailure, type ApproveTreasuryRefundBody, type OwnerRefundDependencies, type TreasuryRefundView } from "./approve-destination.js";
import type { BankCreditClassifier, BankRefundRepository, BankRouteCollaborators, CapturedDestination, ExecutionAttemptRecord, ExecutionGateOutcomeName, ExecutionOfferCommandName, ExecutionOfferRecord, OwnerAuthorityVerdict } from "./ports.js";
import { evidenceUnavailable, type BankRouteRequest } from "./route-config.js";

// --- requests and views ---------------------------------------------------------------------------------------------------------------

/** DP-RECIPIENT at X1/X4: the provider recipient record the owner binds, and the stored recipient-record artifact that proves it. */
export interface RecipientBindingBody {
  readonly recipientRef: string;
  readonly recipientVersion: string;
  readonly artifactRef: string;
  readonly evidenceHash: string;
}
export interface DeclareRefundExecutionBody {
  readonly expectedVersion: number;
  readonly amountCents: string;
  readonly recipient?: RecipientBindingBody;
  readonly authorizationRef: string;
}
export interface ResolveExecutionBody {
  readonly outcome: "EXECUTED" | "NOT_EXECUTED";
  readonly evidence?: { readonly artifactRef: string; readonly evidenceHash: string };
  readonly authorizationRef: string;
}
/** X3's answer: the attempt and the refund after the resolution, and the offer of this key (EXECUTED; null for NOT_EXECUTED). */
export interface ResolveExecutionView {
  readonly attempt: ExecutionAttemptView;
  readonly refund: RefundStateView | null;
  readonly offerId: string | null;
}
export interface RecordBounceBody {
  readonly bouncedCents: string;
  readonly evidence: { readonly artifactRef: string; readonly evidenceHash: string };
  readonly authorizationRef: string;
}
export interface DeclareResendBody {
  readonly amountCents: string;
  readonly recipient?: RecipientBindingBody;
  readonly authorizationRef: string;
}
/** G3's answer: the bounced attempt (still RECORDED), the bounce's cents and the open REFUND_PAYABLE it leaves. */
export interface RecordBounceView {
  readonly attempt: ExecutionAttemptView;
  readonly bounce: { readonly bounceId: string; readonly bouncedCents: string; readonly payableCents: string };
}
export interface RecordExecutionBody {
  readonly evidence: { readonly artifactRef: string; readonly evidenceHash: string };
  readonly authorizationRef: string;
}
export interface ExecutionAttemptView {
  readonly attemptId: string;
  readonly kind: "RETURN" | "RESEND";
  readonly state: "DECLARED" | "UNCERTAIN" | "RECORDED" | "NOT_EXECUTED";
  readonly reference: string;
  readonly amountCents: string;
  readonly currency: "USD";
  readonly declaredAt: string;
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly sourceId: string;
  readonly destination: { readonly accountLast4: string; readonly holderName: string };
  readonly bankExecutionId: string | null;
}
export interface RefundStateView {
  readonly state: string;
  readonly version: number;
}
export interface DeclareExecutionView {
  readonly attempt: ExecutionAttemptView;
  readonly refund: RefundStateView | null;
}
export interface RecordExecutionView {
  readonly attempt: ExecutionAttemptView;
  readonly refund: RefundStateView | null;
  readonly offerId: string;
}
export interface ExecutionQueueItemView {
  readonly attemptId: string;
  readonly kind: "RETURN" | "RESEND";
  readonly state: string;
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly amountCents: string;
  readonly currency: "USD";
  readonly reference: string;
  readonly declaredAt: string;
  readonly destination: { readonly accountLast4: string; readonly holderName: string };
}
export interface ExecutionQueueView {
  readonly data: { readonly items: ReadonlyArray<ExecutionQueueItemView> };
}
export interface ExecutionQueueRequest {
  readonly correlationId: CorrelationId;
  readonly subject: AuthenticatedSubject;
  readonly authority?: RequestAuthority;
}

export interface BankRefundHandlers {
  approveTreasury(request: BankRouteRequest<ApproveTreasuryRefundBody>): Promise<CommandResult<TreasuryRefundView>>;
  declareExecution(request: BankRouteRequest<DeclareRefundExecutionBody>): Promise<CommandResult<DeclareExecutionView>>;
  recordBounce(request: BankRouteRequest<RecordBounceBody>): Promise<CommandResult<RecordBounceView>>;
  declareResend(request: BankRouteRequest<DeclareResendBody>): Promise<CommandResult<DeclareExecutionView>>;
  recordExecution(request: BankRouteRequest<RecordExecutionBody>): Promise<CommandResult<RecordExecutionView>>;
  resolveExecution(request: BankRouteRequest<ResolveExecutionBody>): Promise<CommandResult<ResolveExecutionView>>;
  executionQueue(request: ExecutionQueueRequest): Promise<{ readonly kind: "READ"; readonly view: ExecutionQueueView } | { readonly kind: "PROBLEM"; readonly problem: Problem }>;
}

/** The queue's bound: the DECLARED attempts, oldest first (a corporate owner's working list, never a report). */
export const EXECUTION_QUEUE_LIMIT = 500;

// --- shared plumbing ------------------------------------------------------------------------------------------------------------------

const precondition = (reason: FailureReason, message: string): DomainFailure => new DomainFailure("PRECONDITION_FAILED", message, { reason });
const notDeclared = (): DomainFailure => precondition("NO_DECLARED_ATTEMPT", "the attempt is not DECLARED or UNCERTAIN");

class Replayed {
  constructor(readonly status: 200 | 201, readonly view: unknown) {}
}
/** A refusal whose durable footprint (the offer's REVIEW outcome, its review case) commits before it is answered. */
class Refusal {
  constructor(readonly failure: DomainFailure) {}
}

interface Parts {
  readonly bank: BankRouteCollaborators;
  readonly payment: CommerceUnitOfWorkFactory;
  readonly refunds: (uow: CommerceUnitOfWork) => BankRefundRepository;
}
function partsOf(d: OwnerRefundDependencies): Parts {
  const bank = d.bank;
  if (bank === null || d.payment === null || bank.refunds === undefined) throw evidenceUnavailable();
  return { bank, payment: d.payment, refunds: bank.refunds };
}

/** Runs one owner command; a denial (ACCESS / ASSURANCE / NOT_AUTHORIZED) is recorded afterwards in its own SERVICE unit (agency NULL). */
async function ownerCommand<View>(d: OwnerRefundDependencies, operation: string, correlationId: CorrelationId, body: (context: ServiceContext, adopt: (agency: AgencyId | null) => void) => Promise<CommandResult<View>>): Promise<CommandResult<View>> {
  const context: ServiceContext = { kind: "SERVICE", serviceId: d.paymentServiceId, correlationId };
  let adopted: AgencyId | null = null;
  try {
    return await body(context, (agency) => {
      adopted = agency;
    });
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (DENIAL_CODES.has(e.code) && d.payment !== null) {
      const failure = e;
      await d.payment.run(context, async (uow) => {
        await uow.securityEvents.append({
          agencyId: null,
          requestedAgencyId: adopted,
          actor: actorOf(context),
          action: operation,
          outcome: "DENY",
          reasonCode: failure.details.reason ?? failure.code,
          policyVersion: COMMERCE_POLICY_VERSION,
          assuranceClass: failure.code === "ASSURANCE_REQUIRED" ? "STEP_UP" : "SESSION",
          correlationId,
          occurredAt: d.runtime.clock.now(),
        });
      });
    }
    return resultOf<View>(e, correlationId);
  }
}

/**
 * The owner's authority in the unit, after L1: the definer's verdict at the database clock (OK records the act every guard of the unit
 * requires), the step-up fresh at the effect clock, and the same judgment registered for the committed instant (immediately before COMMIT).
 */
async function ownerAuthority(bank: BankRouteCollaborators, uow: CommerceUnitOfWork, repo: BankRefundRepository, userId: string, proofId: string | null): Promise<OwnerAuthorityVerdict> {
  const verdict = await repo.ownerAuthority(userId, proofId, STEP_UP_FRESHNESS_SECONDS);
  const refused = verdictFailure(verdict);
  if (refused !== null) throw refused;
  if (!freshAt(verdict, await bank.effectNow(uow))) throw stepUpStale();
  beforeCommitOf(uow, async () => {
    if (!freshAt(verdict, await bank.effectNow(uow))) throw stepUpStale();
  });
  return verdict;
}

async function allowFact(uow: CommerceUnitOfWork, context: ServiceContext, operation: string, at: UtcInstant): Promise<void> {
  await uow.securityEvents.append({
    agencyId: null,
    requestedAgencyId: uow.commerceScope,
    actor: actorOf(context),
    action: operation,
    outcome: "ALLOW",
    reasonCode: ALLOW_REASONS.STEP_UP_FRESH,
    policyVersion: COMMERCE_POLICY_VERSION,
    assuranceClass: "STEP_UP",
    correlationId: context.correlationId,
    occurredAt: at,
  });
}

interface Journal {
  readonly identity: { readonly environment: BankRouteRequest<unknown>["environment"]; readonly actor: { readonly kind: "USER"; readonly userId: UserId }; readonly agencyId: null; readonly operation: CommandId; readonly key: string };
  readonly digest: Sha256Hex;
  readonly correlationId: CorrelationId;
}
function journalOf(operation: string, request: BankRouteRequest<{ readonly authorizationRef: string }>): Journal {
  const { authorizationRef: _proof, ...digested } = request.body;
  return {
    identity: { environment: request.environment, actor: { kind: "USER", userId: request.subject.identity.userId as UserId }, agencyId: null, operation: operation as CommandId, key: request.idempotencyKey },
    digest: commandRequestDigest({ operation: operation as CommandId, aggregate: request.path, body: digested }),
    correlationId: request.correlationId,
  };
}
/** The owner's journal entry: NEW (its id), or the journaled answer of the same key and body; another body is BODY_CONFLICT. */
async function reserve(uow: CommerceUnitOfWork, j: Journal): Promise<{ readonly entryId: string } | Replayed> {
  const reservation = await uow.journal.reserve(j.identity, j.digest, j.correlationId);
  if (reservation.kind === "REPLAY") {
    const status = reservation.entry.responseStatus;
    if ((status !== 200 && status !== 201) || reservation.entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
    return new Replayed(status, reservation.entry.responseBody);
  }
  if (reservation.kind === "CONFLICT") throw new DomainFailure("IDEMPOTENCY_CONFLICT", "idempotency key reused with a different request body", { reason: "BODY_CONFLICT" });
  if (reservation.kind === "PENDING") throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
  return { entryId: reservation.entryId as string };
}
async function answer<View>(uow: CommerceUnitOfWork, entryId: string, status: 200 | 201, view: View, resourceKind: string, resourceId: string): Promise<View> {
  const committed = await uow.journal.commit(entryId as never, { responseStatus: status, responseBody: view, resourceKind, resourceId });
  if (committed.state !== "COMMITTED" || committed.responseStatus !== status || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
  return committed.responseBody as View;
}

const withoutNulls = (payload: Readonly<Record<string, unknown>>): Record<string, unknown> => Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null && v !== undefined));

async function publishAttempt(uow: CommerceUnitOfWork, context: ServiceContext, causationId: CausationId, attempt: ExecutionAttemptRecord, eventType: "outbound.declared.v1" | "outbound.uncertain.v1" | "outbound.recorded.v1" | "outbound.not_executed.v1" | "outbound.bounced.v1" | "outbound.resent.v1", payload: Readonly<Record<string, unknown>>): Promise<void> {
  await uow.events.publish({
    aggregateKind: "outbound_execution_attempt",
    aggregateId: attempt.attemptId as never,
    aggregateVersion: attempt.version,
    agencyId: attempt.agencyId as AgencyId | null,
    eventType,
    actor: actorOf(context),
    causationId,
    correlationId: context.correlationId,
    payload: withoutNulls({ attemptId: attempt.attemptId, kind: attempt.kind, state: attempt.state, sourceKind: attempt.sourceKind, sourceId: attempt.sourceId, refundId: attempt.refundId, treasuryRefundId: attempt.treasuryRefundId, ...payload }),
  } as never);
}

async function publishTreasury(uow: CommerceUnitOfWork, context: ServiceContext, causationId: CausationId, row: { readonly treasuryRefundId: string; readonly version: number; readonly bankCreditId: string }, eventType: "treasury_refund.submitting.v1" | "treasury_refund.uncertain.v1" | "treasury_refund.completed.v1" | "treasury_refund.failed.v1", payload: Readonly<Record<string, unknown>>): Promise<void> {
  await uow.events.publish({
    aggregateKind: "treasury_refund",
    aggregateId: row.treasuryRefundId as never,
    aggregateVersion: row.version,
    agencyId: null,
    eventType,
    actor: actorOf(context),
    causationId,
    correlationId: context.correlationId,
    payload: withoutNulls({ treasuryRefundId: row.treasuryRefundId, bankCreditId: row.bankCreditId, ...payload }),
  } as never);
}

/** The X2 lapse and the X3 resolutions share these publications (apps/api payments/execution-window.ts). */
export { publishAttempt as publishAttemptEvent, publishTreasury as publishTreasuryRefundEvent };

export function attemptView(a: ExecutionAttemptRecord, destination: Pick<CapturedDestination, "accountLast4" | "holderName">): ExecutionAttemptView {
  return {
    attemptId: a.attemptId,
    kind: a.kind,
    state: a.state,
    reference: a.reference,
    amountCents: formatMoney(a.amountCents),
    currency: a.currency,
    declaredAt: a.declaredAt,
    sourceKind: a.sourceKind,
    sourceId: a.sourceId,
    destination: { accountLast4: destination.accountLast4, holderName: destination.holderName },
    bankExecutionId: a.bankExecutionId,
  };
}

/** The refund (CAPTURE) or treasury refund (BANK_CREDIT) an attempt executes: its id. */
const refundIdOf = (a: Pick<ExecutionAttemptRecord, "sourceKind" | "refundId" | "treasuryRefundId">): string => (a.sourceKind === "CAPTURE" ? a.refundId : a.treasuryRefundId)!;

/** L2: the source booking lock (CAPTURE: the capture's refund booking; BANK_CREDIT: the credit row). */
async function lockSource(repo: BankRefundRepository, a: Pick<ExecutionAttemptRecord, "sourceKind" | "sourceId">): Promise<void> {
  if (a.sourceKind === "CAPTURE") await repo.lockCaptureRefunds(a.sourceId);
  else if (!(await repo.lockBankCredit(a.sourceId))) throw new NotFoundFailure("bank credit");
}

// --- X1 CMD221 DeclareRefundExecution -------------------------------------------------------------------------------------------------

interface DeclaredSource {
  readonly scope: "CAPTURE" | "BANK_CREDIT";
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly sourceId: string;
  readonly agencyId: string | null;
}

// --- DP-RECIPIENT binding (X1, X4) ------------------------------------------------------------------------------------------------------

interface RecipientRead {
  readonly binding: RecipientBindingBody;
  readonly read: StoredBankEvidence | null;
  readonly expired: boolean;
  readonly classifier: BankCreditClassifier;
  readonly fingerprinter: DestinationFingerprinter;
}
const recipientAlias = (message: string): DomainFailure => precondition("RECIPIENT_ALIAS", message);

/** The recipient-record artifact read outside any unit under the provider-call bound (a failed or late read is unknown, never permission). */
async function readRecipient(bank: BankRouteCollaborators, binding: RecipientBindingBody | undefined): Promise<RecipientRead | null> {
  if (binding === undefined) return null;
  const store = bank.evidence();
  const fingerprinter = bank.fingerprinter?.() ?? null;
  const classifier = bank.creditClassifier?.() ?? null;
  if (store === null || fingerprinter === null || classifier === null) throw evidenceUnavailable();
  const bound = bank.timer.start(PROVIDER_CALL_TIMEOUT_MS);
  let read: StoredBankEvidence | null = null;
  try {
    const got = await Promise.race([store.get(binding.artifactRef).then((evidence) => ({ evidence }), () => null), bound.elapsed.then(() => null)]);
    read = got?.evidence ?? null;
  } finally {
    bound.cancel();
  }
  return { binding, read, expired: bound.expired?.() === true, classifier, fingerprinter };
}

/**
 * Under the declaration's locks: the bytes actually read are the named ones of this account, classify as a recipient record of the bound
 * id and version, and their full details normalize and give exactly the captured fingerprint under its own key id, key version and
 * normalizer version (DV1-11 canonical encoding). Anything else binds nothing: RECIPIENT_ALIAS (the concatenation-collision twin included).
 */
async function judgeRecipient(r: RecipientRead, account: { readonly environment: string; readonly accountRef: string }, destination: CapturedDestination): Promise<{ readonly recipientRef: string; readonly recipientVersion: string }> {
  const ev = r.read;
  if (r.expired || ev === null) throw evidenceUnavailable();
  if (ev.sha256 !== r.binding.evidenceHash || rawDigest(ev.bytes) !== ev.sha256) throw precondition("HASH_MISMATCH", "the recipient record is not the bytes the owner named");
  if (ev.accountRef !== account.accountRef || ev.environment !== account.environment) throw precondition("UNKNOWN_EVIDENCE", "the recipient record is of another account");
  const classified = r.classifier.classifyRecipient(ev);
  if (classified.kind !== "CLASSIFIED") throw refusalOf(classified.code);
  const x = classified.value;
  if (x.accountRef !== account.accountRef || x.recipientRef !== r.binding.recipientRef || x.recipientVersion !== r.binding.recipientVersion) throw recipientAlias("the artifact is not the recipient record and version being bound");
  const n = normalizeDestination(x.full);
  if (n.kind !== "OK") throw recipientAlias("the details of the recipient record do not normalize to a destination");
  const under = { keyId: destination.keyId, keyVersion: destination.keyVersion, normVersion: destination.normVersion };
  const fp = await r.fingerprinter.fingerprint({ routingNumber: n.routing, accountNumber: n.account, holderName: n.holder }, under);
  if (fp.fingerprint !== destination.fingerprint || fp.keyId !== destination.keyId || fp.keyVersion !== destination.keyVersion || fp.normVersion !== destination.normVersion) throw recipientAlias("the recipient record is another destination than the approved one");
  return { recipientRef: x.recipientRef, recipientVersion: x.recipientVersion };
}

function declareExecution(d: OwnerRefundDependencies, request: BankRouteRequest<DeclareRefundExecutionBody>): Promise<CommandResult<DeclareExecutionView>> {
  const operation = BANK_REFUND_COMMAND_IDS.declareExecution;
  const refundId = request.path["refundId"]!;
  const userId = request.subject.identity.userId as UserId;
  const body = request.body;
  return ownerCommand<DeclareExecutionView>(d, operation, request.correlationId, async (context, adopt) => {
    const { bank, payment, refunds } = partsOf(d);
    const amount = BigInt(body.amountCents);
    const journal = journalOf(operation, request);
    const proofId = isUuid(body.authorizationRef) ? body.authorizationRef : null;
    const recipient = await readRecipient(bank, body.recipient);
    const out = await payment.run(context, async (uow): Promise<{ readonly view: DeclareExecutionView } | Replayed> => {
      const repo = refunds(uow);
      const c = uow.commerce;
      // 1. the source (a treasury refund by its id, else the agency refund whose scope is adopted), then L1 and the owner's authority
      const treasury = await repo.treasuryRefund(refundId);
      let source: DeclaredSource;
      if (treasury !== null) source = { scope: "BANK_CREDIT", environment: treasury.environment, accountRef: treasury.accountRef, sourceId: treasury.bankCreditId, agencyId: null };
      else {
        if ((await uow.adoptScope("REFUND", refundId as RefundId)) === null) throw new NotFoundFailure("refund");
        adopt(uow.commerceScope);
        const seen = await c.refunds.get(refundId as RefundId);
        if (seen === null) throw new NotFoundFailure("refund");
        const instructions = await bank.routes(uow).instructionsOf(seen.orderId);
        if (instructions === null) throw integrity("DESTINATION_UNPROVEN", "the refunded capture was not paid by bank transfer");
        source = { scope: "CAPTURE", environment: instructions.environment, accountRef: instructions.accountRef, sourceId: seen.captureId, agencyId: seen.agencyId };
      }
      await repo.lockOutboundStream(source.environment, source.accountRef);
      const verdict = await ownerAuthority(bank, uow, repo, userId, proofId);
      const reservation = await reserve(uow, journal);
      if (reservation instanceof Replayed) return reservation;
      // 2. L2, then the refund's row (L3)
      await lockSource(repo, { sourceKind: source.scope, sourceId: source.sourceId });
      let current: { readonly state: string; readonly version: number; readonly total: bigint | null };
      if (source.scope === "CAPTURE") {
        const r = (await c.refunds.lock(refundId as RefundId)) ?? (await c.refunds.get(refundId as RefundId));
        if (r === null) throw new NotFoundFailure("refund");
        current = { state: r.state, version: r.version, total: r.approved === undefined ? null : componentsTotal(r.approved.amounts) };
      } else {
        const t = await repo.lockTreasuryRefund(refundId);
        if (t === null) throw new NotFoundFailure("treasury refund");
        current = { state: t.state, version: t.version, total: t.amountCents };
      }
      await bank.hold?.("bank:declare-locked");
      if (await repo.isFrozen(source.scope, source.sourceId)) throw precondition("EXECUTION_FROZEN", "a debit contradicted a terminal attempt of this source");
      // 3. NEVER-RESEND first: an open attempt of the source refuses whatever else the request says
      if ((await repo.openAttemptOf(source.scope, source.sourceId)) !== null) throw precondition("EXECUTION_ATTEMPT_OPEN", "an execution attempt of this source is DECLARED or UNCERTAIN");
      const destination = await repo.destinationOf(source.scope, refundId);
      if (destination === null) throw precondition("DESTINATION_NOT_CAPTURED", "the refund was approved without its destination captured");
      if (current.version !== body.expectedVersion) throw new StaleVersionFailure(current.version, current.state);
      if (current.state !== "APPROVED") throw precondition("REFUND_NOT_APPROVED", "the refund is not APPROVED");
      if (current.total === null || current.total !== amount) throw precondition("EXECUTION_AMOUNT_MISMATCH", "the declared amount is not the approved amount");
      const bound = recipient === null ? null : await judgeRecipient(recipient, source, destination);
      const attemptNumber = await repo.nextAttemptNumber(source.scope, source.sourceId);
      const at = await bank.effectNow(uow);
      // no await between this instant and its judgment
      if (!freshAt(verdict, at)) throw stepUpStale();
      const causationId = reservation.entryId as string as CausationId;
      // 4. the refund → SUBMITTING, the DECLARED attempt, their events, the ALLOW fact, the journal's response
      let refundState: RefundStateView;
      let treasuryMoved: { readonly treasuryRefundId: string; readonly version: number; readonly bankCreditId: string; readonly previousState: string } | null = null;
      if (source.scope === "CAPTURE") {
        const w = await c.refunds.transition(refundId as RefundId, current.version, { state: "SUBMITTING" }, at);
        if (w.kind === "STALE") throw new StaleVersionFailure(w.currentVersion, w.currentState);
        refundState = { state: w.record.state, version: w.record.version };
      } else {
        const t = await repo.transitionTreasuryRefund(refundId, current.version, "SUBMITTING");
        if (t === null) throw new StaleVersionFailure(current.version, current.state);
        treasuryMoved = t;
        refundState = { state: t.state, version: t.version };
      }
      const attempt = await repo.insertAttempt({
        attemptId: uow.ids.next() as string,
        environment: source.environment,
        accountRef: source.accountRef,
        kind: "RETURN",
        sourceKind: source.scope,
        agencyId: source.agencyId,
        captureId: source.scope === "CAPTURE" ? source.sourceId : null,
        refundId: source.scope === "CAPTURE" ? refundId : null,
        bankCreditId: source.scope === "BANK_CREDIT" ? source.sourceId : null,
        treasuryRefundId: source.scope === "BANK_CREDIT" ? refundId : null,
        attemptNumber,
        reference: outboundReference(refundId, attemptNumber),
        amountCents: amount,
        declaredAt: at,
        declaredBy: userId,
        destinationFingerprint: destination.fingerprint,
        keyId: destination.keyId,
        keyVersion: destination.keyVersion,
        normVersion: destination.normVersion,
        recipientRef: bound?.recipientRef ?? null,
        recipientVersion: bound?.recipientVersion ?? null,
      });
      if (treasuryMoved !== null) await publishTreasury(uow, context, causationId, treasuryMoved, "treasury_refund.submitting.v1", { attemptId: attempt.attemptId, previousState: treasuryMoved.previousState });
      await publishAttempt(uow, context, causationId, attempt, "outbound.declared.v1", { attemptNumber: attempt.attemptNumber, amountCents: Number(attempt.amountCents), declaredAt: attempt.declaredAt, destinationFingerprint: attempt.destinationFingerprint });
      await allowFact(uow, context, operation, at);
      const view: DeclareExecutionView = { attempt: attemptView(attempt, destination), refund: refundState };
      return { view: await answer(uow, reservation.entryId, 201, view, "outbound_execution_attempt", attempt.attemptId) };
    });
    if (out instanceof Replayed) {
      const view = out.view as DeclareExecutionView;
      return { kind: "COMPLETED", status: out.status, view, version: view.refund?.version ?? 1, replayed: true };
    }
    return { kind: "COMPLETED", status: 201, view: out.view, version: out.view.refund?.version ?? 1, replayed: false };
  });
}

// --- G3 CMD224 RecordReturnBounce -----------------------------------------------------------------------------------------------------

function recordBounce(d: OwnerRefundDependencies, request: BankRouteRequest<RecordBounceBody>): Promise<CommandResult<RecordBounceView>> {
  const operation = BANK_REFUND_COMMAND_IDS.recordBounce;
  const attemptId = request.path["attemptId"]!;
  const userId = request.subject.identity.userId as UserId;
  const body = request.body;
  return ownerCommand<RecordBounceView>(d, operation, request.correlationId, async (context, adopt) => {
    const { bank, payment, refunds } = partsOf(d);
    const store = bank.evidence();
    const classifier = bank.creditClassifier?.() ?? null;
    if (store === null || classifier === null) throw evidenceUnavailable();
    const journal = journalOf(operation, request);
    const proofId = isUuid(body.authorizationRef) ? body.authorizationRef : null;
    const bounced = BigInt(body.bouncedCents);
    // the evidence is read outside any unit under the provider-call bound (a failed or late read is unknown, never permission)
    const bound = bank.timer.start(PROVIDER_CALL_TIMEOUT_MS);
    let read: StoredBankEvidence | null = null;
    try {
      const got = await Promise.race([store.get(body.evidence.artifactRef).then((evidence) => ({ evidence }), () => null), bound.elapsed.then(() => null)]);
      read = got?.evidence ?? null;
    } finally {
      bound.cancel();
    }
    const expired = bound.expired?.() === true;
    await bank.hold?.("bank:gate-read");
    const out = await payment.run(context, async (uow): Promise<{ readonly view: RecordBounceView } | Replayed> => {
      const repo = refunds(uow);
      // 1. the attempt's scope, L1, the owner's authority, the journal
      const seen = await repo.attempt(attemptId);
      if (seen === null) throw new NotFoundFailure("execution attempt");
      if (seen.sourceKind === "CAPTURE") {
        if ((await uow.adoptScope("REFUND", seen.refundId as RefundId)) === null) throw new NotFoundFailure("execution attempt");
        adopt(uow.commerceScope);
      }
      await repo.lockOutboundStream(seen.environment, seen.accountRef);
      const verdict = await ownerAuthority(bank, uow, repo, userId, proofId);
      const reservation = await reserve(uow, journal);
      if (reservation instanceof Replayed) return reservation;
      // 2. L2, then the attempt (L3)
      await lockSource(repo, seen);
      const attempt = await repo.lockAttempt(attemptId);
      if (attempt === null) throw new NotFoundFailure("execution attempt");
      if (attempt.state !== "RECORDED") throw precondition("ATTEMPT_NOT_RECORDED", "only a RECORDED transfer can bounce");
      if ((await repo.bounceOf(attemptId)) !== null) throw precondition("BOUNCE_ALREADY_RECORDED", "the bounce of this transfer is already recorded");
      // 3. the bytes actually read: the evidence of the same transfer coming back, B > 0 and B <= P
      if (expired || read === null) throw evidenceUnavailable();
      if (read.sha256 !== body.evidence.evidenceHash || rawDigest(read.bytes) !== read.sha256) throw precondition("HASH_MISMATCH", "the evidence is not the bytes the owner named");
      if (read.accountRef !== attempt.accountRef || read.environment !== attempt.environment) throw precondition("UNKNOWN_EVIDENCE", "the evidence is of another account");
      const classified = classifier.classifyOutbound(read);
      if (classified.kind !== "CLASSIFIED") throw refusalOf(classified.code);
      const x = classified.value;
      if (x.accountRef !== attempt.accountRef || x.status !== "BOUNCED") throw precondition("UNKNOWN_EVIDENCE", "the evidence does not show the transfer coming back");
      if (x.bankExecutionId !== attempt.bankExecutionId) throw precondition("EXECUTION_ID_INVALID", "the evidence is of another transfer");
      if (bounced <= 0n || bounced > attempt.amountCents || x.returnedCents === null || x.returnedCents !== bounced || x.currency !== attempt.currency) {
        throw precondition("EXECUTION_AMOUNT_MISMATCH", "the returned cents are not the bounced cents or exceed the transfer");
      }
      const destination = await repo.destinationOf(attempt.sourceKind, refundIdOf(attempt));
      if (destination === null) throw new DomainFailure("INTEGRITY_FAILURE", "a recorded attempt without the destination it was declared to");
      const at = await bank.effectNow(uow);
      // no await between this instant and its judgment
      if (!freshAt(verdict, at)) throw stepUpStale();
      const causationId = reservation.entryId as string as CausationId;
      // 4. the bounce row, the attempt's version, the event, the RETURN_BOUNCED case, the ALLOW fact, the journal's response
      const bounceId = uow.ids.next() as string;
      await repo.insertBounce({ bounceId, attempt, bouncedCents: bounced, evidenceHash: read.sha256, recordedBy: userId });
      const moved = await repo.bounceAttempt(attempt.attemptId, attempt.version);
      if (moved === null) throw new StaleVersionFailure(attempt.version, attempt.state);
      await publishAttempt(uow, context, causationId, moved, "outbound.bounced.v1", { bounceId, bouncedCents: Number(bounced), evidenceHash: read.sha256 });
      await repo.openCaseIfNone({ caseId: uow.ids.next() as string, kind: "RETURN_BOUNCED", environment: attempt.environment, accountRef: attempt.accountRef, attemptId: attempt.attemptId, sourceKind: attempt.sourceKind, sourceId: attempt.sourceId, detailCode: "RETURN_BOUNCED", evidenceHash: read.sha256 });
      await allowFact(uow, context, operation, at);
      const view: RecordBounceView = { attempt: attemptView(moved, destination), bounce: { bounceId, bouncedCents: formatMoney(bounced), payableCents: formatMoney(await repo.bouncePayable(bounceId)) } };
      return { view: await answer(uow, reservation.entryId, 200, view, "outbound_execution_attempt", moved.attemptId) };
    });
    const view = out.view as RecordBounceView;
    return out instanceof Replayed ? { kind: "COMPLETED", status: out.status, view, version: 1, replayed: true } : { kind: "COMPLETED", status: 200, view, version: 1, replayed: false };
  });
}

// --- X4 CMD225 DeclareResendExecution ---------------------------------------------------------------------------------------------------

function declareResend(d: OwnerRefundDependencies, request: BankRouteRequest<DeclareResendBody>): Promise<CommandResult<DeclareExecutionView>> {
  const operation = BANK_REFUND_COMMAND_IDS.declareResend;
  const attemptId = request.path["attemptId"]!;
  const userId = request.subject.identity.userId as UserId;
  const body = request.body;
  return ownerCommand<DeclareExecutionView>(d, operation, request.correlationId, async (context, adopt) => {
    const { bank, payment, refunds } = partsOf(d);
    const amount = BigInt(body.amountCents);
    const journal = journalOf(operation, request);
    const proofId = isUuid(body.authorizationRef) ? body.authorizationRef : null;
    const recipient = await readRecipient(bank, body.recipient);
    const out = await payment.run(context, async (uow): Promise<{ readonly view: DeclareExecutionView } | Replayed> => {
      const repo = refunds(uow);
      const c = uow.commerce;
      // 1. the bounced attempt's scope, L1, the owner's authority, the journal
      const seen = await repo.attempt(attemptId);
      if (seen === null) throw new NotFoundFailure("execution attempt");
      if (seen.sourceKind === "CAPTURE") {
        if ((await uow.adoptScope("REFUND", seen.refundId as RefundId)) === null) throw new NotFoundFailure("execution attempt");
        adopt(uow.commerceScope);
      }
      await repo.lockOutboundStream(seen.environment, seen.accountRef);
      const verdict = await ownerAuthority(bank, uow, repo, userId, proofId);
      const reservation = await reserve(uow, journal);
      if (reservation instanceof Replayed) return reservation;
      // 2. L2, then the bounced attempt (L3)
      await lockSource(repo, seen);
      const attempt = await repo.lockAttempt(attemptId);
      if (attempt === null) throw new NotFoundFailure("execution attempt");
      await bank.hold?.("bank:declare-locked");
      if (await repo.isFrozen(attempt.sourceKind, attempt.sourceId)) throw precondition("EXECUTION_FROZEN", "a debit contradicted a terminal attempt of this source");
      // 3. NEVER-RESEND first: an open attempt of the source refuses whatever else the request says
      if ((await repo.openAttemptOf(attempt.sourceKind, attempt.sourceId)) !== null) throw precondition("EXECUTION_ATTEMPT_OPEN", "an execution attempt of this source is DECLARED or UNCERTAIN");
      // 4. a recorded bounce with an open payable, the amount within it
      const bounce = attempt.state === "RECORDED" ? await repo.bounceOf(attempt.attemptId) : null;
      const payable = bounce === null ? 0n : await repo.bouncePayable(bounce.bounceId);
      if (bounce === null || payable <= 0n) throw precondition("NO_RECORDED_BOUNCE", "no recorded bounce of this transfer has an open payable");
      if (amount <= 0n || amount > payable) throw precondition("RESEND_EXCEEDS_PAYABLE", "the resend exceeds the open payable of its bounce");
      const refundId = refundIdOf(attempt);
      const destination = await repo.destinationOf(attempt.sourceKind, refundId);
      if (destination === null) throw precondition("DESTINATION_NOT_CAPTURED", "the refund was approved without its destination captured");
      const bound = recipient === null ? null : await judgeRecipient(recipient, attempt, destination);
      const attemptNumber = await repo.nextAttemptNumber(attempt.sourceKind, attempt.sourceId);
      const at = await bank.effectNow(uow);
      // no await between this instant and its judgment
      if (!freshAt(verdict, at)) throw stepUpStale();
      const causationId = reservation.entryId as string as CausationId;
      // 5. the DECLARED RESEND attempt, its event, the ALLOW fact, the journal's response (the refund stays as it is)
      const resend = await repo.insertAttempt({
        attemptId: uow.ids.next() as string,
        environment: attempt.environment,
        accountRef: attempt.accountRef,
        kind: "RESEND",
        sourceKind: attempt.sourceKind,
        agencyId: attempt.agencyId,
        captureId: attempt.captureId,
        refundId: attempt.refundId,
        bankCreditId: attempt.bankCreditId,
        treasuryRefundId: attempt.treasuryRefundId,
        parentBounceId: bounce.bounceId,
        attemptNumber,
        reference: outboundReference(refundId, attemptNumber),
        amountCents: amount,
        declaredAt: at,
        declaredBy: userId,
        destinationFingerprint: destination.fingerprint,
        keyId: destination.keyId,
        keyVersion: destination.keyVersion,
        normVersion: destination.normVersion,
        recipientRef: bound?.recipientRef ?? null,
        recipientVersion: bound?.recipientVersion ?? null,
      });
      await publishAttempt(uow, context, causationId, resend, "outbound.declared.v1", { attemptNumber: resend.attemptNumber, amountCents: Number(resend.amountCents), declaredAt: resend.declaredAt, destinationFingerprint: resend.destinationFingerprint });
      await allowFact(uow, context, operation, at);
      let refund: RefundStateView | null;
      if (attempt.sourceKind === "CAPTURE") {
        const r = await c.refunds.get(attempt.refundId as RefundId);
        refund = r === null ? null : { state: r.state, version: r.version };
      } else {
        const t = await repo.treasuryRefund(attempt.treasuryRefundId!);
        refund = t === null ? null : { state: t.state, version: t.version };
      }
      const view: DeclareExecutionView = { attempt: attemptView(resend, destination), refund };
      return { view: await answer(uow, reservation.entryId, 201, view, "outbound_execution_attempt", resend.attemptId) };
    });
    const view = out.view as DeclareExecutionView;
    return out instanceof Replayed ? { kind: "COMPLETED", status: out.status, view, version: view.refund?.version ?? 1, replayed: true } : { kind: "COMPLETED", status: 201, view, version: view.refund?.version ?? 1, replayed: false };
  });
}

// --- G2 / G4 CMD222 RecordExecution ---------------------------------------------------------------------------------------------------

type Judgment =
  | { readonly kind: "RECORD"; readonly evidence: OutboundEvidence; readonly proof: "DP_FULL" | "DP_RECIPIENT" }
  | { readonly kind: "REVIEW"; readonly gate: ExecutionGateOutcomeName; readonly code: string; readonly caseKind: string; readonly executionId: string | null };

const PROVIDER_REF = /^[A-Za-z0-9._:-]{1,256}$/;
const review = (gate: ExecutionGateOutcomeName, code: string, caseKind: string, executionId: string | null = null): Judgment => ({ kind: "REVIEW", gate, code, caseKind, executionId });

/**
 * The gate over the bytes actually read, then the predicates of §7.22 in their order: the account and an execution status, E-ID (an
 * execution id never recorded for another attempt of the account, either scope), E-AMT, E-TIME (executed at or after the declaration),
 * E-REF (a present reference is the attempt's), then the destination proof (DP-FULL: the full details normalize and give the attempt's
 * fingerprint under the attempt's key; a fingerprint under another key or normalizer never compares equal). Unknown is never permission.
 */
async function judgeExecution(
  ev: StoredBankEvidence | null,
  expired: boolean,
  offer: ExecutionOfferRecord,
  attempt: ExecutionAttemptRecord,
  classifier: BankCreditClassifier,
  fingerprinter: DestinationFingerprinter,
  captured: CapturedDestination | null,
  used: (executionId: string) => Promise<boolean>,
): Promise<Judgment> {
  if (expired || ev === null) return review("EVIDENCE_UNAVAILABLE", "EVIDENCE_UNAVAILABLE", "RECORD_REQUIRED");
  if (ev.sha256 !== offer.expectedEvidenceHash || rawDigest(ev.bytes) !== ev.sha256) return review("HASH_MISMATCH", "HASH_MISMATCH", "RECORD_REQUIRED");
  if (ev.accountRef !== attempt.accountRef || ev.environment !== attempt.environment) return review("UNKNOWN_EVIDENCE", "UNKNOWN_EVIDENCE", "RECORD_REQUIRED");
  const classified = classifier.classifyOutbound(ev);
  if (classified.kind !== "CLASSIFIED") return review(classified.code, classified.code, "RECORD_REQUIRED");
  const x = classified.value;
  if (x.accountRef !== attempt.accountRef || (x.status !== "SENT" && x.status !== "COMPLETED")) return review("UNKNOWN_EVIDENCE", "UNKNOWN_EVIDENCE", "RECORD_REQUIRED");
  const id = PROVIDER_REF.test(x.bankExecutionId) ? x.bankExecutionId : null;
  if (id === null || (await used(id))) return review("CLASSIFIED", "EXECUTION_ID_INVALID", "MATCH_REVIEW", id);
  if (x.amountCents !== attempt.amountCents || x.currency !== attempt.currency) return review("CLASSIFIED", "EXECUTION_AMOUNT_MISMATCH", "MATCH_REVIEW", id);
  if (x.executedAt === null || Date.parse(x.executedAt) < Date.parse(attempt.declaredAt)) return review("CLASSIFIED", "EXECUTION_PRECEDES_DECLARATION", "MATCH_REVIEW", id);
  if (x.reference !== null && x.reference !== attempt.reference) return review("CLASSIFIED", "EXECUTION_REFERENCE_CONFLICT", "MATCH_REVIEW", id);
  const under = fingerprinter.current();
  if (under.keyId !== attempt.keyId || under.keyVersion !== attempt.keyVersion || under.normVersion !== attempt.normVersion) return review("CLASSIFIED", "DESTINATION_UNPROVEN", "DESTINATION_UNPROVEN", id);
  const dest = x.destination;
  if (dest.full !== null) {
    const n = normalizeDestination(dest.full);
    if (n.kind !== "OK") return review("CLASSIFIED", "DESTINATION_UNPROVEN", "DESTINATION_UNPROVEN", id);
    const fp = await fingerprinter.fingerprint({ routingNumber: n.routing, accountNumber: n.account, holderName: n.holder }, under);
    if (fp.fingerprint === attempt.destinationFingerprint && fp.keyId === attempt.keyId && fp.keyVersion === attempt.keyVersion && fp.normVersion === attempt.normVersion) return { kind: "RECORD", evidence: x, proof: "DP_FULL" };
    return review("CLASSIFIED", "DESTINATION_CONFLICT", "MATCH_REVIEW", id);
  }
  if (dest.accountLast4 !== null && captured !== null && dest.accountLast4 !== captured.accountLast4) return review("CLASSIFIED", "DESTINATION_CONFLICT", "MATCH_REVIEW", id);
  // DP-RECIPIENT: the recipient record bound at declaration, the same id AND the same version (a changed or unversioned record proves nothing)
  if (attempt.recipientRef !== null && attempt.recipientVersion !== null && dest.recipientRef === attempt.recipientRef && dest.recipientVersion === attempt.recipientVersion) return { kind: "RECORD", evidence: x, proof: "DP_RECIPIENT" };
  return review("CLASSIFIED", "DESTINATION_UNPROVEN", "DESTINATION_UNPROVEN", id);
}

const refusalOf = (code: string): DomainFailure => (code === "EVIDENCE_UNAVAILABLE" ? evidenceUnavailable() : precondition(code as FailureReason, `the execution evidence was refused: ${code}`));

/** What distinguishes G2/G4 (CMD222) from X3 EXECUTED (CMD223) on the shared offer -> read -> outcome path. */
interface RecordMode {
  readonly operation: string;
  readonly command: (a: ExecutionAttemptRecord) => ExecutionOfferCommandName;
  /** The attempt states the command records from (checked at the offer and again under the outcome's locks). */
  readonly admits: (a: ExecutionAttemptRecord) => DomainFailure | null;
}
const RECORD_MODE: RecordMode = {
  operation: BANK_REFUND_COMMAND_IDS.recordExecution,
  command: (a) => (a.kind === "RETURN" ? "RECORD_RETURN" : "RECORD_RESEND"),
  admits: (a) => (a.state === "DECLARED" || a.state === "UNCERTAIN" ? null : notDeclared()),
};
const notUncertain = (): DomainFailure => precondition("REFUND_NOT_UNCERTAIN", "the attempt is not UNCERTAIN: only an uncertain execution is resolved by the owner");
const RESOLVE_EXECUTED_MODE: RecordMode = {
  operation: BANK_REFUND_COMMAND_IDS.resolveExecution,
  command: () => "RESOLVE_EXECUTED",
  admits: (a) => (a.state === "UNCERTAIN" ? null : notUncertain()),
};

function recordExecution(d: OwnerRefundDependencies, request: BankRouteRequest<RecordExecutionBody>, mode: RecordMode = RECORD_MODE): Promise<CommandResult<RecordExecutionView>> {
  const operation = mode.operation;
  const attemptId = request.path["attemptId"]!;
  const userId = request.subject.identity.userId as UserId;
  const body = request.body;
  const key = request.idempotencyKey;
  return ownerCommand<RecordExecutionView>(d, operation, request.correlationId, async (context, adopt) => {
    const { bank, payment, refunds } = partsOf(d);
    const store = bank.evidence();
    const fingerprinter = bank.fingerprinter?.() ?? null;
    const classifier = bank.creditClassifier?.() ?? null;
    if (store === null || fingerprinter === null || classifier === null) throw evidenceUnavailable();
    const journal = journalOf(operation, request);
    const proofId = isUuid(body.authorizationRef) ? body.authorizationRef : null;
    const scoped = async (uow: CommerceUnitOfWork, repo: BankRefundRepository): Promise<ExecutionAttemptRecord> => {
      const seen = await repo.attempt(attemptId);
      if (seen === null) throw new NotFoundFailure("execution attempt");
      if (seen.sourceKind === "CAPTURE") {
        if ((await uow.adoptScope("REFUND", seen.refundId as RefundId)) === null) throw new NotFoundFailure("execution attempt");
        adopt(uow.commerceScope);
      }
      await repo.lockOutboundStream(seen.environment, seen.accountRef);
      return seen;
    };

    // 1. Koffer: the durable offer of this key (the same key and artifact finds its row; another artifact under the key conflicts)
    const offer = await payment.run(context, async (uow): Promise<ExecutionOfferRecord> => {
      const repo = refunds(uow);
      await scoped(uow, repo);
      await ownerAuthority(bank, uow, repo, userId, proofId);
      const attempt = await repo.lockAttempt(attemptId);
      if (attempt === null) throw new NotFoundFailure("execution attempt");
      const command = mode.command(attempt);
      const existing = await repo.findOffer(attemptId, command, key);
      if (existing !== null) {
        if (existing.requestedArtifactRef !== body.evidence.artifactRef || existing.expectedEvidenceHash !== body.evidence.evidenceHash || existing.actorUserId !== userId) {
          throw new DomainFailure("IDEMPOTENCY_CONFLICT", "idempotency key reused with a different request body", { reason: "BODY_CONFLICT" });
        }
        return existing;
      }
      // an offer on a NOT_EXECUTED attempt commits its row and, in the same COMMIT, the contradiction and the source freeze (the outcome then refuses)
      const contradicting = attempt.state === "NOT_EXECUTED";
      if (!contradicting) {
        const inadmissible = mode.admits(attempt);
        if (inadmissible !== null) throw inadmissible;
      }
      const fresh: ExecutionOfferRecord = { offerId: uow.ids.next() as string, attemptId, command, idempotencyKey: key, requestedArtifactRef: body.evidence.artifactRef, expectedEvidenceHash: body.evidence.evidenceHash, actorUserId: userId };
      await repo.insertOffer(fresh);
      if (contradicting) await repo.contradictOffered(uow.ids.next() as string, uow.ids.next() as string, attempt, body.evidence.evidenceHash);
      await allowFact(uow, context, operation, await bank.effectNow(uow));
      return fresh;
    });
    await bank.hold?.("bank:offer-committed");

    // 2. G1: the artifact read outside any unit under the provider-call bound (a failed or late read is unknown, never permission)
    const bound = bank.timer.start(PROVIDER_CALL_TIMEOUT_MS);
    let read: StoredBankEvidence | null = null;
    try {
      const got = await Promise.race([store.get(offer.requestedArtifactRef).then((evidence) => ({ evidence }), () => null), bound.elapsed.then(() => null)]);
      read = got?.evidence ?? null;
    } finally {
      bound.cancel();
    }
    const expired = (): boolean => bound.expired?.() === true;
    await bank.hold?.("bank:gate-read");

    // 3. the outcome: the authority again, the locks, the gate and the predicates, then the record or the review
    const out = await payment.run(context, async (uow): Promise<{ readonly view: RecordExecutionView } | Replayed | Refusal> => {
      const repo = refunds(uow);
      const c = uow.commerce;
      const seen = await scoped(uow, repo);
      const verdict = await ownerAuthority(bank, uow, repo, userId, proofId);
      await lockSource(repo, seen);
      const live = seen.sourceKind === "CAPTURE" && seen.kind === "RETURN" ? await c.authorizations.findLiveByCapture(seen.captureId as never) : null;
      if (live !== null) await repo.awaitAuthorization(live.authorizationId);
      const attempt = await repo.lockAttempt(attemptId);
      if (attempt === null) throw new NotFoundFailure("execution attempt");
      await bank.hold?.("bank:outcome-locked");
      const theOffer = await repo.findOffer(attemptId, offer.command, key);
      if (theOffer === null) throw new DomainFailure("INTEGRITY_FAILURE", "the committed offer of this key is not visible to its outcome");
      const prior = await repo.outcomeOf(theOffer.offerId);
      if (prior !== null && prior.footprint === "REVIEW") return new Refusal(refusalOf(prior.outcomeCode));
      if (prior !== null) {
        const replay = await reserve(uow, journal);
        if (replay instanceof Replayed) return replay;
        throw new DomainFailure("INTEGRITY_FAILURE", "a RECORDED outcome without its journaled answer");
      }
      const destination = await repo.destinationOf(attempt.sourceKind, refundIdOf(attempt));
      if (destination === null) throw new DomainFailure("INTEGRITY_FAILURE", "a declared attempt without the destination it was declared to");
      const currentRefund = async (): Promise<RefundStateView | null> => {
        if (attempt.sourceKind === "CAPTURE") {
          const r = await c.refunds.get(attempt.refundId as RefundId);
          return r === null ? null : { state: r.state, version: r.version };
        }
        const t = await repo.treasuryRefund(attempt.treasuryRefundId!);
        return t === null ? null : { state: t.state, version: t.version };
      };
      // recorded meanwhile under another key: this key records nothing (its offer stays without an outcome); its own replay is above
      const moved = mode.admits(attempt);
      if (moved !== null) throw moved;
      const judged = await judgeExecution(read, expired(), theOffer, attempt, classifier, fingerprinter, destination, (id) => repo.executionIdUsed(attempt.environment, attempt.accountRef, id));
      if (judged.kind === "REVIEW") {
        // the refusal is durable: the offer's REVIEW outcome and its review case commit, the attempt and the refund stay as they are
        await repo.insertOutcome({ outcomeId: uow.ids.next() as string, offerId: theOffer.offerId, gateOutcome: judged.gate, bankExecutionId: judged.gate === "CLASSIFIED" ? judged.executionId : null, outcomeCode: judged.code, footprint: "REVIEW", reviewCaseKind: judged.caseKind });
        await repo.openCaseIfNone({ caseId: uow.ids.next() as string, kind: judged.caseKind, environment: attempt.environment, accountRef: attempt.accountRef, attemptId: attempt.attemptId, sourceKind: attempt.sourceKind, sourceId: attempt.sourceId, detailCode: judged.code, evidenceHash: theOffer.expectedEvidenceHash });
        return new Refusal(refusalOf(judged.code));
      }
      const reservation = await reserve(uow, journal);
      if (reservation instanceof Replayed) return reservation;
      const causationId = reservation.entryId as string as CausationId;
      const executionId = judged.evidence.bankExecutionId;
      const evidenceHash = theOffer.expectedEvidenceHash;
      // the refund's row (L3) before its completion
      const refundRow = attempt.kind !== "RETURN" ? null : attempt.sourceKind === "CAPTURE" ? ((await c.refunds.lock(attempt.refundId as RefundId)) ?? (await c.refunds.get(attempt.refundId as RefundId))) : null;
      const treasuryRow = attempt.kind === "RETURN" && attempt.sourceKind === "BANK_CREDIT" ? await repo.lockTreasuryRefund(attempt.treasuryRefundId!) : null;
      if (attempt.kind === "RETURN") {
        const state = attempt.sourceKind === "CAPTURE" ? refundRow?.state : treasuryRow?.state;
        if (state === undefined) throw new NotFoundFailure("refund");
        // a DECLARED/UNCERTAIN RETURN attempt always has its refund SUBMITTING or UNCERTAIN (X1/X2 move both in one transaction)
        if (state !== "SUBMITTING" && state !== "UNCERTAIN") throw new DomainFailure("INTEGRITY_FAILURE", "the refund this execution returns is not SUBMITTING or UNCERTAIN");
      }
      const at = await bank.effectNow(uow);
      // no await between this instant and its judgment
      if (!freshAt(verdict, at)) throw stepUpStale();
      await repo.insertOutcome({ outcomeId: uow.ids.next() as string, offerId: theOffer.offerId, gateOutcome: "CLASSIFIED", bankExecutionId: executionId, outcomeCode: "RECORDED", footprint: "RECORDED", reviewCaseKind: null });
      const recorded = await repo.recordAttempt(attempt.attemptId, attempt.version, { bankExecutionId: executionId, proof: judged.proof, evidenceHash, recordedAt: at });
      if (recorded === null) throw new StaleVersionFailure(attempt.version, attempt.state);
      if (recorded.kind === "RESEND") {
        // G4: the resend recorded settles the REFUND_PAYABLE of its bounce (its amount was held by the declaration); the case closes with the last cent
        await publishAttempt(uow, context, causationId, recorded, "outbound.resent.v1", { previousState: attempt.state, parentBounceId: recorded.parentBounceId, amountCents: Number(recorded.amountCents), evidenceHash, destinationProof: judged.proof });
        const parent = recorded.parentBounceId === null ? null : await repo.bounceById(recorded.parentBounceId);
        if (parent !== null && (await repo.bouncePayable(parent.bounceId)) === 0n) await repo.resolveOpenCases("RETURN_BOUNCED", parent.attemptId, at);
      } else await publishAttempt(uow, context, causationId, recorded, "outbound.recorded.v1", { previousState: attempt.state, evidenceHash, destinationProof: judged.proof });
      let refundState: RefundStateView | null;
      if (refundRow !== null && refundRow !== undefined) {
        // CAPTURE RETURN: the refund COMPLETED citing the execution (KP014); a completion that leaves the capture no service basis revokes
        // the live entitlement in the same transaction (D-REF-B5, KP006)
        const w = await c.refunds.transition(refundRow.refundId, refundRow.version, { state: "COMPLETED", providerRefundId: executionId, evidenceHash: evidenceHash as Sha256Hex, completedAt: at }, at);
        if (w.kind === "STALE") throw new StaleVersionFailure(w.currentVersion, w.currentState);
        refundState = { state: w.record.state, version: w.record.version };
        if (live !== null) {
          const capture = await c.captures.get(refundRow.captureId);
          const refundedService = (await c.refunds.listForCapture(refundRow.captureId)).filter((r) => r.state === "COMPLETED").reduce((sum, r) => sum + (r.approved?.amounts.serviceCents ?? 0n), 0n);
          if (capture !== null && capture.allocation.serviceCents > 0n && refundedService >= capture.allocation.serviceCents) {
            const auth = (await c.authorizations.lock(live.authorizationId)) ?? live;
            if (auth.state !== "REVOKED") {
              const revoked = await c.authorizations.transition(auth.authorizationId, auth.version, { state: "REVOKED", revocation: { at, phase: revocationPhaseOf(auth.state), code: "SERVICE_FULLY_REFUNDED" } }, at);
              if (revoked.kind === "STALE") throw new StaleVersionFailure(revoked.currentVersion, revoked.currentState);
            }
          }
        }
      } else if (treasuryRow !== null) {
        const t = await repo.transitionTreasuryRefund(treasuryRow.treasuryRefundId, treasuryRow.version, "COMPLETED");
        if (t === null) throw new StaleVersionFailure(treasuryRow.version, treasuryRow.state);
        await publishTreasury(uow, context, causationId, t, "treasury_refund.completed.v1", { attemptId: recorded.attemptId, amountCents: Number(t.amountCents), evidenceHash, previousState: t.previousState });
        refundState = { state: t.state, version: t.version };
      } else refundState = await currentRefund();
      await repo.resolveOpenCases("UNCERTAIN_EFFECT", recorded.attemptId, at);
      await allowFact(uow, context, operation, at);
      const view: RecordExecutionView = { attempt: attemptView(recorded, destination), refund: refundState, offerId: theOffer.offerId };
      return { view: await answer(uow, reservation.entryId, 200, view, "outbound_execution_attempt", recorded.attemptId) };
    });
    if (out instanceof Refusal) throw out.failure;
    if (out instanceof Replayed) {
      const view = out.view as RecordExecutionView;
      return { kind: "COMPLETED", status: out.status, view, version: view.refund?.version ?? 1, replayed: true };
    }
    return { kind: "COMPLETED", status: 200, view: out.view, version: out.view.refund?.version ?? 1, replayed: false };
  });
}

// --- X3 CMD223 ResolveUncertainExecution ---------------------------------------------------------------------------------------------

/** NX-COVERAGE: whether the intervals (by start) cover [from, to] without a gap. */
function covers(intervals: ReadonlyArray<{ readonly from: UtcInstant; readonly to: UtcInstant }>, from: UtcInstant, to: UtcInstant): boolean {
  let cursor = Date.parse(from);
  const end = Date.parse(to);
  for (const iv of intervals) {
    if (cursor >= end) break;
    if (Date.parse(iv.from) > cursor) return false;
    cursor = Math.max(cursor, Date.parse(iv.to));
  }
  return cursor >= end;
}

/** The failure code of a refund the owner attested was never executed (X3 NOT_EXECUTED, `owner_attested_no_effect`). */
export const OWNER_ATTESTED_NO_EFFECT = "OWNER_ATTESTED_NO_EFFECT";

function resolveExecution(d: OwnerRefundDependencies, request: BankRouteRequest<ResolveExecutionBody>): Promise<CommandResult<ResolveExecutionView>> {
  const body = request.body;
  if (body.outcome === "EXECUTED") {
    if (body.evidence === undefined) return Promise.resolve(resultOf<ResolveExecutionView>(new InvalidRequestFailure([{ field: "evidence", code: "REQUIRED" }]), request.correlationId));
    // the journal digests the whole body, the outcome with it: the same key under the other outcome is BODY_CONFLICT
    return recordExecution(d, request as unknown as BankRouteRequest<RecordExecutionBody>, RESOLVE_EXECUTED_MODE) as Promise<CommandResult<ResolveExecutionView>>;
  }
  if (body.evidence !== undefined) return Promise.resolve(resultOf<ResolveExecutionView>(new InvalidRequestFailure([{ field: "evidence", code: "UNKNOWN_FIELD" }]), request.correlationId));
  return resolveNotExecuted(d, request);
}

function resolveNotExecuted(d: OwnerRefundDependencies, request: BankRouteRequest<ResolveExecutionBody>): Promise<CommandResult<ResolveExecutionView>> {
  const operation = BANK_REFUND_COMMAND_IDS.resolveExecution;
  const attemptId = request.path["attemptId"]!;
  const userId = request.subject.identity.userId as UserId;
  return ownerCommand<ResolveExecutionView>(d, operation, request.correlationId, async (context, adopt) => {
    const { bank, payment, refunds } = partsOf(d);
    const journal = journalOf(operation, request);
    const proofId = isUuid(request.body.authorizationRef) ? request.body.authorizationRef : null;
    const out = await payment.run(context, async (uow): Promise<{ readonly view: ResolveExecutionView } | Replayed> => {
      const repo = refunds(uow);
      const c = uow.commerce;
      // 1. the attempt's scope, L1, the owner's authority, the journal
      const seen = await repo.attempt(attemptId);
      if (seen === null) throw new NotFoundFailure("execution attempt");
      if (seen.sourceKind === "CAPTURE") {
        if ((await uow.adoptScope("REFUND", seen.refundId as RefundId)) === null) throw new NotFoundFailure("execution attempt");
        adopt(uow.commerceScope);
      }
      await repo.lockOutboundStream(seen.environment, seen.accountRef);
      const verdict = await ownerAuthority(bank, uow, repo, userId, proofId);
      const reservation = await reserve(uow, journal);
      if (reservation instanceof Replayed) return reservation;
      // 2. L2, then the attempt (L3)
      await lockSource(repo, seen);
      const attempt = await repo.lockAttempt(attemptId);
      if (attempt === null) throw new NotFoundFailure("execution attempt");
      if (attempt.state !== "UNCERTAIN") throw notUncertain();
      // 3. CORR-OFFERED: the owner's claim that it was executed (any offer of the attempt, whatever its outcome) blocks NOT_EXECUTED
      if (await repo.anyOfferFor(attemptId)) throw precondition("CONTRADICTORY_EVIDENCE", "an execution was offered for this attempt");
      // 4. NX-LAG, NX-COVERAGE, NX-NO-POTENTIAL at the effect clock, read under L1 (a statement import inserts its lines only under L1)
      const timing = await repo.routeTimingOf(attempt.environment, attempt.accountRef);
      if (timing === null) throw precondition("COVERAGE_INCOMPLETE", "the account has no route: its coverage is unknown");
      const at = await bank.effectNow(uow);
      if (Date.parse(at) < Date.parse(attempt.declaredAt) + timing.windowMs + timing.coverageLagMs) throw precondition("NOT_EXECUTED_TOO_EARLY", "the window and the coverage lag have not passed since the declaration");
      const to = toUtcInstant(Date.parse(at) - timing.coverageLagMs);
      if (!covers(await repo.outboundCoverage(attempt.environment, attempt.accountRef, attempt.declaredAt, to), attempt.declaredAt, to)) {
        throw precondition("COVERAGE_INCOMPLETE", "the imported outbound coverage has a gap since the declaration");
      }
      const debits = await repo.debitsAgainst(attempt.attemptId, attempt.environment, attempt.accountRef, attempt.declaredAt, to);
      if (debits.some((x) => x.correlated)) throw precondition("CONTRADICTORY_EVIDENCE", "a debit of the covered interval is correlated with this attempt");
      if (debits.some((x) => !x.explained)) throw precondition("UNEXPLAINED_DEBIT", "a debit of the covered interval is not explained by another recorded execution");
      const destination = await repo.destinationOf(attempt.sourceKind, refundIdOf(attempt));
      if (destination === null) throw new DomainFailure("INTEGRITY_FAILURE", "a declared attempt without the destination it was declared to");
      // no await between this instant and its judgment
      if (!freshAt(verdict, at)) throw stepUpStale();
      const causationId = reservation.entryId as string as CausationId;
      // 5. the attempt NOT_EXECUTED; a RETURN's refund FAILED (its share released); a RESEND's payable stays open
      const resolved = await repo.notExecuteAttempt(attempt.attemptId, attempt.version);
      if (resolved === null) throw new StaleVersionFailure(attempt.version, attempt.state);
      await publishAttempt(uow, context, causationId, resolved, "outbound.not_executed.v1", { previousState: attempt.state });
      let refundState: RefundStateView | null = null;
      if (attempt.kind === "RETURN" && attempt.sourceKind === "CAPTURE") {
        const r = (await c.refunds.lock(attempt.refundId as RefundId)) ?? (await c.refunds.get(attempt.refundId as RefundId));
        if (r === null) throw new NotFoundFailure("refund");
        if (r.state !== "UNCERTAIN") throw new DomainFailure("INTEGRITY_FAILURE", "the refund of an UNCERTAIN return is not UNCERTAIN");
        const w = await c.refunds.transition(r.refundId, r.version, { state: "FAILED", failureCode: OWNER_ATTESTED_NO_EFFECT }, at);
        if (w.kind === "STALE") throw new StaleVersionFailure(w.currentVersion, w.currentState);
        refundState = { state: w.record.state, version: w.record.version };
      } else if (attempt.kind === "RETURN") {
        const t = await repo.lockTreasuryRefund(attempt.treasuryRefundId!);
        if (t === null) throw new NotFoundFailure("treasury refund");
        if (t.state !== "UNCERTAIN") throw new DomainFailure("INTEGRITY_FAILURE", "the treasury refund of an UNCERTAIN return is not UNCERTAIN");
        const failed = await repo.transitionTreasuryRefund(t.treasuryRefundId, t.version, "FAILED");
        if (failed === null) throw new StaleVersionFailure(t.version, t.state);
        await publishTreasury(uow, context, causationId, failed, "treasury_refund.failed.v1", { attemptId: resolved.attemptId, failureCode: OWNER_ATTESTED_NO_EFFECT, previousState: failed.previousState });
        refundState = { state: failed.state, version: failed.version };
      }
      await repo.resolveOpenCases("UNCERTAIN_EFFECT", resolved.attemptId, at);
      await allowFact(uow, context, operation, at);
      const view: ResolveExecutionView = { attempt: attemptView(resolved, destination), refund: refundState, offerId: null };
      return { view: await answer(uow, reservation.entryId, 200, view, "outbound_execution_attempt", resolved.attemptId) };
    });
    if (out instanceof Replayed) {
      const view = out.view as ResolveExecutionView;
      return { kind: "COMPLETED", status: out.status, view, version: view.refund?.version ?? 1, replayed: true };
    }
    return { kind: "COMPLETED", status: 200, view: out.view, version: out.view.refund?.version ?? 1, replayed: false };
  });
}

// --- the owner queue ------------------------------------------------------------------------------------------------------------------

async function executionQueue(d: OwnerRefundDependencies, request: ExecutionQueueRequest): Promise<{ readonly kind: "READ"; readonly view: ExecutionQueueView } | { readonly kind: "PROBLEM"; readonly problem: Problem }> {
  const context: OperatorContext = { kind: "OPERATOR", userId: request.subject.identity.userId as UserId, correlationId: request.correlationId };
  let denied = false;
  try {
    const bank = d.bank;
    if (bank === null || bank.refunds === undefined) throw evidenceUnavailable();
    const refunds = bank.refunds;
    const view = await d.runtime.unitOfWork.run(context, async (uow) => {
      const decision = await d.runtime.commerceAuthorizer.authorizeOperator(uow, { identity: request.subject.identity, role: "KAURO_OWNER" });
      if (decision.kind === "DENY") {
        denied = true;
        throw CommerceAccessDenied.of("READ_EXECUTION_ATTEMPTS", decision);
      }
      const rows = await refunds(uow).ownerQueue(EXECUTION_QUEUE_LIMIT);
      const items: ExecutionQueueItemView[] = rows.map((r) => ({
        attemptId: r.attemptId,
        kind: r.kind,
        state: r.state,
        sourceKind: r.sourceKind,
        amountCents: formatMoney(r.amountCents),
        currency: "USD",
        reference: r.reference,
        declaredAt: r.declaredAt,
        destination: { accountLast4: r.accountLast4, holderName: r.holderName },
      }));
      // rule 16: answered only under the caller's credential as fenced in this unit
      await judgedUnderHold(request.authority, uow, d.runtime.clock);
      return { data: { items } };
    });
    return { kind: "READ", view };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (denied || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(d.runtime, context, "READ_EXECUTION_ATTEMPTS", e, null);
    return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
  }
}

export function createBankRefundHandlers(d: OwnerRefundDependencies): BankRefundHandlers {
  return {
    approveTreasury: approveTreasuryHandler(d),
    declareExecution: (request) => declareExecution(d, request),
    recordBounce: (request) => recordBounce(d, request),
    declareResend: (request) => declareResend(d, request),
    recordExecution: (request) => recordExecution(d, request),
    resolveExecution: (request) => resolveExecution(d, request),
    executionQueue: (request) => executionQueue(d, request),
  };
}

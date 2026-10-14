/**
 * F2 `Kapprove` of the manual-assisted refunds of the bank-transfer route (Payments V1, lane L-REFUND; docs/design/ACH-ROUTE.md r12 §7.13-§7.14
 * F1/F2, D-ACH-16, D-ACH-19, D-24 A; DV1-10, DV1-11): the corporate owner approves a refund for the manual rail with the destination the owner
 * read from the payer's restricted evidence, in ONE unit of work of the payment service (kauro_payment), so the approval, the destination row,
 * the event, the ALLOW fact and the owner's journal row commit together or not at all.
 *
 *   CAPTURE      CMD032 with `destination` and `destinationEvidence` (the agency refund of a capture paid by bank transfer).
 *   BANK_CREDIT  CMD220 ApproveTreasuryRefund (the route-scope refund of an unassigned credit; excess-only: one amount, agency NULL).
 *
 * Order (lock order §7.28; TIME-AFTER-AWAIT):
 *   1. before the unit: the payer evidence read from the restricted store under the provider-call bound (F1), then the named point
 *      `bank:gate-read`; a read that outlived its bound is CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE, never permission;
 *   2. in the unit: the source located (CAPTURE: the refund's scope adopted, the account of its transfer instructions; BANK_CREDIT: the
 *      treasury row), then L1 (the account's OUTBOUND stream lock), then kauro.bank_owner_authority (the SECURITY DEFINER verdict of the
 *      owner's identity, grant and step-up at the database clock after their transition locks; OK records the act every guard of the unit
 *      requires), then the owner's journal entry (agency NULL; the digest covers the body without the proof, so a lost answer replays under a
 *      new proof and another body is BODY_CONFLICT), then the evidence judged over the bytes actually read (hash, account, payer link), the
 *      destination normalized (destination-norm-v1) and fingerprinted, then the source's row lock and preconditions, the writes, the ALLOW
 *      fact and the journal's response;
 *   3. immediately before COMMIT: the step-up judged again at the effect clock read last (a proof that expired meanwhile refuses everything).
 * A denial (ACCESS / ASSURANCE / NOT_AUTHORIZED) is recorded afterwards in its own SERVICE unit (agency NULL, naming the adopted agency).
 *
 * GAP (reported): the cookie-session fence of rule 16 (judgedUnderHold) needs the session row FOR SHARE under kauro_app; these units run as
 * kauro_payment, so the credential is judged by the transport's authentication and the owner's authority by the definer only.
 */
import type { CommandId, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import type { AgencyId, AssuranceProofId, CausationId, CommerceUnitOfWork, CommerceUnitOfWorkFactory, CorrelationId, RefundId, ServiceContext, UserId } from "@kauro/domain";
import {
  COMMERCE_POLICY_VERSION,
  DomainFailure,
  NotAuthorizedFailure,
  NotFoundFailure,
  PROVIDER_CALL_TIMEOUT_MS,
  StaleVersionFailure,
  actorOf,
  approvedComponents,
  authorizationPreimageMoney,
  beforeCommitOf,
  checkRefundAmounts,
  checkRefundTax,
  commandRequestDigest,
  deliveryPhaseOf,
  formatMoney,
  isUuid,
  normalizeDestination,
  refundAmountFailure,
  refundAuthorizationHash,
  refundEffectsHash,
  refundTaxFailure,
  refundableBalance,
} from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { STEP_UP_FRESHNESS_SECONDS } from "../../ports/assurance-and-admission.js";
import type { ApproveRefundBody } from "../contracts.js";
import type { StoredBankEvidence } from "../ports.js";
import type { ApproveRefundView } from "../views.js";
import { refundEffectsView, refundView } from "../request/projections.js";
import { moneyField, refundEffectsOf } from "../request/approve-refund.js";
import { DENIAL_CODES, resultOf, versionOfView, type CommerceRequestCollaborators, type CommerceRequestRuntime } from "../request/runtime.js";
import type { BankRefundRepository, BankRouteCollaborators, OwnerAuthorityVerdict } from "./ports.js";
import { evidenceUnavailable, type BankRouteRequest } from "./route-config.js";

// --- requests and views ---------------------------------------------------------------------------------------------------------------

export interface RefundDestinationFields {
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly holderName: string;
}
export interface RefundDestinationEvidenceFields {
  readonly artifactRef: string;
  readonly evidenceHash: string;
}
/** CMD220: the treasury refund's one amount, carried as the service component (a treasury refund has no tax: D-ACH-13). */
export interface ApproveTreasuryRefundBody {
  readonly expectedVersion: number;
  readonly serviceCents: string;
  readonly taxCents: string;
  readonly authorizationRef: string;
  readonly destination?: RefundDestinationFields;
  readonly destinationEvidence?: RefundDestinationEvidenceFields;
}
export interface TreasuryRefundView {
  readonly treasuryRefund: {
    readonly treasuryRefundId: string;
    readonly state: string;
    readonly version: number;
    readonly amountCents: string;
    readonly bankCreditId: string;
    readonly destinationLast4: string;
  };
}

/** The lane's operational ids of the command journal (route-scope owner commands; not registry commands). */
export const BANK_REFUND_COMMAND_IDS = Object.freeze({ approveTreasury: "CMD220", declareExecution: "CMD221", recordExecution: "CMD222", resolveExecution: "CMD223", recordBounce: "CMD224", declareResend: "CMD225" } as const);

/** What the owner refund commands run on: the request runtime (its clock), the payment service's units and identity, the bank collaborators. */
export interface OwnerRefundDependencies {
  readonly runtime: Pick<CommerceRequestRuntime, "clock" | "unitOfWork" | "commerceAuthorizer">;
  readonly payment: CommerceUnitOfWorkFactory | null;
  readonly paymentServiceId: string;
  readonly bank: BankRouteCollaborators | null;
}

// --- failures -------------------------------------------------------------------------------------------------------------------------

export const integrity = (reason: "DESTINATION_NOT_CAPTURED" | "DESTINATION_INVALID" | "DESTINATION_UNPROVEN" | "HASH_MISMATCH", message: string): DomainFailure => new DomainFailure("INTEGRITY_FAILURE", message, { reason });
export const stepUpStale = (): DomainFailure => new DomainFailure("ASSURANCE_REQUIRED", "the owner's step-up is not fresh at the effect", { reason: "STEP_UP_STALE" });

/** The definer's verdict as the failure the caller answers (OK: none). */
export function verdictFailure(v: OwnerAuthorityVerdict): DomainFailure | null {
  switch (v.verdict) {
    case "OK":
      return null;
    case "IDENTITY_DISABLED":
      return new NotAuthorizedFailure("IDENTITY_DISABLED", "the owner's identity is disabled");
    case "CORPORATE_ROLE_MISSING":
      return new NotAuthorizedFailure("CORPORATE_ROLE_MISSING", "the owner holds no ACTIVE KAURO_OWNER grant");
    default:
      return new DomainFailure("ASSURANCE_REQUIRED", "the owner's step-up is not fresh at the effect", { reason: v.verdict });
  }
}

/** fresh iff `at` is at most the freshness after the proof's issue and before its expiry (the definer's rule, at the effect instant). */
export function freshAt(v: OwnerAuthorityVerdict, at: UtcInstant): boolean {
  if (v.issuedAt === null || v.expiresAt === null) return false;
  const t = Date.parse(at);
  return t <= Date.parse(v.issuedAt) + STEP_UP_FRESHNESS_SECONDS * 1000 && t < Date.parse(v.expiresAt);
}

// --- the evidence (F1) and the destination (DV1-10, DV1-11) --------------------------------------------------------------------------

interface EvidenceRead {
  readonly ref: string;
  readonly hash: string;
  readonly evidence: StoredBankEvidence | null;
}

/** F1: the payer evidence read from the restricted store under the provider-call bound, outside any transaction. */
async function readPayerEvidence(bank: BankRouteCollaborators, ref: RefundDestinationEvidenceFields): Promise<{ readonly read: EvidenceRead; readonly expired: () => boolean }> {
  const store = bank.evidence();
  if (store === null) throw evidenceUnavailable();
  const bound = bank.timer.start(PROVIDER_CALL_TIMEOUT_MS);
  let read: { readonly evidence: StoredBankEvidence | null } | null;
  try {
    read = await Promise.race([store.get(ref.artifactRef).then((evidence) => ({ evidence })), bound.elapsed.then(() => null)]);
  } finally {
    bound.cancel();
  }
  if (read === null) throw evidenceUnavailable();
  return { read: { ref: ref.artifactRef, hash: ref.evidenceHash, evidence: read.evidence }, expired: () => bound.expired?.() === true };
}

interface ProvenDestination {
  readonly fingerprint: Sha256Hex;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  readonly accountLast4: string;
  readonly holderName: string;
  readonly evidenceRef: string;
  readonly evidenceHash: string;
}

/** The holder's display form: NFC, white space collapsed and trimmed, the case kept (the fingerprint uses the normalized form). */
const displayHolder = (name: string): string => name.normalize("NFC").replace(/\p{White_Space}+/gu, " ").trim();

/**
 * The bytes actually read judged in the unit, after L1 (a replacement meanwhile grants nothing): the stored envelope is the cited hash and
 * the bytes are that hash; the artifact is of the source's account; it classifies as a credit with a payer link; the destination normalizes;
 * then its keyed fingerprint (no number is ever stored).
 */
async function provenDestination(bank: BankRouteCollaborators, read: EvidenceRead, destination: RefundDestinationFields, source: { readonly environment: string; readonly accountRef: string }): Promise<ProvenDestination> {
  const fingerprinter = bank.fingerprinter?.() ?? null;
  const classifier = bank.creditClassifier?.() ?? null;
  if (fingerprinter === null || classifier === null) throw evidenceUnavailable();
  const ev = read.evidence;
  if (ev === null) throw new DomainFailure("NOT_FOUND", "the payer evidence is not in the restricted store", { reason: "EVIDENCE_NOT_FOUND" });
  if (ev.sha256 !== read.hash || rawDigest(ev.bytes) !== ev.sha256) throw integrity("HASH_MISMATCH", "the payer evidence is not the artifact the approval cites");
  if (ev.accountRef !== source.accountRef || ev.environment !== source.environment) throw integrity("DESTINATION_UNPROVEN", "the payer evidence is of another account");
  const credit = classifier.classifyCredit(ev);
  if (credit.kind !== "CLASSIFIED" || credit.value.payerDigest === null || credit.value.payerEvidenceRef === null) throw integrity("DESTINATION_UNPROVEN", "the payer evidence links no payer");
  const n = normalizeDestination(destination);
  if (n.kind !== "OK") throw integrity("DESTINATION_INVALID", "the destination is not a valid ACH destination (destination-norm-v1)");
  const under = fingerprinter.current();
  const fp = await fingerprinter.fingerprint({ routingNumber: n.routing, accountNumber: n.account, holderName: n.holder }, under);
  return { fingerprint: fp.fingerprint, keyId: fp.keyId, keyVersion: fp.keyVersion, normVersion: fp.normVersion, accountLast4: n.account.slice(-4), holderName: displayHolder(destination.holderName), evidenceRef: read.ref, evidenceHash: read.hash };
}

// --- one owner refund command in one SERVICE unit ---------------------------------------------------------------------------------------

interface Outcome<View> {
  readonly status: 200 | 201;
  readonly view: View;
  readonly version: number;
  readonly resourceKind: string;
  readonly resourceId: string;
}

interface OwnerRefundRun<View> {
  readonly operation: "CMD032" | "CMD220";
  readonly environment: CommandEnvelope<unknown>["environment"];
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly userId: UserId;
  readonly path: Readonly<Record<string, string>>;
  readonly body: { readonly authorizationRef: string; readonly destination?: RefundDestinationFields; readonly destinationEvidence?: RefundDestinationEvidenceFields };
  /** Locates the source in the unit (adopting its scope when it has one): the account whose OUTBOUND stream L1 locks. */
  locate(uow: CommerceUnitOfWork, repo: BankRefundRepository): Promise<{ readonly environment: string; readonly accountRef: string }>;
  /** The source's row lock, preconditions and writes, at the effect instant `at`, with the proven destination. */
  apply(uow: CommerceUnitOfWork, repo: BankRefundRepository, causationId: CausationId, at: UtcInstant, destination: ProvenDestination, proofRef: string): Promise<Outcome<View>>;
  readonly replayVersion: (view: View) => number;
}

class Replayed {
  constructor(readonly status: 200 | 201, readonly view: unknown) {}
}

async function runOwnerRefund<View>(d: OwnerRefundDependencies, run: OwnerRefundRun<View>): Promise<CommandResult<View>> {
  const context: ServiceContext = { kind: "SERVICE", serviceId: d.paymentServiceId, correlationId: run.correlationId };
  let adopted: AgencyId | null = null;
  try {
    const bank = d.bank;
    const payment = d.payment;
    if (bank === null || payment === null || bank.refunds === undefined) throw evidenceUnavailable();
    const { destination, destinationEvidence } = run.body;
    if (destination === undefined) throw integrity("DESTINATION_NOT_CAPTURED", "a manual-rail refund is approved only with its destination captured");
    if (destinationEvidence === undefined) throw integrity("DESTINATION_UNPROVEN", "a destination is approved only with the payer evidence that proves it");
    // 1. F1 before the unit: the evidence read under its bound, then the gate point; a read past its bound is unknown, never permission
    const { read, expired } = await readPayerEvidence(bank, destinationEvidence);
    await bank.hold?.("bank:gate-read");
    const { authorizationRef: proof, ...digested } = run.body;
    const identity = { environment: run.environment, actor: { kind: "USER" as const, userId: run.userId }, agencyId: null, operation: run.operation as CommandId, key: run.idempotencyKey };
    const digest = commandRequestDigest({ operation: run.operation as CommandId, aggregate: run.path, body: digested });
    const proofId = isUuid(proof) ? proof : null;
    const refunds = bank.refunds;
    const out = await payment.run(context, async (uow): Promise<{ readonly outcome: Outcome<View> } | Replayed> => {
      const repo = refunds(uow);
      // 2. the source, then L1, then the owner's authority at the database clock (its transition locks), then the journal
      const source = await run.locate(uow, repo);
      adopted = uow.commerceScope;
      await repo.lockOutboundStream(source.environment, source.accountRef);
      const verdict = await repo.ownerAuthority(run.userId, proofId, STEP_UP_FRESHNESS_SECONDS);
      const refused = verdictFailure(verdict);
      if (refused !== null) throw refused;
      // the authority is judged first: a stale step-up is STEP_UP_STALE even when the held evidence read also crossed its bound
      if (!freshAt(verdict, await bank.effectNow(uow))) throw stepUpStale();
      // a read past its bound is unknown, never permission
      if (expired()) throw evidenceUnavailable();
      // 3. the committed instant's judgment: the step-up again at the effect clock read last, immediately before COMMIT
      beforeCommitOf(uow, async () => {
        if (!freshAt(verdict, await bank.effectNow(uow))) throw stepUpStale();
      });
      const reservation = await uow.journal.reserve(identity, digest, run.correlationId);
      if (reservation.kind === "REPLAY") {
        const status = reservation.entry.responseStatus;
        if ((status !== 200 && status !== 201) || reservation.entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
        return new Replayed(status, reservation.entry.responseBody);
      }
      if (reservation.kind === "CONFLICT") throw new DomainFailure("IDEMPOTENCY_CONFLICT", "idempotency key reused with a different request body", { reason: "BODY_CONFLICT" });
      if (reservation.kind === "PENDING") throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
      const proven = await provenDestination(bank, read, destination, source);
      const at = await bank.effectNow(uow);
      // no await between this instant and its judgment
      if (!freshAt(verdict, at)) throw stepUpStale();
      const outcome = await run.apply(uow, repo, reservation.entryId as string as CausationId, at, proven, proof);
      await uow.securityEvents.append({
        agencyId: null,
        requestedAgencyId: uow.commerceScope,
        actor: actorOf(context),
        action: run.operation,
        outcome: "ALLOW",
        reasonCode: ALLOW_REASONS.STEP_UP_FRESH,
        policyVersion: COMMERCE_POLICY_VERSION,
        assuranceClass: "STEP_UP",
        correlationId: run.correlationId,
        occurredAt: at,
      });
      const committed = await uow.journal.commit(reservation.entryId, { responseStatus: outcome.status, responseBody: outcome.view, resourceKind: outcome.resourceKind, resourceId: outcome.resourceId });
      if (committed.state !== "COMMITTED" || committed.responseStatus !== outcome.status || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
      return { outcome: { ...outcome, view: committed.responseBody as View } };
    });
    if (out instanceof Replayed) return { kind: "COMPLETED", status: out.status, view: out.view as View, version: run.replayVersion(out.view as View), replayed: true };
    return { kind: "COMPLETED", status: out.outcome.status, view: out.outcome.view, version: out.outcome.version, replayed: false };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (DENIAL_CODES.has(e.code) && d.payment !== null) {
      const failure = e;
      // the durable fact of the denial, in its own SERVICE unit (agency NULL; the adopted agency named, never referenced)
      await d.payment.run(context, async (uow) => {
        await uow.securityEvents.append({
          agencyId: null,
          requestedAgencyId: adopted,
          actor: actorOf(context),
          action: run.operation,
          outcome: "DENY",
          reasonCode: failure.details.reason ?? failure.code,
          policyVersion: COMMERCE_POLICY_VERSION,
          assuranceClass: failure.code === "ASSURANCE_REQUIRED" ? "STEP_UP" : "SESSION",
          correlationId: run.correlationId,
          occurredAt: d.runtime.clock.now(),
        });
      });
    }
    return resultOf<View>(e, run.correlationId);
  }
}

// --- CAPTURE: CMD032 with the destination ----------------------------------------------------------------------------------------------

/** True when a CMD032 body names the manual rail's destination or its evidence (the bank path; otherwise B09's provider refund). */
export function namesDestination(body: ApproveRefundBody): boolean {
  return body.destination !== undefined || body.destinationEvidence !== undefined;
}

/**
 * CMD032 F2 on a capture refund: the refund's scope adopted, the account of its order's transfer instructions (a capture not paid by bank
 * transfer has none: DESTINATION_UNPROVEN), then CMD032's own preconditions in its order (STALE_VERSION, REFUND_NOT_REQUESTED,
 * CAPTURE_NOT_REFUNDABLE, the components and the remaining capture, the tax rule, SELF_APPROVAL_FORBIDDEN) — the database repeats them
 * (KP003, KP007, KP008, KP012) — then the destination row BEFORE the approval (the review trigger requires it and the act) and the
 * immutable OWNER_STEP_UP intent; refund.approved.v1 is the repository's.
 */
export function approveCaptureWithDestination(d: OwnerRefundDependencies, co: CommerceRequestCollaborators, envelope: CommandEnvelope<ApproveRefundBody>): Promise<CommandResult<ApproveRefundView>> {
  const refundId = envelope.path["refundId"] as RefundId;
  const userId = envelope.userId as UserId;
  const body = envelope.body;
  let seenOrder: string | null = null;
  let seenCapture: string | null = null;
  let seenEnvironment: "SANDBOX" | "LIVE" | null = null;
  return runOwnerRefund<ApproveRefundView>(d, {
    operation: "CMD032",
    environment: envelope.environment,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    userId,
    path: envelope.path,
    body,
    async locate(uow) {
      if ((await uow.adoptScope("REFUND", refundId)) === null) throw new NotFoundFailure("refund");
      const seen = await uow.commerce.refunds.get(refundId);
      if (seen === null) throw new NotFoundFailure("refund");
      seenOrder = seen.orderId;
      seenCapture = seen.captureId;
      const instructions = await d.bank!.routes(uow).instructionsOf(seen.orderId);
      if (instructions === null) throw integrity("DESTINATION_UNPROVEN", "the refunded capture was not paid by bank transfer");
      seenEnvironment = instructions.environment;
      return { environment: instructions.environment, accountRef: instructions.accountRef };
    },
    async apply(uow, repo, _causationId, at, destination, proofRef) {
      const c = uow.commerce;
      if (seenOrder === null || seenCapture === null || seenEnvironment === null) throw new DomainFailure("INTEGRITY_FAILURE", "the refund was located before its approval");
      // the shared halves of what the approval relies on (the capture, its live entitlement), then the refund's row lock
      await co.queries.awaitTransition(uow, "kauro.capture_facts", seenCapture);
      const live = await c.authorizations.findLiveByCapture(seenCapture as never);
      if (live !== null) await co.queries.awaitTransition(uow, "kauro.commercial_authorizations", live.authorizationId);
      // the payment service may lock a refund only while it is REQUESTED: one that moved on is answered from its committed row
      const refund = (await c.refunds.lock(refundId)) ?? (await c.refunds.get(refundId));
      if (refund === null) throw new NotFoundFailure("refund");
      const capture = await c.captures.get(refund.captureId);
      const order = await c.orders.get(refund.orderId);
      const quote = order === null ? null : await c.quotes.get(order.quoteId);
      if (capture === null || order === null || quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "the capture, order and quote of a visible refund are visible to its scope");
      const committed = await c.captures.committedRefunds(capture.captureId);
      const balance = refundableBalance(capture, committed);
      const phase = deliveryPhaseOf(live ?? (await c.authorizations.findByQuote(order.quoteId)));
      const requested = approvedComponents(refund.origin, refund.proposed, { serviceCents: moneyField("serviceCents", body.serviceCents), taxCents: moneyField("taxCents", body.taxCents) });

      if (refund.version !== body.expectedVersion) throw new StaleVersionFailure(refund.version, refund.state);
      if (refund.state !== "REQUESTED") throw new DomainFailure("PRECONDITION_FAILED", "the refund is not REQUESTED", { reason: "REFUND_NOT_REQUESTED", currentVersion: refund.version, currentState: refund.state });
      if (capture.status !== "COMPLETED") throw new DomainFailure("PRECONDITION_FAILED", "the capture is not refundable", { reason: "CAPTURE_NOT_REFUNDABLE" });
      const amounts = checkRefundAmounts(refund.origin, balance, requested);
      if (amounts.kind !== "OK") throw refundAmountFailure(amounts);
      if (checkRefundTax(capture.allocation, committed, requested, quote.tax).kind !== "OK") throw refundTaxFailure();
      if (refund.requestedByUserId !== undefined && refund.requestedByUserId === userId) throw new NotAuthorizedFailure("SELF_APPROVAL_FORBIDDEN", "the approver requested this refund");

      const { effects, remaining } = refundEffectsOf(refund, capture.allocation, committed, requested, phase, live !== null);
      const effectsHash = refundEffectsHash(effects);
      const authorizationHash = refundAuthorizationHash({
        refundId: refund.refundId,
        agencyId: refund.agencyId,
        captureId: refund.captureId,
        ...authorizationPreimageMoney(requested),
        reasonCode: refund.reasonCode,
        authorizationKind: "OWNER_STEP_UP",
        authorizationRef: proofRef,
        approvedByUserId: userId,
        approvedAt: at,
        effectsHash,
      });
      // the destination first: the review trigger admits the payment service's approval only with it and the act of this transaction
      await repo.insertDestination({
        destinationId: uow.ids.next(),
        environment: seenEnvironment,
        sourceKind: "CAPTURE",
        agencyId: refund.agencyId,
        refundId: refund.refundId,
        treasuryRefundId: null,
        evidenceArtifactRef: destination.evidenceRef,
        evidenceHash: destination.evidenceHash,
        fingerprint: destination.fingerprint,
        keyId: destination.keyId,
        keyVersion: destination.keyVersion,
        normVersion: destination.normVersion,
        accountLast4: destination.accountLast4,
        holderName: destination.holderName,
        capturedBy: userId,
      });
      const written = await c.refunds.approve(
        refundId,
        refund.version,
        { amounts: requested, authorizationKind: "OWNER_STEP_UP", authorizationProofRef: proofRef as AssuranceProofId, authorizationHash, effectsHash, creditNoteRequired: effects.creditNoteRequired, approvedByUserId: userId, approvedAt: at },
        at,
      );
      if (written.kind === "STALE") throw new StaleVersionFailure(written.currentVersion, written.currentState);
      const view: ApproveRefundView = { refund: refundView(written.record), effects: refundEffectsView(effects, remaining, effectsHash), authorizationKind: "OWNER_STEP_UP" };
      return { status: 200, view, version: written.record.version, resourceKind: "refund", resourceId: refundId };
    },
    replayVersion: (view) => versionOfView(view),
  });
}

// --- BANK_CREDIT: CMD220 ApproveTreasuryRefund -----------------------------------------------------------------------------------------

/** KAURO_TREASURY_REFUND_AUTHORIZATION_V1: the digest of what the owner approved (strings only; no number, no holder name). */
export function treasuryRefundAuthorizationHash(p: { readonly treasuryRefundId: string; readonly bankCreditId: string; readonly amountCents: bigint; readonly approvedByUserId: string; readonly authorizationRef: string; readonly approvedAt: string; readonly destinationFingerprint: string }): Sha256Hex {
  return rawDigest(
    canonicalBytes({
      domain: "kauro.treasury-refund-authorization",
      version: 1,
      payload: { treasuryRefundId: p.treasuryRefundId, bankCreditId: p.bankCreditId, amountCents: formatMoney(p.amountCents), approvedByUserId: p.approvedByUserId, authorizationRef: p.authorizationRef, approvedAt: p.approvedAt, destinationFingerprint: p.destinationFingerprint },
    }),
  ) as Sha256Hex;
}

/** CMD220 ApproveTreasuryRefund (the handlers are composed in execute-refund.ts). */
export function approveTreasuryHandler(d: OwnerRefundDependencies): (request: BankRouteRequest<ApproveTreasuryRefundBody>) => Promise<CommandResult<TreasuryRefundView>> {
  return {
    approveTreasury(request: BankRouteRequest<ApproveTreasuryRefundBody>): Promise<CommandResult<TreasuryRefundView>> {
      const treasuryRefundId = request.path["treasuryRefundId"]!;
      const userId = request.subject.identity.userId as UserId;
      const body = request.body;
      return runOwnerRefund<TreasuryRefundView>(d, {
        operation: BANK_REFUND_COMMAND_IDS.approveTreasury,
        environment: request.environment,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        userId,
        path: request.path,
        body,
        async locate(_uow, repo) {
          const seen = await repo.treasuryRefund(treasuryRefundId);
          if (seen === null) throw new NotFoundFailure("treasury refund");
          return { environment: seen.environment, accountRef: seen.accountRef };
        },
        async apply(uow, repo, causationId, at, destination, proofRef) {
          const row = await repo.lockTreasuryRefund(treasuryRefundId);
          if (row === null) throw new NotFoundFailure("treasury refund");
          if (row.version !== body.expectedVersion) throw new StaleVersionFailure(row.version, row.state);
          if (row.state !== "REQUESTED") throw new DomainFailure("PRECONDITION_FAILED", "the treasury refund is not REQUESTED", { reason: "REFUND_NOT_REQUESTED", currentVersion: row.version, currentState: row.state });
          const service = moneyField("serviceCents", body.serviceCents);
          const tax = moneyField("taxCents", body.taxCents);
          // excess-only (D-ACH-13): the one amount, no other component
          if (service + tax > row.amountCents) throw refundAmountFailure({ kind: "EXCEEDS", fields: ["serviceCents"] });
          if (tax !== 0n || service !== row.amountCents) throw refundAmountFailure({ kind: "WRONG_COMPONENT" });
          await repo.insertDestination({
            destinationId: uow.ids.next(),
            environment: row.environment,
            sourceKind: "BANK_CREDIT",
            agencyId: null,
            refundId: null,
            treasuryRefundId: row.treasuryRefundId,
            evidenceArtifactRef: destination.evidenceRef,
            evidenceHash: destination.evidenceHash,
            fingerprint: destination.fingerprint,
            keyId: destination.keyId,
            keyVersion: destination.keyVersion,
            normVersion: destination.normVersion,
            accountLast4: destination.accountLast4,
            holderName: destination.holderName,
            capturedBy: userId,
          });
          const authorizationHash = treasuryRefundAuthorizationHash({ treasuryRefundId: row.treasuryRefundId, bankCreditId: row.bankCreditId, amountCents: row.amountCents, approvedByUserId: userId, authorizationRef: proofRef, approvedAt: at, destinationFingerprint: destination.fingerprint });
          const approved = await repo.approveTreasuryRefund(row.treasuryRefundId, row.version, { approvedByUserId: userId, authorizationProofRef: proofRef, authorizationHash, approvedAt: at });
          if (approved === null) {
            const now = await repo.treasuryRefund(row.treasuryRefundId);
            throw new StaleVersionFailure(now?.version ?? row.version, now?.state ?? row.state);
          }
                    await uow.events.publish({
            aggregateKind: "treasury_refund",
            aggregateId: approved.treasuryRefundId as never,
            aggregateVersion: approved.version,
            agencyId: null,
            eventType: "treasury_refund.approved.v1",
            actor: actorOf({ kind: "SERVICE", serviceId: d.paymentServiceId, correlationId: request.correlationId }),
            causationId,
            correlationId: request.correlationId,
            payload: { treasuryRefundId: approved.treasuryRefundId, routeId: approved.routeId, bankCreditId: approved.bankCreditId, amountCents: Number(approved.amountCents), authorizationHash, destinationFingerprint: destination.fingerprint, previousState: row.state },
          });
          const view: TreasuryRefundView = {
            treasuryRefund: { treasuryRefundId: approved.treasuryRefundId, state: approved.state, version: approved.version, amountCents: formatMoney(approved.amountCents), bankCreditId: approved.bankCreditId, destinationLast4: destination.accountLast4 },
          };
          return { status: 200, view, version: approved.version, resourceKind: "treasury_refund", resourceId: approved.treasuryRefundId };
        },
        replayVersion: (view) => view.treasuryRefund.version,
      });
    },
  }.approveTreasury;
}

/**
 * planObservation — steps 3 to 6 of the reconciler (design §6.3) as a pure function: given the facts of one order read inside
 * the SERVICE unit of work under the order's row lock, and one authenticated observation, it decides every write in the lock
 * order of §6.2 (payment order → attempt → capture → commercial authorization → refund; then the appended rows: server refund
 * requests, cases, provider exceptions, scope keys, observations), each version with the event `commerceVersionEventType` names
 * (D-EVT-B3), and the observation's effect per subject. The executor (CommerceReconciler) only performs the plan.
 *
 * The observation comes from one of the three sources of an authenticated provider fact (D-PAY-B3): a dispatch response of an
 * attempt (CMD028, CMD029, CMD033 — or the resume's read by the attempt's request identity), a stored provider query (CMD034, the
 * watchdog) or a verified webhook event (CMD030). The same algorithm applies all of them:
 *
 *  3. match — a capture of another provider, environment, order, payee or currency is never a fact of this order: it becomes the
 *     provider exception of the same kind with its source (S058; D-ING-B3), and nothing of the order changes;
 *  4. order the observation — an observation this source already applied to the subject is a DUPLICATE (and appends nothing: a
 *     webhook event and a query artifact apply once per subject), one older in provider chronology than the latest applied is
 *     STALE_IGNORED, a contradiction of a terminal state opens PROVIDER_INCONSISTENCY, an unknown status is UNRECOGNIZED and opens
 *     UNRECOGNIZED_PROVIDER_STATE;
 *  5. step — the capture lattice (captureStatusStep; a REVERSED observation of an unknown or PENDING capture is its completion then
 *     its reversal, D-PAY-B5), one version and one event per edge; the allocation at the COMPLETED version (allocateCapture); a fee
 *     or a funds availability learned later is a version of its own (D-EVT-B2); a completion needs the provider's completion
 *     instant, the sale's tax point (D-PAY-B6 below);
 *  6. consequences — the order's edge, the attempt's result, the CommercialAuthorization when the capture alone pays the whole
 *     obligation and the subject still binds (issuanceBlockers, D-AUTH-B3), AMOUNT_MISMATCH / EXCESS_CAPTURE /
 *     CAPTURE_WITHOUT_VALID_SUBJECT cases with the EXCESS_CAPTURE and KAURO_REMEDY refund requests (R2-140, D-REF-B1), a reversal's
 *     revocation with its phase and the lapse of APPROVED refunds (S059), a refund's result and the revocation of an entitlement
 *     left without service basis (D-REF-B5), a dispute's DISPUTE_OPEN case with the funds HELD (D-DISPUTE-B1).
 *
 * D-PAY-B6 (the residual finding FINAL-N2; decisions register §12): a completion — a capture observed COMPLETED, or REVERSED while
 * unknown or PENDING (D-PAY-B5) — is recorded only with the provider's completion instant, which is the sale's tax point and the
 * price-expiry comparison. When an observation lacks it, nothing is applied (no fact and no observation row, so a webhook's inbox
 * record can be applied once the instant is known) and the plan asks for a stored provider query of the order
 * (`providerQueryRequired`); when a stored query lacks it as well, a PROVIDER_INCONSISTENCY case (COMPLETION_TIME_UNKNOWN) is opened
 * and nothing is applied — a tax point is never invented.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  CaptureFactRecord,
  CaptureId,
  CaptureStatus,
  CommercialAuthorizationId,
  CommercialAuthorizationRecord,
  EvidenceArtifactRef,
  FiscalProfileRecord,
  InboxId,
  NewCaptureFact,
  NewCommercialAuthorization,
  NewProviderObservation,
  NewReconciliationCase,
  NewRefundRequest,
  NormalizedProviderEvent,
  ObservationEffect,
  ObservationSource,
  ObservedCapture,
  ObservedDispute,
  ObservedRefund,
  PaymentAttemptId,
  PaymentAttemptRecord,
  PaymentAttemptState,
  PaymentOrderChange,
  PaymentOrderRecord,
  PaymentOrderState,
  ProviderEventExceptionRecord,
  ProviderExceptionKind,
  ProviderObservationRecord,
  QuoteRecord,
  ReconciliationCaseId,
  ReconciliationCaseKind,
  RefundChange,
  RefundComponents,
  RefundId,
  RefundOrigin,
  RefundRecord,
  RefundState,
  ScopeEntry,
  AttemptChange,
  AuthorizationChange,
  CaptureAdvance,
  FundsState,
} from "@kauro/domain";
import {
  ZERO_COMPONENTS,
  allocateCapture,
  authorizesObligation,
  captureStatusStep,
  deliveryPhaseOf,
  honoredAfterPriceExpiry,
  instantMs,
  machine,
  matchCapture,
  movableBalanceOf,
  proposeRefund,
  providerScopeKey,
  refundReturnOf,
  refundableBalance,
  returnedCentsOf,
  revocationPhaseOf,
} from "@kauro/domain";
import type { ProviderDispatchResult, ProviderOrderObservation } from "../ports.js";
import { versionEvent, type VersionEvent } from "./events.js";
import { issuanceBlockers, type PurchasedSubject } from "./subject.js";

// --- inputs -------------------------------------------------------------------------------------------------------------------

/** Where an authenticated observation came from (provider_observations.source and its key; D-PAY-B3). */
export type ObservationOrigin =
  | { readonly source: "DISPATCH_RESPONSE"; readonly attemptId: PaymentAttemptId }
  | { readonly source: "PROVIDER_QUERY"; readonly artifactRef: EvidenceArtifactRef }
  | { readonly source: "WEBHOOK"; readonly inboxId: InboxId };

/** What was observed: a dispatch result, an order query (by provider id or by request identity), or a verified provider event. */
export type ObservationContent =
  | { readonly kind: "DISPATCH_RESULT"; readonly result: ProviderDispatchResult }
  | { readonly kind: "ORDER_OBSERVATION"; readonly observation: ProviderOrderObservation }
  | { readonly kind: "PROVIDER_EVENT"; readonly event: NormalizedProviderEvent };

/** The facts of one order, read inside the SERVICE unit of work under the order's row lock (design §6.2, §6.3 step 2). */
export interface ObservationFacts {
  readonly now: UtcInstant;
  readonly order: PaymentOrderRecord;
  readonly quote: QuoteRecord;
  /** The purchased subject (PurchasedSubjectReader), read after the shared halves of its transition locks. */
  readonly subject: PurchasedSubject | null;
  /** The agency's current fiscal profile (D-AUTH-B3: the quoted rule must still be the current one to honor a late capture). */
  readonly currentProfile: FiscalProfileRecord | null;
  readonly attempts: ReadonlyArray<PaymentAttemptRecord>;
  readonly captures: ReadonlyArray<CaptureFactRecord>;
  /** The entitlements of the quote and of the order's captures. */
  readonly authorizations: ReadonlyArray<CommercialAuthorizationRecord>;
  /** The refunds of the order's captures. */
  readonly refunds: ReadonlyArray<RefundRecord>;
  /** The observations already applied to the order (history; D-PAY-B3). */
  readonly observations: ReadonlyArray<ProviderObservationRecord>;
  /** The provider adapter's allowlisted approval hosts (10: redirects never go to an arbitrary origin). */
  readonly approvalHosts: ReadonlyArray<string>;
  /** MAX_ATTEMPTS_PER_OPERATION (D-PROTO-B3). */
  readonly maxAttempts: number;
  /**
   * A blocker of the issuance the caller judged under its own locks at the effect instant, beside the subject's (a bank credit's
   * transfer deadline, provider time, route or retired checkout; ACH-ROUTE §7.10 P1, DV1-06): the capture stands without authority.
   */
  readonly authorityBlocker?: string | null;
}

export interface ObservationInput {
  readonly origin: ObservationOrigin;
  readonly content: ObservationContent;
  /** Mints the ids of the rows the plan creates (the unit of work's generator; B06 D-PORT-1). */
  readonly mint: () => string;
}

// --- the plan -----------------------------------------------------------------------------------------------------------------

export type PlanStep =
  | { readonly op: "ORDER_TRANSITION"; readonly orderId: PaymentOrderRecord["orderId"]; readonly expectedVersion: number; readonly change: PaymentOrderChange; readonly event: VersionEvent }
  | { readonly op: "ATTEMPT_TRANSITION"; readonly attemptId: PaymentAttemptId; readonly expectedVersion: number; readonly change: AttemptChange; readonly event: VersionEvent }
  | { readonly op: "CAPTURE_INSERT"; readonly fact: NewCaptureFact; readonly event: VersionEvent }
  | { readonly op: "CAPTURE_ADVANCE"; readonly captureId: CaptureId; readonly expectedVersion: number; readonly change: CaptureAdvance; readonly event: VersionEvent }
  | { readonly op: "CAPTURE_FEE"; readonly captureId: CaptureId; readonly expectedVersion: number; readonly change: { readonly providerFeeCents: bigint; readonly observedAt: UtcInstant; readonly evidenceHash: Sha256Hex }; readonly event: VersionEvent }
  | { readonly op: "CAPTURE_FUNDS"; readonly captureId: CaptureId; readonly expectedVersion: number; readonly change: { readonly fundsState: Exclude<FundsState, "UNKNOWN">; readonly observedAt: UtcInstant; readonly evidenceHash: Sha256Hex }; readonly event: VersionEvent }
  | { readonly op: "AUTHORIZATION_ISSUE"; readonly authorization: NewCommercialAuthorization; readonly event: VersionEvent }
  | { readonly op: "AUTHORIZATION_TRANSITION"; readonly authorizationId: CommercialAuthorizationId; readonly expectedVersion: number; readonly change: AuthorizationChange; readonly event: VersionEvent }
  | { readonly op: "REFUND_TRANSITION"; readonly refundId: RefundId; readonly expectedVersion: number; readonly change: RefundChange; readonly event: VersionEvent }
  /** A server-originated request, filed ON CONFLICT DO NOTHING (D-REF-B1): its event and scope row follow only when it was filed. */
  | { readonly op: "REFUND_FILE"; readonly request: NewRefundRequest; readonly event: VersionEvent; readonly scope: ScopeEntry }
  /** Opened, or the open case of the same kind and subject (one per kind and subject): its event follows only when opened. */
  | { readonly op: "CASE_OPEN"; readonly entry: NewReconciliationCase; readonly event: VersionEvent }
  | { readonly op: "EXCEPTION"; readonly exception: Omit<ProviderEventExceptionRecord, "exceptionId"> }
  | { readonly op: "SCOPE"; readonly entry: ScopeEntry }
  | { readonly op: "OBSERVATION"; readonly observation: NewProviderObservation };

export interface ObservationPlan {
  /** Every write, in the lock order of design §6.2. */
  readonly steps: ReadonlyArray<PlanStep>;
  /** The observation's effect on each subject it named (design §6.3 step 7). */
  readonly effects: ReadonlyArray<{ readonly about: "ORDER" | "CAPTURE" | "REFUND"; readonly effect: ObservationEffect }>;
  /** The provider exceptions the observation raised (a capture or refund no fact of this order can take). */
  readonly exceptions: ReadonlyArray<ProviderExceptionKind>;
  /** The CommercialAuthorization the plan issues, if any. */
  readonly authorizationIssued: CommercialAuthorizationId | null;
  /** D-PAY-B6: nothing was applied because a completion lacked its instant; a stored provider query of the order must follow. */
  readonly providerQueryRequired: boolean;
}

// --- helpers --------------------------------------------------------------------------------------------------------------------

const RANK: Readonly<Record<PlanStep["op"], number>> = Object.freeze({
  ORDER_TRANSITION: 0,
  ATTEMPT_TRANSITION: 1,
  CAPTURE_INSERT: 2,
  CAPTURE_ADVANCE: 2,
  CAPTURE_FEE: 2,
  CAPTURE_FUNDS: 2,
  AUTHORIZATION_ISSUE: 3,
  AUTHORIZATION_TRANSITION: 3,
  REFUND_TRANSITION: 4,
  REFUND_FILE: 5,
  CASE_OPEN: 6,
  EXCEPTION: 7,
  SCOPE: 8,
  OBSERVATION: 9,
});

const LIVE_ATTEMPT: ReadonlySet<PaymentAttemptState> = new Set<PaymentAttemptState>(["DISPATCHING", "PROVIDER_PENDING", "UNCERTAIN"]);
const TOKEN = /^[A-Z][A-Z0-9_]{2,63}$/;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function listed(name: "PaymentOrder" | "PaymentAttempt" | "Refund" | "CommercialAuthorization", from: string, to: string): boolean {
  return machine(name).transitions.some((t) => t.from === from && t.to === to);
}

function tokenOr(value: string, fallback: string): string {
  const upper = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return TOKEN.test(upper) ? upper : fallback;
}

function currencyToken(value: string): string | undefined {
  return /^[A-Z]{3}$/.test(value) ? value : undefined;
}

function sumComponents(list: ReadonlyArray<RefundComponents>): RefundComponents {
  return list.reduce<RefundComponents>((acc, c) => ({ serviceCents: acc.serviceCents + c.serviceCents, taxCents: acc.taxCents + c.taxCents, excessCents: acc.excessCents + c.excessCents }), ZERO_COMPONENTS);
}

function total(c: RefundComponents): bigint {
  return c.serviceCents + c.taxCents + c.excessCents;
}

function isHostAllowed(url: string, hosts: ReadonlyArray<string>): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && hosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The planner's working state: copies of the facts it changes, so a later step of the same plan sees an earlier one (a capture
 * completed and then reversed, an order allocation that grows capture by capture, versions that advance by one per step).
 */
class Planner {
  private readonly steps: PlanStep[] = [];
  private readonly effects: Array<{ readonly about: "ORDER" | "CAPTURE" | "REFUND"; readonly effect: ObservationEffect }> = [];
  private readonly exceptions: ProviderExceptionKind[] = [];
  private readonly casesPlanned = new Set<string>();
  private readonly observed = new Set<string>();
  private authorizationIssued: CommercialAuthorizationId | null = null;
  private providerQueryRequired = false;

  private order: Mutable<PaymentOrderRecord>;
  private readonly attempts = new Map<string, Mutable<PaymentAttemptRecord>>();
  private readonly captures = new Map<string, Mutable<CaptureFactRecord>>();
  private readonly authorizations = new Map<string, Mutable<CommercialAuthorizationRecord>>();
  private readonly refunds = new Map<string, Mutable<RefundRecord>>();

  constructor(private readonly facts: ObservationFacts, private readonly input: ObservationInput) {
    this.order = { ...facts.order };
    for (const a of facts.attempts) this.attempts.set(a.attemptId, { ...a });
    for (const c of facts.captures) this.captures.set(c.captureId, { ...c });
    for (const a of facts.authorizations) this.authorizations.set(a.authorizationId, { ...a });
    for (const r of facts.refunds) this.refunds.set(r.refundId, { ...r });
  }

  private get now(): UtcInstant {
    return this.facts.now;
  }

  private get agencyId(): AgencyId {
    return this.order.agencyId;
  }

  private get source(): ObservationSource {
    return this.input.origin.source;
  }

  plan(): ObservationPlan {
    const content = this.input.content;
    switch (content.kind) {
      case "DISPATCH_RESULT":
        this.dispatchResult(content.result);
        break;
      case "ORDER_OBSERVATION":
        this.orderObservation(content.observation, this.dispatchAttempt());
        break;
      case "PROVIDER_EVENT":
        this.providerEvent(content.event);
        break;
    }
    const steps = this.steps.map((s, i) => ({ s, i })).sort((a, b) => RANK[a.s.op] - RANK[b.s.op] || a.i - b.i).map((x) => x.s);
    return Object.freeze({
      steps: Object.freeze(steps),
      effects: Object.freeze([...this.effects]),
      exceptions: Object.freeze([...this.exceptions]),
      authorizationIssued: this.authorizationIssued,
      providerQueryRequired: this.providerQueryRequired,
    });
  }

  // --- origin ---------------------------------------------------------------------------------------------------------------

  private dispatchAttempt(): Mutable<PaymentAttemptRecord> | null {
    const origin = this.input.origin;
    if (origin.source !== "DISPATCH_RESPONSE") return null;
    const attempt = this.attempts.get(origin.attemptId);
    if (attempt === undefined || attempt.orderId !== this.order.orderId) throw new RangeError("a dispatch response names an attempt of the order it is applied to (D-BIND-B2)");
    return attempt;
  }

  private liveAttempt(operation: "CREATE_ORDER" | "CAPTURE"): Mutable<PaymentAttemptRecord> | null {
    const dispatch = this.dispatchAttempt();
    if (dispatch !== null && dispatch.operation === operation) return dispatch;
    for (const a of this.attempts.values()) if (a.operation === operation && a.refundId === undefined && LIVE_ATTEMPT.has(a.state)) return a;
    return null;
  }

  private refundAttempt(refundId: RefundId): Mutable<PaymentAttemptRecord> | null {
    const dispatch = this.dispatchAttempt();
    if (dispatch !== null && dispatch.refundId === refundId) return dispatch;
    for (const a of this.attempts.values()) if (a.refundId === refundId && LIVE_ATTEMPT.has(a.state)) return a;
    return null;
  }

  /** The key under which this source records an observation of a subject once (provider_observations_once_per_*). */
  private sourceKey(subjectKind: string, providerRef: string): string | null {
    const origin = this.input.origin;
    if (origin.source === "WEBHOOK") return `WEBHOOK|${origin.inboxId}|${subjectKind}|${providerRef}`;
    if (origin.source === "PROVIDER_QUERY") return `QUERY|${origin.artifactRef}|${subjectKind}|${providerRef}`;
    return null;
  }

  private alreadyApplied(subjectKind: "ORDER" | "CAPTURE" | "REFUND", providerRef: string): boolean {
    const origin = this.input.origin;
    const key = this.sourceKey(subjectKind, providerRef);
    if (key !== null && this.observed.has(key)) return true;
    return this.facts.observations.some(
      (o) =>
        o.subjectKind === subjectKind &&
        o.providerRef === providerRef &&
        ((origin.source === "WEBHOOK" && o.inboxId === origin.inboxId) || (origin.source === "PROVIDER_QUERY" && o.artifactRef === origin.artifactRef)),
    );
  }

  /** An observation older in provider chronology than the latest one applied to the subject changes nothing (15; D-PAY-B3). */
  private isStale(subjectKind: "ORDER" | "CAPTURE" | "REFUND", providerRef: string, providerEventAt: UtcInstant | undefined): boolean {
    if (providerEventAt === undefined) return false;
    const t = instantMs(providerEventAt);
    return this.facts.observations.some((o) => o.subjectKind === subjectKind && o.providerRef === providerRef && o.effect === "ADVANCED" && o.providerEventAt !== undefined && instantMs(o.providerEventAt) > t);
  }

  private observation(o: {
    readonly subjectKind: "ORDER" | "CAPTURE" | "REFUND";
    readonly providerRef: string;
    readonly observedStatus: string;
    readonly effect: ObservationEffect;
    readonly evidenceHash: Sha256Hex;
    readonly amountCents?: bigint;
    readonly currency?: string;
    readonly payeeDigest?: Sha256Hex;
    readonly providerEventAt?: UtcInstant;
  }): void {
    this.effects.push({ about: o.subjectKind, effect: o.effect });
    const key = this.sourceKey(o.subjectKind, o.providerRef);
    if (key !== null) {
      if (this.observed.has(key)) return;
      this.observed.add(key);
    }
    const origin = this.input.origin;
    const currency = o.currency === undefined ? undefined : currencyToken(o.currency);
    const status = o.effect === "UNRECOGNIZED" ? "UNRECOGNIZED" : tokenOr(o.observedStatus, "OBSERVED");
    this.steps.push({
      op: "OBSERVATION",
      observation: {
        agencyId: this.agencyId,
        orderId: this.order.orderId,
        source: origin.source,
        ...(origin.source === "WEBHOOK" ? { inboxId: origin.inboxId } : {}),
        ...(origin.source === "DISPATCH_RESPONSE" ? { attemptId: origin.attemptId } : {}),
        ...(origin.source === "PROVIDER_QUERY" ? { artifactRef: origin.artifactRef } : {}),
        subjectKind: o.subjectKind,
        providerRef: o.providerRef,
        observedStatus: status === "UNRECOGNIZED" && o.effect !== "UNRECOGNIZED" ? "UNRECOGNIZED_STATUS" : status,
        ...(o.amountCents !== undefined ? { amountCents: o.amountCents } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(o.payeeDigest !== undefined ? { payeeDigest: o.payeeDigest } : {}),
        ...(o.providerEventAt !== undefined ? { providerEventAt: o.providerEventAt } : {}),
        observedAt: this.now,
        evidenceHash: o.evidenceHash,
        effect: o.effect,
      },
    });
  }

  private exception(kind: ProviderExceptionKind, detail: { readonly providerRef?: string; readonly amountCents?: bigint; readonly currency?: string; readonly evidenceHash: Sha256Hex }): void {
    this.exceptions.push(kind);
    const origin = this.input.origin;
    const currency = detail.currency === undefined ? undefined : currencyToken(detail.currency);
    this.steps.push({
      op: "EXCEPTION",
      exception: {
        source: origin.source,
        // a stored operation's order attributes the exception (D-ING-B3); a webhook attributed to this order is attributed too
        agencyId: this.agencyId,
        orderId: this.order.orderId,
        ...(origin.source === "WEBHOOK" ? { inboxId: origin.inboxId } : {}),
        ...(origin.source === "DISPATCH_RESPONSE" ? { attemptId: origin.attemptId } : {}),
        ...(origin.source === "PROVIDER_QUERY" ? { artifactRef: origin.artifactRef } : {}),
        provider: this.order.provider,
        environment: this.order.environment,
        kind,
        ...(detail.providerRef !== undefined ? { providerRef: detail.providerRef } : {}),
        ...(detail.amountCents !== undefined && currency !== undefined ? { amountCents: detail.amountCents, currency } : {}),
        evidenceHash: detail.evidenceHash,
        observedAt: this.now,
      },
    });
  }

  private openCase(kind: ReconciliationCaseKind, subject: { readonly captureId?: CaptureId; readonly refundId?: RefundId; readonly providerRef?: string }, detailCode: string, evidenceHash: Sha256Hex, amountCents?: bigint): void {
    // a case that names a capture or a refund always names its order too: one purchase (D-BIND-B2; residual FINAL-N1); a provider
    // object no local fact holds is part of the subject (a provider refund no local refund explains, B09-R1; migration 0019)
    const key = `${kind}|${this.order.orderId}|${subject.captureId ?? "-"}|${subject.refundId ?? "-"}|${subject.providerRef ?? "-"}`;
    if (this.casesPlanned.has(key)) return;
    this.casesPlanned.add(key);
    const caseId = this.input.mint() as ReconciliationCaseId;
    const detail = tokenOr(detailCode, "UNSPECIFIED");
    const entry: NewReconciliationCase = {
      caseId,
      agencyId: this.agencyId,
      orderId: this.order.orderId,
      ...(subject.captureId !== undefined ? { captureId: subject.captureId } : {}),
      ...(subject.refundId !== undefined ? { refundId: subject.refundId } : {}),
      ...(subject.providerRef !== undefined ? { providerRef: subject.providerRef } : {}),
      kind,
      detailCode: detail,
      ...(amountCents !== undefined ? { amountCents, currency: this.order.currency } : {}),
      evidenceHash,
      openedAt: this.now,
    };
    this.steps.push({
      op: "CASE_OPEN",
      entry,
      event: versionEvent("reconciliation_case", caseId, 1, this.agencyId, { previousState: null, state: "OPEN" }, {
        caseId,
        agencyId: this.agencyId,
        orderId: this.order.orderId,
        captureId: subject.captureId,
        refundId: subject.refundId,
        kind,
        detailCode: detail,
        amountCents,
        currency: amountCents !== undefined ? this.order.currency : undefined,
      }),
    });
  }

  // --- versioned writes -----------------------------------------------------------------------------------------------------

  private orderTo(state: PaymentOrderState, extra: { readonly attemptId?: string; readonly captureId?: string; readonly outcomeCode?: string; readonly providerOrderId?: string; readonly providerApprovalUrl?: string } = {}): boolean {
    const o = this.order;
    if (o.state === state || !listed("PaymentOrder", o.state, state)) return false;
    const previousState = o.state;
    const change: PaymentOrderChange = {
      state,
      ...(extra.providerOrderId !== undefined ? { providerOrderId: extra.providerOrderId } : {}),
      ...(extra.providerApprovalUrl !== undefined ? { providerApprovalUrl: extra.providerApprovalUrl } : {}),
    };
    const version = o.version + 1;
    this.steps.push({
      op: "ORDER_TRANSITION",
      orderId: o.orderId,
      expectedVersion: o.version,
      change,
      event: versionEvent("payment_order", o.orderId, version, this.agencyId, { previousState, state }, {
        orderId: o.orderId,
        agencyId: this.agencyId,
        attemptId: extra.attemptId,
        captureId: extra.captureId,
        outcomeCode: extra.outcomeCode,
        previousState,
      }),
    });
    this.order = { ...o, state, version, ...(extra.providerOrderId !== undefined ? { providerOrderId: extra.providerOrderId } : {}), ...(extra.providerApprovalUrl !== undefined ? { providerApprovalUrl: extra.providerApprovalUrl } : {}) };
    return true;
  }

  private attemptTo(attempt: Mutable<PaymentAttemptRecord>, state: PaymentAttemptState, extra: { readonly evidenceHash?: Sha256Hex; readonly outcomeCode?: string } = {}): boolean {
    if (attempt.state === state || !listed("PaymentAttempt", attempt.state, state)) return false;
    const previousState = attempt.state;
    const outcomeCode = extra.outcomeCode === undefined ? undefined : tokenOr(extra.outcomeCode, "PROVIDER_OUTCOME");
    const change: AttemptChange = {
      state,
      lastObservedAt: this.now,
      ...(extra.evidenceHash !== undefined ? { evidenceHash: extra.evidenceHash } : {}),
      ...(outcomeCode !== undefined ? { outcomeCode } : {}),
    };
    const version = attempt.version + 1;
    this.steps.push({
      op: "ATTEMPT_TRANSITION",
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      change,
      event: versionEvent("payment_attempt", attempt.attemptId, version, this.agencyId, { previousState, state }, {
        attemptId: attempt.attemptId,
        agencyId: this.agencyId,
        orderId: attempt.orderId,
        refundId: attempt.refundId,
        operation: attempt.operation,
        ordinal: attempt.ordinal,
        evidenceHash: extra.evidenceHash,
        outcomeCode,
        previousState,
      }),
    });
    const next: Mutable<PaymentAttemptRecord> = { ...attempt, state, version, lastObservedAt: this.now };
    if (extra.evidenceHash !== undefined) next.evidenceHash = extra.evidenceHash;
    if (outcomeCode !== undefined) next.outcomeCode = outcomeCode;
    this.attempts.set(attempt.attemptId, next);
    Object.assign(attempt, next);
    return true;
  }

  private refundTo(refund: Mutable<RefundRecord>, state: RefundState, extra: { readonly attemptId?: string; readonly providerRefundId?: string; readonly evidenceHash?: Sha256Hex; readonly failureCode?: string } = {}): boolean {
    if (refund.state === state || !listed("Refund", refund.state, state)) return false;
    const previousState = refund.state;
    const capture = this.captures.get(refund.captureId);
    const change: RefundChange = {
      state,
      ...(extra.providerRefundId !== undefined ? { providerRefundId: extra.providerRefundId } : {}),
      ...(extra.evidenceHash !== undefined ? { evidenceHash: extra.evidenceHash } : {}),
      ...(state === "COMPLETED" ? { completedAt: this.now } : {}),
      ...(extra.failureCode !== undefined ? { failureCode: tokenOr(extra.failureCode, "PROVIDER_REFUSED") } : {}),
    };
    const version = refund.version + 1;
    const approved = refund.approved;
    let members: Record<string, string | number | boolean | bigint | undefined>;
    switch (state) {
      case "COMPLETED": {
        const completedService = [...this.refunds.values()].filter((r) => r.captureId === refund.captureId && r.state === "COMPLETED" && r.refundId !== refund.refundId).reduce((acc, r) => acc + (r.approved?.amounts.serviceCents ?? 0n), 0n);
        const allocated = capture?.allocation.serviceCents ?? 0n;
        const basisAfter = allocated - completedService - (approved?.amounts.serviceCents ?? 0n);
        // what this completion returns from the capture: its approved components, or nothing once the capture's reversal returned
        // every component no completed refund had (D-LEDGER-B7; B09-R2) — each return nets against the capture exactly once
        const returns = approved === undefined ? undefined : capture === undefined ? approved.amounts : refundReturnOf(approved.amounts, capture.status);
        members = {
          refundId: refund.refundId,
          agencyId: this.agencyId,
          projectId: refund.projectId,
          orderId: refund.orderId,
          captureId: refund.captureId,
          serviceCents: approved?.amounts.serviceCents,
          taxCents: approved?.amounts.taxCents,
          excessCents: approved?.amounts.excessCents,
          serviceBasisAfterCents: basisAfter < 0n ? 0n : basisAfter,
          // the balance the returned money is taken from, as the capture's funds stand at this version (D-LEDGER-B5), and the
          // capture's movable balance before this refund: what the return takes beyond it is the fee the provider keeps (D-LEDGER-B6)
          fundsState: capture?.fundsState ?? "UNKNOWN",
          movableBalanceCents:
            capture === undefined
              ? undefined
              : movableBalanceOf({ amountCents: capture.amountCents, providerFeeCents: capture.providerFeeCents ?? 0n, returnedCents: returnedCentsOf(capture, total(this.completedRefundsOf(refund.captureId, refund.refundId))) }),
          returnedServiceCents: returns?.serviceCents,
          returnedTaxCents: returns?.taxCents,
          returnedExcessCents: returns?.excessCents,
          previousState,
          evidenceHash: extra.evidenceHash,
        };
        break;
      }
      case "APPROVED":
        members = {
          refundId: refund.refundId,
          agencyId: this.agencyId,
          captureId: refund.captureId,
          serviceCents: approved?.amounts.serviceCents,
          taxCents: approved?.amounts.taxCents,
          excessCents: approved?.amounts.excessCents,
          authorizationKind: approved?.authorizationKind,
          authorizationHash: approved?.authorizationHash,
          effectsHash: approved?.effectsHash,
          creditNoteRequired: approved?.creditNoteRequired,
          previousState,
          attemptId: extra.attemptId,
        };
        break;
      case "FAILED":
        members = { refundId: refund.refundId, agencyId: this.agencyId, failureCode: change.failureCode, previousState };
        break;
      default:
        members = { refundId: refund.refundId, agencyId: this.agencyId, attemptId: extra.attemptId, previousState };
    }
    this.steps.push({ op: "REFUND_TRANSITION", refundId: refund.refundId, expectedVersion: refund.version, change, event: versionEvent("refund", refund.refundId, version, this.agencyId, { previousState, state }, members) });
    const next: Mutable<RefundRecord> = { ...refund, state, version };
    if (extra.providerRefundId !== undefined) next.providerRefundId = extra.providerRefundId;
    if (extra.evidenceHash !== undefined) next.evidenceHash = extra.evidenceHash;
    if (state === "COMPLETED") next.completedAt = this.now;
    if (change.failureCode !== undefined) next.failureCode = change.failureCode;
    this.refunds.set(refund.refundId, next);
    Object.assign(refund, next);
    return true;
  }

  private revoke(authorization: Mutable<CommercialAuthorizationRecord>, code: "CAPTURE_REVERSED" | "SERVICE_FULLY_REFUNDED"): void {
    if (authorization.state === "REVOKED") return;
    const previousState = authorization.state;
    const phase = revocationPhaseOf(previousState);
    const version = authorization.version + 1;
    this.steps.push({
      op: "AUTHORIZATION_TRANSITION",
      authorizationId: authorization.authorizationId,
      expectedVersion: authorization.version,
      change: { state: "REVOKED", revocation: { at: this.now, phase, code } },
      event: versionEvent("commercial_authorization", authorization.authorizationId, version, this.agencyId, { previousState, state: "REVOKED" }, {
        authorizationId: authorization.authorizationId,
        agencyId: this.agencyId,
        projectId: authorization.projectId,
        captureId: authorization.captureId,
        phase,
        revocationCode: code,
        previousState,
      }),
    });
    Object.assign(authorization, { state: "REVOKED", version, revokedAt: this.now, revocationPhase: phase, revocationCode: code });
  }

  private liveAuthorizationOf(captureId: CaptureId): Mutable<CommercialAuthorizationRecord> | null {
    for (const a of this.authorizations.values()) if (a.captureId === captureId && a.state !== "REVOKED") return a;
    return null;
  }

  /** The components the completed refunds of a capture returned (all but `except`, the refund being completed). */
  private completedRefundsOf(captureId: CaptureId, except?: RefundId): RefundComponents {
    return sumComponents([...this.refunds.values()].filter((r) => r.captureId === captureId && r.state === "COMPLETED" && r.refundId !== except && r.approved !== undefined).map((r) => r.approved!.amounts));
  }

  private committedRefundsOf(captureId: CaptureId): RefundComponents {
    return sumComponents([...this.refunds.values()].filter((r) => r.captureId === captureId && (r.state === "APPROVED" || r.state === "SUBMITTING" || r.state === "UNCERTAIN" || r.state === "COMPLETED") && r.approved !== undefined).map((r) => r.approved!.amounts));
  }

  private fileServerRequest(capture: Mutable<CaptureFactRecord>, origin: Extract<RefundOrigin, "EXCESS_CAPTURE" | "KAURO_REMEDY">, reasonCode: string): void {
    const balance = refundableBalance(capture, this.committedRefundsOf(capture.captureId));
    const proposed = proposeRefund(origin, balance);
    if (total(proposed) === 0n) return;
    const refundId = this.input.mint() as RefundId;
    const deliveryPhase = deliveryPhaseOf(this.liveAuthorizationOf(capture.captureId));
    const request: NewRefundRequest = {
      refundId,
      agencyId: this.agencyId,
      projectId: this.order.projectId,
      orderId: this.order.orderId,
      captureId: capture.captureId,
      origin,
      reasonCode,
      termsHash: this.order.termsHash,
      deliveryPhase,
      proposed,
      requestedAt: this.now,
    };
    this.steps.push({
      op: "REFUND_FILE",
      request,
      event: versionEvent("refund", refundId, 1, this.agencyId, { previousState: null, state: "REQUESTED" }, {
        refundId,
        agencyId: this.agencyId,
        projectId: this.order.projectId,
        orderId: this.order.orderId,
        captureId: capture.captureId,
        origin,
        deliveryPhase,
        proposedServiceCents: proposed.serviceCents,
        proposedTaxCents: proposed.taxCents,
        proposedExcessCents: proposed.excessCents,
      }),
      scope: { kind: "REFUND", key: refundId, agencyId: this.agencyId, orderId: this.order.orderId, refundId },
    });
  }

  // --- dispatch results -----------------------------------------------------------------------------------------------------

  private dispatchResult(result: ProviderDispatchResult): void {
    const attempt = this.dispatchAttempt();
    if (attempt === null) throw new RangeError("a dispatch result is applied with the attempt it answers (DISPATCH_RESPONSE)");
    switch (result.kind) {
      case "ORDER_CREATED":
        if (attempt.operation !== "CREATE_ORDER") return this.unrecognized(attempt, result.evidenceHash, attempt.providerRequestId);
        return this.orderCreated(attempt, result.providerOrderId, result.approvalUrl, result.evidenceHash, undefined);
      case "CAPTURE_OBSERVED":
        if (attempt.operation === "REFUND") return this.unrecognized(attempt, result.capture.evidenceHash, attempt.providerRequestId);
        return this.capture(result.capture, attempt, undefined);
      case "REFUND_OBSERVED":
        if (attempt.operation !== "REFUND") return this.unrecognized(attempt, result.refund.evidenceHash, attempt.providerRequestId);
        return this.refund(result.refund, attempt, undefined);
      case "PROVED_NO_EFFECT":
        return this.provedNoEffect(attempt, result.outcomeCode, result.evidenceHash, undefined);
      case "AMBIGUOUS":
        return this.ambiguous(attempt, result.reason);
      case "UNRECOGNIZED":
        return this.unrecognized(attempt, result.evidenceHash, attempt.providerRequestId);
    }
  }

  /** CREATE_ORDER answered by the provider's order: the identity is learned once, with an allowlisted approval page. */
  private orderCreated(attempt: Mutable<PaymentAttemptRecord> | null, providerOrderId: string, approvalUrl: string | undefined, evidenceHash: Sha256Hex, providerEventAt: UtcInstant | undefined): void {
    const o = this.order;
    if (o.providerOrderId !== undefined && o.providerOrderId !== providerOrderId) {
      this.openCase("PROVIDER_INCONSISTENCY", {}, "PROVIDER_ORDER_DIFFERS", evidenceHash);
      this.observation({ subjectKind: "ORDER", providerRef: providerOrderId, observedStatus: "CREATED", effect: "MISMATCH", evidenceHash, ...(providerEventAt !== undefined ? { providerEventAt } : {}) });
      return;
    }
    if (o.state !== "CREATING") {
      if (attempt !== null && attempt.operation === "CREATE_ORDER") this.attemptTo(attempt, "CONFIRMED", { evidenceHash });
      this.observation({ subjectKind: "ORDER", providerRef: providerOrderId, observedStatus: "CREATED", effect: "DUPLICATE", evidenceHash, ...(providerEventAt !== undefined ? { providerEventAt } : {}) });
      return;
    }
    let url: string | undefined = approvalUrl;
    if (url !== undefined && !isHostAllowed(url, this.facts.approvalHosts)) {
      // the provider order exists and is learned; the browser is never sent to a host outside the adapter's allowlist (10)
      this.openCase("PROVIDER_INCONSISTENCY", {}, "APPROVAL_HOST_NOT_ALLOWED", evidenceHash);
      url = undefined;
    }
    const creating = attempt ?? this.liveAttempt("CREATE_ORDER");
    this.orderTo("CREATED", { providerOrderId, ...(url !== undefined ? { providerApprovalUrl: url } : {}), ...(creating !== null ? { attemptId: creating.attemptId } : {}) });
    if (creating !== null) this.attemptTo(creating, "CONFIRMED", { evidenceHash });
    this.steps.push({ op: "SCOPE", entry: { kind: "PROVIDER_ORDER", key: providerScopeKey(o.provider, o.environment, providerOrderId), agencyId: this.agencyId, orderId: o.orderId } });
    this.observation({ subjectKind: "ORDER", providerRef: providerOrderId, observedStatus: "CREATED", effect: "ADVANCED", evidenceHash, ...(providerEventAt !== undefined ? { providerEventAt } : {}) });
  }

  /** Authenticated evidence that the attempt's intended effect did not happen (10: never a network exception). */
  private provedNoEffect(attempt: Mutable<PaymentAttemptRecord>, outcomeCode: string, evidenceHash: Sha256Hex, orderStatus: "CREATED" | "APPROVED" | undefined): void {
    if (!LIVE_ATTEMPT.has(attempt.state)) {
      this.observation({ subjectKind: attempt.refundId !== undefined ? "REFUND" : "ORDER", providerRef: attempt.providerRequestId, observedStatus: "PROVED_NO_EFFECT", effect: "STALE_IGNORED", evidenceHash });
      return;
    }
    this.attemptTo(attempt, "FAILED_NO_EFFECT", { evidenceHash, outcomeCode });
    switch (attempt.operation) {
      case "CREATE_ORDER":
        // a later deliberate attempt may follow (D-PROTO-B3); only when the attempts are spent does the order fail
        if (attempt.ordinal >= this.facts.maxAttempts) this.orderTo("FAILED", { attemptId: attempt.attemptId, outcomeCode: tokenOr(outcomeCode, "CREATION_PROVED_NO_EFFECT") });
        break;
      case "CAPTURE": {
        const unapproved = orderStatus === "CREATED" || outcomeCode === "ORDER_NOT_APPROVED";
        this.orderTo(unapproved ? "CREATED" : "APPROVED", { attemptId: attempt.attemptId, outcomeCode: tokenOr(outcomeCode, "CAPTURE_PROVED_NO_EFFECT") });
        break;
      }
      case "REFUND": {
        const refund = attempt.refundId !== undefined ? this.refunds.get(attempt.refundId) : undefined;
        if (refund !== undefined) this.refundTo(refund, "APPROVED", { attemptId: attempt.attemptId });
        break;
      }
    }
    this.observation({ subjectKind: attempt.refundId !== undefined ? "REFUND" : "ORDER", providerRef: attempt.providerRequestId, observedStatus: "PROVED_NO_EFFECT", effect: "ADVANCED", evidenceHash });
  }

  /**
   * An unknown outcome is explicit: the attempt UNCERTAIN, the aggregate uncertain, and a visible case whose evidence is the exact
   * request whose effect is unresolved (15 "Exhausting retries leaves a visible case with the exact unresolved effect"; D-PROTO-B2).
   * No observation row: nothing authenticated was observed.
   */
  private ambiguous(attempt: Mutable<PaymentAttemptRecord>, reason: string): void {
    if (attempt.state === "DISPATCHING" || attempt.state === "PROVIDER_PENDING") this.attemptTo(attempt, "UNCERTAIN", { outcomeCode: reason });
    this.uncertainAggregate(attempt);
    this.openCase("UNCERTAIN_EFFECT", this.refundSubject(attempt), reason, attempt.requestHash);
    this.effects.push({ about: attempt.refundId !== undefined ? "REFUND" : "ORDER", effect: "NO_CHANGE" });
  }

  private refundSubject(attempt: PaymentAttemptRecord | null): { readonly refundId?: RefundId; readonly captureId?: CaptureId } {
    const refundId = attempt?.refundId;
    if (refundId === undefined) return {};
    const captureId = this.refunds.get(refundId)?.captureId;
    return captureId !== undefined ? { refundId, captureId } : { refundId };
  }

  /**
   * Whether a provider view that shows no trace of an attempt's effect proves it never happened: the view can prove absence
   * (its documented lookup), and it was taken after the attempt's dispatch deadline — until then a call may still be in flight
   * (the adapter sends nothing after the deadline; D-PROTO-B4, D-PROTO-B6), so an older view proves nothing.
   */
  private absenceProves(attempt: PaymentAttemptRecord, observation: ProviderOrderObservation): boolean {
    if (!observation.absenceIsProof || attempt.dispatchDeadlineAt === undefined) return false;
    return instantMs(observation.observedAt) >= instantMs(attempt.dispatchDeadlineAt);
  }

  private uncertainAggregate(attempt: Mutable<PaymentAttemptRecord>): void {
    if (attempt.operation === "CAPTURE") this.orderTo("CAPTURE_UNCERTAIN", { attemptId: attempt.attemptId });
    if (attempt.operation === "REFUND" && attempt.refundId !== undefined) {
      const refund = this.refunds.get(attempt.refundId);
      if (refund !== undefined) this.refundTo(refund, "UNCERTAIN", { attemptId: attempt.attemptId });
    }
  }

  /** 15 "Unknown provider statuses become UNRECOGNIZED_PROVIDER_STATE and block consequential assumptions". */
  private unrecognized(attempt: Mutable<PaymentAttemptRecord> | null, evidenceHash: Sha256Hex, providerRef: string): void {
    if (attempt !== null) {
      if (attempt.state === "DISPATCHING" || attempt.state === "PROVIDER_PENDING") this.attemptTo(attempt, "UNCERTAIN", { outcomeCode: "UNRECOGNIZED_PROVIDER_STATE" });
      this.uncertainAggregate(attempt);
    }
    this.openCase("UNRECOGNIZED_PROVIDER_STATE", this.refundSubject(attempt), "UNRECOGNIZED_STATUS", evidenceHash);
    this.observation({ subjectKind: attempt?.refundId !== undefined ? "REFUND" : "ORDER", providerRef, observedStatus: "UNRECOGNIZED", effect: "UNRECOGNIZED", evidenceHash });
  }

  // --- order observations (a query of the provider's current state) ------------------------------------------------------------

  private orderObservation(observation: ProviderOrderObservation, dispatch: Mutable<PaymentAttemptRecord> | null): void {
    const o = this.order;
    const at = observation.observedAt;
    const ref = observation.providerOrderId ?? o.providerOrderId ?? dispatch?.providerRequestId ?? o.orderId;
    if (observation.providerOrderId !== null && o.providerOrderId !== undefined && observation.providerOrderId !== o.providerOrderId) {
      this.exception("WRONG_ORDER", { providerRef: observation.providerOrderId, evidenceHash: observation.evidenceHash });
      this.observation({ subjectKind: "ORDER", providerRef: observation.providerOrderId, observedStatus: observation.orderStatus, effect: "MISMATCH", evidenceHash: observation.evidenceHash, providerEventAt: at });
      return;
    }
    if (observation.orderStatus === "UNRECOGNIZED") return this.unrecognized(dispatch, observation.evidenceHash, ref);
    if (observation.orderStatus === "NOT_FOUND") {
      const creating = this.liveAttempt("CREATE_ORDER");
      if (creating !== null && o.state === "CREATING" && this.absenceProves(creating, observation)) return this.provedNoEffect(creating, "NOT_FOUND_BY_REQUEST_ID", observation.evidenceHash, undefined);
      this.observation({ subjectKind: "ORDER", providerRef: ref, observedStatus: "NOT_FOUND", effect: "NO_CHANGE", evidenceHash: observation.evidenceHash, providerEventAt: at });
      return;
    }
    // the provider order exists: a creation whose response was lost is learned from it (never a second create, 15)
    if (observation.providerOrderId !== null && o.state === "CREATING") this.orderCreated(this.liveAttempt("CREATE_ORDER"), observation.providerOrderId, observation.approvalUrl, observation.evidenceHash, at);
    if (!this.alreadyApplied("ORDER", ref)) this.orderStatus(observation.orderStatus, ref, observation.evidenceHash, at);
    for (const capture of observation.captures) this.capture(capture, this.liveAttempt("CAPTURE"), at);
    // a view that proves absence shows no capture of an in-flight capture attempt: it had no effect (reconciliation_proves_no_capture)
    const capturing = this.liveAttempt("CAPTURE");
    if (
      capturing !== null &&
      observation.captures.length === 0 &&
      (observation.orderStatus === "CREATED" || observation.orderStatus === "APPROVED") &&
      (this.order.state === "CAPTURING" || this.order.state === "CAPTURE_UNCERTAIN") &&
      this.absenceProves(capturing, observation)
    ) {
      this.provedNoEffect(capturing, "NO_CAPTURE_OBSERVED", observation.evidenceHash, observation.orderStatus);
    }
    for (const refund of observation.refunds) this.refund(refund, null, at);
    // a refund in flight that the provider's authoritative view does not show was never made: its attempt proves no effect. Absence
    // is judged per refund, by identity (B09-R3): a provider refund is this refund's trace only when it is bound to it — its provider
    // refund id, or the platform reference its own request carried — never because it refunds the same capture (another refund of
    // the capture, completed before, is that refund's trace, not this one's)
    for (const r of [...this.refunds.values()]) {
      if (r.state !== "SUBMITTING" && r.state !== "UNCERTAIN") continue;
      if (observation.refunds.some((x) => (r.providerRefundId !== undefined && x.providerRefundId === r.providerRefundId) || x.platformRefundRef === r.refundId)) continue;
      const a = this.refundAttempt(r.refundId);
      if (a !== null && this.absenceProves(a, observation)) this.provedNoEffect(a, "REFUND_NOT_FOUND", observation.evidenceHash, undefined);
    }
  }

  private orderStatus(status: ProviderOrderObservation["orderStatus"], ref: string, evidenceHash: Sha256Hex, at: UtcInstant | undefined): void {
    const before = this.order.state;
    let changed = false;
    switch (status) {
      case "APPROVED":
        changed = before === "CREATED" && this.orderTo("APPROVED", { outcomeCode: "BUYER_APPROVAL_OBSERVED" });
        break;
      case "VOIDED":
        changed = (before === "CREATED" || before === "APPROVED") && this.orderTo("CANCELLED", { outcomeCode: "PROVIDER_VOIDED" });
        break;
      case "EXPIRED":
        changed = (before === "CREATED" || before === "APPROVED") && this.orderTo("EXPIRED", { outcomeCode: "PROVIDER_EXPIRED" });
        break;
      default:
        // CREATED and COMPLETED carry nothing of their own at the order level: creation and captures are learned above
        return;
    }
    const effect: ObservationEffect = changed ? "ADVANCED" : this.isStale("ORDER", ref, at) ? "STALE_IGNORED" : "NO_CHANGE";
    this.observation({ subjectKind: "ORDER", providerRef: ref, observedStatus: status, effect, evidenceHash, ...(at !== undefined ? { providerEventAt: at } : {}) });
  }

  // --- verified provider events ------------------------------------------------------------------------------------------------

  private providerEvent(event: NormalizedProviderEvent): void {
    const o = this.order;
    const at = event.providerEventAt;
    if (event.provider !== o.provider) return this.exception("WRONG_PROVIDER", { ...(event.providerOrderId !== undefined ? { providerRef: event.providerOrderId } : {}), evidenceHash: event.bodyHash });
    if (event.environment !== o.environment) return this.exception("WRONG_ENVIRONMENT", { ...(event.providerOrderId !== undefined ? { providerRef: event.providerOrderId } : {}), evidenceHash: event.bodyHash });
    switch (event.kind) {
      case "ORDER_APPROVED":
      case "ORDER_VOIDED": {
        const ref = event.providerOrderId ?? o.providerOrderId;
        if (ref === undefined) return this.exception("UNKNOWN_PROVIDER_REFERENCE", { evidenceHash: event.bodyHash });
        if (o.providerOrderId !== undefined && ref !== o.providerOrderId) return this.exception("WRONG_ORDER", { providerRef: ref, evidenceHash: event.bodyHash });
        if (this.alreadyApplied("ORDER", ref)) {
          this.effects.push({ about: "ORDER", effect: "DUPLICATE" });
          return;
        }
        return this.orderStatus(event.kind === "ORDER_APPROVED" ? "APPROVED" : "VOIDED", ref, event.bodyHash, at);
      }
      case "CAPTURE_COMPLETED":
      case "CAPTURE_PENDING":
      case "CAPTURE_DENIED":
      case "CAPTURE_REVERSED":
        if (event.capture === undefined) return this.exception("UNRECOGNIZED_PROVIDER_STATE", { evidenceHash: event.bodyHash });
        return this.capture(event.capture, this.liveAttempt("CAPTURE"), at);
      case "REFUND_COMPLETED":
      case "REFUND_PENDING":
      case "REFUND_FAILED":
        if (event.refund === undefined) return this.exception("UNRECOGNIZED_PROVIDER_STATE", { evidenceHash: event.bodyHash });
        return this.refund(event.refund, null, at);
      case "DISPUTE_OPENED":
      case "DISPUTE_CLOSED":
        if (event.dispute === undefined) return this.exception("UNRECOGNIZED_PROVIDER_STATE", { evidenceHash: event.bodyHash });
        return this.dispute(event.dispute, at);
      case "UNRECOGNIZED":
        return this.unrecognized(null, event.bodyHash, event.providerOrderId ?? o.providerOrderId ?? o.orderId);
    }
  }

  // --- captures -------------------------------------------------------------------------------------------------------------

  private captureByProvider(providerCaptureId: string): Mutable<CaptureFactRecord> | null {
    for (const c of this.captures.values()) if (c.providerCaptureId === providerCaptureId) return c;
    return null;
  }

  private capture(observed: ObservedCapture, attempt: Mutable<PaymentAttemptRecord> | null, providerEventAt: UtcInstant | undefined): void {
    const ref = observed.providerCaptureId;
    const at = providerEventAt;
    const obs = (status: string, effect: ObservationEffect): void =>
      this.observation({ subjectKind: "CAPTURE", providerRef: ref, observedStatus: status, effect, evidenceHash: observed.evidenceHash, amountCents: observed.amountCents, currency: observed.currency, payeeDigest: observed.payeeDigest, ...(at !== undefined ? { providerEventAt: at } : {}) });
    // 3. match: another provider, environment, order, payee or currency is never a capture of this order (S058)
    const match = matchCapture(this.order, observed);
    if (match.kind === "MISMATCH") {
      this.exception(match.reason, { providerRef: ref, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      obs(observed.status, "MISMATCH");
      return;
    }
    // 4. order the observation
    if (this.alreadyApplied("CAPTURE", ref)) {
      this.effects.push({ about: "CAPTURE", effect: "DUPLICATE" });
      return;
    }
    if (this.isStale("CAPTURE", ref, at)) return obs(observed.status, "STALE_IGNORED");
    let current = this.captureByProvider(ref);
    if (current !== null && current.amountCents !== observed.amountCents) {
      this.openCase("PROVIDER_INCONSISTENCY", { captureId: current.captureId }, "AMOUNT_CHANGED", observed.evidenceHash, observed.amountCents);
      return obs(observed.status, "NO_CHANGE");
    }
    // 5. step
    const step = captureStatusStep(current?.status ?? null, observed.status);
    if (step.kind === "STALE") return obs(observed.status, "STALE_IGNORED");
    if (step.kind === "INCONSISTENT") {
      this.openCase("PROVIDER_INCONSISTENCY", current !== null ? { captureId: current.captureId } : {}, "TERMINAL_CONTRADICTED", observed.evidenceHash);
      return obs(observed.status, "NO_CHANGE");
    }
    let advanced = false;
    const reached: CaptureStatus[] = [];
    if (step.kind === "INSERT" || step.kind === "ADVANCE") {
      const completes = (step.kind === "INSERT" ? step.status : step.next) === "COMPLETED";
      if (completes && observed.providerCompletedAt === null) {
        // D-PAY-B6 (FINAL-N2): the completion instant is the sale's tax point; it is never invented. Nothing is applied and no
        // observation row is appended: a webhook's record stays applicable once a stored provider query recorded the completion
        // (an observation row would make its retry a DUPLICATE of the event and drop what it adds, e.g. the reversal)
        if (this.source !== "PROVIDER_QUERY") {
          this.providerQueryRequired = true;
          this.effects.push({ about: "CAPTURE", effect: "NO_CHANGE" });
          return;
        }
        this.openCase("PROVIDER_INCONSISTENCY", current !== null ? { captureId: current.captureId } : {}, "COMPLETION_TIME_UNKNOWN", observed.evidenceHash, observed.amountCents);
        return obs(observed.status, "NO_CHANGE");
      }
      if (step.kind === "INSERT") {
        current = this.insertCapture(observed, step.status, attempt);
      } else {
        this.advanceCapture(current!, step.next, observed, attempt);
      }
      reached.push(current!.status);
      for (const edge of step.then ?? []) {
        this.advanceCapture(current!, edge.next, observed, attempt);
        reached.push(edge.next);
      }
      advanced = true;
    }
    const capture = current!;
    // 6. consequences of the status the capture reached
    const reversedHere = reached.includes("REVERSED");
    if (reached.includes("COMPLETED")) this.completed(capture, attempt, observed.evidenceHash, reversedHere);
    if (reached.includes("DENIED")) this.denied(attempt, observed.evidenceHash);
    if ((reached.includes("PENDING") || (step.kind === "SAME" && capture.status === "PENDING")) && attempt !== null && attempt.operation === "CAPTURE" && attempt.state === "DISPATCHING") {
      this.attemptTo(attempt, "PROVIDER_PENDING", { evidenceHash: observed.evidenceHash });
    }
    if (reversedHere) this.reversed(capture, observed.evidenceHash);
    if (step.kind === "SAME" && capture.status === "COMPLETED" && attempt !== null && LIVE_ATTEMPT.has(attempt.state) && attempt.operation === "CAPTURE") {
      // the webhook recorded the capture first; the dispatch response (or query) now confirms its own attempt
      this.attemptTo(attempt, "CONFIRMED", { evidenceHash: observed.evidenceHash });
      if (this.order.state === "CAPTURING" || this.order.state === "CAPTURE_UNCERTAIN") this.orderTo("CAPTURED", { captureId: capture.captureId });
    }
    // later provider facts, one per version (D-EVT-B2): the fee, then the availability of the funds. The fee is a fact of captured
    // money whenever the provider reports it — with the completion, after it, with the reversal or after it (B09-R4): a reversal
    // returns the capture's movable balance, and a fee the provider keeps is posted all the same, from the merchant's available
    // balance (D-LEDGER-B6). A fee reported with a PENDING capture travels with its completion; one reported for a DENIED capture —
    // money never captured — is a visible inconsistency, never posted and never dropped.
    if (capture.status === "COMPLETED" || capture.status === "REVERSED") {
      if (observed.feeCents !== null) {
        if (capture.providerFeeCents === undefined) advanced = this.learnFee(capture, observed.feeCents, observed.evidenceHash) || advanced;
        else if (capture.providerFeeCents !== observed.feeCents) this.openCase("PROVIDER_INCONSISTENCY", { captureId: capture.captureId }, "FEE_DIFFERS", observed.evidenceHash, observed.feeCents);
      }
    } else if (capture.status === "DENIED" && observed.feeCents !== null && observed.feeCents > 0n) {
      this.openCase("PROVIDER_INCONSISTENCY", { captureId: capture.captureId }, "FEE_WITHOUT_CAPTURE", observed.evidenceHash, observed.feeCents);
    }
    if (capture.status === "COMPLETED" && observed.fundsState !== "UNKNOWN" && observed.fundsState !== capture.fundsState) advanced = this.learnFunds(capture, observed.fundsState, observed.evidenceHash) || advanced;
    obs(observed.status, advanced ? "ADVANCED" : "DUPLICATE");
  }

  private insertCapture(observed: ObservedCapture, status: "PENDING" | "COMPLETED" | "DENIED", attempt: Mutable<PaymentAttemptRecord> | null): Mutable<CaptureFactRecord> {
    const captureId = this.input.mint() as CaptureId;
    const completes = status === "COMPLETED";
    const allocation = completes ? allocateCapture(this.order, observed.amountCents) : ZERO_COMPONENTS;
    const fee = completes && observed.feeCents !== null ? observed.feeCents : undefined;
    const dispatch = this.dispatchAttempt();
    const fact: NewCaptureFact = {
      captureId,
      agencyId: this.agencyId,
      orderId: this.order.orderId,
      status,
      provider: observed.provider,
      environment: observed.environment,
      providerCaptureId: observed.providerCaptureId,
      merchantRef: this.order.merchantRef,
      payeeDigest: observed.payeeDigest,
      amountCents: observed.amountCents,
      allocation,
      fundsState: "UNKNOWN",
      ...(fee !== undefined ? { providerFeeCents: fee } : {}),
      ...(completes && observed.providerCompletedAt !== null ? { providerCompletedAt: observed.providerCompletedAt } : {}),
      firstObservationSource: this.source,
      observedAt: this.now,
      evidenceHash: observed.evidenceHash,
      ...(dispatch !== null && attempt !== null && dispatch.attemptId === attempt.attemptId ? { attemptId: attempt.attemptId } : {}),
    };
    const record: Mutable<CaptureFactRecord> = {
      captureId,
      agencyId: this.agencyId,
      orderId: this.order.orderId,
      version: 1,
      status,
      provider: observed.provider,
      environment: observed.environment,
      providerCaptureId: observed.providerCaptureId,
      merchantRef: this.order.merchantRef,
      payeeDigest: observed.payeeDigest,
      amountCents: observed.amountCents,
      currency: this.order.currency,
      allocation,
      fundsState: "UNKNOWN",
      firstObservationSource: this.source,
      firstObservedAt: this.now,
      observedAt: this.now,
      evidenceHash: observed.evidenceHash,
    };
    if (fee !== undefined) record.providerFeeCents = fee;
    if (fact.providerCompletedAt !== undefined) record.providerCompletedAt = fact.providerCompletedAt;
    if (fact.attemptId !== undefined) record.attemptId = fact.attemptId;
    this.steps.push({ op: "CAPTURE_INSERT", fact, event: this.captureStatusEvent(record, null, 1) });
    this.captures.set(captureId, record);
    if (completes) this.order.allocatedCents += allocation.serviceCents + allocation.taxCents;
    this.steps.push({ op: "SCOPE", entry: { kind: "PROVIDER_CAPTURE", key: providerScopeKey(observed.provider, observed.environment, observed.providerCaptureId), agencyId: this.agencyId, orderId: this.order.orderId, captureId } });
    return record;
  }

  private advanceCapture(capture: Mutable<CaptureFactRecord>, next: CaptureStatus, observed: ObservedCapture, attempt: Mutable<PaymentAttemptRecord> | null): void {
    const previous = capture.status;
    const completes = next === "COMPLETED";
    const allocation = completes ? allocateCapture(this.order, capture.amountCents) : undefined;
    const fee = completes && capture.providerFeeCents === undefined && observed.feeCents !== null ? observed.feeCents : undefined;
    const completedAt = completes && capture.providerCompletedAt === undefined && observed.providerCompletedAt !== null ? observed.providerCompletedAt : undefined;
    const dispatch = this.dispatchAttempt();
    const attemptId = capture.attemptId === undefined && dispatch !== null && attempt !== null && dispatch.attemptId === attempt.attemptId ? attempt.attemptId : undefined;
    const change: CaptureAdvance = {
      status: next,
      ...(allocation !== undefined ? { allocation } : {}),
      ...(fee !== undefined ? { providerFeeCents: fee } : {}),
      ...(completedAt !== undefined ? { providerCompletedAt: completedAt } : {}),
      observedAt: this.now,
      evidenceHash: observed.evidenceHash,
      ...(attemptId !== undefined ? { attemptId } : {}),
    };
    const version = capture.version + 1;
    // the payload's reversal components and funds state are read before the version applies them
    const nextRecord: Mutable<CaptureFactRecord> = { ...capture, status: next, version, observedAt: this.now, evidenceHash: observed.evidenceHash };
    if (allocation !== undefined) nextRecord.allocation = allocation;
    if (fee !== undefined) nextRecord.providerFeeCents = fee;
    if (completedAt !== undefined) nextRecord.providerCompletedAt = completedAt;
    if (attemptId !== undefined) nextRecord.attemptId = attemptId;
    this.steps.push({ op: "CAPTURE_ADVANCE", captureId: capture.captureId, expectedVersion: capture.version, change, event: this.captureStatusEvent(nextRecord, previous, version) });
    Object.assign(capture, nextRecord);
    if (completes && allocation !== undefined) this.order.allocatedCents += allocation.serviceCents + allocation.taxCents;
  }

  private captureStatusEvent(capture: CaptureFactRecord, previousStatus: CaptureStatus | null, version: number): VersionEvent {
    const base = { captureId: capture.captureId, agencyId: this.agencyId, orderId: capture.orderId, evidenceHash: capture.evidenceHash, source: this.source, previousStatus: previousStatus ?? undefined };
    const fee = capture.status === "COMPLETED" && capture.providerFeeCents !== undefined;
    const change = { previousState: previousStatus, state: capture.status, ...(fee ? { feeChanged: true } : {}) };
    switch (capture.status) {
      case "PENDING":
        return versionEvent("capture", capture.captureId, version, this.agencyId, change, { ...base, amountCents: capture.amountCents, currency: capture.currency });
      case "COMPLETED":
        return versionEvent("capture", capture.captureId, version, this.agencyId, change, {
          ...base,
          projectId: this.order.projectId,
          quoteId: this.order.quoteId,
          amountCents: capture.amountCents,
          currency: capture.currency,
          allocatedServiceCents: capture.allocation.serviceCents,
          allocatedTaxCents: capture.allocation.taxCents,
          excessCents: capture.allocation.excessCents,
          providerFeeCents: capture.providerFeeCents,
        });
      case "DENIED":
        return versionEvent("capture", capture.captureId, version, this.agencyId, change, base);
      case "REVERSED": {
        // a chargeback returns the components completed refunds did not already return (commerce/ledger returnPostings)
        const returned = this.completedRefundsOf(capture.captureId);
        const left = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
        return versionEvent("capture", capture.captureId, version, this.agencyId, change, {
          ...base,
          projectId: this.order.projectId,
          reversedServiceCents: left(capture.allocation.serviceCents, returned.serviceCents),
          reversedTaxCents: left(capture.allocation.taxCents, returned.taxCents),
          reversedExcessCents: left(capture.allocation.excessCents, returned.excessCents),
          fundsState: capture.fundsState,
          // the capture's movable balance before the chargeback: what it returns beyond it is the kept fee (D-LEDGER-B6)
          movableBalanceCents: movableBalanceOf({ amountCents: capture.amountCents, providerFeeCents: capture.providerFeeCents ?? 0n, returnedCents: total(returned) }),
        });
      }
    }
  }

  private learnFee(capture: Mutable<CaptureFactRecord>, feeCents: bigint, evidenceHash: Sha256Hex): boolean {
    const version = capture.version + 1;
    this.steps.push({
      op: "CAPTURE_FEE",
      captureId: capture.captureId,
      expectedVersion: capture.version,
      change: { providerFeeCents: feeCents, observedAt: this.now, evidenceHash },
      event: versionEvent("capture", capture.captureId, version, this.agencyId, { previousState: capture.status, state: capture.status, feeChanged: true }, {
        captureId: capture.captureId,
        agencyId: this.agencyId,
        orderId: capture.orderId,
        providerFeeCents: feeCents,
        // the balance the fee is taken from, as the capture's funds stand at this version (D-LEDGER-B5), and the capture's movable
        // balance before the fee: its amount less the money already returned (D-LEDGER-B6) — all of it once reversed (D-LEDGER-B7)
        fundsState: capture.fundsState,
        movableBalanceCents: movableBalanceOf({ amountCents: capture.amountCents, providerFeeCents: capture.providerFeeCents ?? 0n, returnedCents: returnedCentsOf(capture, total(this.completedRefundsOf(capture.captureId))) }),
        currency: capture.currency,
        evidenceHash,
        source: this.source,
      }),
    });
    Object.assign(capture, { version, providerFeeCents: feeCents, observedAt: this.now });
    return true;
  }

  private learnFunds(capture: Mutable<CaptureFactRecord>, fundsState: Exclude<FundsState, "UNKNOWN">, evidenceHash: Sha256Hex): boolean {
    const version = capture.version + 1;
    const returned = this.completedRefundsOf(capture.captureId);
    // the movable balance: what of the capture's money is still at the provider to move between its balances (D-LEDGER-B5)
    const movable = movableBalanceOf({ amountCents: capture.amountCents, providerFeeCents: capture.providerFeeCents ?? 0n, returnedCents: returnedCentsOf(capture, total(returned)) });
    this.steps.push({
      op: "CAPTURE_FUNDS",
      captureId: capture.captureId,
      expectedVersion: capture.version,
      change: { fundsState, observedAt: this.now, evidenceHash },
      event: versionEvent("capture", capture.captureId, version, this.agencyId, { previousState: capture.status, state: capture.status, fundsChanged: true }, {
        captureId: capture.captureId,
        agencyId: this.agencyId,
        orderId: capture.orderId,
        fundsState,
        previousFundsState: capture.fundsState,
        amountCents: movable,
        currency: capture.currency,
        evidenceHash,
        source: this.source,
      }),
    });
    Object.assign(capture, { version, fundsState, observedAt: this.now });
    return true;
  }

  /** A capture reached COMPLETED: the order's edge, the attempt, then authority or the cases and requests that replace it. */
  private completed(capture: Mutable<CaptureFactRecord>, attempt: Mutable<PaymentAttemptRecord> | null, evidenceHash: Sha256Hex, reversedHere: boolean): void {
    this.orderTo("CAPTURED", { captureId: capture.captureId });
    if (attempt !== null && attempt.operation === "CAPTURE" && LIVE_ATTEMPT.has(attempt.state)) this.attemptTo(attempt, "CONFIRMED", { evidenceHash });
    // a capture completed and reversed in this very observation returned its money already: no authority, no refund to file
    if (reversedHere) return;
    const pays = capture.allocation.serviceCents + capture.allocation.taxCents > 0n;
    if (pays) {
      const quoteEntitled = [...this.authorizations.values()].some((a) => a.quoteId === this.facts.quote.quoteId);
      if (authorizesObligation(this.order, capture)) {
        if (!quoteEntitled) {
          const completedAt = capture.providerCompletedAt ?? this.now;
          const own = this.facts.authorityBlocker;
          const blockers: ReadonlyArray<string> = [...(own !== undefined && own !== null ? [own] : []), ...issuanceBlockers(this.facts.quote, this.facts.subject, this.facts.currentProfile, completedAt, this.now)];
          const subject = this.facts.subject;
          if (blockers.length === 0 && subject !== null && subject.approval !== null && subject.capability !== null) this.issue(capture, completedAt);
          else {
            // 15 "Price and source expiry races": the real capture stands without authority; refund and issue a new quote
            this.openCase("CAPTURE_WITHOUT_VALID_SUBJECT", { captureId: capture.captureId }, blockers[0] ?? "SUBJECT_NOT_READABLE", evidenceHash, capture.amountCents);
            this.fileServerRequest(capture, "KAURO_REMEDY", "KAURO_REMEDY: the purchased subject no longer binds");
          }
        }
      } else {
        // a wrong amount is real money recorded with its allocation, never authority (S058)
        this.openCase("AMOUNT_MISMATCH", { captureId: capture.captureId }, capture.amountCents < this.order.expectedAmountCents ? "PARTIAL_CAPTURE" : "AMOUNT_DIFFERS", evidenceHash, capture.amountCents);
        this.fileServerRequest(capture, "KAURO_REMEDY", "KAURO_REMEDY: the capture amount is not the obligation");
      }
    }
    if (capture.allocation.excessCents > 0n) {
      this.openCase("EXCESS_CAPTURE", { captureId: capture.captureId }, "EXCESS_OVER_OBLIGATION", evidenceHash, capture.allocation.excessCents);
      this.fileServerRequest(capture, "EXCESS_CAPTURE", "EXCESS_CAPTURE: the capture exceeds the obligation");
    }
  }

  private issue(capture: Mutable<CaptureFactRecord>, completedAt: UtcInstant): void {
    const quote = this.facts.quote;
    const subject = this.facts.subject!;
    const approval = subject.approval!;
    const capability = subject.capability!;
    const authorizationId = this.input.mint() as CommercialAuthorizationId;
    const honored = honoredAfterPriceExpiry(quote, completedAt);
    const authorization: NewCommercialAuthorization = {
      authorizationId,
      agencyId: this.agencyId,
      projectId: quote.projectId,
      quoteId: quote.quoteId,
      orderId: this.order.orderId,
      orderQuoteId: this.order.quoteId,
      captureId: capture.captureId,
      approvalId: quote.approvalId,
      approvalHash: approval.approvalHash,
      planId: quote.planId,
      planHash: quote.planHash,
      revisionHash: quote.revisionHash,
      targetContractHash: quote.targetContractHash,
      capabilityId: capability.capabilityId,
      capabilityVersion: capability.capabilityVersion,
      mode: quote.mode,
      billableUnits: quote.billableUnits,
      honoredAfterPriceExpiry: honored,
      createdAt: this.now,
    };
    this.steps.push({
      op: "AUTHORIZATION_ISSUE",
      authorization,
      event: versionEvent("commercial_authorization", authorizationId, 1, this.agencyId, { previousState: null, state: "ACTIVE" }, {
        authorizationId,
        agencyId: this.agencyId,
        projectId: quote.projectId,
        quoteId: quote.quoteId,
        orderId: this.order.orderId,
        orderQuoteId: this.order.quoteId,
        captureId: capture.captureId,
        approvalId: quote.approvalId,
        approvalHash: approval.approvalHash,
        planHash: quote.planHash,
        revisionHash: quote.revisionHash,
        targetContractHash: quote.targetContractHash,
        capabilityId: capability.capabilityId,
        capabilityVersion: capability.capabilityVersion,
        mode: quote.mode,
        billableUnits: quote.billableUnits,
        honoredAfterPriceExpiry: honored,
      }),
    });
    this.authorizations.set(authorizationId, {
      ...authorization,
      version: 1,
      state: "ACTIVE",
    } as Mutable<CommercialAuthorizationRecord>);
    this.authorizationIssued = authorizationId;
  }

  private denied(attempt: Mutable<PaymentAttemptRecord> | null, evidenceHash: Sha256Hex): void {
    if (attempt === null || attempt.operation !== "CAPTURE" || !LIVE_ATTEMPT.has(attempt.state)) return;
    this.attemptTo(attempt, "FAILED_NO_EFFECT", { evidenceHash, outcomeCode: "CAPTURE_DENIED" });
    this.orderTo("APPROVED", { attemptId: attempt.attemptId, outcomeCode: "CAPTURE_DENIED" });
  }

  /** S059: the entitlement is revoked with the phase it leaves, approved refunds lapse, the reversal is visible. */
  private reversed(capture: Mutable<CaptureFactRecord>, evidenceHash: Sha256Hex): void {
    const live = this.liveAuthorizationOf(capture.captureId);
    if (live !== null) this.revoke(live, "CAPTURE_REVERSED");
    for (const r of this.refunds.values()) if (r.captureId === capture.captureId && r.state === "APPROVED") this.refundTo(r, "FAILED", { failureCode: "CAPTURE_REVERSED" });
    this.openCase("REVERSAL", { captureId: capture.captureId }, "CAPTURE_REVERSED", evidenceHash, capture.amountCents);
  }

  // --- refunds --------------------------------------------------------------------------------------------------------------

  private refund(observed: ObservedRefund, attempt: Mutable<PaymentAttemptRecord> | null, providerEventAt: UtcInstant | undefined): void {
    const ref = observed.providerRefundId;
    const obs = (status: string, effect: ObservationEffect): void =>
      this.observation({ subjectKind: "REFUND", providerRef: ref, observedStatus: status, effect, evidenceHash: observed.evidenceHash, amountCents: observed.amountCents, currency: observed.currency, ...(providerEventAt !== undefined ? { providerEventAt } : {}) });
    if (observed.provider !== this.order.provider) {
      this.exception("WRONG_PROVIDER", { providerRef: ref, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      return obs(observed.status, "MISMATCH");
    }
    if (observed.environment !== this.order.environment) {
      this.exception("WRONG_ENVIRONMENT", { providerRef: ref, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      return obs(observed.status, "MISMATCH");
    }
    if (observed.currency !== this.order.currency) {
      this.exception("WRONG_CURRENCY", { providerRef: ref, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      return obs(observed.status, "MISMATCH");
    }
    const capture = this.captureByProvider(observed.providerCaptureId);
    if (capture === null) {
      this.exception("WRONG_ORDER", { providerRef: ref, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      return obs(observed.status, "MISMATCH");
    }
    if (this.alreadyApplied("REFUND", ref)) {
      this.effects.push({ about: "REFUND", effect: "DUPLICATE" });
      return;
    }
    if (this.isStale("REFUND", ref, providerEventAt)) return obs(observed.status, "STALE_IGNORED");
    const refund = this.refundFor(observed, capture, attempt);
    if (refund === null) {
      // money returned that no local refund explains (a refund made outside the platform): its own incident, keyed by the provider
      // refund, with its own amount, for the owner's review — 15 "Unexplained differences create a case with amount and age. They do
      // not enter a generic 'miscellaneous' account without review": its correction is the case's reviewed resolution (D-LEDGER-B4)
      this.unknownRefund(observed, capture);
      return obs(observed.status, "NO_CHANGE");
    }
    if (refund.providerRefundId !== undefined && refund.providerRefundId !== ref) {
      // the local refund completed with another provider refund, so this one is not it — whatever reference or request it names —
      // and is money no local refund explains; the attempt whose own response names it did take effect (B09-R1: never a silent NO_CHANGE)
      if (attempt !== null && attempt.refundId === refund.refundId && LIVE_ATTEMPT.has(attempt.state)) this.attemptTo(attempt, "CONFIRMED", { evidenceHash: observed.evidenceHash });
      this.unknownRefund(observed, capture);
      return obs(observed.status, "NO_CHANGE");
    }
    const refundAttempt = attempt ?? this.refundAttempt(refund.refundId);
    switch (observed.status) {
      case "COMPLETED": {
        if (refund.state === "COMPLETED") {
          // the provider refund this refund completed with, observed again
          if (refundAttempt !== null && LIVE_ATTEMPT.has(refundAttempt.state)) this.attemptTo(refundAttempt, "CONFIRMED", { evidenceHash: observed.evidenceHash });
          return obs("COMPLETED", "DUPLICATE");
        }
        if (refund.state !== "SUBMITTING" && refund.state !== "UNCERTAIN") {
          this.openCase("PROVIDER_INCONSISTENCY", { captureId: capture.captureId, refundId: refund.refundId }, "REFUND_NOT_SUBMITTED", observed.evidenceHash, observed.amountCents);
          return obs("COMPLETED", "NO_CHANGE");
        }
        if (refund.approved === undefined || total(refund.approved.amounts) !== observed.amountCents) {
          this.openCase("PROVIDER_INCONSISTENCY", { captureId: capture.captureId, refundId: refund.refundId }, "REFUND_AMOUNT_DIFFERS", observed.evidenceHash, observed.amountCents);
          return obs("COMPLETED", "NO_CHANGE");
        }
        if (refundAttempt !== null && LIVE_ATTEMPT.has(refundAttempt.state)) this.attemptTo(refundAttempt, "CONFIRMED", { evidenceHash: observed.evidenceHash });
        this.refundTo(refund, "COMPLETED", { providerRefundId: ref, evidenceHash: observed.evidenceHash });
        this.steps.push({ op: "SCOPE", entry: { kind: "PROVIDER_REFUND", key: providerScopeKey(this.order.provider, this.order.environment, ref), agencyId: this.agencyId, orderId: this.order.orderId, refundId: refund.refundId } });
        // a completion that leaves the capture no service basis revokes the entitlement in the same transaction (D-REF-B5, KP006)
        const refundedService = this.completedRefundsOf(capture.captureId).serviceCents;
        const live = this.liveAuthorizationOf(capture.captureId);
        if (live !== null && capture.allocation.serviceCents > 0n && refundedService >= capture.allocation.serviceCents) this.revoke(live, "SERVICE_FULLY_REFUNDED");
        return obs("COMPLETED", "ADVANCED");
      }
      case "PENDING":
        if (refundAttempt !== null && refundAttempt.state === "DISPATCHING") this.attemptTo(refundAttempt, "PROVIDER_PENDING", { evidenceHash: observed.evidenceHash });
        return obs("PENDING", "NO_CHANGE");
      case "FAILED": {
        if (refund.state !== "SUBMITTING" && refund.state !== "UNCERTAIN") return obs("FAILED", refund.state === "FAILED" ? "DUPLICATE" : "STALE_IGNORED");
        if (refundAttempt !== null && LIVE_ATTEMPT.has(refundAttempt.state)) this.attemptTo(refundAttempt, "FAILED_NO_EFFECT", { evidenceHash: observed.evidenceHash, outcomeCode: "PROVIDER_REFUSED" });
        this.refundTo(refund, "FAILED", { failureCode: "PROVIDER_REFUSED" });
        return obs("FAILED", "ADVANCED");
      }
    }
  }

  /**
   * The local refund an observed provider refund is, bound by identity only (B09-R1): the provider refund id a local refund
   * completed with; the attempt whose own dispatch response (or resume read by its request identity) reports it; or the platform's
   * own refund reference the provider's resource names (the refund id the request carried, part of the attempt's exact request).
   * Never by amount: a same-amount refund on the same capture is not evidence that it is the one in flight.
   */
  private refundFor(observed: ObservedRefund, capture: Mutable<CaptureFactRecord>, attempt: Mutable<PaymentAttemptRecord> | null): Mutable<RefundRecord> | null {
    for (const r of this.refunds.values()) if (r.providerRefundId === observed.providerRefundId) return r;
    if (attempt !== null && attempt.refundId !== undefined) {
      const r = this.refunds.get(attempt.refundId);
      if (r !== undefined && r.captureId === capture.captureId) return r;
    }
    if (observed.platformRefundRef !== null) {
      const r = this.refunds.get(observed.platformRefundRef as RefundId);
      if (r !== undefined && r.captureId === capture.captureId) return r;
    }
    return null;
  }

  /** A provider refund no local refund explains: its own UNKNOWN_REFUND case (one per provider refund; 0019), with its amount. */
  private unknownRefund(observed: ObservedRefund, capture: Mutable<CaptureFactRecord>): void {
    this.openCase("PROVIDER_INCONSISTENCY", { captureId: capture.captureId, providerRef: observed.providerRefundId }, "UNKNOWN_REFUND", observed.evidenceHash, observed.amountCents);
  }

  // --- disputes -------------------------------------------------------------------------------------------------------------

  /** D-DISPUTE-B1: a dispute in progress holds the funds and is visible; the capture stays COMPLETED until actually reversed. */
  private dispute(observed: ObservedDispute, providerEventAt: UtcInstant | undefined): void {
    const capture = this.captureByProvider(observed.providerCaptureId);
    const obs = (status: string, effect: ObservationEffect): void =>
      this.observation({ subjectKind: "CAPTURE", providerRef: observed.providerCaptureId, observedStatus: status, effect, evidenceHash: observed.evidenceHash, amountCents: observed.amountCents, currency: observed.currency, ...(providerEventAt !== undefined ? { providerEventAt } : {}) });
    if (capture === null) {
      this.exception(this.source === "WEBHOOK" ? "UNKNOWN_PROVIDER_REFERENCE" : "WRONG_ORDER", { providerRef: observed.providerCaptureId, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      return;
    }
    if (observed.currency !== this.order.currency) {
      this.exception("WRONG_CURRENCY", { providerRef: observed.providerCaptureId, amountCents: observed.amountCents, currency: observed.currency, evidenceHash: observed.evidenceHash });
      return obs("DISPUTE", "MISMATCH");
    }
    if (this.alreadyApplied("CAPTURE", observed.providerCaptureId)) {
      this.effects.push({ about: "CAPTURE", effect: "DUPLICATE" });
      return;
    }
    if (observed.status === "CLOSED_WON" || capture.status !== "COMPLETED") return obs(observed.status === "OPEN" ? "DISPUTE_OPENED" : "DISPUTE_CLOSED_WON", "NO_CHANGE");
    this.openCase("DISPUTE_OPEN", { captureId: capture.captureId }, observed.reasonCode, observed.evidenceHash, observed.amountCents);
    let advanced = false;
    if (capture.fundsState !== "HELD") advanced = this.learnFunds(capture, "HELD", observed.evidenceHash);
    obs("DISPUTE_OPENED", advanced ? "ADVANCED" : "NO_CHANGE");
  }
}

/** Plans the application of one authenticated observation to one order (design §6.3 steps 3–6; pure). */
export function planObservation(facts: ObservationFacts, input: ObservationInput): ObservationPlan {
  return new Planner(facts, input).plan();
}

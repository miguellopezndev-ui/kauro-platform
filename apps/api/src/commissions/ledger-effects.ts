/**
 * The commission service's effects on B10's ledger (docs/design/B10-commercial-domain.md §5, §6, §14; decisions D10-FIRST-2,
 * D10-ATTR-2, D10-POOL-1, D10-RATE-1, D10-RATE-2, D10-ADJ-1, D10-ADJ-2, D10-ELIG-1, D10-HOLD-1, D10-SVC-2, D10-SVC-3): what the
 * COMMISSIONS consumer and the sweeps do inside a SERVICE unit of work that adopted the agency of their work item. Every effect is
 * idempotent by the durable identity the database keeps — one designation mirror per agency, one conversion per claim and one
 * entitlement per (allocation or assistance agreement, seller), one pool per purchase and source, one adjustment per line and source
 * event, one completion per purchase and kind, one funds observation per capture version — so a redelivery or a second pass adds
 * nothing. The arithmetic is the domain's (B09's money kernel through commercial/ledger.ts and commercial/time.ts), rounded once; the
 * database repeats every rule (KC002, KC007, KC015, the pool terms, the claim and entitlement edges).
 *
 * Lock order (§10): the agency row (the designation mirror) → claims → entitlements → pools → lines → holds.
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  acquisitionRate,
  addHours,
  allocatePool,
  commissionBasis,
  commissionPoolCents,
  recomputePool,
  recurrenceWindowEndsAt,
  type AgencyId,
  type AssistanceAgreementId,
  type AttributionAllocationId,
  type BasisChange,
  type CaptureId,
  type CommissionAdjustmentRecord,
  type CommissionEntitlementId,
  type CommissionEntitlementRecord,
  type CommissionHoldId,
  type CommissionLineId,
  type CommissionLineRecord,
  type CommissionPoolId,
  type CommissionRateKind,
  type CommissionSource,
  type EventId,
  type FundsObservationId,
  type HoldReason,
  type PurchaseCompletionId,
  type QualifyingPurchaseRecord,
} from "@kauro/domain";
import { attributionOf, ledgerOf, recurrenceOf, salesOf, type PgCommercialUnitOfWork } from "@kauro/persistence";
import { COMMISSION_SERVICE_ID, HOLD_REVIEW_HOURS, type CommissionRuntime } from "./runtime.js";

/** The server's instant of the unit of work (kauro.server_now(), D10-CLOCK-1), as the domain's canonical instant (milliseconds). */
export async function serverNow(uow: PgCommercialUnitOfWork): Promise<UtcInstant> {
  const exact = await uow.serverInstant();
  return `${exact.slice(0, 23)}Z` as UtcInstant;
}

function stale(what: string, write: { readonly kind: string }): void {
  if (write.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", `the ${what} changed while the commission service wrote it`, {}, true);
}

// --- the first designation (D10-FIRST-2) ---------------------------------------------------------------------------------------------

/**
 * Mirrors the agency's sequence 1 into agencies.first_qualifying_capture_id, once: the agency row first, its version bumped, and
 * agency.first_purchase_designated.v1 for that version. Answers whether this unit of work mirrored it.
 */
export async function mirrorDesignation(uow: PgCommercialUnitOfWork, agencyId: AgencyId, now: UtcInstant): Promise<boolean> {
  const recurrence = await recurrenceOf(uow).get(agencyId);
  if (recurrence === null) return false;
  const out = await recurrenceOf(uow).mirrorFirstDesignation(agencyId, now);
  if (!out.mirrored) return false;
  await uow.events.publish({
    aggregateKind: "agency",
    aggregateId: agencyId,
    aggregateVersion: out.agency.version,
    agencyId,
    eventType: "agency.first_purchase_designated.v1",
    actor: { kind: "SERVICE", serviceId: COMMISSION_SERVICE_ID },
    causationId: uow.provenance().causationId,
    correlationId: uow.context.correlationId,
    payload: { agencyId, firstQualifyingCaptureId: recurrence.firstCaptureId, firstAuthorizationId: recurrence.firstPurchaseId, firstProjectId: recurrence.firstProjectId },
  });
  return true;
}

// --- conversion of accepted claims (D10-ATTR-2) ----------------------------------------------------------------------------------

/**
 * Converts each ACCEPTED claim of the agency's frozen allocation whose conversion the database admits — the agency's first purchase
 * confirmed before the claim's end (its termination tail's, else its acceptance window's) and the claim submitted before that
 * purchase's order — into its ACQUISITION entitlement: the window from the first designation's confirmation to twelve calendar months
 * later at the same America/Bogota wall time. A claim that cannot convert is left to CLAIM_WINDOWS. Answers how many converted.
 */
export async function convertAcceptedClaims(rt: CommissionRuntime, uow: PgCommercialUnitOfWork, agencyId: AgencyId, now: UtcInstant): Promise<number> {
  const recurrence = await recurrenceOf(uow).get(agencyId);
  if (recurrence === null) return 0;
  const allocation = await attributionOf(uow).frozenAllocationOf(agencyId);
  if (allocation === null) return 0;
  const first = await recurrenceOf(uow).getPurchase(recurrence.firstPurchaseId);
  if (first === null) throw new DomainFailure("INTEGRITY_FAILURE", "the agency's first designation names no qualifying purchase");
  let converted = 0;
  for (const share of allocation.shares) {
    const claim = await attributionOf(uow).lockClaim(share.claimId);
    if (claim === null || claim.state !== "ACCEPTED") continue;
    const tail = await salesOf(uow).tailEntryOfClaim(share.claimId);
    const end = tail?.endsAt ?? claim.expiresAt;
    if (!(Date.parse(first.confirmedAt) < Date.parse(end)) || !(Date.parse(claim.submittedAt) < Date.parse(first.orderCreatedAt))) continue;
    stale("claim", await attributionOf(uow).transitionClaim(share.claimId, claim.version, { state: "CONVERTED" }, now));
    await attributionOf(uow).createEntitlement({
      entitlementId: uow.ids.next() as CommissionEntitlementId,
      agencyId,
      sellerId: share.sellerId,
      source: "ACQUISITION",
      allocationId: allocation.allocationId,
      claimId: share.claimId,
      firstCaptureId: recurrence.firstCaptureId,
      windowStartsAt: recurrence.firstConfirmedAt,
      windowEndsAt: recurrenceWindowEndsAt(recurrence.firstConfirmedAt, rt.policy),
      agreementId: share.agreementId,
      agreementVersion: share.agreementVersion,
      shareBps: share.shareBps,
      createdAt: now,
    });
    converted++;
  }
  return converted;
}

// --- accrual (D10-POOL-1, D10-RATE-1, D10-RATE-2, D10-SVC-2) ------------------------------------------------------------------

/** How a purchase's pools are based at accrual (D10-SVC-2). */
export type AccrualBasis = "ALLOCATED" | "CURRENT";

export interface Accrual {
  /** Some source applies to the purchase (an acquisition decision other than NONE, an assistance agreement). */
  readonly applicable: boolean;
  /** Pools this unit of work created. */
  readonly created: number;
}

/** A capture's commission basis now: its allocated service less its completed service refunds, zero once reversed (D10-POOL-1). */
async function currentBasis(uow: PgCommercialUnitOfWork, captureId: CaptureId): Promise<bigint> {
  const capture = await uow.commerce.captures.get(captureId);
  if (capture === null) throw new DomainFailure("INTEGRITY_FAILURE", "the qualifying purchase's capture is not visible in its agency");
  let refunded = 0n;
  for (const r of await uow.commerce.refunds.listForCapture(captureId)) if (r.state === "COMPLETED" && r.approved !== undefined) refunded += r.approved.amounts.serviceCents;
  return commissionBasis({ status: capture.status, allocation: capture.allocation, completedServiceRefundCents: refunded });
}

async function accruePool(
  rt: CommissionRuntime,
  uow: PgCommercialUnitOfWork,
  purchase: QualifyingPurchaseRecord,
  now: UtcInstant,
  basisCents: bigint,
  spec: {
    readonly source: CommissionSource;
    readonly rateKind: CommissionRateKind;
    readonly rateBps: number;
    readonly allocationId?: AttributionAllocationId;
    readonly assistanceAgreementId?: AssistanceAgreementId;
    readonly entitlements: ReadonlyArray<CommissionEntitlementRecord>;
    readonly heldReason?: HoldReason;
  },
): Promise<boolean> {
  const poolCents = commissionPoolCents(basisCents, spec.rateBps);
  const shares = allocatePool(poolCents, spec.entitlements.map((e) => ({ sellerId: e.sellerId, shareBps: e.shareBps })));
  const reviewAt = addHours(now, HOLD_REVIEW_HOURS);
  const result = await ledgerOf(uow).accrue({
    poolId: uow.ids.next() as CommissionPoolId,
    purchaseId: purchase.purchaseId,
    agencyId: purchase.agencyId,
    captureId: purchase.captureId,
    source: spec.source,
    rateKind: spec.rateKind,
    ...(spec.allocationId !== undefined ? { allocationId: spec.allocationId } : {}),
    ...(spec.assistanceAgreementId !== undefined ? { assistanceAgreementId: spec.assistanceAgreementId } : {}),
    basisCents,
    rateBps: spec.rateBps,
    poolCents,
    policyVersion: rt.policy.version,
    lines: spec.entitlements.map((e) => {
      const cents = shares.get(e.sellerId) as bigint;
      // a line is born HELD under a hold of its whole amount: an implausible provider time (D10-RATE-2), or its entitlement disputed
      const reason: HoldReason | undefined = spec.heldReason ?? (e.state === "DISPUTED" ? "ATTRIBUTION_DISPUTED" : undefined);
      return {
        lineId: uow.ids.next() as CommissionLineId,
        entitlementId: e.entitlementId,
        sellerId: e.sellerId,
        shareBps: e.shareBps,
        cumulativeEntitlementCents: cents,
        ...(reason !== undefined && cents > 0n ? { heldReason: reason, reviewAt } : {}),
      };
    }),
    createdAt: now,
  });
  if (result.created && basisCents === 0n) {
    // a purchase accrued only after its full reversal or refund: its lines are born and voided at once (basis zero, entitlement zero)
    for (const line of result.lines) stale("line", await ledgerOf(uow).transitionLine(line.lineId, line.version, { state: "VOID" }, now));
  }
  return result.created;
}

/**
 * Accrues a qualifying purchase's pools, each once: ACQUISITION — the agency's frozen allocation at its first rate for sequence 1, at
 * its repeat rate when the verified provider completion precedes the window's exclusive end, born HELD PROVIDER_TIME_UNVERIFIED when
 * that instant is implausible, nothing after the window (acquisitionRate) — and one ASSISTANCE pool per assistance agreement signed
 * before the purchase's order. The basis is the purchase's allocated service (the consumer, whose basis changes post from their own
 * events) or the capture's current basis (a sweep, which has no event to post them from).
 */
export async function accruePurchase(rt: CommissionRuntime, uow: PgCommercialUnitOfWork, purchase: QualifyingPurchaseRecord, now: UtcInstant, basis: AccrualBasis): Promise<Accrual> {
  let applicable = false;
  let created = 0;
  let basisCents: bigint | null = null;
  const basisOf = async (): Promise<bigint> => (basisCents ??= basis === "ALLOCATED" ? purchase.allocatedServiceCents : await currentBasis(uow, purchase.captureId));

  const allocation = await attributionOf(uow).frozenAllocationOf(purchase.agencyId);
  if (allocation !== null) {
    const entitlements = (await attributionOf(uow).entitlementsOfAgency(purchase.agencyId)).filter((e) => e.source === "ACQUISITION" && e.allocationId === allocation.allocationId);
    const whole = entitlements.reduce((sum, e) => sum + e.shareBps, 0) === 10_000;
    const windowEndsAt = entitlements[0]?.windowEndsAt;
    if (whole && windowEndsAt !== undefined) {
      const decision = acquisitionRate(
        { firstBps: allocation.firstBps, repeatBps: allocation.repeatBps },
        { confirmationSeq: purchase.confirmationSeq, confirmedAt: purchase.confirmedAt, orderCreatedAt: purchase.orderCreatedAt, providerCompletedAt: purchase.providerCompletedAt ?? null, windowEndsAt },
      );
      if (decision.kind !== "NONE") {
        applicable = true;
        const done = await accruePool(rt, uow, purchase, now, await basisOf(), {
          source: "ACQUISITION",
          rateKind: decision.kind === "FIRST" ? "FIRST" : "REPEAT",
          rateBps: decision.rateBps,
          allocationId: allocation.allocationId,
          entitlements,
          ...(decision.kind === "HELD" ? { heldReason: decision.reason } : {}),
        });
        if (done) created++;
      }
    }
  }

  for (const agreement of await salesOf(uow).assistanceAgreementsFor(purchase.agencyId, purchase.projectId, purchase.orderCreatedAt)) {
    applicable = true;
    const entitlement = await attributionOf(uow).createEntitlement({
      entitlementId: uow.ids.next() as CommissionEntitlementId,
      agencyId: purchase.agencyId,
      sellerId: agreement.sellerId,
      source: "ASSISTANCE",
      assistanceAgreementId: agreement.assistanceAgreementId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      shareBps: 10_000,
      createdAt: now,
    });
    const done = await accruePool(rt, uow, purchase, now, await basisOf(), {
      source: "ASSISTANCE",
      rateKind: "ASSISTANCE",
      rateBps: agreement.rateBps,
      assistanceAgreementId: agreement.assistanceAgreementId,
      entitlements: [entitlement.record],
    });
    if (done) created++;
  }
  return { applicable, created };
}

// --- basis changes (D10-ADJ-1, D10-ADJ-2) -------------------------------------------------------------------------------------

/**
 * Applies a basis change of a capture to each of its pools: recomputed cumulatively from the pool's current basis (which only falls),
 * one adjustment per changed line sourced by the event, then each line's edge — VOID at a zero basis before payout, ADJUSTED after
 * one (and ADJUSTED → ADJUSTED); a PAYABLE line keeps its state, its adjustment going to the next statement. Answers how many pools
 * changed (a replay, or a refund completing after the reversal, changes none).
 */
export async function applyBasisChange(uow: PgCommercialUnitOfWork, captureId: CaptureId, change: BasisChange, sourceEventId: EventId, now: UtcInstant): Promise<number> {
  const ledger = ledgerOf(uow);
  let changed = 0;
  for (const { pool, lines } of await ledger.lockPoolsOfCapture(captureId)) {
    const recomputed = recomputePool(
      { basisCents: pool.basisCents, rateBps: pool.rateBps, lines: lines.map((l) => ({ lineId: l.lineId, sellerId: l.sellerId, shareBps: l.shareBps, cumulativeCents: l.cumulativeEntitlementCents })) },
      change,
    );
    if (recomputed.pool.basisCents === pool.basisCents) continue;
    const versionOf = new Map<string, string>();
    for (const l of lines) versionOf.set(l.lineId, (await attributionOf(uow).getEntitlement(l.entitlementId))?.agreementVersion ?? "");
    const written = await ledger.applyBasisChange(
      pool.poolId,
      recomputed.pool.basisCents,
      recomputed.poolCents,
      recomputed.adjustments.map((a) => ({
        adjustmentId: uow.ids.next() as CommissionAdjustmentRecord["adjustmentId"],
        commissionLineId: a.lineId as CommissionLineId,
        reason: a.reason,
        signedCents: a.signedCents,
        newCumulativeEntitlementCents: a.newCumulativeCents,
        sourceEventId,
        agreementVersion: versionOf.get(a.lineId) as string,
        createdAt: now,
      })),
    );
    if (!written.applied) continue;
    changed++;
    const adjusted = new Set(recomputed.adjustments.map((a) => a.lineId));
    for (const before of lines) {
      const line = (await ledger.getLine(before.lineId)) as CommissionLineRecord;
      let next: CommissionLineRecord["state"] | null = null;
      if (recomputed.pool.basisCents === 0n && (line.state === "ACCRUED_PENDING" || line.state === "HELD" || line.state === "ELIGIBLE")) next = "VOID";
      else if (adjusted.has(line.lineId) && (line.state === "PAID" || line.state === "ADJUSTED")) next = "ADJUSTED";
      if (next !== null) stale("line", await ledger.transitionLine(line.lineId, line.version, { state: next }, now));
    }
  }
  return changed;
}

// --- completions and funds (D10-ELIG-1, D10-HOLD-1) ---------------------------------------------------------------------------

/** Records what PreparationCompletionSource reports for the purchase, each completion once. Answers how many were new. */
export async function recordCompletions(rt: CommissionRuntime, uow: PgCommercialUnitOfWork, purchase: QualifyingPurchaseRecord, now: UtcInstant): Promise<number> {
  let recorded = 0;
  for (const c of await rt.completions.completionsOf(uow, { agencyId: purchase.agencyId, captureId: purchase.captureId })) {
    const written = await ledgerOf(uow).recordCompletion({
      completionId: uow.ids.next() as PurchaseCompletionId,
      purchaseId: purchase.purchaseId,
      agencyId: purchase.agencyId,
      kind: c.kind,
      ...(c.stageRef !== undefined ? { stageRef: c.stageRef } : {}),
      completedAt: c.completedAt,
      evidenceHash: c.evidenceHash,
      source: c.source,
      recordedAt: now,
    });
    if (written.recorded) recorded++;
  }
  return recorded;
}

/**
 * Records a capture's funds availability, once per capture version. Funds the provider HOLDS move each line of the capture that is
 * otherwise due — ACCRUED_PENDING, its FINAL completion 720 hours old — to HELD FUNDS_HELD under a hold of its whole unpaid amount with
 * the observation's review date; a line not yet due waits (the ELIGIBILITY sweep holds it when it falls due with the funds still held).
 * AVAILABLE funds release nothing here: the ELIGIBILITY sweep releases the hold and makes the line ELIGIBLE. Answers whether anything
 * was written.
 */
export async function observeFunds(
  uow: PgCommercialUnitOfWork,
  input: { readonly agencyId: AgencyId; readonly captureId: CaptureId; readonly captureVersion: number; readonly fundsState: "HELD" | "AVAILABLE"; readonly sourceEventId: EventId },
  now: UtcInstant,
): Promise<boolean> {
  const ledger = ledgerOf(uow);
  const reviewAt = input.fundsState === "HELD" ? addHours(now, HOLD_REVIEW_HOURS) : undefined;
  const observation = await ledger.recordFundsObservation({
    observationId: uow.ids.next() as FundsObservationId,
    agencyId: input.agencyId,
    captureId: input.captureId,
    captureVersion: input.captureVersion,
    fundsState: input.fundsState,
    ...(reviewAt !== undefined ? { reviewAt } : {}),
    sourceEventId: input.sourceEventId,
    observedAt: now,
  });
  let held = 0;
  if (input.fundsState === "HELD" && (await ledger.fundsStateOf(input.captureId)) === "HELD") {
    const review = observation.record.reviewAt ?? addHours(now, HOLD_REVIEW_HOURS);
    for (const { lines } of await ledger.lockPoolsOfCapture(input.captureId)) {
      for (const line of lines) {
        if (line.state !== "ACCRUED_PENDING" || line.cumulativeEntitlementCents - line.paidCents <= 0n) continue;
        const final = (await ledger.completionsOf(line.purchaseId)).find((c) => c.kind === "FINAL");
        if (final === undefined || Date.parse(final.completedAt) + 720 * 3_600_000 > Date.parse(now)) continue;
        stale("line", await ledger.transitionLine(line.lineId, line.version, { state: "HELD", heldReason: "FUNDS_HELD", reviewAt: review }, now));
        held++;
      }
    }
  }
  return observation.recorded || held > 0;
}

/** Releases an OPEN funds hold whose capture's funds became AVAILABLE (CommissionHold OPEN → RELEASED, the ELIGIBILITY sweep). */
export async function releaseFundsHold(uow: PgCommercialUnitOfWork, holdId: CommissionHoldId, version: number, now: UtcInstant): Promise<boolean> {
  const written = await ledgerOf(uow).resolveHold(holdId, version, "RELEASED", now);
  return written.kind === "APPLIED";
}

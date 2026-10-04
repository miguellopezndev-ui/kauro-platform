/**
 * The commission ledger's arithmetic (17 "Commission basis", "Claim validity and conflicts", "Refunds after payout and negative
 * balances", "Performance and compensation evolution"; reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES examples 1, 6, 7, 8, 19, 20
 * and 23; design D10-POOL-1, D10-ADJ-1, D10-ADJ-2, D10-NEG-1, D10-GUARD-1).
 *
 * Everything is computed over B09's money kernel (commerce/money.ts: roundHalfUpBps, allocateLargestRemainder, cumulativeEntitlement;
 * D-MONEY-B1), never a fork of it and never a second rounding: the pool is the basis rounded once at the rate; the beneficiaries'
 * allocations divide the already rounded pool by largest remainder over their shares, ties by beneficiary id ascending (policy
 * splitRemainder); every basis change recomputes the pool and each allocation cumulatively and posts the difference per line, so a
 * full refund ends every line at exactly zero whatever the sequence of partial refunds (R2-081).
 */
import type { CaptureStatus, RefundComponents } from "../commerce/records.js";
import { allocateLargestRemainder, assertMoney, cumulativeEntitlement } from "../commerce/money.js";
import { PreconditionFailure } from "../model/errors.js";
import { COMPENSATION_PLANNING_GUARD_BPS } from "./policy.js";
import type { AdjustmentDirection, GuardResult, OffsetTerms, RecoveryAction } from "./records.js";

// --- basis and pool (D10-POOL-1) ------------------------------------------------------------------------------------------------------

/** The capture facts the basis reads, and the service refunds completed against it. */
export interface CommissionBasisFacts {
  readonly status: CaptureStatus;
  /** The capture's allocation (service and tax paid toward the obligation, and excess), fixed at completion. */
  readonly allocation: RefundComponents;
  /** The provider's fee for the capture: recorded apart and never part of the basis (example 1). */
  readonly providerFeeCents?: bigint;
  /** The sum of the service components of the capture's COMPLETED refunds. */
  readonly completedServiceRefundCents: bigint;
}

/**
 * The commission basis of a capture (policy commission.base SERVICE_COLLECTED_AFTER_DISCOUNT_NET_OF_REFUND_EXCLUDING_TAX): its
 * allocated service — never the tax, the excess over the obligation or the processor fee (examples 1, 19, 20) — less its completed
 * service refunds, and zero once the capture is REVERSED. A capture that is not complete has no basis at all.
 */
export function commissionBasis(facts: CommissionBasisFacts): bigint {
  const service = assertMoney(facts.allocation.serviceCents);
  assertMoney(facts.allocation.taxCents);
  assertMoney(facts.allocation.excessCents);
  const refunded = assertMoney(facts.completedServiceRefundCents);
  if (refunded > service) throw new RangeError("completed service refunds exceed the allocated service");
  if (facts.status === "REVERSED") return 0n;
  if (facts.status !== "COMPLETED") throw new RangeError("only a COMPLETED or REVERSED capture has a commission basis");
  return service - refunded;
}

/** A pool's cents: the basis rounded half up once at the rate (the database checks the same equality at COMMIT, KC002). */
export function commissionPoolCents(basisCents: bigint, rateBps: number): bigint {
  return cumulativeEntitlement(basisCents, rateBps);
}

/** One beneficiary's signed share of a pool. */
export interface PoolShare<K extends string = string> {
  readonly sellerId: K;
  readonly shareBps: number;
}

/**
 * The allocation of an already rounded pool over signed shares (example 8; R2-097): largest remainder, ties by beneficiary id
 * ascending, the allocations summing to the pool exactly. Shares that do not sum to exactly 10 000 bps are refused
 * SHARES_NOT_WHOLE: two sellers share one pool, never one pool each.
 */
export function allocatePool<K extends string>(poolCents: bigint, shares: ReadonlyArray<PoolShare<K>>): ReadonlyMap<K, bigint> {
  let total = 0;
  for (const s of shares) {
    if (!Number.isSafeInteger(s.shareBps) || s.shareBps < 0 || s.shareBps > 10_000) throw new RangeError("a share is an integer number of basis points between 0 and 10000");
    total += s.shareBps;
  }
  if (shares.length === 0 || total !== 10_000) throw new PreconditionFailure("SHARES_NOT_WHOLE", `shares sum to ${total} bps, not 10000`);
  return allocateLargestRemainder(poolCents, shares.map((s) => ({ key: s.sellerId, weight: BigInt(s.shareBps) }))) as ReadonlyMap<K, bigint>;
}

// --- cumulative recomputation (D10-ADJ-1, D10-ADJ-2) ----------------------------------------------------------------------------------

/** One line of a pool as the recomputation sees it: its beneficiary, share and current cumulative entitlement. */
export interface PoolLineState {
  readonly lineId: string;
  readonly sellerId: string;
  readonly shareBps: number;
  readonly cumulativeCents: bigint;
}

/** A pool's current basis, rate and lines. */
export interface CommissionPoolState {
  readonly basisCents: bigint;
  readonly rateBps: number;
  readonly lines: ReadonlyArray<PoolLineState>;
}

/**
 * A change of a capture's commission basis: `refund.completed.v1` names the capture's allocated service less its completed service
 * refunds (`serviceBasisAfterCents`, which knows nothing of a reversal); `capture.reversed.v1` names zero.
 */
export type BasisChange = { readonly kind: "REFUND_COMPLETED"; readonly serviceBasisAfterCents: bigint } | { readonly kind: "CAPTURE_REVERSED" };

/** One posted difference (registry CommissionAdjustment without its identity): |new - previous| with its direction and sign. */
export interface LineAdjustment {
  readonly lineId: string;
  readonly sellerId: string;
  readonly reason: "REFUND" | "REVERSAL";
  readonly direction: AdjustmentDirection;
  readonly amountCents: bigint;
  readonly signedCents: bigint;
  readonly previousCumulativeCents: bigint;
  readonly newCumulativeCents: bigint;
}

export interface PoolRecomputation {
  readonly pool: CommissionPoolState;
  readonly poolCents: bigint;
  /** One per line whose cumulative entitlement changed, in the pool's line order; empty when nothing changed. */
  readonly adjustments: ReadonlyArray<LineAdjustment>;
}

/**
 * Recomputes a pool after a basis change (D10-ADJ-1): the new basis is the smaller of the current one and the event's — a basis only
 * falls (D10-ADJ-2), so a refund completing after the reversal, a replayed event or one naming a larger basis changes nothing — then
 * the pool is rounded once at the new basis, reallocated over the shares, and each changed line gets one signed adjustment from its
 * previous cumulative entitlement to the new one (examples 6 and 8: never a second negative accrual; a full refund ends at zero).
 */
export function recomputePool(state: CommissionPoolState, change: BasisChange): PoolRecomputation {
  const current = assertMoney(state.basisCents);
  const named = change.kind === "CAPTURE_REVERSED" ? 0n : assertMoney(change.serviceBasisAfterCents);
  const basisCents = named < current ? named : current;
  const poolCents = commissionPoolCents(basisCents, state.rateBps);
  const allocation = allocatePool(poolCents, state.lines.map((l) => ({ sellerId: l.sellerId, shareBps: l.shareBps })));
  if (basisCents === current) return { pool: state, poolCents, adjustments: [] };
  const reason = change.kind === "CAPTURE_REVERSED" ? "REVERSAL" : "REFUND";
  const adjustments: LineAdjustment[] = [];
  const lines = state.lines.map((l) => {
    const previous = assertMoney(l.cumulativeCents);
    const next = allocation.get(l.sellerId) as bigint;
    if (next !== previous) {
      const signed = next - previous;
      adjustments.push({
        lineId: l.lineId,
        sellerId: l.sellerId,
        reason,
        direction: signed < 0n ? "DECREASE" : "INCREASE",
        amountCents: signed < 0n ? -signed : signed,
        signedCents: signed,
        previousCumulativeCents: previous,
        newCumulativeCents: next,
      });
    }
    return { ...l, cumulativeCents: next };
  });
  return { pool: { basisCents, rateBps: state.rateBps, lines }, poolCents, adjustments };
}

// --- the statement position and the offset rule (D10-NEG-1) ---------------------------------------------------------------------------

/** What a statement shows for a line (example 7): original accrual, payout, adjustments and the resulting balance. */
export interface LinePosition {
  readonly accrualCents: bigint;
  readonly payoutCents: bigint;
  /** The sum of the line's signed adjustments. */
  readonly adjustmentCents: bigint;
  /** accrual + adjustments - payout: owed to the seller when positive, a negative position after a payout when negative. */
  readonly balanceCents: bigint;
}

/** A line's position from its first posting, its signed adjustments and its paid cents; the historical payout is never rewritten. */
export function linePosition(input: { readonly accrualCents: bigint; readonly adjustmentsCents: ReadonlyArray<bigint>; readonly paidCents: bigint }): LinePosition {
  const accrual = assertMoney(input.accrualCents);
  const paid = assertMoney(input.paidCents);
  let adjustment = 0n;
  for (const a of input.adjustmentsCents) adjustment += a;
  if (accrual + adjustment < 0n) throw new RangeError("a cumulative entitlement is never below zero");
  return { accrualCents: accrual, payoutCents: paid, adjustmentCents: adjustment, balanceCents: accrual + adjustment - paid };
}

/** The owner's concrete resolution actions for a negative position without signed offset terms (example 7). */
export const RECOVERY_ACTIONS: ReadonlyArray<RecoveryAction> = Object.freeze(["REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"]);

export interface NegativeBalanceTreatment {
  /** Cents of the eligible amount applied against the negative balance. */
  readonly offsetCents: bigint;
  /** What remains payable to the seller: never negative, so nothing debits the seller. */
  readonly payableCents: bigint;
  /** The balance after the offset (zero or negative), carried visibly to the next statement. */
  readonly remainingBalanceCents: bigint;
  /** Without signed offset terms: the owner's recovery item for the whole negative balance; otherwise null. */
  readonly recovery: { readonly amountCents: bigint; readonly actions: ReadonlyArray<RecoveryAction> } | null;
}

/**
 * The offset rule (D10-NEG-1; KC017): a negative balance is offset against a later eligible amount only under SIGNED_FUTURE_OFFSET
 * terms; otherwise the eligible amount is paid in full and the negative balance becomes the owner's REPAYMENT_REVIEW, WRITE_OFF or
 * DISPUTE item — never an indefinite invisible hold, never a debit of the seller's bank (R2-104).
 */
export function applyNegativeBalance(input: { readonly balanceCents: bigint; readonly eligibleCents: bigint; readonly offsetTerms: OffsetTerms }): NegativeBalanceTreatment {
  if (input.balanceCents > 0n) throw new RangeError("a negative position is zero or below");
  const eligible = assertMoney(input.eligibleCents);
  const owed = assertMoney(-input.balanceCents);
  if (owed === 0n) return { offsetCents: 0n, payableCents: eligible, remainingBalanceCents: 0n, recovery: null };
  if (input.offsetTerms === "SIGNED_FUTURE_OFFSET") {
    const offset = owed < eligible ? owed : eligible;
    return { offsetCents: offset, payableCents: eligible - offset, remainingBalanceCents: input.balanceCents + offset, recovery: null };
  }
  return { offsetCents: 0n, payableCents: eligible, remainingBalanceCents: input.balanceCents, recovery: { amountCents: owed, actions: RECOVERY_ACTIONS } };
}

// --- the compensation planning guard (D10-GUARD-1) -----------------------------------------------------------------------------------

export interface CompensationGuardReview {
  readonly retainerCents: bigint;
  readonly commissionAccruedCents: bigint;
  readonly attributableNetServiceCents: bigint;
  /** (retainer + commission) / net service in basis points, rounded half up for display only; null without attributable service. */
  readonly ratioBps: bigint | null;
  readonly ratioText: string | null;
  readonly thresholdBps: number;
  readonly result: GuardResult;
  readonly label: "BUSINESS_PLANNING_GUARD";
  readonly legalCeiling: false;
  readonly refuses: false;
}

/**
 * The owner's compensation-guard review of a seller's period (example 23; R2-105): the full acquisition cost — retainer plus
 * commission accrued — against the attributable net service. The result is decided by exact integer comparison,
 * (retainer + commission) x 10 000 > 1500 x net, never by the displayed ratio; it is a business planning guard and refuses nothing.
 */
export function compensationGuard(input: { readonly retainerCents: bigint; readonly commissionAccruedCents: bigint; readonly attributableNetServiceCents: bigint }): CompensationGuardReview {
  const retainer = assertMoney(input.retainerCents);
  const commission = assertMoney(input.commissionAccruedCents);
  const net = assertMoney(input.attributableNetServiceCents);
  const cost = retainer + commission;
  const threshold = COMPENSATION_PLANNING_GUARD_BPS;
  const exceeds = cost * 10_000n > BigInt(threshold) * net;
  let ratioBps: bigint | null = null;
  let ratioText: string | null = null;
  if (net > 0n) {
    ratioBps = (cost * 20_000n + net) / (2n * net);
    ratioText = `${ratioBps / 100n}.${(ratioBps % 100n).toString().padStart(2, "0")}%`;
  }
  return {
    retainerCents: retainer,
    commissionAccruedCents: commission,
    attributableNetServiceCents: net,
    ratioBps,
    ratioText,
    thresholdBps: threshold,
    result: exceeds ? "EXCEEDS_PLANNING_GUARD" : "WITHIN_PLANNING_GUARD",
    label: "BUSINESS_PLANNING_GUARD",
    legalCeiling: false,
    refuses: false,
  };
}

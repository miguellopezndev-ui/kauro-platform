/**
 * Order 27A: the generic USD receipt adapter and its reconciliation (Payments V1 offline; no Wise, no PayPal, no network). A receipt
 * source is anything that lists the incoming credits of one route account; the only implementation is the simulator below
 * (`SimulatedAchReceiptSource`), a fictitious ACH account whose credits a test scripts. Real sources stay behind
 * `O27A_ACTIVATION.realReceiptSource` (OFF) until PV1 (O27B).
 *
 * `reconcileReceipt` classifies one observation against what the platform already holds, reusing the existing ACH rules rather than
 * forking them (bank-credit.ts M1 `matchDecision`, P1Δ `creditOnTime`; ledger.ts postings; o27a-pending-hold.ts late credit):
 *  - idempotent by (accountRef, sourceRef): the same evidence again is a DUPLICATE with no effect; different evidence under the same
 *    key is an EVIDENCE_CONFLICT review, never an overwrite;
 *  - only a COMPLETED credit is money; PENDING waits; DENIED, REVERSED and UNRECOGNIZED go to review without a consequence;
 *  - USD only, integer minor units (bigint), every amount through assertMoney;
 *  - a matched, on-time credit applies: exact, partial, or with an excess that becomes a refund review (never kept as revenue);
 *  - a credit after the deadline, after a pending-payment hold ended unpaid (data deleted), or without an order is unassigned money:
 *    REVIEW_AND_REFUND, never a revival of deleted data and never an application;
 *  - every outcome carries balanced postings over the platform's ledger accounts, and a receipt only for applied money.
 * Pure: no clock, no I/O.
 */
import { canonicalBytes, rawDigest, type Sha256Hex } from "@kauro/contracts";
import { creditOnTime, matchDecision, type BankCreditRail, type MatchKeys } from "./bank-credit.js";
import { capturePostings, fundsPostings, isBalanced, returnPostings, type PostingLine } from "./ledger.js";
import { assertMoney } from "./money.js";
import type { BankCreditStatus } from "./records.js";

export interface ReceiptObservation {
  readonly accountRef: string;
  /** The bank's own transaction id: unique per account (the idempotency key with accountRef). */
  readonly sourceRef: string;
  readonly rail: BankCreditRail;
  readonly status: BankCreditStatus;
  readonly currency: string;
  readonly grossCents: bigint;
  readonly reference: string | null;
  readonly bookedAt: string | null;
  readonly payerDigest: Sha256Hex | null;
  readonly payeeDigest: Sha256Hex | null;
  readonly evidenceHash: Sha256Hex;
}

/** A source of incoming credits for one route account. */
export interface ReceiptSource {
  readonly kind: "SIMULATOR";
  readonly accountRef: string;
  /** Credits observed after `cursor` (exclusive), oldest first, at most `limit`. */
  list(cursor: string | null, limit: number): Promise<{ readonly items: ReadonlyArray<ReceiptObservation>; readonly next: string | null }>;
  /** One credit by its source id (a GET; never a write). */
  get(sourceRef: string): Promise<ReceiptObservation | null>;
}

/**
 * The fictitious ACH account. Scripted credits only; it counts its calls so tests prove it never spends or writes: it has no write
 * method at all, and `spentCents` is always 0.
 */
export class SimulatedAchReceiptSource implements ReceiptSource {
  readonly kind = "SIMULATOR" as const;
  readonly spentCents = 0n;
  readonly calls: Array<"list" | "get"> = [];
  private readonly credits: ReceiptObservation[] = [];
  constructor(readonly accountRef: string) {}

  /** Scripts one credit as the bank would show it next (a replay of the same source id is allowed: it is how duplicates arrive). */
  script(credit: Omit<ReceiptObservation, "accountRef">): void {
    this.credits.push(Object.freeze({ ...credit, accountRef: this.accountRef }));
  }

  async list(cursor: string | null, limit: number): Promise<{ readonly items: ReadonlyArray<ReceiptObservation>; readonly next: string | null }> {
    this.calls.push("list");
    const start = cursor === null ? 0 : Number(cursor);
    const items = this.credits.slice(start, start + limit);
    const end = start + items.length;
    return { items, next: end < this.credits.length ? String(end) : null };
  }

  async get(sourceRef: string): Promise<ReceiptObservation | null> {
    this.calls.push("get");
    const all = this.credits.filter((c) => c.sourceRef === sourceRef);
    return all.length === 0 ? null : (all[all.length - 1] as ReceiptObservation);
  }
}

/** The order a credit may pay: M1's frozen keys and the amounts its allocation splits into. */
export interface ReceivableOrder {
  readonly keys: MatchKeys;
  /** The quote's service and tax (the obligation); anything above is excess. */
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  /** Applied so far by earlier credits. */
  readonly receivedCents: bigint;
  /** A pending-payment hold that ended unpaid: the project's data was deleted. */
  readonly holdEndedUnpaid: boolean;
}

export type ReceiptReviewReason =
  | "EVIDENCE_CONFLICT"
  | "NOT_COMPLETED"
  | "CURRENCY_NOT_USD"
  | "NO_ORDER"
  | "PAYER_MISMATCH"
  | "PAYEE_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "RAIL_NOT_ACCEPTED"
  | "REFERENCE_MISSING"
  | "ACCOUNT_MISMATCH";

export type ReceiptOutcome =
  | { readonly kind: "DUPLICATE"; readonly key: string }
  | { readonly kind: "PENDING"; readonly key: string }
  | { readonly kind: "REVIEW"; readonly key: string; readonly reason: ReceiptReviewReason }
  | { readonly kind: "REVIEW_AND_REFUND"; readonly key: string; readonly reason: "LATE_AFTER_DEADLINE" | "LATE_AFTER_HOLD_ENDED" | "UNASSIGNED"; readonly amountCents: bigint; readonly revivesData: false; readonly postings: ReadonlyArray<PostingLine> }
  | {
      readonly kind: "APPLIED";
      readonly key: string;
      readonly orderId: string;
      readonly coverage: "EXACT" | "PARTIAL" | "EXCESS";
      readonly appliedServiceCents: bigint;
      readonly appliedTaxCents: bigint;
      readonly excessCents: bigint;
      readonly postings: ReadonlyArray<PostingLine>;
      readonly receipt: PaymentReceipt;
    };

/** What the ledger already knows of a key: the evidence it recorded. */
export type KnownReceipts = ReadonlyMap<string, Sha256Hex>;

export function receiptKey(o: Pick<ReceiptObservation, "accountRef" | "sourceRef">): string {
  return `${o.accountRef}\u0000${o.sourceRef}`;
}

/**
 * A payment receipt: proof that money was received and applied. It is never an invoice (o27a-invoice-rules.ts decides that); its id is
 * deterministic, so a replay produces the same receipt.
 */
export interface PaymentReceipt {
  readonly receiptId: Sha256Hex;
  readonly orderId: string;
  readonly currency: "USD";
  readonly receivedCents: bigint;
  readonly appliedServiceCents: bigint;
  readonly appliedTaxCents: bigint;
  readonly excessCents: bigint;
  readonly bookedAt: string;
  readonly isFiscalInvoice: false;
}

export const PAYMENT_RECEIPT_DOMAIN = "KAURO_PAYMENT_RECEIPT_V1";

function receiptOf(o: ReceiptObservation, orderId: string, service: bigint, tax: bigint, excess: bigint): PaymentReceipt {
  const receiptId = rawDigest(canonicalBytes({ domain: PAYMENT_RECEIPT_DOMAIN, version: 1, payload: { accountRef: o.accountRef, sourceRef: o.sourceRef, evidenceHash: o.evidenceHash, orderId } }));
  return Object.freeze({ receiptId, orderId, currency: "USD", receivedCents: o.grossCents, appliedServiceCents: service, appliedTaxCents: tax, excessCents: excess, bookedAt: o.bookedAt as string, isFiscalInvoice: false });
}

/**
 * Splits a received amount over what the order still owes: service first, then tax, the rest is excess (the B09 allocation order of a
 * capture: service and tax toward the obligation, then excess).
 */
export function allocateReceived(order: Pick<ReceivableOrder, "serviceCents" | "taxCents" | "receivedCents">, grossCents: bigint): { readonly serviceCents: bigint; readonly taxCents: bigint; readonly excessCents: bigint } {
  const gross = assertMoney(grossCents);
  const service = assertMoney(order.serviceCents);
  const tax = assertMoney(order.taxCents);
  const before = assertMoney(order.receivedCents);
  const serviceLeft = before >= service ? 0n : service - before;
  const taxLeft = before >= service + tax ? 0n : service + tax - (before > service ? before : service);
  const s = gross < serviceLeft ? gross : serviceLeft;
  const t = gross - s < taxLeft ? gross - s : taxLeft;
  return { serviceCents: s, taxCents: t, excessCents: gross - s - t };
}

/** Unassigned money: received into the route account and owed back (CUSTOMER_OVERPAYMENT) until its refund completes. */
export function unassignedPostings(amountCents: bigint): ReadonlyArray<PostingLine> {
  return receivedPostings({ serviceCents: 0n, taxCents: 0n, excessCents: assertMoney(amountCents) });
}

/**
 * A booked, COMPLETED bank credit: the capture postings (B09 ledger) and, since the bank already shows the money in the route account,
 * its move from receivable to available in the same set (the bank route has no provider hold to wait for).
 */
export function receivedPostings(split: { readonly serviceCents: bigint; readonly taxCents: bigint; readonly excessCents: bigint }): ReadonlyArray<PostingLine> {
  const total = assertMoney(split.serviceCents + split.taxCents + split.excessCents);
  return [...capturePostings(split), ...fundsPostings("UNKNOWN", "AVAILABLE", total)];
}

/** The completion of the refund of unassigned or excess money: the overpayment leaves the route account. */
export function unassignedRefundPostings(amountCents: bigint): ReadonlyArray<PostingLine> {
  return returnPostings({ serviceCents: 0n, taxCents: 0n, excessCents: assertMoney(amountCents) }, "AVAILABLE", assertMoney(amountCents));
}

export function reconcileReceipt(o: ReceiptObservation, input: { readonly known: KnownReceipts; readonly order: ReceivableOrder | null; readonly accountRef: string }): ReceiptOutcome {
  const key = receiptKey(o);
  const seen = input.known.get(key);
  if (seen !== undefined) return seen === o.evidenceHash ? { kind: "DUPLICATE", key } : { kind: "REVIEW", key, reason: "EVIDENCE_CONFLICT" };
  if (o.accountRef !== input.accountRef) return { kind: "REVIEW", key, reason: "ACCOUNT_MISMATCH" };
  assertMoney(o.grossCents);
  if (o.status === "PENDING") return { kind: "PENDING", key };
  if (o.status !== "COMPLETED" || o.bookedAt === null) return { kind: "REVIEW", key, reason: "NOT_COMPLETED" };
  if (o.currency !== "USD") return { kind: "REVIEW", key, reason: "CURRENCY_NOT_USD" };
  const credit = { reference: o.reference, currency: "USD" as const, rail: o.rail, payerDigest: o.payerDigest, payeeDigest: o.payeeDigest };
  const order = input.order;
  if (order === null) {
    // no order to pay (unknown reference): unassigned money owed back; a missing reference is a review of its own
    if (o.reference === null) return { kind: "REVIEW", key, reason: "REFERENCE_MISSING" };
    return { kind: "REVIEW_AND_REFUND", key, reason: "UNASSIGNED", amountCents: o.grossCents, revivesData: false, postings: unassignedPostings(o.grossCents) };
  }
  const match = matchDecision(credit, order.keys);
  if (match.kind === "REVIEW") return { kind: "REVIEW", key, reason: match.reason };
  if (order.keys.accountRef !== o.accountRef) return { kind: "REVIEW", key, reason: "ACCOUNT_MISMATCH" };
  if (order.holdEndedUnpaid) return { kind: "REVIEW_AND_REFUND", key, reason: "LATE_AFTER_HOLD_ENDED", amountCents: o.grossCents, revivesData: false, postings: unassignedPostings(o.grossCents) };
  if (!creditOnTime(o.bookedAt, order.keys.transferExpiresAt, order.keys.providerTimeToleranceMs)) {
    return { kind: "REVIEW_AND_REFUND", key, reason: "LATE_AFTER_DEADLINE", amountCents: o.grossCents, revivesData: false, postings: unassignedPostings(o.grossCents) };
  }
  const split = allocateReceived(order, o.grossCents);
  const total = assertMoney(order.serviceCents + order.taxCents);
  const after = order.receivedCents + o.grossCents;
  const coverage = split.excessCents > 0n ? "EXCESS" : after === total ? "EXACT" : "PARTIAL";
  const postings = receivedPostings(split);
  if (!isBalanced(postings)) throw new Error("unbalanced receipt postings");
  return {
    kind: "APPLIED",
    key,
    orderId: order.keys.orderId,
    coverage,
    appliedServiceCents: split.serviceCents,
    appliedTaxCents: split.taxCents,
    excessCents: split.excessCents,
    postings,
    receipt: receiptOf(o, order.keys.orderId, split.serviceCents, split.taxCents, split.excessCents),
  };
}

/** The net balance of each account over a set of postings (DEBIT positive). */
export function accountBalances(postings: ReadonlyArray<PostingLine>): ReadonlyMap<string, bigint> {
  const out = new Map<string, bigint>();
  for (const p of postings) out.set(p.account, (out.get(p.account) ?? 0n) + (p.direction === "DEBIT" ? p.amountCents : -p.amountCents));
  return out;
}

/**
 * Reconciles a whole source page by page into a running ledger: each observation once, in order, the known keys growing as it goes, so
 * a replay inside the same run is a duplicate too. Returns every outcome and the postings of the run.
 *
 * The order's running balance is the module's to keep (review O27A F-1): every credit is allocated against what was applied before it —
 * either `receivedOf` (the store's live balance, which already holds every outcome recorded earlier in the run) or, without it, the
 * balance `orderFor` gave when the run started plus what this run applied. So a second partial credit of one order in one run takes the
 * excess, never more service. `onOutcome` runs before the next observation; when it answers false (the caller could not record the
 * outcome: another run owns the account) the run stops there.
 */
export async function reconcileSource(
  source: ReceiptSource,
  input: {
    readonly known: Map<string, Sha256Hex>;
    readonly orderFor: (reference: string | null) => ReceivableOrder | null;
    readonly receivedOf?: (orderId: string) => Promise<bigint>;
    readonly onOutcome?: (outcome: ReceiptOutcome) => void | boolean | Promise<void | boolean>;
    readonly pageSize?: number;
  },
): Promise<{ readonly outcomes: ReadonlyArray<ReceiptOutcome>; readonly postings: ReadonlyArray<PostingLine>; readonly stopped: boolean }> {
  const outcomes: ReceiptOutcome[] = [];
  const postings: PostingLine[] = [];
  const appliedInRun = new Map<string, bigint>();
  let cursor: string | null = null;
  do {
    const page: { readonly items: ReadonlyArray<ReceiptObservation>; readonly next: string | null } = await source.list(cursor, input.pageSize ?? 50);
    for (const o of page.items) {
      const base = input.orderFor(o.reference);
      const order =
        base === null
          ? null
          : { ...base, receivedCents: input.receivedOf !== undefined ? await input.receivedOf(base.keys.orderId) : base.receivedCents + (appliedInRun.get(base.keys.orderId) ?? 0n) };
      const outcome = reconcileReceipt(o, { known: input.known, order, accountRef: source.accountRef });
      outcomes.push(outcome);
      if (outcome.kind === "APPLIED" || outcome.kind === "REVIEW_AND_REFUND") {
        postings.push(...outcome.postings);
        input.known.set(outcome.key, o.evidenceHash);
      } else if (outcome.kind === "REVIEW" && outcome.reason !== "EVIDENCE_CONFLICT") input.known.set(outcome.key, o.evidenceHash);
      if (outcome.kind === "APPLIED") appliedInRun.set(outcome.orderId, (appliedInRun.get(outcome.orderId) ?? 0n) + outcome.appliedServiceCents + outcome.appliedTaxCents);
      if ((await input.onOutcome?.(outcome)) === false) return { outcomes, postings, stopped: true };
    }
    cursor = page.next;
  } while (cursor !== null);
  return { outcomes, postings, stopped: false };
}

/**
 * Operational ledger postings (15 "Operational ledger": immutable events and balanced monetary allocations; suggested accounts
 * provider receivable, bank cash, customer contract liability, recognized service revenue, tax payable, refund payable,
 * processor expense, commission payable/expense, owner contribution and distribution; the accountant maps them to the legal
 * chart. reference/HASHING "Ledger posting and reconciliation": each balanced transaction balances within its currency; a
 * refund webhook replay does not post another refund; a corrected amount is a reversal plus a new entry, never an edit).
 *
 * B09 posts only reconciled money movements, each from the domain event that records it (the event id is the idempotency
 * identity of the posting set, migration 0011 ledger_entries UNIQUE (event_id, line_no)):
 *   capture completed → DEBIT PSP_RECEIVABLE amount / CREDIT CONTRACT_LIABILITY service, TAX_PAYABLE tax,
 *                       CUSTOMER_OVERPAYMENT excess (a capture before delivery is a contract liability, not revenue: 15
 *                       "Revenue recognition follows the actual accounting policy")
 *   provider fee       → DEBIT PROCESSOR_EXPENSE / CREDIT PSP_RECEIVABLE (the actual fee the provider reported)
 *   refund completed   → DEBIT CONTRACT_LIABILITY service, TAX_PAYABLE tax, CUSTOMER_OVERPAYMENT excess / CREDIT PSP_RECEIVABLE
 *   chargeback         → the same shape over the unrefunded components of the reversed capture
 * Settlement movements (receivable → held/available → bank in transit → bank cash) are posted by the settlement reconciler
 * from observed balances (R2-085, fiscal/integration package B15). Zero lines are never written.
 */
import { assertMoney } from "./money.js";
import type { LedgerAccount, RefundComponents } from "./records.js";

export const LEDGER_ACCOUNT_VERSION = "OPS-1";
export const LEDGER_POLICY_VERSION = "B09-1";

export const LEDGER_ACCOUNTS: ReadonlyArray<LedgerAccount> = [
  "PSP_RECEIVABLE",
  "PSP_HELD",
  "PSP_AVAILABLE",
  "BANK_IN_TRANSIT",
  "BANK_CASH",
  "CONTRACT_LIABILITY",
  "SERVICE_REVENUE",
  "TAX_PAYABLE",
  "CUSTOMER_OVERPAYMENT",
  "REFUND_PAYABLE",
  "PROCESSOR_EXPENSE",
  "COMMISSION_PAYABLE",
  "COMMISSION_EXPENSE",
  "OWNER_CONTRIBUTION",
  "OWNER_DISTRIBUTION",
];

export interface PostingLine {
  readonly account: LedgerAccount;
  readonly direction: "DEBIT" | "CREDIT";
  readonly amountCents: bigint;
}

function line(account: LedgerAccount, direction: PostingLine["direction"], amountCents: bigint): PostingLine | null {
  assertMoney(amountCents);
  return amountCents === 0n ? null : { account, direction, amountCents };
}

function lines(...ls: ReadonlyArray<PostingLine | null>): ReadonlyArray<PostingLine> {
  return ls.filter((l): l is PostingLine => l !== null);
}

export function capturePostings(allocation: RefundComponents): ReadonlyArray<PostingLine> {
  const total = allocation.serviceCents + allocation.taxCents + allocation.excessCents;
  return lines(
    line("PSP_RECEIVABLE", "DEBIT", total),
    line("CONTRACT_LIABILITY", "CREDIT", allocation.serviceCents),
    line("TAX_PAYABLE", "CREDIT", allocation.taxCents),
    line("CUSTOMER_OVERPAYMENT", "CREDIT", allocation.excessCents),
  );
}

export function providerFeePostings(feeCents: bigint): ReadonlyArray<PostingLine> {
  return lines(line("PROCESSOR_EXPENSE", "DEBIT", feeCents), line("PSP_RECEIVABLE", "CREDIT", feeCents));
}

/** A completed refund, or a chargeback over the unrefunded components (the provider returned the money in both cases). */
export function returnPostings(amounts: RefundComponents): ReadonlyArray<PostingLine> {
  const total = amounts.serviceCents + amounts.taxCents + amounts.excessCents;
  return lines(
    line("CONTRACT_LIABILITY", "DEBIT", amounts.serviceCents),
    line("TAX_PAYABLE", "DEBIT", amounts.taxCents),
    line("CUSTOMER_OVERPAYMENT", "DEBIT", amounts.excessCents),
    line("PSP_RECEIVABLE", "CREDIT", total),
  );
}

/** Debits equal credits (one currency per posting set; the database re-checks at commit, KA009). */
export function isBalanced(ls: ReadonlyArray<PostingLine>): boolean {
  let net = 0n;
  for (const l of ls) net += l.direction === "DEBIT" ? l.amountCents : -l.amountCents;
  return net === 0n;
}

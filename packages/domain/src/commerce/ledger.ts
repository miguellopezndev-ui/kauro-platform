/**
 * Operational ledger postings (15 "Operational ledger": immutable events and balanced monetary allocations; suggested accounts
 * provider receivable, bank cash, customer contract liability, recognized service revenue, tax payable, refund payable,
 * processor expense, commission payable/expense, owner contribution and distribution; the accountant maps them to the legal
 * chart. reference/HASHING "Ledger posting and reconciliation": each balanced transaction balances within its currency; a
 * refund webhook replay does not post another refund; a corrected amount is a reversal plus a new entry, never an edit).
 *
 * B09 posts only reconciled money movements, each from the domain event that records it (the event id is the idempotency
 * identity of the posting set, migration 0017 ledger_entries UNIQUE (event_id, line_no); the event is the source's own,
 * ledger_entries_source_event). The money a capture brought in sits at the provider in exactly one balance at a time — the
 * balance of the capture's funds state (`fundsAccountOf`: UNKNOWN → PSP_RECEIVABLE, HELD → PSP_HELD, AVAILABLE → PSP_AVAILABLE)
 * — and every posting that takes money out of it credits that balance as the event names it (D-LEDGER-B5; B09-N4):
 *   capture completed → DEBIT PSP_RECEIVABLE amount / CREDIT CONTRACT_LIABILITY service, TAX_PAYABLE tax,
 *                       CUSTOMER_OVERPAYMENT excess (a capture before delivery is a contract liability, not revenue: 15
 *                       "Revenue recognition follows the actual accounting policy"); a capture is born with its funds UNKNOWN
 *   provider fee       → DEBIT PROCESSOR_EXPENSE / CREDIT the balance of the funds state the fee's event names (the actual fee
 *                        the provider reported; a fee reported with the completion is credited to PSP_RECEIVABLE), up to the
 *                        capture's movable balance before it; the rest from the merchant's available balance (below)
 *   funds observed     → the capture's movable balance (`movableBalanceOf`: its amount less the reported fee and the money
 *                        already returned) moves from the balance of the previous funds state to the balance of the new one —
 *                        provider balances only, never bank cash (CMD034 failure; migration 0017 ledger_entries_funds_accounts)
 *   refund completed   → DEBIT CONTRACT_LIABILITY service, TAX_PAYABLE tax, CUSTOMER_OVERPAYMENT excess / CREDIT the balance of
 *                        the funds state the refund's completion event names, up to the capture's movable balance before it;
 *                        the rest from the merchant's available balance (below)
 *   chargeback         → the same shape over the unrefunded components of the reversed capture
 * A capture holds at the provider only its movable balance — its amount less the fee the provider reported and the money already
 * returned. A return or a fee that takes more than that (a full refund or a chargeback after a fee the provider keeps, or a fee
 * reported after most of the money went back) is not taken from the capture's own balance: the provider recovers the difference
 * from the merchant's available balance (PSP_AVAILABLE, `MERCHANT_BALANCE_ACCOUNT`), so the capture's receivable and held balances
 * never go negative and end at zero once its money has left, and the merchant's available balance carries exactly the fees the
 * provider kept (D-LEDGER-B6; the re-check's residual N4). The events that take money out carry the movable balance before them
 * (`movableBalanceCents`, read under the capture's row lock and, for a refund's completion, after the completions of the same
 * capture that committed before it).
 * Every amount a set posts is fixed by its event, so the balances a capture ends with do not depend on the order in which the
 * consumer delivers the events. Bank movements (the provider's available balance → bank in transit → bank cash) are posted only
 * from settlement observations with bank evidence (R2-085, the settlement reconciler of the integration package B15; migration
 * 0017 ledger_entries_bank_accounts). Zero lines are never written.
 */
import { assertMoney } from "./money.js";
import type { CaptureStatus, FundsState, LedgerAccount, RefundComponents } from "./records.js";

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

/** The provider balances a capture's money moves between (a FUNDS posting touches nothing else; migration 0017). */
export const PROVIDER_BALANCE_ACCOUNTS: ReadonlyArray<LedgerAccount> = ["PSP_RECEIVABLE", "PSP_HELD", "PSP_AVAILABLE"];
/** The bank accounts only a settlement observation with bank evidence posts to (migration 0017 ledger_entries_bank_accounts). */
export const BANK_ACCOUNTS: ReadonlyArray<LedgerAccount> = ["BANK_IN_TRANSIT", "BANK_CASH"];

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

/** The provider balance a capture's money sits in while its funds are in this state (D-LEDGER-B5). */
export function fundsAccountOf(state: FundsState): LedgerAccount {
  switch (state) {
    case "UNKNOWN":
      return "PSP_RECEIVABLE";
    case "HELD":
      return "PSP_HELD";
    case "AVAILABLE":
      return "PSP_AVAILABLE";
  }
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

/**
 * The merchant's balance at the provider, from which the provider recovers what a fee or a return takes beyond a capture's movable
 * balance (D-LEDGER-B6): the available balance, where the provider nets refunds, chargebacks and the fees it keeps.
 */
export const MERCHANT_BALANCE_ACCOUNT: LedgerAccount = "PSP_AVAILABLE";

/**
 * The credit lines of money taken out of a capture at the provider: up to the capture's movable balance before it from the balance
 * of the funds state the event names, the rest — only ever a fee the provider keeps — from the merchant's available balance.
 */
function takenFromProvider(amountCents: bigint, fundsState: FundsState, movableBalanceCents: bigint): ReadonlyArray<PostingLine | null> {
  assertMoney(amountCents);
  assertMoney(movableBalanceCents);
  const from = fundsAccountOf(fundsState);
  const own = amountCents < movableBalanceCents ? amountCents : movableBalanceCents;
  if (from === MERCHANT_BALANCE_ACCOUNT) return [line(from, "CREDIT", amountCents)];
  return [line(from, "CREDIT", own), line(MERCHANT_BALANCE_ACCOUNT, "CREDIT", amountCents - own)];
}

/**
 * The provider's reported fee, taken from the balance the capture's money sits in when the fee's event was published, up to the
 * capture's movable balance before the fee (its amount less the money already returned; for a fee reported with the completion, the
 * amount); the rest from the merchant's available balance (D-LEDGER-B6).
 */
export function providerFeePostings(feeCents: bigint, fundsState: FundsState, movableBalanceCents: bigint): ReadonlyArray<PostingLine> {
  return lines(line("PROCESSOR_EXPENSE", "DEBIT", feeCents), ...takenFromProvider(feeCents, fundsState, movableBalanceCents));
}

/**
 * What of a capture's money is still at the provider to move between its balances: the captured amount less the fee the provider
 * reported and the money already returned (completed refunds), never below zero — a return beyond it (a refund or chargeback that
 * returns a fee the provider keeps) is recovered by the provider from the merchant's available balance, not from this capture's
 * (returnPostings and providerFeePostings credit that part to MERCHANT_BALANCE_ACCOUNT; D-LEDGER-B6).
 */
export function movableBalanceOf(capture: { readonly amountCents: bigint; readonly providerFeeCents: bigint; readonly returnedCents: bigint }): bigint {
  assertMoney(capture.amountCents);
  assertMoney(capture.providerFeeCents);
  assertMoney(capture.returnedCents);
  const left = capture.amountCents - capture.providerFeeCents - capture.returnedCents;
  return left > 0n ? left : 0n;
}

/**
 * Every return nets against the capture exactly once, whatever order the provider's facts are observed in (D-LEDGER-B7; B09-R2). A
 * capture's allocation leaves it through its completed refunds and at most one reversal: a reversal returns the components no
 * completed refund had returned (capture.reversed.v1 reversed*Cents), so once the capture is REVERSED every component has left it and
 * a refund that completes afterwards — one in flight when the chargeback came, observed later or in the same provider view —
 * returns nothing more; before the reversal a refund returns its approved components (the commitment ceiling keeps them within the
 * allocation, KP003). What a completion returns is what its event carries for the ledger (refund.completed.v1 returned*Cents); its
 * approved components stay the credit note's and the commissions' basis.
 */
export function refundReturnOf(approved: RefundComponents, captureStatus: CaptureStatus): RefundComponents {
  return captureStatus === "REVERSED" ? { serviceCents: 0n, taxCents: 0n, excessCents: 0n } : approved;
}

/**
 * The money a capture has returned so far (the `returnedCents` of movableBalanceOf; D-LEDGER-B7): all of it once it is REVERSED —
 * the reversal returned what the completed refunds before it had not — else what its completed refunds returned.
 */
export function returnedCentsOf(capture: { readonly status: CaptureStatus; readonly amountCents: bigint }, completedRefundsCents: bigint): bigint {
  assertMoney(completedRefundsCents);
  return capture.status === "REVERSED" ? capture.amountCents : completedRefundsCents;
}

/**
 * A provider availability change of captured funds (capture.funds_observed.v1, D-EVT-B2; its payload's amountCents is the
 * capture's movable balance at that version): the balance moves from the account of the previous state to the account of the
 * new one — never bank cash (CMD034 failure; bank cash comes only from a settlement with bank evidence).
 */
export function fundsPostings(previous: FundsState, next: Exclude<FundsState, "UNKNOWN">, balanceCents: bigint): ReadonlyArray<PostingLine> {
  const from = fundsAccountOf(previous);
  const to = fundsAccountOf(next);
  if (from === to) return [];
  return lines(line(to, "DEBIT", balanceCents), line(from, "CREDIT", balanceCents));
}

/**
 * A completed refund, or a chargeback over the unrefunded components (the provider returned the money in both cases), taken from
 * the balance the capture's money sits in when the event was published, up to the capture's movable balance before the return; what
 * it returns beyond that — the fee the provider keeps — from the merchant's available balance (D-LEDGER-B6).
 */
export function returnPostings(amounts: RefundComponents, fundsState: FundsState, movableBalanceCents: bigint): ReadonlyArray<PostingLine> {
  const total = amounts.serviceCents + amounts.taxCents + amounts.excessCents;
  return lines(
    line("CONTRACT_LIABILITY", "DEBIT", amounts.serviceCents),
    line("TAX_PAYABLE", "DEBIT", amounts.taxCents),
    line("CUSTOMER_OVERPAYMENT", "DEBIT", amounts.excessCents),
    ...takenFromProvider(total, fundsState, movableBalanceCents),
  );
}

/** Debits equal credits (one currency per posting set; the database re-checks at commit, SQLSTATE KP001). */
export function isBalanced(ls: ReadonlyArray<PostingLine>): boolean {
  let net = 0n;
  for (const l of ls) net += l.direction === "DEBIT" ? l.amountCents : -l.amountCents;
  return net === 0n;
}

/**
 * A settlement observation (PV1-SETTLE D-SET-6; R2-085; D-LEDGER-B5): the provider's release of a withdrawal moves it from the
 * provider's available balance into bank money in transit, the withdrawal's fee is the provider's expense out of the same balance, and
 * only a receiving bank's receipt moves money in transit into bank cash. Gross and held are facts of the observation, never posted here
 * (their own sources post them). A receipt beyond the withdrawal is refused (no bank cash from imaginary liquidity).
 */
export function settlementPostings(withdrawnCents: bigint, feeCents: bigint, receivedCents: bigint): ReadonlyArray<PostingLine> {
  assertMoney(withdrawnCents);
  assertMoney(feeCents);
  assertMoney(receivedCents);
  if (withdrawnCents === 0n) throw new RangeError("a settlement observation releases a withdrawal");
  if (receivedCents > withdrawnCents) throw new RangeError("a receipt cannot exceed the withdrawal it cites");
  return lines(
    line("BANK_IN_TRANSIT", "DEBIT", withdrawnCents),
    line("PSP_AVAILABLE", "CREDIT", withdrawnCents),
    line("PROCESSOR_EXPENSE", "DEBIT", feeCents),
    line("PSP_AVAILABLE", "CREDIT", feeCents),
    line("BANK_CASH", "DEBIT", receivedCents),
    line("BANK_IN_TRANSIT", "CREDIT", receivedCents),
  );
}

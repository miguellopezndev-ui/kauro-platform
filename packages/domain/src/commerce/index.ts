/**
 * The commerce domain of package B09 (payments and fiscal workflow; docs/design/B09-payments-fiscal.md): exact money, the
 * offer arithmetic, fiscal treatment, capture matching and allocation, commercial authority predicates, refund arithmetic and
 * authority, ledger postings, the normalized provider vocabulary, the platform machines, the event vocabulary, the principals
 * beyond agency membership and the records.
 */
export type { CommerceFailureReason } from "./failure-reasons.js";
export { COMMERCE_FAILURE_REASONS } from "./failure-reasons.js";

export type * from "./records.js";
export {
  RECONCILIATION_CASE_KINDS,
  BANK_RAILS,
  BANK_ORDER_STATES,
  BANK_CREDIT_STATES,
  BANK_CREDIT_SOURCES,
  BANK_CREDIT_STATUSES,
  EXECUTION_ATTEMPT_KINDS,
  EXECUTION_ATTEMPT_STATES,
  EXECUTION_ATTEMPT_OPEN_STATES,
  EXECUTION_SOURCE_KINDS,
  DESTINATION_PROOFS,
  EXECUTION_OFFER_COMMANDS,
  EXECUTION_GATE_OUTCOMES,
  DEBIT_CORRELATIONS,
  BANK_CASE_KINDS,
  STATEMENT_LINE_KINDS,
  COVERAGE_STREAMS,
  DESTINATION_NORM_VERSION,
} from "./records.js";

export type { FeeProfile } from "./money.js";
export {
  MONEY_MAX,
  isMoney,
  assertMoney,
  isMoneyText,
  parseMoney,
  formatMoney,
  moneyCount,
  roundHalfUpBps,
  discountCents,
  illustrativeProcessorFee,
  allocateLargestRemainder,
  cumulativeEntitlement,
  entitlementAdjustment,
  sumMoney,
} from "./money.js";

export type { PriceBand, RepeatTier, PricePolicy, DiscountSelection, QuoteAmounts, QuoteTermsPreimage } from "./pricing.js";
export { pricePolicyFrom, registryPricePolicy, baseServiceCents, repeatDiscountBps, selectDiscount, quoteAmounts, quoteExpiresAt, lookbackStartsAt, quoteTermsHash, termsMoney } from "./pricing.js";

export type { FiscalBlocker, FiscalTreatmentDecision, FiscalTreatmentInput } from "./fiscal.js";
export { taxOf, ruleSnapshotOf, sameTaxRule, FISCAL_BLOCKERS, profileInForceAt, saleProfileAt, resolveFiscalTreatment, quotableTaxRule } from "./fiscal.js";

export type { ProviderOutcomeKind, AmbiguityReason, ProviderRequest, ScopeKey, ObservedCapture, ObservedRefund, ObservedDispute, NormalizedProviderEventKind, NormalizedProviderEvent, PaymentIntentPreimage } from "./provider.js";
export type {
  BankEvidenceRef,
  EvidenceRejectionCode,
  EvidenceClassification,
  Operational,
  OperationalCode,
  BankOutcome,
  UsdBankAccountDetails,
  IncomingCredit,
  CreditPage,
  DestinationEvidence,
  OutboundEvidence,
  StatementDebit,
  DebitPage,
  StatementPage,
} from "./provider.js";
export { EVIDENCE_REJECTION_CODES, OPERATIONAL_CODES, OUTBOUND_EVIDENCE_STATUSES, STATEMENT_DEBIT_STATUSES } from "./provider.js";
export { PROVIDER_EXCEPTION_KINDS, providerRequestHash, providerRequestIdOf, providerScopeKey, DISPATCH_DEADLINE_SECONDS, PAYMENT_INTENT_DOMAIN, paymentIntentHash } from "./provider.js";

export type { CaptureMismatch, CaptureMatch, CaptureEdge, CaptureStatusStep } from "./capture.js";
export { CAPTURE_MISMATCHES, matchCapture, captureStatusStep, splitObligation, allocateCapture, authorizesObligation, isFullyPaid } from "./capture.js";

export type { CheckoutBlocker, SubjectFacts, CheckoutFacts, QuoteReleaseFacts, QuoteRelease, ReplacementFacts, ReplacementBlocker } from "./authority.js";
export { CHECKOUT_BLOCKERS, checkoutBlockers, authorizationBlockers, honoredAfterPriceExpiry, blockerFailure, revocationPhaseOf, deliveryPhaseOf, quoteRelease, replacementBlockers } from "./authority.js";

export type { RefundAmountCheck, RefundTaxCheck, RefundEffects, RefundAuthorizationPreimage } from "./refunds.js";
export {
  ZERO_COMPONENTS,
  COMMITTING_REFUND_STATES,
  componentsTotal,
  addComponents,
  refundableBalance,
  proposeRefund,
  approvedComponents,
  checkRefundAmounts,
  taxRemainingAfter,
  refundTaxFor,
  checkRefundTax,
  refundTaxFailure,
  policyCovers,
  REFUND_AUTHORIZATION_DOMAIN,
  REFUND_EFFECTS_DOMAIN,
  refundEffectsHash,
  refundAuthorizationHash,
  authorizationPreimageMoney,
  refundAmountFailure,
} from "./refunds.js";

export type { PostingLine } from "./ledger.js";
export {
  LEDGER_ACCOUNT_VERSION,
  LEDGER_POLICY_VERSION,
  LEDGER_ACCOUNTS,
  PROVIDER_BALANCE_ACCOUNTS,
  BANK_ACCOUNTS,
  MERCHANT_BALANCE_ACCOUNT,
  fundsAccountOf,
  capturePostings,
  providerFeePostings,
  movableBalanceOf,
  refundReturnOf,
  returnedCentsOf,
  fundsPostings,
  returnPostings,
  isBalanced,
} from "./ledger.js";

export type { CommercePlatformMachineName } from "./machines.js";
export { COMMERCE_PLATFORM_MACHINES, BANK_STATE_MACHINES, BANK_ORDER_EXTENSION } from "./machines.js";

export type { CommerceAggregateKind, CommerceEventType, CommerceConsumer, CommerceVersionChange, BankPostingEventType } from "./events.js";
export {
  COMMERCE_AGGREGATE_KINDS,
  COMMERCE_EVENT_TYPES,
  COMMERCE_STATE_EVENT_TYPES,
  COMMERCE_REQUEST_HANDLER_EVENT_TYPES,
  commerceVersionEventType,
  COMMERCE_CONSUMERS,
  COMMERCE_EVENT_PAYLOAD_ALLOWLIST,
  COMMERCE_EVENT_SUBSCRIPTIONS,
  BANK_POSTING_EVENT_TYPES,
  RETURN_POSTING_EVENT_TYPES,
} from "./events.js";

export type { ServiceRole, ServiceIdentity } from "./principals.js";
export { SERVICE_ROLE_TABLE, serviceHoldsRole, CORPORATE_ROLES, isCorporateCommandRole, COMMERCE_POLICY_VERSION } from "./principals.js";

export type { BankCreditRail, BankCreditEventType, BankCreditRecord, StatementImportRecord, MatchKeys, MatchDecision } from "./bank-credit.js";
export {
  BANK_CREDIT_RAILS,
  BANK_CREDIT_AGGREGATE_KINDS,
  BANK_CREDIT_EVENT_TYPES,
  BANK_CREDIT_EVENT_PAYLOAD_ALLOWLIST,
  BANK_CREDIT_EVENT_SUBSCRIPTIONS,
  matchDecision,
  bankOrderStateAfterReceipt,
  creditOnTime,
} from "./bank-credit.js";

export type { BankRouteState, BankRouteRollout, BankRouteEventType, TransferWindow, BankRouteDetails, BankRouteRecord, BankRouteVersionRecord, BankTransferInstructionRecord } from "./bank-route.js";
export {
  BANK_ROUTE_STATES,
  BANK_ROUTE_ROLLOUTS,
  BANK_TRANSFER_ROUTE_KIND,
  BANK_ROUTE_AGGREGATE_KINDS,
  BANK_ROUTE_EVENT_TYPES,
  BANK_ROUTE_EVENT_PAYLOAD_ALLOWLIST,
  BANK_ROUTE_EVENT_SUBSCRIPTIONS,
  TRANSFER_REFERENCE_PATTERN,
  transferReferenceOf,
  isTransferReference,
  transferWindowOf,
} from "./bank-route.js";

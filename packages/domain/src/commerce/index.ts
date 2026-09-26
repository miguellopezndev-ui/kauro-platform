/**
 * The commerce domain of package B09 (payments and fiscal workflow; docs/design/B09-payments-fiscal.md): exact money, the
 * offer arithmetic, fiscal treatment, capture matching and allocation, commercial authority predicates, refund arithmetic and
 * authority, ledger postings, the normalized provider vocabulary, the platform machines, the event vocabulary, the principals
 * beyond agency membership and the records.
 */
export type { CommerceFailureReason } from "./failure-reasons.js";
export { COMMERCE_FAILURE_REASONS } from "./failure-reasons.js";

export type * from "./records.js";

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
export { taxOf, ruleSnapshotOf, sameTaxRule, FISCAL_BLOCKERS, profileInForceAt, resolveFiscalTreatment, quotableTaxRule } from "./fiscal.js";

export type { ProviderOutcomeKind, AmbiguityReason, ProviderRequest, ScopeKey, ObservedCapture, ObservedRefund, ObservedDispute, NormalizedProviderEventKind, NormalizedProviderEvent, PaymentIntentPreimage } from "./provider.js";
export { PROVIDER_EXCEPTION_KINDS, providerRequestHash, providerRequestIdOf, providerScopeKey, PAYMENT_INTENT_DOMAIN, paymentIntentHash } from "./provider.js";

export type { CaptureMismatch, CaptureMatch, CaptureStatusStep } from "./capture.js";
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
export { LEDGER_ACCOUNT_VERSION, LEDGER_POLICY_VERSION, LEDGER_ACCOUNTS, capturePostings, providerFeePostings, fundsPostings, returnPostings, isBalanced } from "./ledger.js";

export type { CommercePlatformMachineName } from "./machines.js";
export { COMMERCE_PLATFORM_MACHINES } from "./machines.js";

export type { CommerceAggregateKind, CommerceEventType, CommerceConsumer } from "./events.js";
export { COMMERCE_AGGREGATE_KINDS, COMMERCE_EVENT_TYPES, COMMERCE_CONSUMERS, COMMERCE_EVENT_PAYLOAD_ALLOWLIST, COMMERCE_EVENT_SUBSCRIPTIONS } from "./events.js";

export type { ServiceRole, ServiceIdentity } from "./principals.js";
export { SERVICE_ROLE_TABLE, serviceHoldsRole, CORPORATE_ROLES, isCorporateCommandRole, COMMERCE_POLICY_VERSION } from "./principals.js";

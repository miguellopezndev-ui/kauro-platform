/**
 * Safe reason codes of the payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §7.2). They narrow
 * the stable failure codes of manual 10 exactly like the B06 reasons do — machine tokens that never carry a customer value —
 * and are appended to the closed FAILURE_REASONS list of model/errors.ts, so the Problem schema and the acceptance harness
 * enumerate them. This module imports nothing: the failure taxonomy depends on it, never the reverse.
 */
export const COMMERCE_FAILURE_REASONS = [
  // principals beyond agency membership (08 "Identity is not permission"; COMMAND_CATALOGUE "Shared execution contract")
  "CORPORATE_ROLE_MISSING",
  "SELF_APPROVAL_FORBIDDEN",
  "SERVICE_NOT_PERMITTED",
  "SERVICE_SCOPE_MISMATCH",
  "POLICY_NOT_APPLICABLE",
  // provider ingress (15 "Webhooks and reconciliation"; 10 "Quote and payment routes")
  "PROVIDER_UNKNOWN",
  "PROVIDER_SIGNATURE_INVALID",
  "PROVIDER_EVENT_STALE",
  "PROVIDER_ENVIRONMENT_MISMATCH",
  "PROVIDER_EVENT_BODY_DIFFERS",
  "PROVIDER_SERVICES_UNAVAILABLE",
  // quotes and checkout readiness (07 "Quote and checkout states"; 16 "Quote calculation")
  "QUOTE_NOT_ACTIVE",
  "QUOTE_EXPIRED",
  "APPROVAL_NOT_CURRENT",
  "REVISION_NOT_AVAILABLE",
  "PAYMENT_ROUTE_UNQUALIFIED",
  "FISCAL_ROUTE_UNQUALIFIED",
  "FISCAL_TREATMENT_UNREVIEWED",
  "FISCAL_PROFILE_NOT_EFFECTIVE",
  "FISCAL_TREATMENT_CHANGED",
  "ORDER_ALREADY_OPEN",
  "ALREADY_PAID",
  // orders, captures and observations (15 "PaymentOrder and intent", "Capture and authority")
  "ORDER_NOT_CAPTURABLE",
  "CAPTURE_IN_PROGRESS",
  "CAPTURE_UNCERTAIN",
  "OBSERVATION_STALE",
  "OBSERVATION_SUBJECT_MISMATCH",
  "UNRECOGNIZED_PROVIDER_STATE",
  // refunds (15 "Refund policy and calculation")
  "NOTHING_TO_REFUND",
  "REFUND_REQUEST_OPEN",
  "REFUND_EXCEEDS_REMAINING",
  "REFUND_NOT_REQUESTED",
  "REFUND_NOT_APPROVED",
  "REFUND_UNCERTAIN",
  "CAPTURE_NOT_REFUNDABLE",
  // integrity (the SQLSTATEs KA009..KA014 of migrations 0008..0011)
  "LEDGER_UNBALANCED",
  "OBLIGATION_OVER_ALLOCATED",
  "FACT_REGRESSION",
  "AUTHORITY_WITHOUT_CAPTURE",
  "AUTHORITY_OUTLIVES_REVERSAL",
] as const;

export type CommerceFailureReason = (typeof COMMERCE_FAILURE_REASONS)[number];

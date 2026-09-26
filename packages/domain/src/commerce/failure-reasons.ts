/**
 * Safe reason codes of the payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §7.2). They narrow
 * the stable failure codes of manual 10 exactly like the B06 reasons do — machine tokens that never carry a customer value —
 * and are appended to the closed FAILURE_REASONS list of model/errors.ts, so the Problem schema, the outcome catalogues and the
 * acceptance harness enumerate them. This module imports nothing: the failure taxonomy depends on it, never the reverse.
 */
export const COMMERCE_FAILURE_REASONS = [
  // principals beyond agency membership (08 "Identity is not permission"; COMMAND_CATALOGUE "Shared execution contract")
  "CORPORATE_ROLE_MISSING",
  "SELF_APPROVAL_FORBIDDEN",
  "SERVICE_NOT_PERMITTED",
  "SERVICE_ENVIRONMENT_MISMATCH",
  "POLICY_NOT_APPLICABLE",
  // provider ingress and evidence (15 "Webhooks and reconciliation"; 10 "Quote and payment routes", "Provider adapter contract")
  "PROVIDER_UNKNOWN",
  "PROVIDER_SIGNATURE_INVALID",
  "PROVIDER_EVENT_STALE",
  "PROVIDER_ENVIRONMENT_MISMATCH",
  "PROVIDER_BODY_TOO_LARGE",
  "EVIDENCE_NOT_FOUND",
  "PROVIDER_SERVICES_UNAVAILABLE",
  // quotes and checkout readiness (07 "Quote and checkout states"; 16 "Quote calculation"; CMD028 precondition)
  "QUOTE_NOT_ACTIVE",
  "QUOTE_EXPIRED",
  "APPROVAL_NOT_CURRENT",
  "PAYMENT_ROUTE_UNQUALIFIED",
  "FISCAL_ROUTE_UNQUALIFIED",
  "FISCAL_TREATMENT_UNREVIEWED",
  "FISCAL_PROFILE_NOT_EFFECTIVE",
  "FISCAL_TREATMENT_CHANGED",
  "ALREADY_PAID",
  // deliverable capacity (15 "PaymentOrder and intent"; 07 "Job and attempt states"; D-CAP-B1): the processing package's admission
  "DELIVERY_CAPACITY_UNAVAILABLE",
  // the included pre-execution source replacement (16 "Scope changes and credits"; D-QUOTE-B6; SQLSTATE KP013)
  "REPLACEMENT_NOT_ALLOWED",
  // orders, attempts, captures and observations (15 "PaymentOrder and intent", "Capture and authority", "Payment state transitions")
  "CREATION_IN_PROGRESS",
  "CAPTURE_IN_PROGRESS",
  "CAPTURE_UNCERTAIN",
  "ORDER_NOT_CAPTURABLE",
  "PROVIDER_REFERENCE_MISMATCH",
  "OBSERVATION_STALE",
  "OBSERVATION_SUBJECT_MISMATCH",
  "UNRECOGNIZED_PROVIDER_STATE",
  // refunds (15 "Refund policy and calculation"; CMD031..CMD033)
  "NOTHING_TO_REFUND",
  "REFUND_REQUEST_OPEN",
  "REFUND_EXCEEDS_REMAINING",
  "REFUND_COMPONENT_INVALID",
  // the tax of a partial refund follows its service under the sale's rule (15 "Exact representation and rounding"; D-REF-B6; KP012)
  "REFUND_TAX_INCONSISTENT",
  "REFUND_NOT_REQUESTED",
  "REFUND_NOT_APPROVED",
  "REFUND_IN_PROGRESS",
  "REFUND_UNCERTAIN",
  "CAPTURE_NOT_REFUNDABLE",
  // integrity (the SQLSTATEs KP001..KP013 of migrations 0009..0013; a handler that respects the schema never meets them)
  "LEDGER_UNBALANCED",
  "OBLIGATION_OVER_ALLOCATED",
  "FACT_REGRESSION",
  "AUTHORITY_WITHOUT_CAPTURE",
  "AUTHORITY_OUTLIVES_REVERSAL",
  "FINANCE_SCOPE_MISSING",
  "COMMITMENT_ISOLATION",
  "FISCAL_VALIDATION_REFUSED",
] as const;

export type CommerceFailureReason = (typeof COMMERCE_FAILURE_REASONS)[number];

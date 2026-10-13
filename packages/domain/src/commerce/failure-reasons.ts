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
  // integrity (the SQLSTATEs KP001..KP013 of migrations 0013..0017; a handler that respects the schema never meets them)
  "LEDGER_UNBALANCED",
  "OBLIGATION_OVER_ALLOCATED",
  "FACT_REGRESSION",
  "AUTHORITY_WITHOUT_CAPTURE",
  "AUTHORITY_OUTLIVES_REVERSAL",
  "FINANCE_SCOPE_MISSING",
  "COMMITMENT_ISOLATION",
  "FISCAL_VALIDATION_REFUSED",
  // Payments V1 bank-transfer route (docs/design/ACH-ROUTE.md r12; lane KIT). Safe machine tokens only; the lane that raises one owns its guard.
  // the window the route version freezes (DV1-07) and the manual rail's refusal of the automated refund executor (DV1-08, FC-RAIL)
  "TRANSFER_WINDOW_TOO_SHORT",
  "MANUAL_RAIL_NO_AUTOMATED_OUTBOUND",
  // outbound execution attempts and NEVER-RESEND (DV1-08)
  "EXECUTION_ATTEMPT_OPEN",
  "EXECUTION_FROZEN",
  "NO_DECLARED_ATTEMPT",
  "EXECUTION_PRECEDES_DECLARATION",
  "NO_RECORDED_BOUNCE",
  "RESEND_EXCEEDS_PAYABLE",
  "REFUND_NOT_UNCERTAIN",
  "NOT_EXECUTED_TOO_EARLY",
  "COVERAGE_INCOMPLETE",
  "UNEXPLAINED_DEBIT",
  "POTENTIAL_MATCH_UNRESOLVED",
  "CONTRADICTORY_EVIDENCE",
  // the record predicates of a declared execution (E-ID, E-AMT, E-TIME, E-REF-CONFLICT)
  "EXECUTION_ID_INVALID",
  "EXECUTION_AMOUNT_MISMATCH",
  "EXECUTION_REFERENCE_CONFLICT",
  // destination proof (DV1-10, DV1-11)
  "DESTINATION_NOT_CAPTURED",
  "DESTINATION_INVALID",
  "DESTINATION_UNPROVEN",
  "DESTINATION_CONFLICT",
  "RECIPIENT_ALIAS",
  // the evidence gate outcomes of stored bank evidence (ACH-ROUTE §6): a rejection grants nothing (HASH_MISMATCH is the existing B06 reason)
  "UNKNOWN_EVIDENCE",
  "MALFORMED_EVIDENCE",
  "UNAUTHENTICATED_EVIDENCE",
  "EVIDENCE_UNAVAILABLE",
  // the route configuration and instruction issuance of the bank-transfer route (lane L-ROUTE; ACH-ROUTE §7.1-§7.3, §7.29)
  "ROUTE_VERSION_CHANGED",
  "OPEN_ORDER_EXISTS",
  "ROUTE_NOT_ENABLED",
  "ROUTE_NOT_VERIFIED",
  "DETAILS_EXPIRED",
  "DETAILS_ACCOUNT_MISMATCH",
  "GENERAL_ENABLE_CONDITION_UNMET",
  "INSTRUCTIONS_EXPIRED",
  // I3: an existing visible order whose instructions are not readable (bank order not open, details expired; coordinator ruling RR-2)
  "INSTRUCTIONS_NOT_AVAILABLE",
  // an idempotency key of a bank owner command reused with another request body (lane L-REFUND; the journal conflict named, never a new effect)
  "BODY_CONFLICT",
  // a manual-rail refund or treasury refund COMPLETED without the RECORDED attempt that is its execution evidence (lane L-REFUND; SQLSTATE KP014)
  "EXECUTION_EVIDENCE_MISSING",
] as const;

export type CommerceFailureReason = (typeof COMMERCE_FAILURE_REASONS)[number];

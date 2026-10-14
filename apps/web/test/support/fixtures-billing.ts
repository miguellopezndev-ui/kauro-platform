// Fixtures of the billing and settings screens' tests (S5): the api's own DTOs built to the generated types; the test validates each one
// against the generated schemas so a fixture that drifts from the contract proves nothing.
import type { AgencyClosureView, AgencyView, CaptureView, PaymentOrderDetailView, RefundView, SupportCaseView, TaxDocumentView } from "../../src/api/generated.ts";
import { AGENCY, order, PROJECT } from "./fixtures.ts";

export const CAPTURE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6001";
export const DOCUMENT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6002";
export const REFUND = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6003";
export const CASE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6004";
export const CLOSURE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6005";
export const PROOF = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7001";

export function agency(overrides: Partial<AgencyView> = {}): AgencyView {
  return {
    agencyId: AGENCY,
    version: 4,
    displayName: "Acme Growth Partners",
    state: "ACTIVE",
    termsVersion: "2026-10-01",
    privacyAgreementVersion: "2026-10-01",
    createdAt: "2026-10-01T12:00:00Z",
    permittedActions: ["VIEW", "MANAGE_BILLING", "REQUEST_DELETION"],
    ...overrides,
  };
}

export function capture(overrides: Partial<CaptureView> = {}): CaptureView {
  return {
    captureId: CAPTURE,
    orderId: order().orderId,
    environment: "SANDBOX",
    amountCents: "150000",
    currency: "USD",
    status: "COMPLETED",
    observedAt: "2026-10-13T13:00:00Z",
    allocated: { serviceCents: "140000", taxCents: "10000", excessCents: "0" },
    version: 1,
    ...overrides,
  };
}

export function taxDocument(overrides: Partial<TaxDocumentView> = {}): TaxDocumentView {
  return {
    documentId: DOCUMENT,
    paymentOrderId: order().orderId,
    kind: "INVOICE",
    state: "ISSUED",
    legalNumber: "SETT-000123",
    serviceCents: "140000",
    taxCents: "10000",
    version: 1,
    taxTreatment: "DOMESTIC_TAXABLE",
    issuedAt: "2026-10-13T14:00:00Z",
    ...overrides,
  };
}

export function orderDetail(overrides: Partial<PaymentOrderDetailView> = {}): PaymentOrderDetailView {
  return { order: order({ state: "CAPTURED", paymentStatus: "CONFIRMED" }), captures: [capture()], taxDocuments: [taxDocument()], ...overrides };
}

export function refund(overrides: Partial<RefundView> = {}): RefundView {
  return {
    refundId: REFUND,
    captureId: CAPTURE,
    serviceCents: "140000",
    taxCents: "10000",
    reasonCode: "Delivered file does not match the plan",
    state: "REQUESTED",
    amountsBasis: "PROPOSED",
    version: 1,
    projectId: PROJECT,
    orderId: order().orderId,
    origin: "CUSTOMER_REQUEST",
    deliveryPhase: "POST_DELIVERY",
    excessCents: "0",
    reviewRequired: true,
    requestedAt: "2026-10-14T09:00:00Z",
    ...overrides,
  };
}

export function supportCase(overrides: Partial<SupportCaseView> = {}): SupportCaseView {
  return {
    caseId: CASE,
    agencyId: AGENCY,
    projectId: PROJECT,
    category: "BILLING",
    severity: "S3",
    state: "OPEN",
    summary: "Refund requested for the order: the delivered file does not match the plan.",
    evidenceRefs: [],
    nextReviewAt: "2026-10-15T09:00:00Z",
    createdByMembershipId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6006",
    createdAt: "2026-10-14T09:00:00Z",
    version: 1,
    ...overrides,
  };
}

export function closure(overrides: Partial<AgencyClosureView> = {}): AgencyClosureView {
  return {
    agency: agency({ state: "CLOSING", version: 5, permittedActions: ["VIEW"] }),
    closureId: CLOSURE,
    requestedAt: "2026-10-14T10:00:00Z",
    obligations: { openQuotesWithdrawn: 2, liveAuthorizations: 1, openRefunds: 0, nonTerminalTaxDocuments: 1, openReconciliationCases: 0, activeWorkItems: 3, openReconciliationCents: "2500" },
    deletionScheduledFor: "2026-11-13T10:00:00Z",
    ...overrides,
  };
}

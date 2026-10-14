// Fixtures of the processing and support screens (UI25, UI52): a job, a commercial authorization, a payment order detail and a support case,
// each valid against the generated schema (the tests validate them). The instants are literals: nothing here reads the clock.
import type { CommercialAuthorizationView, JobView, PaymentOrderDetailView, SupportCaseView } from "../../src/api/generated.ts";
import { AGENCY, HASH, order, PROJECT } from "./fixtures.ts";

export { AGENCY, PROJECT };
export const JOB = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb1";
export const AUTHORIZATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
export const CASE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb3";
export const CASE_TWO = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb4";
export const MEMBERSHIP = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb5";
export const PLAN_HASH = HASH;
export const REVISION_HASH = "b".repeat(64);
export const QUEUED_AT = "2026-10-13T12:00:00Z";
/** 80 minutes after QUEUED_AT, as epoch milliseconds (a literal, not a clock read). */
export const NOW_80_MIN = Date.parse("2026-10-13T13:20:00Z");
export const SECRET_TEXT = "AKIA-NEVER-SHOW-THIS-CASE-TEXT-0001";

export function job(overrides: Partial<JobView> = {}): JobView {
  return {
    jobId: JOB,
    projectId: PROJECT,
    authorizationId: AUTHORIZATION,
    state: "RUNNING",
    attempt: 1,
    version: 3,
    queuedAt: QUEUED_AT,
    deliveryDeadlineAt: "2026-10-15T12:00:00Z",
    cancelVersion: 4,
    permittedActions: ["CancelJob"],
    ...overrides,
  };
}

export function authorization(overrides: Partial<CommercialAuthorizationView> = {}): CommercialAuthorizationView {
  return {
    authorizationId: AUTHORIZATION,
    agencyId: AGENCY,
    projectId: PROJECT,
    approvalHash: HASH,
    quoteId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa3",
    captureId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb6",
    revisionHash: REVISION_HASH,
    planHash: PLAN_HASH,
    capabilityVersion: "CAP_V1",
    createdAt: QUEUED_AT,
    version: 2,
    state: "ACTIVE",
    mode: "CLEAN",
    billableUnits: 100,
    honoredAfterPriceExpiry: false,
    ...overrides,
  };
}

export function orderDetail(auth: CommercialAuthorizationView | undefined = authorization()): PaymentOrderDetailView {
  return { order: order({ state: "CAPTURED", paymentStatus: "CONFIRMED" }), captures: [], ...(auth === undefined ? {} : { commercialAuthorization: auth }), taxDocuments: [] };
}

export function supportCase(overrides: Partial<SupportCaseView> = {}): SupportCaseView {
  return {
    caseId: CASE,
    agencyId: AGENCY,
    projectId: PROJECT,
    category: "IMPORT_GUIDANCE",
    severity: "S3",
    state: "OPEN",
    summary: "How do I import the cleaned companies file into my CRM sandbox?",
    evidenceRefs: [],
    nextReviewAt: "2026-10-14T15:00:00Z",
    createdByMembershipId: MEMBERSHIP,
    createdAt: "2026-10-13T12:00:00Z",
    version: 1,
    ...overrides,
  };
}

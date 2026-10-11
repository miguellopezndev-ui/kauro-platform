// Fixtures of the stage-2 screens' tests: the api's own DTOs, built to the generated types and checked against the generated schemas by the
// api client when a test serves them (a fixture that drifts from the contract fails as an INTEGRITY answer, never silently).
import type { AuditView, PaymentOrderView, Problem, QuoteView } from "../../src/api/generated.ts";
import type { FetchedResponse, FetchInit, FetchLike } from "../../src/client/api-client.ts";
import { ApiClient } from "../../src/client/api-client.ts";

export const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
export const PROJECT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa2";
export const QUOTE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa3";
export const ORDER = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa4";
export const AUDIT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa5";
export const REVISION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa6";
export const TARGET = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa7";
export const GRANT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa8";
export const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99";
export const HASH = "a".repeat(64);

export function quote(overrides: Partial<QuoteView> = {}): QuoteView {
  return {
    quoteId: QUOTE,
    agencyId: AGENCY,
    projectId: PROJECT,
    revisionHash: HASH,
    planHash: "b".repeat(64),
    billableUnits: 1200,
    mode: "HUBSPOT",
    pricePolicyVersion: "PRICE_V1",
    discountPolicyVersion: "DISCOUNT_V1",
    baseServiceCents: "150000",
    discountCents: "0",
    serviceCents: "150000",
    taxCents: "0",
    totalCents: "150000",
    currency: "USD",
    expiresAt: "2026-10-20T12:00:00Z",
    sourceAvailableUntil: "2026-10-27T12:00:00Z",
    termsHash: "c".repeat(64),
    version: 3,
    state: "ISSUED",
    discount: { bps: 0, basis: "NONE" },
    taxTreatment: "EXEMPT_EXPORT",
    issuedAt: "2026-10-13T12:00:00Z",
    checkoutReady: true,
    checkoutBlockers: [],
    permittedActions: ["CMD028"],
    ...overrides,
  };
}

export function order(overrides: Partial<PaymentOrderView> = {}): PaymentOrderView {
  return {
    orderId: ORDER,
    quoteId: QUOTE,
    provider: "bank-transfer",
    environment: "SANDBOX",
    expectedAmountCents: "150000",
    currency: "USD",
    state: "CREATED",
    version: 1,
    projectId: PROJECT,
    paymentStatus: "NOT_STARTED",
    nextActions: [],
    createdAt: "2026-10-13T12:00:00Z",
    updatedAt: "2026-10-13T12:00:00Z",
    ...overrides,
  };
}

export function audit(overrides: Partial<AuditView> = {}): AuditView {
  return {
    auditId: AUDIT,
    revisionId: REVISION,
    targetContractId: TARGET,
    state: "PROFILING",
    version: 2,
    startedAt: "2026-10-13T12:00:00Z",
    absoluteDeadline: "2026-10-13T14:00:00Z",
    grantId: GRANT,
    grantClass: "FREE_AUDIT",
    grantState: "AUTHORIZED",
    cancelVersion: 2,
    permittedActions: ["CancelAudit"],
    ...overrides,
  };
}

export function problem(status: number, code: Problem["code"], extra: Partial<Problem> = {}): Problem {
  return { type: `urn:kauro:problem:${code}`, title: "x", status, code, correlationId: CORRELATION, retryable: false, nextActions: [], ...extra };
}

export interface Sent {
  readonly url: string;
  readonly init: FetchInit;
}

export function respond(status: number, body: unknown, contentType = status >= 400 ? "application/problem+json" : "application/json"): FetchedResponse {
  const headers = new Map<string, string>([["content-type", contentType], ["x-correlation-id", CORRELATION]]);
  return { status, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, text: async () => JSON.stringify(body) };
}

/** An api client over a scripted fetch; every request it sends is kept. */
export function harness(answer: (sent: Sent, index: number) => FetchedResponse | Promise<FetchedResponse>) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const entry = { url, init };
    sent.push(entry);
    return answer(entry, sent.length - 1);
  };
  const client = new ApiClient({ fetch, newCorrelationId: () => CORRELATION, context: { csrfToken: () => "csrf-token-value-000", activeAgency: () => AGENCY } });
  return { client, sent };
}

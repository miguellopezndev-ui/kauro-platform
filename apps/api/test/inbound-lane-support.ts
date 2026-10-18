// Lane L-INBOUND (PAYMENTS-V1, tier 1 MONEY): the test driver of the V1 inbound rows of docs/design/ACH-ROUTE.md r12 (§7.5 C5, §7.6 C4/C6,
// §7.9 M1/M2, §7.10 P1, §7.11 P2, §7.12 E1, §7.23 SI1/SI2, §7.24 P1Δ, §7.27 FC-V/FC-API, §7.28 SI2-UNDECLARED) and of cases ACH-04..11, 13,
// 20..22. It fixes, for the lane's builder, the HTTP contract the cells call, the fixtures and one footprint oracle; no business logic. Every
// command runs through the REAL api of the integration world, optionally over a harness connection (`routed`) so a cell can hold it at a
// lock or at its COMMIT, lose its answer, or fail it after a statement (SqlStep).
//
// CONTRACT (the builder serves exactly this; units of the owner commands run as `kauro_app`, of the service steps as `kauro_payment`):
//   owner (KAURO_OWNER, step-up)
//     C5  POST /api/v1/operations/bank-accounts/{accountRef}/credits             { bankTransactionId, rail, grossCents, currency, reference,
//                                                                                  bookedAt, evidence{artifactRef,evidenceHash}, authorizationRef }
//                                                                                -> 201 { credit } DRAFT_MANUAL
//     C4+C6 POST /api/v1/operations/bank-credits/{creditId}/confirmations        { expectedVersion, authorizationRef } -> 200 { credit } OBSERVED
//     M2  POST /api/v1/operations/bank-credits/{creditId}/attributions          { expectedVersion, orderId, billingEvidenceRef, reasonCode,
//                                                                                  authorizationRef } -> 200 { credit } MATCHED
//     SI2 POST /api/v1/operations/bank-accounts/{accountRef}/statement-imports   { artifactRef, evidenceHash, authorizationRef } -> 201 { import }
//         (the refund lane calls the same route: refund-lane-support.ts bankRefundRoutes.importStatement)
//     GET  /api/v1/operations/bank-credits/{creditId}                            -> 200 { credit }
//     GET  /api/v1/operations/bank-orders/{orderId}/match-keys                   -> 200 { keys } (what M1 compares; the owner's review view)
//   service (PAYMENT_SERVICE consumer, registerBankDeliveryHandler)
//     `bank_credit.received.v1` (published by Kconfirm)  -> M1 lookup + Kmatch: MATCHED (publishes `bank_credit.matched.v1`) or MATCH_REVIEW
//     `bank_credit.matched.v1` (Kmatch or M2 attribution) -> P1 Kapply
//   sweep TRANSFER_EXPIRY (registerBankSweep)            -> E1 Kexpiry
//   FINANCE                                              -> P2 Kbook (core/bank-postings.ts planBankCreditPostings)
//   tables (migration I): kauro.bank_credits (bank_credit_id, environment, account_ref, bank_transaction_id, state, version, gross_cents,
//     net_cents, fee_cents, currency, rail, reference, booked_at, evidence_hash, order_id, capture_id; UNIQUE (environment, account_ref,
//     bank_transaction_id)); the order's bank state is L-ROUTE's kauro.bank_transfer_instructions.order_state.
//   locks: C5, C6 and the owner attribution take the account's INBOUND stream lock first (KIT `holdInboundStream`), then the credit identity
//     lock Lc; SI2 takes L1 (KIT `holdOutboundStream`), then INBOUND, then Lc (ACH-ROUTE §7.28).
//
// NEW closed reasons the builder appends to COMMERCE_FAILURE_REASONS (domain failure-reasons.ts) with the FailureCode shown:
//   CREDIT_ALREADY_ENTERED          409 PRECONDITION_FAILED  another draft or credit of the account carries that bank transaction id
//   CREDIT_EVIDENCE_MISMATCH        422 INTEGRITY_FAILURE    the stored artifact disagrees with the draft (amount, currency, rail, reference, bookedAt)
//   COVERAGE_END_IN_FUTURE          409 PRECONDITION_FAILED  a statement's coverage end is after the effect instant (SI2)
//   COVERAGE_OUTSIDE_ROUTE_VERSION  409 PRECONDITION_FAILED  a statement's coverage starts before the account's first route version (SI2)
//   STATEMENT_ALREADY_IMPORTED      409 PRECONDITION_FAILED  the same artifact under another key (SI2)
//   PROVIDER_INCONSISTENCY          409 PRECONDITION_FAILED  a line already recorded with other immutable money fields (SI2, C6)
//   ATTRIBUTION_NOT_OVERRIDABLE     409 PRECONDITION_FAILED  route/payee/environment/currency mismatch an owner may not attribute (M2)
// Existing reasons reused: HASH_MISMATCH, UNKNOWN_EVIDENCE, MALFORMED_EVIDENCE, UNAUTHENTICATED_EVIDENCE (422 INTEGRITY_FAILURE),
// EVIDENCE_UNAVAILABLE (503 CAPACITY_UNAVAILABLE), STEP_UP_STALE (403 ASSURANCE_REQUIRED), CORPORATE_ROLE_MISSING / IDENTITY_DISABLED
// (403 NOT_AUTHORIZED), REQUEST_DIGEST_DIFFERS (409 IDEMPOTENCY_CONFLICT), ORDER_NOT_CAPTURABLE (409 PRECONDITION_FAILED).
import assert from "node:assert/strict";
import { BANK_FAKE_FORMAT, BANK_FAKE_PROVIDER, fakeCreditBytes, fakeStatementBytes, type FakeCreditFields, type FakeDebitFields } from "@kauro/application/testing";
import type { CreateQuoteView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { connectionPid, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { financeConsumer, paymentServiceEffect, unitOfWorkEffect } from "../src/payments/consumers.js";
import { BANK_PAYEE_DIGEST, bankWorld, type BankWorld, type HeldLock, type StoredBankArtifact } from "./bank-support.js";
import { deliveryOf } from "./commission-support.js";
import type { RouteRole, SqlStep, UnitLog } from "./fault-support.js";
import { agentOf, integrationWorld, planOf, quoted, type Agent, type IntegrationWorld } from "./integration-support.js";
import { dispatch } from "./payment-support.js";
import { call, freshKey, outcome, type Person, type Reply } from "./support.js";

/** The owner commands (C5, C6, M2, SI2, the owner reads) and CMD214's record run as kauro_app (D-ACH-16, D-INB-CTX-1/2). */
export const OWNER_ROLE = "kauro_app" as const;
export const OWNER_LOGIN = "kauro_app_test" as const;
/** The payment service's steps (M1, P1, E1 and CMD214's consumption, FINANCE) run as kauro_payment. */
export const ROLE = "kauro_payment" as const;
export const LOGIN = "kauro_payment_test" as const;

// --- contract -----------------------------------------------------------------------------------------------------------------------

const OPS = "/api/v1/operations";
export const inboundRoutes = {
  enterCredit: (accountRef: string) => `${OPS}/bank-accounts/${accountRef}/credits`,
  confirmCredit: (creditId: string) => `${OPS}/bank-credits/${creditId}/confirmations`,
  attributeCredit: (creditId: string) => `${OPS}/bank-credits/${creditId}/attributions`,
  credit: (creditId: string) => `${OPS}/bank-credits/${creditId}`,
  importStatement: (accountRef: string) => `${OPS}/bank-accounts/${accountRef}/statement-imports`,
  matchKeys: (orderId: string) => `${OPS}/bank-orders/${orderId}/match-keys`,
  /** The LATER payer-authorization command: NOT served in V1 (FC-V). */
  payerAuthorizations: (agencyId: string) => `${OPS}/agencies/${agencyId}/payer-authorizations`,
} as const;
/** L-ROUTE's contract (apps/api/test/ach-route-cells.test.ts), used only to stand up an ENABLED route and an AWAITING_TRANSFER order. */
const routeRoutes = {
  configure: () => `${OPS}/bank-routes`,
  verify: (id: string) => `${OPS}/bank-routes/${id}/verify`,
  enable: (id: string) => `${OPS}/bank-routes/${id}/enable`,
  disable: (id: string) => `${OPS}/bank-routes/${id}/disable`,
  order: (quoteId: string) => `/api/v1/quotes/${quoteId}/payment-orders`,
};

export type CreditState = "DRAFT_MANUAL" | "OBSERVED" | "MATCH_REVIEW" | "MATCHED" | "APPLIED" | "RETURN_REVIEW";
export interface CreditView {
  readonly creditId: string;
  readonly accountRef: string;
  readonly bankTransactionId: string;
  readonly state: CreditState;
  readonly version: number;
  readonly source: "OWNER_MANUAL";
  readonly rail: string;
  readonly grossCents: string;
  readonly feeCents: string | null;
  readonly currency: string;
  readonly reference: string | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
}
export interface ImportView {
  readonly importId: string;
  readonly coverage: ReadonlyArray<{ readonly stream: "INBOUND" | "OUTBOUND"; readonly from: string; readonly to: string }>;
  readonly lines: number;
  readonly newLines: number;
  readonly orphans: number;
  readonly balanced: boolean;
}
export interface MatchKeys {
  readonly orderId: string;
  readonly reference: string;
  readonly expectedAmountCents: string;
  readonly currency: "USD";
  /** The order's accepted legal billing identity as M1 compares it (D-ACH-08 rule 3; FC-V). */
  readonly acceptedPayerDigest: string;
  readonly transferExpiresAt: string;
  readonly providerTimeToleranceMs: number;
  readonly accountRef: string;
}

// --- KIT seams this lane needs and a6e64be lacks (exact change) ---------------------------------------------------------------------

export class SeamMissing extends Error {
  constructor(seam: string, change: string) {
    super(`SEAM ${seam} missing on KIT: ${change}`);
    this.name = "SeamMissing";
  }
}
export const SEAMS = {
  S3: "integrationWorld({ bankEvidence }) wiring bankWorld's CONTRACT_FAKE store/port into ApiAssembly.commercial and the payment runtime, so the routes and the PAYMENT_SERVICE read the bytes the cells store (shared with L-REFUND S3)",
  IN1: "commissionWorld({ bankEvidence }) — the same wiring for the commission world, so b10-commission-service.test.ts can pay a purchase by bank transfer (rail parity)",
} as const;

// --- the lane world -----------------------------------------------------------------------------------------------------------------

export interface Lane {
  readonly iw: IntegrationWorld;
  readonly bw: BankWorld;
  readonly owner: Person;
}
let bound: Lane | undefined;
export const L = (): Lane => {
  if (bound === undefined) throw new Error("the inbound lane world is not started (startLane in before())");
  return bound;
};
export async function startLane(): Promise<Lane> {
  const iw = await integrationWorld();
  const bw = await bankWorld({ world: iw });
  // the product's registered holds (BANK_HOLD_POINTS) pass the routed invocation's fault points
  iw.w.bank.hold = (point) => iw.faults.passPoint(point);
  bound = { iw, bw, owner: iw.owner };
  return bound;
}
export async function stopLane(): Promise<void> {
  if (bound === undefined) return;
  await bound.bw.stop();
  await bound.iw.stop();
  bound = undefined;
}

let seq = 0;
export const safe = (label: string): string => label.replace(/[^A-Za-z0-9-]+/g, "-").slice(-40);
export const plusMs = (instant: string, ms: number): string => new Date(Date.parse(instant) + ms).toISOString();
export const code = (r: Reply): string => (r.status < 400 ? `${r.status} (not refused)` : outcome(L().iw.w, r));
export function dataOf<T>(r: Reply, status: 200 | 201, what: string): T {
  assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${r.text}`);
  return r.json<{ data: T }>().data;
}
export async function q<T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  return (await L().iw.h.oracle.query<T>(sql, [...params])).rows;
}
export const count = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) x`, params))[0]!.n);

// --- owner calls --------------------------------------------------------------------------------------------------------------------

export interface OwnerCall {
  readonly owner?: Person;
  readonly stepUp?: "FRESH" | "STALE";
  readonly proof?: string;
  readonly key?: string;
  readonly agency?: string | null;
}
/**
 * The owner's step-up proof for a call. Under a cell's step clock (onClock) the command judges the proof's freshness at its repositioned
 * effect instant, so the proof is issued on that controlled clock (one second before it, a STALE one twenty minutes before), read from a
 * transaction the clock positions; otherwise on the database clock now (World.stepUp).
 */
async function proofFor(owner: Person, freshness: "FRESH" | "STALE"): Promise<string> {
  const { iw } = L();
  const clock = iw.faults.clock;
  // only a routed invocation repositions the owner command on the step clock; an unrouted one judges at the database clock now
  if (clock === null || !iw.faults.routed) return iw.w.stepUp(owner, freshness);
  const c = await openPay();
  let at: string;
  try {
    await c.query("BEGIN");
    await clock.onServer(c);
    at = (await c.query<{ at: string }>(`SELECT to_char(kauro.server_now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).rows[0]!.at;
    await c.query("ROLLBACK");
  } finally {
    await c.end();
  }
  const issuedMs = Date.parse(at) - 1000 - (freshness === "FRESH" ? 0 : 20 * 60_000);
  return iw.h.recordStepUp(owner.userId as UserId, { issuedAt: new Date(issuedMs).toISOString() as never });
}
/** One owner command call with its step-up (a lane outside L-INBOUND drives its own owner route with it: PV1-SETTLE CMD215). */
export async function ownerCall(url: string, body: Record<string, unknown>, o: OwnerCall, label: string): Promise<Reply> {
  const { iw } = L();
  const owner = o.owner ?? L().owner;
  return call(iw.w, { url, token: owner.token, agency: o.agency ?? null, key: o.key ?? freshKey(label), body: { ...body, authorizationRef: o.proof ?? (await proofFor(owner, o.stepUp ?? "FRESH")) } });
}
export const ownerGet = (url: string, owner: Person = L().owner): Promise<Reply> => call(L().iw.w, { method: "GET", url, token: owner.token, agency: null, key: null, contentType: null });

/** A fresh corporate owner with its own revocable KAURO_OWNER grant. */
export async function ownOwner(label: string): Promise<{ readonly person: Person; readonly grantId: string }> {
  const { iw } = L();
  const person = await iw.w.person(`${safe(label)}-owner`);
  const grantId = await iw.h.grantKauroOwner(person.userId as UserId);
  return { person, grantId };
}

// --- routes and orders (L-ROUTE dependency) -----------------------------------------------------------------------------------------

export interface RouteCfg {
  readonly windowMs?: number;
  readonly lifetimeMs?: number;
  readonly toleranceMs?: number;
}
export interface Route {
  readonly routeId: string;
  readonly accountRef: string;
  readonly toleranceMs: number;
}
const DAY = 86_400_000;

/** An ENABLED CONTROLLED route on a fresh account for the participants (L-ROUTE's configure, verify, enable). */
export async function routeFor(label: string, participants: ReadonlyArray<string>, cfg: RouteCfg = {}): Promise<Route> {
  const { iw, bw } = L();
  const accountRef = `acct-in-${safe(label).slice(-24)}-${++seq}`;
  const details = { accountRef, detailsVersion: `details-${seq}`, currency: "USD", acceptedRails: ["ACH", "DOMESTIC_WIRE"], beneficiaryName: "Kauro Test Beneficiary", bankName: "Contract Fake Bank", routingNumber: "026073150", accountNumber: "000000000000", accountType: "CHECKING", payeeDigest: BANK_PAYEE_DIGEST, additionalFields: {}, validUntil: new Date(Date.now() + 60 * DAY).toISOString() };
  const d = await bw.evidence.put({ bytes: new TextEncoder().encode(JSON.stringify({ format: BANK_FAKE_FORMAT, kind: "ACCOUNT_DETAILS", accountRef, details })), accountRef: accountRef as never });
  const toleranceMs = cfg.toleranceMs ?? DAY;
  const owner = (url: string, body: Record<string, unknown>) => ownerCall(url, body, {}, "route");
  const configured = await call(iw.w, { url: routeRoutes.configure(), token: L().owner.token, agency: null, key: freshKey("route"), body: { provider: BANK_FAKE_PROVIDER, environment: bw.environment, accountRef, currency: "USD", acceptedRails: ["ACH", "DOMESTIC_WIRE"], detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.sha256, minimumTransferWindowMs: cfg.windowMs ?? 4 * DAY, instructionLifetimeMs: cfg.lifetimeMs ?? 10 * DAY, providerTimeToleranceMs: toleranceMs, feePolicyVersion: "bank-fee-v1", timingSource: { url: "https://wise.com/help/articles/2827506", accessedOn: "2026-10-07" } } });
  assert.equal(configured.status, 201, `L-ROUTE dependency: configure a bank route (POST ${routeRoutes.configure()}): ${configured.status} ${configured.text}`);
  const r = configured.json<{ data: { route: { routeId: string; routeVersion: number } } }>().data.route;
  const v = await owner(routeRoutes.verify(r.routeId), { expectedVersion: r.routeVersion, verificationEvidenceRef: `kyc-review-${r.routeId}` });
  assert.equal(v.status, 200, `L-ROUTE dependency: verify: ${v.text}`);
  const e = await owner(routeRoutes.enable(r.routeId), { expectedVersion: v.json<{ data: { route: { routeVersion: number } } }>().data.route.routeVersion, rollout: "CONTROLLED", participants });
  assert.equal(e.status, 200, `L-ROUTE dependency: enable: ${e.text}`);
  void iw;
  return { routeId: r.routeId, accountRef, toleranceMs };
}
export async function disableRoute(route: Route): Promise<void> {
  const [row] = await q<{ v: string }>("SELECT current_version::text AS v FROM kauro.bank_routes WHERE route_id = $1", [route.routeId]);
  const r = await ownerCall(routeRoutes.disable(route.routeId), { expectedVersion: Number(row!.v) }, {}, "disable");
  assert.equal(r.status, 200, `L-ROUTE dependency: disable: ${r.text}`);
}

export interface Order {
  readonly a: Agent;
  readonly quote: CreateQuoteView;
  readonly planId: string;
  readonly projectId: string;
  readonly route: Route;
  readonly orderId: string;
  readonly amountCents: bigint;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly reference: string;
  readonly transferExpiresAt: string;
  readonly payerDigest: string;
}
/** A buyer agency with an approved plan, a quote and an AWAITING_TRANSFER bank order on its own ENABLED route. */
export async function awaitingOrder(label: string, cfg: RouteCfg & { readonly agent?: Agent; readonly route?: Route; readonly plan?: { readonly planId: string; readonly projectId: string } } = {}): Promise<Order> {
  const { iw } = L();
  const a = cfg.agent ?? (await agentOf(iw, `${safe(label)}-${++seq}`));
  const route = cfg.route ?? (await routeFor(label, [a.s.agency.agencyId], cfg));
  const plan = cfg.plan ?? (await planOf(iw, a, `${safe(label)}-plan-${++seq}`));
  const quote = await quoted(iw, a, plan);
  const issued = await call(iw.w, { url: routeRoutes.order(quote.quote.quoteId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("bank-issue"), body: { termsHash: quote.quote.termsHash, routeKind: "BANK_TRANSFER", routeId: route.routeId } });
  assert.equal(issued.status, 201, `L-ROUTE dependency: issue transfer instructions (I2): ${issued.text}`);
  const v = issued.json<{ data: { order: { orderId: string; expectedAmountCents: string | number }; transfer: { reference: string; transferExpiresAt: string; bankState: string } } }>().data;
  assert.equal(v.transfer.bankState, "AWAITING_TRANSFER");
  const keys = dataOf<{ keys: MatchKeys }>(await ownerGet(inboundRoutes.matchKeys(v.order.orderId)), 200, "the order's match keys (L-INBOUND read)").keys;
  const [o] = await q<{ s: string; t: string }>("SELECT expected_service_cents::text AS s, expected_tax_cents::text AS t FROM kauro.payment_orders WHERE order_id = $1", [v.order.orderId]);
  return { a, quote, planId: plan.planId, projectId: plan.projectId, route, orderId: v.order.orderId, amountCents: BigInt(v.order.expectedAmountCents), serviceCents: BigInt(o!.s), taxCents: BigInt(o!.t), reference: v.transfer.reference, transferExpiresAt: v.transfer.transferExpiresAt, payerDigest: keys.acceptedPayerDigest };
}

// --- credits ------------------------------------------------------------------------------------------------------------------------

export interface CreditFacts {
  readonly bankTransactionId: string;
  readonly rail: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint | null;
  readonly currency: string;
  readonly reference: string | null;
  readonly payerDigest: string | null;
  readonly bookedAt: string;
  readonly status: string;
}
export const nextTxn = (label: string): string => `txn-${safe(label).replace(/-/g, "").slice(-16)}-${++seq}`;
/** The facts of an exact, on-time, accepted-payer ACH credit for the order. */
export function exactFor(o: Order, over: Partial<CreditFacts> = {}): CreditFacts {
  return { bankTransactionId: nextTxn(o.orderId), rail: "ACH", grossCents: o.amountCents, feeCents: 0n, currency: "USD", reference: o.reference, payerDigest: o.payerDigest, bookedAt: new Date(Date.now() - 60_000).toISOString(), status: "COMPLETED", ...over };
}
const creditFields = (f: CreditFacts): FakeCreditFields => ({ creditId: f.bankTransactionId, rail: f.rail, currency: f.currency, grossCents: f.grossCents, feeCents: f.feeCents, netCents: f.feeCents === null ? null : f.grossCents - f.feeCents, payeeDigest: BANK_PAYEE_DIGEST, reference: f.reference, payerDigest: (f.payerDigest ?? null) as never, payerEvidenceRef: f.payerDigest === null ? null : `payer-${f.bankTransactionId}`, status: f.status, bookedAt: f.bookedAt, observedAt: plusMs(f.bookedAt, 1) });
/** The owner's stored bank artifact of one credit (the restricted store the confirmation rereads). */
export async function creditArtifact(accountRef: string, f: CreditFacts): Promise<StoredBankArtifact> {
  const { artifactRef, sha256 } = await L().bw.evidence.put({ bytes: fakeCreditBytes(accountRef, creditFields(f)), accountRef: accountRef as never });
  return { artifactRef, evidenceHash: sha256 };
}
export interface StatementFacts {
  readonly from: string;
  readonly to: string;
  readonly credits: ReadonlyArray<CreditFacts>;
  readonly debits: ReadonlyArray<FakeDebitFields>;
}
export async function statementArtifact(accountRef: string, s: StatementFacts): Promise<StoredBankArtifact> {
  const { artifactRef, sha256 } = await L().bw.evidence.put({ bytes: fakeStatementBytes(accountRef, { coverageStart: s.from, coverageEnd: s.to, credits: s.credits.map(creditFields), debits: s.debits }), accountRef: accountRef as never });
  return { artifactRef, evidenceHash: sha256 };
}

/** C5 Enter manual credit: the draft carries the facts the owner typed, possibly different from the artifact (`typed`). */
export function enterC5(accountRef: string, f: CreditFacts, artifact: StoredBankArtifact, o: OwnerCall = {}, typed: Partial<CreditFacts> = {}): Promise<Reply> {
  const t = { ...f, ...typed };
  return ownerCall(inboundRoutes.enterCredit(accountRef), { bankTransactionId: t.bankTransactionId, rail: t.rail, grossCents: t.grossCents.toString(), currency: t.currency, reference: t.reference, bookedAt: t.bookedAt, evidence: { artifactRef: artifact.artifactRef, evidenceHash: artifact.evidenceHash } }, o, `c5-${f.bankTransactionId}`);
}
/** C4 + C6 Confirm manual credit. */
export function confirmC6(creditId: string, expectedVersion = 1, o: OwnerCall = {}): Promise<Reply> {
  return ownerCall(inboundRoutes.confirmCredit(creditId), { expectedVersion }, o, `c6-${creditId.slice(-8)}`);
}
/** M2 owner attribution of a MATCH_REVIEW credit to an order. */
export function attributeM2(creditId: string, orderId: string, expectedVersion: number, o: OwnerCall = {}): Promise<Reply> {
  return ownerCall(inboundRoutes.attributeCredit(creditId), { expectedVersion, orderId, billingEvidenceRef: `billing-evidence-${orderId.slice(-8)}`, reasonCode: "Customer billing evidence verified", }, o, `m2-${creditId.slice(-8)}`);
}
/** SI2 ImportStatementCoverage. */
export function importSI2(accountRef: string, artifact: StoredBankArtifact, o: OwnerCall = {}): Promise<Reply> {
  return ownerCall(inboundRoutes.importStatement(accountRef), { artifactRef: artifact.artifactRef, evidenceHash: artifact.evidenceHash }, o, "si2");
}

/** A DRAFT_MANUAL credit (C5 answered 201). */
export async function drafted(accountRef: string, f: CreditFacts, o: OwnerCall = {}): Promise<{ readonly credit: CreditView; readonly artifact: StoredBankArtifact }> {
  const artifact = await creditArtifact(accountRef, f);
  const credit = dataOf<{ credit: CreditView }>(await enterC5(accountRef, f, artifact, o), 201, `C5 enters ${f.bankTransactionId}`).credit;
  assert.equal(credit.state, "DRAFT_MANUAL", "an entry is a draft, never money");
  return { credit, artifact };
}
/** A confirmed credit (C6 answered 200, OBSERVED, the service not yet run); `o` is the owner's call of both commands (its proof). */
export async function confirmed(accountRef: string, f: CreditFacts, o: OwnerCall = {}): Promise<CreditView> {
  const { credit } = await drafted(accountRef, f, o);
  return dataOf<{ credit: CreditView }>(await confirmC6(credit.creditId, 1, o), 200, `C6 confirms ${f.bankTransactionId}`).credit;
}

// --- the service steps --------------------------------------------------------------------------------------------------------------

/** The latest event of `eventType` an aggregate published, or undefined. */
export async function latestEvent(aggregateId: string, eventType: string): Promise<string | undefined> {
  return (await q<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id::text = $1 AND event_type = $2 ORDER BY sequence DESC LIMIT 1", [aggregateId, eventType]))[0]?.event_id;
}
/** Hands the latest `eventType` event of the credit to the PAYMENT_SERVICE consumer once (the handler a lane registers). */
export async function deliverToService(creditId: string, eventType: "bank_credit.received.v1" | "bank_credit.matched.v1"): Promise<string> {
  const { iw } = L();
  const eventId = await latestEvent(creditId, eventType);
  assert.ok(eventId !== undefined, `${creditId} published ${eventType}`);
  return paymentServiceEffect(iw.pw.service.runtime).handle((await deliveryOf(iw as never, eventId)) as never) as Promise<string>;
}
/** M1 + Kmatch: the service's matching of a confirmed credit. */
export const matchService = (creditId: string): Promise<string> => deliverToService(creditId, "bank_credit.received.v1");
/** P1 Kapply. */
export const applyService = (creditId: string): Promise<string> => deliverToService(creditId, "bank_credit.matched.v1");
/** P2: FINANCE passes until nothing is due. */
export async function finance(): Promise<ReadonlyArray<{ readonly eventType: string; readonly outcome: string }>> {
  const out: Array<{ eventType: string; outcome: string }> = [];
  const sink = L().iw.pw.backgroundFailures;
  for (let i = 0; i < 5; i++) {
    const before = sink.length;
    const pass = await dispatch(L().iw.pw, "FINANCE");
    // the dispatcher records a delivery's failure and goes on: the pass's first failure is the booking's own error
    const failed = sink.slice(before)[0];
    if (failed !== undefined) throw failed.error;
    assert.deepEqual(pass.deliveries.filter((d) => d.outcome === "FAILED" || d.outcome === "DEAD_LETTER"), [], "every FINANCE delivery is applied, a duplicate or not applicable");
    out.push(...pass.deliveries);
    if (pass.deliveries.length === 0) break;
  }
  return out;
}
/** The ids of the aggregates whose events book a credit: the credit and its capture. */
async function bookedAggregates(creditId: string): Promise<ReadonlyArray<string>> {
  const row = await creditRow(creditId);
  return [creditId, ...(row?.capture_id ? [row.capture_id] : [])];
}
/**
 * P2 Kbook as a FINANCE redelivery: every FINANCE delivery of the credit's and its capture's events (delivered or not), handed to the
 * FINANCE consumer in its own SERVICE unit (the dispatcher's effect, without its lease or settlement); answers each outcome.
 */
export async function kbook(creditId: string): Promise<ReadonlyArray<string>> {
  const { iw } = L();
  const due = await q<{ event_id: string }>(
    "SELECT e.event_id FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE o.consumer = 'FINANCE' AND e.aggregate_id::text = ANY($1::text[]) ORDER BY e.sequence",
    [await bookedAggregates(creditId)],
  );
  assert.ok(due.length > 0, `${creditId} has FINANCE deliveries`);
  const effect = unitOfWorkEffect(iw.pw.service.runtime, financeConsumer());
  const out: string[] = [];
  for (const d of due) out.push(await effect.handle((await deliveryOf(iw as never, d.event_id)) as never));
  return out;
}
/**
 * The dispatcher's backoff of the credit's failed FINANCE deliveries elapses (it schedules a retry on its own clock): each is due again
 * at the instant it first became due, its created_at (the publisher wrote next_attempt_at = created_at on the application clock, and the
 * failed pass claimed it with the dispatcher's clock at or after that instant). Never the database's now(): the dispatcher compares
 * next_attempt_at with its runtime clock, Date.now() here: whole milliseconds, and on Windows a GetSystemTimeAsFileTime baseline V8
 * extrapolates and resyncs each minute, while PostgreSQL's now() reads GetSystemTimePreciseAsFileTime. It stood up to 2.3 ms behind the
 * database clock on a GitHub Windows runner, and the claim followed this write by as little as 1.7 ms: a pass then claimed nothing and
 * booked nothing (order 8). Answers how many were rescheduled, each due on the dispatcher's clock.
 */
export async function financeRetryDue(creditId: string): Promise<number> {
  const r = await L().iw.h.oracle.query<{ due: Date | string }>(
    "UPDATE kauro.outbox_records o SET next_attempt_at = o.created_at FROM kauro.domain_events e WHERE e.event_id = o.event_id AND o.consumer = 'FINANCE' AND o.state = 'RETRYABLE' AND e.aggregate_id::text = ANY($1::text[]) RETURNING o.next_attempt_at AS due",
    [await bookedAggregates(creditId)],
  );
  const now = L().iw.pw.service.runtime.clock.nowMs();
  for (const row of r.rows) assert.ok(new Date(row.due).getTime() <= now, `a rescheduled FINANCE delivery is due on the dispatcher's clock: ${new Date(row.due).toISOString()} <= ${new Date(now).toISOString()}`);
  return r.rowCount ?? 0;
}
/** E1: one pass of the payment service's sweeps (TRANSFER_EXPIRY is a registered bank sweep). */
/**
 * One sweep pass (E1 Kexpiry among the bank sweeps). The pass reports a failed unit to the service's background-failure sink and goes on;
 * the first failure recorded during THIS pass is thrown here, so a cell sees a sweep that failed (a PARTIAL fault, a timeout) as failed.
 */
export const expirySweep = async (): Promise<void> => {
  const sink = L().iw.pw.backgroundFailures;
  const before = sink.length;
  await L().iw.pw.service.runSweepPass();
  const failed = sink.slice(before)[0];
  if (failed !== undefined) throw failed.error;
};
/** A credit taken from confirmation to its final state: match, then apply if MATCHED. */
export async function settleCredit(creditId: string): Promise<CreditRow> {
  await matchService(creditId);
  if ((await creditRow(creditId))?.state === "MATCHED") await applyService(creditId);
  return (await creditRow(creditId))!;
}
/** An exact credit for the order entered, confirmed and run through the service. */
export async function paid(o: Order, over: Partial<CreditFacts> = {}): Promise<{ readonly credit: CreditRow; readonly facts: CreditFacts }> {
  const facts = exactFor(o, over);
  const c = await confirmed(o.route.accountRef, facts);
  return { credit: await settleCredit(c.creditId), facts };
}

// --- harness routing ----------------------------------------------------------------------------------------------------------------

export const openPay = (): Promise<HarnessConnection> => openLogin(LOGIN);
export const openApp = (): Promise<HarnessConnection> => openLogin(OWNER_LOGIN);
const LOGIN_ROLES: Readonly<Record<string, RouteRole>> = { kauro_app_test: "kauro_app", kauro_payment_test: "kauro_payment", kauro_control_test: "kauro_control" };
const roles = new WeakMap<HarnessConnection, RouteRole>();
async function openLogin(login: "kauro_app_test" | "kauro_payment_test"): Promise<HarnessConnection> {
  const c = await openConnection(L().iw.h.pg.clientConfig(login));
  roles.set(c, LOGIN_ROLES[login]!);
  return c;
}
/** The role a harness connection logs in as (a connection opened elsewhere, mustWaitOn's waiter, is asked once). */
async function roleOf(conn: HarnessConnection): Promise<RouteRole> {
  const known = roles.get(conn);
  if (known !== undefined) return known;
  const login = (await conn.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
  const role = LOGIN_ROLES[login];
  if (role === undefined) throw new Error(`a routed connection logs in as ${login}, not one of ${Object.keys(LOGIN_ROLES).join(", ")}`);
  roles.set(conn, role);
  return role;
}
/** A connection per role a lane step may open a unit for: the owner's (kauro_app) and the payment service's (kauro_payment). */
interface Pair {
  readonly app: HarnessConnection;
  readonly pay: HarnessConnection;
}
async function openPair(): Promise<Pair> {
  const app = await openApp();
  try {
    return { app, pay: await openPay() };
  } catch (e) {
    await app.end();
    throw e;
  }
}
async function endPair(p: Pair): Promise<void> {
  try {
    await p.app.end();
  } finally {
    await p.pay.end();
  }
}
function onPair<T>(ctx: FaultContext, p: Pair, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep>, routing: { target?: number; log?: UnitLog[] } = {}): Promise<T> {
  return L().iw.faults.onRoles({ kauro_app: p.app, kauro_payment: p.pay }, ctx.points, steps, fn, routing);
}
/**
 * The advisory stream lock of one account held by a connection of the payment login (the KIT's holdInboundStream / holdOutboundStream take the
 * fixed BANK_ACCOUNT; a cell's subject lives on its own fresh account, so it holds that account's stream).
 */
export async function holdStream(accountRef: string, stream: "INBOUND" | "OUTBOUND"): Promise<HeldLock> {
  const { iw, bw } = L();
  const connection = await openPay();
  let ended = false;
  const lock: HeldLock = {
    kind: stream === "INBOUND" ? "INBOUND_STREAM" : "L1_OUTBOUND_STREAM",
    pid: connectionPid(connection),
    connection,
    async release() {
      if (ended) return;
      ended = true;
      try {
        await connection.query("ROLLBACK");
      } finally {
        await connection.end();
      }
    },
  };
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, $3))", [bw.environment, accountRef, stream]);
  } catch (e) {
    await lock.release();
    throw e;
  }
  void iw;
  return lock;
}
/** `fn` with its units routed over `conn`, under the role the connection logs in as (a unit of another role fails loudly). */
export async function routed<T>(ctx: FaultContext, conn: HarnessConnection, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = [], target?: number): Promise<T> {
  return L().iw.faults.on(conn, await roleOf(conn), ctx.points, steps, fn, target === undefined ? {} : { target });
}
/** `fn` with its units routed over fresh connections, one per role: an owner command's on kauro_app, a service step's on kauro_payment. */
export async function onFresh<T>(ctx: FaultContext, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = [], target?: number): Promise<T> {
  const p = await openPair();
  try {
    return await onPair(ctx, p, fn, steps, target === undefined ? {} : { target });
  } finally {
    await endPair(p);
  }
}
/** `fn` with the routed units on the operation's step clock (DB-clock cells: template rule 10). */
export function onClock<T>(ctx: FaultContext, what: string, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = []): Promise<T> {
  return ctx.operation(what, (op) =>
    onFresh(ctx, async () => {
      L().iw.faults.clock = op.clock;
      try {
        return await fn();
      } finally {
        L().iw.faults.clock = null;
      }
    }, steps),
  );
}
export async function reach(pause: { reachedBy(p: Promise<unknown>): Promise<void> }, running: Promise<unknown>, what: string): Promise<void> {
  try {
    await pause.reachedBy(running);
  } catch (e) {
    const settled = await running.then((v) => v, (err: unknown) => err);
    const text = typeof settled === "object" && settled !== null && "status" in settled ? `${(settled as Reply).status} ${(settled as Reply).text}` : String(settled);
    assert.fail(`${what}: the step settled before its named point (${String(e)}): ${text}`);
  }
}
export const valueOf = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};
/**
 * The holder's real step held at `at` (default its COMMIT, every lock kept), the waiter observed waiting on its backend, then released.
 * Each side routes over one connection per role; the held unit's role (the holder's last unit when it reached `at`) names the holder's
 * backend, and the waiter is observed on its connection of that same role.
 */
export async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: () => Promise<H>, waiter: () => Promise<W>, at = "uow.before-commit", steps: ReadonlyArray<SqlStep> = []): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const hc = await openPair();
  const wc = await openPair().catch(async (e: unknown) => {
    await endPair(hc);
    throw e;
  });
  try {
    const pause = ctx.points.pause(at);
    const log: UnitLog[] = [];
    const running = ctx.operation(`${what} (holder)`, () => onPair(ctx, hc, holder, steps, { log }));
    const settledHolder = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await reach(pause, running, what);
    const heldRole = log.at(-1)?.role;
    if (heldRole !== "kauro_app" && heldRole !== "kauro_payment") assert.fail(`${what}: the holder reached ${at} outside a kauro_app or kauro_payment unit (${String(heldRole)})`);
    const side = heldRole === "kauro_app" ? "app" : "pay";
    const waiting = await ctx.mustWait(L().iw.h.oracle, { waiter: wc[side], holder: connectionPid(hc[side]) }, () => onPair(ctx, wc, waiter, []), what);
    // a TIMEOUT cell (a statement timeout injected on the waiter) keeps the holder until the waiter timed out: releasing at once would let it win the lock
    if (L().iw.faults.statementTimeoutMs !== null) {
      const waited = await waiting.pending;
      pause.release();
      return { held: await settledHolder, waited };
    }
    pause.release();
    return { held: await settledHolder, waited: await waiting.pending };
  } finally {
    try {
      await endPair(hc);
    } finally {
      await endPair(wc);
    }
  }
}

// --- the footprint oracle (superuser reads only) -----------------------------------------------------------------------------------

export interface CreditRow {
  readonly bank_credit_id: string;
  readonly state: string;
  readonly version: string;
  readonly gross_cents: string;
  readonly fee_cents: string | null;
  readonly order_id: string | null;
  readonly capture_id: string | null;
}
export async function creditRow(creditId: string): Promise<CreditRow | undefined> {
  return (await q<CreditRow & Record<string, unknown>>("SELECT bank_credit_id, state, version::text, gross_cents::text, fee_cents::text, order_id, capture_id FROM kauro.bank_credits WHERE bank_credit_id = $1", [creditId]))[0];
}
export async function creditsOfTxn(accountRef: string, bankTransactionId: string): Promise<CreditRow[]> {
  return q<CreditRow & Record<string, unknown>>("SELECT bank_credit_id, state, version::text, gross_cents::text, fee_cents::text, order_id, capture_id FROM kauro.bank_credits WHERE account_ref = $1 AND bank_transaction_id = $2", [accountRef, bankTransactionId]);
}
export async function orderState(orderId: string): Promise<string> {
  const [r] = await q<{ s: string }>("SELECT order_state AS s FROM kauro.bank_transfer_instructions WHERE order_id = $1", [orderId]);
  return r?.s ?? "-";
}
/** What a credit and its order hold: the money/authority footprint every refusal, crash and partial failure compares whole. */
export interface Footprint {
  readonly credits: ReadonlyArray<readonly [string, string]>;
  readonly orderState: string;
  readonly captures: ReadonlyArray<readonly [string, string, string, string]>;
  readonly allocatedCents: string;
  readonly authorizations: number;
  readonly cases: ReadonlyArray<string>;
  readonly bankCases: ReadonlyArray<string>;
  readonly returns: ReadonlyArray<readonly [string, string]>;
  readonly events: number;
  readonly outbox: number;
  readonly journal: number;
  readonly ledger: number;
}
export async function footprint(o: { readonly orderId?: string; readonly accountRef: string }): Promise<Footprint> {
  const orderId = o.orderId ?? null;
  const credits = await q<{ id: string; state: string }>("SELECT bank_credit_id AS id, state FROM kauro.bank_credits WHERE account_ref = $1 ORDER BY created_at, bank_credit_id", [o.accountRef]);
  const ids = [...credits.map((c) => c.id), ...(orderId === null ? [] : [orderId])];
  const caps = orderId === null ? [] : await q<{ s: string; a: string; sv: string; x: string }>("SELECT status AS s, amount_cents::text AS a, allocated_service_cents::text AS sv, excess_cents::text AS x FROM kauro.capture_facts WHERE order_id = $1 ORDER BY created_at", [orderId]);
  for (const c of await (orderId === null ? Promise.resolve([]) : q<{ id: string }>("SELECT capture_id AS id FROM kauro.capture_facts WHERE order_id = $1", [orderId]))) ids.push(c.id);
  const alloc = orderId === null ? "0" : ((await q<{ a: string }>("SELECT allocated_cents::text AS a FROM kauro.payment_orders WHERE order_id = $1", [orderId]))[0]?.a ?? "0");
  return {
    credits: credits.map((c) => [c.id, c.state] as const),
    orderState: orderId === null ? "-" : await orderState(orderId),
    captures: caps.map((c) => [c.s, c.a, c.sv, c.x] as const),
    allocatedCents: alloc,
    authorizations: orderId === null ? 0 : await count("SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [orderId]),
    cases: orderId === null ? [] : (await q<{ k: string }>("SELECT kind AS k FROM kauro.reconciliation_cases WHERE order_id = $1 ORDER BY kind", [orderId])).map((r) => r.k),
    bankCases: (await q<{ k: string }>("SELECT kind AS k FROM kauro.bank_review_cases WHERE account_ref = $1 ORDER BY kind", [o.accountRef])).map((r) => r.k),
    returns: orderId === null ? [] : (await q<{ o: string; c: string }>("SELECT origin AS o, (proposed_service_cents + proposed_tax_cents + proposed_excess_cents)::text AS c FROM kauro.refunds WHERE order_id = $1 ORDER BY origin, created_at", [orderId])).map((r) => [r.o, r.c] as const),
    events: await count("SELECT 1 FROM kauro.domain_events WHERE aggregate_id::text = ANY($1::text[])", [ids]),
    outbox: await count("SELECT 1 FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE e.aggregate_id::text = ANY($1::text[])", [ids]),
    journal: await count("SELECT 1 FROM kauro.command_journal WHERE resource_id::text = ANY($1::text[])", [ids]),
    ledger: await count("SELECT 1 FROM kauro.ledger_entries l JOIN kauro.domain_events e ON e.event_id = l.domain_event_id WHERE e.aggregate_id::text = ANY($1::text[])", [ids]),
  };
}
/** Σ ledger cents by account of the posting sets sourced by the credit's and its capture's events. */
export async function ledgerByAccount(creditId: string): Promise<Record<string, bigint>> {
  const row = await creditRow(creditId);
  const ids = [creditId, ...(row?.capture_id ? [row.capture_id] : [])];
  const rows = await q<{ a: string; d: string; n: string }>(
    "SELECT l.account_code AS a, l.direction AS d, sum(l.amount_cents)::text AS n FROM kauro.ledger_entries l JOIN kauro.domain_events e ON e.event_id = l.domain_event_id WHERE e.aggregate_id::text = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1, 2",
    [ids],
  );
  const out: Record<string, bigint> = {};
  for (const r of rows) out[`${r.a}:${r.d}`] = BigInt(r.n);
  return out;
}
export async function statementLines(accountRef: string): Promise<ReadonlyArray<readonly [string, string, string | null, string | null]>> {
  return (await q<{ k: string; id: string; a: string | null; l: string | null }>("SELECT line_kind AS k, bank_line_id AS id, amount_cents::text AS a, linked_attempt_id::text AS l FROM kauro.statement_lines WHERE account_ref = $1 ORDER BY line_kind, bank_line_id", [accountRef])).map((r) => [r.k, r.id, r.a, r.l] as const);
}
export async function importsOf(accountRef: string): Promise<number> {
  return count("SELECT 1 FROM kauro.statement_imports WHERE account_ref = $1", [accountRef]);
}
export async function coverageOf(accountRef: string): Promise<ReadonlyArray<readonly [string, string, string]>> {
  return (await q<{ s: string; f: Date; t: Date }>("SELECT c.stream AS s, c.covered_from AS f, c.covered_to AS t FROM kauro.statement_coverage c JOIN kauro.statement_imports i USING (import_id) WHERE i.account_ref = $1 ORDER BY c.covered_from, c.stream", [accountRef])).map((r) => [r.s, r.f.toISOString(), r.t.toISOString()] as const);
}
/** A step-up proof of the owner and its expiry instant (the effect clock decides it: migration 0038). */
export async function proofOf(owner: Person = L().owner): Promise<{ readonly proof: string; readonly expiresAt: string }> {
  const proof = await L().iw.h.recordStepUp(owner.userId as never);
  const expiresAt = (await q<{ e: Date }>("SELECT expires_at AS e FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]))[0]!.e.toISOString();
  return { proof, expiresAt };
}
/** The revocations an owner command must re-check under its held lock (product paths only: no UPDATE that violates a CHECK). */
export const OWNER_PREREQUISITES = ["grant", "identity", "step-up"] as const;
export async function revokeOwner(what: (typeof OWNER_PREREQUISITES)[number], o: { readonly person: Person; readonly grantId: string }, proof: string): Promise<void> {
  const { iw } = L();
  if (what === "grant") await iw.h.revokeCorporateGrant(o.grantId);
  else if (what === "identity") await q("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [o.person.userId]);
  else await q("UPDATE kauro.assurance_proofs SET expires_at = now() WHERE proof_id = $1", [proof]);
}

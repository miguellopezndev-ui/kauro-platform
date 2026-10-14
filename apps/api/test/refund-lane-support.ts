// Lane L-REFUND (PAYMENTS-V1, tier 1 MONEY): the test driver of REFUND-GENERIC-V1 and the V1 ACH refund rows (docs/design/ACH-ROUTE.md r12
// §7.13-§7.22d, §7.27, §7.28; mandate PAYMENTS-V1-REPLAN §4). It fixes, for the lane's builder, the HTTP contract the cells call (routes,
// bodies, views), the scope fixtures and one footprint oracle; it contains no business logic. Every command runs through the REAL api of
// the integration world (apps/api/src), optionally over a harness connection (`routed`) so a cell can hold it at a lock or at its COMMIT
// (crashableFactory `uow`), lose its answer, or fail it after a statement (SqlStep). The SEAMS section names what the KIT (a6e64be) does not
// provide yet and the exact change it needs; a seam is reached only after the CAPTURE-scope arm of a cell already passed.
//
// Contract decisions this file makes for the lane (the builder serves exactly these):
//   * every bank outbound command (X1, X4, G2, G3, G4, X3, Koffer) is an owner command whose units of work run as the payment service role
//     (`BANK_COMMAND_ROLE`), adopting the refund's scope like CMD033 does; F2 is CMD032 itself, extended with the destination;
//   * refusals answer a Problem whose `reason` is the KIT failure-reason token (domain failure-reasons.ts) named by the design.
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import type { UserId } from "@kauro/domain";
import { connectionPid, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { bankWorld, type BankWorld, type StoredBankArtifact } from "./bank-support.js";
import { paymentRoutes } from "./commerce-support.js";
import type { SqlStep } from "./fault-support.js";
import { agentOf, bought, integrationWorld, type Agent, type IntegrationWorld } from "./integration-support.js";
import { execute } from "./payment-support.js";
import { executionWindowPass } from "../src/payments/index.js";
import { asProblem, call, freshKey, ids, type Person, type Reply } from "./support.js";
import type { Purchase } from "./commission-support.js";

// --- vocabulary ---------------------------------------------------------------------------------------------------------------------

export type Scope = "CAPTURE" | "BANK_CREDIT";
/** Every cell runs both source scopes inside its one title (ACH-ROUTE §7 intro, §7.21): CAPTURE first. */
export const SCOPES: ReadonlyArray<Scope> = ["CAPTURE", "BANK_CREDIT"];
export type Kind = "RETURN" | "RESEND";
export const KINDS: ReadonlyArray<Kind> = ["RETURN", "RESEND"];
export const BANK_COMMAND_ROLE = "kauro_payment" as const;
export const BANK_COMMAND_LOGIN = "kauro_payment_test" as const;

export interface Destination {
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly holderName: string;
}
/** The approved destination of every fixture: 021000021 passes the ABA check (3·0+7·2+1·1+3·0+7·0+1·0+3·0+7·2+1·1 = 30). */
export const DEST: Destination = Object.freeze({ routingNumber: "021000021", accountNumber: "12341234", holderName: "Alice Smith" });
export const DEST_LAST4 = "1234";
/** The concatenation-collision twin of DEST (DV1-11 r9 reproduction): same routing, account 123412341234 / holder "M" vs 12341234 / "1234M". */
export const COLLISION_A: Destination = Object.freeze({ routingNumber: "021000021", accountNumber: "12341234", holderName: "1234M" });
export const COLLISION_B: Destination = Object.freeze({ routingNumber: "021000021", accountNumber: "123412341234", holderName: "M" });

// --- the lane's HTTP contract -------------------------------------------------------------------------------------------------------

export const bankRefundRoutes = {
  /** F2 on a CAPTURE refund: CMD032 with `destination` and `destinationEvidence` in its body. */
  approveRefund: (refundId: string) => paymentRoutes.approveRefund(refundId),
  /** F2 on a BANK_CREDIT treasury refund. */
  approveTreasuryRefund: (treasuryRefundId: string) => `/api/v1/operations/treasury-refunds/${treasuryRefundId}/approve`,
  /** X1 DeclareRefundExecution (RETURN), by refund or treasury refund id. */
  declareExecution: (refundId: string) => `/api/v1/operations/refunds/${refundId}/execution-declarations`,
  /** G2 / G4 (by the attempt's kind): Koffer, G1, outcome. */
  recordExecution: (attemptId: string) => `/api/v1/operations/execution-attempts/${attemptId}/records`,
  /** G3 RecordReturnBounce on a RECORDED attempt. */
  recordBounce: (attemptId: string) => `/api/v1/operations/execution-attempts/${attemptId}/bounces`,
  /** X4 DeclareResendExecution for a recorded bounce of the attempt. */
  declareResend: (attemptId: string) => `/api/v1/operations/execution-attempts/${attemptId}/resend-declarations`,
  /** X3 ResolveUncertainExecution. */
  resolveUncertain: (attemptId: string) => `/api/v1/operations/execution-attempts/${attemptId}/resolutions`,
  /** The owner queue: send details only for a DECLARED attempt (GET). */
  ownerQueue: () => `/api/v1/operations/execution-attempts`,
  /** SI2 ImportStatementCoverage (lane L-INBOUND serves it; the refund cells race against it). */
  importStatement: (accountRef: string) => `/api/v1/operations/bank-accounts/${accountRef}/statement-imports`,
  /** G6 is a service step (Kreversal): applied through the inbound consumer of an authenticated reversal version (lane L-INBOUND seam S5). */
} as const;

export interface AttemptView {
  readonly attemptId: string;
  readonly kind: Kind;
  readonly state: "DECLARED" | "UNCERTAIN" | "RECORDED" | "NOT_EXECUTED";
  readonly reference: string;
  readonly amountCents: string;
  readonly currency: "USD";
  readonly declaredAt: string;
  readonly sourceKind: Scope;
  readonly sourceId: string;
  readonly destination: { readonly accountLast4: string; readonly holderName: string };
  readonly bankExecutionId: string | null;
}
export interface RefundStateView {
  readonly state: string;
  readonly version: number;
}
export interface DeclareView {
  readonly attempt: AttemptView;
  readonly refund: RefundStateView | null;
}
export interface RecordView {
  readonly attempt: AttemptView;
  readonly refund: RefundStateView | null;
  readonly offerId: string;
}
export interface ResolveView {
  readonly attempt: AttemptView;
  readonly refund: RefundStateView | null;
}
export interface QueueItem {
  readonly attemptId: string;
  readonly state: string;
  readonly amountCents: string;
  readonly reference: string;
  readonly destination: { readonly accountLast4: string; readonly holderName: string };
}

// --- SEAMS: not expressible on KIT a6e64be (each names the exact KIT change) --------------------------------------------------------

export class SeamMissing extends Error {
  constructor(seam: string, change: string) {
    super(`SEAM ${seam} missing on KIT: ${change}`);
    this.name = "SeamMissing";
  }
}
export const SEAMS = {
  S1: "bankWorld.paidByBankTransfer(agent, label): a purchase whose payment order has routeKind BANK_TRANSFER and whose capture COMPLETED from an applied exact credit (L-ROUTE order + L-INBOUND C6/P1); until then the CAPTURE fixture is the B09 CONTRACT_FAKE purchase",
  S2: "bankWorld.unassignedCredit(cents, label) -> { bankCreditId, treasuryRefundId } a credit in RETURN_REVIEW with a REQUESTED treasury refund of its whole gross (L-INBOUND credit table + L-REFUND treasury_refunds), the BANK_CREDIT source scope",
  S3: "integrationWorld({ bankEvidence }) wiring bankWorld's CONTRACT_FAKE store/port and a test DestinationFingerprinter (fixed key id 'test-key', version 1) into ApiAssembly.commercial, so the routes read the bytes the cells store",
  S4: "bankWorld.storeRecipientRecord({ recipientRef, recipientVersion, full }) (a CONTRACT_FAKE recipient-record artifact kind) for DP-RECIPIENT",
  S5: "bankWorld.reverseCredit(bankCreditId | captureId, cents): an authenticated reversal version delivered to the inbound consumer (G6 Kreversal entry point)",
  S7: "a FINANCE dispatcher handle whose lease was taken over (createPaymentDispatcher with a superseded owner) that a cell runs after the fence moved, its pass reported FENCED with no posting (P3 REVOCATION)",
  S6: "bankWorld.routeTiming(): { manualExecutionWindowMs, coverageLagMs } of the route version in force (L-ROUTE route data), so X2/X3 deadlines are derived, never literals",
} as const;

// --- the lane world -----------------------------------------------------------------------------------------------------------------

export interface Lane {
  readonly iw: IntegrationWorld;
  readonly bw: BankWorld;
  /** The corporate KAURO_OWNER the commands run as (the world's). */
  readonly owner: Person;
}
let bound: Lane | undefined;
export const L = (): Lane => {
  if (bound === undefined) throw new Error("the refund lane world is not started (bindLane in before())");
  return bound;
};
export async function startLane(): Promise<Lane> {
  const iw = await integrationWorld();
  const bw = await bankWorld({ world: iw });
  bound = { iw, bw, owner: iw.owner };
  return bound;
}
export async function stopLane(): Promise<void> {
  if (bound === undefined) return;
  await bound.bw.stop();
  await bound.iw.stop();
  bound = undefined;
}

/** One refundable source of one scope: its refund (CAPTURE) or treasury refund (BANK_CREDIT). */
export interface Source {
  readonly scope: Scope;
  readonly label: string;
  /** captureId or bankCreditId: the NEVER-RESEND fence and L2 key. */
  readonly sourceId: string;
  /** refundId or treasuryRefundId. */
  readonly refundId: string;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  /** The whole approved total (service + tax). */
  readonly totalCents: bigint;
  readonly agent?: Agent;
  readonly purchase?: Purchase;
}

/** A REQUESTED refund of the source's whole remaining balance (CMD031 by the agency's BILLING member, or the treasury request of S2). */
/** A label safe for person names, keys and references (letters, digits and hyphens). */
export const safe = (label: string): string => label.replace(/[^A-Za-z0-9-]+/g, "-");

export async function requested(scope: Scope, rawLabel: string): Promise<Source> {
  const { iw } = L();
  const label = safe(rawLabel);
  if (scope === "BANK_CREDIT") {
    const s2 = (L().bw as unknown as { unassignedCredit?: (cents: bigint, label: string) => Promise<{ bankCreditId: string; treasuryRefundId: string }> }).unassignedCredit;
    if (s2 === undefined) throw new SeamMissing("S2", SEAMS.S2);
    const credit = await s2(25_000n, label);
    return { scope, label, sourceId: credit.bankCreditId, refundId: credit.treasuryRefundId, serviceCents: 25_000n, taxCents: 0n, totalCents: 25_000n };
  }
  const a = await agentOf(iw, `${label}-agency`);
  const s1 = (L().bw as unknown as { paidByBankTransfer?: (a: Agent, label: string) => Promise<Purchase> }).paidByBankTransfer;
  const p = s1 !== undefined ? await s1(a, label) : (await bought(iw, a, label)).purchase;
  const r = await call(iw.w, { url: paymentRoutes.requestRefund(p.projectId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey(`${label}-request`), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } });
  assert.equal(r.status, 201, `CMD031 requests the refund of ${label}: ${r.text}`);
  const refundId = r.json<{ data: { refund: { refundId: string } } }>().data.refund.refundId;
  return { scope, label, sourceId: p.captureId, refundId, serviceCents: p.serviceCents, taxCents: p.taxCents, totalCents: p.serviceCents + p.taxCents, agent: a, purchase: p };
}

/** The destination evidence artifact F2 binds (the restricted payer evidence the owner reads the full numbers from). */
export async function destinationEvidence(label: string): Promise<StoredBankArtifact> {
  const { bw } = L();
  return bw.storeCredit({ creditId: `dest-${label}-${ids.next().slice(-12)}`, currency: "USD", payeeDigest: "b".repeat(64) as never, grossCents: 1n, payerEvidenceRef: `payer-${label}`, payerDigest: "c".repeat(64) as never, status: "COMPLETED", observedAt: new Date().toISOString() });
}

export interface ApproveOptions {
  readonly destination?: Destination | null;
  readonly evidence?: StoredBankArtifact | null;
  readonly owner?: Person;
  readonly stepUp?: "FRESH" | "STALE";
  readonly key?: string;
  /** A proof recorded by the cell (instead of a new one minted per call). */
  readonly proof?: string;
  readonly serviceCents?: bigint;
  readonly taxCents?: bigint;
  readonly expectedVersion?: number;
}
/** F2 Kapprove: CMD032 (or the treasury approval) with the destination captured. */
export async function approveF2(src: Source, o: ApproveOptions = {}): Promise<Reply> {
  const { iw } = L();
  const owner = o.owner ?? L().owner;
  const evidence = o.evidence === undefined ? await destinationEvidence(src.label) : o.evidence;
  const body: Record<string, unknown> = {
    expectedVersion: o.expectedVersion ?? 1,
    serviceCents: (o.serviceCents ?? src.serviceCents).toString(),
    taxCents: (o.taxCents ?? src.taxCents).toString(),
    authorizationRef: o.proof ?? (await iw.w.stepUp(owner, o.stepUp ?? "FRESH")),
  };
  if (o.destination !== null) body["destination"] = o.destination ?? DEST;
  if (evidence !== null) body["destinationEvidence"] = { artifactRef: evidence.artifactRef, evidenceHash: evidence.evidenceHash };
  const url = src.scope === "CAPTURE" ? bankRefundRoutes.approveRefund(src.refundId) : bankRefundRoutes.approveTreasuryRefund(src.refundId);
  const reply = await call(iw.w, { url, token: owner.token, agency: null, key: o.key ?? freshKey(`${src.label}-approve`), body });
  // the KIT's CMD032 does not know the destination at all: say so, whatever the cell expected next (the cell's defect reason)
  if (reply.status === 400 && /"field":"destination(Evidence)?","code":"UNKNOWN_FIELD"/.test(reply.text)) assert.fail(`F2 does not capture the approved destination (Capture approved destination, DV1-10/11): ${reply.text}`);
  return reply;
}

/** A source APPROVED with its destination captured (F2 answered 200). */
export async function approved(scope: Scope, label: string, o: ApproveOptions = {}): Promise<Source> {
  const src = await requested(scope, label);
  const r = await approveF2(src, o);
  assert.equal(r.status, 200, `F2 approves ${scope} ${label} with its destination captured: ${r.text}`);
  return src;
}

export interface OwnerCall {
  readonly owner?: Person;
  readonly stepUp?: "FRESH" | "STALE";
  /** A proof recorded by the cell (iw.h.recordStepUp with a chosen issuedAt): its expiry is issuedAt + the policy validity. */
  readonly proof?: string;
  readonly key?: string;
}
async function ownerCall(url: string, body: Record<string, unknown>, o: OwnerCall, label: string): Promise<Reply> {
  const { iw } = L();
  const owner = o.owner ?? L().owner;
  return call(iw.w, { url, token: owner.token, agency: null, key: o.key ?? freshKey(label), body: { ...body, authorizationRef: o.proof ?? (await iw.w.stepUp(owner, o.stepUp ?? "FRESH")) } });
}

export interface DeclareOptions extends OwnerCall {
  readonly amountCents?: bigint;
  readonly expectedVersion?: number;
  readonly recipient?: { readonly recipientRef: string; readonly recipientVersion: string | null; readonly artifact: StoredBankArtifact } | null;
}
/** X1 DeclareRefundExecution. */
export function declareX1(src: Source, o: DeclareOptions = {}): Promise<Reply> {
  const body: Record<string, unknown> = { expectedVersion: o.expectedVersion ?? 2, amountCents: (o.amountCents ?? src.totalCents).toString() };
  if (o.recipient != null) body["recipient"] = { recipientRef: o.recipient.recipientRef, recipientVersion: o.recipient.recipientVersion, artifactRef: o.recipient.artifact.artifactRef, evidenceHash: o.recipient.artifact.evidenceHash };
  return ownerCall(bankRefundRoutes.declareExecution(src.refundId), body, o, `${src.label}-declare`);
}
/** X4 DeclareResendExecution on the bounced RETURN attempt. */
export function declareX4(bounced: AttemptView, amountCents: bigint, o: DeclareOptions = {}): Promise<Reply> {
  const body: Record<string, unknown> = { amountCents: amountCents.toString() };
  if (o.recipient != null) body["recipient"] = { recipientRef: o.recipient.recipientRef, recipientVersion: o.recipient.recipientVersion, artifactRef: o.recipient.artifact.artifactRef, evidenceHash: o.recipient.artifact.evidenceHash };
  return ownerCall(bankRefundRoutes.declareResend(bounced.attemptId), body, o, `resend-${bounced.attemptId.slice(-8)}`);
}
/** G2 / G4 RecordExecution with the stored execution artifact. */
export function recordG2(attempt: AttemptView, stored: StoredBankArtifact, o: OwnerCall = {}): Promise<Reply> {
  return ownerCall(bankRefundRoutes.recordExecution(attempt.attemptId), { evidence: { artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash } }, o, `record-${attempt.attemptId.slice(-8)}`);
}
/** G3 RecordReturnBounce. */
export function bounceG3(attempt: AttemptView, stored: StoredBankArtifact, bouncedCents: bigint, o: OwnerCall = {}): Promise<Reply> {
  return ownerCall(bankRefundRoutes.recordBounce(attempt.attemptId), { bouncedCents: bouncedCents.toString(), evidence: { artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash } }, o, `bounce-${attempt.attemptId.slice(-8)}`);
}
/** X3 ResolveUncertainExecution. */
export function resolveX3(attempt: AttemptView, outcome: "EXECUTED" | "NOT_EXECUTED", stored: StoredBankArtifact | null, o: OwnerCall = {}): Promise<Reply> {
  const body: Record<string, unknown> = { outcome };
  if (stored !== null) body["evidence"] = { artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash };
  return ownerCall(bankRefundRoutes.resolveUncertain(attempt.attemptId), body, o, `resolve-${attempt.attemptId.slice(-8)}`);
}
/** SI2 ImportStatementCoverage of a stored statement artifact. */
export function importSI2(stored: StoredBankArtifact, o: OwnerCall = {}): Promise<Reply> {
  return ownerCall(bankRefundRoutes.importStatement(L().bw.accountRef), { artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash }, o, "statement");
}
/** The owner queue (GET). */
export function ownerQueue(owner: Person = L().owner): Promise<Reply> {
  return call(L().iw.w, { method: "GET", url: bankRefundRoutes.ownerQueue(), token: owner.token, agency: null, key: null });
}
/** CMD033 ExecuteRefund as the payment service (the automated executor). */
export function cmd033(src: Source, expectedVersion: number): Promise<Reply> {
  return execute(L().iw.pw, src.refundId, { expectedVersion });
}
/** One X2 pass: the EXECUTION_WINDOW bank sweep as the payment service runs it (alone, so a cell's crash/pause lands on its units). */
export async function sweepX2(): Promise<void> {
  await executionWindowPass(L().iw.pw.service.runtime);
}

// --- replies ------------------------------------------------------------------------------------------------------------------------

export function dataOf<T>(r: Reply, status: 200 | 201, what: string): T {
  assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${r.text}`);
  return r.json<{ data: T }>().data;
}
/** `${status} ${reason}` of a refusal (the Problem's reason token; "-" when it has none). */
export function refusal(r: Reply): string {
  if (r.status < 400) return `${r.status} (not refused)`;
  if (r.status === 404 && !r.text.includes('"reason"')) return `404 NOT_FOUND`;
  const p = asProblem(L().iw.w, r);
  return `${r.status} ${p.reason ?? p.code}`;
}
export function assertRefused(r: Reply, expected: string, what: string): void {
  assert.equal(refusal(r), expected, `${what}: ${r.text}`);
}

/** A second customer refund request of the same CAPTURE source (one is open at a time: the first must be approved). */
export async function secondRequest(src: Source): Promise<Source> {
  if (src.scope === "BANK_CREDIT") throw new SeamMissing("S2", SEAMS.S2);
  const { iw } = L();
  const a = src.agent!;
  const r = await call(iw.w, { url: paymentRoutes.requestRefund(src.purchase!.projectId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey(`${src.label}-second`), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } });
  assert.equal(r.status, 201, `a second request of ${src.label}: ${r.text}`);
  return { ...src, label: `${src.label}-second`, refundId: r.json<{ data: { refund: { refundId: string } } }>().data.refund.refundId };
}

// --- composed fixtures --------------------------------------------------------------------------------------------------------------

export async function declared(scope: Scope, label: string, o: DeclareOptions = {}, approval: ApproveOptions = {}): Promise<{ readonly src: Source; readonly attempt: AttemptView }> {
  const src = await approved(scope, label, approval);
  const view = dataOf<DeclareView>(await declareX1(src, o), 201, `X1 declares ${scope} ${label}`);
  return { src, attempt: view.attempt };
}

let executionSeq = 0;
export const nextExecutionId = (label: string): string => `exec-${label.replace(/[^A-Za-z0-9]/g, "").slice(-20)}-${++executionSeq}`;
export const plusMs = (instant: string, ms: number): string => new Date(Date.parse(instant) + ms).toISOString();

export interface ExecutionOverrides {
  readonly bankExecutionId?: string;
  readonly amountCents?: bigint;
  readonly currency?: string;
  readonly reference?: string | null;
  readonly executedAt?: string | null;
  readonly full?: Destination | null;
  readonly accountLast4?: string | null;
  readonly routingDigest?: string | null;
  readonly accountDigest?: string | null;
  readonly recipientRef?: string | null;
  readonly recipientVersion?: string | null;
  readonly status?: string;
  readonly returnedCents?: bigint | null;
}
/** The send receipt of an attempt as the owner would store it: by default DP-FULL, exact amount, the attempt's reference, executed 1 ms after its declaration. */
export function storeExecution(attempt: AttemptView, x: ExecutionOverrides = {}): Promise<StoredBankArtifact> {
  return L().bw.storeOutbound({
    bankExecutionId: x.bankExecutionId ?? nextExecutionId(attempt.attemptId),
    amountCents: x.amountCents ?? BigInt(attempt.amountCents),
    currency: x.currency ?? "USD",
    reference: x.reference === undefined ? attempt.reference : x.reference,
    executedAt: x.executedAt === undefined ? plusMs(attempt.declaredAt, 1) : x.executedAt,
    destination: {
      full: x.full === undefined ? DEST : x.full,
      accountLast4: x.accountLast4 === undefined ? DEST_LAST4 : x.accountLast4,
      routingDigest: (x.routingDigest ?? null) as never,
      accountDigest: (x.accountDigest ?? null) as never,
      recipientRef: x.recipientRef ?? null,
      recipientVersion: x.recipientVersion ?? null,
    },
    status: x.status ?? "COMPLETED",
    returnedCents: x.returnedCents ?? null,
    observedAt: plusMs(attempt.declaredAt, 2),
  });
}

export async function recorded(scope: Scope, label: string, approval: ApproveOptions = {}): Promise<{ readonly src: Source; readonly attempt: AttemptView; readonly executionId: string }> {
  const { src, attempt } = await declared(scope, label, {}, approval);
  const executionId = nextExecutionId(label);
  const view = dataOf<RecordView>(await recordG2(attempt, await storeExecution(attempt, { bankExecutionId: executionId, ...(approval.destination != null ? { full: approval.destination } : {}) })), 200, `G2 records ${scope} ${label}`);
  assert.equal(view.attempt.state, "RECORDED");
  return { src, attempt: view.attempt, executionId };
}

/** A RECORDED RETURN whose money came back (G3, the whole amount): REFUND_PAYABLE O = the amount. */
export async function bounced(scope: Scope, label: string, approval: ApproveOptions = {}): Promise<{ readonly src: Source; readonly attempt: AttemptView; readonly payableCents: bigint }> {
  const r = await recorded(scope, label, approval);
  const back = await storeExecution(r.attempt, { bankExecutionId: r.executionId, status: "BOUNCED", returnedCents: BigInt(r.attempt.amountCents) });
  const reply = await bounceG3(r.attempt, back, BigInt(r.attempt.amountCents));
  assert.equal(reply.status, 200, `G3 records the bounce of ${scope} ${label}: ${reply.text}`);
  return { src: r.src, attempt: r.attempt, payableCents: BigInt(r.attempt.amountCents) };
}

/** An open attempt of `kind`: a declared RETURN, or a declared RESEND of a bounced RETURN (X4 for the whole payable). */
export async function openAttempt(scope: Scope, kind: Kind, label: string, approval: ApproveOptions = {}): Promise<{ readonly src: Source; readonly attempt: AttemptView }> {
  if (kind === "RETURN") return declared(scope, label, {}, approval);
  const b = await bounced(scope, label, approval);
  const view = dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents), 201, `X4 declares the resend of ${scope} ${label}`);
  return { src: b.src, attempt: view.attempt };
}

/** The route timing (S6): the manual execution window and the coverage lag of the route version in force. */
export function routeTiming(): { readonly manualExecutionWindowMs: number; readonly coverageLagMs: number } {
  const s6 = (L().bw as unknown as { routeTiming?: () => { manualExecutionWindowMs: number; coverageLagMs: number } }).routeTiming;
  if (s6 === undefined) throw new SeamMissing("S6", SEAMS.S6);
  return s6();
}

/** An attempt lapsed to UNCERTAIN by X2: the sweep runs with the payment service's transaction standing past declaredAt + window (DB clock). */
export async function lapsed(ctx: FaultContext, scope: Scope, kind: Kind, label: string, approval: ApproveOptions = {}): Promise<{ readonly src: Source; readonly attempt: AttemptView }> {
  const { src, attempt } = await openAttempt(scope, kind, label, approval);
  const { manualExecutionWindowMs } = routeTiming();
  const boundary = plusMs(attempt.declaredAt, manualExecutionWindowMs);
  ctx.deadline(boundary, `the manual execution window of ${label}`);
  ctx.clock.past(boundary);
  await ctx.operation(`X2 lapses ${label}`, async (op) => {
    L().iw.faults.clock = op.clock;
    try {
      await sweepX2();
    } finally {
      L().iw.faults.clock = null;
    }
  });
  const now = await attemptRow(attempt.attemptId);
  assert.equal(now?.state, "UNCERTAIN", `X2 lapsed ${label} to UNCERTAIN`);
  return { src, attempt: { ...attempt, state: "UNCERTAIN" } };
}

// --- harness routing ----------------------------------------------------------------------------------------------------------------

export const openBank = (login: "kauro_payment_test" | "kauro_app_test" = BANK_COMMAND_LOGIN): Promise<HarnessConnection> => openConnection(L().iw.h.pg.clientConfig(login));
/** Runs a command with every unit of work it opens routed over `conn` (crashable `uow`, SqlStep points). */
export function routed<T>(ctx: FaultContext, conn: HarnessConnection, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = [], target?: number): Promise<T> {
  // the bank owner commands run their SERVICE units on the payment service's factory: routed over the same connection
  return L().iw.faults.on(conn, BANK_COMMAND_ROLE, ctx.points, steps, fn, { payment: true, ...(target === undefined ? {} : { target }) });
}
/** A routed command over a fresh connection, closed after. */
export async function onFresh<T>(ctx: FaultContext, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = [], target?: number): Promise<T> {
  const c = await openBank();
  try {
    return await routed(ctx, c, fn, steps, target);
  } finally {
    await c.end();
  }
}

/**
 * The holder's real command held at `at` (default its COMMIT, every lock kept), the waiter's real command observed waiting on the holder's
 * backend (ctx.mustWait, pg_stat_activity), then the holder released: both outcomes (template rule 1; the race cells run it in both orders).
 */
export async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: () => Promise<H>, waiter: () => Promise<W>, at = "uow.before-commit", steps: ReadonlyArray<SqlStep> = []): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const hc = await openBank();
  const wc = await openBank();
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => routed(ctx, hc, holder, steps));
    const settledHolder = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await reach(pause, running, what);
    const waiting = await ctx.mustWait(L().iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => routed(ctx, c, waiter), what);
    pause.release();
    return { held: await settledHolder, waited: await waiting.pending };
  } finally {
    await hc.end();
    await wc.end();
  }
}
/** Waits for the code under test to reach a pause; if it settles first, fails with what it answered (never a bare harness message). */
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

// --- the footprint oracle (superuser reads only) -----------------------------------------------------------------------------------

/**
 * Ends step-up proofs now (REVOCATION cells): proofs are append-only and have no revocation command, so this is a write of the database
 * owner with triggers off — a fault injected by another writer the product does not have, never a product step.
 */
export async function expireProofs(column: "proof_id" | "user_id", value: string): Promise<void> {
  const owner = await L().iw.h.pg.connect("postgres");
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(`UPDATE kauro.assurance_proofs SET expires_at = now() WHERE ${column} = $1`, [value]);
    await owner.query("COMMIT");
  } finally {
    await owner.end();
  }
}
export async function q<T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  return (await L().iw.h.oracle.query<T>(sql, params as unknown[])).rows;
}
export interface AttemptRow {
  readonly attempt_id: string;
  readonly kind: string;
  readonly state: string;
  readonly amount_cents: string;
  readonly reference: string;
  readonly bank_execution_id: string | null;
  readonly attempt_number: number;
  readonly declared_at: Date;
}
export async function attemptRow(attemptId: string): Promise<AttemptRow | undefined> {
  return (await q<AttemptRow & Record<string, unknown>>("SELECT attempt_id, kind, state, amount_cents::text, reference, bank_execution_id, attempt_number, declared_at FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [attemptId]))[0];
}
export async function attemptsOf(src: Source): Promise<AttemptRow[]> {
  return q<AttemptRow & Record<string, unknown>>("SELECT attempt_id, kind, state, amount_cents::text, reference, bank_execution_id, attempt_number, declared_at FROM kauro.outbound_execution_attempts WHERE source_id = $1 ORDER BY attempt_number", [src.sourceId]);
}
/** The refund's state, version and committed (reserved) cents: refunds row (CAPTURE) or treasury_refunds row (BANK_CREDIT, lane migration F). */
export async function refundOf(src: Source): Promise<{ readonly state: string; readonly version: number; readonly reservedCents: bigint } | undefined> {
  const rows =
    src.scope === "CAPTURE"
      ? await q<{ state: string; version: string; reserved: string | null }>(
          "SELECT state, version::text, (coalesce(approved_service_cents, 0) + coalesce(approved_tax_cents, 0) + coalesce(approved_excess_cents, 0))::text AS reserved FROM kauro.refunds WHERE refund_id = $1",
          [src.refundId],
        )
      : await q<{ state: string; version: string; reserved: string | null }>("SELECT state, version::text, amount_cents::text AS reserved FROM kauro.treasury_refunds WHERE treasury_refund_id = $1", [src.refundId]);
  const r = rows[0];
  if (r === undefined) return undefined;
  const held = ["APPROVED", "SUBMITTING", "UNCERTAIN", "COMPLETED"].includes(r.state);
  return { state: r.state, version: Number(r.version), reservedCents: held ? BigInt(r.reserved ?? "0") : 0n };
}
/** Σ committed cents of every refund of the source still holding its share (the F2 ceiling's left side). */
export async function sourceReserved(src: Source): Promise<bigint> {
  const r =
    src.scope === "CAPTURE"
      ? await q<{ n: string }>(
          "SELECT coalesce(sum(coalesce(approved_service_cents,0) + coalesce(approved_tax_cents,0) + coalesce(approved_excess_cents,0)), 0)::text AS n FROM kauro.refunds WHERE capture_id = $1 AND state IN ('APPROVED','SUBMITTING','UNCERTAIN','COMPLETED')",
          [src.sourceId],
        )
      : await q<{ n: string }>("SELECT coalesce(sum(amount_cents), 0)::text AS n FROM kauro.treasury_refunds WHERE bank_credit_id = $1 AND state IN ('APPROVED','SUBMITTING','UNCERTAIN','COMPLETED')", [src.sourceId]);
  return BigInt(r[0]!.n);
}

/** Everything a step of the source can write: compared whole before/after a refusal, a crash before COMMIT or a partial failure. */
export interface Footprint {
  readonly refund: { readonly state: string; readonly version: number; readonly reservedCents: bigint } | undefined;
  readonly attempts: ReadonlyArray<readonly [string, string, string, string | null]>;
  readonly offers: number;
  readonly outcomes: number;
  readonly cases: ReadonlyArray<readonly [string, string]>;
  readonly freezes: number;
  readonly destinations: number;
  readonly events: ReadonlyArray<string>;
  readonly outbox: number;
  readonly journal: number;
  readonly ledgerLines: number;
}
export async function footprint(src: Source): Promise<Footprint> {
  const ids = [src.refundId, src.sourceId, ...(await attemptsOf(src)).map((a) => a.attempt_id)];
  const [att, off, out, cases, fr, dest, ev, ob, jr, ll] = await Promise.all([
    attemptsOf(src),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.execution_offers o JOIN kauro.outbound_execution_attempts a USING (attempt_id) WHERE a.source_id = $1", [src.sourceId]),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.execution_offer_outcomes x JOIN kauro.execution_offers o USING (offer_id) JOIN kauro.outbound_execution_attempts a USING (attempt_id) WHERE a.source_id = $1", [src.sourceId]),
    q<{ kind: string; state: string }>("SELECT kind, state FROM kauro.bank_review_cases WHERE source_id = $1 OR attempt_id IN (SELECT attempt_id FROM kauro.outbound_execution_attempts WHERE source_id = $1) ORDER BY opened_at, kind", [src.sourceId]),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.bank_source_freezes WHERE source_id = $1", [src.sourceId]),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.refund_destinations WHERE refund_id::text = $1 OR treasury_refund_id::text = $1", [src.refundId]),
    q<{ event_type: string }>("SELECT event_type FROM kauro.domain_events WHERE aggregate_id::text = ANY($1::text[]) ORDER BY sequence", [ids]),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE e.aggregate_id::text = ANY($1::text[])", [ids]),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.command_journal WHERE resource_id::text = ANY($1::text[])", [ids]),
    q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.ledger_entries l JOIN kauro.domain_events e ON e.event_id = l.domain_event_id WHERE e.aggregate_id::text = ANY($1::text[])", [ids]),
  ]);
  return {
    refund: await refundOf(src),
    attempts: att.map((a) => [a.kind, a.state, a.amount_cents, a.bank_execution_id] as const),
    offers: Number(off[0]!.n),
    outcomes: Number(out[0]!.n),
    cases: cases.map((c) => [c.kind, c.state] as const),
    freezes: Number(fr[0]!.n),
    destinations: Number(dest[0]!.n),
    events: ev.map((e) => e.event_type),
    outbox: Number(ob[0]!.n),
    journal: Number(jr[0]!.n),
    ledgerLines: Number(ll[0]!.n),
  };
}

/** Outbound sends Kauro itself made for a source: provider refund dispatches at the CONTRACT_FAKE (CMD033's executor). */
export function providerRefundSends(): number {
  return L().iw.pw.paypal.effects.refunds;
}

// --- people for revocation cells ----------------------------------------------------------------------------------------------------

/** A fresh corporate owner with its own revocable KAURO_OWNER grant. */
export async function ownOwner(label: string): Promise<{ readonly person: Person; readonly grantId: string }> {
  const { iw } = L();
  const person = await iw.w.person(`${safe(label)}-owner`);
  const grantId = await iw.h.grantKauroOwner(person.userId as UserId);
  return { person, grantId };
}

// --- RED-FIRST: the cells of a slice not built yet (PV1-REFUND coordinator plan 2026-10-13) ------------------------------------------------
// Each is skipped with a todo naming its slice or the seam it depends on, so no red cell reaches main and none is skipped silently; the
// slice that builds a step removes its entries. First match wins (the specific seams before the step labels).
const RED_FIRST: ReadonlyArray<readonly [RegExp, string]> = [
  [/ RFG-M-(DEST-SI2|NX-SI2-CORR)\b/, "todo: seam SI2 (statement import)"],
  [/ RFG-M-LOCK-L1 /, "todo: seams S5 (G6 credit reversal) + SI2 (statement import)"],
  [/ ACH-M-G6-/, "todo: seam S5 (bankWorld.reverseCredit, the G6 Kreversal entry point)"],
  [/ ACH-M-FC-G5 /, "todo: red-first, slice 3 (X4 resend) + seam SI2 (statement import)"],
  [/^ACH-16 /, "todo: red-first, slice 3 (X4 resend, P3 booking) + seam S5 (credit reversal)"],
  [/^ACH-15 /, "todo: red-first, slices 2-3 (G2 record, X4 resend)"],
  [/ ACH-M-G4-/, "todo: red-first, slice 3 (G4 records a RESEND attempt, declared only by X4)"],
  [/ ACH-M-G3-/, "todo: red-first, slice 3 (G3 record return bounce)"],
  [/ ACH-M-P3-/, "todo: red-first, slice 3 (the FINANCE return-booking queue); its REVOCATION also seam S7"],
  [/^GAP PRODUCTION-BANK-BINDING /, "todo: GAP slice 4 (startApi binds no destination fingerprinter nor credit classifier: a deploy answers 503 EVIDENCE_UNAVAILABLE to every owner refund approval)"],
  [/ RFG-M-X1-REVOCATION-SESSION /, "todo: GAP session fence: the owner commands run in SERVICE units of kauro_payment, which take no lock on the caller's web session (rule 16); a session revoked while X1 waits at L1 is not refused"],
  [/ RFG-M-(X1-RACE|LOCK-L3) /, "todo: seam S5 (bankWorld.reverseCredit, the G6 Kreversal racing the declaration)"],
  [/RFG-P-DEST-RECIPIENT|RFG-M-DEST-RECIPIENT /, "todo: GAP seam S4 (bankWorld.storeRecipientRecord, the DP-RECIPIENT proof is not offered)"],
  [/^(NEVER-RESEND:|RFG-03 |RFG-04 )/, "todo: red-first, slice 3 (X3 resolution, X4 resend, the owner queue)"],
  [/ RFG-M-NR-/, "todo: red-first, slice 3 (NEVER-RESEND at every entry point: X3, X4)"],
  [/ RFG-M-X3-|: Resolve uncertain execution|RFG-M-OFFER-OUTCOME-/, "todo: red-first, slice 3 (X3 resolve uncertain execution)"],
  [/ RFG-M-X4-|: Declare a resend execution| RFG-P-DF-(EQUIV|FULLWIDTH|HYPHEN|UNICODE-DIGITS-EVIDENCE)/, "todo: red-first, slices 2-3 (X1 and X4 bind the destination)"],
  [/\[RFG-M-X2-RACE\]/, "todo: red-first, slice 4 (the RETURN leg asserts the one refund.completed.v1)"],
  [/\[RFG-M-X2-REVOCATION\]/,"todo: red-first, slice 3 (the revoked owner's X3 NOT_EXECUTED)"],
  [/ RFG-M-X2-/, "todo: red-first, slice 3 (every leg: RESEND attempts, declared only by X4)"],
  [/ RFG-M-G2D-RACE /, "todo: seam SI2 (the statement import links the same debit G2 records)"],
  [/ RFG-M-OFFER-| RFG-P-OFFER-GATE-/, "todo: red-first, slice 3 (the offer cells loop RESEND attempts (X4, G3) and X3 RESOLVE_EXECUTED)"],
  [/ RFG-P-(E-ID|E-AMT|E-TIME|E-DEST-UNPROVEN|E-DEST-CONFLICT|E-REF-CONFLICT|E-ALL|DEST-SAME-LAST4|DEST-ROUTING|DEST-NAME|DEST-ABSENT|DEST-PARTIAL-ONLY|DEST-FULL|DF-KEY-VERSION|DF-INVALID-EVIDENCE|DF-CONCAT-COLLISION) /, "todo: red-first, slice 3 (every leg: RESEND attempts (X4) and X3 RESOLVE_EXECUTED; the RETURN x RECORD legs run now as their own cell)"],
];

/** node:test `test`, skipping (with its todo) a cell of a slice not built yet. */
export function laneTest(title: string, fn: () => Promise<void>): void {
  const hit = RED_FIRST.find(([re]) => re.test(title));
  nodeTest(title, hit === undefined ? {} : { skip: hit[1] }, fn);
}

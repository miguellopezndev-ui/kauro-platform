// B12 lane L-SEND test adapter (plan docs/design/B12-outreach-plan.md rev 4 §L, §M, §W, CMD063, Dispatcher; companion §R sender routes).
// The ONE file of the L-SEND tests that names lane K1's kit (apps/api/test/outreach-support.ts, ContractFakeGmailSend/Resend, the
// dispatcher and the B12 routes K1 stubs NOT_BUILT): K1 is imported by name (raceAtWrite, tokenFromSentMime); the L-SEND world is a builder seam (b12-send-world.ts). Every K1
// symbol relied on is listed in K1_SYMBOLS. The row readers are the superuser's plain SELECTs over the 0082 tables (K1's names on b12/kit
// 71dba57d: outreach_send_intents, outreach_drafts, sales_activities, outreach_send_evidence, outreach_provider_warnings, outbox_records).
//
// Rules applied here (docs/design/FAILURE-MATRIX-TEMPLATE.md):
//  - 24/24a: a race cell runs `raceAtWrite` in BOTH orders; its control (KAURO_B12_CONTROL=<cell id>) removes the cell's WHOLE serializer
//    set (acquisition and T2 assertion) and every co-guard the §M row lists, from both actors, everything else unchanged; the body asserts
//    the forbidden effect FIRST and the observed block LAST, so under the control the failing assertion is the forbidden effect.
//  - 24b: actors act only with what was emitted to them: ids from API answers, opt-out tokens only from the MIME the Gmail fake recorded
//    (`tokenFromSentMime`, which throws for an intent the fake never received).
//  - 24c: a control names every guard that refuses the same input (CELL_CONTROLS lists the co-guards per §M row).
//  - 15/25: an expiry cell holds the judgment's LAST await (§W) while the controlled effect clock crosses the deadline, inside
//    ctx.operation, so the crossing is consumed by the unit's own effect_now read; never a real-time margin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Client } from "pg";
import { isOutreachBusinessInstant } from "@kauro/application";
import { connectionPid, runCell, type FaultContext, type FaultKind, type HarnessConnection, type StepClock } from "@kauro/persistence/testing";
import type { SqlStep } from "./fault-support.js";
import type { Reply } from "./support.js";
import type { ContractFakeGmailSend } from "@kauro/application/testing";
// K1 (lane K1, b12/kit fa6a2bb8..b2369118): the only import of the kit by L-SEND tests.
import { raceAtWrite as k1RaceAtWrite, tokenFromSentMime } from "./outreach-support.js";

/** Every K1 symbol the L-SEND tests rely on (through this adapter only), then the seams the L-SEND builder delivers. */
export const K1_SYMBOLS = [
  "K1 outreach-support.ts raceAtWrite({oracle, first: {run, reached, release, pid}, second: {run, pid}}) -> {outcome blocked|settled, first, second: PromiseSettledResult}",
  "K1 outreach-support.ts tokenFromSentMime(ContractFakeGmailSend, intentId) (throws for an intent the fake never received)",
  "K1 @kauro/application/testing ContractFakeGmailSend (calls, events, script, hold, callsOf, sentMime, lateAnswerOf) and ContractFakeResend; OutreachSubmitAnswer ACCEPTED|REJECTED|WARNING|UNKNOWN (ports.ts:23)",
  "K1 packages/persistence/test/b12-outreach-support.ts:421 withoutGuards(world, guards, fn) (the co-guard half of the §M control)",
  "K1 0082 tables, OutreachLocks/holdOutreachLease (packages/persistence/src/outreach-access.ts), NOT_BUILT route stubs",
  "SEAM (L-SEND builder) apps/api/test/b12-send-world.ts sendWorldOf(label): SendWorld below, incl. withoutSerializers(control, fn) (lock acquisition + T2 assertion removed, co-guards via withoutGuards)",
  "SEAM dispatcher (apps/api/src/outreach/dispatcher.ts, lease OUTBOX_DISPATCH b12-outreach-dispatcher): pass, dispatch(intentId), claim (D2), submit (D3), record (D4), recover (D5), takeOver, fence; every unit claims the lease when it holds none (takeover only once expired)",
  "SEAM world.freshResource(label), draft(..., {resource}), metrics(actor, personUserId) (GetOutreachMetrics, L-ACT), routes.suppress (L8 X), routes.reinstatePolicy",
  "SEAM fault-support.ts RouteRole append 'kauro_outreach'",
  "0082 tables/columns: outreach_send_intents(state, outcome_reason, counted_at, submitted_at, uncertain_after, claim_fence, answered_fence, provider_message_ref, payload_hash, authorization_id, person_user_id, prospect_id, draft_id, purpose, route), outreach_drafts(state, version, content_hash), sales_activities(kind, intent_id), outreach_send_evidence(intent_id, fence, status, http_status, provider_ref), outreach_provider_warnings(intent_id, person_user_id, status), outbox_records via domain_events(aggregate_id = intent id, event_type outreach.send_intended.v1)",
] as const;

// --- policy outreach v1 (D-B12O-20) ---------------------------------------------------------------------------------------------------
export const START_GATE_MS = 5_000;
export const CALL_BOUND_MS = 30_000;
export const MARGIN_MS = 2_000;
export const D4_GRACE_MS = 60_000;
export const LEASE_TTL_MS = 120_000;
/** uncertain_after = submitted_at + startGate + callBound + margin (§W). */
export const UNCERTAIN_AFTER_MS = START_GATE_MS + CALL_BOUND_MS + MARGIN_MS;
export const DAY_MS = 86_400_000;
export const US = 0.001; // one microsecond in ms (instants are microsecond-exact on the server; the adapter formats them with 6 digits)

/**
 * The base instant of the send cells: a Thursday 15:00Z (10:00 in Bogota and in New York) whose following fourteen days are business days in both
 * calendars (A10, outreach calendar of the application), the first such Thursday at least nine days after the real clock. The cells place the
 * labelled TEST CLOCK and the controlled clock at instants around it, and both only move forward from the real clock: a literal calendar
 * instant is a time bomb (the one this replaces was overtaken on 2026-10-16), so the base is computed from the clock the run starts at.
 */
export const T0 = ((): string => {
  const DAY = 86_400_000;
  const from = Date.now() + 9 * DAY;
  const d = new Date(from);
  d.setUTCHours(15, 0, 0, 0);
  for (let n = 0; n < 800; n++, d.setTime(d.getTime() + DAY)) {
    if (d.getTime() < from || d.getUTCDay() !== 4) continue;
    let clean = true;
    for (let k = 0; k <= 14 && clean; k++) {
      const day = new Date(d.getTime() + k * DAY);
      const weekday = day.getUTCDay() !== 0 && day.getUTCDay() !== 6;
      if (weekday && isOutreachBusinessInstant(day) !== true) clean = false;
    }
    // GAP-SE-19 places a new sequence at T0 + 90 days (a Wednesday): a business instant in both zones too
    if (clean && isOutreachBusinessInstant(new Date(d.getTime() + 90 * DAY)) === true) return `${d.toISOString().slice(0, 19)}.000000Z`;
  }
  throw new Error("no clean business Thursday in the outreach calendar's years: the calendar needs its next edition");
})();

export const plusMs = (at: string, ms: number): string => usInstant(epochUs(at) + Math.round(ms * 1000));
export const plusUs = (at: string, us: number): string => usInstant(epochUs(at) + us);
/** Microseconds since the epoch of an ISO instant with up to 6 fraction digits. */
export function epochUs(at: string): number {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(at);
  if (m === null) throw new RangeError(`not a UTC instant: ${at}`);
  return Date.parse(`${m[1]}Z`) * 1000 + Number((m[2] ?? "").padEnd(6, "0"));
}
export function usInstant(us: number): string {
  const sec = Math.floor(us / 1_000_000);
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}.${String(us - sec * 1_000_000).padStart(6, "0")}Z`;
}
/** Epoch ms of an instant (the controlled clock's unit; cells that cross a deadline while a unit waits use whole ms). */
export const msOf = (at: string): number => Math.floor(epochUs(at) / 1000);

// --- states (A2, A2b) -------------------------------------------------------------------------------------------------------------------
export type IntentState = "QUEUED" | "SUBMITTING" | "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN" | "OBSERVED_SENT" | "OBSERVED_NOT_SENT" | "NOT_SENT" | "CANCELLED";
export type DraftState = "DRAFT" | "AUTHORIZED" | "SUBMITTING" | "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN" | "BOUNCED" | "REPLIED" | "SUPPRESSED" | "CANCELLED";
export type Purpose = "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP" | "REQUESTED_REPLY";
export type SenderRoute = "GMAIL_API" | "RESEND_TRANSACTIONAL";
export const COUNTED: ReadonlyArray<IntentState> = ["QUEUED", "SUBMITTING", "PROVIDER_ACCEPTED", "SEND_UNCERTAIN", "OBSERVED_SENT"];

// --- problem outcomes (codes KC028-037, KC016 reused; "<status> <code> <reason>" as support.ts outcome) --------------------------------
export const OUTCOME = {
  KC016: "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED",
  DRAFT_CLOSED: "409 PRECONDITION_FAILED DRAFT_CLOSED",
  KC028: "409 PRECONDITION_FAILED OUTREACH_ROUTE_FORBIDDEN",
  KC029: "409 PRECONDITION_FAILED SEND_UNCERTAIN_UNRESOLVED",
  KC030: "409 PRECONDITION_FAILED OUTREACH_GRANT_INVALID",
  KC031: "409 PRECONDITION_FAILED SENDER_NOT_VERIFIED",
  KC032: "409 PRECONDITION_FAILED OUTREACH_CAP_REACHED",
  KC033: "409 PRECONDITION_FAILED RESOURCE_NOT_CURRENT",
  KC034: "409 PRECONDITION_FAILED OUTREACH_PAUSED",
  KC036: "409 PRECONDITION_FAILED OUTREACH_ALREADY_SENT",
  KC037: "503 CAPACITY_UNAVAILABLE OUTREACH_CALENDAR_UNAVAILABLE",
  SENDER_REVOKED: "409 PRECONDITION_FAILED SENDER_REVOKED",
  JURISDICTION: "409 PRECONDITION_FAILED OUTREACH_JURISDICTION_UNREVIEWED",
  COMPLIANCE: "503 CAPACITY_UNAVAILABLE OUTREACH_COMPLIANCE_UNCONFIGURED",
  STALE: "409 STALE_VERSION -",
  KEY_REUSED: "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS",
  FORBIDDEN: "403 FORBIDDEN NOT_AUTHORIZED",
  TIMEOUT: "503 CAPACITY_UNAVAILABLE -",
} as const;

// --- the world K1 builds (shape relied on; K1 names it) ---------------------------------------------------------------------------------
export interface Person {
  readonly userId: string;
  readonly token: string;
}
export interface SellerP extends Person {
  readonly sellerId: string;
  /** Its verified GMAIL_API identity (registered and verified through the owner's routes). */
  readonly sender: SenderP;
}
export interface SenderP {
  readonly senderId: string;
  readonly userId: string;
  readonly route: SenderRoute;
  readonly address: string;
}
export interface ProspectP {
  readonly prospectId: string;
  readonly contactKey: string;
  readonly organizationKey: string;
  readonly sellerId: string | null;
}
export interface ResourceP {
  readonly resourceId: string;
  readonly familyId: string;
  readonly capabilityId: string;
}
export interface DraftP {
  readonly draftId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly contentRef: string;
  readonly prospect: ProspectP;
  readonly sender: SenderP;
  readonly purpose: Purpose;
}
export interface GrantP {
  readonly authorizationId: string;
  readonly senderId: string;
  readonly maximumSends: number;
  readonly validFrom: string;
  readonly expiresAt: string;
}
/** What the Gmail fake answers one submission (GmailSendPort closed set, companion §T). */
export type GmailAnswer =
  | { readonly kind: "ACCEPTED"; readonly ref?: string }
  | { readonly kind: "ACCEPTED_ANSWER_LOST" }
  | { readonly kind: "AUTH_REVOKED" }
  | { readonly kind: "REJECTED_DEFINITIVE"; readonly status: number }
  | { readonly kind: "NOT_ATTEMPTED" }
  | { readonly kind: "HTTP_5XX"; readonly status: number }
  | { readonly kind: "RESET" }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "UNKNOWN" };
export interface GmailSubmission {
  readonly intentId: string | null;
  readonly senderId: string;
  readonly mime: string;
  readonly payloadHash: string;
  readonly answered: GmailAnswer["kind"] | "HELD" | "ABORTED";
}
export interface HeldCall {
  /** Resolves once the dispatcher's call reached the fake (the submission is recorded). */
  readonly reached: Promise<GmailSubmission>;
  /** Answers the held call now (a late answer when the dispatcher's lease moved meanwhile). */
  answer(a: GmailAnswer): void;
  /** Resolves when the dispatcher's AbortSignal fired on this call (recorded by the fake). */
  readonly aborted: Promise<void>;
}
export interface GmailFake {
  readonly submissions: ReadonlyArray<GmailSubmission>;
  /** The next answers, in order (default ACCEPTED with a fresh ref). */
  script(...answers: GmailAnswer[]): void;
  /** Holds the next call open until `answer` or the dispatcher's abort. */
  holdNext(): HeldCall;
}
export interface ResendFake {
  readonly calls: ReadonlyArray<{ readonly to: string; readonly payloadHash: string }>;
}
/** D3's classified answer (plan A3; D-B12O-11): what D4 records. */
export type ClassifiedAnswer =
  | { readonly kind: "ACCEPTED"; readonly ref: string }
  | { readonly kind: "AUTH_REVOKED" }
  | { readonly kind: "REJECTED_DEFINITIVE"; readonly status: 400 | 403 | 413 | 429 }
  | { readonly kind: "NOT_ATTEMPTED" }
  | { readonly kind: "UNCERTAIN"; readonly cause: string };
export interface DispatchReport {
  readonly intentId: string;
  /** D2's verdict (admitted, refused with reason, deferred) and the D4 outcome. */
  readonly outcome: string;
}
export interface Dispatcher {
  readonly name: string;
  /** D1 + every due record D2 -> D3 -> D4, units sequential (one intent at a time), then D5. */
  pass(): Promise<ReadonlyArray<DispatchReport>>;
  /** D2 -> D3 -> D4 of the one intent's outbox record. */
  dispatch(intentId: string): Promise<DispatchReport>;
  /** D2 alone (the claim unit): "ADMITTED", "DEFERRED" (repeat grace: intent QUEUED, outbox RETRYABLE) or "<STATE>(<REASON>)" of its refusal. */
  claim(intentId: string): Promise<string>;
  /** D3 alone (gate statement, then the port call bounded by AbortSignal.timeout(callBound)): the classified answer. */
  submit(intentId: string): Promise<ClassifiedAnswer>;
  /** D4 alone (the outcome unit under this dispatcher's fence; the evidence path when its edge is not admissible): what it recorded. */
  record(intentId: string, answer: ClassifiedAnswer): Promise<string>;
  /** D5 recovery only. */
  recover(): Promise<ReadonlyArray<string>>;
  /** This dispatcher's lease fence (null before its first claim). */
  readonly fence: number | null;
  /** claim_lease OUTBOX_DISPATCH (a takeover once the holder's lease expired): the new fence. */
  takeOver(): Promise<number>;
}
export interface ComplianceConfig {
  readonly postalAddress: string;
  readonly optOutOrigin: string;
  readonly commercialIdentification: string;
}
export interface SendWorld {
  readonly oracle: Client;
  readonly owner: Person;
  readonly gmail: GmailFake;
  readonly resend: ResendFake;
  readonly compliance: ComplianceConfig;
  stop(): Promise<void>;
  /** Every unit's effect clock stands at the instant (null: the unit's own). */
  standAt(at: string | null): void;
  /** The cell operation's step clock: every unit positions its transaction on it while set (fault-support FaultRouting.clock). */
  bindClock(clock: StepClock | null): void;
  /** Sets or removes the deployment compliance configuration (postal address, opt-out origin); returns the restore. */
  setCompliance(config: ComplianceConfig | null): () => void;
  /** An ACTIVE seller with its verified GMAIL_API identity (owner routes RegisterSenderIdentity + VerifySenderIdentity). */
  seller(label: string): Promise<SellerP>;
  agencyMember(label: string): Promise<Person>;
  /** A US prospect registered by (and assigned to) the seller, with one recorded contact and its source evidence. */
  prospect(seller: SellerP, options?: { readonly contact?: string; readonly organization?: string; readonly jurisdiction?: string }): Promise<ProspectP>;
  /** A further identity of the person (route default GMAIL_API), registered and (unless pending) verified. */
  sender(person: Person, options?: { readonly route?: SenderRoute; readonly pending?: true }): Promise<SenderP>;
  /** The CURRENT resource every default draft cites, its family and the capability it claims. */
  readonly resource: ResourceP;
  /** CMD061 (L-DRAFT route) as the author. */
  draft(author: Person, prospect: ProspectP, sender: SenderP, options?: { readonly purpose?: Purpose; readonly label?: string; readonly resource?: ResourceP; readonly contentRef?: string }): Promise<DraftP>;
  /** A CURRENT resource of a fresh family and fresh capability (CMD059 / Publish cells suspend or supersede only their own). */
  freshResource(label: string): Promise<ResourceP>;
  /** GetOutreachMetrics of the person (L-ACT route) as the actor reads it. */
  metrics(actor: Person, personUserId: string): Promise<{ readonly pauseNumerator: number; readonly pauseDenominator: number; readonly paused: boolean; readonly accepted: number; readonly uncertain: number; readonly bounced: number }>;
  /** PrepareOutreachReview + CMD062 (L-AUTH routes) by the owner with a fresh step-up. */
  grant(drafts: ReadonlyArray<DraftP>, options?: { readonly maximumSends?: number; readonly validFrom?: string; readonly expiresAt?: string }): Promise<GrantP>;
  call(c: { readonly method?: "POST" | "GET"; readonly url: string; readonly token: string | null; readonly key?: string | null; readonly body?: unknown }): Promise<Reply>;
  outcome(reply: Reply): string;
  /** The sub-reason a KC032 problem names (FIRST_NOT_SENT, CADENCE_CLOSED, CAP_REACHED, OUTSIDE_BUSINESS_DAY). */
  subReason(reply: Reply): string | null;
  dispatcher(name?: string): Dispatcher;
  /** A test connection of the login (raceAtWrite actors, lease holders); "superuser" for advisory subject holds. */
  open(login: "kauro_app_test" | "kauro_outreach_test" | "kauro_control_test" | "superuser"): Promise<HarnessConnection>;
  /** fn with every unit it opens routed over conn (fault-support FaultRouting.on): points ctx.points, steps instrumented, unit `target` crashable. */
  on<T>(conn: HarnessConnection, role: "kauro_app" | "kauro_outreach" | "kauro_control", ctx: FaultContext, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing?: { readonly target?: number }): Promise<T>;
  /** The routed units' statement_timeout (null: the harness race allowance). */
  setStatementTimeout(ms: number | null): void;
  /** The OUTBOX_DISPATCH lease resource id (v5 UUID "b12-outreach-dispatcher"). */
  readonly leaseResourceId: string;
  /** The draft's subject and body as CMD061 stored them (content ref). */
  contentOf(d: DraftP): Promise<{ readonly subject: string; readonly body: string }>;
  /** The ContractFakeGmailSend instance (K1) behind `gmail` (tokenOf reads its recorded MIME). */
  readonly gmailContract: ContractFakeGmailSend;
  /** The start of a cell: no dispatcher of an earlier cell stays known and the dispatch lease row is free (a second owner would find it HELD). */
  beginCell(): Promise<void>;
  /** The internal errors the api recorded (a routed unit that failed at a fault point answers 500; ctx.partial needs the error itself). */
  readonly internalErrors: ReadonlyArray<{ readonly error: unknown }>;
  /**
   * The §M control (rule 24a/24c): fn with the cell's WHOLE serializer set removed from both actors (each lock's acquisition and its T2
   * assertion) and every listed co-guard dropped (K1 withoutGuards, b12-outreach-support.ts:421), everything else unchanged.
   */
  withoutSerializers<T>(control: Control, fn: () => Promise<T>): Promise<T>;
  /** The routes of the other lanes a race actor or a precondition needs (through their real handlers). */
  readonly routes: {
    revokeGrant(g: GrantP, key?: string): Promise<Reply>;
    terminate(seller: SellerP, key?: string): Promise<Reply>;
    suspendCapability(capabilityId: string, key?: string): Promise<Reply>;
    publishResource(familyId: string, key?: string): Promise<Reply>;
    withdrawPolicy(jurisdiction: string, purpose: Purpose, key?: string): Promise<Reply>;
    registerSender(body: { readonly userId: string; readonly address: string; readonly route: SenderRoute; readonly consentEvidenceRef?: string; readonly consentValidUntil?: string }, options?: { readonly token?: string; readonly key?: string }): Promise<Reply>;
    verifySender(senderId: string, key?: string): Promise<Reply>;
    revokeSender(senderId: string, key?: string): Promise<Reply>;
    recordActivity(actor: Person, activity: Record<string, unknown>, key?: string): Promise<Reply>;
    optOut(token: string): Promise<Reply>;
    diagnose(personUserId: string, key?: string): Promise<Reply>;
    review(drafts: ReadonlyArray<DraftP>, key?: string): Promise<Reply>;
    suppress(target: { readonly contactKey: string } | { readonly domain: string }): Promise<void>;
    /** The next reviewed version of the withdrawn policy, IN_FORCE (a fixture: no route names it); throws unless the latest version reads IN_FORCE. */
    reinstatePolicy(jurisdiction: string, purpose: Purpose): Promise<void>;
  };
}

/**
 * The L-SEND world is NOT part of K1's kit (K1 ships raceAtWrite, tokenFromSentMime, mimeHeader, the contract fakes and withoutGuards):
 * the lane's builder delivers it as apps/api/test/b12-send-world.ts exporting `sendWorldOf(label): Promise<SendWorld>` (composition with
 * the contract fakes, the dispatcher units, the other lanes' routes, and `withoutSerializers`, the §M control built on K1's withoutGuards).
 * Loaded by a computed specifier so these files type-check before it exists; until then every title fails at its world.
 */
const WORLD_MODULE: string = "./b12-send-world.js";
interface WorldModule {
  sendWorldOf(label: string): Promise<SendWorld>;
}

let current: SendWorld | null = null;
/** A fresh L-SEND world (its own database, lease row and fakes); it becomes the world the race harness observes. */
export async function sendWorld(label: string): Promise<SendWorld> {
  const m = (await import(WORLD_MODULE)) as WorldModule;
  const w = await m.sendWorldOf(label);
  current = w;
  return w;
}
/** Makes `w` the world the race harness observes again (a cell that ran in a world of its own restores the file's world). */
export function activate(w: SendWorld): void {
  current = w;
}

/** The advisory subject kinds of §L (K1 b12-outreach-support.ts L map). */
export const SUBJECT: Readonly<Partial<Record<LockName, string>>> = {
  L3: "kauro.outreach_prospects",
  L4: "kauro.outreach_person_caps",
  L4g: "kauro.outreach_authorizations",
  L6: "kauro.sales_resources",
  L6p: "kauro.outreach_channel_policies",
  L7: "kauro.sender_identities",
  L8: "kauro.prospect_suppressions",
  L10: "kauro.outreach_drafts",
};
export interface Hold {
  readonly conn: HarnessConnection;
  release(): Promise<void>;
}
/** A test connection holding the advisory subject (X or S) in an open transaction: the §W holder of an expiry or timeout cell. */
export async function holdSubject(w: SendWorld, lock: LockName, subject: string, mode: "X" | "S" = "X"): Promise<Hold> {
  const kind = SUBJECT[lock];
  if (kind === undefined) throw new Error(`no advisory subject for ${lock}`);
  const conn = await w.open("superuser");
  await conn.query("BEGIN");
  await conn.query(mode === "X" ? "SELECT pg_advisory_xact_lock(kauro.transition_key($1, $2))" : "SELECT pg_advisory_xact_lock_shared(kauro.transition_key($1, $2))", [kind, subject]);
  return {
    conn,
    release: async () => {
      await conn.query("ROLLBACK");
      await conn.end();
    },
  };
}
/** kauro_control_test holding the OUTBOX_DISPATCH lease row FOR UPDATE (the L13 holder of §W D2/D5 rows). */
export async function holdLease(w: SendWorld): Promise<Hold> {
  const conn = await w.open("kauro_control_test");
  await conn.query("BEGIN");
  const r = await conn.query("SELECT fence FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1 FOR UPDATE", [w.leaseResourceId]);
  assert.equal(r.rowCount, 1, "the dispatcher's lease row exists (held FOR UPDATE)");
  return {
    conn,
    release: async () => {
      await conn.query("ROLLBACK");
      await conn.end();
    },
  };
}
/** The unit (CMD063 route or a dispatcher unit) on a fresh connection of its login, observed waiting on the holder (ctx.mustWait). */
export async function waitingBehind<T>(ctx: FaultContext, w: SendWorld, holder: Hold, role: "kauro_app" | "kauro_outreach", what: string, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = []): Promise<{ readonly pending: Promise<T> }> {
  const conn = await w.open(role === "kauro_app" ? "kauro_app_test" : "kauro_outreach_test");
  const waiting = await ctx.mustWait(w.oracle, { waiter: conn, holder: connectionPid(holder.conn) }, () => w.on(conn, role, ctx, steps, fn), what);
  // mustWait settles to a PromiseSettledResult: the operation's own answer (or its failure) is what the cell awaits
  return {
    pending: (waiting.pending as Promise<PromiseSettledResult<T>>)
      .then((r) => {
        if (r.status === "rejected") throw r.reason;
        return r.value;
      })
      .finally(() => conn.end()),
  };
}

// --- locks and co-guards (§L) -----------------------------------------------------------------------------------------------------------
export type LockName = "L1" | "L2" | "L3" | "L4" | "L4g" | "L5" | "L6" | "L6p" | "L7" | "L8" | "L10" | "L13" | "L14";
export type CoGuard = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "U1" | "U2" | "U3" | "U4" | "U5" | "U6" | "U7";
export interface Control {
  readonly locks: ReadonlyArray<LockName>;
  readonly coGuards: ReadonlyArray<CoGuard>;
}
/** §M serializer sets and co-guards, per cell (the control removes exactly these from both actors). */
export const CELL_CONTROLS: Readonly<Record<string, Control>> = {
  M1: { locks: ["L3"], coGuards: [] },
  M2: { locks: ["L4"], coGuards: [] },
  M3: { locks: ["L4"], coGuards: [] },
  M4: { locks: ["L1"], coGuards: [] },
  M4b: { locks: ["L1"], coGuards: [] },
  M5: { locks: ["L1"], coGuards: [] },
  M7: { locks: ["L4g"], coGuards: [] },
  M8: { locks: ["L5"], coGuards: [] },
  M9: { locks: ["L6"], coGuards: [] },
  M10: { locks: ["L6p"], coGuards: [] },
  M11: { locks: ["L6p"], coGuards: [] },
  M12: { locks: ["L7"], coGuards: [] },
  M13: { locks: ["L7"], coGuards: [] },
  M14: { locks: ["L4", "L7"], coGuards: [] },
  M14b: { locks: ["L7"], coGuards: [] },
  M15: { locks: ["L4"], coGuards: [] },
  M16: { locks: ["L3"], coGuards: [] },
  M18: { locks: ["L4"], coGuards: [] },
  M19: { locks: ["L4"], coGuards: [] },
  M20: { locks: ["L4"], coGuards: [] },
  M21: { locks: ["L8"], coGuards: [] },
  M22: { locks: ["L8"], coGuards: [] },
  M23: { locks: ["L8"], coGuards: [] },
  M26: { locks: ["L10"], coGuards: ["T1"] },
  M27: { locks: ["L10"], coGuards: ["T1"] },
  M30: { locks: ["L13"], coGuards: [] },
  M38: { locks: ["L7"], coGuards: ["T6"] },
  M45: { locks: ["L10"], coGuards: [] },
  // §M sweep (rev 4): GAP-RS-3 is a single-member L1 set with no co-guard
  "RS-3": { locks: ["L1"], coGuards: [] },
};
/** The control a run applies: KAURO_B12_CONTROL=<cell> runs that cell with its serializer set and co-guards removed (red-proof leg). */
export function controlOf(cell: string): Control | null {
  const asked = process.env["KAURO_B12_CONTROL"];
  if (asked === undefined || asked !== cell) return null;
  const c = CELL_CONTROLS[cell];
  if (c === undefined) throw new Error(`no §M control for ${cell}`);
  return c;
}
/** M14 (i): the rev-2 lock order (D4 AUTH_REVOKED taking L7 before L4) instead of removing a lock; KAURO_B12_CONTROL=M14-order. */
export const rev2OrderControl = (): boolean => process.env["KAURO_B12_CONTROL"] === "M14-order";

/** An advisory subject of §L (OutreachLocks.take): the statement carries its kind as a parameter, so the step names the kind through `when`. */
function lockStep(label: string, kind: string): SqlStep {
  return { label, match: /pg_advisory_xact_lock(_shared)?\(kauro\.transition_key\(\$1, \$2\)\)/, when: (params) => params[0] === kind };
}

// --- first writes of each actor (the `.before` points raceAtWrite pauses at; §M harness) ---------------------------------------------
export const W = {
  intentInsert: { label: "intent_insert", match: /INSERT INTO kauro\.outreach_send_intents\b/ },
  intentUpdate: { label: "intent_update", match: /UPDATE kauro\.outreach_send_intents\b/ },
  evidenceInsert: { label: "evidence_insert", match: /INSERT INTO kauro\.outreach_send_evidence\b/ },
  d4First: { label: "d4_first", match: /UPDATE kauro\.outreach_send_intents\b|INSERT INTO kauro\.outreach_send_evidence\b/ },
  senderUpdate: { label: "sender_update", match: /UPDATE kauro\.sender_identities\b/ },
  grantRevoke: { label: "grant_revoke", match: /UPDATE kauro\.outreach_authorizations\b/ },
  policyWithdraw: { label: "policy_withdraw", match: /UPDATE kauro\.outreach_channel_policies\b/ },
  resourceSupersede: { label: "resource_supersede", match: /UPDATE kauro\.sales_resources\b/ },
  capabilityUpdate: { label: "capability_update", match: /UPDATE kauro\.capabilities\b/ },
  sellerUpdate: { label: "seller_update", match: /UPDATE kauro\.sellers\b/ },
  activityInsert: { label: "activity_insert", match: /INSERT INTO kauro\.sales_activities\b/ },
  suppressionInsert: { label: "suppression_insert", match: /INSERT INTO kauro\.prospect_suppressions\b/ },
  reviewInsert: { label: "review_insert", match: /INSERT INTO kauro\.outreach_reviews\b/ },
  diagnosisInsert: { label: "diagnosis_insert", match: /INSERT INTO kauro\.outreach_diagnoses\b/ },
  outboxInsert: { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records\b/ },
  draftUpdate: { label: "draft_update", match: /UPDATE kauro\.outreach_drafts\b/ },
  activityAfterIntent: { label: "activity_after", match: /INSERT INTO kauro\.sales_activities\b/ },
  leaseShare: { label: "lease_share", match: /FROM kauro\.leases\b[\s\S]*FOR SHARE/ },
  leaseClaim: { label: "lease_claim", match: /kauro\.claim_lease\(/ },
  personLock: lockStep("person_lock", "kauro.outreach_person_caps"),
  senderLock: lockStep("sender_lock", "kauro.sender_identities"),
  grantLock: lockStep("grant_lock", "kauro.outreach_authorizations"),
  /** D4 on AUTH_REVOKED: its first write is the sender UPDATE (REVOKED) or the intent UPDATE, whichever the unit issues first. */
  d4Revoked: { label: "d4_revoked", match: /UPDATE kauro\.(sender_identities|outreach_send_intents)\b/ },
  /** RegisterSenderIdentity's row INSERT (GAP-RS-1 / GAP-RS-3 pauses). */
  senderInsert: { label: "sender_insert", match: /INSERT INTO kauro\.sender_identities\b/ },
  draftLock: lockStep("draft_lock", "kauro.outreach_drafts"),
} as const satisfies Record<string, SqlStep>;

// --- the race harness (§M; K1 raceAtWrite) ----------------------------------------------------------------------------------------------
export type Settled<T> = { readonly answer: T } | { readonly failure: unknown };
export interface RaceActor<T> {
  readonly name: string;
  readonly role: "kauro_app" | "kauro_outreach" | "kauro_control";
  readonly run: () => Promise<T>;
  /** The first actor's pause: `.before` of this write (or `.after` when `after`); ignored for the second actor. */
  readonly at: SqlStep;
  readonly after?: true;
}
export interface RaceResult<A, B> {
  readonly first: Settled<A>;
  readonly second: Settled<B>;
  /** K1 outcome "blocked": pg_blocking_pids showed the second blocked by the first's pid before the first was released. */
  readonly secondBlocked: boolean;
}
const LOGIN = { kauro_app: "kauro_app_test", kauro_outreach: "kauro_outreach_test", kauro_control: "kauro_control_test" } as const;
const settledOf = <T>(r: PromiseSettledResult<T>): Settled<T> => (r.status === "fulfilled" ? { answer: r.value } : { failure: r.reason });
/**
 * One order of a §M cell on K1's raceAtWrite: the first actor, on its own connection, paused at `db.<label>.before` of its first write (or
 * `.after` when `after`: the write whose trigger takes a member), i.e. once it holds its whole serializer set and judged; the second, on its
 * own connection, run until the oracle sees it blocked by the first's pid or it settles; the first released; both awaited. Under the cell's
 * control (KAURO_B12_CONTROL=<cell>) the world removes the set and its co-guards from both actors for the whole order.
 */
export async function raceAtWrite<A, B>(ctx: FaultContext, cell: string, first: RaceActor<A>, second: RaceActor<B>): Promise<RaceResult<A, B>> {
  const w = current;
  if (w === null) throw new Error("raceAtWrite before sendWorld");
  const control = controlOf(cell);
  const fc = await w.open(LOGIN[first.role]);
  const sc = await w.open(LOGIN[second.role]);
  try {
    const pause = ctx.points.pause(`db.${first.at.label}.${first.after === true ? "after" : "before"}`);
    const order = () =>
      k1RaceAtWrite<A, B>({
        oracle: w.oracle,
        first: {
          run: () => ctx.operation(`${first.name} (first)`, () => w.on(fc, first.role, ctx, [first.at], first.run)),
          reached: pause.reached,
          release: () => pause.release(),
          pid: () => connectionPid(fc),
        },
        // the second runs THROUGH ctx.mustWait (K1 `credit`): the harness observes its wait on the first's backend and credits it, and the first is
        // held until it has (a race cell built on the bare raceAtWrite ends FaultNotInjected even when the race happened)
        second: {
          run: () => Promise.reject(new Error("credit uses runOn")),
          runOn: (client: HarnessConnection) => ctx.operation(`${second.name} (second)`, () => w.on(client, second.role, ctx, [], second.run)),
          waiter: sc,
          pid: () => connectionPid(sc),
        },
        credit: ctx,
        what: `${second.name} waits on ${first.name}`,
      });
    const r = control === null ? await order() : await w.withoutSerializers(control, order);
    return { first: settledOf(r.first), second: settledOf(r.second), secondBlocked: r.outcome === "blocked" };
  } finally {
    await fc.end();
    await sc.end();
  }
}
/** The opt-out token of the intent's first message, from the MIME the Gmail fake recorded (rule 24b; K1 tokenFromSentMime). */
export const tokenOf = (w: SendWorld, intentId: string): string => tokenFromSentMime(w.gmailContract, intentId);
export const answerOf = <T>(s: Settled<T>, what: string): T => {
  if ("failure" in s) throw new assert.AssertionError({ message: `${what} failed: ${String((s.failure as Error)?.message ?? s.failure)}` });
  return s.answer;
};

/** A cell titled verbatim by the plan, run by the common fault harness (runCell asserts the fault was injected). */
export function cell(title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, at?: string): void {
  const id = /^([A-Z0-9-]+[a-z]?)/.exec(title)?.[1] ?? title.slice(0, 16);
  test(title, async () => {
    // the cell's controlled clock starts two days before T0 (default: the real now, which a cell must not be set behind)
    await runCell({ id, step: title.slice(0, 160), fault, ...(at === undefined ? {} : { at }), expect: title }, body, { clockStart: plusMs(T0, -2 * DAY_MS) });
  });
}

/**
 * Runs `fn` inside a cell operation whose step clock every unit positions its transaction on (§W: the unit's effect_now is the controlled
 * clock at its judgment statement), so a crossing made while the unit waits at its last await is consumed by that unit.
 */
export async function onEffectClock<T>(ctx: FaultContext, w: SendWorld, what: string, fn: () => Promise<T>): Promise<T> {
  return ctx.operation(what, async (op) => {
    w.bindClock(op.clock);
    try {
      return await fn();
    } finally {
      w.bindClock(null);
    }
  });
}

// --- row readers (superuser oracle; read only) ------------------------------------------------------------------------------------------
export interface IntentRow {
  readonly intentId: string;
  readonly draftId: string;
  readonly authorizationId: string;
  readonly personUserId: string;
  readonly prospectId: string;
  readonly purpose: Purpose;
  readonly route: SenderRoute;
  readonly state: IntentState;
  readonly reason: string | null;
  readonly providerRef: string | null;
  readonly payloadHash: string;
  readonly countedAt: string;
  readonly submittedAt: string | null;
  readonly uncertainAfter: string | null;
  readonly claimFence: number | null;
}
const INTENT_COLS = `intent_id::text AS "intentId", draft_id::text AS "draftId", authorization_id::text AS "authorizationId", person_user_id::text AS "personUserId",
  prospect_id::text AS "prospectId", purpose, route, state, outcome_reason AS reason, provider_message_ref AS "providerRef", payload_hash AS "payloadHash",
  to_char(counted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "countedAt",
  to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "submittedAt",
  to_char(uncertain_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "uncertainAfter", claim_fence::int AS "claimFence"`;

export async function intentsOfDraft(w: SendWorld, draftId: string): Promise<IntentRow[]> {
  return (await w.oracle.query<IntentRow>(`SELECT ${INTENT_COLS} FROM kauro.outreach_send_intents WHERE draft_id = $1 ORDER BY counted_at, intent_id`, [draftId])).rows;
}
export async function intentsOfProspect(w: SendWorld, prospectId: string): Promise<IntentRow[]> {
  return (await w.oracle.query<IntentRow>(`SELECT ${INTENT_COLS} FROM kauro.outreach_send_intents WHERE prospect_id = $1 ORDER BY counted_at, intent_id`, [prospectId])).rows;
}
export async function intentsOfPerson(w: SendWorld, userId: string): Promise<IntentRow[]> {
  return (await w.oracle.query<IntentRow>(`SELECT ${INTENT_COLS} FROM kauro.outreach_send_intents WHERE person_user_id = $1 ORDER BY counted_at, intent_id`, [userId])).rows;
}
export async function intent(w: SendWorld, intentId: string): Promise<IntentRow> {
  const r = (await w.oracle.query<IntentRow>(`SELECT ${INTENT_COLS} FROM kauro.outreach_send_intents WHERE intent_id = $1`, [intentId])).rows[0];
  assert.ok(r !== undefined, `intent ${intentId} exists`);
  return r;
}
/** The one intent of the draft (asserts there is exactly one). */
export async function onlyIntent(w: SendWorld, d: DraftP): Promise<IntentRow> {
  const rows = await intentsOfDraft(w, d.draftId);
  assert.equal(rows.length, 1, `draft ${d.draftId} has exactly one intent (has ${rows.length}: ${rows.map((r) => r.state).join(", ")})`);
  return rows[0]!;
}
export async function draftRow(w: SendWorld, d: DraftP): Promise<{ readonly state: DraftState; readonly version: number; readonly contentHash: string }> {
  const r = (await w.oracle.query<{ state: DraftState; version: number; contentHash: string }>(`SELECT state, version::int AS version, content_hash AS "contentHash" FROM kauro.outreach_drafts WHERE draft_id = $1`, [d.draftId])).rows[0];
  assert.ok(r !== undefined, `draft ${d.draftId} exists`);
  return r;
}
export const draftState = async (w: SendWorld, d: DraftP): Promise<DraftState> => (await draftRow(w, d)).state;
/** "<STATE>(<REASON>)" of an intent, e.g. "NOT_SENT(SUPPRESSED)"; a state without a reason is the bare state. */
export const stateOf = (i: IntentRow): string => (i.reason === null ? i.state : `${i.state}(${i.reason})`);
export async function activityKinds(w: SendWorld, intentId: string): Promise<string[]> {
  return (await w.oracle.query<{ kind: string }>("SELECT kind FROM kauro.sales_activities WHERE intent_id = $1 ORDER BY recorded_at, activity_id", [intentId])).rows.map((r) => r.kind);
}
export async function evidenceOf(w: SendWorld, intentId: string): Promise<Array<{ fence: number; status: string; httpStatus: number | null; providerRef: string }>> {
  return (
    await w.oracle.query<{ fence: number; status: string; httpStatus: number | null; providerRef: string }>(
      `SELECT fence::int AS fence, status, http_status AS "httpStatus", provider_ref AS "providerRef" FROM kauro.outreach_send_evidence WHERE intent_id = $1 ORDER BY fence`,
      [intentId],
    )
  ).rows;
}
export async function warningsOf(w: SendWorld, userId: string): Promise<Array<{ intentId: string; status: number }>> {
  return (await w.oracle.query<{ intentId: string; status: number }>(`SELECT intent_id::text AS "intentId", status FROM kauro.outreach_provider_warnings WHERE person_user_id = $1 ORDER BY recorded_at`, [userId])).rows;
}
/** The outbox record of the intent's outreach.send_intended.v1 event (state and next attempt). */
export async function outboxOf(w: SendWorld, intentId: string): Promise<Array<{ state: string; attempts: number }>> {
  return (
    await w.oracle.query<{ state: string; attempts: number }>(
      `SELECT o.state, o.attempts FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id
        WHERE e.event_type = 'outreach.send_intended.v1' AND e.aggregate_id = $1 ORDER BY o.created_at`,
      [intentId],
    )
  ).rows;
}
export async function journalStates(w: SendWorld, key: string): Promise<string[]> {
  return (await w.oracle.query<{ state: string }>("SELECT state FROM kauro.command_journal WHERE operation = 'CMD063' AND idempotency_key = $1", [key])).rows.map((r) => r.state);
}
export async function sendIntendedEvents(w: SendWorld, draftId: string): Promise<number> {
  const r = await w.oracle.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kauro.domain_events e JOIN kauro.outreach_send_intents i ON i.intent_id = e.aggregate_id WHERE e.event_type = 'outreach.send_intended.v1' AND i.draft_id = $1`,
    [draftId],
  );
  return r.rows[0]!.n;
}
/** A2/§G: COUNTED intents of the grant (COUNTED states, or any state with an ACCEPTED evidence row). */
export async function grantReserved(w: SendWorld, g: GrantP): Promise<number> {
  const r = await w.oracle.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kauro.outreach_send_intents i WHERE i.authorization_id = $1
       AND (i.state = ANY($2::text[]) OR EXISTS (SELECT 1 FROM kauro.outreach_send_evidence v WHERE v.intent_id = i.intent_id AND v.status = 'ACCEPTED'))`,
    [g.authorizationId, COUNTED],
  );
  return r.rows[0]!.n;
}
/** A10: COUNTED first contacts of the person with counted_at in (at - 24 h, at]. */
export async function firstContacts24h(w: SendWorld, userId: string, at: string): Promise<number> {
  const r = await w.oracle.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kauro.outreach_send_intents i WHERE i.person_user_id = $1 AND i.purpose = 'INDIVIDUAL_PROSPECT_CONTACT'
       AND i.counted_at > $3::timestamptz - interval '24 hours' AND i.counted_at <= $3::timestamptz
       AND (i.state = ANY($2::text[]) OR EXISTS (SELECT 1 FROM kauro.outreach_send_evidence v WHERE v.intent_id = i.intent_id AND v.status = 'ACCEPTED'))`,
    [userId, COUNTED, at],
  );
  return r.rows[0]!.n;
}
export async function senderState(w: SendWorld, senderId: string): Promise<string> {
  const r = (await w.oracle.query<{ state: string }>("SELECT state FROM kauro.sender_identities WHERE sender_id = $1", [senderId])).rows[0];
  assert.ok(r !== undefined, `sender ${senderId} exists`);
  return r.state;
}
export async function sendersAt(w: SendWorld, address: string): Promise<number> {
  return (await w.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.sender_identities WHERE lower(address) = lower($1)", [address])).rows[0]!.n;
}
export async function prospectState(w: SendWorld, p: ProspectP): Promise<string> {
  return (await w.oracle.query<{ state: string }>("SELECT state FROM kauro.prospects WHERE prospect_id = $1", [p.prospectId])).rows[0]!.state;
}

/** Provider calls the fake recorded for the intent (submissions), and in total for the person's identities. */
export const callsOf = (w: SendWorld, intentId: string): number => w.gmail.submissions.filter((s) => s.intentId === intentId).length;
export const callsTotal = (w: SendWorld): number => w.gmail.submissions.length;
export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// --- CMD063 (the lane's route) ----------------------------------------------------------------------------------------------------------
export const sendUrl = (draftId: string): string => `/api/v1/ops/outreach/${draftId}/send`;
export interface SendOptions {
  readonly key?: string;
  readonly expectedVersion?: number;
  readonly contentHash?: string;
  readonly authorizationId?: string;
}
export function send(w: SendWorld, actor: Person, d: DraftP, g: GrantP, options: SendOptions = {}): Promise<Reply> {
  return w.call({
    url: sendUrl(d.draftId),
    token: actor.token,
    key: options.key ?? `cmd063-${d.draftId.slice(-12)}-${Math.random().toString(36).slice(2, 12)}`,
    body: { expectedVersion: options.expectedVersion ?? d.version, authorizationId: options.authorizationId ?? g.authorizationId, contentHash: options.contentHash ?? d.contentHash },
  });
}
/** The intent id a 200 CMD063 answered (ids only from API answers, rule 24b). */
export function intentIdOf(reply: Reply): string {
  assert.equal(reply.status, 200, `CMD063 answered ${reply.status}: ${reply.text}`);
  const body = reply.json<{ data?: { intentId?: string }; intentId?: string; intent?: { intentId?: string } }>();
  const id = body.data?.intentId ?? body.intentId ?? body.intent?.intentId;
  assert.ok(typeof id === "string", `CMD063 answer names its intent: ${reply.text}`);
  return id;
}
/** A sealed draft of a fresh seller's fresh prospect under a live one-send grant (the common staging). */
export interface Staged {
  readonly seller: SellerP;
  readonly prospect: ProspectP;
  readonly draft: DraftP;
  readonly grant: GrantP;
}
export async function staged(w: SendWorld, label: string, options: { readonly seller?: SellerP; readonly prospect?: ProspectP; readonly maximumSends?: number; readonly expiresAt?: string; readonly validFrom?: string; readonly purpose?: Purpose; readonly sender?: SenderP } = {}): Promise<Staged> {
  const seller = options.seller ?? (await w.seller(label));
  const prospect = options.prospect ?? (await w.prospect(seller));
  const draft = await w.draft(seller, prospect, options.sender ?? seller.sender, { purpose: options.purpose ?? "INDIVIDUAL_PROSPECT_CONTACT", label });
  const grant = await w.grant([draft], {
    maximumSends: options.maximumSends ?? 1,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
  });
  return { seller, prospect, draft, grant };
}
/** CMD063 of a staged draft, asserting 200; the intent id. */
export async function queued(w: SendWorld, s: Staged, actor: Person = s.seller): Promise<string> {
  return intentIdOf(await send(w, actor, s.draft, s.grant));
}
/** A first contact sent and PROVIDER_ACCEPTED (CMD063 + one dispatcher unit): the intent id. */
export async function sentFirst(w: SendWorld, s: Staged): Promise<string> {
  const id = await queued(w, s);
  await w.dispatcher().dispatch(id);
  assert.equal((await intent(w, id)).state, "PROVIDER_ACCEPTED", "the first contact is PROVIDER_ACCEPTED");
  return id;
}
/** n first contacts of the seller on n fresh prospects, each sent (counted at the standing instant). */
export async function firstContacts(w: SendWorld, seller: SellerP, n: number, label: string): Promise<string[]> {
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push(await sentFirst(w, await staged(w, `${label}-${k}`, { seller })));
  return out;
}

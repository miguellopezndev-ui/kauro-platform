// B12 lane L-DRAFT test adapter (plan docs/design/B12-outreach-plan.md rev 4 §L, §M, §W, CMD061 trace; companion §R publish/put rows).
// The ONE file of the L-DRAFT tests that names lane K1's kit (apps/api/test/outreach-support.ts raceAtWrite, tokenFromSentMime;
// packages/persistence/test/b12-outreach-support.ts withoutGuards through the builder's withoutSerializers; ContractFakeGmailSend) and the
// routes of the other lanes (through DraftWorld.routes). The L-DRAFT world is a builder seam (b12-draft-world.ts), like L-SEND's
// b12-send-world.ts: the members both lanes need keep L-SEND's names and shapes (b12/send c2351164 b12-send-support.ts) so the batch merge
// can fold the two worlds into one.
//
// Rules applied (docs/design/FAILURE-MATRIX-TEMPLATE.md):
//  - 24/24a: a race cell runs `raceAtWrite` in BOTH orders; its control (KAURO_B12_CONTROL=<control id>) removes the cell's WHOLE
//    serializer set (acquisition and T2 assertion) and every co-guard listed in CELL_CONTROLS from both actors, everything else unchanged;
//    the body asserts the forbidden effect FIRST and the observed block LAST, so under the control the failing assertion is the effect.
//  - 24b: actors use only what was emitted to them: ids from API answers, opt-out tokens only from the MIME the Gmail fake recorded.
//  - 24c: a control names every guard that refuses the same stale write (M40: T7 and the two schema guards behind it, see CELL_CONTROLS).
//  - The second actor runs through ctx.mustWait inside K1's raceAtWrite: K1's oracle decides the outcome (blocked / settled, never a throw
//    when the second settles), and ctx.mustWait credits the observed wait that runCell("race") requires (K1's raceAtWrite alone never
//    increments ctx.observedWaits, so a green "race" cell built on it alone ends in FaultNotInjected).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "pg";
import { connectionPid, InterleavingNotObserved, runCell, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import type { ContractFakeGmailSend } from "@kauro/application/testing";
import type { SqlStep, UnitLog } from "./fault-support.js";
import type { Reply } from "./support.js";
// K1 (lane K1, b12/kit aa7d147b): the only import of the kit by L-DRAFT tests.
import { raceAtWrite as k1RaceAtWrite, tokenFromSentMime } from "./outreach-support.js";

/** Every K1 symbol and every seam the L-DRAFT tests rely on (through this adapter only). */
export const SEAMS = [
  "K1 outreach-support.ts raceAtWrite({oracle, first: {run, reached, release, pid}, second: {run, pid}}) -> {outcome, first, second}",
  "K1 outreach-support.ts tokenFromSentMime(ContractFakeGmailSend, intentId) (throws for an intent the fake never received)",
  "K1 packages/persistence/test/b12-outreach-support.ts:421 withoutGuards(world, guards, fn): the co-guard half of withoutSerializers",
  "K1 0072_b12_outreach.sql tables: outreach_contents, sales_resources, sales_resource_capabilities, outreach_drafts, outreach_draft_resources, outreach_send_intents, sales_activities",
  "SEAM (L-DRAFT builder) apps/api/test/b12-draft-world.ts draftWorldOf(label): DraftWorld below (same member names as L-SEND's SendWorld where both exist)",
  "SEAM the L-DRAFT routes reachable through DraftWorld.call at the paths of ROUTES (CMD061's is the registry path; the others are proposed for K2)",
  "SEAM DraftWorld.withoutSerializers(control, fn): the control's locks removed from every actor (acquisition + T2 assertion) and its co-guards dropped (K1 withoutGuards)",
] as const;

// --- the L-DRAFT routes (CMD061 registry path; the others proposed for K2's registration, §3 API-REG) -------------------------------
export const ROUTES = {
  /** CMD061 PrepareOutreachDraft (registry commands.json: POST /api/v1/ops/outreach/drafts). */
  prepareDraft: "/api/v1/ops/outreach/drafts",
  /** GetOutreachDraft (plan §2 Reads). */
  getDraft: (draftId: string): string => `/api/v1/ops/outreach/drafts/${draftId}`,
  /** PutOutreachContent (companion §R, B12-8): content-addressed. */
  putContent: "/api/v1/ops/outreach/contents",
  /** PublishSalesResource (companion §R, B12-7; owner, step-up). */
  publishResource: "/api/v1/ops/sales/resources",
  /** GetSalesResource (plan §2 Reads). */
  getResource: (resourceId: string): string => `/api/v1/ops/sales/resources/${resourceId}`,
} as const;

// --- problem outcomes ("<status> <code> <reason>", support.ts outcome) -----------------------------------------------------------------
export const OUTCOME = {
  KC016: "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED",
  KC031: "409 PRECONDITION_FAILED SENDER_NOT_VERIFIED",
  KC033: "409 PRECONDITION_FAILED RESOURCE_NOT_CURRENT",
  JURISDICTION: "409 PRECONDITION_FAILED OUTREACH_JURISDICTION_UNREVIEWED",
  /** plan §M M13 order 1 ("409 SENDER_REVOKED"); L-SEND asserts the same reason (it is not yet in K1's OUTREACH_FAILURE_REASONS). */
  SENDER_REVOKED: "409 PRECONDITION_FAILED SENDER_REVOKED",
  KEY_REUSED: "409 IDEMPOTENCY_CONFLICT -",
  TIMEOUT: "503 CAPACITY_UNAVAILABLE -",
} as const;
/** "<status> <code>" of a problem reply (the reason left out: a refusal whose reason the plan does not name). */
export const statusCode = (w: { outcome(r: Reply): string }, r: Reply): string => w.outcome(r).split(" ").slice(0, 2).join(" ");
/** A stale publish (expectedVersion no longer CURRENT): 409 STALE_VERSION. */
export const STALE = "409 STALE_VERSION";
/** The status and code of a content refusal (A13 and companion §T content checks: no new code, the existing CONTENT_REFUSED 422). */
export const CONTENT_REFUSED = "422 CONTENT_REFUSED";

/** A Thursday business instant in America/Bogota and America/New_York (A10), the instant the sends of these files stand at. */
export const T0 = "2026-10-15T15:00:00.000000Z";

// --- the world (builder seam) ----------------------------------------------------------------------------------------------------------
export interface Person {
  readonly userId: string;
  readonly token: string;
}
export type SenderRoute = "GMAIL_API" | "RESEND_TRANSACTIONAL";
export type Purpose = "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP" | "REQUESTED_REPLY";
export interface SenderP {
  readonly senderId: string;
  readonly userId: string;
  readonly route: SenderRoute;
  readonly address: string;
}
export interface SellerP extends Person {
  readonly sellerId: string;
  /** Its verified GMAIL_API identity (registered and verified through the owner's routes). */
  readonly sender: SenderP;
}
export interface ProspectP {
  readonly prospectId: string;
  readonly contactKey: string;
  readonly organizationKey: string;
  readonly sellerId: string | null;
  /** The hash of the prospect's source evidence as RecordProspectSource answered it (CMD061 provenanceEvidenceHash). */
  readonly provenanceEvidenceHash: string;
  readonly jurisdiction: string;
}
export interface ResourceP {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
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
}
export interface DispatchReport {
  readonly intentId: string;
  readonly outcome: string;
}
export interface Dispatcher {
  /** D1 + every due record D2 -> D3 -> D4, then D5 (L-SEND). */
  pass(): Promise<ReadonlyArray<DispatchReport>>;
}

export interface DraftWorld {
  readonly oracle: Client;
  /** The corporate owner with a fresh step-up. */
  readonly owner: Person;
  stop(): Promise<void>;
  /** Every unit's effect clock stands at the instant (null: the unit's own). */
  standAt(at: string | null): void;
  /** An ACTIVE seller with its verified GMAIL_API identity. */
  seller(label: string): Promise<SellerP>;
  /** A further KAURO_OWNER of the deployment with a fresh step-up, and its corporate grant id (a revocation cell revokes only it). */
  extraOwner(label: string): Promise<Person & { readonly grantId: string }>;
  agencyMember(label: string): Promise<Person>;
  /** A prospect registered by (and assigned to) the seller with one recorded contact and its source evidence (L-SOURCE routes). */
  prospect(seller: SellerP, options?: { readonly contact?: string; readonly jurisdiction?: string }): Promise<ProspectP>;
  /** A further identity of the person (default GMAIL_API), registered and (unless pending) verified (L-SEND routes). */
  sender(person: Person, options?: { readonly route?: SenderRoute; readonly pending?: true }): Promise<SenderP>;
  /** A CURRENT resource (version 1) of a fresh family claiming a fresh AVAILABLE capability, published by the owner. */
  freshResource(label: string): Promise<ResourceP>;
  /** The id of a tenant upload artifact and of a staged migration record of an agency (A17: never a contentRef). */
  tenantRecordIds(): Promise<{ readonly uploadId: string; readonly stagedRecordId: string }>;
  /** A first contact of a fresh seller's prospect to the contact address, granted, queued and accepted by the Gmail fake: its intent id. */
  sentFirstContactTo(contact: string, label: string): Promise<string>;
  /** PrepareOutreachReview + CMD062 (L-AUTH routes) by the owner with a fresh step-up; the Reply when it is refused. */
  grant(drafts: ReadonlyArray<DraftP>, options?: { readonly maximumSends?: number }): Promise<GrantP | Reply>;
  /** CMD063 (L-SEND route) of the draft under the grant, as the actor. */
  send(actor: Person, d: DraftP, g: GrantP): Promise<Reply>;
  /** GetOutreachMetrics (L-ACT route) of the person as the actor reads it: every member the answer carries. */
  metrics(actor: Person, personUserId: string): Promise<Readonly<Record<string, number | boolean>>>;
  dispatcher(): Dispatcher;
  call(c: { readonly method?: "POST" | "GET"; readonly url: string; readonly token: string | null; readonly key?: string | null; readonly body?: unknown }): Promise<Reply>;
  outcome(reply: Reply): string;
  /** A test connection of the login (raceAtWrite actors, holders); "superuser" for advisory subject holds. */
  open(login: "kauro_app_test" | "kauro_outreach_test" | "kauro_control_test" | "superuser"): Promise<HarnessConnection>;
  /** fn with every unit it opens routed over conn (fault-support FaultRouting.on): ctx.points, steps instrumented, unit `target` crashable, `log` filled. */
  on<T>(conn: HarnessConnection, role: "kauro_app" | "kauro_outreach" | "kauro_control", ctx: FaultContext, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing?: { readonly target?: number; readonly log?: UnitLog[] }): Promise<T>;
  /** The routed units' statement_timeout (null: the harness race allowance). */
  setStatementTimeout(ms: number | null): void;
  /** The internal errors the api recorded (a routed unit that failed at a fault point answers 500; ctx.partial needs the error itself). */
  readonly internalErrors: ReadonlyArray<{ readonly error: unknown }>;
  /** The ContractFakeGmailSend instance (K1) behind every send: its recorded submissions and MIME. */
  readonly gmailContract: ContractFakeGmailSend;
  /** Provider submissions the Gmail fake recorded for the intent, and in total. */
  callsOf(intentId: string): number;
  callsTotal(): number;
  /** The §M control: fn with the control's lock set removed from every actor (acquisition + T2 assertion) and its co-guards dropped. */
  withoutSerializers<T>(control: Control, fn: () => Promise<T>): Promise<T>;
  /** The routes of the other lanes a race actor or a precondition needs (their real handlers). */
  readonly routes: {
    terminate(seller: SellerP, key?: string): Promise<Reply>;
    suspendCapability(capabilityId: string, key?: string): Promise<Reply>;
    withdrawPolicy(jurisdiction: string, purpose: Purpose, key?: string): Promise<Reply>;
    /** A re-reviewed policy version IN_FORCE again (seed of the next version), so later cells see an in-force policy. */
    reinstatePolicy(jurisdiction: string, purpose: Purpose): Promise<Reply>;
    revokeSender(senderId: string, key?: string): Promise<Reply>;
    /** POST /api/v1/public/outreach/opt-out/{token} with the RFC 8058 body (L-ACT). */
    optOut(token: string): Promise<Reply>;
    /** A suppression of the contact key or organization domain recorded by the owner (CMD064 SUPPRESSED, L-ACT), L8 X. */
    suppress(target: { readonly contactKey: string } | { readonly domain: string }): Promise<void>;
    /** CMD064 (L-ACT) as the actor. */
    recordActivity(actor: Person, activity: Record<string, unknown>, key?: string): Promise<Reply>;
  };
}

/** The L-DRAFT world is the builder's (computed specifier, so these files type-check before it exists; every title fails at it until then). */
const WORLD_MODULE: string = "./b12-draft-world.js";
interface WorldModule {
  draftWorldOf(label: string): Promise<DraftWorld>;
}
let current: DraftWorld | null = null;
export async function draftWorld(label: string): Promise<DraftWorld> {
  const m = (await import(WORLD_MODULE)) as WorldModule;
  current = await m.draftWorldOf(label);
  return current;
}

// --- locks, co-guards and the controls (§L, §M) ---------------------------------------------------------------------------------------
export type LockName = "L1" | "L2" | "L3" | "L5" | "L6" | "L6p" | "L7" | "L8" | "L10";
/**
 * A co-guard by §L name, with the schema guard K1's withoutGuards drops for it (Guard shapes of b12-outreach-support.ts:412): T7 and
 * the two guards that refuse the same stale publish (rule 24c: the plan's M40 row names T7 only, but with L6 and T7 gone the stale
 * publisher is still refused by the family/version UNIQUE and by the CURRENT->SUPERSEDED edge trigger, an incidental 23505 / KA096, so the
 * control drops them too and the forbidden effect, two CURRENT versions, is what fails). U-content: the content-addressed primary key of
 * outreach_contents (GAP-PC-1, U-only control; dependent foreign keys of outreach_drafts and sales_resources are dropped and restored
 * with it by the builder's withoutSerializers: K1's withoutGuards drops a constraint without CASCADE).
 */
export const CO_GUARDS = {
  T7: { constraint: ["kauro.sales_resources", "sales_resources_one_current"] },
  "U-family-version": { constraint: ["kauro.sales_resources", "sales_resources_family_version"] },
  "T-resource-edge": { raise: ["kauro.sales_resources_edge()", "SEND_FENCE: resource % changes only"] },
  "U-content": { constraint: ["kauro.outreach_contents", "outreach_contents_pkey"] },
} as const;
export type CoGuard = keyof typeof CO_GUARDS;
export interface Control {
  readonly locks: ReadonlyArray<LockName>;
  readonly coGuards: ReadonlyArray<CoGuard>;
  /** Locks kept on one actor because they are its own writer's platform code (M8 rule: CMD059's trigger X, the corporate-role trigger X). */
  readonly keptOn?: string;
}
/** §M serializer sets per control id (KAURO_B12_CONTROL=<id>). */
export const CELL_CONTROLS: Readonly<Record<string, Control>> = {
  // M39 (CMD061 x CMD050 / publisher / CMD059): one control per member, each red alone
  "M39-L1": { locks: ["L1"], coGuards: [] },
  "M39-L6": { locks: ["L6"], coGuards: [] },
  "M39-L5": { locks: ["L5"], coGuards: [], keptOn: "CMD059's capabilities_transition_lock trigger X (0003:50-56) is the writer's own code" },
  // M24 (opt-out x CMD061): the opt-out takes L8 X only
  M24: { locks: ["L8"], coGuards: [] },
  // M11 / M13, the CMD061 side (GAP-DR-6, GAP-DR-4)
  M11: { locks: ["L6p"], coGuards: [] },
  M13: { locks: ["L7"], coGuards: [] },
  // M40 (Publish x Publish of one family)
  M40: { locks: ["L6"], coGuards: ["T7", "U-family-version", "T-resource-edge"] },
  // §M sweep: GAP-PU-2 is a single-member L1 set; GAP-PC-1 is U-only; GAP-PC-2 meets CMD050 at L1
  "PU-2": { locks: ["L1"], coGuards: [], keptOn: "corporate_roles_transition_lock trigger X (0013:524) is the revoker's own code" },
  "PC-1": { locks: [], coGuards: ["U-content"] },
  "PC-2": { locks: ["L1"], coGuards: [] },
};
export function controlOf(id: string): Control | null {
  const asked = process.env["KAURO_B12_CONTROL"];
  if (asked === undefined || asked !== id) return null;
  const c = CELL_CONTROLS[id];
  if (c === undefined) throw new Error(`no §M control ${id}`);
  return c;
}

// --- first writes of each actor (the `.before`/`.after` points the first actor pauses at) ---------------------------------------------
export const W = {
  draftInsert: { label: "draft_insert", match: /INSERT INTO kauro\.outreach_drafts\b/ },
  /** CMD061's content binding: the draft's cited resources (the second write of its unit, GAP-DR-5). */
  draftResourceInsert: { label: "draft_resource_insert", match: /INSERT INTO kauro\.outreach_draft_resources\b/ },
  contentInsert: { label: "content_insert", match: /INSERT INTO kauro\.outreach_contents\b/ },
  resourceSupersede: { label: "resource_supersede", match: /UPDATE kauro\.sales_resources\b/ },
  resourceInsert: { label: "resource_insert", match: /INSERT INTO kauro\.sales_resources\b/ },
  capabilityClaimInsert: { label: "capability_claim_insert", match: /INSERT INTO kauro\.sales_resource_capabilities\b/ },
  capabilityUpdate: { label: "capability_update", match: /UPDATE kauro\.capabilities\b/ },
  sellerUpdate: { label: "seller_update", match: /UPDATE kauro\.sellers\b/ },
  policyWithdraw: { label: "policy_withdraw", match: /UPDATE kauro\.outreach_channel_policies\b/ },
  senderUpdate: { label: "sender_update", match: /UPDATE kauro\.sender_identities\b/ },
  suppressionInsert: { label: "suppression_insert", match: /INSERT INTO kauro\.prospect_suppressions\b/ },
  /** CMD061's wait at the resource family subject L6 (GAP-DR-3). */
  resourceLock: { label: "resource_lock", match: /kauro\.sales_resources'/ },
} as const satisfies Record<string, SqlStep>;

// --- the race harness (§M; K1 raceAtWrite + ctx.mustWait) ---------------------------------------------------------------------------
export type Settled<T> = { readonly answer: T } | { readonly failure: unknown };
type Role = "kauro_app" | "kauro_outreach" | "kauro_control";
const LOGIN = { kauro_app: "kauro_app_test", kauro_outreach: "kauro_outreach_test", kauro_control: "kauro_control_test" } as const;
/** A routed actor: an api call whose units run on the actor's connection; as first it pauses at `.before` of `at` (`.after` when `after`). */
export interface RoutedActor<T> {
  readonly name: string;
  readonly role: Role;
  readonly run: () => Promise<T>;
  readonly at: SqlStep;
  readonly after?: true;
}
/** A raw actor (a control-plane fixture with no route, e.g. the corporate-role revocation): `pause` is its point once it judged/locked. */
export interface RawActor<T> {
  readonly name: string;
  readonly login: "kauro_control_test" | "kauro_app_test";
  readonly raw: (conn: HarnessConnection, pause: () => Promise<void>) => Promise<T>;
}
export type Actor<T> = RoutedActor<T> | RawActor<T>;
export interface RaceResult<A, B> {
  readonly first: Settled<A>;
  readonly second: Settled<B>;
  /** K1's oracle saw the second blocked by the first's backend (pg_blocking_pids) before the first was released. */
  readonly secondBlocked: boolean;
}
const settledOf = <T>(r: PromiseSettledResult<T>): Settled<T> => (r.status === "fulfilled" ? { answer: r.value } : { failure: r.reason });
/** A waited operation's own outcome (Waiting.pending settles to the operation's PromiseSettledResult). */
export const settledValue = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status === "rejected") throw r.reason;
  return r.value;
};
const loginOf = (a: Actor<unknown>) => ("raw" in a ? a.login : LOGIN[a.role]);

/**
 * One order of a §M cell. The first actor runs on its own connection until its pause (it holds its whole serializer set and judged); the
 * second runs on its own connection through ctx.mustWait inside K1's raceAtWrite, until K1's oracle sees it blocked by the first's pid
 * or it settles; the first is released; both are awaited. Under control `controlId` the world removes the set and co-guards for the order.
 */
export async function raceAtWrite<A, B>(ctx: FaultContext, controlId: string, first: Actor<A>, second: Actor<B>): Promise<RaceResult<A, B>> {
  const w = current;
  if (w === null) throw new Error("raceAtWrite before draftWorld");
  const control = controlOf(controlId);
  const fc = await w.open(loginOf(first));
  const sc = await w.open(loginOf(second));
  try {
    const point = "raw" in first ? `raw.${first.name}` : `db.${first.at.label}.${first.after === true ? "after" : "before"}`;
    const pause = ctx.points.pause(point);
    const runFirst = (): Promise<A> =>
      ctx.operation(`${first.name} (first)`, () => ("raw" in first ? first.raw(fc, () => ctx.points.pass(point)) : w.on(fc, first.role, ctx, [first.at], first.run)));
    const runSecondOn = (client: HarnessConnection): Promise<B> => ("raw" in second ? second.raw(client, async () => undefined) : w.on(client, second.role, ctx, [], second.run));
    const runSecond = async (): Promise<B> => {
      let started: Promise<B> | undefined;
      try {
        const waiting = await ctx.mustWait(w.oracle, { waiter: sc, holder: connectionPid(fc) }, (client) => (started = runSecondOn(client)), `${second.name} waits on ${first.name}`);
        return settledValue(await waiting.pending);
      } catch (e) {
        // the second settled without waiting (a control): its own answer is the outcome, never the harness's InterleavingNotObserved
        if (e instanceof InterleavingNotObserved && started !== undefined) return await started;
        throw e;
      }
    };
    const order = () =>
      k1RaceAtWrite<A, B>({
        oracle: w.oracle,
        first: { run: runFirst, reached: pause.reached, release: () => pause.release(), pid: () => connectionPid(fc) },
        second: { run: runSecond, pid: () => connectionPid(sc) },
      });
    const r = control === null ? await order() : await w.withoutSerializers(control, order);
    return { first: settledOf(r.first), second: settledOf(r.second), secondBlocked: r.outcome === "blocked" };
  } finally {
    await fc.end().catch(() => undefined);
    await sc.end().catch(() => undefined);
  }
}
export const answerOf = <T>(s: Settled<T>, what: string): T => {
  if ("failure" in s) throw new assert.AssertionError({ message: `${what} failed: ${String((s.failure as Error)?.message ?? s.failure)}` });
  return s.answer;
};
/** Runs a routed api call for ctx.partial: a 500 answer is the internal error the api recorded, thrown (so the fault is the cause). */
export async function failing(w: DraftWorld, call: () => Promise<Reply>): Promise<Reply> {
  const seen = w.internalErrors.length;
  const r = await call();
  if (r.status >= 500) throw w.internalErrors[seen]?.error ?? new Error(`${r.status} ${r.text}`);
  return r;
}
/** A superuser test connection holding an advisory subject of §L in an open transaction (the holder of a TIMEOUT cell). */
export async function holdSubject(w: DraftWorld, kind: string, subject: string, mode: "X" | "S" = "X"): Promise<{ readonly conn: HarnessConnection; release(): Promise<void> }> {
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
export type Order = 1 | 2;
export const ORDERS: ReadonlyArray<Order> = [1, 2];

/** A cell titled verbatim by the plan, run by the common fault harness (runCell asserts the fault was injected). */
export function cell(title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, at?: string): void {
  const id = /^([A-Z0-9-]+[a-z]?)/.exec(title)?.[1] ?? title.slice(0, 16);
  test(title, async () => {
    await runCell({ id, step: title.slice(0, 160), fault, ...(at === undefined ? {} : { at }), expect: title }, body);
  });
}

/** The opt-out token of the intent's first message, from the MIME the Gmail fake recorded (rule 24b; K1 tokenFromSentMime). */
export const tokenOf = (w: DraftWorld, intentId: string): string => tokenFromSentMime(w.gmailContract, intentId);

// --- the L-DRAFT routes as calls -------------------------------------------------------------------------------------------------------
let seq = 0;
export const keyOf = (label: string): string => `b12d-${label}-${(++seq).toString().padStart(5, "0")}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 120);
export interface Completed<T> {
  readonly kind: "COMPLETED";
  readonly replayed: boolean;
  readonly data: T;
}
export function completedOf<T>(reply: Reply, status: 200 | 201, what: string): Completed<T> {
  assert.equal(reply.status, status, `${what}: ${reply.text}`);
  const body = reply.json<Completed<T>>();
  assert.equal(body.kind, "COMPLETED", `${what}: a COMPLETED answer`);
  return body;
}
export function putContent(w: DraftWorld, actor: Person, content: { readonly subject: string; readonly body: string }, key = keyOf("put")): Promise<Reply> {
  return w.call({ url: ROUTES.putContent, token: actor.token, key, body: content });
}
/** The content id PutOutreachContent answered (ids only from API answers). */
export async function contentIdOf(w: DraftWorld, actor: Person, content: { readonly subject: string; readonly body: string }): Promise<string> {
  const id = completedOf<{ contentId: string }>(await putContent(w, actor, content), 201, "PutOutreachContent").data.contentId;
  assert.match(id, /^[0-9a-f]{64}$/, "the content id is a sha256");
  return id;
}
export interface DraftBody {
  readonly prospectId: string;
  readonly senderIdentityRef: string;
  readonly purpose: Purpose;
  readonly contentRef: string;
  readonly provenanceEvidenceHash: string;
  /** The sales resources the draft cites (A8; outreach_draft_resources). */
  readonly resourceIds: ReadonlyArray<string>;
}
export function prepareDraft(w: DraftWorld, actor: Person, body: DraftBody, key = keyOf("cmd061")): Promise<Reply> {
  return w.call({ url: ROUTES.prepareDraft, token: actor.token, key, body });
}
export interface DraftAnswer {
  readonly draftId: string;
  readonly version: number;
  readonly state: string;
  readonly contentHash: string;
}
export const draftAnswerOf = (reply: Reply, what = "CMD061"): DraftAnswer => completedOf<DraftAnswer>(reply, 201, what).data;
/** A safe body that passes every content check (A13, companion §T), unique per label. */
export const safeContent = (label: string): { subject: string; body: string } => ({
  subject: `Migration review for your team (${label})`,
  body: `Hello,\n\nI help agencies plan data migrations with a reviewed, reversible process. Reference ${label}.\n\nWould a short call next week be useful?\n`,
});
/** The default draft body of a seller on its prospect: its own sender, stored safe content, the prospect's provenance, one CURRENT resource. */
export async function draftBodyOf(w: DraftWorld, seller: SellerP, p: ProspectP, r: ResourceP, label: string, options: { readonly sender?: SenderP; readonly purpose?: Purpose } = {}): Promise<DraftBody> {
  return {
    prospectId: p.prospectId,
    senderIdentityRef: (options.sender ?? seller.sender).senderId,
    purpose: options.purpose ?? "INDIVIDUAL_PROSPECT_CONTACT",
    contentRef: await contentIdOf(w, seller, safeContent(label)),
    provenanceEvidenceHash: p.provenanceEvidenceHash,
    resourceIds: [r.resourceId],
  };
}
export const asDraft = (a: DraftAnswer, b: DraftBody, p: ProspectP, s: SenderP): DraftP => ({ draftId: a.draftId, version: a.version, contentHash: a.contentHash, contentRef: b.contentRef, prospect: p, sender: s, purpose: b.purpose });
export interface PublishBody {
  /** Absent: a new family (version 1). */
  readonly familyId?: string;
  /** The CURRENT version the publisher read (stale: 409). */
  readonly expectedVersion?: number;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
}
export function publish(w: DraftWorld, actor: Person, body: PublishBody, key = keyOf("publish")): Promise<Reply> {
  return w.call({ url: ROUTES.publishResource, token: actor.token, key, body });
}

// --- row readers (superuser oracle; read only) ------------------------------------------------------------------------------------------
export async function draftsOfProspect(w: DraftWorld, prospectId: string): Promise<Array<{ draftId: string; state: string; version: number; senderId: string }>> {
  return (
    await w.oracle.query<{ draftId: string; state: string; version: number; senderId: string }>(
      `SELECT draft_id::text AS "draftId", state, version::int AS version, sender_id::text AS "senderId" FROM kauro.outreach_drafts WHERE prospect_id = $1 ORDER BY created_at, draft_id`,
      [prospectId],
    )
  ).rows;
}
export async function draftRow(w: DraftWorld, draftId: string): Promise<{ state: string; version: number; contentHash: string; contentRef: string; contactKey: string; senderId: string; purpose: string; provenance: string }> {
  const r = (
    await w.oracle.query<{ state: string; version: number; contentHash: string; contentRef: string; contactKey: string; senderId: string; purpose: string; provenance: string }>(
      `SELECT state, version::int AS version, content_hash AS "contentHash", content_ref AS "contentRef", contact_key AS "contactKey", sender_id::text AS "senderId", purpose,
              provenance_evidence_hash AS provenance FROM kauro.outreach_drafts WHERE draft_id = $1`,
      [draftId],
    )
  ).rows[0];
  assert.ok(r !== undefined, `draft ${draftId} exists`);
  return r;
}
export async function draftResources(w: DraftWorld, draftId: string): Promise<string[]> {
  return (await w.oracle.query<{ id: string }>(`SELECT resource_id::text AS id FROM kauro.outreach_draft_resources WHERE draft_id = $1 ORDER BY resource_id`, [draftId])).rows.map((r) => r.id);
}
export async function intentsOfDraft(w: DraftWorld, draftId: string): Promise<Array<{ intentId: string; state: string; reason: string | null }>> {
  return (await w.oracle.query<{ intentId: string; state: string; reason: string | null }>(`SELECT intent_id::text AS "intentId", state, outcome_reason AS reason FROM kauro.outreach_send_intents WHERE draft_id = $1 ORDER BY counted_at`, [draftId])).rows;
}
export async function activitiesOfProspect(w: DraftWorld, prospectId: string): Promise<string[]> {
  return (await w.oracle.query<{ kind: string }>(`SELECT kind FROM kauro.sales_activities WHERE prospect_id = $1 ORDER BY recorded_at, activity_id`, [prospectId])).rows.map((r) => r.kind);
}
export async function journalStates(w: DraftWorld, operation: string, key: string): Promise<string[]> {
  return (await w.oracle.query<{ state: string }>("SELECT state FROM kauro.command_journal WHERE operation = $1 AND idempotency_key = $2", [operation, key])).rows.map((r) => r.state);
}
/** Domain events and outbox records whose aggregate is the draft or one of the prospect's intents (CMD061 writes none). */
export async function eventsOfProspect(w: DraftWorld, prospectId: string): Promise<number> {
  const r = await w.oracle.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kauro.domain_events e
      WHERE e.aggregate_id IN (SELECT draft_id FROM kauro.outreach_drafts WHERE prospect_id = $1 UNION SELECT intent_id FROM kauro.outreach_send_intents WHERE prospect_id = $1)`,
    [prospectId],
  );
  return r.rows[0]!.n;
}
export async function familyRows(w: DraftWorld, familyId: string): Promise<Array<{ resourceId: string; version: number; state: string }>> {
  return (
    await w.oracle.query<{ resourceId: string; version: number; state: string }>(
      `SELECT resource_id::text AS "resourceId", version, state FROM kauro.sales_resources WHERE family_id = $1 ORDER BY version, created_at`,
      [familyId],
    )
  ).rows;
}
export async function claimsOf(w: DraftWorld, resourceId: string): Promise<string[]> {
  return (await w.oracle.query<{ id: string }>(`SELECT capability_id::text AS id FROM kauro.sales_resource_capabilities WHERE resource_id = $1 ORDER BY capability_id`, [resourceId])).rows.map((r) => r.id);
}
export async function contentRows(w: DraftWorld, contentId: string): Promise<Array<{ recordedBy: string }>> {
  return (await w.oracle.query<{ recordedBy: string }>(`SELECT recorded_by_user_id::text AS "recordedBy" FROM kauro.outreach_contents WHERE content_id = $1`, [contentId])).rows;
}
export async function contentRowsByBody(w: DraftWorld, body: string): Promise<number> {
  return (await w.oracle.query<{ n: number }>(`SELECT count(*)::int AS n FROM kauro.outreach_contents WHERE body = $1`, [body])).rows[0]!.n;
}
export async function capabilityState(w: DraftWorld, capabilityId: string): Promise<string> {
  return (await w.oracle.query<{ state: string }>(`SELECT state FROM kauro.capabilities WHERE capability_id = $1`, [capabilityId])).rows[0]!.state;
}
export async function sellerState(w: DraftWorld, sellerId: string): Promise<string> {
  return (await w.oracle.query<{ state: string }>(`SELECT state FROM kauro.sellers WHERE seller_id = $1`, [sellerId])).rows[0]!.state;
}
export async function senderState(w: DraftWorld, senderId: string): Promise<string> {
  return (await w.oracle.query<{ state: string }>(`SELECT state FROM kauro.sender_identities WHERE sender_id = $1`, [senderId])).rows[0]!.state;
}
export async function policyStates(w: DraftWorld, jurisdiction: string, purpose: Purpose): Promise<string[]> {
  return (await w.oracle.query<{ state: string }>(`SELECT state FROM kauro.outreach_channel_policies WHERE jurisdiction = $1 AND purpose = $2 ORDER BY version`, [jurisdiction, purpose])).rows.map((r) => r.state);
}
export async function suppressedKeys(w: DraftWorld, contactKey: string): Promise<number> {
  return (await w.oracle.query<{ n: number }>(`SELECT count(*)::int AS n FROM kauro.prospect_suppressions WHERE key_kind = 'CONTACT' AND suppression_key = $1`, [contactKey])).rows[0]!.n;
}
export async function corporateRoleState(w: DraftWorld, grantId: string): Promise<string> {
  return (await w.oracle.query<{ state: string }>(`SELECT state FROM kauro.corporate_roles WHERE grant_id = $1`, [grantId])).rows[0]!.state;
}
/** The corporate-role revocation (control plane, commerce-fixtures.ts:82 shape): its UPDATE's trigger takes L1 X of the person (0013:524). */
export function revokeOwnerActor(grantId: string): RawActor<number> {
  return {
    name: "corporate-role-revocation",
    login: "kauro_control_test",
    raw: async (conn, pause) => {
      await conn.query("BEGIN");
      try {
        const r = await conn.query("UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = now() WHERE grant_id = $1 AND state = 'ACTIVE'", [grantId]);
        await pause();
        await conn.query("COMMIT");
        return r.rowCount ?? 0;
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    },
  };
}

// SetBuyerType (B11 lane A1; SCREENS-PLAN section 3 rows A1, traces A1-T1 and A1-T2) — POST /api/v1/agencies/{agencyId}/buyer-type —
// AGENCY_OWNER — scope AGENCY_PATH — body {buyerType: "agency" | "in-house", forEconomicActivity: true}. R2 A3 3.7: the buyer type is
// answered once during onboarding, before the first quote, and does not change the price. It is recorded once per agency
// (agency_buyer_types), through the command runtime with a content-idempotent journal; the platform's BuyerTypeReader reads it, so
// CMD027 CreateQuote and CMD047 AcceptAttribution see it. GetBuyerType (GET on the same path) answers it to any member, so the
// onboarding screen shows a recorded type read-only.
//
// The real routes, the real authorizers and PostgreSQL 17 through the runtime login roles; the superuser only reads (and, in the
// TIMEOUT cell, holds the agency row as another session would). No buyer-type fake is bound: the composition's platform reader is the
// one under test.
import { INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_OBSERVATION_MS, activateAgency, invariantsAfterEach, recordClaim, recordProspect, recordReviewedFiscalProfile, type AgencyFixture } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CreateQuoteView } from "@kauro/application";
import type { FiscalProfileId, UserId } from "@kauro/domain";
import { API_APPLICATION_NAME } from "../src/index.js";
import { apiBusy, disarm, otherApiBackend, otherWaitsExactlyOn, soleApiBackend, track, until } from "./agency-lock-cells.js";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { prepareAllocation, recordSeller } from "./sales-support.js";
import { SimulatedCrash, approveThroughRoute, asProblem, call, completed, freshKey, outcome, replayTextOf, type Person, type Reply } from "./support.js";

// --- the world: the payments world with a unit-of-work wrapper for the TIMEOUT and PARTIAL cells --------------------------------------

/** The statement bound the TIMEOUT cell injects into the api's units of work (null: the world's own bound). */
const injected: { statementTimeoutMs: number | null; failEventType: string | null } = { statementTimeoutMs: null, failEventType: null };

type RunFn = (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;

/** A unit of work whose event publisher throws once for `injected.failEventType` (the PARTIAL cell: a later write of the unit fails). */
function withFailingPublish(uow: object): object {
  return new Proxy(uow, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== "events" || typeof value !== "object" || value === null) return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      const events = value as { publish: (e: { eventType: string }) => Promise<unknown> };
      return new Proxy(events, {
        get(t, p) {
          if (p === "publish") {
            return async (e: { eventType: string }) => {
              if (injected.failEventType !== null && e.eventType === injected.failEventType) {
                injected.failEventType = null;
                throw new SimulatedCrash(`publishing ${e.eventType}`);
              }
              return t.publish(e);
            };
          }
          const v = Reflect.get(t, p, t) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    },
  });
}

function wrapUnitOfWork<F extends object>(inner: F): F {
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if ((property === "run" || property === "runSource") && typeof value === "function") {
        const run = value as RunFn;
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: Record<string, unknown>) =>
          run.call(target, context, (uow) => work(withFailingPublish(uow as object)), injected.statementTimeoutMs === null ? options : { ...(options ?? {}), statementTimeoutMs: injected.statementTimeoutMs });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let pw: PaymentsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld({ wrapUnitOfWork });
});
after(async () => {
  await pw.stop();
});

const EVENT_TYPE = "agency_buyer_type.recorded.v1";
const buyerTypeUrl = (agencyId: string): string => `/api/v1/agencies/${agencyId}/buyer-type`;
const closeUrl = (agencyId: string): string => `/api/v1/agencies/${agencyId}/closure-requests`;
const oracle = () => pw.w.h.oracle;

interface Onboarding {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly coOwner: Person;
  readonly admin: Person;
  readonly viewer: Person;
}

/** A new agency (DRAFT unless `active`) with its owner, a second OWNER, an ADMIN and a VIEWER. */
async function onboarding(label: string, options: { readonly active?: boolean } = {}): Promise<Onboarding> {
  const { w } = pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  const coOwner = await w.person(`${label}-co-owner`);
  await w.h.addMember(agency, coOwner.userId, "OWNER");
  const admin = await w.person(`${label}-admin`);
  await w.h.addMember(agency, admin.userId, "ADMIN");
  const viewer = await w.person(`${label}-viewer`);
  await w.h.addMember(agency, viewer.userId, "VIEWER");
  if (options.active === true) await activateAgency(w.h, agency);
  return { agency, owner, coOwner, admin, viewer };
}

function setBuyerType(agencyId: string, who: Person, buyerType: string, options: { readonly key?: string; readonly body?: unknown } = {}): Promise<Reply> {
  return call(pw.w, { url: buyerTypeUrl(agencyId), token: who.token, agency: null, key: options.key ?? freshKey("a1-set"), body: options.body ?? { buyerType, forEconomicActivity: true } });
}

function getBuyerType(agencyId: string, who: Person): Promise<Reply> {
  return call(pw.w, { method: "GET", url: buyerTypeUrl(agencyId), token: who.token, agency: null, key: null, contentType: null });
}

interface BuyerTypeView {
  readonly agencyId: string;
  readonly buyerType: "agency" | "in-house" | null;
  readonly forEconomicActivity: boolean | null;
  readonly recordedAt: string | null;
  readonly version: number;
}

/** The recorded row of the agency (superuser oracle), or null. */
async function recorded(agencyId: string): Promise<{ buyer_type: string; for_economic_activity: boolean; version: string; recorded_by_user_id: string } | null> {
  const r = await oracle().query<{ buyer_type: string; for_economic_activity: boolean; version: string; recorded_by_user_id: string }>(
    "SELECT buyer_type, for_economic_activity, version::text AS version, recorded_by_user_id::text AS recorded_by_user_id FROM kauro.agency_buyer_types WHERE agency_id = $1",
    [agencyId],
  );
  return r.rows[0] ?? null;
}

/** Everything a SetBuyerType of the agency can write: its row, its events and its journal entries. */
async function footprint(agencyId: string) {
  return {
    rows: await pw.w.count("agency_buyer_types", "agency_id = $1", [agencyId]),
    events: await pw.w.count("domain_events", "aggregate_kind = 'agency_buyer_type' AND aggregate_id = $1", [agencyId]),
    journal: await pw.w.count("command_journal", "operation = 'CMD101' AND agency_id = $1", [agencyId]),
  };
}

const agencyState = async (agencyId: string): Promise<string | undefined> => (await oracle().query<{ state: string }>("SELECT state FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows[0]?.state;
const settled = (r: PromiseSettledResult<Reply>): string => (r.status === "fulfilled" ? (r.value.status < 300 ? String(r.value.status) : outcome(pw.w, r.value)) : `threw ${String(r.reason)}`);

/** The statement an api backend is running (pg_stat_activity), for naming where a waiter waits. */
async function statementOf(pid: number): Promise<string> {
  await oracle().query("SELECT pg_stat_clear_snapshot()");
  return (await oracle().query<{ query: string }>("SELECT query FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.query ?? "";
}

/** The COMPLETED answer of `reply`, asserting its status first (so a missing route fails as an assertion, never as a parse error). */
function answered<T>(reply: Reply, status: 200 | 201) {
  assert.equal(reply.status, status, reply.text);
  return completed<T>(reply, status);
}

/** The api backend waiting on a lock while running a statement containing `fragment`, or null (one probe; never throws). */
async function lockWaiter(fragment: string): Promise<number | null> {
  await oracle().query("SELECT pg_stat_clear_snapshot()");
  const r = await oracle().query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND position($2 in query) > 0", [API_APPLICATION_NAME, fragment]);
  return r.rows[0]?.pid ?? null;
}

async function close(agencyId: string, owner: Person): Promise<Reply> {
  const version = Number((await oracle().query<{ version: string }>("SELECT version::text AS version FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows[0]?.version);
  return call(pw.w, { url: closeUrl(agencyId), token: owner.token, agency: null, key: freshKey("a1-close"), body: { expectedVersion: version, assuranceProofRef: await pw.w.stepUp(owner) } });
}

// --- OK / DENY ------------------------------------------------------------------------------------------------------------------------

test("OK/DENY: OWNER only; a non-member 404, a VIEWER 403, a body without forEconomicActivity=true 400", async () => {
  const { w } = pw;
  const o = await onboarding("a1-ok");
  const agencyId = o.agency.agencyId;
  // before any answer every member reads the type as not recorded
  const unset = await getBuyerType(agencyId, o.viewer);
  assert.equal(unset.status, 200, unset.text);
  assert.deepEqual(unset.json<{ kind: string; data: BuyerTypeView }>(), { kind: "READ", data: { agencyId, buyerType: null, forEconomicActivity: null, recordedAt: null, version: 0 } });

  // the refusals write nothing: a body that does not affirm the economic activity, or names another value, is a schema violation
  for (const body of [{ buyerType: "agency" }, { buyerType: "agency", forEconomicActivity: false }, { buyerType: "consumer", forEconomicActivity: true }, { buyerType: "AGENCY", forEconomicActivity: true }, { buyerType: "agency", forEconomicActivity: true, extra: 1 }]) {
    assert.equal(outcome(w, await setBuyerType(agencyId, o.owner, "agency", { body })), "400 INVALID_REQUEST SCHEMA_VIOLATION", JSON.stringify(body));
  }
  assert.equal(outcome(w, await setBuyerType(agencyId, w.stranger, "agency")), "404 NOT_FOUND NOT_A_MEMBER", "a member of another agency is a non-member here");
  assert.equal(outcome(w, await setBuyerType(agencyId, o.viewer, "agency")), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await setBuyerType(agencyId, o.admin, "in-house")), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT", "an ADMIN is not the owner");
  assert.equal(outcome(w, await getBuyerType(agencyId, w.stranger)), "404 NOT_FOUND NOT_A_MEMBER", "a non-member reads nothing");
  assert.deepEqual(await footprint(agencyId), { rows: 0, events: 0, journal: 0 }, "no refusal wrote a row, an event or a journal entry");

  // the owner of the DRAFT agency records it: 201, the row, one event and the journaled answer
  const key = freshKey("a1-ok");
  const reply = answered<BuyerTypeView>(await setBuyerType(agencyId, o.owner, "agency", { key }), 201);
  assert.equal(reply.replayed, false);
  assert.equal(reply.version, 1);
  assert.deepEqual({ ...reply.data, recordedAt: typeof reply.data.recordedAt }, { agencyId, buyerType: "agency", forEconomicActivity: true, recordedAt: "string", version: 1 });
  assert.deepEqual(await recorded(agencyId), { buyer_type: "agency", for_economic_activity: true, version: "1", recorded_by_user_id: o.owner.userId });
  const events = await w.events("agency_buyer_type", agencyId);
  assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, EVENT_TYPE]]);
  assert.deepEqual({ ...events[0]!.payload, recordedByMembershipId: typeof events[0]!.payload["recordedByMembershipId"] }, { agencyId, buyerType: "agency", forEconomicActivity: true, recordedByMembershipId: "string" });
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 201, "agency_buyer_type", agencyId]);
  // any member now reads it, read-only, exactly as recorded
  const read = await getBuyerType(agencyId, o.viewer);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json<{ data: BuyerTypeView }>().data, reply.data);
  // the viewer's refusal is still a refusal once it is recorded, and the type does not change
  assert.equal(outcome(w, await setBuyerType(agencyId, o.viewer, "in-house")), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal((await recorded(agencyId))?.buyer_type, "agency");
});

// --- RACE (A1-T1) -----------------------------------------------------------------------------------------------------------------------

test("RACE: two owners record different buyer types in both orders; one row, the second is BUYER_TYPE_ALREADY_SET, no 500", async () => {
  const { w } = pw;
  const rows: string[] = [];
  for (const [first, second] of [["agency", "in-house"], ["in-house", "agency"]] as const) {
    const o = await onboarding(`a1-race-${first}`);
    const agencyId = o.agency.agencyId;
    // the first owner's unit holds the agency row (FOR NO KEY UPDATE) with its row inserted, paused before its journal commit
    const hold = w.holds.arm("journal.commit");
    const a = track(setBuyerType(agencyId, o.owner, first));
    await Promise.race([hold.reached, a.settled]);
    if (a.done()) {
      hold.release();
      await disarm(w, "journal.commit", false);
    }
    assert.equal(a.done() ? settled(await a.settled) : "held", "held", `${first}: the first owner reached its commit`);
    const holder = await soleApiBackend(w, "the first owner at its commit");
    // the second owner passes its own membership lock and its journal reservation, then waits for exactly the first at the agency row
    const b = track(setBuyerType(agencyId, o.coOwner, second));
    let waited = false;
    try {
      await until(`${first}: the second owner waits for the first`, async () => b.done() || (waited = await otherWaitsExactlyOn(w, holder)));
      const waiter = await otherApiBackend(w, holder);
      const statement = waiter === null ? "" : await statementOf(waiter);
      rows.push(`${first} first: second waited ${waited} at ${/FROM kauro\.agencies[\s\S]*FOR NO KEY UPDATE/.test(statement) ? "the agency row" : JSON.stringify(statement)}`);
    } finally {
      hold.release();
    }
    const [ra, rb] = await Promise.all([a.settled, b.settled]);
    rows.push(`${first} first: first ${settled(ra)}, second ${settled(rb)}`);
    assert.equal(ra.status, "fulfilled");
    assert.equal(rb.status, "fulfilled");
    if (rb.status === "fulfilled" && rb.value.status === 409) {
      const problem = asProblem(w, rb.value);
      assert.deepEqual(problem.current, { version: 1, state: first === "agency" ? "AGENCY" : "IN_HOUSE" }, "the refusal names the recorded value");
    }
    assert.deepEqual(await recorded(agencyId), { buyer_type: first, for_economic_activity: true, version: "1", recorded_by_user_id: o.owner.userId }, "one row: the first owner's");
    assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 }, "one row, one event, one committed journal entry");
  }
  assert.deepEqual(rows, [
    "agency first: second waited true at the agency row",
    "agency first: first 201, second 409 PRECONDITION_FAILED BUYER_TYPE_ALREADY_SET",
    "in-house first: second waited true at the agency row",
    "in-house first: first 201, second 409 PRECONDITION_FAILED BUYER_TYPE_ALREADY_SET",
  ]);
  assert.equal(pw.w.internalErrors.length, 0, "no internal error");
});

// --- REVOCATION (A1-T2) -----------------------------------------------------------------------------------------------------------------

test("REVOCATION: closure and buyer type in both orders; after CLOSING no buyer type is written", async () => {
  const { w } = pw;
  // the closure first: CloseAgency holds the agency row (FOR NO KEY UPDATE) and its exclusive half at its active-work inspection; the
  // buyer type waits for exactly the closure's backend at the agency row, reads the agency CLOSING and is refused
  const c = await onboarding("a1-revoke-close-first", { active: true });
  // a client of the agency: CloseAgency's active-work inspection reads it (the hold point)
  await w.h.endClient(c.agency, await w.h.processingAuthority(c.agency), "a1-revoke client");
  const inspecting = w.holds.arm("collaborator");
  const closing = track(close(c.agency.agencyId, c.owner));
  await Promise.race([inspecting.reached, closing.settled]);
  if (closing.done()) {
    inspecting.release();
    await disarm(w, "collaborator", false);
  }
  assert.equal(closing.done() ? settled(await closing.settled) : "held", "held", "the closure reached its inspection");
  const closer = await soleApiBackend(w, "the closure at its inspection");
  const setting = track(setBuyerType(c.agency.agencyId, c.coOwner, "agency"));
  let waited = false;
  try {
    await until("the buyer type waits for the closure", async () => setting.done() || (waited = await otherWaitsExactlyOn(w, closer)));
  } finally {
    inspecting.release();
  }
  const [closed, refused] = await Promise.all([closing.settled, setting.settled]);
  assert.deepEqual({ waited, closure: settled(closed), buyerType: settled(refused) }, { waited: true, closure: "200", buyerType: "409 PRECONDITION_FAILED AGENCY_NOT_OPEN" });
  if (refused.status === "fulfilled") assert.deepEqual(asProblem(w, refused.value).current?.state, "CLOSING");
  assert.equal(await agencyState(c.agency.agencyId), "CLOSING");
  assert.deepEqual(await footprint(c.agency.agencyId), { rows: 0, events: 0, journal: 0 }, "after CLOSING no buyer type is written");
  // a later request on the CLOSING agency is refused the same way and writes nothing
  assert.equal(outcome(w, await setBuyerType(c.agency.agencyId, c.owner, "in-house")), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN");
  assert.deepEqual(await footprint(c.agency.agencyId), { rows: 0, events: 0, journal: 0 });

  // the buyer type first: it holds the agency row until its commit; the closure waits for exactly its backend at the agency row, then
  // closes the agency with the type recorded (a buyer type is no obligation of the closure)
  const b = await onboarding("a1-revoke-type-first", { active: true });
  const commit = w.holds.arm("journal.commit");
  const recording = track(setBuyerType(b.agency.agencyId, b.coOwner, "in-house"));
  await Promise.race([commit.reached, recording.settled]);
  if (recording.done()) {
    commit.release();
    await disarm(w, "journal.commit", false);
  }
  assert.equal(recording.done() ? settled(await recording.settled) : "held", "held", "the buyer type reached its commit");
  const recorder = await soleApiBackend(w, "the buyer type at its commit");
  const closingAfter = track(close(b.agency.agencyId, b.owner));
  let closureWaited = false;
  try {
    await until("the closure waits for the buyer type", async () => closingAfter.done() || (closureWaited = await otherWaitsExactlyOn(w, recorder)));
  } finally {
    commit.release();
  }
  const [rec, closedAfter] = await Promise.all([recording.settled, closingAfter.settled]);
  assert.deepEqual({ closureWaited, buyerType: settled(rec), closure: settled(closedAfter) }, { closureWaited: true, buyerType: "201", closure: "200" });
  assert.deepEqual(await recorded(b.agency.agencyId), { buyer_type: "in-house", for_economic_activity: true, version: "1", recorded_by_user_id: b.coOwner.userId });
  assert.equal(await agencyState(b.agency.agencyId), "CLOSING");
});

// --- TIMEOUT ----------------------------------------------------------------------------------------------------------------------------

test("TIMEOUT: a lock wait past the statement timeout writes nothing and the same key succeeds once", async () => {
  const { w } = pw;
  const o = await onboarding("a1-timeout");
  const agencyId = o.agency.agencyId;
  const key = freshKey("a1-timeout");
  // another session holds the agency row FOR NO KEY UPDATE (as a transition of the agency does); the command's units run under the
  // injected bound, so its wait for the row ends at the bound (57014), inside the operation
  const locker = await w.h.pg.connect("postgres");
  let timedOut: Reply | undefined;
  let elapsed = 0;
  let waitingStatement = "";
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT agency_id FROM kauro.agencies WHERE agency_id = $1 FOR NO KEY UPDATE", [agencyId]);
    injected.statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const started = Date.now();
    const pending = track(setBuyerType(agencyId, o.owner, "agency", { key }));
    let pid: number | null = null;
    await until("the command waits at a row lock, or answers", async () => pending.done() || (pid = await lockWaiter("FOR NO KEY UPDATE")) !== null);
    assert.notEqual(pid, null, "the command waited on a row lock before it answered");
    waitingStatement = await statementOf(pid!);
    const answer = await pending.settled;
    assert.equal(answer.status, "fulfilled");
    timedOut = answer.status === "fulfilled" ? answer.value : undefined;
    elapsed = Date.now() - started;
  } finally {
    injected.statementTimeoutMs = null;
    await locker.query("ROLLBACK");
    await locker.end();
  }
  assert.ok(timedOut);
  assert.match(waitingStatement, /FROM kauro\.agencies[\s\S]*FOR NO KEY UPDATE/, "the command waited at the agency row");
  assert.equal(outcome(w, timedOut), "503 CAPACITY_UNAVAILABLE -");
  assert.ok(elapsed >= INJECTED_STATEMENT_TIMEOUT_MS && elapsed < INJECTED_STATEMENT_TIMEOUT_MS + LOCK_WAIT_OBSERVATION_MS, `the bound fired at the injected statement timeout (${elapsed} ms)`);
  assert.deepEqual(await footprint(agencyId), { rows: 0, events: 0, journal: 0 }, "nothing written");
  assert.equal(await w.journal(key), null, "the key is not consumed");
  // the same key succeeds once; its identical retry replays it
  const first = await setBuyerType(agencyId, o.owner, "agency", { key });
  assert.equal(first.status, 201, first.text);
  const again = await setBuyerType(agencyId, o.owner, "agency", { key });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.text, replayTextOf(first));
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
  assert.equal((await apiBusy(w)).length, 0, "no api backend is left inside a request");
});

// --- CRASH-BEFORE / CRASH-AFTER --------------------------------------------------------------------------------------------------------

test("CRASH-BEFORE: a crash at the journal commit leaves no row, event or journal entry, and the same key records it once", async () => {
  const { w } = pw;
  const o = await onboarding("a1-crash-before");
  const agencyId = o.agency.agencyId;
  const key = freshKey("a1-crash-before");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  let crashed: Reply;
  try {
    crashed = await setBuyerType(agencyId, o.owner, "in-house", { key });
  } finally {
    await disarm(w, "journal.commit", false);
  }
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(agencyId), { rows: 0, events: 0, journal: 0 }, "the row and the event were written and never committed");
  assert.equal(await w.journal(key), null);
  const retried = answered<BuyerTypeView>(await setBuyerType(agencyId, o.owner, "in-house", { key }), 201);
  assert.deepEqual([retried.data.buyerType, retried.data.version, retried.replayed], ["in-house", 1, false]);
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
});

test("CRASH-AFTER: an answer lost after COMMIT leaves the recorded type, and the same key replays the committed 201", async () => {
  const { w } = pw;
  const o = await onboarding("a1-crash-after");
  const agencyId = o.agency.agencyId;
  const key = freshKey("a1-crash-after");
  w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT") });
  let lost: Reply;
  try {
    lost = await setBuyerType(agencyId, o.owner, "agency", { key });
  } finally {
    await disarm(w, "after.commit", false);
  }
  assert.equal(outcome(w, lost), "500 INTERNAL_ERROR -");
  // committed: the row, its event and the journaled 201
  assert.deepEqual(await recorded(agencyId), { buyer_type: "agency", for_economic_activity: true, version: "1", recorded_by_user_id: o.owner.userId });
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status], ["COMMITTED", 201]);
  // the retry under the same key answers the committed result, flagged as a replay, and writes nothing more
  const replay = answered<BuyerTypeView>(await setBuyerType(agencyId, o.owner, "agency", { key }), 201);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, journal?.body, "the replay is the journaled answer");
  assert.deepEqual([replay.data.agencyId, replay.data.buyerType, replay.data.forEconomicActivity, replay.data.version], [agencyId, "agency", true, 1]);
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
});

// --- RETRY ------------------------------------------------------------------------------------------------------------------------------

test("RETRY: an identical replay answers the same bytes, the same key with another body is IDEMPOTENCY_CONFLICT, and a new key is idempotent on the content", async () => {
  const { w } = pw;
  const o = await onboarding("a1-retry");
  const agencyId = o.agency.agencyId;
  const key = freshKey("a1-retry");
  const first = await setBuyerType(agencyId, o.owner, "in-house", { key });
  assert.equal(first.status, 201, first.text);
  // (1) identical replay: the same bytes with `replayed` flipped, nothing written
  const replay = await setBuyerType(agencyId, o.owner, "in-house", { key });
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
  // (2) the same key with another body is another request: a conflict, nothing written, the type unchanged
  assert.equal(outcome(w, await setBuyerType(agencyId, o.owner, "agency", { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
  assert.equal((await recorded(agencyId))?.buyer_type, "in-house");
  // (3) a new key with the recorded value (the same answer delivered twice by a client that lost its key): 200 with the recorded view,
  // journaled, no second row and no second event; the other value under a new key is BUYER_TYPE_ALREADY_SET naming the recorded one
  const firstView = first.json<{ data: BuyerTypeView }>().data;
  const same = answered<BuyerTypeView>(await setBuyerType(agencyId, o.coOwner, "in-house"), 200);
  assert.deepEqual([same.replayed, same.data], [false, firstView]);
  const other = await setBuyerType(agencyId, o.coOwner, "agency");
  assert.equal(outcome(w, other), "409 PRECONDITION_FAILED BUYER_TYPE_ALREADY_SET");
  assert.deepEqual(asProblem(w, other).current, { version: 1, state: "IN_HOUSE" });
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 2 }, "the equal answer is journaled; the refusal is not");
  // the recorded event has no consumer: no redelivery can apply it twice
  const [event] = await w.events("agency_buyer_type", agencyId);
  assert.deepEqual(await w.outbox(event!.eventId), []);
});

// --- PARTIAL ----------------------------------------------------------------------------------------------------------------------------

test("PARTIAL: the event write failing after the row insert rolls back the row and the journal entry, and the same key records it once", async () => {
  const { w } = pw;
  const o = await onboarding("a1-partial");
  const agencyId = o.agency.agencyId;
  const key = freshKey("a1-partial");
  injected.failEventType = EVENT_TYPE;
  let failed: Reply;
  let armed: string | null;
  try {
    failed = await setBuyerType(agencyId, o.owner, "agency", { key });
  } finally {
    armed = injected.failEventType;
    injected.failEventType = null;
  }
  assert.equal(outcome(w, failed), "500 INTERNAL_ERROR -");
  assert.equal(armed, null, "the event write was reached and failed");
  assert.deepEqual(await footprint(agencyId), { rows: 0, events: 0, journal: 0 }, "the row, the event and the journal entry are rolled back together");
  assert.equal(await w.journal(key), null);
  const retried = answered<BuyerTypeView>(await setBuyerType(agencyId, o.owner, "agency", { key }), 201);
  assert.deepEqual([retried.data.buyerType, retried.replayed], ["agency", false]);
  assert.deepEqual(await footprint(agencyId), { rows: 1, events: 1, journal: 1 });
});

// --- end to end: CreateQuote and AcceptAttribution read the recorded type ---------------------------------------------------------------

interface Selling extends Onboarding {
  readonly billing: Person;
  readonly clientId: string;
  readonly profileId: FiscalProfileId;
}

async function sellingAgency(label: string): Promise<Selling> {
  const { w } = pw;
  const o = await onboarding(label, { active: true });
  const billing = await w.person(`${label}-billing`);
  await w.h.addMember(o.agency, billing.userId, "BILLING");
  const authority = await w.h.processingAuthority(o.agency);
  const clientId = await w.h.endClient(o.agency, authority, `${label} client`);
  const profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: pw.kora.userId as UserId, agencyId: o.agency.agencyId, issuerRef: pw.issuerRef });
  return { ...o, billing, clientId, profileId };
}

test("E2E: CreateQuote is BUYER_TYPE_UNSET until the owner records the buyer type through the api, then issues the quote", async () => {
  const { w } = pw;
  const s = await sellingAgency("a1-e2e-quote");
  const { projectId } = await w.project(s.agency, s.clientId as never);
  const plan = await w.approvable(s.agency, projectId, "a1-e2e-quote", "SET", { recent: true });
  await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  const quote = (key: string) => call(w, { url: `/api/v1/projects/${projectId}/quotes`, token: s.billing.token, agency: s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: s.profileId } });
  assert.equal(outcome(w, await quote(freshKey("a1-e2e-unset"))), "409 PRECONDITION_FAILED BUYER_TYPE_UNSET");
  assert.equal(await w.count("quotes", "project_id = $1", [projectId]), 0);
  answered<BuyerTypeView>(await setBuyerType(s.agency.agencyId, s.owner, "agency"), 201);
  const issued = answered<CreateQuoteView>(await quote(freshKey("a1-e2e-set")), 201);
  assert.deepEqual([issued.data.quote.state, issued.data.quote.projectId, issued.data.quote.agencyId], ["ISSUED", projectId, s.agency.agencyId]);
  assert.equal(await w.count("quotes", "project_id = $1 AND state = 'ISSUED'", [projectId]), 1);
});

test("E2E: AcceptAttribution reads the recorded type in the corporate owner's context — in-house is IN_HOUSE_NOT_ATTRIBUTABLE, agency is accepted", async () => {
  const { w } = pw;
  const house = await onboarding("a1-e2e-house");
  const agency = await onboarding("a1-e2e-agency");
  answered<BuyerTypeView>(await setBuyerType(house.agency.agencyId, house.owner, "in-house"), 201);
  answered<BuyerTypeView>(await setBuyerType(agency.agency.agencyId, agency.owner, "agency"), 201);
  const seller = await recordSeller(w, pw.kora.userId, "a1-e2e-seller");
  const prospect = await recordProspect(w.h, { by: seller, domain: "a1-e2e-seller.example" });
  const { claimId } = await recordClaim(w.h, { seller, prospectId: prospect.prospectId });
  const allocationOf = (agencyId: string) => prepareAllocation(w.h, { ownerUserId: pw.kora.userId, agencyId, prospectId: prospect.prospectId, shares: [{ seller, claimId, shareBps: 10000 }] });
  const accept = async (allocationId: string) => call(w, { url: `/api/v1/sales/claims/${claimId}/accept`, token: pw.kora.token, agency: null, key: freshKey("a1-e2e-accept"), body: { expectedVersion: 1, shareAllocationRef: allocationId } });
  assert.equal(outcome(w, await accept(await allocationOf(house.agency.agencyId))), "409 PRECONDITION_FAILED IN_HOUSE_NOT_ATTRIBUTABLE");
  assert.equal(await w.count("attribution_claims", "claim_id = $1 AND state = 'SUBMITTED'", [claimId]), 1, "the claim is not ruled");
  const accepted = await accept(await allocationOf(agency.agency.agencyId));
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(await w.count("attribution_claims", "claim_id = $1 AND state = 'ACCEPTED' AND agency_id = $2", [claimId, agency.agency.agencyId]), 1);
});

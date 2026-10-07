// The 6a cells of the B10 failure matrix on CMD027's issuance and the founding reservation it takes (docs/design/B10-failure-matrix.md "CMD027
// CreateQuote (issuance)", "Qualifying-purchase trigger", "Sweep QUOTE_EXPIRY"; GAP codes QUOTE_PAR, SLOT_RELEASE_RACE, QE_CAPTURE_RACE and
// TOCTOU_SOURCE), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md). The REAL CreateQuote route runs its unit of work over a
// connection the harness opened (`faults.on`), the QUOTE_EXPIRY sweep runs one pass of the REAL commission service over another (`sweepOn`), and
// the payment service's reconciliation of a capture (the authorization insert whose trigger consumes the reservation) runs as the payment
// service's SERVICE unit over a third (`faults.unit`), so a race cell observes one actor waiting on the other's lock. PostgreSQL 17 through the
// runtime login roles; the superuser only reads.
//
// The founding cohort has three slots and this file's cells share them: every cell that takes a slot gives it back (a superseding quote releases
// it) except the QE_CAPTURE_RACE cells, whose captures consume them for good; they run last.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CreateQuoteView } from "@kauro/application";
import { commercialSourceReadsOf } from "@kauro/persistence";
import { FaultPoints, faultCell, openConnection, connectionPid, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { agentOf, integrationWorld, oracleRows, planOf, quoted, type Agent, type IntegrationWorld } from "./integration-support.js";
import { bindCells, contend, failureOf, open, sweepOn } from "./b10-cells-support.js";
import { blockedBy } from "./b10-cells-6a-support.js";
import { checkoutOf, quoteFactsOf, type Checkout } from "./commission-support.js";
import type { SqlStep } from "./fault-support.js";
import { asProblem, call, clock, completed, freshKey, ids, outcome, sha, type PlanFixture, type Reply } from "./support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

type Login = "kauro_app_test" | "kauro_payment_test" | "kauro_commission_test";
const connect = (login: Login): Promise<HarnessConnection> => openConnection(iw.h.pg.clientConfig(login));

const quoteCall = (a: Agent, plan: { readonly planId: string; readonly projectId: string }, key: string): Promise<Reply> =>
  call(iw.w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: a.s.profileId } });
const quoteOn = (ctx: FaultContext, conn: HarnessConnection, a: Agent, plan: PlanFixture, key: string, steps: ReadonlyArray<SqlStep> = []): Promise<Reply> =>
  iw.faults.on(conn, "kauro_app", ctx.points, steps, () => quoteCall(a, plan, key));
const view = (reply: Reply): CreateQuoteView => completed<CreateQuoteView>(reply, 201).data;

/** Runs `run` as the operation that must fail at `at` after an earlier step of it completed; a 500 is the failure the api hid. */
async function failsAt(ctx: FaultContext, what: string, at: string, run: () => Promise<Reply>): Promise<void> {
  await ctx.partial(what, at, async () => {
    const seen = iw.w.internalErrors.length;
    const reply = await run();
    if (reply.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(`the request failed: ${reply.status} ${reply.text}`);
    return reply;
  });
}

interface Slot {
  readonly slot_no: number;
  readonly held: boolean;
  readonly live_reservation_id: string | null;
}
const slots = (): Promise<Slot[]> => oracleRows<Slot & Record<string, unknown>>(iw, "SELECT slot_no, held, live_reservation_id FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' ORDER BY slot_no");
const freeSlots = async (): Promise<number> => (await slots()).filter((s) => !s.held).length;

interface Reservation {
  readonly reservation_id: string;
  readonly quote_id: string;
  readonly state: string;
  readonly slot_no: number;
  readonly release_reason: string | null;
  readonly consumed_by_authorization_id: string | null;
  readonly ends_at: string;
  /** The same instant to the microsecond (the database compares it exactly: ends_at above is truncated to the millisecond). */
  readonly ends_at_us: string;
}
const reservationsOf = (agencyId: string): Promise<Reservation[]> =>
  oracleRows<Reservation & Record<string, unknown>>(iw, "SELECT reservation_id, quote_id, state, slot_no, release_reason, consumed_by_authorization_id, to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS ends_at, to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS ends_at_us FROM kauro.founding_slot_reservations WHERE agency_id = $1 ORDER BY created_at", [agencyId]);

/** What an issuance writes for a project and its agency (the journal entry of the key included): the footprint a rolled-back issuance leaves unchanged. */
async function footprint(a: Agent, plan: PlanFixture, key: string): Promise<Record<string, unknown>> {
  const agencyId = a.s.agency.agencyId;
  const [counts] = await oracleRows(
    iw,
    `SELECT (SELECT count(*) FROM kauro.quotes WHERE project_id = $2)::int AS quotes,
            (SELECT string_agg(state, ',' ORDER BY created_at) FROM kauro.quotes WHERE project_id = $2) AS quote_states,
            (SELECT count(*) FROM kauro.price_eligibility_snapshots WHERE project_id = $2)::int AS snapshots,
            (SELECT count(*) FROM kauro.quote_issuances WHERE agency_id = $1)::int AS issuances,
            (SELECT count(*) FROM kauro.domain_events WHERE agency_id = $1 AND event_type LIKE 'quote.%')::int AS quote_events,
            (SELECT string_agg(state, ',' ORDER BY created_at) FROM kauro.founding_slot_reservations WHERE agency_id = $1) AS reservations`,
    [agencyId, plan.projectId],
  );
  return { ...counts, journal: (await iw.w.journal(key))?.state ?? null, slots: await slots() };
}

/** A fresh agency (founding-eligible: no purchase, no reservation yet) and an approved HubSpot plan of 40,000 units. */
async function fresh(label: string): Promise<{ readonly a: Agent; readonly plan: PlanFixture }> {
  const a = await agentOf(iw, label);
  return { a, plan: await planOf(iw, a, label, { units: 40_000 }) };
}

/** Gives the agency's founding slot back: a superseding quote of the plan releases the live quote's reservation. */
async function giveSlotBack(a: Agent, plan: PlanFixture): Promise<void> {
  await quoted(iw, a, plan);
  for (const r of await reservationsOf(a.s.agency.agencyId)) assert.notEqual(r.state, "RESERVED", "the agency's slot was given back");
}

const SLOT_TAKE: SqlStep = { label: "slot_take", match: /UPDATE kauro\.founding_slots SET held = true/ };
const QUOTE_INSERT: SqlStep = { label: "quote_insert", match: /INSERT INTO kauro\.quotes \(/ };
const RESERVATION_INSERT: SqlStep = { label: "reservation_insert", match: /INSERT INTO kauro\.founding_slot_reservations/ };
const SUPERSEDE: SqlStep = { label: "supersede", match: /UPDATE kauro\.quotes AS q SET/, when: (p) => p[2] === "SUPERSEDED" };
const RELEASE: SqlStep = { label: "release", match: /UPDATE kauro\.founding_slot_reservations AS r\s+SET state = 'RELEASED'/ };
const SLOT_FREE: SqlStep = { label: "slot_free", match: /UPDATE kauro\.founding_slots SET held = false/ };
const DRAFTED_EVENT: SqlStep = { label: "drafted_event", match: /INSERT INTO kauro\.domain_events/, when: (p) => p.includes("quote.drafted.v1") };
const ISSUED_EVENT: SqlStep = { label: "issued_event", match: /INSERT INTO kauro\.domain_events/, when: (p) => p.includes("quote.issued.v1") };
const ISSUANCE: SqlStep = { label: "issuance", match: /INSERT INTO kauro\.quote_issuances/ };
const JOURNAL_COMMIT: SqlStep = { label: "journal_commit", match: /UPDATE kauro\.command_journal SET state = 'COMMITTED'/ };

/** One member of a QUOTE_PAR cell: the issuance fails at `at`, the footprint is unchanged, the same key then issues once. */
async function issuanceFailsAt(ctx: FaultContext, label: string, what: string, at: string, steps: ReadonlyArray<SqlStep>, setup?: (a: Agent, plan: PlanFixture) => Promise<void>): Promise<{ readonly a: Agent; readonly plan: PlanFixture; readonly issued: CreateQuoteView }> {
  const { a, plan } = await fresh(label);
  if (setup !== undefined) await setup(a, plan);
  const key = freshKey(label);
  const before = await footprint(a, plan, key);
  const conn = await open("kauro_app_test");
  try {
    await failsAt(ctx, what, at, () => quoteOn(ctx, conn, a, plan, key, steps));
  } finally {
    await conn.end();
  }
  assert.deepEqual(await footprint(a, plan, key), before, `${label}: the whole issuance rolled back (quote, snapshot, slot, reservation, issuance, events, journal entry)`);
  const issued = view(await quoteCall(a, plan, key));
  assert.equal(issued.quote.state, "ISSUED", "the same key issues once");
  const replay = await quoteCall(a, plan, key);
  assert.equal(replay.status, 201);
  assert.equal(view(replay).quote.quoteId, issued.quote.quoteId, "and replays that one quote");
  return { a, plan, issued };
}

// --- QUOTE_PAR ---------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "QUOTE_PAR",
    step: "CMD027 CreateQuote (issuance) / PARTIAL: W2 founding slot take and reservation",
    fault: "partial",
    expect: "RACE (partial): a failure injected after the founding slot update and before the reservation insert, or before the quote insert, rolls the slot and the reservation back; the same key issues once with one RESERVED reservation",
  },
  async (ctx) => {
    for (const [label, at, what] of [
      ["quote-par-w2-res", "db.reservation_insert.before", "the issuance failing after the slot is taken and before its reservation is written"],
      ["quote-par-w2-quote", "db.quote_insert.before", "the issuance failing after the slot is taken and before the quote insert"],
    ] as const) {
      assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
      const { a, plan, issued } = await issuanceFailsAt(ctx, label, what, at, [SLOT_TAKE, QUOTE_INSERT, RESERVATION_INSERT]);
      assert.equal(issued.eligibility.foundingOffer, "RESERVED");
      const reservations = await reservationsOf(a.s.agency.agencyId);
      assert.deepEqual(reservations.map((r) => [r.quote_id, r.state]), [[issued.quote.quoteId, "RESERVED"]], "one reservation, of the quote the key issued");
      assert.ok((await slots()).some((s) => s.held && s.live_reservation_id === reservations[0]!.reservation_id), "its slot held by it");
      await giveSlotBack(a, plan);
    }
  },
);

faultCell(
  {
    id: "QUOTE_PAR",
    step: "CMD027 CreateQuote (issuance) / PARTIAL: W3 supersession of the previous unpaid quote and release of its reservation",
    fault: "partial",
    expect: "RACE (partial): a failure after the previous quote is superseded and before its reservation is released, and after the release and before the new quote insert, rolls both back (the previous quote ISSUED, its reservation RESERVED, its slot held); the same key supersedes once",
  },
  async (ctx) => {
    for (const [label, at, what] of [
      ["quote-par-w3-release", "db.release.before", "the issuance failing after the supersession and before the reservation's release"],
      ["quote-par-w3-insert", "db.quote_insert.before", "the issuance failing after the release and before the new quote insert"],
    ] as const) {
      let previous = "";
      const { a, issued } = await issuanceFailsAt(ctx, label, what, at, [SUPERSEDE, RELEASE, QUOTE_INSERT], async (agent, plan) => {
        const first = await quoted(iw, agent, plan);
        assert.equal(first.eligibility.foundingOffer, "RESERVED", "the previous quote holds a founding reservation");
        previous = first.quote.quoteId;
      });
      assert.equal(issued.supersededQuoteId, previous, "the same key supersedes the previous quote once");
      const chain = await oracleRows<{ quote_id: string; state: string; superseded_by_quote_id: string | null }>(iw, "SELECT quote_id, state, superseded_by_quote_id FROM kauro.quotes WHERE agency_id = $1 ORDER BY created_at", [a.s.agency.agencyId]);
      assert.deepEqual(chain.map((q) => [q.quote_id, q.state, q.superseded_by_quote_id]), [[previous, "SUPERSEDED", issued.quote.quoteId], [issued.quote.quoteId, "ISSUED", null]]);
      assert.deepEqual((await reservationsOf(a.s.agency.agencyId)).map((r) => [r.quote_id, r.state, r.release_reason]), [[previous, "RELEASED", "QUOTE_SUPERSEDED"]], "released once, the new quote never inherits it");
    }
  },
);

faultCell(
  {
    id: "QUOTE_PAR",
    step: "CMD027 CreateQuote (issuance) / PARTIAL: W4 quote, events, quote_issuances and the journal result",
    fault: "partial",
    expect: "RACE (partial): a failure injected after the quote insert and before its events, after the events and before quote_issuances, and after quote_issuances and before the journal result rolls the whole issuance back; the same key issues once",
  },
  async (ctx) => {
    for (const [label, at, what] of [
      ["quote-par-w4-events", "db.drafted_event.before", "the issuance failing after the quote insert and before quote.drafted.v1"],
      ["quote-par-w4-issuance", "db.issuance.before", "the issuance failing after quote.issued.v1 and before quote_issuances"],
      ["quote-par-w4-journal", "db.journal_commit.before", "the issuance failing after quote_issuances and before the journal result"],
    ] as const) {
      const { a, plan, issued } = await issuanceFailsAt(ctx, label, what, at, [QUOTE_INSERT, DRAFTED_EVENT, ISSUED_EVENT, ISSUANCE, JOURNAL_COMMIT]);
      const issuances = await oracleRows<{ quote_id: string }>(iw, "SELECT quote_id FROM kauro.quote_issuances WHERE agency_id = $1", [a.s.agency.agencyId]);
      assert.deepEqual(issuances.map((i) => i.quote_id), [issued.quote.quoteId], "one issuance, of the quote issued");
      if (issued.eligibility.foundingOffer === "RESERVED") await giveSlotBack(a, plan);
    }
  },
);

// --- SLOT_RELEASE_RACE ----------------------------------------------------------------------------------------------------------------

/** Holds `holder` at `at` on its own connection, observes `waiter` waiting on it, then lets both settle (pg_stat_activity, pg_blocking_pids). */
async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: { readonly login: Login; run(c: HarnessConnection): Promise<H> }, waiter: { readonly login: Login; run(c: HarnessConnection): Promise<W> }, at: string): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const hc = await connect(holder.login);
  const wc = await connect(waiter.login);
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => holder.run(hc));
    const settledHolder = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await pause.reachedBy(running);
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => waiter.run(c), what);
    pause.release();
    return { held: await settledHolder, waited: await waiting.pending };
  } finally {
    await hc.end();
    await wc.end();
  }
}
type Raced = { readonly held: PromiseSettledResult<unknown>; readonly waited: PromiseSettledResult<unknown> };
type Report = { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> };
const value = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};
/** The QUOTE_EXPIRY pass standing a minute past the reservation's end, on `conn`. */
const expiryPassOn = (ctx: Pick<FaultContext, "points">, conn: HarnessConnection, endsAt: string, steps: ReadonlyArray<SqlStep> = [], expectFailure = false, afterMs = 60_000) =>
  sweepOn(ctx, conn, "QUOTE_EXPIRY", steps, afterMs === 0 ? endsAt : new Date(Date.parse(endsAt) + afterMs).toISOString(), expectFailure ? { expectFailure: true } : {});
const quoteState = async (quoteId: string): Promise<string> => (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.quotes WHERE quote_id = $1", [quoteId]))[0]!.state;

faultCell(
  {
    id: "SLOT_RELEASE_RACE",
    step: "CMD027 CreateQuote (issuance) / REVOCATION: W3 the QUOTE_EXPIRY sweep releasing the reservation a superseding CreateQuote releases",
    fault: "race",
    expect: "RACE: the QUOTE_EXPIRY sweep racing a superseding CreateQuote of the same quote releases its slot exactly once in both orders, and the slot is free for exactly one next reservation",
  },
  async (ctx) => {
    for (const order of ["sweep first", "supersession first"] as const) {
      assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
      const { a, plan } = await fresh(`slot-release-${order === "sweep first" ? "sweep" : "quote"}`);
      const first = await quoted(iw, a, plan);
      const [reservation] = await reservationsOf(a.s.agency.agencyId);
      assert.ok(reservation !== undefined && reservation.state === "RESERVED" && reservation.quote_id === first.quote.quoteId);
      const key = freshKey("slot-release");
      const sweep = { login: "kauro_commission_test" as const, run: (c: HarnessConnection) => expiryPassOn(ctx, c, reservation.ends_at, [SLOT_FREE], true) };
      const supersede = { login: "kauro_app_test" as const, run: (c: HarnessConnection) => quoteOn(ctx, c, a, plan, key) };
      const raced: Raced =
        order === "sweep first"
          ? await holdAndWait(ctx, "the superseding CreateQuote while the sweep holds the expired quote and its released slot", sweep, supersede, "db.slot_free.after")
          : await holdAndWait(ctx, "the QUOTE_EXPIRY pass while the superseding CreateQuote holds the quote", supersede, sweep, "uow.before-commit");
      const report = value(order === "sweep first" ? raced.held : raced.waited) as Report;
      for (const item of report.items.filter((i) => i.outcome.startsWith("FAILED"))) {
        const e = failureOf(item.subject);
        assert.fail(`${order}: the raced QUOTE_EXPIRY pass failed its item ${item.subject} (${item.outcome}): ${e instanceof Error ? e.message : String(e)}`);
      }
      const next = view(value(order === "sweep first" ? raced.waited : raced.held) as Reply);
      const after = await reservationsOf(a.s.agency.agencyId);
      assert.equal(after.length, 1, "no second reservation for the agency");
      if (order === "sweep first") {
        assert.deepEqual(report.items.filter((i) => i.subject === reservation.reservation_id).map((i) => i.outcome), ["RELEASED"]);
        assert.deepEqual([await quoteState(first.quote.quoteId), after[0]!.state, after[0]!.release_reason], ["EXPIRED", "RELEASED", "QUOTE_EXPIRED"], "the sweep expired the quote and released the slot once");
        assert.equal(next.supersededQuoteId, undefined, "the CreateQuote found no live quote to supersede and released nothing");
      } else {
        assert.deepEqual(report.items.filter((i) => i.subject === reservation.reservation_id).map((i) => i.outcome), ["SETTLED"], "the sweep finds the reservation already released");
        assert.deepEqual([await quoteState(first.quote.quoteId), after[0]!.state, after[0]!.release_reason], ["SUPERSEDED", "RELEASED", "QUOTE_SUPERSEDED"], "the supersession released the slot once");
        assert.equal(next.supersededQuoteId, first.quote.quoteId);
      }
      assert.notEqual(next.eligibility.foundingOffer, "RESERVED", "the new quote never inherits the founding reservation");
      const slot = (await slots()).find((s) => s.slot_no === reservation.slot_no)!;
      assert.deepEqual([slot.held, slot.live_reservation_id], [false, null], "the slot is free");
      // free for exactly one next reservation: a fresh agency takes that very slot (the lowest free one)
      const taker = await fresh(`slot-release-taker-${order === "sweep first" ? "sweep" : "quote"}`);
      const taken = await quoted(iw, taker.a, taker.plan);
      assert.equal(taken.eligibility.foundingOffer, "RESERVED");
      const takerReservation = (await reservationsOf(taker.a.s.agency.agencyId))[0]!.reservation_id;
      const takenSlots = (await slots()).filter((s) => s.held && s.live_reservation_id === takerReservation);
      assert.equal(takenSlots.length, 1, "one slot, one reservation");
      await giveSlotBack(taker.a, taker.plan);
    }
  },
);

// --- TOCTOU_SOURCE ---------------------------------------------------------------------------------------------------------------------

const SERVER_NOW_READ: SqlStep = { label: "server_now", match: /SELECT to_char\(kauro\.server_now\(\)/ };

/**
 * CreateQuote whose issuance instant (kauro.server_now(), read once the shared halves are taken, create-quote.ts) the cell puts exactly
 * AT the source's effective deadline or one millisecond before it: the unit is held before that read and its open transaction's server
 * clock (kauro_test.clock_offset_seconds) is set on the controlled clock, so the instant the deadline check compares is the controlled one.
 */
async function createQuoteAt(ctx: FaultContext, a: Agent, plan: PlanFixture, key: string, position: "one instant before" | "at", instant: () => void): Promise<Reply> {
  const conn = await open("kauro_app_test");
  try {
    return await ctx.operation(`CreateQuote issued ${position} the source's deadline`, async (op) => {
      instant();
      // held with the shared halves taken, before the issuance instant is read: the transaction's clock then stands at the controlled instant
      const pause = ctx.points.pause("db.server_now.before");
      const running = quoteOn(ctx, conn, a, plan, key, [SERVER_NOW_READ]);
      await pause.reachedBy(running);
      await op.clock.onServer(conn);
      pause.release();
      return running;
    });
  } finally {
    await conn.end();
  }
}

faultCell(
  {
    id: "TOCTOU_SOURCE",
    step: "CMD027 CreateQuote (issuance) / EXPIRY: W1 the source's retention deadline at the quote's issuance instant",
    fault: "expiry",
    expect: "RACE: a CreateQuote issued one millisecond before the source deadline is ISSUED and promises the source no later than it; one issued exactly at the deadline is SOURCE_EXPIRED with nothing written, never an ISSUED quote at or past it",
  },
  async (ctx) => {
    const { a, plan } = await fresh("toctou-source");
    const availability = await iw.h.commerce.run(iw.h.tenant(a.s.agency.agencyId, a.s.agency.ownerUserId), (uow) => commercialSourceReadsOf(uow).availabilityOf({ agencyId: a.s.agency.agencyId, projectId: plan.projectId, revisionHash: plan.revisionHash } as never));
    assert.ok(availability !== null && availability.state === "SEALED", "the sealed source is available");
    const deadline = ctx.deadline(availability.effectiveDeadline, "the source's effective retention deadline");
    // one instant before the deadline: issued, and its promise never reaches past the deadline
    const early = view(await createQuoteAt(ctx, a, plan, freshKey("toctou-source-before"), "one instant before", () => ctx.clock.before(deadline, 1)));
    assert.equal(Date.parse(early.quote.issuedAt), Date.parse(deadline) - 1, "issued at the controlled instant, one millisecond before the deadline");
    assert.ok(Date.parse(early.quote.sourceAvailableUntil) <= Date.parse(deadline), `the quote promises the source no later than its deadline: ${early.quote.sourceAvailableUntil} > ${deadline}`);
    // exactly at the deadline: the source is expired, nothing is written (the quote of the first member stays the project's live quote)
    const key = freshKey("toctou-source-at");
    const before = await footprint(a, plan, key);
    const reply = await createQuoteAt(ctx, a, plan, key, "at", () => ctx.clock.set(deadline));
    assert.equal(reply.status, 422, `issued at the deadline instant ... the source is expired: ${reply.status} ${reply.text}`);
    assert.equal(outcome(iw.w, reply), "422 SOURCE_EXPIRED -");
    assert.deepEqual(await footprint(a, plan, key), before, "nothing written");
    if (early.eligibility.foundingOffer === "RESERVED") await giveSlotBack(a, plan);
  },
);

// --- QUOTE_EXPIRY re-read: what the sweep may call SETTLED (DENY) ---------------------------------------------------------------------

test("QUOTE_EXPIRY DENY: a reservation RELEASED under a quote that is still ISSUED is INTEGRITY_FAILURE, never SETTLED (the sweep's re-read settles only what its actor left consistent)", async () => {
  const { a, plan } = await fresh("qe-deny-released-issued");
  const first = await quoted(iw, a, plan);
  assert.equal(first.eligibility.foundingOffer, "RESERVED");
  const [reservation] = await reservationsOf(a.s.agency.agencyId);
  assert.ok(reservation !== undefined && reservation.state === "RESERVED");
  const points = new FaultPoints();
  const conn = await open("kauro_commission_test");
  let report: Report;
  try {
    // the pass lists the reservation due and is held before it locks the quote; then the reservation is released without its quote leaving
    // ISSUED (a state no actor of the protocol produces; forced as the superuser with the triggers off), so the reservation's UPDATE policy hides it
    const pause = points.pause("db.quote_lock.before");
    const running = expiryPassOn({ points }, conn, reservation.ends_at, [{ label: "quote_lock", match: /FROM kauro\.quotes WHERE quote_id = \$1 FOR UPDATE/ }], true);
    await pause.reachedBy(running);
    const forced = await iw.h.pg.connect("postgres");
    try {
      await forced.query("BEGIN");
      await forced.query("SET LOCAL session_replication_role = replica");
      await forced.query("UPDATE kauro.founding_slot_reservations SET state = 'RELEASED', release_reason = 'QUOTE_SUPERSEDED', released_at = now(), version = version + 1 WHERE reservation_id = $1", [reservation.reservation_id]);
      await forced.query("UPDATE kauro.founding_slots SET held = false, live_reservation_id = NULL, live_agency_id = NULL, updated_at = now() WHERE live_reservation_id = $1", [reservation.reservation_id]);
      await forced.query("COMMIT");
    } finally {
      await forced.end();
    }
    pause.release();
    report = (await running) as Report;
  } finally {
    await conn.end();
  }
  const outcome = report.items.filter((i) => i.subject === reservation.reservation_id).map((i) => i.outcome);
  assert.equal(outcome.length, 1, "the pass visited the reservation");
  assert.ok(outcome[0]!.startsWith("FAILED"), `the inconsistent state is a failure, not a settlement: ${outcome[0]}`);
  const e = failureOf(reservation.reservation_id) as { readonly code?: string } | undefined;
  assert.equal(e?.code, "INTEGRITY_FAILURE");
  assert.equal(await quoteState(first.quote.quoteId), "ISSUED", "the quote was not touched");
  // leave the agency consistent for the cells that follow (their later passes assert no item fails)
  const owner = await iw.h.pg.connect("postgres");
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = version + 1 WHERE quote_id = $1", [first.quote.quoteId]);
    await owner.query("COMMIT");
  } finally {
    await owner.end();
  }
});

// --- FIRST_ISSUE_ORDER, RELEASE_STALE, LIVE_INDEX_STALE (D10-GAP-25, adversary ADV-5, ADV-7, ADV-9) ----------------------------------

/** A write of the database owner with triggers off: a fault injected by another writer the product does not have (never a product step). */
async function ownerWrite(sql: string, params: ReadonlyArray<unknown>): Promise<void> {
  const owner = await iw.h.pg.connect("postgres");
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(sql, params as unknown[]);
    await owner.query("COMMIT");
  } finally {
    await owner.end();
  }
}
/** One actor's own statement steps (each actor of a cell gets its own labels, so its points are its own). */
const liveReadOf = (actor: string, nth: number): SqlStep => ({ ...LIVE_READ(nth), label: `${actor}_live_read_${nth}` });
const quoteLockOf = (actor: string, nth: number): SqlStep => ({ label: `${actor}_quote_lock_${nth}`, match: /FROM kauro\.quotes WHERE quote_id = \$1 FOR UPDATE/, nth });
/** A STALE_VERSION of CMD027: retryable, its current the project's live quote (else its latest) as it stands now. */
async function assertStaleWithCurrent(reply: Reply, quoteId: string, what: string): Promise<void> {
  const seen = reply.status >= 400 ? outcome(iw.w, reply) : `${reply.status} ${reply.text.slice(0, 300)}`;
  assert.equal(seen, "409 STALE_VERSION -", what);
  const problem = asProblem(iw.w, reply);
  assert.equal(problem.retryable, true, `${what}: retryable`);
  const row = (await oracleRows<{ version: number; state: string }>(iw, "SELECT version::int AS version, state FROM kauro.quotes WHERE quote_id = $1", [quoteId]))[0]!;
  assert.deepEqual(problem.current, { version: row.version, state: row.state }, `${what}: current is the project's quote as it stands`);
}
const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> =>
  p.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );

faultCell(
  {
    id: "FIRST_ISSUE_RACE",
    step:     "CMD027 CreateQuote (issuance) / RACE: W3 the first-issuance lock against a quote row lock, both orders",
    fault: "race",
    expect:
      "RACE (lock order): F holds the project's first-issuance lock (it waited behind the first issuance D and read D's quote X live) and R holds X's row lock after reading X live and finding it expired by the QUOTE_EXPIRY pass. Both orders are forced: F's request for X's row first (observed waiting on R), and R's next lock first (before F asks for X): R never waits on the first-issuance lock while holding a row, so no 40P01 and no 503; R answers the retryable 409 STALE_VERSION with the project's quote as current and writes nothing, F issues once (201), and R's retry supersedes it once. With no first-issuance holder, R takes that lock after X's row and issues 201",
  },
  async (ctx) => {
    for (const order of ["F's row request first", "R's next lock first"] as const) {
      assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
      const tag = order === "F's row request first" ? "f" : "r";
      const { a, plan } = await fresh(`first-order-${tag}`);
      const rowKey = freshKey(`first-order-${tag}-r`);
      const firstKey = freshKey(`first-order-${tag}-f`);
      const money = await moneyRows();
      const dc = await open("kauro_app_test");
      const fc = await open("kauro_app_test");
      const rc = await open("kauro_app_test");
      const sc = await open("kauro_commission_test");
      let first: PromiseSettledResult<Reply>;
      let row: PromiseSettledResult<Reply>;
      let x: string;
      try {
        // D issues the project's first quote X, held before its COMMIT with the first-issuance lock taken
        const hold = ctx.points.pause("uow.before-commit");
        const d = ctx.operation("the first issuance of the project (holder)", () => quoteOn(ctx, dc, a, plan, freshKey(`first-order-${tag}-d`)));
        await hold.reachedBy(d);
        // F read no live quote and waits behind D on the first-issuance lock; once D commits it re-reads X live and stops there
        const reread = ctx.points.pause(`db.f_live_read_2.after`);
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: fc, holder: connectionPid(dc) }, (c) => quoteOn(ctx, c, a, plan, firstKey, [liveReadOf("f", 2)]), "F waiting behind the first issuance");
        hold.release();
        x = view(await d).quote.quoteId;
        await reread.reachedBy(waiting.pending);
        // R reads X live and stops before its lock
        const read = ctx.points.pause("db.r_live_read_1.after");
        const rowOp = settle(ctx.operation("R, held after its live-quote read", () => quoteOn(ctx, rc, a, plan, rowKey, [liveReadOf("r", 1), quoteLockOf("r", 1)])));
        await read.reachedBy(rowOp);
        // the QUOTE_EXPIRY pass expires X (it stops being live) while neither holds its row
        const [reservation] = await reservationsOf(a.s.agency.agencyId);
        assert.ok(reservation !== undefined && reservation.quote_id === x && reservation.state === "RESERVED", "X holds the agency's founding reservation");
        const report = (await expiryPassOn(ctx, sc, reservation.ends_at)) as Report;
        assert.deepEqual(report.items.filter((i) => i.subject === reservation.reservation_id).map((i) => i.outcome), ["RELEASED"]);
        assert.equal(await quoteState(x), "EXPIRED");
        // R takes X's row lock and stops
        const locked = ctx.points.pause("db.r_quote_lock_1.after");
        read.release();
        await locked.reachedBy(rowOp);
        if (order === "F's row request first") {
          // F asks for X's row and is observed waiting on R; then R goes for the next lock
          reread.release();
          await blockedBy(iw.h.oracle, connectionPid(rc), "");
          locked.release();
          row = await rowOp;
          first = await waiting.pending;
        } else {
          // R goes for the next lock while F still holds the first-issuance lock and has not asked for X: R must answer, never wait on F
          locked.release();
          const waitedOnF = blockedBy(iw.h.oracle, connectionPid(fc), "").then(
            () => "R waited on the first-issuance lock F holds, while holding X's row",
            () => "R did not wait",
          );
          const settledFirst = await Promise.race([rowOp.then(() => "R answered"), waitedOnF]);
          reread.release();
          row = await rowOp;
          first = await waiting.pending;
          assert.equal(settledFirst, "R answered", "lock order: R never waits on the first-issuance lock after a quote row lock");
        }
      } finally {
        await dc.end();
        await fc.end();
        await rc.end();
        await sc.end();
      }
      assert.equal(first.status, "fulfilled");
      assert.equal(row.status, "fulfilled");
      const firstReply = first.status === "fulfilled" ? (first.value as Reply) : (undefined as never);
      const rowReply = row.status === "fulfilled" ? row.value : (undefined as never);
      const seenOf = (r: Reply): string => (r.status >= 400 ? outcome(iw.w, r) : `${r.status}`);
      assert.deepEqual([seenOf(rowReply), seenOf(firstReply)], ["409 STALE_VERSION -", "201"], `${order}: R refused retryable, F issues: never a deadlock (40P01, answered 503)`);
      await assertStaleWithCurrent(rowReply, x, "R, never 40P01 or 503");
      assert.equal((await iw.w.journal(rowKey))?.state ?? null, null, "the refused key journaled nothing");
      const q1 = view(firstReply).quote.quoteId;
      assert.equal(view(firstReply).supersededQuoteId, undefined, "X expired: nothing to supersede");
      assert.equal((await iw.w.journal(firstKey))?.state, "COMMITTED");
      assert.deepEqual(await chainOf(plan), [[x, "EXPIRED", null], [q1, "ISSUED", null]], "the refused key wrote nothing");
      // R's retry then supersedes F's quote once, and F replays its one quote
      const q2 = view(await quoteCall(a, plan, rowKey));
      assert.equal(q2.supersededQuoteId, q1);
      assert.equal(view(await quoteCall(a, plan, firstKey)).quote.quoteId, q1, "F replays its quote");
      assert.deepEqual(await chainOf(plan), [[x, "EXPIRED", null], [q1, "SUPERSEDED", q2.quote.quoteId], [q2.quote.quoteId, "ISSUED", null]]);
      assert.deepEqual(await moneyRows(), money);
    }
    // no first-issuance holder: R holds X's row, finds X expired and no live quote, takes the first-issuance lock (tried, free) and issues 201
    {
      assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
      const { a, plan } = await fresh("first-order-free");
      const x = (await quoted(iw, a, plan)).quote.quoteId;
      const rowKey = freshKey("first-order-free-r");
      const rc = await open("kauro_app_test");
      const sc = await open("kauro_commission_test");
      let row: PromiseSettledResult<Reply>;
      try {
        const read = ctx.points.pause("db.r_live_read_1.after");
        const rowOp = settle(ctx.operation("R, held after its live-quote read (no first-issuance holder)", () => quoteOn(ctx, rc, a, plan, rowKey, [liveReadOf("r", 1)])));
        await read.reachedBy(rowOp);
        const [reservation] = await reservationsOf(a.s.agency.agencyId);
        assert.ok(reservation !== undefined && reservation.quote_id === x && reservation.state === "RESERVED");
        await expiryPassOn(ctx, sc, reservation.ends_at);
        assert.equal(await quoteState(x), "EXPIRED");
        read.release();
        row = await rowOp;
      } finally {
        await rc.end();
        await sc.end();
      }
      assert.equal(row.status, "fulfilled");
      const reply = row.status === "fulfilled" ? row.value : (undefined as never);
      assert.equal(reply.status >= 400 ? outcome(iw.w, reply) : `${reply.status}`, "201", "the tried first-issuance lock is free: R issues");
      const q = view(reply);
      assert.equal(q.supersededQuoteId, undefined);
      assert.deepEqual(await chainOf(plan), [[x, "EXPIRED", null], [q.quote.quoteId, "ISSUED", null]]);
    }
  },
);

faultCell(
  {
    id: "SLOT_RELEASE_RACE",
    step: "CMD027 CreateQuote (issuance) / RACE: W3 the superseded quote's reservation changed between its read and its release",
    fault: "race",
    expect:
      "DEFENCE (forced state, an injected writer: the QUOTE_EXPIRY pass and CMD043 lock the quote before its reservation and so wait on the issuance's quote lock; the only product writer of the reservation that does not is a capture consuming it, LOCK_NOKEY): another writer changing the superseded quote's founding reservation, uncommitted while the issuance reads it, so that the issuance's release waits on it: once it commits the release finds another version and CreateQuote answers the retryable 409 STALE_VERSION carrying the project's live quote as current, nothing written; the same key then supersedes once",
  },
  async (ctx) => {
    assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
    const { a, plan } = await fresh("release-stale");
    const q0 = (await quoted(iw, a, plan)).quote.quoteId;
    const [reservation] = await reservationsOf(a.s.agency.agencyId);
    assert.ok(reservation !== undefined && reservation.quote_id === q0 && reservation.state === "RESERVED");
    const key = freshKey("release-stale");
    const conn = await open("kauro_app_test");
    // the fault: the database owner (triggers off) moves the reservation's version in a transaction held open while the issuance runs
    const owner = await iw.h.pg.connect("postgres");
    let answered: PromiseSettledResult<Reply>;
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      await owner.query("UPDATE kauro.founding_slot_reservations SET version = version + 1 WHERE reservation_id = $1", [reservation.reservation_id]);
      const ownerPid = (await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const waiting = await ctx.mustWait(iw.h.oracle, { waiter: conn, holder: ownerPid }, (c) => quoteOn(ctx, c, a, plan, key), "the issuance's release waiting on the reservation another writer holds");
      await owner.query("COMMIT");
      answered = await waiting.pending;
    } finally {
      await owner.end();
      await conn.end();
    }
    assert.equal(answered.status, "fulfilled");
    await assertStaleWithCurrent(answered.status === "fulfilled" ? answered.value : (undefined as never), q0, "the issuance whose release lost");
    assert.equal((await iw.w.journal(key))?.state ?? null, null);
    assert.deepEqual(await chainOf(plan), [[q0, "ISSUED", null]], "nothing written");
    const next = view(await quoteCall(a, plan, key));
    assert.equal(next.supersededQuoteId, q0, "the same key then supersedes once");
    await giveSlotBack(a, plan);
  },
);

faultCell(
  {
    id: "FIRST_ISSUE_RACE",
    step: "CMD027 CreateQuote (issuance) / RACE: W4 a live quote appearing between the supersession read and the quote insert",
    fault: "race",
    expect:
      "DEFENCE (forced state, an injected writer: no product writer makes a quote live while CreateQuote holds the project's live quote or its first-issuance lock): another writer making a quote of the project live, uncommitted while the issuance finds none to supersede, so that the issuance's insert waits on it: once it commits quotes_one_live_per_project refuses the insert and CreateQuote answers the retryable 409 STALE_VERSION carrying that quote as current, never 422 INTEGRITY_FAILURE, nothing written; the same key then supersedes it once",
  },
  async (ctx) => {
    assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
    const { a, plan } = await fresh("live-index-stale");
    const q0 = (await quoted(iw, a, plan)).quote.quoteId;
    await ownerWrite("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = version + 1 WHERE quote_id = $1", [q0]);
    const key = freshKey("live-index-stale");
    const conn = await open("kauro_app_test");
    // the fault: the database owner (triggers off) makes q0 live again in a transaction held open while the issuance runs
    const owner = await iw.h.pg.connect("postgres");
    let answered: PromiseSettledResult<Reply>;
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      await owner.query("UPDATE kauro.quotes SET state = 'ISSUED', version = version + 1 WHERE quote_id = $1", [q0]);
      const ownerPid = (await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const waiting = await ctx.mustWait(iw.h.oracle, { waiter: conn, holder: ownerPid }, (c) => quoteOn(ctx, c, a, plan, key), "the issuance's insert waiting on the uncommitted live quote");
      await owner.query("COMMIT");
      answered = await waiting.pending;
    } finally {
      await owner.end();
      await conn.end();
    }
    assert.equal(answered.status, "fulfilled");
    await assertStaleWithCurrent(answered.status === "fulfilled" ? answered.value : (undefined as never), q0, "the issuance refused by the live index");
    assert.equal((await iw.w.journal(key))?.state ?? null, null);
    assert.deepEqual(await chainOf(plan), [[q0, "ISSUED", null]], "nothing written");
    // the same key then supersedes the quote made live (its reservation released): the agency is left consistent for the passes that follow
    const next = view(await quoteCall(a, plan, key));
    assert.equal(next.supersededQuoteId, q0);
    await giveSlotBack(a, plan);
  },
);

// --- QE_CAPTURE_RACE (consumes founding slots for good: last) -------------------------------------------------------------------------

/** A founding quote of a fresh agency, its checkout created at the provider (nothing in flight, nothing captured), and its reservation. */
async function foundingCheckout(label: string): Promise<{ readonly a: Agent; readonly checkout: Checkout; readonly reservation: Reservation }> {
  assert.ok((await freeSlots()) >= 1, `a founding slot is free for ${label} (run the whole file in order)`);
  const { a, plan } = await fresh(label);
  const q = await quoted(iw, a, plan);
  assert.equal(q.eligibility.foundingOffer, "RESERVED");
  const checkout = await checkoutOf(iw, a.s, await quoteFactsOf(iw, a.s, q.quote.quoteId as never));
  const [reservation] = await reservationsOf(a.s.agency.agencyId);
  return { a, checkout, reservation: reservation! };
}

const AUTHORIZATION_INSERT: SqlStep = { label: "authorization", match: /INSERT INTO kauro\.commercial_authorizations/ };

/**
 * The payment service's reconciliation of the provider's capture of the checkout (commission-support captureOf's writes), as its SERVICE unit
 * on `conn`: the capture COMPLETED, the order CAPTURED and the original authorization, whose insert runs the designation (0028) that consumes
 * the founding reservation.
 */
async function captureOn(ctx: FaultContext, conn: HarnessConnection, a: Agent, checkout: Checkout, steps: ReadonlyArray<SqlStep> = []): Promise<{ readonly authorizationId: string }> {
  const { pw } = iw;
  const route = pw.route;
  const quote = checkout.quote;
  pw.paypal.approve(checkout.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(checkout.providerOrderId, { completedAt: new Date(Date.now() - 1000).toISOString() as never });
  const service = { kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() };
  return (await iw.faults.unit(conn, "kauro_payment", ctx.points, steps).run(service as never, async (raw: never) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uow = raw as any;
    if ((await uow.adoptScope("PAYMENT_ORDER", checkout.orderId)) === null) throw new Error("the payment service could not adopt the order's scope");
    const captureId = uow.ids.next();
    const authorizationId = uow.ids.next();
    const now = clock.now();
    await uow.commerce.captures.insert({
      captureId,
      agencyId: a.s.agency.agencyId,
      orderId: checkout.orderId,
      status: "COMPLETED",
      provider: route.provider,
      environment: route.environment,
      providerCaptureId,
      merchantRef: route.merchantRef,
      payeeDigest: route.payeeDigest,
      amountCents: quote.totalCents,
      allocation: { serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0n },
      fundsState: "UNKNOWN",
      providerCompletedAt: new Date(Date.now() - 1000).toISOString(),
      firstObservationSource: "WEBHOOK",
      observedAt: now,
      evidenceHash: sha(`capture-evidence-${captureId}`),
    });
    await uow.scopes.record({ kind: "PROVIDER_CAPTURE", key: `${route.provider}|${route.environment}|${providerCaptureId}`, agencyId: a.s.agency.agencyId, orderId: checkout.orderId, captureId }, now);
    const order = await uow.commerce.orders.lock(checkout.orderId);
    if (order === null || (await uow.commerce.orders.transition(checkout.orderId, order.version, { state: "CAPTURED" }, now)).kind !== "APPLIED") throw new Error("the order's capture was stale");
    await uow.commerce.authorizations.issue({
      authorizationId,
      agencyId: a.s.agency.agencyId,
      projectId: quote.projectId,
      quoteId: quote.quoteId,
      orderId: checkout.orderId,
      orderQuoteId: quote.quoteId,
      captureId,
      approvalId: quote.approvalId,
      approvalHash: quote.approvalHash,
      planId: quote.planId,
      planHash: quote.planHash,
      revisionHash: quote.revisionHash,
      targetContractHash: quote.targetContractHash,
      capabilityId: quote.capabilityId,
      capabilityVersion: quote.capabilityVersion,
      mode: quote.mode,
      billableUnits: quote.billableUnits,
      honoredAfterPriceExpiry: false,
      createdAt: now,
    });
    return { authorizationId };
  })) as { readonly authorizationId: string };
}

interface SlotOutcome {
  readonly reservation: Reservation;
  readonly slot: Slot;
  readonly purchases: number;
  readonly quote: string;
}
async function slotOutcome(x: { readonly a: Agent; readonly checkout: Checkout; readonly reservation: Reservation }): Promise<SlotOutcome> {
  const [reservation] = await reservationsOf(x.a.s.agency.agencyId);
  const slot = (await slots()).find((s) => s.slot_no === x.reservation.slot_no)!;
  const purchases = (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.qualifying_purchases WHERE agency_id = $1", [x.a.s.agency.agencyId]))[0]!.n;
  return { reservation: reservation!, slot, purchases, quote: await quoteState(x.checkout.quote.quoteId) };
}
/** Consumed once or released once, never both: a CONSUMED reservation keeps its slot and names the purchase; a RELEASED one frees it and none consumed it. */
function neverBoth(o: SlotOutcome): "CONSUMED" | "RELEASED" {
  if (o.reservation.state === "CONSUMED") {
    assert.ok(o.reservation.consumed_by_authorization_id !== null, "consumed by the designating authorization");
    assert.deepEqual([o.slot.held, o.slot.live_reservation_id, o.reservation.release_reason], [true, o.reservation.reservation_id, null], "a consumed slot is held by its reservation and never released");
    assert.equal(o.purchases, 1);
    return "CONSUMED";
  }
  assert.equal(o.reservation.state, "RELEASED", `the reservation ends CONSUMED or RELEASED, not ${o.reservation.state}`);
  assert.deepEqual([o.slot.held, o.slot.live_reservation_id, o.reservation.consumed_by_authorization_id], [false, null, null], "a released slot is free and nothing consumed it");
  return "RELEASED";
}

/** The capture and the QUOTE_EXPIRY pass on one founding reservation, `first` holding its rows while the other is observed waiting on them. */
async function captureAgainstExpiry(ctx: FaultContext, label: string, first: "capture" | "sweep") {
  const x = await foundingCheckout(label);
  const capture = { login: "kauro_payment_test" as const, run: (c: HarnessConnection) => captureOn(ctx, c, x.a, x.checkout, [AUTHORIZATION_INSERT]) };
  const sweep = { login: "kauro_commission_test" as const, run: (c: HarnessConnection) => expiryPassOn(ctx, c, x.reservation.ends_at, [SLOT_FREE], true) };
  const raced: Raced =
    first === "capture"
      ? await holdAndWait(ctx, "the QUOTE_EXPIRY pass while the capture's designation holds the reservation", capture, sweep, "db.authorization.after")
      : await holdAndWait(ctx, "the capture while the QUOTE_EXPIRY pass holds the expired quote and its released slot", sweep, capture, "db.slot_free.after");
  const captured = (first === "capture" ? raced.held : raced.waited) as PromiseSettledResult<{ readonly authorizationId: string }>;
  const swept = (first === "capture" ? raced.waited : raced.held) as PromiseSettledResult<Report>;
  // the raced pass may report its item FAILED (it hands the error to the sink): the cell names that failure
  if (swept.status === "fulfilled") {
    for (const item of swept.value.items.filter((i) => i.outcome.startsWith("FAILED"))) {
      const e = failureOf(item.subject);
      assert.fail(`the raced QUOTE_EXPIRY pass failed its item ${item.subject} (${item.outcome}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // a later pass past the end decides anything left
  const conn = await open("kauro_commission_test");
  try {
    await expiryPassOn(ctx, conn, x.reservation.ends_at);
  } finally {
    await conn.end();
  }
  return { x, captured, swept, outcome: await slotOutcome(x) };
}

faultCell(
  {
    id: "QE_CAPTURE_RACE",
    step: "Qualifying-purchase trigger (reconciler transaction) / RACE: T3 founding reservation consumption against the QUOTE_EXPIRY sweep",
    fault: "race",
    expect: "RACE: a capture settling while the QUOTE_EXPIRY sweep decides on its reservation, the capture holding its designation: the slot is consumed once, the sweep finds it settled and releases nothing",
  },
  async (ctx) => {
    const r = await captureAgainstExpiry(ctx, "qe-capture-first", "capture");
    assert.equal(r.captured.status, "fulfilled", `the capture committed: ${r.captured.status === "rejected" ? String(r.captured.reason) : ""}`);
    const report = value(r.swept) as { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> };
    assert.deepEqual(report.items.filter((i) => i.subject === r.x.reservation.reservation_id).map((i) => i.outcome), ["SETTLED"], "the sweep found the reservation consumed");
    assert.equal(neverBoth(r.outcome), "CONSUMED");
    assert.equal(r.outcome.reservation.consumed_by_authorization_id, value(r.captured).authorizationId);
    assert.equal(r.outcome.quote, "ACCEPTED_FOR_CHECKOUT", "the paid quote is never expired");
  },
);

faultCell(
  {
    id: "QE_CAPTURE_RACE",
    step: "Sweep QUOTE_EXPIRY / RACE: W the sweep deciding while the capture of its quote settles",
    fault: "race",
    expect: "RACE: the QUOTE_EXPIRY sweep holding the expired quote and its released slot while the capture of that quote waits: the slot is released once and never consumed, or the capture is refused; never both",
  },
  async (ctx) => {
    const r = await captureAgainstExpiry(ctx, "qe-sweep-first", "sweep");
    const report = value(r.swept) as { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> };
    const decided = report.items.filter((i) => i.subject === r.x.reservation.reservation_id).map((i) => i.outcome);
    // the sweep decided first, holding the expired quote and its released slot: RELEASED is the one outcome of this order
    assert.equal(neverBoth(r.outcome), "RELEASED", "the sweep released the slot; the capture that waited on it consumed nothing");
    assert.deepEqual(decided, ["RELEASED"], "the sweep released it");
    assert.equal(r.outcome.purchases, r.captured.status === "fulfilled" ? 1 : 0, "a capture that committed is a purchase that consumed nothing");
  },
);

faultCell(
  {
    id: "QE_CAPTURE_RACE",
    step: "Qualifying-purchase trigger (reconciler transaction) / EXPIRY: T3 a capture confirmed at and after the reservation's 336-hour end",
    fault: "expiry",
    expect: "RACE: a capture confirmed at or after the reservation's 336-hour end consumes the slot or leaves it to the sweep's rule, and the sweep then releases it or finds it consumed: consumed once or released once, never both",
  },
  async (ctx) => {
    // the sweep alone, standing exactly AT the end of a reservation nothing captured: a reservation at its end is due and is released
    {
      const x = await foundingCheckout("qe-expiry-sweep-at");
      const sweepConn = await open("kauro_commission_test");
      let report: Report;
      try {
        report = await expiryPassOn(ctx, sweepConn, x.reservation.ends_at_us, [], false, 0);
      } finally {
        await sweepConn.end();
      }
      assert.deepEqual(report.items.filter((i) => i.subject === x.reservation.reservation_id).map((i) => i.outcome), ["RELEASED"], "the sweep at the reservation's end released it, never NOT_DUE");
      assert.equal(neverBoth(await slotOutcome(x)), "RELEASED");
    }
    // exactly AT the end first (the clock moves only forward), then one millisecond past it: each member is its own founding checkout
    for (const position of ["at", "past"] as const) {
      const x = await foundingCheckout(`qe-expiry-${position}`);
      // the controlled clock reads milliseconds and the reservation's end is stored in microseconds: the AT member stands on the first millisecond
      // AT OR AFTER the end (never the truncated one, which can precede it by up to 999 microseconds), proven by the database's own comparison
      const [atMs] = await oracleRows<{ at_ms: string }>(iw, "SELECT to_char(date_trunc('milliseconds', ends_at + interval '999 microseconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at_ms FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [x.reservation.reservation_id]);
      const deadline = ctx.deadline(position === "at" ? atMs!.at_ms : x.reservation.ends_at, `the founding reservation's 336-hour end (${position})`);
      if (position === "at") {
        const [reached] = await oracleRows<{ reached: boolean; within: boolean }>(iw, "SELECT $1::timestamptz >= ends_at AS reached, $1::timestamptz - ends_at < interval '1 millisecond' AS within FROM kauro.founding_slot_reservations WHERE reservation_id = $2", [deadline, x.reservation.reservation_id]);
        assert.deepEqual(reached, { reached: true, within: true }, "the AT member's clock instant is the end or less than a millisecond after it, never before it (the database's comparison)");
      }
      if (position === "at") ctx.clock.set(deadline);
      else ctx.clock.past(deadline);
      const conn = await connect("kauro_payment_test");
      let captured: PromiseSettledResult<{ readonly authorizationId: string }>;
      try {
        captured = await ctx.operation(`the capture confirmed ${position === "at" ? "at" : "past"} the reservation's end`, async (op) => {
          // the reconciler's SERVICE unit stands on the cell's clock, at or past the end
          iw.faults.clock = op.clock;
          try {
            return { status: "fulfilled" as const, value: await captureOn(ctx, conn, x.a, x.checkout) };
          } catch (reason) {
            return { status: "rejected" as const, reason };
          } finally {
            iw.faults.clock = null;
          }
        });
      } finally {
        await conn.end();
      }
      const sweepConn = await open("kauro_commission_test");
      let report: Report;
      try {
        // the sweep stands exactly at the end too in the first member: a reservation whose end is "now" is due
        report = await expiryPassOn(ctx, sweepConn, position === "at" ? x.reservation.ends_at_us : x.reservation.ends_at, [], false, position === "at" ? 0 : 60_000);
      } finally {
        await sweepConn.end();
      }
      const decided = report.items.filter((i) => i.subject === x.reservation.reservation_id).map((i) => i.outcome);
      const o = await slotOutcome(x);
      const end = neverBoth(o);
      // consumed: the sweep never lists a consumed reservation (or finds it settled); released: the sweep released it, a reservation at its end is due
      if (end === "CONSUMED") assert.ok(decided.length === 0 || (decided.length === 1 && decided[0] === "SETTLED"), `${position}: the sweep left a consumed reservation alone: ${decided.join()}`);
      else assert.deepEqual(decided, ["RELEASED"], `${position}: the sweep released it (a reservation at its end is due, never NOT_DUE)`);
      if (end === "CONSUMED") assert.equal(captured.status, "fulfilled");
      if (captured.status === "fulfilled" && end === "CONSUMED") assert.equal(o.reservation.consumed_by_authorization_id, captured.value.authorizationId);
    }
  },
);

// --- LIVE_QUOTE_RACE ---------------------------------------------------------------------------------------------------------------

/**
 * CreateQuote's nth live-quote read (lockLiveQuote over PgQuoteReads.liveQuoteOf), a plain read followed by the FOR UPDATE of the quote it
 * names. Anchored on liveQuoteOf's own predicate (the double parenthesis before replaces_quote_id), never the issuance core's supersession read.
 */
const LIVE_READ = (nth: number): SqlStep => ({ label: `live_read_${nth}`, match: /^SELECT quote_id FROM kauro\.quotes\s+WHERE agency_id = \$1 AND project_id = \$2\s+AND \(\(replaces_quote_id IS NULL AND state IN/, nth });

/** The money and entitlement rows of the whole world (this file's database): a quote race changes none of them. */
const moneyRows = async (): Promise<Record<string, unknown>> =>
  (
    await oracleRows(
      iw,
      `SELECT (SELECT count(*) FROM kauro.payment_orders)::int AS orders, (SELECT count(*) FROM kauro.capture_facts)::int AS captures,
              (SELECT count(*) FROM kauro.refunds)::int AS refunds, (SELECT count(*) FROM kauro.ledger_entries)::int AS ledger,
              (SELECT count(*) FROM kauro.commercial_authorizations)::int AS authorizations, (SELECT count(*) FROM kauro.purchase_rebindings)::int AS rebindings`,
    )
  )[0]!;
/** The project's quotes, superseded ones first in creation order, the live one last (a held issuance may have started before the one it supersedes). */
const chainOf = async (plan: PlanFixture): Promise<Array<readonly [string, string, string | null]>> =>
  (await oracleRows<{ quote_id: string; state: string; superseded_by_quote_id: string | null }>(iw, "SELECT quote_id, state, superseded_by_quote_id FROM kauro.quotes WHERE project_id = $1 ORDER BY state = 'ISSUED', created_at", [plan.projectId])).map(
    (q) => [q.quote_id, q.state, q.superseded_by_quote_id] as const,
  );

faultCell(
  {
    id: "LIVE_QUOTE_RACE",
    step: "CMD027 CreateQuote (issuance) / RACE: W3 the project's live quote superseded between the live-quote read and its FOR UPDATE, three rounds running",
    fault: "race",
    expect:
      "RACE: a CreateQuote whose project's live quote is superseded by another issuance between its live-quote read and its lock, in each of its three rounds (the first observed waiting on the superseding issuance's row lock), is refused the retryable 409 STALE_VERSION carrying the project's live quote as current, with nothing written; the same key and a fresh key then each issue exactly once, in both orders, and no money or entitlement row changes",
  },
  async (ctx) => {
    for (const order of ["same key first", "fresh key first"] as const) {
      const { a, plan } = await fresh(`live-race-${order === "same key first" ? "same" : "fresh"}`);
      const q0 = (await quoted(iw, a, plan)).quote.quoteId;
      const lateKey = freshKey("live-race-late");
      const money = await moneyRows();
      const hc = await open("kauro_app_test");
      const lc = await open("kauro_app_test");
      let late: PromiseSettledResult<Reply>;
      const superseding: string[] = [];
      try {
        // round 1: the late request reads q0 live and waits on the row lock of the issuance superseding q0, held before its COMMIT
        const hold = ctx.points.pause("uow.before-commit");
        const first = ctx.operation("the issuance superseding the live quote (holder)", () => quoteOn(ctx, hc, a, plan, freshKey("live-race-1")));
        await hold.reachedBy(first);
        const round2 = ctx.points.pause("db.live_read_2.after");
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: lc, holder: connectionPid(hc) }, (c) => quoteOn(ctx, c, a, plan, lateKey, [LIVE_READ(2), LIVE_READ(3)]), "the late CreateQuote locking the live quote it read");
        hold.release();
        superseding.push(view(await first).quote.quoteId);
        // rounds 2 and 3: after each live-quote read, another issuance supersedes the quote just read and commits before the lock
        await round2.reachedBy(waiting.pending);
        superseding.push((await quoted(iw, a, plan)).quote.quoteId);
        const round3 = ctx.points.pause("db.live_read_3.after");
        round2.release();
        await round3.reachedBy(waiting.pending);
        superseding.push((await quoted(iw, a, plan)).quote.quoteId);
        round3.release();
        late = await waiting.pending;
      } finally {
        await hc.end();
        await lc.end();
      }
      assert.equal(late.status, "fulfilled");
      const refused = late.status === "fulfilled" ? late.value : (undefined as never);
      assert.equal(outcome(iw.w, refused), "409 STALE_VERSION -", `the late request is refused after three rounds, never an issuance on a superseded quote: ${outcome(iw.w, refused)}`);
      const [q1, q2, q3] = superseding as [string, string, string];
      const problem = asProblem(iw.w, refused);
      assert.equal(problem.retryable, true, "the refusal of a race is retryable (the same key then issues once)");
      const live = (await oracleRows<{ version: number }>(iw, "SELECT version::int AS version FROM kauro.quotes WHERE quote_id = $1", [q3]))[0]!;
      assert.deepEqual(problem.current, { version: live.version, state: "ISSUED" }, "current is the project's live quote, read after the last round");
      // nothing written by the late request: its journal entry, no quote, issuance or event of its own
      assert.deepEqual(await chainOf(plan), [[q0, "SUPERSEDED", q1], [q1, "SUPERSEDED", q2], [q2, "SUPERSEDED", q3], [q3, "ISSUED", null]], "only the three superseding issuances wrote quotes");
      assert.equal((await iw.w.journal(lateKey))?.state ?? null, null, "the refused key journaled nothing");
      const issuances = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.quote_issuances WHERE project_id = $1", [plan.projectId]);
      assert.equal(issuances[0]!.n, 4);
      // the retries, in this order's sequence: the same key issues once (and replays it), a fresh key issues once
      const freshKeyOf = freshKey("live-race-fresh");
      const issued: Record<string, string> = {};
      for (const key of order === "same key first" ? [lateKey, freshKeyOf] : [freshKeyOf, lateKey]) {
        const reply = await quoteCall(a, plan, key);
        issued[key] = view(reply).quote.quoteId;
        assert.equal((await iw.w.journal(key))?.state, "COMMITTED");
      }
      const replay = await quoteCall(a, plan, lateKey);
      assert.equal(view(replay).quote.quoteId, issued[lateKey], "the same key replays its one quote");
      const [r1, r2] = (order === "same key first" ? [issued[lateKey], issued[freshKeyOf]] : [issued[freshKeyOf], issued[lateKey]]) as [string, string];
      assert.deepEqual(await chainOf(plan), [[q0, "SUPERSEDED", q1], [q1, "SUPERSEDED", q2], [q2, "SUPERSEDED", q3], [q3, "SUPERSEDED", r1], [r1, "SUPERSEDED", r2], [r2, "ISSUED", null]], "each retry issued exactly once");
      const after = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.quote_issuances WHERE project_id = $1", [plan.projectId]);
      assert.equal(after[0]!.n, 6);
      assert.deepEqual(await moneyRows(), money, "no order, capture, refund, ledger entry, entitlement or re-binding changed");
      await giveSlotBack(a, plan);
    }
  },
);

// --- FIRST_ISSUE_RACE --------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "FIRST_ISSUE_RACE",
    step: "CMD027 CreateQuote (issuance) / RACE: W3 two first issuances of a project with no live quote",
    fault: "race",
    expect:
      "RACE: two CreateQuotes under different keys on a project with no live quote, in both orders, the second observed waiting on the first held before its COMMIT and the second held after its live-quote read while the first commits: the issuances serialize on the project and the second supersedes the first (201 naming it), never 422 INTEGRITY_FAILURE; each key journals its one quote and no money or entitlement row changes",
  },
  async (ctx) => {
    for (const order of ["key A first", "key B first"] as const) {
      const tag = order === "key A first" ? "a" : "b";
      const keyA = freshKey(`first-race-${tag}-a`);
      const keyB = freshKey(`first-race-${tag}-b`);
      const [firstKey, secondKey] = order === "key A first" ? [keyA, keyB] : [keyB, keyA];
      // 1. the second waits on the first, held before its COMMIT with its quote inserted
      {
        const { a, plan } = await fresh(`first-race-wait-${tag}`);
        const money = await moneyRows();
        const raced = await contend(
          ctx,
          { name: `the first issuance (${order})`, login: "kauro_app_test", holdAt: "uow.before-commit", run: (conn) => quoteOn(ctx, conn, a, plan, firstKey) },
          { name: "the other key's first issuance", login: "kauro_app_test", holdAt: "-", run: (conn) => quoteOn(ctx, conn, a, plan, secondKey) },
          `two first issuances of one project (${order})`,
        );
        assert.equal(raced.holder.status, "fulfilled");
        assert.equal(raced.waiter.status, "fulfilled");
        const first = raced.holder.status === "fulfilled" ? (raced.holder.value as Reply) : (undefined as never);
        const second = raced.waiter.status === "fulfilled" ? (raced.waiter.value as Reply) : (undefined as never);
        assert.equal(first.status, 201, `the first issues: ${first.text}`);
        assert.equal(second.status, 201, `the waiting issuance supersedes the first, never 422: ${second.status === 201 ? "" : outcome(iw.w, second)}`);
        const q1 = view(first).quote.quoteId;
        const q2 = view(second);
        assert.equal(q2.supersededQuoteId, q1, "the second supersedes the first");
        assert.deepEqual(await chainOf(plan), [[q1, "SUPERSEDED", q2.quote.quoteId], [q2.quote.quoteId, "ISSUED", null]]);
        assert.equal((await iw.w.journal(firstKey))?.state, "COMMITTED");
        assert.equal((await iw.w.journal(secondKey))?.state, "COMMITTED");
        assert.deepEqual(await moneyRows(), money, "no order, capture, refund, ledger entry, entitlement or re-binding changed");
        await giveSlotBack(a, plan);
      }
      // 2. the second held right after its live-quote read found none, while the first issues and commits
      {
        const { a, plan } = await fresh(`first-race-read-${tag}`);
        const money = await moneyRows();
        const lc = await open("kauro_app_test");
        let held: PromiseSettledResult<Reply>;
        let q1: string;
        try {
          const read = ctx.points.pause("db.live_read_1.after");
          const second = ctx.operation("the other key's first issuance, held after its live-quote read", () => quoteOn(ctx, lc, a, plan, secondKey, [LIVE_READ(1)])).then(
            (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
            (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
          );
          await read.reachedBy(second);
          q1 = view(await ctx.operation(`the first issuance (${order}), run to its answer`, () => quoteCall(a, plan, firstKey))).quote.quoteId;
          read.release();
          held = await second;
        } finally {
          await lc.end();
        }
        assert.equal(held.status, "fulfilled");
        const reply = held.status === "fulfilled" ? held.value : (undefined as never);
        assert.equal(reply.status, 201, `the held issuance supersedes the first, never 422: ${reply.status === 201 ? "" : outcome(iw.w, reply)}`);
        const q2 = view(reply);
        assert.equal(q2.supersededQuoteId, q1);
        assert.deepEqual(await chainOf(plan), [[q1, "SUPERSEDED", q2.quote.quoteId], [q2.quote.quoteId, "ISSUED", null]]);
        assert.equal((await iw.w.journal(firstKey))?.state, "COMMITTED");
        assert.equal((await iw.w.journal(secondKey))?.state, "COMMITTED");
        assert.deepEqual(await moneyRows(), money);
        await giveSlotBack(a, plan);
      }
    }
  },
);


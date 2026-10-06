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
import { after, before } from "node:test";
import type { CreateQuoteView } from "@kauro/application";
import { commercialSourceReadsOf } from "@kauro/persistence";
import { faultCell, openConnection, connectionPid, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { agentOf, integrationWorld, oracleRows, planOf, quoted, type Agent, type IntegrationWorld } from "./integration-support.js";
import { bindCells, failureOf, open, sweepOn } from "./b10-cells-support.js";
import { checkoutOf, quoteFactsOf, type Checkout } from "./commission-support.js";
import type { SqlStep } from "./fault-support.js";
import { routedUnitsIssueWithTheRegistryPolicy } from "./b10-cells-6a-support.js";
import { call, clock, completed, freshKey, ids, outcome, sha, type PlanFixture, type Reply } from "./support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
  routedUnitsIssueWithTheRegistryPolicy();
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
}
const reservationsOf = (agencyId: string): Promise<Reservation[]> =>
  oracleRows<Reservation & Record<string, unknown>>(iw, "SELECT reservation_id, quote_id, state, slot_no, release_reason, consumed_by_authorization_id, to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS ends_at FROM kauro.founding_slot_reservations WHERE agency_id = $1 ORDER BY created_at", [agencyId]);

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
const UNITS_READ: SqlStep = { label: "units", match: /billable_source_units::text AS units/ };

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
const expiryPassOn = (ctx: FaultContext, conn: HarnessConnection, endsAt: string, steps: ReadonlyArray<SqlStep> = [], expectFailure = false) =>
  sweepOn(ctx, conn, "QUOTE_EXPIRY", steps, new Date(Date.parse(endsAt) + 60_000).toISOString(), expectFailure ? { expectFailure: true } : {});
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
      const sweep = { login: "kauro_commission_test" as const, run: (c: HarnessConnection) => expiryPassOn(ctx, c, reservation.ends_at, [SLOT_FREE]) };
      const supersede = { login: "kauro_app_test" as const, run: (c: HarnessConnection) => quoteOn(ctx, c, a, plan, key) };
      const raced: Raced =
        order === "sweep first"
          ? await holdAndWait(ctx, "the superseding CreateQuote while the sweep holds the expired quote and its released slot", sweep, supersede, "db.slot_free.after")
          : await holdAndWait(ctx, "the QUOTE_EXPIRY pass while the superseding CreateQuote holds the quote", supersede, sweep, "uow.before-commit");
      const report = value(order === "sweep first" ? raced.held : raced.waited) as { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> };
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

faultCell(
  {
    id: "TOCTOU_SOURCE",
    step: "CMD027 CreateQuote (issuance) / EXPIRY: W1 the source's retention deadline crossed while CreateQuote holds its locks",
    fault: "expiry",
    expect: "RACE: the source deadline passing while CreateQuote holds its locks: the quote's availability is never later than the deadline, or the quote is SOURCE_EXPIRED, never an ISSUED quote past it",
  },
  async (ctx) => {
    const { a, plan } = await fresh("toctou-source");
    const availability = await iw.h.commerce.run(iw.h.tenant(a.s.agency.agencyId, a.s.agency.ownerUserId), (uow) => commercialSourceReadsOf(uow).availabilityOf({ agencyId: a.s.agency.agencyId, projectId: plan.projectId, revisionHash: plan.revisionHash } as never));
    assert.ok(availability !== null, "the sealed source is available");
    const deadline = ctx.deadline(availability.effectiveDeadline, "the source's effective retention deadline");
    const key = freshKey("toctou-source");
    const before = await footprint(a, plan, key);
    const conn = await open("kauro_app_test");
    let reply: Reply;
    try {
      reply = await ctx.operation("CreateQuote across the source's deadline", async (op) => {
        // held with every shared half taken (agency, capability, approval, revision, target, profile) and the units read
        const pause = ctx.points.pause("db.units.after");
        const running = quoteOn(ctx, conn, a, plan, key, [UNITS_READ]);
        await pause.reachedBy(running);
        // the deadline passes while the locks are held: the open transaction's server clock now stands past it
        ctx.clock.past(deadline);
        await op.clock.onServer(conn);
        pause.release();
        return running;
      });
    } finally {
      await conn.end();
    }
    if (reply.status === 201) {
      const q = view(reply).quote;
      assert.ok(Date.parse(q.sourceAvailableUntil) <= Date.parse(deadline), `the quote promises the source no later than its deadline: ${q.sourceAvailableUntil} > ${deadline}`);
      assert.ok(Date.parse(q.issuedAt) < Date.parse(deadline), "issued before the deadline it states");
      if (view(reply).eligibility.foundingOffer === "RESERVED") await giveSlotBack(a, plan);
    } else {
      assert.equal(outcome(iw.w, reply), "422 SOURCE_EXPIRED -");
      assert.deepEqual(await footprint(a, plan, key), before, "nothing written");
    }
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
    const end = neverBoth(r.outcome);
    if (end === "RELEASED") {
      assert.deepEqual(decided, ["RELEASED"], "the sweep released it");
      assert.equal(r.outcome.purchases, r.captured.status === "fulfilled" ? 1 : 0, "a capture that committed is a purchase that consumed nothing");
    } else {
      assert.equal(r.captured.status, "fulfilled");
    }
  },
);

faultCell(
  {
    id: "QE_CAPTURE_RACE",
    step: "Qualifying-purchase trigger (reconciler transaction) / EXPIRY: T3 a capture confirmed at or after the reservation's 336-hour end",
    fault: "expiry",
    expect: "RACE: a capture confirmed at or after the reservation's 336-hour end consumes the slot or leaves it to the sweep's rule, and the sweep then releases it or finds it consumed: consumed once or released once, never both",
  },
  async (ctx) => {
    const x = await foundingCheckout("qe-expiry");
    const deadline = ctx.deadline(x.reservation.ends_at, "the founding reservation's 336-hour end");
    ctx.clock.past(deadline);
    const conn = await connect("kauro_payment_test");
    let captured: PromiseSettledResult<{ readonly authorizationId: string }>;
    try {
      captured = await ctx.operation("the capture confirmed past the reservation's end", async (op) => {
        // the reconciler's SERVICE unit stands on the cell's clock, past the end
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
    try {
      await expiryPassOn(ctx, sweepConn, x.reservation.ends_at);
    } finally {
      await sweepConn.end();
    }
    const o = await slotOutcome(x);
    const end = neverBoth(o);
    if (end === "CONSUMED") assert.equal(captured.status, "fulfilled");
    if (captured.status === "fulfilled" && end === "CONSUMED") assert.equal(o.reservation.consumed_by_authorization_id, captured.value.authorizationId);
  },
);

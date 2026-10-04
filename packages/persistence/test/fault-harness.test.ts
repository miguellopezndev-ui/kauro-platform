// Self-test of the common fault harness (docs/design/FAULT-HARNESS.md; @kauro/persistence/testing faults/) on real PostgreSQL 17:
// every primitive does what it claims AND fails when the fault it stands for did not happen — a crash point never reached, a
// pause the operation outran, an interleaving whose lock wait was not observed, a matrix cell whose fault was never injected.
// The contended rows are a probe table of this test's own cluster, written by the control plane's login role.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "pg";
import type { LeaseOwnerId, ResourceId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { ids, sha, start, type Harness } from "../src/testing/harness.js";
import {
  FAULT_KINDS,
  FaultNotInjected,
  FaultPointNotReached,
  FaultPoints,
  InterleavingNotObserved,
  SimulatedCrash,
  bothOrders,
  cellTitle,
  connectionPid,
  concurrently,
  controlledClock,
  crashableFactory,
  crashedAt,
  faultCell,
  faultMatrix,
  inOrder,
  instrumentPort,
  mustWait,
  openConnection,
  partition,
  runCell,
  sequentially,
  terminateBackend,
  type ActorOutcome,
  type RaceScenario,
} from "../src/testing/index.js";

let h: Harness;
let a: Client;
let b: Client;

before(async () => {
  h = await start();
  await h.oracle.query("CREATE SCHEMA fault_probe");
  await h.oracle.query("CREATE TABLE fault_probe.items (id text PRIMARY KEY, n integer NOT NULL DEFAULT 0, writers text[] NOT NULL DEFAULT '{}')");
  await h.oracle.query("GRANT USAGE ON SCHEMA fault_probe TO kauro_control_test; GRANT SELECT, INSERT, UPDATE ON fault_probe.items TO kauro_control_test");
  a = await openConnection(h.pg.clientConfig("kauro_control_test"));
  b = await openConnection(h.pg.clientConfig("kauro_control_test"));
});
after(async () => {
  await a.end();
  await b.end();
  await h.stop();
});

async function item(id: string): Promise<{ n: number; writers: string[] } | undefined> {
  const r = await h.oracle.query<{ n: number; writers: string[] }>("SELECT n, writers FROM fault_probe.items WHERE id = $1", [id]);
  return r.rows[0];
}

async function newItem(): Promise<string> {
  const id = ids.next();
  await h.oracle.query("INSERT INTO fault_probe.items (id) VALUES ($1)", [id]);
  return id;
}

const bump = (c: Client, id: string, who: string) => c.query("UPDATE fault_probe.items SET n = n + 1, writers = writers || $2::text WHERE id = $1", [id, who]);

test("controlled clock: frozen until moved, never backwards; past/before place an instant on either side of a boundary; onServer sets kauro.server_now() of that transaction exactly to the clock, and only of that transaction", async () => {
  const clock = controlledClock("2030-01-01T00:00:00.000Z");
  assert.equal(clock.now(), "2030-01-01T00:00:00.000Z");
  assert.equal(clock.nowMs(), Date.parse("2030-01-01T00:00:00.000Z"));
  assert.equal(clock.at(120_000), "2030-01-01T00:02:00.000Z", "at() reads an offset without moving");
  assert.equal(clock.moves, 0);
  assert.equal(clock.advance(1_000), "2030-01-01T00:00:01.000Z");
  assert.equal(clock.past("2030-01-01T00:02:00.000Z"), "2030-01-01T00:02:00.001Z");
  assert.throws(() => clock.before("2030-01-01T00:02:00.000Z"), RangeError, "before() of a boundary already passed would move backwards");
  assert.throws(() => clock.set("2029-12-31T23:59:59.000Z"), RangeError);
  assert.throws(() => clock.advance(0), RangeError);
  assert.equal(clock.before("2030-01-01T00:05:00.000Z", 1_000), "2030-01-01T00:04:59.000Z");
  assert.equal(clock.moves, 3);
  // the server clock of one transaction stands exactly at the controlled instant; the next transaction is back on real time
  await a.query("BEGIN");
  try {
    assert.equal(await clock.onServer(a), "2030-01-01T00:04:59.000000Z");
    const again = await a.query<{ now: string }>(`SELECT to_char(kauro.server_now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`);
    assert.equal(again.rows[0]?.now, "2030-01-01T00:04:59.000000Z", "stable within the transaction");
  } finally {
    await a.query("COMMIT");
  }
  const real = await a.query<{ skew: number }>("SELECT abs(extract(epoch FROM kauro.server_now() - now()))::float8 AS skew");
  assert.equal(real.rows[0]?.skew, 0, "the offset was transaction-local");
});

test("fault points: an armed crash throws SimulatedCrash where it is reached; a pause holds until released or crashed; unarmed points pass; an armed point never reached and a pause the operation outran FAIL", async () => {
  const points = new FaultPoints();
  const flow = async (log: string[]) => {
    log.push("start");
    await points.pass("step.one");
    log.push("one");
    await points.pass("step.two");
    log.push("two");
  };
  // crash
  const crash = points.crash("step.two");
  const log1: string[] = [];
  await assert.rejects(flow(log1), (e: unknown) => e instanceof SimulatedCrash && e.point === "step.two");
  await crash.reached;
  assert.deepEqual(log1, ["start", "one"]);
  assert.deepEqual(points.crashes, ["step.two"]);
  // pause then release
  const pause = points.pause("step.one");
  const log2: string[] = [];
  const running = flow(log2);
  await pause.reachedBy(running);
  assert.deepEqual(log2, ["start"], "held at the point");
  pause.release();
  await running;
  assert.deepEqual(log2, ["start", "one", "two"]);
  // pause then crash where it waits
  const held = points.pause("step.two");
  const log3: string[] = [];
  const doomed = flow(log3);
  await held.reached;
  held.crash();
  await assert.rejects(doomed, SimulatedCrash);
  assert.deepEqual(log3, ["start", "one"]);
  points.assertAllReached();
  // FAILS: a crash point the run never reaches
  points.crash("step.three");
  await flow([]);
  assert.throws(() => points.assertAllReached(), (e: unknown) => e instanceof FaultPointNotReached && /step\.three/.test(e.message));
  // FAILS: a pause the operation finished without reaching
  const other = new FaultPoints();
  const never = other.pause("never.passed");
  await assert.rejects(never.reachedBy(Promise.resolve("done")), FaultPointNotReached);
  assert.throws(() => other.crash("never.passed"), /already armed/);
});

test("crash before and after COMMIT of a real unit of work (crashableFactory over the control plane's PgUnitOfWorkFactory): before, the lease claim rolls back with the unit; after, it is committed and only the answer is lost", async () => {
  const claim = (resourceId: ResourceId) => (uow: Parameters<Parameters<Harness["control"]["run"]>[1]>[0]) =>
    uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId: ids.next() as LeaseOwnerId, ttlSeconds: 120, deadlineAt: toUtcInstant(Date.now() + 3_600_000), subjectHash: sha("fault"), costAuthorityId: null, checkpointHash: null }, toUtcInstant(Date.now()));
  const leases = async (resourceId: ResourceId) => (await h.oracle.query("SELECT 1 FROM kauro.leases WHERE resource_id = $1", [resourceId])).rows.length;
  const points = new FaultPoints();
  const control = crashableFactory(h.control, points, "uow");
  const r1 = ids.next() as ResourceId;
  points.crash("uow.before-commit");
  await assert.rejects(control.run(h.system(), claim(r1)), crashedAt("uow.before-commit"));
  assert.equal(await leases(r1), 0, "crash before COMMIT: nothing of the unit remains");
  const r2 = ids.next() as ResourceId;
  points.crash("uow.after-commit");
  await assert.rejects(control.run(h.system(), claim(r2)), crashedAt("uow.after-commit"));
  assert.equal(await leases(r2), 1, "crash after COMMIT: the unit committed, its answer was lost");
  const r3 = ids.next() as ResourceId;
  assert.equal((await control.run(h.system(), claim(r3))).kind, "CLAIMED", "unarmed, the decorated factory is the real one");
  assert.deepEqual(points.passed.slice(-2), ["uow.before-commit", "uow.after-commit"]);
  points.assertAllReached();
});

test("instrumentPort: a crash before a provider call means the effect never happened; a crash after it means the effect happened and its answer was lost; the retry that follows sees the effect", async () => {
  const effects: string[] = [];
  const provider = { async place(key: string) { effects.push(key); return { placed: key }; } };
  const points = new FaultPoints();
  const port = instrumentPort(provider, points, "storage");
  points.crash("storage.place.before");
  await assert.rejects(port.place("k1"), crashedAt("storage.place.before"));
  assert.ok(!crashedAt("storage.place.after")(new SimulatedCrash("storage.place.before")), "crashedAt names the point");
  assert.deepEqual(effects, []);
  points.crash("storage.place.after");
  await assert.rejects(port.place("k1"), SimulatedCrash);
  assert.deepEqual(effects, ["k1"], "the effect landed although the caller saw a crash");
  const outcomes = await sequentially(2, () => port.place("k1"));
  assert.deepEqual(partition(outcomes).fulfilled, [{ placed: "k1" }, { placed: "k1" }]);
  assert.deepEqual(points.crashes, ["storage.place.before", "storage.place.after"]);
});

test("terminateBackend: a killed process's open transaction is aborted by the server, never committed, and the crash is recorded", async () => {
  const id = await newItem();
  const victim = await h.pg.connect("kauro_control_test");
  const points = new FaultPoints();
  await victim.query("BEGIN");
  await bump(victim, id, "victim");
  await terminateBackend(h.oracle, victim, points, "victim.died");
  await assert.rejects(victim.query("SELECT 1"));
  assert.deepEqual(await item(id), { n: 0, writers: [] });
  assert.deepEqual(points.crashes, ["victim.died"]);
});

test("mustWait: an operation is observed waiting only when its own statement, on the connection the harness hands it, is blocked by the intended holder; one that is not blocked, or blocked by another backend, FAILS with InterleavingNotObserved", async () => {
  const id = await newItem();
  const holder = connectionPid(a);
  const waiter = b;
  await a.query("BEGIN");
  try {
    await bump(a, id, "a");
    await b.query("BEGIN");
    const { pending } = await mustWait(h.oracle, { waiter, holder }, (c) => bump(c, id, "b"), "b behind a");
    await a.query("COMMIT");
    assert.equal((await pending).status, "fulfilled");
    await b.query("COMMIT");
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
  }
  assert.deepEqual(await item(id), { n: 2, writers: ["a", "b"] });
  // FAILS: nothing holds the row, so the write finishes without waiting
  await assert.rejects(mustWait(h.oracle, { waiter, holder }, (c) => bump(c, id, "b"), "an unblocked write"), InterleavingNotObserved);
  // FAILS: b waits, but on a, not on the holder the probe names
  const other = await h.pg.connect("kauro_control_test");
  await a.query("BEGIN");
  try {
    await bump(a, id, "a");
    await b.query("BEGIN");
    await assert.rejects(mustWait(h.oracle, { waiter, holder: connectionPid(other) }, (c) => bump(c, id, "b"), "b behind a third backend", 500), (e: unknown) => e instanceof InterleavingNotObserved && /never on the holder/.test(e.message));
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
    await other.end();
  }
});

test("bothOrders runs one race under both orders with one call — each actor holds the lock once and the other is observed waiting — and FAILS when the second actor never waits", async () => {
  const seen: string[] = [];
  const scenario: RaceScenario<{ id: string }> = {
    oracle: h.oracle,
    actors: [
      { name: "A", client: a, act: (c, s) => bump(c, s.id, "A") },
      { name: "B", client: b, act: (c, s) => bump(c, s.id, "B") },
    ],
    setup: async () => ({ id: await newItem() }),
    async verify(run) {
      seen.push(run.order.join(">"));
      assert.ok(run.outcomes["A"]?.committed && run.outcomes["B"]?.committed);
      assert.deepEqual(await item(run.state.id), { n: 2, writers: [...run.order] }, "the waiter wrote after the holder committed");
    },
  };
  const runs = await bothOrders(scenario);
  assert.deepEqual(seen, ["A>B", "B>A"]);
  assert.deepEqual(runs.map((r) => r.order), [["A", "B"], ["B", "A"]]);
  // a write that fails once its wait ends is reported as the actor's outcome, and its transaction is rolled back
  const refusing: RaceScenario<{ id: string }> = {
    ...scenario,
    actors: [
      { name: "A", client: a, act: (c, s) => bump(c, s.id, "A") },
      { name: "B", client: b, act: async (c, s) => { await bump(c, s.id, "B"); await c.query("SELECT 1/0"); } },
    ],
    async verify(run) {
      assert.deepEqual(await item(run.state.id), { n: 1, writers: ["A"] });
      assert.equal(run.outcomes["A"]?.committed, true);
      assert.equal(run.outcomes["B"]?.act.status, "rejected");
      assert.equal(run.outcomes["B"]?.commit, null);
      assert.equal(run.outcomes["B"]?.committed, false);
    },
  };
  await inOrder(refusing, "A");
  // FAILS: the actors touch different rows, so the second never waits
  const disjoint: RaceScenario<{ x: string; y: string }> = {
    oracle: h.oracle,
    actors: [
      { name: "A", client: a, act: (c, s) => bump(c, s.x, "A") },
      { name: "B", client: b, act: (c, s) => bump(c, s.y, "B") },
    ],
    setup: async () => ({ x: await newItem(), y: await newItem() }),
    verify: () => assert.fail("never reached: the interleaving did not happen"),
  };
  await assert.rejects(bothOrders(disjoint), InterleavingNotObserved);
  // nothing stays open on either connection after a failed race
  assert.equal((await a.query<{ s: string }>("SELECT 1 AS s")).rows.length, 1);
  assert.equal((await b.query<{ s: string }>("SELECT 1 AS s")).rows.length, 1);
});

test("duplicates and retries of one request id: concurrent copies settle with exactly one winner; sequential retries report every attempt", async () => {
  const requestId = ids.next();
  const insert = () => h.controlPool.raw.query("INSERT INTO fault_probe.items (id) VALUES ($1)", [requestId]);
  const copies = partition(await concurrently(4, insert));
  assert.equal(copies.fulfilled.length, 1);
  assert.equal(copies.rejected.length, 3);
  assert.ok(copies.rejected.every((e) => (e as { code?: string }).code === "23505"));
  const retries = await sequentially(2, insert);
  assert.deepEqual(retries.map((o) => o.status), ["rejected", "rejected"]);
  assert.throws(() => concurrently(1, insert), RangeError);
});

test("matrix cells: the title is the cell; a cell whose body injected nothing FAILS (FaultNotInjected) for every kind, and passes once its fault happened at its boundary; a crash cell names its boundary; an armed point never reached FAILS the cell; a matrix whose cells and bodies do not map 1:1 is refused", async () => {
  assert.equal(cellTitle({ id: "S090", step: "lease takeover", fault: "expiry", expect: "REFUSED" }), "S090 [expiry] lease takeover -> REFUSED");
  assert.equal(cellTitle({ step: "x", fault: "partial", expect: "y" }), "[partial] x -> y");
  assert.equal(cellTitle({ step: "x", fault: "crash-after-commit", at: "uow", expect: "y" }), "[crash-after-commit at uow] x -> y");
  assert.throws(() => cellTitle({ step: "x", fault: "flaky" as never, expect: "y" }), /unknown fault kind/);
  assert.throws(() => cellTitle({ step: "x", fault: "crash-before-commit", expect: "y" }), /names its commit boundary/);
  await assert.rejects(runCell({ step: "x", fault: "crash-after-commit", expect: "y" }, async () => undefined), /names its commit boundary/);
  assert.deepEqual([...FAULT_KINDS], ["race", "timeout", "expiry", "crash-before-commit", "crash-after-commit", "retry", "revocation", "partial"]);
  for (const fault of FAULT_KINDS) {
    await assert.rejects(runCell({ step: "noop", fault, expect: "nothing", at: "uow" }, async () => undefined), FaultNotInjected, fault);
  }
  // each passes once its fault happened at its boundary
  for (const fault of ["expiry", "timeout"] as const) {
    await runCell({ step: "s", fault, expect: "e" }, async (ctx) => {
      const deadline = ctx.deadline(ctx.clock.at(10_000));
      ctx.clock.past(deadline);
      await a.query("BEGIN");
      try {
        await ctx.withClock("the statement past the deadline", async (clock) => {
          assert.equal(Date.parse(await clock.onServer(a)), Date.parse(deadline) + 1, "the transaction runs past the deadline");
          const r = await a.query<{ past: boolean }>("SELECT kauro.server_now() > $1::timestamptz AS past", [deadline]);
          assert.equal(r.rows[0]?.past, true);
        });
      } finally {
        await a.query("ROLLBACK");
      }
    });
  }
  await runCell({ step: "s", fault: "retry", expect: "e" }, async (ctx) => void (await ctx.sequentially(2, async () => 1)));
  await runCell({ step: "s", fault: "retry", expect: "e" }, async (ctx) => {
    await ctx.attempt(async () => 1);
    await assert.rejects(ctx.attempt(async () => Promise.reject(new Error("a failed attempt counts once it ran"))));
  });
  await runCell({ step: "s", fault: "race", expect: "e" }, async (ctx) => {
    const id = await newItem();
    await ctx.inOrder({ oracle: h.oracle, actors: [{ name: "A", client: a, act: (c) => bump(c, id, "A") }, { name: "B", client: b, act: (c) => bump(c, id, "B") }], setup: async () => ({}), verify: () => undefined }, "A");
  });
  await runCell({ step: "s", fault: "revocation", expect: "e" }, async (ctx) => {
    let revokedFlag = false;
    await ctx.revoked("the grant", async () => void (revokedFlag = true));
    await ctx.fenced(
      "the use",
      async () => {
        if (revokedFlag) throw new Error("REVOKED");
      },
      (e) => e instanceof Error && e.message === "REVOKED",
    );
  });
  await runCell({ step: "s", fault: "partial", expect: "e" }, async (ctx) => {
    const effects: string[] = [];
    const port = instrumentPort({ async place(k: string) { effects.push(k); } }, ctx.points, "storage");
    const index = instrumentPort({ async put(k: string) { effects.push(`index:${k}`); } }, ctx.points, "index");
    await ctx.partial("a placement, then its index entry", "index.put.after", async () => {
      await port.place("one");
      await index.put("one");
    });
    assert.deepEqual(effects, ["one", "index:one"], "the placement completed; the index entry landed and its answer was lost");
  });
  // an armed point never reached fails the cell
  await assert.rejects(runCell({ step: "s", fault: "partial", expect: "e" }, async (ctx) => void ctx.points.crash("never")), FaultPointNotReached);
  // 1:1: a cell without a body, a body without a cell, a duplicated cell
  const cell = { id: "X1", step: "s", fault: "partial", expect: "e" } as const;
  assert.throws(() => faultMatrix([cell], {}), /cells without a body: \[X1\|s\|partial\]/);
  assert.throws(() => faultMatrix([], { "X1|s|partial": async () => undefined }), /bodies without a cell: \[X1\|s\|partial\]/);
  assert.throws(() => faultMatrix([cell, cell], { "X1|s|partial": async () => undefined }), /duplicated cells: \[X1\|s\|partial\]/);
});

test("FH-R1 (evidence) a revocation cell FAILS without a revocation that took effect or without a refusal observed after it; a partial cell FAILS when the operation completed, failed elsewhere or failed before any step of it completed", async () => {
  const cell = { step: "s", fault: "revocation", expect: "e" } as const;
  await assert.rejects(runCell(cell, async (ctx) => void (await ctx.revoked("grant", async () => undefined))), /no operation was observed refused/);
  await assert.rejects(runCell(cell, async (ctx) => void (await ctx.fenced("use", async () => Promise.reject(new Error("x")), () => true))), /fenced before any revocation/);
  await assert.rejects(
    runCell(cell, async (ctx) => {
      await ctx.revoked("grant", async () => undefined);
      await ctx.fenced("use", async () => undefined, () => true);
    }),
    /was not refused/,
  );
  await assert.rejects(
    runCell(cell, async (ctx) => {
      await ctx.revoked("grant", async () => undefined);
      await ctx.fenced("use", async () => Promise.reject(new Error("other")), (e) => e instanceof Error && e.message === "REVOKED");
    }),
    /not with the refusal/,
  );
  await assert.rejects(runCell(cell, async (ctx) => void (await ctx.revoked("grant", { act: { status: "fulfilled", value: 1 }, commit: { status: "fulfilled", value: undefined }, committed: true }))), /not an outcome the harness/);
  // a revocation actor that did not commit is no revocation; a fenced actor that settled before the revocation proves nothing
  await assert.rejects(
    runCell(cell, async (ctx) => {
      const id = await newItem();
      await ctx.inOrder<{ id: string }>(
        {
          oracle: h.oracle,
          actors: [
            { name: "H", client: a, act: (c) => bump(c, id, "H") },
            { name: "R", client: b, act: (c) => bump(c, id, "R").then(() => c.query("SELECT 1/0").catch(() => undefined)) },
          ],
          setup: async () => ({ id }),
          verify: async ({ outcomes }) => void (await ctx.revoked("R", outcomes["R"] as ActorOutcome)),
        },
        "H",
      );
    }),
    /did not commit/,
  );
  await assert.rejects(
    runCell(cell, async (ctx) => {
      const id = await newItem();
      await ctx.inOrder<{ id: string }>(
        {
          oracle: h.oracle,
          actors: [
            { name: "U", client: a, act: (c) => bump(c, id, "U") },
            { name: "R", client: b, act: (c) => bump(c, id, "R") },
          ],
          setup: async () => ({ id }),
          verify: async ({ outcomes }) => {
            await ctx.revoked("R", outcomes["R"] as ActorOutcome);
            // U held the lock and committed before R: settled first, and committed — never fenced by R
            await ctx.fenced("U", outcomes["U"] as ActorOutcome, () => true);
          },
        },
        "U",
      );
    }),
    /settled before the revocation/,
  );
  const partial = { step: "s", fault: "partial", expect: "e" } as const;
  const port = (points: FaultPoints) => instrumentPort({ async place() { return 1; } }, points, "storage");
  await assert.rejects(runCell(partial, async (ctx) => void (await ctx.partial("p", "storage.place.after", async () => undefined))), /completed: it never failed/);
  await assert.rejects(runCell(partial, async (ctx) => void (await ctx.partial("p", "storage.place.after", async () => Promise.reject(new Error("elsewhere"))))), /not at storage.place.after/);
  await assert.rejects(runCell(partial, async (ctx) => void (await ctx.partial("p", "storage.place.before", () => port(ctx.points).place()))), /before any earlier step/);
});

test("FH-R2 (evidence) an expiry cell FAILS when its declared deadline was not crossed by one move, or the clock was not used past it after the crossing; a read or onServer in the body is no use (FH-R2 (r3))", async () => {
  const cell = { step: "s", fault: "expiry", expect: "e" } as const;
  await assert.rejects(
    runCell(cell, async (ctx) => {
      ctx.deadline(ctx.clock.at(3_600_000));
      ctx.clock.advance(1);
      ctx.clock.now();
    }),
    /never crossed/,
    "one millisecond while the deadline is an hour away",
  );
  await assert.rejects(
    runCell(cell, async (ctx) => {
      ctx.clock.past(ctx.deadline(ctx.clock.at(1_000)));
    }),
    /nothing used the clock after it crossed/,
  );
  await assert.rejects(
    runCell(cell, async (ctx) => {
      const deadline = ctx.deadline(ctx.clock.at(1_000));
      ctx.clock.now();
      ctx.clock.set(deadline);
      ctx.clock.set(deadline);
    }),
    /nothing used the clock after it crossed/,
    "a read before the crossing is not a use after it",
  );
  await assert.rejects(
    runCell({ step: "s", fault: "timeout", expect: "e" }, async (ctx) => {
      ctx.clock.past(ctx.deadline(ctx.clock.at(1_000)));
      const step = instrumentPort({ async take(_now: string) {} }, ctx.points, "step");
      await ctx.withClock("the step", async (clock) => step.take(clock.now()));
      ctx.deadline(ctx.clock.at(60_000), "second deadline");
    }),
    /second deadline/,
    "every declared deadline must be crossed",
  );
  const exactly = controlledClock("2030-01-01T00:00:00.000Z");
  exactly.set("2030-01-01T00:00:01.000Z");
  assert.deepEqual(exactly.moveLog.map((m) => [m.from, m.to]), [[Date.parse("2030-01-01T00:00:00.000Z"), Date.parse("2030-01-01T00:00:01.000Z")]]);
});

// a registered cell, as a package's matrix writes one: the clock moves a lease past its time to live between two claims
faultCell({ id: "SELF", step: "OUTBOX_DISPATCH lease claim", fault: "expiry", expect: "HELD while live, taken over at fence 2 once expired" }, async (ctx) => {
  const resourceId = ids.next() as ResourceId;
  const deadlineAt = ctx.clock.at(3_600_000);
  // the claim is the operation under test: it takes its instant through the step clock the harness hands it
  const claim = () =>
    ctx.withClock("lease claim", (clock) =>
      h.control.run(h.system(), (uow) => instrumentPort(uow.leases, ctx.points, "leases").claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId: ids.next() as LeaseOwnerId, ttlSeconds: 120, deadlineAt, subjectHash: sha("self"), costAuthorityId: null, checkpointHash: null }, clock.now())),
    );
  const expiresAt = ctx.deadline(ctx.clock.at(120_000), "lease's time to live");
  assert.equal((await claim()).kind, "CLAIMED");
  ctx.clock.before(expiresAt);
  assert.equal((await claim()).kind, "HELD");
  // the instant a move returns is not a use: the claim reads the clock once it crossed the deadline
  ctx.clock.past(expiresAt);
  const taken = await claim();
  assert.deepEqual(taken.kind === "CLAIMED" && taken.lease.fence, 2);
});

// --- FH-R1..R9 (Codex review of 930d2f1): a cell can never pass unless its fault demonstrably happened at the boundary it names --------
// Each test below passed vacuously, hung or reported a false outcome on 930d2f1.

/** A cell built outside an object literal (the crash kinds' commit point `at`). */
const cellOf = (fault: string, at?: string) => ({ step: "s", fault, expect: "e", ...(at === undefined ? {} : { at }) }) as unknown as Parameters<typeof runCell>[0];
const leaseClaim = (resourceId: ResourceId) => (uow: Parameters<Parameters<Harness["control"]["run"]>[1]>[0]) =>
  uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId: ids.next() as LeaseOwnerId, ttlSeconds: 120, deadlineAt: toUtcInstant(Date.now() + 3_600_000), subjectHash: sha("fault"), costAuthorityId: null, checkpointHash: null }, toUtcInstant(Date.now()));
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms).unref())]);

test("FH-R1 a revocation or partial-failure cell whose body revoked, failed and observed nothing FAILS", async () => {
  for (const fault of ["revocation", "partial"] as const) {
    await assert.rejects(runCell({ step: "s", fault, expect: "e" }, async () => undefined), FaultNotInjected, fault);
  }
});

test("FH-R2 an expiry or timeout cell FAILS when the clock never crossed a deadline: set() to the current instant is not a move, a move short of the deadline proves nothing", async () => {
  for (const fault of ["expiry", "timeout"] as const) {
    await assert.rejects(runCell({ step: "s", fault, expect: "e" }, async (ctx) => void ctx.clock.set(ctx.clock.now())), FaultNotInjected, `${fault}: set to now`);
    await assert.rejects(runCell({ step: "s", fault, expect: "e" }, async (ctx) => void ctx.clock.advance(1)), FaultNotInjected, `${fault}: one millisecond, no deadline`);
  }
  const clock = controlledClock("2030-01-01T00:00:00.000Z");
  clock.set("2030-01-01T00:00:00.000Z");
  assert.equal(clock.moves, 0, "set() to the current instant is not a move");
});

test("FH-R3 a retry cell counts an attempt only once the request ran and settled: a marked retry, copies not yet run FAIL", async () => {
  await assert.rejects(runCell({ step: "s", fault: "retry", expect: "e" }, async (ctx) => (ctx as unknown as { retried?: () => void }).retried?.()), FaultNotInjected, "a retry marked by hand");
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  await assert.rejects(runCell({ step: "s", fault: "retry", expect: "e" }, async (ctx) => void ctx.concurrently(2, () => gate)), FaultNotInjected, "copies that never settled");
  open();
});

test("FH-R4 a crash cell FAILS unless the crash fired at the commit boundary it names: an unrelated point, a killed idle connection, the other boundary, another factory, a hand-passed point", async () => {
  const beforeCommit = async (points: FaultPoints, name = "uow") => {
    const f = crashableFactory(h.control, points, name);
    points.crash(`${name}.before-commit`);
    await assert.rejects(f.run(h.system(), leaseClaim(ids.next() as ResourceId)), crashedAt(`${name}.before-commit`));
  };
  const afterCommit = async (points: FaultPoints) => {
    const f = crashableFactory(h.control, points, "uow");
    points.crash("uow.after-commit");
    await assert.rejects(f.run(h.system(), leaseClaim(ids.next() as ResourceId)), crashedAt("uow.after-commit"));
  };
  await assert.rejects(
    runCell(cellOf("crash-after-commit", "uow"), async (ctx) => {
      ctx.points.crash("unrelated.before");
      await assert.rejects(ctx.points.pass("unrelated.before"), SimulatedCrash);
    }),
    FaultNotInjected,
    "a crash at an unrelated point",
  );
  await assert.rejects(runCell(cellOf("crash-after-commit", "uow"), async (ctx) => void (await ctx.kill(h.oracle, await h.pg.connect("kauro_control_test")))), FaultNotInjected, "an idle connection killed");
  await assert.rejects(runCell(cellOf("crash-after-commit", "uow"), (ctx) => ctx.operation("claim", () => beforeCommit(ctx.points))), FaultNotInjected, "a before-commit crash in an after-commit cell");
  await assert.rejects(runCell(cellOf("crash-before-commit", "uow"), (ctx) => ctx.operation("claim", () => afterCommit(ctx.points))), FaultNotInjected, "an after-commit crash in a before-commit cell");
  await assert.rejects(runCell(cellOf("crash-before-commit", "uow"), (ctx) => ctx.operation("claim", () => beforeCommit(ctx.points, "other"))), FaultNotInjected, "another factory's boundary");
  await assert.rejects(
    runCell(cellOf("crash-after-commit", "uow"), async (ctx) => {
      ctx.points.crash("uow.after-commit");
      await assert.rejects(ctx.points.pass("uow.after-commit"), SimulatedCrash);
    }),
    FaultNotInjected,
    "a point named like the boundary, passed by hand",
  );
  await assert.rejects(runCell(cellOf("crash-before-commit", "uow"), (ctx) => beforeCommit(ctx.points)), FaultNotInjected, "the real boundary, crashed outside any operation of the cell");
  // the real boundaries pass
  await runCell(cellOf("crash-before-commit", "uow"), (ctx) => ctx.operation("claim", () => beforeCommit(ctx.points)));
  await runCell(cellOf("crash-after-commit", "uow"), (ctx) => ctx.operation("claim", () => afterCommit(ctx.points)));
});

test("FH-R5 Pause.crash() of a pause already released throws and records nothing: a crash that did not happen is never evidence", async () => {
  const points = new FaultPoints();
  const p = points.pause("p");
  const op = points.pass("p");
  await p.reached;
  p.release();
  await op;
  assert.throws(() => p.crash(), /released/);
  assert.deepEqual(points.crashes, []);
});

test("FH-R6 an interleaving whose waiter is blocked by a third transaction, not by the holder, FAILS", async () => {
  const x = await newItem();
  const y = await newItem();
  const third = await h.pg.connect("kauro_control_test");
  await third.query("BEGIN");
  await bump(third, y, "third");
  const unblock = setTimeout(() => void third.query("ROLLBACK").catch(() => undefined), 4_000);
  try {
    await assert.rejects(
      inOrder({ oracle: h.oracle, actors: [{ name: "A", client: a, act: (c) => bump(c, x, "A") }, { name: "B", client: b, act: (c) => bump(c, y, "B") }], setup: async () => ({}), verify: () => undefined, limitMs: 1_500 }, "A"),
      InterleavingNotObserved,
    );
  } finally {
    clearTimeout(unblock);
    await third.query("ROLLBACK").catch(() => undefined);
    await third.end();
  }
});

test("FH-R7 a COMMIT the server answers with ROLLBACK (an actor that caught a refusal) is not committed", async () => {
  const run = await inOrder<{ id: string }>(
    {
      oracle: h.oracle,
      actors: [
        { name: "A", client: a, act: (c, s) => bump(c, s.id, "A") },
        {
          name: "B",
          client: b,
          act: async (c, s) => {
            await bump(c, s.id, "B");
            await c.query("SELECT 1/0").catch(() => undefined);
          },
        },
      ],
      setup: async () => ({ id: await newItem() }),
      verify: () => undefined,
    },
    "A",
  );
  assert.equal(run.outcomes["B"]?.act.status, "fulfilled");
  assert.equal(run.outcomes["B"]?.commit?.status, "rejected");
  assert.equal(run.outcomes["B"]?.committed, false);
  assert.deepEqual(await item(run.state.id), { n: 1, writers: ["A"] });
});

test("FH-R8 terminateBackend interrupts a connection blocked on a lock (its pid is known from the connection, never asked of it)", async () => {
  const id = await newItem();
  const victim = await h.pg.connect("kauro_control_test");
  const pid = (await victim.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
  await a.query("BEGIN");
  try {
    await bump(a, id, "a");
    await victim.query("BEGIN");
    const blocked = bump(victim, id, "victim");
    blocked.catch(() => undefined);
    for (let i = 0; i < 500 && (await h.oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])).rows.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(await within(terminateBackend(h.oracle, victim), 5_000, "the termination of the blocked backend"), pid);
    await assert.rejects(blocked);
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
  }
  assert.deepEqual(await item(id), { n: 0, writers: [] });
});

test("FH-R9 crashableFactory: a method left undecorated runs on the real factory (runSource reaches its private fields)", async () => {
  const f = crashableFactory(h.control, new FaultPoints(), "uow");
  assert.equal(await f.runSource(h.system(), async () => "ran"), "ran");
});

// --- FH-R1, FH-R2, FH-R6 (Codex re-check 2 of 9de9948): the evidence must come from the operation under test ----------------------
// Each test below passed vacuously on 9de9948 (or credited evidence the operation never produced).

/** Resolves once the backend `pid` waits on a lock (a statement issued outside the harness, set up as a counterexample). */
const blockedOnLock = async (pid: number): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if ((await h.oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])).rows.length > 0) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
};

test("FH-R1 (r3) a partial cell FAILS unless a step of the operation COMPLETED before the failure: an outer call's .before point, the failing call's own .after, a point passed by hand are no completed step; an .after point or a committed unit before a later failure point is", async () => {
  const partial = { step: "s", fault: "partial", expect: "e" } as const;
  const nothingPartial = (e: unknown) => e instanceof FaultNotInjected && /before any earlier step of it completed/.test(e.message);
  // Codex's counterexample: nested wrappers, the crash before the first effect; the log is [workflow.run.before, storage.place.before]
  let effects = 0;
  await assert.rejects(
    runCell(partial, async (ctx) => {
      const storage = instrumentPort({ async place() { effects += 1; } }, ctx.points, "storage");
      const workflow = instrumentPort({ async run() { await storage.place(); } }, ctx.points, "workflow");
      await ctx.partial("workflow", "storage.place.before", () => workflow.run());
    }),
    nothingPartial,
    "an outer call's .before point is no completed step",
  );
  assert.equal(effects, 0);
  await assert.rejects(
    runCell(partial, async (ctx) => {
      const port = instrumentPort({ async place() { return 1; } }, ctx.points, "storage");
      await ctx.partial("one placement", "storage.place.after", () => port.place());
    }),
    nothingPartial,
    "the failing call's own .after: its step never completed before the failure",
  );
  await assert.rejects(
    runCell(partial, async (ctx) => {
      const port = instrumentPort({ async place() { return 1; } }, ctx.points, "storage");
      await ctx.partial("hand-passed", "storage.place.before", async () => {
        await ctx.points.pass("index.put.after");
        await port.place();
      });
    }),
    nothingPartial,
    "a point passed by hand is no completed step",
  );
  // passes: the first port's call answered (its .after passed), the second dies before its effect
  const placed: string[] = [];
  await runCell(partial, async (ctx) => {
    const storage = instrumentPort({ async place(k: string) { placed.push(k); } }, ctx.points, "storage");
    const index = instrumentPort({ async put(k: string) { placed.push(`index:${k}`); } }, ctx.points, "index");
    await ctx.partial("place, then index", "index.put.before", async () => {
      await storage.place("one");
      await index.put("one");
    });
  });
  assert.deepEqual(placed, ["one"]);
  // passes: a committed unit of work is a completed step
  const resourceId = ids.next() as ResourceId;
  await runCell(partial, async (ctx) => {
    const control = crashableFactory(h.control, ctx.points, "uow");
    const notify = instrumentPort({ async send() { return 1; } }, ctx.points, "notify");
    await ctx.partial("claim, then notify", "notify.send.before", async () => {
      await control.run(h.system(), leaseClaim(resourceId));
      await notify.send();
    });
  });
  assert.equal((await h.oracle.query("SELECT 1 FROM kauro.leases WHERE resource_id = $1", [resourceId])).rows.length, 1, "the committed unit survived the failure");
});

test("FH-R2 (r3) an expiry or timeout cell FAILS when the instant past its deadline was only read in the body (a discarded read, a bare onServer): only an operation run through ctx.withClock uses the clock; it passes once the operation takes the instant through its step clock", async () => {
  const unused = (e: unknown) => e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message);
  for (const fault of ["expiry", "timeout"] as const) {
    const cell = { step: "lease claim", fault, expect: "expired refusal" } as const;
    // Codex's counterexample: a deadline crossed and a read discarded, no claim ever executed
    await assert.rejects(
      runCell(cell, async (ctx) => {
        const d = ctx.deadline(ctx.clock.at(1000));
        ctx.clock.past(d);
        void ctx.clock.now();
      }),
      unused,
      `${fault}: a discarded read`,
    );
    await assert.rejects(
      runCell(cell, async (ctx) => {
        ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
        await a.query("BEGIN");
        try {
          await ctx.clock.onServer(a);
        } finally {
          await a.query("ROLLBACK");
        }
      }),
      unused,
      `${fault}: a transaction positioned in the body, no operation run in it`,
    );
  }
  const cell = { step: "lease claim", fault: "expiry", expect: "taken over" } as const;
  // a step's clock is closed once the step settled: a read kept for later is refused
  await assert.rejects(
    runCell(cell, async (ctx) => {
      ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
      let kept: { nowMs(): number } | undefined;
      await ctx.withClock("a step that only keeps its clock", async (clock) => void (kept = clock));
      kept?.nowMs();
    }),
    /settled/,
  );
  // passes: the claim takes the instant through the step clock, before and past the lease's time to live
  await runCell(cell, async (ctx) => {
    const resourceId = ids.next() as ResourceId;
    const deadlineAt = ctx.clock.at(3_600_000);
    const expiresAt = ctx.deadline(ctx.clock.at(120_000), "lease's time to live");
    const claim = () =>
      ctx.withClock("claim", (clock) =>
        h.control.run(h.system(), (uow) => instrumentPort(uow.leases, ctx.points, "leases").claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId: ids.next() as LeaseOwnerId, ttlSeconds: 120, deadlineAt, subjectHash: sha("r3"), costAuthorityId: null, checkpointHash: null }, clock.now())),
      );
    assert.equal((await claim()).kind, "CLAIMED");
    ctx.clock.past(expiresAt);
    const taken = await claim();
    assert.deepEqual(taken.kind === "CLAIMED" && taken.lease.fence, 2);
  });
  // passes: onServer on the transaction the operation runs in
  await runCell({ step: "server-clock step", fault: "timeout", expect: "past" }, async (ctx) => {
    const d = ctx.deadline(ctx.clock.at(5_000), "call timeout");
    ctx.clock.past(d);
    await a.query("BEGIN");
    try {
      await ctx.withClock("the statement past the timeout", async (clock) => {
        await clock.onServer(a);
        const r = await a.query<{ past: boolean }>("SELECT kauro.server_now() > $1::timestamptz AS past", [d]);
        assert.equal(r.rows[0]?.past, true);
      });
    } finally {
      await a.query("ROLLBACK");
    }
  });
});

test("FH-R6 (r3) mustWait binds the wait to the operation: a bare waiter pid, a client the harness did not open, a connection already running an earlier statement FAIL; the operation's own statement waiting on the holder passes", async () => {
  const id = await newItem();
  const holder = connectionPid(a);
  const race = { step: "SELECT 1", fault: "race", expect: "e" } as const;
  const loose = (ctx: unknown) => (ctx as { mustWait: (oracle: Client, probe: unknown, op: unknown, what: string, limitMs?: number) => Promise<unknown> }).mustWait;
  await a.query("BEGIN");
  try {
    await bump(a, id, "a");
    await b.query("BEGIN");
    const earlier = bump(b, id, "earlier");
    earlier.catch(() => undefined);
    await blockedOnLock(connectionPid(b));
    // Codex's counterexample, exactly: a bare pid and an independent SELECT 1 queued behind b's earlier UPDATE
    const queued = b.query("SELECT 1");
    queued.catch(() => undefined);
    await assert.rejects(runCell(race, async (ctx) => void (await loose(ctx)(h.oracle, { waiter: connectionPid(b), holder }, queued, "SELECT 1", 1_000))), InterleavingNotObserved, "a bare pid is not owned by the operation");
    // the harness hands the operation b, but b is still running the earlier statement: its wait is not the operation's
    await assert.rejects(
      runCell(race, async (ctx) => void (await loose(ctx)(h.oracle, { waiter: b, holder }, (c: Client) => c.query("SELECT 1"), "SELECT 1", 1_000))),
      (e: unknown) => e instanceof InterleavingNotObserved && /busy/.test(e.message),
      "a connection already running an earlier statement",
    );
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
  }
  // a client the harness did not open is no waiter (its query method may be bound or cached anywhere)
  const elsewhere = await h.pg.connect("kauro_control_test");
  try {
    await assert.rejects(runCell(race, async (ctx) => void (await loose(ctx)(h.oracle, { waiter: elsewhere, holder }, (c: Client) => c.query("SELECT 1"), "a client opened elsewhere", 1_000))), (e: unknown) => e instanceof InterleavingNotObserved && /harness opened/.test(e.message));
  } finally {
    await elsewhere.end();
  }
  await a.query("BEGIN");
  try {
    await bump(a, id, "a");
    // passes: the operation's own UPDATE, on the handle, waits on the holder; while it runs the connection is the operation's alone
    await b.query("BEGIN");
    await runCell(race, async (ctx) => {
      const { pending } = (await loose(ctx)(h.oracle, { waiter: b, holder }, (c: Client) => bump(c, id, "b"), "b behind a")) as { pending: Promise<PromiseSettledResult<unknown>> };
      await assert.rejects(b.query("SELECT 1"), /dedicated/, "a statement queued on the connection outside the operation");
      await a.query("COMMIT");
      assert.equal((await pending).status, "fulfilled");
    });
    await b.query("COMMIT");
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
  }
  assert.deepEqual(await item(id), { n: 2, writers: ["a", "b"] }, "the holder, then the operation that waited on it");
});

// --- FH-R1, FH-R2, FH-R6 (Codex re-check 3 of 9fb6bb7): evidence is owned by the operation's scope --------------------------------
// The first assertion of each test below is Codex's r3 counterexample; each passed (the cell credited evidence the operation never
// produced) on 9fb6bb7.

/** A promise and the function that resolves it (a gate a test opens from inside an operation). */
const gated = (): { gate: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
};

test("FH-R1 (r4) a partial cell credits only a step completed by its own operation: an unrelated instrumented call that completes while partial() is pending — in the body or in another operation — is no completed step, and cannot fire the operation's failure point", async () => {
  const partial = { step: "s", fault: "partial", expect: "e" } as const;
  const nothingPartial = (e: unknown) => e instanceof FaultNotInjected && /before any earlier step of it completed/.test(e.message);
  // Codex's counterexample, exactly: side.ping() completes outside the callback while the storage workflow waits on its gate
  let effects = 0;
  await assert.rejects(
    runCell(partial, async (ctx) => {
      const storage = instrumentPort({ async place() { effects += 1; } }, ctx.points, "storage");
      const side = instrumentPort({ async ping() {} }, ctx.points, "side");
      const { gate, open } = gated();
      const p = ctx.partial("storage workflow", "storage.place.before", async () => {
        await gate;
        await storage.place();
      });
      await side.ping();
      open();
      await p;
    }),
    nothingPartial,
    "a concurrent unrelated call in the body",
  );
  assert.equal(effects, 0, "the workflow crashed before its first effect");
  await assert.rejects(
    runCell(partial, async (ctx) => {
      const storage = instrumentPort({ async place() { effects += 1; } }, ctx.points, "storage");
      const side = instrumentPort({ async ping() {} }, ctx.points, "side");
      const { gate, open } = gated();
      const p = ctx.partial("storage workflow", "storage.place.before", async () => {
        await gate;
        await storage.place();
      });
      await ctx.operation("an unrelated operation", () => side.ping());
      open();
      await p;
    }),
    nothingPartial,
    "a step completed by another operation of the same cell",
  );
  assert.equal(effects, 0);
  // passes: the operation's own placement completed, then it died at the index point; the same point passed outside the
  // operation meanwhile is unarmed there (the crash belongs to the operation)
  const placed: string[] = [];
  await runCell(partial, async (ctx) => {
    const storage = instrumentPort({ async place(k: string) { placed.push(k); } }, ctx.points, "storage");
    const index = instrumentPort({ async put(k: string) { placed.push(`index:${k}`); } }, ctx.points, "index");
    const { gate, open } = gated();
    const p = ctx.partial("place, then index", "index.put.before", async () => {
      await gate;
      await storage.place("one");
      await index.put("one");
    });
    await index.put("outside");
    open();
    await p;
  });
  assert.deepEqual(placed, ["index:outside", "one"]);
});

test("FH-R2 (r4) an expiry or timeout cell FAILS unless its operation CONSUMED an instant past the deadline: a wrapped but discarded read, an old instant handed to the claim, an instant consumed outside the operation, an onServer whose transaction ran nothing of the operation", async () => {
  const unused = (e: unknown) => e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message);
  for (const fault of ["expiry", "timeout"] as const) {
    const cell = { step: "lease claim", fault, expect: "expired refusal" } as const;
    // Codex's counterexample, exactly: the step clock read and discarded, no claim executed
    await assert.rejects(
      runCell(cell, async (ctx) => {
        ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
        await ctx.withClock("claim", async (clock) => {
          void clock.now();
        });
      }),
      unused,
      `${fault}: a wrapped, discarded read`,
    );
    // an actual claim taking an old instant, preceded by the discarded read
    await assert.rejects(
      runCell(cell, async (ctx) => {
        const leases = instrumentPort({ async claim(_now: string) { return "CLAIMED"; } }, ctx.points, "leases");
        const old = ctx.clock.at(0);
        ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
        await ctx.withClock("claim", async (clock) => {
          void clock.now();
          await leases.claim(old);
        });
      }),
      unused,
      `${fault}: the claim took an instant before the deadline`,
    );
    // the instant read in the operation, consumed by a call outside it
    await assert.rejects(
      runCell(cell, async (ctx) => {
        const leases = instrumentPort({ async claim(_now: string) { return "CLAIMED"; } }, ctx.points, "leases");
        ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
        const kept = await ctx.withClock("read", async (clock) => clock.now());
        await leases.claim(kept);
      }),
      unused,
      `${fault}: consumed outside the operation`,
    );
    // onServer in the operation, but the transaction then runs nothing of it (it ends, or the statement runs in the body)
    for (const [label, inside, outside] of [
      ["nothing run", async () => undefined, async () => undefined],
      ["only the transaction's end", async () => void (await a.query("ROLLBACK")), async () => void (await a.query("SELECT 1"))],
      ["the statement run outside the operation", async () => undefined, async () => void (await a.query("SELECT kauro.server_now()"))],
    ] as const) {
      await assert.rejects(
        runCell(cell, async (ctx) => {
          ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
          await a.query("BEGIN");
          try {
            await ctx.withClock("server step", async (clock) => {
              await clock.onServer(a);
              await inside();
            });
            await outside();
          } finally {
            await a.query("ROLLBACK");
          }
        }),
        unused,
        `${fault}: onServer, ${label}`,
      );
    }
  }
  // passes: the instrumented claim receives the instant past the deadline that its operation read
  await runCell({ step: "lease claim", fault: "expiry", expect: "taken" }, async (ctx) => {
    const leases = instrumentPort({ async claim(_input: { at: string }) { return "CLAIMED"; } }, ctx.points, "leases");
    ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
    await ctx.withClock("claim", async (clock) => leases.claim({ at: clock.now() }));
  });
});

// --- FH-R2 (Codex re-check 4 of bb93069): a call's instants are its arguments AT the call; a transaction ends whoever ends it -----
// The first assertion of each block below is Codex's r4 counterexample; each passed on bb93069.

test("FH-R2 (r5) consumption is judged from what the call received and the transaction the statement ran in: an argument mutated after the call, an outside ROLLBACK (or COMMIT; BEGIN, ROLLBACK TO a savepoint) between onServer and the operation's statement FAIL; the same transaction passes", async () => {
  const unused = (e: unknown) => e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message);
  // Codex's counterexample 1, exactly: the claim received 1000 ms; the argument object is changed to the discarded 2001 ms afterwards
  await assert.rejects(
    runCell(
      { step: "lease claim", fault: "expiry", expect: "expired" },
      async (ctx) => {
        const input = { at: ctx.clock.at(0) };
        let received: string | undefined;
        const leases = instrumentPort({ async claim(x: { at: string }) { received = x.at; } }, ctx.points, "leases");
        ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
        await ctx.withClock("claim", async (clock) => {
          void clock.now();
          await leases.claim(input);
        });
        input.at = ctx.clock.at(0);
        assert.notEqual(received, input.at);
      },
      { clockStart: 1000 },
    ),
    unused,
    "an argument mutated after the call",
  );
  // the same with a Date argument moved after the call (setTime), nested one level down
  await assert.rejects(
    runCell({ step: "lease claim", fault: "timeout", expect: "expired" }, async (ctx) => {
      const input = { lease: { at: new Date(Date.parse(ctx.clock.at(0))) } };
      const leases = instrumentPort({ async claim(_x: unknown) {} }, ctx.points, "leases");
      ctx.clock.past(ctx.deadline(ctx.clock.at(1000)));
      await ctx.withClock("claim", async (clock) => {
        const late = clock.nowMs();
        await leases.claim(input);
        input.lease.at.setTime(late);
      });
    }),
    unused,
    "a Date argument moved after the call, inside the operation",
  );
  // Codex's counterexample 2, exactly: an outside callback rolls the transaction back between onServer and the operation's SELECT
  const outsideEnd = async (label: string, end: (c: Client) => Promise<unknown>) =>
    assert.rejects(
      runCell(
        { step: "server-clock step", fault: "timeout", expect: "past deadline" },
        async (ctx) => {
          const d = ctx.deadline(ctx.clock.at(1000));
          ctx.clock.past(d);
          const { gate, open } = gated();
          const outside = gate.then(() => end(a));
          await a.query("BEGIN");
          try {
            await ctx.withClock("server-clock step", async (clock) => {
              await clock.onServer(a);
              open();
              await outside;
              const r = await a.query<{ before: boolean }>("SELECT kauro.server_now() < $1::timestamptz AS before", [d]);
              assert.equal(r.rows[0]!.before, true);
            });
          } finally {
            await a.query("ROLLBACK");
          }
        },
        { clockStart: "2100-01-01T00:00:00.000Z" },
      ),
      unused,
      label,
    );
  await outsideEnd("an outside ROLLBACK between onServer and the operation's statement", (c) => c.query("ROLLBACK"));
  await outsideEnd("an outside COMMIT; BEGIN in one string (the operation's statement runs in a new transaction)", (c) => c.query("COMMIT; BEGIN"));
  // the transaction-local setting is undone by a rollback to a savepoint taken before onServer: the transaction goes on, the instant is gone
  await assert.rejects(
    runCell(
      { step: "server-clock step", fault: "timeout", expect: "past deadline" },
      async (ctx) => {
        const d = ctx.deadline(ctx.clock.at(1000));
        ctx.clock.past(d);
        const { gate, open } = gated();
        const outside = gate.then(() => a.query("ROLLBACK TO SAVEPOINT before_clock"));
        await a.query("BEGIN");
        await a.query("SAVEPOINT before_clock");
        try {
          await ctx.withClock("server-clock step", async (clock) => {
            await clock.onServer(a);
            open();
            await outside;
            const r = await a.query<{ before: boolean }>("SELECT kauro.server_now() < $1::timestamptz AS before", [d]);
            assert.equal(r.rows[0]!.before, true);
          });
        } finally {
          await a.query("ROLLBACK");
        }
      },
      { clockStart: "2100-01-01T00:00:00.000Z" },
    ),
    unused,
    "an outside ROLLBACK TO a savepoint taken before onServer",
  );
  // passes: the operation's statement runs in the transaction onServer positioned (on a harness connection and on a plain client)
  for (const [label, session] of [
    ["harness connection", () => a],
    ["plain client", () => h.oracle],
  ] as const) {
    await runCell(
      { step: "server-clock step", fault: "timeout", expect: "past deadline" },
      async (ctx) => {
        const d = ctx.deadline(ctx.clock.at(1000));
        ctx.clock.past(d);
        const c = session();
        await c.query("BEGIN");
        try {
          await ctx.withClock(`server-clock step (${label})`, async (clock) => {
            await clock.onServer(c);
            const r = await c.query<{ before: boolean }>("SELECT kauro.server_now() < $1::timestamptz AS before", [d]);
            assert.equal(r.rows[0]!.before, false);
          });
        } finally {
          await c.query("ROLLBACK");
        }
      },
      { clockStart: "2100-01-01T00:00:00.000Z" },
    );
  }
});

test("FH-R6 (r4) a lock wait is credited only to the operation's own statement — tagged fault-op:<id>:<n>, issued in its scope on a connection the harness opened, the one the driver is running: a query method bound before mustWait, a statement bypassing the handle after the idle check, the operation's identical SQL still queued behind it FAIL", async () => {
  const x = await newItem();
  const y = await newItem();
  const holder = connectionPid(a);
  const race = { step: "UPDATE", fault: "race", expect: "e" } as const;
  const sql = "UPDATE fault_probe.items SET n = n + 1, writers = writers || 'w'::text WHERE id = $1";
  await a.query("BEGIN");
  try {
    await a.query(sql, [x]);
    // Codex's counterexample, exactly: a query method saved before mustWait, called by a background callback the operation releases;
    // the operation's own UPDATE of the unlocked row Y (identical SQL) would queue behind it
    await b.query("BEGIN");
    const q = b.query.bind(b);
    const { gate, open } = gated();
    const background = gate.then(() => q(sql, [x]));
    background.catch(() => undefined);
    await assert.rejects(
      runCell(race, async (ctx) =>
        void (await ctx.mustWait(
          h.oracle,
          { waiter: b, holder },
          (c) => {
            open();
            return Promise.resolve().then(() => c.query(sql, [y]));
          },
          "the UPDATE of Y",
          1_000,
        )),
      ),
      InterleavingNotObserved,
      "a bound query method from outside the operation",
    );
    await assert.rejects(background, /dedicated/, "the saved method is the harness's: outside the operation it is refused, never sent");
    await b.query("ROLLBACK");
    // a statement that bypasses the handle altogether (the driver's own method on the connection), issued after the idle check:
    // it is sent untagged and waits on A; the operation's identical UPDATE of Y is queued behind it, never dispatched
    await b.query("BEGIN");
    const bypass = Client.prototype.query as unknown as (this: Client, text: string, values: unknown[]) => Promise<unknown>;
    const second = gated();
    const outside = second.gate.then(() => bypass.call(b, sql, [x]));
    outside.catch(() => undefined);
    let queued: Promise<unknown> | undefined;
    await assert.rejects(
      runCell(race, async (ctx) =>
        void (await ctx.mustWait(
          h.oracle,
          { waiter: b, holder },
          async (c) => {
            second.open();
            await new Promise((res) => setImmediate(res));
            queued = c.query(sql, [y]);
            return queued;
          },
          "the UPDATE of Y",
          1_000,
        )),
      ),
      (e: unknown) => e instanceof InterleavingNotObserved && /did not issue|not the one the driver is running/.test(e.message),
      "the wait belongs to a statement the operation did not issue",
    );
    await a.query("ROLLBACK");
    await outside;
    await queued;
    await b.query("ROLLBACK");
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
  }
  // passes: the operation's own UPDATE of X, through the handle, waits on the holder
  await a.query("BEGIN");
  try {
    await a.query(sql, [x]);
    await b.query("BEGIN");
    await runCell(race, async (ctx) => {
      const { pending } = await ctx.mustWait(h.oracle, { waiter: b, holder }, (c) => c.query(sql, [x]), "the UPDATE of X");
      await a.query("COMMIT");
      assert.equal((await pending).status, "fulfilled");
    });
    await b.query("COMMIT");
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
  }
  assert.deepEqual(await item(x), { n: 2, writers: ["w", "w"] });
  assert.deepEqual(await item(y), { n: 0, writers: [] }, "every UPDATE of Y was rolled back");
});

// --- FH-R2 (Codex re-check 5 of 2238273): consumption of an onServer instant is proven by the server, never by parsing SQL -------
// On 2238273 the client-side SQL-text tracker credited the instant in every rejection below except the two DO blocks (refused there
// only because a fragment of them starts with END), and refused both positive cases (their text names ROLLBACK TO).

test("FH-R2 (r6) an onServer instant is consumed only when probes the harness runs immediately before and after the operation's statement, on that connection, read the call's clock token and the same txid: a comment-split, cached-method, DO-block, function-body or multi-statement undo FAILS whatever its SQL text; an untouched transaction passes", async () => {
  // since r7 the server refuses an operation's multi-statement string (extended protocol): that refusal is a failure too
  const unused = (e: unknown) =>
    (e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message)) || (e instanceof Error && /cannot insert multiple commands into a prepared statement/.test(e.message));
  const cell = { step: "server-clock step", fault: "timeout", expect: "past deadline" } as const;
  const options = { clockStart: "2100-01-01T00:00:00.000Z" } as const;
  /** onServer in the operation; `outside` runs from a callback registered in the body; then the operation's `statement`. */
  const undone = async (label: string, c: Client, outside: (() => Promise<unknown>) | undefined, statement: (deadline: string) => Promise<unknown>, prepare?: () => Promise<unknown>) =>
    assert.rejects(
      runCell(
        cell,
        async (ctx) => {
          const d = ctx.deadline(ctx.clock.at(1000));
          ctx.clock.past(d);
          const { gate, open } = gated();
          const late = gate.then(() => outside?.());
          await c.query("BEGIN");
          await c.query("SAVEPOINT before_clock");
          try {
            await prepare?.();
            await ctx.withClock("server-clock step", async (clock) => {
              await clock.onServer(c);
              open();
              await late;
              await statement(d);
            });
          } finally {
            await c.query("ROLLBACK");
          }
        },
        options,
      ),
      unused,
      label,
    );
  const before = (c: Client) => async (d: string) => {
    const r = await c.query<{ before: boolean }>("SELECT kauro.server_now() < $1::timestamptz AS before", [d]);
    assert.equal(r.rows[0]!.before, true, "the instant is gone: the statement ran before the deadline");
  };
  // Codex's counterexample 1, exactly: a ROLLBACK TO behind a comment holding a `;`
  await undone("an outside '/* ; */ ROLLBACK TO SAVEPOINT' (comment-split)", a, () => a.query("/* ; */ ROLLBACK TO SAVEPOINT before_clock"), before(a));
  // Codex's counterexample 2: a plain client's query method cached before the tap
  {
    const c = h.oracle;
    const q = c.query.bind(c);
    await undone("an outside ROLLBACK TO through a query method cached before onServer", c, () => q("ROLLBACK TO SAVEPOINT before_clock"), before(c));
  }
  // dollar quoting, a DO block: no transaction control in the text, the clock override is undone all the same
  await undone("an outside DO block (dollar-quoted) resetting the transaction's clock", a, () => a.query("DO $body$ BEGIN PERFORM set_config('kauro_test.clock_offset_seconds', '0', true); END $body$"), before(a));
  // a function body: the reset is hidden in a function called by a plain SELECT
  await undone(
    "an outside SELECT of a function whose body resets the transaction's clock",
    a,
    () => a.query("SELECT pg_temp.fault_undo_clock()"),
    before(a),
    () => a.query("CREATE FUNCTION pg_temp.fault_undo_clock() RETURNS text LANGUAGE sql AS $f$ SELECT set_config('kauro_test.clock_offset_seconds', '0', true) $f$"),
  );
  // the operation's own multi-statement string: a comment-split ROLLBACK TO, then its read of the server clock
  await undone("the operation's own multi-statement string undoing the instant before its read", a, undefined, async (d) => {
    const r = (await a.query(`/* ; */ ROLLBACK TO SAVEPOINT before_clock; SELECT kauro.server_now() < '${d}'::timestamptz AS before`)) as unknown as Array<{ rows: Array<{ before: boolean }> }>;
    assert.equal(r[1]!.rows[0]!.before, true);
  });
  // the operation's own DO block resetting the clock before its read
  await undone("the operation's own DO block resetting the clock", a, undefined, async (d) => {
    await a.query("DO $$ BEGIN PERFORM set_config('kauro_test.clock_offset_seconds', '0', true); END $$");
    await before(a)(d);
  });
  // passes: transaction control that leaves the instant in place (a savepoint taken and rolled back to AFTER onServer, one
  // statement each since r7) — the SQL text names ROLLBACK TO, the server proves the instant stood before and after each
  for (const [label, session] of [
    ["harness connection", () => a],
    ["plain client", () => h.oracle],
  ] as const) {
    await runCell(
      cell,
      async (ctx) => {
        const d = ctx.deadline(ctx.clock.at(1000));
        ctx.clock.past(d);
        const c = session();
        await c.query("BEGIN");
        try {
          await ctx.withClock(`server-clock step (${label})`, async (clock) => {
            await clock.onServer(c);
            await c.query("SAVEPOINT inner_step");
            await c.query("ROLLBACK TO SAVEPOINT inner_step");
            const r = await c.query<{ before: boolean }>(`SELECT kauro.server_now() < '${d}'::timestamptz AS before`);
            assert.equal(r.rows[0]!.before, false, "the statement ran past the deadline");
          });
        } finally {
          await c.query("ROLLBACK");
        }
      },
      options,
    );
  }
});

// --- FH-R2 (Codex re-check 6 of 1e32feb): the probes bracket exactly ONE server statement --------------------------------------
// On 1e32feb one multi-statement string took a SAVEPOINT after onServer, reset the clock override, ran its deadline check (before
// the deadline) and ROLLBACK TO restored the settings before the closing probe: both probes matched and the instant was credited.
// Every statement of an operation now goes through the extended query protocol (Parse/Bind/Execute), so the SERVER refuses a
// multi-statement string, and only a statement the driver sent that way can prove an instant consumed.

test("FH-R2 (r7) the probes bracket exactly one server statement: an operation's multi-statement string that undoes the instant (SAVEPOINT, reset, deadline check, ROLLBACK TO) is refused by the server on a harness connection and on a tapped plain client; a single statement past the deadline passes", async () => {
  const cell = { step: "server-clock step", fault: "timeout", expect: "past deadline" } as const;
  const options = { clockStart: "2100-01-01T00:00:00.000Z" } as const;
  const refused = (e: unknown) =>
    (e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message)) || (e instanceof Error && /cannot insert multiple commands into a prepared statement/.test(e.message));
  for (const [label, session] of [
    ["harness connection", () => a],
    ["plain client", () => h.oracle],
  ] as const) {
    // Codex's counterexample, exactly: one string, inside the operation, after onServer
    await assert.rejects(
      runCell(
        cell,
        async (ctx) => {
          const d = ctx.deadline(ctx.clock.at(1000));
          ctx.clock.past(d);
          const c = session();
          await c.query("BEGIN");
          try {
            await ctx.withClock(`server-clock step (${label})`, async (clock) => {
              await clock.onServer(c);
              const r = (await c.query(
                `SAVEPOINT s; SELECT set_config('kauro_test.clock_offset_seconds', '0', true); SELECT kauro.server_now() < '${d}'::timestamptz AS before; ROLLBACK TO SAVEPOINT s`,
              )) as unknown as Array<{ rows: Array<{ before: boolean }> }>;
              assert.equal(r[2]!.rows[0]!.before, true, "the deadline check ran before the deadline");
            });
          } finally {
            await c.query("ROLLBACK");
          }
        },
        options,
      ),
      refused,
      `${label}: a multi-statement string undoing the instant between the probes`,
    );
    // the same string with its refusal swallowed by the operation: nothing executed, nothing is credited
    await assert.rejects(
      runCell(
        cell,
        async (ctx) => {
          const d = ctx.deadline(ctx.clock.at(1000));
          ctx.clock.past(d);
          const c = session();
          await c.query("BEGIN");
          try {
            await ctx.withClock(`server-clock step (${label}, swallowed)`, async (clock) => {
              await clock.onServer(c);
              await c.query(`SAVEPOINT s; SELECT set_config('kauro_test.clock_offset_seconds', '0', true); SELECT kauro.server_now() < '${d}'::timestamptz AS before; ROLLBACK TO SAVEPOINT s`).catch(() => undefined);
            });
          } finally {
            await c.query("ROLLBACK");
          }
        },
        options,
      ),
      (e: unknown) => e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message),
      `${label}: a refused multi-statement string proves nothing`,
    );
    // passes: one statement past the deadline, bracketed by the probes
    await runCell(
      cell,
      async (ctx) => {
        const d = ctx.deadline(ctx.clock.at(1000));
        ctx.clock.past(d);
        const c = session();
        await c.query("BEGIN");
        try {
          await ctx.withClock(`server-clock step (${label}, single)`, async (clock) => {
            await clock.onServer(c);
            const r = await c.query<{ before: boolean }>(`SELECT kauro.server_now() < '${d}'::timestamptz AS before`);
            assert.equal(r.rows[0]!.before, false, "the statement ran past the deadline");
          });
        } finally {
          await c.query("ROLLBACK");
        }
      },
      options,
    );
  }
});

// --- FH-R2 (Codex re-check 7 of dce1cfc): the bracketed statement earns credit only if the SERVER executed it -------------------
// On dce1cfc the extended-protocol check and the "sent" hook ran before the driver's submit(): a statement pg refuses before
// writing anything (a prepared-statement name already used for another text, values that are not an array) errored locally, the
// client went on with its queue, both probes matched and the instant was credited though no operation statement reached the
// server. Now the statement must have been written by submit() without error AND the server must have answered it with a
// CommandComplete.

test("FH-R2 (r8) a statement the driver refuses before sending (prepared-statement name collision, values not an array) proves nothing, on a harness connection and on a tapped plain client; a statement the server executed passes", async () => {
  const cell = { step: "server-clock step", fault: "timeout", expect: "past deadline" } as const;
  const options = { clockStart: "2100-01-01T00:00:00.000Z" } as const;
  const unused = (e: unknown) => e instanceof FaultNotInjected && /nothing used the clock after it crossed/.test(e.message);
  let n = 0;
  for (const [label, session] of [
    ["harness connection", () => a],
    ["plain client", () => h.oracle],
  ] as const) {
    const cases: Array<[string, (c: Client, d: string) => Promise<() => Promise<unknown>>]> = [
      [
        "a prepared-statement name already used for another text",
        async (c, d) => {
          const name = `fh_r8_${n++}`;
          await c.query({ name, text: "SELECT 1 AS one" });
          return () => c.query({ name, text: `SELECT kauro.server_now() < '${d}'::timestamptz AS before` });
        },
      ],
      ["values that are not an array", async (c, d) => () => c.query({ text: `SELECT kauro.server_now() < '${d}'::timestamptz AS before`, values: {} as unknown as unknown[] })],
    ];
    for (const [what, prepare] of cases) {
      await assert.rejects(
        runCell(
          cell,
          async (ctx) => {
            const d = ctx.deadline(ctx.clock.at(1000));
            ctx.clock.past(d);
            const c = session();
            await c.query("BEGIN");
            try {
              // the setup (a first use of the name) runs before the operation; only the refused statement is bracketed
              const statement = await prepare(c, d);
              await ctx.withClock(`server-clock step (${label}, ${what})`, async (clock) => {
                await clock.onServer(c);
                await statement().catch(() => undefined);
              });
            } finally {
              await c.query("ROLLBACK");
            }
          },
          options,
        ),
        unused,
        `${label}: ${what} — refused by the driver before anything was sent, the instant must not be credited`,
      );
    }
    // passes: a named prepared statement the server executes, past the deadline
    await runCell(
      cell,
      async (ctx) => {
        const d = ctx.deadline(ctx.clock.at(1000));
        ctx.clock.past(d);
        const c = session();
        await c.query("BEGIN");
        try {
          await ctx.withClock(`server-clock step (${label}, executed)`, async (clock) => {
            await clock.onServer(c);
            const r = await c.query<{ before: boolean }>({ name: `fh_r8_ok_${n++}`, text: `SELECT kauro.server_now() < '${d}'::timestamptz AS before` });
            assert.equal(r.rows[0]!.before, false, "the statement ran past the deadline");
          });
        } finally {
          await c.query("ROLLBACK");
        }
      },
      options,
    );
  }
});

// Self-test of K1's raceAtWrite wait credit (lane K1b; found by L-DRAFT): a "race" cell is injected only when ctx.observedWaits > 0, and only
// ctx.mustWait counts a wait, so a cell built on raceAtWrite alone ended in FaultNotInjected even when the race really happened.
// `credit` makes the second run THROUGH ctx.mustWait: an observed wait is credited (the cell is green), a second that settled without
// waiting (a control, or a race that did not happen) is not (the cell is red at the harness's own check). Real PostgreSQL 17, a probe
// table of this test's own cluster, the control plane's login role.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connectionPid, FaultNotInjected, openConnection, runCell, startHarness, type FaultContext, type Harness, type HarnessConnection } from "@kauro/persistence/testing";
import { raceAtWrite, type RaceResult } from "./outreach-support.js";

let h: Harness;
let a: HarnessConnection;
let b: HarnessConnection;
let seq = 0;

before(async () => {
  h = await startHarness();
  await h.oracle.query("CREATE SCHEMA k1b_probe");
  await h.oracle.query("CREATE TABLE k1b_probe.items (id text PRIMARY KEY, n integer NOT NULL DEFAULT 0)");
  await h.oracle.query("GRANT USAGE ON SCHEMA k1b_probe TO kauro_control_test; GRANT SELECT, INSERT, UPDATE ON k1b_probe.items TO kauro_control_test");
  a = await openConnection(h.pg.clientConfig("kauro_control_test"));
  b = await openConnection(h.pg.clientConfig("kauro_control_test"));
});
after(async () => {
  await a.end();
  await b.end();
  await h.stop();
});

async function newItem(): Promise<string> {
  const id = `item-${++seq}`;
  await h.oracle.query("INSERT INTO k1b_probe.items (id) VALUES ($1)", [id]);
  return id;
}

/** The first actor: updates `id` and pauses holding the row lock until released, then commits. */
function holder(id: string): { run(): Promise<string>; reached: Promise<void>; finished: Promise<void>; release(): void; pid(): number } {
  let reachedNow!: () => void;
  let releaseNow!: () => void;
  let finishedNow!: () => void;
  const reached = new Promise<void>((resolve) => (reachedNow = resolve));
  const released = new Promise<void>((resolve) => (releaseNow = resolve));
  const finished = new Promise<void>((resolve) => (finishedNow = resolve));
  return {
    async run() {
      try {
        await a.query("BEGIN");
        await a.query("UPDATE k1b_probe.items SET n = n + 1 WHERE id = $1", [id]);
        reachedNow();
        await released;
        await a.query("COMMIT");
        return "first";
      } finally {
        finishedNow();
      }
    },
    reached,
    finished,
    release: () => releaseNow(),
    pid: () => connectionPid(a),
  };
}

/** The second actor: updates `id` in one transaction on the connection it is handed. */
const writer = (id: string) => async (client: HarnessConnection): Promise<string> => {
  await client.query("BEGIN");
  try {
    await client.query("UPDATE k1b_probe.items SET n = n + 10 WHERE id = $1", [id]);
    await client.query("COMMIT");
    return "second";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
};

const CELL = { step: "k1b race credit", fault: "race", expect: "the second waits behind the first" } as const;

test("raceAtWrite with credit: a second that waits on the first's lock is observed by ctx.mustWait and credited: the cell is green with outcome 'blocked'", async () => {
  const contested = await newItem();
  let result: RaceResult<string, string> | undefined;
  const ctx = await runCell(CELL, async (c: FaultContext) => {
    result = await raceAtWrite({ oracle: h.oracle, first: holder(contested), second: { run: () => Promise.reject(new Error("credit uses runOn")), runOn: writer(contested), waiter: b, pid: () => connectionPid(b) }, credit: c });
  });
  assert.equal(ctx.observedWaits, 1, "one observed wait credited");
  assert.equal(result?.outcome, "blocked");
  assert.deepEqual([result?.first.status, result?.second.status], ["fulfilled", "fulfilled"]);
  assert.equal((await h.oracle.query("SELECT n FROM k1b_probe.items WHERE id = $1", [contested])).rows[0]?.n, 11, "both writes landed, in order");
});

test("raceAtWrite with credit: a second that settles WITHOUT waiting is not credited: the cell is red (FaultNotInjected, 'no lock wait ... was observed') while the outcome stays 'settled' and the second keeps its own answer", async () => {
  const held = await newItem();
  const elsewhere = await newItem();
  let result: RaceResult<string, string> | undefined;
  await assert.rejects(
    runCell(CELL, async (c: FaultContext) => {
      result = await raceAtWrite({ oracle: h.oracle, first: holder(held), second: { run: () => Promise.reject(new Error("credit uses runOn")), runOn: writer(elsewhere), waiter: b, pid: () => connectionPid(b) }, credit: c });
    }),
    (e: unknown) => e instanceof FaultNotInjected && /no lock wait of the operation on the intended holder was observed/.test(e.message),
  );
  assert.equal(result?.outcome, "settled");
  assert.deepEqual(result?.second, { status: "fulfilled", value: "second" });
});

test("raceAtWrite without credit keeps the K1 behavior: the outcome is reported but no wait is credited, so a race cell built on it alone is FaultNotInjected (the defect `credit` repairs)", async () => {
  const contested = await newItem();
  let result: RaceResult<string, string> | undefined;
  await assert.rejects(
    runCell(CELL, async () => {
      result = await raceAtWrite({ oracle: h.oracle, first: holder(contested), second: { run: () => writer(contested)(b), pid: () => connectionPid(b) } });
    }),
    FaultNotInjected,
  );
  assert.equal(result?.outcome, "blocked", "the race itself happened");
});

test("raceAtWrite with credit names its waiter connection and runOn: a second without them is a TypeError before the first starts, never a silently uncredited run", async () => {
  const contested = await newItem();
  const first = holder(contested);
  await assert.rejects(
    runCell(CELL, async (c: FaultContext) => {
      await raceAtWrite({ oracle: h.oracle, first, second: { run: () => writer(contested)(b), pid: () => connectionPid(b) }, credit: c });
    }),
    (e: unknown) => e instanceof TypeError && /waiter connection and runOn/.test(e.message),
  );
  await h.oracle.query("SELECT 1 FROM k1b_probe.items WHERE id = $1", [contested]); // nothing was staged: the first never started
});

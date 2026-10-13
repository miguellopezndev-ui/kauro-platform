// PAID_STAGED retention deadlines of a staged CRM import workflow (package B16 lane L7, cases R2-054 and R2-055, gate G-DELETE; manual 09
// "Retention schedule" staged row and "Quotes, reuploads and retention": "Stage continuation ends at the earlier of first release plus
// twenty-one days and capture plus thirty days ... final download access may last up to seven days after completion but still ends no
// later than capture plus thirty days ... A late receipt cannot create the final-delivery allowance after workflow expiry"; "A staged
// workflow waiting legitimately for agency import is not an eight-hour running job and does not trigger the ordinary execution watchdog").
// Mandate .kauro/mandates/B16-REST-PLAN.md §5 C7: no runtime writer releases an import stage yet (0052 header), so the window and its stage
// are fixture-born through the owner's oracle connection (as the stage compiler would write them); R2-054/R2-055 stay PART until a
// stage-release writer exists. Every instant is the database's: a fixture stands at "capture + N days" through the labelled TEST CLOCK
// (kauro_test.clock_offset_seconds, transaction-local), never a back-dated row, never the process clock. The superuser is the oracle.
//
// Failure matrix of the deadline writer (kauro.staged_retention_windows birth, first release, final completion; the reads
// kauro.staged_retention_phase / _current / _due):
// | step            | RACE                         | TIMEOUT                         | EXPIRY                              | CRASH-BEFORE              | CRASH-AFTER                    | RETRY                                   | REVOCATION                                 | PARTIAL                          |
// | birth           | N/A: one INSERT per plan, the UNIQUE (agency, plan) key refuses the second (T8) | N/A: no lock wait before its stamp | N/A: born unreleased, no deadline judged | N/A: an uncommitted INSERT leaves nothing | N/A: a second birth is refused 23505 (T8) | T8 the writer's capture/hard instants ignored | T8 capture of another plan / no capture refused KA072 | N/A: one row |
// | first release   | T5 both orders: second waits, first committer's instant stays | N/A: a release judges only the 30-day hard cap, covered by T3 at the exact instant | T3 release at capture + 30 d refused | T7 terminated before COMMIT: unreleased, re-run anchors at its own instant | T7 committed, replay keeps the anchor | T4 identical replay, later stage release, client instant, written deadline | N/A in L7: a reversed capture never extends a deadline; the deletion it triggers is B09's | T7 second write of the unit refused: release rolled back, retry anchors |
// | final completion| N/A: serialised by the same row lock as T5; the judged instant is covered by T6 | T6 effect clock crosses the deadline while waiting: refused | T3 at the deadline refused, 1 s before granted and capped | N/A: same statement class as the release (T7) | T4 retried completion keeps the first | T4 retried completion keeps the first | N/A in L7 (as release) | N/A: one statement |
// | phase / due     | N/A: read only               | N/A: read only                  | T1/T2 at deadline EXPIRED, 1 µs before open; T9 due at the deadline | N/A: read only | N/A: read only | T4 re-read on a later clock moves nothing | N/A: read only | N/A: read only |
// | waiting (R2-055)| N/A: no write while waiting  | T9 ten days waiting: no job, attempt, lease or slot; JOB_DEADLINES examines nothing | T9 the deadline keeps running and is due at release + 21 d | N/A | N/A | N/A | N/A | N/A |
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as domain from "@kauro/domain";
import { connectionPid, EFFECT_CLOCK_MARGIN_MS, mustWait, openConnection, terminateBackend, bothOrders, type HarnessConnection } from "@kauro/persistence/testing";
import { ids, sha, startExecutionWorld, type ExecutionWorld, type Purchase } from "./support/execution-world.js";

let w: ExecutionWorld;
before(async () => {
  w = await startExecutionWorld("staged");
});
after(async () => {
  await w.stop();
});

const DAY = 86_400;
/** Seconds as the exact decimal count of microseconds the oracle reports. */
const us = (seconds: number): string => (BigInt(Math.round(seconds * 1_000_000))).toString();
const days = (n: number): string => us(n * DAY);

type Pg = Pick<HarnessConnection, "query">;
type Outcome<T> = { readonly ok: T } | { readonly error: string };
const failure = (e: unknown): string => {
  const x = e as { code?: string; message?: string };
  return `${x.code ?? "?"} ${x.message ?? String(e)}`;
};

/** Runs `work` in one transaction on `conn` whose server clock stands exactly `sinceCapture` seconds after the window's capture instant. */
async function asOf<T>(windowId: string, sinceCapture: number, work: (c: Pg) => Promise<T>, conn: Pg = w.h.oracle): Promise<Outcome<T>> {
  await conn.query("BEGIN");
  try {
    const placed = await conn.query(
      `SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM (x.captured_at + make_interval(secs => $2::double precision) - transaction_timestamp()))::text, true)
         FROM kauro.staged_retention_windows x WHERE x.window_id = $1`,
      [windowId, sinceCapture],
    );
    if (placed.rowCount !== 1) throw new Error(`window ${windowId} not found`);
    const out = await work(conn);
    await conn.query("COMMIT");
    return { ok: out };
  } catch (e) {
    await conn.query("ROLLBACK");
    return { error: failure(e) };
  }
}

/** A statement of the oracle outside any clock placement. */
async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await work() };
  } catch (e) {
    return { error: failure(e) };
  }
}

/** The staged workflow of a fresh paid purchase: its window born on the purchase's capture, as the stage compiler would write it. */
async function bornWindow(p: Purchase): Promise<Outcome<string>> {
  const windowId = ids.next();
  const r = await attempt(() =>
    w.h.oracle.query("INSERT INTO kauro.staged_retention_windows (window_id, agency_id, project_id, plan_id, capture_id) VALUES ($1, $2, $3, $4, $5)", [windowId, p.agency.agencyId, p.projectId, p.planId, p.captureId]),
  );
  return "error" in r ? r : { ok: windowId };
}

async function freshWindow(label: string): Promise<{ readonly p: Purchase; readonly windowId: string }> {
  const p = await w.paid(w.A, label);
  const born = await bornWindow(p);
  assert.ok("ok" in born, `the window of ${label} is born on its capture: ${"error" in born ? born.error : ""}`);
  return { p, windowId: born.ok };
}

const RELEASE = "UPDATE kauro.staged_retention_windows SET first_released_at = now() WHERE window_id = $1";
const COMPLETE = "UPDATE kauro.staged_retention_windows SET final_completed_at = now() WHERE window_id = $1";
const release = (windowId: string, sinceCapture: number): Promise<Outcome<number | null>> => asOf(windowId, sinceCapture, async (c) => (await c.query(RELEASE, [windowId])).rowCount);
const complete = (windowId: string, sinceCapture: number): Promise<Outcome<number | null>> => asOf(windowId, sinceCapture, async (c) => (await c.query(COMPLETE, [windowId])).rowCount);

/** Every instant of the window as microseconds after its capture instant (null when not reached). */
interface WindowView {
  readonly hard: string;
  readonly release: string | null;
  readonly continuation: string | null;
  readonly completion: string | null;
  readonly final: string | null;
}
const rel = (col: string): string => `CASE WHEN ${col} IS NULL THEN NULL ELSE (extract(epoch FROM ${col} - captured_at) * 1000000)::bigint::text END`;
async function windowOf(windowId: string): Promise<Outcome<WindowView>> {
  return attempt(async () => {
    const r = await w.h.oracle.query<WindowView>(
      `SELECT ${rel("hard_deadline")} AS hard, ${rel("first_released_at")} AS release, ${rel("continuation_deadline")} AS continuation,
              ${rel("final_completed_at")} AS completion, ${rel("final_download_deadline")} AS final
         FROM kauro.staged_retention_windows WHERE window_id = $1`,
      [windowId],
    );
    assert.equal(r.rows.length, 1, "the window exists");
    return r.rows[0]!;
  });
}

interface Standing {
  readonly phase: string;
  readonly deadline: string;
  readonly remaining: string;
}
/** kauro.staged_retention_phase at exactly `sinceCapture` seconds after the capture (the deadline relative to the capture, the remaining microseconds). */
async function phaseAt(windowId: string, sinceCapture: number): Promise<Outcome<Standing>> {
  return attempt(async () => {
    const r = await w.h.oracle.query<Standing>(
      `SELECT (p).phase AS phase, (extract(epoch FROM (p).governing_deadline - y.captured_at) * 1000000)::bigint::text AS deadline, (p).remaining_micros::text AS remaining
         FROM (SELECT x.captured_at, kauro.staged_retention_phase(x, x.captured_at + make_interval(secs => $2::double precision)) AS p
                 FROM kauro.staged_retention_windows x WHERE x.window_id = $1) y`,
      [windowId, sinceCapture],
    );
    return r.rows[0]!;
  });
}

/** The window's anchors as epoch microseconds (the domain mirror's input) and its deadlines as the database wrote them. */
async function anchorsOf(windowId: string): Promise<{ readonly anchors: domain.StagedRetentionAnchors; readonly hard: bigint; readonly continuation: bigint | null; readonly final: bigint | null }> {
  const micros = (col: string): string => `CASE WHEN ${col} IS NULL THEN NULL ELSE (extract(epoch FROM ${col}) * 1000000)::bigint::text END`;
  const r = await w.h.oracle.query<{ c: string; r: string | null; f: string | null; h: string; cd: string | null; fd: string | null }>(
    `SELECT ${micros("captured_at")} AS c, ${micros("first_released_at")} AS r, ${micros("final_completed_at")} AS f, ${micros("hard_deadline")} AS h,
            ${micros("continuation_deadline")} AS cd, ${micros("final_download_deadline")} AS fd FROM kauro.staged_retention_windows WHERE window_id = $1`,
    [windowId],
  );
  const x = r.rows[0]!;
  const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));
  return {
    anchors: { capturedAtMicros: BigInt(x.c), ...(x.r === null ? {} : { firstReleasedAtMicros: BigInt(x.r) }), ...(x.f === null ? {} : { finalCompletedAtMicros: BigInt(x.f) }) },
    hard: BigInt(x.h),
    continuation: big(x.cd),
    final: big(x.fd),
  };
}

/** The domain mirror computes exactly the database's deadlines from the database's anchors. */
async function domainAgrees(windowId: string): Promise<void> {
  const a = await anchorsOf(windowId);
  const out = domain.stagedRetentionDeadlines(a.anchors);
  assert.equal(out.kind, "DEADLINES");
  if (out.kind !== "DEADLINES") return;
  assert.deepEqual(
    [out.deadlines.hardDeadlineMicros, out.deadlines.continuationDeadlineMicros ?? null, out.deadlines.finalDownloadDeadlineMicros ?? null],
    [a.hard, a.continuation, a.final],
    "the domain mirror and the database agree on every deadline",
  );
}

test("R2-054: first release + 21 d governs stage continuation when it is earlier than capture + 30 d; a completion inside it gets the full seven-day final download; at each deadline the window is EXPIRED and one microsecond before it is open", async () => {
  const { windowId } = await freshWindow("staged-t1");
  // released two days after capture: continuation = min(2 + 21, 30) = capture + 23 d
  assert.deepEqual(await release(windowId, 2 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } });
  assert.deepEqual(await phaseAt(windowId, 23 * DAY - 0.000001), { ok: { phase: "CONTINUATION_OPEN", deadline: days(23), remaining: "1" } }, "one microsecond before the continuation deadline: open");
  assert.deepEqual(await phaseAt(windowId, 23 * DAY), { ok: { phase: "EXPIRED", deadline: days(23), remaining: "0" } }, "at the continuation deadline: expired");
  // the final stage completes ten days after capture: final download = min(10 + 7, 30) = capture + 17 d
  assert.deepEqual(await complete(windowId, 10 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: days(10), final: days(17) } });
  assert.deepEqual(await phaseAt(windowId, 10 * DAY), { ok: { phase: "FINAL_DOWNLOAD_OPEN", deadline: days(17), remaining: days(7) } }, "the full seven days");
  assert.deepEqual(await phaseAt(windowId, 17 * DAY - 0.000001), { ok: { phase: "FINAL_DOWNLOAD_OPEN", deadline: days(17), remaining: "1" } });
  assert.deepEqual(await phaseAt(windowId, 17 * DAY), { ok: { phase: "EXPIRED", deadline: days(17), remaining: "0" } });
  await domainAgrees(windowId);
  const a = await anchorsOf(windowId);
  const d = domain.stagedRetentionDeadlines(a.anchors);
  assert.ok(d.kind === "DEADLINES");
  assert.deepEqual(domain.stagedRetentionStanding(d.deadlines, a.anchors.capturedAtMicros + 10n * 86_400_000_000n), { phase: "FINAL_DOWNLOAD_OPEN", governingDeadlineMicros: a.anchors.capturedAtMicros + 17n * 86_400_000_000n, remainingMicros: 7n * 86_400_000_000n, remainingDays: 7 });
  assert.deepEqual(domain.stagedRetentionStanding(d.deadlines, a.anchors.capturedAtMicros + 17n * 86_400_000_000n), { phase: "EXPIRED", governingDeadlineMicros: a.anchors.capturedAtMicros + 17n * 86_400_000_000n, remainingMicros: 0n, remainingDays: 0 });
});

test("R2-054: capture + 30 d caps continuation when first release + 21 d is later; a final stage completing one day before the hard cap gets exactly one remaining day (deadline capture + 30 d), never seven", async () => {
  const { windowId } = await freshWindow("staged-t2");
  // released twelve days after capture: 12 + 21 = 33 > 30, so continuation = capture + 30 d
  assert.deepEqual(await release(windowId, 12 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(12), continuation: days(30), completion: null, final: null } });
  assert.deepEqual(await phaseAt(windowId, 30 * DAY - 0.000001), { ok: { phase: "CONTINUATION_OPEN", deadline: days(30), remaining: "1" } });
  assert.deepEqual(await phaseAt(windowId, 30 * DAY), { ok: { phase: "EXPIRED", deadline: days(30), remaining: "0" } });
  // the final stage completes at capture + 29 d: min(29 + 7, 30) = capture + 30 d, one day left
  assert.deepEqual(await complete(windowId, 29 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(12), continuation: days(30), completion: days(29), final: days(30) } });
  assert.deepEqual(await phaseAt(windowId, 29 * DAY), { ok: { phase: "FINAL_DOWNLOAD_OPEN", deadline: days(30), remaining: days(1) } }, "the actual remaining day, not seven");
  assert.deepEqual(await phaseAt(windowId, 30 * DAY - 0.000001), { ok: { phase: "FINAL_DOWNLOAD_OPEN", deadline: days(30), remaining: "1" } });
  assert.deepEqual(await phaseAt(windowId, 30 * DAY), { ok: { phase: "EXPIRED", deadline: days(30), remaining: "0" } });
  // the server-clock read (kauro.effect_now()) at capture + 29 d shows the same deadline and at most one day
  const current = await asOf(windowId, 29 * DAY, async (c) => (await c.query<{ phase: string; deadline: string; remaining: string }>(
    `SELECT s.phase, (extract(epoch FROM s.governing_deadline - x.captured_at) * 1000000)::bigint::text AS deadline, s.remaining_micros::text AS remaining
       FROM kauro.staged_retention_current($1) s, kauro.staged_retention_windows x WHERE x.window_id = $1`, [windowId])).rows[0]!);
  assert.ok("ok" in current, "error" in current ? current.error : "");
  assert.deepEqual([current.ok.phase, current.ok.deadline], ["FINAL_DOWNLOAD_OPEN", days(30)]);
  assert.ok(BigInt(current.ok.remaining) <= BigInt(days(1)) && BigInt(current.ok.remaining) > BigInt(days(1)) - 1_000_000n, `one day less the statement's own elapsed time: ${current.ok.remaining} µs`);
  await domainAgrees(windowId);
  const a = await anchorsOf(windowId);
  const d = domain.stagedRetentionDeadlines(a.anchors);
  assert.ok(d.kind === "DEADLINES");
  assert.deepEqual(domain.stagedRetentionStanding(d.deadlines, a.anchors.capturedAtMicros + 29n * 86_400_000_000n), { phase: "FINAL_DOWNLOAD_OPEN", governingDeadlineMicros: a.anchors.capturedAtMicros + 30n * 86_400_000_000n, remainingMicros: 86_400_000_000n, remainingDays: 1 });
});

test("R2-054 EXPIRY: a final completion at the continuation deadline is refused KA072 and creates no final-delivery allowance; one second before it the allowance is granted and still capped at capture + 30 d; a first release at capture + 30 d is refused", async () => {
  const late = await freshWindow("staged-t3-late");
  assert.deepEqual(await release(late.windowId, 2 * DAY), { ok: 1 });
  const refused = await complete(late.windowId, 23 * DAY);
  assert.ok("error" in refused && refused.error.startsWith("KA072 LIFECYCLE_BINDING: staged workflow"), `refused at the deadline: ${JSON.stringify(refused)}`);
  assert.match((refused as { error: string }).error, /late completion creates no final-delivery allowance/);
  assert.deepEqual(await windowOf(late.windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "no allowance was created");
  assert.deepEqual(await phaseAt(late.windowId, 23 * DAY), { ok: { phase: "EXPIRED", deadline: days(23), remaining: "0" } });

  const inTime = await freshWindow("staged-t3-in-time");
  assert.deepEqual(await release(inTime.windowId, 2 * DAY), { ok: 1 });
  assert.deepEqual(await complete(inTime.windowId, 23 * DAY - 1), { ok: 1 });
  // min(23 d - 1 s + 7 d, 30 d) = 30 d - 1 s
  assert.deepEqual(await windowOf(inTime.windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: us(23 * DAY - 1), final: us(30 * DAY - 1) } });

  const capped = await freshWindow("staged-t3-capped");
  assert.deepEqual(await release(capped.windowId, 22 * DAY), { ok: 1 });
  assert.deepEqual(await complete(capped.windowId, 29 * DAY + 0.5), { ok: 1 });
  assert.deepEqual(await windowOf(capped.windowId), { ok: { hard: days(30), release: days(22), continuation: days(30), completion: us(29 * DAY + 0.5), final: days(30) } }, "never past capture + 30 d");

  const tooLate = await freshWindow("staged-t3-release");
  const r = await release(tooLate.windowId, 30 * DAY);
  assert.ok("error" in r && r.error.startsWith("KA072 LIFECYCLE_BINDING: staged workflow") && /passed its hard deadline/.test(r.error), `release at the hard deadline refused: ${JSON.stringify(r)}`);
  assert.deepEqual(await windowOf(tooLate.windowId), { ok: { hard: days(30), release: null, continuation: null, completion: null, final: null } });
  assert.deepEqual(await release(tooLate.windowId, 30 * DAY - 1), { ok: 1 }, "one second before the hard deadline a release is accepted");
  assert.deepEqual(await windowOf(tooLate.windowId), { ok: { hard: days(30), release: us(30 * DAY - 1), continuation: days(30), completion: null, final: null } });
  assert.deepEqual(domain.stagedRetentionDeadlines({ capturedAtMicros: 0n, firstReleasedAtMicros: 2n * 86_400_000_000n, finalCompletedAtMicros: 23n * 86_400_000_000n }), { kind: "REFUSED", reason: "COMPLETION_AFTER_WORKFLOW_EXPIRY" });
  assert.deepEqual(domain.stagedRetentionDeadlines({ capturedAtMicros: 0n, firstReleasedAtMicros: 30n * 86_400_000_000n }), { kind: "REFUSED", reason: "RELEASE_AFTER_HARD_DEADLINE" });
});

test("R2-054 RETRY: an identical release replay, a later stage release, a client-supplied instant, a written deadline, a retried completion and a re-read on a later server clock never move an anchor or a deadline", async () => {
  const { windowId } = await freshWindow("staged-t4");
  // a client instant (one day after capture) is never the anchor: the server's instant (two days after capture) is
  const client = await asOf(windowId, 2 * DAY, async (c) => (await c.query("UPDATE kauro.staged_retention_windows SET first_released_at = captured_at + interval '1 day', continuation_deadline = captured_at + interval '40 days' WHERE window_id = $1", [windowId])).rowCount);
  assert.deepEqual(client, { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "server instant, computed deadline");
  // identical replay of the release on a later clock: the first release stays the anchor
  assert.deepEqual(await release(windowId, 5 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "identical replay");
  // a later stage's release (a different writer instant) is not the first release
  assert.deepEqual(await asOf(windowId, 9 * DAY, async (c) => (await c.query("UPDATE kauro.staged_retention_windows SET first_released_at = kauro.server_now() WHERE window_id = $1", [windowId])).rowCount), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "a later stage release");
  // a written deadline is recomputed from the anchors, an extension of the hard cap is refused
  assert.deepEqual(await asOf(windowId, 10 * DAY, async (c) => (await c.query("UPDATE kauro.staged_retention_windows SET continuation_deadline = captured_at + interval '29 days' WHERE window_id = $1", [windowId])).rowCount), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "a written continuation deadline");
  const hard = await asOf(windowId, 10 * DAY, async (c) => (await c.query("UPDATE kauro.staged_retention_windows SET hard_deadline = hard_deadline + interval '72 hours' WHERE window_id = $1", [windowId])).rowCount);
  assert.ok("error" in hard && hard.error.startsWith("KA004 IMMUTABLE_COLUMN"), `the hard cap never moves: ${JSON.stringify(hard)}`);
  // completion, then its retry and a written final deadline
  assert.deepEqual(await complete(windowId, 11 * DAY), { ok: 1 });
  assert.deepEqual(await complete(windowId, 12 * DAY), { ok: 1 });
  assert.deepEqual(await asOf(windowId, 12 * DAY, async (c) => (await c.query("UPDATE kauro.staged_retention_windows SET final_download_deadline = captured_at + interval '30 days' WHERE window_id = $1", [windowId])).rowCount), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: days(11), final: days(18) } }, "a retried completion and a written final deadline");
  // re-reads on later server clocks change nothing
  for (const at of [12 * DAY, 15 * DAY, 18 * DAY]) assert.deepEqual(await asOf(windowId, at, async (c) => (await c.query("SELECT * FROM kauro.staged_retention_current($1)", [windowId])).rowCount), { ok: 1 });
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: days(11), final: days(18) } }, "re-reads");
  await domainAgrees(windowId);
});

test("R2-054 RACE (both orders): two first-release writers on one window; the second is observed waiting on the row lock and the first committer's server instant stays the anchor", async () => {
  const x = await openConnection(w.h.pg.clientConfig("postgres"));
  const y = await openConnection(w.h.pg.clientConfig("postgres"));
  try {
    const at = { X: 2 * DAY, Y: 3 * DAY } as const;
    const place = (c: Pg, windowId: string, s: number) =>
      c.query(
        "SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM (x.captured_at + make_interval(secs => $2::double precision) - transaction_timestamp()))::text, true) FROM kauro.staged_retention_windows x WHERE x.window_id = $1",
        [windowId, s],
      );
    await bothOrders<{ readonly windowId: string }>({
      oracle: w.h.oracle,
      actors: [
        { name: "X", client: x, begin: async (c, st) => void (await place(c, st.windowId, at.X)), act: (c, st) => c.query(RELEASE, [st.windowId]) },
        { name: "Y", client: y, begin: async (c, st) => void (await place(c, st.windowId, at.Y)), act: (c, st) => c.query(RELEASE, [st.windowId]) },
      ],
      async setup(order) {
        return { windowId: (await freshWindow(`staged-t5-${order.join("")}`)).windowId };
      },
      async verify({ order, state, outcomes }) {
        assert.deepEqual([outcomes["X"]?.committed, outcomes["Y"]?.committed], [true, true], "both writes commit; the waiter's is a no-op");
        const first = at[order[0] as "X" | "Y"];
        assert.deepEqual(await windowOf(state.windowId), { ok: { hard: days(30), release: us(first), continuation: us(first + 21 * DAY), completion: null, final: null } }, `${order[0]} committed first`);
      },
    });
  } finally {
    await x.end();
    await y.end();
  }
});

test("R2-054 TIMEOUT: a final completion that waits on the window's row lock while its effect clock crosses the continuation deadline is refused at that instant (KA072), its transaction's server instant still before the deadline", async () => {
  const { windowId } = await freshWindow("staged-t6");
  assert.deepEqual(await release(windowId, 2 * DAY), { ok: 1 });
  const holder = await openConnection(w.h.pg.clientConfig("postgres"));
  const waiter = await openConnection(w.h.pg.clientConfig("postgres"));
  try {
    // the holder: a release replay inside an open transaction, holding the window's row lock
    await holder.query("BEGIN");
    await holder.query(RELEASE, [windowId]);
    // the waiter: its effect clock placed EFFECT_CLOCK_MARGIN_MS before capture + 23 d
    await waiter.query("BEGIN");
    const placed = await waiter.query<{ instant: string; deadline: string }>(
      `SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM (x.continuation_deadline - make_interval(secs => $2::double precision) - clock_timestamp()))::text, true),
              x.continuation_deadline::text AS deadline FROM kauro.staged_retention_windows x WHERE x.window_id = $1`,
      [windowId, EFFECT_CLOCK_MARGIN_MS / 1000],
    );
    const deadline = placed.rows[0]!.deadline;
    const instant = (await waiter.query<{ instant: string }>("SELECT kauro.server_now()::text AS instant")).rows[0]!.instant;
    const before = (await waiter.query<{ before: boolean }>("SELECT kauro.server_now() < $1::timestamptz AND kauro.effect_now() < $1::timestamptz AS before", [deadline])).rows[0]!.before;
    assert.equal(before, true, "the waiter's server and effect instants stand before the deadline when it starts");
    const { pending } = await mustWait(w.h.oracle, { waiter, holder: connectionPid(holder) }, (c) => c.query(COMPLETE, [windowId]), "the completion behind the release replay");
    // let the waiter's effect clock (instant + its elapsed transaction time) run past the deadline while it still waits
    const look = async () =>
      (
        await w.h.oracle.query<{ began_before: boolean; waiting: boolean; remaining_ms: string }>(
          `SELECT $3::timestamptz + (query_start - xact_start) < $4::timestamptz AS began_before,
                  wait_event_type IS NOT DISTINCT FROM 'Lock' AND $2::int = ANY (pg_blocking_pids(pid)) AS waiting,
                  (extract(epoch FROM $4::timestamptz - ($3::timestamptz + (clock_timestamp() - xact_start))) * 1000)::text AS remaining_ms
             FROM pg_stat_activity WHERE pid = $1`,
          [connectionPid(waiter), connectionPid(holder), instant, deadline],
        )
      ).rows[0]!;
    const first = await look();
    assert.equal(first.began_before, true, "its effect clock stood before the deadline when the waiting statement began");
    assert.equal(first.waiting, true, "the completion waits on the holder");
    assert.ok(Number(first.remaining_ms) <= EFFECT_CLOCK_MARGIN_MS, `within the harness margin: ${first.remaining_ms} ms`);
    if (Number(first.remaining_ms) >= 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(Number(first.remaining_ms)) + 1));
    const second = await look();
    assert.equal(second.waiting, true, "it still waits");
    assert.ok(Number(second.remaining_ms) < 0, `its effect clock ran past the deadline while it waited (${second.remaining_ms} ms)`);
    await holder.query("COMMIT");
    const settled = await pending;
    assert.equal(settled.status, "rejected", "the completion is refused at its effect instant");
    const why = failure((settled as PromiseRejectedResult).reason);
    assert.ok(why.startsWith("KA072 LIFECYCLE_BINDING: staged workflow") && /late completion creates no final-delivery allowance/.test(why), why);
    await waiter.query("ROLLBACK");
  } finally {
    await holder.end();
    await waiter.end();
  }
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "no allowance");
});

test("R2-054 CRASH-BEFORE / CRASH-AFTER / PARTIAL: a release whose backend dies before COMMIT leaves the window unreleased and the re-run anchors at its own instant; a committed release survives the crash and its replay keeps it; a unit whose second write fails rolls the release back", async () => {
  // CRASH-BEFORE
  const a = await freshWindow("staged-t7-before");
  const victim = await openConnection(w.h.pg.clientConfig("postgres"));
  await victim.query("BEGIN");
  await victim.query("SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM (x.captured_at + interval '2 days' - transaction_timestamp()))::text, true) FROM kauro.staged_retention_windows x WHERE x.window_id = $1", [a.windowId]);
  assert.equal((await victim.query(RELEASE, [a.windowId])).rowCount, 1);
  await terminateBackend(w.h.oracle, victim);
  assert.deepEqual(await windowOf(a.windowId), { ok: { hard: days(30), release: null, continuation: null, completion: null, final: null } }, "nothing of the uncommitted release");
  assert.deepEqual(await release(a.windowId, 3 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(a.windowId), { ok: { hard: days(30), release: days(3), continuation: days(24), completion: null, final: null } }, "the re-run's own instant");
  // CRASH-AFTER
  const b = await freshWindow("staged-t7-after");
  const committed = await openConnection(w.h.pg.clientConfig("postgres"));
  assert.deepEqual(await asOf(b.windowId, 2 * DAY, async (c) => (await c.query(RELEASE, [b.windowId])).rowCount, committed), { ok: 1 });
  await terminateBackend(w.h.oracle, committed);
  assert.deepEqual(await windowOf(b.windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "the committed release survives");
  assert.deepEqual(await release(b.windowId, 4 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(b.windowId), { ok: { hard: days(30), release: days(2), continuation: days(23), completion: null, final: null } }, "the replay returns the committed anchor");
  // PARTIAL: the release and an unlisted stage edge (no stage-release writer exists, 0052 refuses PREPARED -> RELEASED) in one unit
  const c = await freshWindow("staged-t7-partial");
  const stageId = await seedStage(c.p, "PREPARED", 7 * DAY);
  const unit = await asOf(c.windowId, 2 * DAY, async (x) => {
    await x.query(RELEASE, [c.windowId]);
    await x.query("UPDATE kauro.import_stages SET state = 'RELEASED', version = version + 1 WHERE stage_id = $1", [stageId]);
  });
  assert.ok("error" in unit && unit.error.startsWith("KA008 UNLISTED_TRANSITION"), `the second write is refused: ${JSON.stringify(unit)}`);
  assert.deepEqual(await windowOf(c.windowId), { ok: { hard: days(30), release: null, continuation: null, completion: null, final: null } }, "the release rolled back with its unit");
  assert.deepEqual((await w.h.oracle.query("SELECT state, version FROM kauro.import_stages WHERE stage_id = $1", [stageId])).rows, [{ state: "PREPARED", version: 1 }]);
  assert.deepEqual(await release(c.windowId, 3 * DAY), { ok: 1 });
  assert.deepEqual(await windowOf(c.windowId), { ok: { hard: days(30), release: days(3), continuation: days(24), completion: null, final: null } }, "the retry anchors at its own instant");
});

test("R2-054 REVOCATION (binding): a window is born only on a COMPLETED capture of its own project and plan, once per plan; its capture instant and hard deadline come from the capture fact, never from the writer", async () => {
  const p1 = await w.paid(w.A, "staged-t8-one");
  const p2 = await w.paid(w.A, "staged-t8-two");
  const foreign = await bornWindow({ ...p1, captureId: p2.captureId });
  assert.ok("error" in foreign && foreign.error.startsWith("KA072 LIFECYCLE_BINDING: a staged retention window"), `another plan's capture: ${JSON.stringify(foreign)}`);
  const otherPlan = await bornWindow({ ...p1, planId: p2.planId });
  assert.ok("error" in otherPlan && otherPlan.error.startsWith("KA072 LIFECYCLE_BINDING: a staged retention window"), `its capture paid another plan: ${JSON.stringify(otherPlan)}`);
  const none = await bornWindow({ ...p1, captureId: ids.next() });
  assert.ok("error" in none && none.error.startsWith("KA072 LIFECYCLE_BINDING: a staged retention window"), `no capture: ${JSON.stringify(none)}`);
  // the writer's own capture instant, hard deadline and release are ignored or refused
  const windowId = ids.next();
  const lied = await attempt(() =>
    w.h.oracle.query(
      "INSERT INTO kauro.staged_retention_windows (window_id, agency_id, project_id, plan_id, capture_id, captured_at, hard_deadline) VALUES ($1, $2, $3, $4, $5, now() + interval '10 days', now() + interval '60 days')",
      [windowId, p1.agency.agencyId, p1.projectId, p1.planId, p1.captureId],
    ),
  );
  assert.ok("ok" in lied, "error" in lied ? lied.error : "");
  const facts = (await w.h.oracle.query<{ same: boolean; hard: string }>(
    `SELECT x.captured_at = least(c.provider_completed_at, c.first_observed_at) AS same, (extract(epoch FROM x.hard_deadline - x.captured_at) * 1000000)::bigint::text AS hard
       FROM kauro.staged_retention_windows x JOIN kauro.capture_facts c ON c.capture_id = x.capture_id WHERE x.window_id = $1`, [windowId])).rows;
  assert.deepEqual(facts, [{ same: true, hard: days(30) }], "the capture fact's instant (the earlier of provider completion and first observation) + 30 d");
  const second = await bornWindow(p1);
  assert.ok("error" in second && second.error.startsWith("23505"), `one window per plan: ${JSON.stringify(second)}`);
  const released = await attempt(() =>
    w.h.oracle.query("INSERT INTO kauro.staged_retention_windows (window_id, agency_id, project_id, plan_id, capture_id, first_released_at) VALUES ($1, $2, $3, $4, $5, now())", [ids.next(), p2.agency.agencyId, p2.projectId, p2.planId, p2.captureId]),
  );
  assert.ok("error" in released && released.error.startsWith("KA072 LIFECYCLE_BINDING: a staged retention window is born unreleased"), JSON.stringify(released));
  const gone = await attempt(() => w.h.oracle.query("DELETE FROM kauro.staged_retention_windows WHERE window_id = $1", [windowId]));
  assert.ok("error" in gone, "a window is never deleted");
});

/** A stage of the purchase's plan as the stage compiler leaves it (the request role has no INSERT on stages). */
async function seedStage(p: Purchase, state: "PREPARED" | "AWAITING_AGENCY_IMPORT", expiresInSeconds: number): Promise<string> {
  const stageId = ids.next();
  await w.h.oracle.query(
    `INSERT INTO kauro.import_stages (stage_id, agency_id, project_id, plan_id, sequence, object_api_name, operation, state, parent_stage_ids, package_hash, receipt_required, expires_at, instance_id, source_ids)
     VALUES ($1, $2, $3, $4, 1, 'Contact', 'CREATE_ONLY', $5, '[]'::jsonb, $6, true, kauro.server_now() + make_interval(secs => $7::double precision), $8, '["src-1","src-2"]'::jsonb)`,
    [stageId, p.agency.agencyId, p.projectId, p.planId, state, sha(`package-${stageId}`), expiresInSeconds, ids.next()],
  );
  return stageId;
}

async function computeOf(p: Purchase, subjects: ReadonlyArray<string>): Promise<{ readonly jobs: string; readonly attempts: string; readonly leases: string }> {
  return (
    await w.h.oracle.query<{ jobs: string; attempts: string; leases: string }>(
      `SELECT (SELECT count(*) FROM kauro.processing_jobs WHERE project_id = $1)::text AS jobs,
              (SELECT count(*) FROM kauro.processing_attempts WHERE project_id = $1)::text AS attempts,
              (SELECT count(*) FROM kauro.leases WHERE cost_authority_id = $2 OR resource_id = ANY ($3::uuid[]))::text AS leases`,
      [p.projectId, p.authorizationId, [p.projectId, ...subjects]],
    )
  ).rows[0]!;
}

test("R2-055: a parent stage waiting ten days for the agency's receipt holds no job, attempt, lease, heartbeat or capacity slot, the execution watchdog never fires for it, and its continuation deadline keeps running (eleven days left, never paused) until it is due at release + 21 d", async () => {
  const { p, windowId } = await freshWindow("staged-t9");
  assert.deepEqual(await release(windowId, 1 * DAY), { ok: 1 });
  const stageId = await seedStage(p, "AWAITING_AGENCY_IMPORT", 21 * DAY);
  // the control plane ten days after the release (capture + 11 d): the watchdog and the monitor find nothing to run or expire
  const offset = 11 * DAY;
  w.advance(offset);
  try {
    const deadlines = await w.x.sweepers.jobDeadlines.sweep(w.units, 50);
    const monitor = await w.x.sweepers.attemptMonitor.sweep(w.units, 50);
    assert.deepEqual([deadlines.examined, deadlines.acted, monitor.examined, monitor.acted], [0, 0, 0, 0], "no execution watchdog for a waiting stage");
  } finally {
    w.advance(-offset);
  }
  assert.deepEqual(await computeOf(p, [stageId, windowId]), { jobs: "0", attempts: "0", leases: "0" }, "waiting is not compute");
  assert.deepEqual(await w.capacity(p.agency.agencyId), { active: 0, waiting: 0, live: 0 });
  assert.deepEqual((await w.h.oracle.query("SELECT state, version FROM kauro.import_stages WHERE stage_id = $1", [stageId])).rows, [{ state: "AWAITING_AGENCY_IMPORT", version: 1 }]);
  // the deadline continued: eleven days left at capture + 11 d, the same deadline (capture + 22 d), not paused by the wait
  assert.deepEqual(await windowOf(windowId), { ok: { hard: days(30), release: days(1), continuation: days(22), completion: null, final: null } });
  assert.deepEqual(await phaseAt(windowId, 11 * DAY), { ok: { phase: "CONTINUATION_OPEN", deadline: days(22), remaining: days(11) } });
  const due = (s: number) => asOf(windowId, s, async (c) => (await c.query<{ window_id: string; deadline: string }>(
    `SELECT d.window_id, (extract(epoch FROM d.governing_deadline - x.captured_at) * 1000000)::bigint::text AS deadline
       FROM kauro.staged_retention_due(1000) d JOIN kauro.staged_retention_windows x USING (window_id) WHERE d.window_id = $1`, [windowId])).rows);
  assert.deepEqual(await due(11 * DAY), { ok: [] }, "not due while waiting");
  assert.deepEqual(await due(22 * DAY), { ok: [{ window_id: windowId, deadline: days(22) }] }, "due at release + 21 d although the stage still waits");
  assert.deepEqual(await phaseAt(windowId, 22 * DAY), { ok: { phase: "EXPIRED", deadline: days(22), remaining: "0" } });
  await domainAgrees(windowId);
});

// The family runner's own checks (docs/design/B10-KIT-SUITES.md sections 3 and 4): registration refuses an incomplete or ambiguous family
// before any cell runs, a member registers under its matrix reference and tag, and the routing of one invocation numbers its units from 1
// across every access to the routed factory, logs each unit's role and statements, and names only the target ordinal's commit boundary
// `target`. The families themselves (CMD_TMO, CMD_CRA, TEN_REV, SWEEP_*, CONS_*, LEASE) register their members in their own files.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FaultPoints } from "@kauro/persistence/testing";
import { integrationWorld, type IntegrationWorld } from "./integration-support.js";
import { bindCells, memberCell, open, registerFamily, runSweepPass, settled, validateMembers, type Member } from "./b10-cells-support.js";
import type { UnitLog } from "./fault-support.js";

let iw: IntegrationWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => iw.h.oracle);
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

const step = { label: "lines.lock", match: /FROM kauro\.commission_lines/ };
/** A member with every declaration a registration needs; `over` replaces what a check is about. */
const member = (over: Record<string, unknown> = {}): Member<never, never> =>
  ({
    code: "SWEEP_CRB",
    cell: { table: "Sweep ELIGIBILITY", row: "ELIGIBLE", column: "CRASH-BEFORE" },
    tag: "[gsweepcrb]",
    roles: { kauro_commission: "kauro_commission_test" },
    fixture: async () => undefined as never,
    act: async () => undefined as never,
    point: { kind: "crash-before", unit: { ordinal: 2, phase: "ELIGIBLE", witness: step, identity: () => () => true } },
    tables: ["commission_lines"],
    earlier: async () => ({}),
    failed: async () => undefined,
    recover: async () => undefined,
    recovered: async () => undefined,
    expect: "the line stays HELD beside its RELEASED hold; the next pass makes it ELIGIBLE once",
    ...over,
  }) as unknown as Member<never, never>;

test("registration refuses an incomplete or ambiguous family, naming every reason", () => {
  validateMembers([member()]);
  const crashAfter = member({ code: "SWEEP_CRA", tag: "[gsweepcra]", point: { kind: "crash-after", unit: { ordinal: 2, phase: "ELIGIBLE", witness: step, identity: () => () => true } } });
  assert.throws(() => validateMembers([crashAfter]), /SWEEP_CRA: a crash-after member declares what its committed unit leaves \(committed\)/);
  validateMembers([member({ ...crashAfter, committed: async () => undefined })] as never);
  assert.throws(() => validateMembers([member(), member()]), (e: unknown) => e instanceof Error && /registered twice/.test(e.message) && /the tag \[gsweepcrb\] names two members/.test(e.message));
  assert.throws(() => validateMembers([member({ tag: "gsweepcrb" })]), /is not of the matrix test index form/);
  assert.throws(() => validateMembers([member({ roles: {} })]), /no role/);
  assert.throws(() => validateMembers([member({ point: { kind: "lease", obligation: { row: "L1", column: "TIMEOUT" } } })]), /LEASE family's runner/);
  assert.throws(() => validateMembers([member({ point: { kind: "crash-before", unit: { ordinal: 0, phase: "x", witness: step, identity: () => () => true } } })]), /ordinal is a positive integer/);
  assert.throws(() => validateMembers([member({ point: { kind: "port-timeout", port: "BuyerTypeReader", boundMs: 0 } })]), /declares the application's bound/);
});

test("registration refuses an empty family (a filtered list that comes out empty registers no cell and would pass silently)", () => {
  assert.throws(() => validateMembers([]), /the family has no member/);
  assert.throws(() => registerFamily([]), /the family has no member/);
});

test("a member registers as a cell of its code, matrix reference, variant and tag, its crash at the target unit's commit boundary", () => {
  assert.deepEqual(memberCell(member({ variant: "release unit" })), {
    id: "SWEEP_CRB",
    step: "Sweep ELIGIBILITY ELIGIBLE CRASH-BEFORE (release unit) [gsweepcrb]",
    fault: "crash-before-commit",
    at: "target",
    expect: "the line stays HELD beside its RELEASED hold; the next pass makes it ELIGIBLE once",
  });
  assert.equal(memberCell(member({ point: { kind: "lock-timeout", hold: async () => undefined, waits: { ...step, identity: () => () => true } } })).fault, "race");
  assert.equal(memberCell(member({ point: { kind: "port-timeout", port: "PreparationCompletionSource", boundMs: 1000 } })).fault, "timeout");
});

test("routing: one invocation numbers its units from 1 across the routed factory's accesses, each with its role, attempt and statement log", async () => {
  const conn = await open("kauro_commission_test");
  const log: UnitLog[] = [];
  try {
    await iw.faults.on(conn, "kauro_commission", new FaultPoints(), [], () => runSweepPass("ELIGIBILITY"), { log });
  } finally {
    await conn.end();
  }
  assert.ok(log.length >= 2, `the ELIGIBILITY pass opened its list units (${log.length})`);
  assert.deepEqual(log.map((u) => u.ordinal), log.map((_, i) => i + 1), "numbered from 1 by the invocation");
  for (const u of log) {
    assert.deepEqual([u.name, u.role, u.attempts], ["uow", "kauro_commission", 1], `unit ${u.ordinal}`);
    assert.ok(u.statements.length > 0 && u.statements.every((s) => s.outcome === "answered" && s.attempt === 1), `unit ${u.ordinal} logged its answered statements: ${JSON.stringify(u.statements.map((s) => [s.text.slice(0, 40), s.outcome, s.code, s.attempt]))}`);
  }
});

test("routing: only the target ordinal's unit is crashable as `target`; its crash before COMMIT fires there and the next pass runs unrouted", async () => {
  const conn = await open("kauro_commission_test");
  const points = new FaultPoints();
  const log: UnitLog[] = [];
  const crash = points.crash("target.before-commit");
  try {
    const outcome = await settled(iw.faults.on(conn, "kauro_commission", points, [], () => runSweepPass("ELIGIBILITY", { expectFailure: true }), { target: 2, log }));
    void outcome;
    await crash.reached;
  } finally {
    await conn.end();
  }
  assert.deepEqual(points.crashes, ["target.before-commit"]);
  assert.deepEqual(log.slice(0, 2).map((u) => [u.ordinal, u.name]), [[1, "uow"], [2, "target"]]);
  assert.ok(log.slice(2).every((u) => u.name === "uow"), "every other unit keeps the uow boundary");
  await runSweepPass("ELIGIBILITY");
});

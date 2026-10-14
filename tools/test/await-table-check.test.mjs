// The await-table check (tools/lib/await-table-check.mjs; local plan section 4, r15/r25): no await between the clock read and the effect.
import assert from "node:assert/strict";
import test from "node:test";
import { checkAwaitTable, checkRow } from "../lib/await-table-check.mjs";

const row = { file: "h.ts", clockCall: "effectNowOf", effectCall: "ports.recordContinuation" };
const handler = (between) => `
export async function handle(ports: P, ctx: C) {
  const stage = await ports.lockCurrentByHash(ctx.hash);
  const now = effectNowOf(ctx);
  ${between}
  if (stage.expiresAt <= now) return "STAGE_EXPIRED";
  return await ports.recordContinuation(stage, now);
}
`;

test("the table order (last await, clock, judgment, effect) is green", () => {
  assert.deepEqual(checkRow(row, handler("")), []);
});

test("a planted await between the clock read and the effect is red, naming its line", () => {
  const violations = checkRow(row, handler("await Promise.resolve();"));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^h\.ts:\d+: await between effectNowOf \(line 4\) and ports\.recordContinuation/);
});

test("an await inside the effect's own arguments runs before the effect and is red; the effect's own await is not", () => {
  const src = `export async function h(ports: P) { const now = effectNowOf(); return await ports.recordContinuation(await ports.load(), now); }`;
  assert.equal(checkRow(row, src).length, 1);
  assert.deepEqual(checkRow(row, `export async function h(ports: P) { const now = effectNowOf(); return (await ports.recordContinuation(now)); }`), []);
});

test("an await after the effect, before the clock, or in another function is not between them", () => {
  const src = `
async function other() { await x(); }
export async function h(ports: P) {
  await ports.a();
  const now = effectNowOf();
  const r = await ports.recordContinuation(now);
  await ports.after();
  return r;
}`;
  assert.deepEqual(checkRow(row, src), []);
});

test("a stale row never passes: a missing clock call, or no effect after the clock, is a violation", () => {
  assert.match(checkRow(row, "export async function h(ports: P) { await ports.recordContinuation(); }")[0], /clock call effectNowOf not found/);
  assert.match(checkRow(row, "export async function h(ports: P) { effectNowOf(); }")[0], /no ports\.recordContinuation call follows/);
});

test("checkAwaitTable reads each row's file under root and reports every row", () => {
  const files = { "a.ts": handler(""), "b.ts": handler("await ports.x();") };
  const rows = [{ ...row, file: "a.ts" }, { ...row, file: "b.ts" }];
  const violations = checkAwaitTable(rows, { root: "/r", read: (p) => files[p.replaceAll("\\", "/").split("/").pop()] });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^b\.ts:/);
});

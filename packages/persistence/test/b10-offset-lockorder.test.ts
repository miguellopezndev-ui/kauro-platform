// The one lock order at the database (docs/design/B10-OFFSET.md G-ORD-1, cells S71 S72 S75 S77; migration 0055): the first B10 lock call of a
// transaction may block, every later one refuses KC027 COMMISSION_LOCK_ORDER instead of waiting, a missing line is KC022
// COMMISSION_LINE_NOT_FOUND, and the owner's lock-only path (the created_at column and its WITH CHECK false policy) writes nothing else.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { invariantsAfterEach } from "../src/testing/invariants.js";
import { corporate, ids, ownerOf, within } from "./b10-commission-support.js";
import { asCommission, closeOffsetWorld, openOffsetWorld, ordered, sellerWith as sellerWithIn, type OffsetWorld } from "./b10-offset-support.js";

let ow: OffsetWorld;
invariantsAfterEach(() => ow.w.h.oracle);
before(async () => {
  ow = await openOffsetWorld("b10-offset-lockorder");
});
after(async () => {
  await closeOffsetWorld(ow);
});

const lockRows = (c: Client, lines: readonly string[], mode = "UPDATE") => c.query("SELECT kauro.commission_lock_line_rows($1::uuid[], $2)", [lines, mode]);
const kc = (code: string) => (e: unknown): boolean => (e as { code?: string }).code === code;

test("S71: a transaction's SECOND lock call over a row another transaction holds is refused KC027 and does not wait", async () => {
  const { negativeLines: [a], receivingLines: [b] } = await sellerWithIn(ow, "lockorder-s71", 1, [500]);
  const raced = await ordered(
    ow,
    asCommission((c) => lockRows(c, [b!])),
    asCommission(async (c) => {
      await lockRows(c, [a!]);
      return lockRows(c, [b!]);
    }),
  );
  assert.equal(raced.waited, false, "the refusal is immediate: the second call never queues behind the holder");
  assert.equal(raced.second.status, "rejected");
  assert.ok(kc("KC027")((raced.second as PromiseRejectedResult).reason));
});

test("S72: the FIRST lock call of a transaction waits for the holder and then proceeds", async () => {
  const { receivingLines: [b] } = await sellerWithIn(ow, "lockorder-s72", 0, [500]);
  const raced = await ordered(ow, asCommission((c) => lockRows(c, [b!])), asCommission((c) => lockRows(c, [b!])));
  assert.equal(raced.waited, true);
  assert.equal(raced.second.status, "fulfilled");
});

test("S75: a line the call names that does not exist is KC022 COMMISSION_LINE_NOT_FOUND", async () => {
  const { receivingLines: [b] } = await sellerWithIn(ow, "lockorder-s75", 0, [500]);
  await assert.rejects(within(ow.w.commission, corporate, (c) => lockRows(c, [b!, ids.next()])), kc("KC022"));
});

test("S77: the owner's lock-only path may update only created_at and the policy refuses every such write (the row lock is the whole effect): the no-op and another column are 42501, a changed value IMMUTABLE_COLUMN", async () => {
  const { receivingLines: [b] } = await sellerWithIn(ow, "lockorder-s77", 0, [500]);
  await assert.rejects(within(ow.w.app, ownerOf(ow.w), (c) => c.query("UPDATE kauro.commission_lines SET created_at = created_at WHERE line_id = $1", [b])), kc("42501"), "the row lock is taken, the WITH CHECK false policy refuses the write: nothing changes");
  await assert.rejects(within(ow.w.app, ownerOf(ow.w), (c) => c.query("UPDATE kauro.commission_lines SET created_at = now() WHERE line_id = $1", [b])), /IMMUTABLE_COLUMN/, "a changed value meets the immutability trigger first");
  await assert.rejects(within(ow.w.app, ownerOf(ow.w), (c) => c.query("UPDATE kauro.commission_lines SET state = 'VOID' WHERE line_id = $1", [b])), kc("42501"));
});

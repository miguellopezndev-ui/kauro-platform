// D4's retry until uncertain_after + d4Grace (plan docs/design/B12-outreach-plan.md A3, §5 residual): a received answer is never dropped while the
// database's window is open, including when the window read itself fails because the database is still unavailable. The units of work are a scripted
// stand-in (each call answers the next scripted outcome), so the cells exercise recordAnswer's own decisions, not the database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainFailure } from "@kauro/domain";
import type { OutreachRuntime } from "../src/outreach/dispatcher.js";
import { recordAnswer } from "../src/outreach/late-evidence.js";

type Step = { readonly answer: unknown } | { readonly fail: unknown };
const unavailable = (): DomainFailure => new DomainFailure("CAPACITY_UNAVAILABLE", "no database connection available", { retryAfterSeconds: 1 }, true);

/** A runtime whose units of work answer the scripted steps in order (record, window, record, ...), counting the calls. */
function scripted(steps: ReadonlyArray<Step>): { readonly rt: OutreachRuntime; calls(): number } {
  let n = 0;
  const units = {
    async run(): Promise<unknown> {
      const step = steps[n++];
      if (step === undefined) throw new Error(`unit of work ${n} was not scripted`);
      if ("fail" in step) throw step.fail;
      return step.answer;
    },
  };
  let id = 0;
  // the runtime clock (the injected Clock port) moves one second per read: the bound is judged on it, never on a process clock
  let ms = Date.parse("2026-12-10T15:00:00.000Z");
  const clock = { nowMs: () => (ms += 1_000), now: () => new Date(ms).toISOString() };
  const rt = { units, clock, ids: { next: () => `01990000-0000-7000-8000-${String(++id).padStart(12, "0")}` } } as unknown as OutreachRuntime;
  return { rt, calls: () => n };
}
const lease = { resourceId: "01990000-0000-7000-8000-00000000aaaa", ownerId: "01990000-0000-7000-8000-00000000bbbb", fence: 1 };
const accepted = { kind: "ACCEPTED", ref: "gmail-d4" } as const;

test("D4 retry: an answer whose unit and whose window read both fail while the database is unavailable is kept and recorded once the database answers inside the window", async () => {
  const s = scripted([{ fail: unavailable() }, { fail: unavailable() }, { fail: unavailable() }, { answer: 50_000 }, { answer: "PROVIDER_ACCEPTED" }]);
  assert.equal(await recordAnswer(s.rt, "01990000-0000-7000-8000-00000000cccc", lease, accepted, 1), "PROVIDER_ACCEPTED");
  assert.equal(s.calls(), 5, "record, window (failed), record, window (open), record");
});

test("D4 retry: a window the database reads closed ends the retries with the unit's own failure; a failure that is not a capacity one is never retried", async () => {
  const closed = scripted([{ fail: unavailable() }, { answer: null }]);
  await assert.rejects(recordAnswer(closed.rt, "01990000-0000-7000-8000-00000000dddd", lease, accepted, 1), (e: unknown) => e instanceof DomainFailure && e.code === "CAPACITY_UNAVAILABLE");
  assert.equal(closed.calls(), 2);
  const fenced = new DomainFailure("PRECONDITION_FAILED", "the outreach dispatcher no longer holds its lease", { reason: "LEASE_FENCED" });
  const other = scripted([{ fail: fenced }]);
  await assert.rejects(recordAnswer(other.rt, "01990000-0000-7000-8000-00000000eeee", lease, accepted, 1), (e: unknown) => e === fenced);
  assert.equal(other.calls(), 1, "no window read, no retry");
});

test("D4 retry: a database that stays unavailable for the whole window ends the retries once the widest window passed on the runtime clock, never earlier", async () => {
  const always = scripted(Array.from({ length: 1_000 }, () => ({ fail: unavailable() })));
  await assert.rejects(recordAnswer(always.rt, "01990000-0000-7000-8000-00000000ffff", lease, accepted, 1), (e: unknown) => e instanceof DomainFailure && e.code === "CAPACITY_UNAVAILABLE");
  // one second per clock read, one read per failed record: uncertainAfter (37 s) + d4Grace (60 s) of runtime time, two units of work each
  assert.equal(always.calls(), 2 * 98, "it kept the answer for the widest window the database might still have open");
});

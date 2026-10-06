// The harness-derived test statement timeout must outlive every harness observation window (cmd043 family, adversary ADV-2):
// if mustWait / observeBlocked / waitForLockWait ever allow longer, this fails instead of the margin shrinking silently.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("RACE_STATEMENT_TIMEOUT_MS outlives the harness observation windows by at least 2x", () => {
  const bounds = read("packages/persistence/src/testing/faults/bounds.ts");
  const attempts = Number(/LOCK_WAIT_POLL_ATTEMPTS = (\d+)/u.exec(bounds)?.[1]);
  const interval = Number(/LOCK_WAIT_POLL_INTERVAL_MS = (\d+)/u.exec(bounds)?.[1]);
  const factor = Number(/RACE_STATEMENT_TIMEOUT_MS = (\d+) \* LOCK_WAIT_OBSERVATION_MS/u.exec(bounds)?.[1]);
  assert.ok(attempts > 0 && interval > 0 && factor > 0, "bounds.ts constants not found");
  const race = factor * attempts * interval;
  // every harness observation helper's default window: mustWait (interleave.ts), observeBlocked (b10-cells-support.ts),
  // settlesOrWaits (harness.ts) — Codex cmd043-flake MINOR
  const sources = ["packages/persistence/src/testing/faults/interleave.ts", "apps/api/test/b10-cells-support.ts", "packages/persistence/src/testing/harness.ts"];
  const limits = sources.flatMap((f) => {
    const found = [...read(f).matchAll(/limitMs = ([\d_]+)/gu)].map((m) => Number(m[1].replace(/_/gu, "")));
    assert.ok(found.length > 0, `no limitMs default found in ${f}`);
    return found;
  });
  for (const limit of [...limits, attempts * interval]) assert.ok(race >= 2 * limit, `race timeout ${race} ms < 2 x observation window ${limit} ms`);
});

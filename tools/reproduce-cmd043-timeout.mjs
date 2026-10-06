// Run after building the backend, on a builder allowed to listen on TCP (PostgreSQL 17).
// Restores the old test timeout through the reproduction knob, then runs the same assertions with the fixed configuration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCK_WAIT_OBSERVATION_MS } from "../packages/persistence/dist/src/testing/faults/bounds.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const args = ["--test", "--test-reporter=spec", "apps/api/dist/test/cmd043-close-agency.test.js"];
const env = { ...process.env, PGBIN: process.env.PGBIN ?? "/usr/lib/postgresql/17/bin", KAURO_TEST_LOCK_RELEASE_DELAY_MS: String(LOCK_WAIT_OBSERVATION_MS + 1_000) };
delete env.KAURO_TEST_RACE_STATEMENT_TIMEOUT_MS;

function run(name, overrides) {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const log = join(tmpdir(), `cmd043-${name}.log`);
  writeFileSync(log, output);
  console.log(`${name}: exit=${result.status} log=${log}`);
  if (result.error) throw result.error;
  return { ...result, output };
}

const before = run("before", { KAURO_TEST_RACE_STATEMENT_TIMEOUT_MS: String(LOCK_WAIT_OBSERVATION_MS) });
assert.notEqual(before.status, 0, "the old timeout must cancel the observed agency waiter");
assert.match(before.output, /\+ '503 CAPACITY_UNAVAILABLE -'/);
assert.match(before.output, /- '409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED'/);
assert.match(before.output, /cause=DatabaseError code=57014/);
assert.match(before.output, /wait_event_type.*Lock.*blockers.*\d/s, "the delayed release follows a real lock observation");
assert.match(before.output, /"query":"SELECT .*FROM kauro\.agencies .*FOR UPDATE"/, "CMD043 waits at the agency row read");
assert.match(before.output, /"wait_event":"transactionid"/, "the row conflict waits on the holder's transaction");

const after = run("after", {});
assert.equal(after.status, 0, after.output);
assert.doesNotMatch(after.output, /cause=DatabaseError code=57014/);
console.log("Confirmed: old 10 s test configuration fails the original assertion; harness-derived configuration passes all CMD043 cases with the same delayed release.");

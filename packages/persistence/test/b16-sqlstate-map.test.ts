// Every KA0xx SQLSTATE a migration raises has a MAP entry in sqlstate.ts (package B16 follow-up: KA094 and KA085 were raised but unmapped,
// so a bypassing writer's refusal surfaced as an internal error). Pure unit test: it reads the migrations, not a database.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { failureOfSqlState } from "../src/index.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const raised = new Set<string>();
for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
  for (const m of readFileSync(join(dir, f), "utf8").matchAll(/ERRCODE\s*=\s*'(KA\d{3})'/g)) raised.add(m[1] as string);
}

test("KA094 (download authorization guard) maps to INTEGRITY_FAILURE, not retryable (DENY: unmapped -> null -> internal)", () => {
  const f = failureOfSqlState("KA094");
  assert.notEqual(f, null, "KA094 has a MAP entry");
  assert.equal(f?.code, "INTEGRITY_FAILURE");
  assert.equal(f?.retryable, false);
  assert.equal(failureOfSqlState("KA099"), null, "OK sibling: a code nobody raised stays unmapped");
});

test("every KA0xx a migration raises (KA080..KA094) is mapped", () => {
  assert.ok(raised.has("KA094") && raised.has("KA085") && raised.size >= 10, [...raised].join());
  const unmapped = [...raised].filter((c) => failureOfSqlState(c) === null);
  assert.deepEqual(unmapped, []);
});

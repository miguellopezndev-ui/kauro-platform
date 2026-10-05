import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { lintFixtures, lintSource } from "../fixture-clock-lint.mjs";

for (const source of [
  "const row = { issuedAt: clock.now() };",
  "const row = { providerCompletedAt: options.providerCompletedAt ?? clock.now() };",
  "const row = { completedAt: new Date(Date.now() - 1000).toISOString() };",
  "const row = { occurred_at: toUtcInstant(Date.now()) };",
  "row.issuedAt = clock.now();",
  'row["completedAt"] = clock.now();',
  'const row = { ["occurredAt"]: Date.now() };',
]) {
  test(`rejects ${source}`, () => {
    const failures = lintSource(source, "apps/api/test/support.ts");
    assert.equal(failures.length, 1);
    assert.match(failures[0], /apps\/api\/test\/support.ts:1: .*uses the process clock/);
  });
}

test("permits database defaults, explicit instants, unrelated clocks, comments and strings", () => {
  assert.deepEqual(lintSource(`
    const row = { issuedAt: options.issuedAt ?? toUtcInstant(Date.parse(await serverNow(client)) - 1000),
      completedAt: options.completedAt, occurredAt: "2026-01-01T00:00:00.000Z",
      createdAt: clock.now(), expiresAt: toUtcInstant(Date.now() + 1000) };
    // completedAt: clock.now()
    const text = "issuedAt: Date.now()";
    const clock = { now: () => toUtcInstant(Date.now()) };
  `), []);
});

test("scans nested app support and persistence testing files, leaving production and ordinary tests alone", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-fixture-clock-lint-"));
  try {
    for (const file of ["apps/api/test/nested/planner-support.ts", "packages/persistence/src/testing/fixtures/nested.ts", "apps/control/test/job-admission.test.ts", "apps/api/src/support.ts"]) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "const row = { completedAt: clock.now() };\n");
    }
    assert.equal(lintFixtures(root).length, 2);
    assert.match(lintFixtures(root)[0], /planner-support\.ts:1:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the repository's fixtures pass", () => assert.deepEqual(lintFixtures(), []));

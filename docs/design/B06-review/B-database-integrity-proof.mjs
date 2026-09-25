// Revert-and-run proof of the database-integrity fixes (docs/design/B06-review/B-database-integrity.md). For each spec of
// B-database-integrity-proof.json: replace each fixed SQL text of packages/persistence/migrations with its pre-fix text, run
// the regression tests that cover it (they must FAIL), restore the file, and re-run the first test when the spec asks (it
// must PASS). Migrations are read at run time, so no rebuild is needed between specs; build once with `pnpm run build`.
// Usage from the repository root: node docs/design/B06-review/B-database-integrity-proof.mjs [spec-id]
// Prints one JSON line per spec; exits 1 when a spec did not fail without its fix or did not pass once restored.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const migration = (file) => join(root, "packages/persistence/migrations", file);
const suites = {
  persist: { cwd: join(root, "packages/persistence"), file: "dist/test/integrity-guards.test.js" },
  migtest: { cwd: join(root, "packages/persistence"), file: "dist/test/migrations.test.js" },
  api: { cwd: join(root, "apps/api"), file: "dist/test/database-integrity.test.js" },
};

function run(test) {
  const suite = suites[test.suite];
  if (!suite) throw new Error(`unknown suite ${test.suite}`);
  const out = spawnSync(process.execPath, ["--test", "--test-reporter=spec", `--test-name-pattern=${test.pattern}`, suite.file], { cwd: suite.cwd, encoding: "utf8", timeout: 600_000 });
  const text = `${out.stdout}\n${out.stderr}`;
  const tests = /^ℹ tests (\d+)/m.exec(text)?.[1];
  if (tests !== "1") throw new Error(`pattern ${test.pattern} selected ${tests ?? "no"} tests in ${suite.file}`);
  const firstFailure = text.split(/\r?\n/).find((l) => /AssertionError|error: /.test(l)) ?? "";
  return { suite: test.suite, pattern: test.pattern, exit: out.status, firstFailure: firstFailure.trim().slice(0, 200) };
}

const specs = JSON.parse(readFileSync(join(here, "B-database-integrity-proof.json"), "utf8"));
const only = process.argv[2];
let ok = true;
for (const spec of specs) {
  if (only && spec.id !== only) continue;
  const originals = new Map();
  const result = { id: spec.id, what: spec.what };
  try {
    for (const r of spec.revert) {
      const path = migration(r.file);
      if (!originals.has(path)) originals.set(path, readFileSync(path, "utf8"));
      const text = readFileSync(path, "utf8");
      if (!text.includes(r.from)) throw new Error(`fixed text not found in ${r.file}: ${r.from.slice(0, 80)}`);
      writeFileSync(path, text.replace(r.from, r.to));
    }
    result.withoutFix = spec.tests.map(run);
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
  result.failedWithoutFix = result.withoutFix.every((r) => r.exit !== 0);
  if (spec.restoreCheck) {
    result.restored = run(spec.tests[0]);
    result.passedRestored = result.restored.exit === 0;
  }
  if (!result.failedWithoutFix || result.passedRestored === false) ok = false;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
process.exit(ok ? 0 : 1);

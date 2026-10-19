// B18 S088 (plan rev 3, ADV-17, ADV-31): "only owned disposable intermediates can be routinely cleaned". Every recursive delete in
// tools/** (literal rmSync/rm/rmdirSync/fs.promises.rm calls AND every call that reaches one through an alias: an import rename, an
// assignment, a destructuring or a parameter defaulting to rmSync) removes a directory the same file created, or sits on an exact
// allowlisted line. Negative controls plant a broad delete, plain and aliased, in a temp tree and assert it is refused.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { census } from "./fixtures/release/owned-census.mjs";

const repo = join(import.meta.dirname, "..", "..");

// Exact-text allowlist (file + line text). Anything else must be owned by the rules in owned-census.mjs.
const ALLOWLIST = [
  // red-proof removes the dist of its own disposable clone's packages before each build phase (the clone is `work`, mkdtemp'd at :40).
  { file: "red-proof.mjs", text: 'for (const pkg of buildOrder) rmSync(join(pkg.dir, "dist"), { recursive: true, force: true });' },
];

const LANE_FILES = ["test/owned-cleanup.test.mjs", "test/release-candidate.test.mjs", "test/pipe-exit.test.mjs"];

// Product src recursive deletes are asserted by name, not judged: b14/worker-host and persistence own them.
const PRODUCT_SRC = {
  "packages/data-plane/src/cores/migration-core-adapter.ts": 3,
  "packages/data-plane/src/evaluator/selection-evaluator.ts": 1,
  // B14-A: a job directory the host prepared itself, removed when another create took the identity first (and the directory it is
  // stamped in, when the stamp cannot be moved into view); the same for a cancellation's tombstone; and the browser's temporary
  // directory the host made for an attempt (browserTempDirectoryOf), removed once that attempt's tree has ended
  "packages/data-plane/src/host/local-process-host.ts": 4,
  "packages/data-plane/src/inspector/container-inspector.ts": 1,
  "packages/data-plane/src/preview/preview-reader.ts": 1,
  "packages/persistence/src/testing/temporary-postgres.ts": 1,
};

function violationsOf(result) {
  return result.sites.filter((s) => !s.owned && !ALLOWLIST.some((a) => a.file === s.file && a.text === s.text));
}

function plant(files) {
  const dir = mkdtempSync(join(tmpdir(), "kauro-owned-cleanup-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return census(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("S088: every recursive delete in tools/** removes a directory its own code created or an allowlisted line; a planted broad delete is refused", () => {
  const whole = census(join(repo, "tools"));
  assert.deepEqual(whole.unresolved, [], "an alias form the census cannot follow fails closed");
  // The 80 sites are the census of 99266f52; the files of this lane add owned deletes of their own, judged by the same rule below.
  const result = { ...whole, sites: whole.sites.filter((s) => !LANE_FILES.includes(s.file)) };
  const literal = result.sites.filter((s) => s.via === "literal");
  const aliased = result.sites.filter((s) => s.via === "alias-param");
  assert.equal(literal.length, 74, "literal recursive deletes");
  assert.equal(aliased.length, 6, "real-delete callers of withCleanup (default remover = rmSync)");
  assert.equal(result.sites.length, 80);
  assert.deepEqual(result.aliasBindings.map((b) => `${b.file}:${b.fn}`), ["test/gate-process.mjs:withCleanup"]);
  assert.equal(result.stubs.length, 7, "stub removers are not sinks");
  assert.ok(result.stubs.every((s) => s.file === "test/gate-process.test.mjs"));
  assert.deepEqual(violationsOf(whole).map((s) => `${s.file}:${s.line} ${s.text}`), []);
  assert.equal(ALLOWLIST.filter((a) => result.sites.some((s) => s.file === a.file && s.text === a.text)).length, ALLOWLIST.length, "no stale allowlist line");

  const planted = plant({ "test/x.mjs": 'import { rmSync } from "node:fs";\nrmSync(process.cwd(), { recursive: true });\n' });
  const refused = violationsOf(planted);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].file, "test/x.mjs");
  assert.equal(refused[0].path, "process.cwd()");

  // the control is selective: the same call on a directory the file made is accepted
  const control = plant({ "test/y.mjs": 'import { mkdtempSync, rmSync } from "node:fs";\nconst d = mkdtempSync("x");\nrmSync(d, { recursive: true });\n' });
  assert.equal(control.sites.length, 1);
  assert.deepEqual(violationsOf(control), []);

  // product src: asserted by name (file -> number of recursive deletes), not judged
  const found = {};
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(repo, group))) {
      let src;
      try { src = census(join(repo, group, name, "src")); } catch { continue; }
      for (const s of src.sites) found[`${group}/${name}/src/${s.file}`] = (found[`${group}/${name}/src/${s.file}`] ?? 0) + 1;
    }
  }
  assert.deepEqual(found, PRODUCT_SRC);
});

test("S088: a planted aliased recursive delete of the working directory is refused", () => {
  const cases = {
    "import rename": 'import { rmSync as zap } from "node:fs";\nzap(process.cwd(), { recursive: true });\n',
    "assignment": 'import { rmSync } from "node:fs";\nconst killer = rmSync;\nkiller(process.cwd(), { recursive: true, force: true });\n',
    "destructuring": 'import * as fs from "node:fs";\nconst { rmSync: gone } = fs;\ngone(process.cwd(), { recursive: true });\n',
    "namespace promises": 'import { promises as fsp } from "node:fs";\nawait fsp.rm(process.cwd(), { recursive: true });\n',
    "default parameter": 'import { rmSync } from "node:fs";\nexport function wipe(target, remove = rmSync) { remove(target, { recursive: true }); }\nwipe(process.cwd());\n',
    "default parameter, renamed import": 'import { rmSync as zap } from "node:fs";\nconst wipe = (target, remove = zap) => remove(target, { recursive: true });\nwipe(process.cwd());\n',
    "options in a variable": 'import { rmSync } from "node:fs";\nconst opts = { recursive: true };\nrmSync(process.cwd(), opts);\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    const refused = violationsOf(plant({ "test/z.mjs": text }));
    assert.ok(refused.length >= 1 && refused.every((s) => s.path === "process.cwd()"), `${name}: refused (${JSON.stringify(refused.map((s) => s.text))})`);
  }
  const dynamic = plant({ "test/w.mjs": 'const fs = await import("node:fs");\nfs.rmSync(process.cwd(), { recursive: true });\n' });
  assert.equal(dynamic.unresolved.length, 1, "a dynamic fs import fails closed");

  // the alias is judged by what it deletes: an owned argument and a stub remover are both accepted
  const owned = plant({ "test/v.mjs": 'import { mkdtempSync, rmSync } from "node:fs";\nexport function wipe(target, remove = rmSync) { remove(target, { recursive: true }); }\nconst d = mkdtempSync("x");\nwipe(d);\nwipe(process.cwd(), () => {});\n' });
  assert.equal(owned.sites.length, 1);
  assert.equal(owned.stubs.length, 1);
  assert.deepEqual(violationsOf(owned), []);
});

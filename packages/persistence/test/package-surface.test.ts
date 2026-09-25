// The published surface of @kauro/persistence (review findings R46, R47). The production entry point carries no test code:
// the temporary cluster (initdb/pg_ctl through spawnSync), the test role names, the harness and the interleaving helpers are
// the separate subpath @kauro/persistence/testing, which only tests import (architecture gate `test-only`). The manifest
// declares exactly the dependencies the package's files import and ships the pg type declarations its own public
// declarations name (tools/clean-consume.mjs type-checks the tarballs with skipLibCheck off).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as production from "../src/index.js";
import * as testing from "../src/testing/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

function* files(dir: string, extension: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* files(p, extension);
    else if (p.endsWith(extension)) yield p;
  }
}

const TEST_HELPERS = ["startTemporaryPostgres", "ROLES", "startHarness", "waitForLockWait", "settlesOrWaits", "backendPid", "barrier", "CAPABILITY_PUBLICATION_PATH"] as const;

test("R46: the production entry point exports no test helper; the test-only subpath @kauro/persistence/testing does", () => {
  for (const name of TEST_HELPERS) {
    assert.ok(!(name in production), `@kauro/persistence exports ${name}`);
    assert.ok(name in testing, `@kauro/persistence/testing lacks ${name}`);
  }
  assert.deepEqual(manifest.exports["."], { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" });
  assert.deepEqual(manifest.exports["./testing"], { types: "./dist/src/testing/index.d.ts", default: "./dist/src/testing/index.js" });
  // nothing on the production side reaches into the testing directory
  const src = join(packageRoot, "src");
  for (const file of files(src, ".ts")) {
    const rel = relative(src, file).split(sep).join("/");
    if (rel.startsWith("testing/")) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+"\.{1,2}\/(?:[^"]*\/)?testing\//, `${rel} imports the testing directory`);
  }
});

test("R47: every declared workspace dependency is imported, and the pg types the public declarations name are a pinned runtime dependency", () => {
  const sources = [...files(join(packageRoot, "src"), ".ts"), ...files(join(packageRoot, "test"), ".ts")].map((f) => readFileSync(f, "utf8"));
  for (const dep of Object.keys(manifest.dependencies).filter((d) => d.startsWith("@kauro/"))) {
    assert.ok(sources.some((text) => text.includes(`from "${dep}"`) || text.includes(`from "${dep}/`)), `${dep} is declared but never imported`);
  }
  // the declarations of the public surface import pg (Pool, PoolClient, Client): whoever compiles against them needs @types/pg
  const declarationsNamingPg = [...files(join(packageRoot, "src"), ".ts")].filter((f) => /from\s+"pg"/.test(readFileSync(f, "utf8")));
  assert.ok(declarationsNamingPg.length > 0);
  assert.match(manifest.dependencies["@types/pg"] ?? "", /^\d+\.\d+\.\d+$/, "@types/pg is a runtime dependency pinned exactly");
  assert.equal(manifest.devDependencies["@types/pg"], undefined, "@types/pg is not merely a devDependency");
});

// S046: UI imports a private core module or domain imports persistence -> the gate rejects the forbidden edge while the valid
// public port remains usable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gate = resolve(dirname(fileURLToPath(import.meta.url)), "..", "architecture-gate.mjs");

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "kauro-arch-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

function pkg(name, deps = {}) {
  return JSON.stringify({ name, version: "0.0.0", type: "module", dependencies: deps });
}

function run(root) {
  const r = spawnSync(process.execPath, [gate, root], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("a valid tree passes: application uses the contracts public port, api uses application", () => {
  const root = tree({
    "packages/contracts/package.json": pkg("@kauro/contracts"),
    "packages/contracts/src/index.ts": "export const x = 1;",
    "packages/application/package.json": pkg("@kauro/application", { "@kauro/contracts": "workspace:*" }),
    "packages/application/src/index.ts": 'import { x } from "@kauro/contracts";\nimport { structuredDigest } from "@kauro/contracts/digest";\nexport { x, structuredDigest };',
    "apps/api/package.json": pkg("@kauro/api", { "@kauro/application": "workspace:*" }),
    "apps/api/src/main.ts": 'import { x } from "@kauro/application";\nimport { readFileSync } from "node:fs";\nexport default x;',
  });
  try {
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no violation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forbidden edges are rejected with their rule, and the valid port in the same tree still passes on its own", () => {
  const root = tree({
    "packages/contracts/package.json": pkg("@kauro/contracts"),
    "packages/contracts/src/index.ts": "export const x = 1;",
    "packages/persistence/package.json": pkg("@kauro/persistence", { "@kauro/contracts": "workspace:*" }),
    "packages/persistence/src/index.ts": 'import { x } from "@kauro/contracts"; export const db = x;',
    "packages/domain/package.json": pkg("@kauro/domain", { "@kauro/contracts": "workspace:*", "@kauro/persistence": "workspace:*" }),
    "packages/domain/src/index.ts": 'import { db } from "@kauro/persistence";\nimport { x } from "@kauro/contracts";\nexport { db, x };',
    "packages/ui/package.json": pkg("@kauro/ui", { "@kauro/contracts": "workspace:*", "@kauro/intelligence-core": "workspace:*" }),
    "packages/ui/src/Widget.tsx": 'import { x } from "@kauro/contracts";\nimport { secret } from "@kauro/intelligence-core/src/private.js";\nimport { readFileSync } from "node:fs";\nexport const w = x + secret;',
    "packages/intelligence-core/package.json": pkg("@kauro/intelligence-core", { "@kauro/contracts": "workspace:*" }),
    "packages/intelligence-core/src/private.ts": "export const secret = 2;",
    "apps/web/package.json": pkg("@kauro/web", { "@kauro/contracts": "workspace:*", "pg": "8.0.0" }),
    "apps/web/src/page.tsx": 'import pg from "pg";\nconst url = process.env.DATABASE_URL;\nimport { x } from "../../../packages/contracts/src/index.js";\nexport { pg, url, x };',
  });
  try {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[layer\] domain package @kauro\/domain may not import adapter package @kauro\/persistence/);
    assert.match(r.out, /\[layer\] ui package @kauro\/ui may not import core package @kauro\/intelligence-core/);
    assert.match(r.out, /\[private\] private module import @kauro\/intelligence-core\/src\/private\.js/);
    assert.match(r.out, /\[deep-import\]/);
    assert.match(r.out, /\[client-bundle\] client bundle imports a Node built-in \(node:fs\)/);
    assert.match(r.out, /\[client-bundle\] server-only package pg imported from a client bundle/);
    assert.match(r.out, /\[credential\] credential-like identifier DATABASE_URL in a client bundle/);
    assert.match(r.out, /\[sibling\] relative import escapes the package/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a test-only subpath is importable from a test file only, never from production source; a declared workspace dependency nothing imports is refused", () => {
  const files = {
    "packages/contracts/package.json": pkg("@kauro/contracts"),
    "packages/contracts/src/index.ts": "export const x = 1;",
    "packages/persistence/package.json": pkg("@kauro/persistence", { "@kauro/contracts": "workspace:*" }),
    "packages/persistence/src/index.ts": 'import { x } from "@kauro/contracts"; export const db = x;',
    "packages/persistence/src/testing/index.ts": "export const startTemporaryPostgres = () => 1;",
    "apps/api/package.json": pkg("@kauro/api", { "@kauro/persistence": "workspace:*" }),
    "apps/api/src/main.ts": 'import { db } from "@kauro/persistence";\nexport default db;',
    "apps/api/test/support.ts": 'import { startTemporaryPostgres } from "@kauro/persistence/testing";\nexport const pg = startTemporaryPostgres;',
  };
  const clean = tree(files);
  try {
    const r = run(clean);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  const dirty = tree({
    ...files,
    "apps/api/src/main.ts": 'import { db } from "@kauro/persistence";\nimport { startTemporaryPostgres } from "@kauro/persistence/testing";\nexport default [db, startTemporaryPostgres];',
    "packages/persistence/package.json": pkg("@kauro/persistence", { "@kauro/contracts": "workspace:*", "@kauro/application": "workspace:*" }),
    "packages/application/package.json": pkg("@kauro/application", { "@kauro/contracts": "workspace:*" }),
    "packages/application/src/index.ts": 'import { x } from "@kauro/contracts"; export const a = x;',
  });
  try {
    const r = run(dirty);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /apps\/api\/src\/main\.ts:2: \[test-only\] production source imports the test-only subpath @kauro\/persistence\/testing/);
    assert.match(r.out, /packages\/persistence\/package\.json:1: \[unused\] @kauro\/application is declared in @kauro\/persistence\/package\.json dependencies but never imported/);
    assert.doesNotMatch(r.out, /apps\/api\/test\/support\.ts/, "a test file may import the test-only subpath");
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("undeclared dependencies and cycles are rejected", () => {
  const root = tree({
    "packages/contracts/package.json": pkg("@kauro/contracts"),
    "packages/contracts/src/index.ts": "export const x = 1;",
    "packages/domain/package.json": pkg("@kauro/domain", { "@kauro/contracts": "workspace:*" }),
    "packages/domain/src/index.ts": 'import { a } from "@kauro/application"; export const d = a;',
    "packages/application/package.json": pkg("@kauro/application", { "@kauro/domain": "workspace:*" }),
    "packages/application/src/index.ts": 'import { d } from "@kauro/domain"; export const a = d;',
  });
  try {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[declared\] @kauro\/application is imported but not declared/);
    assert.match(r.out, /\[layer\] domain package @kauro\/domain may not import application package/);
    assert.match(r.out, /\[cycle\] dependency cycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B11 D-SEC-2: the node-side files of a client-bundle package (tests, build scripts and configuration, browser-test harness) may use Node built-ins; its shipped source may not use one, declare a Server Action or a server data cache, or import next/og; a Next.js build output is not scanned", () => {
  const files = {
    "packages/ui/package.json": pkg("@kauro/ui"),
    "packages/ui/src/index.ts": "export const tokens = 1;",
    "packages/ui/test/tokens.test.ts": 'import { readFileSync } from "node:fs";\nimport { tokens } from "../src/index.js";\nexport { readFileSync, tokens };',
    "apps/web/package.json": pkg("@kauro/web", { "@kauro/ui": "workspace:*", next: "16.3.6" }),
    "apps/web/src/app/page.tsx": 'import { tokens } from "@kauro/ui";\nimport "@kauro/ui/tokens.css";\nexport default function Page() { return tokens; }',
    "apps/web/test/headers.test.ts": 'import { test } from "node:test";\nexport { test };',
    "apps/web/e2e/support/serve.mjs": 'import https from "node:https";\nexport { https };',
    "apps/web/scripts/next.mjs": 'import { spawn } from "node:child_process";\nexport { spawn };',
    "apps/web/next.config.ts": 'import { join } from "node:path";\nexport default { root: join(".", "..") };',
    "apps/web/playwright.config.ts": 'import { join } from "node:path";\nexport default join("e2e");',
    "apps/web/.next/server/app/page.js": 'import { readFileSync } from "node:fs";\n"use server";\nexport { readFileSync };',
  };
  const clean = tree(files);
  try {
    const r = run(clean);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  const dirty = tree({
    ...files,
    "apps/web/src/app/actions.ts": '"use server";\nimport { createHash } from "node:crypto";\nexport async function save() { return createHash("sha256"); }',
    "apps/web/src/app/inline.tsx": 'export async function act() {\n  "use server";\n  return 1;\n}\nexport async function cached() {\n  \'use cache\'\n  return 2;\n}',
    "apps/web/src/app/og/route.tsx": 'import { ImageResponse } from "next/og";\nexport const GET = () => new ImageResponse(null);',
  });
  try {
    const r = run(dirty);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /apps\/web\/src\/app\/actions\.ts:1: \[client-bundle\] a client bundle declares "use server"/);
    assert.match(r.out, /apps\/web\/src\/app\/actions\.ts:2: \[client-bundle\] client bundle imports a Node built-in \(node:crypto\)/);
    assert.match(r.out, /apps\/web\/src\/app\/inline\.tsx:2: \[client-bundle\] a client bundle declares "use server"/);
    assert.match(r.out, /apps\/web\/src\/app\/inline\.tsx:6: \[client-bundle\] a client bundle declares "use cache"/);
    assert.match(r.out, /apps\/web\/src\/app\/og\/route\.tsx:1: \[client-bundle\] a client bundle imports the forbidden module next\/og/);
    assert.doesNotMatch(r.out, /apps\/web\/(test|e2e|scripts)\/|next\.config\.ts|playwright\.config\.ts|packages\/ui\/test\/|\.next\//, "node-side files and build outputs are not client bundles");
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("B11 D-SEC-2: a file that reads the environment lives in apps/web/src/server/config/ and starts with import server-only; a comment about the environment reads nothing, and node-side files may read it", () => {
  const files = {
    "packages/contracts/package.json": pkg("@kauro/contracts"),
    "packages/contracts/src/index.ts": "export const x = 1;",
    "apps/web/package.json": pkg("@kauro/web", { "@kauro/contracts": "workspace:*" }),
    "apps/web/src/index.ts": 'import { x } from "@kauro/contracts";\nexport { x };',
    "apps/web/src/server/config/hosts.ts": '// the one reader of the host values (process.env is named here in a comment only)\n/* import.meta.env too */\nimport "server-only";\nexport const host = process.env["KAURO_PUBLIC_ORIGIN"];',
    "apps/web/src/server/config/quiet.ts": '\n\nimport "server-only";\nexport const quiet = 1;',
    "apps/web/src/server/pure.ts": '// takes its values as arguments: process.env is never read here\nexport const parse = (value: string | undefined) => value ?? "";',
    "apps/web/test/env.test.ts": 'export const level = process.env.NODE_ENV;',
    "apps/web/e2e/support/serve.mjs": "export const port = process.env.KAURO_E2E_PORT;",
    "apps/web/scripts/next.mjs": "export const env = { ...process.env };",
    "apps/web/next.config.ts": 'export default { level: process.env["NODE_ENV"] };',
  };
  const clean = tree(files);
  try {
    const r = run(clean);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  const dirty = tree({
    ...files,
    "apps/web/src/server/pure.ts": '// takes its values as arguments\nexport const parse = () => process.env.KAURO_ENV;',
    "apps/web/src/app/page.tsx": 'export default function Page() {\n  return process?.env?.KAURO_ENV ?? "";\n}',
    "apps/web/src/app/meta.ts": "export const mode = import.meta.env.MODE;",
    "apps/web/src/app/bracket.ts": 'export const level = process["env"];',
    "apps/web/src/app/destructured.ts": "const { env } = process;\nexport { env };",
    "apps/web/src/server/config/late.ts": 'export const before = 1;\nimport "server-only";\nexport const level = process.env["KAURO_ENV"];',
    "apps/web/src/server/config/plain.ts": 'import { x } from "@kauro/contracts";\nexport const level = process.env["KAURO_ENV"] ?? x;',
    "apps/web/src/server/config/empty.ts": "// nothing here\n",
    "apps/web/src/server/config/wrong.ts": 'import "server-only-extra";\nexport const level = process.env["KAURO_ENV"];',
  });
  try {
    const r = run(dirty);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /apps\/web\/src\/server\/pure\.ts:2: \[server-config\] a client bundle reads the environment outside apps\/web\/src\/server\/config\//);
    assert.match(r.out, /apps\/web\/src\/app\/page\.tsx:2: \[server-config\] a client bundle reads the environment outside/);
    assert.match(r.out, /apps\/web\/src\/app\/meta\.ts:1: \[server-config\] a client bundle reads the environment outside/);
    assert.match(r.out, /apps\/web\/src\/app\/bracket\.ts:1: \[server-config\] a client bundle reads the environment outside/);
    assert.match(r.out, /apps\/web\/src\/app\/destructured\.ts:1: \[server-config\] a client bundle reads the environment outside/);
    assert.match(r.out, /apps\/web\/src\/server\/config\/late\.ts:1: \[server-config\] a server configuration module must start with import "server-only"/);
    assert.match(r.out, /apps\/web\/src\/server\/config\/plain\.ts:1: \[server-config\] a server configuration module must start with import "server-only"/);
    assert.match(r.out, /apps\/web\/src\/server\/config\/empty\.ts:1: \[server-config\] a server configuration module must start with import "server-only"/);
    assert.match(r.out, /apps\/web\/src\/server\/config\/wrong\.ts:1: \[server-config\] a server configuration module must start with import "server-only"/);
    assert.doesNotMatch(r.out, /config\/hosts\.ts|config\/quiet\.ts|apps\/web\/(test|e2e|scripts)\/|next\.config\.ts/, "a compliant config module and the node-side files are not reported");
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("B11 D-SEC-2: a test or node-side file may import a workspace devDependency, shipped source may not", () => {
  const manifest = JSON.stringify({ name: "@kauro/web", version: "0.0.0", type: "module", dependencies: {}, devDependencies: { "@kauro/contracts": "workspace:*" } });
  const files = {
    "packages/contracts/package.json": pkg("@kauro/contracts"),
    "packages/contracts/src/index.ts": "export const x = 1;",
    "apps/web/package.json": manifest,
    "apps/web/src/index.ts": "export const y = 2;",
    "apps/web/test/contracts.test.ts": 'import { x } from "@kauro/contracts";\nexport { x };',
  };
  const clean = tree(files);
  try {
    const r = run(clean);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  const dirty = tree({ ...files, "apps/web/src/index.ts": 'import { x } from "@kauro/contracts";\nexport const y = x;' });
  try {
    const r = run(dirty);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /apps\/web\/src\/index\.ts:1: \[declared\] @kauro\/contracts is imported but not declared/);
    assert.doesNotMatch(r.out, /contracts\.test\.ts/);
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
});

// B05 D5-1/D5-6 (S046): the raw cores are importable only by their wrapper, at the root; the wrappers are server code.
const MC_WRAPPER = {
  "packages/migration-core/package.json": pkg("@kauro/migration-core", { "kauro-migration-core": "3.0.0" }),
  "packages/migration-core/src/index.ts": 'export * from "kauro-migration-core";',
};
const IC_WRAPPER = {
  "packages/intelligence-core/package.json": pkg("@kauro/intelligence-core", { "kauro-intelligence-core": "0.6.0", "kauro-migration-core": "3.0.0" }),
  "packages/intelligence-core/src/index.ts": 'export * from "kauro-intelligence-core";',
};
const CONTRACTS = { "packages/contracts/package.json": pkg("@kauro/contracts"), "packages/contracts/src/index.ts": "export const x = 1;" };
const ADAPTER = (body, deps = { "@kauro/migration-core": "workspace:*", "@kauro/intelligence-core": "workspace:*" }) => ({
  "packages/data-plane/package.json": pkg("@kauro/data-plane", deps),
  "packages/data-plane/src/cores/index.ts": body,
});
const WRAPPED = 'import { runMigration } from "@kauro/migration-core";\nimport { interpret } from "@kauro/intelligence-core";\nexport const a = [runMigration, interpret];';

function gated(files) {
  const root = tree(files);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("A01 S046 DENY: a deep import into a raw core or a wrapper, or a raw core imported outside its wrapper, is rejected while the wrapper root import passes", () => {
  const ok = gated({ ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, ...ADAPTER(WRAPPED) });
  assert.equal(ok.code, 0, ok.out);
  const deepRaw = gated({ ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, ...ADAPTER(WRAPPED), "packages/migration-core/src/internal.ts": 'import { x } from "kauro-migration-core/dist/src/ingest/csv.js";\nexport const y = x;' });
  assert.equal(deepRaw.code, 1, deepRaw.out);
  assert.match(deepRaw.out, /packages\/migration-core\/src\/internal\.ts:1: \[raw-core\] deep import into the raw core kauro-migration-core\/dist\/src\/ingest\/csv\.js/);
  const deepWrapper = gated({ ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, ...ADAPTER('import { y } from "@kauro/migration-core/dist/src/index.js";\nimport { z } from "@kauro/intelligence-core/src/index.js";\nexport const a = [y, z];') });
  assert.equal(deepWrapper.code, 1, deepWrapper.out);
  assert.match(deepWrapper.out, /\[deep-import\] deep import into @kauro\/migration-core\/dist\/src\/index\.js/);
  assert.match(deepWrapper.out, /\[private\] private module import @kauro\/intelligence-core\/src\/index\.js/);
  const outside = gated({ ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, ...ADAPTER('import { runMigration } from "kauro-migration-core";\nexport const a = runMigration;', { "kauro-migration-core": "3.0.0" }) });
  assert.equal(outside.code, 1, outside.out);
  assert.match(outside.out, /packages\/data-plane\/src\/cores\/index\.ts:1: \[raw-core\] kauro-migration-core is imported outside its wrapper @kauro\/migration-core/);
  const crossWrapper = gated({ ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, "packages/intelligence-core/src/other.ts": 'import { runMigration } from "kauro-migration-core";\nexport const q = runMigration;' });
  assert.equal(crossWrapper.code, 1, crossWrapper.out);
  assert.match(crossWrapper.out, /packages\/intelligence-core\/src\/other\.ts:1: \[raw-core\] kauro-migration-core is imported outside its wrapper @kauro\/migration-core/);
});

test("A02 S046 DENY: ui or web importing a wrapper or raw core is rejected as server-only, and domain importing persistence still fails in the same tree", () => {
  const r = gated({
    ...CONTRACTS,
    ...MC_WRAPPER,
    ...IC_WRAPPER,
    "packages/persistence/package.json": pkg("@kauro/persistence", { "@kauro/contracts": "workspace:*" }),
    "packages/persistence/src/index.ts": 'import { x } from "@kauro/contracts"; export const db = x;',
    "packages/domain/package.json": pkg("@kauro/domain", { "@kauro/contracts": "workspace:*", "@kauro/persistence": "workspace:*" }),
    "packages/domain/src/index.ts": 'import { db } from "@kauro/persistence"; export const d = db;',
    "packages/ui/package.json": pkg("@kauro/ui", { "@kauro/migration-core": "workspace:*" }),
    "packages/ui/src/Widget.tsx": 'import { runMigration } from "@kauro/migration-core";\nexport const w = runMigration;',
    "apps/web/package.json": pkg("@kauro/web", { "@kauro/contracts": "workspace:*", "kauro-intelligence-core": "0.6.0", "@kauro/intelligence-core": "workspace:*" }),
    "apps/web/src/page.tsx": 'import { interpret } from "kauro-intelligence-core";\nimport { x } from "@kauro/contracts";\nimport { interpret as i2 } from "@kauro/intelligence-core";\nexport const p = [interpret, i2, x];',
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /packages\/ui\/src\/Widget\.tsx:1: \[client-bundle\] server-only package @kauro\/migration-core imported from a client bundle/);
  assert.match(r.out, /apps\/web\/src\/page\.tsx:1: \[client-bundle\] server-only package kauro-intelligence-core imported from a client bundle/);
  assert.match(r.out, /apps\/web\/src\/page\.tsx:3: \[client-bundle\] server-only package @kauro\/intelligence-core imported from a client bundle/);
  assert.match(r.out, /\[layer\] domain package @kauro\/domain may not import adapter package @kauro\/persistence/);
  assert.match(r.out, /\[layer\] ui package @kauro\/ui may not import core package @kauro\/migration-core/);
});

test("A03 S046 DENY: production source importing kauro-intelligence-core/benchmark is rejected", () => {
  const files = { ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, ...ADAPTER(WRAPPED) };
  const bad = gated({ ...files, "packages/intelligence-core/src/bench.ts": 'import { surface } from "kauro-intelligence-core/benchmark";\nexport const b = surface;' });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /packages\/intelligence-core\/src\/bench\.ts:1: \[raw-core\] production source imports kauro-intelligence-core\/benchmark/);
  const viaWrapper = gated({ ...files, "packages/data-plane/src/cores/bench.ts": 'import { surface } from "@kauro/intelligence-core/benchmark";\nexport const b = surface;' });
  assert.equal(viaWrapper.code, 1, viaWrapper.out);
  assert.match(viaWrapper.out, /packages\/data-plane\/src\/cores\/bench\.ts:1: \[deep-import\] deep import into @kauro\/intelligence-core\/benchmark/);
});

test("A04 S046 OK: the checked-in tree with both wrappers passes, and the same cores-adapter tree with one injected deep core import fails", () => {
  const real = spawnSync(process.execPath, [gate], { encoding: "utf8" });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /no violation/);
  const files = { ...CONTRACTS, ...MC_WRAPPER, ...IC_WRAPPER, ...ADAPTER(WRAPPED) };
  const clean = gated(files);
  assert.equal(clean.code, 0, clean.out);
  const injected = gated({ ...files, "packages/migration-core/src/index.ts": 'export * from "kauro-migration-core";\nexport { y } from "kauro-migration-core/dist/src/y.js";' });
  assert.equal(injected.code, 1, injected.out);
  assert.match(injected.out, /\[raw-core\] deep import into the raw core/);
});

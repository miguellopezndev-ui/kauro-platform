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

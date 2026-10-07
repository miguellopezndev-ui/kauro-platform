// I-2 / I-3: no composition root can open a PostgreSQL connection outside LOCAL without verified TLS. The structural scan lists
// every site that builds a pool or a client in apps/ and packages/*/src; each non-persistence site must call connectionSecurityOf
// (the one rule), and the persistence sites must derive ssl only from sslOptionsOf (rejectUnauthorized: true).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConnectionSecurityError } from "@kauro/persistence";
import { openCommissionPools, openPaymentPools } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (EXTENSIONS.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** The ways a file opens (or can open) a PostgreSQL connection: a constructor, an aliased or namespace import of pg's classes, createPool, applyMigrationsAs, a connection string. */
const SITE_FORMS: ReadonlyArray<RegExp> = [
  /\bnew\s+(?:[\w$]+\s*\.\s*)*(?:Pool|Client)\s*\(/,
  /\bimport\s+(?!type\b)\{[^}]*(?<!type\s)\b(?:Pool|Client)\b[^}]*\}\s*from\s*["']pg["']/,
  /\bimport\s+(?!type\b)(?:\*\s+as\s+[\w$]+|[\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']pg["']/,
  /\brequire\(\s*["']pg["']\s*\)/,
  /\bimport\(\s*["']pg["']\s*\)/,
  /\bcreatePool\b/,
  /\bapplyMigrationsAs\b/,
  /\bconnectionString\b/,
];

/** TLS settings are written in tls.ts and nowhere else: `ssl:` only as `ssl: sslOptionsOf(`, no identity-check override. */
const TLS_FORMS: ReadonlyArray<RegExp> = [/\bssl\s*:(?!\s*sslOptionsOf\()/, /\bcheckServerIdentity\b/, /\brejectUnauthorized\b/, /NODE_TLS_REJECT_UNAUTHORIZED/];

function isSite(text: string): boolean {
  const c = code(text);
  return SITE_FORMS.some((f) => f.test(c));
}

function tlsViolations(text: string): string[] {
  const c = code(text);
  return TLS_FORMS.filter((f) => f.test(c)).map(String);
}

test("scan self-test: each connection form is caught, in .ts, .js and .mjs files", () => {
  const forms: Record<string, string> = {
    "new pg.Pool(": 'import pg from "pg";\nexport const p = new pg.Pool({});',
    "namespace import": 'import * as db from "pg";\nexport const c = new db.Client({});',
    "aliased Pool": 'import { Pool as P } from "pg";\nexport const p = new P({});',
    "aliased Client with a type": 'import { type PoolClient, Client as C } from "pg";\nexport const c = new C();',
    "require": 'const { Pool } = require("pg");',
    "dynamic import": 'const m = await import("pg");',
    "createPool alias": 'import { createPool as mk } from "@kauro/persistence";',
    "applyMigrationsAs alias": 'import { applyMigrationsAs as run } from "@kauro/persistence";',
    "connectionString": 'export const x = { connectionString: process.env.DATABASE_URL };',
  };
  for (const [name, text] of Object.entries(forms)) assert.ok(isSite(text), `not caught: ${name}`);
  for (const text of ['import type { PoolClient } from "pg";', 'import { type Client } from "pg";', "// new Pool(\nexport const a = 1;"]) assert.ok(!isSite(text), text);
  const dir = mkdtempSync(join(tmpdir(), "kauro-scan-"));
  try {
    for (const name of ["a.ts", "b.js", "c.mjs", "d.cjs"]) writeFileSync(join(dir, name), forms["new pg.Pool("] ?? "");
    assert.deepEqual(sources(dir).map((f) => relative(dir, f)).sort(), ["a.ts", "b.js", "c.mjs", "d.cjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan self-test: a TLS setting outside tls.ts is caught in every form", () => {
  const bad = ["const o = { ssl: { rejectUnauthorized: false } };", "const o = { ssl: true };", "const o = { ssl: { ca, checkServerIdentity: () => undefined } };", "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", "const o = { rejectUnauthorized: true };"];
  for (const text of bad) assert.ok(tlsViolations(text).length > 0, text);
  assert.deepEqual(tlsViolations("const o = { ...(tls === undefined ? {} : { ssl: sslOptionsOf(tls) }) };"), []);
});

test("every connection site of apps/ and packages/*/src is known, and each composition root applies connectionSecurityOf", () => {
  const dirs = [join(root, "apps"), ...readdirSync(join(root, "packages")).map((p) => join(root, "packages", p, "src"))];
  const files = dirs.flatMap((d) => {
    try {
      return sources(d);
    } catch {
      return [];
    }
  });
  const found = new Map<string, string>();
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel.startsWith("packages/persistence/src/testing/")) continue; // the test-only subpath (the architecture gate keeps it out of production)
    const text = readFileSync(file, "utf8");
    if (isSite(text)) found.set(rel, text);
    if (rel !== "packages/persistence/src/tls.ts") assert.deepEqual(tlsViolations(text), [], `${rel}: TLS settings belong in tls.ts`);
  }
  assert.deepEqual(
    [...found.keys()].sort(),
    [
      "apps/api/src/commissions/assembly.ts",
      "apps/api/src/composition.ts",
      "apps/api/src/payments/assembly.ts",
      "apps/control/src/audit/receipts.ts",
      "apps/control/src/composition.ts",
      "packages/persistence/src/index.ts",
      "packages/persistence/src/migrations/runner.ts",
      "packages/persistence/src/pool.ts",
    ],
    "a new connection site must be listed here and covered by connectionSecurityOf",
  );
  for (const [rel, text] of found) {
    if (rel === "packages/persistence/src/index.ts") continue; // re-exports only
    if (rel.startsWith("packages/persistence/src/")) {
      assert.ok(text.includes("sslOptionsOf("), `${rel} derives ssl from sslOptionsOf`);
    } else {
      assert.ok(text.includes("connectionSecurityOf("), `${rel} applies connectionSecurityOf before it connects`);
    }
  }
});

const login = { host: "db.example.test", port: 1, database: "kauro", user: "u", poolMax: 1 };
const secure = { ...login, tlsCaFile: "ca.pem" };
const deps = (environment: "SANDBOX" | "LIVE") => ({ clock: { now: () => 0 } as never, random: (() => new Uint8Array(1)) as never, environment });
const refused = (variable: string) => (e: unknown) => e instanceof ConnectionSecurityError && e.message.startsWith(`${variable}:`);

test("the commission and payment roots refuse SANDBOX and LIVE without a CA, with a plain password or with an IP host", async () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    const ok = { commission: login, control: login };
    await assert.rejects(openCommissionPools(ok, deps(environment)), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openCommissionPools({ commission: { ...secure, password: "x" }, control: secure }, deps(environment)), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openCommissionPools({ commission: { ...secure, host: "10.0.0.1" }, control: secure }, deps(environment)), refused("KAURO_DB_HOST"));
    const pay = { payment: login, control: login, ingress: login };
    await assert.rejects(openPaymentPools({} as never, pay, deps(environment)), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openPaymentPools({} as never, { payment: { ...secure, password: "x" }, control: secure, ingress: secure }, deps(environment)), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openPaymentPools({} as never, { payment: { ...secure, host: "10.0.0.1" }, control: secure, ingress: secure }, deps(environment)), refused("KAURO_DB_HOST"));
  }
});

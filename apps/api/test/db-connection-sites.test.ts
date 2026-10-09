// I-2 / I-3: no composition root can open a PostgreSQL connection outside LOCAL without verified TLS. The structural scan lists
// every site that builds a pool or a client in apps/ and packages/*/src; each non-persistence site must call connectionSecurityOf
// (the one rule), and the persistence sites must derive ssl only from sslOptionsOf (rejectUnauthorized: true).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ConnectionSecurityError } from "@kauro/persistence";
import { openCommissionPools, openPaymentPools } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Only TRACKED source is scanned (git ls-files): build output (.next, dist, coverage, ...) is untracked, so it is excluded because it
 * is not shipped source, while a tracked directory that happens to be named build/, out/ or vendor/ (a Next route folder, say) is
 * scanned. Only a package's own test/ directory at its root is skipped.
 */
function trackedSources(repo: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "apps", "packages"], { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split("\0")
    .filter((f) => f !== "" && EXTENSIONS.some((e) => f.endsWith(e)) && !/\.d\.[cm]?ts$/.test(f) && !/^(?:apps|packages)\/[^/]+\/test\//.test(f))
    .sort();
}

/** A throw-away repository: `tracked` files are added to the index, `untracked` ones are only written. */
function tempRepo(tracked: Record<string, string>, untracked: Record<string, string> = {}): { dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "kauro-scan-repo-"));
  const write = (files: Record<string, string>): void => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  };
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true }).status, 0);
  write(tracked);
  assert.equal(spawnSync("git", ["add", "-A"], { cwd: dir, windowsHide: true }).status, 0);
  write(untracked);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * ADV-10 (1896dea): comments removed by the TypeScript parser and printer, which know strings, templates and regular
 * expressions ("a//b" is not a comment); a bare scanner loses its place at template tails and regex literals.
 */
const printer = ts.createPrinter({ removeComments: true });
/** The parse mode follows the file name: parsed as plain TS, `<A>{new Pool(c)}</A>` in a .tsx file prints as `{ new: Pool(c) }`. */
function scriptKindOf(rel: string): ts.ScriptKind {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
function withoutComments(text: string, rel: string): string {
  return printer.printFile(ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindOf(rel)));
}

function code(text: string, rel = "scan.ts"): string {
  return withoutComments(text, rel)
    // ADV-8 (56673d9): one spelling per form before matching: `import (`/`require (` -> `import(`, a template literal without
    // substitutions -> a quoted string, so the patterns need not enumerate spacing and quoting variants
    .replace(/\b(import|require)\s+\(/g, "$1(")
    .replace(/`([^`$\\]*)`/g, '"$1"');
}

/** The ways a file opens (or can open) a PostgreSQL connection: a constructor, an aliased or namespace import of pg's classes, createPool, applyMigrationsAs, a connection string. */
const SITE_FORMS: ReadonlyArray<RegExp> = [
  /\bnew\s+(?:[\w$]+\s*\.\s*)*(?:Pool|Client|KauroPool)\s*\(/,
  // DB-TLS-R2: persistence's exported KauroPool opens connections too: its constructor, a value import or re-export of it (aliased or not)
  /\b(?:import|export)\s+(?!type\b)\{[^}]*(?<!type\s)\bKauroPool\b[^}]*\}\s*from\b/,
  // ADV-1 (e692ba2): KauroPool taken by destructuring (a dynamic import, a require, a namespace object), as a namespace member, or persistence loaded at run time
  /(?<!:[ \t]*)\{[^{}\n]*\bKauroPool\b[^{}\n]*\}[ \t]*=(?!=)/,
  /[\w$)\]]\s*\.\s*KauroPool\b/,
  /(?:\brequire\(\s*|\bimport\(\s*)["']@kauro\/persistence["']/,
  // ADV-5 (1b9e8fa): every value path to KauroPool starts at an import; a namespace import or star re-export of persistence is a site
  // whatever is done with the namespace afterwards (multi-line or nested destructuring, defaults, computed members)
  /\b(?:import|export)\s+(?!type\b)\*(?:\s+as\s+[\w$]+)?\s+from\s*["']@kauro\/persistence["']/,
  /\bimport\s+(?!type\b)\{[^}]*(?<!type\s)\b(?:Pool|Client)\b[^}]*\}\s*from\s*["']pg["']/,
  /\bimport\s+(?!type\b)(?:\*\s+as\s+[\w$]+|[\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']pg["']/,
  /\brequire\(\s*["']pg["']\s*\)/,
  /\bimport\(\s*["']pg["']\s*\)/,
  /\bcreatePool\b/,
  /\bapplyMigrationsAs\b/,
  /\bconnectionString\b/,
  // a re-export of the driver's classes, a CommonJS require made inside an ES module, any other PostgreSQL driver or data layer
  /\bexport\s+(?!type\b)(?:\{[^}]*(?<!type\s)\b(?:Pool|Client)\b[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*["']pg["']/,
  /\bcreateRequire\b/,
  /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["'](?:postgres|pg-promise|pg-native|pg-pool|pg-cursor|@neondatabase\/[\w-]+|@vercel\/postgres|@databases\/pg[\w-]*|slonik|knex|kysely|typeorm|sequelize|drizzle-orm[\w/-]*|@prisma\/client|@supabase\/[\w-]+)["']/,
];

/** The constructors only: a persistence file that holds one must derive ssl from sslOptionsOf; one without is a re-export. */
const CONSTRUCTS = /\bnew\s+(?:[\w$]+\s*\.\s*)*(?:Pool|Client)\s*\(/;

/** ADV-3 (a88da2e): KauroPool is constructed in pool.ts (createPool) only; a persistence wrapper elsewhere would hand apps a pool whose callers are not sites. */
const CONSTRUCTS_KAURO_POOL = /\bnew\s+(?:[\w$]+\s*\.\s*)*KauroPool\s*\(/;

/**
 * DB-TLS-R3 (fdf3360): inside persistence every value path to KauroPool starts at an import of the pool module, so only pool.ts
 * (defines it) and index.ts (the package's re-export) may take it as a value; elsewhere it is a type only, which closes aliases,
 * parenthesized constructors, destructuring and computed members at their source.
 */
const POOL_VALUE_IMPORTS: ReadonlyArray<RegExp> = [
  // ADV-7 (56673d9): createPool too, so a persistence wrapper cannot hand apps a pool through a file they import without being a site
  /\b(?:import|export)\s+(?!type\b)\{[^}]*(?<!type\s)\b(?:KauroPool|createPool)\b[^}]*\}\s*from\b/,
  /\b(?:import|export)\s+(?!type\b)\*(?:\s+as\s+[\w$]+)?\s+from\s*["'][^"']*\/pool(?:\.js)?["']/,
  /(?:\brequire\(\s*|\bimport\(\s*)["'][^"']*\/pool(?:\.js)?["']/,
];
const POOL_VALUE_HOLDERS = new Set(["packages/persistence/src/pool.ts", "packages/persistence/src/index.ts"]);

function persistenceProblem(rel: string, text: string): string | undefined {
  const c = code(text, rel);
  if (CONSTRUCTS.test(c) && !text.includes("sslOptionsOf(")) return `${rel} derives ssl from sslOptionsOf`;
  if (CONSTRUCTS_KAURO_POOL.test(c) && rel !== "packages/persistence/src/pool.ts") return `${rel} constructs KauroPool outside pool.ts`;
  // ADV-9 (1896dea): createPool is not even mentioned elsewhere, so no import route (index namespace, run-time import) can wrap it
  if (!POOL_VALUE_HOLDERS.has(rel) && (POOL_VALUE_IMPORTS.some((f) => f.test(c)) || /\bcreatePool\b/.test(c))) return `${rel} takes KauroPool or createPool as a value outside pool.ts and index.ts`;
  return undefined;
}

/** TLS settings are written in tls.ts and nowhere else: `ssl:` only as `ssl: sslOptionsOf(`, no identity-check override. */
const TLS_FORMS: ReadonlyArray<RegExp> = [
  /\bssl\s*:(?!\s*sslOptionsOf\()/,
  /["']ssl["']\s*:/,
  /\.\s*ssl\s*=(?!=)/,
  /\[\s*["']ssl["']\s*\]\s*=(?!=)/,
  /[{,]\s*ssl\s*[,}]/,
  /\bcheckServerIdentity\b/,
  /\brejectUnauthorized\b/,
  /NODE_TLS_REJECT_UNAUTHORIZED/,
  /\bPG(?:SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY|PASSWORD|PASSFILE|SERVICE)\b/,
];

function isSite(text: string, rel?: string): boolean {
  const c = code(text, rel);
  return SITE_FORMS.some((f) => f.test(c));
}

function tlsViolations(text: string, rel?: string): string[] {
  const c = code(text, rel);
  return TLS_FORMS.filter((f) => f.test(c)).map(String);
}

test("scan self-test: each connection form is caught, in .ts, .js and .mjs files; .mts, .cts and .jsx are listed", () => {
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
    "export { Pool } from pg": 'export { Pool } from "pg";',
    "export { Client as X } from pg": 'export { Client as Db } from "pg";',
    "export * from pg": 'export * from "pg";',
    "createRequire": 'import { createRequire } from "node:module";\nconst pg = createRequire(import.meta.url)("pg");',
    "postgres driver": 'import postgres from "postgres";',
    "pg-promise": 'const pgp = require("pg-promise")();',
    "neon driver": 'import { Pool } from "@neondatabase/serverless";',
    "knex": 'import knex from "knex";',
    "new KauroPool(": 'import { KauroPool } from "@kauro/persistence";\nconst p = new KauroPool(config);\nawait p.acquire();',
    "aliased KauroPool": 'import { KauroPool as KP } from "@kauro/persistence";\nconst p = new KP(config);',
    "namespace KauroPool": 'import * as persistence from "@kauro/persistence";\nconst p = new persistence.KauroPool(config);',
    "re-exported KauroPool": 'export { KauroPool as Pool2 } from "@kauro/persistence";',
    "destructured KauroPool from a dynamic import": 'const { KauroPool: KP } = await import("@kauro/persistence");\nconst p = new KP(cfg);',
    "required KauroPool": 'const { KauroPool } = require("@kauro/persistence");',
    "KauroPool destructured from a namespace": 'import * as ns from "@kauro/persistence";\nconst { KauroPool: KP } = ns;\nconst p = new KP(cfg);',
    "KauroPool member taken without new": 'import * as ns from "@kauro/persistence";\nconst KP = ns.KauroPool;',
    "persistence imported at run time": 'const m = await import("@kauro/persistence");',
    "namespace destructured over lines": 'import * as ns from "@kauro/persistence";\nconst {\n  KauroPool: K,\n} = ns;\nconst p = new K(cfg);',
    "namespace destructured after a ternary colon": 'import * as ns from "@kauro/persistence";\nlet K;\nc ? 0 : ({ KauroPool: K } = ns);',
    "namespace computed member": 'import * as ns from "@kauro/persistence";\nconst p = new ns["KauroPool"](cfg);',
    "star re-export of persistence": 'export * from "@kauro/persistence";',
    "spaced dynamic import of pg": 'const m = await import ("pg");\nconst p = new m["Pool"](cfg);',
    "template-literal import of pg": "const m = await import(`pg`);",
    "a site after a string holding //": 'const u = "a//b"; const p = new (await import("pg")).Pool({});',
  };
  for (const [name, text] of Object.entries(forms)) assert.ok(isSite(text), `not caught: ${name}`);
  // a JSX expression that starts with `new` in a .tsx file (adversary note on 244b276: parsed as plain TS it printed as an object literal)
  assert.ok(isSite("export const V = (c: object) => <A>{new Pool(c)}</A>;", "apps/web/src/v.tsx"), "not caught: new Pool inside JSX in a .tsx file");
  for (const text of ['import type { PoolClient } from "pg";', 'import { type Client } from "pg";', "// new Pool(\nexport const a = 1;", 'export type { Pool } from "pg";', 'import type { KauroPool } from "@kauro/persistence";', 'import { type KauroPool } from "@kauro/persistence";', 'export const superuser = "postgres";', 'function f(): KauroPool {\n  return x;\n}\nconst { a, b } = y;', 'function f({ pool }: { pool: KauroPool } = d) {}']) assert.ok(!isSite(text), text);
  // ADV-3 (a88da2e): a persistence file other than pool.ts that constructs KauroPool is refused; pool.ts may
  assert.equal(persistenceProblem("packages/persistence/src/wrap.ts", 'import { KauroPool } from "./pool.js";\nexport const p = (c) => new KauroPool(c);'), "packages/persistence/src/wrap.ts constructs KauroPool outside pool.ts");
  assert.equal(persistenceProblem("packages/persistence/src/pool.ts", "export function createPool(config) {\n  return new KauroPool(config);\n}"), undefined);
  // DB-TLS-R3 (fdf3360): aliased, parenthesized, destructured, computed and run-time forms, also in an already-listed site (runner.ts)
  for (const [rel, text] of [
    ["packages/persistence/src/migrations/runner.ts", 'import { KauroPool as K } from "../pool.js";\nexport const p = (c) => new (K)(c);'],
    ["packages/persistence/src/wrap.ts", 'import * as P from "./pool.js";\nexport const p = (c) => new P["KauroPool"](c);'],
    ["packages/persistence/src/wrap.ts", 'import * as P from "./pool.js";\nconst { KauroPool: K } = P;\nexport const p = (c) => new K(c);'],
    ["packages/persistence/src/wrap.ts", 'export const p = async (c) => new (await import("./pool.js")).KauroPool(c);'],
    ["packages/persistence/src/migrations/runner.ts", 'import { createPool as mk } from "../pool.js";\nexport const open = (c) => mk(c);'],
    ["packages/persistence/src/wrap.ts", "export const p = async (c) => (await import (`./pool.js`)).createPool(c);"],
    ["packages/persistence/src/migrations/runner.ts", 'import * as I from "../index.js";\nexport const open = (c) => I.createPool(c);'],
  ] as const) assert.equal(persistenceProblem(rel, text), `${rel} takes KauroPool or createPool as a value outside pool.ts and index.ts`, text);
  for (const [rel, text] of [
    ["packages/persistence/src/evidence.ts", 'import type { KauroPool, RuntimeRole } from "./pool.js";\nexport const f = (pool: KauroPool) => pool;'],
    ["packages/persistence/src/inquiries.ts", 'import { type KauroPool } from "./pool.js";'],
    ["packages/persistence/src/index.ts", 'export { createPool, KauroPool } from "./pool.js";'],
  ] as const) assert.equal(persistenceProblem(rel, text), undefined, text);
  const files = Object.fromEntries(["a.ts", "b.js", "c.mjs", "d.cjs", "e.mts", "f.cts", "g.jsx"].map((n) => [`apps/x/src/${n}`, forms["new pg.Pool("] ?? ""]));
  const repo = tempRepo(files);
  try {
    assert.deepEqual(trackedSources(repo.dir), Object.keys(files));
  } finally {
    repo.done();
  }
});

test("scan self-test: only tracked source is scanned: src/build/db.ts, src/out/db.ts and src/vendor/db.ts are caught, an untracked .next/ file and a package-root test/ are not", () => {
  const looks = ["import pg from \"pg\";", "export const p = new pg.Pool({});"].join("\n");
  const repo = tempRepo(
    {
      "apps/web/src/build/db.ts": looks,
      "apps/web/src/out/db.ts": looks,
      "apps/web/src/app/out/db.ts": looks,
      "packages/x/src/vendor/db.ts": looks,
      "apps/web/src/test/db.ts": looks,
      "apps/web/test/db.test.ts": looks,
      "apps/web/src/types.d.ts": looks,
      "apps/web/src/types.d.mts": looks,
      "apps/web/src/types.d.cts": looks,
    },
    { "apps/web/.next/standalone/apps/web/server.js": looks, "apps/web/dist/db.js": looks },
  );
  try {
    assert.deepEqual(trackedSources(repo.dir), ["apps/web/src/app/out/db.ts", "apps/web/src/build/db.ts", "apps/web/src/out/db.ts", "apps/web/src/test/db.ts", "packages/x/src/vendor/db.ts"]);
  } finally {
    repo.done();
  }
});

test("scan self-test: a TLS setting outside tls.ts is caught in every form", () => {
  const bad = [
    "const o = { ssl: { rejectUnauthorized: false } };",
    "const o = { ssl: true };",
    "const o = { ssl: { ca, checkServerIdentity: () => undefined } };",
    "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
    "const o = { rejectUnauthorized: true };",
    "config.ssl = { ca };",
    "config['ssl'] = true;",
    'const o = { "ssl": true };',
    "const o = { host, ssl, port };",
    "process.env.PGSSLMODE = 'disable';",
    "process.env.PGPASSWORD = x;",
  ];
  for (const text of bad) assert.ok(tlsViolations(text).length > 0, text);
  assert.deepEqual(tlsViolations("const o = { ...(tls === undefined ? {} : { ssl: sslOptionsOf(tls) }) };"), []);
});

test("every connection site of apps/ and packages/*/src is known, and each composition root applies connectionSecurityOf", () => {
  const files = trackedSources(root).map((f) => join(root, f));
  const found = new Map<string, string>();
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel.startsWith("packages/persistence/src/testing/")) continue; // the test-only subpath (the architecture gate keeps it out of production)
    const text = readFileSync(file, "utf8");
    if (isSite(text, rel)) found.set(rel, text);
    // DB-TLS-R3: every persistence source, listed site or not, takes KauroPool as a type only (pool.ts and index.ts excepted)
    if (rel.startsWith("packages/persistence/src/")) {
      const problem = persistenceProblem(rel, text);
      assert.equal(problem, undefined, problem);
    }
    if (rel !== "packages/persistence/src/tls.ts") assert.deepEqual(tlsViolations(text, rel), [], `${rel}: TLS settings belong in tls.ts`);
  }
  assert.deepEqual(
    [...found.keys()].sort(),
    [
      "apps/api/src/commissions/assembly.ts",
      "apps/api/src/composition.ts",
      "apps/api/src/payments/assembly.ts",
      "apps/control/src/audit/receipts.ts",
      "apps/control/src/composition.ts",
      "apps/web/scripts/next.mjs",
      "packages/persistence/src/index.ts",
      "packages/persistence/src/migrations/runner.ts",
      "packages/persistence/src/pool.ts",
    ],
    "a new connection site must be listed here and covered by connectionSecurityOf",
  );
  for (const [rel, text] of found) {
    if (rel === "apps/web/scripts/next.mjs") {
      // createRequire there only resolves the `next` binary; nothing in it may open a database connection
      assert.ok(!SITE_FORMS.filter((f) => !f.test("createRequire")).some((f) => f.test(code(text, rel))), `${rel} opens no database connection`);
    } else if (rel.startsWith("packages/persistence/src/")) {
      // by content: a file that constructs a Pool or Client derives ssl from sslOptionsOf; a file that does not only re-exports
      const problem = persistenceProblem(rel, text);
      assert.equal(problem, undefined, problem);
    } else {
      assert.ok(text.includes("connectionSecurityOf("), `${rel} applies connectionSecurityOf before it connects`);
    }
  }
});

const login = { host: "db.example.test", port: 1, database: "kauro", user: "u", poolMax: 1, passwordFile: "pw" };
const secure = { ...login, tlsCaFile: "ca.pem" };
const plain = { host: "db.example.test", port: 1, database: "kauro", user: "u", poolMax: 1, tlsCaFile: "ca.pem", password: "x" };
const deps = (environment: "SANDBOX" | "LIVE") => ({ clock: { now: () => 0 } as never, random: (() => new Uint8Array(1)) as never, environment });
const refused = (variable: string) => (e: unknown) => e instanceof ConnectionSecurityError && e.message.startsWith(`${variable}:`);

test("the commission and payment roots refuse SANDBOX and LIVE without a CA, with a plain password or with an IP host", async () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    const ok = { commission: login, control: login };
    await assert.rejects(openCommissionPools(ok, deps(environment)), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openCommissionPools({ commission: plain, control: secure }, deps(environment)), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openCommissionPools({ commission: { ...secure, host: "10.0.0.1" }, control: secure }, deps(environment)), refused("KAURO_DB_HOST"));
    const pay = { payment: login, control: login, ingress: login };
    await assert.rejects(openPaymentPools({} as never, pay, deps(environment)), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openPaymentPools({} as never, { payment: plain, control: secure, ingress: secure }, deps(environment)), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openPaymentPools({} as never, { payment: { ...secure, host: "10.0.0.1" }, control: secure, ingress: secure }, deps(environment)), refused("KAURO_DB_HOST"));
  }
});

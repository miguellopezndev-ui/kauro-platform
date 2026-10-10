// I-2 / I-3: no process can open a PostgreSQL connection outside LOCAL without verified TLS.
//
// DB-TLS-R4/R5 root cause (adversary ADV-1/ADV-2 on d515f18): the earlier scan listed the spellings of an unchecked connection (a denylist:
// aliases, index specifiers, require forms) and each round found a spelling it missed. The design is now an allowlist plus enforcement at
// the single construction point:
//   1. packages/persistence/src/pool.ts builds every connection (KauroPool through createPool, the migrator's client) and applies
//      connectionSecurityOf there itself (pool-enforcement.test.ts proves it for every import route). Calling, aliasing, re-exporting or
//      wrapping createPool therefore cannot produce an insecure pool, and none of those is a scan finding.
//   2. This scan proves nothing else can reach the driver: through the TypeScript AST, every module a file loads (import, export-from,
//      import-equals, dynamic import, require, createRequire()()) is resolved by its literal specifier, and only DRIVER_FILES may load a
//      PostgreSQL driver. A load whose specifier is not a literal, and every other module-loading primitive (createRequire, the module and
//      vm modules, getBuiltinModule, module.require, _load, eval), is a finding unless allowlisted at its exact file and line: fail closed.
//   3. Type-only references (`import type`, `import { type X }`, `import("x").T` in a type position) load nothing and are never findings.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ConnectionSecurityError } from "@kauro/persistence";
import { testDatabaseEnvironment } from "@kauro/persistence/testing";
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

/** The parse mode follows the file name: parsed as plain TS, `<A>{new Pool(c)}</A>` in a .tsx file is an object literal. */
function scriptKindOf(rel: string): ts.ScriptKind {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Every PostgreSQL driver or data layer, by package name (a subpath such as pg/lib/client included). */
const DRIVER = /^(?:pg|pg-[\w.-]+|postgres|@neondatabase\/[\w.-]+|@vercel\/postgres|@databases\/pg[\w.-]*|slonik|knex|kysely|typeorm|sequelize|drizzle-orm|@prisma\/client|@supabase\/[\w.-]+)(?:\/.*)?$/s;

/**
 * The files that may load a driver. pool.ts builds every production connection under connectionSecurityOf. The others are the test-only
 * subpath @kauro/persistence/testing (temporary clusters, the harness and the fault/fixture helpers connect as the superuser of a throw-away
 * cluster); the architecture gate (tools/test/architecture-gate.test.mjs) keeps that subpath out of every production import graph.
 */
const DRIVER_FILES: ReadonlySet<string> = new Set([
  "packages/persistence/src/pool.ts",
  "packages/persistence/src/testing/faults/interleave.ts",
  "packages/persistence/src/testing/faults/scope.ts",
  "packages/persistence/src/testing/harness.ts",
  "packages/persistence/src/testing/temporary-postgres.ts",
]);

/** Modules that load other modules from computed names or evaluate code: loading them is itself a finding outside the allowlist. */
const LOADER_MODULE = /^(?:node:)?(?:module|vm|worker_threads)$/;
/** Node's module-loading and code-evaluation entry points, as a referenced name or a member name. */
const LOADER_NAMES: ReadonlySet<string> = new Set(["createRequire", "getBuiltinModule", "mainModule", "_load", "_compile", "_resolveFilename", "eval"]);

/**
 * The exact loader uses that are allowed, by file, line and text (each one reviewed; any other line, or this text on another line, is a finding):
 * - apps/web/scripts/next.mjs resolves the `next` binary's path with require.resolve; it loads no module through that require;
 * - apps/web/e2e/support/serve.mjs (browser-suite support, never shipped) loads the compiled contract fake of the edge by its built path;
 * - packages/data-plane/src/sandbox/child.ts runs the task module of a sandbox job inside the isolated child, whose preload refuses every
 *   network entry point (D-ISO-1), so no module it loads can reach a database;
 * - packages/data-plane/src/sandbox/preload.ts imports node:module (syncBuiltinESMExports, to publish its network hooks) and
 *   node:worker_threads (to observe the permission model's refusals); it loads nothing by name.
 */
const EXACT_ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly line: number; readonly text: string }> = [
  { file: "apps/web/scripts/next.mjs", line: 7, text: 'import { createRequire } from "node:module";' },
  { file: "apps/web/scripts/next.mjs", line: 10, text: "const require = createRequire(import.meta.url);" },
  { file: "apps/web/e2e/support/serve.mjs", line: 41, text: "const { createEdgeFake, mountOnEdge } = await import(pathToFileURL(fakeModule).href);" },
  { file: "packages/data-plane/src/sandbox/child.ts", line: 30, text: "const task = (await import(pathToFileURL(job.task).href)) as { run?: (payload: unknown, context: { readonly workDir: string }) => Promise<unknown> };" },
  { file: "packages/data-plane/src/sandbox/preload.ts", line: 26, text: 'import { syncBuiltinESMExports } from "node:module";' },
  { file: "packages/data-plane/src/sandbox/preload.ts", line: 29, text: 'import workerThreads from "node:worker_threads";' },
  // DB-TLS gap 2: the "LOCAL" values that are not an environment handed to a connection: the two lists of the three environments, the
  // origin policy kind of the web host, and the browser suite's default for its own local stack
  { file: "packages/domain/src/model/idempotency.ts", line: 17, text: 'export const ENVIRONMENTS: ReadonlyArray<Environment> = ["LOCAL", "SANDBOX", "LIVE"];' },
  { file: "packages/persistence/src/environment.ts", line: 23, text: 'const NAMES: ReadonlyArray<string> = Object.freeze(["LOCAL", "SANDBOX", "LIVE"]);' },
  { file: "apps/web/src/server/host-config.ts", line: 44, text: 'if (blank(publicOrigin) && blank(appOrigin)) return local ? { ok: true, policy: { kind: "LOCAL" } } : { ok: false, problem: "ORIGINS_MISSING" };' },
  { file: "apps/web/playwright.config.ts", line: 39, text: 'KAURO_ENV: process.env["KAURO_ENV"] ?? "LOCAL",' },
];

/**
 * DB-TLS gap 2 (6de1436): the environment of a connection comes from the validated runtime configuration only (apps/api/src/config.ts
 * environmentOf, KAURO_ENVIRONMENT, read by loadConfig and loadMigrationJobConfig), never from a literal. Fail closed: a "LOCAL" string in a
 * value position is a finding wherever it is not compared (===, !==, ==, !=, a case label), outside test code and the exact allowlist.
 *
 * Since the brand (packages/persistence/src/environment.ts) createPool and the migrator refuse any string, literal or built at run time, so
 * this rule no longer guards the connection itself. It is KEPT for what the brand trusts: the input of the production minter. A literal
 * fed to the configuration (`loadConfig({ ...env, KAURO_ENVIRONMENT: "LOCAL" })`, `env["KAURO_ENVIRONMENT"] ?? "LOCAL"`) mints a genuine
 * LOCAL value that the brand accepts; this rule finds it. The minters themselves are pinned by MINTER_FILES below.
 */
const TEST_CODE = /(?:^|\/)(?:e2e|testing)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
function isComparedOnly(node: ts.Node): boolean {
  const p = node.parent;
  if (ts.isCaseClause(p) && p.expression === node) return true;
  return ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind);
}

/** DB-TLS gap 2 brand: the only files that may name a minter of DatabaseEnvironment (test files may name them too: they never run in production). */
const MINTER_FILES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["claimEnvironmentMinter", new Set(["packages/persistence/src/environment.ts", "packages/persistence/src/index.ts", "apps/api/src/config.ts"])],
  ["mintTestDatabaseEnvironment", new Set(["packages/persistence/src/environment.ts", "packages/persistence/src/testing/index.ts", "packages/persistence/src/testing/harness.ts"])],
]);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly problem: string;
}

const literalOf = (node: ts.Node | undefined): string | undefined => (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);

/** `import { type A, type B } from "x"` and `export { type A } from "x"` bind types only (an empty brace list loads the module). */
function onlyTypes(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

/** The name position of a declaration or an object key: `{ eval: 1 }`, `class { require() {} }`, `const require = ...`, an import specifier. */
function isDeclarationName(node: ts.Identifier): boolean {
  const p = node.parent;
  return (
    ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p) || ts.isEnumMember(p)) && p.name === node) ||
    ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)
  );
}

/** Every finding of one file: driver loads outside DRIVER_FILES, non-literal loads, and loader primitives (memoized: the tree mutations rescan it). */
const memo = new Map<string, Finding[]>();
function findingsOf(file: string, text: string): Finding[] {
  const key = `${file}\u0000${text}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const found = findingsOfUncached(file, text);
  memo.set(key, found);
  return found;
}
function findingsOfUncached(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const findings: Finding[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: ts.Node, problem: string): void => {
    const line = lineOf(node);
    const lineText = (text.split(/\r?\n/)[line - 1] ?? "").trim();
    if (EXACT_ALLOWLIST.some((a) => a.file === file && a.line === line && a.text === lineText)) return;
    findings.push({ file, line, problem });
  };
  const load = (node: ts.Node, specifier: string | undefined, form: string): void => {
    if (specifier === undefined) return report(node, `${form} with a specifier that is not a string literal (the loaded module cannot be checked)`);
    if (DRIVER.test(specifier) && !DRIVER_FILES.has(file)) report(node, `${form} loads the PostgreSQL driver ${JSON.stringify(specifier)}: only ${[...DRIVER_FILES][0]} connects (it applies connectionSecurityOf)`);
    if (LOADER_MODULE.test(specifier)) report(node, `${form} loads ${JSON.stringify(specifier)}, a module loader or code evaluator`);
  };
  const visit = (node: ts.Node): void => {
    // a type position loads nothing (DB-TLS-R5): `import("./pool.js").KauroPool`, `typeof require`, ... are erased by the compiler
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && onlyTypes(clause.namedBindings.elements)));
      if (!typeOnly) load(node, literalOf(node.moduleSpecifier), "import");
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && !node.isTypeOnly && !(node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && onlyTypes(node.exportClause.elements))) load(node, literalOf(node.moduleSpecifier), "export-from");
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) load(node, literalOf(node.moduleReference.expression), "import = require");
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) load(node, literalOf(node.arguments[0]), "dynamic import");
      else if (ts.isIdentifier(callee) && callee.text === "require") load(node, literalOf(node.arguments[0]), "require");
      else if (ts.isCallExpression(callee) && /(?:^|\.)createRequire$/.test(callee.expression.getText())) load(node, literalOf(node.arguments[0]), "createRequire(...)(...)");
    }
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const p = node.parent;
      const member = ts.isPropertyAccessExpression(p) && p.name === node;
      if (LOADER_NAMES.has(node.text)) report(node, `${node.text} loads modules or evaluates code`);
      else if (node.text === "require") {
        if (member) report(node, "a .require member loads modules");
        else {
          const called = ts.isCallExpression(p) && p.expression === node;
          const resolved = ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text === "resolve" && ts.isCallExpression(p.parent) && p.parent.expression === p && literalOf(p.parent.arguments[0]) !== undefined;
          if (!called && !resolved) report(node, "require is used other than as a call with a literal specifier (an alias of the loader)");
        }
      } else if (node.text === "Function" && !member && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node) report(node, "the Function constructor evaluates code");
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "LOCAL" && !TEST_CODE.test(file) && !isComparedOnly(node)) {
      report(node, '"LOCAL" as a value outside test code: the environment of a connection comes from the validated configuration (KAURO_ENVIRONMENT), never from a literal');
    }
    const named = ts.isIdentifier(node) ? node.text : literalOf(node);
    if (named !== undefined && MINTER_FILES.get(named)?.has(file) === false && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      report(node, `${named} mints the environment of a database connection: only ${[...(MINTER_FILES.get(named) ?? [])].join(", ")} may name it`);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = literalOf(node.argumentExpression);
      if (key !== undefined && (LOADER_NAMES.has(key) || key === "require")) report(node, `a [${JSON.stringify(key)}] member loads modules or evaluates code`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** TLS settings are written in tls.ts and pool.ts (the construction point) and nowhere else: process-wide or per-socket overrides of verification. */
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
/** tls.ts and pool.ts are the construction point; temporary-postgres.ts (test-only subpath) writes the throw-away cluster's server TLS settings. */
const TLS_FILES: ReadonlySet<string> = new Set(["packages/persistence/src/tls.ts", "packages/persistence/src/pool.ts", "packages/persistence/src/testing/temporary-postgres.ts"]);
const printer = ts.createPrinter({ removeComments: true });

const tlsMemo = new Map<string, string[]>();
function tlsViolations(text: string, rel = "scan.ts"): string[] {
  const key = `${rel}\u0000${text}`;
  const known = tlsMemo.get(key);
  if (known !== undefined) return known;
  const c = printer.printFile(ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindOf(rel)));
  const found = TLS_FORMS.filter((f) => f.test(c)).map(String);
  tlsMemo.set(key, found);
  return found;
}

/** The whole structural scan over {tracked relative path -> text}: every problem found, empty when the tree conforms. */
function scanTree(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [rel, text] of sources) {
    for (const f of findingsOf(rel, text)) problems.push(`${f.file}:${f.line} ${f.problem}`);
    if (!TLS_FILES.has(rel)) for (const v of tlsViolations(text, rel)) problems.push(`${rel}: TLS settings belong in tls.ts (${v})`);
  }
  // an allowlisted loader line that no longer exists is stale: the list stays exact
  for (const a of EXACT_ALLOWLIST) {
    const lines = (sources.get(a.file) ?? "").split(/\r?\n/);
    if ((lines[a.line - 1] ?? "").trim() !== a.text) problems.push(`${a.file}:${a.line} is allowlisted as ${JSON.stringify(a.text)} but holds something else`);
  }
  return problems.sort();
}

const problemsOf = (file: string, text: string): string[] => findingsOf(file, text).map((f) => f.problem);
const APP = "apps/api/src/x.ts";

test("scan self-test: every way to load a PostgreSQL driver outside pool.ts is caught, in every source kind", () => {
  const forms: Record<string, string> = {
    "default import": 'import pg from "pg";\nexport const p = new pg.Pool({});',
    "namespace import": 'import * as db from "pg";\nexport const c = new db.Client({});',
    "aliased Pool": 'import { Pool as P } from "pg";\nexport const p = new P({});',
    "aliased Client beside a type": 'import { type PoolClient, Client as C } from "pg";\nexport const c = new C();',
    "side-effect import": 'import "pg";',
    "empty brace import (loads the module)": 'import {} from "pg";',
    "subpath": 'import Client from "pg/lib/client.js";',
    require: 'const { Pool } = require("pg");',
    "import = require": 'import pg = require("pg");',
    "dynamic import": 'const m = await import("pg");',
    "spaced dynamic import": 'const m = await import ("pg");\nconst p = new m["Pool"](cfg);',
    "template-literal import": "const m = await import(`pg`);",
    "export { Pool } from pg": 'export { Pool } from "pg";',
    "export { Client as X } from pg": 'export { Client as Db } from "pg";',
    "export * from pg": 'export * from "pg";',
    "export * as ns from pg": 'export * as ns from "pg";',
    "createRequire()()": 'import { createRequire } from "node:module";\nconst pg = createRequire(import.meta.url)("pg");',
    "postgres driver": 'import postgres from "postgres";',
    "pg-pool": 'import Pool from "pg-pool";',
    "pg-promise": 'const pgp = require("pg-promise")();',
    "neon driver": 'import { Pool } from "@neondatabase/serverless";',
    knex: 'import knex from "knex";',
    "a load after a string holding //": 'const u = "a//b"; const p = new (await import("pg")).Pool({});',
  };
  for (const [name, text] of Object.entries(forms)) assert.ok(problemsOf(APP, text).some((p) => p.includes("loads the PostgreSQL driver")), `not caught: ${name}`);
  // the same in persistence outside pool.ts (the old R3 site runner.ts included): only pool.ts connects
  for (const rel of ["packages/persistence/src/migrations/runner.ts", "packages/persistence/src/sql.ts", "packages/persistence/src/index.ts"]) {
    assert.ok(problemsOf(rel, 'import { Client } from "pg";').length > 0, rel);
    assert.ok(problemsOf(rel, 'export { Pool } from "pg";').length > 0, rel);
  }
  assert.deepEqual(problemsOf("packages/persistence/src/pool.ts", 'import { Client, Pool, type PoolClient } from "pg";\nexport { DatabaseError } from "pg";'), []);
  // the parse mode follows the extension: a JSX expression in a .tsx/.jsx file, a load in a .mjs/.cjs file
  assert.ok(problemsOf("apps/web/src/v.tsx", 'export const V = async (c: object) => <A>{new (await import("pg")).Pool(c)}</A>;').length > 0, ".tsx");
  assert.ok(problemsOf("apps/web/src/v.jsx", 'export const V = async (c) => <A>{new (await import("pg")).Pool(c)}</A>;').length > 0, ".jsx");
  for (const ext of [".js", ".mjs", ".cjs", ".mts", ".cts"]) assert.ok(problemsOf(`apps/x/src/a${ext}`, 'const pg = require("pg");').length > 0, ext);
  const files = Object.fromEntries(["a.ts", "b.js", "c.mjs", "d.cjs", "e.mts", "f.cts", "g.jsx"].map((n) => [`apps/x/src/${n}`, forms["default import"] ?? ""]));
  const repo = tempRepo(files);
  try {
    assert.deepEqual(trackedSources(repo.dir), Object.keys(files));
  } finally {
    repo.done();
  }
});

test("scan self-test: fail closed: a load whose specifier is not a literal and every module-loading primitive are caught; the exact allowlist is honoured", () => {
  for (const text of [
    "const m = await import(name);",
    "const m = await import(`p${'g'}`);",
    'const m = require("p" + "g");',
    "const m = require(name);",
    'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconst m = r("../");',
    'import { createRequire } from "module";',
    'import * as M from "node:module";\nconst r = M["create" + "Require"](import.meta.url);',
    'const M = await import("node:module");',
    'import vm from "node:vm";',
    'import { Worker } from "node:worker_threads";',
    "const r = require;\nr(x);",
    "const m = module.require(x);",
    'const m = module["require"](x);',
    "const m = process.mainModule.require(x);",
    'const M = process.getBuiltinModule("module");',
    "const m = Module._load(x);",
    'eval("import(\'pg\')");',
    "globalThis.eval(code);",
    'const f = new Function("return import(\'pg\')");',
    'const f = Function("return 1");',
    "const s = require.cache;",
  ]) assert.ok(problemsOf(APP, text).length > 0, `not caught: ${text}`);
  // allowed: a literal require/import of anything that is not a driver or a loader, require.resolve of a literal, keys and declarations named like a primitive
  for (const text of [
    'const fs = require("node:fs");',
    'const { join } = await import("node:path");',
    'const p = require.resolve("next/dist/bin/next");',
    "const o = { eval: 1, require: 2, createRequire: 3 };",
    "class C { require(): void {} }",
    'export const superuser = "postgres";',
    "if (x instanceof Function) y();",
  ]) assert.deepEqual(problemsOf(APP, text), [], text);
  // the allowlist is by exact file, line and text
  const next = readFileSync(join(root, "apps/web/scripts/next.mjs"), "utf8");
  assert.deepEqual(findingsOf("apps/web/scripts/next.mjs", next), []);
  assert.ok(findingsOf("apps/web/scripts/next.mjs", `${next}\nconst db = require(process.env.X);\n`).length > 0, "a new loader line in an allowlisted file");
  assert.ok(findingsOf("apps/web/scripts/next.mjs", `${next}\nconst db = require("pg");\n`).length > 0, "a driver load in an allowlisted file");
  assert.ok(findingsOf("apps/web/scripts/other.mjs", next).length > 0, "the same lines in another file");
  assert.ok(scanTree(new Map([["apps/web/scripts/next.mjs", `// moved\n${next}`]])).some((p) => p.includes("is allowlisted as")), "a stale allowlist entry");
});

test("scan self-test: DB-TLS gap 2: a literal \"LOCAL\" environment in production code is caught; comparisons, types and test code are not", () => {
  for (const text of [
    'createPool({ environment: "LOCAL", host, port, database, user, max: 1, applicationName: "a" });',
    'const environment = "LOCAL";',
    'await applyMigrationsWith("LOCAL", migrator, password);',
    'connectionSecurityOf("LOCAL", { host });',
    'const e = process.env["KAURO_ENVIRONMENT"] ?? "LOCAL";',
    'config.environment = "LOCAL";',
    'createPool({ ...c, environment: live ? "LIVE" : "LOCAL" });',
    "createPool({ ...c, environment: `LOCAL` });",
    'createPool({ ...c, environment: "LOCAL" as const });',
  ]) assert.ok(problemsOf(APP, text).some((p) => p.includes('"LOCAL" as a value')), `not caught: ${text}`);
  for (const text of [
    'if (environment === "LOCAL") x();',
    'const remote = "LOCAL" !== environment;',
    'switch (environment) {\n  case "LOCAL":\n    break;\n}',
    'type E = "LOCAL" | "LIVE";',
    'function f(e: "LOCAL" | "SANDBOX"): void {}',
  ]) assert.deepEqual(problemsOf(APP, text), [], text);
  for (const rel of ["packages/persistence/src/testing/harness.ts", "apps/web/e2e/support/serve.mjs", "apps/api/src/a.test.ts"]) assert.deepEqual(problemsOf(rel, 'createPool({ environment: "LOCAL" });'), [], rel);
});

test("scan self-test: DB-TLS gap 2 brand: a minter of the database environment named outside MINTER_FILES is caught", () => {
  for (const [rel, text] of [
    ["apps/control/src/composition.ts", 'import { claimEnvironmentMinter } from "@kauro/persistence";\nexport const m = claimEnvironmentMinter();'],
    ["apps/api/src/main.ts", 'import * as P from "@kauro/persistence";\nexport const m = P.claimEnvironmentMinter();'],
    ["apps/api/src/main.ts", 'import * as P from "@kauro/persistence";\nexport const m = (P as never as Record<string, () => unknown>)["claimEnvironmentMinter"]!();'],
    ["packages/persistence/src/pool.ts", 'import { mintTestDatabaseEnvironment } from "./environment.js";\nexport const e = mintTestDatabaseEnvironment("LIVE");'],
  ] as const) assert.ok(problemsOf(rel, text).some((p) => p.includes("mints the environment")), `${rel}: ${text}`);
  assert.deepEqual(problemsOf("apps/api/src/config.ts", 'import { claimEnvironmentMinter } from "@kauro/persistence";\nconst mint = claimEnvironmentMinter();'), []);
  assert.deepEqual(problemsOf("packages/persistence/test/x.test.ts", 'import { claimEnvironmentMinter } from "../src/index.js";\nclaimEnvironmentMinter();'), []);
});

test("scan self-test: DB-TLS-R5 / ADV-2: type-only references load nothing and are never findings", () => {
  for (const [rel, text] of [
    ["packages/persistence/src/evidence.ts", 'export const f = (pool: import("./pool.js").KauroPool) => pool;'],
    ["packages/persistence/src/types.ts", 'export type Config = import("./pool.js").PoolConfig;'],
    ["packages/persistence/src/types.ts", 'export type Open = typeof import("./pool.js");'],
    ["packages/persistence/src/types.ts", 'export type Opened = ReturnType<typeof import("./pool.js").createPool>;'],
    ["apps/api/src/main.ts", 'export type P = import("@kauro/persistence").KauroPool;'],
    ["apps/api/src/main.ts", 'export type C = import("pg").PoolClient;'],
    ["apps/api/src/main.ts", 'export type R = typeof require;'],
    ["packages/persistence/src/evidence.ts", 'import type { PoolClient } from "pg";'],
    ["packages/persistence/src/evidence.ts", 'import { type PoolClient, type QueryResult } from "pg";'],
    ["packages/persistence/src/evidence.ts", 'import type * as P from "pg";\nexport type K = P.Pool;'],
    ["packages/persistence/src/evidence.ts", 'export type { Pool } from "pg";'],
    ["packages/persistence/src/evidence.ts", 'export { type Pool } from "pg";'],
    ["packages/persistence/src/evidence.ts", 'import type pg = require("pg");'],
  ] as const) assert.deepEqual(problemsOf(rel, text), [], `${rel}: ${text}`);
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

test("scan self-test: a TLS setting outside tls.ts and pool.ts is caught in every form", () => {
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
  assert.deepEqual(tlsViolations("// ssl: false\nexport const a = 1;"), [], "comments are not code");
});

const treeSources = (): Map<string, string> => new Map(trackedSources(root).map((f) => [f, readFileSync(join(root, f), "utf8")]));

test("the tree conforms: only pool.ts (and the test-only subpath) loads a driver, every load is literal, no loader primitive outside the allowlist, TLS only in tls.ts/pool.ts", () => {
  assert.deepEqual(scanTree(treeSources()), []);
});

test("DB-TLS-R4 / ADV-1 / ADV-2 on the complete tree: a direct driver load anywhere is caught; createPool aliases, wrappers and index routes are not findings (createPool enforces, pool-enforcement.test.ts); type references are not findings", () => {
  const base = treeSources();
  const mutated = (...edits: ReadonlyArray<readonly [string, string]>): string[] => {
    const tree = new Map(base);
    for (const [rel, append] of edits) {
      assert.ok(tree.has(rel), `${rel} is tracked`);
      tree.set(rel, `${tree.get(rel)}\n${append}\n`);
    }
    return scanTree(tree);
  };
  // every direct-driver form, in an app root and in persistence outside pool.ts
  for (const [rel, text] of [
    ["apps/api/src/main.ts", 'import { Pool } from "pg";\nexport const p = new Pool({ host: "10.0.0.1" });'],
    ["apps/api/src/main.ts", 'export const p = async () => new (await import("pg")).default.Pool({});'],
    ["apps/control/src/composition.ts", 'import { createRequire } from "node:module";\nexport const P = createRequire(import.meta.url)("pg").Pool;'],
    ["packages/persistence/src/migrations/runner.ts", 'import { Client as C } from "pg";\nexport const c = new C({});'],
    ["packages/persistence/src/index.ts", 'export { Pool } from "pg";'],
    ["packages/persistence/src/sql.ts", 'export * from "pg";'],
    // ADV-1 P3 of d515f18: require of the parent directory through createRequire, now a loader finding wherever it appears
    ["packages/persistence/src/migrations/runner.ts", 'import { createRequire } from "node:module";\nexport const open = (c: never) => createRequire(import.meta.url)("../").createPool(c);'],
    ["apps/api/src/main.ts", 'export const open = async (m: string) => (await import(m)).Pool;'],
  ] as const) assert.ok(mutated([rel, text]).some((p) => p.startsWith(`${rel}:`)), `${rel}: ${text}`);
  // DB-TLS gap 2: a production root that hands a connection a literal LOCAL environment
  for (const [rel, text] of [
    ["apps/api/src/main.ts", 'import { createPool } from "@kauro/persistence";\nexport const p =(c: never) => createPool({ ...(c as object), environment: "LOCAL" } as never);'],
    ["apps/control/src/composition.ts", 'export const localEnvironment = "LOCAL";'],
  ] as const) assert.ok(mutated([rel, text]).some((p) => p.startsWith(`${rel}:`) && p.includes('"LOCAL" as a value')), `${rel}: ${text}`);
  // ADV-1 P1/P2/P3b of d515f18 (an aliased re-export with an app caller, the index by another specifier, at run time): no finding, because
  // the pool they reach is built under connectionSecurityOf; pool-enforcement.test.ts runs each route and proves the refusal and the TLS
  assert.deepEqual(mutated(["packages/persistence/src/index.ts", 'export { createPool as openPool } from "./pool.js";'], ["apps/api/src/main.ts", 'import { openPool } from "@kauro/persistence";\nexport const o = (c: never) => openPool(c);']), []);
  assert.deepEqual(mutated(["packages/persistence/src/migrations/runner.ts", 'import * as I from "../index.js";\nexport const open = (c: never) => (I as never as Record<string, (c: never) => unknown>)["create" + "Pool"]!(c);']), []);
  assert.deepEqual(mutated(["packages/persistence/src/migrations/runner.ts", 'export const open = async (c: never) => ((await import("../index.js")) as never as Record<string, (c: never) => unknown>)["createPool"]!(c);']), []);
  // ADV-2 / DB-TLS-R5: type references in a persistence file and an app file are not findings
  assert.deepEqual(mutated(["packages/persistence/src/evidence.ts", 'export const f = (pool: import("./pool.js").KauroPool) => pool;\nexport type O = ReturnType<typeof import("./pool.js").createPool>;'], ["apps/api/src/main.ts", 'export type P = import("@kauro/persistence").KauroPool;']), []);
});

const login = { host: "db.example.test", port: 1, database: "kauro", user: "u", poolMax: 1, passwordFile: "pw" };
const secure = { ...login, tlsCaFile: "ca.pem" };
const plain = { host: "db.example.test", port: 1, database: "kauro", user: "u", poolMax: 1, tlsCaFile: "ca.pem", password: "x" };
const deps = (environment: "SANDBOX" | "LIVE") => ({ clock: { now: () => 0 } as never, random: (() => new Uint8Array(1)) as never, environment: testDatabaseEnvironment(environment) });
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

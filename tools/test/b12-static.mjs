// The shared scanners of package B12's static cells (companion docs/design/B12-outreach-plan-cells.md §S; plan §W rule 25; lane K1):
// the B12 file set and pure functions over source text, so each test checks the real files AND a planted copy with the same function.
// Every check is an exact allowlist or a structural rule over the parsed text; a form it cannot read (a non-literal import) fails closed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The B12 product sources (plan §9 K1 and every lane's handler file), relative to the repository root. */
export const B12_SOURCE_ROOTS = [
  "packages/domain/src/commercial/outreach.ts",
  "packages/persistence/src/outreach-access.ts",
  "packages/persistence/src/repositories/commercial-outreach.ts",
  "packages/application/src/commercial/outreach",
  "packages/application/src/commercial/prospects/record-source.ts",
  "packages/application/src/commercial/prospects/record-contact.ts",
  "packages/application/src/commercial/prospects/contact-key.ts",
  "packages/application/src/commercial/testing/outreach-send.ts",
  "apps/api/src/outreach",
  "packages/application/src/commercial/sellers/owner-tools",
  "packages/persistence/src/repositories/commercial-owner-tools.ts",
];
/** The B12 migration (0088, renumbered at the batch C merge). */
export const B12_MIGRATION = "packages/persistence/migrations/0088_b12_outreach.sql";

function walk(path) {
  const abs = join(root, path);
  if (!existsSync(abs)) throw new Error(`${path} does not exist: the B12 file set is stale`);
  if (statSync(abs).isFile()) return [path];
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => walk(`${path}/${d.name}`));
}

export function b12Sources() {
  return B12_SOURCE_ROOTS.flatMap(walk).filter((f) => f.endsWith(".ts")).sort();
}

export const read = (path) => readFileSync(join(root, path), "utf8");

/** TypeScript text without comments (string contents kept; a `//` inside a string is kept). */
export function stripTsComments(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** SQL text without comments (`--` to end of line, block comments). */
export function stripSqlComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

// --- D-33 ----------------------------------------------------------------------------------------------------------------------------

const D33_IDENT = /\b(segment|segments|buyer_?types?|buyerTypes?|BuyerType\w*)\b/i;
const D33_LITERAL = /(["'`])(AGENCY|COMPANY)\1/;
const RANKING_TERM = /\b(segment|buyer|score|rank|ranking|priority|tier)\b/i;
const ID_OR_CREATED = /^(\w+\.)?(\w*_id|created_at)(\s+(ASC|DESC))?$/i;

/** D-33 problems of one source (TypeScript or SQL): a segment or buyer-type read, an AGENCY/COMPANY literal, an ordering by an attribute. */
export function d33Problems(file, text) {
  const code = file.endsWith(".sql") ? stripSqlComments(text) : stripTsComments(text);
  const problems = [];
  code.split("\n").forEach((line, n) => {
    if (D33_IDENT.test(line)) problems.push(`${file}:${n + 1} reads a segment or buyer type: ${line.trim()}`);
    if (D33_LITERAL.test(line)) problems.push(`${file}:${n + 1} names an AGENCY/COMPANY literal: ${line.trim()}`);
  });
  for (const stmt of code.split(";")) {
    for (const m of stmt.matchAll(/ORDER\s+BY\s+([\s\S]+?)(?=\bLIMIT\b|\bLOOP\b|\bOFFSET\b|\bFOR\b|\)|$)/gi)) {
      const terms = m[1].split(",").map((t) => t.trim()).filter(Boolean);
      for (const t of terms) if (RANKING_TERM.test(t)) problems.push(`${file}: orders by an attribute (${t})`);
      if (/\b(?:FROM|JOIN)\s+kauro\.(prospect\w*|\w*evidence\w*)\b/i.test(stmt)) {
        for (const t of terms) if (!ID_OR_CREATED.test(t)) problems.push(`${file}: orders prospects or evidence by ${t}, not by id/created_at`);
      }
    }
  }
  return problems;
}

// --- imports ---------------------------------------------------------------------------------------------------------------------------

/** The only module specifiers a B12 source may import (exact; relative paths are the package's own files). */
export const B12_IMPORT_ALLOW = new Set(["@kauro/domain", "@kauro/contracts", "@kauro/persistence", "@kauro/application", "pg", "node:crypto", "node:timers/promises"]);
/** Only the SIM fakes, on the test-only subpath, may import the application's own test helpers; nothing imports @kauro/*\/testing. */
const RELATIVE = /^\.\.?\//;

/** Import problems of one TypeScript source: a specifier outside the allowlist, or an import form whose specifier is not a literal. */
export function importProblems(file, text) {
  const code = stripTsComments(text);
  const problems = [];
  const specs = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?(["'])([^"']+)\1/g)) specs.push(m[2]);
  for (const m of code.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    const lit = /^\s*(["'])([^"']+)\1\s*$/.exec(m[1]);
    if (lit === null) problems.push(`${file}: a dynamic import whose specifier is not a literal (${m[1].trim()})`);
    else specs.push(lit[2]);
  }
  if (/\brequire\s*\(/.test(code)) problems.push(`${file}: require() is not an import form B12 uses`);
  for (const s of specs) if (!RELATIVE.test(s) && !B12_IMPORT_ALLOW.has(s)) problems.push(`${file} imports ${s}, which is not on the B12 allowlist`);
  return problems;
}

/** Tables with an agency_id column, from every migration (CREATE TABLE bodies and ALTER TABLE ... ADD COLUMN agency_id). */
export function agencyTables(migrations) {
  const out = new Set();
  for (const sql of migrations.map(stripSqlComments)) {
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?kauro\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) if (/^\s*agency_id\b/im.test(m[2])) out.add(m[1]);
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?kauro\.(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?agency_id\b/gi)) out.add(m[1]);
  }
  return out;
}

/** The tables every migration grants to `role` (any privilege, table-level or column-level), less those a later REVOKE ALL takes back. */
export function grantedTables(migrations, role) {
  const out = new Set();
  for (const sql of migrations.map(stripSqlComments)) {
    for (const m of sql.matchAll(/\bGRANT\s+([^;]+?)\s+ON\s+(?:TABLE\s+)?([^;]+?)\s+TO\s+([^;]+);/gi)) {
      if (!m[3].split(",").map((r) => r.trim()).includes(role)) continue;
      for (const t of m[2].matchAll(/kauro\.(\w+)/g)) out.add(t[1]);
    }
    for (const m of sql.matchAll(/\bREVOKE\s+ALL\s+(?:PRIVILEGES\s+)?ON\s+(?:TABLE\s+)?([^;]+?)\s+FROM\s+([^;]+);/gi)) {
      if (!m[2].split(",").map((r) => r.trim()).includes(role)) continue;
      for (const t of m[1].matchAll(/kauro\.(\w+)/g)) out.delete(t[1]);
    }
  }
  return out;
}

export function migrationTexts() {
  const dir = join(root, "packages/persistence/migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
}

// --- producers -------------------------------------------------------------------------------------------------------------------------

/** Tables a source reads (FROM / JOIN kauro.<t>, outside comments). */
export function readTables(text, sql = false) {
  const code = sql ? stripSqlComments(text) : stripTsComments(text);
  return new Set([...code.matchAll(/\b(?:FROM|JOIN)\s+kauro\.(\w+)/gi)].map((m) => m[1]));
}

/** Tables a source inserts into (INSERT INTO kauro.<t>). */
export function insertedTables(text, sql = false) {
  const code = sql ? stripSqlComments(text) : stripTsComments(text);
  return new Set([...code.matchAll(/\bINSERT\s+INTO\s+kauro\.(\w+)/gi)].map((m) => m[1]));
}

/** Non-fixture product sources: packages/*\/src and apps/*\/src, outside any testing directory or test file. */
export function productSources() {
  const out = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = `${top}/${pkg.name}/src`;
      if (!existsSync(join(root, src))) continue;
      for (const f of walk(src)) if (f.endsWith(".ts") && !/\/testing(\/|\.ts$)|\.test\.ts$/.test(f)) out.push(f);
    }
  }
  return out;
}

export const rel = (abs) => relative(root, abs).replace(/\\/g, "/");

// --- rule 25: no await between the judgment and the first write -------------------------------------------------------------------------

/**
 * Rule-25 problems of one source. Two forms:
 * - a writer (repositories/commercial-outreach.ts): in every function, between its requireHeld(...) judgment and its first execute(...)
 *   write there is no `await`;
 * - a unit (a lane's handler, the dispatcher): the statement marked `b12:judge` (or, in the dispatcher, `b12:gate`) is followed by the
 *   statement marked `b12:write` (or `b12:submit`) with no `await` between them except the one on the marked write line. A unit that
 *   calls a writer or port.submit without the markers is a problem (fail closed); a NOT_BUILT stub has neither and is skipped.
 */
export function awaitProblems(file, text) {
  const code = stripTsComments(text.replace(/\/\*\s*(b12:\w+)\s*\*\//g, "__$1__")).replace(/__b12:(\w+)__/g, "/*b12:$1*/");
  const problems = [];
  if (/requireHeld\(/.test(code) && /function requireHeld/.test(code)) {
    const judgments = [...code.matchAll(/(?<!function )\brequireHeld\(/g)].length;
    const checked = [...code.matchAll(/(?<!function )\brequireHeld\([^;]*\);([\s\S]*?)\bexecute\(/g)];
    if (checked.length !== judgments) problems.push(`${file}: a requireHeld judgment with no write after it`);
    for (const m of checked) {
      if (/\bawait\b/.test(m[1].replace(/(const\s+\w+\s*=\s*)?await\s*$/, ""))) problems.push(`${file}: an await between a writer's requireHeld judgment and its first write`);
    }
    return problems;
  }
  const pairs = [
    ["judge", "write"],
    ["gate", "submit"],
  ];
  const calls = /\.(queueIntent|claimIntent|refuseQueued|answerIntent|acceptUncertain|observeUncertain|recordServiceActivity|recordPersonActivity|recordSuppression)\(|\.submit\(/.test(code);
  const marked = /\/\*b12:(judge|gate)\*\//.test(code);
  if (calls && !marked) problems.push(`${file}: writes or submits without b12:judge/b12:write (b12:gate/b12:submit) markers`);
  for (const [from, to] of pairs) {
    const re = new RegExp(`\\/\\*b12:${from}\\*\\/([\\s\\S]*?)\\n([^\\n]*\\/\\*b12:${to}\\*\\/)`, "g");
    const opened = [...code.matchAll(new RegExp(`\\/\\*b12:${from}\\*\\/`, "g"))].length;
    const closed = [...code.matchAll(re)];
    if (closed.length !== opened) problems.push(`${file}: a b12:${from} without its b12:${to}`);
    for (const m of closed) {
      const between = m[1].split("\n").slice(1).join("\n");
      if (/\bawait\b/.test(between)) problems.push(`${file}: an await between b12:${from} and b12:${to}`);
    }
  }
  return problems;
}

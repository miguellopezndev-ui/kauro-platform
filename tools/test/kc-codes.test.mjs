// Cell 28 (ledger [g6c-r2-kc-codes]): the KC codes of the migrations, the MAP, the SQLSTATE table and docs/design/KC-CODES.md agree.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAISE = /'([A-Z][A-Z0-9_]*):(?:[^']|'')*'[^;]*?ERRCODE\s*=\s*'(KC\d{3})'/g;

/** code -> Set of prefixes, judged on the last CREATE OR REPLACE of each function in migration order. */
export function raisedCodes(migrations) {
  const last = new Map();
  let anonymous = 0;
  for (const { text } of [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    for (const part of text.split(/(?=CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[\w."]+)/i)) {
      const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)/i.exec(part);
      last.set(m ? m[1] : `@anonymous${anonymous++}`, part);
    }
  }
  const codes = new Map();
  for (const part of last.values()) {
    for (const r of part.matchAll(RAISE)) {
      if (!codes.has(r[2])) codes.set(r[2], new Set());
      codes.get(r[2]).add(`${r[1]}:`);
    }
  }
  return codes;
}

export function parseRows(registry) {
  const rows = new Map();
  for (const line of registry.split(/\r?\n/)) {
    if (!/^\|\s*KC\d{3}\s*\|/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim().replace(/^`|`$/g, ""));
    rows.set(c[0], { prefix: c[1], mapCode: c[2], reason: c[3], name: c[4], lane: c[5], status: c[6] });
  }
  return rows;
}

export function check({ migrations, sqlstate, registry }) {
  const failures = [];
  const raised = raisedCodes(migrations);
  const rows = parseRows(registry);
  const owner = new Map();
  const names = new Map();
  for (const [code, prefixes] of [...raised].sort()) {
    if (prefixes.size !== 1) failures.push(`${code}: raised with ${prefixes.size} prefixes (${[...prefixes].join(", ")}); one prefix per code`);
    for (const p of prefixes) {
      if (owner.has(p) && owner.get(p) !== code) failures.push(`${p} is the prefix of both ${owner.get(p)} and ${code}`);
      owner.set(p, code);
    }
    const keys = [...sqlstate.matchAll(new RegExp(`^\\s+${code}: \\{ code: "(\\w+)"(?:, reason: "(\\w+)")?`, "gm"))];
    if (keys.length !== 1) failures.push(`${code}: ${keys.length} MAP keys; exactly one`);
    const values = [...sqlstate.matchAll(new RegExp(`^\\s+([A-Z_]+): "${code}",`, "gm"))];
    if (values.length !== 1) failures.push(`${code}: ${values.length} SQLSTATE values; exactly one`);
    const name = values[0]?.[1];
    if (name !== undefined) {
      if (names.has(name) && names.get(name) !== code) failures.push(`${code}: SQLSTATE name ${name} is also the name of ${names.get(name)}`);
      names.set(name, code);
    }
    const row = rows.get(code);
    if (row === undefined) {
      failures.push(`${code}: raised but has no KC-CODES.md row`);
      continue;
    }
    if (row.status !== "RAISED" && row.status !== "PLANNED") failures.push(`${code}: raised but its row is ${row.status}`);
    if (prefixes.size === 1 && !prefixes.has(row.prefix)) failures.push(`${code}: raised prefix ${[...prefixes][0]} differs from its row's ${row.prefix}`);
    if (keys.length === 1) {
      const reason = keys[0][2] ?? "-";
      if (reason !== row.reason) failures.push(`${code}: MAP reason ${reason} differs from its row's ${row.reason}`);
      if (keys[0][1] !== row.mapCode) failures.push(`${code}: MAP code ${keys[0][1]} differs from its row's ${row.mapCode}`);
    }
  }
  for (const [code, row] of rows) {
    if (row.status === "RAISED" && !raised.has(code)) failures.push(`${code}: row is RAISED but the migrations do not raise it`);
    if (row.status === "RESERVED" && raised.has(code)) failures.push(`${code}: RESERVED code is raised`);
  }
  return failures;
}

function load() {
  const dir = join(root, "packages/persistence/migrations");
  return {
    migrations: readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })),
    sqlstate: readFileSync(join(root, "packages/persistence/src/sqlstate.ts"), "utf8"),
    registry: readFileSync(join(root, "docs/design/KC-CODES.md"), "utf8"),
  };
}

const fn = (name, token, code) => `CREATE OR REPLACE FUNCTION kauro.${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '${token} detail %', 1 USING ERRCODE = '${code}'; END $$;\n`;
const SQLSTATE = `  CLAIM_ACCEPTED_PAST_DEADLINE: "KC021",\n  KC021: { code: "PRECONDITION_FAILED", reason: "CLAIM_EXPIRED" },\n`;
const row = (status, prefix = "CLAIM_EXPIRED:", code = "KC021") => `| ${code} | \`${prefix}\` | PRECONDITION_FAILED | CLAIM_EXPIRED | CLAIM_ACCEPTED_PAST_DEADLINE | x | ${status} |\n`;

describe("KC codes", () => {
  it("KC codes: each code raised in migrations has one message prefix, one MAP key, one SQLSTATE name and its KC-CODES.md row (prefix and reason); reserved codes are never raised", () => {
    assert.deepEqual(check(load()), []);
  });
  it("self-test (a): a second prefix for KC021 fails", () => {
    const f = check({ migrations: [{ name: "1.sql", text: fn("a", "CLAIM_EXPIRED:", "KC021") + fn("b", "COMMISSION_LOCK_ORDER:", "KC021") }], sqlstate: SQLSTATE, registry: row("RAISED") });
    assert.ok(f.some((x) => /KC021: raised with 2 prefixes/.test(x)), f.join("\n"));
  });
  it("self-test (b): a raised prefix differing from its row fails", () => {
    const f = check({ migrations: [{ name: "1.sql", text: fn("a", "CLAIM_EXPIRED:", "KC021") }], sqlstate: SQLSTATE, registry: row("RAISED", "CLAIM_LAPSED:") });
    assert.ok(f.some((x) => /raised prefix CLAIM_EXPIRED: differs from its row/.test(x)), f.join("\n"));
  });
  it("self-test (c): a superseded body with an old prefix passes", () => {
    const f = check({ migrations: [{ name: "1.sql", text: fn("a", "OLD_PREFIX:", "KC021") }, { name: "2.sql", text: fn("a", "CLAIM_EXPIRED:", "KC021") }], sqlstate: SQLSTATE, registry: row("RAISED") });
    assert.deepEqual(f, []);
  });
  it("self-test (d): a RESERVED code raised fails", () => {
    const f = check({ migrations: [{ name: "1.sql", text: fn("a", "CLAIM_EXPIRED:", "KC021") }], sqlstate: SQLSTATE, registry: row("RESERVED") });
    assert.ok(f.some((x) => /KC021: raised but its row is RESERVED/.test(x)) && f.some((x) => /RESERVED code is raised/.test(x)), f.join("\n"));
  });
});

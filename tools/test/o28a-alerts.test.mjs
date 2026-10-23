// O28A: the declared alert rules fire on the api's real failure lines (verbatim from the continuity run's stderr), once per episode, and
// stay quiet on a healthy stream; every rule's pattern matches a line the shipped source writes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, loadRules, parseLog } from "../ci/alerts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const T0 = Date.UTC(2026, 9, 22, 22);
const at = (s) => T0 + s * 1000;

test("a database outage pages once, its pool errors open a ticket, and a new episode after a quiet window pages again", () => {
  const rules = loadRules();
  const outage = [
    { at: at(0), line: "kauro-db pool=kauro-api idle connection error class=DatabaseError code=57P01" },
    ...[1, 2, 3, 4, 5, 6].map((s) => ({ at: at(s), line: `kauro-api unavailable correlation=01a1668e-cf96-7cfd-9115-7f1d92f5938${s} code=CAPACITY_UNAVAILABLE cause=DatabaseError code=28000` })),
    ...[7, 8, 9, 10].map((s) => ({ at: at(s), line: "kauro-db pool=kauro-api in-use connection error class=Error" })),
  ];
  assert.deepEqual(evaluate(rules, outage).map((a) => [a.id, a.severity, a.count]), [["API_DATABASE_UNAVAILABLE", "page", 3], ["DB_POOL_CONNECTION_ERRORS", "ticket", 5]]);
  const continuing = [...outage, ...[20, 30, 40].map((s) => ({ at: at(s), line: "kauro-api unavailable correlation=x code=CAPACITY_UNAVAILABLE" }))];
  assert.equal(evaluate(rules, continuing).filter((a) => a.id === "API_DATABASE_UNAVAILABLE").length, 1, "one episode, one page");
  const later = [...outage, ...[200, 201, 202].map((s) => ({ at: at(s), line: "kauro-api unavailable correlation=y code=CAPACITY_UNAVAILABLE" }))];
  assert.equal(evaluate(rules, later).filter((a) => a.id === "API_DATABASE_UNAVAILABLE").length, 2, "a new episode pages again");
});

test("an internal error pages at once; a healthy stream fires nothing; events out of order are refused", () => {
  const rules = loadRules();
  assert.deepEqual(evaluate(rules, [{ at: at(0), line: "kauro-api internal error correlation=abc class=TypeError" }]).map((a) => a.id), ["API_INTERNAL_ERROR"]);
  assert.deepEqual(evaluate(rules, parseLog(["2026-10-22T22:00:00Z kauro-api drained and closed", "2026-10-22T22:00:01Z GET /readyz 200"].join("\n"))), []);
  assert.throws(() => evaluate(rules, [{ at: at(2), line: "x" }, { at: at(1), line: "y" }]), /time order/);
});

test("every rule matches a line the shipped api or persistence source writes", () => {
  const sources = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) sources.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(root, "apps", "api", "src"));
  walk(join(root, "packages", "persistence", "src"));
  const text = sources.join("\n");
  for (const r of loadRules()) {
    const literal = r.pattern.replace(/^\^/, "").split(/\\S\+|\(|\\/)[0].trim();
    assert.ok(literal.length >= 9 && text.includes(literal), `${r.id}: "${literal}" is written by the shipped source`);
  }
});

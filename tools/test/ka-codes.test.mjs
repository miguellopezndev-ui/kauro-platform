// SQLSTATE reservations (packages/persistence/src/sqlstate.ts): every KA/KP/KC value of the SQLSTATE object is unique, and KA085..KA094 are
// reserved for B16 lanes L2..L8 by name, so two lanes never pick one code; KA095..KA098 are package B12's (migration 0072, plan §3).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "packages", "persistence", "src", "sqlstate.ts"), "utf8");
const block = src.slice(src.indexOf("export const SQLSTATE"), src.indexOf("});", src.indexOf("export const SQLSTATE")));
const entries = [...block.matchAll(/^\s*([A-Z0-9_]+):\s*"([A-Z0-9]{5})",/gm)].map((m) => [m[1], m[2]]);

test("every SQLSTATE name and value is unique", () => {
  assert.ok(entries.length > 40);
  assert.equal(new Set(entries.map((e) => e[0])).size, entries.length, "a name is declared twice");
  assert.equal(new Set(entries.map((e) => e[1])).size, entries.length, "a value is declared twice");
});

test("B16 reserves exactly KA085..KA094, named by lane L2..L8, and no other name holds a code in KA085..KA094", () => {
  const reserved = entries.filter(([name]) => name.startsWith("B16_"));
  assert.deepEqual(reserved.map((e) => e[1]).sort(), Array.from({ length: 10 }, (_, i) => `KA0${85 + i}`));
  for (const [name] of reserved) assert.match(name, /^B16_L[2-8]_[A-Z_]+$/, name);
  const lanes = new Set(reserved.map(([name]) => name.slice(4, 6)));
  assert.deepEqual([...lanes].sort(), ["L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  for (const [name, value] of entries) {
    if (/^KA\d{3}$/.test(value) && value > "KA084" && value < "KA095") assert.ok(name.startsWith("B16_"), `${name} = ${value} is outside the B16 reservation`);
  }
});

test("B12 holds exactly KA095..KA098 (OUTREACH_BINDING, SEND_FENCE, ACTIVITY_EVIDENCE, OUTREACH_SUPPRESSION_SCOPE) and nothing holds a code above KA098", () => {
  const b12 = entries.filter(([, value]) => /^KA\d{3}$/.test(value) && value >= "KA095");
  assert.deepEqual(b12, [["OUTREACH_BINDING", "KA095"], ["SEND_FENCE", "KA096"], ["ACTIVITY_EVIDENCE", "KA097"], ["OUTREACH_SUPPRESSION_SCOPE", "KA098"]]);
});

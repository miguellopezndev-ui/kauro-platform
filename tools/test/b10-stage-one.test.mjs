// B10 stage 1 is one implementation (the `b10/stage-1` integrator; docs/design/B10-commercial-domain.md §12, D10-ERR-1,
// D10-STAGE-1). The schema mandates raise class-KC SQLSTATEs whose translation the stage-2 lanes add to sqlstate.ts, into reasons
// B10-MODEL registered beside them; merged, the codes migrations 0028..0031 raise are exactly the codes §12 names, each §12 name is a
// registered commercial failure reason, and each code is translated by exactly one stage-2 mandate whose task names it. It reads the
// built domain package (`pnpm run verify` builds before it tests).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("B10 stage 1 is one error contract: the KC codes migrations 0028..0031 raise are exactly section 12's, each named by a registered commercial failure reason and translated by exactly one stage-2 mandate that names it", async () => {
  const dir = join(root, "packages", "persistence", "migrations");
  const raised = new Set();
  for (const file of readdirSync(dir).filter((f) => /^00(28|29|30|31)_/.test(f))) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(/ERRCODE = '(KC\d{3})'/g)) raised.add(m[1]);
  }

  const design = read("docs", "design", "B10-commercial-domain.md");
  const section = design.slice(design.indexOf("## 12. Error contract"), design.indexOf("## 13. "));
  const named = new Map([...section.matchAll(/\b(KC\d{3})\s+([A-Z][A-Z_]+[A-Z])\b/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual([...raised].sort(), [...named.keys()].sort(), "the raised codes are section 12's");

  const { COMMERCIAL_FAILURE_REASONS, FAILURE_REASONS } = await import(pathToFileURL(join(root, "packages", "domain", "dist", "src", "index.js")).href);
  for (const [code, reason] of named) {
    assert.ok(COMMERCIAL_FAILURE_REASONS.includes(reason), `${code} ${reason} is a commercial failure reason (D10-ERR-1)`);
    assert.ok(FAILURE_REASONS.includes(reason), `${code} ${reason} is registered in FAILURE_REASONS`);
  }

  // "... by the stage-2 mandate whose adapter surfaces the code (ADAPTERS-RECURRENCE KC001, KC014; AGENCY-LIFECYCLE KC006; ...)"
  const owners = section.slice(section.indexOf("whose adapter surfaces the code"));
  const translated = new Map();
  for (const m of owners.matchAll(/([A-Z]+-[A-Z]+) ((?:KC\d{3}(?:,\s*)?)+)/g)) {
    for (const code of m[2].split(/,\s*/).filter(Boolean)) {
      assert.ok(!translated.has(code), `${code} is translated by one mandate`);
      translated.set(code, `B10-${m[1]}`);
    }
  }
  assert.deepEqual([...translated.keys()].sort(), [...named.keys()].sort(), "every code has its translating mandate");
  const mandates = JSON.parse(read("docs", "design", "B10-mandates.json")).mandates;
  for (const [code, key] of translated) {
    const mandate = mandates.find((m) => m.key === key);
    assert.ok(mandate !== undefined && mandate.stage === 2, `${key} is a stage-2 mandate`);
    assert.match(mandate.task, new RegExp(`\\b${code}\\b[^.]*sqlstate\\.ts|translations? of [^.]*\\b${code}\\b`), `${key}'s task names the translation of ${code}`);
  }
});

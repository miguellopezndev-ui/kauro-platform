// The two CMD035 rows of the await table (docs/design/B15-B17-B18-local-plan.md section 4, rules r15/r25; package B15 lane L6):
// the intent judges at effectNowOf and writes VALIDATED -> SUBMITTING with no await between; the reconciler reads observedFrom before
// its first page (R2-084: an absence is judged from the instant the observation began, never from after the pages were read).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { checkAwaitTable, checkRow } from "../lib/await-table-check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = "packages/application/src/commerce/core/fiscal-issuance.ts";
const INTENT_ROW = { file: FILE, clockCall: "effectNowOf", effectCall: "docs.markSubmitting" };
const source = readFileSync(join(root, FILE), "utf8");

/** The positions of the calls named `name` inside the function declaration `fn` (nested arrows included). */
function callPositions(text, fn, name) {
  const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true);
  let target = null;
  const find = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fn) target = n;
    ts.forEachChild(n, find);
  };
  find(sf);
  assert.ok(target !== null, `${fn} is declared in ${FILE}`);
  const out = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && (n.expression.getText() === name || n.expression.getText().endsWith(`.${name}`))) out.push(n.getStart());
    ts.forEachChild(n, walk);
  };
  walk(target);
  return out;
}

test("CMD035 await table: no await between the intent's effectNowOf and docs.markSubmitting", () => {
  assert.deepEqual(checkAwaitTable([INTENT_ROW], { root }), []);
});

test("CMD035 await table control: an await planted between the intent's clock read and its effect is refused", () => {
  const planted = source.replace("const packet = route.prepare(", "await Promise.resolve();\n  const packet = route.prepare(");
  assert.notEqual(planted, source, "the plant point exists");
  assert.ok(checkRow(INTENT_ROW, planted).length > 0, "the planted await is reported");
});

test("R2-084 await table: the reconciler reads observedFrom (effectNowOf) before its first page (observe)", () => {
  const clock = callPositions(source, "reconcileTaxDocument", "effectNowOf");
  const pages = callPositions(source, "reconcileTaxDocument", "observe");
  assert.equal(clock.length, 1, "one clock read in the reconciler");
  assert.equal(pages.length, 1, "one observation in the reconciler");
  assert.ok(clock[0] < pages[0], "observedFrom is read before the pages");
  // the page loop itself reads no clock: absence is judged against the instant read first
  assert.deepEqual(callPositions(source, "observe", "effectNowOf"), []);
});

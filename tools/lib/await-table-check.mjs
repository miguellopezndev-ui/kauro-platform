// Static check of the B15/B17/B18 await table (docs/design/B15-B17-B18-local-plan.md section 4, rules r15/r25): between the clock read of a
// time judgment and the effect it guards there is no `await`, so the judged instant cannot go stale while the handler waits. A row is
// {file, clockCall, effectCall}; both are callee names matched on the last dotted segments (`effectNowOf`, `store.recordContinuation`).
// For each clock call the check takes the next effect call in the same function and refuses every `await` that lies between them,
// except the `await` that is the effect call itself (its own statement). An `await` inside the effect's arguments runs before the effect
// and is refused. A row whose clock call or effect call is not found, or has no effect after the clock, is a violation: a stale row never passes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const calleeText = (call) => call.expression.getText();
const matches = (call, name) => {
  const text = calleeText(call).replace(/\?\./g, ".").replace(/\s+/g, "");
  return text === name || text.endsWith(`.${name}`);
};
const unwrap = (node) => {
  let n = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent))) n = n.parent;
  return n;
};
const isOwnAwait = (aw, call) => {
  // the await whose operand is the call (through parentheses, `!` and `as`)
  let e = aw.expression;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  return e === call;
};
const enclosingFunction = (node) => {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) && n.body) return n;
  return null;
};

/** Violations of one row over source text: [] when no await separates a clock call from the next effect call of its function. */
export function checkRow(row, text) {
  const sf = ts.createSourceFile(row.file, text, ts.ScriptTarget.Latest, true, row.file.endsWith(".mjs") || row.file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const calls = [];
  const awaits = [];
  const walk = (n) => {
    if (ts.isCallExpression(n)) calls.push(n);
    if (ts.isAwaitExpression(n)) awaits.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const clocks = calls.filter((c) => matches(c, row.clockCall));
  if (clocks.length === 0) return [`${row.file}: clock call ${row.clockCall} not found`];
  const out = [];
  let paired = 0;
  for (const clock of clocks) {
    const fn = enclosingFunction(clock);
    const effect = calls
      .filter((c) => matches(c, row.effectCall) && enclosingFunction(c) === fn && c.getStart(sf) >= clock.getEnd())
      .sort((a, b) => a.getStart(sf) - b.getStart(sf))[0];
    if (!effect) continue;
    paired++;
    for (const aw of awaits) {
      if (enclosingFunction(aw) !== fn) continue;
      if (aw.getStart(sf) < clock.getEnd() || aw.getEnd() > effect.getEnd()) continue;
      if (isOwnAwait(aw, effect)) continue;
      out.push(`${row.file}:${line(aw)}: await between ${row.clockCall} (line ${line(clock)}) and ${row.effectCall} (line ${line(effect)})`);
    }
  }
  if (paired === 0) out.push(`${row.file}: no ${row.effectCall} call follows ${row.clockCall} in its function`);
  return out;
}

/** The violations of every row of a table, reading each file under `root`. */
export function checkAwaitTable(rows, { root = process.cwd(), read = (p) => readFileSync(p, "utf8") } = {}) {
  return rows.flatMap((row) => checkRow(row, read(join(root, row.file))));
}

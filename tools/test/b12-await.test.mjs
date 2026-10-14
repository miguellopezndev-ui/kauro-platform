// Rule 25 (docs/design/FAILURE-MATRIX-TEMPLATE.md; plan docs/design/B12-outreach-plan.md §W; lane K1): in every B12 unit there is no
// await between the judgment statement and the first write, and none between D3's gate statement and port.submit. Writers
// (repositories/commercial-outreach.ts): nothing awaited between requireHeld and the first execute. Units (handlers, the dispatcher):
// the b12:judge / b12:write (b12:gate / b12:submit) markers, with no await between them; a unit that writes or submits without them fails.
import assert from "node:assert/strict";
import test from "node:test";
import { awaitProblems, b12Sources, read } from "./b12-static.mjs";

const TITLE = "B12 units: no await between the judgment statement and the first write (and between D3's gate and port.submit); a planted await in a copy of dispatcher.ts fails";

const DISPATCHER = "apps/api/src/outreach/dispatcher.ts";
const gated = (between) =>
  `${read(DISPATCHER)}
export async function d3(port, gate, submission, signal) {
  const ok = /* b12:gate */ await gate(submission.intentId);
  if (!ok) return null;${between}
  return /* b12:submit */ await port.submit(submission, signal);
}
`;

test(TITLE, () => {
  assert.deepEqual(b12Sources().flatMap((f) => awaitProblems(f, read(f))), []);
  assert.deepEqual(awaitProblems(DISPATCHER, gated("")), [], "a gate followed by the submit with no await between passes");
  assert.ok(awaitProblems(DISPATCHER, gated("\n  await refresh(submission);")).some((p) => /b12:gate and b12:submit/.test(p)), "a planted await between the gate and the submit fails");
  assert.ok(awaitProblems(DISPATCHER, `${read(DISPATCHER)}\nexport const go = (port, s, sig) => port.submit(s, sig);\n`).some((p) => /without/.test(p)), "a submit without the markers fails closed");
  const writers = "packages/persistence/src/repositories/commercial-outreach.ts";
  const planted = read(writers).replace(/(requireHeld\(locks, "suppression"[^;]*;)/, "$1\n    await Promise.resolve();");
  assert.notEqual(planted, read(writers));
  assert.ok(awaitProblems(writers, planted).some((p) => /requireHeld/.test(p)), "a planted await between a writer's judgment and its write fails");
});

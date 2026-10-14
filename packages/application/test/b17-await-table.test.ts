// The B17 await table (docs/design/B15-B17-B18-local-plan.md section 4, rules r15/r25): in each time-judging handler the effect clock is
// read after the last await (`effectNowOf`, kauro.effect_now()), and nothing is awaited between that read and the effect it guards, so the
// judged instant cannot go stale while the handler waits on a lock. The check is the L0 kit's static one (tools/lib/await-table-check.mjs);
// each row is green on the handler as built and red with an `await` planted right after its clock read (the row's control).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

interface Row {
  readonly file: string;
  readonly clockCall: string;
  readonly effectCall: string;
}
type CheckRow = (row: Row, text: string) => ReadonlyArray<string>;

function repoRoot(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
  }
  throw new Error("the repository root (pnpm-workspace.yaml) was not found above the test");
}
const ROOT = repoRoot();
const checkRow = async (): Promise<CheckRow> => ((await import(pathToFileURL(join(ROOT, "tools/lib/await-table-check.mjs")).href)) as { checkRow: CheckRow }).checkRow;

const H = "packages/application/src";
/** Section 4's rows SSR through EXP: the file, its clock read and the effect the judgment guards. */
const ROWS: ReadonlyArray<{ readonly id: string; readonly row: Row }> = [
  { id: "SSR append", row: { file: `${H}/audit/handlers/submit-stage-receipt.ts`, clockCall: "effectNowOf", effectCall: "importStages.appendReceipt" } },
  { id: "SSR reconciliation", row: { file: `${H}/audit/handlers/submit-stage-receipt.ts`, clockCall: "effectNowOf", effectCall: "importStages.openReconciliation" } },
  { id: "CST", row: { file: `${H}/audit/handlers/continue-stage.ts`, clockCall: "effectNowOf", effectCall: "importStages.recordContinuation" } },
  { id: "CTC", row: { file: `${H}/audit/handlers/confirm-target-contract.ts`, clockCall: "effectNowOf", effectCall: "targetContracts.supersede" } },
  { id: "CRT", row: { file: `${H}/audit/handlers/create-target-contract.ts`, clockCall: "effectNowOf", effectCall: "targetContracts.createDraft" } },
  { id: "STA", row: { file: `${H}/audit/handlers/start-audit.ts`, clockCall: "effectNowOf", effectCall: "audits.startAudit" } },
  { id: "EXP", row: { file: `${H}/execution/handlers/execute-project.ts`, clockCall: "effectNowOf", effectCall: "x.queueJob" } },
];

/** The handler text with `await Promise.resolve();` planted on the line after its (single) clock read. */
function planted(text: string, clockCall: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(`${clockCall}(`));
  assert.ok(at >= 0, `the clock read ${clockCall} is in the handler`);
  assert.equal(lines.filter((l) => l.includes(`${clockCall}(`)).length, 1, `one clock read of ${clockCall} in the handler`);
  return [...lines.slice(0, at + 1), "          await Promise.resolve();", ...lines.slice(at + 1)].join("\n");
}

for (const { id, row } of ROWS) {
  test(`B17 await table ${id}: no await between ${row.clockCall} and ${row.effectCall}; the planted await is red`, async () => {
    const check = await checkRow();
    const text = readFileSync(join(ROOT, row.file), "utf8");
    assert.deepEqual(check(row, text), [], `${id}: the handler as built keeps the clock read after its last await`);
    const red = check(row, planted(text, row.clockCall));
    assert.equal(red.length, 1, `${id}: the planted await is reported (${red.join(" | ")})`);
    assert.match(red[0] as string, new RegExp(`await between ${row.clockCall}`));
  });
}

test("B17 await table: the six moved judgments read no serverInstant (section 2 clock sources)", () => {
  for (const { row } of ROWS) {
    const text = readFileSync(join(ROOT, row.file), "utf8");
    assert.ok(!/\bserverInstant\(/.test(text), `${row.file} reads no serverInstant`);
    assert.ok(!/\bDate\.now\(|\bnew Date\(/.test(text), `${row.file} reads no process clock`);
  }
});

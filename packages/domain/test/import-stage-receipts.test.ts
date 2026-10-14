// The pure half of CMD040's receipt rules (B17 L1; R2-023, R2-024): the stage correlation key a receipt row carries back, the parent edges
// that block a child source, and the validation of a receipt against the stage's exact membership with blocked children. The correlation
// oracle below is written from the preimage rules (HASHING_AND_ACCOUNTING_RULES: closed wrapper under the canonical profile), not from
// the product function.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalBytes, type Sha256Hex } from "@kauro/contracts";
import { blockedChildSources, parseStageReceipt, receiptOfAnotherStage, stageCorrelationKey, validateStageReceipt, type ReceiptMappingRow } from "../src/index.js";

const oracle = (stageId: string, packageHash: string, sourceId: string): string =>
  createHash("sha256").update(canonicalBytes({ domain: "KAURO_STAGE_CORRELATION_V1", version: 1, payload: { stageId, packageHash, sourceId } })).digest("hex");
const PKG = "a".repeat(64) as Sha256Hex;
const STAGE = "0190a000-0000-7000-8000-000000000001";
const OTHER = "0190a000-0000-7000-8000-000000000002";

test("R2-024: the stage correlation key is KAURO_STAGE_CORRELATION_V1 over {stageId, packageHash, sourceId}; another stage's key never matches", () => {
  assert.equal(stageCorrelationKey(STAGE, PKG, "src-1"), oracle(STAGE, PKG, "src-1"));
  const rows = (stage: string) => ({ rows: ["src-1", "src-2"].map((s) => ({ sourceId: s, status: "MATCHED", targetId: `crm-${s}`, correlationKey: oracle(stage, PKG, s) })) });
  const own = parseStageReceipt(rows(STAGE));
  const foreign = parseStageReceipt(rows(OTHER));
  assert.ok(own && foreign);
  assert.equal(receiptOfAnotherStage({ stageId: STAGE, packageHash: PKG }, own), false, "OK: the stage's own receipt");
  assert.equal(receiptOfAnotherStage({ stageId: STAGE, packageHash: PKG }, foreign), true, "DENY: a receipt of another stage with the same rows");
});

test("R2-024: DENY a row without its correlation key, or with a key that is not a digest; OK with it", () => {
  assert.equal(parseStageReceipt({ rows: [{ sourceId: "src-1", status: "FAILED" }] }), null);
  assert.equal(parseStageReceipt({ rows: [{ sourceId: "src-1", status: "FAILED", correlationKey: "not-a-digest" }] }), null);
  assert.deepEqual(parseStageReceipt({ rows: [{ sourceId: "src-1", status: "FAILED", correlationKey: oracle(STAGE, PKG, "src-1") }] })?.rows.length, 1);
});

test("R2-023: a child source is admitted iff every edge of it is MATCHED in the parent's latest mapping; a parent with no receipt blocks every edge", () => {
  const parent: ReceiptMappingRow[] = [
    { sourceId: "p-1", disposition: "MATCHED", targetId: "crm-p1" },
    { sourceId: "p-2", disposition: "FAILED" },
    { sourceId: "p-3", disposition: "UNRESOLVED" },
  ];
  const edges = [
    { childSourceId: "c-1", parentStageId: "P", parentSourceId: "p-1" },
    { childSourceId: "c-2", parentStageId: "P", parentSourceId: "p-2" },
    { childSourceId: "c-3", parentStageId: "P", parentSourceId: "p-3" },
    { childSourceId: "c-4", parentStageId: "P", parentSourceId: "p-1" },
    { childSourceId: "c-4", parentStageId: "Q", parentSourceId: "q-1" },
  ];
  assert.deepEqual([...blockedChildSources(edges, new Map([["P", parent]]))].sort(), ["c-2", "c-3", "c-4"]);
  assert.deepEqual([...blockedChildSources(edges.slice(0, 1), new Map([["P", parent]]))], [], "OK: the matched edge binds");
});

test("R2-023: DENY a receipt claiming MATCHED for a blocked child (CHILD_EDGE_BLOCKED); OK a blocked child reported FAILED or omitted is BLOCKED_BY_PARENT and counts as failed", () => {
  const row = (sourceId: string, status: "MATCHED" | "FAILED") => ({ sourceId, status, ...(status === "MATCHED" ? { targetId: `crm-${sourceId}` } : {}), correlationKey: oracle(STAGE, PKG, sourceId) });
  const blocked = new Set(["c-2"]);
  const claimed = parseStageReceipt({ rows: [row("c-1", "MATCHED"), row("c-2", "MATCHED")] });
  assert.ok(claimed);
  assert.deepEqual(validateStageReceipt(["c-1", "c-2"], claimed, blocked), { kind: "CHILD_EDGE_BLOCKED", sourceIds: ["c-2"] });
  for (const rows of [[row("c-1", "MATCHED"), row("c-2", "FAILED")], [row("c-1", "MATCHED")]]) {
    const parsed = parseStageReceipt({ rows });
    assert.ok(parsed);
    const v = validateStageReceipt(["c-1", "c-2"], parsed, blocked);
    assert.equal(v.kind, "VALIDATED");
    if (v.kind !== "VALIDATED") return;
    assert.deepEqual(v.mapping, [{ sourceId: "c-1", disposition: "MATCHED", targetId: "crm-c-1" }, { sourceId: "c-2", disposition: "BLOCKED_BY_PARENT" }]);
    assert.deepEqual([v.matchedRows, v.failedRows, v.unresolvedRows, v.result], [1, 1, 0, "PARTIAL_ACCOUNTED"]);
  }
});

// D-33 (commercial scope 2026-10-13; companion docs/design/B12-outreach-plan-cells.md §S; lane K1): no B12 source reads a segment or a
// buyer type, names an AGENCY/COMPANY literal in a rule, cap, copy or fixture, or orders prospects or evidence by any attribute but
// id/created_at. The same scanner refuses a planted copy of a B12 file.
import assert from "node:assert/strict";
import test from "node:test";
import { B12_MIGRATION, b12Sources, d33Problems, read } from "./b12-static.mjs";

const TITLE = "D-33: no B12 file reads segment or buyer type, names AGENCY/COMPANY literals in a rule, cap, copy or fixture, or orders prospects or evidence by any attribute but id/created_at; a planted ORDER BY segment and a planted 'AGENCY' cap in a copy of a B12 file each fail";

test(TITLE, () => {
  const files = [...b12Sources(), B12_MIGRATION];
  assert.ok(files.length > 30, `the B12 file set is scanned (${files.length} files)`);
  assert.deepEqual(files.flatMap((f) => d33Problems(f, read(f))), []);
  const writers = "packages/persistence/src/repositories/commercial-outreach.ts";
  const plantedOrder = read(writers).replace("export class PgOutreachWriters {", 'const RANKED = "SELECT prospect_id FROM kauro.prospects ORDER BY segment, prospect_id";\nexport class PgOutreachWriters {');
  assert.notEqual(plantedOrder, read(writers));
  assert.ok(d33Problems(writers, plantedOrder).some((p) => /orders/.test(p)), "a planted ORDER BY segment is refused");
  const runtime = "packages/application/src/commercial/outreach/runtime.ts";
  const plantedCap = `${read(runtime)}\nexport const CAP = Object.freeze({ kind: 'AGENCY', perDay: 5 });\n`;
  assert.ok(d33Problems(runtime, plantedCap).some((p) => /AGENCY\/COMPANY literal/.test(p)), "a planted 'AGENCY' cap is refused");
  const plantedSql = `${read(B12_MIGRATION)}\nSELECT e.evidence_id FROM kauro.prospect_source_evidence e ORDER BY e.observed_on DESC;\n`;
  assert.ok(d33Problems(B12_MIGRATION, plantedSql).some((p) => /orders prospects or evidence by e\.observed_on/.test(p)), "evidence ordered by an attribute is refused");
});

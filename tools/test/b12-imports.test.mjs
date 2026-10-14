// B12 import and grant boundary (plan §0 A17, companion docs/design/B12-outreach-plan-cells.md §S; lane K1): B12 sources import only the
// exact allowlist (no tenant data-plane, staging, target adapter, connector or CRM write module; a non-literal import fails closed), and
// role kauro_outreach holds no grant on any table with an agency_id column (static census of every migration; the live census is
// persistence/test/b12-outreach-migrations.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { agencyTables, b12Sources, grantedTables, importProblems, migrationTexts, read } from "./b12-static.mjs";

const TITLE = "B12 imports no tenant data-plane, staging, target adapter, connector or CRM write module, and kauro_outreach holds no grant on any table with agency_id; a planted import of @kauro/data-plane fails";

test(TITLE, () => {
  const files = b12Sources();
  assert.deepEqual(files.flatMap((f) => importProblems(f, read(f))), []);
  const migrations = migrationTexts();
  const agency = agencyTables(migrations);
  assert.ok(agency.has("commercial_transitions"), "the agency_id census reads the migrations");
  const granted = grantedTables(migrations, "kauro_outreach");
  assert.ok(granted.has("outreach_send_intents") && granted.has("leases"), "the grant census reads the kauro_outreach grants");
  assert.deepEqual([...granted].filter((t) => agency.has(t)), [], "kauro_outreach holds no grant on an agency_id table");
  const target = "packages/application/src/commercial/outreach/send.ts";
  assert.ok(importProblems(target, `import { x } from "@kauro/data-plane";\n${read(target)}`).some((p) => /@kauro\/data-plane/.test(p)), "a planted import of @kauro/data-plane is refused");
  assert.ok(importProblems(target, `${read(target)}\nconst m = await import(moduleName);\n`).some((p) => /not a literal/.test(p)), "a non-literal dynamic import fails closed");
  assert.ok(importProblems(target, `export * from "@kauro/persistence/testing";\n${read(target)}`).length > 0, "a re-export from a testing subpath is refused");
  const plantedGrant = [...migrations, "GRANT SELECT ON kauro.commercial_transitions TO kauro_outreach;"];
  assert.ok(grantedTables(plantedGrant, "kauro_outreach").has("commercial_transitions"), "a planted grant on an agency_id table is seen");
});

// The six B07 command specs and their request schemas against the vendored catalogue (registry/commands.json through
// @kauro/contracts COMMANDS), and the selection manifest document schema under the strict compiler every request goes through:
// closed objects, no coercion, no defaults, only the keyword vocabulary the validator enforces (R2-058, R2-059, S093).
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { B07_COMMANDS, REQUEST_SCHEMA_PREFIX, SELECTION_MANIFEST_SCHEMA, SELECTION_MANIFEST_SCHEMA_ID, SOURCE_REQUEST_SCHEMAS, SOURCE_REQUEST_SCHEMA_IDS, SOURCE_ROUTES, compileSchemaBundle } from "../src/index.js";

const IN_SCOPE = ["CMD012", "CMD013", "CMD014", "CMD015", "CMD016", "CMD017"] as const;

test("every B07 spec matches the catalogue entry: method, path, role, fields in order, gate G-UPLOAD, idempotency REQUIRED", () => {
  for (const id of IN_SCOPE) {
    const catalogue = COMMANDS.find((c) => c.id === id);
    assert.ok(catalogue, id);
    const spec = B07_COMMANDS[id];
    assert.equal(spec.id, catalogue.id);
    assert.equal(spec.name, catalogue.name);
    assert.equal(spec.method, catalogue.method);
    assert.equal(spec.path, catalogue.path);
    assert.equal(spec.role, catalogue.role);
    assert.deepEqual([...spec.fields], catalogue.fields.map((f) => f.name), `${id} fields`);
    assert.equal(catalogue.idempotency, "REQUIRED");
    assert.equal(catalogue.gate, "G-UPLOAD");
    assert.equal(catalogue.owner, "09");
    assert.deepEqual([...(catalogue.testIds ?? [])], [`${id}-OK`, `${id}-DENY`, `${id}-RACE`]);
    // every B07 route names its aggregate in the path and takes the agency selector from the header (D-SCOPE-1)
    assert.equal(spec.scope, "AGENCY_HEADER", id);
    assert.ok(spec.aggregateParam && spec.path.includes(`{${spec.aggregateParam}}`), id);
    assert.equal(spec.expectedVersionRequired, catalogue.fields.some((f) => f.name === "expectedVersion"), `${id} expectedVersion`);
    assert.equal(spec.stepUpRequired, false, `${id} names no assuranceProofRef`);
  }
});

test("B07 request schemas are closed 2020-12 objects whose properties are exactly the catalogue fields, typed by the field vocabulary", () => {
  const typeOf: Record<string, string> = { label: "string", id: "string", version: "integer", hash: "string", count: "integer", text: "string" };
  for (const id of IN_SCOPE) {
    const catalogue = COMMANDS.find((c) => c.id === id)!;
    const s = SOURCE_REQUEST_SCHEMAS[id];
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(s.$id, `${REQUEST_SCHEMA_PREFIX}${id}`);
    assert.equal(s.additionalProperties, false, `${id} must reject unknown fields (R2-059)`);
    assert.deepEqual(Object.keys(s.properties), catalogue.fields.map((f) => f.name), `${id} properties`);
    assert.deepEqual([...s.required], catalogue.fields.map((f) => f.name), `${id}: every catalogue field is required`);
    for (const f of catalogue.fields) {
      const p = s.properties[f.name]!;
      assert.equal(p["type"], typeOf[f.type], `${id}.${f.name} (${f.type})`);
      assert.ok(!("default" in p), `${id}.${f.name} must not default`);
      if (f.type === "version") assert.equal(p["minimum"], 1);
      if (f.type === "count") assert.equal(p["minimum"], 0);
      if (f.type === "hash") assert.equal(p["pattern"], "^[0-9a-f]{64}$");
    }
  }
  assert.deepEqual(SOURCE_REQUEST_SCHEMAS.CMD013.properties["declaredFormat"]!["enum"], ["CSV", "XLSX"]);
  assert.equal(SOURCE_REQUEST_SCHEMA_IDS.length, IN_SCOPE.length);
  const forbidden = ["verified", "admitted", "scanState", "state", "agencyId", "version", "sha256", "manifestHash", "observedGeneration", "bytes"];
  for (const s of Object.values(SOURCE_REQUEST_SCHEMAS)) for (const f of forbidden) assert.ok(!(f in s.properties), `${s.$id} exposes server-owned ${f}`);
});

test("the B07 schemas compile under the strict validator; unknown members, coercible strings and oversized manifests are refused", () => {
  const roots: Record<string, unknown> = { [SELECTION_MANIFEST_SCHEMA_ID]: SELECTION_MANIFEST_SCHEMA };
  for (const [command, schema] of Object.entries(SOURCE_REQUEST_SCHEMAS)) roots[`${REQUEST_SCHEMA_PREFIX}${command}`] = schema;
  const compiled = compileSchemaBundle({ defs: {}, roots });
  const reserve = `${REQUEST_SCHEMA_PREFIX}CMD013`;
  const valid = { expectedVersion: 2, declaredBytes: 1024, declaredFormat: "CSV", displayName: "contacts.csv" };
  assert.deepEqual(compiled.validate(reserve, valid), []);
  assert.deepEqual(compiled.validate(reserve, { ...valid, declaredBytes: "1024" }).map((e) => e.code), ["TYPE"], "no coercion of a numeric string");
  assert.deepEqual(compiled.validate(reserve, { ...valid, admitted: true }).map((e) => [e.field, e.code]), [["admitted", "UNKNOWN_FIELD"]], "a browser cannot set admission (FileManifest.admitted)");
  assert.deepEqual(compiled.validate(reserve, { ...valid, declaredFormat: "PDF" }).map((e) => e.code), ["ENUM"]);
  assert.ok(compiled.validate(`${REQUEST_SCHEMA_PREFIX}CMD014`, { providerCompletionRef: "x".repeat(4097) }).length > 0);
  const revisionId = "0190c7a2-0000-7000-8000-000000000001";
  const fileId = "0190c7a2-0000-7000-8000-000000000002";
  const tableId = "0190c7a2-0000-7000-8000-000000000003";
  const manifest = {
    schemaVersion: 1,
    revisionId,
    inventoryHash: "a".repeat(64),
    files: [{ fileId, origin: "THIS_REVISION", disposition: "INCLUDE" }],
    tables: [
      {
        tableId,
        fileId,
        structureHash: "b".repeat(64),
        disposition: "INCLUDE",
        hiddenSheetAcknowledged: true,
        parser: { kind: "WORKSHEET", header: { mode: "ROW", rowIndex: 0 }, formulas: "REJECT_FORMULAS", hiddenRows: "EXCLUDE", hiddenColumns: "EXCLUDE", mergedCells: "AS_OBSERVED" },
        selectedColumns: [0, 1, 2],
      },
    ],
    projections: [{ projectionKey: "CONTACTS", tableId, objectKind: "CONTACT", kind: "ROW", fieldOrdinals: [0, 1] }],
    associations: [],
  };
  assert.deepEqual(compiled.validate(SELECTION_MANIFEST_SCHEMA_ID, manifest), []);
  // a hidden sheet cannot be acknowledged with anything but true, and a string "true" is not a boolean
  const t0 = manifest.tables[0]!;
  assert.ok(compiled.validate(SELECTION_MANIFEST_SCHEMA_ID, { ...manifest, tables: [{ ...t0, hiddenSheetAcknowledged: "true" }] }).length > 0);
  assert.ok(compiled.validate(SELECTION_MANIFEST_SCHEMA_ID, { ...manifest, tables: [{ ...t0, hiddenSheetAcknowledged: false }] }).length > 0);
  // no customer text can travel in the manifest: an unknown member (a sheet name) is refused
  assert.ok(compiled.validate(SELECTION_MANIFEST_SCHEMA_ID, { ...manifest, tables: [{ ...t0, sheetName: "Clients" }] }).some((e) => e.code === "UNKNOWN_FIELD"));
  // at most 800 selected columns per table (09 "800 selected columns per table")
  assert.ok(compiled.validate(SELECTION_MANIFEST_SCHEMA_ID, { ...manifest, tables: [{ ...t0, selectedColumns: Array.from({ length: 801 }, (_, i) => i) }] }).length > 0);
});

test("the auxiliary routes read with any live membership and write with the operator role; the session read is the operator's own", () => {
  for (const [name, route] of Object.entries(SOURCE_ROUTES)) {
    assert.ok(route.path.startsWith("/api/v1/"), name);
    if (route.method === "GET" && name !== "getUploadSession") assert.equal(route.role, "AGENCY_READER", name);
  }
  assert.equal(SOURCE_ROUTES.selectionManifestIntake.method, "POST");
  assert.equal(SOURCE_ROUTES.selectionManifestIntake.role, "AGENCY_OPERATOR");
  assert.equal(SOURCE_ROUTES.getUploadSession.role, "AGENCY_OPERATOR");
});

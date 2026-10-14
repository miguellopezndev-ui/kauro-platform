// The B06 command specs and request schemas against the vendored catalogue (registry/commands.json through
// @kauro/contracts COMMANDS): method, path, role and the exact field list. The registry is the oracle; a spec that drifts
// from the catalogue fails here before any handler exists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { SUPPORT_CATEGORIES } from "@kauro/domain";
import { B06_COMMANDS, REQUEST_SCHEMAS, REQUEST_SCHEMA_IDS, REQUEST_SCHEMA_PREFIX, SUPPORT_COMMANDS, requestSchemaId } from "../src/index.js";

const IN_SCOPE = ["CMD001", "CMD009", "CMD010", "CMD011", "CMD023", "CMD025", "CMD026"] as const;
/** B16's five team commands (CMD003-CMD007). */
const TEAM = ["CMD003", "CMD004", "CMD005", "CMD006", "CMD007"] as const;
/** B16 lane L2's retention extension (CMD060). */
const RETENTION = ["CMD060"] as const;
/** The B06 commands, CMD044 of the support package (B11 W4) and the B16 team and retention commands, whose request schemas are checked against the catalogue too. */
const WITH_SUPPORT = [...IN_SCOPE, "CMD044", ...TEAM, ...RETENTION] as const;

test("every in-scope spec matches the catalogue entry: method, path, role, fields in order", () => {
  for (const id of IN_SCOPE) {
    const catalogue = COMMANDS.find((c) => c.id === id);
    assert.ok(catalogue, id);
    const spec = B06_COMMANDS[id];
    assert.equal(spec.id, catalogue.id);
    assert.equal(spec.name, catalogue.name);
    assert.equal(spec.method, catalogue.method);
    assert.equal(spec.path, catalogue.path);
    assert.equal(spec.role, catalogue.role);
    assert.deepEqual([...spec.fields], catalogue.fields.map((f) => f.name), `${id} fields`);
    assert.equal(catalogue.idempotency, "REQUIRED");
    assert.equal(catalogue.gate, "G-DOMAIN");
    assert.deepEqual([...(catalogue.testIds ?? [])], [`${id}-OK`, `${id}-DENY`, `${id}-RACE`]);
  }
});

test("request schemas are closed 2020-12 objects whose properties are exactly the catalogue fields, typed by the field vocabulary", () => {
  const typeOf: Record<string, string> = { label: "string", id: "string", version: "integer", hash: "string", text: "string", listText: "array", count: "integer" };
  for (const id of WITH_SUPPORT) {
    const catalogue = COMMANDS.find((c) => c.id === id)!;
    const s = REQUEST_SCHEMAS[id];
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(s.$id, `${REQUEST_SCHEMA_PREFIX}${id}`);
    assert.equal(s.$id, requestSchemaId(id));
    assert.equal(s.type, "object");
    assert.equal(s.additionalProperties, false, `${id} must reject unknown fields (R2-059)`);
    assert.deepEqual(Object.keys(s.properties), catalogue.fields.map((f) => f.name), `${id} properties`);
    for (const f of catalogue.fields) {
      const p = s.properties[f.name]!;
      assert.equal(p["type"], typeOf[f.type], `${id}.${f.name} (${f.type})`);
      assert.ok(!("default" in p), `${id}.${f.name} must not default (10: useDefaults=false)`);
      if (f.type === "version") assert.equal(p["minimum"], 1);
      if (f.type === "hash") assert.equal(p["pattern"], "^[0-9a-f]{64}$");
    }
    for (const r of s.required) assert.ok(r in s.properties, `${id} requires unknown ${r}`);
  }
  // expectedVersion is required wherever the catalogue lists it (10 "Edits require ... expectedVersion")
  for (const id of ["CMD010", "CMD023", "CMD025", "CMD026"] as const) {
    assert.ok(REQUEST_SCHEMAS[id].required.includes("expectedVersion"), id);
    assert.equal(B06_COMMANDS[id].expectedVersionRequired, true);
  }
  // CMD011: targetInstanceRef is the only optional member (required by the handler for CRM modes, D-CMD-4)
  assert.deepEqual([...REQUEST_SCHEMAS.CMD011.required], ["mode", "purpose"]);
  assert.deepEqual(REQUEST_SCHEMAS.CMD011.properties["mode"]!["enum"], ["CLEAN", "HUBSPOT", "SALESFORCE"]);
  assert.equal(REQUEST_SCHEMA_IDS.length, WITH_SUPPORT.length);
});

test("CMD044 CreateSupportCase matches the catalogue entry and its schema names the closed category set and a bounded summary (B11 W4)", () => {
  const catalogue = COMMANDS.find((c) => c.id === "CMD044")!;
  const spec = SUPPORT_COMMANDS.CMD044;
  assert.equal(spec.id, catalogue.id);
  assert.equal(spec.name, catalogue.name);
  assert.equal(spec.method, catalogue.method);
  assert.equal(spec.path, catalogue.path);
  assert.equal(spec.role, catalogue.role);
  assert.equal(spec.role, "AGENCY_MEMBER");
  assert.deepEqual([...spec.fields], catalogue.fields.map((f) => f.name));
  assert.equal(catalogue.idempotency, "REQUIRED");
  assert.equal(catalogue.gate, "G-UX");
  assert.deepEqual([...(catalogue.testIds ?? [])], ["CMD044-OK", "CMD044-DENY", "CMD044-RACE"]);
  assert.equal(spec.expectedVersionRequired, false);
  assert.equal(spec.stepUpRequired, false);
  const schema = REQUEST_SCHEMAS.CMD044;
  assert.deepEqual([...schema.required], ["category", "summary"], "evidenceRefs is optional: an empty list until B07 serves upload ids");
  assert.deepEqual(schema.properties["category"]!["enum"], [...SUPPORT_CATEGORIES], "the request's categories are the domain's, in order");
  const summary = schema.properties["summary"]!;
  assert.equal(summary["minLength"], 20);
  assert.equal(summary["maxLength"], 4000);
  assert.equal(schema.properties["evidenceRefs"]!["maxItems"], 0, "no upload id can be cited before B07's uploads are on main (D-SUP-2)");
});

test("no request schema exposes a server-owned member (verified, agencyOwner, state, agencyId, version, hashes of bytes)", () => {
  const forbidden = ["verified", "agencyOwner", "state", "agencyId", "version", "bodyHash", "revisionHash", "role", "createdAt"];
  for (const s of Object.values(REQUEST_SCHEMAS)) {
    // a member the catalogue itself lists as a request field is client input, not server-owned (CMD003/CMD005: the requested role)
    const declared = new Set((COMMANDS.find((c) => s.$id.endsWith(`:${c.id}`))?.fields ?? []).map((field) => field.name));
    for (const f of forbidden) assert.ok(!(f in s.properties) || declared.has(f), `${s.$id} exposes ${f}`);
  }
  assert.deepEqual(Object.values(REQUEST_SCHEMAS).filter((s) => "role" in s.properties).map((s) => s.$id).sort(), [requestSchemaId("CMD003"), requestSchemaId("CMD005")].sort(), "only the catalogue commands that request a role carry one");
});

test("scope resolution: only CreateAgency runs without a tenant; agency-path routes carry agencyId; the rest use the header", () => {
  for (const spec of [...Object.values(B06_COMMANDS), ...Object.values(SUPPORT_COMMANDS)]) {
    if (spec.path.includes("{agencyId}")) assert.equal(spec.scope, "AGENCY_PATH", spec.id);
    else if (spec.id === "CMD001") assert.equal(spec.scope, "NONE");
    else assert.equal(spec.scope, "AGENCY_HEADER", spec.id);
    if (spec.aggregateParam) assert.ok(spec.path.includes(`{${spec.aggregateParam}}`), spec.id);
  }
  assert.equal(B06_COMMANDS.CMD025.stepUpRequired, true);
  assert.deepEqual([...B06_COMMANDS.CMD025.authorityHashFields], ["planHash", "validationReceiptHash", "disclosuresHash"]);
});

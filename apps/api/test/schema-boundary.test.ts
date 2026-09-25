// S093, HTTP half — "Customer target metadata is compiled as a trusted JSON Schema. Reject the boundary; compile only
// reviewed application-owned schemas." (registry S093; 10 "Version and validation": customer-supplied target metadata is data
// validated by trusted schemas, never a schema compiled as code; database queries occur after structural validation; design
// §10 and I-VAL-1). The structural half is packages/application/test/schema-boundary.test.ts.
//
// Reading recorded in docs/design/B06-case-map.md: the route that accepts customer target metadata is
// POST /api/v1/projects/{projectId}/target-contracts — CMD018 CreateTargetContract, package B17 (gate G-VENDOR). B06 serves
// none of it. What B06 serves is the seven command routes and the one closed validator the composition root hands to every
// route, so the boundary is demonstrated there: (1) the composed validator is closed and has no compile entry — an id outside
// the set is INTEGRITY_FAILURE before the input is read; (2) target metadata that looks like a JSON Schema is validated as data
// by the application-owned TargetContract schema: schema text is a string, schema keywords are unknown members of closed
// objects, nothing is registered; (3) through the HTTP routes, schema-shaped members are refused before any unit of work
// opens, and a label that spells a JSON Schema is stored and answered verbatim.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { EndClientView, KnownSchemaId, ProjectView } from "@kauro/application";
import { ACCEPTED_RESPONSE_SCHEMA_ID, OPERATIONAL_ROUTES, READ_OPERATION_IDS, REQUEST_SCHEMA_IDS, SERVED_COMMAND_IDS, commandResponseSchemaId, operationalResponseSchemaId, readResponseSchemaId, requestSchemaId } from "@kauro/application";
import { CONTRACT_NAMES } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import { asProblem, call, completed, effectCounts, ids, outcome, routes, sha, world, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** A value any read of which fails the test: proves a refusal happened before the input was inspected. */
function untouchable(): object {
  const trap = (): never => {
    throw new Error("the validator read an input it had no schema for");
  };
  return new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
}

function isIntegrityFailure(e: unknown): boolean {
  return e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE";
}

function field(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiName: "email",
    dataType: "TEXT",
    createable: true,
    updateable: true,
    requiredOnCreate: false,
    allowedValues: [],
    clearMechanism: "UNSUPPORTED",
    unique: false,
    nillable: true,
    constraintStatus: "DECLARED",
    allowedValuesStatus: "NOT_APPLICABLE",
    constraintEvidenceHash: sha("constraint-evidence"),
    ...extra,
  };
}

function targetObject(fields: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { apiName: "contacts", operations: ["UPSERT"], fields, identifierFields: ["email"], relationships: [], ...extra };
}

function targetContract(objects: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: ids.next(),
    mode: "HUBSPOT",
    instanceId: "portal-7781",
    importerProfileId: "hubspot-crm-import",
    importerVersion: "v3",
    objects,
    bodyHash: sha("target-body"),
    observedAt: "2026-09-24T12:00:00.000Z",
    authorityEvidenceHash: sha("authority-evidence"),
    capabilityVersion: "R2-INITIAL",
    ...extra,
  };
}

test("the validator the api composes is closed: exactly the contract names, the request schema ids, the response schema ids and Problem; it has no compile entry, and an unknown schema id is INTEGRITY_FAILURE before the input is read", async () => {
  // the response schema ids: the COMPLETED envelope of each served command, the ACCEPTED envelope and the declared replies of
  // the operational routes — application-owned schemas like the request ones (api/response-schemas)
  const responseIds = [
    ...SERVED_COMMAND_IDS.map(commandResponseSchemaId),
    ACCEPTED_RESPONSE_SCHEMA_ID,
    ...OPERATIONAL_ROUTES.flatMap((r) => Object.keys(r.responses).map((s) => operationalResponseSchemaId(r.operationId, s))),
    // the READ envelopes of the manual-10 reads (N16)
    ...READ_OPERATION_IDS.map(readResponseSchemaId),
  ];
  const expected = [...CONTRACT_NAMES, ...REQUEST_SCHEMA_IDS, ...responseIds, "Problem"].sort();
  assert.deepEqual([...w.validator.knownSchemaIds].sort(), expected);
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(Object.keys(w.validator).sort(), ["knownSchemaIds", "validate"], "validate and the closed id list: nothing compiles or registers a schema");
  // the ids a caller could try to smuggle in: a customer label, the JSON Schema dialect, a bundle-relative $ref, the bundle's
  // own id and a definition URI inside it — each is refused before a single member of the input is read
  const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as { $id: string };
  for (const id of ["customer-target-metadata", JSON_SCHEMA_DIALECT, "#/$defs/TargetContract", bundle.$id, `${bundle.$id}#/$defs/TargetContract`, "targetcontract"]) {
    assert.throws(() => w.validator.validate(id as KnownSchemaId, untouchable()), isIntegrityFailure, id);
  }
  // the instance under test is the one the running server validates with: a refused request carries exactly its verdict
  const body = { mode: "CLEAN", purpose: "Import", $schema: JSON_SCHEMA_DIALECT, $defs: { Evil: { type: "object" } } };
  const direct = w.validator.validate(requestSchemaId("CMD011"), body);
  assert.equal(direct.kind, "INVALID");
  const reply = await call(w, { url: routes.createProject(w.clientA), token: w.operator.token, body });
  assert.equal(outcome(w, reply), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.deepEqual(asProblem(w, reply).errors, direct.kind === "INVALID" ? direct.fields : null);
});

test("customer target metadata that looks like a JSON Schema is validated as data by the application-owned TargetContract schema and never compiled", () => {
  const knownBefore = [...w.validator.knownSchemaIds];
  // schema text inside string values is data: an importer version and allowed values that spell a JSON Schema (with a
  // catastrophic-backtracking pattern) are strings the closed schema bounds by length, nothing more
  const schemaText = JSON.stringify({ $schema: JSON_SCHEMA_DIALECT, type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } }, additionalProperties: true });
  const asData = targetContract([targetObject([field({ allowedValues: [schemaText, "#/$defs/Plan", "$ref"] })])], { importerVersion: schemaText });
  assert.deepEqual(w.validator.validate("TargetContract", asData), { kind: "VALID", value: asData });
  // schema keywords as members of the metadata are unknown members of closed objects: refused by path, never interpreted —
  // a `$ref`, `properties`, `pattern`, `additionalProperties` or `$defs` changes nothing about how the value is validated
  const smuggled = targetContract([targetObject([field({ $ref: "#/$defs/Plan", pattern: "^.*$", type: "string" })], { properties: { email: { type: "string" } }, additionalProperties: true })], { $schema: JSON_SCHEMA_DIALECT, $defs: { Evil: { type: "object" } } });
  const verdict = w.validator.validate("TargetContract", smuggled);
  assert.equal(verdict.kind, "INVALID");
  assert.deepEqual(
    verdict.kind === "INVALID" ? [...verdict.fields].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)) : null,
    [
      { field: "$defs", code: "UNKNOWN_FIELD" },
      { field: "$schema", code: "UNKNOWN_FIELD" },
      { field: "objects/0/additionalProperties", code: "UNKNOWN_FIELD" },
      { field: "objects/0/fields/0/$ref", code: "UNKNOWN_FIELD" },
      { field: "objects/0/fields/0/pattern", code: "UNKNOWN_FIELD" },
      { field: "objects/0/fields/0/type", code: "UNKNOWN_FIELD" },
      { field: "objects/0/properties", code: "UNKNOWN_FIELD" },
    ],
  );
  // a member's type is the application's, not the metadata's: the "type": "string" the metadata declares did not relax the
  // boolean it sits next to
  const relaxed = w.validator.validate("TargetContract", targetContract([targetObject([field({ createable: "false" })])]));
  assert.deepEqual(relaxed, { kind: "INVALID", fields: [{ field: "objects/0/fields/0/createable", code: "TYPE" }] });
  // validating customer metadata compiles nothing: the known set is unchanged, the definition it carried is still unknown,
  // and the same value receives the same verdict
  assert.deepEqual([...w.validator.knownSchemaIds], knownBefore);
  assert.throws(() => w.validator.validate("Evil" as KnownSchemaId, {}), isIntegrityFailure);
  assert.deepEqual(w.validator.validate("TargetContract", smuggled), verdict);
});

test("through the served routes, schema-shaped request members are refused before any unit of work opens, and a label that spells a JSON Schema is stored and answered verbatim", async () => {
  const knownBefore = [...w.validator.knownSchemaIds];
  const countsBefore = await effectCounts(w);
  const runsBefore = w.stats.runs;
  const smuggled = await call(w, {
    url: routes.createProject(w.clientA),
    token: w.operator.token,
    body: { mode: "HUBSPOT", purpose: "Import", targetInstanceRef: ids.next(), $schema: JSON_SCHEMA_DIALECT, properties: { targetInstanceRef: { type: "string" } }, $ref: "#/$defs/Plan", additionalProperties: true },
  });
  assert.equal(outcome(w, smuggled), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.deepEqual(asProblem(w, smuggled).errors, [
    { field: "$schema", code: "UNKNOWN_FIELD" },
    { field: "properties", code: "UNKNOWN_FIELD" },
    { field: "$ref", code: "UNKNOWN_FIELD" },
    { field: "additionalProperties", code: "UNKNOWN_FIELD" },
  ]);
  assert.ok(!smuggled.text.includes(JSON_SCHEMA_DIALECT) && !smuggled.text.includes("#/$defs/Plan"), "the problem names fields, never values");
  assert.equal(w.stats.runs, runsBefore, "refused before any unit of work opened: no database query ran");
  assert.deepEqual(await effectCounts(w), countsBefore);

  // a JSON Schema written into a label or a purpose is a label: validated as a string, stored and answered byte for byte
  const schemaLabel = JSON.stringify({ $schema: JSON_SCHEMA_DIALECT, type: "object", required: ["x"], properties: { x: { $ref: "#/$defs/Plan" } } });
  const client = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, body: { displayName: schemaLabel, processingAuthorityRef: w.authorityA } }), 201);
  assert.equal(client.data.displayName, schemaLabel);
  assert.equal((await w.row<{ display_name: string }>("end_clients", "client_id = $1", [client.data.clientId]))?.display_name, schemaLabel);
  const project = completed<ProjectView>(await call(w, { url: routes.createProject(client.data.clientId), token: w.operator.token, body: { mode: "CLEAN", purpose: schemaLabel } }), 201);
  assert.equal(project.data.purpose, schemaLabel);
  assert.equal((await w.row<{ purpose: string }>("projects", "project_id = $1", [project.data.projectId]))?.purpose, schemaLabel);
  // nothing was compiled from those values
  assert.deepEqual([...w.validator.knownSchemaIds], knownBefore);
});

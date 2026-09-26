// The six B07 command specs and their request schemas against the vendored catalogue (registry/commands.json through
// @kauro/contracts COMMANDS), and the selection manifest document schema under the strict compiler every request goes through:
// closed objects, no coercion, no defaults, only the keyword vocabulary the validator enforces (R2-058, R2-059, S093).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { DomainFailure, EVENT_SUBSCRIPTIONS, FAILURE_REASONS, machine, type MachineName } from "@kauro/domain";
import {
  AUTHORITY_TOMBSTONES,
  B07_COMMANDS,
  PROBLEM_STATUS,
  REQUEST_SCHEMA_PREFIX,
  SELECTION_MANIFEST_SCHEMA,
  SELECTION_MANIFEST_SCHEMA_ID,
  SESSION_URL_MEMBER,
  SESSION_URL_VIEW,
  SOURCE_COMMAND_OUTCOMES,
  SOURCE_COMMAND_RESPONSES,
  SOURCE_REQUEST_SCHEMAS,
  SOURCE_REQUEST_SCHEMA_IDS,
  SOURCE_ROUTES,
  SOURCE_ROUTE_OUTCOMES,
  SOURCE_SWEEPERS,
  SOURCE_VIEW_DEFINITIONS,
  buildResponseSchemas,
  commandResponseSchemaId,
  intakeResponseSchemaId,
  readResponseSchemaId,
  ACCEPTED_RESPONSE_SCHEMA_ID,
  buildSourceViewSchemas,
  compileSchemaBundle,
  declaredMembers,
  type ContractSchemaBundle,
  type JsonSchema,
  type ViewDefinition,
} from "../src/index.js";

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
    if (route.method === "GET" && name !== "GetUploadSession") assert.equal(route.role, "AGENCY_READER", name);
  }
  assert.equal(SOURCE_ROUTES.SubmitSelectionManifest.method, "POST");
  assert.equal(SOURCE_ROUTES.SubmitSelectionManifest.role, "AGENCY_OPERATOR");
  assert.equal(SOURCE_ROUTES.GetUploadSession.role, "AGENCY_OPERATOR");
  assert.deepEqual(Object.keys(SOURCE_ROUTE_OUTCOMES).sort(), Object.keys(SOURCE_ROUTES).sort(), "every auxiliary route has its closed outcome catalogue");
});

const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle & { $defs: Record<string, { properties: Record<string, Record<string, unknown>>; required?: string[] }> };

/** The names of B06's own views: the served build carries B06's and B07's views together (VIEW_DEFINITIONS). */
function b06ViewNames(): Set<string> {
  const sourceNames = new Set(SOURCE_VIEW_DEFINITIONS.map((v) => v.name));
  return new Set(Object.keys(buildResponseSchemas(bundle).defs).filter((name) => !sourceNames.has(name)));
}

function sourceSchemas(): { readonly all: Record<string, JsonSchema>; readonly source: Readonly<Record<string, JsonSchema>> } {
  const served = buildResponseSchemas(bundle);
  const source = buildSourceViewSchemas(bundle, b06ViewNames());
  // the served build carries exactly these views
  for (const [name, schema] of Object.entries(source)) assert.deepEqual(served.defs[name], schema, `${name} is served as built`);
  return { all: served.defs, source };
}

test("the B07 response views build from the registry bundle exactly as B06's do: registry members derived and narrowed only by added keywords, every registry member selected or withheld with a reason, closed, no forbidden member", () => {
  const { source } = sourceSchemas();
  assert.deepEqual(Object.keys(source).sort(), SOURCE_VIEW_DEFINITIONS.map((v) => v.name).sort());
  let derived = 0;
  for (const view of SOURCE_VIEW_DEFINITIONS) {
    const built = source[view.name] as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    assert.equal(built.additionalProperties, false, `${view.name} is closed`);
    assert.deepEqual(Object.keys(built.properties), Object.keys(view.members), `${view.name} declares exactly its members`);
    for (const [name, member] of Object.entries(view.members)) {
      assert.equal(built.required.includes(name), member.required, `${view.name}.${name} required`);
      if (member.kind !== "registry") continue;
      derived += 1;
      const [contract, field] = member.from ?? [view.contract as string, name];
      assert.deepEqual(built.properties[name], { ...bundle.$defs[contract]!.properties[field]!, ...(member.narrow ?? {}) }, `${view.name}.${name} is ${contract}.${field}`);
    }
    if (view.contract !== null) {
      const registryMembers = Object.keys(bundle.$defs[view.contract]!.properties).sort();
      const covered = [...Object.keys(view.members).filter((m) => registryMembers.includes(m)), ...Object.keys(view.withheld)].sort();
      assert.deepEqual(covered, registryMembers, `${view.name}: every ${view.contract} member is selected or withheld`);
    }
  }
  assert.ok(derived >= 25, `${derived} members derived from the registry`);
  // the registry contracts the source lifecycle projects: the bearer reference and every provider generation stay off the wire
  const withheldOf = (name: string) => Object.keys(SOURCE_VIEW_DEFINITIONS.find((v) => v.name === name)!.withheld).sort();
  assert.deepEqual(withheldOf("UploadView"), ["observedGeneration", "providerSessionSecretRef"]);
  assert.deepEqual(withheldOf("InspectionFileView"), ["providerGeneration", "storageRef"]);
  // the session URL is carried by ProtectedSessionView and by no other view
  for (const [name, schema] of Object.entries(source)) {
    const carries = declaredMembers(schema).some((m) => m.name === SESSION_URL_MEMBER);
    assert.equal(carries, name === SESSION_URL_VIEW, `${name} and the session URL`);
  }
  // a view that tried to carry it elsewhere is refused at build time, as is a forbidden member
  const upload = SOURCE_VIEW_DEFINITIONS.find((v) => v.name === "UploadView")!;
  const withMember = (name: string): ViewDefinition => ({ ...upload, members: { ...upload.members, [name]: { kind: "platform", required: false, schema: { type: "string" }, description: "a leak" } } });
  const b06Names = b06ViewNames();
  const refusal = (views: ReadonlyArray<ViewDefinition>) => {
    try {
      buildSourceViewSchemas(bundle, b06Names, views);
    } catch (e) {
      assert.ok(e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE", String(e));
      return e.message;
    }
    return assert.fail("the build did not refuse");
  };
  assert.match(refusal([withMember(SESSION_URL_MEMBER)]), /carries the session URL outside ProtectedSessionView/);
  assert.match(refusal([withMember("sessionUri")]), /declares the forbidden member sessionUri/);
  assert.match(refusal([{ ...upload, name: "RevisionSummary" }]), /is defined twice/);
});

test("every B07 view and command reply compiles under the strict validator, and samples of the protected session, an upload and a preview validate while a leaking member is refused", () => {
  const { all } = sourceSchemas();
  const roots: Record<string, unknown> = {};
  for (const name of SOURCE_VIEW_DEFINITIONS.map((v) => v.name)) roots[`urn:kauro:test:${name}`] = { $ref: `#/$defs/${name}` };
  const compiled = compileSchemaBundle({ defs: { ...bundle.$defs, ...all }, roots });
  const id = "0190c7a2-0000-7000-8000-00000000000a";
  const t = "2026-09-25T12:00:00Z";
  assert.deepEqual(compiled.validate("urn:kauro:test:ProtectedSessionView", { delivery: "PROTECTED_RESPONSE", uploadUrl: "https://storage.example/upload/session", method: "PUT", chunkMultipleBytes: 262144, applicationExpiresAt: t }), []);
  assert.deepEqual(compiled.validate("urn:kauro:test:ProtectedSessionView", { delivery: "UNAVAILABLE", unavailableReason: "NOT_REQUESTER" }), []);
  assert.ok(compiled.validate("urn:kauro:test:ProtectedSessionView", { delivery: "PROTECTED_RESPONSE", uploadUrl: "http://plain.example/session" }).length > 0, "a session URL is https");
  const upload = {
    uploadId: id, revisionId: id, version: 3, state: "VERIFYING", reservedBytes: 1024, applicationExpiresAt: t, providerCancellationState: "NOT_REQUESTED",
    agencyId: id, projectId: id, displayName: "contacts export.csv", declaredFormat: "CSV", requestedByMembershipId: id, createdAt: t, permittedActions: ["CancelUpload"],
  };
  assert.deepEqual(compiled.validate("urn:kauro:test:UploadView", upload), []);
  assert.deepEqual(compiled.validate("urn:kauro:test:UploadView", { ...upload, providerSessionSecretRef: "https://storage.example/upload/session" }).map((e) => e.code), ["UNKNOWN_FIELD"], "the bearer reference never rides on progress");
  assert.deepEqual(compiled.validate("urn:kauro:test:UploadView", { ...upload, observedGeneration: "1700000000000001" }).map((e) => e.code), ["UNKNOWN_FIELD"]);
  assert.deepEqual(compiled.validate("urn:kauro:test:UploadView", { ...upload, displayName: "bad\u0085name" }).map((e) => e.code), ["FORMAT"], "a C1 control character is not a label (B06 N6)");
  const preview = { tableId: id, fileId: id, columns: [{ ordinal: 0, label: "Email", labelState: "PRESENT" }], rows: [["ana@example.com"], [null]], truncated: false };
  assert.deepEqual(compiled.validate("urn:kauro:test:TablePreviewView", preview), []);
  assert.ok(compiled.validate("urn:kauro:test:TablePreviewView", { ...preview, rows: Array.from({ length: 21 }, () => ["x"]) }).length > 0, "at most 20 rows (D-SAPI-7)");
  assert.ok(compiled.validate("urn:kauro:test:TablePreviewView", { ...preview, rows: [["x".repeat(201)]] }).length > 0, "at most 200 characters a cell");
  // every command reply names a built view (CMD014 answers B06's ACCEPTED envelope)
  for (const [command, reply] of Object.entries(SOURCE_COMMAND_RESPONSES)) {
    if (reply.view === null) assert.equal(reply.status, 202, command);
    else assert.ok(reply.view in all, `${command} names ${reply.view}`);
  }
  for (const route of Object.values(SOURCE_ROUTES)) assert.ok(route.view in all, `${route.path} names ${route.view}`);
});

test("the closed outcome catalogues of the B07 routes: registered codes and reasons, no duplicates, the access decisions on every tenant route, STALE_VERSION exactly where the command carries expectedVersion", () => {
  const reasons = new Set<string>(FAILURE_REASONS);
  for (const [route, outcomes] of [...Object.entries(SOURCE_COMMAND_OUTCOMES), ...Object.entries(SOURCE_ROUTE_OUTCOMES)]) {
    const keys = outcomes.map((o) => `${o.code}/${o.reason ?? "-"}`);
    assert.equal(new Set(keys).size, keys.length, `${route}: no entry twice`);
    for (const o of outcomes) {
      assert.ok(o.code in PROBLEM_STATUS, `${route}: ${o.code} has a status`);
      if (o.reason !== null) assert.ok(reasons.has(o.reason), `${route}: ${o.reason} is a registered failure reason`);
    }
    assert.ok(keys.includes("NOT_FOUND/NOT_A_MEMBER"), `${route}: a foreign and a nonexistent agency answer alike`);
  }
  for (const id of IN_SCOPE) {
    const keys = SOURCE_COMMAND_OUTCOMES[id].map((o) => `${o.code}/${o.reason ?? "-"}`);
    assert.equal(keys.includes("STALE_VERSION/-"), B07_COMMANDS[id].expectedVersionRequired, `${id}: STALE_VERSION iff expectedVersion`);
    assert.ok(keys.includes("IDEMPOTENCY_CONFLICT/REQUEST_DIGEST_DIFFERS") && keys.includes("PRECONDITION_FAILED/OPERATION_PENDING"), `${id} is journaled`);
    assert.ok(keys.includes("NOT_AUTHORIZED/ROLE_INSUFFICIENT"), `${id} is AGENCY_OPERATOR`);
  }
  // the selection intake is not journaled (D-SEL-2): no idempotency outcome
  assert.ok(!SOURCE_ROUTE_OUTCOMES.SubmitSelectionManifest.some((o) => o.layer === "IDEMPOTENCY" || o.reason === "IDEMPOTENCY_KEY_MISSING"));
  // the reads carry no role refusal (AGENCY_READER: every membership role reads); the session read does (the operator's own)
  assert.ok(!SOURCE_ROUTE_OUTCOMES.GetUpload.some((o) => o.reason === "ROLE_INSUFFICIENT"));
  assert.ok(SOURCE_ROUTE_OUTCOMES.GetUploadSession.some((o) => o.reason === "ROLE_INSUFFICIENT"));
  assert.ok(SOURCE_ROUTE_OUTCOMES.GetUploadSession.some((o) => o.reason === "UPLOAD_NOT_OWNED"));
});

test("B07-F8: every event routed to AUTHORITY_JOURNAL produces exactly one tombstone kind and a terminal state — an expired and a rejected revision included — and nothing else produces one", () => {
  const routed = EVENT_SUBSCRIPTIONS.filter((s) => s.consumer === "AUTHORITY_JOURNAL").map((s) => s.eventType).sort();
  assert.deepEqual(Object.keys(AUTHORITY_TOMBSTONES).sort(), routed);
  assert.deepEqual(AUTHORITY_TOMBSTONES["dataset_revision.expired.v1"], { kind: "REVISION_EXPIRED", state: "EXPIRED" });
  assert.deepEqual(AUTHORITY_TOMBSTONES["dataset_revision.rejected.v1"], { kind: "REVISION_REJECTED", state: "REJECTED" });
  // D-RESTORE-2 (residual FINAL-N1): the state a tombstone names is derived from the subject's own machine, never from a literal
  // list — a state the machine enters by one of its edges, from which it never leads back to a live state (every state reachable
  // from it is itself a tombstoned state of that subject), and every terminal state of the machine is tombstoned.
  const subjectMachine: Readonly<Record<string, MachineName>> = { upload_session: "UploadSession", dataset_revision: "DatasetRevision", source_file: "SourceFile" };
  const tombstoned = new Map<MachineName, Set<string>>();
  const entries = Object.entries(AUTHORITY_TOMBSTONES).map(([eventType, t]) => {
    const name = subjectMachine[eventType.slice(0, eventType.indexOf("."))];
    assert.ok(name !== undefined, `${eventType} names a tombstoned subject`);
    tombstoned.set(name, (tombstoned.get(name) ?? new Set<string>()).add(t.state));
    return { eventType, state: t.state as string, name };
  });
  for (const { eventType, state, name } of entries) {
    const m = machine(name);
    assert.ok(m.transitions.some((e) => e.to === state), `${eventType}: ${state} is a state ${name} enters`);
    const reachable = new Set<string>([state]);
    const pending = [state];
    for (let s = pending.pop(); s !== undefined; s = pending.pop()) {
      for (const e of m.transitions) {
        if (e.from === s && !reachable.has(e.to)) {
          reachable.add(e.to);
          pending.push(e.to);
        }
      }
    }
    for (const s of reachable) assert.ok(tombstoned.get(name)!.has(s), `${eventType}: ${name} leads from ${state} to ${s}, which no tombstone names`);
  }
  for (const [name, states] of tombstoned) for (const s of machine(name).terminal) assert.ok(states.has(s), `${name} terminal ${s} is tombstoned`);
});

test("N5: a file-admission revocation is a restore tombstone — source_file.admission_revoked.v1 is routed to AUTHORITY_JOURNAL and produces FILE_ADMISSION_REVOKED in the SourceFile machine's terminal state ADMISSION_REVOKED, so a restore never re-admits bytes whose retention ended or whose generation was lost", () => {
  const consumers = EVENT_SUBSCRIPTIONS.filter((s) => s.eventType === "source_file.admission_revoked.v1").map((s) => s.consumer).sort();
  assert.deepEqual(consumers, ["AUTHORITY_JOURNAL", "EXECUTION_CONTROL", "NOTIFICATIONS"]);
  assert.deepEqual((AUTHORITY_TOMBSTONES as Readonly<Record<string, { readonly kind: string; readonly state: string }>>)["source_file.admission_revoked.v1"], { kind: "FILE_ADMISSION_REVOKED", state: "ADMISSION_REVOKED" });
  // D-RESTORE-2 (residual FINAL-N1): the consumer appends only when the subject is in the named state, so it must be the state a
  // revoked file is in — the machine's terminal state and the only state source_files records for a revoked admission
  assert.deepEqual(machine("SourceFile").terminal, ["ADMISSION_REVOKED"]);
  assert.ok(machine("SourceFile").transitions.some((e) => e.event === "admission_revoked" && e.to === AUTHORITY_TOMBSTONES["source_file.admission_revoked.v1"].state));
});

test("B07-F13: the sweepers of the contracts are exactly the sweepers of design §12.5, LOCATION_POLICY and RETENTION included", () => {
  const design = readFileSync(new URL("../../../../docs/design/B07-upload-source-lifecycle.md", import.meta.url), "utf8");
  const line = /^Sweepers \(SOURCE_SWEEPERS\): (.+)\.$/m.exec(design);
  assert.ok(line, "design §12.5 names the sweepers in one line");
  assert.deepEqual(line[1]!.split(", "), [...SOURCE_SWEEPERS]);
  assert.ok(SOURCE_SWEEPERS.includes("RETENTION") && SOURCE_SWEEPERS.includes("LOCATION_POLICY"));
});

test("B07-F13: the reply envelopes of the source routes are served and build closed from the views — a COMPLETED envelope per command but CMD014 (ACCEPTED), a READ envelope per read, a STORED envelope for the selection manifest intake", () => {
  const served = buildResponseSchemas(bundle);
  for (const command of ["CMD012", "CMD013", "CMD015", "CMD016", "CMD017"] as const) assert.ok(commandResponseSchemaId(command) in served.roots, command);
  assert.ok(!(commandResponseSchemaId("CMD014") in served.roots), "CMD014 answers the shared ACCEPTED envelope");
  assert.ok(ACCEPTED_RESPONSE_SCHEMA_ID in served.roots);
  for (const op of Object.keys(SOURCE_ROUTES).filter((op) => op !== "SubmitSelectionManifest")) {
    assert.ok(readResponseSchemaId(op as Parameters<typeof readResponseSchemaId>[0]) in served.roots, op);
  }
  const intakeId = intakeResponseSchemaId("SubmitSelectionManifest");
  assert.ok(intakeId in served.roots);
  const compiled = compileSchemaBundle({ defs: { ...bundle.$defs, ...served.defs }, roots: served.roots });
  const intake = { selectionManifestId: "0190c7a2-0000-7000-8000-00000000000a", revisionId: "0190c7a2-0000-7000-8000-00000000000b", bodyHash: "a".repeat(64), created: true };
  assert.deepEqual(compiled.validate(intakeId, { kind: "STORED", data: intake }), []);
  assert.ok(compiled.validate(intakeId, { kind: "STORED", data: intake, replayed: false }).length > 0, "the envelope is closed");
});

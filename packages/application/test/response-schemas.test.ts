// R23, R29 — the response contract (10 "Version and validation": closed 2020-12 wire contracts, OpenAPI generated from the
// owning contract registry, "TypeScript types alone are insufficient runtime validation"; 10 "Responses and safe errors":
// "Synchronous success returns a validated DTO and version"; reference/FIELD_CONTRACTS.md "Responses must select only authorized
// fields"; reference/HASHING_AND_ACCOUNTING_RULES "the consumer recomputes the relevant preimage"). The views are derived from
// the registry contract bundle, the build refuses a view that relaxes, invents or silently drops a registry member, no schema
// declares a forbidden member, and every handler's COMPLETED reply satisfies its schema.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import type { B06Collaborators, CommandResult, ContractSchemaBundle, DisclosureSet, OperationalRoute, PatchCompilation } from "../src/index.js";
import {
  ACCEPTED_RESPONSE_SCHEMA_ID,
  APPROVE_PLAN,
  ARCHIVE_CLIENT,
  COMMAND_RESPONSES,
  CREATE_AGENCY,
  CREATE_CLIENT,
  CREATE_PROJECT,
  FORBIDDEN_RESPONSE_FIELDS,
  LABEL_PATTERN,
  OPERATIONAL_ROUTES,
  PROBLEM_SCHEMA,
  RESPONSE_FIELD_VOCABULARY,
  REVISE_PLAN,
  ResponseContractViolation,
  SERVED_COMMAND_IDS,
  VIEW_DEFINITIONS,
  WITHDRAW_APPROVAL,
  buildResponseSchemas,
  checkReply,
  commandResponseSchemaId,
  commandRouteResponses,
  createB06Handlers,
  createSchemaValidator,
  declaredMembers,
  openObjects,
  operationalResponseSchemaId,
  operationalRouteResponses,
  problemOf,
  responseIntegrityProblem,
} from "../src/index.js";
import { bodyHashOf, envelope, planBodyOf, sha, subject, world, type World } from "./support.js";

const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle & { $defs: Record<string, { properties: Record<string, Record<string, unknown>>; required?: string[] }> };
const validator = createSchemaValidator(bundle);

/** The KAURO_PLAN_APPROVAL_V1 preimage (reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation", Approval hash row). */
const APPROVAL_PREIMAGE = ["approvalId", "actorId", "agencyId", "planHash", "revisionHash", "targetContractHash", "validationReceiptHash", "disclosuresHash", "createdAt"] as const;

function without<T extends Record<string, unknown>>(o: T, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = o;
  return rest;
}

function refusal(build: () => unknown): string {
  try {
    build();
  } catch (e) {
    assert.ok(e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE", String(e));
    return e.message;
  }
  assert.fail("the build did not refuse");
}

test("R23: every view member taken from the registry is the registry member, narrowed only by keywords the registry lacks; a registry-required member stays required; every registry member is selected or withheld with a reason", () => {
  const { defs } = buildResponseSchemas(bundle);
  let derived = 0;
  for (const view of VIEW_DEFINITIONS) {
    const built = defs[view.name] as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    assert.equal(built.additionalProperties, false, `${view.name} is closed`);
    assert.deepEqual(Object.keys(built.properties), Object.keys(view.members), `${view.name} declares exactly its members`);
    for (const [name, member] of Object.entries(view.members)) {
      assert.equal(built.required.includes(name), member.required, `${view.name}.${name} required`);
      if (member.kind !== "registry") continue;
      derived += 1;
      const [contract, field] = member.from ?? [view.contract as string, name];
      const source = bundle.$defs[contract]!;
      const base = source.properties[field]!;
      assert.deepEqual(built.properties[name], { ...base, ...(member.narrow ?? {}) }, `${view.name}.${name} is ${contract}.${field}`);
      for (const k of Object.keys(member.narrow ?? {})) assert.ok(!(k in base), `${view.name}.${name} narrowing adds ${k}, never overrides it`);
      if ((source.required ?? []).includes(field)) assert.ok(member.required, `${contract}.${field} is required by the registry`);
    }
    if (view.contract !== null) {
      const registryMembers = Object.keys(bundle.$defs[view.contract]!.properties).sort();
      const covered = [...Object.keys(view.members).filter((m) => registryMembers.includes(m)), ...Object.keys(view.withheld)].sort();
      assert.deepEqual(covered, registryMembers, `${view.name}: every ${view.contract} member is selected or withheld`);
      for (const [name, why] of Object.entries(view.withheld)) assert.ok(why.length > 20, `${view.name}.${name} withheld with a reason`);
    }
  }
  assert.ok(derived >= 35, `${derived} members derived from the registry`);
  // the platform vocabulary is the registry's where the registry has the type, and narrower where the platform promises more
  const v = RESPONSE_FIELD_VOCABULARY;
  const shape = (contract: string, field: string) => without(bundle.$defs[contract]!.properties[field]!, "description");
  assert.deepEqual(v.LABEL, { ...shape("Agency", "displayName"), pattern: LABEL_PATTERN }, "the platform label narrows the registry label with the control-character rule of the request schemas (N6)");
  assert.deepEqual(v.UTC, shape("Agency", "createdAt"));
  assert.deepEqual(v.HASH, shape("Plan", "bodyHash"));
  assert.deepEqual(v.COUNT, shape("RowCounts", "physicalSourceRows"));
  assert.deepEqual({ ...shape("Agency", "version"), minimum: 1 }, v.VERSION, "a platform version starts at 1 (design D-VER-1)");
  assert.deepEqual(shape("Agency", "agencyId"), { type: "string", minLength: 1, maxLength: 128 });
  assert.equal(new RegExp(v.UUID_PATTERN).test("0192f3a4-5b6c-7d8e-9f01-23456789abcd"), true);
});

test("R23: the build refuses a registry member a view neither selects nor withholds, a registry-required member left optional, a narrowing that overrides a registry keyword and a missing contract", () => {
  const edited = (edit: (b: typeof bundle) => void): typeof bundle => {
    const copy = structuredClone(bundle);
    edit(copy);
    return copy;
  };
  assert.match(refusal(() => buildResponseSchemas(edited((b) => { b.$defs["Approval"]!.properties["revokedBy"] = { type: "string" }; }))), /ApprovalView: registry member Approval.revokedBy is neither selected nor withheld/);
  assert.match(refusal(() => buildResponseSchemas(edited((b) => { b.$defs["Approval"]!.required = [...(b.$defs["Approval"]!.required ?? []), "withdrawnAt"]; }))), /ApprovalView.withdrawnAt: the registry requires Approval.withdrawnAt/);
  assert.match(refusal(() => buildResponseSchemas(edited((b) => { b.$defs["Agency"]!.properties["agencyId"] = { type: "string", pattern: "^[a-z]+$" }; }))), /AgencyView.agencyId: narrowing may only add keywords the registry member lacks \(pattern is already set\)/);
  assert.match(refusal(() => buildResponseSchemas(edited((b) => { delete b.$defs["EndClient"]; }))), /the registry bundle has no contract EndClient/);
  assert.match(refusal(() => buildResponseSchemas(edited((b) => { delete b.$defs["Plan"]!.properties["policyHash"]; }))), /PlanView.policyHash: the registry contract Plan has no member policyHash/);
});

test("R29: ApprovalView selects every member of the KAURO_PLAN_APPROVAL_V1 preimage as required, and actorId is the registry's Approval.actorId", () => {
  const { defs } = buildResponseSchemas(bundle);
  const approval = defs["ApprovalView"] as { properties: Record<string, Record<string, unknown>>; required: string[] };
  for (const member of APPROVAL_PREIMAGE) {
    assert.ok(member in approval.properties, member);
    assert.ok(approval.required.includes(member), member);
  }
  assert.equal(approval.properties["actorId"]!["description"], bundle.$defs["Approval"]!.properties["actorId"]!["description"]);
});

test("R23: every response schema is closed and none declares a forbidden member; an operational route that would declare one, or leave an object open, is refused", () => {
  const { defs, roots } = buildResponseSchemas(bundle);
  for (const [where, schema] of [...Object.entries(defs), ...Object.entries(roots), ["Problem", PROBLEM_SCHEMA] as const]) {
    for (const m of declaredMembers(schema)) assert.ok(!(m.name in FORBIDDEN_RESPONSE_FIELDS), `${where}${m.path}`);
    assert.deepEqual(openObjects(schema), [], `${where} is closed`);
  }
  const open: OperationalRoute = {
    operationId: "getOpen",
    method: "GET",
    path: "/open",
    summary: "negative control",
    authority: "none",
    responses: { "200": { description: "open", contentType: "application/json", schema: { type: "object", required: [], properties: { status: { type: "string" } } } } },
  };
  assert.match(refusal(() => buildResponseSchemas(bundle, [open])), /urn:kauro:api:v1:response:op:getOpen:200 is not closed at \/ \(additionalProperties must be false\)/);
  const leaking: OperationalRoute = {
    operationId: "getLeak",
    method: "GET",
    path: "/leak",
    summary: "negative control",
    authority: "none",
    responses: { "200": { description: "leak", contentType: "application/json", schema: { type: "object", additionalProperties: false, required: [], properties: { detail: { type: "object", additionalProperties: false, properties: { sessionToken: { type: "string" } } } } } } },
  };
  assert.match(refusal(() => buildResponseSchemas(bundle, [leaking])), /declares the forbidden member sessionToken/);
});

test("R23: the validator compiles the COMPLETED envelope of every served command, the ACCEPTED envelope and the declared replies of operational routes; operational routes are declared and checked like command routes", () => {
  for (const command of SERVED_COMMAND_IDS) assert.ok(validator.knownSchemaIds.includes(commandResponseSchemaId(command)), command);
  assert.ok(validator.knownSchemaIds.includes(ACCEPTED_RESPONSE_SCHEMA_ID));
  // the operational routes of this edition are the two probes (14 "Monitoring and service health") and the two public routes
  // (B11 W5b, D-PUB-1..D-PUB-6); the default validator compiles exactly their declared replies, and a probe's or a public route's
  // reply is checked like a command's
  assert.deepEqual(OPERATIONAL_ROUTES.map((r) => [r.method, r.path, r.operationId, Object.keys(r.responses)]), [
    ["GET", "/livez", "getLiveness", ["200"]],
    ["GET", "/readyz", "getReadiness", ["200", "503"]],
    ["GET", "/api/v1/public/capability-publication", "getCapabilityPublication", ["200"]],
    ["POST", "/api/v1/public/inquiries", "createInquiry", ["201"]],
  ]);
  for (const route of OPERATIONAL_ROUTES) {
    for (const status of Object.keys(route.responses)) assert.ok(validator.knownSchemaIds.includes(operationalResponseSchemaId(route.operationId, status)), `${route.operationId} ${status}`);
  }
  const live = operationalRouteResponses("getLiveness");
  assert.deepEqual(live.declared, { "200": { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:op:getLiveness:200" } });
  checkReply(validator, live, 200, "application/json; charset=utf-8", { status: "LIVE" });
  assert.throws(() => checkReply(validator, live, 200, "application/json", { status: "LIVE", uptimeSeconds: 12 }), (e: unknown) => e instanceof ResponseContractViolation && e.fields.some((f) => f.field === "uptimeSeconds" && f.code === "UNKNOWN_FIELD"));
  const notReady = { status: "NOT_READY", checks: { process: "SERVING", database: "UNAVAILABLE", schema: "NOT_CHECKED" }, schemaVersion: { code: 7, database: null } };
  checkReply(validator, operationalRouteResponses("getReadiness"), 503, "application/json", notReady);
  assert.throws(() => checkReply(validator, operationalRouteResponses("getReadiness"), 503, "application/json", { ...notReady, error: "connect ECONNREFUSED 10.0.0.5:5432" }), (e: unknown) => e instanceof ResponseContractViolation && e.fields.some((f) => f.field === "error" && f.code === "UNKNOWN_FIELD"));
  // only a declared operational route is compiled: a route outside the list is unknown to the default validator
  const control: OperationalRoute = {
    operationId: "getControl",
    method: "GET",
    path: "/control",
    summary: "negative control",
    authority: "none",
    responses: { "200": { description: "control", contentType: "application/json", schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", const: "OK" } } } } },
  };
  const withOps = createSchemaValidator(bundle, [control]);
  assert.ok(withOps.knownSchemaIds.includes(operationalResponseSchemaId("getControl", "200")));
  assert.ok(!validator.knownSchemaIds.includes(operationalResponseSchemaId("getControl", "200")), "only a declared operational route is compiled");
  checkReply(withOps, operationalRouteResponses("getControl", [control]), 200, "application/json", { status: "OK" });
  assert.throws(() => operationalRouteResponses("getReadiness", [control]), (e: unknown) => e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE");
});

test("R23: checkReply refuses an undeclared status, another content type, a closed-schema violation and a problem whose status is not the HTTP status; it names paths and codes, never values; the replacement problem is itself a valid Problem", () => {
  const contract = commandRouteResponses("CMD009", "CreateClient");
  const secret = "sentinel-value-0f9e8d";
  const client = { clientId: "0192f3a4-5b6c-7d8e-9f01-23456789abcd", agencyId: "0192f3a4-5b6c-7d8e-9f01-23456789abce", version: 1, displayName: "Client", state: "ACTIVE", processingAuthorityRef: "0192f3a4-5b6c-7d8e-9f01-23456789abcf", createdAt: "2026-09-25T10:00:00.000Z", permittedActions: ["ArchiveClient", "CreateProject"] };
  const completed = { kind: "COMPLETED", version: 1, replayed: false, data: client };
  checkReply(validator, contract, 201, "application/json; charset=utf-8", completed);
  const refused = (status: number, contentType: string, body: unknown): ResponseContractViolation => {
    try {
      checkReply(validator, contract, status, contentType, body);
    } catch (e) {
      assert.ok(e instanceof ResponseContractViolation, String(e));
      assert.ok(!e.message.includes(secret), "a violation never carries a value");
      return e;
    }
    assert.fail("the reply was accepted");
  };
  assert.match(refused(200, "application/json", completed).message, /status 200 is not declared/);
  assert.match(refused(202, "application/json", { kind: "ACCEPTED" }).message, /status 202 is not declared/);
  assert.match(refused(201, "application/problem+json", completed).message, /content type application\/problem\+json is not application\/json/);
  assert.deepEqual(refused(201, "application/json", { ...completed, data: { ...client, tokenHash: secret } }).fields, [{ field: "data/tokenHash", code: "UNKNOWN_FIELD" }]);
  assert.deepEqual(refused(201, "application/json", { ...completed, data: { ...client, createdAt: "2026-02-30T10:00:00Z" } }).fields, [{ field: "data/createdAt", code: "FORMAT" }]);
  assert.deepEqual(refused(201, "application/json", { ...completed, data: without(client, "processingAuthorityRef") }).fields, [{ field: "data/processingAuthorityRef", code: "REQUIRED" }]);
  const problem = problemOf(new DomainFailure("NOT_FOUND", "no"), "0192f3a4-5b6c-7d8e-9f01-23456789abcd");
  checkReply(validator, contract, 404, "application/problem+json; charset=utf-8", problem);
  assert.match(refused(409, "application/problem+json", problem).message, /the problem states status 404/);
  assert.deepEqual(refused(404, "application/problem+json", { ...problem, stack: secret }).fields, [{ field: "stack", code: "UNKNOWN_FIELD" }]);
  assert.deepEqual(refused(404, "application/problem+json", { ...problem, errors: [{ field: "x", code: "TYPE", value: secret }] }).fields, [{ field: "errors/0/value", code: "UNKNOWN_FIELD" }]);
  const integrity = responseIntegrityProblem("0192f3a4-5b6c-7d8e-9f01-23456789abcd");
  assert.deepEqual([integrity.status, integrity.code, integrity.reason, integrity.retryable], [422, "INTEGRITY_FAILURE", "RESPONSE_CONTRACT_VIOLATION", false]);
  checkReply(validator, contract, 422, "application/problem+json", integrity);
});

// --- every handler's COMPLETED reply satisfies its schema (in-memory ports; the HTTP routes check the same through the guard)

function collaborators(w: World): B06Collaborators {
  const patched = planBodyOf(w.revisionHash, w.targetContractHash, "Email");
  return {
    abuseLimiter: { admit: async () => ({ kind: "ADMITTED" }) },
    activeWork: { inspectClient: async (uow, clientId) => ({ openProjects: await uow.endClients.countOpenProjects(clientId), activeJobs: 0, liveCommercialAuthorizations: 0 }) },
    artifacts: { resolveDecisionPatch: async (_uow, _agencyId, ref) => ({ artifactRef: ref, patchHash: sha("patch"), document: { candidate: "Email" } }) },
    patchCompiler: { apply: async (): Promise<PatchCompilation> => ({ kind: "COMPILED", body: patched, bodyHash: bodyHashOf(patched) }) },
    disclosures: { compose: async (_uow, plan): Promise<DisclosureSet> => ({ disclosuresHash: sha(`disclosures:${plan.bodyHash}`), items: ["SET:Contact.Phone:10"], includesClear: false }) },
    externalActions: { completedForPlan: async () => [{ kind: "IMPORT_STAGE_VERIFIED", referenceId: "0192f3a4-5b6c-7d8e-9f01-23456789abcd" }] },
    // CMD023 on an APPROVED plan consults it (D-PLAN-4); the plans revised here are VALIDATED, and nothing is unreconciled
    commercialConsequences: { unreconciledForPlan: async () => [] },
  };
}

function envelopeOf<V>(command: keyof typeof COMMAND_RESPONSES, r: CommandResult<V>): unknown {
  assert.equal(r.kind, "COMPLETED", JSON.stringify(r));
  const c = r as Extract<CommandResult<V>, { kind: "COMPLETED" }>;
  assert.equal(c.status, COMMAND_RESPONSES[command].status, `${command} answers its declared status`);
  return { kind: "COMPLETED", version: c.version, replayed: c.replayed, data: c.view };
}

test("R23 / R29: the COMPLETED reply of each of the seven handlers satisfies its response schema; the approval view recomputes its KAURO_PLAN_APPROVAL_V1 hash from its own members", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const replies: Array<[keyof typeof COMMAND_RESPONSES, unknown]> = [];
  replies.push(["CMD001", envelopeOf("CMD001", await h.CMD001.execute(envelope(CREATE_AGENCY, subject("founder"), { key: "response-schema-cmd001", body: { displayName: "Founded" } })))]);
  replies.push(["CMD009", envelopeOf("CMD009", await h.CMD009.execute(envelope(CREATE_CLIENT, w.operator, { key: "response-schema-cmd009", path: { agencyId: w.agencyId }, body: { displayName: "Another", processingAuthorityRef: w.authorityId } })))]);
  replies.push(["CMD011", envelopeOf("CMD011", await h.CMD011.execute(envelope(CREATE_PROJECT, w.operator, { key: "response-schema-cmd011", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { mode: "CLEAN", purpose: "Dedupe" } })))]);
  replies.push(["CMD010", envelopeOf("CMD010", await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: "response-schema-cmd010", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })))]);
  const planHash = bodyHashOf(w.planBody);
  const approved = envelopeOf("CMD025", await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: "response-schema-cmd025", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, planHash, validationReceiptHash: w.receiptHash, disclosuresHash: sha(`disclosures:${planHash}`), assuranceProofRef: w.proofId } })));
  replies.push(["CMD025", approved]);
  replies.push(["CMD026", envelopeOf("CMD026", await h.CMD026.execute(envelope(WITHDRAW_APPROVAL, w.approver, { key: "response-schema-cmd026", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } })))]);
  const other = world();
  const revised = await createB06Handlers(other.runtime, collaborators(other)).CMD023.execute(envelope(REVISE_PLAN, other.operator, { key: "response-schema-cmd023", agencyId: other.agencyId, path: { planId: other.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: "0192f3a4-5b6c-7d8e-9f01-23456789abcd" } }));
  replies.push(["CMD023", envelopeOf("CMD023", revised)]);
  assert.deepEqual(replies.map(([c]) => c).sort(), [...SERVED_COMMAND_IDS].sort());
  for (const [command, reply] of replies) assert.deepEqual(validator.validate(commandResponseSchemaId(command), reply), { kind: "VALID", value: reply }, command);

  // R29: a consumer holding only the DTO recomputes the approval hash (the preimage members, nothing else)
  const approval = (approved as { data: { approval: Record<string, string> } }).data.approval;
  assert.equal(approval["actorId"], w.approver.identity.userId);
  const preimage = Object.fromEntries(APPROVAL_PREIMAGE.map((k) => [k, approval[k]]));
  assert.equal(structuredDigest(DOMAINS.PLAN_APPROVAL, 1, preimage), approval["approvalHash"]);
});

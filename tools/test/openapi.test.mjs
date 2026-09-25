// R23 — 10 "Version and validation": "OpenAPI is generated from the owning contract registry and checked against actual
// routes. The build fails on undocumented public routes, missing operation IDs, incompatible response schemas or a DTO that
// exposes a forbidden field." The checker runs on the committed document and the route inventory of the api the composition
// root builds; each failure class is shown with a negative control next to the passing real pair.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { DOCUMENT_PATH, checkOpenApi, generateOpenApi, loadSources, openApiPath, registeredRoutes, serialize } from "../openapi.mjs";

let sources;
let expected;
let committed;
let inventory;
before(async () => {
  sources = await loadSources();
  expected = generateOpenApi(sources);
  committed = JSON.parse(readFileSync(DOCUMENT_PATH, "utf8"));
  inventory = await registeredRoutes();
});

const clone = (v) => structuredClone(v);
const check = (overrides = {}) => checkOpenApi({ document: committed, expected, inventory, sources, ...overrides });

test("the committed document is the generated one, byte for byte, and matches every registered route of the composed api", () => {
  assert.equal(readFileSync(DOCUMENT_PATH, "utf8"), serialize(expected));
  assert.deepEqual(generateOpenApi(sources), expected, "generation is deterministic");
  assert.deepEqual(check(), []);
  // the seven registry commands B06 serves, under their registry paths and names
  assert.deepEqual(
    inventory.map((r) => `${r.method} ${openApiPath(r.url)} ${r.responses.operationId}`).sort(),
    [
      "POST /api/v1/agencies CreateAgency",
      "POST /api/v1/agencies/{agencyId}/clients CreateClient",
      "POST /api/v1/clients/{clientId}/archive ArchiveClient",
      "POST /api/v1/clients/{clientId}/projects CreateProject",
      "POST /api/v1/plans/{planId}/approve ApprovePlan",
      "POST /api/v1/plans/{planId}/revisions RevisePlan",
      "POST /api/v1/plans/{planId}/withdraw WithdrawApproval",
    ],
  );
  for (const command of sources.registryCommands.filter((c) => sources.application.SERVED_COMMAND_IDS.includes(c.id))) {
    const op = expected.paths[command.path][command.method.toLowerCase()];
    assert.equal(op.operationId, command.name);
    assert.equal(op["x-kauro-command"], command.id);
    assert.deepEqual(op["x-kauro-cases"], command.testIds);
    assert.equal(op.requestBody.content["application/json"].schema.$ref, `#/components/schemas/${command.name}Request`);
    assert.deepEqual(Object.keys(op.responses).sort(), [String(sources.application.COMMAND_RESPONSES[command.id].status), "default"]);
  }
  // the ApprovalView component carries every member of the KAURO_PLAN_APPROVAL_V1 preimage (R29)
  const approval = expected.components.schemas.ApprovalView;
  for (const member of ["approvalId", "actorId", "agencyId", "planHash", "revisionHash", "targetContractHash", "validationReceiptHash", "disclosuresHash", "createdAt"]) {
    assert.ok(approval.required.includes(member), member);
  }
});

test("an undocumented registered route fails the check", () => {
  const extra = { method: "GET", url: "/api/v1/agencies/:agencyId/members", responses: inventory[0].responses };
  assert.deepEqual(check({ inventory: [...inventory, extra] }).filter((f) => f.startsWith("undocumented")), ["undocumented registered route: GET /api/v1/agencies/{agencyId}/members"]);
});

test("a documented route that is not registered fails the check", () => {
  const without = inventory.filter((r) => !r.url.endsWith("/withdraw"));
  assert.deepEqual(check({ inventory: without }), ["documented route that is not registered: POST /api/v1/plans/{planId}/withdraw"]);
});

test("a missing or duplicate operationId fails the check", () => {
  const missing = clone(committed);
  delete missing.paths["/api/v1/agencies"].post.operationId;
  const failures = check({ document: missing });
  assert.ok(failures.includes("missing operationId: POST /api/v1/agencies"), failures.join("\n"));
  const duplicate = clone(committed);
  duplicate.paths["/api/v1/plans/{planId}/withdraw"].post.operationId = "ApprovePlan";
  assert.ok(check({ document: duplicate }).some((f) => f.startsWith("duplicate operationId ApprovePlan")));
});

test("a response schema that differs from the one the route validates its replies with fails the check", () => {
  // the documented view loses a member the runtime schema requires (a consumer would accept a reply without actorId)
  const relaxed = clone(committed);
  const view = relaxed.components.schemas.ApprovalView;
  view.required = view.required.filter((m) => m !== "actorId");
  delete view.properties.actorId;
  const failures = check({ document: relaxed });
  assert.ok(failures.includes("response schema mismatch on POST /api/v1/plans/{planId}/approve: status 201 is not the schema urn:kauro:api:v1:response:CMD025 the route validates its replies with"), failures.join("\n"));
  assert.ok(failures.includes("response schema mismatch on POST /api/v1/plans/{planId}/withdraw: status 200 is not the schema urn:kauro:api:v1:response:CMD026 the route validates its replies with"), failures.join("\n"));
  // the route declares another status than the document (a 200 documented where the route answers 201)
  const moved = clone(committed);
  const responses = moved.paths["/api/v1/agencies"].post.responses;
  responses["200"] = responses["201"];
  delete responses["201"];
  const statusFailures = check({ document: moved });
  assert.ok(statusFailures.includes("response schema mismatch on POST /api/v1/agencies: status 200 is documented but the route does not declare it"), statusFailures.join("\n"));
  assert.ok(statusFailures.includes("response schema mismatch on POST /api/v1/agencies: status 201 is not documented as application/json"), statusFailures.join("\n"));
  // the registered route validates with another schema than the one documented
  const rewired = inventory.map((r) => (r.url === "/api/v1/agencies" ? { ...r, responses: { ...r.responses, declared: { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD009" } } } } : r));
  assert.deepEqual(check({ inventory: rewired }), ["response schema mismatch on POST /api/v1/agencies: status 201 is not the schema urn:kauro:api:v1:response:CMD009 the route validates its replies with"]);
  // problems are the closed Problem document
  const loose = clone(committed);
  loose.components.schemas.Problem.additionalProperties = true;
  assert.ok(check({ document: loose }).some((f) => f.includes("status default is not the schema Problem")));
});

test("a DTO that exposes a forbidden field fails the check", () => {
  const leaking = clone(committed);
  leaking.components.schemas.MembershipView.properties.tokenHash = { type: "string", pattern: "^[0-9a-f]{64}$" };
  const failures = check({ document: leaking });
  assert.ok(failures.some((f) => f.startsWith("DTO exposes a forbidden field: POST /api/v1/agencies 201 #/components/schemas/MembershipView/properties/tokenHash")), failures.join("\n"));
  const stack = clone(committed);
  stack.components.schemas.Problem.properties.stack = { type: "string" };
  assert.ok(check({ document: stack }).some((f) => f.includes("#/components/schemas/Problem/properties/stack")));
});

test("generation refuses registry prose that carries the pre-A2 brand (amendment A2)", () => {
  assert.equal(sources.legacyBrands.length, 1, "the legacy token the R2 domain aliases name");
  const legacy = sources.legacyBrands[0];
  const tainted = { ...sources, registryCommands: sources.registryCommands.map((c) => (c.id === "CMD001" ? { ...c, effect: `${c.effect} (${legacy.toLowerCase()} wording)` } : c)) };
  assert.throws(() => generateOpenApi(tainted), /pre-A2 brand/);
});

test("a registered route without a declared response contract and a stale document fail the check", () => {
  const undeclared = inventory.map((r) => (r.url === "/api/v1/agencies" ? { ...r, responses: null } : r));
  assert.deepEqual(check({ inventory: undeclared }), ["registered route declares no response contract: POST /api/v1/agencies"]);
  const stale = clone(committed);
  stale.paths["/api/v1/agencies"].post.summary = "edited by hand";
  assert.deepEqual(check({ document: stale }), ["apps/api/openapi.json is not the generated document (run pnpm run openapi:generate); it differs at /paths/~1api~1v1~1agencies/post/summary"]);
});

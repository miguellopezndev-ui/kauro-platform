// B11 design D-GEN-1 (10 "Consumer tests use the actual generated DTOs"): apps/web/src/api/generated.ts is produced from
// apps/api/openapi.json by tools/web-client.mjs, and `check` (part of `pnpm run verify`) refuses a committed file that is not that
// output. The generator is closed: a construct it does not translate is a failure, never a guess. Each failure class has a negative
// control next to the passing real pair.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCUMENT_PATH, GENERATED_PATH, digestOf, generate, renderClient } from "../web-client.mjs";

const documentText = readFileSync(DOCUMENT_PATH, "utf8");
const document = JSON.parse(documentText);
const clone = () => structuredClone(document);
const failuresOf = (mutated) => renderClient(mutated, "0".repeat(64)).failures;

test("the committed generated module is the generated one, byte for byte, and generation is deterministic", () => {
  const { text, failures } = generate();
  assert.deepEqual(failures, []);
  assert.equal(readFileSync(GENERATED_PATH, "utf8"), text);
  assert.equal(generate().text, text);
  assert.ok(text.includes(`sha256 ${digestOf(documentText)}`), "the header names the digest of the document it was generated from");
  assert.equal(text.includes("\r"), false, "no carriage returns: the file is the same on every platform");
});

test("every served operation of the document is a descriptor with its method, path, idempotency and reply schemas", () => {
  const { text } = generate();
  const served = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) if (item[method] !== undefined) served.push({ method, path, operation: item[method] });
  }
  assert.ok(served.length >= 14, "the document serves the fourteen operations of B06");
  // package B09's provider webhook and payment service routes are no call of the browser: left out, and named in the header
  const service = served.filter(({ operation }) => ["PROVIDER", "PAYMENT_SERVICE"].includes(operation["x-kauro-principal"]));
  assert.deepEqual(service.map(({ operation }) => operation.operationId).sort(), ["ExecuteRefund", "ReceivePaymentWebhook", "ReconcilePayment"]);
  for (const { operation } of service) assert.equal(text.split("\n").some((l) => l.startsWith(`  ${operation.operationId}: {`)), false, `${operation.operationId} has no descriptor`);
  assert.ok(text.includes("// Left out, no browser calls them (a provider's or a service's principal): ExecuteRefund, ReceivePaymentWebhook, ReconcilePayment."));
  served.splice(0, served.length, ...served.filter((entry) => !service.includes(entry)));
  for (const { method, path, operation } of served) {
    assert.ok(text.includes(`export type OperationId = `) && text.includes(JSON.stringify(operation.operationId)), operation.operationId);
    const line = text.split("\n").find((l) => l.startsWith(`  ${operation.operationId}: {"operationId"`));
    assert.ok(line, `${operation.operationId} has a descriptor`);
    const descriptor = JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1));
    assert.equal(descriptor.method, method);
    assert.equal(descriptor.path, path);
    assert.equal(descriptor.planned, false);
    assert.equal(descriptor.idempotency, operation["x-kauro-idempotency"] === "REQUIRED" ? "REQUIRED" : "NONE");
    assert.equal(descriptor.command, operation["x-kauro-command"] ?? null);
    assert.deepEqual(Object.keys(descriptor.replies).sort(), Object.keys(operation.responses).sort());
    assert.equal(descriptor.idempotency === "REQUIRED", method === "post" && operation["x-kauro-command"] !== undefined, `${operation.operationId}: every command is idempotent and nothing else is`);
  }
  for (const name of Object.keys(document.components.schemas)) assert.ok(text.includes(`export function is${name[0].toUpperCase()}${name.slice(1)}(value: unknown)`), `a closed guard for ${name}`);
});

test("a planned operation (x-kauro-planned) is generated beside the served ones, marked planned, and its id must be unique", () => {
  const planned = clone();
  planned["x-kauro-planned"] = {
    "POST /api/v1/agencies/{agencyId}/quotes": {
      operationId: "CreateQuote",
      "x-kauro-command": "CMD028",
      "x-kauro-idempotency": "REQUIRED",
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/CorrelationId" }],
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ArchiveClientRequest" } } } },
      responses: {
        201: { description: "created", content: { "application/json": { schema: { $ref: "#/components/schemas/ArchiveClientCompleted" } } } },
        400: { description: "refused", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      },
    },
  };
  const { text, failures } = renderClient(planned, "0".repeat(64));
  assert.deepEqual(failures, []);
  const line = text.split("\n").find((l) => l.startsWith("  CreateQuote: "));
  assert.ok(line);
  const descriptor = JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1));
  assert.equal(descriptor.planned, true);
  assert.equal(descriptor.method, "post");
  assert.equal(descriptor.path, "/api/v1/agencies/{agencyId}/quotes");
  assert.equal(descriptor.request, "ArchiveClientRequest");
  assert.match(text, /and 1 planned operations/);

  const duplicated = clone();
  duplicated["x-kauro-planned"] = { "POST /api/v1/quotes": { operationId: "ListAgencies", responses: {} } };
  assert.deepEqual(failuresOf(duplicated), ["the operationId ListAgencies is used twice"]);
});

test("negative controls: every construct the generator does not translate is a failure that names where, and no module is produced", () => {
  const open = clone();
  delete open.components.schemas.ArchiveClientRequest.additionalProperties;
  assert.deepEqual(failuresOf(open), ["ArchiveClientRequest: an object with properties must be closed"]);

  const openTrue = clone();
  openTrue.components.schemas.ArchiveClientRequest.additionalProperties = true;
  assert.ok(failuresOf(openTrue).includes("ArchiveClientRequest: an object must be closed (additionalProperties: false)"));

  const keyword = clone();
  keyword.components.schemas.ArchiveClientRequest.properties.expectedVersion.oneOf = [{ type: "integer" }];
  assert.deepEqual(failuresOf(keyword), ["ArchiveClientRequest.expectedVersion: the keyword oneOf is not translated by this generator"]);

  const foreign = clone();
  foreign.components.schemas.ArchiveClientView.properties.client = { $ref: "https://example.test/schemas/EndClientView" };
  assert.ok(failuresOf(foreign).some((f) => f.startsWith("ArchiveClientView.client: a reference must point into #/components/schemas/")));

  const unknownRef = clone();
  unknownRef.components.schemas.ArchiveClientView.properties.client = { $ref: "#/components/schemas/Nope" };
  assert.ok(failuresOf(unknownRef).some((f) => f.includes("the reference Nope names no component")));

  const format = clone();
  format.components.schemas.EndClientView.properties.createdAt.format = "uri";
  assert.ok(failuresOf(format).some((f) => f.includes('the format "uri" is not translated')));

  const pattern = clone();
  pattern.components.schemas.EndClientView.properties.createdAt.pattern = "(";
  assert.ok(failuresOf(pattern).some((f) => f.includes("does not compile")));

  const type = clone();
  type.components.schemas.ArchiveClientRequest.properties.expectedVersion.type = "tuple";
  assert.ok(failuresOf(type).some((f) => f.includes('the type "tuple" is not translated')));

  const undeclared = clone();
  undeclared.components.schemas.ArchiveClientRequest.required = ["expectedVersion", "ghost"];
  assert.ok(failuresOf(undeclared).some((f) => f.includes("required member ghost is not declared")));

  const noItems = clone();
  noItems.components.schemas.AgencyPage.properties.items = { type: "array" };
  assert.ok(failuresOf(noItems).some((f) => f.includes("an array must declare its items")));

  const name = clone();
  name.components.schemas["Bad-Name"] = { type: "string" };
  assert.ok(failuresOf(name).some((f) => f.startsWith("Bad-Name: a component name must be a TypeScript identifier")));

  const duplicate = clone();
  duplicate.paths["/api/v1/agencies"].post.operationId = "ListAgencies";
  assert.deepEqual(failuresOf(duplicate), ["the operationId ListAgencies is used twice"]);

  const missing = clone();
  delete missing.paths["/api/v1/agencies"].get.operationId;
  assert.ok(failuresOf(missing).some((f) => f.includes("the operation has no operationId")));

  const media = clone();
  media.paths["/api/v1/agencies"].post.requestBody.content["text/plain"] = { schema: { $ref: "#/components/schemas/CreateAgencyRequest" } };
  assert.ok(failuresOf(media).some((f) => f.includes("the request body must be application/json only")));

  const inline = clone();
  inline.paths["/api/v1/agencies"].get.responses["200"].content["application/json"].schema = { type: "object", additionalProperties: false, properties: {} };
  assert.ok(failuresOf(inline).some((f) => f.includes("the schema must be a reference to a component")));

  const principal = clone();
  principal.paths["/api/v1/agencies"].post["x-kauro-principal"] = "ROBOT";
  assert.deepEqual(failuresOf(principal), ["POST /api/v1/agencies: the principal \"ROBOT\" is neither a browser's nor a known service's"]);

  const parameter = clone();
  parameter.paths["/api/v1/agencies"].get.parameters.push({ $ref: "#/components/parameters/Nope" });
  assert.ok(failuresOf(parameter).some((f) => f.includes("names no component")));

  for (const mutated of [open, keyword, duplicate]) assert.equal(renderClient(mutated, "0".repeat(64)).text, "", "a failing document produces no module");
});

test("the command line: check passes on the repository, and an unknown mode is a usage error", () => {
  const script = fileURLToPath(new URL("../web-client.mjs", import.meta.url));
  const ok = spawnSync(process.execPath, [script, "check"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /is the module generated from apps\/api\/openapi\.json/);
  const usage = spawnSync(process.execPath, [script, "publish"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: node tools\/web-client\.mjs generate\|check/);
});

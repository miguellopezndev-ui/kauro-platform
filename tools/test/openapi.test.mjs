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
  // the seven registry commands B06 serves and the six of B07, under their registry paths and names, the five manual-10 reads
  // (N16), the seven source reads and the selection manifest intake (B07), CMD044 and the two support reads (B11 W4), the two
  // operational probes, every payment route of
  // package B09 (M4: the request side, M3: the payment service's; D-REQ-B7, D-INT2-B1), the execution and audit routes of package B08 (CMD036 ExecuteProject, CMD037 CancelJob, GetJob; CMD020 StartAudit, CMD021 CancelAudit, CMD022 CreatePlan, CMD024 ValidatePlan, GetAudit and the decision artifact intake; D8-API-1, D8-CMA-7), the served commands of package
  // B10 (CMD002 and CMD043, mandate B10-AGENCY-LIFECYCLE; CMD027, mandate B10-COMMANDS-QUOTE; CMD045..CMD047, mandate B10-COMMANDS-PROSPECTS; CMD048..CMD050, mandate B10-COMMANDS-SELLERS),
  // the five routes of the browser session boundary (B11 W2), the two public routes (B11 W5b), and the Payments V1 bank-transfer
  // routes (L-ROUTE: the five operational bank-route commands, getBankRoute, and the KIT read getTransferInstructions)
  assert.deepEqual(
    inventory.map((r) => `${r.method} ${openApiPath(r.url)} ${r.responses.operationId}`).sort(),
    [
      "GET /api/v1/agencies ListAgencies",
      "GET /api/v1/agencies/{agencyId} GetAgency",
      "GET /api/v1/agencies/{agencyId}/buyer-type GetBuyerType",
      "GET /api/v1/agencies/{agencyId}/clients ListClients",
      "GET /api/v1/agencies/{agencyId}/members ListMembers",
      "GET /api/v1/agencies/{agencyId}/projects ListProjects",
      "GET /api/v1/audits/{auditId} GetAudit",
      "GET /api/v1/jobs/{jobId} GetJob",
      "GET /api/v1/operations/bank-routes/{routeId} getBankRoute",
      "GET /api/v1/operations/refunds/{refundId} GetRefundReview",
      "GET /api/v1/payment-orders/{orderId} GetPaymentOrder",
      "GET /api/v1/payment-orders/{orderId}/transfer-instructions getTransferInstructions",
      "GET /api/v1/projects/{projectId} GetProject",
      "GET /api/v1/projects/{projectId}/support-cases ListSupportCases",
      "GET /api/v1/public/capability-publication getCapabilityPublication",
      "GET /api/v1/public/identity-config getIdentityConfig",
      "GET /api/v1/quotes/{quoteId} GetQuote",
      "GET /api/v1/refunds/{refundId} GetRefund",
      "GET /api/v1/revisions/{revisionId} GetRevision",
      "GET /api/v1/revisions/{revisionId}/inspection GetInspection",
      "GET /api/v1/revisions/{revisionId}/selection-manifests/{selectionManifestId} GetSelectionManifest",
      "GET /api/v1/revisions/{revisionId}/tables/{tableId}/preview PreviewTable",
      "GET /api/v1/revisions/{revisionId}/uploads ListUploads",
      "GET /api/v1/sales/statements/{statementId} GetCommissionStatement",
      "GET /api/v1/sessions/current getCurrentSession",
      "GET /api/v1/support-cases/{caseId} GetSupportCase",
      "GET /api/v1/uploads/{uploadId} GetUpload",
      "GET /api/v1/uploads/{uploadId}/session GetUploadSession",
      "GET /livez getLiveness",
      "GET /readyz getReadiness",
      "POST /api/v1/agencies CreateAgency",
      "POST /api/v1/agencies/{agencyId}/activate ActivateAgency",
      "POST /api/v1/agencies/{agencyId}/buyer-type setBuyerType",
      "POST /api/v1/agencies/{agencyId}/clients CreateClient",
      "POST /api/v1/agencies/{agencyId}/closure-requests CloseAgency",
      "POST /api/v1/assurance/step-ups createStepUp",
      "POST /api/v1/audits/{auditId}/cancel CancelAudit",
      "POST /api/v1/audits/{auditId}/decision-artifacts SubmitDecisionArtifact",
      "POST /api/v1/audits/{auditId}/plans CreatePlan",
      "POST /api/v1/clients/{clientId}/archive ArchiveClient",
      "POST /api/v1/clients/{clientId}/projects CreateProject",
      "POST /api/v1/jobs/{jobId}/cancel CancelJob",
      "POST /api/v1/operations/bank-routes configureBankRoute",
      "POST /api/v1/operations/bank-routes/{routeId}/details replaceBankRouteDetails",
      "POST /api/v1/operations/bank-routes/{routeId}/disable disableBankRoute",
      "POST /api/v1/operations/bank-routes/{routeId}/enable enableBankRoute",
      "POST /api/v1/operations/bank-routes/{routeId}/verify verifyBankRoute",
      "POST /api/v1/operations/capabilities/{capabilityId}/restrict RestrictCapability",
      "POST /api/v1/operations/capabilities/{capabilityId}/versions ChangeCapability",
      "POST /api/v1/operations/incidents RecordIncident",
      "POST /api/v1/operations/recoveries AuthorizeRecovery",
      "POST /api/v1/payment-orders/{orderId}/capture CapturePayment",
      "POST /api/v1/payment-orders/{orderId}/reconcile ReconcilePayment",
      "POST /api/v1/payments/webhooks/{provider} ReceivePaymentWebhook",
      "POST /api/v1/plans/{planId}/approve ApprovePlan",
      "POST /api/v1/plans/{planId}/revisions RevisePlan",
      "POST /api/v1/plans/{planId}/validate ValidatePlan",
      "POST /api/v1/plans/{planId}/withdraw WithdrawApproval",
      "POST /api/v1/projects/{projectId}/execute ExecuteProject",
      "POST /api/v1/projects/{projectId}/import-stages/{stageId}/continue ContinueStage",
      "POST /api/v1/projects/{projectId}/import-stages/{stageId}/receipts SubmitStageReceipt",
      "POST /api/v1/projects/{projectId}/quotes CreateQuote",
      "POST /api/v1/projects/{projectId}/refund-requests RequestRefund",
      "POST /api/v1/projects/{projectId}/revisions CreateRevision",
      "POST /api/v1/projects/{projectId}/support-cases CreateSupportCase",
      "POST /api/v1/projects/{projectId}/target-contracts CreateTargetContract",
      "POST /api/v1/public/inquiries createInquiry",
      "POST /api/v1/quotes/{quoteId}/payment-orders CreatePaymentOrder",
      "POST /api/v1/refunds/{refundId}/approve ApproveRefund",
      "POST /api/v1/refunds/{refundId}/execute ExecuteRefund",
      "POST /api/v1/revisions/{revisionId}/audits StartAudit",
      "POST /api/v1/revisions/{revisionId}/seal SealRevision",
      "POST /api/v1/revisions/{revisionId}/selection SelectInputTables",
      "POST /api/v1/revisions/{revisionId}/selection-manifests SubmitSelectionManifest",
      "POST /api/v1/revisions/{revisionId}/uploads ReserveUpload",
      "POST /api/v1/sales/agencies/{agencyId}/assignment AssignAccount",
      "POST /api/v1/sales/claims/{claimId}/accept AcceptAttribution",
      "POST /api/v1/sales/commission-periods/{periodId}/close CloseCommissionPeriod",
      "POST /api/v1/sales/prospects RegisterProspect",
      "POST /api/v1/sales/prospects/{prospectId}/claims ClaimProspect",
      "POST /api/v1/sales/sellers/{sellerId}/activate ActivateSeller",
      "POST /api/v1/sales/sellers/{sellerId}/terminate TerminateSeller",
      "POST /api/v1/sales/statements/{statementId}/approve-payout ApproveCommissionPayout",
      "POST /api/v1/sales/statements/{statementId}/reconcile-payout ReconcileCommissionPayout",
      "POST /api/v1/sessions openSession",
      "POST /api/v1/sessions/current/revoke revokeCurrentSession",
      "POST /api/v1/target-contracts/{contractId}/confirm ConfirmTargetContract",
      "POST /api/v1/uploads/{uploadId}/cancel CancelUpload",
      "POST /api/v1/uploads/{uploadId}/complete CompleteUpload",
    ],
  );
  for (const command of sources.registryCommands.filter((c) => sources.application.SERVED_COMMAND_IDS.includes(c.id))) {
    const op = expected.paths[command.path][command.method.toLowerCase()];
    assert.equal(op.operationId, command.name);
    assert.equal(op["x-kauro-command"], command.id);
    assert.deepEqual(op["x-kauro-cases"], command.testIds);
    assert.equal(op.requestBody.content["application/json"].schema.$ref, `#/components/schemas/${command.name}Request`);
    // the success status and one Problem per status of the command's outcome catalogue (N13), no catch-all
    const problemStatuses = sources.application.outcomesByStatus(sources.application.COMMAND_OUTCOMES[command.id]).map(([status]) => String(status));
    assert.deepEqual(Object.keys(op.responses).sort(), [String(sources.application.COMMAND_RESPONSES[command.id].status), ...problemStatuses].sort());
    for (const status of problemStatuses) assert.ok(Array.isArray(op.responses[status]["x-kauro-outcomes"]) && op.responses[status]["x-kauro-outcomes"].length > 0, `${command.name} ${status}`);
  }
  // the manual-10 reads (N16): 200 and their catalogue's problem statuses
  for (const read of Object.values(sources.application.READ_ROUTES)) {
    const op = expected.paths[read.path].get;
    assert.equal(op.operationId, read.operationId);
    assert.equal(op["x-kauro-read"], true);
    const problemStatuses = sources.application.outcomesByStatus(sources.application.READ_OUTCOMES[read.operationId]).map(([status]) => String(status));
    assert.deepEqual(Object.keys(op.responses).sort(), ["200", ...problemStatuses].sort());
  }
  // the probes, the session routes, the public routes and the Payments V1 bank-transfer routes (L-ROUTE) are the operational routes of @kauro/application (R42 connected to R23):
  // documented with the replies they declare — a probe with the one Problem default, a session or public route with one Problem per
  // status of its closed catalogue (like a command's), a body-less 204 without content, a request body where the route takes one
  for (const route of sources.operationalRoutes) {
    const op = expected.paths[route.path][route.method.toLowerCase()];
    assert.equal(op.operationId, route.operationId);
    assert.equal(op["x-kauro-operational"], true);
    const outcomes = sources.application.OPERATIONAL_OUTCOMES[route.operationId];
    const problemStatuses = outcomes === undefined ? ["default"] : sources.application.outcomesByStatus(outcomes).map(([status]) => String(status));
    assert.deepEqual(Object.keys(op.responses).sort(), [...Object.keys(route.responses), ...problemStatuses].sort());
    for (const [status, response] of Object.entries(route.responses)) assert.equal(op.responses[status].content === undefined, response.schema === null, `${route.operationId} ${status}`);
    assert.equal(op.requestBody !== undefined, route.request !== undefined, route.operationId);
  }
  assert.deepEqual(sources.operationalRoutes.map((r) => `${r.method} ${r.path} ${r.operationId}`), [
    "GET /livez getLiveness",
    "GET /readyz getReadiness",
    "POST /api/v1/sessions openSession",
    "GET /api/v1/sessions/current getCurrentSession",
    "POST /api/v1/sessions/current/revoke revokeCurrentSession",
    "POST /api/v1/assurance/step-ups createStepUp",
    "GET /api/v1/public/identity-config getIdentityConfig",
    "GET /api/v1/public/capability-publication getCapabilityPublication",
    "POST /api/v1/public/inquiries createInquiry",
    "POST /api/v1/operations/bank-routes configureBankRoute",
    "POST /api/v1/operations/bank-routes/{routeId}/verify verifyBankRoute",
    "POST /api/v1/operations/bank-routes/{routeId}/enable enableBankRoute",
    "POST /api/v1/operations/bank-routes/{routeId}/disable disableBankRoute",
    "POST /api/v1/operations/bank-routes/{routeId}/details replaceBankRouteDetails",
    "GET /api/v1/operations/bank-routes/{routeId} getBankRoute",
    "GET /api/v1/payment-orders/{orderId}/transfer-instructions getTransferInstructions",
    "POST /api/v1/agencies/{agencyId}/buyer-type setBuyerType",
  ]);
  // the public routes take no credential (an explicit empty security requirement) and the inquiry names the Origin it demands
  for (const [path, method] of [["/api/v1/public/capability-publication", "get"], ["/api/v1/public/inquiries", "post"]]) assert.deepEqual(expected.paths[path][method].security, [], path);
  assert.deepEqual(expected.paths["/api/v1/public/inquiries"].post.parameters, [{ $ref: "#/components/parameters/CorrelationId" }, { $ref: "#/components/parameters/InquiryOrigin" }]);
  assert.deepEqual(expected.paths["/api/v1/public/capability-publication"].get.parameters, [{ $ref: "#/components/parameters/CorrelationId" }]);
  assert.equal(expected.paths["/api/v1/public/inquiries"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/createInquiryRequest");
  assert.ok(expected.components.schemas.createInquiryRequest.properties.buyerType.enum.includes("in-house"));
  // the ApprovalView component carries every member of the KAURO_PLAN_APPROVAL_V1 preimage (R29)
  const approval = expected.components.schemas.ApprovalView;
  for (const member of ["approvalId", "actorId", "agencyId", "planHash", "revisionHash", "targetContractHash", "validationReceiptHash", "disclosuresHash", "createdAt"]) {
    assert.ok(approval.required.includes(member), member);
  }
});

test("an undocumented registered route fails the check", () => {
  const extra = { method: "GET", url: "/api/v1/agencies/:agencyId/invitations", responses: inventory[0].responses };
  assert.deepEqual(check({ inventory: [...inventory, extra] }).filter((f) => f.startsWith("undocumented")), ["undocumented registered route: GET /api/v1/agencies/{agencyId}/invitations"]);
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
  const rewired = inventory.map((r) => (r.url === "/api/v1/agencies" && r.method === "POST" ? { ...r, responses: { ...r.responses, declared: { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD009" } } } } : r));
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
  const undeclared = inventory.map((r) => (r.url === "/api/v1/agencies" && r.method === "POST" ? { ...r, responses: null } : r));
  assert.deepEqual(check({ inventory: undeclared }), ["registered route declares no response contract: POST /api/v1/agencies"]);
  const stale = clone(committed);
  stale.paths["/api/v1/agencies"].post.summary = "edited by hand";
  assert.deepEqual(check({ document: stale }), ["apps/api/openapi.json is not the generated document (run pnpm run openapi:generate); it differs at /paths/~1api~1v1~1agencies/post/summary"]);
});

test("B07-F13: the source-lifecycle routes are served and documented under paths from their contracts — every command, read and the selection manifest intake, none left planned; the planned mechanism stays for later packages: a planned operation that is registered, also served, repeats an operationId or exposes a forbidden member fails the check", () => {
  const { application } = sources;
  // B07 plans nothing any more (mandate B07-COMMANDS served every specified route)
  assert.deepEqual(committed["x-kauro-planned"], {});
  for (const spec of Object.values(application.B07_COMMANDS)) {
    const op = committed.paths[spec.path][spec.method.toLowerCase()];
    assert.equal(op.operationId, spec.name);
    assert.equal(op["x-kauro-command"], spec.id);
    const reply = application.COMMAND_RESPONSES[spec.id];
    const problemStatuses = application.outcomesByStatus(application.COMMAND_OUTCOMES[spec.id]).map(([status]) => String(status));
    assert.deepEqual(Object.keys(op.responses).sort(), [String(reply.status), ...problemStatuses].sort(), spec.id);
    assert.ok(op.parameters.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"), spec.id);
  }
  // CompleteUpload answers the ACCEPTED envelope (completion remains asynchronous, D-RUN-1)
  assert.deepEqual(committed.paths["/api/v1/uploads/{uploadId}/complete"].post.responses["202"].content["application/json"].schema, { $ref: "#/components/schemas/AcceptedResponse" });
  for (const [operationId, route] of Object.entries(application.SOURCE_ROUTES)) {
    const op = committed.paths[route.path][route.method.toLowerCase()];
    assert.equal(op.operationId, operationId);
    if (route.method === "GET") assert.equal(op["x-kauro-read"], true, operationId);
  }
  // the intake: no idempotency key (content-idempotent), 201 stored and 200 the same document again, the document schema as body
  const intake = committed.paths["/api/v1/revisions/{revisionId}/selection-manifests"].post;
  assert.equal(intake["x-kauro-intake"], true);
  assert.ok(!intake.parameters.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"));
  assert.deepEqual(intake.requestBody.content["application/json"].schema, { $ref: "#/components/schemas/SelectionManifestDocument" });
  for (const status of ["200", "201"]) assert.deepEqual(intake.responses[status].content["application/json"].schema, { $ref: "#/components/schemas/SubmitSelectionManifestReply" });
  // the planned mechanism (B09 plans its payment routes the same way): an operation planned where a served route stands
  const seal = committed.paths["/api/v1/revisions/{revisionId}/seal"].post;
  const planned = (operation) => {
    const document = clone(committed);
    document["x-kauro-planned"] = { "POST /api/v1/revisions/{revisionId}/seal": operation };
    return check({ document }).filter((f) => !f.startsWith("apps/api/openapi.json is not the generated document"));
  };
  assert.deepEqual(planned({ ...clone(seal), operationId: "PlannedSeal" }), [
    "planned route is registered: POST /api/v1/revisions/{revisionId}/seal (a served route is documented under paths)",
    "planned route is also documented as served: POST /api/v1/revisions/{revisionId}/seal",
  ]);
  assert.ok(planned(clone(seal)).some((f) => f.startsWith("duplicate operationId SealRevision")));
  const leaking = { ...clone(seal), operationId: "PlannedLeak", responses: { 200: { description: "leak", content: { "application/json": { schema: { type: "object", properties: { sessionUri: { type: "string" } } } } } } } };
  assert.ok(planned(leaking).some((f) => f.startsWith("DTO exposes a forbidden field: planned ") && f.includes("sessionUri")));
  // and a served source route that leaks is refused like any other (the bearer session URI never rides on progress)
  const leakingView = clone(committed);
  leakingView.components.schemas.UploadView.properties.sessionUri = { type: "string" };
  assert.ok(check({ document: leakingView }).some((f) => f.startsWith("DTO exposes a forbidden field: GET /api/v1/uploads/{uploadId} ") && f.includes("sessionUri")));
});

test("B09: the payment routes are documented from their contracts — a served one under paths with exactly the replies its route declares, the rest as planned operations never registered and never also served; a planned route the api registers, a repeated operationId and a forbidden DTO member fail the check", () => {
  const { application } = sources;
  const planned = expected["x-kauro-planned"];
  const commands = Object.values(application.COMMERCE_COMMANDS);
  const reads = Object.entries(application.COMMERCE_READ_ROUTES);
  // the served lists decide where each operation lives (D-REQ-B7): paths, or the planned list — never both, never neither
  assert.deepEqual(
    Object.keys(planned).sort(),
    [...commands.filter((c) => !application.isServedCommerceCommand(c.id)).map((c) => `${c.method} ${c.path}`), ...reads.filter(([id]) => !application.isServedCommerceRead(id)).map(([, r]) => `GET ${r.path}`)].sort(),
  );
  const operationOf = (served, method, path) => (served ? expected.paths[path]?.[method.toLowerCase()] : planned[`${method} ${path}`]);
  for (const spec of commands) {
    const served = application.isServedCommerceCommand(spec.id);
    const op = operationOf(served, spec.method, spec.path);
    assert.ok(op !== undefined, spec.id);
    assert.equal(served ? planned[`${spec.method} ${spec.path}`] : expected.paths[spec.path]?.[spec.method.toLowerCase()], undefined, `${spec.id} is documented once`);
    assert.equal(op.operationId, spec.name);
    assert.equal(op["x-kauro-role"], spec.role);
    assert.equal(op["x-kauro-package"], "B09");
    const reply = application.COMMERCE_COMMAND_RESPONSES[spec.id];
    const problemStatuses = application.outcomesByStatus(application.COMMERCE_COMMAND_OUTCOMES[spec.id]).map(([status]) => String(status));
    assert.deepEqual(Object.keys(op.responses).sort(), [String(reply.status), ...(reply.accepted ? ["202"] : []), ...problemStatuses].sort(), spec.id);
    const route = inventory.find((r) => r.method === spec.method && openApiPath(r.url) === spec.path);
    if (served) {
      // a served operation documents exactly the replies its route declares (the 202 accepted observation beside the success)
      assert.ok(route !== undefined, `${spec.id} is registered`);
      assert.deepEqual(route.responses, application.commerceCommandRouteResponses(spec.id), spec.id);
    } else assert.equal(route, undefined, `${spec.id} is not registered`);
  }
  for (const [operationId, spec] of reads) {
    const op = operationOf(application.isServedCommerceRead(operationId), "GET", spec.path);
    assert.equal(op.operationId, operationId);
    assert.equal(op["x-kauro-read"], true);
    assert.equal(op["x-kauro-scope"], spec.scope);
  }
  // every B09 operation is served after the stage-2 integration (D-INT2-B1): M4's request side — the four commands and the four
  // reads the agency and the corporate owner call — and M3's payment service side (the webhook, ExecuteRefund, ReconcilePayment)
  assert.deepEqual([...application.COMMERCE_SERVED_COMMAND_IDS], ["CMD028", "CMD029", "CMD030", "CMD031", "CMD032", "CMD033", "CMD034"]);
  assert.deepEqual(Object.keys(planned), [], "nothing of the payment catalogue stays planned");
  assert.deepEqual([...application.COMMERCE_SERVED_READ_IDS], ["GetQuote", "GetPaymentOrder", "GetRefund", "GetRefundReview"]);
  // the webhook takes no idempotency key and no bearer token: its identity is the provider inbox, its authentication the signature
  const webhook = operationOf(application.isServedCommerceCommand("CMD030"), "POST", "/api/v1/payments/webhooks/{provider}");
  assert.deepEqual(webhook.security, []);
  assert.equal(webhook.parameters.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"), false);
  // the payment service authenticates as a service identity, never as a person; the corporate owner and the agency as people
  assert.deepEqual(operationOf(application.isServedCommerceCommand("CMD033"), "POST", "/api/v1/refunds/{refundId}/execute").security, [{ serviceAuth: [] }]);
  assert.deepEqual(operationOf(application.isServedCommerceCommand("CMD034"), "POST", "/api/v1/payment-orders/{orderId}/reconcile").security, [{ serviceAuth: [] }]);
  const approve = expected.paths["/api/v1/refunds/{refundId}/approve"].post;
  // a person authenticates with a bearer token or the browser session, whose unsafe requests carry the CSRF token (B11 D-AUTH-5)
  assert.deepEqual(approve.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
  assert.equal(approve.parameters.some((p) => p.$ref === "#/components/parameters/CsrfToken"), true);
  assert.equal(operationOf(true, "POST", "/api/v1/refunds/{refundId}/execute").parameters.some((p) => p.$ref === "#/components/parameters/CsrfToken"), false, "a service identity sends no session cookie");
  assert.equal(approve.parameters.some((p) => p.$ref === "#/components/parameters/AgencySelector"), false, "the scope of an operator is the stored operation, never a selector");
  assert.equal(expected.paths["/api/v1/quotes/{quoteId}/payment-orders"].post.parameters.some((p) => p.$ref === "#/components/parameters/AgencySelector"), true);
  // a route documented as planned that the api registers fails the check (it must be served from paths), and so does a planned
  // operationId that repeats a served one
  const demoted = clone(committed);
  demoted["x-kauro-planned"]["POST /api/v1/refunds/{refundId}/approve"] = { ...demoted.paths["/api/v1/refunds/{refundId}/approve"].post, operationId: "ApprovePlan" };
  delete demoted.paths["/api/v1/refunds/{refundId}/approve"];
  const demotedFailures = check({ document: demoted });
  assert.ok(demotedFailures.includes("planned route is registered: POST /api/v1/refunds/{refundId}/approve (a served route is documented under paths)"), demotedFailures.join("\n"));
  assert.ok(demotedFailures.includes("undocumented registered route: POST /api/v1/refunds/{refundId}/approve"), demotedFailures.join("\n"));
  assert.ok(demotedFailures.some((f) => f.startsWith("duplicate operationId ApprovePlan")), demotedFailures.join("\n"));
  // a served operation also listed as planned
  const twice = clone(committed);
  twice["x-kauro-planned"]["POST /api/v1/refunds/{refundId}/approve"] = { ...twice.paths["/api/v1/refunds/{refundId}/approve"].post, operationId: "ApproveRefundAgain" };
  assert.ok(check({ document: twice }).includes("planned route is also documented as served: POST /api/v1/refunds/{refundId}/approve"));
  // a forbidden member in a payment view is refused wherever the view is documented, served or planned
  const leaking = clone(committed);
  leaking.components.schemas.RefundView.properties.tokenHash = { type: "string", pattern: "^[0-9a-f]{64}$" };
  leaking["x-kauro-planned"]["POST /api/v1/refunds/{refundId}/approve-again"] = { ...leaking.paths["/api/v1/refunds/{refundId}/approve"].post, operationId: "ApproveRefundAgain" };
  const leaks = check({ document: leaking });
  assert.ok(leaks.some((f) => f.startsWith("DTO exposes a forbidden field: POST /api/v1/projects/{projectId}/refund-requests 201")), leaks.join("\n"));
  assert.ok(leaks.some((f) => f.startsWith("DTO exposes a forbidden field: planned POST /api/v1/refunds/{refundId}/approve-again 200")), leaks.join("\n"));
});

test("B08-COMMANDS-AUDIT: the audit routes are documented from their contracts — the four commands with the registry's paths, StartAudit and ValidatePlan as ACCEPTED, GetAudit as a read and the decision artifact intake with its closed envelope, 201 stored and 200 the same document again", () => {
  const audits = committed.paths["/api/v1/revisions/{revisionId}/audits"].post;
  assert.equal(audits.operationId, "StartAudit");
  assert.deepEqual(Object.keys(audits.responses).filter((status) => status.startsWith("2")), ["202"]);
  assert.deepEqual(audits.responses["202"].content["application/json"].schema, { $ref: "#/components/schemas/AcceptedResponse" });
  assert.match(audits.responses["202"].description, /GetAudit/);
  const validate = committed.paths["/api/v1/plans/{planId}/validate"].post;
  assert.equal(validate.operationId, "ValidatePlan");
  assert.deepEqual(validate.responses["202"].content["application/json"].schema, { $ref: "#/components/schemas/AcceptedResponse" });
  const cancel = committed.paths["/api/v1/audits/{auditId}/cancel"].post;
  assert.deepEqual(Object.keys(cancel.responses).filter((status) => status.startsWith("2")), ["200"]);
  const plans = committed.paths["/api/v1/audits/{auditId}/plans"].post;
  assert.deepEqual(Object.keys(plans.responses).filter((status) => status.startsWith("2")), ["201"]);
  const read = committed.paths["/api/v1/audits/{auditId}"].get;
  assert.equal(read["x-kauro-read"], true);
  const intake = committed.paths["/api/v1/audits/{auditId}/decision-artifacts"].post;
  assert.equal(intake["x-kauro-intake"], true);
  assert.ok(!intake.parameters.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"));
  assert.deepEqual(intake.requestBody.content["application/json"].schema, { $ref: "#/components/schemas/DecisionArtifactDocument" });
  for (const status of ["200", "201"]) assert.deepEqual(intake.responses[status].content["application/json"].schema, { $ref: "#/components/schemas/SubmitDecisionArtifactReply" });
  const envelope = committed.components.schemas.DecisionArtifactDocument;
  assert.equal(envelope.additionalProperties, false, "the envelope is closed");
  assert.deepEqual([...envelope.required].sort(), ["document", "kind"]);
});

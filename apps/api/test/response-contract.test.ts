// R23 — every reply is a validated DTO (10 "Responses and safe errors": "Synchronous success returns a validated DTO and
// version"; 10 "Version and validation": "TypeScript types alone are insufficient runtime validation"; 07 "Command outcomes and
// error taxonomy": an unexpected failure is recorded with an opaque correlation id, integrity failure is its own outcome).
// R29 — ApprovalView carries actorId, so a consumer recomputes approvalHash from the DTO (registry contract Approval:
// actorId required; reference/HASHING_AND_ACCOUNTING_RULES: KAURO_PLAN_APPROVAL_V1 preimage, "the consumer recomputes the
// relevant preimage"). Real routes, real composition root, real PostgreSQL 17 (apps/api/test/support.ts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { ActiveWorkSummary, WithdrawApprovalView } from "@kauro/application";
import { PROBLEM_RESPONSE, ResponseContractViolation, commandRouteResponses } from "@kauro/application";
import type { FailureReason, FieldError, ProjectId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { assembleApi, classifyInternalError, createBearerTokenAuthenticator, routeInventoryOf } from "../src/index.js";
import { approveThroughRoute, asProblem, call, completed, freshKey, ids, routes, sha, world, type World } from "./support.js";

const SENTINEL = `sentinel-${randomBytes(8).toString("hex")}`;

/** What the test-bound collaborators add or throw while a test arms them (ports of @kauro/application, never the database). */
const leak: { summary: Record<string, unknown> | null; failure: DomainFailure | null } = { summary: null, failure: null };

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world({
    collaborators: (base) => ({
      ...base,
      activeWork: {
        async inspectClient(uow, clientId) {
          const summary = await base.activeWork.inspectClient(uow, clientId);
          // a collaborator of a later package that reports more than the view declares
          return leak.summary === null ? summary : ({ ...summary, ...leak.summary } as ActiveWorkSummary);
        },
      },
      externalActions: {
        async completedForPlan(uow, planId) {
          if (leak.failure !== null) throw leak.failure;
          return base.externalActions.completedForPlan(uow, planId);
        },
      },
    }),
  });
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

function assertNoSentinel(text: string, headers: Record<string, unknown>): void {
  const wire = JSON.stringify(headers) + "\n" + text;
  for (const s of [SENTINEL, sha(SENTINEL), "SELECT", "kauro."]) assert.ok(!wire.includes(s), `${s} reached the wire`);
}

test("R23: a success reply its route's contract refuses is never sent — a member a collaborator adds to the ArchiveClient view is answered 422 INTEGRITY_FAILURE under the correlation id, and the sink receives the violation (path and code, never the value)", async () => {
  const clientId = await w.h.endClient(w.A, w.authorityA, "Leaky client");
  const key = freshKey("r23-success-leak");
  const correlationId = ids.next();
  const sunk = w.internalErrors.length;
  leak.summary = { tokenHash: sha(SENTINEL), sql: `SELECT ${SENTINEL} FROM kauro.identities` };
  let reply;
  try {
    reply = await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key, headers: { "x-correlation-id": correlationId }, body: { expectedVersion: 1 } });
  } finally {
    leak.summary = null;
  }
  assert.equal(reply.status, 422);
  assert.equal(reply.contentType, "application/problem+json; charset=utf-8");
  assert.equal(reply.headers["x-correlation-id"], correlationId);
  const p = asProblem(w, reply);
  assert.deepEqual(
    { code: p.code, reason: p.reason, correlationId: p.correlationId, retryable: p.retryable, nextActions: p.nextActions },
    { code: "INTEGRITY_FAILURE", reason: "RESPONSE_CONTRACT_VIOLATION", correlationId, retryable: false, nextActions: [{ action: "CONTACT_SUPPORT" }] },
  );
  assertNoSentinel(reply.text, reply.headers);
  // the sink received the violation once, under the request's correlation id: schema, status and paths, no value
  assert.equal(w.internalErrors.length, sunk + 1);
  const recorded = w.internalErrors.at(-1)!;
  assert.equal(recorded.correlationId, correlationId);
  assert.ok(recorded.error instanceof ResponseContractViolation);
  assert.equal(classifyInternalError(recorded.error), "ResponseContractViolation");
  assert.deepEqual(
    { operationId: recorded.error.operationId, status: recorded.error.status, schemaId: recorded.error.schemaId, fields: [...recorded.error.fields].sort((a, b) => (a.field < b.field ? -1 : 1)) },
    {
      operationId: "ArchiveClient",
      status: 200,
      schemaId: "urn:kauro:api:v1:response:CMD010",
      fields: [
        { field: "data/retainedActiveWork/sql", code: "UNKNOWN_FIELD" },
        { field: "data/retainedActiveWork/tokenHash", code: "UNKNOWN_FIELD" },
      ],
    },
  );
  assert.ok(!recorded.error.message.includes(SENTINEL) && !recorded.error.message.includes(sha(SENTINEL)), "the violation names paths, never values");
  // the check runs at the send boundary, after COMMIT: the archive is durable (10 "An unexpected 500 does not automatically
  // mean a command did not commit"), the journal holds the answer the guard refused, and a retry with the same key replays
  // that journaled answer through the same check — refused again, never sent, never executed twice
  assert.deepEqual(await w.row<{ state: string; version: string }>("end_clients", "client_id = $1", [clientId]).then((r) => r && [r.state, r.version]), ["ARCHIVED", "2"]);
  assert.equal((await w.journal(key))?.state, "COMMITTED");
  const retry = await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key, body: { expectedVersion: 1 } });
  assert.equal(retry.status, 422);
  assert.equal(asProblem(w, retry).reason, "RESPONSE_CONTRACT_VIOLATION");
  assertNoSentinel(retry.text, retry.headers);
  assert.equal(w.internalErrors.length, sunk + 2);
  assert.deepEqual((await w.events("end_client", clientId)).map((e) => e.type), ["end_client.created.v1", "end_client.archived.v1"]);
  // the same route answers its declared COMPLETED reply when nothing is added
  const clean = await w.h.endClient(w.A, w.authorityA, "Clean client");
  const ok = completed<{ client: { state: string } }>(await call(w, { url: routes.archiveClient(clean), token: w.admin.token, body: { expectedVersion: 1 } }), 200);
  assert.equal(ok.data.client.state, "ARCHIVED");
  assert.equal(w.internalErrors.length, sunk + 2);
});

test("R23: a problem its contract refuses is never sent — a collaborator failure carrying a raw value beside its field error and a reason outside the vocabulary answers 422 INTEGRITY_FAILURE; the withdrawal rolled back", async () => {
  const plan = await w.approvable(w.A, projectId, "r23-problem-leak");
  const approved = await approveThroughRoute(w, plan);
  const correlationId = ids.next();
  const sunk = w.internalErrors.length;
  leak.failure = new DomainFailure("INVALID_REQUEST", `SELECT ${SENTINEL}`, {
    reason: `SENTINEL_${SENTINEL.slice(-8).toUpperCase()}` as FailureReason,
    fields: [{ field: "reasonCode", code: "TYPE", value: SENTINEL } as unknown as FieldError],
  });
  let reply;
  try {
    reply = await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, headers: { "x-correlation-id": correlationId }, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } });
  } finally {
    leak.failure = null;
  }
  assert.equal(reply.status, 422);
  assert.equal(asProblem(w, reply).code, "INTEGRITY_FAILURE");
  assert.equal(asProblem(w, reply).correlationId, correlationId);
  assertNoSentinel(reply.text, reply.headers);
  assert.ok(!reply.text.includes(SENTINEL.slice(-8).toUpperCase()), "the invented reason did not reach the wire");
  assert.equal(w.internalErrors.length, sunk + 1);
  const recorded = w.internalErrors.at(-1)!;
  assert.ok(recorded.error instanceof ResponseContractViolation);
  assert.equal(recorded.correlationId, correlationId);
  assert.deepEqual(
    { status: recorded.error.status, schemaId: recorded.error.schemaId, fields: [...recorded.error.fields].sort((a, b) => (a.field < b.field ? -1 : 1)) },
    { status: 400, schemaId: "Problem", fields: [{ field: "errors/0/value", code: "UNKNOWN_FIELD" }, { field: "reason", code: "ENUM" }] },
  );
  // nothing committed: the approval is still live at v1 and the plan APPROVED at v5
  assert.deepEqual(await w.row<{ version: string; withdrawn_at: Date | null }>("approvals", "approval_id = $1", [approved.data.approval.approvalId]).then((r) => r && [r.version, r.withdrawn_at]), ["1", null]);
  assert.deepEqual(await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]).then((r) => r && [r.state, r.version]), ["APPROVED", "5"]);
});

test("R23: every served route declares its replies (the route inventory the OpenAPI checker reads); a route that declares none refuses to register; a reply whose declared schema the validator never compiled, or whose body is sent as text instead of a checked object, is refused like any other violation", async () => {
  assert.deepEqual(
    routeInventoryOf(w.app).map((r) => [r.method, r.url, r.responses.operationId, r.responses.declared, r.responses.problem]),
    [
      // the probes are the operational routes of the response contract (OPERATIONAL_ROUTES; review R42 connected to R23)
      ["GET", "/livez", "getLiveness", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:op:getLiveness:200" } }],
      ["GET", "/readyz", "getReadiness", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:op:getReadiness:200" }, 503: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:op:getReadiness:503" } }],
      ["POST", "/api/v1/agencies", "CreateAgency", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD001" } }],
      ["POST", "/api/v1/agencies/:agencyId/clients", "CreateClient", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD009" } }],
      ["POST", "/api/v1/clients/:clientId/archive", "ArchiveClient", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD010" } }],
      ["POST", "/api/v1/clients/:clientId/projects", "CreateProject", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD011" } }],
      ["POST", "/api/v1/plans/:planId/revisions", "RevisePlan", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD023" } }],
      ["POST", "/api/v1/plans/:planId/approve", "ApprovePlan", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD025" } }],
      ["POST", "/api/v1/plans/:planId/withdraw", "WithdrawApproval", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD026" } }],
      // the six source-lifecycle commands (B07 design §11); CompleteUpload answers the shared ACCEPTED envelope (D-RUN-1)
      ["POST", "/api/v1/projects/:projectId/revisions", "CreateRevision", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD012" } }],
      ["POST", "/api/v1/revisions/:revisionId/uploads", "ReserveUpload", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD013" } }],
      ["POST", "/api/v1/uploads/:uploadId/complete", "CompleteUpload", { 202: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:accepted" } }],
      ["POST", "/api/v1/uploads/:uploadId/cancel", "CancelUpload", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD015" } }],
      ["POST", "/api/v1/revisions/:revisionId/selection", "SelectInputTables", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD016" } }],
      ["POST", "/api/v1/revisions/:revisionId/seal", "SealRevision", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD017" } }],
      // the manual-10 reads (N16)
      ["GET", "/api/v1/agencies", "ListAgencies", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:ListAgencies" } }],
      ["GET", "/api/v1/agencies/:agencyId", "GetAgency", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetAgency" } }],
      ["GET", "/api/v1/agencies/:agencyId/members", "ListMembers", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:ListMembers" } }],
      ["GET", "/api/v1/agencies/:agencyId/clients", "ListClients", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:ListClients" } }],
      ["GET", "/api/v1/projects/:projectId", "GetProject", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetProject" } }],
      // the source reads (B07 design §9.1)
      ["GET", "/api/v1/revisions/:revisionId/selection-manifests/:selectionManifestId", "GetSelectionManifest", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetSelectionManifest" } }],
      ["GET", "/api/v1/revisions/:revisionId", "GetRevision", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetRevision" } }],
      ["GET", "/api/v1/revisions/:revisionId/inspection", "GetInspection", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetInspection" } }],
      ["GET", "/api/v1/revisions/:revisionId/uploads", "ListUploads", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:ListUploads" } }],
      ["GET", "/api/v1/uploads/:uploadId", "GetUpload", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetUpload" } }],
      ["GET", "/api/v1/uploads/:uploadId/session", "GetUploadSession", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetUploadSession" } }],
      ["GET", "/api/v1/revisions/:revisionId/tables/:tableId/preview", "PreviewTable", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:PreviewTable" } }],
      // the selection manifest intake: 201 stored, 200 the same document again (B07 D-SEL-2)
      ["POST", "/api/v1/revisions/:revisionId/selection-manifests", "SubmitSelectionManifest", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:intake:SubmitSelectionManifest" }, 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:intake:SubmitSelectionManifest" } }],
      // package B09's request side (M4, D-REQ-B7): a provider command declares its 202 accepted observation beside its success
      ["POST", "/api/v1/quotes/:quoteId/payment-orders", "CreatePaymentOrder", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD028" }, 202: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:accepted" } }],
      ["POST", "/api/v1/payment-orders/:orderId/capture", "CapturePayment", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD029" }, 202: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:accepted" } }],
      ["POST", "/api/v1/projects/:projectId/refund-requests", "RequestRefund", { 201: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD031" } }],
      ["POST", "/api/v1/refunds/:refundId/approve", "ApproveRefund", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD032" } }],
      ["GET", "/api/v1/quotes/:quoteId", "GetQuote", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetQuote" } }],
      ["GET", "/api/v1/payment-orders/:orderId", "GetPaymentOrder", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetPaymentOrder" } }],
      ["GET", "/api/v1/refunds/:refundId", "GetRefund", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetRefund" } }],
      ["GET", "/api/v1/operations/refunds/:refundId", "GetRefundReview", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:read:GetRefundReview" } }],
      // package B10's agency lifecycle (mandate B10-AGENCY-LIFECYCLE): both complete synchronously, no 202
      ["POST", "/api/v1/agencies/:agencyId/activate", "ActivateAgency", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD002" } }],
      ["POST", "/api/v1/agencies/:agencyId/closure-requests", "CloseAgency", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD043" } }],
      // the payment service's routes of package B09 (stage-2 mandate M3), served in every edition: the ACCEPTED envelope only
      // where a provider effect may stay unknown (CMD033)
      ["POST", "/api/v1/payments/webhooks/:provider", "ReceivePaymentWebhook", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD030" } }],
      ["POST", "/api/v1/refunds/:refundId/execute", "ExecuteRefund", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD033" }, 202: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:accepted" } }],
      ["POST", "/api/v1/payment-orders/:orderId/reconcile", "ReconcilePayment", { 200: { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:CMD034" } }],
    ].map(([m, u, o, d]) => [m, u, o, d, { contentType: "application/problem+json", schemaId: "Problem" }]),
  );
  // another server over the same real unit of work: an undeclared route is refused at registration, before any request
  const sink: Array<{ correlationId: string; error: unknown }> = [];
  const app = assembleApi({ environment: "LOCAL", unitOfWork: w.db.unitOfWork, database: w.db, authenticator: createBearerTokenAuthenticator(new Map()), validator: w.validator, onInternalError: (correlationId, error) => sink.push({ correlationId, error }) });
  try {
    assert.throws(() => app.get("/api/v1/undeclared", async () => ({ ok: true })), /route GET \/api\/v1\/undeclared declares no response contract/);
    app.route({
      method: "GET",
      url: "/api/v1/text-probe",
      config: { responses: commandRouteResponses("CMD009", "TextProbe") },
      handler: async (_request, reply) => reply.code(201).header("x-correlation-id", ids.next()).type("application/json").send(`{"kind":"COMPLETED","secret":"${SENTINEL}"}`),
    });
    // a declaration naming a schema the validator never compiled: the check cannot run, so the reply is refused too
    app.route({
      method: "GET",
      url: "/api/v1/unknown-schema-probe",
      config: { responses: { operationId: "UnknownSchemaProbe", declared: { "200": { contentType: "application/json", schemaId: "urn:kauro:api:v1:response:op:neverCompiled:200" } }, problem: PROBLEM_RESPONSE, outcomes: null } },
      handler: async (_request, reply) => reply.code(200).header("x-correlation-id", ids.next()).send({ secret: SENTINEL }),
    });
    await app.ready();
    const unknown = await app.inject({ method: "GET", url: "/api/v1/unknown-schema-probe" });
    assert.equal(unknown.statusCode, 422);
    assertNoSentinel(unknown.body, unknown.headers);
    assert.equal(sink.length, 1);
    assert.ok(sink[0]?.error instanceof ResponseContractViolation);
    assert.equal(classifyInternalError(sink[0]?.error), "ResponseContractViolation cause=DomainFailure");
    sink.length = 0;
    const res = await app.inject({ method: "GET", url: "/api/v1/text-probe" });
    assert.equal(res.statusCode, 422);
    assert.equal(res.headers["content-type"], "application/problem+json; charset=utf-8");
    const p = w.validator.validate<{ code: string; reason: string; correlationId: string }>("Problem", JSON.parse(res.body));
    assert.equal(p.kind, "VALID");
    assert.deepEqual(p.kind === "VALID" && [p.value.code, p.value.reason, p.value.correlationId], ["INTEGRITY_FAILURE", "RESPONSE_CONTRACT_VIOLATION", res.headers["x-correlation-id"]]);
    assertNoSentinel(res.body, res.headers);
    assert.equal(sink.length, 1);
    assert.ok(sink[0]?.error instanceof ResponseContractViolation);
    assert.equal(sink[0]?.correlationId, res.headers["x-correlation-id"]);
    assert.match((sink[0]?.error as Error).message, /without passing the response check/);
  } finally {
    await app.close();
  }
});

test("R29: the approval the routes answer carries actorId, and a consumer recomputes approvalHash from the wire DTO alone — when approved and after withdrawal", async () => {
  const plan = await w.approvable(w.A, projectId, "r29-recompute");
  const approved = await approveThroughRoute(w, plan);
  const approval = approved.data.approval as unknown as Record<string, string>;
  // the preimage members of reference/HASHING_AND_ACCOUNTING_RULES, read from the DTO and nothing else
  const PREIMAGE = ["approvalId", "actorId", "agencyId", "planHash", "revisionHash", "targetContractHash", "validationReceiptHash", "disclosuresHash", "createdAt"];
  const recompute = (view: Record<string, string>): string => structuredDigest(DOMAINS.PLAN_APPROVAL, 1, Object.fromEntries(PREIMAGE.map((k) => [k, view[k]])));
  for (const member of PREIMAGE) assert.equal(typeof approval[member], "string", `${member} is on the wire`);
  assert.equal(recompute(approval), approval["approvalHash"]);
  // the oracle: the stored actor and hash are the ones the DTO carries, and the actor is the approving person's identity reference
  const row = await w.row<{ actor_id: string; approval_hash: string }>("approvals", "approval_id = $1", [approval["approvalId"]]);
  assert.deepEqual(row && [row.actor_id, row.approval_hash], [approval["actorId"], approval["approvalHash"]]);
  assert.equal(approval["actorId"], w.approver.userId);
  // withdrawal is excluded from the preimage ("Excluded mutable envelope: withdrawnAt"): the withdrawn view still recomputes
  const withdrawn = completed<WithdrawApprovalView>(await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } }), 200);
  const after = withdrawn.data.approval as unknown as Record<string, string>;
  assert.equal(typeof after["withdrawnAt"], "string");
  assert.equal(after["actorId"], approval["actorId"]);
  assert.equal(recompute(after), approval["approvalHash"]);
});

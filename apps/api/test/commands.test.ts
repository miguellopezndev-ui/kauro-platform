// The command routes end to end over the in-memory ports: routes equal the catalogue paths; the subject is authenticated
// after structural validation (10 order); denials are 401/403/404 problems and durable security events; idempotent replay
// and conflict at the HTTP boundary (S052); typed COMPLETED replies; an unexpected exception is an opaque INTERNAL_ERROR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { B06_COMMANDS } from "@kauro/application";
import { fastifyPath } from "../src/index.js";
import { api, asProblem, call } from "./support.js";

test("exactly the seven catalogue routes are registered, as POST, under /api/v1", async () => {
  const a = api();
  await a.app.ready();
  for (const spec of Object.values(B06_COMMANDS)) {
    assert.ok(a.app.hasRoute({ method: "POST", url: fastifyPath(spec.path) }), spec.path);
    assert.ok(!a.app.hasRoute({ method: "GET", url: fastifyPath(spec.path) }), `no GET on ${spec.path}`);
  }
  assert.equal(fastifyPath("/api/v1/agencies/{agencyId}/clients"), "/api/v1/agencies/:agencyId/clients");
  assert.equal(a.app.printRoutes().split("\n").filter((l) => l.includes("(POST)")).length, 7);
});

test("authentication happens after structural validation and before authorization: a malformed body is 400 without a token, a valid body without a token is 401 REAUTHENTICATE", async () => {
  const a = api();
  const malformed = await call(a, { url: "/api/v1/agencies", body: { displayName: 42 }, token: null, agency: null });
  assert.equal(malformed.status, 400);
  const unauthenticated = await call(a, { url: "/api/v1/agencies", body: { displayName: "Acme Two" }, token: null, agency: null });
  assert.equal(unauthenticated.status, 401);
  const p = asProblem(unauthenticated.json());
  assert.equal(p.code, "AUTHENTICATION_REQUIRED");
  assert.deepEqual(p.nextActions, [{ action: "REAUTHENTICATE" }]);
  const badToken = await call(a, { url: "/api/v1/agencies", body: { displayName: "Acme Two" }, token: "unknown-token-0123456789", agency: null });
  assert.equal(badToken.status, 401);
  assert.equal(a.store().agencies.size, 1);
});

test("CMD001 over HTTP: 201 CompletedResponse with the agency and membership views; identical retry replays (replayed: true); same key with another body is 409 IDEMPOTENCY_CONFLICT (S052); an unverified identity is 403 with a durable denial", async () => {
  const a = api();
  // the owner already holds a DRAFT agency: the structural limit answers; the stranger (verified, no agency) creates one
  const second = await call(a, { url: "/api/v1/agencies", body: { displayName: "Second" }, agency: null });
  assert.equal(second.status, 429);
  assert.equal(asProblem(second.json()).reason, "DRAFT_AGENCY_EXISTS");
  const created = await call(a, { url: "/api/v1/agencies", body: { displayName: "Stranger Co" }, token: a.stranger.token, agency: null, key: "stranger-key-0001" });
  assert.equal(created.status, 201);
  assert.equal(created.contentType, "application/json; charset=utf-8");
  const body = created.json() as { kind: string; version: number; replayed: boolean; data: { agency: { agencyId: string; state: string; permittedActions: string[] }; membership: { role: string } } };
  assert.equal(body.kind, "COMPLETED");
  assert.equal(body.version, 1);
  assert.equal(body.data.agency.state, "DRAFT");
  assert.equal(body.data.membership.role, "OWNER");
  assert.ok(body.data.agency.permittedActions.includes("MANAGE_AGENCY"));
  const replay = await call(a, { url: "/api/v1/agencies", body: { displayName: "Stranger Co" }, token: a.stranger.token, agency: null, key: "stranger-key-0001" });
  assert.equal(replay.status, 201);
  const replayed = replay.json() as typeof body;
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.data, body.data);
  const conflict = await call(a, { url: "/api/v1/agencies", body: { displayName: "Stranger Co 2" }, token: a.stranger.token, agency: null, key: "stranger-key-0001" });
  assert.equal(conflict.status, 409);
  assert.equal(asProblem(conflict.json()).code, "IDEMPOTENCY_CONFLICT");
  assert.equal([...a.store().agencies.values()].filter((x) => x.displayName.startsWith("Stranger")).length, 1);
  const unverified = await call(a, { url: "/api/v1/agencies", body: { displayName: "No MFA Co" }, token: a.unverified.token, agency: null, key: "unverified-key-001" });
  assert.equal(unverified.status, 403);
  const denied = asProblem(unverified.json());
  assert.equal(denied.code, "NOT_AUTHORIZED");
  assert.equal(denied.reason, "IDENTITY_UNVERIFIED");
  const fact = a.store().securityEvents.at(-1)!;
  assert.equal(fact.action, "CMD001");
  assert.equal(fact.outcome, "DENY");
  assert.equal(fact.reasonCode, "IDENTITY_UNVERIFIED");
  assert.equal(fact.agencyId, null);
  assert.equal([...a.store().journal.values()].some((j) => j.identity.key === "unverified-key-001"), false);
});

test("authorization denials over HTTP: VIEWER creating a client is 403 ROLE_INSUFFICIENT and a security event; a non-member selecting the agency is 404; nothing is written", async () => {
  const a = api();
  const url = `/api/v1/agencies/${a.agencyId}/clients`;
  const bodyIn = { displayName: "New Client", processingAuthorityRef: a.authorityId };
  const viewer = await call(a, { url, body: bodyIn, token: a.viewer.token, agency: null });
  assert.equal(viewer.status, 403);
  const p = asProblem(viewer.json());
  assert.equal(p.code, "NOT_AUTHORIZED");
  assert.equal(p.reason, "ROLE_INSUFFICIENT");
  const denial = a.store().securityEvents.at(-1)!;
  assert.equal(denial.action, "CMD009");
  assert.equal(denial.outcome, "DENY");
  assert.equal(denial.reasonCode, "ROLE_INSUFFICIENT");
  assert.equal(denial.policyVersion, "B06-1");
  assert.equal(denial.agencyId, a.agencyId);
  const stranger = await call(a, { url, body: bodyIn, token: a.stranger.token, agency: null });
  assert.equal(stranger.status, 404);
  assert.equal(asProblem(stranger.json()).code, "NOT_FOUND");
  assert.equal(a.store().endClients.size, 1);
  assert.equal(a.store().journal.size, 0, "rejections leave no journal row");
  const owner = await call(a, { url, body: bodyIn, agency: null });
  assert.equal(owner.status, 201);
});

test("a stale version is 409 STALE_VERSION with the current safe version and RELOAD / COMPARE_VERSIONS; the winner of two archives is 200", async () => {
  const a = api();
  const url = `/api/v1/clients/${a.clientId}/archive`;
  const stale = await call(a, { url, body: { expectedVersion: 5 } });
  assert.equal(stale.status, 409);
  const p = asProblem(stale.json());
  assert.equal(p.code, "STALE_VERSION");
  assert.deepEqual(p.current, { version: 1, state: "ACTIVE" });
  assert.deepEqual(p.nextActions.map((n) => n.action), ["RELOAD", "COMPARE_VERSIONS"]);
  const first = await call(a, { url, body: { expectedVersion: 1 }, key: "archive-key-00001" });
  assert.equal(first.status, 200);
  const second = await call(a, { url, body: { expectedVersion: 1 }, key: "archive-key-00002" });
  assert.equal(second.status, 409);
  assert.deepEqual(asProblem(second.json()).current, { version: 2, state: "ARCHIVED" });
});

test("an unexpected exception is 500 INTERNAL_ERROR with only the correlation id, RETRY_SAME_KEY and the safe classification handed to the sink; no stack or message reaches the wire", async () => {
  const a = api({
    wrapHandlers: (h) => ({
      ...h,
      CMD001: {
        spec: h.CMD001.spec,
        execute: async () => {
          throw new TypeError("secret internal detail: SELECT * FROM kauro.agencies");
        },
      },
    }),
  });
  const url = "/api/v1/agencies";
  const res = await call(a, { url, body: { displayName: "Boom" }, agency: null, headers: { "x-correlation-id": "corr-boom-1" } });
  assert.equal(res.status, 500);
  const p = asProblem(res.json());
  assert.equal(p.code, "INTERNAL_ERROR");
  assert.equal(p.correlationId, "corr-boom-1");
  assert.equal(p.retryable, true);
  assert.deepEqual(p.nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.ok(!JSON.stringify(res.json()).includes("SELECT"), "no SQL on the wire");
  assert.ok(!JSON.stringify(res.json()).includes("secret"), "no message on the wire");
  assert.equal(a.internalErrors.length, 1);
  assert.equal(a.internalErrors[0]?.correlationId, "corr-boom-1");
});

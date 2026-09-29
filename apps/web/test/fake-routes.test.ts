// ContractFakeAgencyApi (design section 6, D-E2E-2): the browser suite's stand-in for planned operations. These tests hold the fake to its
// three promises: it answers planned operations only, it builds and checks every reply against the planned schema, and it checks every
// request the way the real api will. The requests of the first group are produced by the real ApiClient, so the fake and the client that
// the screens use are proved to agree on one wire.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OPERATIONS } from "../src/api/generated.ts";
import type { SchemaNode } from "../src/api/schema-guard.ts";
import { ApiClient, type FetchedResponse, type FetchInit, type WireDescriptor } from "../src/client/api-client.ts";
import { CREATE_SESSION, GET_CURRENT_SESSION, REVOKE_CURRENT_SESSION, STAND_IN_SCHEMAS } from "./support/planned-stand-ins.ts";
import { CONTROL_PREFIX, ContractFakeAgencyApi, createEdgeFake, type EdgeRequest, FakeMountError, mountOnEdge, type ReplyScript } from "../e2e/support/fake-routes.ts";

const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
const OTHER = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
const TOKEN = "csrf-token-one-0123456789abcdef";
const KEY = "operation-key-0123456789abcdef";
const LOCAL = { KAURO_ENV: "LOCAL" } as const;
const SESSION_BODY = { userId: "user-1", emailVerified: true, mfaEnrolled: true, mfaAt: "2026-09-29T10:00:00Z", stepUpFreshUntil: null, idleExpiresAt: "2026-09-29T10:30:00Z", absoluteExpiresAt: "2026-09-29T22:00:00Z", csrfToken: TOKEN };

// a planned operation with everything the rules can bite on: two path parameters, an agency header, a query parameter, a required idempotency key and a body
const SYNTHETIC: WireDescriptor = {
  operationId: "SyntheticAcknowledge",
  method: "post",
  path: "/api/v1/agencies/{agencyId}/synthetic/{itemId}",
  command: null,
  role: null,
  idempotency: "REQUIRED",
  headers: ["Idempotency-Key", "X-Correlation-Id", "X-Kauro-Agency"],
  pathParameters: ["agencyId", "itemId"],
  queryParameters: ["mode"],
  request: "SyntheticRequest",
  replies: { "200": "SyntheticView", "400": "Problem", "409": "Problem" },
  planned: true,
};

const SCHEMAS: Readonly<Record<string, SchemaNode>> = {
  ...STAND_IN_SCHEMAS,
  SyntheticRequest: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", minLength: 1, maxLength: 20 } } },
  SyntheticView: { type: "object", additionalProperties: false, required: ["itemId", "note"], properties: { itemId: { type: "string" }, note: { type: "string" } } },
};

const SERVED_GET_AGENCY = OPERATIONS.GetAgency as WireDescriptor;

function makeFake(): ContractFakeAgencyApi {
  return new ContractFakeAgencyApi({ operations: [SERVED_GET_AGENCY, OPERATIONS.CreateAgency as WireDescriptor, CREATE_SESSION, GET_CURRENT_SESSION, REVOKE_CURRENT_SESSION, SYNTHETIC], schemas: SCHEMAS, environment: LOCAL, csrfExempt: ["CreateSession"] });
}

const ok = (body: unknown, status = 200): ReplyScript => ({ kind: "BODY", status, body });

function correlations(): () => string {
  let counter = 0;
  return () => `0199c1a2-7b3d-7c4e-8a5f-${(counter += 1).toString(16).padStart(12, "0")}`;
}

/** The api client, wired straight to the fake: what the browser would send through the edge. */
function clientOf(fake: ContractFakeAgencyApi, csrf: string | null = TOKEN) {
  const seen: string[] = [];
  const fetch = async (url: string, init: FetchInit): Promise<FetchedResponse> => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const answer = fake.handle({ method: init.method, url, headers, body: init.body ?? "" });
    if (answer === null) throw new TypeError(`the fake declined ${init.method} ${url}`);
    seen.push(`${init.method} ${url} -> ${answer.status}`);
    const lower = new Map(Object.entries(answer.headers).map(([name, value]) => [name.toLowerCase(), value]));
    return { status: answer.status, headers: { get: (name) => lower.get(name.toLowerCase()) ?? null }, text: async () => answer.body };
  };
  const client = new ApiClient({ fetch, newCorrelationId: correlations(), context: { csrfToken: () => csrf, activeAgency: () => AGENCY } });
  return { client, seen };
}

function request(overrides: Partial<EdgeRequest> & { readonly headers?: EdgeRequest["headers"] } = {}): EdgeRequest {
  return {
    method: "POST",
    url: `/api/v1/agencies/${AGENCY}/synthetic/item-1?mode=fast`,
    headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-000000000001", "idempotency-key": KEY, "x-kauro-csrf": TOKEN, "x-kauro-agency": AGENCY, "content-type": "application/json" },
    body: JSON.stringify({ note: "hello" }),
    ...overrides,
  };
}

function mountError(action: () => unknown, reason: FakeMountError["reason"]): FakeMountError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof FakeMountError, "a FakeMountError, not another failure");
    assert.equal(error.reason, reason);
    return error;
  }
  return assert.fail(`expected a ${reason} refusal`);
}

test("D-E2E-2: the fake answers planned operations only: a served route is refused at mount and never answered, and a path no descriptor knows is left to the edge", () => {
  const fake = makeFake();
  mountError(() => fake.reply("GetAgency", ok({})), "SERVED_ROUTE");
  mountError(() => fake.replyOnce("CreateAgency", ok({}, 201)), "SERVED_ROUTE");
  mountError(() => fake.reply("NoSuchOperation", ok({})), "UNKNOWN_OPERATION");
  assert.deepEqual(fake.plannedOperations(), ["CreateSession", "GetCurrentSession", "RevokeCurrentSession", "SyntheticAcknowledge"]);

  const foreign: ReadonlyArray<readonly [string, string]> = [
    ["GET", `/api/v1/agencies/${AGENCY}`],
    ["POST", "/api/v1/agencies"],
    ["GET", "/api/v1/nothing-here"],
    ["GET", "/livez"],
    ["GET", "/agencies"],
    ["DELETE", "/api/v1/sessions/current"],
    // a request target that is not origin-form is never read as a path of ours
    ["GET", "//other.invalid/api/v1/sessions/current"],
    ["GET", "http://other.invalid/api/v1/sessions/current"],
    ["GET", "*"],
  ];
  for (const [method, url] of foreign) {
    assert.equal(fake.probe(method, url), false, `${method} ${url} is not the fake's`);
    assert.equal(fake.handle({ method, url, headers: {}, body: "" }), null, `${method} ${url}`);
  }
  assert.equal(fake.probe("GET", "/api/v1/sessions/current"), true);
  assert.equal(fake.probe("POST", `/api/v1/agencies/${AGENCY}/synthetic/x`), true);
  assert.deepEqual(fake.calls(), [], "a request that is not the fake's leaves no trace");
  assert.deepEqual(fake.violations(), []);
  // the generated client carries no planned operation yet: when it does, the edge fake picks it up without a change here
  const edge = createEdgeFake(LOCAL);
  for (const descriptor of Object.values(OPERATIONS)) assert.equal(edge.plannedOperations().includes(descriptor.operationId), descriptor.planned, descriptor.operationId);
});

test("D-E2E-2: a reply is built from and checked against the planned schema, and a script that cannot be a real reply is refused when it is mounted", () => {
  const fake = makeFake();
  fake.reply("GetCurrentSession", ok(SESSION_BODY));
  const answer = fake.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000a" }, body: "" });
  assert.ok(answer);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["content-type"], "application/json");
  assert.equal(answer.headers["cache-control"], "no-store");
  assert.equal(answer.headers["x-correlation-id"], "0199c1a2-7b3d-7c4e-8a5f-00000000000a", "the correlation id is echoed");
  assert.deepEqual(JSON.parse(answer.body), SESSION_BODY);

  const refused: ReadonlyArray<readonly [string, string, ReplyScript, FakeMountError["reason"], RegExp]> = [
    ["a status the operation does not document", "SyntheticAcknowledge", ok({ itemId: "a", note: "b" }, 202), "STATUS_NOT_DOCUMENTED", /202/],
    ["a body with a member the schema does not have", "GetCurrentSession", ok({ ...SESSION_BODY, role: "OWNER" }), "REPLY_INVALID", /SessionView/],
    ["a body without a required member", "GetCurrentSession", ok((({ csrfToken: _drop, ...rest }) => rest)(SESSION_BODY)), "REPLY_INVALID", /csrfToken/],
    ["no body where the status has one", "GetCurrentSession", { kind: "BODY", status: 200 }, "REPLY_INVALID", /needs a body/],
    ["a body where the status has none", "RevokeCurrentSession", ok({ done: true }, 204), "REPLY_INVALID", /has no body/],
    ["a built Problem where the status is not a Problem", "GetCurrentSession", { kind: "PROBLEM", status: 200, code: "INTERNAL_ERROR" }, "REPLY_INVALID", /not a Problem/],
    ["a Problem body that breaks the Problem schema", "GetCurrentSession", ok({ type: "x", title: "x", status: 401 }, 401), "REPLY_INVALID", /Problem/],
  ];
  for (const [name, operation, script, reason, message] of refused) {
    const error = mountError(() => fake.reply(operation, script), reason);
    assert.match(error.message, message, name);
    assert.throws(() => fake.replyOnce(operation, script), FakeMountError, name);
  }
  // a refused script scripted nothing: the mounted reply is still the last good one
  assert.equal(fake.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000a" }, body: "" })?.status, 200);

  // a Problem is built, with the request's own correlation id, and served as problem+json
  fake.reply("GetCurrentSession", { kind: "PROBLEM", status: 401, code: "AUTHENTICATION_REQUIRED" });
  const problem = fake.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000b" }, body: "" });
  assert.ok(problem);
  assert.equal(problem.status, 401);
  assert.equal(problem.headers["content-type"], "application/problem+json");
  const parsed = JSON.parse(problem.body) as Record<string, unknown>;
  assert.equal(parsed["code"], "AUTHENTICATION_REQUIRED");
  assert.equal(parsed["status"], 401);
  assert.equal(parsed["correlationId"], "0199c1a2-7b3d-7c4e-8a5f-00000000000b");
  assert.equal(parsed["retryable"], false);
  // a Problem the script wrote itself is served as problem+json too
  fake.reply("GetCurrentSession", ok({ type: "urn:kauro:problem:INTERNAL_ERROR", title: "x", status: 500, code: "INTERNAL_ERROR", correlationId: "c-1", retryable: true, nextActions: [] }, 500));
  assert.equal(fake.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000b" }, body: "" })?.headers["content-type"], "application/problem+json");
  // a 204 is bodiless
  fake.reply("RevokeCurrentSession", ok(undefined, 204));
  const revoked = fake.handle({ method: "POST", url: "/api/v1/sessions/current/revoke", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000c", "x-kauro-csrf": TOKEN }, body: "" });
  assert.equal(revoked?.status, 204);
  assert.equal(revoked?.body, "");
  assert.equal(revoked?.headers["content-type"], undefined);
});

test("D-E2E-2: a scripted function that builds a reply breaking its contract is answered as a broken fake, never as the api, and is recorded", () => {
  const fake = makeFake();
  fake.reply("GetCurrentSession", () => ok({ userId: 7 }));
  const answer = fake.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000a" }, body: "" });
  assert.equal(answer?.status, 500);
  assert.match(answer?.headers["content-type"] ?? "", /^text\/plain/, "not a Problem: no screen will take it for the api");
  assert.equal(fake.violations().length, 1);
  assert.match(fake.violations()[0] ?? "", /GetCurrentSession: the scripted reply is not a reply of the operation/);
});

test("D-E2E-2: the real api client and the fake agree on every request rule, so a screen's call passes with no violation", async () => {
  const fake = makeFake();
  fake.reply("GetCurrentSession", ok(SESSION_BODY));
  fake.reply("RevokeCurrentSession", ok(undefined, 204));
  fake.reply("SyntheticAcknowledge", (call) => ok({ itemId: call.params["itemId"] ?? "", note: (call.body as { note: string }).note }));
  fake.reply("CreateSession", ok(SESSION_BODY, 201));
  const { client, seen } = clientOf(fake);

  const current = await client.send(GET_CURRENT_SESSION, {}, SCHEMAS);
  assert.equal(current.kind, "REPLY");
  const revoked = await client.send(REVOKE_CURRENT_SESSION, {}, SCHEMAS);
  assert.equal(revoked.kind, "REPLY");
  const acknowledged = await client.send<{ itemId: string; note: string }>(SYNTHETIC, { path: { agencyId: AGENCY, itemId: "item-1" }, query: { mode: "fast" }, body: { note: "hello" }, idempotencyKey: KEY }, SCHEMAS);
  assert.equal(acknowledged.kind, "REPLY");
  if (acknowledged.kind === "REPLY") assert.deepEqual(acknowledged.body, { itemId: "item-1", note: "hello" });
  // signing in has no session yet: no token, and the fake does not ask for one
  const signedIn = await clientOf(fake, null).client.send(CREATE_SESSION, { body: { idToken: "provider-token" } }, SCHEMAS);
  assert.equal(signedIn.kind, "REPLY");

  assert.deepEqual(fake.violations(), []);
  assert.equal(seen.length, 3);
  const [session, revoke, command, create] = fake.calls();
  assert.equal(session?.operationId, "GetCurrentSession");
  assert.equal(revoke?.csrfToken, TOKEN);
  assert.equal(command?.idempotencyKey, KEY);
  assert.equal(command?.agencyHeader, AGENCY);
  assert.deepEqual(command?.params, { agencyId: AGENCY, itemId: "item-1" });
  assert.deepEqual(command?.query, { mode: "fast" });
  assert.deepEqual(command?.body, { note: "hello" });
  assert.equal(create?.csrfToken, null);
  assert.deepEqual(
    fake.calls("SyntheticAcknowledge").map((call) => call.violations),
    [[]],
  );
});

test("D-E2E-2: a request the real api would refuse is recorded as a violation and answered with the operation's own refusal, and it consumes no scripted reply", () => {
  const cases: ReadonlyArray<readonly [string, EdgeRequest, RegExp]> = [
    ["no correlation id", request({ headers: { ...request().headers, "x-correlation-id": undefined } }), /X-Correlation-Id/],
    ["a correlation id that is not a UUID", request({ headers: { ...request().headers, "x-correlation-id": "abc" } }), /X-Correlation-Id/],
    ["a repeated correlation id", request({ headers: { ...request().headers, "x-correlation-id": ["0199c1a2-7b3d-7c4e-8a5f-000000000001", "0199c1a2-7b3d-7c4e-8a5f-000000000002"] } }), /X-Correlation-Id/],
    ["no idempotency key on a command", request({ headers: { ...request().headers, "idempotency-key": undefined } }), /Idempotency-Key/],
    ["an idempotency key that is too short", request({ headers: { ...request().headers, "idempotency-key": "short" } }), /Idempotency-Key/],
    ["no CSRF token on an unsafe method", request({ headers: { ...request().headers, "x-kauro-csrf": undefined } }), /X-Kauro-CSRF/],
    ["no agency header where the operation lists it", request({ headers: { ...request().headers, "x-kauro-agency": undefined } }), /X-Kauro-Agency is missing/],
    ["an agency header that is not the path's agency", request({ headers: { ...request().headers, "x-kauro-agency": OTHER } }), /differs from the agency in the path/],
    ["a query parameter the operation does not declare", request({ url: `/api/v1/agencies/${AGENCY}/synthetic/item-1?mode=fast&extra=1` }), /extra is not a query parameter/],
    ["a repeated query parameter", request({ url: `/api/v1/agencies/${AGENCY}/synthetic/item-1?mode=a&mode=b` }), /mode is repeated/],
    ["a path parameter that is malformed", request({ url: `/api/v1/agencies/${AGENCY}/synthetic/it%20em?mode=fast` }), /path parameter itemId is malformed/],
    ["a body that is not JSON", request({ body: "{" }), /not JSON/],
    ["a body that breaks the request schema", request({ body: JSON.stringify({ note: "hello", extra: true }) }), /SyntheticRequest/],
    ["a body of the wrong media type", request({ headers: { ...request().headers, "content-type": "text/plain" } }), /application\/json/],
  ];
  const fake = makeFake();
  fake.replyOnce("SyntheticAcknowledge", ok({ itemId: "item-1", note: "hello" }));
  let expected = 0;
  for (const [name, bad, message] of cases) {
    const answer = fake.handle(bad);
    assert.ok(answer, name);
    assert.equal(answer.status, 400, name);
    assert.equal(answer.headers["content-type"], "application/problem+json", name);
    assert.equal((JSON.parse(answer.body) as { code: string }).code, "INVALID_REQUEST", name);
    const recorded = fake.calls().at(-1);
    assert.ok(recorded, name);
    assert.equal(
      recorded.violations.some((violation) => message.test(violation)),
      true,
      `${name}: ${recorded.violations.join(" | ")}`,
    );
    assert.equal(fake.calls().length, ++expected, name);
  }
  // none of them used the scripted reply: the good request still gets it
  assert.equal(fake.handle(request())?.status, 200);
  assert.equal(fake.handle(request())?.status, 501, "and the queue is spent");

  // a bodiless operation refuses a body, and an operation with no 400 of its own is refused with its default Problem
  const sessions = makeFake();
  sessions.reply("GetCurrentSession", ok(SESSION_BODY));
  const withBody = sessions.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000a" }, body: "{}" });
  assert.equal(withBody?.status, 400);
  assert.match(sessions.violations().at(-1) ?? "", /takes no request body/);
  const aloneOnGet = sessions.handle({ method: "GET", url: "/api/v1/sessions/current", headers: { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000a", "idempotency-key": KEY }, body: "" });
  assert.equal(aloneOnGet?.status, 400);
  assert.match(sessions.violations().at(-1) ?? "", /takes none/);
});

test("D-E2E-2: an operation with no scripted reply answers 501 and a violation; queued replies go first, in order, then the standing one; reset forgets everything", () => {
  const fake = makeFake();
  const unscripted = fake.handle(request());
  assert.equal(unscripted?.status, 501);
  assert.match(unscripted?.headers["content-type"] ?? "", /^text\/plain/);
  assert.deepEqual(fake.violations(), ["SyntheticAcknowledge: no reply is scripted"]);

  fake.reply("SyntheticAcknowledge", ok({ itemId: "standing", note: "s" }));
  fake.replyOnce("SyntheticAcknowledge", { kind: "PROBLEM", status: 409, code: "STALE_VERSION" });
  fake.replyOnce("SyntheticAcknowledge", ok({ itemId: "second", note: "q" }));
  const statuses = [1, 2, 3, 4].map(() => {
    const answer = fake.handle(request());
    return `${answer?.status}:${answer?.status === 200 ? (JSON.parse(answer.body) as { itemId: string }).itemId : (JSON.parse(answer?.body ?? "{}") as { code: string }).code}`;
  });
  assert.deepEqual(statuses, ["409:STALE_VERSION", "200:second", "200:standing", "200:standing"]);
  assert.equal(fake.calls("SyntheticAcknowledge").length, 5);

  fake.reset();
  assert.deepEqual(fake.calls(), []);
  assert.deepEqual(fake.violations(), []);
  assert.equal(fake.handle(request())?.status, 501, "the scripts are gone too");
});

test("D-E2E-2: the fake exists only for the local stack", () => {
  for (const environment of [{}, { KAURO_ENV: "PRODUCTION" }, { KAURO_ENV: "local" }, { KAURO_ENV: "STAGING" }] as const) {
    const error = mountError(() => createEdgeFake(environment), "OUTSIDE_LOCAL");
    assert.match(error.message, /KAURO_ENV=LOCAL/);
  }
  // the generated client plans nothing since W2's session routes are served: the edge carries the harness probe alone
  assert.deepEqual(createEdgeFake(LOCAL).plannedOperations(), ["HarnessProbe"]);
});

async function listening(handler: http.RequestListener): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("D-E2E-2: on the edge a planned request is answered and everything else is forwarded unread, and a spec scripts the fake through the control endpoints", async () => {
  const fake = makeFake();
  const hook = mountOnEdge(fake);
  const forwarded: string[] = [];
  const edge = await listening(async (req, res) => {
    if (await hook(req, res)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    forwarded.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString("utf8")}`);
    res.writeHead(299, { "content-type": "text/plain" });
    res.end("forwarded");
  });
  try {
    const call = (path: string, init: RequestInit = {}) => fetch(`${edge.origin}${path}`, init);
    const correlated = { "x-correlation-id": "0199c1a2-7b3d-7c4e-8a5f-00000000000a" };

    // scripted through the control endpoints, as a browser spec does from another process
    const script = await call(`${CONTROL_PREFIX}reply`, { method: "POST", body: JSON.stringify({ operationId: "GetCurrentSession", script: { kind: "BODY", status: 200, body: SESSION_BODY } }) });
    assert.equal(script.status, 204);
    const served = await call("/api/v1/sessions/current", { headers: correlated });
    assert.equal(served.status, 200);
    assert.deepEqual(await served.json(), SESSION_BODY);
    const calls = (await (await call(`${CONTROL_PREFIX}calls`)).json()) as { calls: Array<{ operationId: string }> };
    assert.deepEqual(calls.calls.map((entry) => entry.operationId), ["GetCurrentSession"]);
    assert.deepEqual(await (await call(`${CONTROL_PREFIX}violations`)).json(), { violations: [] });
    assert.deepEqual(await (await call(`${CONTROL_PREFIX}operations`)).json(), { planned: ["CreateSession", "GetCurrentSession", "RevokeCurrentSession", "SyntheticAcknowledge"] });

    // a script that cannot be a reply is refused with the reason, and a stranger's control is unknown
    const bad = await call(`${CONTROL_PREFIX}reply`, { method: "POST", body: JSON.stringify({ operationId: "GetAgency", script: { kind: "BODY", status: 200, body: {} } }) });
    assert.equal(bad.status, 422);
    assert.match(((await bad.json()) as { error: string }).error, /SERVED_ROUTE/);
    assert.equal((await call(`${CONTROL_PREFIX}reply`, { method: "POST", body: "not json" })).status, 422);
    assert.equal((await call(`${CONTROL_PREFIX}reply`, { method: "POST", body: JSON.stringify({ operationId: 7 }) })).status, 422);
    assert.equal((await call(`${CONTROL_PREFIX}nothing`)).status, 404);
    const once = await call(`${CONTROL_PREFIX}reply-once`, { method: "POST", body: JSON.stringify({ operationId: "GetCurrentSession", script: { kind: "PROBLEM", status: 401, code: "AUTHENTICATION_REQUIRED" } }) });
    assert.equal(once.status, 204);
    assert.equal((await call("/api/v1/sessions/current", { headers: correlated })).status, 401);
    assert.equal((await call("/api/v1/sessions/current", { headers: correlated })).status, 200);

    // a served route, an unknown path and a page are forwarded with their bodies intact
    const posted = await call("/api/v1/agencies", { method: "POST", body: '{"displayName":"x"}', headers: { "content-type": "application/json" } });
    assert.equal(posted.status, 299);
    assert.equal((await call(`/api/v1/agencies/${AGENCY}`)).status, 299);
    assert.equal((await call("/livez")).status, 299);
    assert.deepEqual(forwarded, ['POST /api/v1/agencies {"displayName":"x"}', `GET /api/v1/agencies/${AGENCY} `, "GET /livez "]);

    // a body past the cap is refused, and the session route still answers afterwards
    const big = await call("/api/v1/sessions", { method: "POST", body: "x".repeat(1_100_000), headers: { "content-type": "application/json" } });
    assert.equal(big.status, 413);
    assert.equal((await call("/api/v1/sessions/current", { headers: correlated })).status, 200, "the fake still answers after a refused body");
    assert.equal((await call(`${CONTROL_PREFIX}reset`, { method: "POST" })).status, 204);
    assert.deepEqual(await (await call(`${CONTROL_PREFIX}calls`)).json(), { calls: [] });
  } finally {
    await edge.close();
  }
});

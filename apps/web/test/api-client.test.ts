// The api client (design D-TOPO-1, D-PRIV-1, D-GEN-1): what it sends, and how it classifies what comes back. The oracle is the wire
// contract itself: the request headers of 10 "Request envelope" and the four answer kinds of answer.ts. Nothing here reads prose.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient, type FetchInit, type FetchedResponse, type FetchLike } from "../src/client/api-client.ts";
import { OPERATIONS, type Problem } from "../src/api/generated.ts";

const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f70";
const CLIENT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f71";
const AUTHORITY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f72";
const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99";
const KEY = "k-0199c1a27b3d7c4e8a5f1b2c3d4e5f70";

interface Sent {
  readonly url: string;
  readonly init: FetchInit;
}

function respond(status: number, contentType: string | null, body: string, headers: Readonly<Record<string, string>> = {}): FetchedResponse {
  const all = new Map<string, string>(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (contentType !== null) all.set("content-type", contentType);
  return { status, headers: { get: (name) => all.get(name.toLowerCase()) ?? null }, text: async () => body };
}

function problem(status: number, code: Problem["code"], extra: Partial<Problem> = {}): Problem {
  return { type: `urn:kauro:problem:${code}`, title: "x", status, code, correlationId: CORRELATION, retryable: false, nextActions: [], ...extra };
}

function harness(answer: (sent: Sent) => FetchedResponse | Promise<FetchedResponse>, csrf: string | null = "csrf-token-value", agency: string | null = AGENCY) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const entry = { url, init };
    sent.push(entry);
    return answer(entry);
  };
  const client = new ApiClient({ fetch, newCorrelationId: () => CORRELATION, context: { csrfToken: () => csrf, activeAgency: () => agency } });
  return { client, sent };
}

const completed = {
  kind: "COMPLETED",
  version: 1,
  replayed: false,
  data: { clientId: CLIENT, agencyId: AGENCY, version: 1, displayName: "Acme", state: "ACTIVE", processingAuthorityRef: AUTHORITY, createdAt: "2026-09-29T10:00:00Z", permittedActions: ["CreateProject"] },
};

test("D-PRIV-1, D-TOPO-1: every request is same-origin, never cached, never follows a redirect, and carries the envelope headers of its operation", async () => {
  const { client, sent } = harness(() => respond(201, "application/json", JSON.stringify(completed), { "X-Correlation-Id": CORRELATION }));
  const answer = await client.call("CreateClient", { path: { agencyId: AGENCY }, body: { displayName: "Acme", processingAuthorityRef: AUTHORITY }, idempotencyKey: KEY });
  assert.equal(answer.kind, "REPLY");
  const [request] = sent;
  assert.ok(request);
  assert.equal(request.url, `/api/v1/agencies/${AGENCY}/clients`);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "same-origin");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.mode, "same-origin");
  assert.equal(request.init.referrerPolicy, "no-referrer");
  assert.deepEqual(request.init.headers, {
    Accept: "application/json, application/problem+json",
    "X-Correlation-Id": CORRELATION,
    "Idempotency-Key": KEY,
    "X-Kauro-CSRF": "csrf-token-value",
    "Content-Type": "application/json",
  });
  assert.equal(request.init.body, JSON.stringify({ displayName: "Acme", processingAuthorityRef: AUTHORITY }));
});

test("D-PRIV-1: a read carries no CSRF token and no body; the agency header appears only on operations that name it, from the page's active agency", async () => {
  const { client, sent } = harness(() => respond(200, "application/json", JSON.stringify({ kind: "READ", data: { items: [] } }), { "x-correlation-id": CORRELATION }));
  const listed = await client.call("ListAgencies", { query: { limit: 25 } });
  assert.equal(listed.kind, "REPLY");
  assert.equal(sent[0]?.url, "/api/v1/agencies?limit=25");
  assert.equal(sent[0]?.init.method, "GET");
  assert.equal(sent[0]?.init.body, undefined);
  assert.deepEqual(Object.keys(sent[0]?.init.headers ?? {}).sort(), ["Accept", "X-Correlation-Id"]);

  const archive = harness(() => respond(200, "application/json", "{}"));
  await archive.client.call("ArchiveClient", { path: { clientId: CLIENT }, body: { expectedVersion: 2 }, idempotencyKey: KEY });
  assert.equal(archive.sent[0]?.init.headers["X-Kauro-Agency"], AGENCY, "taken from the page's active agency");
  const other = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f88";
  await archive.client.call("ArchiveClient", { path: { clientId: CLIENT }, body: { expectedVersion: 2 }, idempotencyKey: KEY, agency: other });
  assert.equal(archive.sent[1]?.init.headers["X-Kauro-Agency"], other, "an explicit agency wins over the page's");

  // before a session exists there is no token to send; the request goes without one and the api refuses it, by code
  const anonymous = harness(() => respond(200, "application/json", "{}"), null);
  await anonymous.client.call("ArchiveClient", { path: { clientId: CLIENT }, body: { expectedVersion: 2 }, idempotencyKey: KEY });
  assert.equal(Object.hasOwn(anonymous.sent[0]?.init.headers ?? {}, "X-Kauro-CSRF"), false);
});

test("D-GEN-1: a request the contract would refuse is never sent (missing key, malformed key, missing agency, bad path value, body off contract, stray input)", async () => {
  const { client, sent } = harness(() => respond(200, "application/json", "{}"));
  const good = { path: { clientId: CLIENT }, body: { expectedVersion: 2 }, idempotencyKey: KEY } as const;
  const refused: readonly (readonly [string, () => Promise<unknown>])[] = [
    ["no key", () => client.call("ArchiveClient", { path: good.path, body: good.body })],
    ["short key", () => client.call("ArchiveClient", { ...good, idempotencyKey: "short" })],
    ["key with a space", () => client.call("ArchiveClient", { ...good, idempotencyKey: "0199c1a2 7b3d7c4e8a5f1b2c" })],
    ["a key on a read", () => client.call("GetProject", { path: { projectId: CLIENT }, idempotencyKey: KEY })],
    ["path value with a slash", () => client.call("ArchiveClient", { ...good, path: { clientId: "../agencies" } })],
    ["missing path value", () => client.call("ArchiveClient", { ...good, path: {} })],
    ["body off contract", () => client.call("ArchiveClient", { ...good, body: { expectedVersion: 0 } })],
    ["unknown body field", () => client.call("ArchiveClient", { ...good, body: { expectedVersion: 2, extra: true } })],
    ["missing body", () => client.call("ArchiveClient", { path: good.path, idempotencyKey: KEY })],
    ["a body on a read", () => client.call("GetProject", { path: { projectId: CLIENT }, body: {} })],
    ["undeclared query parameter", () => client.call("ListAgencies", { query: { filter: "x" } })],
    ["agency that is not an id", () => client.call("ArchiveClient", { ...good, agency: "acme" })],
  ];
  for (const [label, attempt] of refused) await assert.rejects(attempt, RangeError, label);
  const without = harness(() => respond(200, "application/json", "{}"), "t", null);
  await assert.rejects(() => without.client.call("GetProject", { path: { projectId: CLIENT } }), RangeError, "no active agency and none given");
  assert.equal(sent.length, 0, "nothing reached the network");
  assert.equal(without.sent.length, 0);
  const badId = new ApiClient({ fetch: async () => respond(200, null, ""), newCorrelationId: () => "not-a-uuid", context: { csrfToken: () => null, activeAgency: () => AGENCY } });
  await assert.rejects(() => badId.call("ListAgencies"), RangeError, "the correlation id must be a lowercase uuid");
});

test("D-STATE-1: a Problem document is a PROBLEM by code; the same status without a valid Problem is an integrity failure, or no answer when it came from an edge", async () => {
  const doc = problem(409, "STALE_VERSION", { reason: "VERSION_DISCIPLINE", current: { version: 4, state: "ACTIVE" }, nextActions: [{ action: "RELOAD" }] });
  const ok = harness(() => respond(409, "application/problem+json; charset=utf-8", JSON.stringify(doc), { "x-correlation-id": CORRELATION }));
  const answer = await ok.client.call("ArchiveClient", { path: { clientId: CLIENT }, body: { expectedVersion: 2 }, idempotencyKey: KEY });
  assert.deepEqual(answer, { kind: "PROBLEM", status: 409, correlationId: CORRELATION, problem: doc });

  const call = (status: number, type: string | null, body: string) =>
    harness(() => respond(status, type, body)).client.call("ArchiveClient", { path: { clientId: CLIENT }, body: { expectedVersion: 2 }, idempotencyKey: KEY });
  const integrity = (failure: string, status: number) => ({ kind: "INTEGRITY", status, correlationId: null, failure });
  assert.deepEqual(await call(409, "application/json", JSON.stringify(doc)), integrity("UNEXPECTED_MEDIA_TYPE", 409), "a problem in the wrong media type");
  assert.deepEqual(await call(409, "application/problem+json", "not json"), integrity("PROBLEM_FAILED_CONTRACT", 409));
  assert.deepEqual(await call(409, "application/problem+json", JSON.stringify({ ...doc, code: "MADE_UP" })), integrity("PROBLEM_FAILED_CONTRACT", 409), "a code outside the closed set");
  assert.deepEqual(await call(409, "application/problem+json", JSON.stringify({ ...doc, extra: 1 })), integrity("PROBLEM_FAILED_CONTRACT", 409), "a member the contract does not define");
  assert.deepEqual(await call(409, "application/problem+json", JSON.stringify({ ...doc, status: 403 })), integrity("PROBLEM_FAILED_CONTRACT", 409), "a body that disagrees with its own status line");
  assert.deepEqual(await call(418, "application/problem+json", JSON.stringify(problem(418, "INVALID_REQUEST"))), { kind: "PROBLEM", status: 418, correlationId: CORRELATION, problem: problem(418, "INVALID_REQUEST") }, "an undocumented status with a valid Problem is still a Problem");
  assert.deepEqual(await call(418, "application/problem+json", "{}"), integrity("UNEXPECTED_STATUS", 418), "an undocumented status without one is version skew");
  assert.deepEqual(await call(404, "text/html", "<h1>Not found</h1>"), integrity("UNEXPECTED_MEDIA_TYPE", 404), "the framework's own 404 is not the api");
  // a 5xx that is not a Problem is an edge or proxy answer: it says nothing about what the api did
  for (const status of [500, 502, 503, 504]) assert.deepEqual(await call(status, "text/html", "<h1>Bad gateway</h1>"), { kind: "NO_ANSWER", reason: "UNREADABLE", status });
  const server = await call(503, "application/problem+json", JSON.stringify(problem(503, "CAPACITY_UNAVAILABLE", { retryable: true, retryAfterSeconds: 30 })));
  assert.equal(server.kind, "PROBLEM", "a valid Problem on a 5xx is the api's own answer");
});

test("D-GEN-1: a success body is checked against its generated schema; a body that fails is an integrity failure, never rendered", async () => {
  const call = (status: number, type: string | null, body: string, headers: Record<string, string> = {}) =>
    harness(() => respond(status, type, body, headers)).client.call("CreateClient", { path: { agencyId: AGENCY }, body: { displayName: "Acme", processingAuthorityRef: AUTHORITY }, idempotencyKey: KEY });
  const good = await call(201, "application/json; charset=utf-8", JSON.stringify(completed), { "x-correlation-id": CORRELATION });
  assert.equal(good.kind, "REPLY");
  if (good.kind === "REPLY") {
    assert.equal(good.status, 201);
    assert.equal(good.correlationId, CORRELATION);
    assert.deepEqual(good.body, completed);
  }
  const withoutEcho = await call(201, "application/json", JSON.stringify(completed));
  assert.equal(withoutEcho.kind === "REPLY" && withoutEcho.correlationId, CORRELATION, "the id this client sent stands in when the reply carries none");
  const failing = (mutate: (body: typeof completed) => unknown) => JSON.stringify(mutate(structuredClone(completed)));
  const expectIntegrity = async (label: string, answer: ReturnType<typeof call>, failure: string) => assert.deepEqual(await answer, { kind: "INTEGRITY", status: 201, correlationId: null, failure }, label);
  await expectIntegrity("missing member", call(201, "application/json", failing((b) => ({ ...b, data: { ...b.data, clientId: undefined } }))), "REPLY_FAILED_CONTRACT");
  await expectIntegrity("unknown member", call(201, "application/json", failing((b) => ({ ...b, extra: 1 }))), "REPLY_FAILED_CONTRACT");
  await expectIntegrity("wrong enum value", call(201, "application/json", failing((b) => ({ ...b, data: { ...b.data, state: "PAUSED" } }))), "REPLY_FAILED_CONTRACT");
  await expectIntegrity("wrong kind constant", call(201, "application/json", failing((b) => ({ ...b, kind: "ACCEPTED" }))), "REPLY_FAILED_CONTRACT");
  await expectIntegrity("not json", call(201, "application/json", "{"), "REPLY_FAILED_CONTRACT");
  await expectIntegrity("wrong media type", call(201, "text/plain", JSON.stringify(completed)), "UNEXPECTED_MEDIA_TYPE");
  await expectIntegrity("no media type", call(201, null, JSON.stringify(completed)), "UNEXPECTED_MEDIA_TYPE");
  // the status the operation documents for its success is the only one whose body is read as the success schema
  assert.deepEqual(await call(200, "application/json", JSON.stringify(completed)), { kind: "INTEGRITY", status: 200, correlationId: null, failure: "UNEXPECTED_MEDIA_TYPE" }, "200 is not a documented reply of CreateClient: only a Problem could come with it");
});

test("D-OPS-1: a fetch that fails or a body that cannot be read is NO_ANSWER with its reason, never a failure of the command", async () => {
  const thrower = (error: unknown) => new ApiClient({ fetch: async () => Promise.reject(error), newCorrelationId: () => CORRELATION, context: { csrfToken: () => null, activeAgency: () => AGENCY } });
  const input = { path: { agencyId: AGENCY }, body: { displayName: "Acme", processingAuthorityRef: AUTHORITY }, idempotencyKey: KEY } as const;
  assert.deepEqual(await thrower(new TypeError("Failed to fetch")).call("CreateClient", input), { kind: "NO_ANSWER", reason: "NETWORK", status: null });
  assert.deepEqual(await thrower(Object.assign(new Error("x"), { name: "AbortError" })).call("CreateClient", input), { kind: "NO_ANSWER", reason: "ABORTED", status: null });
  assert.deepEqual(await thrower(Object.assign(new Error("x"), { name: "TimeoutError" })).call("CreateClient", input), { kind: "NO_ANSWER", reason: "TIMEOUT", status: null });
  assert.deepEqual(await thrower("odd").call("CreateClient", input), { kind: "NO_ANSWER", reason: "NETWORK", status: null });
  const cut = new ApiClient({
    fetch: async () => ({ status: 201, headers: { get: () => null }, text: () => Promise.reject(new TypeError("terminated")) }),
    newCorrelationId: () => CORRELATION,
    context: { csrfToken: () => null, activeAgency: () => AGENCY },
  });
  assert.deepEqual(await cut.call("CreateClient", input), { kind: "NO_ANSWER", reason: "UNREADABLE", status: 201 }, "the status line arrived, the body did not: the effect is unknown");
});

test("D-GEN-1: an operation the contract documents with a default Problem and a non-Problem error body is read by its own schema", async () => {
  const { client } = harness((sent) =>
    sent.url === "/readyz"
      ? respond(503, "application/json", JSON.stringify({ status: "NOT_READY", checks: { process: "SERVING", database: "UNAVAILABLE", schema: "NOT_CHECKED" }, schemaVersion: { code: 3, database: null } }))
      : respond(200, "application/json", JSON.stringify({ status: "LIVE" })),
  );
  const live = await client.call("getLiveness");
  assert.equal(live.kind, "REPLY");
  const notReady = await client.call("getReadiness");
  assert.equal(notReady.kind, "REPLY", "a readiness body is read against getReadinessResponse503, not as a Problem");
  assert.equal(notReady.kind === "REPLY" && notReady.status, 503);
  const stray = await harness(() => respond(404, "application/problem+json", JSON.stringify(problem(404, "NOT_FOUND")))).client.call("getLiveness");
  assert.equal(stray.kind, "PROBLEM", "the default reply of a probe is a Problem");
});

test("D-PRIV-1: an observer is told of every classified answer without changing it, and an observer that throws never costs the caller its answer", async () => {
  const seen: string[] = [];
  const answers: Array<() => FetchedResponse> = [
    () => respond(200, "application/json", JSON.stringify({ kind: "READ", data: { items: [] } })),
    () => respond(401, "application/problem+json", JSON.stringify(problem(401, "AUTHENTICATION_REQUIRED"))),
    () => respond(200, "text/html", "<html></html>"),
    () => {
      throw new TypeError("network down");
    },
  ];
  let next = 0;
  const fetch: FetchLike = async () => (answers[next++] as () => FetchedResponse)();
  const observed = new ApiClient({
    fetch,
    newCorrelationId: () => CORRELATION,
    context: { csrfToken: () => null, activeAgency: () => null },
    observe: (answer) => {
      seen.push(answer.kind);
    },
  });
  const returned: string[] = [];
  for (let index = 0; index < 4; index += 1) returned.push((await observed.call("ListAgencies")).kind);
  assert.deepEqual(returned, ["REPLY", "PROBLEM", "INTEGRITY", "NO_ANSWER"]);
  assert.deepEqual(seen, returned, "the observer saw exactly what the caller got, in order");

  const reported: unknown[] = [];
  const throwing = new ApiClient({
    fetch: async () => respond(200, "application/json", JSON.stringify({ kind: "READ", data: { items: [] } })),
    newCorrelationId: () => CORRELATION,
    context: { csrfToken: () => null, activeAgency: () => null },
    observe: () => {
      throw new RangeError("observer bug");
    },
    reportObserverFailure: (error) => {
      reported.push(error);
    },
  });
  const answer = await throwing.call("ListAgencies");
  assert.equal(answer.kind, "REPLY", "the caller still gets its answer");
  assert.equal(reported.length, 1, "the observer's failure is reported, not swallowed");
  assert.ok(reported[0] instanceof RangeError);
});

test("D-GEN-1: every generated descriptor lists exactly the parameters of its path template, and every journaled command declares its Idempotency-Key", () => {
  // the commands that are not journaled by the api (sign-in and logout, the step-up, the public inquiry, the two document intakes, the owner's
  // content-addressed bank evidence upload, B12 D-B12S-2): a closed list
  const NOT_JOURNALED = ["SubmitDecisionArtifact", "SubmitSelectionManifest", "createInquiry", "createStepUp", "openSession", "revokeCurrentSession", "uploadBankEvidenceArtifact"];
  const journalless: string[] = [];
  for (const descriptor of Object.values(OPERATIONS)) {
    const templated = [...descriptor.path.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]);
    assert.deepEqual([...descriptor.pathParameters], templated, `${descriptor.operationId}: ${descriptor.path}`);
    if (descriptor.method !== "get" && descriptor.idempotency !== "REQUIRED") journalless.push(descriptor.operationId);
    if (descriptor.idempotency === "REQUIRED") assert.ok(descriptor.headers.includes("Idempotency-Key"), `${descriptor.operationId} sends its key`);
  }
  assert.deepEqual(journalless.sort(), NOT_JOURNALED);
  for (const id of ["configureBankRoute", "verifyBankRoute", "enableBankRoute", "disableBankRoute", "replaceBankRouteDetails"] as const) {
    assert.equal(OPERATIONS[id].idempotency, "REQUIRED", id);
    assert.ok(OPERATIONS[id].headers.includes("Idempotency-Key"), id);
  }
  assert.ok(OPERATIONS.getTransferInstructions.headers.includes("X-Kauro-Agency"));
});

test("D-B12S-4: a Ref path value admits the server's REF characters and never a dot segment; other parameters keep the UUID-safe pattern", async () => {
  const { client, sent } = harness(() => respond(500, null, ""));
  const proof = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f73";
  const body = { artifactRef: "art-1", evidenceHash: "a".repeat(64), authorizationRef: proof };
  // an account reference of the server's REF pattern (bank-route-routes.ts REF_PATH) reaches the wire, encoded
  await client.call("importBankStatement", { path: { accountRef: "acct.b12:main-1" }, body, idempotencyKey: KEY });
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.url.startsWith("/api/v1/operations/bank-accounts/acct.b12%3Amain-1/statement-imports"), sent[0]!.url);
  const refused: readonly (readonly [string, () => Promise<unknown>])[] = [
    ["a dot segment", () => client.call("importBankStatement", { path: { accountRef: "." }, body, idempotencyKey: KEY })],
    ["a parent segment", () => client.call("importBankStatement", { path: { accountRef: ".." }, body, idempotencyKey: KEY })],
    ["a slash", () => client.call("importBankStatement", { path: { accountRef: "a/b" }, body, idempotencyKey: KEY })],
    ["129 characters", () => client.call("importBankStatement", { path: { accountRef: "a".repeat(129) }, body, idempotencyKey: KEY })],
    // a parameter that is not a Ref keeps the UUID-safe characters: no dot, no colon
    ["a dot in an id", () => client.call("getBankCredit", { path: { creditId: "acct.b12" } })],
    ["a colon in an id", () => client.call("getBankCredit", { path: { creditId: "a:b" } })],
  ];
  for (const [label, attempt] of refused) await assert.rejects(attempt, RangeError, label);
  assert.equal(sent.length, 1, "no refused value reached the network");
});

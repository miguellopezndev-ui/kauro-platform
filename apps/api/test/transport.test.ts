// The HTTP transport of the api (review findings R28, R34, R39, R40, R41, R45 — docs/design/B06-review/E-transport-operability.md)
// through the real routes and composition root over PostgreSQL 17: the correlation id is resolved once per request (adopted
// when an `id`, minted otherwise, never refused or echoed) and is the request log's id; every answer the framework itself
// would give is a problem+json with that id and no echoed input; the body is strict UTF-8; a repeated envelope header is
// refused before its first value is used; and the client address reaches the creation limiter as a keyed hash of its network,
// through the configured number of trusted proxy hops. Framing cases that `inject` cannot express (a repeated header, a
// chunked body, a malformed request line) go over a real socket of the same server.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import type { AuthenticatedSubject } from "@kauro/application";
import { assembleApi, clientNetworkOf, createBearerTokenAuthenticator, loadContractSchemas } from "../src/index.js";
import { asProblem, call, clock, completed, effectCounts, freshKey, ids, outcome, personOf, routes, world, type Reply, type World } from "./support.js";

let w: World;
let port: number;
before(async () => {
  w = await world();
  const address = await w.app.listen({ host: "127.0.0.1", port: 0 });
  port = Number(new URL(address).port);
});
after(async () => {
  await w.stop();
});

const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One raw HTTP/1.1 exchange on a fresh socket: writes `chunks` in order and reads until the server closes the connection. */
function exchange(chunks: ReadonlyArray<string | Buffer>, toPort: number = port): Promise<{ readonly head: string; readonly status: number; readonly headers: Record<string, string>; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(toPort, "127.0.0.1");
    const received: Buffer[] = [];
    socket.on("data", (d: Buffer) => received.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(received).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = split < 0 ? text : text.slice(0, split);
      const lines = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ head, status: Number(lines[0]?.split(" ")[1] ?? "0"), headers, body: split < 0 ? "" : text.slice(split + 4) });
    });
    socket.on("connect", () => {
      for (const c of chunks) socket.write(c);
    });
  });
}

function requestHead(path: string, headers: ReadonlyArray<string>): string {
  return [`POST ${path} HTTP/1.1`, "Host: kauro.test", "Connection: close", ...headers, "", ""].join("\r\n");
}

function withLength(path: string, headers: ReadonlyArray<string>, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(requestHead(path, [...headers, `Content-Length: ${body.length}`]), "latin1"), body]);
}

function problemOfRaw(r: { status: number; headers: Record<string, string>; body: string }): { code: string; reason?: string; correlationId: string } {
  assert.match(r.headers["content-type"] ?? "", /^application\/problem\+json/);
  const p = w.validator.validate<{ code: string; reason?: string; correlationId: string }>("Problem", JSON.parse(r.body));
  if (p.kind === "INVALID") throw new Error(`not a Problem: ${r.body}`);
  assert.equal(r.headers["x-correlation-id"], p.value.correlationId, "the header and the problem carry the same correlation id");
  return p.value;
}

test("R28: a client correlation id that is not an id never refuses the command — the server mints a UUIDv7, answers and records the command under it, and never echoes the client value", async () => {
  for (const given of ["req-7f3a-proxy", "Root=1-5f84c7a1-abcdef", "abc def <script>"]) {
    const res = await call(w, { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, headers: { "x-correlation-id": given }, body: { displayName: `Via proxy ${given.length}`, processingAuthorityRef: w.authorityA } });
    const created = completed<{ clientId: string }>(res, 201);
    const correlationId = String(res.headers["x-correlation-id"]);
    assert.match(correlationId, MINTED, given);
    assert.ok(!res.text.includes(given) && !correlationId.includes(given), `${given} is never echoed`);
    // the minted id is the command's durable correlation too: journal entry and event
    assert.equal(await w.count("command_journal", "correlation_id = $1 AND resource_id = $2", [correlationId, created.data.clientId]), 1, given);
    assert.equal(await w.count("domain_events", "correlation_id = $1 AND aggregate_id = $2", [correlationId, created.data.clientId]), 1, given);
  }
});

test("R45: the request log's id is the correlation id — supplied or minted, every log line of a request carries the id its answer names, the internal-error sink uses the same id, and an answer below HTTP is logged under its id too", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const sunk: Array<{ correlationId: string }> = [];
  const tokens = new Map<string, AuthenticatedSubject>([[w.owner.token, w.owner.subject]]);
  const app = assembleApi({
    environment: "LOCAL",
    unitOfWork: w.db.unitOfWork,
    database: w.db,
    authenticator: createBearerTokenAuthenticator(tokens),
    validator: loadContractSchemas(),
    clock,
    ids,
    logger: { level: "info", stream: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) } },
    onInternalError: (correlationId) => sunk.push({ correlationId }),
  });
  await app.ready();
  try {
    const supplied = ids.next();
    const suppliedRes = await app.inject({ method: "POST", url: routes.createAgency(), headers: { "content-type": "application/json", authorization: `Bearer ${w.owner.token}`, "idempotency-key": freshKey("log"), "x-correlation-id": supplied }, payload: JSON.stringify({ displayName: "Logged" }) });
    assert.equal(suppliedRes.headers["x-correlation-id"], supplied);
    const mintedRes = await app.inject({ method: "POST", url: "/api/v1/nothing", headers: { "content-type": "application/json" }, payload: "{}" });
    const minted = String(mintedRes.headers["x-correlation-id"]);
    assert.match(minted, MINTED);
    for (const id of [supplied, minted]) {
      const own = lines.filter((l) => l["correlationId"] === id);
      assert.ok(own.some((l) => l["msg"] === "incoming request") && own.some((l) => l["msg"] === "request completed"), `the request ${id} is found in the log by its correlation id`);
    }
    // below HTTP no request object exists (an unreadable header line): the problem's minted id is still in the log
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const garbled = await exchange([["POST /api/v1/agencies HTTP/1.1", "Host: kauro.test", "this is not a header", "", ""].join("\r\n")], Number(new URL(address).port));
    const garbledId = problemOfRaw(garbled).correlationId;
    assert.match(garbledId, MINTED);
    assert.ok(lines.some((l) => l["correlationId"] === garbledId && l["reason"] === "REQUEST_MALFORMED"), "the answer below HTTP is found in the log by its correlation id");
    assert.ok(!lines.some((l) => JSON.stringify(l).includes("this is not a header")), "the raw bytes are never logged");
    // every request-scoped line (pino's incoming/completed lines carry req/res) is labelled with a correlation id
    const requestLines = lines.filter((l) => "req" in l || "res" in l);
    assert.ok(requestLines.length >= 4);
    assert.ok(requestLines.every((l) => l["correlationId"] === supplied || (typeof l["correlationId"] === "string" && MINTED.test(l["correlationId"]))), "no line carries Fastify's counter");
    assert.ok(!lines.some((l) => "reqId" in l));
    // an unexpected exception: the sink's correlation id is the one in the log lines and in the answer
    const failing = assembleApi({
      environment: "LOCAL",
      unitOfWork: { run: async () => Promise.reject(new TypeError("boom")) },
      database: w.db,
      authenticator: createBearerTokenAuthenticator(tokens),
      validator: loadContractSchemas(),
      clock,
      ids,
      logger: { level: "info", stream: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) } },
      onInternalError: (correlationId) => sunk.push({ correlationId }),
    });
    await failing.ready();
    try {
      const res = await failing.inject({ method: "POST", url: routes.createAgency(), headers: { "content-type": "application/json", authorization: `Bearer ${w.owner.token}`, "idempotency-key": freshKey("boom") }, payload: JSON.stringify({ displayName: "Boom" }) });
      assert.equal(res.statusCode, 500);
      const correlationId = String(res.headers["x-correlation-id"]);
      assert.deepEqual(sunk.at(-1), { correlationId });
      assert.ok(lines.some((l) => l["correlationId"] === correlationId && l["msg"] === "request completed"));
    } finally {
      await failing.close();
    }
  } finally {
    await app.close();
  }
});

test("R39: framework errors are problems — an undecodable URL is REQUEST_MALFORMED, an over-long path parameter PATH_ID_INVALID, an unreadable request line REQUEST_MALFORMED; each with a correlation id and nothing echoed", async () => {
  const counts = await effectCounts(w);
  const bad = await call(w, { url: "/api/v1/clients/%zz/archive", token: w.admin.token, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, bad), "400 INVALID_REQUEST REQUEST_MALFORMED");
  assert.equal(bad.contentType, "application/problem+json; charset=utf-8");
  assert.equal(asProblem(w, bad).correlationId, bad.headers["x-correlation-id"]);
  assert.match(String(bad.headers["x-correlation-id"]), MINTED);
  assert.ok(!bad.text.includes("%zz") && !bad.text.includes("zz") && !bad.text.includes("/api/v1"), "the path is not echoed");
  const long = await call(w, { url: `/api/v1/clients/${"a".repeat(101)}/archive`, token: w.admin.token, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, long), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.ok(!long.text.includes("aaaa"));
  // below HTTP: a header line without a colon — the parser refuses it; the answer is still a problem, then the socket closes
  const garbled = await exchange([["POST /api/v1/agencies HTTP/1.1", "Host: kauro.test", "this is not a header", "", ""].join("\r\n")]);
  assert.equal(garbled.status, 400);
  const p = problemOfRaw(garbled);
  assert.deepEqual([p.code, p.reason], ["INVALID_REQUEST", "REQUEST_MALFORMED"]);
  assert.match(p.correlationId, MINTED);
  assert.ok(!garbled.body.includes("this is not"));
  assert.deepEqual(await effectCounts(w), counts);
});

test("R40: the body is strict UTF-8 — invalid bytes are JSON_SYNTAX with Content-Length and when chunked, nothing is stored with U+FFFD; a body shorter or longer than its Content-Length is REQUEST_MALFORMED", async () => {
  const bad = Buffer.concat([Buffer.from('{"displayName":"Bad'), Buffer.from([0xff, 0xfe]), Buffer.from('Name"}')]);
  const person = await w.person("utf8-founder");
  const counts = await effectCounts(w);
  const runs = w.stats.runs;
  const headers = ["Content-Type: application/json", `Authorization: Bearer ${person.token}`];
  // with a Content-Length (inject computes it from the bytes)
  const lengthed = await w.app.inject({ method: "POST", url: routes.createAgency(), headers: { "content-type": "application/json", authorization: `Bearer ${person.token}`, "idempotency-key": freshKey("utf8") }, payload: bad });
  assert.equal(lengthed.statusCode, 400);
  assert.deepEqual([asProblem(w, toReply(lengthed)).code, asProblem(w, toReply(lengthed)).reason], ["INVALID_REQUEST", "JSON_SYNTAX"]);
  // chunked, where no length comparison can notice a replaced byte
  const chunked = await exchange([requestHead(routes.createAgency(), [...headers, `Idempotency-Key: ${freshKey("chunked")}`, "Transfer-Encoding: chunked"]), `${bad.length.toString(16)}\r\n`, bad, "\r\n0\r\n\r\n"]);
  assert.equal(chunked.status, 400);
  assert.equal(problemOfRaw(chunked).reason, "JSON_SYNTAX");
  assert.equal(w.stats.runs, runs, "no unit of work opened");
  assert.deepEqual(await effectCounts(w), counts, "nothing stored");
  assert.equal(await w.count("agencies", "display_name LIKE '%' || chr(65533) || '%'"), 0);
  // a declared length the body does not have: the framing cannot be trusted
  for (const declared of ["40", "3"]) {
    const res = await w.app.inject({ method: "POST", url: routes.createAgency(), headers: { "content-type": "application/json", "content-length": declared, authorization: `Bearer ${person.token}`, "idempotency-key": freshKey("length") }, payload: Buffer.from('{"displayName":"Length"}') });
    assert.equal(outcome(w, toReply(res)), "400 INVALID_REQUEST REQUEST_MALFORMED", declared);
  }
  // valid multi-byte text arrives intact, chunked or not
  const name = "Agência Ñandú 東京";
  const ok = await exchange([requestHead(routes.createAgency(), [...headers, `Idempotency-Key: ${freshKey("chunked-ok")}`, "Transfer-Encoding: chunked"]), (() => { const b = Buffer.from(JSON.stringify({ displayName: name })); return Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`), b, Buffer.from("\r\n0\r\n\r\n")]); })()]);
  assert.equal(ok.status, 201, ok.body);
  const agencyId = (JSON.parse(ok.body) as { data: { agency: { agencyId: string } } }).data.agency.agencyId;
  assert.deepEqual(await w.row<{ display_name: string }>("agencies", "agency_id = $1", [agencyId]).then((r) => r?.display_name), name);
});

function toReply(res: { statusCode: number; headers: Record<string, unknown>; body: string }): Reply {
  return {
    status: res.statusCode,
    headers: res.headers as Reply["headers"],
    contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : undefined,
    text: res.body,
    json: <T>() => JSON.parse(res.body) as T,
  };
}

test("R41: a repeated Authorization, Content-Type, Idempotency-Key, X-Correlation-Id or X-Kauro-Agency is refused as HEADER_REPEATED before any value is used — a second bearer token cannot choose the acting subject", async () => {
  const second = await w.person("second-bearer");
  const counts = await effectCounts(w);
  const runs = w.stats.runs;
  const body = Buffer.from(JSON.stringify({ displayName: "Dup" }));
  const base = (key: string) => ["Content-Type: application/json", `Authorization: Bearer ${w.owner.token}`, `Idempotency-Key: ${key}`];
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["authorization", ["Content-Type: application/json", `Authorization: Bearer ${second.token}`, `Authorization: Bearer ${w.owner.token}`, `Idempotency-Key: ${freshKey("dup-auth")}`]],
    ["content-type", ["Content-Type: application/json", "Content-Type: text/plain", `Authorization: Bearer ${second.token}`, `Idempotency-Key: ${freshKey("dup-ct")}`]],
    ["idempotency-key", [...base(freshKey("dup-key-a")), `Idempotency-Key: ${freshKey("dup-key-b")}`]],
    ["x-correlation-id", [...base(freshKey("dup-corr")), `X-Correlation-Id: ${ids.next()}`, `X-Correlation-Id: ${ids.next()}`]],
    ["x-kauro-agency", [...base(freshKey("dup-agency")), `X-Kauro-Agency: ${w.A.agencyId}`, `X-Kauro-Agency: ${w.B.agencyId}`]],
  ];
  for (const [name, headers] of cases) {
    const r = await exchange([withLength(routes.createAgency(), headers, body)]);
    assert.equal(r.status, 400, name);
    const p = problemOfRaw(r);
    assert.deepEqual([p.code, p.reason], ["INVALID_REQUEST", "HEADER_REPEATED"], name);
  }
  assert.equal(w.stats.runs, runs, "no unit of work opened");
  assert.deepEqual(await effectCounts(w), counts, "no agency for either bearer");
  // the same request with each header once is served
  const once = await exchange([withLength(routes.createAgency(), ["Content-Type: application/json", `Authorization: Bearer ${second.token}`, `Idempotency-Key: ${freshKey("once")}`], body)]);
  assert.equal(once.status, 201, once.body);
});

test("R34: the client address reaches the creation limiter as a keyed hash of its network — through exactly the configured proxy hops; N+1 identities from one client are limited, another client is not, and a forged X-Forwarded-For moves nothing when no hop is trusted", async () => {
  // the network of an address: IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 as its /64
  assert.equal(clientNetworkOf("203.0.113.9"), "203.0.113.9");
  assert.equal(clientNetworkOf("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientNetworkOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:0db8:0001:0002::/64");
  assert.equal(clientNetworkOf("2001:db8:1:2::7"), clientNetworkOf("2001:0DB8:1:2:ffff::1"), "one /64 is one client");
  assert.notEqual(clientNetworkOf("2001:db8:1:2::7"), clientNetworkOf("2001:db8:1:3::7"));
  assert.equal(clientNetworkOf("::1"), "0000:0000:0000:0000::/64");

  const tokens = new Map<string, AuthenticatedSubject>();
  const people = Array.from({ length: 23 }, (_, i) => {
    const p = personOf(`farm-${i}`);
    tokens.set(p.token, p.subject);
    return p;
  });
  const behindProxy = assembleApi({ environment: "LOCAL", unitOfWork: w.db.unitOfWork, database: w.db, authenticator: createBearerTokenAuthenticator(tokens), validator: loadContractSchemas(), clock, ids, trustedProxyHops: 1 });
  await behindProxy.ready();
  try {
    const create = (token: string, forwardedFor: string) =>
      behindProxy.inject({
        method: "POST",
        url: routes.createAgency(),
        remoteAddress: "10.0.0.2",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": freshKey("farm"), "x-forwarded-for": forwardedFor },
        payload: JSON.stringify({ displayName: "Farm" }),
      });
    // twenty creations per client address per hour (design I-ADM-1): identities 0..19 from one client behind the proxy
    for (const p of people.slice(0, 20)) assert.equal((await create(p.token, "198.51.100.7")).statusCode, 201, p.name);
    const limited = await create(people[20]!.token, "198.51.100.7");
    assert.equal(limited.statusCode, 429, "the twenty-first identity from one client address is limited");
    assert.equal(outcome(w, toReply(limited)), "429 ADMISSION_LIMITED CREATION_RATE_LIMITED");
    assert.ok((JSON.parse(limited.body) as { retryAfterSeconds?: number }).retryAfterSeconds! > 0);
    // a spoofed entry in front of the proxy's own is not trusted: the proxy-reported client is still 198.51.100.7
    const spoofed = await create(people[21]!.token, "192.0.2.1, 198.51.100.7");
    assert.equal(spoofed.statusCode, 429, "a forged leading X-Forwarded-For entry does not open a new window");
    assert.equal(outcome(w, toReply(spoofed)), "429 ADMISSION_LIMITED CREATION_RATE_LIMITED");
    // another client behind the same proxy is another window
    assert.equal((await create(people[22]!.token, "198.51.100.8")).statusCode, 201);
  } finally {
    await behindProxy.close();
  }
  // with no trusted hop the socket peer is the client: X-Forwarded-For is ignored, so rotating it opens nothing
  const direct = assembleApi({ environment: "LOCAL", unitOfWork: w.db.unitOfWork, database: w.db, authenticator: createBearerTokenAuthenticator(tokens), validator: loadContractSchemas(), clock, ids });
  await direct.ready();
  try {
    const fresh = Array.from({ length: 21 }, (_, i) => {
      const p = personOf(`direct-${i}`);
      tokens.set(p.token, p.subject);
      return p;
    });
    for (const [i, p] of fresh.entries()) {
      const res = await direct.inject({
        method: "POST",
        url: routes.createAgency(),
        remoteAddress: "10.0.0.9",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.token}`, "idempotency-key": freshKey("direct"), "x-forwarded-for": `203.0.113.${i}` },
        payload: JSON.stringify({ displayName: "Direct" }),
      });
      assert.equal(res.statusCode, i < 20 ? 201 : 429, `${p.name}: ${res.body}`);
    }
  } finally {
    await direct.close();
  }
});

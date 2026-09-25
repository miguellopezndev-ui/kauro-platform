// The api process as a deployment runs it (review findings R34-R38, R42-R44; 14 "Monitoring and service health", "Deployment
// and rollback"; 07 "Connection budget and operating limits", "Restoration and migration"; 08 "Abuse controls", "Secrets and
// supply chain"): bootstrap() from an environment, a real socket, a real PostgreSQL 17. Every wait is bounded and fails
// loudly; interleavings are fixed by a lock held from a superuser session and observed in pg_stat_activity, never by a sleep.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DomainFailure } from "@kauro/domain";
import type { PoolErrorEvent } from "@kauro/persistence";
import { classifyError, listMigrations } from "@kauro/persistence";
import { ROLES, startTemporaryPostgres, waitForLockWait, type TemporaryPostgres } from "@kauro/persistence/testing";
import {
  API_APPLICATION_NAME,
  ConfigError,
  HEALTH_ROUTES,
  LIVENESS_RESPONSE_SCHEMA,
  READINESS_RESPONSE_SCHEMA,
  bootstrap,
  loadConfig,
  writeNotReady,
  writeUnavailable,
  type BootstrappedApi,
  type ReadinessResponse,
} from "../src/index.js";

let pg: TemporaryPostgres;
let dir: string;
before(async () => {
  pg = await startTemporaryPostgres();
  dir = mkdtempSync(join(tmpdir(), "kauro-api-operability-"));
});
after(async () => {
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
});

const VERIFIED = "2026-09-24T12:00:00.000Z";
const FOUNDER = "operability-founder-token-0001";
const RUNTIME_SECRET = "runtime-secret-value";
const MIGRATOR_SECRET = "migrator-secret-value";
const farmToken = (i: number) => `operability-farm-token-${String(i).padStart(4, "0")}`;

function tokenFile(): string {
  const path = join(dir, "bearer-tokens.json");
  const subject = (token: string, name: string) => ({ token, provider: "identity-platform", subject: name, emailVerifiedAt: VERIFIED, mfaEnrolledAt: VERIFIED, state: "ACTIVE" });
  writeFileSync(path, JSON.stringify({ subjects: [subject(FOUNDER, "operability-founder"), ...Array.from({ length: 30 }, (_, i) => subject(farmToken(i), `operability-farm-${i}`))] }));
  return path;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function envOf(cluster: TemporaryPostgres, overrides: Record<string, string | undefined> = {}): Promise<Record<string, string | undefined>> {
  return {
    KAURO_ENVIRONMENT: "LOCAL",
    KAURO_DB_HOST: "127.0.0.1",
    KAURO_DB_PORT: String(cluster.port),
    KAURO_DB_NAME: ROLES.database,
    KAURO_DB_USER: ROLES.appLogin,
    KAURO_DB_POOL_MAX: "4",
    KAURO_HTTP_HOST: "127.0.0.1",
    KAURO_HTTP_PORT: String(await freePort()),
    KAURO_AUTH_BEARER_TOKENS_FILE: tokenFile(),
    ...overrides,
  };
}

/** Fails loudly when `promise` has not settled within `ms`: a bounded wait, never a synchronization point. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function configError(variable: string): (e: unknown) => boolean {
  return (e) => e instanceof ConfigError && e.message.startsWith(`${variable}:`);
}

let keyCounter = 0;
function createAgency(api: BootstrappedApi, token: string, headers: Record<string, string> = {}): Promise<Response> {
  keyCounter += 1;
  return fetch(`${api.address}/api/v1/agencies`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": `operability-key-${String(keyCounter).padStart(6, "0")}`, ...headers },
    body: JSON.stringify({ displayName: `Operability ${keyCounter}` }),
  });
}

/** A raw socket that has sent part of a request's head: the server holds it as a connection with a request in progress. */
function partialRequest(port: number, firstPart: string): Promise<{ finish(rest: string): Promise<string>; destroy(): void }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const received: Buffer[] = [];
    const closed = new Promise<string>((done) => socket.on("close", () => done(Buffer.concat(received).toString("utf8"))));
    socket.on("data", (d: Buffer) => received.push(d));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(firstPart, () =>
        resolve({
          finish: (rest) => {
            socket.write(rest);
            return closed;
          },
          destroy: () => socket.destroy(),
        }),
      );
    });
  });
}

/** A minimal check of a body against the closed response schemas health.ts exports (type, enum, required, closed objects). */
function conforms(schema: Record<string, unknown>, value: unknown, at = "$"): void {
  const types = schema["type"] === undefined ? [] : Array.isArray(schema["type"]) ? (schema["type"] as string[]) : [schema["type"] as string];
  const typeOf = value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value === "object" ? "object" : typeof value;
  assert.ok(types.length === 0 || types.includes(typeOf) || (typeOf === "integer" && types.includes("number")), `${at}: ${typeOf} is not ${types.join("|")}`);
  if (Array.isArray(schema["enum"])) assert.ok((schema["enum"] as unknown[]).includes(value), `${at}: ${String(value)} is not in the enum`);
  if (typeOf === "object") {
    const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema["required"] ?? []) as string[]) assert.ok(key in (value as object), `${at}.${key} is required`);
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      const sub = props[key];
      assert.ok(sub !== undefined || schema["additionalProperties"] !== false, `${at}.${key} is not allowed`);
      if (sub) conforms(sub, member, `${at}.${key}`);
    }
  }
}

test("configuration of the operating limits: the api pool stays inside the four-connection budget (R43), the proxy hop count is explicit outside LOCAL (R34), request, socket and shutdown deadlines are bounded (R35, R36), the migrator's limits are read with migrations on start (R37), and its password is never configuration (R44)", async () => {
  const base = await envOf(pg);
  // R43: 07 "API at most two instances with four connections each"
  assert.equal(loadConfig({ ...base, KAURO_DB_POOL_MAX: "4" }).database.poolMax, 4);
  for (const bad of ["5", "24"]) assert.throws(() => loadConfig({ ...base, KAURO_DB_POOL_MAX: bad }), configError("KAURO_DB_POOL_MAX"), bad);
  // R34: behind the platform's load balancer the hop count is a deployment fact
  assert.equal(loadConfig(base).http.trustedProxyHops, 0);
  assert.equal(loadConfig({ ...base, KAURO_HTTP_TRUSTED_PROXY_HOPS: "2" }).http.trustedProxyHops, 2);
  assert.throws(() => loadConfig({ ...base, KAURO_ENVIRONMENT: "LIVE", KAURO_AUTH_BEARER_TOKENS_FILE: undefined }), configError("KAURO_HTTP_TRUSTED_PROXY_HOPS"));
  assert.throws(() => loadConfig({ ...base, KAURO_HTTP_TRUSTED_PROXY_HOPS: "5" }), configError("KAURO_HTTP_TRUSTED_PROXY_HOPS"));
  // R36 / R35
  assert.deepEqual(
    loadConfig({ ...base, KAURO_HTTP_REQUEST_TIMEOUT_MS: "15000", KAURO_HTTP_CONNECTION_TIMEOUT_MS: "20000", KAURO_SHUTDOWN_DEADLINE_MS: "9000" }).http,
    { host: "127.0.0.1", port: Number(base["KAURO_HTTP_PORT"]), trustedProxyHops: 0, requestTimeoutMs: 15_000, connectionTimeoutMs: 20_000, shutdownDeadlineMs: 9_000 },
  );
  assert.throws(() => loadConfig({ ...base, KAURO_HTTP_REQUEST_TIMEOUT_MS: "0" }), configError("KAURO_HTTP_REQUEST_TIMEOUT_MS"));
  assert.throws(() => loadConfig({ ...base, KAURO_HTTP_CONNECTION_TIMEOUT_MS: "999" }), configError("KAURO_HTTP_CONNECTION_TIMEOUT_MS"));
  assert.throws(() => loadConfig({ ...base, KAURO_SHUTDOWN_DEADLINE_MS: "10000" }), configError("KAURO_SHUTDOWN_DEADLINE_MS"), "the deadline stays below Cloud Run's ten-second grace period");
  // R37 / R44
  const migrating = loadConfig({ ...base, KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.owner, KAURO_DB_MIGRATOR_PASSWORD: MIGRATOR_SECRET, KAURO_DB_MIGRATOR_CONNECT_TIMEOUT_MS: "300" });
  assert.deepEqual(migrating.migrateOnStart, { host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.owner, connectTimeoutMs: 300, statementTimeoutMs: 120_000, lockTimeoutMs: 5_000 });
  assert.ok(!JSON.stringify(migrating).includes(MIGRATOR_SECRET), "the migrator password is not configuration");
  assert.throws(() => loadConfig({ ...base, KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.owner, KAURO_DB_MIGRATOR_LOCK_TIMEOUT_MS: "50" }), configError("KAURO_DB_MIGRATOR_LOCK_TIMEOUT_MS"));
  assert.throws(() => loadConfig({ ...base, KAURO_DB_MIGRATOR_PASSWORD: MIGRATOR_SECRET }), (e: unknown) => configError("KAURO_DB_MIGRATOR_PASSWORD")(e) && !(e as Error).message.includes(MIGRATOR_SECRET), "an instance that does not migrate never receives owner credentials");
});

test("R44: bootstrap consumes the migrator password — it leaves the environment before anything runs and is no part of the configuration the running process keeps", async () => {
  const env = await envOf(pg, { KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.owner, KAURO_DB_MIGRATOR_PASSWORD: MIGRATOR_SECRET, KAURO_DB_PASSWORD: RUNTIME_SECRET });
  const api = await bootstrap(env, { logger: false });
  try {
    assert.ok(!("KAURO_DB_MIGRATOR_PASSWORD" in env), "removed from the environment the process was given");
    assert.deepEqual(api.database.migrations && [api.database.migrations.applied.length, api.database.migrations.skipped.length], [0, listMigrations().length]);
    assert.ok(api.config.migrateOnStart !== null && !("password" in api.config.migrateOnStart));
    assert.ok(!JSON.stringify(api.config).includes(MIGRATOR_SECRET));
    assert.equal(api.config.database.password, RUNTIME_SECRET, "the runtime login keeps its own credential: the pool reconnects with it");
  } finally {
    await api.close();
  }
});

test("R34: one client address cannot rotate identities past the per-address creation window of the running api — twenty verified identities are admitted, the next is 429 CREATION_RATE_LIMITED, and a forged X-Forwarded-For moves nothing when no proxy hop is trusted", async () => {
  const api = await bootstrap(await envOf(pg), { logger: false });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await createAgency(api, farmToken(i));
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    assert.deepEqual(statuses, Array<number>(20).fill(201));
    for (const [i, headers] of [[20, {}], [21, { "x-forwarded-for": "203.0.113.50" }]] as const) {
      const r = await createAgency(api, farmToken(i), headers);
      assert.equal(r.status, 429);
      const p = (await r.json()) as { code: string; reason: string; retryAfterSeconds: number };
      assert.deepEqual([p.code, p.reason], ["ADMISSION_LIMITED", "CREATION_RATE_LIMITED"]);
      assert.ok(p.retryAfterSeconds > 0);
    }
  } finally {
    await api.close();
  }
});

test("R36: a request that stalls is not held forever — past the request timeout it is answered REQUEST_TIMEOUT and closed; a silent socket is closed past the connection timeout", async () => {
  const slowBody = await bootstrap(await envOf(pg, { KAURO_HTTP_REQUEST_TIMEOUT_MS: "1000" }), { logger: false });
  try {
    assert.equal(slowBody.app.server.requestTimeout, 1_000);
    const port = Number(new URL(slowBody.address).port);
    const stalled = await partialRequest(port, ["POST /api/v1/agencies HTTP/1.1", "Host: kauro.test", "Content-Type: application/json", `Authorization: Bearer ${FOUNDER}`, "Idempotency-Key: operability-stalled-01", "Content-Length: 100", "", "{"].join("\r\n"));
    const answer = await within(stalled.finish(""), 15_000, "a request whose body never completes");
    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.match(answer, /"reason":"REQUEST_TIMEOUT"/);
    assert.match(answer, /content-type: application\/problem\+json/i);
  } finally {
    await slowBody.close();
  }
  const silent = await bootstrap(await envOf(pg, { KAURO_HTTP_CONNECTION_TIMEOUT_MS: "1000" }), { logger: false });
  try {
    assert.equal(silent.app.server.timeout, 1_000);
    const port = Number(new URL(silent.address).port);
    const idle = await partialRequest(port, "POST /api/v1/agencies HTTP/1.1\r\nHost: kauro.test\r\n");
    const answer = await within(idle.finish(""), 15_000, "a socket that stopped sending");
    assert.equal(answer, "", "the silent socket is closed without an answer");
  } finally {
    await silent.close();
  }
});

test("R35: shutdown drains — the in-flight command is answered with Connection: close, a request completed on an open connection meanwhile is a 503 problem, readiness reports DRAINING, and close() ends with the in-flight work instead of waiting for keep-alive sockets", async () => {
  const api = await bootstrap(await envOf(pg), { logger: false });
  const port = Number(new URL(api.address).port);
  const oracle = await pg.connect("postgres");
  let locked = false;
  let shutdownStarted = false;
  const partial: Array<{ destroy(): void }> = [];
  try {
    const warm = await createAgency(api, farmToken(25));
    assert.equal(warm.status, 201);
    await warm.arrayBuffer();
    // two connections with a request head in progress, completed only once the drain began
    const lateCommand = await partialRequest(port, "POST /api/v1/agencies HTTP/1.1\r\nHost: kauro.test\r\n");
    const lateProbe = await partialRequest(port, "GET /readyz HTTP/1.1\r\nHost: kauro.test\r\n");
    partial.push(lateCommand, lateProbe);
    await oracle.query("BEGIN");
    await oracle.query("LOCK TABLE kauro.agencies IN ACCESS EXCLUSIVE MODE");
    locked = true;
    const inflight = createAgency(api, farmToken(26));
    await waitForLockWait(oracle, API_APPLICATION_NAME, "");
    const shutdown = api.shutdown();
    shutdownStarted = true;
    const lateCommandAnswer = await within(lateCommand.finish(`Content-Type: application/json\r\nAuthorization: Bearer ${FOUNDER}\r\nIdempotency-Key: operability-late-000001\r\nContent-Length: 2\r\n\r\n{}`), 15_000, "a request completed during the drain");
    assert.match(lateCommandAnswer, /^HTTP\/1\.1 503 /);
    assert.match(lateCommandAnswer, /connection: close/i);
    assert.match(lateCommandAnswer, /"code":"CAPACITY_UNAVAILABLE"/);
    const lateProbeAnswer = await within(lateProbe.finish("\r\n"), 15_000, "a readiness probe during the drain");
    assert.match(lateProbeAnswer, /^HTTP\/1\.1 503 /);
    const probeBody = JSON.parse(lateProbeAnswer.slice(lateProbeAnswer.indexOf("\r\n\r\n") + 4)) as ReadinessResponse;
    conforms(READINESS_RESPONSE_SCHEMA, probeBody);
    assert.deepEqual(probeBody.checks, { process: "DRAINING", database: "NOT_CHECKED", schema: "NOT_CHECKED" });
    await oracle.query("ROLLBACK");
    locked = false;
    const answered = await within(inflight, 15_000, "the in-flight command");
    assert.equal(answered.status, 201, "the in-flight command completes");
    assert.equal(answered.headers.get("connection"), "close", "and closes its keep-alive connection");
    await answered.arrayBuffer();
    assert.deepEqual(await within(shutdown, 15_000, "shutdown"), { kind: "CLOSED" }, "the drain finished well inside the deadline");
    assert.equal(api.database.pool.raw.ended, true);
    await assert.rejects(fetch(`${api.address}/livez`), "no new connection is accepted");
  } finally {
    for (const socket of partial) socket.destroy();
    if (locked) await oracle.query("ROLLBACK");
    await oracle.end();
    if (!shutdownStarted) await api.shutdown();
  }
});

test("R35: the shutdown deadline is kept — a command blocked past it has its connection closed and shutdown() returns DEADLINE_EXCEEDED; the close completes once the database lets the command go", async () => {
  const api = await bootstrap(await envOf(pg, { KAURO_SHUTDOWN_DEADLINE_MS: "300" }), { logger: false });
  const oracle = await pg.connect("postgres");
  let locked = false;
  let shutdownStarted = false;
  try {
    await oracle.query("BEGIN");
    await oracle.query("LOCK TABLE kauro.agencies IN ACCESS EXCLUSIVE MODE");
    locked = true;
    const inflight = createAgency(api, farmToken(27)).then(
      (r) => `answered ${r.status}`,
      (e: unknown) => `connection closed: ${e instanceof Error ? e.name : typeof e}`,
    );
    await waitForLockWait(oracle, API_APPLICATION_NAME, "");
    shutdownStarted = true;
    const outcome = await within(api.shutdown(), 15_000, "shutdown with a blocked command");
    assert.equal(outcome.kind, "DEADLINE_EXCEEDED");
    assert.match(await within(inflight, 15_000, "the blocked request"), /^connection closed/);
    await oracle.query("ROLLBACK");
    locked = false;
    if (outcome.kind === "DEADLINE_EXCEEDED") await within(outcome.closing, 15_000, "the close after the deadline");
    assert.equal(api.database.pool.raw.ended, true);
  } finally {
    if (locked) await oracle.query("ROLLBACK");
    await oracle.end();
    if (!shutdownStarted) await api.shutdown();
  }
});

test("R37: with migrations on start, a database host that accepts and never answers refuses the start within the migrator's connect timeout", async () => {
  const sockets: Socket[] = [];
  const silent: Server = createServer((s) => {
    sockets.push(s);
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  const silentPort = typeof address === "object" && address ? address.port : 0;
  try {
    const env = await envOf(pg, { KAURO_DB_PORT: String(silentPort), KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.owner, KAURO_DB_MIGRATOR_CONNECT_TIMEOUT_MS: "300" });
    const started = Date.now();
    await within(assert.rejects(bootstrap(env, { logger: false }), (e: unknown) => e instanceof Error && /timeout/i.test(e.message)), 10_000, "bootstrap against a silent database host");
    // the configured 300 ms bound the wait, not the runner's 5 s default: the variable reaches the migrator connection
    assert.ok(Date.now() - started < 3_000, `refused after ${Date.now() - started} ms`);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("R42 and R38: /livez and /readyz outside /api/v1 — readiness verifies a connection and the schema against the shipped migrations (503 when drifted or behind, tolerant of a newer expand); a database outage is visible by correlation id in the unavailable and not-ready sinks and in the pool sink, never with a credential", async () => {
  const cluster = await startTemporaryPostgres();
  const poolEvents: PoolErrorEvent[] = [];
  let poolEvent: () => void = () => undefined;
  const poolEventSeen = new Promise<void>((resolve) => {
    poolEvent = resolve;
  });
  const unavailable: Array<{ correlationId: string; cause: unknown }> = [];
  const notReady: Array<{ correlationId: string; response: ReadinessResponse; cause: unknown }> = [];
  const api = await bootstrap(await envOf(cluster, { KAURO_DB_PASSWORD: RUNTIME_SECRET }), {
    logger: false,
    onPoolError: (e) => {
      poolEvents.push(e);
      poolEvent();
    },
    onUnavailable: (correlationId, cause) => unavailable.push({ correlationId, cause }),
    onNotReady: (correlationId, response, cause) => notReady.push({ correlationId, response, cause }),
  });
  const oracle = await cluster.connect("postgres");
  const shipped = listMigrations();
  const code = shipped.at(-1)?.version ?? 0;
  const probe = async (path: string) => {
    const r = await fetch(`${api.address}${path}`);
    return { status: r.status, correlationId: r.headers.get("x-correlation-id"), contentType: r.headers.get("content-type"), body: (await r.json()) as unknown };
  };
  let stopped = false;
  try {
    // the inventory: exactly the two probe routes, GET, outside /api/v1
    for (const route of HEALTH_ROUTES) {
      assert.ok(api.app.hasRoute({ method: route.method, url: route.path }), route.path);
      assert.ok(!route.path.startsWith("/api/"), route.path);
    }
    const live = await probe("/livez");
    assert.equal(live.status, 200);
    conforms(LIVENESS_RESPONSE_SCHEMA, live.body);
    assert.deepEqual(live.body, { status: "LIVE" });
    const ready = await probe("/readyz");
    assert.equal(ready.status, 200);
    conforms(READINESS_RESPONSE_SCHEMA, ready.body);
    assert.deepEqual(ready.body, { status: "READY", checks: { process: "SERVING", database: "AVAILABLE", schema: "COMPATIBLE" }, schemaVersion: { code, database: code } });
    assert.match(ready.contentType ?? "", /^application\/json/);
    // drifted: a shipped version recorded under another checksum
    const original = await oracle.query<{ checksum: string }>("SELECT checksum FROM kauro_meta.schema_migrations WHERE version = $1", [code]);
    await oracle.query("UPDATE kauro_meta.schema_migrations SET checksum = repeat('0', 64) WHERE version = $1", [code]);
    const drifted = await probe("/readyz");
    assert.equal(drifted.status, 503);
    conforms(READINESS_RESPONSE_SCHEMA, drifted.body);
    assert.deepEqual((drifted.body as ReadinessResponse).checks, { process: "SERVING", database: "AVAILABLE", schema: "DRIFTED" });
    assert.equal(notReady.at(-1)?.correlationId, drifted.correlationId, "the NOT_READY answer is logged under its correlation id");
    await oracle.query("UPDATE kauro_meta.schema_migrations SET checksum = $2 WHERE version = $1", [code, original.rows[0]?.checksum]);
    // behind: a shipped version not applied (migrations off on start: the process would serve an older schema)
    const removed = await oracle.query<{ name: string; checksum: string }>("DELETE FROM kauro_meta.schema_migrations WHERE version = $1 RETURNING name, checksum", [code]);
    const behind = await probe("/readyz");
    assert.equal(behind.status, 503);
    assert.deepEqual(behind.body, { status: "NOT_READY", checks: { process: "SERVING", database: "AVAILABLE", schema: "BEHIND" }, schemaVersion: { code, database: code - 1 } });
    await oracle.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [code, removed.rows[0]?.name, removed.rows[0]?.checksum]);
    // a newer expand migration of the next release: this release stays ready
    await oracle.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES ($1, 'next_release_expand', repeat('b', 64))", [code + 1]);
    const ahead = await probe("/readyz");
    assert.equal(ahead.status, 200);
    assert.deepEqual((ahead.body as ReadinessResponse).schemaVersion, { code, database: code + 1 });
    await oracle.query("DELETE FROM kauro_meta.schema_migrations WHERE version = $1", [code + 1]);

    // an idle pooled connection exists; then the database goes away
    const before = await createAgency(api, FOUNDER);
    assert.equal(before.status, 201);
    await before.arrayBuffer();
    await oracle.end();
    await cluster.stop();
    stopped = true;
    await within(poolEventSeen, 15_000, "the pool error sink after the outage");
    assert.equal(poolEvents[0]?.pool, API_APPLICATION_NAME);
    assert.match(poolEvents[0]?.errorClass ?? "", /^[A-Za-z]\w*$/);
    // a command now: 503 CAPACITY_UNAVAILABLE, its cause logged under the answer's correlation id
    const outage = await createAgency(api, farmToken(28));
    assert.equal(outage.status, 503);
    const outageProblem = (await outage.json()) as { code: string; correlationId: string; retryable: boolean };
    assert.deepEqual([outageProblem.code, outageProblem.retryable], ["CAPACITY_UNAVAILABLE", true]);
    assert.equal(outage.headers.get("x-correlation-id"), outageProblem.correlationId);
    assert.deepEqual(unavailable.map((u) => u.correlationId), [outageProblem.correlationId]);
    const cause = unavailable[0]?.cause;
    assert.ok(cause instanceof Error && !(cause instanceof DomainFailure), "the underlying cause, not the translated failure");
    assert.match(classifyError(cause).errorClass, /^[A-Za-z]\w*$/);
    // readiness names the outage; liveness does not depend on it
    const down = await probe("/readyz");
    assert.equal(down.status, 503);
    assert.deepEqual(down.body, { status: "NOT_READY", checks: { process: "SERVING", database: "UNAVAILABLE", schema: "NOT_CHECKED" }, schemaVersion: { code, database: null } });
    assert.equal(notReady.at(-1)?.correlationId, down.correlationId);
    assert.ok(notReady.at(-1)?.cause instanceof Error);
    assert.equal((await probe("/livez")).status, 200);
    // the default sinks write one line of safe tokens: the classification, never the message, a host or a credential
    const lines: string[] = [];
    const original2 = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      writeUnavailable(outageProblem.correlationId, unavailable[0]?.cause);
      writeNotReady(String(down.correlationId), down.body as ReadinessResponse, notReady.at(-1)?.cause);
    } finally {
      process.stderr.write = original2;
    }
    assert.match(lines[0] ?? "", new RegExp(`^kauro-api unavailable correlation=${outageProblem.correlationId} code=CAPACITY_UNAVAILABLE cause=[A-Za-z]\\w*( code=[0-9A-Z_]+)?\\n$`));
    assert.match(lines[1] ?? "", /^kauro-api not ready correlation=\S+ process=SERVING database=UNAVAILABLE schema=NOT_CHECKED cause=[A-Za-z]\w*( code=[0-9A-Z_]+)?\n$/);
    const everything = JSON.stringify({ poolEvents, lines, notReady: notReady.map((n) => n.response) });
    for (const secret of [RUNTIME_SECRET, ROLES.appLogin, String(cluster.port)]) assert.ok(!everything.includes(secret), `no ${secret} in the diagnostics`);
  } finally {
    await api.close();
    if (!stopped) {
      await oracle.end();
      await cluster.stop();
    }
  }
});

// The deployment path of the api process (14 "Deployment and rollback": the accepted artifact starts from explicit environment
// configuration and refuses to start when a required input is missing; 07 "Restoration and migration": migrations run as the
// owner role in their own connection, never through the runtime pool; 08 "Database isolation": the runtime pool refuses a
// privileged login before it serves a request; 07 "Connection budget": the pool ceiling is a required input; design §12c
// I-INT-1 and I-INT-3). bootstrap() is exercised on a real PostgreSQL 17 cluster over a real socket, the way main.ts runs it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MigratorRoleError, PrivilegedRoleError, listMigrations } from "@kauro/persistence";
import { ROLES, startTemporaryPostgres, type TemporaryPostgres } from "@kauro/persistence/testing";
import { BearerTokenFileError, ConfigError, authenticatorOf, bootstrap, loadConfig, parseBearerTokenFile } from "../src/index.js";

let pg: TemporaryPostgres;
let dir: string;
before(async () => {
  pg = await startTemporaryPostgres();
  dir = mkdtempSync(join(tmpdir(), "kauro-api-bootstrap-"));
});
after(async () => {
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
});

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

const VERIFIED = "2026-09-24T12:00:00.000Z";
const TOKEN = "local-founder-token-0123456789";

function tokenFile(): string {
  const path = join(dir, "bearer-tokens.json");
  writeFileSync(path, JSON.stringify({ subjects: [{ token: TOKEN, provider: "identity-platform", subject: "local-founder", emailVerifiedAt: VERIFIED, mfaEnrolledAt: VERIFIED, state: "ACTIVE" }] }));
  return path;
}

/** A complete LOCAL environment for the temporary cluster; `overrides` replaces or (with undefined) removes variables. */
function envOf(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    KAURO_ENVIRONMENT: "LOCAL",
    KAURO_DB_HOST: "127.0.0.1",
    KAURO_DB_PORT: String(pg.port),
    KAURO_DB_NAME: ROLES.database,
    KAURO_DB_USER: ROLES.appLogin,
    KAURO_DB_POOL_MAX: "2",
    KAURO_HTTP_HOST: "127.0.0.1",
    KAURO_HTTP_PORT: "3000",
    ...overrides,
  };
}

function configError(variable: string): (e: unknown) => boolean {
  return (e) => e instanceof ConfigError && e.message.startsWith(`${variable}:`);
}

/** Asserts that bootstrap refuses `env`. An api that starts anyway is closed before the assertion fails, so a regression is
 * reported as a failure of the test instead of an open server that keeps the test process from exiting. */
async function assertRefusedStart(env: Record<string, string | undefined>, refusal: (e: unknown) => boolean): Promise<void> {
  let started: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    await assert.rejects(
      bootstrap(env, { logger: false }).then((api) => {
        started = api;
        return api;
      }),
      refusal,
    );
  } finally {
    await started?.close();
  }
}

test("configuration: every variable is validated and a missing or malformed one refuses the start by name, never by value; the pool ceiling is a required input", () => {
  assert.throws(() => loadConfig({}), configError("KAURO_ENVIRONMENT"));
  assert.throws(() => loadConfig(envOf({ KAURO_ENVIRONMENT: "PRODUCTION" })), configError("KAURO_ENVIRONMENT"));
  assert.throws(() => loadConfig(envOf({ KAURO_DB_USER: undefined })), configError("KAURO_DB_USER"));
  assert.throws(() => loadConfig(envOf({ KAURO_DB_USER: "Robert'); DROP TABLE" })), (e: unknown) => configError("KAURO_DB_USER")(e) && !(e as Error).message.includes("DROP"));
  assert.throws(() => loadConfig(envOf({ KAURO_DB_POOL_MAX: undefined })), configError("KAURO_DB_POOL_MAX"), "07 connection budget: no library default");
  for (const bad of ["0", "5", "24", "25", "ten", "-1", "2.5"]) assert.throws(() => loadConfig(envOf({ KAURO_DB_POOL_MAX: bad })), configError("KAURO_DB_POOL_MAX"), bad);
  assert.throws(() => loadConfig(envOf({ KAURO_DB_PORT: "70000" })), configError("KAURO_DB_PORT"));
  assert.throws(() => loadConfig(envOf({ KAURO_DB_STATEMENT_TIMEOUT_MS: "5" })), configError("KAURO_DB_STATEMENT_TIMEOUT_MS"));
  assert.throws(() => loadConfig(envOf({ KAURO_DB_MIGRATE_ON_START: "yes" })), configError("KAURO_DB_MIGRATE_ON_START"));
  // migration roles are separate from runtime: migrating on start names its own role, never the runtime login
  assert.throws(() => loadConfig(envOf({ KAURO_DB_MIGRATE_ON_START: "true" })), configError("KAURO_DB_MIGRATOR_USER"));
  assert.throws(() => loadConfig(envOf({ KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.appLogin })), configError("KAURO_DB_MIGRATOR_USER"));
  // the LOCAL bearer-token file is refused outside LOCAL
  assert.throws(() => loadConfig(envOf({ KAURO_ENVIRONMENT: "SANDBOX", KAURO_AUTH_BEARER_TOKENS_FILE: "tokens.json" })), configError("KAURO_AUTH_BEARER_TOKENS_FILE"));
  // secrets never appear in a refusal
  assert.throws(() => loadConfig(envOf({ KAURO_DB_PASSWORD: "hunter2-secret", KAURO_DB_POOL_MAX: "99" })), (e: unknown) => configError("KAURO_DB_POOL_MAX")(e) && !(e as Error).message.includes("hunter2"));
  // a complete LOCAL environment with its defaults
  const config = loadConfig(envOf({ KAURO_DB_HOST: undefined, KAURO_DB_NAME: undefined, KAURO_HTTP_HOST: undefined, KAURO_HTTP_PORT: undefined }));
  assert.deepEqual(config, {
    environment: "LOCAL",
    http: { host: "127.0.0.1", port: 3000, trustedProxyHops: 0, requestTimeoutMs: 30_000, connectionTimeoutMs: 60_000, shutdownDeadlineMs: 8_000 },
    database: { host: "127.0.0.1", port: pg.port, database: "kauro", user: ROLES.appLogin, poolMax: 2, statementTimeoutMs: 10_000 },
    migrateOnStart: null,
    bearerTokensFile: null,
    cursorKeyFile: null,
  });
});

test("authentication of this edition: the LOCAL bearer-token file is a closed document; SANDBOX and LIVE refuse to start without the Identity Platform verifier (I-INT-3)", () => {
  const subjects = parseBearerTokenFile(JSON.stringify({ subjects: [{ token: TOKEN, provider: "identity-platform", subject: "local-founder", emailVerifiedAt: VERIFIED, mfaEnrolledAt: null, state: "ACTIVE" }] }));
  const subject = subjects.get(TOKEN);
  assert.ok(subject);
  assert.equal(subject.identity.mfaEnrolledAt, null);
  assert.match(subject.subjectHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(subject).includes("local-founder"), "the provider subject itself is never carried, only its digest and the derived id");
  const refused = (text: string, fragment: string) =>
    assert.throws(() => parseBearerTokenFile(text), (e: unknown) => e instanceof BearerTokenFileError && e.message.includes(fragment) && !e.message.includes(TOKEN), fragment);
  refused("{", "not valid JSON");
  refused(JSON.stringify({ subjects: [] }), "non-empty");
  refused(JSON.stringify({ subjects: [], extra: 1 }), "exactly one member");
  const entry = { token: TOKEN, provider: "identity-platform", subject: "s", emailVerifiedAt: VERIFIED, mfaEnrolledAt: VERIFIED, state: "ACTIVE" };
  refused(JSON.stringify({ subjects: [{ ...entry, verified: true }] }), "unknown member verified");
  refused(JSON.stringify({ subjects: [{ ...entry, emailVerifiedAt: "2026-02-30T00:00:00Z" }] }), "emailVerifiedAt");
  refused(JSON.stringify({ subjects: [entry, entry] }), "repeats an earlier token");
  refused(JSON.stringify({ subjects: [{ ...entry, token: "short" }] }), "16..512");
  for (const environment of ["SANDBOX", "LIVE"]) {
    // outside LOCAL the list cursors' key is a required shared secret (N16); with it, the missing verifier refuses the start
    assert.throws(() => loadConfig(envOf({ KAURO_ENVIRONMENT: environment, KAURO_HTTP_TRUSTED_PROXY_HOPS: "1" })), configError("KAURO_API_CURSOR_KEY_FILE"), environment);
    assert.throws(() => authenticatorOf(loadConfig(envOf({ KAURO_ENVIRONMENT: environment, KAURO_HTTP_TRUSTED_PROXY_HOPS: "1", KAURO_API_CURSOR_KEY_FILE: "cursor.key" }))), configError("KAURO_ENVIRONMENT"), environment);
  }
  assert.throws(() => authenticatorOf(loadConfig(envOf())), configError("KAURO_AUTH_BEARER_TOKENS_FILE"));
});

test("bootstrap on a real cluster: migrations on start as the owner (idempotent), the verified runtime pool, a real socket serving a command, and a clean close; privileged logins refuse the start", async () => {
  const port = await freePort();
  const api = await bootstrap(envOf({ KAURO_HTTP_PORT: String(port), KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.owner, KAURO_AUTH_BEARER_TOKENS_FILE: tokenFile() }), { logger: false });
  let closed = false;
  try {
    assert.equal(api.address, `http://127.0.0.1:${port}`);
    // every shipped migration was applied by the cluster helper: applying on start is idempotent and applies nothing new
    assert.deepEqual(api.database.migrations && { applied: api.database.migrations.applied.length, skipped: api.database.migrations.skipped.length }, { applied: 0, skipped: listMigrations().length });
    // one command over the network, through the composition root, into the database
    const res = await fetch(`${api.address}/api/v1/agencies`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "idempotency-key": "bootstrap-key-000001" },
      body: JSON.stringify({ displayName: "Bootstrapped Agency" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { kind: string; data: { agency: { agencyId: string; state: string } } };
    assert.equal(body.kind, "COMPLETED");
    assert.equal(body.data.agency.state, "DRAFT");
    const oracle = await pg.connect("postgres");
    try {
      const r = await oracle.query<{ n: string; app: string }>(
        "SELECT (SELECT count(*) FROM kauro.agencies WHERE agency_id = $1)::text AS n, (SELECT count(*) FROM pg_stat_activity WHERE application_name = 'kauro-api' AND usename = $2)::text AS app",
        [body.data.agency.agencyId, ROLES.appLogin],
      );
      assert.equal(r.rows[0]?.n, "1");
      assert.ok(Number(r.rows[0]?.app) >= 1, "the api's runtime connections announce themselves and log in as the runtime role");
    } finally {
      await oracle.end();
    }
    await api.close();
    closed = true;
    assert.equal(api.database.pool.raw.ended, true, "close() ends the pool");
    await assert.rejects(fetch(`${api.address}/api/v1/agencies`, { method: "POST" }), "the socket is closed");
  } finally {
    if (!closed) await api.close();
  }

  // a runtime login that is privileged (the object owner has CREATEROLE) or belongs to another runtime group refuses the start
  await assertRefusedStart(envOf({ KAURO_DB_USER: ROLES.owner, KAURO_HTTP_PORT: String(await freePort()), KAURO_AUTH_BEARER_TOKENS_FILE: tokenFile() }), (e: unknown) => e instanceof PrivilegedRoleError);
  await assertRefusedStart(envOf({ KAURO_DB_USER: ROLES.controlLogin, KAURO_HTTP_PORT: String(await freePort()), KAURO_AUTH_BEARER_TOKENS_FILE: tokenFile() }), (e: unknown) => e instanceof Error && e.message.includes("member of kauro_app"));
  // a superuser migrator is refused before it applies anything
  await assertRefusedStart(
    envOf({ KAURO_DB_MIGRATE_ON_START: "true", KAURO_DB_MIGRATOR_USER: ROLES.superuser, KAURO_HTTP_PORT: String(await freePort()), KAURO_AUTH_BEARER_TOKENS_FILE: tokenFile() }),
    (e: unknown) => e instanceof MigratorRoleError && e.message.includes("SUPERUSER"),
  );
});

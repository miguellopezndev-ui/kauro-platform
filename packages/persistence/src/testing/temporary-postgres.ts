/**
 * Real PostgreSQL 17 for tests (07 "Acceptance obligations": use real PostgreSQL for tenant constraints, transactions,
 * migrations and concurrency; fakes cannot prove RLS, unique constraints, lock behaviour or pool reset).
 *
 * startTemporaryPostgres() runs initdb into a fresh directory, starts the server on a free 127.0.0.1 port, creates the
 * database and the roles the platform expects, applies the migrations as the owner role, creates one login role per runtime
 * group (request handlers, control plane, step-up verifier, validator, provider ingress, payment service, commission service),
 * and returns connection factories. stop() shuts the server down and removes the directory. Binaries: env PGBIN first, then
 * C:\Tools\pgsql17\bin on Windows, /usr/lib/postgresql/17/bin on Linux.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type ClientConfig } from "pg";
import { applyMigrations, type ApplyResult } from "../migrations/runner.js";

export const ROLES = Object.freeze({
  owner: "kauro_owner",
  app: "kauro_app",
  control: "kauro_control",
  assurance: "kauro_assurance",
  validator: "kauro_validator",
  ingress: "kauro_ingress",
  payment: "kauro_payment",
  commission: "kauro_commission",
  appLogin: "kauro_app_test",
  controlLogin: "kauro_control_test",
  assuranceLogin: "kauro_assurance_test",
  validatorLogin: "kauro_validator_test",
  ingressLogin: "kauro_ingress_test",
  paymentLogin: "kauro_payment_test",
  commissionLogin: "kauro_commission_test",
  superuser: "postgres",
  database: "kauro",
});

export type LoginRole = "postgres" | "kauro_owner" | "kauro_app_test" | "kauro_control_test" | "kauro_assurance_test" | "kauro_validator_test" | "kauro_ingress_test" | "kauro_payment_test" | "kauro_commission_test";

export interface TemporaryPostgres {
  readonly port: number;
  readonly dataDir: string;
  readonly migrations: ApplyResult;
  /** Present when started with `tls: true`: the CA file to hand to KAURO_DB_TLS_CA_FILE and the host name the certificate names. */
  readonly tls?: { readonly caFile: string; readonly host: "localhost"; /** Every login of a TLS cluster has this password (scram-sha-256), and passwordFile holds it with a trailing newline. */ readonly password: string; readonly passwordFile: string };
  /** A connected client as the given role (LOGIN roles only). The caller ends it. */
  connect(role: LoginRole): Promise<Client>;
  /** The connection settings of a client as the given role, for a connection someone else opens (the fault harness's openConnection). */
  clientConfig(role: LoginRole): ClientConfig;
  stop(): Promise<void>;
}

function pgbin(): string {
  const fromEnv = process.env["PGBIN"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fallback = process.platform === "win32" ? "C:\\Tools\\pgsql17\\bin" : "/usr/lib/postgresql/17/bin";
  if (!existsSync(fallback)) throw new Error(`PostgreSQL 17 binaries not found: set PGBIN (looked at ${fromEnv ?? "(unset)"} and ${fallback})`);
  return fallback;
}

function exe(bin: string, name: string): string {
  return join(bin, process.platform === "win32" ? `${name}.exe` : name);
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

function run(cmd: string, args: string[], what: string, options: { readonly detached?: boolean; readonly logFile?: string } = {}): void {
  // pg_ctl start hands its stdio to the server it launches; with piped stdio spawnSync would wait for the server to exit.
  // The server writes to its own log file, so the launcher runs with ignored stdio and the log is read on failure.
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, stdio: options.detached ? "ignore" : "pipe", timeout: 120_000 });
  if (r.status !== 0) {
    let log = "";
    if (options.logFile && existsSync(options.logFile)) log = readFileSync(options.logFile, "utf8").slice(-2000);
    throw new Error(`${what} failed (exit ${r.status ?? "signal " + r.signal}): ${r.stdout ?? ""}\n${r.stderr ?? ""}\n${log}`);
  }
}

export interface StartOptions {
  /** Skip applying migrations (a test that exercises the runner itself). */
  readonly migrate?: boolean;
  /** Apply the migrations of this directory instead of the package's (a test of a migration on a cluster at the one before it). */
  readonly migrationsDir?: string;
  /**
   * Install the labelled TEST CLOCK (default true; see TEST_CLOCK_FUNCTION). false keeps the shipped kauro.server_now() exactly as
   * the migration defines it (the migrations test proves that body).
   */
  readonly testClock?: boolean;
  /** Where the server port comes from (default: a probed free 127.0.0.1 port). The harness's own test hands it a port in use. */
  readonly portSource?: () => Promise<number>;
  /**
   * Serve TLS (I-2): a CA and a server certificate for the host name `localhost` are generated with openssl into the cluster's
   * directory; the result names the CA file. The server refuses every connection without TLS (hostnossl reject), and the harness's
   * own connections are TLS and verified.
   */
  readonly tls?: boolean;
}

/** How many ports a start tries when the probed one was taken before the server bound it. */
const PORT_ATTEMPTS = 5;

/**
 * The transaction-local setting the test clock reads: seconds (a decimal, possibly negative) added to the transaction time. A
 * fixture sets it with set_config(TEST_CLOCK_OFFSET_SETTING, '<seconds>', true) inside its own transaction to stand in the past.
 */
export const TEST_CLOCK_OFFSET_SETTING = "kauro_test.clock_offset_seconds";

/**
 * The TEST CLOCK (B07 decision D-CLOCK-1): every B07 lifecycle guard reads kauro.server_now(), which a deployment defines as
 * transaction_timestamp() (migration 0009). Fixtures that need a past — a revision sealed fifteen days ago so a test may expire it,
 * an upload initiated twenty-five hours ago — must never back-date a row through a production role (the database refuses it,
 * B07-F2); instead the temporary cluster replaces the function, as the migration owner, by this body, which adds the
 * transaction-local offset above. Only this test-only subpath installs it (the architecture gate keeps @kauro/persistence/testing
 * out of production), and the function's comment labels it. Without the setting it is exactly the transaction time.
 */
export const TEST_CLOCK_FUNCTION = `CREATE OR REPLACE FUNCTION kauro.server_now() RETURNS timestamptz
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT transaction_timestamp() + make_interval(secs => coalesce(nullif(current_setting('${TEST_CLOCK_OFFSET_SETTING}', true), ''), '0')::double precision) $$`;

export const TEST_CLOCK_COMMENT = "TEST CLOCK installed by @kauro/persistence/testing: transaction_timestamp() plus the transaction-local kauro_test.clock_offset_seconds; never present in a deployment";

function openssl(args: string[], cwd: string): void {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${r.stdout ?? ""}${r.stderr ?? ""} (the tls option of the temporary cluster needs openssl on PATH)`);
}

/** A throw-away CA and a server certificate for DNS:localhost, the server's copies installed in the data directory. */
/** Every login of a TLS cluster is scram-authenticated with this password: a connection that drops its password setting fails (ADV-8). */
export const TLS_CLUSTER_PASSWORD = "kauro-tls-cluster-secret";

function generateTlsFiles(base: string, dataDir: string): NonNullable<TemporaryPostgres["tls"]> {
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=kauro-test-ca"], base);
  writeFileSync(join(base, "server.ext"), "subjectAltName=DNS:localhost" + "\n");
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"], base);
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "server.ext"], base);
  // a connection without TLS is refused by the server itself: a site that skips its TLS wiring cannot connect at all (ADV-1)
  const hba = join(dataDir, "pg_hba.conf");
  writeFileSync(hba, `hostnossl all all 127.0.0.1/32 reject\nhostnossl all all ::1/128 reject\n${readFileSync(hba, "utf8")}`);
  copyFileSync(join(base, "server.crt"), join(dataDir, "server.crt"));
  copyFileSync(join(base, "server.key"), join(dataDir, "server.key"));
  if (process.platform !== "win32") spawnSync("chmod", ["600", join(dataDir, "server.key")]);
  return { caFile: join(base, "ca.crt"), host: "localhost", password: TLS_CLUSTER_PASSWORD, passwordFile: join(base, "pw") };
}

export async function startTemporaryPostgres(options: StartOptions = {}): Promise<TemporaryPostgres> {
  // A cluster default reaches every runtime pool; transaction-local clock settings still override it.
  const offsetMs = Number(process.env["KAURO_TEST_CLOCK_OFFSET_MS"] ?? 0);
  if (!Number.isFinite(offsetMs)) throw new Error("KAURO_TEST_CLOCK_OFFSET_MS must be a finite number");
  const bin = pgbin();
  const base = mkdtempSync(join(tmpdir(), "kauro-pg-"));
  const dataDir = join(base, "data");
  // a TLS cluster authenticates every login with scram-sha-256 and one known password (initdb sets the superuser's from the file)
  if (options.tls === true) writeFileSync(join(base, "pw"), `${TLS_CLUSTER_PASSWORD}\n`);
  const auth = options.tls === true ? ["-A", "scram-sha-256", "--pwfile", join(base, "pw")] : ["-A", "trust"];
  run(exe(bin, "initdb"), ["-D", dataDir, "-U", ROLES.superuser, ...auth, "-E", "UTF8", "--no-locale"], "initdb");
  let tls: TemporaryPostgres["tls"];
  if (options.tls === true) tls = generateTlsFiles(base, dataDir);
  // The free port is probed, released and then bound by the server: another process can take it in between (ci-local 89f7b90,
  // "could not bind": Address already in use on Linux, "Only one usage of each socket address" on Windows). That bind failure,
  // and only that one, starts again on a newly probed port.
  const nextPort = options.portSource ?? freePort;
  let port = 0;
  for (let attempt = 1; ; attempt++) {
    port = await nextPort();
    const serverOptions = [`-p ${port}`, "-c listen_addresses=127.0.0.1", "-c fsync=off", "-c synchronous_commit=off", "-c full_page_writes=off", "-c max_connections=40"];
    if (tls !== undefined) serverOptions.push("-c ssl=on");
    if (options.testClock !== false && offsetMs !== 0) serverOptions.push(`-c ${TEST_CLOCK_OFFSET_SETTING}=${offsetMs / 1000}`);
    if (process.platform !== "win32") serverOptions.push(`-k ${base}`);
    const logFile = join(base, `postgres-${attempt}.log`);
    try {
      run(exe(bin, "pg_ctl"), ["-D", dataDir, "-l", logFile, "-o", serverOptions.join(" "), "-w", "-t", "60", "start"], "pg_ctl start", { detached: true, logFile });
      break;
    } catch (e) {
      const portTaken = existsSync(logFile) && /could not bind IPv4 address "127\.0\.0\.1"/.test(readFileSync(logFile, "utf8"));
      if (!portTaken || attempt >= PORT_ATTEMPTS) throw e;
    }
  }

  // a TLS cluster is dialled by its certificate's name and verified, like every deployment connection
  const verified = tls === undefined ? {} : { ssl: { ca: readFileSync(tls.caFile, "utf8"), rejectUnauthorized: true } };
  const pwd = tls === undefined ? "" : ` PASSWORD '${tls.password}'`;
  const clientConfig = (role: string, database: string = ROLES.database): ClientConfig => ({ host: tls === undefined ? "127.0.0.1" : tls.host, port, user: role, database, application_name: `kauro-test-${role}`, ...verified, ...(tls === undefined ? {} : { password: tls.password }) });
  const connect = async (role: string, database: string = ROLES.database): Promise<Client> => {
    const c = new Client(clientConfig(role, database));
    await c.connect();
    return c;
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    spawnSync(exe(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], { encoding: "utf8", windowsHide: true, stdio: "ignore", timeout: 60_000 });
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    const su = await connect(ROLES.superuser, "postgres");
    try {
      await su.query(`CREATE ROLE ${ROLES.owner} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB${pwd}`);
      await su.query(`CREATE DATABASE ${ROLES.database} OWNER ${ROLES.owner}`);
    } finally {
      await su.end();
    }
    let migrations: ApplyResult = { applied: [], skipped: [] };
    if (options.migrate !== false) {
      const owner = await connect(ROLES.owner);
      try {
        migrations = await applyMigrations(owner, options.migrationsDir === undefined ? {} : { dir: options.migrationsDir });
      } finally {
        await owner.end();
      }
      const su2 = await connect(ROLES.superuser, "postgres");
      try {
        await su2.query(`CREATE ROLE ${ROLES.appLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}${pwd}`);
        await su2.query(`CREATE ROLE ${ROLES.controlLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.control}${pwd}`);
        await su2.query(`CREATE ROLE ${ROLES.assuranceLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.assurance}${pwd}`);
        await su2.query(`CREATE ROLE ${ROLES.validatorLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.validator}${pwd}`);
        await su2.query(`CREATE ROLE ${ROLES.ingressLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.ingress}${pwd}`);
        await su2.query(`CREATE ROLE ${ROLES.paymentLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.payment}${pwd}`);
        await su2.query(`CREATE ROLE ${ROLES.commissionLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.commission}${pwd}`);
      } finally {
        await su2.end();
      }
      if (options.testClock !== false) {
        const owner = await connect(ROLES.owner);
        try {
          await owner.query(TEST_CLOCK_FUNCTION);
          await owner.query(`COMMENT ON FUNCTION kauro.server_now() IS '${TEST_CLOCK_COMMENT}'`);
        } finally {
          await owner.end();
        }
      }
    }
    return {
      port,
      dataDir,
      migrations,
      ...(tls === undefined ? {} : { tls }),
      connect: (role) => connect(role),
      clientConfig: (role) => clientConfig(role),
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

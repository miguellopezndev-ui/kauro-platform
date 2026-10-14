// The proxy under the real standalone server that `pnpm run build` produces (design D-TOPO-2, D-SEC-1, D-SEC-2): the server-only
// configuration module loads inside the proxy layer of the bundler, screen paths answer by the host they arrive on, and a deployment
// that names its hosts wrongly serves no screen and says why. The routing decisions themselves are proven exhaustively in
// host-routing.test.ts; this file proves they are wired into the process that runs. It needs the build, and fails, not skips, without it.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";

const server = join(import.meta.dirname, "..", "..", ".next", "standalone", "apps", "web", "server.js");
const PUBLIC_HOST = "www.kauro.example";
const APP_HOST = "app.kauro.example";
const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f01";

interface Running {
  readonly port: number;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function start(environment: Readonly<Record<string, string>>): Promise<Running> {
  assert.ok(existsSync(server), `no standalone server at ${server}: run pnpm run build first`);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port), HOSTNAME: "127.0.0.1" };
  for (const name of ["KAURO_ENV", "KAURO_PUBLIC_ORIGIN", "KAURO_APP_ORIGIN", "KAURO_UPLOAD_ORIGIN"]) delete env[name];
  const child: ChildProcess = spawn(process.execPath, [server], { env: { ...env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not report ready:\n${output}`)), 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code}:\n${output}`));
    });
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (/Ready in/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
  });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.removeAllListeners("exit");
      child.on("exit", () => resolve());
      child.kill();
    });
  try {
    await ready;
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, output: () => output, stop };
}

function get(running: Running, path: string, host: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: running.port, path, method: "GET", headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function header(answer: Answer, name: string): string {
  const value = answer.headers[name];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function assertPolicy(answer: Answer, label: string): void {
  assert.match(header(answer, "content-security-policy"), /script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/, `${label}: the per-request nonce policy`);
  assert.equal(header(answer, "x-content-type-options"), "nosniff", `${label}: static headers`);
  assert.equal(header(answer, "referrer-policy"), "no-referrer", `${label}: static headers`);
}

test("D-TOPO-2, D-SEC-2: on a split deployment a screen path on the wrong host, on the right host or on a stranger's host is a 404 that carries the policy, and probes answer on every host", async () => {
  const running = await start({ KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: `https://${PUBLIC_HOST}`, KAURO_APP_ORIGIN: `https://${APP_HOST}` });
  try {
    for (const host of [PUBLIC_HOST, APP_HOST, "elsewhere.example"]) {
      const probe = await get(running, "/livez", host);
      assert.equal(probe.status, 200, `livez on ${host}`);
      assert.equal(probe.body, "ok\n");
      assertPolicy(probe, `livez on ${host}`);
    }
    const hidden: ReadonlyArray<readonly [string, string]> = [
      ["/login", PUBLIC_HOST],
      ["/pricing", APP_HOST],
      [`/agencies/${AGENCY}/projects`, PUBLIC_HOST],
      ["/pricing", "elsewhere.example"],
      ["/agencies/a%20b/projects", APP_HOST],
      ["/%E0%A4%A", APP_HOST],
    ];
    for (const [path, host] of hidden) {
      const answer = await get(running, path, host);
      assert.equal(answer.status, 404, `${path} on ${host}`);
      assert.match(header(answer, "cache-control"), /no-store/, `${path} on ${host}`);
      assert.match(header(answer, "content-type"), /^text\/html/, `${path} on ${host}`);
      assert.match(answer.body, /Page not found/, `${path} on ${host}: the application's own not-found document`);
      assertPolicy(answer, `${path} on ${host}`);
    }
    assert.doesNotMatch(running.output(), /KAURO_HOST_CONFIG_INVALID/, "a valid deployment says nothing");
  } finally {
    await running.stop();
  }
});

test("D-TOPO-2, D-SEC-2: a deployment that names its hosts wrongly serves no screen (503 with the policy, no page) and logs why once, yet still answers its probe and its missing paths", async () => {
  const running = await start({ KAURO_ENV: "PRODUCTION" });
  try {
    for (const path of ["/login", "/pricing", `/agencies/${AGENCY}/projects`]) {
      const answer = await get(running, path, PUBLIC_HOST);
      assert.equal(answer.status, 503, path);
      assert.match(header(answer, "content-type"), /^text\/plain/, path);
      assert.match(header(answer, "cache-control"), /no-store/, path);
      assert.equal(answer.body, "Service unavailable\n", path);
      assertPolicy(answer, path);
    }
    assert.equal((await get(running, "/livez", PUBLIC_HOST)).status, 200);
    assert.equal((await get(running, "/no-such-page", PUBLIC_HOST)).status, 404);
    assert.equal(running.output().split("KAURO_HOST_CONFIG_INVALID ORIGINS_MISSING").length - 1, 1, "logged once per process, the problem name only");
  } finally {
    await running.stop();
  }
});

test("D-TOPO-2: the local stack names no host and any host reaches every group", async () => {
  const running = await start({ KAURO_ENV: "LOCAL" });
  try {
    for (const host of [PUBLIC_HOST, APP_HOST, "localhost:44300"]) {
      assert.equal((await get(running, "/livez", host)).status, 200);
      const answer = await get(running, "/login", host);
      assert.notEqual(answer.status, 503, `/login on ${host}: the local stack is configured`);
      assertPolicy(answer, `/login on ${host}`);
    }
    assert.doesNotMatch(running.output(), /KAURO_HOST_CONFIG_INVALID/);
  } finally {
    await running.stop();
  }
});

test("D-SCR-3: the running server's connect-src gains exactly the configured upload origin, and a missing or malformed value gains nothing", async () => {
  const connect = (answer: Answer): string => (header(answer, "content-security-policy").split("; ").find((part) => part.startsWith("connect-src ")) ?? "");
  const hosts = { KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: `https://${PUBLIC_HOST}`, KAURO_APP_ORIGIN: `https://${APP_HOST}` };
  const configured = await start({ ...hosts, KAURO_UPLOAD_ORIGIN: "https://uploads.example.test" });
  try {
    assert.equal(connect(await get(configured, "/livez", APP_HOST)), "connect-src 'self' https://uploads.example.test");
  } finally {
    await configured.stop();
  }
  for (const value of [undefined, "https://*.example.test", "https://uploads.example.test/path"]) {
    const running = await start({ ...hosts, ...(value === undefined ? {} : { KAURO_UPLOAD_ORIGIN: value }) });
    try {
      assert.equal(connect(await get(running, "/livez", APP_HOST)), "connect-src 'self'", String(value));
    } finally {
      await running.stop();
    }
  }
});

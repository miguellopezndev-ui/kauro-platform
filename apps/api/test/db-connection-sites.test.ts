// I-2 / I-3: no composition root can open a PostgreSQL connection outside LOCAL without verified TLS. The structural scan lists
// every site that builds a pool or a client in apps/ and packages/*/src; each non-persistence site must call connectionSecurityOf
// (the one rule), and the persistence sites must derive ssl only from sslOptionsOf (rejectUnauthorized: true).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConnectionSecurityError } from "@kauro/persistence";
import { openCommissionPools, openPaymentPools } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const SITE = /\bnew Pool\(|\bcreatePool\(|\bnew Client\(|\bconnectionString\b|\bapplyMigrationsAs\(/;

test("every connection site of apps/ and packages/*/src is known, and each composition root applies connectionSecurityOf", () => {
  const dirs = [join(root, "apps"), ...readdirSync(join(root, "packages")).map((p) => join(root, "packages", p, "src"))];
  const files = dirs.flatMap((d) => {
    try {
      return sources(d);
    } catch {
      return [];
    }
  });
  const found = new Map<string, string>();
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel.startsWith("packages/persistence/src/testing/")) continue; // the test-only subpath (the architecture gate keeps it out of production)
    const text = readFileSync(file, "utf8");
    if (SITE.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))) found.set(rel, text);
  }
  assert.deepEqual(
    [...found.keys()].sort(),
    [
      "apps/api/src/commissions/assembly.ts",
      "apps/api/src/composition.ts",
      "apps/api/src/payments/assembly.ts",
      "apps/control/src/audit/receipts.ts",
      "apps/control/src/composition.ts",
      "packages/persistence/src/migrations/runner.ts",
      "packages/persistence/src/pool.ts",
    ],
    "a new connection site must be listed here and covered by connectionSecurityOf",
  );
  for (const [rel, text] of found) {
    if (rel.startsWith("packages/persistence/src/")) {
      assert.ok(text.includes("sslOptionsOf("), `${rel} derives ssl from sslOptionsOf`);
    } else {
      assert.ok(text.includes("connectionSecurityOf("), `${rel} applies connectionSecurityOf before it connects`);
    }
  }
  for (const file of files) {
    assert.ok(!/rejectUnauthorized\s*:\s*false/.test(readFileSync(file, "utf8")), `${relative(root, file)}: rejectUnauthorized false`);
  }
});

const login = { host: "db.example.test", port: 1, database: "kauro", user: "u", poolMax: 1 };
const secure = { ...login, tlsCaFile: "ca.pem" };
const deps = (environment: "SANDBOX" | "LIVE") => ({ clock: { now: () => 0 } as never, random: (() => new Uint8Array(1)) as never, environment });
const refused = (variable: string) => (e: unknown) => e instanceof ConnectionSecurityError && e.message.startsWith(`${variable}:`);

test("the commission and payment roots refuse SANDBOX and LIVE without a CA, with a plain password or with an IP host", async () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    const ok = { commission: login, control: login };
    await assert.rejects(openCommissionPools(ok, deps(environment)), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openCommissionPools({ commission: { ...secure, password: "x" }, control: secure }, deps(environment)), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openCommissionPools({ commission: { ...secure, host: "10.0.0.1" }, control: secure }, deps(environment)), refused("KAURO_DB_HOST"));
    const pay = { payment: login, control: login, ingress: login };
    await assert.rejects(openPaymentPools({} as never, pay, deps(environment)), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openPaymentPools({} as never, { payment: { ...secure, password: "x" }, control: secure, ingress: secure }, deps(environment)), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openPaymentPools({} as never, { payment: { ...secure, host: "10.0.0.1" }, control: secure, ingress: secure }, deps(environment)), refused("KAURO_DB_HOST"));
  }
});

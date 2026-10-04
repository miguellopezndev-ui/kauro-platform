// D-TOPO-2: which host serves which group, decided by the first path segment, with the strict route map behind it. The oracle is the
// design's sentence ("answers 404 for the other group's paths by host") applied to every screen of the registry, not a table copied from
// the code, plus the fail-closed cases the framework's looser dynamic segments would otherwise let through.
import assert from "node:assert/strict";
import { test } from "node:test";
import { screens as registryScreens } from "@kauro/contracts";
import { parametersOf, pathOf, SCREENS } from "../src/screens.ts";
import { type HostConfig, type HostEnvironment, parseHostPolicy } from "../src/server/host-config.ts";
import { decideRoute, groupOfHost, groupOfRoot, rootsOf } from "../src/server/host-routing.ts";

interface RegistryRow {
  readonly id: string;
  readonly origin: string;
  readonly route: string;
}

const registry = registryScreens() as unknown as readonly RegistryRow[];
const served = registry.filter((row) => row.origin === "PUBLIC" || row.origin === "APP");
const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f01";
const PUBLIC_HOST = "www.kauro.example";
const APP_HOST = "app.kauro.example";
const SPLIT: HostConfig = { ok: true, policy: { kind: "SPLIT", publicHost: PUBLIC_HOST, appHost: APP_HOST } };
const LOCAL: HostConfig = { ok: true, policy: { kind: "LOCAL" } };
const BROKEN: HostConfig = { ok: false, problem: "ORIGINS_MISSING" };

function concretePath(id: string): string {
  const screen = SCREENS.find((row) => row.id === id);
  assert.ok(screen, id);
  return pathOf(id, Object.fromEntries(parametersOf(screen.route).map((name) => [name, name === "agencyId" ? AGENCY : "abc123"])));
}

test("D-TOPO-2: the two groups own disjoint first segments, and every registry screen's first segment belongs to the group its registry row names", () => {
  const publicRoots = rootsOf("PUBLIC");
  const appRoots = rootsOf("APP");
  assert.ok(publicRoots.length > 0 && appRoots.length > 0);
  assert.deepEqual(publicRoots.filter((root) => appRoots.includes(root)), [], "no first segment is in both groups");
  for (const row of served) {
    const first = concretePath(row.id).slice(1).split("/")[0] ?? "";
    assert.equal(groupOfRoot(first), row.origin, `${row.id} ${first}`);
  }
  assert.equal(groupOfRoot("livez"), null);
  assert.equal(groupOfRoot("_next"), null);
  assert.equal(groupOfRoot("%E0%A4%A"), "MALFORMED");
  assert.equal(groupOfRoot("%6Cogin"), "APP", "the framework decodes before it routes, so the group is decided after decoding");
});

test("D-TOPO-2: on a split deployment every screen answers on its own host and is a 404 on the other, for every screen of the registry", () => {
  for (const row of served) {
    const path = concretePath(row.id);
    const own = row.origin === "PUBLIC" ? PUBLIC_HOST : APP_HOST;
    const other = row.origin === "PUBLIC" ? APP_HOST : PUBLIC_HOST;
    assert.equal(decideRoute(SPLIT, own, path), "PASS", `${row.id} on ${own}`);
    assert.equal(decideRoute(SPLIT, other, path), "NOT_FOUND", `${row.id} on ${other}`);
    assert.equal(decideRoute(SPLIT, "elsewhere.example", path), "NOT_FOUND", `${row.id} on a host that serves neither`);
    assert.equal(decideRoute(SPLIT, null, path), "NOT_FOUND", `${row.id} without a host`);
  }
});

test("D-TOPO-2: hosts are compared exactly, lower-cased and with their port", () => {
  const withPort: HostConfig = { ok: true, policy: { kind: "SPLIT", publicHost: "localhost:8443", appHost: "app.localhost:8443" } };
  assert.equal(decideRoute(SPLIT, "APP.Kauro.Example", "/login"), "PASS");
  assert.equal(decideRoute(SPLIT, "app.kauro.example.", "/login"), "NOT_FOUND", "a trailing dot is another name");
  assert.equal(decideRoute(SPLIT, "app.kauro.example:8443", "/login"), "NOT_FOUND", "a port is part of the host");
  assert.equal(decideRoute(SPLIT, "evil.example", "/login"), "NOT_FOUND");
  assert.equal(decideRoute(withPort, "localhost:8443", "/pricing"), "PASS");
  assert.equal(decideRoute(withPort, "localhost", "/pricing"), "NOT_FOUND");
  assert.equal(groupOfHost({ kind: "SPLIT", publicHost: PUBLIC_HOST, appHost: APP_HOST }, PUBLIC_HOST), "PUBLIC");
  assert.equal(groupOfHost({ kind: "SPLIT", publicHost: PUBLIC_HOST, appHost: APP_HOST }, APP_HOST), "APP");
  assert.equal(groupOfHost({ kind: "LOCAL" }, APP_HOST), null, "the local policy has no host groups");
});

test("D-TOPO-2: probes, assets and paths under no screen's first segment pass on every host and every configuration; the framework answers them", () => {
  const passing = ["/livez", "/robots.txt", "/favicon.ico", "/_next/image", "/_next/data/x.json", "/no-such-page", "/pricing.json", "/Login", "/api/v1/agencies", "/login%2Fx"];
  for (const config of [SPLIT, LOCAL, BROKEN]) {
    for (const host of [PUBLIC_HOST, APP_HOST, "elsewhere.example", null]) {
      for (const path of passing) assert.equal(decideRoute(config, host, path), "PASS", `${path} on ${host ?? "no host"}`);
    }
  }
});

test("D-TOPO-2: a path under a screen's first segment that no screen owns is a 404 on every host and every configuration, never handed to a page", () => {
  const notOwned = [
    "/pricing/",
    "/pricing/x",
    "/legal",
    "/legal/terms/",
    "//login",
    "//",
    "/%6Cogin",
    "/%70ricing",
    "/agencies/",
    "/agencies//projects",
    `/agencies/${AGENCY}/zzz`,
    `/agencies/${AGENCY}/projects/`,
    "/agencies/a%20b/projects",
    "/agencies/a.b/projects",
    "/agencies/../login",
    "/unsubscribe",
    "/unsubscribe/a/b",
    "/%E0%A4%A",
    "",
    "login",
  ];
  for (const config of [SPLIT, LOCAL, BROKEN]) {
    for (const host of [PUBLIC_HOST, APP_HOST]) {
      for (const path of notOwned) assert.equal(decideRoute(config, host, path), "NOT_FOUND", `${JSON.stringify(path)} on ${host}`);
    }
  }
});

test("D-TOPO-2: the local policy serves both groups on any host, and a misconfigured deployment serves neither group but still answers probes", () => {
  const sample = ["UI01", "UI04", "UI50", "UI11", "UI24"];
  for (const host of [PUBLIC_HOST, APP_HOST, "localhost:44300", null]) {
    for (const id of sample) assert.equal(decideRoute(LOCAL, host, concretePath(id)), "PASS", `${id} on ${host ?? "no host"}`);
  }
  for (const id of sample) assert.equal(decideRoute(BROKEN, PUBLIC_HOST, concretePath(id)), "UNAVAILABLE", id);
  assert.equal(decideRoute(BROKEN, PUBLIC_HOST, "/livez"), "PASS");
});

const env = (values: Partial<HostEnvironment>): HostEnvironment => ({ KAURO_ENV: undefined, KAURO_PUBLIC_ORIGIN: undefined, KAURO_APP_ORIGIN: undefined, ...values });

test("D-TOPO-2, D-SEC-2: the hosts are read from two https origins that differ; only the local stack may name none, and anything else serves nothing", () => {
  const table: Array<[string, HostEnvironment, HostConfig]> = [
    ["two origins", env({ KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "https://www.kauro.example", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: true, policy: { kind: "SPLIT", publicHost: "www.kauro.example", appHost: "app.kauro.example" } }],
    ["a port is kept", env({ KAURO_PUBLIC_ORIGIN: "https://www.kauro.example:8443", KAURO_APP_ORIGIN: "https://app.kauro.example:8443" }), { ok: true, policy: { kind: "SPLIT", publicHost: "www.kauro.example:8443", appHost: "app.kauro.example:8443" } }],
    ["local with none", env({ KAURO_ENV: "LOCAL" }), LOCAL],
    ["local with empty strings", env({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "", KAURO_APP_ORIGIN: "" }), LOCAL],
    ["local may split on plain http", env({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "http://localhost:3000", KAURO_APP_ORIGIN: "http://app.localhost:3000" }), { ok: true, policy: { kind: "SPLIT", publicHost: "localhost:3000", appHost: "app.localhost:3000" } }],
    ["none outside local", env({ KAURO_ENV: "PRODUCTION" }), { ok: false, problem: "ORIGINS_MISSING" }],
    ["none and no environment", env({}), { ok: false, problem: "ORIGINS_MISSING" }],
    ["only the public origin", env({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "https://www.kauro.example" }), { ok: false, problem: "ONE_ORIGIN_ONLY" }],
    ["only the app origin", env({ KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ONE_ORIGIN_ONLY" }],
    ["plain http outside local", env({ KAURO_ENV: "PRODUCTION", KAURO_PUBLIC_ORIGIN: "http://www.kauro.example", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ORIGIN_INVALID" }],
    ["a path on an origin", env({ KAURO_PUBLIC_ORIGIN: "https://www.kauro.example/x", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ORIGIN_INVALID" }],
    ["a trailing slash", env({ KAURO_PUBLIC_ORIGIN: "https://www.kauro.example/", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ORIGIN_INVALID" }],
    ["a name that is not an origin", env({ KAURO_PUBLIC_ORIGIN: "www.kauro.example", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ORIGIN_INVALID" }],
    ["another scheme", env({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: "ftp://www.kauro.example", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ORIGIN_INVALID" }],
    ["upper case is not the origin the parser prints", env({ KAURO_PUBLIC_ORIGIN: "https://WWW.kauro.example", KAURO_APP_ORIGIN: "https://app.kauro.example" }), { ok: false, problem: "ORIGIN_INVALID" }],
    ["the same origin twice", env({ KAURO_PUBLIC_ORIGIN: "https://kauro.example", KAURO_APP_ORIGIN: "https://kauro.example" }), { ok: false, problem: "ORIGINS_NOT_DISTINCT" }],
  ];
  for (const [label, input, expected] of table) assert.deepEqual(parseHostPolicy(input), expected, label);
});

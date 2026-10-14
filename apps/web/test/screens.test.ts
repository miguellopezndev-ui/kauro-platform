// D-ROUTE-1 / D-TOPO-2: every PUBLIC and APP screen of the registry's screens.json has exactly one route, tenant screens live under
// /agencies/{agencyId}, OPS screens live under /ops (D-SCR-1), and the return path after sign-in is an allowlist of this application's own APP
// and OPS routes.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { screens as registryScreens } from "@kauro/contracts";
import { AGENCY_NAVIGATION, IMPLEMENTED_SCREENS, matchRoute, navigationFor, originOfPath, parametersOf, pathOf, safeReturnPath, SCREENS, screenById, signInHref } from "../src/screens.ts";

interface RegistryRow {
  readonly id: string;
  readonly origin: string;
  readonly route: string;
}

const registry = registryScreens() as unknown as readonly RegistryRow[];
const served = registry.filter((row) => row.origin === "PUBLIC" || row.origin === "APP");
const AGENCY = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f01";
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The design's rule, written from D-ROUTE-1's sentence and not from the table under test. */
const AGENCY_LESS = new Set(["UI09", "UI10", "UI50", "UI51"]);
function expectedRoute(row: RegistryRow): string {
  if (row.origin === "PUBLIC" || AGENCY_LESS.has(row.id)) return row.route;
  if (row.id === "UI24") return "/agencies/{agencyId}/payments/{orderId}";
  return `/agencies/{agencyId}${row.route}`;
}

test("D-ROUTE-1, D-SCR-1: every screen of the registry is mapped to exactly one route, the 15 OPS screens under /ops plus their registry route", () => {
  assert.equal(registry.length, 55, "the registry has 55 screen rows");
  assert.equal(served.length, 40, "13 public and 27 app screens");
  const ops = registry.filter((row) => row.origin === "OPS");
  assert.equal(ops.length, 15, "the 15 OPS screens of the private origin");
  assert.deepEqual([...SCREENS.map((screen) => screen.id)].sort(), registry.map((row) => row.id).sort());
  for (const row of ops) {
    const screen = SCREENS.find((candidate) => candidate.id === row.id);
    assert.equal(screen?.origin, "OPS", row.id);
    assert.equal(screen?.route, row.route === "/" ? "/ops" : "/ops" + row.route, row.id + " route");
    assert.equal(screen?.tenant, false, row.id + " is never a tenant screen");
    assert.equal(screen?.anonymous, false, row.id + " is never drawn without a session");
  }
  assert.equal(new Set(SCREENS.map((screen) => screen.id)).size, SCREENS.length, "one row per screen");
  for (const row of served) {
    const mapped = SCREENS.filter((screen) => screen.id === row.id);
    assert.equal(mapped.length, 1, row.id);
    assert.equal(mapped[0]?.origin, row.origin, `${row.id} origin`);
  }
});

test("D-ROUTE-1: tenant screens live under /agencies/{agencyId} plus the registry route; UI09, UI10, UI50 and UI51 keep their own; UI24 names its order", () => {
  for (const row of served) assert.equal(SCREENS.find((screen) => screen.id === row.id)?.route, expectedRoute(row), row.id);
  const byId = (id: string) => SCREENS.find((screen) => screen.id === id)?.route;
  assert.equal(byId("UI13"), "/agencies/{agencyId}/projects/{id}");
  assert.equal(byId("UI10"), "/agencies");
  assert.equal(byId("UI09"), "/onboarding");
  assert.equal(byId("UI50"), "/login");
  assert.equal(byId("UI51"), "/invitations/{id}");
  assert.equal(byId("UI24"), "/agencies/{agencyId}/payments/{orderId}");
  for (const screen of SCREENS) {
    assert.equal(screen.tenant, screen.route.startsWith("/agencies/{agencyId}/"), `${screen.id}: tenant means under an agency`);
    assert.equal(parametersOf(screen.route)[0] === "agencyId", screen.tenant, `${screen.id}: agencyId is the first parameter of tenant screens and of no other`);
    assert.ok(screen.tenant === (screen.origin === "APP" && !AGENCY_LESS.has(screen.id) && screen.id !== "UI10"), `${screen.id}: every APP screen but the agency-less four is a tenant screen`);
  }
});

test("D-ROUTE-1: no two routes can match the same path, and every route is a strict URL-safe pattern", () => {
  const patterns = SCREENS.map((screen) => ({ id: screen.id, segments: screen.route === "/" ? [""] : screen.route.slice(1).split("/") }));
  for (const [index, a] of patterns.entries()) {
    for (const b of patterns.slice(index + 1)) {
      if (a.segments.length !== b.segments.length) continue;
      const overlap = a.segments.every((segment, position) => segment === b.segments[position] || segment.startsWith("{") || (b.segments[position] ?? "").startsWith("{"));
      assert.equal(overlap, false, `${a.id} and ${b.id} overlap`);
    }
  }
  for (const screen of SCREENS) {
    assert.match(screen.route, /^\/([A-Za-z0-9-]+|\{[A-Za-z][A-Za-z0-9]*\})?(\/([A-Za-z0-9-]+|\{[A-Za-z][A-Za-z0-9]*\}))*$/, screen.id);
    assert.equal(new Set(parametersOf(screen.route)).size, parametersOf(screen.route).length, `${screen.id}: parameter names are distinct`);
  }
});

test("D-ROUTE-1: a concrete path is matched to its one screen with its parameters, and only when it is strictly well formed", () => {
  const project = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f02";
  assert.deepEqual(matchRoute(`/agencies/${AGENCY}/projects/${project}/plan/approval`), { screen: SCREENS.find((s) => s.id === "UI22"), params: { agencyId: AGENCY, id: project } });
  assert.equal(matchRoute("/")?.screen.id, "UI01");
  assert.equal(matchRoute("/agencies")?.screen.id, "UI10");
  assert.equal(matchRoute(`/agencies/${AGENCY}/projects`)?.screen.id, "UI11");
  assert.equal(matchRoute(`/agencies/${AGENCY}/payments/ord_1`)?.screen.id, "UI24");
  assert.equal(matchRoute("/unsubscribe/abc-DEF_123")?.screen.id, "UI49");
  for (const bad of ["", "agencies", "/agencies/", `/agencies/${AGENCY}/projects/`, `/agencies/${AGENCY}//projects`, `/agencies/${AGENCY}/projects/..`, `/agencies/${AGENCY}/projects/%2e%2e`, `/agencies/${AGENCY}/projects/a b`, "/agencies/a/b/c/d/e/f", "/sales/prospects", "/finance", "/operations/jobs", "/owner/actions", "/ops/", "/ops/finance/", "/ops/ops", "/ops/sales/agencies/a.b", "/login/", "/Login", "/agencies/\u0000"]) {
    assert.equal(matchRoute(bad), null, JSON.stringify(bad));
  }
  assert.equal(matchRoute(`/agencies/${"a".repeat(129)}/projects`), null, "a segment is at most 128 characters");
  assert.equal(originOfPath("/pricing"), "PUBLIC");
  assert.equal(originOfPath(`/agencies/${AGENCY}/projects`), "APP");
  assert.equal(originOfPath("/login"), "APP");
  assert.equal(originOfPath("/livez"), null, "a system path belongs to no group");
  assert.equal(originOfPath("/sales/prospects"), null, "a registry route of the private origin is nobody's without its /ops prefix");
  assert.equal(originOfPath("/ops/finance"), "OPS");
  assert.equal(originOfPath("/ops"), "OPS");
});

test("D-ROUTE-1: a path is built from exactly its parameters, each one URL-safe, and round-trips through the matcher", () => {
  for (const screen of SCREENS) {
    const values = Object.fromEntries(parametersOf(screen.route).map((name) => [name, name === "agencyId" ? AGENCY : `${name}-1`]));
    const path = pathOf(screen.id, values);
    assert.equal(matchRoute(path)?.screen.id, screen.id, `${screen.id} ${path}`);
    assert.deepEqual(matchRoute(path)?.params, values, screen.id);
  }
  assert.throws(() => pathOf("UI11"), RangeError, "a missing agency");
  assert.throws(() => pathOf("UI11", { agencyId: AGENCY, extra: "x" }), RangeError, "an extra value");
  assert.throws(() => pathOf("UI11", { agencyId: "../x" }), RangeError, "a dot segment");
  assert.throws(() => pathOf("UI11", { agencyId: "a/b" }), RangeError, "a separator");
  assert.throws(() => pathOf("UI11", { agencyId: "" }), RangeError);
  assert.throws(() => pathOf("UI99"), RangeError, "an unknown screen");
  assert.equal(pathOf("UI01"), "/");
  assert.equal(pathOf("UI10"), "/agencies");
});

test("D-ROUTE-1: the return path after sign-in is a plain path of an APP or OPS screen of this application and nothing else", () => {
  const good = ["/ops", "/ops/finance", `/agencies/${AGENCY}/projects`, `/agencies/${AGENCY}/projects/p-1/plan/approval`, "/agencies", "/onboarding", "/invitations/inv-1", `/agencies/${AGENCY}/payments/o-1`];
  for (const path of good) assert.equal(safeReturnPath(path), path, path);
  const bad: readonly unknown[] = [
    "https://elsewhere.test/agencies",
    "//elsewhere.test/agencies",
    "/\\elsewhere.test",
    "\\agencies",
    "javascript:alert(1)",
    "/login",
    "/logout",
    "/",
    "/pricing",
    "/agencies/",
    `/agencies/${AGENCY}/projects?x=1`,
    `/agencies/${AGENCY}/projects#frag`,
    `/agencies/${AGENCY}/projects/../../login`,
    `/agencies/${AGENCY}/projects/%2e%2e/x`,
    `/agencies/${AGENCY}//projects`,
    "/agencies/\r\nSet-Cookie: x=1",
    "/agencies/%0d%0a",
    "/sales/prospects",
    "/finance",
    `/${"a".repeat(600)}`,
    "",
    null,
    undefined,
    42,
    { toString: () => "/agencies" },
    ["/agencies"],
  ];
  for (const candidate of bad) assert.equal(safeReturnPath(candidate), null, JSON.stringify(candidate));
  assert.equal(signInHref(`/agencies/${AGENCY}/projects`), `/login?return=${encodeURIComponent(`/agencies/${AGENCY}/projects`)}`);
  assert.equal(signInHref("/login"), "/login");
  assert.equal(signInHref("/pricing"), "/login");
  assert.equal(signInHref("https://elsewhere.test/"), "/login");
});

test("D-ROUTE-1: navigation offers only agency-level screens that exist, in reference order, and each link resolves to a page file", () => {
  assert.deepEqual(AGENCY_NAVIGATION.map((entry) => entry.screen), ["UI11", "UI12", "UI31", "UI30", "UI32", "UI52"]);
  for (const entry of AGENCY_NAVIGATION) {
    const screen = SCREENS.find((candidate) => candidate.id === entry.screen);
    assert.ok(screen?.tenant === true && parametersOf(screen.route).length === 1, `${entry.screen} is an agency-level screen with no other parameter`);
  }
  assert.deepEqual(navigationFor(AGENCY, new Set()), [], "no page, no entry");
  assert.deepEqual(navigationFor(AGENCY, new Set(["UI12", "UI11", "UI13"])).map((entry) => entry.screen), ["UI11", "UI12"], "order is the shell's, and a screen with a parameter is never an entry");
  assert.deepEqual(navigationFor(AGENCY, new Set(["UI11"])), [{ screen: "UI11", label: "nav.projects.label", href: `/agencies/${AGENCY}/projects` }]);
  for (const id of IMPLEMENTED_SCREENS) assert.ok(SCREENS.some((screen) => screen.id === id), `${id} is a screen`);

  // pages on disk and implemented screens are the same set
  const pages: string[] = [];
  const walk = (directory: string, group: string, prefix: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, group, `${prefix}/${entry.name.replace(/^\[(.+)\]$/, "{$1}")}`);
      // a page, or a route handler that answers a whole document (the legal documents, D-LEGAL-1)
      else if (entry.name === "page.tsx" || entry.name === "route.ts") pages.push(`${group}:${prefix === "" ? "/" : prefix}`);
    }
  };
  walk(join(webRoot, "src", "app", "(public)"), "PUBLIC", "");
  walk(join(webRoot, "src", "app", "(app)"), "APP", "");
  walk(join(webRoot, "src", "app", "(ops)"), "OPS", "");
  const implementedRoutes = [...IMPLEMENTED_SCREENS].map((id) => {
    const screen = SCREENS.find((candidate) => candidate.id === id);
    return `${screen?.origin}:${screen?.route}`;
  });
  assert.deepEqual(pages.sort(), implementedRoutes.sort(), "an implemented screen has its page in its group, and a page is an implemented screen");
});

test("D-PRIV-1: a screen is drawn without a session only when it is public, the sign-in or the invitation; every tenant screen and the agency screens need one", () => {
  const anonymousApp = SCREENS.filter((screen) => screen.origin === "APP" && screen.anonymous).map((screen) => screen.id);
  assert.deepEqual(anonymousApp, ["UI50", "UI51"]);
  for (const screen of SCREENS) {
    if (screen.origin === "PUBLIC") assert.equal(screen.anonymous, true, `${screen.id} is public`);
    if (screen.tenant) assert.equal(screen.anonymous, false, `${screen.id} is a tenant screen`);
  }
  for (const id of ["UI09", "UI10"]) assert.equal(screenById(id).anonymous, false, id);
});

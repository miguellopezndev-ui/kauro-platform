// The owner's private-screen review (Order 11) covers every private screen of the registry, each once, in one of the five review groups,
// and the review project stays outside the product: the web's sources never refer to it (apps/web/test/review-isolation.test.ts holds the
// build side), and the review is only ever served by the local review edge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const registry = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "screens.json"), "utf8"));
const groups = JSON.parse(readFileSync(join(root, "tools", "review", "private", "lib", "groups.json"), "utf8"));

test("the review's five groups hold exactly the registry's private screens, each once", () => {
  const privateIds = registry.filter((screen) => screen.origin !== "PUBLIC").map((screen) => screen.id).sort();
  const listed = groups.flatMap((group) => group.ids);
  assert.equal(new Set(listed).size, listed.length, "no screen is listed twice");
  assert.deepEqual([...listed].sort(), privateIds, "every private screen of the registry, and nothing else");
  assert.deepEqual(groups.map((group) => group.key), ["A", "B", "C", "D", "E"]);
});

test("the review edge, bound to the loopback address, sends the review only the application's private paths and its own assets", () => {
  const edge = readFileSync(join(root, "tools", "review", "serve.mjs"), "utf8");
  assert.match(edge, /const HOST = "127\.0\.0\.1";/);
  assert.match(edge, /const PRIVATE_PREFIXES = \["\/login", "\/onboarding", "\/invitations", "\/agencies", "\/ops", "\/account", "\/__as", "\/__review\/private"\];/);
  assert.match(edge, /url\.pathname\.startsWith\("\/__review\/assets\/"\)/);
  const config = readFileSync(join(root, "tools", "review", "private", "next.config.mjs"), "utf8");
  assert.match(config, /assetPrefix: "\/__review\/assets"/);
  assert.doesNotMatch(config, /basePath/);
});

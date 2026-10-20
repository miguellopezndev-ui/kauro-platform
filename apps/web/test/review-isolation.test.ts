// The owner's review environment (tools/review/serve.mjs, Order 10) is outside the product: nothing the web build compiles refers to it,
// the application has no review route, and a production build carries no trace of it. A review index or switch reached through the
// product would be a hidden door in the real routes.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// the compiled test runs from dist/test: the web app is two levels up
const web = fileURLToPath(new URL("../../", import.meta.url));
const MARKERS = [/__review/, /tools[\\/]review/, /KAURO_REVIEW/];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

test("no source, configuration or build script of the web refers to the review environment", () => {
  const sources = [...files(join(web, "src")), join(web, "next.config.ts"), ...files(join(web, "scripts"))];
  assert.ok(sources.length > 50);
  for (const path of sources) {
    if (!/\.(ts|tsx|mjs|js|css|json)$/.test(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const marker of MARKERS) assert.doesNotMatch(text, marker, path);
  }
});

test("the application defines no review route", () => {
  for (const path of files(join(web, "src", "app"))) assert.doesNotMatch(path, /review/i, path);
});

test("a production build, when present, carries no trace of the review environment", (t) => {
  const standalone = join(web, ".next", "standalone", "apps", "web");
  if (!existsSync(standalone)) {
    t.skip("no production build in this checkout");
    return;
  }
  const built = [...files(join(standalone, ".next", "server"))].filter((p) => /\.(js|json|html)$/.test(p));
  assert.ok(built.length > 0);
  for (const path of built) {
    const text = readFileSync(path, "utf8");
    for (const marker of MARKERS) assert.doesNotMatch(text, marker, path);
  }
});

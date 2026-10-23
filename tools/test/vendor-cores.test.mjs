// B05 D5-1 (S045): the vendored cores are pinned tarballs; tools/vendor-cores.mjs proves sha256 == MANIFEST == SHA256SUMS ==
// pnpm-lock integrity, refuses sibling/link/workspace specs and, with --release, a provisional pin; and proves each wrapper
// exposes exactly its core's root exports on the installed (== tarball) files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tool = resolve(here, "..", "vendor-cores.mjs");
const realRoot = resolve(here, "..", "..");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sha512b64 = (b) => createHash("sha512").update(b).digest("base64");

function run(root, ...args) {
  const r = spawnSync(process.execPath, [tool, "check", ...args, "--root", root], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// a fixture workspace: one released core (with a SHA256SUMS line) and one provisional core, wrappers, lockfile, overrides.
// A mutation is the replacement content, or a function of the pristine content.
function fixture(mutate = {}) {
  const root = mkdtempSync(join(tmpdir(), "kauro-vendor-"));
  const rc = Buffer.from("released-core-bytes");
  const pc = Buffer.from("provisional-core-bytes");
  const manifest = {
    artifactKind: "KAURO_VENDORED_DEPENDENCIES",
    cores: [
      { name: "core-a", version: "1.0.0", file: "vendor/core-a-1.0.0.tgz", bytes: rc.length, sha256: sha256(rc), status: "RELEASED", provisional: false, sha256sums: "vendor/SHA256SUMS.a", wrapper: "packages/wrap-a", source: { tag: "v1.0.0", commit: "a".repeat(40), releaseId: 1 } },
      { name: "core-b", version: "0.1.0", file: "vendor/core-b-0.1.0.tgz", bytes: pc.length, sha256: sha256(pc), status: "PROVISIONAL_UNRELEASED", provisional: true, wrapper: "packages/wrap-b", source: { commit: "b".repeat(40) } },
    ],
  };
  const lock = `lockfile: x
packages:

  core-a@file:vendor/core-a-1.0.0.tgz:
    resolution: {integrity: sha512-${sha512b64(rc)}, tarball: file:vendor/core-a-1.0.0.tgz}
    version: 1.0.0

  core-b@file:vendor/core-b-0.1.0.tgz:
    resolution: {integrity: sha512-${sha512b64(pc)}, tarball: file:vendor/core-b-0.1.0.tgz}
    version: 0.1.0
`;
  const pristine = {
    "vendor/core-a-1.0.0.tgz": rc,
    "vendor/core-b-0.1.0.tgz": pc,
    "vendor/SHA256SUMS.a": `${sha256(rc)}  core-a-1.0.0.tgz\n`,
    "vendor/MANIFEST.json": JSON.stringify(manifest),
    "pnpm-lock.yaml": lock,
    "pnpm-workspace.yaml": `packages:\n  - packages/*\n\noverrides:\n  core-a: file:vendor/core-a-1.0.0.tgz\n  core-b: file:vendor/core-b-0.1.0.tgz\n`,
    "packages/wrap-a/package.json": JSON.stringify({ name: "@x/wrap-a", dependencies: { "core-a": "1.0.0" } }),
    "packages/wrap-b/package.json": JSON.stringify({ name: "@x/wrap-b", dependencies: { "core-b": "0.1.0", "core-a": "1.0.0" } }),
  };
  for (const [rel, base] of Object.entries(pristine)) {
    const m = mutate[rel];
    const content = typeof m === "function" ? m(base) : m !== undefined ? m : base;
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

function withFixture(mutate, fn) {
  const root = fixture(mutate);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("K01 S045 OK: each vendored core's sha256 equals MANIFEST and SHA256SUMS and pnpm-lock integrity equals the file's sha512", () => {
  withFixture({}, (root) => {
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /core-a 1\.0\.0 sha256 [0-9a-f]{64} == MANIFEST == SHA256SUMS == lock integrity/);
    assert.match(r.out, /core-b 0\.1\.0 .* PROVISIONAL_UNRELEASED/);
  });
  // the checked-in tree: both real cores, the internal release SHA256SUMS of Migration Core 3.1.0
  const real = run(realRoot);
  assert.equal(real.code, 0, real.out);
  assert.match(real.out, /kauro-migration-core 3\.1\.0 sha256 22fe91ae66f30289839188ca16f0b99a5eb850950ad94b559ad42fc28daee5ea == MANIFEST == SHA256SUMS == lock integrity/);
  assert.match(real.out, /kauro-intelligence-core 0\.6\.0 .* PROVISIONAL_UNRELEASED/);
});

test("K02 S045 DENY: a tampered tarball, a MANIFEST mismatch, a lockfile integrity mismatch, a sibling file:../ path, link: or workspace: spec each fail with its reason", () => {
  withFixture({ "vendor/core-a-1.0.0.tgz": Buffer.from("tampered") }, (root) => {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[sha256\] vendor\/core-a-1\.0\.0\.tgz sha256 [0-9a-f]{64} differs from MANIFEST/);
    assert.match(r.out, /\[bytes\] vendor\/core-a-1\.0\.0\.tgz is 8 bytes, MANIFEST says 19/);
    assert.match(r.out, /\[lock\] pnpm-lock\.yaml integrity of core-a@file:vendor\/core-a-1\.0\.0\.tgz does not equal the file's sha512/);
    assert.match(r.out, /\[sums\] vendor\/SHA256SUMS\.a/);
  });
  withFixture({ "vendor/SHA256SUMS.a": `${"0".repeat(64)}  core-a-1.0.0.tgz\n` }, (root) => {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[sums\] vendor\/SHA256SUMS\.a line for core-a-1\.0\.0\.tgz is 0{64}, the file is [0-9a-f]{64}/);
  });
  withFixture({ "vendor/MANIFEST.json": (t) => t.replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${"1".repeat(64)}"`) }, (root) => {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`\\[sha256\\] vendor/core-a-1\\.0\\.0\\.tgz sha256 [0-9a-f]{64} differs from MANIFEST 1{64}`));
  });
  withFixture({ "pnpm-lock.yaml": (t) => t.replace(/integrity: sha512-[^,]+/, "integrity: sha512-AAAA") }, (root) => {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[lock\] pnpm-lock\.yaml integrity of core-a@file:vendor\/core-a-1\.0\.0\.tgz does not equal the file's sha512/);
  });
  for (const [label, spec, reason] of [
    ["a sibling path", "file:../kauro-migration-core/core-a-1.0.0.tgz", /\[spec\] packages\/wrap-a\/package\.json: core-a is "file:\.\.\/kauro-migration-core\/core-a-1\.0\.0\.tgz"/],
    ["link:", "link:../core-a", /\[spec\] packages\/wrap-a\/package\.json: core-a is "link:\.\.\/core-a"/],
    ["workspace:", "workspace:*", /\[spec\] packages\/wrap-a\/package\.json: core-a is "workspace:\*"/],
    ["a version other than the manifest's", "1.0.1", /\[spec\] packages\/wrap-a\/package\.json: core-a is "1\.0\.1", the vendored version is the exact 1\.0\.0/],
  ]) {
    withFixture({ "packages/wrap-a/package.json": JSON.stringify({ name: "@x/wrap-a", dependencies: { "core-a": spec } }) }, (root) => {
      const r = run(root);
      assert.equal(r.code, 1, `${label}: ${r.out}`);
      assert.match(r.out, reason, label);
    });
  }
  withFixture({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n\noverrides:\n  core-a: file:../elsewhere/core-a-1.0.0.tgz\n  core-b: file:vendor/core-b-0.1.0.tgz\n" }, (root) => {
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[spec\] pnpm-workspace\.yaml: override core-a is "file:\.\.\/elsewhere\/core-a-1\.0\.0\.tgz", expected file:vendor\/core-a-1\.0\.0\.tgz/);
  });
});

test("K03 S045 DENY: check --release refuses a PROVISIONAL_UNRELEASED pin", () => {
  withFixture({}, (root) => {
    assert.equal(run(root).code, 0);
    const r = run(root, "--release");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[release\] core-b 0\.1\.0 is PROVISIONAL_UNRELEASED \(source commit b{40}\); a release refuses a provisional pin/);
    assert.doesNotMatch(r.out, /\[release\] core-a/);
  });
  // a manifest whose status and provisional flag disagree is refused too (no way to launder a provisional pin)
  withFixture({}, (root) => {
    const m = JSON.parse(readFileSync(join(root, "vendor/MANIFEST.json"), "utf8"));
    m.cores[1].status = "RELEASED";
    writeFileSync(join(root, "vendor/MANIFEST.json"), JSON.stringify(m));
    const r = run(root, "--release");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[manifest\] core-b: status RELEASED disagrees with provisional true/);
  });
  // the checked-in tree is provisional (IC) until L4 swaps the pin
  const real = run(realRoot, "--release");
  assert.equal(real.code, 1, real.out);
  assert.match(real.out, /\[release\] kauro-intelligence-core 0\.6\.0 is PROVISIONAL_UNRELEASED/);
  assert.doesNotMatch(real.out, /\[release\] kauro-migration-core/);
});

test("K04 S045 OK: each wrapper's export names equal its core's root exports and the installed core files equal the tarball's", async () => {
  const mod = await import(new URL("../vendor-cores.mjs", import.meta.url));
  // the checked-in workspace (installed by pnpm, wrappers built by the build step that precedes the tests)
  const real = spawnSync(process.execPath, [tool, "check", "--installed", "--root", realRoot], { encoding: "utf8" });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /@kauro\/migration-core exports equal kauro-migration-core's \d+ root exports/);
  assert.match(real.stdout, /@kauro\/intelligence-core exports equal kauro-intelligence-core's \d+ root exports/);
  assert.match(real.stdout, /installed kauro-migration-core files equal the tarball's \d+ files/);
  // the comparisons refuse a wrapper that drops, adds or renames an export, and an installed file that differs
  assert.deepEqual(mod.diffExportNames({ a: 1, b: 2 }, { b: 1, a: 1 }), { missing: [], extra: [] });
  assert.deepEqual(mod.diffExportNames({ a: 1, b: 2 }, { a: 1, c: 3 }), { missing: ["b"], extra: ["c"] });
  const dir = mkdtempSync(join(tmpdir(), "kauro-installed-"));
  try {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "a.js"), "one");
    writeFileSync(join(dir, "pkg", "b.js"), "two");
    const expected = new Map([["a.js", sha256(Buffer.from("one"))], ["b.js", sha256(Buffer.from("two"))]]);
    assert.deepEqual(mod.diffInstalledFiles(join(dir, "pkg"), expected), []);
    writeFileSync(join(dir, "pkg", "b.js"), "tampered");
    writeFileSync(join(dir, "pkg", "c.js"), "extra");
    const problems = mod.diffInstalledFiles(join(dir, "pkg"), expected);
    assert.deepEqual([...problems].sort(), ["b.js differs from the tarball", "c.js is not in the tarball"]);
    rmSync(join(dir, "pkg", "a.js"));
    assert.ok(mod.diffInstalledFiles(join(dir, "pkg"), expected).includes("a.js is missing from the install"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

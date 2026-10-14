// S076 (A scanner lacks feeds or an action/image is not pinned): every third-party action reference in .github/** and every container
// image reference in the repository's CI and container files is pinned to an immutable digest, never a tag or a branch.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HEX40 = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Every `uses:` value of a workflow or composite action text (quotes and a trailing comment removed). */
export function usesOf(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(.*)$/.exec(line);
    if (m) out.push({ line: i + 1, value: m[1].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "") });
  });
  return out;
}

/** Every container image reference: `image:` / `container:` scalars, `docker://` uses, Dockerfile FROM lines. */
export function imagesOf(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const clean = line.replace(/\s+#.*$/, "");
    let m = /^\s*(?:-\s+)?(?:image|container):\s*(\S.*)$/.exec(clean);
    if (m && !m[1].startsWith("{") && !m[1].startsWith("|")) out.push({ line: i + 1, value: m[1].trim().replace(/^["']|["']$/g, "") });
    m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(clean);
    if (m && m[1].toLowerCase() !== "scratch") out.push({ line: i + 1, value: m[1] });
    m = /uses:\s*["']?docker:\/\/(\S+?)["']?\s*$/.exec(clean);
    if (m) out.push({ line: i + 1, value: m[1] });
  });
  return out;
}

export function unpinnedActions(text) {
  return usesOf(text)
    .filter(({ value }) => !value.startsWith("./") && !value.startsWith("docker://"))
    .filter(({ value }) => !HEX40.test(value.split("@")[1] ?? ""))
    .map((u) => `${u.line}: ${u.value}`);
}

export function unpinnedImages(text) {
  return imagesOf(text)
    .filter(({ value }) => !DIGEST.test(value))
    .map((u) => `${u.line}: ${u.value}`);
}

function walk(dir, accept, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, accept, out);
    else if (accept(e.name)) out.push(p);
  }
  return out;
}

const workflowFiles = () => walk(join(root, ".github"), (n) => /\.ya?ml$/.test(n));
const imageFiles = () => [...workflowFiles(), ...walk(root, (n) => /^(Dockerfile|Containerfile)(\..+)?$/.test(n) || /^(docker-)?compose(\..+)?\.ya?ml$/.test(n))];

test("S076: the detectors flag a tag, a branch, a short sha, a missing ref and an image without a digest, and accept a 40-hex sha and an @sha256 digest", () => {
  const sha = "a".repeat(40);
  const bad = ["actions/checkout@v5", "actions/checkout@main", `actions/checkout@${"a".repeat(39)}`, "actions/checkout", `actions/checkout@${"A".repeat(40)}`];
  for (const value of bad) assert.equal(unpinnedActions(`    - uses: ${value}`).length, 1, value);
  assert.deepEqual(unpinnedActions(`    - uses: actions/checkout@${sha} # v5\n    uses: ./local-action\n    - uses: "x/y@${sha}"`), []);
  const digest = `@sha256:${"b".repeat(64)}`;
  for (const text of ["    image: postgres:17", "    container: node:24", "FROM node:24-slim", `    - uses: docker://alpine:3`, `    image: postgres${digest.slice(0, -1)}`]) assert.equal(unpinnedImages(text).length, 1, text);
  assert.deepEqual(unpinnedImages(`    image: postgres:17${digest}\nFROM node${digest} AS build\nFROM scratch\n    - uses: docker://alpine${digest}`), []);
});

test("S076: every workflow uses: is pinned to a 40-hex sha and every image to @sha256", () => {
  const files = imageFiles();
  assert.ok(workflowFiles().length >= 1, "the CI workflow is there to be checked");
  const problems = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const p of unpinnedActions(text)) problems.push(`${file.slice(root.length + 1)}: action ${p}`);
    for (const p of unpinnedImages(text)) problems.push(`${file.slice(root.length + 1)}: image ${p}`);
  }
  assert.deepEqual(problems, [], "no mutable reference may run in CI");
  const total = workflowFiles().reduce((n, f) => n + usesOf(readFileSync(f, "utf8")).length, 0);
  assert.ok(total >= 1, "the check saw at least one uses: line (an empty scan proves nothing)");
});

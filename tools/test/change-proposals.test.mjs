// ChangeProposals against the vendored authority registry (docs/authority/proposals/README.md; D-34 §1.3: a registry change goes
// through a ChangeProposal and a new version, never a silent edit). A proposal is checked here, not applied: the vendored registry
// keeps its recorded hashes until the authority re-issue adopts an item. Each delta must
//   - name the exact bytes it was written against (base hashes = PROVENANCE.json = the files on disk),
//   - prove every value it replaces (a `test` op on the same path right before each `replace`), and never remove or overwrite,
//   - touch each path through one item only, and apply cleanly in item order,
//   - carry a closed status, a traceable approval and its open points, and claim no adoption,
//   - leave a registry the contracts generator still accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const proposalsDir = join(repo, "docs", "authority", "proposals");
const registryDir = join(repo, "packages", "contracts", "registry");

const STATUSES = new Set(["APPROVED_AWAITING_REISSUE", "CONDITIONAL", "PROPOSED"]);
const SOURCES = new Set(["owner", "authority", "law"]);
const OPS = new Set(["test", "add", "replace"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const provenance = readJson(join(registryDir, "PROVENANCE.json"));

const deltas = readdirSync(proposalsDir)
  .filter((name) => name.endsWith(".registry-delta.json"))
  .map((name) => ({ name, delta: readJson(join(proposalsDir, name)) }));

/** RFC 6901 pointer to its unescaped tokens. */
function tokens(pointer) {
  assert.ok(pointer.startsWith("/"), `pointer ${pointer} is absolute`);
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parentOf(doc, pointer) {
  const path = tokens(pointer);
  const key = path.pop();
  let node = doc;
  for (const t of path) {
    assert.ok(node !== null && typeof node === "object" && Object.hasOwn(node, Array.isArray(node) ? Number(t) : t), `${pointer}: parent ${t} exists`);
    node = node[Array.isArray(node) ? Number(t) : t];
  }
  assert.ok(node !== null && typeof node === "object", `${pointer}: parent is a container`);
  return { node, key };
}

function valueAt(doc, pointer) {
  const { node, key } = parentOf(doc, pointer);
  assert.ok(Object.hasOwn(node, Array.isArray(node) ? Number(key) : key), `${pointer} exists`);
  return node[Array.isArray(node) ? Number(key) : key];
}

/** Applies one op of the RFC 6902 subset a proposal may use; add never overwrites, replace never creates. */
function apply(doc, op) {
  assert.ok(OPS.has(op.op), `${op.path}: op ${op.op} is one of ${[...OPS]}`);
  if (op.op === "test") {
    assert.deepEqual(valueAt(doc, op.path), op.value, `${op.path}: the proposal was written against this value`);
    return;
  }
  const { node, key } = parentOf(doc, op.path);
  if (op.op === "replace") {
    valueAt(doc, op.path);
    node[Array.isArray(node) ? Number(key) : key] = structuredClone(op.value);
    return;
  }
  if (Array.isArray(node)) {
    assert.equal(key, "-", `${op.path}: an array grows only at its end`);
    node.push(structuredClone(op.value));
  } else {
    assert.ok(!Object.hasOwn(node, key), `${op.path}: add never overwrites an existing member`);
    node[key] = structuredClone(op.value);
  }
}

test("there is at least one proposal, and each names its document", () => {
  assert.ok(deltas.length > 0, "docs/authority/proposals holds a registry delta");
  for (const { name, delta } of deltas) {
    assert.match(delta.proposal, /^CP-\d{2}$/, `${name}: proposal id`);
    assert.ok(name.startsWith(`${delta.proposal}.`), `${name}: file named after ${delta.proposal}`);
    assert.ok(existsSync(join(repo, delta.document)), `${name}: ${delta.document} exists`);
  }
});

test("a proposal is written against the exact vendored bytes: base hashes equal PROVENANCE.json and the files on disk", () => {
  for (const { name, delta } of deltas) {
    for (const [file, hash] of Object.entries(delta.base.files)) {
      assert.equal(hash, provenance.files[file], `${name}: base of ${file} is the recorded provenance`);
      assert.equal(sha256(readFileSync(join(registryDir, file))), hash, `${name}: ${file} on disk is unchanged`);
    }
    assert.equal(readJson(join(registryDir, "policy.json")).edition, delta.base.edition, `${name}: base edition`);
  }
});

test("every item has a closed status, a traceable approval and its open points, and none claims adoption", () => {
  for (const { name, delta } of deltas) {
    const ids = new Set();
    for (const item of delta.items) {
      assert.match(item.id, new RegExp(`^${delta.proposal}\\.\\d{2}$`), `${name}: item id ${item.id}`);
      assert.ok(!ids.has(item.id), `${name}: ${item.id} is unique`);
      ids.add(item.id);
      assert.ok(STATUSES.has(item.status), `${item.id}: status ${item.status} is one of ${[...STATUSES]} (ADOPTED only after the re-issue)`);
      assert.ok(Array.isArray(item.gaps) && item.gaps.length > 0, `${item.id}: names the gaps it answers`);
      assert.ok(Array.isArray(item.pending), `${item.id}: lists its open points`);
      if (item.status === "PROPOSED") {
        assert.equal(item.approval, null, `${item.id}: a proposal carries no approval`);
        assert.ok(item.pending.length > 0, `${item.id}: a proposal names the decision it needs`);
      } else {
        assert.ok(item.approval && SOURCES.has(item.approval.source), `${item.id}: approval source is one of ${[...SOURCES]}`);
        assert.match(item.approval.date, /^\d{4}-\d{2}-\d{2}$/, `${item.id}: approval date`);
        assert.ok(existsSync(join(repo, item.approval.record)), `${item.id}: approval record ${item.approval.record} exists`);
        if (item.status === "APPROVED_AWAITING_REISSUE") assert.deepEqual(item.pending, [], `${item.id}: an approved item has nothing open`);
        else assert.ok(item.pending.length > 0, `${item.id}: a conditional item names what it waits for`);
      }
      for (const dep of item.dependsOn) assert.ok(ids.has(dep) && dep !== item.id, `${item.id}: depends on an earlier item ${dep}`);
    }
  }
});

test("every replaced value is proved first, nothing is removed, and no path is changed by two items", () => {
  for (const { name, delta } of deltas) {
    const owner = new Map();
    for (const item of delta.items) {
      for (const [file, ops] of Object.entries(item.patch)) {
        assert.ok(Object.hasOwn(delta.base.files, file), `${item.id}: ${file} has a base hash`);
        ops.forEach((op, i) => {
          if (op.op === "replace") {
            const before = ops[i - 1];
            assert.ok(before && before.op === "test" && before.path === op.path, `${item.id}: ${file}${op.path} is tested right before it is replaced`);
          }
          if (op.op !== "test") {
            const key = `${file}${op.path}`;
            assert.ok(!owner.has(key) || op.path.endsWith("/-"), `${name}: ${key} is changed by ${owner.get(key)} and ${item.id}`);
            owner.set(key, item.id);
          }
        });
      }
    }
  }
});

test("each proposal applies cleanly in item order and keeps every existing key and record", () => {
  for (const { delta } of deltas) {
    const docs = Object.fromEntries(Object.keys(delta.base.files).map((file) => [file, readJson(join(registryDir, file))]));
    const before = structuredClone(docs);
    for (const item of delta.items) for (const [file, ops] of Object.entries(item.patch)) for (const op of ops) apply(docs[file], op);
    for (const [file, original] of Object.entries(before)) {
      if (Array.isArray(original)) {
        assert.ok(docs[file].length >= original.length, `${file}: no record removed`);
        original.forEach((row, i) => {
          for (const k of Object.keys(row)) assert.ok(Object.hasOwn(docs[file][i], k), `${file}[${i}].${k} kept`);
          if (row.id !== undefined) assert.equal(docs[file][i].id, row.id, `${file}[${i}] keeps its id`);
        });
      } else {
        for (const k of Object.keys(original)) assert.ok(Object.hasOwn(docs[file], k), `${file}.${k} kept`);
      }
    }
    const screenIds = docs["screens.json"]?.map((s) => s.id) ?? [];
    assert.equal(new Set(screenIds).size, screenIds.length, "screen ids stay unique");
  }
});

test("the registry a proposal would produce is still accepted by the contracts generator", () => {
  for (const { delta } of deltas) {
    const root = mkdtempSync(join(tmpdir(), "kauro-cp-"));
    try {
      mkdirSync(join(root, "tools"));
      mkdirSync(join(root, "registry"));
      copyFileSync(join(repo, "packages", "contracts", "tools", "generate.mjs"), join(root, "tools", "generate.mjs"));
      const files = {};
      for (const file of Object.keys(provenance.files)) {
        const doc = readJson(join(registryDir, file));
        for (const item of delta.items) for (const op of item.patch[file] ?? []) apply(doc, op);
        const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
        writeFileSync(join(root, "registry", file), bytes);
        files[file] = sha256(bytes);
      }
      writeFileSync(join(root, "registry", "PROVENANCE.json"), JSON.stringify({ ...provenance, files }, null, 2));
      const run = spawnSync(process.execPath, [join(root, "tools", "generate.mjs")], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 0, run.stdout + run.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

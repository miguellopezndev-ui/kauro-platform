// B18 S079 / R2-113 (SIMULATED over fixture inputs: no required CI step runs the tool yet, that is the separate "CI: release-candidate
// gate" PR; real digests are B19/D-14). The candidate is the source tree plus the lock, the vendored cores and the image digest.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freezeCandidate, verifyPromotion } from "../release-candidate.mjs";

const here = import.meta.dirname;
const tool = join(here, "..", "release-candidate.mjs");
const inputs = JSON.parse(readFileSync(join(here, "fixtures", "release", "candidate-inputs.json"), "utf8"));
const approved = freezeCandidate(inputs);
const withInputs = (patch) => freezeCandidate({ ...inputs, ...patch });
const codes = (result) => result.problems.map((p) => p.code);
const flipped = (hex) => (hex[0] === "f" ? "e" : "f") + hex.slice(1);

test("freeze is deterministic, covers every input and ignores the order of cores", () => {
  assert.deepEqual(freezeCandidate(inputs), approved);
  assert.deepEqual(freezeCandidate({ ...inputs, cores: [...inputs.cores].reverse() }), approved);
  assert.match(approved.id, /^[0-9a-f]{64}$/);
  for (const patch of [
    { sourceTree: flipped(inputs.sourceTree) },
    { lock: { ...inputs.lock, sha256: flipped(inputs.lock.sha256) } },
    { cores: [{ ...inputs.cores[0], sha256: flipped(inputs.cores[0].sha256) }, inputs.cores[1]] },
    { imageDigest: `sha256:${flipped(inputs.imageDigest.slice(7))}` },
  ]) assert.notEqual(withInputs(patch).id, approved.id, JSON.stringify(Object.keys(patch)));
  assert.throws(() => freezeCandidate({ ...inputs, imageDigest: "latest" }), /imageDigest/);
  assert.throws(() => freezeCandidate({ ...inputs, cores: [inputs.cores[0], inputs.cores[0]] }), /duplicate core/);
});

test("S079: OK the approved candidate itself; DENY promotion of a rebuilt image digest under the approved candidate's evidence", () => {
  assert.deepEqual(verifyPromotion(approved, freezeCandidate(inputs)), { ok: true, problems: [] });
  const rebuilt = withInputs({ imageDigest: `sha256:${flipped(inputs.imageDigest.slice(7))}` });
  const denied = verifyPromotion(approved, rebuilt);
  assert.equal(denied.ok, false);
  assert.deepEqual(codes(denied), ["IMAGE_DIGEST_CHANGED"]);
  // no receipt can carry approval to a rebuilt image: the digest is the artifact
  const receipt = { kind: "EquivalenceReceipt", input: "image", name: "image", from: approved.imageDigest, to: rebuilt.imageDigest };
  assert.deepEqual(codes(verifyPromotion(approved, rebuilt, [receipt])), ["IMAGE_DIGEST_CHANGED"]);
  // a candidate whose id was edited to hide a changed digest is refused
  assert.deepEqual(codes(verifyPromotion(approved, { ...rebuilt, id: approved.id })), ["CANDIDATE_ID_MISMATCH"]);
  assert.deepEqual(codes(verifyPromotion(approved, { ...rebuilt, imageDigest: "latest" })), ["CANDIDATE_MALFORMED"]);
  // the same digest with another source tree is another candidate too
  assert.deepEqual(codes(verifyPromotion(approved, withInputs({ sourceTree: flipped(inputs.sourceTree) }))), ["SOURCE_TREE_CHANGED"]);
});

test("R2-113: DENY an identical source tree with a changed dependency lock or core hash; OK only with an EquivalenceReceipt naming exactly that input", () => {
  const lockTo = flipped(inputs.lock.sha256);
  const lockChanged = withInputs({ lock: { ...inputs.lock, sha256: lockTo } });
  assert.equal(lockChanged.sourceTree, approved.sourceTree, "identical source tree");
  assert.notEqual(lockChanged.id, approved.id, "still a different candidate");
  assert.deepEqual(codes(verifyPromotion(approved, lockChanged)), ["LOCK_CHANGED"]);
  const lockReceipt = { kind: "EquivalenceReceipt", input: "lock", name: "pnpm-lock.yaml", from: inputs.lock.sha256, to: lockTo };
  assert.deepEqual(verifyPromotion(approved, lockChanged, [lockReceipt]), { ok: true, problems: [] });
  // a receipt that names another input, another name or other hashes does not cover this change
  for (const wrong of [
    { ...lockReceipt, input: "core" },
    { ...lockReceipt, name: "package-lock.json" },
    { ...lockReceipt, from: flipped(inputs.lock.sha256).replace(/^./, "0") },
    { ...lockReceipt, to: flipped(lockTo) },
    { ...lockReceipt, kind: "ApprovalNote" },
  ]) assert.deepEqual(codes(verifyPromotion(approved, lockChanged, [wrong])), ["LOCK_CHANGED"], JSON.stringify(wrong));

  const coreTo = flipped(inputs.cores[0].sha256);
  const coreChanged = withInputs({ cores: [{ ...inputs.cores[0], sha256: coreTo }, inputs.cores[1]] });
  assert.deepEqual(codes(verifyPromotion(approved, coreChanged)), ["CORE_CHANGED"]);
  const coreReceipt = { kind: "EquivalenceReceipt", input: "core", name: inputs.cores[0].name, from: inputs.cores[0].sha256, to: coreTo };
  assert.deepEqual(verifyPromotion(approved, coreChanged, [coreReceipt]), { ok: true, problems: [] });
  assert.deepEqual(codes(verifyPromotion(approved, coreChanged, [lockReceipt])), ["CORE_CHANGED"], "a lock receipt does not cover a core");
  // two inputs changed: each needs its own receipt
  const both = withInputs({ lock: { ...inputs.lock, sha256: lockTo }, cores: [{ ...inputs.cores[0], sha256: coreTo }, inputs.cores[1]] });
  assert.deepEqual(codes(verifyPromotion(approved, both, [lockReceipt])), ["CORE_CHANGED"]);
  assert.deepEqual(verifyPromotion(approved, both, [lockReceipt, coreReceipt]), { ok: true, problems: [] });
  // an added or removed core cannot be an equivalence
  assert.deepEqual(codes(verifyPromotion(approved, withInputs({ cores: [inputs.cores[0]] }), [{ ...coreReceipt, name: inputs.cores[1].name, from: inputs.cores[1].sha256, to: null }])), ["CORE_CHANGED"]);
  // equivalence never launders a rebuilt image
  assert.deepEqual(codes(verifyPromotion(approved, withInputs({ lock: { ...inputs.lock, sha256: lockTo }, imageDigest: `sha256:${"b".repeat(64)}` }), [lockReceipt])), ["IMAGE_DIGEST_CHANGED"]);
});

test("the CLI freezes real files and answers with exit 0 (OK), 1 (DENY) and 2 (usage)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-rc-"));
  try {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lock v1\n");
    writeFileSync(join(dir, "core.tgz"), "core bytes\n");
    const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    const image = `sha256:${"a".repeat(64)}`;
    const freeze = (out, lockFile, imageDigest = image) => run("freeze", "--tree", inputs.sourceTree, "--lock", join(dir, lockFile), "--core", join(dir, "core.tgz"), "--image", imageDigest, "--out", join(dir, out));
    assert.equal(freeze("a.json", "pnpm-lock.yaml").status, 0);
    assert.equal(freeze("b.json", "pnpm-lock.yaml").status, 0);
    assert.equal(run("verify-promotion", "--approved", join(dir, "a.json"), "--proposed", join(dir, "b.json")).status, 0);
    assert.equal(freeze("c.json", "pnpm-lock.yaml", `sha256:${"b".repeat(64)}`).status, 0);
    const denied = run("verify-promotion", "--approved", join(dir, "a.json"), "--proposed", join(dir, "c.json"));
    assert.equal(denied.status, 1);
    assert.match(denied.stdout, /IMAGE_DIGEST_CHANGED/);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lock v2\n");
    writeFileSync(join(dir, "lock2.json"), "[]");
    assert.equal(freeze("d.json", "pnpm-lock.yaml").status, 0);
    const lockDenied = run("verify-promotion", "--approved", join(dir, "a.json"), "--proposed", join(dir, "d.json"));
    assert.equal(lockDenied.status, 1);
    assert.match(lockDenied.stdout, /LOCK_CHANGED/);
    assert.equal(run("verify-promotion", "--approved", join(dir, "a.json")).status, 2);
    assert.equal(run("nonsense").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

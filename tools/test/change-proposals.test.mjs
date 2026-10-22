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
const DECISIONS = new Set([
  "APPROVED",
  "APPROVED_WITH_CHANGES",
  "CONTENT_APPROVED_LEGAL_EFFECT_CONDITIONAL",
  "DESIGN_APPROVED_PUBLICATION_CONDITIONAL",
  "PARAMETERS_APPROVED_ACTIVATION_BLOCKED",
]);

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
      assert.ok(Array.isArray(item.activation), `${item.id}: lists what must hold before it takes effect`);
      if (item.status === "PROPOSED") {
        assert.equal(item.approval, null, `${item.id}: a proposal carries no approval`);
        assert.ok(item.pending.length > 0, `${item.id}: a proposal names the decision it needs`);
        if (item.deferred) assert.ok(existsSync(join(repo, item.deferred.record)), `${item.id}: deferral record ${item.deferred.record} exists`);
      } else {
        assert.ok(item.approval && SOURCES.has(item.approval.source), `${item.id}: approval source is one of ${[...SOURCES]}`);
        assert.match(item.approval.date, /^\d{4}-\d{2}-\d{2}$/, `${item.id}: approval date`);
        assert.ok(existsSync(join(repo, item.approval.record)), `${item.id}: approval record ${item.approval.record} exists`);
        if (item.approval.decision !== undefined) assert.ok(DECISIONS.has(item.approval.decision), `${item.id}: decision ${item.approval.decision}`);
        for (const record of item.approval.basis ?? []) assert.ok(existsSync(join(repo, record)), `${item.id}: basis ${record} exists`);
        assert.equal(item.deferred, undefined, `${item.id}: an approved item is not deferred`);
        if (item.status === "APPROVED_AWAITING_REISSUE") assert.deepEqual(item.pending, [], `${item.id}: an approved item has nothing open`);
        else assert.ok(item.pending.length > 0, `${item.id}: a conditional item names what it waits for`);
      }
      for (const dep of item.dependsOn) assert.ok(ids.has(dep) && dep !== item.id, `${item.id}: depends on an earlier item ${dep}`);
    }
  }
});

test("every replaced value is proved first, nothing is removed, and no path is changed by two items of any proposal", () => {
  // One owner per path across every proposal in the folder: CP-01 and CP-02 are adopted in one re-issue, so neither may change a
  // path the other changes (cite the other item instead).
  const owner = new Map();
  for (const { name, delta } of deltas) {
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

test("the registry each proposal, and all of them together, would produce is still accepted by the contracts generator", () => {
  // Alone, then jointly in file-name order (the coordinated re-issue applies every pending proposal to the same base).
  const runs = deltas.map(({ delta }) => [delta]);
  if (deltas.length > 1) runs.push(deltas.map(({ delta }) => delta));
  for (const run of runs) {
    const root = mkdtempSync(join(tmpdir(), "kauro-cp-"));
    try {
      mkdirSync(join(root, "tools"));
      mkdirSync(join(root, "registry"));
      copyFileSync(join(repo, "packages", "contracts", "tools", "generate.mjs"), join(root, "tools", "generate.mjs"));
      const files = {};
      for (const file of Object.keys(provenance.files)) {
        const doc = readJson(join(registryDir, file));
        for (const delta of run) for (const item of delta.items) for (const op of item.patch[file] ?? []) apply(doc, op);
        const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
        writeFileSync(join(root, "registry", file), bytes);
        files[file] = sha256(bytes);
      }
      writeFileSync(join(root, "registry", "PROVENANCE.json"), JSON.stringify({ ...provenance, files }, null, 2));
      const generated = spawnSync(process.execPath, [join(root, "tools", "generate.mjs")], { cwd: root, encoding: "utf8" });
      assert.equal(generated.status, 0, `${run.map((d) => d.proposal).join(" + ")}: ${generated.stdout}${generated.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// CP-01 after the owner resolution of 2026-10-22 (docs/authority/decisions/2026-10-22-CP-01-OWNER-RESOLUTION.md): the decided
// substance is enforced here so a later edit of the delta cannot quietly drift from it, and nothing of it is adopted early.
const cp01 = deltas.find(({ delta }) => delta.proposal === "CP-01")?.delta;
const cp01Item = (id) => cp01.items.find((item) => item.id === id);
const added = (id, file, path) => {
  const op = cp01Item(id).patch[file]?.find((o) => o.op === "add" && o.path === path);
  assert.ok(op, `${id}: adds ${file}${path}`);
  return op.value;
};

test("CP-01: every item carries the owner resolution, CP-01.09 stays deferred, and the registry holds none of it", () => {
  assert.ok(cp01, "CP-01 delta present");
  assert.ok(existsSync(join(repo, cp01.ownerResolution.record)), "the owner resolution is recorded");
  for (const item of cp01.items) {
    if (item.id === "CP-01.09") continue;
    assert.equal(item.approval.source, "owner", `${item.id}: owner decision`);
    assert.equal(item.approval.record, cp01.ownerResolution.record, `${item.id}: cites the resolution`);
    assert.equal(item.approval.date, cp01.ownerResolution.date, `${item.id}: dated by the resolution`);
  }
  const deferred = cp01Item("CP-01.09");
  assert.equal(deferred.status, "PROPOSED", "CP-01.09 is not approved");
  assert.equal(deferred.approval, null);
  assert.equal(deferred.deferred.currentTextStays, true, "CP-01.09 keeps the current UI03 text");
  assert.equal(cp01Item("CP-01.10").status, "CONDITIONAL", "UI56: publication conditional");
  assert.equal(cp01Item("CP-01.11").status, "CONDITIONAL", "the hold: activation blocked");
  const policy = readJson(join(registryDir, "policy.json"));
  for (const key of ["alerts", "identityResolution", "legalStatus"]) assert.ok(!Object.hasOwn(policy, key), `registry has no ${key} yet`);
  for (const key of ["policyVersion", "extendHardCapExceptions", "pendingPaymentHold"]) assert.ok(!Object.hasOwn(policy.retention, key), `registry has no retention.${key} yet`);
  assert.equal(policy.retention.extendHardCap, false);
  assert.ok(!readJson(join(registryDir, "screens.json")).some((s) => s.id === "UI56"), "registry has no UI56 yet");
});

test("CP-01.07: only a material change of state is progress, and progress extends nothing but the inactivity alert", () => {
  const progress = added("CP-01.07", "policy.json", "/alerts/relevantProgress");
  for (const act of progress.counts) {
    assert.doesNotMatch(act, /COMMAND|READ|DOWNLOAD|SIGN_IN|REMINDER|NOTIFICATION|SUPPORT|RETRY|ATTEMPT|ANY/, `${act} is not a generic or non-material act`);
  }
  for (const act of ["READ", "DOWNLOAD", "SIGN_IN", "REMINDER_OR_NOTIFICATION", "ORDINARY_SUPPORT_MESSAGE", "COMMAND_WITHOUT_MATERIAL_EFFECT", "FAILED_ATTEMPT_OR_RETRY", "REPEATED_ACTION_WITHOUT_STATE_CHANGE"]) {
    assert.ok(progress.neverCounts.includes(act), `${act} never counts`);
  }
  assert.deepEqual(progress.affects, ["INACTIVITY_ALERT"]);
  assert.deepEqual([...progress.neverExtends].sort(), ["LEGAL_DEADLINES", "QUOTE_VALIDITY", "RETENTION"]);
  for (const [file, ops] of Object.entries(cp01Item("CP-01.07").patch)) {
    for (const op of ops) assert.ok(file === "policy.json" && op.path.startsWith("/alerts/"), `CP-01.07 touches only alerts, not ${file}${op.path}`);
  }
  assert.ok(cp01Item("CP-01.07").dependsOn.includes("CP-01.06"));
});

test("CP-01.12: only the core's proving keys merge without a person; name and email stay candidates in bulk of at most 100", () => {
  const identity = added("CP-01.12", "policy.json", "/identityResolution");
  const core = readFileSync(join(repo, "cores", "kauro-migration-core", "src", "domain", "identity.ts"), "utf8");
  const kinds = JSON.parse(core.match(/PROVING_KEY_KINDS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(kinds, ["SOURCE_RECORD_ID", "EXTERNAL_ID"], "Migration Core's proving keys");
  assert.equal(identity.deterministicMerge.onlyProvenIdentityKeys.length, kinds.length);
  kinds.forEach((kind) => assert.ok(identity.deterministicMerge.onlyProvenIdentityKeys.some((key) => key.includes(kind)), `${kind} is a proven key`));
  assert.doesNotMatch(JSON.stringify(identity.deterministicMerge), /EMAIL|NAME/, "email and name never merge by themselves");
  assert.equal(identity.candidatesProveIdentity, false);
  assert.match(identity.normalization.email, /NO_PLUS_STRIPPING/);
  assert.match(identity.normalization.fullName, /ACCENTS_KEPT/);
  assert.equal(identity.normalization.foldingToManufactureProof, false);
  const { batchItems } = readJson(join(registryDir, "policy.json")).api;
  assert.equal(identity.candidateDecision.maximumGroupsPerDecision, 100);
  assert.equal(identity.candidateDecision.maximumGroupsPerDecision, batchItems, "no new limit: api.batchItems");
  assert.equal(identity.candidateDecision.exactPreview, true);
  assert.equal(identity.candidateDecision.explicitHumanApproval, true);
  assert.equal(identity.blockingConflicts.length, 5);
  for (const field of ["DECISION", "EVIDENCE", "RESPONSIBLE_PERSON", "VERSION", "EFFECT"]) assert.ok(identity.decisionRecord.includes(field), `records ${field}`);
});

test("CP-01.11: the hold's approved parameters, its official calendar sources, and no activation before PV1", () => {
  const item = cp01Item("CP-01.11");
  assert.equal(item.status, "CONDITIONAL");
  assert.ok(item.pending.some((p) => /Wise Business/.test(p) && /PV1/.test(p)), "waits for Wise Business and PV1");
  const hold = added("CP-01.11", "policy.json", "/retention/pendingPaymentHold");
  const retention = readJson(join(registryDir, "policy.json")).retention;
  assert.equal(hold.route, "ACH");
  assert.equal(hold.businessDaysFromAcceptedProof, 5);
  assert.equal(hold.calendar, "US_FEDERAL_RESERVE_BANKING_DAYS");
  assert.equal(hold.ceilingDaysFromSeal, 24);
  assert.ok(hold.ceilingDaysFromSeal < retention.stagedDaysHardFromCapture);
  assert.equal(hold.effectiveEnd, "EARLIER_OF_BUSINESS_DAYS_END_AND_CEILING");
  assert.equal(hold.customerSeesEffectiveEnd, true);
  assert.equal(hold.perQuote, 1);
  assert.equal(hold.perSealedSet, 1);
  assert.equal(hold.renewable, false);
  assert.equal(hold.addsToExtension, false);
  assert.equal(hold.withExtension, "LATER_DATE_WITHIN_CEILING");
  assert.equal(hold.stepUpRequired, true);
  assert.equal(hold.isPayment, false);
  assert.equal(hold.authorizesExecution, false);
  assert.deepEqual(hold.ownerReview, { fromEndedUnpaidHold: 3, rollingWindowDays: 90, scope: "ORGANIZATION" });
  const { calendar } = item.evidence;
  assert.match(calendar.appliesTo, /^US ACH \(FedACH\) only/);
  assert.ok(calendar.sources.length >= 3);
  for (const source of calendar.sources) {
    assert.match(new URL(source.url).hostname, /^(www\.)?(federalreserve\.gov|frbservices\.org|uscode\.house\.gov)$/, `${source.url} is official`);
  }
});

test("CP-01.02 to .05 and .14: the decided values and the legal status", () => {
  const retention = readJson(join(registryDir, "policy.json")).retention;
  assert.deepEqual(added("CP-01.02", "policy.json", "/retention/extendHardCapExceptions"), { UNPAID: { ceilingDaysFromSeal: 17, onlyThroughTheProjectExtension: true } });
  assert.equal(retention.softExtensionMaximumSeconds, 72 * 3600, "the extension is up to 72 hours");
  assert.equal(retention.softExtensionsPerProject, 1, "one per project");
  assert.equal(added("CP-01.03", "policy.json", "/intelligence/freeAuditPauseBps"), 9000);
  const reasons = added("CP-01.04", "policy.json", "/commission/claimRefusalReasons");
  assert.deepEqual(reasons.map((r) => r.code), ["CUSTOMER_OR_DIRECT_CONTACT", "OTHER_SELLER_LIVE_CLAIM", "OWNER_RULE", "INSUFFICIENT_OWN_WORK_EVIDENCE", "OUTSIDE_SELLER_AGREEMENT", "DUPLICATE_OWN_CLAIM", "OTHER"]);
  const other = reasons.find((r) => r.code === "OTHER");
  assert.ok(other.noteRequired && other.evidenceRequired, "OTHER needs a note and evidence");
  assert.ok(reasons.find((r) => r.code === "OWNER_RULE").ruleReferenceRequired, "OWNER_RULE names a rule");
  const rules = added("CP-01.04", "policy.json", "/commission/claimRefusalRules");
  assert.equal(rules.sellerSees, "SELLER_MESSAGE_ONLY");
  assert.equal(rules.sellerMayRequestReview, true);
  assert.deepEqual(rules.ownerRule, { mustNameARuleInForce: true, mustBeVersioned: true, retroactive: false });
  const legal = added("CP-01.14", "policy.json", "/legalStatus")["commission.claimRules"];
  assert.equal(legal.state, "PENDING_COUNSEL", "not legally approved without the competent review");
  assert.equal(legal.validation, null);
  assert.ok(legal.covers.includes("commission.claimRefusalReasons"));
  assert.equal(added("CP-01.05", "policy.json", "/commission/retainerDefaultCentsPerMonth"), 0);
});

// ChangeProposal CP-02 (Order 17): the api contract of the functional change, checked before anyone adopts it.
//
// Each rule is a function that throws on the first violation. It runs once on the real proposal (it must pass) and once or more on a
// deliberately broken copy (it must fail): a rule that cannot fail proves nothing, and a repair is accepted only against a rule that
// was seen failing (Order 17 §7). The broken copies are built in memory; nothing on disk is changed.
//
// What is proved:
//   - procedure: CP-02 follows the ChangeProposal procedure of CP-01 (README at PR #122) and the four classes of Order 17;
//   - application: its operations apply to the registry that exists, alone and after CP-01, leave every record in place, and the
//     contracts generator accepts both results; the vendored registry stays byte-identical;
//   - CP-01 is the pinned one and CP-02 never touches a value CP-01 changes;
//   - authority: every decision an item cites exists in its record with the cited words, and an approved item cites only approved
//     decisions and approved CP-01 items;
//   - correspondence: commands, operations, cases, requirements, gates, contracts and events all have their counterpart;
//   - authorization as the contract represents it: audiences, roles, paths, field visibility per identity, assurance;
//   - OpenAPI: the committed document is the generated one, its requests are the registry fields, its replies the registry contracts,
//     its shared shapes the served api's, it collides with no served route, and the web client generator can translate it;
//   - compatibility: every change that could break a current consumer is computed, declared with the same class, and its consumers found;
//   - examples: the valid ones pass and the invalid ones fail, with the expected error, under the api's own strict validator.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PATHS, ROOT, applyDeltas, applyOp, buildAll, canonicalHash, compatibility, generateBundle, generatedOutputs, itemOperations, loadCp01,
  loadProvenance, openapiChanges, readRecord, registryChanges, sha256, valueAt,
} from "../cp02.mjs";
import { generate as generateWebClient } from "../web-client.mjs";

const built = await buildAll();
const { spec, registry, cp01, cp02, combined, bundle, application, domain, live, openapi, matrix } = built;
const clone = (v) => structuredClone(v);
const CLASSES = ["APPROVED_AWAITING_REISSUE", "CONDITIONAL", "PROPOSED", "BLOCKED_EXTERNAL"];
const STATUSES = new Set(["APPROVED_AWAITING_REISSUE", "CONDITIONAL", "PROPOSED"]);
const KINDS = ["POSITIVE", "NEGATIVE", "ADVERSARIAL"];
const RANK = { ADDITIVE: 0, TEXT: 0, COORDINATED: 1, BREAKING: 2 };
const ROLES_IN_FORCE = new Set([
  ...registry["commands.json"].map((c) => c.role.replace(/(^|[^A-Z])KAVO(?![A-Z])/g, "$1KAURO")),
  ...Object.values(live.paths).flatMap((m) => Object.values(m)).map((o) => o["x-kauro-role"]).filter(Boolean),
]);
const REFERENCE = /\b(?:F-\d{2}|G-\d{2}|CP-01\.\d{2}|CP-02\.\d{2}|B-\d{2}|LR-\d{2}|L-\d{2}|PM-\d{2}|O17-\d{2})\b/g;

/** Expects `fn` to fail on a broken copy, and the failure to be the rule's (not a crash of the copy). */
function mustFail(fn, pattern, label) {
  assert.throws(fn, pattern, `the rule did not catch: ${label}`);
}

// --- 1. procedure -----------------------------------------------------------------------------------------------------------

function checkProcedure(s, delta) {
  assert.equal(delta.proposal, "CP-02");
  assert.ok(existsSync(join(ROOT, delta.document)), `${delta.document} exists`);
  const record = readFileSync(join(ROOT, delta.document), "utf8");
  assert.equal(delta.items.length, s.items.length, "one delta item per source item");
  const ids = [];
  for (const [i, item] of s.items.entries()) {
    const d = delta.items[i];
    assert.match(item.id, /^CP-02\.\d{2}$/, `${item.id}: id`);
    assert.equal(Number(item.id.slice(-2)), i + 1, `${item.id}: items are numbered in order`);
    assert.equal(d.id, item.id);
    assert.ok(CLASSES.includes(item.class), `${item.id}: class ${item.class} is one of ${CLASSES} (ADOPTED only after the re-issue)`);
    assert.ok(STATUSES.has(d.status), `${item.id}: status ${d.status} is CP-01's vocabulary`);
    assert.equal(d.status, s.statusOfClass[item.class], `${item.id}: status follows the class`);
    assert.ok(item.gaps.length > 0 && item.o17.length > 0, `${item.id}: names its gaps and its O17 entries`);
    const external = item.blockers.some((b) => b.kind === "EXTERNAL");
    if (item.class === "PROPOSED") {
      assert.equal(item.approval, null, `${item.id}: a proposal carries no approval`);
      assert.ok(item.blockers.some((b) => b.kind === "OWNER"), `${item.id}: a proposal waits for the owner`);
    } else {
      assert.ok(item.approval && ["owner", "authority", "law"].includes(item.approval.source), `${item.id}: approval source`);
      assert.match(item.approval.date, /^\d{4}-\d{2}-\d{2}$/, `${item.id}: approval date`);
      assert.ok(existsSync(join(ROOT, item.approval.record)), `${item.id}: approval record ${item.approval.record} exists on this branch`);
    }
    if (item.class === "APPROVED_AWAITING_REISSUE") {
      assert.deepEqual(item.pending, [], `${item.id}: an approved item has nothing open`);
      assert.deepEqual(item.blockers, [], `${item.id}: an approved item has no blocker`);
    } else {
      assert.ok(item.pending.length > 0 && item.blockers.length > 0, `${item.id}: a non-approved item names what it waits for`);
      assert.ok(item.unlock && item.whyNotYet, `${item.id}: states the exact condition that unlocks it and why it cannot be adopted yet`);
    }
    assert.equal(item.class === "BLOCKED_EXTERNAL", external, `${item.id}: BLOCKED_EXTERNAL exactly when a blocker is external`);
    for (const dep of item.dependsOn) assert.ok(ids.includes(dep), `${item.id}: depends on an earlier item ${dep}`);
    const kinds = new Set(item.acceptance.map((a) => a.kind));
    for (const k of KINDS) assert.ok(kinds.has(k), `${item.id}: has a ${k.toLowerCase()} acceptance case`);
    assert.ok(record.includes(`| ${item.id} | ${item.o17.join(", ")} | ${item.class} |`), `${delta.document} lists ${item.id} with its class ${item.class}`);
    assert.ok(record.includes(`| ${item.id} | | | |`), `${delta.document} has a signature row for ${item.id}`);
    ids.push(item.id);
  }
  const owner = new Map();
  for (const item of delta.items) {
    for (const [file, ops] of Object.entries(item.patch)) {
      assert.ok(Object.hasOwn(delta.base.files, file), `${item.id}: ${file} has a base hash`);
      ops.forEach((op, i) => {
        assert.ok(["test", "add", "replace"].includes(op.op), `${item.id}: ${op.op} is test, add or replace (nothing is removed or moved)`);
        if (op.op === "replace") assert.ok(ops[i - 1]?.op === "test" && ops[i - 1].path === op.path, `${item.id}: ${file}${op.path} is tested right before it is replaced`);
        if (op.op !== "test") {
          const key = `${file}${op.path}`;
          assert.ok(!owner.has(key) || op.path.endsWith("/-"), `${key} is changed by ${owner.get(key)} and ${item.id}`);
          owner.set(key, item.id);
        }
      });
    }
  }
}

test("procedure: CP-02 follows the ChangeProposal procedure and the four classes", () => {
  checkProcedure(spec, cp02);
  const broken = (mutate) => {
    const s = clone(spec);
    const d = clone(cp02);
    mutate(s, d);
    return () => checkProcedure(s, d);
  };
  mustFail(broken((s) => { s.items[0].class = "ADOPTED"; }), /class/, "an item claiming adoption");
  mustFail(broken((s, d) => { s.items[8].class = "APPROVED_AWAITING_REISSUE"; s.items[8].pending = []; s.items[8].blockers = []; d.items[8].status = "APPROVED_AWAITING_REISSUE"; }), /lists CP-02.09 with its class/, "a class the change record does not show");
  mustFail(broken((s) => { s.items[1].pending = ["something"]; }), /nothing open/, "an approved item with an open point");
  mustFail(broken((s) => { s.items[16].blockers = s.items[16].blockers.filter((b) => b.kind !== "EXTERNAL"); }), /external/, "BLOCKED_EXTERNAL without an external blocker");
  mustFail(broken((s) => { delete s.items[8].whyNotYet; }), /unlocks it/, "a conditional item without its reason");
  mustFail(broken((s) => { s.items[1].dependsOn = ["CP-02.09"]; }), /earlier item/, "a dependency on a later item");
  mustFail(broken((s) => { s.items[3].acceptance = s.items[3].acceptance.filter((a) => a.kind !== "ADVERSARIAL"); }), /adversarial/, "an item without an adversarial case");
  mustFail(broken((s, d) => { d.items[20].patch["commands.json"].splice(1, 1); }), /tested right before/, "a replace without its test");
  mustFail(broken((s, d) => { d.items[0].patch["cases.json"].push({ op: "remove", path: "/0" }); }), /nothing is removed/, "a remove op");
});

// --- 2. application ---------------------------------------------------------------------------------------------------------

function checkBase(delta) {
  const provenance = loadProvenance();
  for (const [file, hash] of Object.entries(delta.base.files)) {
    assert.equal(hash, provenance.files[file], `base of ${file} is the recorded provenance`);
    assert.equal(sha256(readFileSync(join(PATHS.registry, file))), hash, `${file} on disk is unchanged`);
  }
  assert.equal(registry["policy.json"].edition, delta.base.edition, "base edition");
}

function checkKept(before, after) {
  for (const [file, original] of Object.entries(before)) {
    if (Array.isArray(original)) {
      assert.ok(after[file].length >= original.length, `${file}: no record removed`);
      original.forEach((row, i) => {
        for (const k of Object.keys(row)) assert.ok(Object.hasOwn(after[file][i], k), `${file}[${i}].${k} kept`);
        if (row.id !== undefined) assert.equal(after[file][i].id, row.id, `${file}[${i}] keeps its id`);
      });
    } else for (const k of Object.keys(original)) assert.ok(Object.hasOwn(after[file], k), `${file}.${k} kept`);
  }
  for (const [file, key] of [["contracts.json", "name"], ["commands.json", "id"], ["commands.json", "name"], ["screens.json", "id"], ["cases.json", "id"], ["requirements.json", "id"], ["state_transitions.json", "contract"]]) {
    const values = after[file].map((r) => r[key]);
    assert.equal(new Set(values).size, values.length, `${file} ${key}s stay unique`);
  }
}

test("application: the operations apply to the registry that exists, alone and after CP-01, and keep every record", () => {
  checkBase(cp02);
  checkKept(registry, applyDeltas(registry, [cp02]));
  checkKept(registry, combined);
  // the registry on disk is untouched by all of the above
  checkBase(cp02);
  const tampered = clone(cp02);
  tampered.base.files["commands.json"] = "0".repeat(64);
  mustFail(() => checkBase(tampered), /provenance/, "a delta written against other bytes");
  const stale = clone(cp02);
  stale.items[20].patch["commands.json"][1].value = "an older precondition";
  mustFail(() => applyDeltas(registry, [stale]), /test failed/, "a replaced value that is not the registry's");
  mustFail(() => applyOp({ a: 1 }, { op: "add", path: "/a", value: 2 }), /never overwrites/, "an add over an existing member");
  mustFail(() => applyOp([1], { op: "add", path: "/0", value: 2 }), /end/, "an insert in the middle of an array");
});

test("application: the contracts generator accepts CP-02 alone and CP-01 + CP-02 in a temporary registry", () => {
  assert.ok(generateBundle(applyDeltas(registry, [cp02])).$defs.ProjectDates, "CP-02 alone");
  for (const name of ["ProjectDates", "ConsentRecord", "SellerClaimView", "StatementBalance", "Alert"]) assert.ok(bundle.$defs[name], `CP-01 + CP-02: ${name}`);
  assert.equal(bundle.$defs.Audit.required.includes("targetContractId"), false, "CP-01.01 applied under CP-02");
  const broken = clone(cp02);
  broken.items[1].patch["contracts.json"][0].value.fields[0].type = "ref:NoSuchContract";
  mustFail(() => generateBundle(applyDeltas(registry, [broken])), /generator refused/, "a contract the generator refuses");
});

// --- 3. CP-01 ---------------------------------------------------------------------------------------------------------------

function checkDisjoint(first, second) {
  const changed = new Set();
  for (const item of first.items) for (const [file, ops] of Object.entries(item.patch)) for (const op of ops) if (op.op !== "test" && !op.path.endsWith("/-")) changed.add(`${file}${op.path}`);
  for (const item of second.items) {
    for (const [file, ops] of Object.entries(item.patch)) {
      for (const op of ops) {
        const key = `${file}${op.path}`;
        for (const c of changed) assert.ok(key !== c && !key.startsWith(`${c}/`) && !c.startsWith(`${key}/`) || op.path.endsWith("/-"), `${item.id} touches ${key}, which ${first.proposal} changes`);
      }
    }
  }
}

test("CP-01: the pinned delta is the one on PR #122, and CP-02 never touches a value CP-01 changes", () => {
  const { origin } = loadCp01(spec);
  assert.ok(origin === "disk" || origin.startsWith("git"), origin);
  assert.equal(cp01.proposal, "CP-01");
  checkDisjoint(cp01, cp02);
  mustFail(() => loadCp01({ ...spec, complementOf: { ...spec.complementOf, sha256: "0".repeat(64) } }), /re-verify/, "a CP-01 other than the pinned one");
  const clash = clone(cp02);
  clash.items[0].patch["commands.json"] = [{ op: "test", path: "/19/precondition", value: valueAt(registry["commands.json"], "/19/precondition") }, { op: "replace", path: "/19/precondition", value: "x" }];
  mustFail(() => checkDisjoint(cp01, clash), /CP-01 changes/, "a CP-02 change on a CP-01 path");
});

// --- 4. authority -----------------------------------------------------------------------------------------------------------

function checkAuthority(s, first) {
  const cp01Items = new Map(first.items.map((i) => [i.id, i]));
  for (const [id, a] of Object.entries(s.authorities)) {
    const body = readRecord(s, a.record);
    assert.ok(body.includes(a.anchor), `${id}: ${a.record} holds the cited words "${a.anchor}"`);
    assert.ok(["APPROVED", "CONDITIONAL", "PROPOSED", "EXTERNAL"].includes(a.standing), `${id}: standing`);
    if (a.standing !== "APPROVED") assert.ok(a.waitsFor, `${id}: names what it waits for`);
  }
  const itemIds = new Set(s.items.map((i) => i.id));
  for (const item of s.items) {
    for (const b of item.basis) assert.ok(s.authorities[b], `${item.id}: basis ${b} is a recorded decision`);
    for (const r of item.requires) assert.ok(cp01Items.has(r), `${item.id}: requires ${r}, an item of CP-01`);
    for (const ref of JSON.stringify(item).match(REFERENCE) ?? []) {
      assert.ok(s.authorities[ref] || cp01Items.has(ref) || itemIds.has(ref) || /^O17-\d{2}$/.test(ref), `${item.id}: cites ${ref}, which no record or proposal defines`);
    }
    if (item.approval) assert.ok(item.basis.some((b) => s.authorities[b].record === item.approval.record), `${item.id}: its approval record is one of its bases`);
    if (item.class === "APPROVED_AWAITING_REISSUE") {
      for (const b of item.basis) assert.equal(s.authorities[b].standing, "APPROVED", `${item.id}: an approved item cites only approved decisions (${b} is ${s.authorities[b].standing})`);
      for (const r of item.requires) assert.equal(cp01Items.get(r).status, "APPROVED_AWAITING_REISSUE", `${item.id}: requires ${r}, which CP-01 has not approved (${cp01Items.get(r).status})`);
      for (const d of item.dependsOn) assert.equal(s.items.find((i) => i.id === d).class, "APPROVED_AWAITING_REISSUE", `${item.id}: depends on ${d}, which is not approved`);
    }
  }
}

test("authority: every cited decision exists with its words; approved items cite only approved decisions", () => {
  checkAuthority(spec, cp01);
  const broken = (mutate) => {
    const s = clone(spec);
    mutate(s);
    return () => checkAuthority(s, cp01);
  };
  mustFail(broken((s) => { s.items[1].basis.push("F-33"); }), /only approved decisions/, "an approved item citing a proposal");
  mustFail(broken((s) => { s.items[1].requires.push("CP-01.04"); }), /not approved/, "an approved item requiring a conditional CP-01 item");
  mustFail(broken((s) => { s.items[2].rules.push("As decided in F-99."); }), /no record or proposal defines/, "a decision nobody recorded");
  mustFail(broken((s) => { s.authorities["F-24"].anchor = "## F-24. The five dates may be added"; }), /cited words/, "words the record does not say");
  mustFail(broken((s) => { s.items[7].dependsOn = ["CP-02.09"]; s.items[7].dependsOn = ["CP-02.07"]; s.items[6].class = "CONDITIONAL"; }), /not approved/, "an approved item depending on a conditional one");
});

// --- 5. correspondence --------------------------------------------------------------------------------------------------------

const safeKinds = new Set(["id", "hash", "token", "count", "bool", "utc"]);

function contractsOf(item) {
  return [...item.contracts, ...(item.extraContracts ?? [])];
}

function checkCorrespondence(s, reg, dom) {
  const contractNames = new Set(reg["contracts.json"].map((c) => c.name));
  const referenced = new Set();
  const refsOf = (name, seen = new Set()) => {
    if (seen.has(name)) return seen;
    seen.add(name);
    const c = reg["contracts.json"].find((x) => x.name === name);
    for (const f of c?.fields ?? []) {
      const m = /^(?:ref|list):(.+)$/.exec(f.type);
      if (m) refsOf(m[1], seen);
    }
    return seen;
  };
  const eventTypes = new Set(dom.EVENT_TYPES);
  const consumers = new Set(dom.CONSUMERS);
  const proposedEvents = new Set();
  for (const item of s.items) {
    const ops = itemOperations(item);
    for (const c of item.commands) {
      assert.equal(ops.filter((o) => o.command === c.id).length, 1, `${item.id}: ${c.id} has exactly one operation`);
      const testIds = reg["commands.json"].find((x) => x.id === c.id)?.testIds;
      assert.deepEqual(testIds, [`${c.id}-OK`, `${c.id}-DENY`, `${c.id}-RACE`], `${c.id}: is in the registry with its three cases`);
    }
    for (const o of ops) {
      if (o.kind === "command") assert.ok(item.commands.some((c) => c.id === o.command), `${item.id}: operation ${o.operationId} has its registry command`);
      assert.ok(contractNames.has(o.response.contract), `${item.id}: ${o.operationId} answers ${o.response.contract}, a registry contract`);
      for (const n of refsOf(o.response.contract)) referenced.add(n);
      for (const [, type] of o.registry?.fields ?? []) {
        const m = /^list:(.+)$/.exec(type);
        if (m) for (const n of refsOf(m[1])) referenced.add(n);
      }
    }
    for (const m of item.modified) if (m.registryContract) for (const n of refsOf(m.registryContract)) referenced.add(n);
    for (const ext of item.extendContracts) for (const [, type] of ext.fields) {
      const m = /^(?:ref|list):(.+)$/.exec(type);
      if (m) for (const n of refsOf(m[1])) referenced.add(n);
    }
    for (const a of item.acceptance) {
      const id = `CP02-${item.id.slice(-2)}-${a.tag}`;
      assert.ok(reg["cases.json"].some((c) => c.id === id), `${id} is a registry case`);
    }
    const itemEvents = new Map(item.events.map((e) => [e.type, e]));
    for (const e of item.events) {
      assert.match(e.type, /^[a-z_]+\.[a-z_]+\.v1$/, `${e.type}: <kind>.<state>.v1`);
      assert.ok(e.type.startsWith(`${e.aggregateKind}.`), `${e.type}: named after its aggregate kind ${e.aggregateKind}`);
      assert.ok(!eventTypes.has(e.type) && !proposedEvents.has(e.type), `${e.type}: a new event type, not one already registered`);
      proposedEvents.add(e.type);
      for (const [k, kind] of Object.entries(e.payload)) assert.ok(safeKinds.has(kind), `${e.type}.${k}: payloads carry ids, hashes, tokens, counts, booleans and instants only (never ${kind})`);
      for (const c of e.consumers) assert.ok(consumers.has(c), `${e.type}: consumer ${c} is registered`);
      for (const p of e.producers ?? [e.producer]) assert.ok(ops.some((o) => o.command === p && o.events?.includes(e.type)), `${e.type}: produced by ${p}, an operation of ${item.id} that declares it`);
    }
    for (const o of ops.filter((x) => x.kind === "command")) {
      for (const t of o.events ?? []) assert.ok(itemEvents.has(t), `${o.operationId}: emits ${t}, which ${item.id} defines`);
      if ((o.events ?? []).length === 0) assert.ok(o.transitions?.length && /D10-EVT-1/.test(o.noEventReason ?? ""), `${o.operationId}: no domain event only as a commercial transition under D10-EVT-1`);
    }
    for (const sub of item.subscriptions ?? []) {
      assert.ok(eventTypes.has(sub.eventType) && consumers.has(sub.consumer), `${item.id}: subscription ${sub.eventType} → ${sub.consumer} names registered names`);
      assert.ok(!dom.EVENT_SUBSCRIPTIONS.some((x) => x.eventType === sub.eventType && x.consumer === sub.consumer), `${item.id}: ${sub.eventType} → ${sub.consumer} is not subscribed already`);
    }
    for (const ch of item.eventPayloadChanges ?? []) assert.ok(eventTypes.has(ch.eventType), `${item.id}: payload change of a registered event ${ch.eventType}`);
  }
  for (const item of s.items) for (const c of contractsOf(item)) assert.ok(referenced.has(c.name), `${item.id}: contract ${c.name} is read or written by an operation`);
  for (const c of reg["cases.json"].filter((x) => x.origin === "CP02_C3_CONTRACT")) {
    const req = reg["requirements.json"].find((r) => r.id === c.requirementId);
    assert.ok(req && req.caseIds.includes(c.id) && req.gate === c.gate, `${c.id}: its requirement exists and names it`);
    assert.ok(reg["gates.json"].find((g) => g.id === c.gate).caseIds.includes(c.id), `${c.id}: gate ${c.gate} carries it`);
    if (c.command) assert.ok(reg["commands.json"].some((x) => x.id === c.command && x.testIds.includes(c.id)), `${c.id}: its command lists it`);
  }
}

test("correspondence: every command, operation, case, requirement, gate, contract and event has its counterpart", () => {
  checkCorrespondence(spec, combined, domain);
  const broken = (mutate, reg = combined) => {
    const s = clone(spec);
    mutate(s);
    return () => checkCorrespondence(s, reg, domain);
  };
  mustFail(broken((s) => { s.items[4].operations.splice(1, 1); }), /exactly one operation/, "a command without its operation");
  mustFail(broken((s) => { s.items[4].events[0].type = "quote.issued.v1"; s.items[4].events[0].aggregateKind = "quote"; }), /new event type/, "an event that already exists");
  mustFail(broken((s) => { s.items[4].events[0].payload.documentVersion = "label"; }), /never label/, "a label in an event payload");
  mustFail(broken((s) => { s.items[4].events[0].consumers = ["MARKETING_MAILER"]; }), /registered/, "an unknown consumer");
  mustFail(broken((s) => { s.items[5].operations[0].events = []; }), /produced by|D10-EVT-1|defines/, "a command whose event disappears");
  mustFail(broken((s) => { s.items[2].contracts.push({ ...s.items[2].contracts[0], name: "OrphanView" }); }), /is read or written/, "a contract no operation uses");
  const noGate = clone(combined);
  for (const g of noGate["gates.json"]) g.caseIds = g.caseIds.filter((id) => id !== "CMD065-OK");
  mustFail(broken(() => {}, noGate), /gate/, "a case no gate carries");
});

// --- 6. authorization as represented --------------------------------------------------------------------------------------------

function fieldsReachable(reg, name, seen = new Map()) {
  if (seen.has(name)) return seen;
  const c = reg["contracts.json"].find((x) => x.name === name);
  seen.set(name, c.fields);
  for (const f of c.fields) {
    const m = /^(?:ref|list):(.+)$/.exec(f.type);
    if (m) fieldsReachable(reg, m[1], seen);
  }
  return seen;
}

function checkAuthorization(s, reg) {
  for (const item of s.items) {
    for (const o of itemOperations(item)) {
      const where = `${item.id} ${o.operationId}`;
      assert.ok(s.identities[o.audience], `${where}: audience ${o.audience} is a declared identity`);
      assert.ok(ROLES_IN_FORCE.has(o.role) || s.newRoles[o.role], `${where}: role ${o.role} is in force or declared new for Order 15`);
      const rule = s.pathRules[o.audience];
      assert.match(o.path, new RegExp(typeof rule === "string" ? rule : rule[o.kind]), `${where}: ${o.audience} ${o.kind}s live under their own prefix`);
      const roleFits = {
        KAURO_OWNER: /^(KAURO_OWNER|OWNER)$/, SELLER: /SELLER/, SELF: /^AUTHENTICATED_SELF$/, PUBLIC: /^PUBLIC$/, AGENCY: /^AGENCY_/, AGENCY_BILLING: /^AGENCY_BILLING/,
      }[o.audience];
      assert.match(o.role, roleFits, `${where}: role ${o.role} fits audience ${o.audience}`);
      const visible = s.visibility[o.audience];
      for (const [contract, fields] of fieldsReachable(reg, o.response.contract)) {
        for (const f of fields) {
          assert.ok(!visible.forbiddenFields.includes(f.name), `${where}: ${o.audience} must not read ${contract}.${f.name}`);
          for (const t of visible.forbiddenTypes ?? []) assert.ok(f.type !== t, `${where}: ${o.audience} must not read a ${t} (${contract}.${f.name})`);
        }
      }
      if (o.kind === "command") {
        assert.ok(["SESSION", "STEP_UP"].includes(o.assurance), `${where}: assurance declared`);
        const moves = o.registry.fields.some(([, t]) => t === "money") || /step-up/i.test(o.registry.precondition);
        if (moves) assert.equal(o.assurance, "STEP_UP", `${where}: money or an owner step-up rule needs a step-up`);
      }
    }
  }
  // four things never confused (Order 17 §4.D)
  const consent = s.items.flatMap(contractsOf).find((c) => c.name === "ConsentRecord");
  const kinds = consent.fields.find(([n]) => n === "kind")[1].slice(5).split(",");
  for (const k of kinds) assert.doesNotMatch(k, /SESSION|LOGIN|AUTHENTICAT|STEP_UP|ASSURANCE/, `a ${k} consent is not a session or an assurance`);
  const topics = s.items.flatMap(contractsOf).find((c) => c.name === "NotificationPreference").fields.find(([n]) => n === "topic")[1].slice(5).split(",");
  for (const t of topics) assert.doesNotMatch(t, /MARKETING|PROMOTION|NEWSLETTER|COMMERCIAL/, `${t}: marketing is a consent, never a notification preference`);
  const request = s.items.flatMap(contractsOf).find((c) => c.name === "OutreachAuthorizationRequest");
  assert.ok(!request.fields.some(([n]) => /consent|permissionEvidence/i.test(n)), "an authorization request carries no consent or permission evidence");
}

test("authorization: audiences, roles, routes, field visibility per identity and assurance are what the contract represents", () => {
  checkAuthorization(spec, combined);
  const withField = (contract, field) => {
    const reg = clone(combined);
    reg["contracts.json"].find((c) => c.name === contract).fields.push({ name: field, type: field.endsWith("Cents") ? "money" : "label", required: false, description: "" });
    return reg;
  };
  mustFail(() => checkAuthorization(spec, withField("SellerClaimView", "reasonCode")), /must not read SellerClaimView.reasonCode/, "a refusal reason in the seller's view");
  mustFail(() => checkAuthorization(spec, withField("ProjectSummary", "servingSellerId")), /must not read/, "a seller id in an agency read");
  mustFail(() => checkAuthorization(spec, withField("FreeCheckAvailability", "remainingCents")), /must not read a money/, "the budget in the public read");
  const s1 = clone(spec);
  s1.items[7].operations[0].path = "/api/v1/sales/sellers";
  mustFail(() => checkAuthorization(s1, combined), /own prefix/, "an owner read under the seller prefix");
  const s2 = clone(spec);
  s2.items[16].operations[0].assurance = "SESSION";
  mustFail(() => checkAuthorization(s2, combined), /step-up/, "a money command without step-up");
  const s3 = clone(spec);
  s3.items[2].operations[0].role = "ANYONE";
  mustFail(() => checkAuthorization(s3, combined), /in force or declared new/, "an undeclared role");
  const s4 = clone(spec);
  s4.items.find((i) => i.id === "CP-02.06").contracts[0].fields[0][1] += ",MARKETING_NEWS";
  mustFail(() => checkAuthorization(s4, combined), /marketing is a consent/, "marketing as a notification preference");
});

// --- 7. OpenAPI ------------------------------------------------------------------------------------------------------------

function checkOpenapi(s, doc, served, bndl) {
  const servedOps = new Map();
  for (const [p, methods] of Object.entries(served.paths)) for (const [m, o] of Object.entries(methods)) servedOps.set(`${m.toUpperCase()} ${p}`, o);
  const servedIds = new Set([...servedOps.values()].map((o) => o.operationId));
  const ids = new Set();
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [m, o] of Object.entries(methods)) {
      assert.ok(!servedOps.has(`${m.toUpperCase()} ${p}`), `${m.toUpperCase()} ${p} is not a served route`);
      assert.ok(!servedIds.has(o.operationId) && !ids.has(o.operationId), `${o.operationId}: operationId unique across the served and the proposed api`);
      ids.add(o.operationId);
      for (const [status, r] of Object.entries(o.responses)) for (const out of r["x-kauro-outcomes"] ?? []) assert.equal(application.PROBLEM_STATUS[out.code], Number(status), `${o.operationId}: ${out.code} answers ${status}`);
    }
  }
  for (const item of s.items) {
    for (const o of itemOperations(item)) {
      const op = doc.paths[o.path]?.[o.method.toLowerCase()];
      assert.ok(op && op.operationId === o.operationId, `${o.operationId} is documented at ${o.method} ${o.path}`);
      if (o.kind === "command") {
        const req = doc.components.schemas[`${o.operationId}Request`];
        assert.deepEqual(Object.keys(req.properties), o.registry.fields.map(([n]) => n), `${o.operationId}: request members are exactly the registry fields`);
        assert.equal(req.additionalProperties, false, `${o.operationId}: closed request`);
        const command = combined["commands.json"].find((c) => c.id === o.command);
        assert.deepEqual(command.fields.map((f) => f.name), Object.keys(req.properties), `${o.operationId}: the registry command and the request agree`);
      }
      const component = doc.components.schemas[o.response.contract];
      const def = bndl.$defs[o.response.contract];
      assert.deepEqual(Object.keys(component.properties), Object.keys(def.properties), `${o.operationId}: the reply is the registry contract ${o.response.contract}`);
      assert.deepEqual(component.required, def.required, `${o.operationId}: same required members as the registry`);
    }
  }
  const refs = JSON.stringify(doc).match(/#\/components\/(schemas|parameters)\/[A-Za-z]+/g) ?? [];
  for (const r of refs) {
    const [, , kind, name] = r.split("/");
    assert.ok(doc.components[kind][name], `${r} resolves inside the document`);
  }
  for (const [name, p] of Object.entries(doc.components.parameters)) assert.deepEqual(p, served.components.parameters[name], `parameter ${name} is the served one`);
  for (const [key, mod] of Object.entries(doc["x-kauro-modified"])) {
    for (const [name, c] of Object.entries(mod.components)) {
      if (c.new) assert.ok(!served.components.schemas[name], `${name} is new`);
      else assert.equal(c.baseSha256, canonicalHash(served.components.schemas[name]), `${key}: ${name} was written against the served component (re-verify after the served api changed)`);
    }
  }
  // shared shapes: the request vocabulary is the served api's own
  const sa = doc.components.schemas.RecordConsentRequest.properties;
  assert.deepEqual(sa.documentVersion, served.components.schemas.StartAuditRequest.properties.auditPolicyVersion, "label is the served label");
  assert.deepEqual(doc.components.schemas.WithdrawConsentRequest.properties.expectedVersion, served.components.schemas.ArchiveClientRequest.properties.expectedVersion, "version is the served version");
  assert.deepEqual(doc.components.schemas.ApplyDemonstratedBatchRequest.properties.previewHash, served.components.schemas.ApprovePlanRequest.properties.planHash, "hash is the served hash");
  assert.deepEqual(doc.components.schemas.RefuseAttributionRequest.properties.evidenceRef, served.components.schemas.StartAuditRequest.properties.targetContractId, "id is the served id");
}

test("OpenAPI: the committed files are the generated ones", () => {
  for (const [path, body] of generatedOutputs(built)) assert.equal(readFileSync(path, "utf8"), body, `${path} is current (node tools/cp02.mjs generate)`);
  const tampered = clone(openapi);
  tampered.paths["/api/v1/projects/{projectId}/dates"].get.summary = "edited by hand";
  assert.notEqual(JSON.stringify(tampered, null, 2) + "\n", readFileSync(PATHS.openapi, "utf8"), "a hand edit is visible as drift");
});

test("OpenAPI: requests are the registry fields, replies the registry contracts, shapes the served api's, no served route collides", () => {
  checkOpenapi(spec, openapi, live, bundle);
  const d1 = clone(openapi);
  delete d1.components.schemas.RecordConsentRequest.properties.channel;
  mustFail(() => checkOpenapi(spec, d1, live, bundle), /registry fields/, "a request that drops a registry field");
  const d2 = clone(openapi);
  d2.paths["/api/v1/projects/{projectId}"] = { get: d2.paths["/api/v1/projects/{projectId}/dates"].get };
  mustFail(() => checkOpenapi(spec, d2, live, bundle), /served route/, "a proposed route on a served path");
  const l3 = clone(live);
  l3.components.schemas.RetentionExtensionView.properties.extensionId.description = "changed on main";
  mustFail(() => checkOpenapi(spec, openapi, l3, bundle), /written against the served component/, "a served component that moved under the proposal");
  const d4 = clone(openapi);
  d4.components.schemas.ProjectDates.required = ["projectId"];
  mustFail(() => checkOpenapi(spec, d4, live, bundle), /same required members/, "a reply that differs from the registry contract");
});

test("OpenAPI: the web client generator (the browser's consumer) translates the proposed and modified operations", () => {
  const merged = clone(live);
  merged["x-kauro-planned"] = {};
  for (const [p, methods] of Object.entries(openapi.paths)) for (const [m, o] of Object.entries(methods)) {
    const op = clone(o);
    if (op.responses["200"]?.content?.["text/csv"]) op.responses["200"] = { description: op.responses["200"].description };
    merged["x-kauro-planned"][`${m.toUpperCase()} ${p}`] = op;
  }
  Object.assign(merged.components.schemas, clone(openapi.components.schemas));
  const { text: ts, failures } = generateWebClient(JSON.stringify(merged));
  assert.deepEqual(failures, [], "the closed web client generator translates every construct");
  for (const name of ["ProjectDates", "RetentionExtensionView", "StatementBalanceView", "SellerClaimView"]) assert.match(ts, new RegExp(`\\b${name}\\b`), `${name} is translated`);
  assert.match(ts, /"RETAINER"/, "the widened statement item kind reaches the client");
});

// --- 8. compatibility ------------------------------------------------------------------------------------------------------

function checkCompatibility(s, m) {
  const declared = new Map(s.compatibility.map((d) => [d.key, d]));
  const computed = m.changes.filter((c) => RANK[c.class] >= 1);
  for (const c of computed) {
    const d = declared.get(c.key);
    assert.ok(d, `${c.key} (${c.class}) can break a current consumer and is not declared`);
    assert.equal(d.class, c.class, `${c.key}: declared ${d.class}, computed ${c.class}`);
    assert.ok(d.migration, `${c.key}: declares its migration`);
    if (c.class === "BREAKING") {
      assert.ok(d.acceptedBy && s.authorities[d.acceptedBy]?.standing === "APPROVED", `${c.key}: a breaking change names the approved decision that accepted it`);
      assert.ok(!/^CP-02/.test(c.source) || s.items.find((i) => i.id === c.source)?.class !== "APPROVED_AWAITING_REISSUE", `${c.key}: an approved CP-02 item breaks no consumer`);
    }
  }
  for (const key of declared.keys()) assert.ok(computed.some((c) => c.key === key), `${key} is declared but no longer computed`);
}

test("compatibility: every change that can break a current consumer is computed, declared with its class, and its consumers found", () => {
  checkCompatibility(spec, matrix);
  assert.ok(matrix.changes.some((c) => c.class === "BREAKING" && c.source === "CP-01"), "CP-01.01's Audit.targetContractId is in the matrix");
  assert.ok(matrix.changes.filter((c) => c.class === "COORDINATED").every((c) => Array.isArray(c.consumers)), "consumers searched for every coordinated change");
  assert.ok(matrix.changes.find((c) => c.key === "OPENAPI:components/CommissionStatementView.balance:PROPERTY_ADDED").consumers.includes("apps/web/src/api/generated.ts"), "the web client is found as a consumer of a closed reply");
  const s1 = clone(spec);
  s1.compatibility.find((d) => d.class === "COORDINATED").class = "ADDITIVE";
  mustFail(() => checkCompatibility(s1, matrix), /declared ADDITIVE, computed COORDINATED/, "a coordinated change declared harmless");
  const s2 = clone(spec);
  s2.compatibility.pop();
  mustFail(() => checkCompatibility(s2, matrix), /not declared/, "an undeclared change");
  const s3 = clone(spec);
  s3.compatibility.find((d) => d.class === "BREAKING").acceptedBy = "F-33";
  mustFail(() => checkCompatibility(s3, matrix), /approved decision/, "a breaking change accepted by a proposal");
});

test("compatibility: the classifier finds real breaks (removal, type, required, closed replies, enums)", () => {
  const reg = clone(registry);
  const audit = reg["contracts.json"].find((c) => c.name === "Audit");
  audit.fields = audit.fields.filter((f) => f.name !== "grantId");
  audit.fields.find((f) => f.name === "cancelVersion").type = "label";
  audit.fields.find((f) => f.name === "candidateManifestHash").required = true;
  audit.fields.find((f) => f.name === "state").type = "enum:QUEUED,FAILED";
  const quote = reg["contracts.json"].find((c) => c.name === "Quote");
  quote.fields.push({ name: "note", type: "text", required: true, description: "" });
  const changes = registryChanges(registry, reg).map((c) => `${c.subject}:${c.change}:${c.class}`);
  for (const expected of [
    "contracts.json:Audit.grantId:FIELD_REMOVED:BREAKING",
    "contracts.json:Audit.cancelVersion:TYPE_CHANGED:BREAKING",
    "contracts.json:Audit.candidateManifestHash:OPTIONAL_TO_REQUIRED:BREAKING",
    "contracts.json:Audit.state:TYPE_CHANGED:BREAKING",
    "contracts.json:Quote.note:FIELD_ADDED:BREAKING",
  ]) assert.ok(changes.includes(expected), `found ${expected}`);
  const proposed = { paths: {}, "x-kauro-modified": { X: { item: "T", components: {
    StartAuditRequest: { direction: "request", proposed: { ...clone(live.components.schemas.StartAuditRequest), required: ["targetContractId", "auditPolicyVersion", "extra"], properties: { ...live.components.schemas.StartAuditRequest.properties, extra: { type: "string" } } } },
    QuoteView: { direction: "response", proposed: (() => { const q = clone(live.components.schemas.QuoteView); q.required = q.required.filter((r) => r !== "issuedAt"); q.properties.state.enum = q.properties.state.enum.slice(0, 3); return q; })() },
  }, outcomes: {} } } };
  const api = openapiChanges(live, proposed).map((c) => `${c.subject}:${c.change}:${c.class}`);
  assert.ok(api.includes("components/StartAuditRequest.extra:PROPERTY_ADDED:BREAKING"), "a new required request member breaks clients");
  assert.ok(api.includes("components/QuoteView.issuedAt:REQUIRED_TO_OPTIONAL:BREAKING"), "a reply member that may disappear breaks readers");
  assert.ok(api.includes("components/QuoteView.state:ENUM_NARROWED:ADDITIVE"), "a narrower reply vocabulary is safe for readers");
});

test("compatibility: the matrix covers CP-01 + CP-02 and attributes each change", () => {
  const recomputed = compatibility(spec, registry, cp01, cp02, live, openapi);
  assert.deepEqual(recomputed.map((c) => c.key), matrix.changes.map((c) => c.key), "the committed matrix is the computed one");
  for (const c of matrix.changes) assert.ok(c.source, `${c.key}: attributed`);
  for (const id of ["CP-02.01", "CP-02.04", "CP-02.10"]) assert.ok(matrix.changes.some((c) => c.source.includes(id)), `${id} has its changes`);
});

// --- 9. examples -----------------------------------------------------------------------------------------------------------

function examplesCompiler(doc, bndl) {
  const strip = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k.startsWith("x-") ? undefined : v)).replaceAll("#/components/schemas/", "#/$defs/"));
  const defs = { ...bndl.$defs };
  for (const [name, schema] of Object.entries(doc.components.schemas)) if (!defs[name]) defs[name] = strip(schema);
  const roots = {};
  for (const key of Object.keys(spec.examples)) {
    const [kind, name] = key.split(":");
    roots[key] = kind === "contract" ? bndl.$defs[name] : strip(doc.components.schemas[name]);
    assert.ok(roots[key], `${key} names a schema`);
  }
  return application.compileSchemaBundle({ defs, roots });
}

function checkExamples(examples, compiled) {
  for (const [key, { valid, invalid }] of Object.entries(examples)) {
    for (const [i, v] of valid.entries()) assert.deepEqual(compiled.validate(key, v), [], `${key} valid[${i}] passes`);
    for (const bad of invalid) {
      const errors = compiled.validate(key, bad.value);
      assert.ok(errors.some((e) => e.field === bad.error.field && e.code === bad.error.code), `${key}: "${bad.why}" fails with ${bad.error.field} ${bad.error.code} (got ${JSON.stringify(errors)})`);
    }
  }
}

test("examples: valid examples pass and invalid ones fail with their error, under the api's strict validator", () => {
  const compiled = examplesCompiler(openapi, bundle);
  checkExamples(spec.examples, compiled);
  assert.ok(Object.keys(spec.examples).length >= 12 && Object.values(spec.examples).every((e) => e.valid.length > 0 && e.invalid.length > 0), "every example set has both sides");
  const e1 = clone(spec.examples);
  e1["contract:PriceEstimate"].invalid.push({ why: "not actually invalid", value: e1["contract:PriceEstimate"].valid[0], error: { field: "nature", code: "ENUM" } });
  mustFail(() => checkExamples(e1, compiled), /fails with/, "an invalid example that passes");
  const e2 = clone(spec.examples);
  e2["contract:SellerClaimView"].valid.push({ ...e2["contract:SellerClaimView"].valid[0], evidenceRef: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });
  mustFail(() => checkExamples(e2, compiled), /passes/, "a valid example the contract refuses");
});

// --- 10. nothing adopted --------------------------------------------------------------------------------------------------

test("nothing is adopted: the registry, the served api and the generated client are unchanged, and new records never carry the old brand", () => {
  const provenance = loadProvenance();
  for (const [file, hash] of Object.entries(provenance.files)) assert.equal(sha256(readFileSync(join(PATHS.registry, file))), hash, `${file} untouched`);
  assert.equal(openapi.info["x-kauro-base"].openapi, sha256(readFileSync(PATHS.liveOpenapi)), "the proposal was generated against the served api on disk");
  assert.equal(openapi["x-kauro-status"], "PROPOSED_NOT_ADOPTED");
  for (const p of Object.values(openapi.paths)) for (const o of Object.values(p)) assert.notEqual(o["x-kauro-class"], "ADOPTED");
  const added = JSON.stringify(cp02.items.map((i) => Object.values(i.patch).flat().filter((op) => op.op !== "test").map((op) => op.value)));
  assert.doesNotMatch(added, /\bKAVO|\bkavo/, "amendment A2: new registry text is Kauro's");
  assert.ok(createHash, "node:crypto");
});

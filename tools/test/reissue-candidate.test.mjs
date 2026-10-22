// Order 19A: the joint re-issue candidate of CP-01 (revision 3) and CP-02, checked before anyone adopts it (tools/reissue/reissue.mjs).
//
// Each rule is a function that throws on the first violation. It runs once on the real candidate (it must pass) and once or more on a
// deliberately broken copy (it must fail for its own reason): a rule that cannot fail proves nothing (the convention of
// cp02-api-contracts.test.mjs). Broken copies live in memory or in a temporary directory; nothing in the repository is written.
//
// What is proved:
//   - the bytes in force (the registry, the served api, the generated web client and contracts) are the ones the candidate recorded, and
//     the ones CP-02 was written against: Order 19A changed none of them;
//   - the candidate is current: every committed file is the generated one, from pinned inputs;
//   - the two deltas are disjoint, and every place where items meet is declared with its resolution;
//   - each item carries exactly its recorded state, its legal effect, and who must satisfy each of its conditions;
//   - the profiles are closed sets of the admitted states, and nothing undecided reaches either;
//   - the contract rules of CP-01 and CP-02 hold on each candidate registry, contracts bundle, served document and web client;
//   - the compatibility matrix of CP-01 + CP-02, the 271 changes recorded before Order 17's final review and the 11 it added, is
//     revalidated on the candidate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IN_FORCE, OUTPUTS, PATHS, PROFILES, ROOT, buildAll, candidateDocument, changesDigest, checkClosed, checkCompatibility, checkConflicts,
  checkInForce, checkInputs, checkSatisfiers, checkStates, compatibilityCore, componentCollisions, computeConflicts, generateContracts,
  generatedOutputs, isCurrent, itemsOf, pendingCounselItems, profileItems, recordedStates, registryFiles, webClientInput,
} from "../reissue/reissue.mjs";
import { renderClient, digestOf } from "../web-client.mjs";

const built = await buildAll();
const { source, spec, registry, cp01, cp02, items, conflicts, profiles, fullChanges, manifest, live, application } = built;
const clone = (v) => structuredClone(v);
const createHashHex = (b) => createHash("sha256").update(b).digest("hex");
const RANK = { ADDITIVE: 0, TEXT: 0, COORDINATED: 1, BREAKING: 2 };
const ids = (p) => profiles[p].ids;
const delta = (id) => items.find((i) => i.delta.id === id).delta;

/** Expects `fn` to fail on a broken copy, and the failure to be the rule's (not a crash of the copy). */
function mustFail(fn, pattern, label) {
  assert.throws(fn, pattern, `the rule did not catch: ${label}`);
}

/** A reader that answers `bytes` for one path and the disk for every other. */
const substitute = (path, bytes) => (p) => (p === path ? bytes : readFileSync(p));

// --- 1. in force and inputs ----------------------------------------------------------------------------------------------------

test("in force: the registry, the served api, the generated web client and contracts are byte-identical to the recorded ones", () => {
  checkInForce(manifest.inForce);
  // the same bytes CP-02 was written against (Order 17's base): Order 19A changed none of them
  const cp02Base = JSON.parse(readFileSync(PATHS.cp02Openapi, "utf8")).info["x-kauro-base"];
  assert.equal(manifest.inForce["apps/api/openapi.json"], cp02Base.openapi, "the served api is CP-02's base");
  assert.equal(manifest.inForce["apps/web/src/api/generated.ts"], cp02Base.webClient, "the web client is CP-02's base");
  for (const [file, hash] of Object.entries(cp02Base.registry)) assert.equal(manifest.inForce[`packages/contracts/registry/${file}`], hash, `${file} is CP-02's base`);
  // and the committed web client is still the one generated from the served api alone: no candidate operation reached it
  const served = readFileSync(IN_FORCE.openapi, "utf8");
  assert.equal(renderClient(JSON.parse(served), digestOf(served)).text, readFileSync(IN_FORCE.webClient, "utf8"));
  assert.doesNotMatch(readFileSync(IN_FORCE.webClient, "utf8"), /\bProjectDates\b|\bOwnerSellerRecordView\b/, "no candidate type in the client in force");

  const flip = (path) => {
    const bytes = Buffer.from(readFileSync(path));
    bytes[bytes.length - 2] ^= 1;
    return bytes;
  };
  mustFail(() => checkInForce(manifest.inForce, substitute(IN_FORCE.openapi, flip(IN_FORCE.openapi))), /apps\/api\/openapi\.json in force/, "an edited served api");
  mustFail(() => checkInForce(manifest.inForce, substitute(IN_FORCE.webClient, flip(IN_FORCE.webClient))), /generated\.ts in force/, "an edited web client");
  mustFail(() => checkInForce(manifest.inForce, substitute(IN_FORCE.contractsTypes, flip(IN_FORCE.contractsTypes))), /types\.ts in force/, "edited generated contracts");
  const policy = join(IN_FORCE.registry, "policy.json");
  mustFail(() => checkInForce(manifest.inForce, substitute(policy, flip(policy))), /no longer matches its PROVENANCE/, "an edited registry file");
  const provenance = join(IN_FORCE.registry, "PROVENANCE.json");
  const reVendored = JSON.parse(readFileSync(provenance, "utf8"));
  reVendored.source = "a silent re-vendor";
  mustFail(() => checkInForce(manifest.inForce, substitute(provenance, Buffer.from(JSON.stringify(reVendored, null, 2)))), /PROVENANCE\.json in force/, "a re-vendored provenance");
  const fewer = { ...manifest.inForce };
  delete fewer["apps/api/openapi.json"];
  mustFail(() => checkInForce(fewer), /not recorded/, "a file in force the candidate does not record");
});

test("inputs: the candidate is prepared from the pinned proposals and records, and refuses any other bytes", () => {
  checkInputs(source);
  assert.equal(source.inputs.pins["CP-01.registry-delta.json"], spec.complementOf.sha256, "the same CP-01 revision CP-02 pins");
  assert.equal(cp01.revision, 3);
  const bump = (path) => Buffer.from(`${readFileSync(path, "utf8")} `);
  mustFail(() => checkInputs(source, substitute(PATHS.cp01Delta, bump(PATHS.cp01Delta))), /re-verify the candidate/, "a changed CP-01 delta");
  mustFail(() => checkInputs(source, substitute(PATHS.cp02Spec, bump(PATHS.cp02Spec))), /CP-02\.api\.json/, "a changed CP-02 source");
  const resolution = join(ROOT, source.inputs.ownerResolution);
  mustFail(() => checkInputs(source, substitute(resolution, bump(resolution))), /carries its states from/, "a changed owner resolution");
  // the consumer lists of CP-02's matrix follow unrelated code and never make the candidate stale; its changes do
  const compat = JSON.parse(readFileSync(PATHS.cp02Compatibility, "utf8"));
  const moreConsumers = clone(compat);
  moreConsumers.changes.find((c) => c.consumers).consumers.push("apps/new-consumer.ts");
  checkInputs(source, substitute(PATHS.cp02Compatibility, Buffer.from(JSON.stringify(moreConsumers))));
  const reclassed = clone(compat);
  reclassed.changes.find((c) => c.class === "COORDINATED").class = "ADDITIVE";
  mustFail(() => checkInputs(source, substitute(PATHS.cp02Compatibility, Buffer.from(JSON.stringify(reclassed)))), /without consumers/, "a reclassified compatibility change");
  mustFail(() => checkInputs({ ...source, inputs: { ...source.inputs, pins: { ...source.inputs.pins, "CP-03.registry-delta.json": "0".repeat(64) } } }), /not an input/, "a pin of an unknown input");
});

test("freshness: every committed candidate file is the generated one", () => {
  const outputs = generatedOutputs(built);
  assert.equal(outputs.length, 2 + PROFILES.length * Object.keys(OUTPUTS).length);
  for (const output of outputs) assert.ok(isCurrent(output), `${output[0]} is the generated file (run node tools/reissue/reissue.mjs generate)`);
  for (const p of PROFILES) {
    for (const [file, hash] of Object.entries(manifest.profiles[p].outputs)) assert.equal(createHashHex(readFileSync(join(PATHS.dir, file))), hash, `${file}: the manifest records its hash`);
  }
  assert.equal(manifest.inputs.combinedDelta, createHashHex(readFileSync(PATHS.combined)), "the manifest records the combined delta's hash");
  const [path, bytes] = outputs[0];
  const stale = Buffer.concat([bytes, Buffer.from(" ")]);
  assert.equal(isCurrent([path, stale]), false, "a stale output is found");
  assert.equal(isCurrent([join(PATHS.dir, "missing.json"), bytes]), false, "a missing output is found");
});

// --- 2. the combined delta -----------------------------------------------------------------------------------------------------

test("disjoint patches: no path is written by two items, no item proves a value another changes, nested adds only on a dependency", () => {
  const forbidden = conflicts.filter((c) => ["WRITE_WRITE_OVERLAP", "TEST_OF_A_PATH_ANOTHER_ITEM_WRITES"].includes(c.kind));
  assert.deepEqual(forbidden, []);
  for (const i of built.combined.items) assert.deepEqual(i.patch, delta(i.id).patch, `${i.id}: the combined delta carries the item's ops unchanged`);
  assert.deepEqual(built.combined.items.map((i) => i.id), [...cp01.items, ...cp02.items].map((d) => d.id), "CP-01's items, then CP-02's, each in order");

  const withOps = (id, file, ops) => {
    const copy = itemsOf(clone(cp01), clone(cp02));
    const target = copy.find((i) => i.delta.id === id);
    target.delta.patch[file] = [...(target.delta.patch[file] ?? []), ...ops];
    return copy;
  };
  const cmd020 = registry["commands.json"].findIndex((c) => c.id === "CMD020");
  const overwrite = withOps("CP-02.03", "commands.json", [{ op: "test", path: `/${cmd020}/id`, value: "CMD020" }, { op: "replace", path: `/${cmd020}/precondition`, value: "x" }]);
  assert.ok(computeConflicts(registry, overwrite).some((c) => c.kind === "WRITE_WRITE_OVERLAP" && c.items.join() === "CP-01.01,CP-02.03"), "the overlap is computed");
  mustFail(() => checkConflicts(source.conflicts, computeConflicts(registry, overwrite)), /CP-01\.01 and CP-02\.03: two items may never write the same/, "a CP-02 write on a path CP-01.01 changes");
  const audit = registry["contracts.json"].findIndex((c) => c.name === "Audit");
  const prove = withOps("CP-02.02", "contracts.json", [{ op: "test", path: `/${audit}/fields`, value: registry["contracts.json"][audit].fields }]);
  mustFail(() => checkConflicts(source.conflicts, computeConflicts(registry, prove)), /TEST_OF_A_PATH_ANOTHER_ITEM_WRITES/, "a CP-02 test of a value CP-01.01 changes");
  const orphan = itemsOf(clone(cp01), clone(cp02));
  orphan.find((i) => i.delta.id === "CP-01.07").delta.dependsOn = [];
  mustFail(() => checkConflicts(source.conflicts, computeConflicts(registry, orphan)), /WRITE_WRITE_OVERLAP on policy\.json\/alerts/, "a nested add without its dependency");
});

test("conflicts: every place where two items meet is declared with its resolution, and no declaration is stale", () => {
  checkConflicts(source.conflicts, conflicts);
  assert.equal(conflicts.length, 20);
  assert.deepEqual(new Set(conflicts.map((c) => c.kind)), new Set(["APPENDS_TO_THE_SAME_ARRAY", "KEYS_ADDED_TO_THE_SAME_OBJECT", "NESTED_ADD_ON_A_DEPENDENCY", "SAME_RECORD_DISJOINT_MEMBERS"]));
  for (const c of manifest.conflicts) assert.ok(c.resolution.length > 40, `${c.entity}: the manifest carries the resolution`);
  mustFail(() => checkConflicts(source.conflicts.slice(1), conflicts), /is not declared/, "an undeclared meeting point");
  mustFail(() => checkConflicts([...source.conflicts, { kind: "SAME_RECORD_DISJOINT_MEMBERS", entity: "screens.json[6] UI07", items: ["CP-01.08", "CP-01.09"], resolution: "a resolution of something that does not happen" }], conflicts), /no longer computed/, "a stale declaration");
  const wrongItems = clone(source.conflicts);
  wrongItems.find((d) => d.entity === "screens.json[2] UI03").items = ["CP-01.08"];
  mustFail(() => checkConflicts(wrongItems, conflicts), /declared between/, "a declaration naming other items");
  const noReason = clone(source.conflicts);
  noReason[0].resolution = "ok";
  mustFail(() => checkConflicts(noReason, conflicts), /no resolution/, "a declaration without a resolution");
});

test("component names: a proposed component that clashes with a served one is renamed by a declared resolution, never merged over it", () => {
  for (const p of PROFILES) {
    const doc = profiles[p].document;
    assert.deepEqual(componentCollisions(live, profiles[p].proposal), ["SellerRecordView", "SupportCasePage"], `${p}: the two clashes`);
    assert.deepEqual(doc.components.schemas.SellerRecordView, live.components.schemas.SellerRecordView, `${p}: the served SellerRecordView is kept`);
    assert.deepEqual(doc.components.schemas.SupportCasePage, live.components.schemas.SupportCasePage, `${p}: the served SupportCasePage is kept`);
    assert.equal(doc.components.schemas.OwnerSellerRecordView["x-kauro-schema-id"], "urn:kauro:r2:contracts#/$defs/SellerRecordView", `${p}: the renamed component keeps its registry id`);
    const getSellerRecord = Object.values(doc["x-kauro-planned"]).find((o) => o.operationId === "GetSellerRecord");
    assert.match(JSON.stringify(doc.components.schemas[getSellerRecord.responses["200"].content["application/json"].schema.$ref.split("/").at(-1)]), /OwnerSellerRecordView/, `${p}: GetSellerRecord answers the renamed component`);
    assert.match(JSON.stringify(doc.components.schemas.ListAgencySupportCasesReply), /AgencySupportCasePage/, `${p}: the agency's support cases answer the renamed page`);
  }
  for (const [name, r] of Object.entries(source.componentRenames)) assert.ok(ids("adoption").includes(r.item), `${name}: renamed for an item of the adoption profile`);
  const proposal = profiles.build.proposal;
  mustFail(() => candidateDocument(live, proposal, {}, {}), /collide with served ones: SellerRecordView, SupportCasePage/, "a clash without a declared rename");
  mustFail(() => candidateDocument(live, proposal, {}, { SellerRecordView: { to: "OwnerSellerRecordView" } }), /renamed by the source: SellerRecordView;?/, "one clash left undeclared");
  mustFail(() => candidateDocument(live, proposal, {}, { ...source.componentRenames, SupportCasePage: { to: "SupportCaseView" } }), /the name is taken/, "a rename onto a served name");
  const sneaky = clone(proposal);
  sneaky.components.schemas.AuditView = { ...sneaky.components.schemas.AuditView, description: "replaced" };
  for (const mod of Object.values(sneaky["x-kauro-modified"])) delete mod.components.AuditView;
  mustFail(() => candidateDocument(live, sneaky, {}, source.componentRenames), /collide/, "a served component replaced without a declared modification");
});

// --- 3. states, profiles, conditions -------------------------------------------------------------------------------------------

test("states: every item carries exactly the state of its record, the owner resolution for CP-01 and Order 17's classes for CP-02", () => {
  const recorded = recordedStates(readFileSync(join(ROOT, source.inputs.ownerResolution), "utf8"), readFileSync(join(ROOT, spec.document), "utf8"));
  checkStates(source, items, recorded);
  assert.equal(Object.keys(recorded.cp01).length, 14);
  assert.equal(Object.keys(recorded.cp02).length, 21);
  const count = (state) => items.filter((i) => i.state === state).length;
  assert.deepEqual([count("APPROVED_AWAITING_REISSUE"), count("CONDITIONAL"), count("PROPOSED")], [26, 5, 4]);
  assert.deepEqual(items.filter((i) => i.class === "BLOCKED_EXTERNAL").map((i) => i.delta.id), ["CP-02.17", "CP-02.19"]);
  assert.equal(delta("CP-01.09").deferred.currentTextStays, true, "CP-01.09 deferred: the current UI03 text stays");
  for (const i of manifest.items.filter((x) => x.proposal === "CP-02")) assert.equal(i.decision, "OWNER_DECISION_PENDING_CP-02_SECTION_8", `${i.id}: CP-02's decision block is still empty`);
  assert.ok(readFileSync(join(ROOT, spec.document), "utf8").includes("| CP-02.01 | | | |"), "CP-02 section 8 is empty: no owner decision is claimed");
  for (const i of manifest.items) assert.notEqual(i.state, "ADOPTED");

  const promoted = itemsOf(clone(cp01), clone(cp02));
  promoted.find((i) => i.delta.id === "CP-01.10").state = "APPROVED_AWAITING_REISSUE";
  mustFail(() => checkStates(source, promoted, recorded), /CP-01\.10: the owner resolution records CONDITIONAL/, "a CONDITIONAL item promoted");
  const unblocked = itemsOf(clone(cp01), clone(cp02));
  unblocked.find((i) => i.delta.id === "CP-02.17").class = "CONDITIONAL";
  mustFail(() => checkStates(source, unblocked, recorded), /CP-02\.17: CP-02's record classes it BLOCKED_EXTERNAL/, "a blocked item reclassed");
  const declared = clone(source);
  declared.items["CP-01.09"].state = "APPROVED_AWAITING_REISSUE";
  mustFail(() => checkStates(declared, items, recorded), /CP-01\.09: the source declares/, "the source declaring a deferred item approved");
  const edited = recordedStates(readFileSync(join(ROOT, source.inputs.ownerResolution), "utf8").replace("| `CONDITIONAL`, values recorded |", "| `APPROVED_AWAITING_REISSUE` |"), readFileSync(join(ROOT, spec.document), "utf8"));
  mustFail(() => checkStates(source, items, edited), /CP-01\.11/, "a resolution that says otherwise");
});

test("profiles: adoption holds the approved items, build adds the conditional ones, neither holds a proposed item; both are closed", () => {
  assert.deepEqual(ids("adoption"), items.filter((i) => i.state === "APPROVED_AWAITING_REISSUE").map((i) => i.delta.id));
  assert.deepEqual(ids("build"), items.filter((i) => i.state !== "PROPOSED").map((i) => i.delta.id));
  for (const id of ["CP-01.09", "CP-02.16", "CP-02.18", "CP-02.21"]) for (const p of PROFILES) assert.ok(!ids(p).includes(id), `${id} (PROPOSED) is in no profile`);
  for (const id of ["CP-01.10", "CP-01.11", "CP-02.17", "CP-02.19", "CP-02.20"]) {
    assert.ok(!ids("adoption").includes(id), `${id} (CONDITIONAL) is not adoptable`);
    assert.ok(ids("build").includes(id), `${id} is in the build profile, behind its activation`);
  }
  for (const p of PROFILES) checkClosed(items, ids(p), p);
  mustFail(() => checkClosed(items, ids("adoption").filter((id) => id !== "CP-01.06"), "adoption"), /CP-01\.07 needs CP-01\.06/, "a dependency left out");
  mustFail(() => checkClosed(items, ids("adoption").filter((id) => id !== "CP-01.12"), "adoption"), /CP-02\.15 needs CP-01\.12/, "a required CP-01 item left out");
  mustFail(() => checkClosed(items, [...ids("adoption"), "CP-02.17"], "adoption"), /CP-02\.17 needs CP-01\.11/, "a blocked item without the conditional item it requires");
  const widened = clone(source);
  widened.profiles.adoption.states.push("PROPOSED");
  assert.ok(profileItems(widened, items, "adoption").includes("CP-01.09"), "the profile follows the states it admits (and the test above pins them)");
});

test("conditions: every activation and pending condition names the orders or gates that must satisfy it before Order 19B activates it", () => {
  checkSatisfiers(source, items);
  for (const i of manifest.items) {
    const d = delta(i.id);
    assert.equal(i.conditions.length, (d.activation ?? []).length + (d.pending ?? []).length, `${i.id}: every condition is carried`);
    for (const c of i.conditions) assert.ok(c.text === (d[c.kind] ?? [])[i.conditions.filter((x) => x.kind === c.kind).indexOf(c)], `${i.id}: the condition's words are the delta's`);
  }
  const orders = new Set(manifest.items.flatMap((i) => i.implementingOrders));
  for (const o of ["O20", "O21", "O22", "O24", "O27A", "CORE"]) assert.ok(orders.has(o), `${o} satisfies at least one condition`);
  assert.deepEqual(manifest.items.find((i) => i.id === "CP-02.01").implementingOrders, ["O20"]);
  assert.ok(manifest.items.find((i) => i.id === "CP-01.11").conditions.some((c) => c.by.includes("O27B")), "the hold waits for PV1 (O27B)");
  assert.ok(manifest.residual.some((r) => /UNASSIGNED_C4/.test(r)), "the unassigned handlers are reported");

  const missing = clone(source);
  missing.items["CP-01.02"].activationBy = [["O21"]];
  mustFail(() => checkSatisfiers(missing, items), /CP-01\.02: 2 activation conditions, 1 satisfier/, "a condition nobody satisfies");
  const unknown = clone(source);
  unknown.items["CP-02.09"].activationBy = [["O99"]];
  mustFail(() => checkSatisfiers(unknown, items), /O99, which is no known order/, "an unknown satisfier");
  const empty = clone(source);
  empty.items["CP-02.17"].pendingBy[0] = [];
  mustFail(() => checkSatisfiers(empty, items), /names no satisfier/, "an empty satisfier list");
});

test("legal effect: the claim rules (CP-01.04, CP-01.14, CP-02.14) stay PENDING_COUNSEL, without validation, in every profile", () => {
  const counsel = pendingCounselItems(items);
  assert.deepEqual(counsel, { state: "PENDING_COUNSEL", validation: null, items: ["CP-01.04", "CP-01.14", "CP-02.14"] });
  for (const id of counsel.items) assert.equal(manifest.items.find((i) => i.id === id).legalEffect, "PENDING_COUNSEL");
  assert.equal(manifest.items.find((i) => i.id === "CP-02.12").legalEffect, undefined, "reading the status carries no claim rule");
  for (const p of PROFILES) {
    const legal = profiles[p].applied["policy.json"].legalStatus["commission.claimRules"];
    assert.equal(legal.state, "PENDING_COUNSEL", `${p}: not legally approved`);
    assert.equal(legal.validation, null, `${p}: no review evidence claimed`);
  }
  const broken = itemsOf(clone(cp01), clone(cp02));
  broken.find((i) => i.delta.id === "CP-01.14").delta.patch["policy.json"].find((op) => op.path === "/legalStatus").value["commission.claimRules"].covers.push("commission.retainerDefaultCentsPerMonth");
  assert.ok(pendingCounselItems(broken).items.includes("CP-01.05"), "the rule follows what the legal status covers");
});

// --- 4. contract tests of both proposals on the candidate ----------------------------------------------------------------------

function policyLeaves(o, prefix = "") {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? policyLeaves(v, `${prefix}${k}.`) : [[`${prefix}${k}`, JSON.stringify(v)]]));
}

function checkCp01OnRegistry(profile, reg) {
  const policy = reg["policy.json"];
  for (const [key, value] of policyLeaves(registry["policy.json"])) assert.equal(JSON.stringify(key.split(".").reduce((o, k) => o?.[k], policy)), value, `${profile}: ${key} keeps its value (the public snapshot and the domain copies hold)`);
  assert.equal(policy.edition, registry["policy.json"].edition, `${profile}: the edition is Order 19B's to set`);
  const progress = policy.alerts.relevantProgress;
  assert.deepEqual(progress.affects, ["INACTIVITY_ALERT"], `${profile}: progress affects the inactivity alert only`);
  assert.deepEqual([...progress.neverExtends].sort(), ["LEGAL_DEADLINES", "QUOTE_VALIDITY", "RETENTION"]);
  assert.deepEqual(policy.identityResolution.deterministicMerge.onlyProvenIdentityKeys, ["SOURCE_RECORD_ID_WITHIN_ONE_IDENTITY_SPACE", "AUTHORITATIVE_EXTERNAL_ID_VERIFIED"]);
  assert.equal(policy.identityResolution.candidatesProveIdentity, false);
  assert.equal(policy.identityResolution.candidateDecision.maximumGroupsPerDecision, policy.api.batchItems);
  assert.deepEqual(policy.retention.extendHardCapExceptions, { UNPAID: { ceilingDaysFromSeal: 17, onlyThroughTheProjectExtension: true } });
  assert.equal(policy.retention.extendHardCap, false);
  assert.equal(policy.retention.policyVersion, "R2-RETENTION-2");
  assert.equal(policy.intelligence.freeAuditPauseBps, 9000);
  assert.equal(policy.commission.retainerDefaultCentsPerMonth, 0);
  assert.equal(policy.commission.collectionPeriod, "MONTH_OF_CONFIRMED_CAPTURE");
  assert.deepEqual(policy.commission.claimRefusalReasons.map((r) => r.code), ["CUSTOMER_OR_DIRECT_CONTACT", "OTHER_SELLER_LIVE_CLAIM", "OWNER_RULE", "INSUFFICIENT_OWN_WORK_EVIDENCE", "OUTSIDE_SELLER_AGREEMENT", "DUPLICATE_OWN_CLAIM", "OTHER"]);
  assert.deepEqual(policy.alerts.precedence, ["BLOCKED", "DEADLINE_PASSED", "DEADLINE_SOON", "INACTIVE"]);
  const audit = reg["contracts.json"].find((c) => c.name === "Audit");
  assert.equal(audit.fields.find((f) => f.name === "targetContractId").required, false, `${profile}: CLEAN needs no target (CP-01.01)`);
  const commands = new Map(reg["commands.json"].map((c) => [c.id, c]));
  for (const id of ["CMD020", "CMD060"]) {
    for (const op of ["CP-01.01", "CP-01.02"].flatMap((i) => delta(i).patch["commands.json"]).filter((o) => o.op === "replace")) {
      const index = Number(op.path.split("/")[1]);
      if (registry["commands.json"][index].id === id) assert.equal(commands.get(id)[op.path.split("/")[2]], op.value, `${profile}: ${id}'s text is CP-01's`);
    }
  }
  // CP-01.08's activation: the web's amended rows become the registry's own text, so the re-issue removes them
  const web = readFileSync(join(ROOT, "apps", "web", "test", "support", "registry.ts"), "utf8");
  for (const id of ["UI03", "UI07"]) {
    const amended = new RegExp(`${id}: \\{ text: "([^"]+)"`).exec(web)[1];
    assert.equal(reg["screens.json"].find((s) => s.id === id).primaryCopy, amended, `${profile}: ${id}'s registry copy is the web's amended copy`);
  }
  const ui03 = reg["screens.json"].find((s) => s.id === "UI03");
  const before = registry["screens.json"].find((s) => s.id === "UI03");
  for (const [k, v] of Object.entries(before)) if (k !== "primaryCopy") assert.deepEqual(ui03[k], v, `${profile}: UI03's ${k} stays (CP-01.09 deferred)`);
  const conditional = profile === "build";
  assert.equal(Object.hasOwn(policy.retention, "pendingPaymentHold"), conditional, `${profile}: the hold's policy only where CONDITIONAL items are`);
  assert.equal(reg["screens.json"].some((s) => s.id === "UI56"), conditional, `${profile}: UI56 only where CONDITIONAL items are`);
  const retentionClass = reg["contracts.json"].find((c) => c.name === "RetentionRecord").fields.find((f) => f.name === "class").type;
  assert.equal(retentionClass.includes("PENDING_PAYMENT_HOLD"), conditional, `${profile}: the hold's class only where CP-01.11 is`);
}

test("CP-01 on the candidate: every decided value is in each profile's registry, nothing deferred or conditional leaks into adoption", () => {
  for (const p of PROFILES) checkCp01OnRegistry(p, profiles[p].applied);
  const leaky = registryFiles(registry, cp01, cp02, [...ids("adoption"), "CP-01.11"]).applied;
  mustFail(() => checkCp01OnRegistry("adoption", leaky), /the hold's policy only where CONDITIONAL items are/, "a conditional item in the adoption registry");
  const deferred = registryFiles(registry, cp01, cp02, [...ids("adoption"), "CP-01.09"]).applied;
  mustFail(() => checkCp01OnRegistry("adoption", deferred), /UI03's .* stays/, "the deferred UI03 wording in the registry");
});

function checkCp02OnRegistry(profile, reg, bundle, members) {
  const commands = new Map(reg["commands.json"].map((c) => [c.id, c]));
  const cases = new Map(reg["cases.json"].map((c) => [c.id, c]));
  const requirements = new Map(reg["requirements.json"].map((r) => [r.id, r]));
  const gates = new Map(reg["gates.json"].map((g) => [g.id, g]));
  assert.equal(commands.size, reg["commands.json"].length, `${profile}: command ids are unique`);
  assert.equal(cases.size, reg["cases.json"].length, `${profile}: case ids are unique`);
  for (const item of spec.items) {
    const inside = members.includes(item.id);
    for (const c of item.commands) {
      assert.equal(commands.has(c.id), inside, `${profile}: ${c.id} (${item.id}) is present exactly when its item is`);
      if (!inside) continue;
      for (const t of commands.get(c.id).testIds) assert.ok(cases.has(t), `${profile}: ${c.id}'s case ${t} exists`);
    }
    for (const contract of [...item.contracts, ...(item.extraContracts ?? [])]) {
      assert.equal(Boolean(bundle.$defs[contract.name]), inside, `${profile}: ${contract.name} (${item.id}) is generated exactly when its item is`);
    }
    const own = [...cases.keys()].filter((k) => k.startsWith(`CP02-${item.id.slice(-2)}-`));
    assert.equal(own.length > 0, inside, `${profile}: ${item.id}'s acceptance cases follow it`);
  }
  for (const [id, c] of cases) {
    if (c.origin !== "CP02_C3_CONTRACT") continue;
    assert.deepEqual(requirements.get(`REQ-${id}`)?.caseIds, [id], `${profile}: ${id} has its requirement`);
    assert.ok(gates.get(c.gate)?.caseIds.includes(id), `${profile}: ${id} is listed in its gate ${c.gate}`);
  }
  // the registry's own invariants (packages/contracts/test/registry.test.ts) on the candidate
  const contracts = reg["contracts.json"];
  assert.deepEqual(Object.keys(bundle.$defs), contracts.map((c) => c.name), `${profile}: the generated bundle is the registry's contracts, in order`);
  for (const c of contracts) {
    const def = bundle.$defs[c.name];
    assert.deepEqual(Object.keys(def.properties), c.fields.map((f) => f.name), `${profile}: ${c.name} members`);
    assert.deepEqual(def.required, c.fields.filter((f) => f.required).map((f) => f.name), `${profile}: ${c.name} required members`);
    assert.equal(def.additionalProperties, false, `${profile}: ${c.name} is closed`);
  }
  const byName = new Map(contracts.map((c) => [c.name, c]));
  for (const m of reg["state_transitions.json"]) {
    const state = byName.get(m.contract)?.fields.find((f) => f.name === "state" || f.name === "status");
    assert.ok(state?.type.startsWith("enum:"), `${profile}: ${m.contract} has an enum state`);
    const states = new Set(state.type.slice(5).split(","));
    for (const t of m.transitions) assert.ok(states.has(t.from) && states.has(t.to), `${profile}: ${m.contract} ${t.from} -> ${t.to}`);
  }
  for (const c of reg["commands.json"]) assert.match(`${c.method} ${c.path}`, /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//, `${profile}: ${c.id} has a route`);
}

test("CP-02 on the candidate: commands, cases, requirements, gates and contracts follow their items, and the registry's own invariants hold", () => {
  for (const p of PROFILES) checkCp02OnRegistry(p, profiles[p].applied, profiles[p].bundle, ids(p));
  const counts = manifest.profiles.adoption.registry.counts;
  assert.equal(counts["commands.json"], "64 -> 76", "Order 19B updates the registry test's command count");
  assert.equal(counts["state_transitions.json"], "12 -> 14", "and its machine count");
  const missingGate = clone(profiles.adoption.applied);
  const gate = missingGate["gates.json"].find((g) => g.id === "G-COMMERCIAL");
  gate.caseIds = gate.caseIds.filter((id) => !id.startsWith("CP02-07-"));
  mustFail(() => checkCp02OnRegistry("adoption", missingGate, profiles.adoption.bundle, ids("adoption")), /is listed in its gate/, "a case missing from its gate");
  mustFail(() => checkCp02OnRegistry("adoption", profiles.build.applied, profiles.build.bundle, ids("adoption")), /CMD078 \(CP-02\.17\) is present exactly when/, "a blocked item's command in the adoption registry");
  const refused = Object.fromEntries(Object.entries(profiles.adoption.files).map(([f, b]) => [f, Buffer.from(b)]));
  const contracts = JSON.parse(refused["contracts.json"].toString("utf8"));
  contracts.at(-1).fields[0].type = "ref:NoSuchContract";
  refused["contracts.json"] = Buffer.from(`${JSON.stringify(contracts, null, 2)}\n`);
  mustFail(() => generateContracts(refused), /refused the candidate registry/, "a candidate the contracts generator refuses");
});

function resolves(doc) {
  const walk = (node, at) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${at}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref") {
          const [, kind, name] = /^#\/components\/(schemas|parameters|headers)\/(.+)$/.exec(v) ?? [];
          assert.ok(kind && doc.components[kind][name], `${at}: ${v} resolves`);
        } else walk(v, `${at}.${k}`);
      }
    }
  };
  walk(doc, "#");
}

function checkDocument(profile, doc, members) {
  assert.deepEqual(Object.keys(doc.paths), Object.keys(live.paths), `${profile}: every served route stays, and no planned one is served`);
  const modifiedOps = new Set(spec.items.filter((i) => members.includes(i.id)).flatMap((i) => i.modified.filter((m) => m.outcomes.length > 0).map((m) => m.operationId)));
  for (const [path, methods] of Object.entries(live.paths)) {
    for (const [m, o] of Object.entries(methods)) {
      const now = doc.paths[path][m];
      if (!modifiedOps.has(o.operationId)) assert.deepEqual(now, o, `${profile}: ${o.operationId} is served as it is`);
      else assert.deepEqual({ ...now, responses: undefined }, { ...o, responses: undefined }, `${profile}: ${o.operationId} changes only its outcomes`);
    }
  }
  const expected = spec.items.filter((i) => members.includes(i.id)).flatMap((i) => i.operations.map((o) => (o.kind === "command" ? i.commands.find((c) => c.id === o.command).name : o.operationId))).sort();
  assert.deepEqual(Object.values(doc["x-kauro-planned"]).map((o) => o.operationId).sort(), expected, `${profile}: the planned operations are exactly its items'`);
  for (const o of Object.values(doc["x-kauro-planned"])) assert.ok(members.includes(o["x-kauro-cp02-item"]), `${profile}: ${o.operationId} belongs to an item of the profile`);
  const operationIds = [...Object.values(doc.paths).flatMap((m) => Object.values(m)), ...Object.values(doc["x-kauro-planned"])].map((o) => o.operationId);
  assert.equal(new Set(operationIds).size, operationIds.length, `${profile}: operationIds are unique across served and planned`);
  resolves(doc);
  assert.equal(doc.info["x-kauro-candidate"].status, "CANDIDATE_NOT_ADOPTED");
  assert.doesNotMatch(JSON.stringify(doc["x-kauro-planned"]), /\bKAVO|\bkavo/, `${profile}: amendment A2, no old brand in planned operations`);
}

test("served document: the served api in force plus the profile's planned operations, modified components and outcomes; every reference resolves", () => {
  for (const p of PROFILES) checkDocument(p, profiles[p].document, ids(p));
  assert.equal(profiles.adoption.document.components.schemas.StartAuditRequest.required.includes("targetContractId"), false, "CP-02.01: the request member is optional");
  assert.equal(profiles.adoption.document.components.schemas.ActivateAgencyRequest.required.includes("billingProfileRef"), true, "CP-02.21 (PROPOSED) did not reach the document");
  const start = Object.values(profiles.adoption.document.paths["/api/v1/revisions/{revisionId}/audits"]).find((o) => o.operationId === "StartAudit");
  const reasons = start.responses["400"]["x-kauro-outcomes"].map((o) => o.reason);
  assert.ok(reasons.includes("TARGET_CONTRACT_REQUIRED") && reasons.includes("TARGET_NOT_APPLICABLE"), "StartAudit answers CP-02.01's reasons");
  assert.match(start.responses["400"].description, new RegExp(`the ${start.responses["400"]["x-kauro-outcomes"].length} outcomes`), "the Problem description counts them");
  const leaked = clone(profiles.adoption.document);
  leaked["x-kauro-planned"]["POST /api/v1/payment-orders/{orderId}/transfer-proofs"] = profiles.build.document["x-kauro-planned"]["POST /api/v1/payment-orders/{orderId}/transfer-proofs"] ?? { operationId: "RecordTransferProof", "x-kauro-cp02-item": "CP-02.17" };
  mustFail(() => checkDocument("adoption", leaked, ids("adoption")), /planned operations are exactly|belongs to an item/, "a blocked item's operation in the adoption document");
  const dangling = clone(profiles.adoption.document);
  dangling.components.schemas.ProjectDates.properties.dates.items.$ref = "#/components/schemas/NoSuchComponent";
  mustFail(() => resolves(dangling), /NoSuchComponent resolves/, "a dangling reference");
});

test("web client: each profile's client is the closed generator's output for its document, with the one declared binary adaptation", () => {
  for (const p of PROFILES) {
    const documentText = readFileSync(join(PATHS.dir, p, OUTPUTS.openapi), "utf8");
    const raw = renderClient(JSON.parse(documentText), digestOf(documentText));
    assert.ok(raw.failures.length > 0 && raw.failures.every((f) => /export.*(text\/csv|application\/pdf|several media types|reference to a component)/.test(f)), `${p}: unadapted, only the binary export fails (${raw.failures.join("; ")})`);
    const { input, adaptations } = webClientInput(JSON.parse(documentText));
    assert.deepEqual(adaptations.map((a) => `${a.operationId} ${a.status}`), ["ExportCommissionStatement 200"], `${p}: one adaptation`);
    assert.deepEqual(manifest.profiles[p].webClientAdaptations, adaptations, `${p}: the manifest records it`);
    const adapted = renderClient(input, digestOf(documentText));
    assert.deepEqual(adapted.failures, []);
    assert.equal(adapted.text, readFileSync(join(PATHS.dir, p, OUTPUTS.webClient), "utf8"), `${p}: the committed client is the generated one`);
    assert.match(adapted.text, new RegExp(`and ${manifest.profiles[p].plannedOperations} planned operations`), `${p}: every planned operation is described`);
    assert.match(adapted.text, /\bisProjectDates\b/, `${p}: CP-02.02's type reaches the candidate client`);
  }
  assert.doesNotMatch(profiles.adoption.client, /\bRecordTransferProof\b|\bTransferProof\b/, "the hold's proof (CP-02.17) is not in the adoption client");
  assert.match(profiles.build.client, /\bRecordTransferProof\b/, "the build client carries it for O27A, behind its activation");
  mustFail(() => webClientInput({ "x-kauro-planned": { "GET /x": { operationId: "X", responses: { 200: { content: { "application/json": {}, "text/csv": {} } } } } } }), /mixes JSON and binary/, "a reply that mixes JSON and binary");
});

function examplesCompiler(doc, bundle) {
  const strip = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k.startsWith("x-") ? undefined : v)).replaceAll("#/components/schemas/", "#/$defs/"));
  const defs = { ...bundle.$defs };
  for (const [name, schema] of Object.entries(doc.components.schemas)) if (!defs[name]) defs[name] = strip(schema);
  const roots = {};
  for (const key of Object.keys(spec.examples)) {
    const [kind, name] = key.split(":");
    const schema = kind === "contract" ? bundle.$defs[name] : doc.components.schemas[name] && strip(doc.components.schemas[name]);
    if (schema) roots[key] = schema;
  }
  return { compiled: application.compileSchemaBundle({ defs, roots }), roots };
}

test("examples: CP-02's valid examples pass and invalid ones fail on each candidate; examples of items left out do not pass there", () => {
  const owner = (key) => {
    const [kind, name] = key.split(":");
    return spec.items.find((i) => (kind === "contract" ? [...i.contracts, ...(i.extraContracts ?? [])].some((c) => c.name === name)
      : kind === "modified" ? i.modified.some((m) => m.components.some((c) => c.name === name))
        : i.operations.some((o) => `${o.kind === "command" ? i.commands.find((c) => c.id === o.command).name : o.operationId}Request` === name))).id;
  };
  for (const p of PROFILES) {
    const { compiled, roots } = examplesCompiler(profiles[p].document, profiles[p].bundle);
    for (const [key, { valid, invalid }] of Object.entries(spec.examples)) {
      const inside = ids(p).includes(owner(key));
      if (inside) {
        for (const [n, v] of valid.entries()) assert.deepEqual(compiled.validate(key, v), [], `${p}: ${key} valid[${n}] passes`);
        for (const bad of invalid) assert.ok(compiled.validate(key, bad.value).some((e) => e.field === bad.error.field && e.code === bad.error.code), `${p}: ${key} "${bad.why}" fails with ${bad.error.field} ${bad.error.code}`);
      } else if (roots[key]) {
        assert.ok(valid.some((v) => compiled.validate(key, v).length > 0), `${p}: ${key} belongs to ${owner(key)}, left out, and its valid examples do not all pass`);
      } else assert.equal(key.startsWith("modified:"), false, `${p}: ${key}, left out, has no schema`);
    }
  }
});

// --- 5. compatibility ----------------------------------------------------------------------------------------------------------

test("compatibility: the 271 changes recorded before Order 17's final review and the 11 it added are revalidated on the candidate (282)", () => {
  const core = compatibilityCore(readFileSync(PATHS.cp02Compatibility, "utf8"));
  checkCompatibility(source, fullChanges, core);
  assert.equal(fullChanges.length, 282);
  assert.deepEqual(manifest.compatibility.all.byLayer, { EVENTS: 12, OPENAPI: 81, REGISTRY: 189 });
  const withoutOne = clone(source);
  withoutOne.compatibility.addedByTheFinalReview.pop();
  mustFail(() => checkCompatibility(withoutOne, fullChanges, core), /changes besides the final review's, not the 271/, "an added change counted among the 271");
  const otherDigest = clone(source);
  otherDigest.compatibility.recorded.digest = changesDigest(fullChanges);
  mustFail(() => checkCompatibility(otherDigest, fullChanges, core), /not all present with the same class/, "a different set of 271");
  const reclassed = clone(fullChanges);
  reclassed.find((c) => c.class === "TEXT").class = "ADDITIVE";
  mustFail(() => checkCompatibility(source, reclassed, core), /differs from CP-02\.compatibility\.json/, "a change reclassified on the candidate");
  const dropped = fullChanges.filter((c) => c.key !== source.compatibility.addedByTheFinalReview[0]);
  mustFail(() => checkCompatibility(source, dropped, compatibilityCore(JSON.stringify({ ...JSON.parse(core), changes: JSON.parse(core).changes.filter((c) => c.key !== source.compatibility.addedByTheFinalReview[0]) }))), /no longer computed/, "a change of the final review lost");
});

test("compatibility per profile: every non-additive change is declared by CP-02 with its class, and no served projection is left behind", () => {
  const declared = new Map(spec.compatibility.map((d) => [d.key, d]));
  for (const p of PROFILES) {
    const changes = profiles[p].changes;
    assert.ok(changes.every((c) => c.change !== "PROJECTION_NOT_FOLLOWED"), `${p}: every served projection follows its registry contract`);
    for (const c of changes.filter((x) => RANK[x.class] >= 1)) {
      assert.equal(declared.get(c.key)?.class, c.class, `${p}: ${c.key} is declared ${c.class}`);
      assert.ok(fullChanges.some((f) => f.key === c.key && f.class === c.class), `${p}: ${c.key} is one of the 282`);
    }
    assert.deepEqual(changes.filter((c) => c.class === "BREAKING").map((c) => c.key).sort(), ["OPENAPI:components/AuditView.targetContractId:REQUIRED_TO_OPTIONAL", "REGISTRY:contracts.json:Audit.targetContractId:REQUIRED_TO_OPTIONAL"], `${p}: only CP-01.01's accepted break and its served consequence`);
  }
  assert.ok(!profiles.adoption.changes.some((c) => c.key === "OPENAPI:components/RetentionView.class:ENUM_WIDENED"), "the hold's projection (CP-01.11, CP-02.17) is not in the adoption profile");
  assert.ok(profiles.build.changes.some((c) => c.key === "OPENAPI:components/RetentionView.class:ENUM_WIDENED"), "it is in the build profile");
});

// --- 6. materialize ------------------------------------------------------------------------------------------------------------

/** Removes a tree this test made, file by file and directory by directory (never a recursive delete: S088). */
function removeTree(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) removeTree(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}

test("materialize: a profile is written into an empty directory with the recorded hashes; a non-empty directory is refused", () => {
  const work = mkdtempSync(join(tmpdir(), "kauro-reissue-test-"));
  try {
    const out = join(work, "adoption");
    const run = spawnSync(process.execPath, [join(ROOT, "tools", "reissue", "reissue.mjs"), "materialize", "adoption", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    for (const [file, hash] of Object.entries(manifest.profiles.adoption.registry.files)) assert.equal(createHashHex(readFileSync(join(out, "registry", file))), hash, `registry/${file}`);
    for (const [file, hash] of Object.entries(manifest.profiles.adoption.outputs)) assert.equal(createHashHex(readFileSync(join(out, file.slice("adoption/".length)))), hash, file);
    const provenance = JSON.parse(readFileSync(join(out, "registry", "PROVENANCE.json"), "utf8"));
    assert.deepEqual(provenance.files, manifest.profiles.adoption.registry.files);
    assert.equal(provenance.profile, "adoption");
    const again = spawnSync(process.execPath, [join(ROOT, "tools", "reissue", "reissue.mjs"), "materialize", "adoption", out], { encoding: "utf8" });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /is not empty/);
  } finally {
    if (existsSync(work)) removeTree(work);
  }
});

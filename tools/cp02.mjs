// ChangeProposal CP-02 (Order 17, component C3: the api contract of the functional change) — generator and checker.
//
//   node tools/cp02.mjs generate   writes, from docs/authority/proposals/CP-02.api.json (the source) and the vendored registry:
//                                    CP-02.registry-delta.json   the registry change as JSON Patch (test/add/replace), CP-01's format
//                                    CP-02.openapi.json          the proposed operations and the modified components (not served)
//                                    CP-02.compatibility.json    every change of CP-01 + CP-02 against the registry and the served api
//   node tools/cp02.mjs check      exits 1 when a committed file is not the generated one
//   node tools/cp02.mjs explain    prints the non-additive changes and the consumers found for each (to write the declarations)
//
// A proposal is not authority (docs/authority/proposals/README.md at PR #122; D-34 §1.3): nothing here touches the vendored registry,
// apps/api/openapi.json or any handler. The registry the proposals would produce is built only in a temporary directory.
// CP-01 is read from disk when PR #122 has merged, otherwise from the pinned commit of PR #122 (git), and must match its pinned hash.
//
// Requires the workspace to be built (pnpm run build, or tools/prepare-fast.mjs): the request vocabulary, the problem statuses and the
// event registry are read from the built @kauro/application and @kauro/domain, the very modules the api runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROPOSALS = join(ROOT, "docs", "authority", "proposals");
export const PATHS = {
  spec: join(PROPOSALS, "CP-02.api.json"),
  delta: join(PROPOSALS, "CP-02.registry-delta.json"),
  openapi: join(PROPOSALS, "CP-02.openapi.json"),
  compatibility: join(PROPOSALS, "CP-02.compatibility.json"),
  registry: join(ROOT, "packages", "contracts", "registry"),
  liveOpenapi: join(ROOT, "apps", "api", "openapi.json"),
  webClient: join(ROOT, "apps", "web", "src", "api", "generated.ts"),
};
const COMPONENTS = "#/components/schemas/";
const MAX = Number.MAX_SAFE_INTEGER;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const CASE_ORIGIN = "CP02_C3_CONTRACT";
const CASE_STATUS = "SPECIFIED_NOT_EXECUTED_ON_PRODUCT";
const COMMAND_STATUS = "SPECIFIED_NOT_IMPLEMENTATION_VERIFIED";
/** Batch bound of a request list (policy api.batchItems). */
const BATCH = 100;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const clone = (v) => structuredClone(v);
const text = (v) => `${JSON.stringify(v, null, 2)}\n`;
const WIDTH = 200;
const inline = (x) => (x === null || typeof x !== "object" ? JSON.stringify(x)
  : Array.isArray(x) ? `[${x.map(inline).join(", ")}]`
  : Object.keys(x).length === 0 ? "{}" : `{ ${Object.entries(x).map(([k, e]) => `${JSON.stringify(k)}: ${inline(e)}`).join(", ")} }`);
/** JSON with short arrays and objects on one line (the delta and the matrix are read by people); parses to the same value. */
export function compactJson(value) {
  const fmt = (x, ind, keyLen = 0) => {
    if (x === null || typeof x !== "object") return JSON.stringify(x);
    const one = inline(x);
    const wide = Array.isArray(x) && x.some((e) => e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).length > 3);
    if (ind.length + keyLen + one.length <= WIDTH && !wide) return one;
    const next = `${ind}  `;
    if (Array.isArray(x)) return x.length === 0 ? "[]" : `[\n${x.map((e) => next + fmt(e, next)).join(",\n")}\n${ind}]`;
    const keys = Object.keys(x);
    return keys.length === 0 ? "{}" : `{\n${keys.map((k) => `${next}${JSON.stringify(k)}: ${fmt(x[k], next, JSON.stringify(k).length + 2)}`).join(",\n")}\n${ind}}`;
  };
  return `${fmt(value, "")}\n`;
}

export function loadSpec() {
  return readJson(PATHS.spec);
}

export function loadProvenance() {
  return readJson(join(PATHS.registry, "PROVENANCE.json"));
}

/** The vendored registry, file by file (only the files PROVENANCE records). */
export function loadRegistry() {
  const provenance = loadProvenance();
  return Object.fromEntries(Object.keys(provenance.files).map((file) => [file, readJson(join(PATHS.registry, file))]));
}

function git(args) {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString("utf8").trim()}`);
  return run.stdout;
}

/**
 * A record named "pr122:<path>" is PR #122's version of a file: read from disk once PR #122 has merged (CP-01's delta is on disk),
 * from the pinned commit before (the file may exist on main in an older version).
 */
export function readRecord(spec, ref) {
  const pr = ref.startsWith("pr122:");
  const path = pr ? ref.slice("pr122:".length) : ref;
  if (pr && !existsSync(join(ROOT, spec.complementOf.delta))) return git(["show", `${spec.complementOf.commit}:${path}`]).toString("utf8");
  if (!existsSync(join(ROOT, path))) throw new Error(`record ${ref} does not exist`);
  return readFileSync(join(ROOT, path), "utf8");
}

/** CP-01's delta, from disk (PR #122 merged) or from its pinned commit; its bytes must be the ones CP-02 was written against. */
export function loadCp01(spec) {
  const { delta: path, commit, sha256: pin } = spec.complementOf;
  const onDisk = existsSync(join(ROOT, path));
  const bytes = onDisk ? readFileSync(join(ROOT, path)) : git(["show", `${commit}:${path}`]);
  const actual = sha256(bytes);
  if (actual !== pin) {
    throw new Error(`CP-01 delta (${onDisk ? "on disk" : `commit ${commit}`}) has sha256 ${actual}, not the ${pin} CP-02 was verified against: re-verify CP-02 against the new CP-01 and update complementOf`);
  }
  return { delta: JSON.parse(bytes.toString("utf8")), origin: onDisk ? "disk" : `git ${commit.slice(0, 12)}` };
}

// --- JSON Patch subset (the rules of CP-01's test: add never overwrites, replace never creates, arrays grow at their end) ---------

function tokens(pointer) {
  if (!pointer.startsWith("/")) throw new Error(`pointer ${pointer} is not absolute`);
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parentOf(doc, pointer) {
  const path = tokens(pointer);
  const key = path.pop();
  let node = doc;
  for (const t of path) {
    const k = Array.isArray(node) ? Number(t) : t;
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, k)) throw new Error(`${pointer}: parent ${t} does not exist`);
    node = node[k];
  }
  if (node === null || typeof node !== "object") throw new Error(`${pointer}: parent is not a container`);
  return { node, key };
}

export function valueAt(doc, pointer) {
  const { node, key } = parentOf(doc, pointer);
  const k = Array.isArray(node) ? Number(key) : key;
  if (!Object.hasOwn(node, k)) throw new Error(`${pointer} does not exist`);
  return node[k];
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b) || isDeepStrictEqualLoose(a, b);
function isDeepStrictEqualLoose(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && isDeepStrictEqualLoose(a[k], b[k]));
}

export function applyOp(doc, op) {
  if (op.op === "test") {
    if (!deepEqual(valueAt(doc, op.path), op.value)) throw new Error(`${op.path}: test failed, the registry does not hold the value the proposal was written against`);
    return;
  }
  const { node, key } = parentOf(doc, op.path);
  if (op.op === "replace") {
    valueAt(doc, op.path);
    node[Array.isArray(node) ? Number(key) : key] = clone(op.value);
    return;
  }
  if (op.op !== "add") throw new Error(`${op.path}: op ${op.op} is not test, add or replace`);
  if (Array.isArray(node)) {
    if (key !== "-") throw new Error(`${op.path}: an array grows only at its end`);
    node.push(clone(op.value));
  } else {
    if (Object.hasOwn(node, key)) throw new Error(`${op.path}: add never overwrites an existing member`);
    node[key] = clone(op.value);
  }
}

/** Applies the items of the deltas, in order, to a copy of the registry; `only` restricts each delta to some item ids. */
export function applyDeltas(registry, deltas, only = null) {
  const docs = clone(registry);
  for (const delta of deltas) {
    for (const item of delta.items) {
      if (only && !only.has(item.id)) continue;
      for (const [file, ops] of Object.entries(item.patch)) {
        if (!Object.hasOwn(docs, file)) throw new Error(`${item.id}: ${file} is not a registry file`);
        for (const op of ops) applyOp(docs[file], op);
      }
    }
  }
  return docs;
}

// --- the registry delta ----------------------------------------------------------------------------------------------------

const fieldRecord = ([name, type, required, description]) => ({ name, type, required, description });

function contractRecord(c) {
  return { name: c.name, owner: c.owner, flow: c.flow, invariant: c.invariant, fields: c.fields.map(fieldRecord), schemaRef: `urn:kauro:r2:contracts#/$defs/${c.name}` };
}

function commandRecord(c) {
  return {
    id: c.id, name: c.name, method: c.method, path: c.path, role: c.role, owner: c.owner,
    fields: c.fields.map(([name, type]) => ({ name, type })),
    precondition: c.precondition, effect: c.effect, failure: c.failure, gate: c.gate, idempotency: c.idempotency, stateCheck: c.stateCheck,
    testIds: [`${c.id}-OK`, `${c.id}-DENY`, `${c.id}-RACE`], status: COMMAND_STATUS,
  };
}

/** The case template of a gate's boundary, copied from an existing case of the registry so it is the authority's own text. */
function template(registry, spec, key) {
  const boundary = spec.caseTemplates[key];
  if (boundary === undefined) throw new Error(`unknown case template ${key}`);
  const found = registry["cases.json"].find((c) => c.publicBoundary === boundary && c.command);
  if (!found) throw new Error(`no registry case carries the boundary ${boundary}`);
  return { publicBoundary: found.publicBoundary, oracle: found.oracle, verification: found.verification, requiredEvidence: found.requiredEvidence };
}

function caseRecord(fields, tpl) {
  const record = {
    id: fields.id, title: fields.title, scenario: fields.scenario, expected: fields.expected, gate: fields.gate, owner: fields.owner, package: fields.package,
  };
  if (fields.command) record.command = fields.command;
  Object.assign(record, { status: CASE_STATUS, origin: CASE_ORIGIN, requirementId: `REQ-${fields.id}`, ...clone(tpl) });
  return record;
}

export function itemNumber(item) {
  return item.id.split(".")[1];
}

/** Every case an item adds: three per command (the registry's own OK/DENY/RACE templates) and its acceptance cases. */
export function itemCases(registry, spec, item) {
  const gates = registry["gates.json"];
  const cases = [];
  for (const c of item.commands) {
    const tpl = template(registry, spec, c.template);
    const base = { gate: c.gate, owner: c.owner, package: c.package, command: c.id };
    cases.push(caseRecord({ ...base, id: `${c.id}-OK`, title: `${c.name} OK`, scenario: `Valid authority, current aggregate and exact preconditions: ${c.precondition}`, expected: c.effect }, tpl));
    cases.push(caseRecord({ ...base, id: `${c.id}-DENY`, title: `${c.name} DENY`, scenario: `Foreign tenant/wrong role and then one missing material prerequisite at ${c.name}`, expected: `${c.failure} No unauthorized committed state or external effect.` }, tpl));
    cases.push(caseRecord({ ...base, id: `${c.id}-RACE`, title: `${c.name} RACE`, scenario: `Identical retry, conflicting same-key request and crash at the intent/commit boundary of ${c.name}`, expected: `${c.effect} Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority.` }, tpl));
  }
  for (const a of item.acceptance) {
    const gate = gates.find((g) => g.id === a.gate);
    if (!gate) throw new Error(`${item.id}: unknown gate ${a.gate}`);
    cases.push(caseRecord({ id: `CP02-${itemNumber(item)}-${a.tag}`, title: `${a.title} (${a.kind.toLowerCase()})`, scenario: a.scenario, expected: a.expected, gate: a.gate, owner: gate.owner, package: item.component }, template(registry, spec, a.template)));
  }
  return cases;
}

export const allContracts = (item) => [...item.contracts, ...(item.extraContracts ?? [])];

export function buildDelta(spec, registry) {
  const provenance = loadProvenance();
  const touched = new Set();
  const items = [];
  for (const item of spec.items) {
    const patch = {};
    const push = (file, op) => {
      touched.add(file);
      (patch[file] ??= []).push(op);
    };
    for (const c of allContracts(item)) push("contracts.json", { op: "add", path: "/-", value: contractRecord(c) });
    for (const ext of item.extendContracts) {
      const idx = registry["contracts.json"].findIndex((c) => c.name === ext.contract);
      if (idx < 0) throw new Error(`${item.id}: no contract ${ext.contract}`);
      push("contracts.json", { op: "test", path: `/${idx}/name`, value: ext.contract });
      for (const f of ext.fields) push("contracts.json", { op: "add", path: `/${idx}/fields/-`, value: fieldRecord(f) });
    }
    for (const c of item.commands) push("commands.json", { op: "add", path: "/-", value: commandRecord(c) });
    for (const change of item.commandTextChanges ?? []) {
      const idx = registry["commands.json"].findIndex((c) => c.id === change.id);
      if (idx < 0) throw new Error(`${item.id}: no command ${change.id}`);
      push("commands.json", { op: "test", path: `/${idx}/id`, value: change.id });
      push("commands.json", { op: "test", path: `/${idx}/${change.member}`, value: registry["commands.json"][idx][change.member] });
      push("commands.json", { op: "replace", path: `/${idx}/${change.member}`, value: change.value });
    }
    for (const m of item.machines ?? []) push("state_transitions.json", { op: "add", path: "/-", value: m });
    for (const s of item.screens ?? []) push("screens.json", { op: "add", path: "/-", value: s });
    const cases = itemCases(registry, spec, item);
    const gateTested = new Set();
    for (const c of cases) {
      push("cases.json", { op: "add", path: "/-", value: c });
      push("requirements.json", { op: "add", path: "/-", value: { id: `REQ-${c.id}`, owner: c.owner, caseIds: [c.id], gate: c.gate, packages: [c.package], statement: c.expected, origin: CASE_ORIGIN } });
    }
    for (const c of cases) {
      const idx = registry["gates.json"].findIndex((g) => g.id === c.gate);
      if (!gateTested.has(c.gate)) {
        push("gates.json", { op: "test", path: `/${idx}/id`, value: c.gate });
        gateTested.add(c.gate);
      }
      push("gates.json", { op: "add", path: `/${idx}/caseIds/-`, value: c.id });
    }
    items.push({
      id: item.id,
      o17: item.o17,
      title: item.title,
      gaps: item.gaps,
      class: item.class,
      status: spec.statusOfClass[item.class],
      approval: item.approval,
      pending: item.pending,
      blockers: item.blockers,
      requires: item.requires,
      dependsOn: item.dependsOn,
      activation: item.activation,
      component: item.component,
      patch,
    });
  }
  const order = Object.keys(provenance.files);
  return {
    proposal: spec.proposal,
    document: spec.document,
    preparedBy: spec.preparedBy,
    generatedBy: "tools/cp02.mjs from docs/authority/proposals/CP-02.api.json; do not edit",
    complementOf: spec.complementOf,
    base: {
      edition: registry["policy.json"].edition,
      files: Object.fromEntries(order.filter((f) => touched.has(f)).map((f) => [f, provenance.files[f]])),
    },
    statuses: {
      APPROVED_AWAITING_REISSUE: "The substance was decided; it waits only for the re-issue that adopts CP-01 and CP-02 together.",
      CONDITIONAL: "Not adoptable until `pending` is empty (an owner value, a CP-01 item, a component or an external party).",
      PROPOSED: "A recommendation; it needs the owner's decision.",
    },
    classes: spec.classes,
    items,
  };
}

// --- the generated contract bundle of a registry (the authority's own generator, in a temporary directory) ---------------------

/**
 * Runs the authority's generator on a registry in a fresh temporary directory and returns its JSON Schema bundle. The directory is
 * cleaned file by file: exactly the files this function wrote and the two the generator writes, then the five directories, none of
 * them recursively; anything else left there makes rmdir fail rather than be deleted unseen.
 */
export function generateBundle(registry) {
  const provenance = loadProvenance();
  const dir = mkdtempSync(join(tmpdir(), "kauro-cp02-"));
  const registryFiles = [...Object.keys(provenance.files), "PROVENANCE.json"].map((f) => join(dir, "registry", f));
  const generated = ["types.ts", "schemas.json"].map((f) => join(dir, "src", "generated", f));
  const script = join(dir, "tools", "generate.mjs");
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "registry"));
    copyFileSync(join(ROOT, "packages", "contracts", "tools", "generate.mjs"), script);
    const files = {};
    for (const file of Object.keys(provenance.files)) {
      const bytes = Buffer.from(text(registry[file]));
      writeFileSync(join(dir, "registry", file), bytes);
      files[file] = sha256(bytes);
    }
    writeFileSync(join(dir, "registry", "PROVENANCE.json"), JSON.stringify({ ...provenance, files }, null, 2));
    const run = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`the contracts generator refused the registry: ${run.stdout}${run.stderr}`);
    return readJson(join(dir, "src", "generated", "schemas.json"));
  } finally {
    for (const f of [...registryFiles, ...generated, script]) if (existsSync(f)) unlinkSync(f);
    for (const d of [join(dir, "src", "generated"), join(dir, "src"), join(dir, "registry"), join(dir, "tools"), dir]) if (existsSync(d)) rmdirSync(d);
  }
}

// --- the proposed OpenAPI -------------------------------------------------------------------------------------------------

async function load(rel) {
  return import(pathToFileURL(join(ROOT, rel)).href);
}

export async function loadModules() {
  const [application, domain] = await Promise.all([load("packages/application/dist/src/index.js"), load("packages/domain/dist/src/index.js")]);
  return { application, domain };
}

function requestFieldSchema(type, override, application) {
  const o = override ?? {};
  let s;
  if (type === "id") s = { type: "string", pattern: UUID };
  else if (type === "label") s = { type: "string", minLength: 1, maxLength: 200, pattern: application.LABEL_PATTERN };
  else if (type === "text") s = { type: "string", minLength: 1, maxLength: 4000, pattern: application.TEXT_PATTERN };
  else if (type === "version") s = { type: "integer", minimum: 1, maximum: MAX };
  else if (type === "hash") s = { type: "string", pattern: "^[0-9a-f]{64}$" };
  else if (type === "count") s = { type: "integer", minimum: 0, maximum: MAX };
  else if (type === "money") s = { type: "string", pattern: "^(0|[1-9][0-9]*)$", maxLength: 16 };
  else if (type === "utc") s = { type: "string", format: "date-time", pattern: "Z$" };
  else if (type === "bool") s = { type: "boolean" };
  else if (type.startsWith("enum:")) s = { type: "string", enum: type.slice(5).split(",") };
  else if (type === "listHash") s = { type: "array", items: { type: "string", pattern: "^[0-9a-f]{64}$" }, maxItems: BATCH };
  else if (type === "listText") s = { type: "array", items: o.items === "id" ? { type: "string", pattern: UUID } : { type: "string", minLength: 1, maxLength: 200, pattern: application.LABEL_PATTERN }, maxItems: BATCH };
  else if (type.startsWith("list:")) s = { type: "array", items: { $ref: COMPONENTS + type.slice(5) }, maxItems: BATCH };
  else throw new Error(`no request shape for registry type ${type}`);
  for (const [k, v] of Object.entries(o)) if (k !== "items") s[k] = v;
  return s;
}

/** A bundle definition as an OpenAPI component: $defs references to components, the registry id kept. */
function toComponent(def, name) {
  const convert = (s) => {
    if (Array.isArray(s)) return s.map(convert);
    if (typeof s !== "object" || s === null) return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) out[k] = k === "$ref" ? v.replace("#/$defs/", COMPONENTS) : convert(v);
    return out;
  };
  return { title: name, ...convert(def), "x-kauro-schema-id": `urn:kauro:r2:contracts#/$defs/${name}` };
}

function refsOf(schema, into = new Set()) {
  if (Array.isArray(schema)) schema.forEach((s) => refsOf(s, into));
  else if (typeof schema === "object" && schema !== null) {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith(COMPONENTS)) into.add(v.slice(COMPONENTS.length));
      else refsOf(v, into);
    }
  }
  return into;
}

const pathParameters = (path) => [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);

/** The operations of an item, normalized: a command operation takes method, path, name and role from the registry command. */
export function itemOperations(item) {
  return item.operations.map((op) => {
    if (op.kind !== "command") return op;
    const command = item.commands.find((c) => c.id === op.command);
    if (!command) throw new Error(`${item.id}: operation of ${op.command} has no command in the item`);
    return { ...op, operationId: command.name, method: command.method, path: command.path, role: command.role, registry: command };
  });
}

function applyEdits(base, edits) {
  const schema = clone(base);
  for (const e of edits) {
    if (e.op === "unrequire") {
      if (!schema.required?.includes(e.property)) throw new Error(`unrequire ${e.property}: not required in the base`);
      schema.required = schema.required.filter((r) => r !== e.property);
    } else if (e.op === "addProperty") {
      if (Object.hasOwn(schema.properties, e.property)) throw new Error(`addProperty ${e.property}: already present`);
      schema.properties[e.property] = clone(e.schema);
      if (e.required) schema.required = [...schema.required, e.property];
    } else if (e.op === "addEnumValue") {
      const p = schema.properties[e.property];
      if (!p || !Array.isArray(p.enum) || p.enum.includes(e.value)) throw new Error(`addEnumValue ${e.property}: no enum or value present`);
      p.enum = [...p.enum, e.value];
    } else throw new Error(`unknown edit ${e.op}`);
  }
  return schema;
}

export const canonicalHash = (value) => sha256(JSON.stringify(value));

export function buildOpenapi(spec, ctx) {
  const { bundle, live, application } = ctx;
  const problemStatus = application.PROBLEM_STATUS;
  const liveReasons = live.components.schemas.Problem.properties.reason.enum;
  const liveCodes = live.components.schemas.Problem.properties.code.enum;
  const liveOps = new Map();
  for (const [path, methods] of Object.entries(live.paths)) for (const [m, o] of Object.entries(methods)) liveOps.set(`${m.toUpperCase()} ${path}`, o);
  const liveIds = new Set([...liveOps.values()].map((o) => o.operationId));

  const schemas = {};
  const parameters = {};
  const needContracts = new Set();
  const newReasons = [];
  const addReason = (reason) => {
    if (reason && !liveReasons.includes(reason) && !newReasons.includes(reason)) newReasons.push(reason);
  };
  const paramRef = (name) => {
    if (!live.components.parameters[name]) throw new Error(`the served api has no parameter ${name}`);
    parameters[name] = clone(live.components.parameters[name]);
    return { $ref: `#/components/parameters/${name}` };
  };
  const problemResponses = (outcomes, kind) => {
    const byStatus = {};
    for (const o of outcomes) {
      if (!liveCodes.includes(o.code)) throw new Error(`problem code ${o.code} is not in the served Problem vocabulary (a new code is not proposed)`);
      if (problemStatus[o.code] !== o.status) throw new Error(`${o.code} answers ${problemStatus[o.code]}, not ${o.status}`);
      addReason(o.reason);
      const entry = { code: o.code, ...(o.reason ? { reason: o.reason } : {}), ...(o.fieldCodes ? { fieldCodes: o.fieldCodes } : {}), layer: o.layer, meaning: o.meaning, ...(o.nextAction ? { nextAction: o.nextAction } : {}), ...(o.change ? { change: o.change } : {}) };
      (byStatus[o.status] ??= []).push(entry);
    }
    return Object.fromEntries(Object.entries(byStatus).map(([status, entries]) => [status, {
      description: `Problem: the ${entries.length === 1 ? "outcome" : `${entries.length} outcomes`} this operation adds at ${status}; the envelope, admission and authentication outcomes of every ${kind} route are added by tools/openapi.mjs when the route is served.`,
      content: { "application/problem+json": { schema: { $ref: `${COMPONENTS}Problem` } } },
      "x-kauro-outcomes": entries,
    }]));
  };

  const paths = {};
  const seenIds = new Set();
  for (const item of spec.items) {
    for (const op of itemOperations(item)) {
      const key = `${op.method} ${op.path}`;
      if (liveOps.has(key)) throw new Error(`${item.id}: ${key} is already served`);
      if (liveIds.has(op.operationId) || seenIds.has(op.operationId)) throw new Error(`${item.id}: operationId ${op.operationId} is not unique`);
      seenIds.add(op.operationId);
      const contract = op.response.contract;
      if (!bundle.$defs[contract]) throw new Error(`${item.id}: ${op.operationId} answers ${contract}, which the registry does not define`);
      needContracts.add(contract);
      const params = pathParameters(op.path).map((name) => ({ name, in: "path", required: true, description: "Path id, resolved with server-owned tenant scope.", schema: { type: "string", pattern: UUID } }));
      if (op.kind === "command") params.push(paramRef("IdempotencyKey"));
      if (op.scope === "AGENCY_HEADER") params.push(paramRef("AgencySelector"));
      if (op.kind === "read" && op.response.list) params.push(paramRef("PageLimit"), paramRef("PageCursor"));
      for (const q of op.query ?? []) {
        params.push({ name: q.name, in: "query", required: q.required === true, description: q.description, schema: q.id ? { type: "string", pattern: UUID } : { type: "string", enum: q.enum } });
      }
      params.push(paramRef("CorrelationId"));
      const cookie = ["AGENCY", "AGENCY_BILLING", "SELF"].includes(op.audience);
      if (op.kind === "command" && cookie) params.push(paramRef("CsrfToken"));
      const security = op.audience === "PUBLIC" ? [] : cookie ? [{ bearerAuth: [] }, { sessionCookie: [] }] : [{ bearerAuth: [] }];
      let success;
      if (op.response.binary) {
        success = {
          [String(op.response.status ?? 200)]: {
            description: `The export (${op.response.binary.join(", ")}); CSV rows follow ${contract}.`,
            content: Object.fromEntries(op.response.binary.map((type) => [type, { schema: { type: "string" } }])),
            "x-kauro-csv-row": { $ref: COMPONENTS + contract },
          },
        };
      } else if (op.kind === "read") {
        const dataRef = op.response.list ? `${contract}Page` : contract;
        if (op.response.list) {
          schemas[`${contract}Page`] = {
            title: `${contract}Page`,
            description: `A page of ${contract}, newest first.`,
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: { items: { type: "array", maxItems: 100, items: { $ref: COMPONENTS + contract } }, nextCursor: clone(live.components.schemas.ProjectDashboardPage.properties.nextCursor) },
          };
        }
        schemas[`${op.operationId}Reply`] = {
          title: `${op.operationId} READ`,
          type: "object",
          additionalProperties: false,
          required: ["kind", "data"],
          properties: { kind: { type: "string", const: "READ" }, data: { $ref: COMPONENTS + dataRef } },
          "x-kauro-schema-id": `urn:kauro:api:v1:response:read:${op.operationId}`,
        };
        success = { 200: { description: op.summary, content: { "application/json": { schema: { $ref: `${COMPONENTS}${op.operationId}Reply` } } } } };
      } else {
        schemas[`${op.operationId}Completed`] = {
          title: `${op.command} COMPLETED`,
          type: "object",
          additionalProperties: false,
          required: ["kind", "version", "replayed", "data"],
          properties: { kind: { type: "string", const: "COMPLETED" }, version: { type: "integer", minimum: 1, maximum: MAX }, replayed: { type: "boolean" }, data: { $ref: COMPONENTS + contract } },
          "x-kauro-schema-id": `urn:kauro:api:v1:response:${op.command}`,
        };
        success = { [String(op.response.status)]: { description: `COMPLETED: ${op.registry.effect}`, content: { "application/json": { schema: { $ref: `${COMPONENTS}${op.operationId}Completed` } } } } };
      }
      const operation = {
        operationId: op.operationId,
        summary: op.kind === "command" ? `${op.command} ${op.operationId}` : op.summary,
        ...(op.kind === "command" ? { description: `Precondition: ${op.registry.precondition}\n\nEffect: ${op.registry.effect}\n\nFailure: ${op.registry.failure}` } : {}),
        ...(op.kind === "command" ? { "x-kauro-command": op.command, "x-kauro-idempotency": op.registry.idempotency, "x-kauro-gate": op.registry.gate, "x-kauro-cases": [`${op.command}-OK`, `${op.command}-DENY`, `${op.command}-RACE`] } : { "x-kauro-read": true }),
        "x-kauro-cp02-item": item.id,
        "x-kauro-class": item.class,
        "x-kauro-role": op.role,
        "x-kauro-audience": op.audience,
        "x-kauro-standard-outcomes": op.kind === "command" ? "COMMAND" : "READ",
        ...(op.kind === "command" ? { "x-kauro-assurance": op.assurance } : {}),
        ...(op.events?.length ? { "x-kauro-events": op.events } : {}),
        ...(op.transitions?.length ? { "x-kauro-transitions": op.transitions } : {}),
        security,
        parameters: params,
      };
      if (op.kind === "command") {
        const fields = op.registry.fields;
        const required = op.request.required;
        for (const r of required) if (!fields.some(([n]) => n === r)) throw new Error(`${op.command}: required ${r} is not a registry field`);
        const requestName = `${op.operationId}Request`;
        const properties = Object.fromEntries(fields.map(([name, type]) => [name, requestFieldSchema(type, op.request.overrides?.[name], application)]));
        for (const s of Object.values(properties)) for (const r of refsOf(s)) needContracts.add(r);
        schemas[requestName] = { type: "object", additionalProperties: false, required, properties, "x-kauro-schema-id": `urn:kauro:api:v1:request:${op.command}` };
        operation.requestBody = { required: true, content: { "application/json": { schema: { $ref: COMPONENTS + requestName } } } };
      }
      operation.responses = { ...success, ...problemResponses(op.outcomes, op.kind === "command" ? "command" : "read") };
      paths[op.path] = { ...(paths[op.path] ?? {}), [op.method.toLowerCase()]: operation };
    }
  }

  // registry contracts the operations answer, with everything they reference
  const pending = [...needContracts];
  while (pending.length > 0) {
    const name = pending.pop();
    if (schemas[name]) continue;
    const def = bundle.$defs[name];
    if (!def) throw new Error(`no registry contract ${name}`);
    schemas[name] = toComponent(def, name);
    for (const r of refsOf(schemas[name])) if (!schemas[r]) pending.push(r);
  }

  // modified operations of the served api
  const modified = {};
  const modifiedComponents = {};
  for (const item of spec.items) {
    for (const m of item.modified) {
      const served = liveOps.get(`${m.method} ${m.path}`);
      if (!served || served.operationId !== m.operationId) throw new Error(`${item.id}: ${m.method} ${m.path} is not the served ${m.operationId}`);
      const components = {};
      for (const c of m.components) {
        if (c.new) {
          if (live.components.schemas[c.name]) throw new Error(`${item.id}: ${c.name} already exists in the served api`);
          components[c.name] = { direction: c.direction, new: true, proposed: clone(c.schema) };
          schemas[c.name] = clone(c.schema);
          continue;
        }
        const base = live.components.schemas[c.name];
        if (!base) throw new Error(`${item.id}: the served api has no component ${c.name}`);
        const proposed = applyEdits(base, c.edits);
        components[c.name] = { direction: c.direction, baseSha256: canonicalHash(base), edits: c.edits, proposed };
        modifiedComponents[c.name] = proposed;
      }
      for (const o of m.outcomes) {
        if (o.change === "meaning") {
          const listed = Object.values(served.responses).flatMap((r) => r["x-kauro-outcomes"] ?? []);
          if (!listed.some((l) => l.code === o.code && l.reason === o.reason)) throw new Error(`${m.operationId}: ${o.code}/${o.reason} is not a served outcome whose meaning could change`);
        }
      }
      modified[m.operationId] = { method: m.method, path: m.path, item: item.id, class: item.class, components, outcomes: problemResponses(m.outcomes, "served") };
    }
  }
  if (newReasons.length > 0) {
    const base = live.components.schemas.Problem;
    const proposed = clone(base);
    proposed.properties.reason.enum = [...base.properties.reason.enum, ...newReasons];
    modifiedComponents.Problem = proposed;
    modified["components/Problem"] = { item: "CP-02 (every item that adds a reason)", components: { Problem: { direction: "response", baseSha256: canonicalHash(base), edits: newReasons.map((value) => ({ op: "addEnumValue", property: "reason", value })), proposed } }, outcomes: {} };
  }
  schemas.Problem = modifiedComponents.Problem ?? clone(live.components.schemas.Problem);
  for (const [name, schema] of Object.entries(modifiedComponents)) schemas[name] = schema;
  // served components a modified one references, copied unchanged so every reference resolves inside this document
  const missing = [...refsOf(schemas)].filter((n) => !schemas[n]);
  while (missing.length > 0) {
    const name = missing.pop();
    if (schemas[name]) continue;
    if (!live.components.schemas[name]) throw new Error(`${name} is referenced and neither proposed nor served`);
    schemas[name] = clone(live.components.schemas[name]);
    for (const r of refsOf(schemas[name])) if (!schemas[r]) missing.push(r);
  }

  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return {
    openapi: live.openapi,
    jsonSchemaDialect: live.jsonSchemaDialect,
    info: {
      title: "Kauro API — ChangeProposal CP-02 (proposed, not served)",
      version: "cp-02",
      description: "Generated by tools/cp02.mjs from docs/authority/proposals/CP-02.api.json; do not edit. Operations no route serves: nothing here is authority until the owner signs the item and the authority re-issue adopts CP-01 and CP-02 together. x-kauro-modified lists the served operations and components the proposal changes, each with the hash of the served component it was written against.",
      "x-kauro-base": {
        openapi: sha256(readFileSync(PATHS.liveOpenapi)),
        webClient: sha256(readFileSync(PATHS.webClient)),
        registry: loadProvenance().files,
        cp01: spec.complementOf.sha256,
      },
    },
    "x-kauro-status": "PROPOSED_NOT_ADOPTED",
    paths: sorted(paths),
    "x-kauro-modified": modified,
    components: { schemas: sorted(schemas), parameters: sorted(parameters), securitySchemes: clone(live.components.securitySchemes) },
  };
}

// --- compatibility ---------------------------------------------------------------------------------------------------------

const RANK = { ADDITIVE: 0, TEXT: 0, COORDINATED: 1, BREAKING: 2 };

function enumValues(type) {
  return type.startsWith("enum:") ? type.slice(5).split(",") : null;
}

/** Changes of the registry contracts, commands and machines between two registries. */
export function registryChanges(base, after) {
  const changes = [];
  const add = (subject, change, cls, detail) => changes.push({ layer: "REGISTRY", subject, change, class: cls, detail });
  const contractsBefore = new Map(base["contracts.json"].map((c) => [c.name, c]));
  for (const c of after["contracts.json"]) {
    const prev = contractsBefore.get(c.name);
    if (!prev) {
      add(`contracts.json:${c.name}`, "CONTRACT_ADDED", "ADDITIVE", `${c.fields.length} fields`);
      continue;
    }
    const fieldsBefore = new Map(prev.fields.map((f) => [f.name, f]));
    const fieldsAfter = new Map(c.fields.map((f) => [f.name, f]));
    for (const [name, f] of fieldsAfter) {
      const p = fieldsBefore.get(name);
      if (!p) {
        add(`contracts.json:${c.name}.${name}`, "FIELD_ADDED", f.required ? "BREAKING" : "COORDINATED", f.required ? "a required member existing producers do not write" : "a new member of a closed shape: generated types and validators change with it");
        continue;
      }
      if (p.type !== f.type) {
        const a = enumValues(p.type);
        const b = enumValues(f.type);
        if (a && b && a.every((v) => b.includes(v))) add(`contracts.json:${c.name}.${name}`, "ENUM_WIDENED", "COORDINATED", `adds ${b.filter((v) => !a.includes(v)).join(", ")}`);
        else add(`contracts.json:${c.name}.${name}`, "TYPE_CHANGED", "BREAKING", `${p.type} → ${f.type}`);
      }
      if (p.required !== f.required) add(`contracts.json:${c.name}.${name}`, p.required ? "REQUIRED_TO_OPTIONAL" : "OPTIONAL_TO_REQUIRED", "BREAKING", p.required ? "readers that assume the member break" : "producers that omit the member break");
    }
    for (const name of fieldsBefore.keys()) if (!fieldsAfter.has(name)) add(`contracts.json:${c.name}.${name}`, "FIELD_REMOVED", "BREAKING", "");
  }
  for (const name of contractsBefore.keys()) if (!after["contracts.json"].some((c) => c.name === name)) add(`contracts.json:${name}`, "CONTRACT_REMOVED", "BREAKING", "");
  const commandsBefore = new Map(base["commands.json"].map((c) => [c.id, c]));
  for (const c of after["commands.json"]) {
    const prev = commandsBefore.get(c.id);
    if (!prev) {
      add(`commands.json:${c.id}`, "COMMAND_ADDED", "ADDITIVE", `${c.name} ${c.method} ${c.path}`);
      continue;
    }
    for (const k of ["name", "method", "path", "role", "idempotency"]) if (prev[k] !== c[k]) add(`commands.json:${c.id}.${k}`, "COMMAND_CHANGED", "BREAKING", `${prev[k]} → ${c[k]}`);
    if (JSON.stringify(prev.fields) !== JSON.stringify(c.fields)) add(`commands.json:${c.id}.fields`, "COMMAND_FIELDS_CHANGED", "BREAKING", "");
    for (const k of ["precondition", "effect", "failure"]) if (prev[k] !== c[k]) add(`commands.json:${c.id}.${k}`, "TEXT_CHANGED", "TEXT", "");
  }
  const machinesBefore = new Map(base["state_transitions.json"].map((m) => [m.contract, m]));
  for (const m of after["state_transitions.json"]) {
    const prev = machinesBefore.get(m.contract);
    if (!prev) add(`state_transitions.json:${m.contract}`, "MACHINE_ADDED", "ADDITIVE", `${m.transitions.length} transitions`);
    else if (JSON.stringify(prev) !== JSON.stringify(m)) add(`state_transitions.json:${m.contract}`, "MACHINE_CHANGED", "BREAKING", "");
  }
  for (const [file, key] of [["screens.json", "id"], ["cases.json", "id"], ["requirements.json", "id"], ["gates.json", "id"]]) {
    const before = new Map(base[file].map((r) => [r[key], r]));
    let added = 0;
    for (const r of after[file]) {
      const prev = before.get(r[key]);
      if (!prev) added += 1;
      else if (JSON.stringify(prev) !== JSON.stringify(r)) {
        const growing = file === "gates.json" && JSON.stringify({ ...prev, caseIds: [] }) === JSON.stringify({ ...r, caseIds: [] }) && prev.caseIds.every((id, i) => r.caseIds[i] === id);
        add(`${file}:${r[key]}`, growing ? "CASES_ADDED_TO_GATE" : "TEXT_CHANGED", growing ? "ADDITIVE" : "TEXT", growing ? `+${r.caseIds.length - prev.caseIds.length}` : "");
      }
    }
    if (added > 0) add(`${file}`, "RECORDS_ADDED", "ADDITIVE", `+${added}`);
  }
  const policyKeys = (o, prefix = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? [`${prefix}${k}`, ...policyKeys(v, `${prefix}${k}.`)] : [`${prefix}${k}`]));
  const before = new Set(policyKeys(base["policy.json"]));
  for (const k of policyKeys(after["policy.json"])) if (!before.has(k)) add(`policy.json:${k}`, "POLICY_KEY_ADDED", "ADDITIVE", "");
  return changes;
}

function propertyChanges(name, direction, base, proposed, add) {
  const req0 = new Set(base.required ?? []);
  const req1 = new Set(proposed.required ?? []);
  for (const [prop, s] of Object.entries(proposed.properties ?? {})) {
    const p = base.properties?.[prop];
    const subject = `${name}.${prop}`;
    if (!p) {
      if (direction === "request") add(subject, "PROPERTY_ADDED", req1.has(prop) ? "BREAKING" : "ADDITIVE", req1.has(prop) ? "existing clients do not send it" : "optional input");
      else add(subject, "PROPERTY_ADDED", "COORDINATED", "a closed reply gains a member: the generated web client and its guards must be regenerated with the server");
      continue;
    }
    const e0 = p.enum;
    const e1 = s.enum;
    if (e0 && e1 && JSON.stringify(e0) !== JSON.stringify(e1)) {
      const widened = e0.every((v) => e1.includes(v));
      const narrowed = e1.every((v) => e0.includes(v));
      if (direction === "request") add(subject, widened ? "ENUM_WIDENED" : "ENUM_NARROWED", widened ? "ADDITIVE" : "BREAKING", "");
      else add(subject, widened ? "ENUM_WIDENED" : "ENUM_NARROWED", widened ? "COORDINATED" : narrowed ? "ADDITIVE" : "BREAKING", widened ? `adds ${e1.filter((v) => !e0.includes(v)).join(", ")}` : "");
    } else if (JSON.stringify({ ...p, enum: undefined, description: undefined }) !== JSON.stringify({ ...s, enum: undefined, description: undefined })) {
      add(subject, "SCHEMA_CHANGED", "BREAKING", "");
    }
    if (req0.has(prop) && !req1.has(prop)) add(subject, "REQUIRED_TO_OPTIONAL", direction === "request" ? "ADDITIVE" : "BREAKING", direction === "request" ? "clients may omit it" : "readers that assume it break");
    if (!req0.has(prop) && req1.has(prop)) add(subject, "OPTIONAL_TO_REQUIRED", direction === "request" ? "BREAKING" : "ADDITIVE", "");
  }
  for (const prop of Object.keys(base.properties ?? {})) if (!Object.hasOwn(proposed.properties ?? {}, prop)) add(`${name}.${prop}`, "PROPERTY_REMOVED", "BREAKING", "");
}

/** Changes of the served api: new operations, modified components and outcomes of served operations. */
export function openapiChanges(live, proposed) {
  const changes = [];
  const add = (subject, change, cls, detail) => changes.push({ layer: "OPENAPI", subject, change, class: cls, detail });
  for (const [path, methods] of Object.entries(proposed.paths)) for (const [m, o] of Object.entries(methods)) add(`${m.toUpperCase()} ${path}`, "OPERATION_ADDED", "ADDITIVE", `${o.operationId} (${o["x-kauro-cp02-item"]}, ${o["x-kauro-class"]})`);
  for (const [key, mod] of Object.entries(proposed["x-kauro-modified"])) {
    for (const [name, c] of Object.entries(mod.components)) {
      if (c.new) {
        add(`components/${name}`, "COMPONENT_ADDED", "ADDITIVE", `referenced by ${key}`);
        continue;
      }
      propertyChanges(name, c.direction, live.components.schemas[name], c.proposed, (subject, change, cls, detail) => add(`components/${subject}`, change, cls, detail));
    }
    for (const r of Object.values(mod.outcomes ?? {})) {
      for (const o of r["x-kauro-outcomes"]) {
        const subject = `${key}:${o.code}${o.reason ? `/${o.reason}` : ""}`;
        if (o.change === "meaning") add(subject, "OUTCOME_MEANING_CHANGED", "COORDINATED", "the same token now covers a different situation; copy and branching that relied on the old meaning must follow");
        else add(subject, "OUTCOME_ADDED", "COORDINATED", "a served operation answers a new reason; frontends branch on reason");
      }
    }
  }
  return changes;
}

const keyOf = (c) => `${c.layer}:${c.subject}:${c.change}`;

/** Every change of the proposals, attributed to CP-01, to a CP-02 item, or to both. */
/**
 * Changes of the payloads of registered events (declared in `eventPayloadChanges`, checked against the domain's allowlists): a key
 * added, a key that some events now omit, or new values of a token. A consumer of the event must follow each one.
 */
export function eventChanges(spec, domain) {
  const changes = [];
  for (const item of spec.items) {
    for (const ch of item.eventPayloadChanges ?? []) {
      const allow = domain.EVENT_PAYLOAD_ALLOWLIST[ch.eventType];
      if (!allow) throw new Error(`${item.id}: ${ch.eventType} is not a registered event`);
      const add = (key, change, detail) => changes.push({ layer: "EVENTS", subject: `${ch.eventType}:${key}`, change, class: "COORDINATED", detail, source: item.id });
      for (const k of ch.addKeys ?? []) {
        if (allow.includes(k)) throw new Error(`${item.id}: ${ch.eventType} already allows ${k}`);
        add(k, "KEY_ADDED", ch.note);
      }
      for (const k of ch.optionalKeys ?? []) {
        if (!allow.includes(k)) throw new Error(`${item.id}: ${ch.eventType} has no key ${k}`);
        add(k, "KEY_SOMETIMES_ABSENT", ch.note);
      }
      for (const [k, values] of Object.entries(ch.widenValues ?? {})) {
        if (!allow.includes(k)) throw new Error(`${item.id}: ${ch.eventType} has no key ${k}`);
        add(k, "VALUES_WIDENED", `${values.join(", ")}: ${ch.note}`);
      }
    }
  }
  return changes.map((c) => ({ key: keyOf(c), ...c }));
}

export function compatibility(spec, registry, cp01, cp02, live, proposedOpenapi, domain) {
  const combined = applyDeltas(registry, [cp01, cp02]);
  const all = registryChanges(registry, combined);
  const fromCp01 = new Set(registryChanges(registry, applyDeltas(registry, [cp01])).map(keyOf));
  const perItem = new Map();
  for (const item of cp02.items) for (const c of registryChanges(registry, applyDeltas(registry, [cp02], new Set([item.id])))) {
    const k = keyOf(c);
    perItem.set(k, [...(perItem.get(k) ?? []), item.id]);
  }
  const attributed = all.map((c) => {
    const k = keyOf(c);
    const sources = [...(fromCp01.has(k) ? ["CP-01"] : []), ...(perItem.get(k) ?? [])];
    return { key: k, ...c, source: sources.length ? sources.join(" + ") : "CP-01 + CP-02 together" };
  });
  const api = openapiChanges(live, proposedOpenapi).map((c) => {
    const mod = Object.entries(proposedOpenapi["x-kauro-modified"]).find(([key]) => c.subject.startsWith(`${key}:`) || Object.keys(proposedOpenapi["x-kauro-modified"][key].components).some((n) => c.subject.startsWith(`components/${n}.`) || c.subject === `components/${n}`));
    const op = c.change === "OPERATION_ADDED" ? /\((CP-02\.\d{2}),/.exec(c.detail)?.[1] : null;
    return { key: keyOf(c), ...c, source: op ?? mod?.[1].item ?? "CP-02" };
  });
  return [...attributed, ...api, ...eventChanges(spec, domain)];
}

// --- consumers ------------------------------------------------------------------------------------------------------------

const SCAN_ROOTS = ["apps", "packages", "tools"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "generated", "coverage", "vendor"]);
const SCAN_EXT = /\.(ts|tsx|mjs|js)$/;
let scanCache = null;

function sourceFiles() {
  if (scanCache) return scanCache;
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (SCAN_EXT.test(name)) out.push(full);
    }
  };
  for (const r of SCAN_ROOTS) walk(join(ROOT, r));
  // the generated web client is the browser's consumer of the served api (tools/web-client.mjs), kept although it is generated
  const client = join(ROOT, "apps", "web", "src", "api", "generated.ts");
  if (!out.includes(client)) out.push(client);
  scanCache = out.map((full) => ({ path: relative(ROOT, full).split(sep).join("/"), body: readFileSync(full, "utf8") })).filter((f) => !f.path.startsWith("tools/cp02") && !f.path.startsWith("tools/test/cp02"));
  return scanCache;
}

/**
 * Source files that consume the subject of a non-additive change: an import of the registry type from @kauro/contracts; a served
 * component by name; for an outcome of a served operation, the files that hold that operation's command-layer reason vocabulary; for
 * the Problem reason enum, the files that enumerate it (ten or more of its reasons).
 */
export function consumersOf(change, live) {
  const files = sourceFiles();
  let match;
  if (change.layer === "EVENTS") {
    const type = change.subject.split(":")[0];
    match = (body) => body.includes(`"${type}"`);
  } else if (change.layer === "REGISTRY") {
    const m = /^contracts\.json:([A-Za-z]+)/.exec(change.subject);
    if (!m) return [];
    const pattern = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${m[1]}\\b[^}]*\\}\\s+from\\s+"@kauro/contracts"`);
    match = (body) => pattern.test(body);
  } else if (change.subject.startsWith("components/Problem")) {
    const reasons = live.components.schemas.Problem.properties.reason.enum;
    match = (body) => reasons.filter((r) => body.includes(`"${r}"`)).length >= 10;
  } else if (change.subject.startsWith("components/")) {
    const name = /^components\/([A-Za-z]+)/.exec(change.subject)[1];
    const pattern = new RegExp(`\\b${name}\\b`);
    match = (body) => pattern.test(body);
  } else {
    const operationId = change.subject.split(":")[0];
    const served = [...Object.values(live.paths)].flatMap((m) => Object.values(m)).find((o) => o.operationId === operationId);
    if (!served) return [];
    const names = [operationId, served["x-kauro-command"]].filter(Boolean);
    const reasons = Object.values(served.responses).flatMap((r) => r["x-kauro-outcomes"] ?? []).filter((o) => o.layer === "COMMAND" && o.reason).map((o) => o.reason);
    match = (body) => names.some((n) => body.includes(n)) && reasons.some((r) => body.includes(`"${r}"`));
  }
  return [...new Set(files.filter((f) => match(f.body)).map((f) => f.path))].sort();
}

// --- generate / check -----------------------------------------------------------------------------------------------------

export async function buildAll() {
  const spec = loadSpec();
  const registry = loadRegistry();
  const { delta: cp01 } = loadCp01(spec);
  const cp02 = buildDelta(spec, registry);
  const combined = applyDeltas(registry, [cp01, cp02]);
  const bundle = generateBundle(combined);
  const { application, domain } = await loadModules();
  const live = readJson(PATHS.liveOpenapi);
  const openapi = buildOpenapi(spec, { bundle, live, application });
  const changes = compatibility(spec, registry, cp01, cp02, live, openapi, domain);
  const declared = new Map((spec.compatibility ?? []).map((d) => [d.key, d]));
  const matrix = {
    proposal: "CP-02",
    generatedBy: "tools/cp02.mjs; do not edit",
    base: { registry: loadProvenance().files, openapi: openapi.info["x-kauro-base"].openapi, cp01: spec.complementOf.sha256 },
    classes: {
      ADDITIVE: "No current consumer changes: a new contract, command, operation, case, policy key, or a relaxed request member.",
      TEXT: "Registry prose (precondition, effect, failure, case or requirement text); no shape changes.",
      COORDINATED: "A closed shape or vocabulary a current consumer validates gains a member or a value: the generated types, the web client and its guards are regenerated in the same change as the server (one re-issue), never one without the other.",
      BREAKING: "A current consumer breaks unless it changes its own logic: allowed only with a declared migration and the decision that accepted it.",
    },
    changes: changes.map((c) => ({ ...c, ...(RANK[c.class] >= 1 ? { consumers: consumersOf(c, live), declared: declared.get(c.key) ?? null } : {}) })),
  };
  return { spec, registry, cp01, cp02, combined, bundle, application, domain, live, openapi, matrix };
}

/**
 * The three generated files, their bytes, and how two versions are compared. The matrix's `consumers` lists follow the code base (a new
 * file that reads a coordinated component is found on the next generation) and are left out of the comparison, so unrelated work on
 * main never makes CP-02 stale; everything else is compared byte for byte.
 */
export function generatedOutputs(built) {
  const withoutConsumers = (body) => compactJson({ ...JSON.parse(body), changes: JSON.parse(body).changes.map(({ consumers, ...c }) => c) });
  return [
    [PATHS.delta, compactJson(built.cp02), (b) => b],
    [PATHS.openapi, text(built.openapi), (b) => b],
    [PATHS.compatibility, compactJson(built.matrix), withoutConsumers],
  ];
}

/** Whether a committed generated file is current. */
export function isCurrent([path, body, normalize]) {
  return existsSync(path) && normalize(readFileSync(path, "utf8")) === normalize(body);
}

async function main(mode) {
  const built = await buildAll();
  const outputs = generatedOutputs(built);
  if (mode === "generate") {
    for (const [path, body] of outputs) writeFileSync(path, body);
    console.log(`cp02: ${built.cp02.items.length} items, ${Object.values(built.openapi.paths).reduce((n, m) => n + Object.keys(m).length, 0)} proposed operations, ${built.matrix.changes.length} changes`);
    return 0;
  }
  if (mode === "check") {
    const stale = outputs.filter((output) => !isCurrent(output)).map(([path]) => relative(ROOT, path));
    if (stale.length > 0) {
      console.error(`cp02: not the generated output (run node tools/cp02.mjs generate): ${stale.join(", ")}`);
      return 1;
    }
    console.log("cp02: generated files are current");
    return 0;
  }
  if (mode === "explain") {
    for (const c of built.matrix.changes.filter((c) => RANK[c.class] >= 1)) console.log(JSON.stringify({ key: c.key, class: c.class, source: c.source, consumers: c.consumers }));
    return 0;
  }
  console.error("usage: node tools/cp02.mjs generate|check|explain");
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv[2]);
}

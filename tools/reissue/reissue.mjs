// Order 19A: the joint re-issue candidate of ChangeProposals CP-01 (revision 3) and CP-02 — generator and checker.
//
//   node tools/reissue/reissue.mjs generate               writes the candidate under docs/authority/proposals/reissue-candidate/ from
//                                                          its hand-written source (REISSUE-CANDIDATE.source.json), the two deltas and
//                                                          the bytes in force
//   node tools/reissue/reissue.mjs check                  exits 1 when a committed candidate file is not the generated one (an input,
//                                                          the registry, the served api or a generated consumer in force moved)
//   node tools/reissue/reissue.mjs materialize <profile> <dir>
//                                                          writes one profile's candidate registry (with a candidate PROVENANCE.json),
//                                                          generated contracts, served document and web client into a new empty <dir>,
//                                                          for an implementing order that builds against the candidate with its
//                                                          activation off
//
// A candidate is not authority (docs/authority/proposals/README.md, D-34 §1.3): nothing here writes packages/contracts/registry,
// apps/api/openapi.json, apps/web/src/api/generated.ts or packages/contracts/src/generated. Adoption is Order 19B's, only with the owner's
// explicit approval of that PR and SHA; an adopted item takes effect only with its activation.
//
// Two profiles are produced, each a closed set of items applied in one order (CP-01's items, then CP-02's, each in its own order):
//   adoption  the APPROVED_AWAITING_REISSUE items: the most Order 19B may adopt, once the owner approves and each activation holds;
//   build     adoption plus the CONDITIONAL items (principle and values decided, adoption blocked by a named condition): the contract the
//             implementing orders build and test against with the activation off. PROPOSED items (undecided or deferred) are in neither.
//
// Requires the workspace to be built (pnpm run build, or tools/prepare-fast.mjs), as tools/cp02.mjs does.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT, PATHS as CP02_PATHS, applyDeltas, buildDelta, buildOpenapi, canonicalHash, compactJson, compatibility, loadCp01, loadModules,
  loadProvenance, loadRegistry, loadSpec, readJson, sha256,
} from "../cp02.mjs";
import { digestOf, renderClient } from "../web-client.mjs";

export { ROOT };
const PROPOSALS = join(ROOT, "docs", "authority", "proposals");
const DIR = join(PROPOSALS, "reissue-candidate");
export const PATHS = {
  dir: DIR,
  source: join(DIR, "REISSUE-CANDIDATE.source.json"),
  manifest: join(DIR, "REISSUE-CANDIDATE.json"),
  combined: join(DIR, "REISSUE-CANDIDATE.combined-delta.json"),
  cp01Delta: join(PROPOSALS, "CP-01.registry-delta.json"),
  cp02Delta: CP02_PATHS.delta,
  cp02Spec: CP02_PATHS.spec,
  cp02Openapi: CP02_PATHS.openapi,
  cp02Compatibility: CP02_PATHS.compatibility,
};
/** The bytes in force the candidate is written against and must never change (Order 19A's forbidden paths). */
export const IN_FORCE = {
  registry: join(ROOT, "packages", "contracts", "registry"),
  openapi: CP02_PATHS.liveOpenapi,
  webClient: CP02_PATHS.webClient,
  contractsTypes: join(ROOT, "packages", "contracts", "src", "generated", "types.ts"),
  contractsSchemas: join(ROOT, "packages", "contracts", "src", "generated", "schemas.json"),
};
export const PROFILES = ["adoption", "build"];
/** The files of one profile, relative to the candidate folder. */
export const OUTPUTS = {
  registryProvenance: "registry.provenance.json",
  contractsTypes: "contracts/types.ts",
  contractsSchemas: "contracts/schemas.json",
  openapi: "api/openapi.json",
  webClient: "web/generated.ts",
};
const COMPONENTS = "#/components/schemas/";
const RANK = { ADDITIVE: 0, TEXT: 0, COORDINATED: 1, BREAKING: 2 };
const posix = (p) => p.split("\\").join("/");
const rel = (p) => posix(relative(ROOT, p));
const clone = (v) => structuredClone(v);
const text = (v) => `${JSON.stringify(v, null, 2)}\n`;
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

export function loadSource() {
  return readJson(PATHS.source);
}

// --- inputs --------------------------------------------------------------------------------------------------------------------

/** CP-02's committed compatibility matrix without its consumer lists (they follow unrelated code: tools/cp02.mjs generatedOutputs). */
export function compatibilityCore(body) {
  const m = JSON.parse(body);
  return compactJson({ ...m, changes: m.changes.map(({ consumers, ...c }) => c) });
}

/** The current bytes of every input the source pins, by name. `read` lets a test substitute bytes without touching the disk. */
export function inputDigests(read = (p) => readFileSync(p)) {
  return {
    "CP-01.registry-delta.json": sha256(read(PATHS.cp01Delta)),
    "CP-02.registry-delta.json": sha256(read(PATHS.cp02Delta)),
    "CP-02.api.json": sha256(read(PATHS.cp02Spec)),
    "CP-02.openapi.json": sha256(read(PATHS.cp02Openapi)),
    "CP-02.compatibility.json (without consumers)": sha256(compatibilityCore(read(PATHS.cp02Compatibility).toString("utf8"))),
  };
}

/** Throws unless every pinned input still has the bytes the candidate was prepared from. */
export function checkInputs(source, read = (p) => readFileSync(p)) {
  const now = inputDigests(read);
  for (const [name, pin] of Object.entries(source.inputs.pins)) {
    if (now[name] === undefined) throw new Error(`the source pins ${name}, which is not an input of the candidate`);
    if (now[name] !== pin) throw new Error(`input ${name} has sha256 ${now[name]}, not the ${pin} the candidate was prepared from: re-verify the candidate against the changed proposal before regenerating`);
  }
  for (const name of Object.keys(now)) if (!Object.hasOwn(source.inputs.pins, name)) throw new Error(`input ${name} is not pinned by the source`);
  for (const record of source.inputs.records) {
    if (!existsSync(join(ROOT, record.path))) throw new Error(`record ${record.path} does not exist`);
    const actual = sha256(read(join(ROOT, record.path)));
    if (actual !== record.sha256) throw new Error(`record ${record.path} has sha256 ${actual}, not the ${record.sha256} the candidate carries its states from`);
  }
}

/** The bytes in force, by repository path. */
export function inForceDigests(read = (p) => readFileSync(p)) {
  const provenance = JSON.parse(read(join(IN_FORCE.registry, "PROVENANCE.json")).toString("utf8"));
  const out = {};
  for (const file of [...Object.keys(provenance.files), "PROVENANCE.json"]) out[rel(join(IN_FORCE.registry, file))] = sha256(read(join(IN_FORCE.registry, file)));
  for (const key of ["openapi", "webClient", "contractsTypes", "contractsSchemas"]) out[rel(IN_FORCE[key])] = sha256(read(IN_FORCE[key]));
  return out;
}

/** Throws unless every byte in force is the one the candidate recorded (and the registry still matches its own provenance). */
export function checkInForce(recorded, read = (p) => readFileSync(p)) {
  const now = inForceDigests(read);
  const provenance = JSON.parse(read(join(IN_FORCE.registry, "PROVENANCE.json")).toString("utf8"));
  for (const [file, hash] of Object.entries(provenance.files)) {
    if (now[rel(join(IN_FORCE.registry, file))] !== hash) throw new Error(`packages/contracts/registry/${file} no longer matches its PROVENANCE.json: the registry in force was edited`);
  }
  for (const [path, hash] of Object.entries(recorded)) {
    if (now[path] === undefined) throw new Error(`${path} is recorded in force but no longer exists`);
    if (now[path] !== hash) throw new Error(`${path} in force has sha256 ${now[path]}, not the ${hash} the candidate recorded: Order 19A never changes it; if another order changed it legitimately, regenerate the candidate (node tools/reissue/reissue.mjs generate)`);
  }
  for (const path of Object.keys(now)) if (!Object.hasOwn(recorded, path)) throw new Error(`${path} is in force but not recorded by the candidate`);
}

// --- items, states and profiles ------------------------------------------------------------------------------------------------

/** Every item of both proposals in apply order, with what the candidate carries for it. */
export function itemsOf(cp01, cp02) {
  return [
    ...cp01.items.map((d) => ({ proposal: "CP-01", delta: d, state: d.status, class: null })),
    ...cp02.items.map((d) => ({ proposal: "CP-02", delta: d, state: d.status, class: d.class })),
  ];
}

/** The ids of a profile: the items whose state the profile admits. */
export function profileItems(source, items, profile) {
  const admitted = new Set(source.profiles[profile].states);
  return items.filter((i) => admitted.has(i.state)).map((i) => i.delta.id);
}

/** Throws unless every item of the set brings the CP-01 items it requires and the items it depends on. */
export function checkClosed(items, ids, label) {
  const set = new Set(ids);
  for (const i of items) {
    if (!set.has(i.delta.id)) continue;
    for (const r of [...(i.delta.requires ?? []), ...(i.delta.dependsOn ?? [])]) {
      if (!set.has(r)) throw new Error(`${label}: ${i.delta.id} needs ${r}, which the profile leaves out`);
    }
  }
}

// --- conflicts between items -------------------------------------------------------------------------------------------------

function tokensOf(pointer) {
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Where a write lands: in an array file, the appended records or one record (by index, with its id, name or contract); in an object
 * file (policy.json), the object an `add` puts a new key into, or the exact key a `replace` changes.
 */
function placeOf(registry, file, op) {
  const t = tokensOf(op.path);
  if (Array.isArray(registry[file])) {
    if (t[0] === "-") return { entity: `${file} (appended records)`, append: true };
    const row = registry[file][Number(t[0])];
    return { entity: `${file}[${t[0]}] ${row?.id ?? row?.name ?? row?.contract ?? "?"}`, append: t.at(-1) === "-" ? t.slice(1, -1).join(".") : null };
  }
  if (op.op === "add") return { entity: `${file}:${t.slice(0, -1).join(".") || "(root)"} (added keys)`, append: true };
  return { entity: `${file}:${t.join(".")}`, append: null };
}

const isPrefix = (a, b) => a === b || b.startsWith(`${a}/`);

/** Whether `later` needs `earlier` (requires or dependsOn, transitively). */
function needs(items, later, earlier) {
  const byId = new Map(items.map((i) => [i.delta.id, i]));
  const seen = new Set();
  const walk = (id) => {
    for (const r of [...(byId.get(id)?.delta.requires ?? []), ...(byId.get(id)?.delta.dependsOn ?? [])]) {
      if (r === earlier) return true;
      if (!seen.has(r)) {
        seen.add(r);
        if (walk(r)) return true;
      }
    }
    return false;
  };
  return walk(later);
}

/**
 * Every place where two items meet, computed from the deltas:
 *   APPENDS_TO_THE_SAME_ARRAY        records appended to one file, or entries to one nested list (a gate's caseIds): the apply order
 *                                    fixes their positions;
 *   KEYS_ADDED_TO_THE_SAME_OBJECT    new keys of one policy object: distinct keys, the apply order fixes their order;
 *   SAME_RECORD_DISJOINT_MEMBERS     one record, different members (proved disjoint below);
 *   NESTED_ADD_ON_A_DEPENDENCY       an item adds inside a key that an item it needs adds first;
 * and the two that are never resolvable (CP-01's rule, one owner per path): WRITE_WRITE_OVERLAP (two items write the same or nested
 * paths) and TEST_OF_A_PATH_ANOTHER_ITEM_WRITES (an item proves a value another item changes, so the result depends on the order).
 */
export function computeConflicts(registry, items) {
  const order = new Map(items.map((i, n) => [i.delta.id, n]));
  const writes = [];
  const tests = [];
  for (const i of items) {
    for (const [file, ops] of Object.entries(i.delta.patch)) {
      for (const op of ops) {
        if (op.op === "test") tests.push({ item: i.delta.id, file, path: op.path });
        else writes.push({ item: i.delta.id, file, path: op.path, op: op.op, ...placeOf(registry, file, op) });
      }
    }
  }
  const byEntity = new Map();
  for (const w of writes) {
    if (!byEntity.has(w.entity)) byEntity.set(w.entity, []);
    byEntity.get(w.entity).push(w);
  }
  const conflicts = [];
  for (const [entity, ws] of byEntity) {
    const members = [...new Set(ws.map((w) => w.item))].sort();
    if (members.length < 2) continue;
    let kind = "SAME_RECORD_DISJOINT_MEMBERS";
    if (ws.every((w) => w.append === true)) kind = entity.endsWith("(added keys)") ? "KEYS_ADDED_TO_THE_SAME_OBJECT" : "APPENDS_TO_THE_SAME_ARRAY";
    else if (ws.every((w) => typeof w.append === "string" && w.append === ws[0].append)) kind = "APPENDS_TO_THE_SAME_ARRAY";
    conflicts.push({ entity: kind === "APPENDS_TO_THE_SAME_ARRAY" && typeof ws[0].append === "string" ? `${entity} ${ws[0].append}` : entity, kind, items: members });
  }
  for (const a of writes) {
    for (const b of writes) {
      if (a === b || a.item === b.item || a.file !== b.file || a.path.endsWith("/-") || b.path.endsWith("/-")) continue;
      if (a.path === b.path) conflicts.push({ entity: `${a.file}${a.path}`, kind: "WRITE_WRITE_OVERLAP", items: [a.item, b.item].sort() });
      else if (isPrefix(a.path, b.path)) {
        const resolvable = a.op === "add" && order.get(a.item) < order.get(b.item) && needs(items, b.item, a.item);
        conflicts.push({ entity: `${a.file}${a.path}`, kind: resolvable ? "NESTED_ADD_ON_A_DEPENDENCY" : "WRITE_WRITE_OVERLAP", items: [a.item, b.item].sort() });
      }
    }
    for (const t of tests) {
      if (t.item === a.item || t.file !== a.file) continue;
      // an append changes no existing element: only a test of the whole list (or of a container of it) depends on it
      const hit = a.path.endsWith("/-") ? isPrefix(t.path, a.path.slice(0, -2)) : isPrefix(a.path, t.path) || isPrefix(t.path, a.path);
      if (hit) {
        conflicts.push({ entity: `${a.file}${a.path}`, kind: "TEST_OF_A_PATH_ANOTHER_ITEM_WRITES", items: [a.item, t.item].sort() });
      }
    }
  }
  const key = (c) => `${c.kind} ${c.entity} ${c.items.join(",")}`;
  const unique = new Map(conflicts.map((c) => [key(c), c]));
  return [...unique.values()].sort((x, y) => (key(x) < key(y) ? -1 : 1));
}

/** The kinds a declaration may resolve; the two overlaps never are (CP-01's rule: one owner per path). */
const RESOLVABLE = new Set(["APPENDS_TO_THE_SAME_ARRAY", "KEYS_ADDED_TO_THE_SAME_OBJECT", "SAME_RECORD_DISJOINT_MEMBERS", "NESTED_ADD_ON_A_DEPENDENCY"]);

/** Throws unless every computed meeting point is declared with a resolution, and every declaration is still computed. */
export function checkConflicts(declared, computed) {
  const keyOf = (c) => `${c.kind} ${c.entity}`;
  const byKey = new Map(declared.map((d) => [keyOf(d), d]));
  for (const c of computed) {
    if (!RESOLVABLE.has(c.kind)) throw new Error(`${c.kind} on ${c.entity} between ${c.items.join(" and ")}: two items may never write the same or nested paths, or test a path another writes`);
  }
  for (const c of computed) {
    const d = byKey.get(keyOf(c));
    if (!d) throw new Error(`${c.kind} on ${c.entity} (${c.items.join(", ")}) is not declared with its resolution`);
    if (JSON.stringify(d.items) !== JSON.stringify(c.items)) throw new Error(`${c.entity}: declared between ${d.items.join(", ")}, computed between ${c.items.join(", ")}`);
    if (typeof d.resolution !== "string" || d.resolution.length < 20) throw new Error(`${c.entity}: the declaration states no resolution`);
  }
  for (const d of declared) if (!computed.some((c) => keyOf(c) === keyOf(d))) throw new Error(`${d.kind} on ${d.entity} is declared but no longer computed`);
}

// --- the registry, contracts, served document and web client of a profile ------------------------------------------------------

/** The registry files of a set of items: touched files as canonical JSON, untouched files byte for byte. */
export function registryFiles(registry, cp01, cp02, ids) {
  const provenance = loadProvenance();
  const applied = applyDeltas(registry, [cp01, cp02], new Set(ids));
  const touched = new Set();
  for (const d of [...cp01.items, ...cp02.items]) if (ids.includes(d.id)) for (const file of Object.keys(d.patch)) touched.add(file);
  const files = {};
  for (const file of Object.keys(provenance.files)) {
    files[file] = touched.has(file) ? Buffer.from(text(applied[file])) : readFileSync(join(IN_FORCE.registry, file));
  }
  return { applied, files, touched: [...touched] };
}

/**
 * The PROVENANCE.json of a candidate registry: its source names the candidate and says it is not adopted, before the base's source, so
 * no file generated from it (the contracts' headers quote the source) or materialized with it can pass for the authority in force.
 */
export function candidateProvenance(files, { candidate, profile }) {
  const base = loadProvenance();
  return {
    ...base,
    source: `CANDIDATE ${candidate} (${profile} profile), NOT ADOPTED; base: ${base.source}`,
    status: "CANDIDATE_NOT_ADOPTED",
    candidate,
    profile,
    files: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha256(b)])),
  };
}

/** The first lines of a candidate web client: the closed generator's header names apps/api/openapi.json, which is not its source here. */
export const clientMarker = ({ candidate, profile }) => [
  `// CANDIDATE ${candidate} (${profile} profile), NOT ADOPTED (status CANDIDATE_NOT_ADOPTED): generated by tools/reissue/reissue.mjs with tools/web-client.mjs`,
  `// from docs/authority/proposals/reissue-candidate/${profile}/api/openapi.json, not from apps/api/openapi.json as the generator's own header below says.`,
  "",
].join("\n");

/**
 * Runs the authority's contracts generator (packages/contracts/tools/generate.mjs, unchanged) on the candidate registry in a fresh
 * temporary directory and returns its two outputs; their headers quote the candidate's provenance source. Cleanup is file by file, never
 * recursive (S088): anything else left there makes rmdir fail rather than be deleted unseen.
 */
export function generateContracts(files, label = { candidate: "an unnamed re-issue candidate", profile: "unnamed" }) {
  const dir = mkdtempSync(join(tmpdir(), "kauro-reissue-"));
  const written = [...Object.keys(files), "PROVENANCE.json"].map((f) => join(dir, "registry", f));
  const generated = ["types.ts", "schemas.json"].map((f) => join(dir, "src", "generated", f));
  const script = join(dir, "tools", "generate.mjs");
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "registry"));
    copyFileSync(join(ROOT, "packages", "contracts", "tools", "generate.mjs"), script);
    for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, "registry", file), bytes);
    writeFileSync(join(dir, "registry", "PROVENANCE.json"), JSON.stringify(candidateProvenance(files, label), null, 2));
    const run = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`the contracts generator refused the candidate registry: ${run.stdout}${run.stderr}`);
    return { types: readFileSync(generated[0]), schemas: readFileSync(generated[1]) };
  } finally {
    for (const f of [...written, ...generated, script]) if (existsSync(f)) unlinkSync(f);
    for (const d of [join(dir, "src", "generated"), join(dir, "src"), join(dir, "registry"), join(dir, "tools"), dir]) if (existsSync(d)) rmdirSync(d);
  }
}

/**
 * The proposed components whose name a served component already holds with another schema, and that the proposal does not declare as
 * a modification of it: two meanings under one name cannot share one served document.
 */
export function componentCollisions(live, proposal) {
  const modified = new Set(Object.values(proposal["x-kauro-modified"]).flatMap((m) => Object.entries(m.components).filter(([, c]) => !c.new).map(([n]) => n)));
  return Object.entries(proposal.components.schemas)
    .filter(([name, schema]) => live.components.schemas[name] && !modified.has(name) && JSON.stringify(live.components.schemas[name]) !== JSON.stringify(schema))
    .map(([name]) => name)
    .sort();
}

/** The proposal with the declared components renamed; throws unless the declarations are exactly the collisions of this proposal. */
export function renameComponents(live, proposal, renames) {
  const collisions = componentCollisions(live, proposal);
  const declared = Object.keys(renames).filter((n) => proposal.components.schemas[n]).sort();
  if (JSON.stringify(collisions) !== JSON.stringify(declared)) throw new Error(`proposed components that collide with served ones: ${collisions.join(", ") || "none"}; renamed by the source: ${declared.join(", ") || "none"}`);
  if (declared.length === 0) return proposal;
  const copy = clone(proposal);
  for (const name of declared) {
    const to = renames[name].to;
    if (live.components.schemas[to] || copy.components.schemas[to]) throw new Error(`${name} cannot be renamed ${to}: the name is taken`);
  }
  const map = new Map(declared.map((n) => [COMPONENTS + n, COMPONENTS + renames[n].to]));
  // an unchanged copy of a served component keeps the served references; the proposal's own and modified components are rewritten
  const servedCopies = new Set(Object.keys(copy.components.schemas).filter((n) => !declared.includes(n) && JSON.stringify(live.components.schemas[n]) === JSON.stringify(copy.components.schemas[n])));
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "$ref" && map.has(v) ? map.get(v) : rewrite(v)]));
  };
  const schemas = {};
  for (const [name, schema] of Object.entries(copy.components.schemas)) {
    if (servedCopies.has(name)) schemas[name] = schema;
    else if (declared.includes(name)) schemas[renames[name].to] = { ...rewrite(schema), title: renames[name].to };
    else schemas[name] = rewrite(schema);
  }
  copy.components.schemas = schemas;
  copy.paths = rewrite(copy.paths);
  copy["x-kauro-modified"] = rewrite(copy["x-kauro-modified"]);
  return copy;
}

/** CP-02's source restricted to some items (the OpenAPI, event and compatibility builders read `items` only). */
export const specOf = (spec, ids) => ({ ...spec, items: spec.items.filter((i) => ids.includes(i.id)) });
const deltaOf = (delta, ids) => ({ ...delta, items: delta.items.filter((i) => ids.includes(i.id)) });

const PROBLEM_DESCRIPTION = /^Problem \(10 "Responses and safe errors"\): the (?:outcome|\d+ outcomes) of this operation answered (\d{3}), listed in x-kauro-outcomes; frontends branch on code and reason, never on the title\.$/;
const problemDescription = (n, status) => `Problem (10 "Responses and safe errors"): the ${n === 1 ? "outcome" : `${n} outcomes`} of this operation answered ${status}, listed in x-kauro-outcomes; frontends branch on code and reason, never on the title.`;

/**
 * The served document as the candidate would have it: the served api in force, plus each proposed operation of the profile under
 * `x-kauro-planned` (keyed "METHOD path": designed, no route serves it until its implementing order does), each modified served component
 * in its proposed form, each new outcome of a served operation added to its status (and a changed meaning replacing the old one), and the
 * proposed Problem reasons. A component of the proposal with a served name must be the served one unless the proposal modifies it, or
 * be renamed by a declared resolution (`renames`: proposed name -> candidate name, every reference inside the proposal rewritten).
 */
export function candidateDocument(live, proposedDocument, meta, renames = {}) {
  const proposal = renameComponents(live, proposedDocument, renames);
  const doc = clone(live);
  const servedOps = new Map();
  for (const [path, methods] of Object.entries(live.paths)) for (const [m, o] of Object.entries(methods)) servedOps.set(o.operationId, { path, method: m });
  const planned = { ...(doc["x-kauro-planned"] ?? {}) };
  for (const [path, methods] of Object.entries(proposal.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      const key = `${m.toUpperCase()} ${path}`;
      if (planned[key] || live.paths[path]?.[m]) throw new Error(`${key} is already served or planned`);
      if (servedOps.has(op.operationId)) throw new Error(`operationId ${op.operationId} is already served`);
      planned[key] = clone(op);
    }
  }
  doc["x-kauro-planned"] = sorted(planned);
  const modified = new Map();
  for (const mod of Object.values(proposal["x-kauro-modified"])) {
    for (const [name, c] of Object.entries(mod.components)) {
      if (c.new) continue;
      if (!live.components.schemas[name]) throw new Error(`${name} is modified but not served`);
      if (canonicalHash(live.components.schemas[name]) !== c.baseSha256) throw new Error(`${name}: the proposal was written against another served component (baseSha256)`);
      modified.set(name, c.proposed);
    }
  }
  const schemas = { ...doc.components.schemas };
  for (const [name, schema] of Object.entries(proposal.components.schemas)) {
    if (modified.has(name)) schemas[name] = clone(modified.get(name));
    else if (live.components.schemas[name]) {
      if (JSON.stringify(live.components.schemas[name]) !== JSON.stringify(schema)) throw new Error(`component ${name}: the proposal's differs from the served one and is not declared modified`);
    } else schemas[name] = clone(schema);
  }
  doc.components.schemas = sorted(schemas);
  for (const [name, parameter] of Object.entries(proposal.components.parameters)) {
    if (JSON.stringify(live.components.parameters[name]) !== JSON.stringify(parameter)) throw new Error(`parameter ${name} differs from the served one`);
  }
  for (const [operationId, mod] of Object.entries(proposal["x-kauro-modified"])) {
    if (!mod.path) continue;
    const served = doc.paths[mod.path]?.[mod.method.toLowerCase()];
    if (!served || served.operationId !== operationId) throw new Error(`${operationId} is not served at ${mod.method} ${mod.path}`);
    for (const [status, response] of Object.entries(mod.outcomes)) {
      for (const o of response["x-kauro-outcomes"]) {
        const entry = { code: o.code, ...(o.reason ? { reason: o.reason } : {}), ...(o.fieldCodes ? { fieldCodes: [...o.fieldCodes] } : {}), layer: o.layer, meaning: o.meaning };
        const target = served.responses[status];
        if (o.change === "meaning") {
          const listed = target?.["x-kauro-outcomes"]?.find((x) => x.code === o.code && x.reason === o.reason);
          if (!listed) throw new Error(`${operationId}: ${o.code}/${o.reason} is not served at ${status}, its meaning cannot change`);
          listed.meaning = o.meaning;
          continue;
        }
        if (!target) throw new Error(`${operationId}: no served ${status} response to add ${o.code}/${o.reason} to`);
        if (target["x-kauro-outcomes"].some((x) => x.code === o.code && x.reason === o.reason)) throw new Error(`${operationId}: ${o.code}/${o.reason} is already served at ${status}`);
        target["x-kauro-outcomes"].push(entry);
        const m = PROBLEM_DESCRIPTION.exec(target.description);
        if (!m || m[1] !== status) throw new Error(`${operationId} ${status}: the served description is not the generator's Problem description`);
        target.description = problemDescription(target["x-kauro-outcomes"].length, status);
      }
    }
  }
  doc.info = { ...doc.info, "x-kauro-candidate": meta };
  return doc;
}

/**
 * The closed web client generator translates application/json replies only; a binary reply (the statement export, CP-02.13) is listed
 * here and its content left out of the copy the client is generated from, never silently: each adaptation is recorded in the manifest.
 */
export function webClientInput(document) {
  const copy = clone(document);
  const adaptations = [];
  for (const [key, op] of Object.entries(copy["x-kauro-planned"] ?? {})) {
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      const media = Object.keys(response.content ?? {});
      const binary = media.filter((t) => !/json$/.test(t));
      if (binary.length === 0) continue;
      if (binary.length !== media.length) throw new Error(`${key} ${status}: mixes JSON and binary replies`);
      adaptations.push({ operation: key, operationId: op.operationId, status, contentLeftOut: binary, why: "the closed web client generator translates application/json replies only; the browser downloads the export by URL, outside the typed client" });
      op.responses[status] = { description: response.description };
    }
  }
  return { input: copy, adaptations };
}

// --- building everything -------------------------------------------------------------------------------------------------------

/** Loads every input; throws when a pin, a state carried from the records or a profile's closure is wrong. */
export async function loadAll() {
  const source = loadSource();
  checkInputs(source);
  const spec = loadSpec();
  const registry = loadRegistry();
  const { delta: cp01 } = loadCp01(spec);
  const cp02 = readJson(PATHS.cp02Delta);
  const regenerated = buildDelta(spec, registry);
  if (compactJson(regenerated) !== readFileSync(PATHS.cp02Delta, "utf8")) throw new Error("CP-02's committed delta is not the one tools/cp02.mjs generates from CP-02.api.json (run node tools/cp02.mjs check)");
  const { application, domain } = await loadModules();
  const live = readJson(IN_FORCE.openapi);
  return { source, spec, registry, cp01, cp02, application, domain, live };
}

export function buildProfile(ctx, profile, ids) {
  const { source, spec, registry, cp01, cp02, application, domain, live } = ctx;
  const { applied, files, touched } = registryFiles(registry, cp01, cp02, ids);
  const label = { candidate: source.candidate, profile };
  const contracts = generateContracts(files, label);
  const bundle = JSON.parse(contracts.schemas.toString("utf8"));
  const cp02Ids = ids.filter((id) => id.startsWith("CP-02."));
  const subSpec = specOf(spec, cp02Ids);
  const proposal = buildOpenapi(subSpec, { bundle, live, application });
  const meta = {
    candidate: source.candidate,
    profile,
    status: "CANDIDATE_NOT_ADOPTED",
    items: ids,
    note: "Generated by tools/reissue/reissue.mjs; do not edit. The served api in force plus, for the items of this profile, the proposed operations under x-kauro-planned (no route serves them), the modified served components and outcomes, and the proposed Problem reasons. Nothing here is served or adopted.",
    base: { openapi: sha256(readFileSync(IN_FORCE.openapi)), webClient: sha256(readFileSync(IN_FORCE.webClient)) },
  };
  const document = candidateDocument(live, proposal, meta, Object.fromEntries(Object.entries(source.componentRenames ?? {}).filter(([n]) => proposal.components.schemas[n])));
  const documentText = text(document);
  const { input, adaptations } = webClientInput(document);
  const client = renderClient(input, digestOf(documentText));
  if (client.failures.length > 0) throw new Error(`the web client generator refused the ${profile} document: ${client.failures.join("; ")}`);
  const changes = compatibility(subSpec, registry, deltaOf(cp01, ids), deltaOf(cp02, ids), live, proposal, domain);
  const provenance = loadProvenance();
  const registryProvenance = {
    candidate: source.candidate,
    profile,
    status: "CANDIDATE_NOT_ADOPTED",
    generatedBy: "tools/reissue/reissue.mjs; do not edit",
    baseEdition: registry["policy.json"].edition,
    edition: "unchanged: Order 19B sets the new edition label, source and vendored_at when it adopts, as one recorded act",
    baseFiles: provenance.files,
    files: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha256(b)])),
    changedFiles: Object.keys(provenance.files).filter((f) => touched.includes(f)),
  };
  const outputs = {
    [OUTPUTS.registryProvenance]: Buffer.from(text(registryProvenance)),
    [OUTPUTS.contractsTypes]: contracts.types,
    [OUTPUTS.contractsSchemas]: contracts.schemas,
    [OUTPUTS.openapi]: Buffer.from(documentText),
    [OUTPUTS.webClient]: Buffer.from(clientMarker(label) + client.text),
  };
  return { profile, ids, applied, files, bundle, proposal, document, client: client.text, clientMarker: clientMarker(label), adaptations, changes, outputs, registryProvenance };
}

/** Records per registry file, before and after (the registry's own tests pin some of these counts). */
const countsOf = (base, after) => Object.fromEntries(Object.keys(after).filter((f) => Array.isArray(after[f])).map((f) => [f, `${base[f].length} -> ${after[f].length}`]));

const summarize = (changes) => ({
  total: changes.length,
  byLayer: sorted(changes.reduce((a, c) => ({ ...a, [c.layer]: (a[c.layer] ?? 0) + 1 }), {})),
  byClass: sorted(changes.reduce((a, c) => ({ ...a, [c.class]: (a[c.class] ?? 0) + 1 }), {})),
});

/** The digest of a set of compatibility changes: what makes two matrices the same (key, class and attribution, in key order). */
export const changesDigest = (changes) => sha256(JSON.stringify(changes.map((c) => [c.key, c.class, c.source]).sort((a, b) => (a[0] < b[0] ? -1 : 1))));

/**
 * The compatibility revalidation: CP-02's matrix, recomputed on the candidate with every item, equals the committed one, and the 271
 * changes recorded before Order 17's final review are all still there, with the same class and attribution, beside the ones that review
 * added.
 */
export function checkCompatibility(source, full, committedCore) {
  const committed = JSON.parse(committedCore).changes;
  const strip = (c) => JSON.stringify({ key: c.key, layer: c.layer, subject: c.subject, change: c.change, class: c.class, detail: c.detail, source: c.source });
  const recomputed = full.map(strip).sort();
  const recorded = committed.map(strip).sort();
  if (JSON.stringify(recomputed) !== JSON.stringify(recorded)) {
    const a = new Set(recomputed);
    const b = new Set(recorded);
    throw new Error(`the matrix recomputed on the candidate differs from CP-02.compatibility.json: ${[...a].filter((x) => !b.has(x)).slice(0, 3).join(" ")} | ${[...b].filter((x) => !a.has(x)).slice(0, 3).join(" ")}`);
  }
  const r = source.compatibility.recorded;
  const added = new Set(source.compatibility.addedByTheFinalReview);
  for (const k of added) if (!full.some((c) => c.key === k)) throw new Error(`${k}, added by Order 17's final review, is no longer computed`);
  const earlier = full.filter((c) => !added.has(c.key));
  if (earlier.length !== r.count) throw new Error(`${earlier.length} changes besides the final review's, not the ${r.count} recorded at ${r.commit}`);
  if (changesDigest(earlier) !== r.digest) throw new Error(`the ${r.count} changes recorded at ${r.commit} are not all present with the same class and attribution`);
  const layers = summarize(earlier).byLayer;
  if (JSON.stringify(layers) !== JSON.stringify(sorted(r.byLayer))) throw new Error(`the ${r.count} changes are ${JSON.stringify(layers)} by layer, not ${JSON.stringify(r.byLayer)}`);
  if (full.length !== r.count + added.size) throw new Error(`${full.length} changes, not ${r.count} + ${added.size}`);
}

// --- states carried from the records -------------------------------------------------------------------------------------------

/** The owner resolution's table (item -> "In the proposal" column) and CP-02's record table (item -> class). */
export function recordedStates(resolutionText, cp02RecordText) {
  const cp01 = {};
  for (const line of resolutionText.split("\n")) {
    // the last cell holds the state as its one backticked token ("Delta corrected; `APPROVED_AWAITING_REISSUE`, ...")
    const m = /^\| (CP-01\.\d{2}) \| .* \|([^|]*)\|$/.exec(line);
    const state = m && [...m[2].matchAll(/`([A-Z_]+)`/g)];
    if (state?.length === 1) cp01[m[1]] = state[0][1];
  }
  const cp02 = {};
  for (const line of cp02RecordText.split("\n")) {
    const m = /^\| (CP-02\.\d{2}) \| O17-\d{2} \| ([A-Z_]+) \|/.exec(line);
    if (m) cp02[m[1]] = m[2];
  }
  return { cp01, cp02 };
}

/** Throws unless every item carries exactly the state its record gives it, and the source's declaration agrees. */
export function checkStates(source, items, recorded) {
  for (const i of items) {
    const id = i.delta.id;
    const declared = source.items[id];
    if (!declared) throw new Error(`${id} has no entry in the candidate source`);
    if (i.proposal === "CP-01") {
      if (recorded.cp01[id] !== i.state) throw new Error(`${id}: the owner resolution records ${recorded.cp01[id]}, the candidate carries ${i.state}`);
    } else if (recorded.cp02[id] !== i.class) throw new Error(`${id}: CP-02's record classes it ${recorded.cp02[id]}, the candidate carries ${i.class}`);
    if (declared.state !== i.state) throw new Error(`${id}: the source declares ${declared.state}, the delta carries ${i.state}`);
    if (i.proposal === "CP-02" && declared.class !== i.class) throw new Error(`${id}: the source declares class ${declared.class}, the delta ${i.class}`);
  }
  for (const id of Object.keys(source.items)) if (!items.some((i) => i.delta.id === id)) throw new Error(`the source names ${id}, which neither proposal has`);
  const cp01Count = Object.keys(recorded.cp01).length;
  const cp02Count = Object.keys(recorded.cp02).length;
  if (cp01Count !== items.filter((i) => i.proposal === "CP-01").length || cp02Count !== items.filter((i) => i.proposal === "CP-02").length) {
    throw new Error(`the records list ${cp01Count} CP-01 and ${cp02Count} CP-02 items; the deltas hold ${items.length}`);
  }
}

/**
 * The items whose legal effect is PENDING_COUNSEL: CP-01.14 (the state itself), every item that writes a policy key CP-01.14's legal
 * status covers (CP-01.04's refusal reasons and rules), and every item that requires such a writer (CP-02.14's refusals). An item that
 * only reads the status (CP-02.12) carries no claim rule.
 */
export function pendingCounselItems(items) {
  const status = items.find((i) => i.delta.id === "CP-01.14");
  const legal = status.delta.patch["policy.json"].find((op) => op.op === "add" && op.path === "/legalStatus").value["commission.claimRules"];
  const covered = new Set(legal.covers.map((k) => `/${k.replace(".", "/")}`));
  const direct = items.filter((i) => i.delta.id === "CP-01.14" || (i.delta.patch["policy.json"] ?? []).some((op) => op.op !== "test" && covered.has(op.path))).map((i) => i.delta.id);
  const writers = direct.filter((id) => id !== "CP-01.14");
  const requiring = items.filter((i) => (i.delta.requires ?? []).some((r) => writers.includes(r))).map((i) => i.delta.id);
  return { state: legal.state, validation: legal.validation, items: [...new Set([...direct, ...requiring])] };
}

/**
 * The adoption items Order 19B's own exclusions hold back (elevated retention, PENDING_COUNSEL), each declared with the condition after
 * which it becomes adoptable; that condition must name a satisfier of one of the item's conditions. The PENDING_COUNSEL ones are exactly
 * the adoption items whose legal effect is pending, the writer of the retention exception is held, and every adoption item that requires
 * or depends on a held item (transitively) is held with it. No state changes.
 */
export function heldItems(source, items, adoption) {
  const declared = source.o19bExclusions.items;
  const byId = new Map(items.map((i) => [i.delta.id, i]));
  const writesException = (i) => (i.delta.patch["policy.json"] ?? []).some((op) => op.op === "add" && op.path === "/retention/extendHardCapExceptions");
  for (const [id, d] of Object.entries(declared)) {
    const i = byId.get(id);
    if (!i) throw new Error(`o19bExclusions names ${id}, which neither proposal has`);
    if (!adoption.includes(id)) throw new Error(`${id} is held from adoption but is not in the adoption profile`);
    const by = [...new Set([...(source.items[id].activationBy ?? []), ...(source.items[id].pendingBy ?? [])].flat())];
    if (!by.some((s) => new RegExp(`\\b${s}\\b`).test(d.adoptableOnlyAfter))) throw new Error(`${id}: adoptableOnlyAfter names none of the satisfiers of its conditions (${by.join(", ")})`);
    if (d.exclusion === "ELEVATED_RETENTION") {
      if (!writesException(i) && !(i.delta.requires ?? []).includes("CP-01.02")) throw new Error(`${id}: held for elevated retention, but it neither writes the retention exception nor requires CP-01.02`);
    } else if (d.exclusion !== "PENDING_COUNSEL") throw new Error(`${id}: unknown exclusion ${d.exclusion}`);
  }
  const counsel = pendingCounselItems(items).items.filter((id) => adoption.includes(id)).sort();
  const heldCounsel = Object.keys(declared).filter((id) => declared[id].exclusion === "PENDING_COUNSEL").sort();
  if (JSON.stringify(counsel) !== JSON.stringify(heldCounsel)) throw new Error(`the adoption items PENDING_COUNSEL are ${counsel.join(", ")}; held for it: ${heldCounsel.join(", ")}`);
  for (const i of items) {
    if (writesException(i) && adoption.includes(i.delta.id) && declared[i.delta.id]?.exclusion !== "ELEVATED_RETENTION") throw new Error(`${i.delta.id} writes the elevated retention exception and is not held`);
  }
  const heldWith = {};
  for (const id of adoption) {
    if (declared[id]) continue;
    const seen = new Set();
    const walk = (x) => {
      for (const r of [...(byId.get(x).delta.requires ?? []), ...(byId.get(x).delta.dependsOn ?? [])]) {
        if (!seen.has(r)) {
          seen.add(r);
          walk(r);
        }
      }
    };
    walk(id);
    const hits = [...seen].filter((r) => declared[r]).sort();
    if (hits.length > 0) heldWith[id] = hits;
  }
  return { declared, heldWith };
}

/** Throws unless every activation and pending condition of every item names who must satisfy it, from the known satisfiers. */
export function checkSatisfiers(source, items) {
  const known = new Set(Object.keys(source.satisfiers));
  for (const i of items) {
    const id = i.delta.id;
    const declared = source.items[id];
    for (const kind of ["activation", "pending"]) {
      const conditions = i.delta[kind] ?? [];
      const by = declared[`${kind}By`] ?? [];
      if (by.length !== conditions.length) throw new Error(`${id}: ${conditions.length} ${kind} conditions, ${by.length} satisfier lists`);
      by.forEach((list, n) => {
        if (!Array.isArray(list) || list.length === 0) throw new Error(`${id}: ${kind}[${n}] names no satisfier`);
        for (const s of list) if (!known.has(s)) throw new Error(`${id}: ${kind}[${n}] names ${s}, which is no known order or gate`);
      });
    }
  }
}

// --- the generated files -------------------------------------------------------------------------------------------------------

export async function buildAll() {
  const ctx = await loadAll();
  const { source, registry, cp01, cp02, spec } = ctx;
  const items = itemsOf(cp01, cp02);
  const recorded = recordedStates(readFileSync(join(ROOT, source.inputs.ownerResolution), "utf8"), readFileSync(join(ROOT, spec.document), "utf8"));
  checkStates(source, items, recorded);
  checkSatisfiers(source, items);
  const conflicts = computeConflicts(registry, items);
  checkConflicts(source.conflicts, conflicts);
  const profiles = {};
  for (const p of PROFILES) {
    const ids = profileItems(source, items, p);
    checkClosed(items, ids, p);
    profiles[p] = buildProfile(ctx, p, ids);
  }
  const clashes = componentCollisions(ctx.live, profiles.build.proposal);
  for (const name of Object.keys(source.componentRenames ?? {})) if (!clashes.includes(name)) throw new Error(`the source renames ${name}, which no longer clashes with a served component`);
  const held = heldItems(source, items, profiles.adoption.ids);
  const all = items.map((i) => i.delta.id);
  const fullChanges = compatibility(spec, registry, cp01, cp02, ctx.live, buildOpenapi(spec, { bundle: JSON.parse(generateContracts(registryFiles(registry, cp01, cp02, all).files).schemas.toString("utf8")), live: ctx.live, application: ctx.application }), ctx.domain);
  checkCompatibility(source, fullChanges, compatibilityCore(readFileSync(PATHS.cp02Compatibility, "utf8")));
  const counsel = pendingCounselItems(items);
  for (const id of counsel.items) if (source.items[id].legalEffect !== counsel.state) throw new Error(`${id}: its legal effect is ${counsel.state} (CP-01.14), the source says ${source.items[id].legalEffect}`);
  for (const [id, d] of Object.entries(source.items)) if (d.legalEffect !== undefined && !counsel.items.includes(id)) throw new Error(`${id}: declares a legal effect CP-01.14 does not give it`);

  const combined = {
    candidate: source.candidate,
    generatedBy: "tools/reissue/reissue.mjs from REISSUE-CANDIDATE.source.json, CP-01.registry-delta.json and CP-02.registry-delta.json; do not edit",
    status: "CANDIDATE_NOT_ADOPTED",
    applyOrder: source.applyOrder,
    base: { edition: registry["policy.json"].edition, files: loadProvenance().files },
    inputs: source.inputs.pins,
    items: items.map((i) => ({
      id: i.delta.id,
      proposal: i.proposal,
      state: i.state,
      ...(i.class ? { class: i.class } : {}),
      profiles: PROFILES.filter((p) => profiles[p].ids.includes(i.delta.id)),
      requires: i.delta.requires ?? [],
      dependsOn: i.delta.dependsOn ?? [],
      patch: i.delta.patch,
    })),
  };

  const coordinatedOf = (id) => fullChanges.filter((c) => RANK[c.class] >= 1 && c.source.split(" + ").includes(id)).map((c) => `${c.class} ${c.key}`);
  const manifest = {
    candidate: source.candidate,
    title: source.title,
    status: "CANDIDATE_NOT_ADOPTED",
    generatedBy: "tools/reissue/reissue.mjs from REISSUE-CANDIDATE.source.json; do not edit",
    preparedBy: source.preparedBy,
    document: source.document,
    adoption: source.adoption,
    inForce: inForceDigests(),
    inputs: { pins: source.inputs.pins, records: source.inputs.records, combinedDelta: sha256(compactJson(combined)) },
    applyOrder: source.applyOrder,
    profiles: Object.fromEntries(PROFILES.map((p) => [p, {
      meaning: source.profiles[p].meaning,
      states: source.profiles[p].states,
      items: profiles[p].ids,
      leftOut: all.filter((id) => !profiles[p].ids.includes(id)),
      ...(p === "adoption" ? { heldByOrder19BExclusions: [...Object.keys(held.declared), ...Object.keys(held.heldWith)].sort() } : {}),
      registry: { changedFiles: profiles[p].registryProvenance.changedFiles, files: profiles[p].registryProvenance.files, counts: countsOf(registry, profiles[p].applied) },
      outputs: Object.fromEntries(Object.entries(profiles[p].outputs).map(([f, b]) => [`${p}/${f}`, sha256(b)])),
      plannedOperations: Object.keys(profiles[p].document["x-kauro-planned"]).length,
      webClientAdaptations: profiles[p].adaptations,
      compatibility: { ...summarize(profiles[p].changes), nonAdditive: profiles[p].changes.filter((c) => RANK[c.class] >= 1).map((c) => `${c.class} ${c.key} (${c.source})`) },
    }])),
    compatibility: {
      revalidated: "CP-02.compatibility.json recomputed on the candidate with every item: equal (key, class, detail, attribution)",
      all: summarize(fullChanges),
      recorded: source.compatibility.recorded,
      addedByTheFinalReview: source.compatibility.addedByTheFinalReview,
    },
    conflicts: conflicts.map((c) => ({ ...c, resolution: source.conflicts.find((d) => d.kind === c.kind && d.entity === c.entity).resolution })),
    legalEffect: counsel,
    satisfiers: source.satisfiers,
    adoptionGates: source.adoptionGates,
    o19bExclusions: {
      basis: source.o19bExclusions.basis,
      held: Object.entries(held.declared).map(([id, d]) => ({ id, exclusion: d.exclusion, adoptableOnlyAfter: d.adoptableOnlyAfter })),
      heldWith: held.heldWith,
    },
    items: items.map((i) => {
      const id = i.delta.id;
      const d = source.items[id];
      return {
        id,
        proposal: i.proposal,
        title: i.delta.title,
        state: i.state,
        ...(i.class ? { class: i.class } : {}),
        // CP-01: the owner's decision of 2026-10-22; CP-02: the owner's decision block (section 8) is still empty
        decision: i.proposal === "CP-01" ? (i.delta.approval?.decision ?? (i.delta.deferred ? "DEFERRED" : "UNDECIDED")) : "OWNER_DECISION_PENDING_CP-02_SECTION_8",
        basis: i.delta.approval?.record ?? null,
        ...(d.legalEffect ? { legalEffect: d.legalEffect } : {}),
        ...(held.declared[id] ? { o19bExclusion: held.declared[id].exclusion, adoptableOnlyAfter: held.declared[id].adoptableOnlyAfter } : {}),
        ...(held.heldWith[id] ? { adoptableOnlyWith: held.heldWith[id] } : {}),
        profiles: PROFILES.filter((p) => profiles[p].ids.includes(id)),
        requires: [...(i.delta.requires ?? []), ...(i.delta.dependsOn ?? [])],
        conditions: [
          ...(i.delta.pending ?? []).map((t, n) => ({ kind: "pending", text: t, by: d.pendingBy[n] })),
          ...(i.delta.activation ?? []).map((t, n) => ({ kind: "activation", text: t, by: d.activationBy[n] })),
        ],
        implementingOrders: [...new Set([...(d.pendingBy ?? []), ...(d.activationBy ?? [])].flat())].filter((s) => source.satisfiers[s].kind === "ORDER").sort(),
        coordinatedChanges: coordinatedOf(id),
        ...(d.note ? { note: d.note } : {}),
      };
    }),
    residual: source.residual,
  };
  return { ...ctx, items, conflicts, profiles, fullChanges, combined, manifest };
}

/** Every generated file: [absolute path, bytes]. */
export function generatedOutputs(built) {
  const out = [
    [PATHS.combined, Buffer.from(compactJson(built.combined))],
    [PATHS.manifest, Buffer.from(compactJson(built.manifest))],
  ];
  for (const p of PROFILES) for (const [file, bytes] of Object.entries(built.profiles[p].outputs)) out.push([join(DIR, p, file), bytes]);
  return out;
}

export const isCurrent = ([path, bytes]) => existsSync(path) && readFileSync(path).equals(bytes);

/** Writes one profile into a new, empty directory (an implementing order's build target): registry, contracts, document, client. */
function materialize(built, profile, out) {
  if (!PROFILES.includes(profile)) throw new Error(`no profile ${profile} (${PROFILES.join(", ")})`);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  const p = built.profiles[profile];
  mkdirSync(join(out, "registry"), { recursive: true });
  for (const [file, bytes] of Object.entries(p.files)) writeFileSync(join(out, "registry", file), bytes);
  writeFileSync(join(out, "registry", "PROVENANCE.json"), text(candidateProvenance(p.files, { candidate: built.source.candidate, profile })));
  for (const [file, bytes] of Object.entries(p.outputs)) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    writeFileSync(join(out, file), bytes);
  }
}

async function main(argv) {
  const [mode, ...rest] = argv;
  if (!["generate", "check", "materialize"].includes(mode)) {
    console.error("usage: node tools/reissue/reissue.mjs generate|check|materialize <profile> <dir>");
    return 2;
  }
  if (mode === "check") {
    // the bytes in force first: a change there is never Order 19A's, whatever else is stale
    if (existsSync(PATHS.manifest)) checkInForce(readJson(PATHS.manifest).inForce);
  }
  const built = await buildAll();
  const outputs = generatedOutputs(built);
  if (mode === "generate") {
    for (const [path, bytes] of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    console.log(`reissue: ${built.items.length} items; adoption ${built.profiles.adoption.ids.length}, build ${built.profiles.build.ids.length}; ${built.conflicts.length} meeting points resolved; ${built.fullChanges.length} compatibility changes revalidated`);
    return 0;
  }
  if (mode === "check") {
    const stale = outputs.filter((o) => !isCurrent(o)).map(([path]) => rel(path));
    if (stale.length > 0) {
      console.error(`reissue: not the generated candidate (run node tools/reissue/reissue.mjs generate): ${stale.join(", ")}`);
      return 1;
    }
    console.log("reissue: the candidate is current and the bytes in force are the recorded ones");
    return 0;
  }
  const [profile, out] = rest;
  if (!profile || !out) {
    console.error("usage: node tools/reissue/reissue.mjs materialize <profile> <dir>");
    return 2;
  }
  materialize(built, profile, resolve(out));
  console.log(`reissue: ${profile} written to ${resolve(out)}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}


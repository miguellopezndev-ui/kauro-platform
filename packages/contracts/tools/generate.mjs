// Generates the TypeScript types, the JSON Schema bundle and the typed command/state catalogues from the vendored R2 registry.
// Source of truth: registry/*.json (vendored from the authority with provenance in registry/PROVENANCE.json). Nothing in the
// generated output is hand-edited; the generator is deterministic (same registry -> byte-identical output) and the build fails
// when the vendored files no longer match their recorded hashes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const registryDir = join(root, "registry");
const outDir = join(root, "src", "generated");

const provenance = JSON.parse(readFileSync(join(registryDir, "PROVENANCE.json"), "utf8"));
for (const [file, sha] of Object.entries(provenance.files)) {
  const actual = createHash("sha256").update(readFileSync(join(registryDir, file))).digest("hex");
  if (actual !== sha) {
    throw new Error(`registry/${file} sha256 ${actual} differs from PROVENANCE.json (${sha}); re-vendor from the authority and record the new hash`);
  }
}

const contracts = JSON.parse(readFileSync(join(registryDir, "contracts.json"), "utf8"));
const commands = JSON.parse(readFileSync(join(registryDir, "commands.json"), "utf8"));
const transitions = JSON.parse(readFileSync(join(registryDir, "state_transitions.json"), "utf8"));

const names = new Set(contracts.map((c) => c.name));

// Amendment A2 (docs/BRAND_AMENDMENT_A2.md): identifier-like tokens that carry the old brand are emitted with the Kauro brand.
// Prose (descriptions, invariants, flows) is quoted authority text and stays as written.
const brand = (v) => (typeof v === "string" ? v.replace(/(^|[^A-Z])KAVO(?![A-Z])/g, "$1KAURO").replace(/(^|[^a-z])kavo(?![a-z])/g, "$1kauro") : v);
for (const c of commands) c.role = brand(c.role);
const SCHEMA_ID = "urn:kauro:r2:contracts";

// --- field vocabulary (reference/FIELD_CONTRACTS.md "Common rules") -------------------------------------------------------
const SCALARS = {
  id: { ts: "Id", schema: { type: "string", minLength: 1, maxLength: 128, description: "Opaque server identity." } },
  hash: { ts: "Sha256Hex", schema: { type: "string", pattern: "^[0-9a-f]{64}$" } },
  hash40: { ts: "GitObjectName", schema: { type: "string", pattern: "^[0-9a-f]{40}$" } },
  utc: { ts: "UtcInstant", schema: { type: "string", format: "date-time", pattern: "Z$" } },
  text: { ts: "string", schema: { type: "string", maxLength: 40000 } },
  label: { ts: "string", schema: { type: "string", minLength: 1, maxLength: 200 } },
  count: { ts: "Count", schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
  integer: { ts: "number", schema: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
  version: { ts: "Version", schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
  money: { ts: "MoneyMinorUnits", schema: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Nonnegative exact minor units as a decimal string." } },
  decimal: { ts: "DecimalString", schema: { type: "string", pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$" } },
  bps: { ts: "BasisPoints", schema: { type: "integer", minimum: 0, maximum: 10000 } },
  bool: { ts: "boolean", schema: { type: "boolean" } },
  knownBoolean: { ts: "KnownBoolean", schema: { type: ["boolean", "null"], description: "null is explicitly unknown and never authorizes." } },
  listText: { ts: "string[]", schema: { type: "array", items: { type: "string", maxLength: 40000 }, maxItems: 10000 } },
  listHash: { ts: "Sha256Hex[]", schema: { type: "array", items: { type: "string", pattern: "^[0-9a-f]{64}$" }, maxItems: 10000 } },
  scalar: { ts: "JsonScalar", schema: { type: ["string", "number", "boolean", "null"] } },
};

function tsIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`field name ${name} is not a TypeScript identifier`);
  return name;
}

function typeOf(fieldType, ctx) {
  if (fieldType in SCALARS) return { ts: SCALARS[fieldType].ts, schema: { ...SCALARS[fieldType].schema } };
  if (fieldType.startsWith("enum:")) {
    const values = fieldType.slice(5).split(",").map((v) => brand(v.trim())).filter(Boolean);
    if (values.length === 0) throw new Error(`empty enum at ${ctx}`);
    return { ts: values.map((v) => JSON.stringify(v)).join(" | "), schema: { type: "string", enum: values } };
  }
  if (fieldType.startsWith("ref:")) {
    const ref = fieldType.slice(4);
    if (!names.has(ref)) throw new Error(`unknown contract reference ${ref} at ${ctx}`);
    return { ts: ref, schema: { $ref: `#/$defs/${ref}` } };
  }
  if (fieldType.startsWith("list:")) {
    const ref = fieldType.slice(5);
    if (!names.has(ref)) throw new Error(`unknown contract list reference ${ref} at ${ctx}`);
    return { ts: `${ref}[]`, schema: { type: "array", items: { $ref: `#/$defs/${ref}` }, maxItems: 10000 } };
  }
  throw new Error(`unknown field type ${fieldType} at ${ctx}`);
}

// --- types.ts ---------------------------------------------------------------------------------------------------------
const lines = [];
lines.push("// GENERATED by tools/generate.mjs from registry/contracts.json — do not edit by hand.");
lines.push(`// Registry provenance: ${provenance.source} (contracts.json sha256 ${provenance.files["contracts.json"]}).`);
lines.push("");
lines.push("/** Opaque server identity (UUIDv7 or a compatible opaque scheme fixed by the registry). */");
lines.push("export type Id = string;");
lines.push("/** Lowercase hexadecimal SHA-256. */");
lines.push("export type Sha256Hex = string;");
lines.push("/** Full Git object name (40 hex). */");
lines.push("export type GitObjectName = string;");
lines.push("/** UTC instant with Z. */");
lines.push("export type UtcInstant = string;");
lines.push("/** Nonnegative safe integer count. */");
lines.push("export type Count = number;");
lines.push("/** Optimistic concurrency / fence version. */");
lines.push("export type Version = number;");
lines.push("/** Nonnegative exact minor units carried as a decimal string. */");
lines.push("export type MoneyMinorUnits = string;");
lines.push("/** Exact decimal carried as a string. */");
lines.push("export type DecimalString = string;");
lines.push("/** Basis points 0..10000. */");
lines.push("export type BasisPoints = number;");
lines.push("/** true/false when observed; null is explicitly unknown and never authorizes. */");
lines.push("export type KnownBoolean = boolean | null;");
lines.push("export type JsonScalar = string | number | boolean | null;");
lines.push("");
for (const c of contracts) {
  lines.push("/**");
  lines.push(` * ${c.name} — owner manual ${c.owner}. Flow: ${c.flow}`);
  lines.push(` * Invariant: ${c.invariant}`);
  lines.push(" */");
  lines.push(`export interface ${tsIdent(c.name)} {`);
  for (const f of c.fields) {
    const t = typeOf(f.type, `${c.name}.${f.name}`);
    lines.push(`  /** ${f.description ?? ""} */`);
    lines.push(`  readonly ${tsIdent(f.name)}${f.required ? "" : "?"}: ${t.ts};`);
  }
  lines.push("}");
  lines.push("");
}
lines.push(`export const CONTRACT_NAMES = ${JSON.stringify(contracts.map((c) => c.name))} as const;`);
lines.push("export type ContractName = (typeof CONTRACT_NAMES)[number];");
lines.push("");
lines.push(`export const SCHEMA_ID = ${JSON.stringify(SCHEMA_ID)};`);
lines.push("");

// commands
lines.push("/** One public command of the API catalogue (registry/commands.json). */");
lines.push("export interface CommandDefinition {");
lines.push("  readonly id: string; readonly name: string; readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly path: string;");
lines.push("  readonly role: string; readonly owner: string; readonly fields: ReadonlyArray<{ readonly name: string; readonly type: string }>;");
lines.push("  readonly precondition: string; readonly effect: string; readonly failure: string; readonly gate: string; readonly idempotency: string;");
lines.push("  readonly stateCheck?: string; readonly status?: string; readonly testIds?: ReadonlyArray<string>;");
lines.push("}");
lines.push(`export const COMMANDS: ReadonlyArray<CommandDefinition> = ${JSON.stringify(commands, null, 0)} as const;`);
lines.push(`export const COMMAND_IDS = ${JSON.stringify(commands.map((c) => c.id))} as const;`);
lines.push("export type CommandId = (typeof COMMAND_IDS)[number];");
lines.push(`export const COMMAND_ROLES = ${JSON.stringify([...new Set(commands.map((c) => c.role))].sort())} as const;`);
lines.push("export type CommandRole = (typeof COMMAND_ROLES)[number];");
lines.push("");

// state machines
lines.push("export interface StateTransition { readonly from: string; readonly event: string; readonly to: string; readonly guard: string; readonly effect: string; }");
lines.push("/** unlistedTransition: what a transition absent from the list means (the registry says: reject unless a new versioned contract is accepted). */");
lines.push("export interface StateMachine { readonly contract: string; readonly initial: string; readonly terminal: ReadonlyArray<string>; readonly transitions: ReadonlyArray<StateTransition>; readonly unlistedTransition?: string; }");
lines.push(`export const STATE_MACHINES: ReadonlyArray<StateMachine> = ${JSON.stringify(transitions, null, 0)} as const;`);
lines.push("");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "types.ts"), lines.join("\n") + "\n");

// --- schemas.json (JSON Schema 2020-12 bundle) --------------------------------------------------------------------------
const defs = {};
for (const c of contracts) {
  const properties = {};
  const required = [];
  for (const f of c.fields) {
    const t = typeOf(f.type, `${c.name}.${f.name}`);
    properties[f.name] = { ...t.schema, description: f.description ?? "" };
    if (f.required) required.push(f.name);
  }
  defs[c.name] = {
    type: "object",
    description: `${c.invariant} (owner manual ${c.owner})`,
    properties,
    required,
    additionalProperties: false, // "Unknown fields reject the object."
  };
}
const bundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_ID,
  title: "Kauro R2 contract registry",
  description: `Generated from the vendored authority registry (${provenance.source}); the R2 text references these definitions as urn:kavo:r2:contracts#/$defs/<Name>.`,
  $defs: defs,
};
writeFileSync(join(outDir, "schemas.json"), JSON.stringify(bundle, null, 1) + "\n");
console.log(`generated ${contracts.length} contracts, ${commands.length} commands, ${transitions.length} state machines -> ${outDir}`);

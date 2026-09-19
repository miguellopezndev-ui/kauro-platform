// The generated authority must agree with the vendored registry, the registry with its provenance, and the schemas must reject
// unknown fields (FIELD_CONTRACTS "Unknown fields reject the object").
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_NAMES, COMMANDS, COMMAND_IDS, STATE_MACHINES, SCHEMA_ID } from "../src/generated/types.js";
import { provenance, registryJson, gates, screens, policy, RegistryIntegrityError, registryBytes } from "../src/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemas = JSON.parse(readFileSync(join(here, "..", "src", "generated", "schemas.json"), "utf8")) as {
  $id: string;
  $defs: Record<string, { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }>;
};

interface RegistryContract {
  name: string;
  fields: Array<{ name: string; type: string; required: boolean }>;
}

test("registry provenance verifies and every vendored file is hashed", () => {
  const p = provenance();
  for (const f of Object.keys(p.files)) assert.ok(registryBytes(f).length > 0, f);
  assert.throws(() => registryBytes("nope.json"), RegistryIntegrityError);
  assert.match(p.brand_note, /Kauro/);
});

test("generated catalogue matches the vendored registry", () => {
  const contracts = registryJson<RegistryContract[]>("contracts.json");
  assert.deepEqual([...CONTRACT_NAMES], contracts.map((c) => c.name));
  assert.equal(Object.keys(schemas.$defs).length, contracts.length);
  assert.equal(schemas.$id, SCHEMA_ID);
  assert.equal(SCHEMA_ID, "urn:kauro:r2:contracts");
  for (const c of contracts) {
    const def = schemas.$defs[c.name];
    assert.ok(def, c.name);
    assert.deepEqual(Object.keys(def.properties), c.fields.map((f) => f.name), c.name);
    assert.deepEqual(def.required, c.fields.filter((f) => f.required).map((f) => f.name), c.name);
    assert.equal(def.additionalProperties, false, c.name);
  }
  const commands = registryJson<Array<{ id: string }>>("commands.json");
  assert.deepEqual([...COMMAND_IDS], commands.map((c) => c.id));
  assert.equal(COMMANDS.length, 64);
  assert.equal(STATE_MACHINES.length, 12);
  assert.ok(gates().length >= 30);
  assert.ok(screens().length >= 50);
  assert.ok(policy());
});

test("every command has a unique id, an HTTP method/path and a declared idempotency and gate", () => {
  const ids = new Set<string>();
  for (const c of COMMANDS) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.match(c.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.match(c.path, /^\/api\/v1\//);
    assert.ok(c.idempotency.length > 0 && c.gate.length > 0, c.id);
  }
});

test("state machines reference contracts and their enum states; initial and terminal states exist", () => {
  const byName = new Map(registryJson<RegistryContract[]>("contracts.json").map((c) => [c.name, c]));
  for (const m of STATE_MACHINES) {
    const c = byName.get(m.contract);
    assert.ok(c, `state machine for unknown contract ${m.contract}`);
    const stateField = c.fields.find((f) => f.name === "state" || f.name === "status");
    assert.ok(stateField && stateField.type.startsWith("enum:"), `${m.contract} has no enum state field`);
    const states = new Set(stateField.type.slice(5).split(","));
    assert.ok(states.has(m.initial), `${m.contract}: initial ${m.initial} is not an enum state`);
    for (const t of m.terminal) assert.ok(states.has(t), `${m.contract}: terminal ${t}`);
    for (const t of m.transitions) assert.ok(states.has(t.from) && states.has(t.to), `${m.contract}: ${t.from} -> ${t.to}`);
  }
});

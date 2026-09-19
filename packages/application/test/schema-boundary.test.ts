// S093 (structural half at the application boundary): the set of schema ids a validator may compile is closed — the
// registry contract names plus the request schemas of this package. Customer target metadata is one of those contracts
// (TargetContract.objects is data validated by the application-owned TargetContract schema); nothing in the port lets a
// caller hand a value in as a schema. The behavioural half (Ajv strict configuration on real HTTP input) is the api package.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTRACT_NAMES } from "@kauro/contracts";
import type { KnownSchemaId, SchemaValidator } from "../src/index.js";
import { REQUEST_SCHEMA_IDS, REQUEST_SCHEMAS } from "../src/index.js";

test("KnownSchemaId is exactly the contract names, the request schema ids and Problem", () => {
  const known: KnownSchemaId[] = [...CONTRACT_NAMES, ...REQUEST_SCHEMA_IDS, "Problem"];
  assert.equal(new Set(known).size, known.length);
  // the type refuses anything else at compile time; at runtime an adapter must expose the same closed set
  const fake: SchemaValidator = {
    knownSchemaIds: known,
    validate: () => ({ kind: "INVALID", fields: [] }),
  };
  assert.ok(fake.knownSchemaIds.includes("TargetContract"));
  assert.ok(!(fake.knownSchemaIds as ReadonlyArray<string>).includes("customer-target-metadata"));
});

test("the generated TargetContract schema types customer metadata as data (closed object with an objects array), never as a schema", () => {
  const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as {
    $defs: Record<string, { properties: Record<string, { type?: string; $ref?: string; items?: { $ref?: string } }>; additionalProperties: boolean }>;
  };
  const tc = bundle.$defs["TargetContract"]!;
  assert.equal(tc.additionalProperties, false);
  assert.equal(tc.properties["objects"]!.type, "array");
  assert.equal(tc.properties["objects"]!.items!.$ref, "#/$defs/TargetObject");
  for (const s of Object.values(REQUEST_SCHEMAS)) {
    for (const [name, p] of Object.entries(s.properties)) {
      assert.ok(!("$ref" in p) && !("properties" in p) && !("$dynamicRef" in p), `${s.$id}.${name} must be a scalar wire field`);
    }
  }
});

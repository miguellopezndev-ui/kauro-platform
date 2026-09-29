// The closed runtime guard behind the generated client (design D-GEN-1; 10 "Version and validation": TypeScript types alone are not runtime
// validation). Each keyword the generator translates has a passing and a failing value, and the answer is a path and a rule, never a value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { conforms, isProblem, SCHEMAS, violations } from "../src/api/generated.ts";
import { type SchemaNode, validateAgainst } from "../src/api/schema-guard.ts";

const table: Readonly<Record<string, SchemaNode>> = {
  Leaf: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^[a-z]{3}$", minLength: 3, maxLength: 3 } } },
  Root: {
    type: "object",
    additionalProperties: false,
    required: ["n", "kind", "state", "leaf"],
    properties: {
      n: { type: "integer", minimum: 1, maximum: 9 },
      ratio: { type: "number", minimum: 0, maximum: 1 },
      flag: { type: "boolean" },
      kind: { type: "string", const: "READ" },
      state: { type: "string", enum: ["OPEN", "CLOSED"] },
      at: { type: "string", format: "date-time" },
      text: { type: "string", minLength: 1, maxLength: 3 },
      maybe: { type: ["integer", "null"], minimum: 0 },
      leaf: { $ref: "Leaf" },
      list: { type: "array", minItems: 1, maxItems: 2, items: { $ref: "Leaf" } },
    },
  },
  Dangling: { type: "object", additionalProperties: false, properties: { next: { $ref: "Missing" } } },
  Loop: { type: "object", additionalProperties: false, properties: { next: { $ref: "Loop" } } },
};

const base = { n: 3, kind: "READ", state: "OPEN", leaf: { id: "abc" } };
const check = (value: unknown, name = "Root") => validateAgainst(table, name, value);

test("D-GEN-1: a value that conforms answers no violation, and each keyword rejects its own counter-example by path and rule", () => {
  assert.deepEqual(check(base), []);
  assert.deepEqual(check({ ...base, ratio: 0.5, flag: false, at: "2026-09-29T10:00:00Z", text: "ab", maybe: null, list: [{ id: "xyz" }] }), []);
  const cases: readonly (readonly [string, unknown, string])[] = [
    ["not an object", [], "$: type"],
    ["null", null, "$: type"],
    ["missing member", { n: 3, kind: "READ", state: "OPEN" }, "$.leaf: required"],
    ["unknown member", { ...base, extra: 1 }, "$.extra: unknown-member"],
    ["integer that is fractional", { ...base, n: 2.5 }, "$.n: type"],
    ["integer as text", { ...base, n: "3" }, "$.n: type"],
    ["below minimum", { ...base, n: 0 }, "$.n: minimum"],
    ["above maximum", { ...base, n: 10 }, "$.n: maximum"],
    ["number not finite", { ...base, ratio: Number.POSITIVE_INFINITY }, "$.ratio: type"],
    ["boolean as text", { ...base, flag: "false" }, "$.flag: type"],
    ["wrong constant", { ...base, kind: "WRITE" }, "$.kind: const"],
    ["value outside the enum", { ...base, state: "PAUSED" }, "$.state: enum"],
    ["bad date-time", { ...base, at: "2026-13-01T00:00:00Z" }, "$.at: format"],
    ["date that does not exist", { ...base, at: "2026-02-30T00:00:00Z" }, "$.at: format"],
    ["date-time without a zone", { ...base, at: "2026-09-29T10:00:00" }, "$.at: format"],
    ["empty text", { ...base, text: "" }, "$.text: minLength"],
    ["long text", { ...base, text: "abcd" }, "$.text: maxLength"],
    ["null where only an integer or null is allowed and it is negative", { ...base, maybe: -1 }, "$.maybe: minimum"],
    ["string in an integer-or-null", { ...base, maybe: "x" }, "$.maybe: type"],
    ["nested pattern", { ...base, leaf: { id: "ABC" } }, "$.leaf.id: pattern"],
    ["array too short", { ...base, list: [] }, "$.list: minItems"],
    ["array too long", { ...base, list: [{ id: "abc" }, { id: "abc" }, { id: "abc" }] }, "$.list: maxItems"],
    ["item off contract", { ...base, list: [{ id: "abc" }, { id: "abc", x: 1 }] }, "$.list[1].x: unknown-member"],
    ["array where an object belongs", { ...base, leaf: [] }, "$.leaf: type"],
  ];
  for (const [label, value, expected] of cases) assert.deepEqual(check(value), [expected], label);
});

test("D-GEN-1: string length counts characters, not UTF-16 units; only plain objects are objects; a hostile key is an unknown member", () => {
  assert.deepEqual(check({ ...base, text: "\u{1F600}\u{1F600}\u{1F600}" }), [], "three emoji are three characters");
  assert.deepEqual(check({ ...base, text: "\u{1F600}\u{1F600}\u{1F600}\u{1F600}" }), ["$.text: maxLength"]);
  class Fake {
    readonly n = 3;
  }
  assert.deepEqual(check(new Fake()), ["$: type"], "a class instance is not a JSON object");
  assert.deepEqual(check(new Map()), ["$: type"]);
  assert.deepEqual(check(Object.assign(Object.create(null), base)), [], "a prototype-less object parsed by a reviver is a plain object");
  const hostile = JSON.parse('{"n":3,"kind":"READ","state":"OPEN","leaf":{"id":"abc"},"__proto__":{"admin":true},"constructor":1}') as unknown;
  assert.deepEqual([...check(hostile)].sort(), ["$.__proto__: unknown-member", "$.constructor: unknown-member"].sort());
  assert.deepEqual(check({ n: 3, kind: "READ", state: "OPEN", leaf: { id: "abc" }, toString: 1 }), ["$.toString: unknown-member"]);
  assert.deepEqual(validateAgainst(table, "constructor", {}), ["$: unknown-schema constructor"], "a schema name is looked up as an own key only");
});

test("D-GEN-1: an unknown reference, a reference loop and a flood of failures are bounded and reported, never thrown", () => {
  assert.deepEqual(check({ next: {} }, "Dangling"), ["$.next: unknown-schema Missing"]);
  assert.deepEqual(check({}, "Nope"), ["$: unknown-schema Nope"]);
  let nested: Record<string, unknown> = {};
  const deep = nested;
  for (let i = 0; i < 60; i += 1) {
    const next: Record<string, unknown> = {};
    nested["next"] = next;
    nested = next;
  }
  const result = check(deep, "Loop");
  assert.deepEqual(result.length, 1);
  assert.match(result[0] ?? "", /: depth$/);
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
  assert.equal(check(many).length, 50, "at most fifty failures are collected");
});

test("D-PRIV-1: a violation names the path and the rule and never a value the server sent", () => {
  const secret = "s3cr3t-value-that-must-not-echo";
  for (const value of [{ ...base, state: secret }, { ...base, kind: secret }, { ...base, leaf: { id: secret } }, { ...base, text: secret }]) {
    const found = check(value);
    assert.ok(found.length > 0);
    for (const line of found) assert.equal(line.includes(secret), false, line);
  }
});

test("D-GEN-1: the generated guards apply the api's own schemas (a real Problem passes, and each mutation of it fails)", () => {
  const problem = { type: "urn:kauro:problem:STALE_VERSION", title: "Stale", status: 409, code: "STALE_VERSION", correlationId: "c-1", retryable: false, nextActions: [{ action: "RELOAD", href: "/agencies" }] };
  assert.equal(isProblem(problem), true);
  assert.deepEqual(violations("Problem", problem), []);
  assert.equal(conforms("Problem", { ...problem, code: "STALE" }), false);
  assert.equal(conforms("Problem", { ...problem, status: 200 }), false);
  assert.equal(conforms("Problem", { ...problem, nextActions: [{ action: "RELOAD", href: "https://elsewhere.test/" }] }), false, "a next action href is a path on this origin");
  assert.equal(conforms("Problem", { ...problem, type: "urn:kauro:problem:stale" }), false);
  const { retryable: _omitted, ...without } = problem;
  assert.deepEqual(violations("Problem", without), ["$.retryable: required"]);
  assert.ok(Object.keys(SCHEMAS).length > 30);
});

// The strict body parser (10 "Request envelope": JSON syntax, duplicate keys, bounded depth and string lengths).
import assert from "node:assert/strict";
import { test } from "node:test";
import { StrictJsonError, parseStrictJson } from "../src/index.js";

function reasonOf(text: string, options?: { maxDepth?: number; maxStringLength?: number }): string | null {
  try {
    parseStrictJson(text, options);
    return null;
  } catch (e) {
    if (e instanceof StrictJsonError) return e.reason;
    throw e;
  }
}

test("parses RFC 8259 values exactly like JSON.parse for well-formed input", () => {
  const samples = ['{"a":1,"b":[true,false,null,"x\\u00e9\\n"],"c":{"d":-1.5e3}}', "[]", "{}", '"\\ud83d\\ude00"', "0", "-0.5", "1E2", "  [1 , 2]  "];
  for (const s of samples) assert.deepEqual(parseStrictJson(s), JSON.parse(s), s);
});

test("duplicate keys are refused at any depth (JSON.parse would keep the last one)", () => {
  assert.equal(reasonOf('{"a":1,"a":2}'), "JSON_DUPLICATE_KEY");
  assert.equal(reasonOf('{"x":{"expectedVersion":1,"expectedVersion":2}}'), "JSON_DUPLICATE_KEY");
  assert.equal(JSON.parse('{"a":1,"a":2}').a, 2, "control: the lenient parser silently collapses");
});

test("depth and string length are bounded", () => {
  assert.equal(reasonOf("[".repeat(17) + "]".repeat(17)), "JSON_DEPTH_EXCEEDED");
  assert.equal(reasonOf("[".repeat(16) + "]".repeat(16)), null);
  assert.equal(reasonOf(JSON.stringify({ s: "x".repeat(40_001) })), "JSON_STRING_TOO_LONG");
  assert.equal(reasonOf(JSON.stringify({ s: "x".repeat(40_000) })), null);
  assert.equal(reasonOf('{"a":[[1]]}', { maxDepth: 2 }), "JSON_DEPTH_EXCEEDED");
});

test("syntax errors: trailing commas, comments, NaN, leading zeros, single quotes, control characters, lone surrogates, BOM, trailing garbage, bad escapes", () => {
  for (const bad of ["[1,]", "{\"a\":1,}", "// c\n1", "NaN", "01", "'a'", '"a\tb"', '"\\ud83d"', '"\\ude00"', "﻿{}", "{} x", '"\\x41"', "tru", "{\"a\" 1}", "", "   "]) {
    assert.equal(reasonOf(bad), "JSON_SYNTAX", JSON.stringify(bad));
  }
});

test("prototype-polluting member names are refused", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) assert.equal(reasonOf(`{"${key}":{}}`), "JSON_SYNTAX", key);
  const clean = parseStrictJson('{"safe":1}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(clean), Object.prototype);
});

// The evidence record of the final audit (R2 21_QUALITY_AND_ACCEPTANCE.md:11: "An evidence item records producer, subject commit/tree or
// artifact digest, input and dependency hashes, environment, tool versions, command/procedure, start/end, exit/result, cost, raw result
// reference and interpretation. Evidence retains its original producer and date when reused."; :7 classes; :9 "Every claim names its
// class"). Decision K-1: a TOOL record is only SIMULATED, EXECUTED_LOCAL or EXECUTED_PROVIDER; DESIGN, IMPLEMENTATION,
// INDEPENDENTLY_REVIEWED and ACCEPTED are claims a person or a review makes, never a tool.
//
//   validateRecord(record)              -> record, or throws E_RECORD_FIELD (err.field names it) / E_RECORD_CLASS
//   reuseRecord(record, {reusedBy, at}) -> a copy that keeps producer and createdAt and adds reusedFrom{recordId, producer, createdAt}
//   canonical(value), sha256Hex(bytes), recordId(record)
// Imports nothing from tools/evidence.mjs (AT-00 edits it).
import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted, no whitespace. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function recordId(record) {
  return sha256Hex(canonical(record));
}

export const TOOL_CLASSES = Object.freeze(["SIMULATED", "EXECUTED_LOCAL", "EXECUTED_PROVIDER"]);
export const RECORD_FIELDS = Object.freeze(["producer", "subject", "inputs", "dependencies", "environment", "toolVersions", "command", "startedAt", "endedAt", "exit", "result", "cost", "rawRef", "interpretation", "class", "createdAt"]);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function fail(code, message, extra = {}) {
  return Object.assign(new Error(`${code}: ${message}`), { code }, extra);
}

function missing(field, why = "is missing or has the wrong shape") {
  return fail("E_RECORD_FIELD", `record field ${field} ${why}`, { field });
}

const isText = (v) => typeof v === "string" && v.length > 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTime = (v) => isText(v) && !Number.isNaN(Date.parse(v));

/** A subject: repo plus (commit and tree) or an artifact digest. `errorOf(fieldName)` builds the error. */
export function checkSubject(subject, prefix, errorOf) {
  if (!isObject(subject)) throw errorOf(prefix);
  if (!isText(subject.repo)) throw errorOf(`${prefix}.repo`);
  if (subject.digest !== undefined && subject.commit === undefined) {
    if (!HEX64.test(subject.digest)) throw errorOf(`${prefix}.digest`);
    return;
  }
  if (!HEX40.test(subject.commit ?? "")) throw errorOf(`${prefix}.commit`);
  if (!HEX40.test(subject.tree ?? "")) throw errorOf(`${prefix}.tree`);
}

export function validateRecord(record) {
  if (!isObject(record)) throw missing("record", "is not an object");
  for (const field of RECORD_FIELDS) if (record[field] === undefined) throw missing(field);
  if (!isText(record.producer)) throw missing("producer");
  checkSubject(record.subject, "subject", missing);
  if (!Array.isArray(record.inputs) || !record.inputs.every((i) => isObject(i) && isText(i.path) && HEX64.test(i.sha256 ?? ""))) throw missing("inputs");
  if (!Array.isArray(record.dependencies) || !record.dependencies.every((d) => isObject(d) && isText(d.name) && isText(d.hash))) throw missing("dependencies");
  if (!isObject(record.environment)) throw missing("environment");
  for (const k of ["os", "platform", "node"]) if (!isText(record.environment[k])) throw missing(`environment.${k}`);
  if (!isObject(record.toolVersions) || Object.keys(record.toolVersions).length === 0) throw missing("toolVersions");
  if (!Array.isArray(record.command) || record.command.length === 0 || !record.command.every(isText)) throw missing("command");
  if (!isTime(record.startedAt)) throw missing("startedAt");
  if (!isTime(record.endedAt)) throw missing("endedAt");
  if (!Number.isInteger(record.exit)) throw missing("exit");
  if (!isText(record.result)) throw missing("result");
  if (!isObject(record.cost)) throw missing("cost");
  for (const k of ["usd", "minutes"]) if (typeof record.cost[k] !== "number" || !(record.cost[k] >= 0)) throw missing(`cost.${k}`);
  if (!isObject(record.rawRef)) throw missing("rawRef");
  if (!isText(record.rawRef.path)) throw missing("rawRef.path");
  if (!HEX64.test(record.rawRef.sha256 ?? "")) throw missing("rawRef.sha256");
  if (!isText(record.interpretation)) throw missing("interpretation");
  if (!isTime(record.createdAt)) throw missing("createdAt");
  if (!TOOL_CLASSES.includes(record.class)) throw fail("E_RECORD_CLASS", `a tool record is ${TOOL_CLASSES.join(", ")}, not ${JSON.stringify(record.class)}`);
  if (record.reusedFrom !== undefined) {
    const r = record.reusedFrom;
    if (!isObject(r)) throw missing("reusedFrom");
    for (const k of ["recordId", "producer", "createdAt"]) if (!isText(r[k])) throw missing(`reusedFrom.${k}`);
    if (r.producer !== record.producer || r.createdAt !== record.createdAt) throw fail("E_RECORD_REUSE", "a reused record keeps its original producer and date", { field: "reusedFrom" });
  }
  return record;
}

/** The record as reused by `reusedBy` at `at`: the original producer and date stay (R2 21:11); who reused it is only noted. */
export function reuseRecord(original, { reusedBy, at }) {
  return {
    ...structuredClone(original),
    reusedFrom: { recordId: recordId(original), producer: original.producer, createdAt: original.createdAt, reusedBy, reusedAt: at },
  };
}

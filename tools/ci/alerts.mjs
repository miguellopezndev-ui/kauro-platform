#!/usr/bin/env node
// O28A: the offline evaluator of deploy/local/alerts.json. Input: timestamped log events `{ at: epochMs, line }` (the collector's
// framing), in time order. A rule fires when `threshold` matching lines fall within `windowSeconds`; it fires once, then stays quiet
// until a full window passes without a match (no alert storm). Output: the fired alerts, in time order.
//
//   node tools/ci/alerts.mjs <log-file>    # each line "<ISO-8601> <api stderr line>"; prints the fired alerts as JSON lines
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ALERTS_FILE = join(root, "deploy", "local", "alerts.json");

export function loadRules(file = ALERTS_FILE) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (doc.version !== 1 || !Array.isArray(doc.rules)) throw new Error("alerts.json: version 1 with a rules array");
  const seen = new Set();
  return doc.rules.map((r) => {
    if (typeof r.id !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(r.id) || seen.has(r.id)) throw new Error(`alerts.json: a unique upper-case id (${r.id})`);
    seen.add(r.id);
    if (r.severity !== "page" && r.severity !== "ticket") throw new Error(`${r.id}: severity page or ticket`);
    if (!Number.isInteger(r.threshold) || r.threshold < 1 || !Number.isInteger(r.windowSeconds) || r.windowSeconds < 1) throw new Error(`${r.id}: positive integer threshold and window`);
    return { ...r, regex: new RegExp(r.pattern) };
  });
}

export function evaluate(rules, events) {
  const fired = [];
  const state = new Map(rules.map((r) => [r.id, { hits: [], quietUntil: -Infinity }]));
  let last = -Infinity;
  for (const e of events) {
    if (!(e.at >= last)) throw new Error("events are in time order");
    last = e.at;
    for (const r of rules) {
      if (!r.regex.test(e.line)) continue;
      const s = state.get(r.id);
      // an episode that is still going on extends its quiet period: it pages once
      if (e.at < s.quietUntil) {
        s.quietUntil = e.at + r.windowSeconds * 1000;
        continue;
      }
      const from = e.at - r.windowSeconds * 1000;
      s.hits = s.hits.filter((t) => t > from);
      s.hits.push(e.at);
      if (s.hits.length >= r.threshold) {
        fired.push({ id: r.id, severity: r.severity, at: new Date(e.at).toISOString(), count: s.hits.length });
        s.quietUntil = e.at + r.windowSeconds * 1000;
        s.hits = [];
      }
    }
  }
  return fired;
}

export function parseLog(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => {
    const at = l.indexOf(" ");
    const ms = Date.parse(l.slice(0, at));
    if (!Number.isFinite(ms)) throw new Error(`not a timestamped line: ${l.slice(0, 40)}`);
    return { at: ms, line: l.slice(at + 1) };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write("usage: node tools/ci/alerts.mjs <log-file>\n");
    process.exit(2);
  }
  for (const a of evaluate(loadRules(), parseLog(readFileSync(file, "utf8")))) process.stdout.write(`${JSON.stringify(a)}\n`);
}

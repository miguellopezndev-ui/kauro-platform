// Which timing cells a change touches, and whether it gives them a fixed wait cap (owner 2026-10-07, defect class
// WIN-TIMING-AFTER-GREEN-PR: a race/timeout cell green once on its PR turned main red on Windows three times).
// Pure functions + one git reader; tools/stress-cells.mjs --changed runs the selection 20x under CPU load.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The fault kinds whose outcome depends on timing: their cells are stressed. */
export const TIMING_FAULTS = ["race", "timeout", "expiry"];
/** A plain test( is a timing cell when its title names the family or its body drives the interleaving harness. */
const TIMING_TITLE = /\b(?:RACE|TIMEOUT|EXPIRY)\b|\[(?:race|timeout|expiry)\b/;
const TIMING_BODY = /\b(?:contend|bothOrders|mustWait|concurrently|inOrder|lastSettledOrder)\s*\(/;
const START = /^\s*(faultCell\s*\(|test\s*\(|it\s*\()/;

/** Lines (1-based, in the new file) that a unified diff with -U0 adds or next to which it deletes, per file. */
export function touchedLines(diff) {
  const files = new Map();
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    const f = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (f) { file = f[1] === "/dev/null" ? null : f[1]; if (file && !files.has(file)) files.set(file, { touched: new Set(), added: new Map() }); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]); const count = h[2] === undefined ? 1 : Number(h[2]);
      const entry = files.get(file);
      if (count === 0) entry.touched.add(Math.max(1, start)); // a pure deletion touches the line it sat before
      for (let n = start; n < start + count; n++) entry.touched.add(n);
      entry.cursor = start;
      continue;
    }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      const entry = files.get(file);
      entry.added.set(entry.cursor, line.slice(1));
      entry.cursor += 1;
    }
  }
  return files;
}

function literal(text, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`).exec(text);
  return m ? JSON.parse(m[1].startsWith("'") ? `"${m[1].slice(1, -1).replace(/"/g, '\\"')}"` : m[1]) : undefined;
}
function firstString(text) {
  const m = /^\s*(?:test|it)\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)/.exec(text);
  if (!m) return undefined;
  const raw = m[1];
  return raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The registrations of a test source (faultCell / test / it at line start), each with its line span, whether it is a timing cell,
 * and the name pattern that selects exactly it (null when its title is not a literal: then the whole file runs).
 */
export function cellsOf(source) {
  const lines = source.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (START.test(l)) starts.push(i); });
  return starts.map((s, k) => {
    const end = (k + 1 < starts.length ? starts[k + 1] : lines.length) - 1;
    const text = lines.slice(s, end + 1).join("\n");
    if (/^\s*faultCell\s*\(/.test(lines[s])) {
      const head = text.slice(0, 4000);
      const id = literal(head, "id"); const fault = literal(head, "fault"); const step = literal(head, "step");
      const timing = TIMING_FAULTS.includes(fault);
      const pattern = fault !== undefined && step !== undefined ? `^${escapeRe(id !== undefined ? `${id} ` : "")}\\[${escapeRe(fault)}\\] ${escapeRe(step)} -> ` : null;
      return { kind: "faultCell", title: [id, fault, step].filter(Boolean).join(" "), from: s + 1, to: end + 1, timing, pattern };
    }
    const title = firstString(text);
    const timing = (title !== undefined && TIMING_TITLE.test(title)) || TIMING_BODY.test(text);
    return { kind: "test", title: title ?? "(non-literal title)", from: s + 1, to: end + 1, timing, pattern: title !== undefined ? `^${escapeRe(title)}$` : null };
  });
}

/**
 * A wait cap written as a fixed number: a setTimeout, sleep, delay, wait or until call with a literal of three or more digits, or a
 * timeout, or a timeout/wait/deadline/pause/bound name in milliseconds, assigned one. Caps come from the harness or product bounds (bounds.ts), never a literal.
 */
const FIXED_CAP = [
  /\b(?:setTimeout|setInterval|sleep|delay|pause|waitFor\w*|wait\w*|until\w*|withTimeout|timeout)\s*\([^)]*?(?<![\w.$])\d[\d_]{2,}(?![\w.$])/,
  /\b(?:\w*(?:timeout|wait|deadline|pause|bound)\w*(?:ms|_ms|millis)|timeout|testTimeout)\s*[:=]\s*\d[\d_]{2,}(?![\w.$])/i,
];
export function fixedWaitCaps(addedLines) {
  const found = [];
  for (const [line, text] of addedLines) {
    const code = text.replace(/\/\/.*$/, "");
    if (FIXED_CAP.some((re) => re.test(code))) found.push({ line, text: text.trim() });
  }
  return found;
}

/** The timing cells a change touches: per test file, the touched timing cells, their patterns, and fixed caps in their added lines. */
export function selectChanged(diff, readSource) {
  const out = [];
  for (const [file, { touched, added }] of touchedLines(diff)) {
    if (!/(^|\/)test\/.*\.test\.(?:[cm]?[jt]s|tsx)$/.test(file)) continue;
    const cells = cellsOf(readSource(file)).filter((c) => c.timing && [...touched].some((n) => n >= c.from && n <= c.to));
    if (!cells.length) continue;
    const inCells = new Map([...added].filter(([n]) => cells.some((c) => n >= c.from && n <= c.to)));
    out.push({ file, cells, wholeFile: cells.some((c) => c.pattern === null), fixedCaps: fixedWaitCaps(inCells) });
  }
  return out;
}

/** Reads the change of HEAD against the merge base with `base` in `repo`. */
export function changedTimingCells(repo, base = "origin/main") {
  const diff = execFileSync("git", ["diff", "-U0", "--no-color", "--no-ext-diff", `${base}...HEAD`, "--", "*.test.ts", "*.test.mjs", "*.test.js"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return selectChanged(diff, (file) => readFileSync(join(repo, file), "utf8"));
}

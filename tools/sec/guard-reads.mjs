#!/usr/bin/env node
// SEC-DEPTH-PROVENANCE completeness inventory (read-only). For every guard function the lane covers (and the kauro functions
// they call), extracts from the migration SQL every table and column it reads or writes, plus the trigger attachments that bind
// NEW/OLD, and flags each column that is learned once (kauro.forbid_reassignment: a NULL -> value first assignment) or immutable
// (kauro.forbid_column_change). Output: JSON on stdout. Usage: node tools/sec/guard-reads.mjs [migrationsDir]
// Completeness: node tools/sec/guard-reads.mjs --check [designDoc] [migrationsDir] exits 1 when a column has no section 3b cell.
// The latest CREATE OR REPLACE of a function wins (migrations are applied in file order). Over-approximates on purpose: an
// unqualified identifier counts as a column of every table its statement names that has a column of that name.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS = resolve(here, "..", "..", "packages", "persistence", "migrations");

// The lane's guards (design section 1) and the writers/readers its B bindings replace or keep.
export const COVERED = {
  G1: ["guard_active_owner_count", "maintain_active_owner_count", "enforce_membership_initial_state"],
  G2: ["payment_orders_allocation_writer", "capture_facts_allocate"],
  G3: ["processing_jobs_workflow", "processing_attempts_bookkeeping", "processing_attempts_workflow", "attempt_owns_lease"],
  G4: ["cost_grants_workflow", "cost_grants_pool_hold", "request_journal_reserves_grant", "request_journal_guard"],
  G5: ["is_control_session"],
  G6: ["audits_workflow", "audit_steps_workflow", "audit_steps_claim_fence"],
  G7: ["record_commercial_transition", "record_corporate_transition", "commercial_transitions_recorded_by_trigger"],
  G8: ["founding_slot_reservations_consumed_by_designation", "founding_slot_reservations_snapshot_binding"],
  G9: ["agency_recurrence_designation_only"],
  G10: ["qualifying_purchases_designation_only", "designate_qualifying_purchase"],
  G11: ["execution_capacity_last_admission_guard", "processing_jobs_ledgers", "execution_ledgers_consistent", "check_execution_ledgers", "lock_execution_ledger"],
  G12: ["agency_execution_capacity_guard"],
  G13: ["leases_guard", "claim_lease", "heartbeat_lease", "checkpoint_lease", "cancel_lease"],
  G14: ["commercial_authorizations_consumption_bound", "commercial_authorizations_delivery_bound", "processing_jobs_admission_bound", "processing_jobs_ready_bound"],
};

// Generic helpers: they read no table a guard decides on (clock, context, locks, label checks); not followed.
const GENERIC = new Set([
  "server_now", "current_user_id", "current_agency_id", "take_transition_lock", "await_transition", "transition_key", "touch_updated_at",
  "enforce_version_bump", "forbid_column_change", "forbid_reassignment", "forbid_change", "enforce_listed_transition", "enforce_listed_transition_of",
  "enforce_initial_state", "require_event_for_version", "require_state_event_type", "require_commerce_event_type", "is_uuid_v7", "is_sha256_hex",
  "is_label", "is_money", "is_generation",
]);

const KEYWORDS = new Set(("where set on join for using values select into limit order group returning and or when left right inner cross full do " +
  "then else end as is not null in exists from update insert delete with having union lateral natural outer by skip nowait share key no " +
  "if loop return raise perform declare begin case").split(" "));

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function lineOf(src, i) {
  return src.slice(0, i).split("\n").length;
}

export function parseMigrations(dir = DEFAULT_MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const tables = new Map(); // table -> Set(columns)
  const functions = new Map(); // name -> { body, at }
  const attachments = new Map(); // fn -> [{ table, args, at }]
  const learnedOnce = new Map(); // table -> Set
  const immutable = new Map(); // table -> Set
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); for (const x of v) m.get(k).add(x); };
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const src = stripComments(raw);
    const tag = f.slice(0, 4);
    for (const m of src.matchAll(/CREATE TABLE kauro\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const cols = [];
      for (const line of m[2].split("\n")) {
        const c = /^\s+([a-z_][a-z0-9_]*)\s+(uuid|text|bigint|integer|smallint|timestamptz|boolean|jsonb|numeric|date|bytea|interval|inet|char|varchar)/.exec(line);
        if (c && !["constraint", "primary", "unique", "foreign", "check", "exclude"].includes(c[1])) cols.push(c[1]);
      }
      add(tables, m[1], cols);
    }
    for (const m of src.matchAll(/ALTER TABLE kauro\.(\w+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/g)) add(tables, m[1], [m[2]]);
    for (const m of src.matchAll(/CREATE (?:OR REPLACE )?FUNCTION kauro\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS[\s\S]*?\$\$([\s\S]*?)\$\$/g)) {
      functions.set(m[1], { body: m[3], params: m[2], at: `${tag}:${lineOf(raw, m.index)}` });
    }
    for (const m of src.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER\s+(\w+)\s+(?:BEFORE|AFTER)[\s\S]*?\sON\s+kauro\.(\w+)\b[\s\S]*?EXECUTE FUNCTION\s+kauro\.(\w+)\(([^)]*)\)/g)) {
      const args = [...m[4].matchAll(/'([^']*)'/g)].map((a) => a[1]);
      if (!attachments.has(m[3])) attachments.set(m[3], []);
      attachments.get(m[3]).push({ trigger: m[1], table: m[2], args, at: `${tag}:${lineOf(raw, m.index)}` });
      if (m[3] === "forbid_reassignment") add(learnedOnce, m[2], args.join(",").split(",").filter(Boolean));
      if (m[3] === "forbid_column_change") add(immutable, m[2], args.join(",").split(",").filter(Boolean));
    }
  }
  return { tables, functions, attachments, learnedOnce, immutable };
}

function callees(body) {
  return [...body.matchAll(/kauro\.(\w+)\s*\(/g)].map((m) => m[1]);
}

export function inventory(dir = DEFAULT_MIGRATIONS) {
  const db = parseMigrations(dir);
  const reads = new Map(); // table -> Map(column -> Set(fn))
  const note = (t, c, fn) => {
    if (!db.tables.has(t) || !db.tables.get(t).has(c)) return;
    if (!reads.has(t)) reads.set(t, new Map());
    if (!reads.get(t).has(c)) reads.get(t).set(c, new Set());
    reads.get(t).get(c).add(fn);
  };
  const guardOf = new Map();
  for (const [g, fns] of Object.entries(COVERED)) for (const fn of fns) guardOf.set(fn, g);
  // transitive closure over kauro callees
  const queue = [...guardOf.keys()];
  const seen = new Set();
  const missing = [];
  while (queue.length) {
    const fn = queue.shift();
    if (seen.has(fn)) continue;
    seen.add(fn);
    const def = db.functions.get(fn);
    if (!def) { missing.push(fn); continue; }
    for (const c of callees(def.body)) if (!GENERIC.has(c) && db.functions.has(c) && !seen.has(c)) { queue.push(c); if (!guardOf.has(c)) guardOf.set(c, guardOf.get(fn)); }
  }
  for (const fn of seen) {
    const def = db.functions.get(fn);
    if (!def) continue;
    const attached = (db.attachments.get(fn) ?? []).map((a) => a.table);
    const body = def.body.replace(/'(?:[^']|'')*'/g, "''");
    for (const stmt of body.split(";")) {
      const aliases = new Map();
      for (const m of stmt.matchAll(/kauro\.([a-z_][a-z0-9_]*)\b(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
        const t = m[1];
        if (!db.tables.has(t)) continue;
        aliases.set(t, t);
        if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) aliases.set(m[2], t);
      }
      for (const m of stmt.matchAll(/\b(NEW|OLD)\.([a-z_][a-z0-9_]*)/g)) for (const t of attached) note(t, m[2], fn);
      for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const t = aliases.get(m[1]);
        if (t) note(t, m[2], fn);
      }
      const named = [...new Set(aliases.values())];
      if (named.length) {
        for (const m of stmt.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)(?![\w.(])/g)) for (const t of named) note(t, m[1], fn);
      }
    }
    // dynamic history writers: TG_ARGV id/state columns plus version and agency_id of every attached subject
    if (/TG_ARGV/.test(def.body)) {
      for (const a of db.attachments.get(fn) ?? []) {
        for (const c of [...a.args.slice(1), "version", "agency_id", "updated_at", "created_at"]) note(a.table, c, fn);
      }
    }
  }
  const out = { generatedFrom: "packages/persistence/migrations", functions: {}, tables: {}, missingFunctions: missing };
  for (const fn of [...seen].sort()) out.functions[fn] = { guard: guardOf.get(fn) ?? null, at: db.functions.get(fn)?.at ?? null, attachedTo: (db.attachments.get(fn) ?? []).map((a) => `${a.table}@${a.at}`) };
  let columns = 0;
  let firstAssignments = 0;
  for (const t of [...reads.keys()].sort()) {
    const cols = {};
    for (const c of [...reads.get(t).keys()].sort()) {
      const lo = db.learnedOnce.get(t)?.has(c) ?? false;
      cols[c] = { readBy: [...reads.get(t).get(c)].sort(), learnedOnce: lo, immutable: db.immutable.get(t)?.has(c) ?? false };
      columns += 1;
      if (lo) firstAssignments += 1;
    }
    out.tables[t] = cols;
  }
  out.counts = { functions: seen.size, tables: Object.keys(out.tables).length, columns, firstAssignments };
  return out;
}

// The design doc's section 3b: one line per table, "- `table` (row N) imm: ...; bound: ...; first: ...", and one line
// "Residual B-LIFETIME-2: `table` ...". Every inventory column must appear backticked on its table's line; every learned-once
// column must appear after "first:" with a binding text; a residual table needs no line.
export function sectionLines(doc) {
  const start = doc.indexOf("### 3b");
  if (start < 0) return { tables: new Map(), residual: new Set() };
  const end = doc.indexOf("\n## ", start);
  const text = doc.slice(start, end < 0 ? undefined : end);
  const tables = new Map();
  const residual = new Set();
  for (const line of text.split("\n")) {
    const row = /^- `([a-z_][a-z0-9_]*)` \(row \d+\)(.*)$/.exec(line);
    if (row) {
      const body = row[2];
      const firstAt = body.indexOf(" first: ");
      const firstPart = firstAt < 0 ? "" : body.slice(firstAt);
      const tokens = new Set([...body.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]));
      const first = new Map();
      for (const m of firstPart.matchAll(/`([a-z_][a-z0-9_]*)` ([^;.]+)/g)) first.set(m[1], m[2].trim());
      tables.set(row[1], { tokens, first });
    }
    const res = /^Residual B-LIFETIME-2:(.*)$/.exec(line);
    if (res) for (const m of res[1].matchAll(/`([a-z_][a-z0-9_]*)`/g)) residual.add(m[1]);
  }
  return { tables, residual };
}

export function unmapped(inv, doc) {
  const { tables, residual } = sectionLines(doc);
  const missing = [];
  for (const [t, cols] of Object.entries(inv.tables)) {
    if (residual.has(t)) continue;
    const line = tables.get(t);
    if (!line) { missing.push(`${t}: no section 3b line and no residual entry`); continue; }
    for (const [c, v] of Object.entries(cols)) {
      if (!line.tokens.has(c)) missing.push(`${t}.${c}: no cell`);
      else if (v.learnedOnce && !(line.first.get(c) ?? "").length) missing.push(`${t}.${c}: learned once without a first-assignment binding`);
    }
  }
  return missing;
}

export function check(docPath, dir = DEFAULT_MIGRATIONS) {
  const inv = inventory(dir);
  const missing = unmapped(inv, readFileSync(docPath, "utf8"));
  return { ...inv.counts, unmapped: missing.length, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--check");
  if (at >= 0) {
    const doc = resolve(args[at + 1] ?? join(here, "..", "..", "docs", "design", "SEC-DEPTH-PROVENANCE.md"));
    const rest = args.filter((_, i) => i !== at && i !== at + 1);
    const r = check(doc, rest[0] ? resolve(rest[0]) : DEFAULT_MIGRATIONS);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(r.unmapped === 0 ? 0 : 1);
  }
  process.stdout.write(JSON.stringify(inventory(args[0] ? resolve(args[0]) : DEFAULT_MIGRATIONS), null, 2) + "\n");
}

#!/usr/bin/env node
// SEC-DEPTH-PROVENANCE completeness and enforcement check (read-only).
//   node tools/sec/guard-reads.mjs [migrationsDir]                  -> JSON inventory
//   node tools/sec/guard-reads.mjs --check [designDoc] [migrationsDir] -> JSON report, exit 1 on any problem
// Inventory: for every guard function the lane covers (and the kauro functions they call), every table and column it reads or
// writes, from the migration SQL (latest CREATE OR REPLACE wins). Columns are flagged learned once (kauro.forbid_reassignment:
// a NULL -> value first assignment) and immutable (kauro.forbid_column_change). Over-approximates on purpose: an unqualified
// identifier counts as a column of every table its statement names.
// Check (design doc section 3b/3c): every inventory table has a 3b line (or a "feeds none" residual entry); every column is
// classified imm / bound / all / first, and every bound or first cell names an enforcing trigger that (a) exists on that table in
// the SQL, or is declared in 3c as planned in a migration not yet written, (b) fires on UPDATE of that column (no UPDATE OF list
// or one naming it; no WHEN clause, or one that reads the column), (c) runs a function that reads the column (NEW/OLD, its
// trigger arguments, or a whole-row refusal), and for a first cell also (d) fires on INSERT and is not the learned-once trigger
// itself. A line marked feeds money or authority needs a birth cell naming a table-specific INSERT trigger.
// Known limits (stated in the design doc): views and wildcard reads are not followed; functions are keyed by name (kauro has one
// schema); string-built dynamic SQL is read only through TG_ARGV and ->> literals. Sufficiency of a binding is a review question.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS = resolve(here, "..", "..", "packages", "persistence", "migrations");
export const DEFAULT_DOC = resolve(here, "..", "..", "docs", "design", "SEC-DEPTH-PROVENANCE.md");

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
  G14: ["commercial_authorizations_consumption_bound", "commercial_authorizations_delivery_bound", "processing_jobs_admission_bound", "processing_jobs_ready_bound", "package_versions_workflow", "package_versions_publication_guard"],
  // config readers every guard relies on (listed edges, initial states, event bindings): their table reads count, their NEW/OLD do
  // not (they are attached to every machine table, and the machine columns they read are mapped per table as `state`)
  CONFIG: ["enforce_listed_transition", "enforce_listed_transition_of", "enforce_initial_state", "enforce_initial_state_of", "require_event_for_version", "require_state_event_type", "require_commerce_event_type"],
};
const NO_NEW_OLD = new Set(COVERED.CONFIG);

// Helpers that read no table (clock, context, locks, label checks) or only bookkeeping of their own row; not followed.
const GENERIC = new Set([
  "server_now", "current_user_id", "current_agency_id", "take_transition_lock", "await_transition", "transition_key", "touch_updated_at",
  "enforce_version_bump", "forbid_column_change", "forbid_reassignment", "forbid_change", "is_uuid_v7", "is_sha256_hex", "is_label", "is_money",
  "is_generation", "is_token", "is_distinct_uuid_set",
]);
// Functions that never count as a birth binding (they bind no value of the row to a source).
const NOT_BIRTH = new Set(["touch_updated_at", "enforce_version_bump", "require_event_for_version", "require_state_event_type", "require_commerce_event_type", "take_transition_lock"]);

const KEYWORDS = new Set(("where set on join for using values select into limit order group returning and or when left right inner cross full do " +
  "then else end as is not null in exists from update insert delete with having union lateral natural outer by skip nowait share key no " +
  "if loop return raise perform declare begin case").split(" "));

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function lineOf(src, i) {
  return src.slice(0, i).split("\n").length;
}

function parseEvents(header) {
  const timing = /^(BEFORE|AFTER|INSTEAD OF)\s+/i.exec(header)?.[1]?.toUpperCase() ?? "";
  const rest = header.replace(/^(BEFORE|AFTER|INSTEAD OF)\s+/i, "");
  const events = new Set();
  let ofCols = null;
  for (const part of rest.split(/\s+OR\s+/i)) {
    const p = part.trim();
    const up = /^UPDATE(?:\s+OF\s+(.*))?$/i.exec(p);
    if (up) { events.add("UPDATE"); if (up[1]) ofCols = new Set(up[1].split(",").map((c) => c.trim())); continue; }
    if (/^(INSERT|DELETE|TRUNCATE)$/i.test(p)) events.add(p.toUpperCase());
  }
  return { timing, events, ofCols };
}

export function parseMigrations(dir = DEFAULT_MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const tables = new Map();
  const functions = new Map();
  const attachments = new Map();
  const triggers = new Map(); // `${table}.${name}` -> trigger
  const learnedOnce = new Map();
  const immutable = new Map();
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
    for (const m of src.matchAll(/DROP TRIGGER (?:IF EXISTS )?(\w+) ON kauro\.(\w+)/g)) triggers.delete(`${m[2]}.${m[1]}`);
    for (const m of src.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER\s+(\w+)\s+((?:BEFORE|AFTER|INSTEAD OF)[\s\S]*?)\s+ON\s+kauro\.(\w+)\b([\s\S]*?)EXECUTE FUNCTION\s+kauro\.(\w+)\(([^)]*)\)/g)) {
      const args = [...m[6].matchAll(/'([^']*)'/g)].map((a) => a[1]);
      const ev = parseEvents(m[2].replace(/\s+/g, " ").trim());
      const when = /WHEN\s*\(([\s\S]*)\)\s*$/.exec(m[4].trim())?.[1] ?? null;
      const t = { name: m[1], table: m[3], ...ev, when, fn: m[5], args, at: `${tag}:${lineOf(raw, m.index)}`, planned: false };
      triggers.set(`${t.table}.${t.name}`, t);
      if (!attachments.has(t.fn)) attachments.set(t.fn, []);
      attachments.get(t.fn).push({ trigger: t.name, table: t.table, args, at: t.at });
      if (t.fn === "forbid_reassignment") add(learnedOnce, t.table, args.join(",").split(",").filter(Boolean));
      if (t.fn === "forbid_column_change") add(immutable, t.table, args.join(",").split(",").filter(Boolean));
    }
  }
  return { files, tables, functions, attachments, triggers, learnedOnce, immutable };
}

function callees(body) {
  return [...body.matchAll(/kauro\.(\w+)\s*\(/g)].map((m) => m[1]);
}

export function inventory(dir = DEFAULT_MIGRATIONS, db = parseMigrations(dir)) {
  const reads = new Map();
  const note = (t, c, fn) => {
    if (!db.tables.has(t) || !db.tables.get(t).has(c)) return;
    if (!reads.has(t)) reads.set(t, new Map());
    if (!reads.get(t).has(c)) reads.get(t).set(c, new Set());
    reads.get(t).get(c).add(fn);
  };
  const guardOf = new Map();
  for (const [g, fns] of Object.entries(COVERED)) for (const fn of fns) guardOf.set(fn, g);
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
    const attached = NO_NEW_OLD.has(fn) ? [] : (db.attachments.get(fn) ?? []);
    const literalCols = [...def.body.matchAll(/->>\s*'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
    const body = def.body.replace(/'(?:[^']|'')*'/g, "''");
    for (const stmt of body.split(";")) {
      const aliases = new Map();
      for (const m of stmt.matchAll(/kauro\.([a-z_][a-z0-9_]*)\b(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
        const t = m[1];
        if (!db.tables.has(t)) continue;
        aliases.set(t, t);
        if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) aliases.set(m[2], t);
      }
      for (const m of stmt.matchAll(/\b(NEW|OLD)\.([a-z_][a-z0-9_]*)/g)) for (const a of attached) note(a.table, m[2], fn);
      for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const t = aliases.get(m[1]);
        if (t) note(t, m[2], fn);
      }
      const named = [...new Set(aliases.values())];
      if (named.length) for (const m of stmt.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)(?![\w.(])/g)) for (const t of named) note(t, m[1], fn);
    }
    // dynamic row readers (to_jsonb(NEW) ->> TG_ARGV[i] or ->> 'literal'): the argument columns and the literal columns
    if (/TG_ARGV/.test(def.body) && !NO_NEW_OLD.has(fn)) {
      for (const a of attached) for (const c of [...a.args.slice(1), ...literalCols]) note(a.table, c, fn);
    }
  }
  const out = { generatedFrom: "packages/persistence/migrations", functions: {}, tables: {}, missingFunctions: missing };
  for (const fn of [...seen].sort()) out.functions[fn] = { guard: guardOf.get(fn) ?? null, at: db.functions.get(fn)?.at ?? null };
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

// ---- design doc ------------------------------------------------------------------------------------------------------------------

function section(doc, heading) {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const next = doc.slice(start + heading.length).search(/\n#{2,3} /);
  return next < 0 ? doc.slice(start) : doc.slice(start, start + heading.length + next);
}

// 3c: "- planned `name` BEFORE INSERT OR UPDATE ON `table` in sec_depth_l2a_admission (columns: `a` `b`)". The migration is named by
// its slug (the file NNNN_<slug>.sql), never by number: a number shifts whenever another migration lands first (incident
// PLANNED-MIGRATION-SHIFT, four times on 2026-10-13), a slug does not.
export function plannedTriggers(doc) {
  const out = [];
  for (const line of section(doc, "### 3c").split("\n")) {
    const m = /^- planned `(\w+)` ((?:BEFORE|AFTER) [A-Z ,_a-z]+?) ON `(\w+)` in (\w+)(?: \(columns: ([^)]*)\))?/.exec(line);
    if (!m) continue;
    const ev = parseEvents(m[2].trim());
    const columns = new Set([...(m[5] ?? "").matchAll(/`([a-z_][a-z0-9_]*|[*])`/g)].map((x) => x[1]));
    out.push({ name: m[1], table: m[3], ...ev, when: null, fn: null, args: [], migration: m[4], columns, planned: true });
  }
  return out;
}

// 3b: "- `t` (row N; feeds money|authority|money and authority|none: why) birth: [trig] text; imm: `a`; bound: `c` [trig] text;
//      all: [trig] text: `x` `y`; first: `e` [trig] text."  and "Residual B-LIFETIME-2 (feeds none): `t` why; ..."
export function sectionLines(doc) {
  const text = section(doc, "### 3b");
  const tables = new Map();
  const residual = new Map();
  for (const line of text.split("\n")) {
    const row = /^- `([a-z_][a-z0-9_]*)` \(row (\d+); feeds (money and authority|money|authority|none)([^)]*)\)(.*)$/.exec(line);
    if (row) {
      const body = row[5];
      const marks = [...body.matchAll(/\b(birth|imm|bound|all|first):/g)];
      const seg = {};
      marks.forEach((m, i) => { seg[m[1]] = (seg[m[1]] ?? "") + body.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined); });
      const cells = new Map(); // column -> { kind, triggers }
      const entries = (s, kind) => {
        for (const m of (s ?? "").matchAll(/`([a-z_][a-z0-9_]*)` \[([\w, ]+)\]/g)) cells.set(m[1], { kind, triggers: m[2].split(",").map((x) => x.trim()) });
      };
      entries(seg.bound, "bound");
      entries(seg.first, "first");
      for (const m of (seg.imm ?? "").matchAll(/`([a-z_][a-z0-9_]*)`/g)) cells.set(m[1], { kind: "imm", triggers: [] });
      if (seg.all) {
        const trig = /\[([\w, ]+)\]/.exec(seg.all)?.[1]?.split(",").map((x) => x.trim()) ?? [];
        const after = seg.all.slice(seg.all.indexOf("]") + 1);
        for (const m of after.matchAll(/`([a-z_][a-z0-9_]*)`/g)) cells.set(m[1], { kind: "bound", triggers: trig });
      }
      const birth = /\[([\w, ]+)\]/.exec(seg.birth ?? "")?.[1]?.split(",").map((x) => x.trim()) ?? null;
      tables.set(row[1], { row: Number(row[2]), feeds: row[3], cells, birth });
    }
    const res = /^Residual B-LIFETIME-2 \(feeds none\):(.*)$/.exec(line);
    if (res) for (const m of res[1].matchAll(/`([a-z_][a-z0-9_]*)` ([^;.]+)/g)) residual.set(m[1], m[2].trim());
  }
  return { tables, residual };
}

// Row-specific reads (Codex r13 SDP-41): the trigger's own function must read the column of THIS row (NEW.col / OLD.col, its
// trigger arguments, or a whole-row refusal), or a function it calls must read that column of THIS table by the statement-level
// extraction of the inventory (a deferred recount re-selecting the row). A column token of another table never counts.
export function fnReads(db, trig, col, readsByFn = readsOfFunctions(db)) {
  if (trig.planned) return trig.columns.has(col) || trig.columns.has("*");
  if (trig.fn === "forbid_change") return true; // whole-row refusal
  if (trig.args.join(",").split(",").map((x) => x.trim()).includes(col)) return true;
  if (["enforce_listed_transition", "enforce_initial_state"].includes(trig.fn)) return col === "state";
  if (trig.fn === "touch_updated_at") return col === "updated_at";
  if (trig.fn === "enforce_version_bump") return col === "version";
  const own = (db.functions.get(trig.fn)?.body ?? "").replace(/'(?:[^']|'')*'/g, "''");
  if (new RegExp(`\\b(NEW|OLD)\\.${col}\\b`).test(own)) return true;
  const seen = new Set();
  const queue = [trig.fn];
  while (queue.length) {
    const fn = queue.shift();
    if (seen.has(fn) || GENERIC.has(fn)) continue;
    seen.add(fn);
    if (readsByFn.get(fn)?.has(`${trig.table}.${col}`)) return true;
    for (const c of callees(db.functions.get(fn)?.body ?? "")) if (db.functions.has(c)) queue.push(c);
  }
  return false;
}

// statement-level reads of every function (same extraction as the inventory, NEW/OLD excluded): fn -> Set("table.column")
const readsCache = new WeakMap();
export function readsOfFunctions(db) {
  if (readsCache.has(db)) return readsCache.get(db);
  const out = new Map();
  for (const [fn, def] of db.functions) {
    const set = new Set();
    const body = def.body.replace(/'(?:[^']|'')*'/g, "''");
    for (const stmt of body.split(";")) {
      const aliases = new Map();
      for (const m of stmt.matchAll(/kauro\.([a-z_][a-z0-9_]*)\b(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
        if (!db.tables.has(m[1])) continue;
        aliases.set(m[1], m[1]);
        if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) aliases.set(m[2], m[1]);
      }
      for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const t = aliases.get(m[1]);
        if (t && db.tables.get(t).has(m[2])) set.add(`${t}.${m[2]}`);
      }
      const named = [...new Set(aliases.values())];
      if (named.length === 1) for (const m of stmt.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)(?![\w.(])/g)) if (db.tables.get(named[0]).has(m[1])) set.add(`${named[0]}.${m[1]}`);
    }
    out.set(fn, set);
  }
  readsCache.set(db, out);
  return out;
}

export function resolveTrigger(db, planned, table, name, migrationsPresent) {
  const sql = db.triggers.get(`${table}.${name}`);
  const p = planned.find((x) => x.name === name && x.table === table);
  // a planned (re)definition stands for the trigger until its migration exists; from then on the SQL must carry it
  if (p && /^\d+$/u.test(p.migration)) return { error: `planned trigger ${name} on ${table} names its migration by number (${p.migration}): name it by slug (NNNN_<slug>.sql), a number shifts when another migration lands first` };
  if (p && !migrationsPresent.has(p.migration)) return { trig: p };
  if (sql) return { trig: sql };
  if (!p) return { error: `trigger ${name} does not exist on ${table} (neither in the migrations nor planned in 3c)` };
  return { error: `planned trigger ${name} on ${table} is missing from migration ${p.migration}` };
}

// A trigger's WHEN never certifies by mention (Codex r13 SDP-41; the kit lint's allowlist principle): a cell is covered only when
// the WHEN is absent, or is exactly a disjunction of change terms `OLD.c IS DISTINCT FROM NEW.c` (either order) one of which is the
// column, or its normalized text is in REVIEWED_WHEN for that trigger and column. Anything else fails.
export const REVIEWED_WHEN = new Map([
  // "table.trigger" -> { when: normalized text, columns: [...] } — add only after review; none needed on 21b310f
]);

export function normalizeWhen(when) {
  let w = when.replace(/\s+/g, " ").trim();
  while (/^\((.*)\)$/.test(w) && balanced(w.slice(1, -1))) w = w.slice(1, -1).trim();
  return w;
}

function balanced(s) {
  let d = 0;
  for (const ch of s) { if (ch === "(") d += 1; if (ch === ")") { d -= 1; if (d < 0) return false; } }
  return d === 0;
}

export function whenCovers(trig, col) {
  if (!trig.when) return true;
  const w = normalizeWhen(trig.when);
  const reviewed = REVIEWED_WHEN.get(`${trig.table}.${trig.name}`);
  if (reviewed && reviewed.when === w && reviewed.columns.includes(col)) return true;
  const terms = w.split(/ OR /i).map((t) => normalizeWhen(t));
  const cols = [];
  for (const t of terms) {
    const m = /^(OLD|NEW)\.([a-z_][a-z0-9_]*) IS DISTINCT FROM (NEW|OLD)\.([a-z_][a-z0-9_]*)$/i.exec(t);
    if (!m || m[1].toUpperCase() === m[3].toUpperCase() || m[2] !== m[4]) return false;
    cols.push(m[2]);
  }
  return cols.includes(col);
}

export function firesOnUpdateOf(trig, col) {
  if (!trig.events.has("UPDATE")) return "does not fire on UPDATE";
  if (trig.ofCols && !trig.ofCols.has(col)) return `fires only on UPDATE OF ${[...trig.ofCols].join(", ")}`;
  if (!whenCovers(trig, col)) return `its WHEN (${trig.when.replace(/\s+/g, " ").slice(0, 80)}) is not a change predicate on ${col} nor a reviewed text`;
  return null;
}

export function problems(inv, doc, db) {
  const { tables, residual } = sectionLines(doc);
  const planned = plannedTriggers(doc);
  const migrationsPresent = new Set(db.files.map((f) => f.replace(/^\d{4}_/u, "").replace(/\.sql$/u, "")));
  const readsByFn = readsOfFunctions(db);
  const out = [];
  for (const [t, cols] of Object.entries(inv.tables)) {
    if (residual.has(t)) { if (tables.has(t)) out.push(`${t}: both a 3b line and a residual entry`); continue; }
    const line = tables.get(t);
    if (!line) { out.push(`${t}: no section 3b line and no residual entry`); continue; }
    const appendOnly = [...db.triggers.values()].some((x) => x.table === t && x.fn === "forbid_change" && x.events.has("UPDATE"));
    if (line.feeds !== "none") {
      if (!line.birth) out.push(`${t}: feeds ${line.feeds} but has no birth cell`);
      else {
        const ok = line.birth.some((name) => {
          const r = resolveTrigger(db, planned, t, name, migrationsPresent);
          return r.trig && r.trig.events.has("INSERT") && !NOT_BIRTH.has(r.trig.fn);
        });
        if (!ok) out.push(`${t}: birth cell names no table-specific trigger that fires on INSERT`);
      }
    }
    for (const [c, v] of Object.entries(cols)) {
      const cell = line.cells.get(c);
      if (!cell) { out.push(`${t}.${c}: no cell`); continue; }
      if (cell.kind === "imm") {
        if (!v.immutable && !appendOnly) out.push(`${t}.${c}: claimed imm but no forbid_column_change or append-only trigger covers it`);
        if (v.learnedOnce) out.push(`${t}.${c}: learned once, needs a first cell`);
        continue;
      }
      if (v.learnedOnce && cell.kind !== "first") { out.push(`${t}.${c}: learned once, needs a first cell`); continue; }
      const reasons = [];
      const ok = cell.triggers.some((name) => {
        const r = resolveTrigger(db, planned, t, name, migrationsPresent);
        if (r.error) { reasons.push(r.error); return false; }
        const trig = r.trig;
        const why = firesOnUpdateOf(trig, c);
        if (why) { reasons.push(`${name} ${why}`); return false; }
        if (!fnReads(db, trig, c, readsByFn)) { reasons.push(`${name} does not read ${c} of this row`); return false; }
        if (cell.kind === "first") {
          if (!trig.events.has("INSERT")) { reasons.push(`${name} does not fire on INSERT (first write at birth)`); return false; }
          if (trig.fn === "forbid_reassignment") { reasons.push(`${name} is the learned-once trigger itself`); return false; }
        }
        return true;
      });
      if (!ok) out.push(`${t}.${c}: ${cell.triggers.length ? reasons.join("; ") : "names no enforcing trigger"}`);
    }
  }
  return out;
}

export function check(docPath = DEFAULT_DOC, dir = DEFAULT_MIGRATIONS) {
  const db = parseMigrations(dir);
  const inv = inventory(dir, db);
  const doc = readFileSync(docPath, "utf8");
  const found = problems(inv, doc, db);
  const { tables, residual } = sectionLines(doc);
  return { ...inv.counts, mappedTables: [...tables.keys()].filter((t) => inv.tables[t]).length, residualTables: [...residual.keys()].filter((t) => inv.tables[t]).length, planned: plannedTriggers(doc).length, problems: found.length, missing: found };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--check");
  if (at >= 0) {
    const doc = args[at + 1] && existsSync(resolve(args[at + 1])) ? resolve(args[at + 1]) : DEFAULT_DOC;
    const rest = args.filter((a, i) => i !== at && resolve(a) !== doc);
    const r = check(doc, rest[0] ? resolve(rest[0]) : DEFAULT_MIGRATIONS);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(r.problems === 0 ? 0 : 1);
  }
  process.stdout.write(JSON.stringify(inventory(args[0] ? resolve(args[0]) : DEFAULT_MIGRATIONS), null, 2) + "\n");
}

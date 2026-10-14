// B05 lane L3t, CK1-CK3 (docs/design/B05-cores.md D5-20 "one clock by source", D5-11 deferred census): the clock census of the live
// schema and the migration files equals persistence/clock-gates.json, each site classified; no deferred function but the two gates
// locks or writes and the deferred foreign keys are D5-11's; the product reads no process clock outside its four injection points.
// Write mode (the coordinator's, at every rebase; never hand-merged, as openapi.json): KAURO_CLOCK_GATES=write regenerates the file,
// keeping no hand edit: the classes come from the rules and tables below, and a site no rule classifies fails as UNCLASSIFIED.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { MIGRATIONS_DIR } from "../src/migrations/runner.js";
import { start, type Harness } from "../src/testing/harness.js";
import { census, sqlCallers, stripComments, maskStrings, type Census, type Site } from "./clock-census.js";

const PACKAGE_ROOT = join(MIGRATIONS_DIR, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const GATES_FILE = join(PACKAGE_ROOT, "clock-gates.json");
const WRITE = process.env["KAURO_CLOCK_GATES"] === "write";

let h: Harness;
before(async () => {
  h = await start();
});
after(async () => {
  await h.stop();
});

// --- classification ------------------------------------------------------------------------------------------------------------------

/** The package owning each migration file (its header; 0001-0007 the B06 foundation; 0023's deadline gates are B05's, D5-20). */
function ownerOfFile(tag: string): string {
  const n = Number(tag);
  if (n <= 8 || n === 54 || n === 67) return "B06";
  if ((n >= 9 && n <= 12) || n === 18 || n === 20) return "B07";
  if ((n >= 13 && n <= 17) || n === 19 || n === 53) return "B09";
  if (n === 21 || n === 22 || n === 24 || n === 44) return "B08";
  if (n === 23 || n === 58 || n === 61 || n === 66 || n === 68 || n === 70) return "B05";
  if (n >= 25 && n <= 27) return "B11";
  if ((n >= 28 && n <= 43) || n === 48 || n === 49 || n === 56 || n === 57 || n === 73) return "B10";
  if (n === 45 || n === 46 || n === 47 || n === 55 || n === 72 || n === 79 || n === 80 || n === 81) return "PV1";
  if (n === 50 || n === 52) return "B17";
  if (n === 51 || n === 59) return "B18";
  if (n === 60) return "SEC-DEPTH";
  if (n === 69 || n === 71 || (n >= 74 && n <= 76)) return "B16";
  if (n === 77) return "SEC-HARDENING-2";
  if (n === 78) return "SEC-OWNER-POLICY-FORALL";
  return "UNKNOWN";
}
const fileTag = (at: string): string => at.split(":")[0]!;

/** AT_COMMIT judges (D5-20): the 0023 gates re-judged at COMMIT by a deferred trigger reading the same column with effect_now(). */
const AT_COMMIT: ReadonlyArray<{ object: string; text: RegExp; nth?: number; trigger: string; table: string; column: string; site: string }> = [
  // L3t, 0066
  { object: "function:cost_grants_workflow", text: /NEW\.expires_at <= clock/, trigger: "cost_grants_birth_at_commit", table: "cost_grants", column: "expires_at", site: "0023:145 birth" },
  { object: "function:cost_grants_workflow", text: /OLD\.expires_at <= clock$/, nth: 1, trigger: "cost_grants_authorized_at_commit", table: "cost_grants", column: "expires_at", site: "0023:169 PREPARED -> AUTHORIZED" },
  { object: "function:cost_grants_workflow", text: /OLD\.expires_at <= clock$/, nth: 2, trigger: "cost_grants_authorized_at_commit", table: "cost_grants", column: "expires_at", site: "0023:178 EXHAUSTED -> AUTHORIZED" },
  { object: "function:cost_grants_pool_hold", text: /expires_at > kauro\.server_now\(\)/, trigger: "cost_grants_authorized_at_commit", table: "cost_grants", column: "expires_at", site: "0023:218 the pool's hold" },
  { object: "function:audits_workflow", text: /g\.expires_at <= clock/, trigger: "audits_birth_at_commit", table: "audits", column: "expires_at", site: "0023:435 audit birth" },
  { object: "function:audits_workflow", text: /clock >= OLD\.absolute_deadline_at/, trigger: "audits_edge_at_commit", table: "audits", column: "absolute_deadline_at", site: "0023:491 orchestration edge" },
  { object: "function:audits_draft_ready_bound", text: /kauro\.server_now\(\) >= NEW\.absolute_deadline_at/, trigger: "audits_edge_at_commit", table: "audits", column: "absolute_deadline_at", site: "0023:635 DRAFT_READY" },
  { object: "function:audit_steps_workflow", text: /clock >= a\.absolute_deadline_at/, nth: 1, trigger: "audit_steps_claim_at_commit", table: "audit_steps", column: "absolute_deadline_at", site: "0023:584 claim" },
  { object: "function:audit_steps_workflow", text: /clock >= a\.absolute_deadline_at/, nth: 2, trigger: "audit_steps_result_at_commit", table: "audit_steps", column: "absolute_deadline_at", site: "0023:598 result" },
  { object: "function:model_tasks_current_step", text: /clock >= a\.interpretation_deadline_at/, trigger: "model_tasks_planned_at_commit", table: "model_tasks", column: "interpretation_deadline_at", site: "0023:693 model task" },
  // L3t, 0066: the deferred judges themselves (effect_now() at COMMIT)
  { object: "function:cost_grants_authority_at_commit", text: /g\.expires_at <= judged/, trigger: "cost_grants_birth_at_commit", table: "cost_grants", column: "expires_at", site: "0066 the grant's expiry at COMMIT" },
  { object: "function:cost_grants_authority_at_commit", text: /g\.pool_expires_at <= judged/, trigger: "cost_grants_birth_at_commit", table: "cost_grants", column: "expires_at", site: "0066 the AUDIT grant's pool expiry at COMMIT" },
  { object: "function:audits_authority_at_commit", text: /grant_expires <= judged/, trigger: "audits_birth_at_commit", table: "audits", column: "expires_at", site: "0066 the audit's grant expiry at COMMIT" },
  { object: "function:audits_authority_at_commit", text: /judged >= a\.absolute_deadline_at/, trigger: "audits_edge_at_commit", table: "audits", column: "absolute_deadline_at", site: "0066 the audit's absolute deadline at COMMIT" },
  { object: "function:audit_steps_authority_at_commit", text: /kauro\.effect_now\(\) >= a\.absolute_deadline_at/, trigger: "audit_steps_claim_at_commit", table: "audit_steps", column: "absolute_deadline_at", site: "0066 a step's absolute deadline at COMMIT" },
  { object: "function:model_tasks_authority_at_commit", text: /kauro\.effect_now\(\) >= NEW\.interpretation_deadline_at/, trigger: "model_tasks_planned_at_commit", table: "model_tasks", column: "interpretation_deadline_at", site: "0066 a task's interpretation deadline at COMMIT" },
  // L3m, 0061: the reservation's and the send's judgements after their last lock wait (judged := effect_now()), re-judged at COMMIT by
  // request_journal_commit_gate (0023:272, :284, :309 replaced; the lease, grant and pool expiries)
  { object: "function:request_journal_reserves_grant", text: /judged >= m\.interpretation_deadline_at/, trigger: "request_journal_commit_gate_reserve", table: "request_journal", column: "interpretation_deadline_at", site: "0023:272 the reservation's interpretation deadline" },
  { object: "function:request_journal_reserves_grant", text: /g\.expires_at <= judged/, trigger: "request_journal_commit_gate_reserve", table: "request_journal", column: "expires_at", site: "0023:284 the reservation's grant expiry" },
  { object: "function:request_journal_reserves_grant", text: /p\.expires_at > judged/, trigger: "request_journal_commit_gate_reserve", table: "request_journal", column: "expires_at", site: "the reservation's pool expiry" },
  { object: "function:request_journal_model_task_send", text: /judged >= m\.interpretation_deadline_at/, trigger: "request_journal_commit_gate_dispatch", table: "request_journal", column: "interpretation_deadline_at", site: "0023:309 the send's interpretation deadline" },
  { object: "function:request_journal_model_task_send", text: /l\.expires_at > judged/, trigger: "request_journal_commit_gate_dispatch", table: "request_journal", column: "expires_at", site: "the send's lease expiry" },
  { object: "function:request_journal_model_task_send", text: /g\.(pool_)?expires_at <= judged/, trigger: "request_journal_commit_gate_dispatch", table: "request_journal", column: "expires_at", site: "the send's grant and pool expiry" },
  { object: "function:request_journal_commit_gate", text: /kauro\.effect_now\(\) >= deadline/, trigger: "request_journal_commit_gate_reserve", table: "request_journal", column: "interpretation_deadline_at", site: "0061 the interpretation deadline at COMMIT" },
  { object: "function:request_journal_commit_gate", text: /l\.expires_at > kauro\.effect_now\(\)/, trigger: "request_journal_commit_gate_reserve", table: "request_journal", column: "expires_at", site: "0061 the lease expiry at COMMIT" },
  { object: "function:request_journal_commit_gate", text: /(grant|pool)_expires <= kauro\.effect_now\(\)/, trigger: "request_journal_commit_gate_reserve", table: "request_journal", column: "expires_at", site: "0061 the grant and pool expiry at COMMIT" },
];
/** MONOTONE_REFUSAL judges: an early instant only refuses or delays. */
const MONOTONE: ReadonlyArray<{ object: string; text: RegExp; reason: string }> = [
  { object: "function:cost_grants_workflow", text: /clock < OLD\.expires_at/, reason: "0023:183 EXPIRED never early: an early instant only refuses the edge (D8-DL-1)" },
  { object: "function:audits_workflow", text: /clock < OLD\.absolute_deadline_at/, reason: "0023:486 EXPIRED never early: an early instant only refuses the edge (D8-DL-1)" },
];

interface Row extends Site {
  readonly class: "AT_COMMIT" | "MONOTONE_REFUSAL" | "SHAPE" | "PARAM" | "OUTSIDE_B05" | "DYNAMIC" | "MIGRATION_DML" | "UNCLASSIFIED";
  readonly owner?: string;
  readonly reason?: string;
  readonly trigger?: string;
  readonly table?: string;
  readonly callers?: ReadonlyArray<string>;
}

async function classify(c: Client, live: Census): Promise<Row[]> {
  const liveFunctionAt = new Map<string, string>();
  for (const s of live.sites) if (s.objectKind === "function" && !liveFunctionAt.has(s.object)) liveFunctionAt.set(s.object, fileTag(s.at));
  // the stamped columns (D5-20 stamped-instant class): a judge reading one of the row being written (NEW./OLD.) compares an instant
  // stamped at its transaction's start, so it is not SHAPE
  const stamped = new Set(live.sites.filter((x) => x.kind === "S" && x.column !== undefined).map((x) => x.column!.split(".").pop()!));
  const readsStamp = (text: string): boolean => [...text.matchAll(/\b(?:NEW|OLD)\.([a-z_]\w*)/gi)].some((m) => stamped.has(m[1]!.toLowerCase()));
  const rows: Row[] = [];
  for (const s of live.sites) {
    const owner = ownerOfFile(fileTag(s.at));
    const b05 = owner === "B05";
    const object = `${s.objectKind}:${s.object}`;
    if (s.kind === "J") {
      const nth = live.sites.filter((o) => o.kind === "J" && `${o.objectKind}:${o.object}` === object && o.ordinal <= s.ordinal);
      const at = AT_COMMIT.find((x) => x.object === object && x.text.test(s.text) && (x.nth === undefined || nth.filter((o) => x.text.test(o.text)).length === x.nth));
      const mono = MONOTONE.find((x) => x.object === object && x.text.test(s.text));
      if (at !== undefined) rows.push({ ...s, class: "AT_COMMIT", trigger: at.trigger, table: at.table, reason: at.site, column: at.column });
      else if (mono !== undefined) rows.push({ ...s, class: "MONOTONE_REFUSAL", reason: mono.reason });
      else if (s.operands === "STORED" && !readsStamp(s.text)) rows.push({ ...s, class: "SHAPE", reason: "stored instants only, no clock" });
      else if (s.operands === "STORED" && !b05) rows.push({ ...s, class: "OUTSIDE_B05", owner, reason: "a stamped instant of the written row compared with a boundary (D5-20 stamped-instant class): routed to fix/clock-gates" });
      else if (s.operands === "PARAM") rows.push({ ...s, class: "PARAM", callers: s.objectKind === "function" ? await sqlCallers(c, s.object) : [] });
      else if (b05) rows.push({ ...s, class: "UNCLASSIFIED", owner });
      else rows.push({ ...s, class: "OUTSIDE_B05", owner, reason: "routed to fix/clock-gates (D5-20)" });
    } else if (s.kind === "P") {
      if (s.objectKind === "file") {
        const inBody = / in (\w+)$/.exec(s.text)?.[1];
        if (inBody === undefined) rows.push({ ...s, class: "MIGRATION_DML", owner, reason: "one-time migration statement outside a function body" });
        else if (b05) rows.push({ ...s, class: "UNCLASSIFIED", owner });
        else rows.push({ ...s, class: "OUTSIDE_B05", owner, reason: liveFunctionAt.get(inBody) === fileTag(s.at) ? `the live body of ${inBody}` : `a body of ${inBody} replaced later (not live)` });
      } else if (b05) rows.push({ ...s, class: "UNCLASSIFIED", owner });
      else rows.push({ ...s, class: "OUTSIDE_B05", owner, reason: "a clock primitive outside kauro.server_now(): routed to fix/clock-gates (D5-20)" });
    } else if (s.kind === "S") {
      if (!b05) rows.push({ ...s, class: "OUTSIDE_B05", owner, reason: "stamped by its owner's writer" });
      else if (/(expires|deadline)/.test(s.column ?? "")) rows.push({ ...s, class: "MONOTONE_REFUSAL", reason: "a deadline or expiry stamped at the transaction's start only shrinks authority (D5-20 stamped-instant class)" });
      else rows.push({ ...s, class: "SHAPE", reason: "a record instant: every comparison reading it is a judge row of its own" });
    } else {
      rows.push({ ...s, class: "DYNAMIC", owner, reason: "dynamic SQL text is not censused (D5-20 limit); read without a clock" });
    }
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// --- CK2 -------------------------------------------------------------------------------------------------------------------------------

const GATE_FUNCTIONS = new Set(["request_journal_commit_gate", "dispatch_liabilities_commit_gate"]);
const LOCK_OR_DML = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b|\bINSERT\s+INTO\b|\bUPDATE\s+(?:ONLY\s+)?kauro\.|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bMERGE\s+INTO\b|\bLOCK\s+TABLE\b/i;
/** The tables a gate-taking unit writes (D5-11): no deferred foreign key is on or references one. */
const GATE_UNIT_TABLES = new Set(["model_tasks", "leases", "request_journal", "cost_grants", "dispatch_liabilities", "pool_liability_gates", "domain_events"]);
/** D5-11's 14 deferred foreign keys by table -> referenced table (0003:231, 0009:150 projects; 0004:52, :227 plans; ...). */
const DEFERRED_FKS = ["agency_recurrence", "dataset_revisions", "fiscal_profiles", "founding_slots", "plans", "plans", "projects", "projects", "quotes", "quotes", "stored_objects", "stored_objects", "upload_sessions", "upload_sessions"];

function commitTimeLocks(live: Census): string[] {
  const problems: string[] = [];
  for (const t of live.deferredTriggers) {
    if (GATE_FUNCTIONS.has(t.fn)) continue;
    const body = maskStrings(stripComments(t.body));
    const m = LOCK_OR_DML.exec(body);
    if (m !== null) problems.push(`deferred trigger ${t.table}.${t.trigger} runs ${t.fn}, which locks or writes (${m[0]})`);
  }
  const fks = live.deferredForeignKeys;
  for (const k of fks) if (GATE_UNIT_TABLES.has(k.table) || GATE_UNIT_TABLES.has(k.references)) problems.push(`deferred foreign key ${k.name} on ${k.table} -> ${k.references} touches a gate-taking unit's table`);
  const tables = fks.map((k) => k.table).sort();
  if (JSON.stringify(tables) !== JSON.stringify(DEFERRED_FKS)) problems.push(`the deferred foreign keys are ${JSON.stringify(fks.map((k) => `${k.table}.${k.name}`))}, not D5-11's 14`);
  return problems;
}

// --- CK3 -------------------------------------------------------------------------------------------------------------------------------

const CK3_PATHS = [
  "packages/persistence/src/audit",
  "packages/persistence/src/request-journal.ts",
  "packages/persistence/src/lease-store.ts",
  "apps/control/src/audit",
  "packages/domain/src/model/audit",
  "packages/domain/src/ports/audit-store.ts",
  "packages/domain/src/ports/audit-discovery.ts",
  "packages/domain/src/ports/lease-store.ts",
  "packages/application/src/audit",
  "packages/data-plane/src/cores",
  "packages/application/src/adapters/cores/intelligence",
];
/** The product's server code (the process clocks are exactly the four injection points). apps/web is the browser client. */
const PRODUCT_ROOTS = ["packages/application/src", "packages/authorization/src", "packages/contracts/src", "packages/data-plane/src", "packages/domain/src", "packages/persistence/src", "packages/reports/src", "apps/api/src", "apps/control/src"];
const INJECTION_POINTS = ["apps/control/src/composition.ts:controlClock", "apps/api/src/composition.ts:systemClock", "apps/api/src/identity-verifier.ts:systemClock", "packages/application/src/sources/provider-holds.ts:performance.now"];
/**
 * The product's LeaseStore claim/heartbeat/checkpoint callers, exactly: the outbox dispatchers (B08 commissions, PV1 payments, the
 * control outbox), none in the B05 paths. Their p_now is a stamp and the expiry is judged after the row lock at
 * GREATEST(p_now, kauro.effect_now()) (0054); the B05 audit units do not lease (their steps are fenced in the audit tables).
 */
const LEASE_CALLERS = [
  "apps/api/src/commissions/dispatcher.ts#claim1",
  "apps/api/src/commissions/dispatcher.ts#heartbeat1",
  "apps/api/src/commissions/dispatcher.ts#heartbeat2",
  "apps/api/src/payments/dispatcher.ts#claim1",
  "apps/api/src/payments/dispatcher.ts#heartbeat1",
  "apps/control/src/dispatcher.ts#claim1",
];
const PROCESS_CLOCK = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(|\bprocess\.hrtime\b/g;

function tsFiles(path: string, root = REPO_ROOT): string[] {
  const abs = join(root, path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return /\.ts$/.test(abs) && !/\.d\.ts$/.test(abs) ? [abs] : [];
  return readdirSync(abs).flatMap((f) => (f === "testing" || f === "node_modules" || f === "dist" ? [] : tsFiles(join(path, f), root)));
}

/** A TypeScript source with comments and string/template contents blanked (positions kept). */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => (m.startsWith("/") ? m.replace(/[^\n]/g, " ") : m[0] + m.slice(1, -1).replace(/[^\n]/g, " ") + m[m.length - 1]));
}

interface AppRow {
  readonly key: string;
  readonly at: string;
  readonly text: string;
  readonly class: "AT_COMMIT" | "MONOTONE_REFUSAL" | "ADVISORY" | "STAMP" | "UNCLASSIFIED";
  readonly reason?: string;
}
/** The app-side database clock reads and judges (D5-20 "App side"), classified by file and text. */
const APP_CLASSES: ReadonlyArray<{ file: string; text: RegExp; class: AppRow["class"]; reason: string }> = [
  { file: "apps/control/src/audit/deadlines.ts", text: /reached\(|serverNow\(/, class: "MONOTONE_REFUSAL", reason: "AUDIT_DEADLINES: an early instant delays EXPIRED (0023:486 never early)" },
  { file: "apps/control/src/audit/grants.ts", text: /reached\(|serverNow\(/, class: "MONOTONE_REFUSAL", reason: "GRANT_RECONCILIATION's instant: an early one only delays EXPIRED; a re-authorization is judged at COMMIT (L19, L19b)" },
  { file: "apps/control/src/audit/orchestration.ts", text: /claimedAt = await/, class: "AT_COMMIT", reason: "the claim's instant: its deadline binds at 0023:584 at COMMIT (audit_steps_claim_at_commit, L20)" },
  { file: "apps/control/src/audit/orchestration.ts", text: /reached\(claimedAt, audit\.absoluteDeadlineAt\)/, class: "AT_COMMIT", reason: "claim deadline: binding at 0023:584 at COMMIT (audit_steps_claim_at_commit, L20)" },
  { file: "apps/control/src/audit/orchestration.ts", text: /funding\.expiresAt/, class: "ADVISORY", reason: "the claim's funding expiry: a claim spends nothing; every spend is judged at the reservation's and the edge's COMMIT (L17, S19)" },
  { file: "apps/control/src/audit/orchestration.ts", text: /throw new StepRefused\("ABSOLUTE_DEADLINE_REACHED"\)/, class: "AT_COMMIT", reason: "record deadline: binding at 0023:598 at COMMIT (audit_steps_result_at_commit, L20)" },
  { file: "apps/control/src/audit/orchestration.ts", text: /return "CANCELL/, class: "ADVISORY", reason: "the cancellation channel: the binding judgements are at COMMIT" },
  { file: "apps/control/src/audit/orchestration.ts", text: /completedAt: \(\) => serverNowIn/, class: "STAMP", reason: "a receipt stamp, judged nowhere in the app" },
  { file: "apps/control/src/audit/plan-validation.ts", text: /serverNow/, class: "STAMP", reason: "a receipt stamp, judged nowhere in the app" },
  { file: "apps/control/src/audit/work.ts", text: /serverNow\(\)/, class: "STAMP", reason: "serverNowIn: the database clock read for a stamp" },
  { file: "packages/persistence/src/audit/store.ts", text: /serverInstantOf/, class: "STAMP", reason: "reserved_at: a record instant (the reservation's deadline gates judge at COMMIT, request_journal_commit_gate)" },
];

function appSide(root = REPO_ROOT, paths = CK3_PATHS): { problems: string[]; rows: AppRow[] } {
  const problems: string[] = [];
  const rows: AppRow[] = [];
  for (const file of paths.flatMap((p) => tsFiles(p, root))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const code = codeOf(src);
    const lines = src.split("\n");
    for (const m of code.matchAll(PROCESS_CLOCK)) problems.push(`${rel}:${code.slice(0, m.index).split("\n").length} reads a process clock (${m[0]})`);
    const counts = new Map<string, number>();
    for (const m of code.matchAll(/\bserverNow\s*\(|\bserverNowIn\s*\(|\bserverInstantOf\s*\(|(?<!function\s)\breached\s*\(/g)) {
      const lineNo = code.slice(0, m.index).split("\n").length;
      const line = lines[lineNo - 1]!.trim();
      if (/^export (async )?function /.test(line)) continue;
      const kind = m[0].replace(/\s*\($/, "");
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      const rule = APP_CLASSES.find((r) => r.file === rel && r.text.test(line));
      rows.push({ key: `${rel}#${kind}${n}`, at: `${rel}:${lineNo}`, text: line.replace(/\s+/g, " "), class: rule?.class ?? "UNCLASSIFIED", ...(rule === undefined ? {} : { reason: rule.reason }) });
    }
  }
  return { problems, rows };
}

function productClocks(root = REPO_ROOT): { points: string[]; leaseCallers: string[] } {
  const points: string[] = [];
  const leaseCallers: string[] = [];
  for (const file of PRODUCT_ROOTS.flatMap((p) => tsFiles(p, root))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const code = codeOf(src);
    const lines = src.split("\n");
    for (const m of code.matchAll(PROCESS_CLOCK)) {
      const line = lines[code.slice(0, m.index).split("\n").length - 1]!;
      const name = /\b(?:const|let)\s+(\w+)\s*(?::\s*\w+)?\s*=/.exec(line)?.[1] ?? m[0].replace(/\s*\($/, "");
      const point = `${rel}:${name}`;
      if (!points.includes(point)) points.push(point);
    }
    const seen: Record<string, number> = {};
    for (const m of code.matchAll(/\.leases\.(claim|heartbeat|checkpoint)\s*\(/g)) {
      seen[m[1]!] = (seen[m[1]!] ?? 0) + 1;
      leaseCallers.push(`${rel}#${m[1]}${seen[m[1]!]}`);
    }
  }
  return { points: points.sort(), leaseCallers: leaseCallers.sort() };
}

// --- the checked-in census ------------------------------------------------------------------------------------------------------------

interface GatesFile {
  readonly note: string;
  readonly migrations: string;
  readonly counts: Record<string, number>;
  readonly sites: ReadonlyArray<Row>;
  readonly deferredForeignKeys: ReadonlyArray<string>;
  readonly app: ReadonlyArray<AppRow>;
}

const rowId = (r: { key: string; text: string; class: string }): string => `${r.key} | ${r.text} | ${r.class}`;

function diff<T extends { key: string; text: string; class: string }>(live: ReadonlyArray<T>, listed: ReadonlyArray<T>): { unlisted: string[]; gone: string[] } {
  const a = new Set(live.map(rowId));
  const b = new Set(listed.map(rowId));
  return { unlisted: [...a].filter((x) => !b.has(x)), gone: [...b].filter((x) => !a.has(x)) };
}

async function atCommitProblems(c: Client, rows: ReadonlyArray<Row>): Promise<string[]> {
  const problems: string[] = [];
  for (const r of rows.filter((x) => x.class === "AT_COMMIT")) {
    const t = await c.query<{ deferrable: boolean; src: string }>(
      `SELECT g.tgdeferrable AS deferrable, p.prosrc AS src FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace s ON s.oid = r.relnamespace JOIN pg_proc p ON p.oid = g.tgfoid
        WHERE s.nspname = 'kauro' AND r.relname = $1 AND g.tgname = $2`,
      [r.table, r.trigger],
    );
    const fn = t.rows[0];
    if (fn === undefined || !fn.deferrable) problems.push(`${r.key} (${r.at}): its deferred trigger ${r.table}.${r.trigger} does not exist`);
    else if (!/kauro\.effect_now\(\)/.test(fn.src) || !new RegExp(`\\b${r.column}\\b`).test(fn.src)) problems.push(`${r.key} (${r.at}): ${r.trigger}'s function does not judge ${r.column} against kauro.effect_now()`);
  }
  return problems;
}

async function liveRows(c: Client): Promise<{ live: Census; rows: Row[] }> {
  const live = await census(c, MIGRATIONS_DIR);
  return { live, rows: await classify(c, live) };
}

/** The census on a transaction of the oracle that plants `plant` first and rolls everything back. */
async function plantedRows(plant: string): Promise<{ live: Census; rows: Row[] }> {
  await h.oracle.query("BEGIN");
  try {
    await h.oracle.query(plant);
    return await liveRows(h.oracle);
  } finally {
    await h.oracle.query("ROLLBACK");
  }
}

function listed(): GatesFile {
  return JSON.parse(readFileSync(GATES_FILE, "utf8")) as GatesFile;
}

// --- tests -------------------------------------------------------------------------------------------------------------------------------

test("CK1 (CK) DENY clock drift (census by source): in the live kauro schema (function bodies, RLS policies, CHECK constraints, views, trigger WHEN clauses, column defaults) and in every migration file, every clock primitive (now(), current_timestamp, current_time, current_date, localtimestamp, localtime, transaction_timestamp(), statement_timestamp(), clock_timestamp(), timeofday(), one-argument age(), the other pg_proc clock functions and the 'now'/'today' literals) outside the bodies of kauro.server_now() and kauro.effect_now(), every column stamped with an instant, every comparison whose operand is a clock call, a clock-tainted variable, a timestamptz parameter or a typed temporal column, and every dynamic EXECUTE is listed in persistence/clock-gates.json by object and ordinal with file:line and its class (AT_COMMIT with its deferred trigger, MONOTONE_REFUSAL, SHAPE, PARAM with its callers, OUTSIDE_B05 with its owner, DYNAMIC, MIGRATION_DML); an unlisted site and a listed site that no longer exists both fail, and 0029:938, a planted now() and a planted deferred trigger comparing NEW.reserved_at with interpretation_deadline_at are each reported", async () => {
  const { live, rows } = await liveRows(h.oracle);
  const app = appSide();
  if (WRITE) {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[`${r.kind}:${r.class}`] = (counts[`${r.kind}:${r.class}`] ?? 0) + 1;
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const out: GatesFile = {
      note: "Generated by persistence/test/b05-clock-gates.test.ts with KAURO_CLOCK_GATES=write (B05 D5-20 CK1-CK3); regenerate at every rebase, never hand-merge.",
      migrations: `${files[0]} .. ${files[files.length - 1]}`,
      counts,
      sites: rows,
      deferredForeignKeys: live.deferredForeignKeys.map((k) => `${k.table}.${k.name} -> ${k.references}`),
      app: app.rows,
    };
    writeFileSync(GATES_FILE, JSON.stringify(out, null, 1) + "\n");
  }
  const file = listed();
  // every site classified, and the AT_COMMIT rows' deferred judges exist and read their column against effect_now()
  assert.deepEqual(rows.filter((r) => r.class === "UNCLASSIFIED").map((r) => `${r.key} ${r.at} ${r.text}`), [], "every B05 site is classified");
  assert.deepEqual(await atCommitProblems(h.oracle, rows), []);
  assert.equal(rows.filter((r) => r.class === "AT_COMMIT").length >= AT_COMMIT.length, true, "every AT_COMMIT gate of D5-20 is a live judge");
  for (const g of AT_COMMIT) assert.ok(rows.some((r) => r.class === "AT_COMMIT" && `${r.objectKind}:${r.object}` === g.object && g.text.test(r.text)), `${g.site} is censused`);
  for (const g of MONOTONE) assert.ok(rows.some((r) => r.class === "MONOTONE_REFUSAL" && `${r.objectKind}:${r.object}` === g.object && g.text.test(r.text)), `${g.reason} is censused`);
  // the checked-in census equals the live one, both directions
  assert.deepEqual(diff(rows, file.sites), { unlisted: [], gone: [] }, "clock-gates.json lists every site, and no site that no longer exists (KAURO_CLOCK_GATES=write regenerates it)");
  // 0029:938 (a step-up proof judged fresh at an early changed_at) is reported, routed to B10
  const r938 = file.sites.find((r) => r.at === "0029:938" && r.kind === "J");
  assert.ok(r938 !== undefined && r938.class === "OUTSIDE_B05" && r938.owner === "B10", `0029:938 is listed OUTSIDE_B05 for B10 (${JSON.stringify(r938)})`);
  // a planted now() is reported unlisted
  const nowPlant = await plantedRows("CREATE FUNCTION kauro.ck1_planted_now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() $$");
  assert.deepEqual(diff(nowPlant.rows, file.sites).unlisted.filter((x) => x.includes("ck1_planted_now")), ["function:ck1_planted_now#P1 | now() | OUTSIDE_B05"]);
  // a planted deferred trigger comparing NEW.reserved_at with interpretation_deadline_at is reported unlisted
  const gatePlant = await plantedRows(`
    CREATE FUNCTION kauro.ck1_planted_gate() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
    DECLARE m record;
    BEGIN
      SELECT t.interpretation_deadline_at INTO m FROM kauro.model_tasks t WHERE t.model_task_id = NEW.model_task_id;
      IF NEW.reserved_at > m.interpretation_deadline_at THEN RAISE EXCEPTION 'late' USING ERRCODE = 'KA081'; END IF;
      RETURN NULL;
    END $f$;
    CREATE CONSTRAINT TRIGGER ck1_planted_gate AFTER INSERT ON kauro.request_journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.ck1_planted_gate();`);
  const plantedJudges = diff(gatePlant.rows, file.sites).unlisted.filter((x) => x.includes("ck1_planted_gate"));
  assert.ok(plantedJudges.some((x) => /#J\d+ \| NEW\.reserved_at > m\.interpretation_deadline_at/.test(x)), `the planted deferred judge is reported (${JSON.stringify(plantedJudges)})`);
  // a listed site that no longer exists is reported (the commit-time grant judge dropped)
  const dropped = await plantedRows("DROP FUNCTION kauro.cost_grants_authority_at_commit() CASCADE");
  const gone = diff(dropped.rows, file.sites).gone;
  assert.ok(gone.some((x) => x.startsWith("function:cost_grants_authority_at_commit#J")), `the vanished site is reported (${gone.length} gone)`);
  // the app-side database clock reads and judges equal the checked-in list with their class
  assert.deepEqual(app.rows.filter((r) => r.class === "UNCLASSIFIED"), [], "every app-side clock read or judge is classified");
  assert.deepEqual(diff(app.rows, file.app), { unlisted: [], gone: [] }, "clock-gates.json app equals the app-side reads and judges");
});

test("CK2 (CK) DENY commit-time locks (census): in the live schema no deferred constraint trigger function other than request_journal_commit_gate and dispatch_liabilities_commit_gate contains FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE or DML, the deferred foreign keys are exactly the 14 of D5-11 and none is on or references model_tasks, leases, request_journal, cost_grants, dispatch_liabilities, pool_liability_gates or domain_events; a planted locking deferred trigger or deferred FK on one of them fails", async () => {
  const { live } = await liveRows(h.oracle);
  assert.deepEqual(commitTimeLocks(live), []);
  assert.ok(live.deferredTriggers.some((t) => t.fn === "request_journal_commit_gate") && live.deferredTriggers.some((t) => t.fn === "dispatch_liabilities_commit_gate"), "the two gates are deferred");
  assert.ok(live.deferredTriggers.filter((t) => !GATE_FUNCTIONS.has(t.fn)).length >= 7, "0066's deferred judges are censused");
  assert.deepEqual(listed().deferredForeignKeys, live.deferredForeignKeys.map((k) => `${k.table}.${k.name} -> ${k.references}`));
  const lockPlant = await plantedRows(`
    CREATE FUNCTION kauro.ck2_planted_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
    BEGIN PERFORM 1 FROM kauro.cost_grants WHERE grant_id = NEW.cost_grant_id FOR UPDATE; RETURN NULL; END $f$;
    CREATE CONSTRAINT TRIGGER ck2_planted_lock AFTER INSERT ON kauro.request_journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.ck2_planted_lock();`);
  assert.deepEqual(commitTimeLocks(lockPlant.live), ["deferred trigger request_journal.ck2_planted_lock runs ck2_planted_lock, which locks or writes (FOR UPDATE)"]);
  const fkPlant = await plantedRows("ALTER TABLE kauro.model_tasks ADD CONSTRAINT ck2_planted_fk FOREIGN KEY (agency_id) REFERENCES kauro.agencies (agency_id) DEFERRABLE INITIALLY DEFERRED");
  const fkProblems = commitTimeLocks(fkPlant.live);
  assert.ok(fkProblems.some((p) => p.startsWith("deferred foreign key ck2_planted_fk on model_tasks")), JSON.stringify(fkProblems));
  assert.ok(fkProblems.some((p) => p.includes("not D5-11's 14")), "the count changed");
});

test("CK3 (CK) DENY process clock (census): in persistence src/audit/**, src/request-journal.ts, src/lease-store.ts, apps/control/src/audit/**, domain src/model/audit/** and ports, application src/audit/**, data-plane src/cores/** and application src/adapters/cores/intelligence/** there is no Date.now(, zero-argument new Date(, performance.now( or process.hrtime( and no comparison of a database instant with a process clock; the database clock reads from the app (serverNow, serverInstantOf) and the app-side judges (reached) equal the checked-in list with their class, LeaseStore claim/heartbeat/checkpoint have no caller in those paths and their product callers are exactly the checked-in outbox dispatchers, whose expiry claim_lease/heartbeat_lease/checkpoint_lease judge after the row lock at GREATEST(p_now, effect_now()) (0054) in their latest definition, claim_lease's deadline judged at that same instant after the lock and never at p_now (0067), and the process clocks of the product are exactly the four injection points (apps/control composition.ts:70, apps/api composition.ts:48, apps/api identity-verifier.ts:60, application sources/provider-holds.ts:28); a planted Date.now() in apps/control/src/audit fails", () => {
  const app = appSide();
  assert.deepEqual(app.problems, [], "no process clock in the B05/B08 paths");
  for (const p of CK3_PATHS) assert.ok(tsFiles(p).length > 0, `${p} is scanned`);
  assert.deepEqual(diff(app.rows, listed().app), { unlisted: [], gone: [] });
  const product = productClocks();
  assert.deepEqual(product.points, [...INJECTION_POINTS].sort(), "the product's process clocks are its four injection points");
  assert.deepEqual(product.leaseCallers, [...LEASE_CALLERS].sort(), "the LeaseStore claim/heartbeat/checkpoint callers are the checked-in outbox dispatchers");
  for (const caller of product.leaseCallers) assert.ok(!CK3_PATHS.some((p) => caller.startsWith(p)), `${caller} is not in a B05 path`);
  // their expiry is judged after the row lock at the database clock (0054) in the definition that is in force, the latest migration
  // defining the function: the param is never the judge alone. claim_lease's deadline is judged at that instant too (0067)
  const latestBody = (fn: string): { file: string; body: string } => {
    const defining = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: f, sql: stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8")) }))
      .filter((m) => m.sql.includes(`FUNCTION kauro.${fn}(`));
    const last = defining[defining.length - 1];
    assert.ok(last !== undefined, `${fn} is defined by a migration`);
    return { file: last.file, body: last.sql.slice(last.sql.indexOf(`FUNCTION kauro.${fn}(`)).split("$$;")[0]! };
  };
  for (const fn of ["claim_lease", "heartbeat_lease", "checkpoint_lease"]) {
    const { file, body } = latestBody(fn);
    const lock = body.indexOf("FOR UPDATE");
    const judge = body.indexOf("GREATEST(p_now, kauro.effect_now())");
    assert.ok(lock > 0 && judge > lock, `${fn} (${file}) judges the expiry at GREATEST(p_now, effect_now()) after its row lock`);
  }
  const claim = latestBody("claim_lease");
  const judgedAt = claim.body.indexOf("judged := GREATEST(p_now, kauro.effect_now())");
  const deadlineJudge = claim.body.indexOf("judged >= p_deadline");
  assert.ok(judgedAt > claim.body.indexOf("FOR UPDATE") && deadlineJudge > judgedAt, `claim_lease (${claim.file}) judges its deadline at the judged instant after the row lock`);
  assert.ok(!/p_now\s*>=?\s*p_deadline|p_deadline\s*<=?\s*p_now/.test(claim.body), `claim_lease (${claim.file}) never judges its deadline at the caller's p_now`);
  // a planted Date.now() in apps/control/src/audit fails (the scan run on a copy of that file with the plant)
  const target = join(REPO_ROOT, "apps/control/src/audit/grants.ts");
  const planted = readFileSync(target, "utf8") + "\nexport const plantedNow = (): number => Date.now();\n";
  const scratch = mkdtempSync(join(tmpdir(), "kauro-ck3-"));
  try {
    mkdirSync(join(scratch, "apps/control/src/audit"), { recursive: true });
    writeFileSync(join(scratch, "apps/control/src/audit/grants.ts"), planted);
    const scanned = appSide(scratch, ["apps/control/src/audit"]);
    assert.equal(scanned.problems.length, 1, JSON.stringify(scanned.problems));
    assert.match(scanned.problems[0]!, /^apps\/control\/src\/audit\/grants\.ts:\d+ reads a process clock \(Date\.now\(\)$/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

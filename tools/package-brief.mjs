// Prints the build brief of one program package straight from the vendored authority registry: the package definition, its gates
// with their evidence rule, every case with its expected outcome, the commands under its gates, the screens that belong to its
// surfaces and the manuals it cites. Usage: node tools/package-brief.mjs B06 [--json]. The brief is the input of an implementation
// wave; it never replaces reading the manuals.
//
// The gates of a brief are the union of the gates of the package's cases, and its commands are every command one of whose triad
// cases (CMDnnn-OK, -DENY, -RACE) is in the package's caseIds. `pkg.gates` alone is not that set: a package can own cases of a gate
// it does not list (B16 owns G-TENANT's CMD003-CMD007 and CMD038; B11 owns CMD044 of G-UX), and filtering by it dropped them
// from the brief (tools/test/package-brief.test.mjs checks the 22 packages).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reg = (f) => JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", f), "utf8"));
const list = (v) => (Array.isArray(v) ? v : Object.values(v).find(Array.isArray) ?? []);

const program = list(reg("program.json").packages ?? reg("program.json"));
const cases = new Map(list(reg("cases.json")).map((c) => [c.id, c]));
for (const c of list(reg("additional_scenarios.json"))) {
  const id = c.id ?? c.scenarioId ?? c.caseId;
  if (id && !cases.has(id)) cases.set(id, c);
}
const allGates = list(reg("gates.json"));
const allCommands = list(reg("commands.json"));
const contracts = list(reg("contracts.json"));
const machines = list(reg("state_transitions.json"));
const screens = list(reg("screens.json"));

// Amendment A5 (authority/r2/amendments/A5_CMD024_SPLIT.md, 2026-10-01): the platform commands of the two core libraries are
// split. The core package owns the semantic half; B08 owns the transactional half. The registry stays byte-identical until the
// next re-issue, so the brief carries the split here.
const A5 = { B01: ["CMD024"], B03: ["CMD020", "CMD021", "CMD022"] };
const a5Note = (id) => {
  const cmd = id.split("-")[0];
  const core = Object.keys(A5).find((k) => A5[k].includes(cmd));
  if (!core || !/^CMD0\d\d-(OK|DENY|RACE)$/.test(id)) return "";
  return pkgId === core
    ? `
    amendment A5: this package owns the core half only (deterministic behaviour through the public API of the clean installed package); the transactional half (tenant and role, aggregate version, idempotency, crash at the intent/commit boundary, the record persisted once in PostgreSQL) belongs to B08. Closure required here: core half tested, row PARTIAL naming B08.`
    : pkgId === "B08"
      ? `
    amendment A5: B08 owns the transactional half of this case; the core half belongs to ${core}.`
      : "";
};

/** The brief of one package; null when the package is not in registry/program.json. */
export function buildBrief(pkgId) {
  const pkg = program.find((p) => p.id === pkgId);
  if (!pkg) return null;
  const caseIds = pkg.caseIds ?? [];
  const gateIds = new Set(caseIds.map((id) => cases.get(id)?.gate).filter(Boolean));
  const triads = new Set(caseIds.map((id) => /^(CMD\d{3})-(OK|DENY|RACE)$/.exec(id)?.[1]).filter(Boolean));
  return {
    package: pkg,
    gates: allGates.filter((g) => gateIds.has(g.id)).map((g) => ({ id: g.id, owner: g.owner, evidenceRule: g.evidenceRule, cases: g.caseIds })),
    cases: caseIds.map((id) => cases.get(id) ?? { id, missing: true }),
    commands: allCommands.filter((c) => triads.has(c.id)),
    contracts: contracts.filter((c) => (pkg.docs ?? []).includes(c.owner)).map((c) => c.name),
    stateMachines: machines.map((m) => m.contract),
    screens: screens.filter((s) => (pkg.docs ?? []).some((d) => String(s.owner ?? "").includes(d))).map((s) => s.id),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const [pkgId, flag] = isMain ? process.argv.slice(2) : [];
if (isMain && !pkgId) {
  console.error("usage: node tools/package-brief.mjs <B00..B21> [--json]");
  process.exit(2);
}
const brief = isMain ? buildBrief(pkgId) : null;
if (isMain && !brief) {
  console.error(`package ${pkgId} not found in registry/program.json`);
  process.exit(2);
}
const pkg = brief?.package;
const commands = brief?.commands ?? [];

if (!isMain) {
  // imported: buildBrief only
} else if (flag === "--json") {
  console.log(JSON.stringify(brief, null, 1));
} else {
  console.log(`# ${pkg.id} — ${pkg.title}\n`);
  console.log(`depends on: ${(pkg.dependsOn ?? []).join(", ") || "-"} · gates: ${brief.gates.map((g) => g.id).join(", ")} · manuals: ${(pkg.docs ?? []).join(", ")}`);
  console.log(`\nscope: ${pkg.scope}\nwork: ${pkg.work}\nowner action: ${pkg.ownerAction}\n`);
  for (const g of brief.gates) console.log(`gate ${g.id} (manual ${g.owner}) — evidence rule: ${g.evidenceRule}`);
  console.log(`\n## Cases (${brief.cases.length})`);
  for (const c of brief.cases) {
    if (c.missing) { console.log(`- ${c.id}: MISSING in the registry`); continue; }
    console.log(`- ${c.id} [${c.gate ?? ""}] ${c.title ?? c.scenario ?? ""}\n    expected: ${c.expected ?? ""}\n    verification: ${c.verification ?? ""}${a5Note(c.id)}`);
  }
  console.log(`\n## Commands (${commands.length})`);
  for (const c of commands) console.log(`- ${c.id} ${c.name} ${c.method} ${c.path} role=${c.role} idempotency=${c.idempotency}\n    precondition: ${c.precondition}\n    effect: ${c.effect}\n    failure: ${c.failure}${c.stateCheck ? `\n    stateCheck: ${c.stateCheck}` : ""}`);
  console.log(`\n## Contracts owned by the cited manuals: ${brief.contracts.join(", ")}`);
}

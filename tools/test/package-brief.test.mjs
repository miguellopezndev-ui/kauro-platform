// The package brief Codex receives (tools/package-brief.mjs): its gates are the union of the gates of the package's cases and
// its commands every command one of whose triad cases is in the package's caseIds — for each of the 22 packages of the program.
// The earlier brief filtered both by `pkg.gates`, so B16 lost G-TENANT with CMD003-CMD007 and CMD038 and B11 lost CMD044.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildBrief } from "../package-brief.mjs";

const root = join(import.meta.dirname, "..", "..");
const registry = (name) => {
  const value = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", name), "utf8"));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};
const program = registry("program.json");
const cases = new Map(registry("cases.json").map((c) => [c.id, c]));
const commandIds = new Set(registry("commands.json").map((c) => c.id));

test("every one of the 22 packages: the brief's gates are exactly the gates of its cases and its commands exactly the commands of its triad cases, each case present with its registry record", () => {
  assert.equal(program.length, 22);
  for (const pkg of program) {
    const brief = buildBrief(pkg.id);
    const gates = new Set(pkg.caseIds.map((id) => cases.get(id).gate));
    assert.deepEqual(brief.gates.map((g) => g.id).sort(), [...gates].sort(), `${pkg.id}: gates`);
    const triads = new Set(pkg.caseIds.flatMap((id) => /^(CMD\d{3})-(OK|DENY|RACE)$/.exec(id)?.[1] ?? []));
    for (const cmd of triads) assert.ok(commandIds.has(cmd), `${pkg.id}: ${cmd} is a registry command`);
    assert.deepEqual(brief.commands.map((c) => c.id).sort(), [...triads].sort(), `${pkg.id}: commands`);
    assert.deepEqual(brief.cases.map((c) => c.id), pkg.caseIds, `${pkg.id}: cases`);
    assert.ok(brief.cases.every((c) => !c.missing), `${pkg.id}: every case in the registry`);
  }
});

test("the packages whose cases fall outside pkg.gates: B16 carries G-TENANT with CMD003-CMD007 and CMD038, B11 carries CMD044, and the CLI prints the same brief", () => {
  const b16 = buildBrief("B16");
  assert.ok(!program.find((p) => p.id === "B16").gates.includes("G-TENANT"), "the registry's B16 gates do not list G-TENANT");
  assert.ok(b16.gates.some((g) => g.id === "G-TENANT"));
  for (const cmd of ["CMD003", "CMD004", "CMD005", "CMD006", "CMD007", "CMD038"]) assert.ok(b16.commands.some((c) => c.id === cmd), `B16 brief lists ${cmd}`);
  assert.ok(buildBrief("B11").commands.some((c) => c.id === "CMD044"), "B11 brief lists CMD044");
  const cli = JSON.parse(execFileSync(process.execPath, [join(root, "tools", "package-brief.mjs"), "B16", "--json"], { encoding: "utf8" }));
  assert.deepEqual(cli.commands.map((c) => c.id), b16.commands.map((c) => c.id));
  assert.deepEqual(cli.gates.map((g) => g.id), b16.gates.map((g) => g.id));
  assert.equal(buildBrief("B99"), null);
});

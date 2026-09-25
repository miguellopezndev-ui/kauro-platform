// The durable evidence bundle of a candidate commit (re-check finding N14; prompts/B06 "Deliverables": "complete gate dossier,
// fixture/truth and command manifests, actual result inventory ... The reviewer must be able to decide closure from durable
// artifacts rather than narrative confidence"; registry requiredEvidence of every case: exact_subject_and_environment,
// input_manifest, presealed_expected_truth, actual_public_result, exit_status, artifact_digests; CMD011 verification "A failed
// harness or changed binary cannot borrow a previous green result"; 21 "Evidence classes").
//
//   node tools/evidence.mjs run [--out <dir>]
//
// Refuses a working tree that differs from HEAD (the bundle names exactly one commit and tree). Then, in this order:
//   1. seals the expected truth before anything runs: every case row of docs/design/B06-case-map.md — its status, the tests it
//      cites and what a sealed check observes — with the SHA-256 of the file and of the canonical rows (truth.json);
//   2. records the subject and the environment: commit and tree, node, pnpm and PostgreSQL versions, the operating system, the
//      start time (environment.json), and the input manifest: the lockfile, every migration, every registry file, the OpenAPI
//      document, the matrix and the case map, each by SHA-256 (inputs.json);
//   3. builds the workspace and runs every test suite exactly as its package runs it, each with a JUnit report (junit/*.xml),
//      recording each command, its exit status and its start and end (results.json);
//   4. maps every cited test of every case to its result by file and name (cases.json): PASSED, FAILED, SKIPPED or MISSING;
//   5. writes MANIFEST.sha256 over every file of the bundle.
// Exit 0 only when the build and every suite exit 0 and every cited test of every case PASSED. The bundle is committed after the
// candidate commit it names (docs/evidence/b06/README.md), per platform.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, type } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CASE_MAP_PATH = join(root, "docs", "design", "B06-case-map.md");

/** The suites of `pnpm run test`, each exactly as its package's test script runs it (the check refuses a drifted script). */
export const SUITES = [
  { name: "contracts", cwd: "packages/contracts", script: 'node --test --test-reporter=spec "dist/test/**/*.test.js"', args: ["dist/test/**/*.test.js"] },
  { name: "domain", cwd: "packages/domain", script: 'node --test --test-reporter=spec "dist/test/**/*.test.js"', args: ["dist/test/**/*.test.js"] },
  { name: "application", cwd: "packages/application", script: 'node --test --test-reporter=spec "dist/test/**/*.test.js"', args: ["dist/test/**/*.test.js"] },
  { name: "persistence", cwd: "packages/persistence", script: 'node --test --test-reporter=spec --test-concurrency=2 "dist/test/**/*.test.js"', args: ["--test-concurrency=2", "dist/test/**/*.test.js"] },
  { name: "authorization", cwd: "packages/authorization", script: 'node --test --test-reporter=spec "dist/test/**/*.test.js"', args: ["dist/test/**/*.test.js"] },
  { name: "api", cwd: "apps/api", script: 'node --test --test-reporter=spec --test-concurrency=3 "dist/test/**/*.test.js"', args: ["--test-concurrency=3", "dist/test/**/*.test.js"] },
  { name: "tools", cwd: ".", script: null, args: ["tools/test/**/*.test.mjs"] },
];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Canonical JSON (sorted keys) for the digests of structured content. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

// --- the presealed truth: the case map -------------------------------------------------------------------------------------------

/** Splits a markdown table row into its cells (a `|` inside backticks or an escaped `\|` does not split). */
function cellsOf(line) {
  const cells = [];
  let current = "";
  let code = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      current += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      current += c;
    } else if (c === "|" && !code) {
      cells.push(current.trim());
      current = "";
    } else current += c;
  }
  cells.push(current.trim());
  return cells.slice(1, -1);
}

/**
 * The cited tests of a cell: a backticked test file sets the file, and every `:: "title"` that follows cites a test of it; a
 * cell that cites a title before any file continues the file of the previous row (the case map's convention).
 */
export function citationsOf(cell, carriedFile) {
  const out = [];
  let file = carriedFile;
  const token = /`([^`]+\.test\.(?:ts|mjs))`|::\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of cell.matchAll(token)) {
    if (m[1] !== undefined) file = m[1];
    else {
      if (file === null) throw new Error(`a title is cited before any test file: ${m[2].slice(0, 80)}`);
      out.push({ file, title: JSON.parse(`"${m[2]}"`) });
    }
  }
  return { citations: out, file };
}

/** Every case row of the case map: id, registry expectation, cited tests, status, what a sealed check observes. */
export function readCaseMap(text) {
  const rows = [];
  let carried = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| ")) continue;
    const cells = cellsOf(line);
    if (cells.length !== 5 || !/^(S\d{3}|R2-\d{3}|CMD\d{3}-(OK|DENY|RACE))$/.test(cells[0])) continue;
    const { citations, file } = citationsOf(cells[2], carried);
    carried = file;
    rows.push({ caseId: cells[0], expected: cells[1], citations, status: cells[3], observes: cells[4] });
  }
  return rows;
}

// --- JUnit ---------------------------------------------------------------------------------------------------------------------------

function xmlText(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
}

/**
 * The top-level test cases of a node:test JUnit report: name, file, outcome. Node escapes a name's quotes before XML-escaping
 * it, so a name is unescaped twice for `&quot;` (the reporter's own double escape).
 */
export function readJunit(xml) {
  const cases = [];
  // attribute values are double-quoted and may contain a raw ">" (the reporter escapes "<" and "&" only), so the start tag is
  // read attribute by attribute
  const re = /<testcase((?:\s+\w+="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = xmlText(a[2]);
    const body = m[3] ?? "";
    const outcome = /<failure\b/.test(body) || attrs["failure"] !== undefined ? "FAILED" : /<skipped\b/.test(body) ? "SKIPPED" : "PASSED";
    cases.push({ name: attrs["name"].replace(/&quot;/g, '"'), file: attrs["file"] ?? null, time: Number(attrs["time"] ?? "0"), outcome });
  }
  return cases;
}

/** The source test file a compiled test file was built from (`<pkg>/dist/test/x.test.js` → `<pkg>/test/x.test.ts`). */
export function sourceOf(compiledAbsolute) {
  const rel = relative(root, compiledAbsolute).split(sep).join("/");
  return rel.replace(/\/dist\/test\/(.+)\.test\.js$/, "/test/$1.test.ts");
}

/** Each cited test of each case, with its result (PASSED, FAILED, SKIPPED or MISSING). */
export function caseResults(rows, results) {
  const byKey = new Map();
  for (const r of results) {
    const key = `${r.source} ${r.name}`;
    if (byKey.has(key)) throw new Error(`two tests of one file share a name: ${key}`);
    byKey.set(key, r);
  }
  return rows.map((row) => {
    const tests = row.citations.map((c) => ({ file: c.file, title: c.title, outcome: byKey.get(`${c.file} ${c.title}`)?.outcome ?? "MISSING" }));
    return { caseId: row.caseId, status: row.status, tests, allPassed: tests.length > 0 && tests.every((t) => t.outcome === "PASSED") };
  });
}

// --- the run ---------------------------------------------------------------------------------------------------------------------------

function run(command, args, options = {}) {
  const started = new Date().toISOString();
  const r = spawnSync(command, args, { cwd: options.cwd ?? root, encoding: "utf8", shell: options.shell ?? false, maxBuffer: 256 * 1024 * 1024, env: process.env });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, started, ended: new Date().toISOString() };
}

function git(...args) {
  const r = run("git", args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function postgresVersion() {
  const bin = process.env["PGBIN"] ?? (platform() === "win32" ? "C:\\Tools\\pgsql17\\bin" : "/usr/lib/postgresql/17/bin");
  const exe = join(bin, platform() === "win32" ? "postgres.exe" : "postgres");
  if (!existsSync(exe)) throw new Error(`PostgreSQL binaries not found at ${bin} (set PGBIN)`);
  const r = run(exe, ["--version"]);
  if (r.status !== 0) throw new Error(`postgres --version failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== "run") {
    process.stderr.write("usage: node tools/evidence.mjs run [--out <dir>]\n");
    process.exitCode = 2;
    return;
  }
  const dirty = git("status", "--porcelain");
  if (dirty !== "") {
    process.stderr.write(`evidence: the working tree differs from HEAD; commit first so the bundle names exactly what was tested:\n${dirty}\n`);
    process.exitCode = 2;
    return;
  }
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const platformName = platform() === "win32" ? "windows" : platform();
  const outIndex = rest.indexOf("--out");
  const out = outIndex >= 0 && rest[outIndex + 1] ? resolve(rest[outIndex + 1]) : join(root, "docs", "evidence", "b06", `${commit.slice(0, 12)}-${platformName}`);
  if (existsSync(out)) throw new Error(`${out} exists: a bundle is written once`);
  mkdirSync(join(out, "junit"), { recursive: true });
  const write = (name, value) => writeFileSync(join(out, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");

  // 1. the expected truth, sealed before anything runs
  const caseMapText = readFileSync(CASE_MAP_PATH, "utf8");
  const rows = readCaseMap(caseMapText);
  const truth = {
    caseMap: "docs/design/B06-case-map.md",
    caseMapSha256: sha256(caseMapText),
    rowsSha256: sha256(canonical(rows)),
    observesSha256: sha256(canonical(rows.map((r) => [r.caseId, r.observes]))),
    cases: rows.length,
    rows,
  };
  write("truth.json", truth);
  const sealedAt = new Date().toISOString();

  // 2. subject, environment, inputs
  const pnpm = run(platform() === "win32" ? "pnpm.cmd" : "pnpm", ["--version"], { shell: platform() === "win32" });
  if (pnpm.status !== 0) throw new Error(`pnpm --version failed: ${pnpm.stderr}`);
  write("environment.json", {
    subject: { commit, tree, branch: git("rev-parse", "--abbrev-ref", "HEAD") },
    node: process.version,
    pnpm: pnpm.stdout.trim(),
    postgres: postgresVersion(),
    os: { platform: platform(), type: type(), release: release(), arch: arch(), cpus: cpus().length },
    truthSealedAt: sealedAt,
    truthSha256: sha256(readFileSync(join(out, "truth.json"))),
  });
  const inputs = ["pnpm-lock.yaml", "apps/api/openapi.json", "docs/design/B06-state-command-event-matrix.md", "docs/design/B06-case-map.md"];
  for (const dir of ["packages/persistence/migrations", "packages/contracts/registry"]) {
    for (const f of readdirSync(join(root, dir)).sort()) inputs.push(`${dir}/${f}`);
  }
  write("inputs.json", Object.fromEntries(inputs.map((p) => [p, sha256(readFileSync(join(root, p)))])));

  // 3. build and every suite
  const suites = [];
  const build = run(platform() === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build"], { shell: platform() === "win32" });
  suites.push({ name: "build", command: "pnpm run build", exitCode: build.status, started: build.started, ended: build.ended });
  const results = [];
  for (const suite of SUITES) {
    if (suite.script !== null) {
      const pkg = JSON.parse(readFileSync(join(root, suite.cwd, "package.json"), "utf8"));
      if (pkg.scripts?.test !== suite.script) throw new Error(`${suite.cwd}: its test script is not the one this tool runs (${pkg.scripts?.test})`);
    }
    const junit = join(out, "junit", `${suite.name}.xml`);
    const args = ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=junit", `--test-reporter-destination=${junit}`, ...suite.args];
    const r = build.status === 0 ? run(process.execPath, args, { cwd: join(root, suite.cwd) }) : { status: null, stdout: "", stderr: "not run: the build failed", started: build.ended, ended: build.ended };
    const cases = existsSync(junit) ? readJunit(readFileSync(junit, "utf8")) : [];
    for (const c of cases) results.push({ suite: suite.name, source: c.file === null ? null : sourceOf(c.file), name: c.name, outcome: c.outcome });
    const count = (o) => cases.filter((c) => c.outcome === o).length;
    suites.push({ name: suite.name, command: `node ${args.map((a) => (a.includes(" ") || a.includes("*") ? JSON.stringify(a) : a)).join(" ").replace(junit, `junit/${suite.name}.xml`)}`, cwd: suite.cwd, exitCode: r.status, started: r.started, ended: r.ended, tests: cases.length, passed: count("PASSED"), failed: count("FAILED"), skipped: count("SKIPPED") });
  }

  // 4. every cited test of every case
  const cases = caseResults(rows, results);
  write("results.json", { subject: { commit, tree }, suites, tests: results.length });
  write("cases.json", { subject: { commit, tree }, cases });

  // 5. the digests of the bundle
  const manifest = filesUnder(out)
    .map((p) => relative(out, p).split(sep).join("/"))
    .filter((p) => p !== "MANIFEST.sha256")
    .sort()
    .map((p) => `${sha256(readFileSync(join(out, p)))}  ${p}`);
  write("MANIFEST.sha256", manifest.join("\n") + "\n");

  const failedSuites = suites.filter((s) => s.exitCode !== 0);
  const unproven = cases.filter((c) => !c.allPassed);
  process.stdout.write(`evidence: ${relative(root, out)} for ${commit.slice(0, 12)} (${results.length} tests; ${suites.length - failedSuites.length}/${suites.length} steps exit 0; ${cases.length - unproven.length}/${cases.length} cases with every cited test PASSED)\n`);
  for (const s of failedSuites) process.stderr.write(`evidence: ${s.name} exited ${String(s.exitCode)}\n`);
  for (const c of unproven) process.stderr.write(`evidence: ${c.caseId}: ${c.tests.filter((t) => t.outcome !== "PASSED").map((t) => `${t.outcome} ${t.file} :: ${t.title.slice(0, 80)}`).join("; ") || "no cited test"}\n`);
  if (failedSuites.length > 0 || unproven.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

// The acceptance ledger of amendment A4: every registry case of the 22 packages with the strongest evidence class demonstrated for
// it (reviewed: a review id and its commit), every package's status computed from registry/program.json dependencies, a record per
// gate and the table of docs/acceptance/README.md. It reads only committed inputs:
//
//   - the sidecars docs/acceptance/case-maps/<package>.json — one row per case, schema {case, class, test ["file :: title"],
//     commit, reviewId, inheritedTo}, converted mechanically from the platform case maps docs/design/<package>-case-map.md
//     (`node tools/ledger.mjs sidecars --write`; the .md files are never rewritten) or, for a package without a case map yet,
//     derived from the registry (class NOT_EXECUTED; B20/B21 PLANNED_POST_B19 with the owner's date);
//   - the case maps of the two core libraries (MC: B01, B02; IC: B03, B04), each pinned to a repository path and commit in
//     docs/acceptance/ledger/inputs.json and read through a snapshot docs/acceptance/ledger/external/<id>-<commit>.json made from
//     `git show <commit>:<path>` of a local checkout (`--mc <file>@<sha>` / `--ic <file>@<sha>`; a given checkout is re-converted
//     and must equal the snapshot);
//   - the reviewer's answers docs/acceptance/reviews/<package>-round<n>-<commit>.json.
//
// It fails (exit 1) when a case is missing, a cross citation has no inherited mark, a PARTIAL or SIMULATED row names nobody who
// carries the rest, a row claims a review that does not accept it
// or a README row claims acceptance without one, a case is PLANNED outside B20/B21 (whose only class is PLANNED_POST_B19 with the
// owner's date), or the vendored registry no longer matches PROVENANCE.json. A claim is never acceptance: a row's class counts as
// demonstrated only through its accepting review. Usage:
//
//   node tools/ledger.mjs [--json] [--mc <file>@<sha>] [--ic <file>@<sha> ...] [--write] [--readme]
//   node tools/ledger.mjs sidecars [--write]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CASE_ID = /^(MC-\d\d|IC-\d\d|CAP\d\d|S\d{3}|R2-\d{3}|CMD\d{3}-(OK|DENY|RACE))$/;
/** The classes a row can carry, strongest first. NOT_EXECUTED is no evidence (the registry's SPECIFIED_NOT_EXECUTED_ON_PRODUCT). */
export const CLASSES = ["EXECUTED_PROVIDER", "EXECUTED_LOCAL", "PARTIAL", "SIMULATED", "PLANNED_POST_B19", "PLANNED", "NOT_EXECUTED"];
const EXECUTED = new Set(["EXECUTED_PROVIDER", "EXECUTED_LOCAL"]);
const POST_LAUNCH = new Set(["B20", "B21"]);
const ACCEPTING = new Set(["ACCEPT", "ACCEPT_WITH_MINOR"]);
const PACKAGE_ID = /\bB(0\d|1\d|2[01])\b/g;

export const SIDECAR_DIR = "docs/acceptance/case-maps";
export const LEDGER_DIR = "docs/acceptance/ledger";
export const REVIEW_DIR = "docs/acceptance/reviews";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const stable = (value) => `${JSON.stringify(value, null, 1)}\n`;

// --- the registry ------------------------------------------------------------------------------------------------------------------

export function loadRegistry(root = ROOT) {
  const dir = join(root, "packages", "contracts", "registry");
  const read = (name) => {
    const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
    return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
  };
  const program = read("program.json");
  const cases = new Map(read("cases.json").map((c) => [c.id, c]));
  const owner = new Map(program.flatMap((p) => p.caseIds.map((id) => [id, p.id])));
  const provenance = JSON.parse(readFileSync(join(dir, "PROVENANCE.json"), "utf8"));
  const hashes = Object.fromEntries(Object.keys(provenance.files).map((f) => [f, sha256(readFileSync(join(dir, f)))]));
  return { program, cases, owner, gates: read("gates.json"), provenance, hashes };
}

// --- reading a case map ------------------------------------------------------------------------------------------------------------

/** Splits a markdown table row into cells; a `|` inside backticks or escaped as `\|` does not split. */
export function cellsOf(line) {
  const cells = [];
  let cell = "";
  let tick = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") { cell += "|"; i++; continue; }
    if (ch === "`") tick = !tick;
    if (ch === "|" && !tick) { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells.slice(1, -1);
}

/** The markdown tables of a text: header cells and data rows (the separator row dropped). */
export function tablesOf(text) {
  const tables = [];
  let table = null;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.startsWith("|")) { table = null; continue; }
    const cells = cellsOf(line);
    if (!table) { table = { line: i + 1, header: cells.map((c) => c.toLowerCase()), rows: [] }; tables.push(table); continue; }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    table.rows.push({ line: i + 1, cells });
  }
  return tables;
}

/**
 * Every test cited in a text, as "file :: title" — the reading of tools/evidence.mjs `citationsOf` extended to the MC map:
 * a backtick span followed by `::` (or naming a test file) sets the file, prefixed `golden`/`adversarial` when the text says so;
 * a quoted or backticked span preceded by `::` is a title of the current file (carried from an earlier cell when the text names
 * none); a span right after a title and separated from it only by `;`, `,`, `and` or `<br>` is another title of the same file;
 * a title followed directly by `:: "title"` is one nested title ("describe :: it"). Returns the titles and the file to carry.
 */
export function citationsIn(text, carried = null) {
  const out = [];
  const token = /`([^`]+)`|"((?:[^"\\]|\\.)*)"/g;
  let file = carried;
  let lastEnd = 0;
  let previous = false;
  for (let m; (m = token.exec(text)); ) {
    const gap = text.slice(lastEnd, m.index);
    const after = text.slice(m.index + m[0].length);
    lastEnd = m.index + m[0].length;
    const isFile = m[1] !== undefined && (/^\s*::/.test(after) || /\.(test|spec)\.(ts|tsx|mjs|js)$/.test(m[1]));
    if (isFile && !(/::\s*$/.test(gap) && !/^\s*::/.test(after))) {
      const kind = /\b(golden|adversarial)\s*$/.exec(gap)?.[1];
      file = kind ? `${kind} ${m[1]}` : m[1];
      previous = false;
      continue;
    }
    const title = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[1];
    if (previous && /^\s*::\s*$/.test(gap) && m[2] !== undefined) {
      out[out.length - 1] = `${out[out.length - 1]} :: ${title}`;
      continue;
    }
    if (file && (/::\s*$/.test(gap) || (previous && /^\s*(;|,|,?\s*and|<br>)\s*$/.test(gap)))) {
      out.push(`${file} :: ${title}`);
      previous = true;
      continue;
    }
    previous = false;
  }
  return Object.assign(out, { file });
}

/** The class a status cell states: its first class word (MISSING, a case with no evidence yet, is PLANNED). */
export function classOf(cell) {
  const m = /\b(EXECUTED_PROVIDER|EXECUTED_LOCAL|PARTIAL|SIMULATED|PLANNED_POST_B19|PLANNED|MISSING|NOT_EXECUTED)\b/.exec(cell);
  if (!m) return null;
  return m[1] === "MISSING" ? "PLANNED" : m[1];
}

/** The detail of a case in a map: its `### <case>` section and its `- **<case>**` bullet block. */
export function detailOf(text, caseId) {
  const lines = text.split(/\r?\n/);
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = new RegExp(`^(#{2,4}) ${caseId.replace(/[-]/g, "\\-")}\\b`).exec(lines[i]);
    const bullet = new RegExp(`^(\\s*)- \\*\\*${caseId.replace(/[-]/g, "\\-")}\\*\\*`).exec(lines[i]);
    if (!heading && !bullet) continue;
    let j = i + 1;
    if (heading) {
      while (j < lines.length && !(/^#{1,4} /.test(lines[j]) && lines[j].match(/^#+/)[0].length <= heading[1].length)) j++;
    } else {
      const indent = bullet[1].length;
      while (j < lines.length && !/^#/.test(lines[j]) && !(new RegExp(`^\\s{0,${indent}}- \\*\\*`).test(lines[j]))) j++;
    }
    parts.push(lines.slice(i, j).join("\n"));
    i = j - 1;
  }
  return parts.join("\n");
}

/**
 * The packages a non-executed row hands its remainder to: the other packages it names; when it names none, the packages of the
 * other registry cases it names (MC-07's real counterpart R2-017 is B02's own case); when it names neither, its own package if it
 * names it as the holder of the rest (B10's R2-104: "B10 lane B10-OFFSET, no registry case").
 */
export function remainderOwners(text, caseId, pkg, registry) {
  const others = [...new Set(text.match(PACKAGE_ID) ?? [])].filter((p) => p !== pkg);
  if (others.length) return others.sort();
  const ids = text.match(/\b(MC-\d\d|IC-\d\d|CAP\d\d|S\d{3}|R2-\d{3}|CMD\d{3}-(?:OK|DENY|RACE))\b/g) ?? [];
  const viaCases = [...new Set(ids.filter((id) => id !== caseId).map((id) => registry.owner.get(id)).filter(Boolean))].sort();
  if (viaCases.length) return viaCases;
  // a remainder the package keeps for one of its own later lanes ("B10 lane B10-OFFSET, no registry case")
  return (text.match(PACKAGE_ID) ?? []).includes(pkg) ? [pkg] : [];
}

const unquoted = (text) => text.replace(/`[^`]*`|"(?:[^"\\]|\\.)*"/g, " ");
const shasIn = (cell) => [...cell.matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]);

/**
 * Converts a case map in the table format of the platform and of MC (a table whose first header is `case`, a class column named
 * `status`, `closure` or `planned status`, optionally a `commit` column) into rows of the single schema. `packages` are the
 * packages whose registry cases the map answers; `reviewOf(package, case)` gives the accepting review that agrees with the row.
 */
export function convertTableMap(text, { packages, registry, reviewOf = () => null }) {
  const rows = new Map();
  for (const table of tablesOf(text)) {
    if (table.header[0] !== "case") continue;
    let carried = null;
    const classAt = table.header.findIndex((h) => ["status", "closure", "planned status"].includes(h));
    const commitAt = table.header.indexOf("commit");
    for (const { cells } of table.rows) {
      const id = cells[0];
      if (!CASE_ID.test(id)) continue;
      const pkg = registry.owner.get(id);
      if (!packages.includes(pkg)) continue;
      const row = rows.get(id) ?? { case: id, package: pkg, class: null, claimed: null, tests: [], commits: [], text: [] };
      if (row.class === null && classAt > 0 && classOf(cells[classAt] ?? "")) {
        row.class = classOf(cells[classAt]);
        row.claimed = cells[classAt];
        row.text.push(...cells.filter((_c, i) => i !== 0 && i !== classAt).map(unquoted), unquoted(cells[classAt]));
      }
      const cited = citationsIn(cells.filter((_c, i) => i !== 0).join(" | "), carried);
      carried = cited.file;
      row.tests.push(...cited);
      if (commitAt > 0) row.commits.push(...shasIn(cells[commitAt] ?? ""));
      rows.set(id, row);
    }
  }
  const out = [];
  for (const row of rows.values()) {
    row.tests.push(...citationsIn(detailOf(text, row.case)));
    const klass = row.class ?? "NOT_EXECUTED";
    const inheritedTo = EXECUTED.has(klass) ? [] : remainderOwners(row.text.join(" "), row.case, row.package, registry);
    const review = reviewOf(row.package, row.case, klass);
    out.push({
      case: row.case,
      class: klass,
      test: [...new Set(row.tests)],
      commit: review ? review.commit : row.commits.length ? [...new Set(row.commits)].join(", ") : null,
      reviewId: review ? review.id : null,
      inheritedTo,
      claimed: row.claimed,
    });
  }
  return out;
}

/**
 * Converts a case map in the block format of IC: a case opens a block (a heading or a bold label naming the case id) and states
 * `Status: <class ...>`; the block's citations are its tests and a `Commit:` line or `commit <sha>` its commit.
 */
export function convertStatusBlocks(text, { packages, registry }) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const opener = /^(?:#{2,5}\s+|\s*[-*]\s+\*\*|\*\*)(MC-\d\d|IC-\d\d|CAP\d\d|S\d{3}|R2-\d{3}|CMD\d{3}-(?:OK|DENY|RACE))\b/;
  const starts = lines.flatMap((l, i) => (opener.test(l) ? [i] : []));
  const seen = new Set();
  for (const [k, start] of starts.entries()) {
    const id = opener.exec(lines[start])[1];
    const pkg = registry.owner.get(id);
    if (!packages.includes(pkg) || seen.has(id)) continue;
    const block = lines.slice(start, starts[k + 1] ?? lines.length).join("\n");
    const status = /^\s*[-*]?\s*\**Status\**:\**\s*(.+)$/im.exec(block)?.[1] ?? "";
    const klass = classOf(status) ?? "NOT_EXECUTED";
    seen.add(id);
    out.push({
      case: id,
      class: klass,
      test: [...new Set(citationsIn(block))],
      commit: shasIn(/commit[^\n]*/i.exec(block)?.[0] ?? "").join(", ") || null,
      reviewId: null,
      inheritedTo: EXECUTED.has(klass) ? [] : remainderOwners(unquoted(block), id, pkg, registry),
      claimed: status.trim(),
    });
  }
  return out;
}

// --- reviews -----------------------------------------------------------------------------------------------------------------------

/** The reviewer's answers: id `<package>-round<n>-<commit>`, verdict and the per-case agreement. */
export function loadReviews(root = ROOT) {
  const dir = join(root, REVIEW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => {
      const m = /^(B\d\d)-round(\d+)-([0-9a-f]{7,40})\.json$/.exec(f);
      if (!m) return [];
      const body = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return [{ id: f.replace(/\.json$/, ""), package: m[1], round: Number(m[2]), commit: m[3], verdict: body.verdict, cases: body.cases ?? [] }];
    })
    .sort((a, b) => a.package.localeCompare(b.package) || a.round - b.round);
}

/**
 * The package's latest review, and the review a row's class rests on. A re-check covers only its findings (A4 (c)), so a case's
 * verdict is its most recent entry across the package's rounds; the subject is the latest round, which must accept.
 */
export function reviewIndex(reviews) {
  const latest = new Map();
  const entries = new Map();
  for (const r of reviews) {
    latest.set(r.package, r);
    for (const c of r.cases) entries.set(`${r.package} ${c.id}`, { ...c, review: r.id });
  }
  const entryOf = (pkg, caseId) => entries.get(`${pkg} ${caseId}`) ?? null;
  return {
    latest,
    entryOf,
    reviewOf(pkg, caseId, klass) {
      const r = latest.get(pkg);
      if (!r || !ACCEPTING.has(r.verdict)) return null;
      const entry = entryOf(pkg, caseId);
      if (!entry || entry.agree !== true) return null;
      if (entry.claimed_status && classOf(entry.claimed_status) !== klass) return null;
      return r;
    },
  };
}

// --- sidecars ----------------------------------------------------------------------------------------------------------------------

/** The sidecar of every platform package: converted from its case map when it has one, else derived from the registry. */
export function buildSidecars(root = ROOT, registry = loadRegistry(root), external = ["B01", "B02", "B03", "B04"]) {
  const { reviewOf } = reviewIndex(loadReviews(root));
  const sidecars = [];
  for (const pkg of registry.program) {
    if (external.includes(pkg.id)) continue;
    const file = `docs/design/${pkg.id}-case-map.md`;
    if (existsSync(join(root, file))) {
      const text = readFileSync(join(root, file), "utf8");
      const rows = convertTableMap(text, { packages: [pkg.id], registry, reviewOf });
      sidecars.push({ package: pkg.id, generatedBy: "node tools/ledger.mjs sidecars --write", source: { file, sha256: sha256(text) }, rows });
    } else {
      const post = POST_LAUNCH.has(pkg.id);
      sidecars.push({
        package: pkg.id,
        generatedBy: "node tools/ledger.mjs sidecars --write",
        source: { file: null, registry: "packages/contracts/registry/program.json", note: post ? "post-launch package: PLANNED_POST_B19 until the owner dates it" : "no case map yet: no evidence claimed" },
        rows: pkg.caseIds.map((id) => ({ case: id, class: post ? "PLANNED_POST_B19" : "NOT_EXECUTED", test: [], commit: null, reviewId: null, inheritedTo: [], ...(post ? { ownerDate: null } : {}) })),
      });
    }
  }
  return sidecars;
}

/** Keeps the owner's date and obligations a committed sidecar carries (they are not in any map). */
function carryOwnerFields(fresh, committed) {
  if (!committed) return fresh;
  const dates = new Map((committed.rows ?? []).filter((r) => r.ownerDate).map((r) => [r.case, r.ownerDate]));
  return {
    ...fresh,
    ...(committed.obligations ? { obligations: committed.obligations } : {}),
    rows: fresh.rows.map((r) => (dates.has(r.case) && r.class === "PLANNED_POST_B19" ? { ...r, ownerDate: dates.get(r.case) } : r)),
  };
}

export function readSidecars(root = ROOT) {
  const dir = join(root, SIDECAR_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^B\d\d\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

// --- external maps (MC, IC) ----------------------------------------------------------------------------------------------------

export function readInputs(root = ROOT) {
  return JSON.parse(readFileSync(join(root, LEDGER_DIR, "inputs.json"), "utf8"));
}

export const snapshotPath = (input, commit = input.commit) => join(LEDGER_DIR, "external", `${input.id}-${String(commit).slice(0, 12)}.json`);

/** Reads `<file>@<sha>` through git: the file's repository, its path in it and the bytes at that commit. */
export function readPinned(spec) {
  const at = spec.lastIndexOf("@");
  if (at < 0) throw new Error(`${spec}: expected <file>@<sha>`);
  const file = resolve(spec.slice(0, at));
  const sha = spec.slice(at + 1);
  const top = execFileSync("git", ["-C", dirname(file), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const path = relative(top, file).split("\\").join("/");
  const commit = execFileSync("git", ["-C", top, "rev-parse", `${sha}^{commit}`], { encoding: "utf8" }).trim();
  const text = execFileSync("git", ["-C", top, "show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 64 << 20 });
  return { path, commit, text };
}

export function convertExternal(input, pinned, registry) {
  const convert = input.format === "status-blocks" ? convertStatusBlocks : convertTableMap;
  return {
    id: input.id,
    repository: input.repository,
    path: pinned.path,
    commit: pinned.commit,
    sha256: sha256(pinned.text),
    packages: input.packages,
    generatedBy: `node tools/ledger.mjs --${input.flag} <checkout>/${pinned.path}@${pinned.commit} --write`,
    rows: convert(pinned.text, { packages: input.packages, registry }),
  };
}

// --- the ledger --------------------------------------------------------------------------------------------------------------------

const rank = (klass) => (CLASSES.indexOf(klass) < 0 ? CLASSES.length : CLASSES.indexOf(klass));
const strongest = (rows) => rows.reduce((best, r) => (best === null || rank(r.class) < rank(best.class) ? r : best), null);

/** The README table's rows: package id, status and the commit it names. */
export function readmeClaims(text) {
  return tablesOf(text)
    .filter((t) => t.header[0] === "package" && t.header.includes("status"))
    .flatMap((t) => t.rows.map(({ cells }) => ({ package: /^(B\d\d)\b/.exec(cells[0])?.[1], status: cells[t.header.indexOf("status")], commit: shasIn(cells[t.header.indexOf("commit on main")] ?? "")[0] ?? null })))
    .filter((r) => r.package);
}

/**
 * Computes the ledger. `sources` are the sidecars and external snapshots ({package(s), rows}); `missingInputs` names the
 * external maps that could not be read.
 */
export function computeLedger({ registry, sidecars, externals = [], missingInputs = [], reviews = [], readme = "" }) {
  const violations = [];
  const flag = (kind, subject, detail) => violations.push({ kind, subject, detail });
  const { latest, entryOf } = reviewIndex(reviews);
  const reviewById = new Map(reviews.map((r) => [r.id, r]));

  for (const [file, hash] of Object.entries(registry.provenance.files)) {
    if (registry.hashes[file] !== hash) flag("REGISTRY_HASH_MISMATCH", file, `PROVENANCE.json ${hash.slice(0, 12)}, vendored ${registry.hashes[file]?.slice(0, 12)}`);
  }

  // every row, with the package whose map holds it
  const sources = [
    ...sidecars.map((s) => ({ name: `${SIDECAR_DIR}/${s.package}.json`, packages: [s.package], rows: s.rows, obligations: s.obligations ?? [] })),
    ...externals.map((e) => ({ name: `${e.id}@${e.commit.slice(0, 12)}`, packages: e.packages, rows: e.rows, obligations: [] })),
  ];
  const own = new Map();
  const inherited = new Map();
  for (const src of sources) {
    const seen = new Set();
    for (const row of src.rows) {
      const owner = registry.owner.get(row.case);
      if (!owner) { flag("UNKNOWN_CASE", row.case, `${src.name}: not a registry case`); continue; }
      const held = src.packages.includes(owner);
      if (!held) {
        if (!(row.inheritedTo ?? []).includes(owner)) flag("CROSS_CITATION_WITHOUT_INHERITED", row.case, `${src.name} cites ${owner}'s case without inheritedTo ${owner}`);
        inherited.set(row.case, [...(inherited.get(row.case) ?? []), { ...row, from: src.name }]);
        continue;
      }
      if (seen.has(row.case)) { flag("DUPLICATE_CASE", row.case, `${src.name}: more than one row`); continue; }
      seen.add(row.case);
      own.set(row.case, { ...row, package: owner, from: src.name });
    }
  }

  const cases = [];
  for (const pkg of registry.program) {
    for (const id of pkg.caseIds) {
      const row = own.get(id);
      if (!row) {
        const input = missingInputs.find((m) => m.packages.includes(pkg.id));
        flag("MISSING_CASE", id, input ? `${pkg.id}: input ${input.id} unavailable (${input.reason})` : `${pkg.id}: no row in any case map`);
        cases.push({ case: id, package: pkg.id, gate: registry.cases.get(id)?.gate ?? null, claimed: null, demonstrated: null, reviewId: null, commit: null });
        continue;
      }
      const all = [row, ...(inherited.get(id) ?? [])];
      // a reviewed row: its review exists, accepts, is the package's latest round and agrees with the row's class for this case
      const reviewed = all.filter((r) => {
        if (!r.reviewId) return false;
        const review = reviewById.get(r.reviewId);
        const entry = review ? entryOf(review.package, id) : null;
        const ok = review && ACCEPTING.has(review.verdict) && latest.get(review.package) === review && entry?.agree === true && (!entry.claimed_status || classOf(entry.claimed_status) === r.class);
        if (!ok) flag("PASS_WITHOUT_REVIEW", id, `${r.from}: reviewId ${r.reviewId} does not accept ${r.class}`);
        return ok;
      });
      for (const r of all) {
        const isOwnRow = r === row;
        if (POST_LAUNCH.has(pkg.id) && isOwnRow) {
          if (r.class !== "PLANNED_POST_B19" && !EXECUTED.has(r.class)) flag("POST_LAUNCH_CLASS", id, `${pkg.id}: class ${r.class}; the only planned class allowed is PLANNED_POST_B19`);
          if (r.class === "PLANNED_POST_B19" && !/^\d{4}-\d{2}-\d{2}$/.test(r.ownerDate ?? "")) flag("OWNER_DATE_MISSING", id, `${pkg.id}: PLANNED_POST_B19 without the owner's date`);
        } else if (/^PLANNED/.test(r.class)) {
          flag("PLANNED_OUTSIDE_B20_B21", id, `${r.from}: ${r.class}${r.claimed ? ` (${r.claimed.slice(0, 80)})` : ""}`);
        }
        if ((r.class === "PARTIAL" || r.class === "SIMULATED") && !(r.inheritedTo ?? []).length && !/PLANNED|MISSING/.test(r.claimed ?? "")) {
          flag("REMAINDER_WITHOUT_OWNER", id, `${r.from}: ${r.class} names no package or case that carries the rest`);
        }
        for (const p of r.inheritedTo ?? []) if (!registry.program.some((q) => q.id === p)) flag("CROSS_CITATION_WITHOUT_INHERITED", id, `${r.from}: inheritedTo ${p} is not a program package`);
      }
      const best = strongest(reviewed);
      const claimed = strongest(all);
      cases.push({ case: id, package: pkg.id, gate: registry.cases.get(id)?.gate ?? null, claimed: claimed.class, demonstrated: best?.class ?? null, reviewId: best?.reviewId ?? null, commit: best?.commit ?? null });
    }
  }

  // packages: own acceptance from the latest review, formal acceptance from the dependencies
  const byPkg = new Map(registry.program.map((p) => [p.id, p]));
  const obligationsOf = (id) => sources.filter((s) => s.packages.includes(id)).flatMap((s) => s.obligations);
  const ownStatus = new Map();
  for (const pkg of registry.program) {
    const rows = cases.filter((c) => c.package === pkg.id);
    const review = latest.get(pkg.id);
    const open = obligationsOf(pkg.id).filter((o) => !(o.status === "COVERED" || (o.status === "NOT_APPLICABLE" && o.ownerSigned)));
    let status;
    if (rows.some((c) => c.claimed === null)) status = "INCOMPLETE_MAP";
    else if (!review) status = rows.every((c) => c.claimed === "NOT_EXECUTED" || c.claimed === "PLANNED_POST_B19") ? "NOT_STARTED" : "IN_PROGRESS";
    else if (!ACCEPTING.has(review.verdict)) status = "REVIEW_REJECTED";
    else if (rows.some((c) => c.reviewId !== review.id)) status = "IN_PROGRESS";
    else status = "OWN_ACCEPTED";
    if (status === "OWN_ACCEPTED" && open.length) {
      for (const o of open) flag("OPEN_INHERITED_OBLIGATION", o.id, `${pkg.id}: inherited from ${o.from ?? "?"} still ${o.status ?? "OPEN"}`);
      status = "IN_PROGRESS";
    }
    ownStatus.set(pkg.id, status);
  }
  const accepted = new Map();
  const isAccepted = (id) => {
    if (!accepted.has(id)) accepted.set(id, ownStatus.get(id) === "OWN_ACCEPTED" && (byPkg.get(id).dependsOn ?? []).every(isAccepted));
    return accepted.get(id);
  };
  const waitingFor = (id) => {
    const levels = [];
    let frontier = (byPkg.get(id).dependsOn ?? []).filter((d) => !isAccepted(d));
    const seen = new Set();
    while (frontier.length) {
      const level = [...new Set(frontier)].filter((d) => !seen.has(d)).sort();
      if (!level.length) break;
      level.forEach((d) => seen.add(d));
      levels.push(level);
      frontier = level.flatMap((d) => (byPkg.get(d).dependsOn ?? []).filter((x) => !isAccepted(x)));
    }
    return levels.map((l) => l.join(", ")).join(" → ");
  };
  const packages = registry.program.map((pkg) => {
    const rows = cases.filter((c) => c.package === pkg.id);
    const review = latest.get(pkg.id);
    const own = ownStatus.get(pkg.id);
    const status = own === "OWN_ACCEPTED" ? (isAccepted(pkg.id) ? "ACCEPTED" : "REVIEW_ACCEPTED") : own;
    const counts = {};
    for (const c of rows) counts[c.claimed ?? "MISSING"] = (counts[c.claimed ?? "MISSING"] ?? 0) + 1;
    return {
      package: pkg.id,
      title: pkg.title,
      cases: rows.length,
      counts,
      status,
      acceptedSubject: own === "OWN_ACCEPTED" ? { commit: review.commit, reviewId: review.id } : null,
      rounds: reviews.filter((r) => r.package === pkg.id).map((r) => `${r.verdict} ${r.commit}`),
      waitingFor: status === "REVIEW_ACCEPTED" ? waitingFor(pkg.id) : "",
    };
  });

  // a README row is a claim; acceptance is the computed status
  for (const claim of readmeClaims(readme)) {
    const p = packages.find((x) => x.package === claim.package);
    if (/ACCEPTED/.test(claim.status) && !(p && (p.status === "REVIEW_ACCEPTED" || p.status === "ACCEPTED"))) {
      flag("README_CLAIM_WITHOUT_REVIEW", claim.package, `README says ${claim.status}; computed ${p?.status ?? "unknown package"}`);
    } else if (p && claim.status !== p.status) {
      flag("README_CLAIM_WITHOUT_REVIEW", claim.package, `README says ${claim.status}; computed ${p.status}`);
    }
  }

  const gates = registry.gates.map((g) => {
    const owners = [...new Set(g.caseIds.map((id) => registry.owner.get(id)))].sort();
    return {
      gate: g.id,
      manual: g.owner,
      package: g.package,
      evidenceRule: g.evidenceRule,
      cases: g.caseIds.map((id) => cases.find((c) => c.case === id) ?? { case: id, claimed: null }).map(({ case: id, package: p, claimed, demonstrated, reviewId, commit }) => ({ case: id, package: p, claimed, demonstrated, reviewId, commit })),
      casePackages: owners,
      acceptedSubjects: owners.map((p) => ({ package: p, ...(packages.find((x) => x.package === p)?.acceptedSubject ?? { commit: null, reviewId: null }) })),
      status: g.caseIds.every((id) => cases.find((c) => c.case === id)?.demonstrated) ? "DEMONSTRATED" : "OPEN",
    };
  });

  return { cases, packages, gates, violations, registry: registry.provenance.files };
}

export function readmeTable(ledger) {
  const lines = ["| Package | Cases | Status | Accepted subject (commit · review) | Review rounds | Waiting for |", "|---|---|---|---|---|---|"];
  for (const p of ledger.packages) {
    const counts = Object.entries(p.counts).sort((a, b) => rank(a[0]) - rank(b[0])).map(([k, n]) => `${n} ${k}`).join(", ");
    const subject = p.acceptedSubject ? `\`${p.acceptedSubject.commit}\` · ${p.acceptedSubject.reviewId}` : "—";
    lines.push(`| ${p.package} ${p.title} | ${p.cases}: ${counts} | ${p.status} | ${subject} | ${p.rounds.length ? `${p.rounds.length}: ${p.rounds.join(" → ")}` : "—"} | ${p.waitingFor || "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

// --- the command line --------------------------------------------------------------------------------------------------------------

function loadExternals(root, registry, args) {
  const inputs = readInputs(root).external;
  const externals = [];
  const missingInputs = [];
  const drift = [];
  const given = [...(args["--mc"] ?? []), ...(args["--ic"] ?? [])].map((spec) => ({ spec, pinned: readPinned(spec) }));
  for (const input of inputs) {
    const match = given.find((g) => g.pinned.path === input.path && (args[`--${input.flag}`] ?? []).includes(g.spec));
    const fresh = match ? convertExternal(input, match.pinned, registry) : null;
    const commit = fresh?.commit ?? input.commit;
    const snapFile = commit ? join(root, snapshotPath(input, commit)) : null;
    const snap = snapFile && existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, "utf8")) : null;
    if (fresh && snap && stable(snap) !== stable(fresh)) drift.push(`${input.id}: the snapshot ${snapshotPath(input, commit)} differs from the conversion of ${fresh.path}@${commit}`);
    if (fresh && input.commit && commit !== input.commit) drift.push(`${input.id}: given ${commit.slice(0, 12)}, pinned ${String(input.commit).slice(0, 12)} in ${LEDGER_DIR}/inputs.json`);
    const use = fresh ?? snap;
    if (use) externals.push(use);
    else missingInputs.push({ id: input.id, packages: input.packages, reason: input.commit ? `no snapshot ${snapshotPath(input)} and no --${input.flag} <checkout>/${input.path}@<sha>` : `not pinned in ${LEDGER_DIR}/inputs.json; pass --${input.flag} <checkout>/${input.path}@<sha>` });
  }
  for (const g of given) if (!inputs.some((i) => i.path === g.pinned.path)) drift.push(`${g.spec}: ${g.pinned.path} is not an input of ${LEDGER_DIR}/inputs.json`);
  return { inputs, externals, missingInputs, drift };
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--(mc|ic)$/.test(a)) (args[a] ??= []).push(argv[++i]);
    else if (a.startsWith("--")) args[a] = true;
    else args._.push(a);
  }
  return args;
}

/** The ledger of a repository's committed inputs (and of the external maps `args` names). */
export function ledgerOfRepo(root = ROOT, args = { _: [] }, registry = loadRegistry(root)) {
  const { inputs, externals, missingInputs, drift } = loadExternals(root, registry, args);
  const readmeFile = join(root, "docs", "acceptance", "README.md");
  const ledger = computeLedger({
    registry,
    sidecars: readSidecars(root),
    externals,
    missingInputs,
    reviews: loadReviews(root),
    readme: existsSync(readmeFile) ? readFileSync(readmeFile, "utf8") : "",
  });
  for (const d of drift) ledger.violations.push({ kind: "EXTERNAL_SNAPSHOT_DRIFT", subject: "inputs", detail: d });
  return { inputs, externals, missingInputs, ledger };
}

/** The files `--write` produces, by repository path. */
export function ledgerFiles(ledger) {
  return {
    [`${LEDGER_DIR}/ledger.json`]: stable({ cases: ledger.cases, packages: ledger.packages, violations: ledger.violations }),
    [`${LEDGER_DIR}/README-table.md`]: readmeTable(ledger),
    ...Object.fromEntries(ledger.gates.map((g) => [`${LEDGER_DIR}/gates/${g.gate}.json`, stable(g)])),
  };
}

export function main(argv, root = ROOT, log = console.log) {
  const args = Array.isArray(argv) ? parseArgs(argv) : argv;
  const registry = loadRegistry(root);
  if (args._[0] === "sidecars") {
    const committed = new Map(readSidecars(root).map((s) => [s.package, s]));
    const fresh = buildSidecars(root, registry).map((s) => carryOwnerFields(s, committed.get(s.package)));
    const stale = fresh.filter((s) => !committed.has(s.package) || stable(committed.get(s.package)) !== stable(s)).map((s) => s.package);
    if (args["--write"]) {
      mkdirSync(join(root, SIDECAR_DIR), { recursive: true });
      for (const s of fresh) writeFileSync(join(root, SIDECAR_DIR, `${s.package}.json`), stable(s));
      log(`wrote ${fresh.length} sidecars (${stale.length} changed: ${stale.join(", ") || "none"})`);
      return 0;
    }
    log(stale.length ? `stale sidecars: ${stale.join(", ")} — run node tools/ledger.mjs sidecars --write` : `${fresh.length} sidecars up to date`);
    return stale.length ? 1 : 0;
  }

  const { inputs, externals, ledger } = ledgerOfRepo(root, args, registry);
  const readmeFile = join(root, "docs", "acceptance", "README.md");

  if (args["--write"]) {
    for (const e of externals) {
      const input = inputs.find((i) => i.id === e.id);
      mkdirSync(join(root, LEDGER_DIR, "external"), { recursive: true });
      writeFileSync(join(root, snapshotPath(input, e.commit)), stable(e));
    }
    mkdirSync(join(root, LEDGER_DIR, "gates"), { recursive: true });
    for (const [path, content] of Object.entries(ledgerFiles(ledger))) writeFileSync(join(root, path), content);
  }
  if (args["--readme"]) {
    const text = readFileSync(readmeFile, "utf8");
    const start = "<!-- ledger:table:start -->";
    const end = "<!-- ledger:table:end -->";
    if (!text.includes(start) || !text.includes(end)) throw new Error(`docs/acceptance/README.md has no ${start} … ${end} markers`);
    writeFileSync(readmeFile, `${text.slice(0, text.indexOf(start) + start.length)}\n${readmeTable(ledger)}${text.slice(text.indexOf(end))}`);
  }

  const missing = ledger.violations.filter((v) => v.kind === "MISSING_CASE");
  if (args["--json"]) log(JSON.stringify(ledger, null, 1));
  else {
    log(`# Acceptance ledger — ${ledger.cases.length} registry cases, ${ledger.cases.length - missing.length} mapped, ${missing.length} missing\n`);
    log("| case | package | gate | claimed | demonstrated | review | commit |\n|---|---|---|---|---|---|---|");
    for (const c of ledger.cases) log(`| ${c.case} | ${c.package} | ${c.gate} | ${c.claimed ?? "MISSING"} | ${c.demonstrated ?? "—"} | ${c.reviewId ?? "—"} | ${c.commit ?? "—"} |`);
    log(`\n${readmeTable(ledger)}`);
    const kinds = {};
    for (const v of ledger.violations) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
    log(`violations: ${ledger.violations.length}${ledger.violations.length ? ` (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
    for (const v of ledger.violations) log(`- ${v.kind} ${v.subject}: ${v.detail}`);
  }
  return ledger.violations.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

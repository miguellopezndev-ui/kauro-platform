// Which accepted packages later commits touch (amendment A6 §2: an accepted package needs no new verify or review "unless a later
// diff touches its files or its registry cases"; draft A7 §3). Usage:
//
//   node tools/acceptance-touch.mjs [[<sha>..]<target>] [--json]        (target defaults to HEAD)
//
// Each accepted package (REVIEW_ACCEPTED or ACCEPTED in tools/ledger.mjs) is diffed from its own accepted subject — the commit of
// its accepting review — to the target, never from a later commit: a `<sha>..` left bound only widens a package's range when it
// is an ancestor of that package's subject. A package's files are:
//   - its case map docs/design/<package>-case-map.md and its design documents docs/design/<package>-* (its sidecar is compared
//     row by row, below);
//   - every test file its rows cite, and the source tree `<dir>/src/**` beside each cited `<dir>/test/**` file;
//   - its globs and the shared globs of docs/acceptance/ledger/package-globs.json (required: the file attributes every tracked
//     non-doc file to a package or to the shared list; shared files touch every accepted package).
// Its cases are touched when a registry record of one of them is added, changed or deleted, when one is added to, removed from or
// moved between packages (old and new owner), or when a case-map row for one of them changes (its own sidecar's or another
// package's inherited row; the acceptance bookkeeping `reviewId` and `commit` excepted). Paths are read with
// `--name-status -z --no-renames` and `core.quotepath=off`: a rename is its deletion and its addition, a non-ASCII path is
// itself. A changed cited test (either name of a rename) or a changed own row is reported apart: under the draft A7 §3 (b)
// only those reopen the package. A changed non-doc file that no package and no shared glob owns fails the run (exit 1); an
// unresolvable target or subject is exit 2.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LEDGER_DIR, ROOT, SIDECAR_DIR, convertTableMap, ledgerOfRepo, loadRegistry } from "./ledger.mjs";

export const PACKAGE_GLOBS = `${LEDGER_DIR}/package-globs.json`;

/** A glob (`**` any path, `*` within a segment) as a regular expression over a repository path. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (ch === "*") re += "[^/]*";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A documentation path: never required to have an owner (it is matched against the globs all the same). */
export const isDoc = (path) => path.startsWith("docs/") || /\.md$/i.test(path);

/** The attribution file: every package's globs and the shared list. Missing or malformed is an error, never "no globs". */
export function readPackageGlobs(root = ROOT) {
  const file = join(root, PACKAGE_GLOBS);
  if (!existsSync(file)) throw new Error(`${PACKAGE_GLOBS} is missing: every tracked non-doc file must be attributed`);
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value.shared) || typeof value.packages !== "object" || value.packages === null) throw new Error(`${PACKAGE_GLOBS}: expected {shared: [...], packages: {...}}`);
  return value;
}

/** The files of each package: its map, sidecar and design documents, its cited test files and their source trees, its globs. */
export function packageGlobs(pkg, sidecar, extra = {}) {
  const tests = new Set();
  for (const row of sidecar?.rows ?? []) {
    for (const t of row.test) {
      const file = t.split(" :: ")[0];
      if (/^[\w.-]+(\/[\w.@-]+)+\.\w+$/.test(file)) tests.add(file);
    }
  }
  const sources = [...tests].flatMap((f) => {
    const m = /^(.*?)\/(test|e2e)\//.exec(f);
    return m ? [`${m[1]}/src/**`] : [];
  });
  return {
    tests: [...tests].sort(),
    // the sidecar is not a glob: its rows are compared one by one (changedCaseRows), so recording a review is not a change
    globs: [...new Set([`docs/design/${pkg}-*`, ...tests, ...sources, ...(extra[pkg] ?? [])])].sort(),
  };
}

/** The touched accepted packages, from the changed files and the changed case rows of each package's own range. */
export function touched({ accepted, changedFiles, changedCases, changedOwnRows, globsOf, shared = [] }) {
  const out = [];
  const sharedRes = shared.map(globToRegExp);
  for (const p of accepted) {
    const { globs, tests } = globsOf(p.package);
    const res = [...globs.map(globToRegExp), ...sharedRes];
    const files = changedFiles.filter((f) => res.some((r) => r.test(f)));
    const citedTests = changedFiles.filter((f) => tests.includes(f));
    const cases = [...new Set(changedCases.filter((c) => c.package === p.package).map((c) => c.case))].sort();
    const ownRows = [...new Set(changedOwnRows.filter((c) => c.package === p.package).map((c) => c.case))].sort();
    if (files.length || cases.length) out.push({ package: p.package, status: p.status, acceptedSubject: p.acceptedSubject, files, cases, reopen: { citedTests, ownRows } });
  }
  return out;
}

/** The changed non-doc files that no package's globs and no shared glob own. */
export function unattributed(changedFiles, globSets, shared) {
  const res = [...globSets.flat(), ...shared].map(globToRegExp);
  return changedFiles.filter((f) => !isDoc(f) && !res.some((r) => r.test(f)));
}

const git = (root, args) => execFileSync("git", ["-C", root, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const exists = (root, rev, path) => {
  try {
    git(root, ["cat-file", "-e", `${rev}:${path}`]);
    return true;
  } catch {
    return false;
  }
};
/** A file at a revision; null only when the path does not exist there (any other git failure throws). */
const show = (root, rev, path) => (exists(root, rev, path) ? git(root, ["show", `${rev}:${path}`]) : null);
const list = (v) => (Array.isArray(v) ? v : Object.values(v).find(Array.isArray) ?? []);

/** Every path a range adds, deletes or modifies — both names of a rename, non-ASCII paths verbatim. */
export function changedPaths(root, from, to, ...pathspec) {
  const tokens = git(root, ["diff", "--no-renames", "--name-status", "-z", from, to, ...(pathspec.length ? ["--", ...pathspec] : [])]).split("\0");
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) if (tokens[i]) out.push(tokens[i + 1]);
  return [...new Set(out)];
}

/** The rows of a package's case map at a revision: its sidecar, or the conversion of its .md map when it had no sidecar yet. */
function rowsAt(root, rev, sidecarPath, registry) {
  const json = show(root, rev, sidecarPath);
  if (json !== null) return JSON.parse(json).rows ?? [];
  const pkg = /(B\d\d)\.json$/.exec(sidecarPath)[1];
  const md = show(root, rev, `docs/design/${pkg}-case-map.md`);
  return md === null ? [] : convertTableMap(md, { packages: [pkg], registry });
}
/** A row without the acceptance bookkeeping: recording the review that accepted it is not a change of the row. */
const rowKey = ({ reviewId: _r, commit: _c, ...rest }) => JSON.stringify(rest);

/**
 * The registry cases a range touches — a record added, changed or deleted, a case added to, removed from or moved between
 * packages (old and new owner) — and the case-map rows that differ, by their owner (an own row when the sidecar is the owner's).
 * A registry file that cannot be read at either revision is an error.
 */
export function changedCaseRows(root, from, to, registry = loadRegistry(root)) {
  const changedCases = [];
  const changedOwnRows = [];
  const reg = (rev, f) => {
    const text = show(root, rev, `packages/contracts/registry/${f}`);
    if (text === null) throw new Error(`packages/contracts/registry/${f} cannot be read at ${rev}`);
    return list(JSON.parse(text));
  };
  const program = { from: reg(from, "program.json"), to: reg(to, "program.json") };
  const ownerAt = (p) => new Map(p.flatMap((x) => (x.caseIds ?? []).map((id) => [id, x.id])));
  const owner = { from: ownerAt(program.from), to: ownerAt(program.to) };
  const touch = (id, why) => {
    for (const pkg of new Set([owner.from.get(id), owner.to.get(id)])) if (pkg) changedCases.push({ case: id, package: pkg, why });
  };
  for (const id of new Set([...owner.from.keys(), ...owner.to.keys()])) if (owner.from.get(id) !== owner.to.get(id)) touch(id, "registry program");
  for (const f of ["cases.json", "additional_scenarios.json"]) {
    const a = new Map(reg(from, f).map((c) => [c.id, JSON.stringify(c)]));
    const b = new Map(reg(to, f).map((c) => [c.id, JSON.stringify(c)]));
    for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) touch(id, `registry ${f}`);
  }
  const sidecars = new Set(changedPaths(root, from, to, SIDECAR_DIR).filter((p) => /\/B\d\d\.json$/.test(p)));
  for (const md of changedPaths(root, from, to, "docs/design").filter((p) => /\/B\d\d-case-map\.md$/.test(p))) sidecars.add(`${SIDECAR_DIR}/${/(B\d\d)-case-map/.exec(md)[1]}.json`);
  for (const path of sidecars) {
    const index = (rows) => new Map(rows.map((r) => [r.case, rowKey(r)]));
    const a = index(rowsAt(root, from, path, registry));
    const b = index(rowsAt(root, to, path, registry));
    const sidecarPkg = /(B\d\d)\.json$/.exec(path)[1];
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(id) === b.get(id)) continue;
      touch(id, `row in ${path}`);
      for (const pkg of new Set([owner.from.get(id), owner.to.get(id)])) if (pkg === sidecarPkg) changedOwnRows.push({ case: id, package: pkg });
    }
  }
  return { changedCases, changedOwnRows };
}

const resolveCommit = (root, rev) => git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
const isAncestor = (root, a, b) => {
  try {
    git(root, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
};

export function main(argv, root = ROOT, log = console.log) {
  const spec = argv.find((a) => !a.startsWith("--")) ?? "HEAD";
  const m = /^(?:([^.\s]+)\.\.)?([^.\s]*)$/.exec(spec);
  if (!m) {
    log("usage: node tools/acceptance-touch.mjs [[<sha>..]<target>] [--json]");
    return 2;
  }
  let target;
  let left = null;
  try {
    target = resolveCommit(root, m[2] || "HEAD");
    if (m[1]) left = resolveCommit(root, m[1]);
  } catch {
    log(`${spec}: does not resolve to commits`);
    return 2;
  }
  const { ledger } = ledgerOfRepo(root);
  const registry = loadRegistry(root);
  const accepted = ledger.packages.filter((p) => p.status === "REVIEW_ACCEPTED" || p.status === "ACCEPTED");
  const globsFile = readPackageGlobs(root);
  const sidecarOf = (pkg) => {
    const f = join(root, SIDECAR_DIR, `${pkg}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  };
  const globsOf = (p) => packageGlobs(p, sidecarOf(p), globsFile.packages);

  // each package from its own accepted subject (or an older left bound) to the target
  const result = [];
  const allChanged = new Set();
  const byFrom = new Map();
  for (const p of accepted) {
    let subject;
    try {
      subject = resolveCommit(root, p.acceptedSubject.commit);
    } catch {
      log(`${p.package}: its accepted subject ${p.acceptedSubject.commit} does not resolve in this repository`);
      return 2;
    }
    const from = left && left !== subject && isAncestor(root, left, subject) ? left : subject;
    byFrom.set(from, [...(byFrom.get(from) ?? []), p]);
  }
  for (const [from, pkgs] of byFrom) {
    const files = changedPaths(root, from, target);
    files.forEach((f) => allChanged.add(f));
    const { changedCases, changedOwnRows } = changedCaseRows(root, from, target, registry);
    result.push(...touched({ accepted: pkgs, changedFiles: files, changedCases, changedOwnRows, globsOf, shared: globsFile.shared }).map((r) => ({ ...r, range: `${from.slice(0, 7)}..${target.slice(0, 7)}` })));
  }
  result.sort((a, b) => a.package.localeCompare(b.package));
  const allPackages = [...new Set([...Object.keys(globsFile.packages), ...ledger.packages.map((p) => p.package)])];
  const orphans = unattributed([...allChanged].sort(), allPackages.map((p) => globsOf(p).globs), globsFile.shared);

  if (argv.includes("--json")) log(JSON.stringify({ target, touched: result, unattributed: orphans }, null, 1));
  else {
    log(`# Accepted packages touched up to ${target.slice(0, 7)}: ${result.length ? result.map((r) => r.package).join(", ") : "none"}`);
    for (const r of result) {
      log(`\n## ${r.package} (${r.status}; accepted ${r.acceptedSubject.commit} · ${r.acceptedSubject.reviewId}; range ${r.range})`);
      log(`files (${r.files.length}):${r.files.slice(0, 50).map((f) => `\n- ${f}`).join("")}${r.files.length > 50 ? `\n- … ${r.files.length - 50} more` : ""}`);
      log(`cases (${r.cases.length}): ${r.cases.join(", ") || "none"}`);
      log(`reopens it (cited test changed or own row changed): ${[...r.reopen.citedTests, ...r.reopen.ownRows].join(", ") || "none"}`);
    }
    if (orphans.length) log(`\nchanged files owned by no package and not shared (${PACKAGE_GLOBS}):${orphans.map((f) => `\n- ${f}`).join("")}`);
  }
  return orphans.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

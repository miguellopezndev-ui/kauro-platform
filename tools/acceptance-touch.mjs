// Which accepted packages later commits touch (amendment A6 §2: an accepted package needs no new verify or review "unless a later
// diff touches its files or its registry cases"; draft A7 §3). Usage:
//
//   node tools/acceptance-touch.mjs [[<sha>..]<target>] [--json]        (target defaults to HEAD)
//
// Each accepted package (REVIEW_ACCEPTED or ACCEPTED in tools/ledger.mjs, or any package whose latest review round accepts) is
// diffed from its own accepted subject — the commit of its accepting review — to the target, never from a later commit: a
// `<sha>..` left bound only widens a package's range when it is an ancestor of that package's subject. An external package (its
// map pinned in docs/acceptance/ledger/inputs.json, its subject a commit of the core's repository) is diffed from the platform
// commit that recorded its accepting review; a change of its pin or of its snapshot touches it. Every input that says what a
// package is (package-globs.json, its sidecar rows, inputs.json, the snapshots) is read at both ends of the range (SCOPE_INPUTS):
// a package owns what it owned at its subject and what it owns at the target, and a change of its globs or of the shared list
// touches it. A package's files are:
//   - its case map docs/design/<package>-case-map.md and its design documents docs/design/<package>-* (its sidecar is compared
//     row by row, below);
//   - every test file its rows cite, and the source tree `<dir>/src/**` beside each cited `<dir>/test/**` file;
//   - its globs and the shared globs of docs/acceptance/ledger/package-globs.json (required: the file attributes every tracked
//     non-doc file to a package or to the shared list; shared files touch every accepted package).
// Its cases are touched when a registry record of one of them is added, changed or deleted, when one is added to, removed from or
// moved between packages (old and new owner), or when a case-map row for one of them changes (its own sidecar's or another
// package's inherited row; the acceptance bookkeeping `reviewId` and `commit` excepted only when they record a review the range
// adds), or when its own sidecar's obligations change. A review record of the package edited or deleted after it was added (the
// accepting round included; an external package's too) touches and reopens it; only a newly added round file is inert. Paths are read with
// `--name-status -z --no-renames` and `core.quotepath=off`: a rename is its deletion and its addition, a non-ASCII path is
// itself. A changed cited test (either name of a rename) or a changed own row is reported apart: under the draft A7 §3 (b)
// only those reopen the package. A changed non-doc file that no package and no shared glob owns fails the run (exit 1); an
// unresolvable target or subject is exit 2.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LEDGER_DIR, REVIEW_DIR, ROOT, SIDECAR_DIR, convertTableMap, ledgerOfRepo, loadRegistry, loadReviews, reviewIndex } from "./ledger.mjs";

export const PACKAGE_GLOBS = `${LEDGER_DIR}/package-globs.json`;
export const INPUTS = `${LEDGER_DIR}/inputs.json`;
export const EXTERNAL_DIR = `${LEDGER_DIR}/external`;
const REGISTRY_DIR = "packages/contracts/registry";
/**
 * Every repository input this tool reads, a file or a directory prefix. Each is read at both ends of a package's range, never
 * only in the working tree: the family test (tools/test/ledger-touch.test.mjs) has a row for each, so a new input needs one.
 */
export const SCOPE_INPUTS = [PACKAGE_GLOBS, INPUTS, `${EXTERNAL_DIR}/`, `${SIDECAR_DIR}/`, `${REVIEW_DIR}/`, "docs/design/", `${REGISTRY_DIR}/`];

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
  return parsePackageGlobs(existsSync(file) ? readFileSync(file, "utf8") : null);
}
function parsePackageGlobs(text, at = "") {
  if (text === null) throw new Error(`${PACKAGE_GLOBS} is missing${at}: every tracked non-doc file must be attributed`);
  const value = JSON.parse(text);
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
export function touched({ accepted, changedFiles, changedCases, changedOwnRows, globsOf, shared = [], controlOf = () => [], reviewsOf = () => [] }) {
  const out = [];
  const sharedRes = shared.map(globToRegExp);
  for (const p of accepted) {
    const { globs, tests } = globsOf(p.package);
    const res = [...globs.map(globToRegExp), ...sharedRes];
    // a control file (the attribution or a pin) that changed what the package is counts as one of its files
    // an edited or deleted review record of the package (ADV-1 r4) is one of its files too, and reopens it
    const reviews = [...new Set(reviewsOf(p.package))].sort();
    const files = [...new Set([...changedFiles.filter((f) => res.some((r) => r.test(f))), ...controlOf(p.package), ...reviews])].sort();
    const citedTests = changedFiles.filter((f) => tests.includes(f));
    const cases = [...new Set(changedCases.filter((c) => c.package === p.package).map((c) => c.case))].sort();
    const ownRows = [...new Set(changedOwnRows.filter((c) => c.package === p.package).map((c) => c.case))].sort();
    if (files.length || cases.length) out.push({ package: p.package, status: p.status, acceptedSubject: p.acceptedSubject, files, cases, reopen: { citedTests, ownRows, reviews } });
  }
  return out;
}

/** The changed non-doc files that no package's globs and no shared glob own. */
export function unattributed(changedFiles, globSets, shared) {
  const res = [...globSets.flat(), ...shared].map(globToRegExp);
  return changedFiles.filter((f) => !isDoc(f) && !res.some((r) => r.test(f)));
}

const git = (root, args) => execFileSync("git", ["-C", root, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
/**
 * A file at a revision; null only when the revision's tree has no such path. Any git failure throws: an unknown revision, a
 * corrupt object (`ls-tree` lists the path from the tree, `show` must then read its blob).
 */
export function fileAt(root, rev, path) {
  const listed = git(root, ["ls-tree", "-z", "--name-only", rev, "--", path]).split("\0");
  return listed.includes(path) ? git(root, ["show", `${rev}:${path}`]) : null;
}
const show = fileAt;
const list = (v) => (Array.isArray(v) ? v : Object.values(v).find(Array.isArray) ?? []);

/** Every path a range adds, deletes or modifies — both names of a rename, non-ASCII paths verbatim. */
export function changedPaths(root, from, to, ...pathspec) {
  const tokens = git(root, ["diff", "--no-renames", "--name-status", "-z", from, to, ...(pathspec.length ? ["--", ...pathspec] : [])]).split("\0");
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) if (tokens[i]) out.push(tokens[i + 1]);
  return [...new Set(out)];
}

/**
 * The review records a range of commits adds, and the ones it edits or deletes: every commit of `from..to` (a merge by its
 * first-parent diff), so a record added and then edited inside the range is edited, not added. Only an added record is inert
 * (it is an acceptance itself); an edit or a deletion of one that existed is a change of the acceptance it records (ADV-1 r4).
 */
export function reviewChanges(root, from, to) {
  const tokens = git(root, ["log", "--no-renames", "--diff-merges=first-parent", "--format=", "--name-status", "-z", `${from}..${to}`, "--", REVIEW_DIR]).split("\0");
  const added = new Set();
  const edited = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i].trim();
    if (!/^[ACDMTUXB]\d*$/.test(status)) continue;
    const path = tokens[++i];
    (status === "A" ? added : edited).add(path);
  }
  return { added, edited };
}
/** The package and commit a review record's file name binds (`<package>-round<n>-<commit>.json`), or null. */
const reviewName = (path) => {
  const m = /(?:^|\/)((B\d\d)-round\d+-([0-9a-f]{7,40}))\.json$/.exec(path);
  return m ? { id: m[1], package: m[2], commit: m[3] } : null;
};

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
 * Whether two versions of a row differ by more than the recording of a review the range adds: the bookkeeping may only move to a
 * review record added in the range, with that record's commit (ADV-1 r4 sweep); any other change of reviewId or commit is a change.
 */
const rowChanged = (a, b, addedIds) => {
  if (a === undefined || b === undefined) return a !== b;
  if (rowKey(a) !== rowKey(b)) return true;
  if (a.reviewId === b.reviewId && a.commit === b.commit) return false;
  const r = b.reviewId ? reviewName(`${b.reviewId}.json`) : null;
  return !(r && addedIds.has(r.id) && typeof b.commit === "string" && (b.commit.startsWith(r.commit) || r.commit.startsWith(b.commit)));
};

/**
 * The registry cases a range touches — a record added, changed or deleted, a case added to, removed from or moved between
 * packages (old and new owner) — and the case-map rows that differ, by their owner (an own row when the sidecar is the owner's).
 * A registry file that cannot be read at either revision is an error.
 */
export function changedCaseRows(root, from, to, registry = loadRegistry(root), addedReviews = reviewChanges(root, from, to).added) {
  const addedIds = new Set([...addedReviews].map((p) => reviewName(p)?.id).filter(Boolean));
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
    const index = (rows) => new Map(rows.map((r) => [r.case, r]));
    const a = index(rowsAt(root, from, path, registry));
    const b = index(rowsAt(root, to, path, registry));
    const sidecarPkg = /(B\d\d)\.json$/.exec(path)[1];
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      if (!rowChanged(a.get(id), b.get(id), addedIds)) continue;
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
  const { ledger, inputs } = ledgerOfRepo(root);
  const registry = loadRegistry(root);
  // the packages to scan: every accepted package, and every package whose latest review round accepts (a later change that makes
  // a package stop computing as accepted — a row its review no longer agrees with, a moved pin — must not hide it)
  const { latest } = reviewIndex(loadReviews(root));
  const accepted = ledger.packages
    .map((p) => {
      const r = latest.get(p.package);
      if (p.status === "REVIEW_ACCEPTED" || p.status === "ACCEPTED") return p;
      return r && /^ACCEPT/.test(r.verdict) ? { ...p, acceptedSubject: { commit: r.commit, reviewId: r.id } } : null;
    })
    .filter(Boolean);
  // a review record edited or deleted after it was added (ADV-1 r4): when its first version accepted, its package is scanned from
  // the commit that record names, even when the edit (a verdict flipped, the record deleted) makes it stop computing as accepted
  const everEdited = git(root, ["log", "--no-renames", "--diff-merges=first-parent", "--diff-filter=MDT", "--format=", "--name-only", "-z", target, "--", REVIEW_DIR]).split("\0").map((t) => t.trim()).filter(Boolean);
  for (const path of [...new Set(everEdited)].sort()) {
    const name = reviewName(path);
    if (!name || accepted.some((p) => p.package === name.package)) continue;
    const firstAdd = git(root, ["log", "--diff-filter=A", "--format=%H", target, "--", path]).trim().split("\n").filter(Boolean).at(-1);
    const text = firstAdd ? fileAt(root, firstAdd, path) : null;
    if (text !== null && /^ACCEPT/.test(JSON.parse(text).verdict ?? "")) {
      const p = ledger.packages.find((x) => x.package === name.package);
      accepted.push({ ...(p ?? { package: name.package }), acceptedSubject: { commit: name.commit, reviewId: name.id } });
    }
  }
  accepted.sort((a, b) => a.package.localeCompare(b.package));
  const externalOf = new Map(inputs.flatMap((i) => i.packages.map((p) => [p, i])));
  const globsTarget = parsePackageGlobs(fileAt(root, target, PACKAGE_GLOBS), ` at ${target.slice(0, 12)}`);
  // the attribution at a range's start: the file at that commit, or its first version when the package was accepted before it
  const first = git(root, ["log", "--diff-filter=A", "--format=%H", target, "--", PACKAGE_GLOBS]).trim().split("\n").filter(Boolean).at(-1);
  const globsFrom = (from) => {
    const text = fileAt(root, from, PACKAGE_GLOBS) ?? (first ? fileAt(root, first, PACKAGE_GLOBS) : null);
    return text === null ? globsTarget : parsePackageGlobs(text);
  };
  const rowsOf = (rev, pkg) => ({ rows: rowsAt(root, rev, `${SIDECAR_DIR}/${pkg}.json`, registry) });
  const inputsAt = (rev) => {
    const text = fileAt(root, rev, INPUTS);
    return text === null ? [] : JSON.parse(text).external ?? [];
  };
  const snapshotPackages = (rev, path) => {
    const text = fileAt(root, rev, path);
    return text === null ? [] : JSON.parse(text).packages ?? [];
  };

  // each package from its own accepted subject (or an older left bound) to the target; an external package (its map pinned in
  // inputs.json, its subject a commit of the core's repository) from the platform commit that recorded its accepting review
  const result = [];
  const allChanged = new Set();
  const byFrom = new Map();
  for (const p of accepted) {
    let subject;
    if (externalOf.has(p.package)) {
      const review = `${REVIEW_DIR}/${p.acceptedSubject.reviewId}.json`;
      subject = git(root, ["log", "--diff-filter=A", "--format=%H", target, "--", review]).trim().split("\n").filter(Boolean).at(-1);
      if (!subject) {
        log(`${p.package}: its accepting review ${review} is not committed in the history of ${target.slice(0, 12)}`);
        return 2;
      }
    } else {
      try {
        subject = resolveCommit(root, p.acceptedSubject.commit);
      } catch {
        log(`${p.package}: its accepted subject ${p.acceptedSubject.commit} does not resolve in this repository`);
        return 2;
      }
    }
    const from = left && left !== subject && isAncestor(root, left, subject) ? left : subject;
    byFrom.set(from, [...(byFrom.get(from) ?? []), p]);
  }
  const sameSet = (a = [], b = []) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  for (const [from, pkgs] of byFrom) {
    const files = changedPaths(root, from, target);
    files.forEach((f) => allChanged.add(f));
    const reviews = reviewChanges(root, from, target);
    const { changedCases, changedOwnRows } = changedCaseRows(root, from, target, registry, reviews.added);
    // every attribution input read at both ends of the range: a package owns what it owned at its subject and what it owns now
    const before = globsFrom(from);
    const globsOf = (pkg) => {
      const a = packageGlobs(pkg, rowsOf(from, pkg), before.packages);
      const b = packageGlobs(pkg, rowsOf(target, pkg), globsTarget.packages);
      return { globs: [...new Set([...a.globs, ...b.globs])].sort(), tests: [...new Set([...a.tests, ...b.tests])].sort() };
    };
    const pinsBefore = inputsAt(from);
    const pinsAfter = inputsAt(target);
    const changedPins = [...new Set([...pinsBefore, ...pinsAfter].map((i) => i.id))].flatMap((id) => {
      const [a, b] = [pinsBefore.find((i) => i.id === id), pinsAfter.find((i) => i.id === id)];
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? [] : [...(a?.packages ?? []), ...(b?.packages ?? [])];
    });
    const snapshots = files.filter((f) => f.startsWith(`${EXTERNAL_DIR}/`)).map((f) => ({ f, packages: [...snapshotPackages(from, f), ...snapshotPackages(target, f)] }));
    // the package's own sidecar beyond its rows: an inherited obligation entered, changed or released (ADV-1 r4 sweep)
    const obligationsAt = (rev, pkg) => {
      const text = fileAt(root, rev, `${SIDECAR_DIR}/${pkg}.json`);
      return JSON.stringify(text === null ? [] : JSON.parse(text).obligations ?? []);
    };
    const controlOf = (pkg) => [
      ...(obligationsAt(from, pkg) !== obligationsAt(target, pkg) ? [`${SIDECAR_DIR}/${pkg}.json`] : []),
      ...(!sameSet(before.packages[pkg], globsTarget.packages[pkg]) || !sameSet(before.shared, globsTarget.shared) ? [PACKAGE_GLOBS] : []),
      ...(changedPins.includes(pkg) ? [INPUTS] : []),
      ...snapshots.filter((s) => s.packages.includes(pkg)).map((s) => s.f),
    ];
    const shared = [...new Set([...before.shared, ...globsTarget.shared])];
    const reviewsOf = (pkg) => [...reviews.edited].filter((f) => reviewName(f)?.package === pkg);
    result.push(...touched({ accepted: pkgs, changedFiles: files, changedCases, changedOwnRows, globsOf, shared, controlOf, reviewsOf }).map((r) => ({ ...r, range: `${from.slice(0, 7)}..${target.slice(0, 7)}`, ...(externalOf.has(r.package) ? { subjectRepository: externalOf.get(r.package).repository } : {}) })));
  }
  result.sort((a, b) => a.package.localeCompare(b.package));
  // ownership at the target: a changed non-doc file that the target's attribution gives to nobody fails the run
  const allPackages = [...new Set([...Object.keys(globsTarget.packages), ...ledger.packages.map((p) => p.package)])];
  const orphans = unattributed([...allChanged].sort(), allPackages.map((p) => packageGlobs(p, rowsOf(target, p), globsTarget.packages).globs), globsTarget.shared);

  if (argv.includes("--json")) log(JSON.stringify({ target, touched: result, unattributed: orphans }, null, 1));
  else {
    log(`# Accepted packages touched up to ${target.slice(0, 7)}: ${result.length ? result.map((r) => r.package).join(", ") : "none"}`);
    for (const r of result) {
      log(`\n## ${r.package} (${r.status}; accepted ${r.acceptedSubject.commit} · ${r.acceptedSubject.reviewId}; range ${r.range})`);
      log(`files (${r.files.length}):${r.files.slice(0, 50).map((f) => `\n- ${f}`).join("")}${r.files.length > 50 ? `\n- … ${r.files.length - 50} more` : ""}`);
      log(`cases (${r.cases.length}): ${r.cases.join(", ") || "none"}`);
      log(`reopens it (cited test, own row or review record changed): ${[...r.reopen.citedTests, ...r.reopen.ownRows, ...r.reopen.reviews].join(", ") || "none"}`);
    }
    if (orphans.length) log(`\nchanged files owned by no package and not shared (${PACKAGE_GLOBS}):${orphans.map((f) => `\n- ${f}`).join("")}`);
  }
  return orphans.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

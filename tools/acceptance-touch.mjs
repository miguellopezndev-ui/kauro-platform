// Which accepted packages a range of commits touches (amendment A6 §2: an accepted package needs no new verify or review "unless
// a later diff touches its files or its registry cases"). Usage: node tools/acceptance-touch.mjs <accepted-sha>..HEAD [--json].
//
// The accepted packages are the ledger's (REVIEW_ACCEPTED or ACCEPTED, tools/ledger.mjs). A package's files are:
//   - its case map docs/design/<package>-case-map.md, its sidecar and its design documents docs/design/<package>-*;
//   - every test file its rows cite, and the source tree `<dir>/src/**` beside each cited `<dir>/test/**` file (conservative: a
//     shared source tree touches every package that cites tests of it);
//   - the extra globs of docs/acceptance/ledger/package-globs.json, when that file names the package.
// Its cases are touched when the registry record of one of its cases changes, or a case-map row for one of its cases (its own or
// an inherited row of another package's sidecar) changes. A changed cited test file or a changed own row is reported apart: under
// the draft A7 §3 (b) only those reopen the package; the rest is reviewed inside the later package's review.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LEDGER_DIR, ROOT, SIDECAR_DIR, ledgerOfRepo } from "./ledger.mjs";

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

/** The files of each package: its map, sidecar and design documents, its cited test files and their source trees, extra globs. */
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
    globs: [...new Set([`docs/design/${pkg}-*`, `${SIDECAR_DIR}/${pkg}.json`, ...tests, ...sources, ...(extra[pkg] ?? [])])].sort(),
  };
}

/** The touched accepted packages, from the changed files and the changed case rows of a range. */
export function touched({ accepted, changedFiles, changedCases, changedOwnRows, globsOf }) {
  const out = [];
  for (const p of accepted) {
    const { globs, tests } = globsOf(p.package);
    const res = globs.map(globToRegExp);
    const files = changedFiles.filter((f) => res.some((r) => r.test(f)));
    const citedTests = changedFiles.filter((f) => tests.includes(f));
    const cases = [...new Set(changedCases.filter((c) => c.package === p.package).map((c) => c.case))].sort();
    const ownRows = [...new Set(changedOwnRows.filter((c) => c.package === p.package).map((c) => c.case))].sort();
    if (files.length || cases.length) out.push({ package: p.package, status: p.status, acceptedSubject: p.acceptedSubject, files, cases, reopen: { citedTests, ownRows } });
  }
  return out;
}

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
const show = (root, rev, path) => {
  try {
    return git(root, ["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
};
const list = (v) => (Array.isArray(v) ? v : Object.values(v).find(Array.isArray) ?? []);

/** The registry cases whose record differs between two revisions, and the sidecar rows that differ (by the sidecar's package). */
export function changedCaseRows(root, from, to, owner) {
  const changedCases = [];
  const changedOwnRows = [];
  const regFiles = ["cases.json", "additional_scenarios.json", "program.json"];
  for (const f of regFiles) {
    const path = `packages/contracts/registry/${f}`;
    const a = show(root, from, path);
    const b = show(root, to, path);
    if (a === b) continue;
    const before = new Map(a ? list(JSON.parse(a)).map((c) => [c.id, JSON.stringify(c)]) : []);
    for (const c of b ? list(JSON.parse(b)) : []) {
      if (f === "program.json") {
        const old = before.get(c.id);
        const oldIds = old ? JSON.parse(old).caseIds ?? [] : [];
        for (const id of c.caseIds ?? []) if (!oldIds.includes(id)) changedCases.push({ case: id, package: c.id, why: "registry program" });
      } else if (before.get(c.id) !== JSON.stringify(c)) changedCases.push({ case: c.id, package: owner.get(c.id), why: `registry ${f}` });
    }
  }
  const names = new Set(
    git(root, ["diff", "--name-only", from, to, "--", SIDECAR_DIR])
      .split("\n")
      .filter((p) => /\/B\d\d\.json$/.test(p)),
  );
  for (const path of names) {
    const rows = (rev) => new Map((JSON.parse(show(root, rev, path) ?? '{"rows":[]}').rows ?? []).map((r) => [r.case, JSON.stringify(r)]));
    const a = rows(from);
    const b = rows(to);
    const sidecarPkg = /(B\d\d)\.json$/.exec(path)[1];
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(id) === b.get(id)) continue;
      const pkg = owner.get(id);
      changedCases.push({ case: id, package: pkg, why: `row in ${path}` });
      if (pkg === sidecarPkg) changedOwnRows.push({ case: id, package: pkg });
    }
  }
  return { changedCases, changedOwnRows };
}

export function main(argv, root = ROOT, log = console.log) {
  const range = argv.find((a) => !a.startsWith("--"));
  const m = /^([^.]+)\.\.([^.]*)$/.exec(range ?? "");
  if (!m) {
    log("usage: node tools/acceptance-touch.mjs <accepted-sha>..HEAD [--json]");
    return 2;
  }
  const [from, to] = [m[1], m[2] || "HEAD"];
  const { ledger } = ledgerOfRepo(root);
  const owner = new Map(ledger.cases.map((c) => [c.case, c.package]));
  const accepted = ledger.packages.filter((p) => p.status === "REVIEW_ACCEPTED" || p.status === "ACCEPTED");
  const extraFile = join(root, LEDGER_DIR, "package-globs.json");
  const extra = existsSync(extraFile) ? JSON.parse(readFileSync(extraFile, "utf8")).packages ?? {} : {};
  const sidecarOf = (pkg) => {
    const f = join(root, SIDECAR_DIR, `${pkg}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  };
  const changedFiles = git(root, ["diff", "--name-only", from, to]).split("\n").filter(Boolean);
  const { changedCases, changedOwnRows } = changedCaseRows(root, from, to, owner);
  const result = touched({ accepted, changedFiles, changedCases, changedOwnRows, globsOf: (p) => packageGlobs(p, sidecarOf(p), extra) });
  if (argv.includes("--json")) log(JSON.stringify({ range: `${from}..${to}`, touched: result }, null, 1));
  else {
    log(`# Accepted packages touched by ${from}..${to}: ${result.length ? result.map((r) => r.package).join(", ") : "none"}`);
    for (const r of result) {
      log(`\n## ${r.package} (${r.status}; accepted ${r.acceptedSubject?.commit ?? "—"} · ${r.acceptedSubject?.reviewId ?? "—"})`);
      log(`files (${r.files.length}):${r.files.slice(0, 50).map((f) => `\n- ${f}`).join("")}${r.files.length > 50 ? `\n- … ${r.files.length - 50} more` : ""}`);
      log(`cases (${r.cases.length}): ${r.cases.join(", ") || "none"}`);
      log(`reopens it (cited test changed or own row changed): ${[...r.reopen.citedTests, ...r.reopen.ownRows].join(", ") || "none"}`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

// B18 release candidate tools (S079, R2-113, S080). Pure functions plus a small CLI; no clock, no network, no shared state.
//   node tools/release-candidate.mjs freeze --tree <git tree sha> --lock <file> --core <file>... --image sha256:<hex> [--out <file>]
//   node tools/release-candidate.mjs verify-promotion --approved <file> --proposed <file> [--receipts <file>]
//   node tools/release-candidate.mjs verify-ci --runs <check-runs.json> --sha <40 hex> --require <context>...
//   node tools/release-candidate.mjs verify-pipes [--workflow <file>]... [--package <file>]...
// Exit 0 = OK, 1 = DENY (problems on stdout as JSON), 2 = usage error.
//
// A candidate is the source tree plus every input that changes what ships: the dependency lock, each vendored core, the image
// digest. "A changed dependency or image produces a different candidate even with identical source text." (registry ReleaseCandidate)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const HEX64 = /^[0-9a-f]{64}$/;
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

const bodyOf = (c) => ({ kind: "RELEASE_CANDIDATE", sourceTree: c.sourceTree, inputs: { lock: c.inputs.lock, cores: c.inputs.cores }, imageDigest: c.imageDigest });

/** Freezes a candidate. `lock` = { path, sha256 }, `cores` = [{ name, sha256 }]. The id is the digest of everything that ships. */
export function freezeCandidate({ sourceTree, lock, cores, imageDigest }) {
  if (!TREE.test(sourceTree ?? "")) throw new Error("sourceTree must be a git tree sha");
  if (!lock || typeof lock.path !== "string" || !HEX64.test(lock.sha256 ?? "")) throw new Error("lock must be { path, sha256 }");
  if (!Array.isArray(cores)) throw new Error("cores must be a list");
  const names = new Set();
  for (const core of cores) {
    if (typeof core?.name !== "string" || !HEX64.test(core.sha256 ?? "")) throw new Error("each core must be { name, sha256 }");
    if (names.has(core.name)) throw new Error(`duplicate core ${core.name}`);
    names.add(core.name);
  }
  if (!IMAGE.test(imageDigest ?? "")) throw new Error("imageDigest must be sha256:<64 hex>");
  const body = bodyOf({ sourceTree, inputs: { lock: { path: lock.path, sha256: lock.sha256 }, cores: [...cores].map((c) => ({ name: c.name, sha256: c.sha256 })).sort((a, b) => a.name.localeCompare(b.name)) }, imageDigest });
  return { ...body, id: sha256(canonical(body)) };
}

/** A candidate is well formed and its id covers exactly its content. */
function intact(candidate, label, problems) {
  try {
    const again = freezeCandidate({ sourceTree: candidate.sourceTree, lock: candidate.inputs?.lock, cores: candidate.inputs?.cores, imageDigest: candidate.imageDigest });
    if (again.id !== candidate.id) problems.push({ code: "CANDIDATE_ID_MISMATCH", detail: `${label} id does not cover its content` });
    return again.id === candidate.id;
  } catch (error) {
    problems.push({ code: "CANDIDATE_MALFORMED", detail: `${label}: ${error.message}` });
    return false;
  }
}

/** The inputs of `proposed` that differ from `approved`: [{ input: "lock"|"core", name, from, to }]. */
function changedInputs(approved, proposed) {
  const changes = [];
  const a = approved.inputs.lock, p = proposed.inputs.lock;
  if (a.path !== p.path || a.sha256 !== p.sha256) changes.push({ input: "lock", name: p.path, from: a.sha256, to: p.sha256, renamed: a.path !== p.path });
  const before = new Map(approved.inputs.cores.map((c) => [c.name, c.sha256]));
  const after = new Map(proposed.inputs.cores.map((c) => [c.name, c.sha256]));
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) !== after.get(name)) changes.push({ input: "core", name, from: before.get(name) ?? null, to: after.get(name) ?? null });
  }
  return changes;
}

/**
 * S079 / R2-113: may `proposed` be promoted under the evidence of `approved`?
 * The image digest must be the approved one, with no exception: a rebuilt image is a different candidate. The source tree must be the
 * approved one. A changed dependency lock or core hash is a different candidate too, reusable only when an EquivalenceReceipt names
 * exactly that input, its name and both hashes.
 */
export function verifyPromotion(approved, proposed, receipts = []) {
  const problems = [];
  const okA = intact(approved, "approved", problems);
  const okP = intact(proposed, "proposed", problems);
  if (!okA || !okP) return { ok: false, problems };
  if (proposed.imageDigest !== approved.imageDigest) problems.push({ code: "IMAGE_DIGEST_CHANGED", detail: `${proposed.imageDigest} is not the approved ${approved.imageDigest}; a rebuilt image is a new candidate` });
  if (proposed.sourceTree !== approved.sourceTree) problems.push({ code: "SOURCE_TREE_CHANGED", detail: `${proposed.sourceTree} is not the approved ${approved.sourceTree}` });
  const list = Array.isArray(receipts) ? receipts : [];
  for (const change of changedInputs(approved, proposed)) {
    const covered = !change.renamed && change.from !== null && change.to !== null && list.some((r) => r && r.kind === "EquivalenceReceipt" && r.input === change.input && r.name === change.name && r.from === change.from && r.to === change.to);
    if (!covered) problems.push({ code: change.input === "lock" ? "LOCK_CHANGED" : "CORE_CHANGED", detail: `${change.input} ${change.name}: ${change.from} -> ${change.to} has no EquivalenceReceipt naming exactly that input` });
  }
  return { ok: problems.length === 0, problems };
}

/**
 * S080: the required contexts all have a completed, successful check run on exactly `sha`. A run on another head sha never counts, even
 * under the same name; the latest run (highest id) of a context on `sha` decides, so a later failed rerun supersedes an earlier success;
 * skipped, neutral and every other conclusion fail.
 */
export function verifyCi(runs, { sha, required }) {
  const problems = [];
  if (!TREE.test(sha ?? "")) problems.push({ code: "SHA_MALFORMED", detail: "sha must be the full commit sha" });
  if (!Array.isArray(required) || required.length === 0) problems.push({ code: "NO_REQUIRED_CONTEXTS", detail: "at least one required context is needed" });
  if (!Array.isArray(runs)) problems.push({ code: "RUNS_MALFORMED", detail: "check runs must be a list" });
  if (problems.length) return { ok: false, problems };
  for (const context of required) {
    const exact = runs.filter((r) => r && r.name === context && r.head_sha === sha);
    if (exact.length === 0) {
      const other = runs.filter((r) => r && r.name === context).length;
      problems.push({ code: "RUN_MISSING", detail: `${context}: no check run on ${sha}${other ? ` (${other} on other shas do not count)` : ""}` });
      continue;
    }
    if (exact.some((r) => !Number.isSafeInteger(r.id))) { problems.push({ code: "RUN_MALFORMED", detail: `${context}: a run has no numeric id` }); continue; }
    const top = Math.max(...exact.map((r) => r.id));
    const latest = exact.filter((r) => r.id === top);
    if (latest.length !== 1) { problems.push({ code: "RUN_AMBIGUOUS", detail: `${context}: several runs share id ${top}` }); continue; }
    const run = latest[0];
    if (run.status !== "completed") problems.push({ code: "RUN_NOT_COMPLETED", detail: `${context}: latest run ${run.id} is ${run.status}` });
    else if (run.conclusion !== "success") problems.push({ code: "RUN_NOT_SUCCESS", detail: `${context}: latest run ${run.id} concluded ${run.conclusion}` });
  }
  return { ok: problems.length === 0, problems };
}

// ---- pipes that drop exit 1 -------------------------------------------------------------------------------------------------------
// A pipe is safe iff its step runs explicit bash (step `shell: bash` or `defaults.run.shell: bash`; GitHub runs it as
// `bash --noprofile --norc -eo pipefail`) or its body runs `set -o pipefail` before the pipe. A step with no shell is `bash -e` without
// pipefail on Linux and pwsh on Windows, so it is unsafe.

const PIPEFAIL_ON = /\bset\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*o\s+pipefail\b/;
const PIPEFAIL_OFF = /\bset\s+\+[A-Za-z]*o\s+pipefail\b/;

/** Logical lines of a shell body: comments dropped, backslash continuations joined, quoted text blanked. */
function logicalLines(lines) {
  const out = [];
  let acc = null;
  for (const { n, text } of lines) {
    if (/^\s*#/.test(text)) continue;
    const blanked = text.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\s#.*$/, "");
    const joined = acc ? { n: acc.n, text: `${acc.text} ${blanked.trim()}` } : { n, text: blanked };
    if (/\\\s*$/.test(blanked)) { acc = { n: joined.n, text: joined.text.replace(/\\\s*$/, "") }; continue; }
    acc = null;
    out.push(joined);
  }
  if (acc) out.push(acc);
  return out;
}

function hasPipe(line) { return /(^|[^|])\|(?!\|)/.test(line.replace(/\|&/g, "|")); }

/** Unsafe pipes in one shell body: [{ line, text }]. `shellIsBash`: the step runs explicit bash. */
export function unsafePipesInBody(lines, shellIsBash) {
  const found = [];
  let pipefail = false;
  for (const { n, text } of logicalLines(lines)) {
    if (PIPEFAIL_OFF.test(text)) pipefail = false;
    else if (PIPEFAIL_ON.test(text)) pipefail = true;
    if (hasPipe(text) && !shellIsBash && !pipefail) found.push({ line: n, text: text.trim() });
  }
  return found;
}

const indentOf = (s) => s.length - s.trimStart().length;

/** Pipes of a workflow file: { pipes: [{ line, text, safe, step }] } over every `run:` of every job step. */
export function workflowPipes(text) {
  const raw = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
  const defaultShell = (from, to, keyIndent) => {
    for (let i = from; i < to; i++) {
      if (/^\s*defaults:\s*$/.test(raw[i].text) && indentOf(raw[i].text) === keyIndent) {
        for (let j = i + 1; j < to && (raw[j].text.trim() === "" || indentOf(raw[j].text) > keyIndent); j++) {
          const m = /^\s*shell:\s*(.+?)\s*$/.exec(raw[j].text);
          if (m) return m[1].replace(/^["']|["']$/g, "");
        }
      }
    }
    return null;
  };
  const jobsAt = raw.findIndex((r) => /^jobs:\s*$/.test(r.text));
  const workflowShell = defaultShell(0, jobsAt < 0 ? raw.length : jobsAt, 0);
  const pipes = [];
  if (jobsAt < 0) return { pipes };
  const jobStarts = [];
  for (let i = jobsAt + 1; i < raw.length; i++) if (/^ {2}[\w-]+:\s*$/.test(raw[i].text)) jobStarts.push(i);
  jobStarts.forEach((start, k) => {
    const end = k + 1 < jobStarts.length ? jobStarts[k + 1] : raw.length;
    const jobShell = defaultShell(start + 1, end, 4) ?? workflowShell;
    const stepsAt = raw.findIndex((r, i) => i > start && i < end && /^ {4}steps:\s*$/.test(r.text));
    if (stepsAt < 0) return;
    const items = [];
    for (let i = stepsAt + 1; i < end; i++) if (/^ {6}- /.test(raw[i].text)) items.push(i);
    items.forEach((s, j) => {
      const stop = j + 1 < items.length ? items[j + 1] : end;
      let shell = jobShell, name = `step@${raw[s].n}`, runAt = -1;
      for (let i = s; i < stop; i++) {
        const t = raw[i].text.replace(/^(\s*)- /, "$1  ");
        if (indentOf(t) !== 8) continue;
        let m;
        if ((m = /^\s*name:\s*(.+?)\s*$/.exec(t))) name = m[1];
        if ((m = /^\s*shell:\s*(.+?)\s*$/.exec(t))) shell = m[1].replace(/^["']|["']$/g, "");
        if (/^\s*run:/.test(t)) runAt = i;
      }
      if (runAt < 0) return;
      const run = /^\s*(?:- )?run:\s*(.*)$/.exec(raw[runAt].text)[1];
      let body;
      if (/^[|>][+-]?\d*\s*$/.test(run)) {
        body = [];
        for (let i = runAt + 1; i < stop && (raw[i].text.trim() === "" || indentOf(raw[i].text) > 8); i++) body.push(raw[i]);
      } else body = [{ n: raw[runAt].n, text: run }];
      const bash = shell === "bash";
      const unsafe = new Set(unsafePipesInBody(body, bash).map((p) => p.line));
      for (const { n, text: line } of logicalLines(body)) if (hasPipe(line)) pipes.push({ line: n, text: line.trim(), safe: !unsafe.has(n), step: name });
    });
  });
  return { pipes };
}

/** Pipes in the scripts of a package.json (npm runs them with `sh -c`, no pipefail): safe only after `set -o pipefail`. */
export function packagePipes(text) {
  const scripts = JSON.parse(text).scripts ?? {};
  const pipes = [];
  for (const [name, body] of Object.entries(scripts)) {
    const pieces = String(body).split(/;|&&/).map((t, i) => ({ n: i + 1, text: t }));
    const unsafe = new Set(unsafePipesInBody(pieces, false).map((p) => p.line));
    for (const { n, text: piece } of logicalLines(pieces)) if (hasPipe(piece)) pipes.push({ script: name, text: piece.trim(), safe: !unsafe.has(n) });
  }
  return { pipes };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------------------------
function parse(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    (opts[a.slice(2)] ??= []).push(argv[++i]);
  }
  return opts;
}
const one = (opts, key) => { if (!opts[key] || opts[key].length !== 1) throw new Error(`--${key} is required once`); return opts[key][0]; };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const answer = (result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.ok ? 0 : 1; };

export function main(argv) {
  const [command, ...rest] = argv;
  try {
    const opts = parse(rest);
    if (command === "freeze") {
      const candidate = freezeCandidate({
        sourceTree: one(opts, "tree"),
        lock: { path: basename(one(opts, "lock")), sha256: sha256(readFileSync(one(opts, "lock"))) },
        cores: (opts.core ?? []).map((p) => ({ name: basename(p), sha256: sha256(readFileSync(p)) })),
        imageDigest: one(opts, "image"),
      });
      if (opts.out) writeFileSync(one(opts, "out"), `${JSON.stringify(candidate, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
      return 0;
    }
    if (command === "verify-promotion") return answer(verifyPromotion(readJson(one(opts, "approved")), readJson(one(opts, "proposed")), opts.receipts ? readJson(one(opts, "receipts")) : []));
    if (command === "verify-ci") return answer(verifyCi(readJson(one(opts, "runs")), { sha: one(opts, "sha"), required: opts.require ?? [] }));
    if (command === "verify-pipes") {
      const problems = [];
      for (const f of opts.workflow ?? []) for (const p of workflowPipes(readFileSync(f, "utf8")).pipes) if (!p.safe) problems.push({ code: "PIPE_DROPS_EXIT", detail: `${f}:${p.line} ${p.text}` });
      for (const f of opts.package ?? []) for (const p of packagePipes(readFileSync(f, "utf8")).pipes) if (!p.safe) problems.push({ code: "PIPE_DROPS_EXIT", detail: `${f} script ${p.script}: ${p.text}` });
      return answer({ ok: problems.length === 0, problems });
    }
    throw new Error("command must be freeze, verify-promotion, verify-ci or verify-pipes");
  } catch (error) {
    process.stderr.write(`release-candidate: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));

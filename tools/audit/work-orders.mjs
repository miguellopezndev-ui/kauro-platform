// tools/audit/work-orders.mjs — the final-audit work-order ledger (FA-kit-at14 lane W; mandate sections 2-4 and 7).
// R2 21_QUALITY_AND_ACCEPTANCE:95 a finding records requirement, subject, reproduction, expected/observed, cause, impact, consumers,
// repair and acceptance cases; :97 material defects block the affected capability; :109-110 independence (the fixer is not the auditor,
// the verifier is not the fixer) and closure on the code that is on main; :128 "A final report cannot omit a failed attempt simply
// because a later attempt passed": events are written once (lib/atomic.mjs writeOnce), never rewritten, and a reopened WO keeps every
// attempt in its history and in the summary.
//
// Layout under `--root` (W-1): repos.json (repo -> worktree), fp/<fp>.json (claim {requestId}), fp/<fp>.wo.json (binding {woId}),
// wo/WO-<n>/<seq>.json (events {seq, prev, at, actor, requestId, from, to, fields}; prev = sha256 of the previous event file bytes),
// runs/<run-id>/{anchors.json, summary.json, MANIFEST.sha256} (immutable anchor runs), delta/<WO-id>/<nnnn>.json (deltaRun, lane D).
// W-2a: every committed transition writes an anchor run {WO: {seq, hash}}; anchors are read only from runs whose manifest verifies and
// never from summary.json; a covered event cannot vanish or change without the next fold failing with E_LEDGER_CORRUPT. W-2b: a frozen
// WO (fold fails) takes no transition; a truncated tail is recovered by one coordinator LOST event citing the anchor (run, seq, hash).
// W-3 states, W-4 import (claim, slot, event 1, binding), W-5 ASSIGNED, W-6 FIXED (K-3 red proof), W-7 VERIFIED (deltaRun, root cause),
// W-8 CLOSED (the tool fetches and reads origin/main itself; no flag accepts a main sha). All git reads precede the first write.
// CLI: node tools/audit/work-orders.mjs <import|assign|fix|verify|close|void|reopen|lost|show|summary> --root <dir> ...
//   exit 0 ok, 1 refused (code printed), 2 blocked or frozen.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isTempName, probeLinks, readableFiles, writeOnce } from "./lib/atomic.mjs";
import { validateFinding } from "./lib/finding.mjs";
import { gitStatus } from "./lib/git.mjs";
import { MANIFEST_NAME, verifyManifest, writeManifest } from "./lib/manifest.mjs";
import { HARNESS_SAMPLES, isTestOnly, validateRedProof } from "./lib/red-proof.mjs";
import { canonical, fail, sha256Hex } from "./lib/record.mjs";
import { repoNameOf } from "./lib/subject.mjs";

const EDGES = {
  OPEN: ["ASSIGNED", "VOIDED"],
  ASSIGNED: ["ASSIGNED", "FIXED", "VOIDED"],
  FIXED: ["VERIFIED", "ASSIGNED"],
  VERIFIED: ["CLOSED", "ASSIGNED"],
  CLOSED: [],
  VOIDED: [],
};
const SLOT = /^WO-(\d+)$/;
const EVENT_FILE = /^(\d{4})\.json$/;
const RECEIPT = /^(wo-(\d+)-(lane|pkg)-review(?:-r\d+)?)-([0-9a-f]{12})$/;
const FROZEN_CODES = new Set(["E_LEDGER_CORRUPT", "E_LOST_NO_ANCHOR", "E_LOST_AUTHORITY"]);
const COMPUTED = ["reviewSha256", "mainSha"];
const ACCEPTING = ["ACCEPT", "ACCEPT_WITH_MINOR"];

const pad4 = (n) => String(n).padStart(4, "0");
const slash = (p) => p.replaceAll("\\", "/");
const isText = (v) => typeof v === "string" && v.length > 0;
const clean = (v) => JSON.parse(JSON.stringify(v));
const numeric = (a, b) => Number.parseInt(a.replace(/\D/g, ""), 10) - Number.parseInt(b.replace(/\D/g, ""), 10);
const jsonText = (v) => `${JSON.stringify(v)}\n`;

function readJsonIf(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const corrupt = (message, extra = {}) => fail("E_LEDGER_CORRUPT", message, { kind: "tamper", ...extra });
const stripComputed = (fields) => Object.fromEntries(Object.entries(fields ?? {}).filter(([k]) => !COMPUTED.includes(k)));
const sameBody = (event, to, actor, fields) => canonical({ to: event.to, actor: event.actor, fields: stripComputed(event.fields) }) === canonical({ to, actor, fields: stripComputed(fields) });

let lastRunMs = 0;
function nextRunId() {
  lastRunMs = Math.max(Date.now(), lastRunMs + 1);
  return `${String(lastRunMs).padStart(13, "0")}-${randomBytes(3).toString("hex")}`;
}

export function openLedger({ root: rootArg, runner, beforeLink, crashAt, fs, platform } = {}) {
  if (!isText(rootArg)) throw fail("E_ROOT", "--root is required");
  const root = resolve(rootArg);
  mkdirSync(root, { recursive: true });
  probeLinks(root, fs ? { fs } : {});

  const wopts = (path) => {
    const point = typeof crashAt === "string" ? crashAt : crashAt?.match.test(slash(path)) ? crashAt.point : undefined;
    return { ...(fs ? { fs } : {}), ...(platform ? { platform } : {}), beforeLink, crashAt: point };
  };
  const woDir = (id) => join(root, "wo", id);
  const eventPath = (id, seq) => join(woDir(id), `${pad4(seq)}.json`);
  const claimPath = (fp) => join(root, "fp", `${fp}.json`);
  const bindPath = (fp) => join(root, "fp", `${fp}.wo.json`);
  const gitIn = (cwd) => (args, okCodes = [0]) => {
    const r = gitStatus(args, { cwd, runner });
    if (!okCodes.includes(r.status)) throw fail("E_GIT", `git ${args.join(" ")} exited ${r.status}: ${r.stderr.trim()}`);
    return r;
  };

  /** W-1: the worktree of `repo` from repos.json; its origin must be that repository. */
  function worktree(repo) {
    const path = readJsonIf(join(root, "repos.json"))?.[repo];
    if (!isText(path)) throw fail("E_REPO_UNKNOWN", `repos.json has no worktree for ${repo}`);
    const origin = gitIn(path)(["remote", "get-url", "origin"]).stdout.trim();
    if (repoNameOf(origin) !== repo) throw fail("E_REPO_MISMATCH", `the worktree ${path} has origin ${origin}, not repository ${repo}`);
    return path;
  }

  // ---------------------------------------------------------------- anchors (W-2a)
  /**
   * Anchors of every run whose MANIFEST verifies: Map WO -> [{run, seq, hash, blocks}]. anchors.json only, never summary.json.
   * A run without a manifest (crash before the manifest) is ignored; a run whose manifest or anchors.json does not verify is listed in
   * `index.bad` and freezes every fold (ADV-9, E_LEDGER_CORRUPT kind run): it can no longer be known which WOs it anchored.
   * `blocks` is the capability the WO blocked at that anchor (blocks.json, ADV-2), null when none.
   */
  function anchorIndex() {
    const index = new Map();
    index.bad = [];
    const runs = join(root, "runs");
    if (!existsSync(runs)) return index;
    for (const id of readableFiles(runs)) {
      const dir = join(runs, id);
      if (!existsSync(join(dir, MANIFEST_NAME))) continue;
      let anchors;
      let blocks = {};
      try {
        verifyManifest(dir);
        anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
        if (existsSync(join(dir, "blocks.json"))) blocks = JSON.parse(readFileSync(join(dir, "blocks.json"), "utf8"));
        if (anchors === null || typeof anchors !== "object" || Array.isArray(anchors)) throw new Error("anchors.json is not an object");
        for (const a of Object.values(anchors)) if (!Number.isInteger(a?.seq) || !isText(a?.hash)) throw new Error("anchors.json has a malformed anchor");
      } catch (error) {
        index.bad.push({ run: id, message: error.message });
        continue;
      }
      for (const [wo, a] of Object.entries(anchors)) {
        if (!index.has(wo)) index.set(wo, []);
        index.get(wo).push({ run: id, seq: a.seq, hash: a.hash, blocks: isText(blocks?.[wo]) ? blocks[wo] : null });
      }
    }
    return index;
  }

  /** The capability a WO blocks in this view: a material finding that is neither CLOSED nor VOIDED. */
  function blockOf(view) {
    const finding = view.events[0].event.fields.finding;
    return finding.materialClass !== undefined && view.state !== "CLOSED" && view.state !== "VOIDED" && isText(finding.capability) ? finding.capability : null;
  }

  /** An anchor is superseded only by a LOST event whose supersedes lists its run and whose range covers its seq (ADV-1: never by run-id order). */
  const exemptBy = (events) => {
    const losts = events.filter((e) => e.event.to === "LOST").map((e) => e.event.fields);
    return (a) => losts.some((l) => Array.isArray(l.supersedes) && l.supersedes.includes(a.run) && l.lastSurvivingSeq < a.seq && a.seq <= l.anchorSeq);
  };

  /** A new anchor never has a lower seq or another hash than an earlier valid, not superseded, anchor of the WO. */
  function guardAnchor(woId, candidate, events, index) {
    const exempt = exemptBy(events);
    for (const a of index.get(woId) ?? []) {
      if (exempt(a)) continue;
      if (a.seq > candidate.seq) throw corrupt(`${woId}: an earlier anchor (run ${a.run}) names seq ${a.seq}, above the new anchor ${candidate.seq}`);
      if (a.seq === candidate.seq && a.hash !== candidate.hash) throw corrupt(`${woId}: the anchor at seq ${a.seq} has another hash (run ${a.run})`);
    }
  }

  function writeRun(files) {
    const id = nextRunId();
    const dir = join(root, "runs", id);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeOnce(join(dir, name), text, wopts(join(dir, name)));
    writeManifest(dir, wopts(join(dir, MANIFEST_NAME)));
    return id;
  }

  /** R3-2: the anchor run of one committed event of `woId`. */
  function anchorRunFor(woId) {
    const index = anchorIndex();
    const view = inspect(woId, index);
    const candidate = { seq: view.seq, hash: view.lastHash };
    guardAnchor(woId, candidate, view.events, index);
    const anchors = { [woId]: candidate };
    return writeRun({ "anchors.json": jsonText(anchors), "blocks.json": jsonText({ [woId]: blockOf(view) }), "summary.json": jsonText({ trigger: "transition", woId, anchors }) });
  }

  function anchorRunOf(woId, view, index) {
    const found = (index.get(woId) ?? []).find((a) => a.seq === view.seq && a.hash === view.lastHash);
    return found ? found.run : anchorRunFor(woId);
  }

  // ---------------------------------------------------------------- the fold (W-2)
  /** Reads and verifies one WO; throws E_LEDGER_CORRUPT (kind tamper|truncation), E_LOST_NO_ANCHOR or E_LOST_AUTHORITY. */
  function inspect(woId, index = anchorIndex()) {
    const dir = woDir(woId);
    if (index.bad.length > 0) throw corrupt(`${woId}: run ${index.bad[0].run} does not verify (${index.bad[0].message})`, { kind: "run" });
    if (!existsSync(dir)) {
      if (index.has(woId)) throw corrupt(`${woId} is anchored by a verified run but its folder is missing`, { kind: "missing" });
      throw fail("E_NO_WO", `${woId} does not exist`);
    }
    if (index.has(woId) && !isBound(woId)) throw corrupt(`${woId} is anchored by a verified run but its binding is missing`, { kind: "missing" });
    const files = readdirSync(dir).filter((n) => EVENT_FILE.test(n)).sort(numeric);
    if (files.length === 0) throw corrupt(`${woId} has no events`);
    const events = files.map((f) => {
      const bytes = readFileSync(join(dir, f));
      let event;
      try {
        event = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw corrupt(`${woId}/${f} is not JSON`);
      }
      return { num: Number.parseInt(f, 10), event, hash: sha256Hex(bytes) };
    });
    // contiguity: file numbers 1..n and every event names its own position
    events.forEach((e, i) => {
      if (e.num !== i + 1 || e.event.seq !== i + 1) throw corrupt(`${woId}: gap or misnumbered event at position ${i + 1} (file ${e.num}, seq ${e.event.seq})`);
    });
    // the prev chain
    events.forEach((e, i) => {
      const want = i === 0 ? null : events[i - 1].hash;
      if (e.event.prev !== want) throw corrupt(`${woId}: event ${e.event.seq} does not chain to the bytes of event ${i}`);
    });
    // the state replay and the LOST events
    let state = null;
    events.forEach((e, i) => {
      const ev = e.event;
      if (i === 0) {
        if (ev.to !== "OPEN" || ev.from !== null) throw corrupt(`${woId}: event 1 is not OPEN`);
        state = "OPEN";
        return;
      }
      if (ev.to === "LOST") {
        const f = ev.fields ?? {};
        if (ev.actor?.role !== "coordinator") throw fail("E_LOST_AUTHORITY", `${woId}: LOST event ${ev.seq} was not written by a coordinator`);
        const cited = (index.get(woId) ?? []).some((a) => a.run === f.anchorRun && a.seq === f.anchorSeq && a.hash === f.anchorHash);
        if (!isText(f.anchorRun) || !Number.isInteger(f.anchorSeq) || !isText(f.anchorHash) || f.lastSurvivingSeq !== ev.seq - 1 || !cited) {
          throw fail("E_LOST_NO_ANCHOR", `${woId}: LOST event ${ev.seq} does not cite an anchor (run, seq, hash) of a verified run`);
        }
        if (!Array.isArray(f.supersedes) || !f.supersedes.includes(f.anchorRun)) throw fail("E_LOST_NO_ANCHOR", `${woId}: LOST event ${ev.seq} does not list the runs it supersedes`);
        if (ev.from !== state) throw corrupt(`${woId}: LOST event ${ev.seq} records the wrong state`);
        return;
      }
      if (ev.from !== state || !(EDGES[state] ?? []).includes(ev.to)) throw corrupt(`${woId}: event ${ev.seq} is not an edge of the state table (${state} -> ${ev.to})`);
      state = ev.to;
    });
    const view = { id: woId, state, seq: events.length, lastHash: events.at(-1).hash, events };
    // anchors
    const exempt = exemptBy(events);
    const anchors = (index.get(woId) ?? []).filter((a) => !exempt(a));
    for (const a of anchors) {
      const at = events[a.seq - 1];
      if (at && at.hash !== a.hash) throw corrupt(`${woId}: the event at seq ${a.seq} differs from the anchor of run ${a.run}`, { anchor: a, view });
    }
    const above = anchors.filter((a) => a.seq > view.seq).sort((a, b) => b.seq - a.seq || (a.run < b.run ? -1 : 1));
    if (above.length > 0) {
      throw corrupt(`${woId}: the tail above seq ${view.seq} is missing (anchor of run ${above[0].run} names seq ${above[0].seq})`, { kind: "truncation", anchor: above[0], view });
    }
    return view;
  }

  const publicFold = (view) => ({ id: view.id, state: view.state, seq: view.seq, history: view.events.map((e) => e.event) });

  const slotIds = () => (existsSync(join(root, "wo")) ? readdirSync(join(root, "wo")).filter((n) => SLOT.test(n)).sort(numeric) : []);

  function isBound(slot) {
    const first = readJsonIf(eventPath(slot, 1));
    const fp = first?.fields?.fingerprint;
    return isText(fp) && readJsonIf(bindPath(fp))?.woId === slot;
  }

  // ---------------------------------------------------------------- import (W-4)
  function importFinding(finding, { actor, requestId } = {}) {
    validateFinding(finding);
    if (finding.class === "D") throw fail("E_IMPORT_CLASS_D", "a class D finding is a design decision, not a work order");
    for (const field of ["location", "checkId"]) if (!isText(finding[field])) throw fail("E_FINDING_FIELD", `finding field ${field} is missing or has the wrong shape`, { field });
    if (!isText(actor?.id) || !isText(actor?.role)) throw fail("E_ACTOR", "actor {id, role} is required");
    worktree(finding.subject.repo);
    const fp = sha256Hex(canonical({ requirement: finding.requirement, repo: finding.subject.repo, location: finding.location, checkId: finding.checkId, observed: finding.observed.text }));
    const rid = requestId ?? sha256Hex(`import:${fp}`);
    const body = sha256Hex(canonical(clean(finding)));

    // ADV-5: a known fingerprint with another canonical body is a conflict, never a silent replay of the first body.
    const boundReturn = () => {
      const woId = readJsonIf(bindPath(fp)).woId;
      const first = readJsonIf(eventPath(woId, 1));
      if (first && sha256Hex(canonical(first.fields?.finding)) !== body) throw fail("E_IMPORT_CONFLICT", `${woId} was imported from this fingerprint with another finding body`);
      anchorRunOf(woId, inspect(woId), anchorIndex());
      return { woId };
    };
    const boundNow = () => readJsonIf(bindPath(fp));
    if (boundNow()) return boundReturn();
    let claim = readJsonIf(claimPath(fp));
    if (!claim) {
      mkdirSync(join(root, "fp"), { recursive: true });
      try {
        writeOnce(claimPath(fp), jsonText({ requestId: rid, fingerprint: fp, body }), wopts(claimPath(fp)));
        claim = { requestId: rid, body };
      } catch (error) {
        if (error.code !== "E_EXISTS") throw error;
        if (boundNow()) return boundReturn();
        claim = readJsonIf(claimPath(fp));
      }
    } else if (boundNow()) {
      return boundReturn();
    }
    if (claim.requestId === rid && claim.body !== undefined && claim.body !== body) throw fail("E_IMPORT_CONFLICT", `request ${rid} claimed this fingerprint with another finding body`);
    if (claim.requestId !== rid) throw fail("E_IMPORT_PENDING", `another import (request ${claim.requestId}) of this finding has claimed it and is not bound yet`);

    mkdirSync(join(root, "wo"), { recursive: true });
    let n = slotIds().reduce((m, s) => Math.max(m, Number.parseInt(s.slice(3), 10)), 0) + 1;
    for (;;) {
      try {
        mkdirSync(woDir(`WO-${n}`));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        n += 1;
      }
    }
    const woId = `WO-${n}`;
    const event = { seq: 1, prev: null, at: new Date().toISOString(), actor, requestId: rid, from: null, to: "OPEN", fields: clean({ fingerprint: fp, finding }) };
    writeOnce(eventPath(woId, 1), jsonText(event), wopts(eventPath(woId, 1)));
    try {
      writeOnce(bindPath(fp), jsonText({ woId }), wopts(bindPath(fp)));
    } catch (error) {
      if (error.code !== "E_EXISTS") throw error;
      return boundReturn();
    }
    anchorRunFor(woId);
    return { woId };
  }

  // ---------------------------------------------------------------- derived facts of one WO
  function facts(view) {
    const events = view.events.map((e) => e.event);
    const finding = events[0].fields.finding;
    const assigns = events.filter((e) => e.to === "ASSIGNED" && e.fields?.acceptanceTest);
    const fixedEvents = events.filter((e) => e.to === "FIXED");
    return {
      events,
      finding,
      subject: finding.subject,
      auditor: events[0].actor.id,
      fixer: [...events].reverse().find((e) => e.to === "ASSIGNED" && e.fields?.fixer)?.fields.fixer,
      firstTest: assigns[0]?.fields.acceptanceTest,
      fixedEvents,
      lastFixed: fixedEvents.at(-1),
    };
  }

  const titleIn = (text, title) => [JSON.stringify(title), `'${title}'`, `\`${title}\``].some((q) => text.includes(q));
  function titleAt(g, sha, file, title) {
    const shown = g(["show", `${sha}:${file}`], [0, 128]);
    return shown.status === 0 && titleIn(shown.stdout, title);
  }

  function patchId(g, cwd, a, b) {
    const diff = g(["diff", "--no-ext-diff", "--no-color", a, b]).stdout;
    if (diff === "") return null;
    const withInput = (cmd, args, opts) => (runner ?? spawnSync)(cmd, args, { ...opts, input: diff });
    const r = gitStatus(["patch-id", "--stable"], { cwd, runner: withInput });
    if (r.status !== 0) throw fail("E_GIT", `git patch-id exited ${r.status}: ${r.stderr.trim()}`);
    return r.stdout.trim().split(/\s+/)[0] || null;
  }

  // ---------------------------------------------------------------- per-target rules (every git read before the write)
  function checkAssigned(woId, view, f, actor, fields) {
    if (view.state === "FIXED" || view.state === "VERIFIED") {
      if (!isText(fields.reason)) throw fail("E_REOPEN_REASON", `reopening ${woId} needs a reason`);
      return;
    }
    if (!isText(fields.fixer)) throw fail("E_ASSIGN_FIXER", "ASSIGNED names a fixer");
    if (fields.fixer === f.auditor) throw fail("E_INDEPENDENCE_FIXER", `the fixer ${fields.fixer} is the auditor of ${woId}`);
    if (fields.branch !== `audit/${woId}`) throw fail("E_ASSIGN_BRANCH", `the branch of ${woId} is audit/${woId}, not ${fields.branch}`);
    const cwd = worktree(f.subject.repo);
    const g = gitIn(cwd);
    if (g(["rev-parse", "--verify", "--quiet", `refs/heads/${fields.branch}^{commit}`], [0, 1]).status !== 0) throw fail("E_ASSIGN_BRANCH", `branch ${fields.branch} does not exist`);
    if (g(["merge-base", "--is-ancestor", f.subject.commit, `refs/heads/${fields.branch}`], [0, 1]).status !== 0) throw fail("E_ASSIGN_BRANCH", `${fields.branch} is not cut from the audited ${f.subject.commit}`);
    const t = fields.acceptanceTest;
    if (!t || !isText(t.file) || !isText(t.title) || !isText(t.expectedFailure)) throw fail("E_ASSIGN_TEST", "ASSIGNED needs acceptanceTest {file, title, expectedFailure}");
    let reason;
    try {
      reason = new RegExp(t.expectedFailure);
    } catch {
      throw fail("E_ASSIGN_EXPECTED", `expectedFailure ${t.expectedFailure} is not a regular expression`);
    }
    const sample = HARNESS_SAMPLES.find((s) => reason.test(s));
    if (sample) throw fail("E_ASSIGN_EXPECTED", `expectedFailure ${t.expectedFailure} matches the harness sample ${sample}`);
    if (f.firstTest && canonical(f.firstTest) !== canonical({ file: t.file, title: t.title, expectedFailure: t.expectedFailure })) {
      throw fail("E_ASSIGN_EXPECTED_CHANGED", "the acceptance test and its expected failure are immutable after the first ASSIGN");
    }
  }

  function checkFixed(woId, f, actor, fields) {
    if (actor.id !== f.fixer) throw fail("E_ACTOR_NOT_FIXER", `${actor.id} is not the current fixer ${f.fixer} of ${woId}`);
    if (!fields.red || !fields.green || !isText(fields.red.sha) || !isText(fields.green.sha)) throw fail("E_RED_PROOF_MISSING", "FIXED needs red {sha, record} and green {sha, record}");
    if (f.fixedEvents.some((e) => e.fields.green?.sha === fields.green.sha)) throw fail("E_FIX_REUSED", `the fix ${fields.green.sha} was used by an earlier FIXED of ${woId}`);
    validateRedProof({ cwd: worktree(f.subject.repo), auditedSha: f.subject.commit, acceptanceTest: f.firstTest, red: fields.red, green: fields.green }, { runner });
  }

  function deltasOf(woId) {
    const dir = join(root, "delta", woId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => EVENT_FILE.test(n) && !isTempName(n)).sort(numeric).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  }

  /** The bound WOs of `family` other than `self` that are not VOIDED, in any state (a frozen WO counts: fail closed). */
  function familySiblings(family, self, index) {
    let live = 0;
    for (const slot of slotIds()) {
      if (slot === self || !isBound(slot)) continue;
      try {
        const v = inspect(slot, index);
        if (v.events[0].event.fields.finding.family === family && v.state !== "VOIDED") live += 1;
      } catch (error) {
        if (!FROZEN_CODES.has(error.code)) throw error;
        if (readJsonIf(eventPath(slot, 1))?.fields?.finding?.family === family) live += 1;
      }
    }
    return live;
  }

  function checkVerified(woId, f, actor, fields, index) {
    if (f.events.some((e) => e.to === "ASSIGNED" && e.fields?.fixer === actor.id)) throw fail("E_INDEPENDENCE_VERIFIER", `the verifier ${actor.id} was assigned as a fixer of ${woId}`);
    const F = f.lastFixed.fields.green.sha;
    const R = f.lastFixed.fields.red.sha;
    const deltas = deltasOf(woId);
    const run = deltas.at(-1);
    if (!run || run.plan?.base !== f.subject.commit || run.plan?.head !== F) throw fail("E_VERIFY_SUBJECT", `the newest delta run of ${woId} is not bound to the audited sha ${f.subject.commit} and the fix ${F}`);
    if (run.plan.binding === "BLOCKED") throw fail("E_VERIFY_BINDING", "the delta run is BLOCKED");
    const must = run.plan.mustRun ?? [];
    if (!must.includes(`wo:${woId}`)) throw fail("E_VERIFY_REPRO", `the delta run does not run the repro wo:${woId}`);
    const status = new Map((run.results ?? []).map((r) => [r.id, r.status]));
    for (const id of must) if (!status.has(id)) throw fail("E_VERIFY_MISSING", `the delta run has no result for ${id}`);
    for (const id of must) if (status.get(id) !== "PASS") throw fail("E_VERIFY_FAIL", `${id} is ${status.get(id)} in the delta run`);
    const failedBefore = new Set(deltas.slice(0, -1).filter((d) => d.plan?.head === F).flatMap((d) => (d.results ?? []).filter((r) => r.status === "FAIL").map((r) => r.id)));
    const flipped = must.filter((id) => failedBefore.has(id));
    if (flipped.length > 0) throw fail("E_NONDETERMINISTIC", `${flipped.join(", ")} failed on the same fix ${F} earlier and passes now`);
    if (1 + familySiblings(f.finding.family, woId, index) >= 2) {
      const check = fields.permanentCheck;
      if (!check || !isText(check.file) || !isText(check.title) || !isTestOnly(check.file)) throw fail("E_ROOT_CAUSE", `the family ${f.finding.family} has two non-VOIDED WOs: VERIFIED needs a permanent test-only check {file, title}`);
      const g = gitIn(worktree(f.subject.repo));
      if (!titleAt(g, R, check.file, check.title) || !titleAt(g, F, check.file, check.title)) throw fail("E_ROOT_CAUSE_ABSENT", `the permanent check ${check.file} :: ${JSON.stringify(check.title)} is absent at the red or the fix commit`);
    }
  }

  /** ADV-12: the receipt dir must resolve (realpath) under <kauroRoot>/tools/review/out, kauroRoot from repos.json. */
  function receiptUnderReviewOut(dir) {
    const kauroRoot = readJsonIf(join(root, "repos.json"))?.kauroRoot;
    if (!isText(kauroRoot)) throw fail("E_REVIEW_RECEIPT", "repos.json names no kauroRoot: a review receipt cannot be located");
    let real;
    let out;
    try {
      real = realpathSync.native(dir);
      out = realpathSync.native(join(kauroRoot, "tools", "review", "out"));
    } catch (error) {
      throw fail("E_REVIEW_RECEIPT", `the review receipt ${dir} or ${kauroRoot}/tools/review/out cannot be resolved: ${error.code ?? error.message}`);
    }
    const rel = relative(out, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw fail("E_REVIEW_RECEIPT", `the review receipt ${real} is not under ${out}`);
  }

  function checkClosed(woId, f, fields) {
    const F = f.lastFixed.fields.green.sha;
    const cwd = worktree(f.subject.repo);
    const g = gitIn(cwd);
    let fetched;
    try {
      fetched = gitStatus(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd, runner });
    } catch (error) {
      throw fail("E_CLOSE_MAIN_UNRESOLVED", `git fetch origin main did not finish: ${error.message}`);
    }
    if (fetched.status !== 0) throw fail("E_CLOSE_MAIN_UNRESOLVED", `git fetch origin main failed: ${fetched.stderr.trim()}`);
    const main = g(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]).stdout.trim();
    let onMain = g(["merge-base", "--is-ancestor", F, main], [0, 1]).status === 0;
    if (!onMain) {
      const want = patchId(g, cwd, f.subject.commit, F);
      const commits = g(["rev-list", "--first-parent", `${f.subject.commit}..${main}`]).stdout.split("\n").filter(Boolean);
      for (const c of commits) {
        if (g(["rev-parse", "--verify", "--quiet", `${c}^1`], [0, 1]).status !== 0) continue;
        if (want !== null && patchId(g, cwd, `${c}^1`, c) === want) {
          onMain = true;
          break;
        }
      }
    }
    if (!onMain) throw fail("E_CLOSE_NOT_ON_MAIN", `the fix ${F} is not on origin/main (${main}) by ancestry or patch-id`);
    if (!titleAt(g, main, f.firstTest.file, f.firstTest.title)) throw fail("E_CLOSE_TITLE", `${f.firstTest.file} at origin/main has no test titled ${JSON.stringify(f.firstTest.title)}`);
    if (!isText(fields.toolRule) || !(/^NOT_GENERIC: \S/.test(fields.toolRule) || /^\S.* :: ".+"$/.test(fields.toolRule))) throw fail("E_CLOSE_TOOL_RULE", "CLOSED needs a toolRule: `file :: \"title\"` or `NOT_GENERIC: <reason>`");
    const computed = { mainSha: main };
    if (f.finding.tier === 1) {
      if (!isText(fields.reviewReceipt)) throw fail("E_CLOSE_REVIEW", `${woId} is tier 1: CLOSED needs the lane or package review receipt of the fix`);
      const dir = resolve(fields.reviewReceipt);
      receiptUnderReviewOut(dir);
      const m = RECEIPT.exec(basename(dir));
      if (!m || Number.parseInt(m[2], 10) !== Number.parseInt(woId.slice(3), 10)) throw fail("E_CLOSE_REVIEW_LABEL", `the receipt ${basename(dir)} is not labelled wo-${woId.slice(3)}-(lane|pkg)-review`);
      const resolved = gitStatus(["rev-parse", "--verify", `${m[4]}^{commit}`], { cwd, runner });
      if (resolved.status !== 0) throw fail("E_CLOSE_REVIEW_AMBIGUOUS", `the review sha ${m[4]} is ambiguous or unknown: ${resolved.stderr.trim()}`);
      const reviewed = resolved.stdout.trim();
      const names = ["review.json", "codex.log", "prompt.md"];
      for (const n of names) if (!existsSync(join(dir, n))) throw fail("E_CLOSE_REVIEW_FILES", `the receipt ${basename(dir)} has no ${n}`);
      let verdict;
      try {
        verdict = JSON.parse(readFileSync(join(dir, "review.json"), "utf8")).verdict;
      } catch {
        verdict = undefined;
      }
      if (!ACCEPTING.includes(verdict)) throw fail("E_CLOSE_REVIEW_VERDICT", `the review verdict is ${verdict}, not ACCEPT or ACCEPT_WITH_MINOR`);
      const want = patchId(g, cwd, f.subject.commit, F);
      if (want === null || patchId(g, cwd, f.subject.commit, reviewed) !== want) throw fail("E_CLOSE_REVIEW_PATCH", `the review covers another patch than ${f.subject.commit}..${F}`);
      computed.reviewSha256 = Object.fromEntries(names.map((n) => [n, sha256Hex(readFileSync(join(dir, n)))]));
    }
    return computed;
  }

  // ---------------------------------------------------------------- transitions (W-3)
  function transition(woId, input = {}) {
    const { to, rev, requestId, actor, ...rest } = input;
    const fields = clean(rest);
    if (!isText(requestId)) throw fail("E_REQUEST_ID", "a request id is required");
    if (!isText(actor?.id) || !isText(actor?.role)) throw fail("E_ACTOR", "actor {id, role} is required");
    const index = anchorIndex();
    const view = inspect(woId, index);
    const history = view.events.map((e) => e.event);
    const seen = history.find((e) => e.requestId === requestId);
    if (seen) {
      if (!sameBody(seen, to, actor, fields)) throw fail("E_CONFLICT", `request ${requestId} was committed with another body`);
      return { event: seen, anchorRun: anchorRunOf(woId, view, index) };
    }
    if (rev !== view.seq) throw fail("E_CONFLICT", `${woId} is at revision ${view.seq}, not ${rev}`);
    if (!(EDGES[view.state] ?? []).includes(to)) throw fail("E_TRANSITION", `${view.state} -> ${to} is not an edge of the state table`);
    if (!isBound(woId)) throw fail(to === "ASSIGNED" ? "E_ASSIGN_UNBOUND" : "E_NOT_LIVE", `${woId} is an unbound import slot`);
    const f = facts(view);
    let computed = {};
    if (to === "ASSIGNED") checkAssigned(woId, view, f, actor, fields);
    else if (to === "FIXED") checkFixed(woId, f, actor, fields);
    else if (to === "VERIFIED") checkVerified(woId, f, actor, fields, index);
    else if (to === "CLOSED") computed = checkClosed(woId, f, fields);
    else if (to === "VOIDED") {
      const r2 = fields.r2;
      if (actor.role !== "coordinator" || !isText(r2?.doc) || !isText(r2?.heading)) throw fail("E_VOID_AUTHORITY", "VOIDED is a coordinator act citing the R2 {doc, heading} that makes the finding invalid");
    }
    const event = { seq: view.seq + 1, prev: view.lastHash, at: new Date().toISOString(), actor, requestId, from: view.state, to, fields: { ...fields, ...computed } };
    const committed = commit(woId, event);
    return { event: committed, anchorRun: anchorRunFor(woId) };
  }

  /** The one writeOnce of an event: a second writer at the same revision is E_CONFLICT (or the same request id: its event). */
  function commit(woId, event) {
    try {
      writeOnce(eventPath(woId, event.seq), jsonText(event), wopts(eventPath(woId, event.seq)));
    } catch (error) {
      if (error.code !== "E_EXISTS") throw error;
      const winner = readJsonIf(eventPath(woId, event.seq));
      if (winner && winner.requestId === event.requestId && sameBody(winner, event.to, event.actor, event.fields)) return winner;
      throw fail("E_CONFLICT", `${woId} already has an event ${event.seq}`);
    }
    return event;
  }

  // ---------------------------------------------------------------- LOST (W-2b)
  function lost(woId, { anchorRun, actor, requestId } = {}) {
    if (actor?.role !== "coordinator" || !isText(actor?.id)) throw fail("E_LOST_AUTHORITY", "LOST is a coordinator act");
    if (!isText(anchorRun)) throw fail("E_LOST_AUTHORITY", "LOST cites the anchor run it recovers against");
    const index = anchorIndex();
    const cited = (index.get(woId) ?? []).find((a) => a.run === anchorRun);
    if (!cited) throw fail("E_LOST_AUTHORITY", `run ${anchorRun} is not a verified run that anchors ${woId}`);
    const rid = requestId ?? sha256Hex(`lost:${woId}:${anchorRun}`);
    let truncation;
    try {
      const view = inspect(woId, index);
      const seen = view.events.map((e) => e.event).find((e) => e.requestId === rid && e.to === "LOST");
      if (seen) return { event: seen, anchorRun: anchorRunOf(woId, view, index) };
      throw fail("E_LOST_NOT_TRUNCATION", `${woId} is not frozen: nothing to recover`);
    } catch (error) {
      if (error.code !== "E_LEDGER_CORRUPT") throw error;
      truncation = error;
    }
    if (truncation.kind !== "truncation") throw fail("E_LOST_NOT_TRUNCATION", `${woId} is tampered, not truncated: ${truncation.message}`);
    if (cited.seq !== truncation.anchor.seq || cited.hash !== truncation.anchor.hash) throw fail("E_LOST_NOT_TRUNCATION", `run ${anchorRun} is not the highest anchor of ${woId}`);
    const v = truncation.view;
    const supersedes = [...new Set((index.get(woId) ?? []).filter((a) => a.seq > v.seq && a.seq <= cited.seq).map((a) => a.run))].sort();
    const event = {
      seq: v.seq + 1,
      prev: v.lastHash,
      at: new Date().toISOString(),
      actor,
      requestId: rid,
      from: v.state,
      to: "LOST",
      fields: { anchorRun, anchorSeq: cited.seq, anchorHash: cited.hash, lastSurvivingSeq: v.seq, supersedes },
    };
    const committed = commit(woId, event);
    return { event: committed, anchorRun: anchorRunFor(woId) };
  }

  // ---------------------------------------------------------------- reads
  const fold = (woId) => publicFold(inspect(woId));
  const list = () => slotIds().filter(isBound);

  function summary() {
    const index = anchorIndex();
    const workOrders = [];
    const frozen = [];
    const anchors = {};
    const lostEvents = [];
    const blocks = {};
    const counts = { byFamily: {}, byState: {}, byTier: {}, byKind: {} };
    const blocked = new Set();
    const bump = (bucket, key) => {
      counts[bucket][key] = (counts[bucket][key] ?? 0) + 1;
    };
    // ADV-2: every WO any verified run anchors is listed, whether or not its folder and binding are still on disk.
    const ids = [...new Set([...list(), ...index.keys()])].sort(numeric);
    for (const id of ids) {
      let state = "FROZEN";
      let finding = readJsonIf(eventPath(id, 1))?.fields?.finding ?? {};
      const attempts = [];
      try {
        const view = inspect(id, index);
        const history = view.events.map((e) => e.event);
        state = view.state;
        finding = history[0].fields.finding;
        for (const e of history) {
          if (e.to === "FIXED") attempts.push({ fixSha: e.fields.green.sha, reopenedReason: null });
          else if (e.to === "ASSIGNED" && (e.from === "FIXED" || e.from === "VERIFIED") && attempts.length > 0) attempts.at(-1).reopenedReason = e.fields.reason;
          else if (e.to === "LOST") lostEvents.push({ woId: id, ...e.fields });
        }
        const candidate = { seq: view.seq, hash: view.lastHash };
        guardAnchor(id, candidate, view.events, index);
        anchors[id] = candidate;
        if (blockOf(view)) blocked.add(blockOf(view));
        blocks[id] = blockOf(view);
      } catch (error) {
        if (!FROZEN_CODES.has(error.code)) throw error;
        frozen.push(id);
        if (error.kind === "missing") {
          const latest = [...(index.get(id) ?? [])].sort((a, b) => a.seq - b.seq || (a.run < b.run ? -1 : 1)).at(-1);
          if (latest?.blocks) blocked.add(latest.blocks);
        }
        if (error.kind === "truncation") {
          const candidate = { seq: error.view.seq, hash: error.view.lastHash };
          try {
            guardAnchor(id, candidate, error.view.events, index);
            anchors[id] = candidate;
          } catch (guard) {
            if (guard.code !== "E_LEDGER_CORRUPT") throw guard;
          }
        }
      }
      workOrders.push({ id, state, family: finding.family ?? null, tier: finding.tier ?? null, kind: finding.kind ?? null, attempts });
      bump("byFamily", finding.family ?? "unknown");
      bump("byState", state);
      bump("byTier", finding.tier ?? "unknown");
      bump("byKind", finding.kind ?? "unknown");
    }
    const unboundSlots = slotIds().filter((s) => !isBound(s) && !index.has(s));
    const body = clean({ workOrders, counts, blockedCapabilities: [...blocked].sort(), lost: lostEvents, anchors, unboundSlots, frozen });
    const runId = writeRun({ "anchors.json": jsonText(anchors), "blocks.json": jsonText(blocks), "summary.json": `${JSON.stringify(body, null, 2)}\n` });
    return { runId, summary: body };
  }

  return { importFinding, transition, lost, fold, list, summary };
}

// ------------------------------------------------------------------- CLI
const COMMAND_TO = { assign: "ASSIGNED", reopen: "ASSIGNED", fix: "FIXED", verify: "VERIFIED", close: "CLOSED", void: "VOIDED" };
const BLOCKED_CODES = new Set(["E_LEDGER_CORRUPT", "E_LOST_NO_ANCHOR", "E_IMPORT_PENDING", "E_CLOSE_MAIN_UNRESOLVED", "E_VERIFY_BINDING", "E_GIT_TIMEOUT"]);

const UNKNOWN_OUTCOME = new Set(["E_IO", "E_GIT", "E_SIMULATED_CRASH"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

const jsonArg = (text) => (text.trim().startsWith("{") || text.trim().startsWith("[") ? JSON.parse(text) : JSON.parse(readFileSync(text, "utf8")));

export function main(argv = process.argv.slice(2), out = { log: console.log, error: console.error }) {
  const { positional, flags } = parseArgs(argv);
  const [command, target] = positional;
  try {
    const ledger = openLedger({ root: flags.root });
    // ADV-3: the actor is explicit (--actor <id> --role <role>); there is no default role. show and summary need neither.
    const needsActor = command === "import" || command === "lost" || command in COMMAND_TO;
    if (needsActor && (!isText(flags.actor) || !isText(flags.role))) throw fail("E_USAGE", "--actor <id> and --role <role> are required");
    const actor = { id: flags.actor, role: flags.role };
    if (command === "import") out.log(JSON.stringify(ledger.importFinding(jsonArg(target), { actor, requestId: flags["request-id"] })));
    else if (command === "show") out.log(JSON.stringify(ledger.fold(target), null, 2));
    else if (command === "summary") out.log(JSON.stringify(ledger.summary(), null, 2));
    else if (command === "lost") out.log(JSON.stringify(ledger.lost(target, { anchorRun: flags.anchor, actor, requestId: flags["request-id"] })));
    else if (COMMAND_TO[command]) {
      const to = COMMAND_TO[command];
      const fields = flags.fields ? jsonArg(flags.fields) : {};
      // ADV-4: the expected revision is explicit and part of the default request id.
      if (!/^\d+$/.test(flags.rev ?? "")) throw fail("E_USAGE", "--rev <expected revision> is required");
      const rev = Number.parseInt(flags.rev, 10);
      const requestId = flags["request-id"] ?? sha256Hex(canonical({ woId: target, to, actor, rev, fields }));
      out.log(JSON.stringify(ledger.transition(target, { to, rev, requestId, actor, ...fields })));
    } else throw fail("E_USAGE", "usage: work-orders.mjs <import|assign|fix|verify|close|void|reopen|lost|show|summary> --root <dir> [--actor id --role role] [--rev n] [--request-id id] [--fields json|file] [--anchor run]");
    return 0;
  } catch (error) {
    out.error(`${/^E_/.test(error.code ?? "") ? error.code : "E_UNEXPECTED"}: ${error.message}`);
    // ADV-13: exit 1 only for a refusal that happened before any write; an unknown outcome (E_IO, E_GIT, a codeless or system error) is 2.
    return BLOCKED_CODES.has(error.code) || UNKNOWN_OUTCOME.has(error.code) || !/^E_/.test(error.code ?? "") ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();

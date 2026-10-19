// removeTemp (tools/temp-removal.mjs) and every removal that goes through it. The site cells replay, through the eperm-fault
// preload, the two shapes Codex's PR #112 round-2 run recorded on Windows: a tree left intact, and a tree emptied down to
// directories. Fixture trees here are removed entry by entry: a recursive delete would be a new S088 site.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { HOLD_BOUND_MS, entries, removeTemp, restartManagerHolders } from "../temp-removal.mjs";

const repo = join(import.meta.dirname, "..", "..");
const windows = process.platform === "win32";
const WINDOWS_ONLY = !windows && "removeTemp retries only on Windows; elsewhere every removal error is thrown as before";
const eperm = () => Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" });

function quiet(extra = {}) {
  const lines = [];
  return { lines, options: { platform: "win32", sleep: () => {}, log: (line) => lines.push(line), ...extra } };
}

// A node process with the fault preload; NODE_TEST_CONTEXT would make a nested node --test report to this runner.
function underFault(fault, args) {
  const env = { ...process.env, KAURO_EPERM_FAULT: JSON.stringify(fault) };
  delete env.NODE_TEST_CONTEXT;
  const fixture = pathToFileURL(join(import.meta.dirname, "fixtures", "eperm-fault.mjs")).href;
  const result = spawnSync(process.execPath, ["--import", fixture, ...args], { cwd: repo, env, encoding: "utf8", windowsHide: true });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}
const moduleUrl = (rel) => JSON.stringify(pathToFileURL(join(repo, rel)).href);

// A child whose current directory is `cwd`, alive until killed.
async function holderIn(cwd, script = "") {
  const child = spawn(process.execPath, ["-e", `${script}process.stdout.write("ready"); setInterval(() => {}, 1000);`], { cwd, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  return { pid: child.pid, stop: () => new Promise((resolve) => { child.once("close", resolve); child.kill(); }) };
}

test("off Windows, or for any error but EPERM/EBUSY/ENOTEMPTY, a removal fails as before: one call, nothing printed", () => {
  for (const [platform, error] of [["linux", eperm()], ["darwin", eperm()], ["win32", Object.assign(new Error("EACCES"), { code: "EACCES" })]]) {
    const { lines, options } = quiet({ platform, holders: () => assert.fail("no fact is sought") });
    let calls = 0;
    assert.throws(() => removeTemp("x", () => { calls++; throw error; }, options), (thrown) => thrown === error, platform);
    assert.equal(calls, 1);
    assert.deepEqual(lines, []);
  }
  let calls = 0;
  removeTemp("x", () => { calls++; }, quiet({ holders: () => assert.fail("no failure, no query") }).options);
  assert.equal(calls, 1);
});

test("only directories left: removed bottom-up with rmdir, never by repeating the recursive removal, and printed", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  mkdirSync(join(root, "repository", "objects"), { recursive: true });
  mkdirSync(join(root, "scratch"));
  const { lines, options } = quiet({ holders: () => assert.fail("no file is left to ask about") });
  let calls = 0;
  removeTemp(root, () => { calls++; throw eperm(); }, options);
  assert.equal(calls, 1);
  assert.equal(existsSync(root), false);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `temp removal: ${root}: EPERM; only directories remain (3 below the root), no file; retrying for at most ${HOLD_BOUND_MS} ms`);
  assert.match(lines[1], /: removed at retry 1, \d+ ms after the first failure$/);
});

test("a hold that outlasts the bound fails with what is left and the retries made; a query that fails is never read as no holder", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  writeFileSync(join(root, "held.txt"), "x");
  try {
    let clock = 0;
    const asked = [];
    let unlinks = 0;
    const { lines, options } = quiet({ holders: (files, { timeoutMs }) => { asked.push(timeoutMs); return []; }, now: () => clock,
      sleep: () => { clock += 1000; }, fs: { unlink: () => { unlinks++; throw eperm(); }, rmdir: rmdirSync } });
    let calls = 0;
    assert.throws(() => removeTemp(root, () => { calls++; throw eperm(); }, options),
      (error) => error.message === `EPERM, Permission denied; still held ${HOLD_BOUND_MS} ms after the first failure (5 retries); left: held.txt`
        && error.code === "EPERM" && error.cause.code === "EPERM");
    assert.equal(calls, 1, "the recursive removal is never repeated");
    assert.equal(unlinks, 5, "five retries, one clock second apart");
    assert.deepEqual(asked, [HOLD_BOUND_MS], "the query is given what is left of the bound");
    assert.equal(lines.length, 1, "the retry was announced; no success line");
    calls = 0;
    const unknown = quiet({ holders: () => { throw new Error("powershell.exe not found"); } });
    assert.throws(() => removeTemp(root, () => { calls++; throw eperm(); }, unknown.options),
      { message: "EPERM, Permission denied; not retried: who holds its 1 remaining files is unknown (powershell.exe not found); left: held.txt" });
    assert.equal(calls, 1);
    assert.deepEqual(unknown.lines, []);
  } finally { unlinkSync(join(root, "held.txt")); rmdirSync(root); }
});

// R114-1 (Codex, PR #114 round 1): at 03d1a0c3 the new-entry check ran only after a retry failed, so a retry that succeeded
// erased an entry written during the Restart Manager query.
test("an entry that appears after the failure stops the retry before anything is removed, and is kept: something is still writing", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  writeFileSync(join(root, "old.txt"), "x");
  try {
    const { options } = quiet({ holders: () => { writeFileSync(join(root, "new.txt"), "x"); return []; } });
    let calls = 0;
    assert.throws(() => removeTemp(root, () => { calls++; throw eperm(); }, options),
      { message: "EPERM, Permission denied; not retried further: new.txt appeared after the failure, so something is still writing there; left: new.txt, old.txt" });
    assert.equal(calls, 1);
    assert.equal(existsSync(join(root, "new.txt")), true);
    assert.equal(existsSync(join(root, "old.txt")), true);
  } finally { unlinkSync(join(root, "old.txt")); unlinkSync(join(root, "new.txt")); rmdirSync(root); }
});

test("an entry a retry removed that comes back stops the retry: it is not removed a second time", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  writeFileSync(join(root, "old.txt"), "x");
  try {
    const ebusy = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    const { options } = quiet({ holders: () => [], fs: { unlink: unlinkSync, rmdir: () => { writeFileSync(join(root, "old.txt"), "again"); throw ebusy(); } } });
    assert.throws(() => removeTemp(root, () => { throw eperm(); }, options),
      { message: "EPERM, Permission denied; not retried further: old.txt appeared after the failure, so something is still writing there; left: old.txt" });
    assert.equal(existsSync(join(root, "old.txt")), true);
  } finally { unlinkSync(join(root, "old.txt")); rmdirSync(root); }
});

// R114-2 (Codex, PR #114 round 1): at 03d1a0c3 the bound was checked only after a failed retry, so a query that outlasted it was
// followed by a removal, and the query itself had no timeout.
test("no retry starts once the bound has passed, however long the query took", () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  writeFileSync(join(root, "old.txt"), "x");
  try {
    let clock = 0;
    const { lines, options } = quiet({ now: () => clock, holders: () => { clock += HOLD_BOUND_MS; return []; }, fs: { unlink: () => assert.fail("no retry after the bound"), rmdir: () => assert.fail("no retry after the bound") } });
    let calls = 0;
    assert.throws(() => removeTemp(root, () => { calls++; throw eperm(); }, options),
      { message: `EPERM, Permission denied; still held ${HOLD_BOUND_MS} ms after the first failure (0 retries); left: old.txt` });
    assert.equal(calls, 1);
    assert.equal(lines.length, 1);
    assert.equal(existsSync(join(root, "old.txt")), true);
  } finally { unlinkSync(join(root, "old.txt")); rmdirSync(root); }
});

test("a Restart Manager query is given a timeout, and one that does not answer in time is an unknown answer, never no holder", () => {
  let given;
  const run = (file, args, options) => { given = options.timeout; return { error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }), pid: 77, status: null }; };
  assert.throws(() => restartManagerHolders(["a.txt"], { run, timeoutMs: 1234 }),
    { message: "Restart Manager query did not answer within 1234 ms; powershell.exe 77 was stopped" });
  assert.equal(given, 1234);
  restartManagerHolders(["a.txt"], { run: (file, args, options) => { given = options.timeout; return { status: 0, stdout: "[]" }; } });
  assert.equal(given, HOLD_BOUND_MS, "never unbounded, even called on its own");
});

test("Windows: a live process whose current directory is in the tree keeps it, and the retry ends at the bound naming it", { skip: WINDOWS_ONLY }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  mkdirSync(join(root, "repository"));
  writeFileSync(join(root, "a.txt"), "x");
  const holder = await holderIn(join(root, "repository"));
  try {
    const { lines, options } = quiet({ platform: process.platform, boundMs: 300, sleep: undefined });
    // the caller's own removal, entry by entry: Windows refuses the directory with EBUSY while it is a process's current directory
    const remove = () => { try { unlinkSync(join(root, "a.txt")); } catch (error) { if (error.code !== "ENOENT") throw error; } rmdirSync(join(root, "repository")); rmdirSync(root); };
    assert.throws(() => removeTemp(root, remove, options), (error) => /^EBUSY: .*; still held 300 ms after the first failure \(\d+ retries\); left: repository$/.test(error.message));
    assert.match(lines[0], /: EBUSY; only directories remain \(1 below the root\), no file; retrying for at most 300 ms$/);
    assert.equal(existsSync(join(root, "repository")), true);
  } finally {
    await holder.stop();
    rmdirSync(join(root, "repository"));
    rmdirSync(root);
  }
});

test("Windows: Restart Manager names a live process holding a remaining file, and removeTemp does not retry past it", { skip: WINDOWS_ONLY }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  const file = join(root, "locked.txt");
  writeFileSync(file, "x");
  const holder = await holderIn(root, `require("node:fs").openSync(${JSON.stringify(file)}, "r");`);
  try {
    assert.deepEqual(restartManagerHolders([file]).map((h) => Number(h.split(" ")[0])), [holder.pid]);
    let calls = 0;
    assert.throws(() => removeTemp(root, () => { calls++; throw eperm(); }, { log: () => assert.fail("nothing is retried") }),
      (error) => error.message.startsWith(`EPERM, Permission denied; not retried: Restart Manager names ${holder.pid} `) && error.message.endsWith("; left: locked.txt"));
    assert.equal(calls, 1);
  } finally { await holder.stop(); }
  assert.deepEqual(restartManagerHolders([file]), []);
  unlinkSync(file);
  rmdirSync(root);
});

// R114-1 with a real writer and the real query: the writer creates new.txt while Restart Manager is being asked.
test("Windows: a live process that writes into the tree during the Restart Manager query is neither erased nor hidden", { skip: WINDOWS_ONLY }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  writeFileSync(join(root, "old.txt"), "x");
  const go = `${root}.go`, made = join(root, "new.txt");
  const writer = await holderIn(tmpdir(), `const fs = require("node:fs"); const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(poll); fs.writeFileSync(${JSON.stringify(made)}, "x"); } }, 5);`);
  try {
    const holders = (files, options) => {
      const held = restartManagerHolders(files, options);
      writeFileSync(go, "");
      for (const until = performance.now() + 5_000; !existsSync(made) && performance.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      return held;
    };
    // the caller's removal deletes whatever is there, as a recursive rmSync would, once its first attempt has failed
    let calls = 0;
    const remove = () => { if (++calls === 1) throw eperm(); for (const path of entries(root).files) unlinkSync(path); rmdirSync(root); };
    assert.throws(() => removeTemp(root, remove, { holders, log: () => {} }),
      { message: "EPERM, Permission denied; not retried further: new.txt appeared after the failure, so something is still writing there; left: new.txt, old.txt" });
    assert.equal(calls, 1, "the caller's removal is not repeated");
    assert.equal(existsSync(made), true);
    process.kill(writer.pid, 0);
  } finally {
    await writer.stop();
    for (const file of [join(root, "old.txt"), made, go]) { try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    rmdirSync(root);
  }
});

// R114-2 with the real query: it is stopped at its timeout, its process has exited when it returns, and the answer is unknown.
test("Windows: a Restart Manager query that outlasts its timeout is stopped, and no process of it is left", { skip: WINDOWS_ONLY }, () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-temp-removal-"));
  const file = join(root, "a.txt");
  writeFileSync(file, "x");
  try {
    let pid;
    assert.throws(() => restartManagerHolders([file], { timeoutMs: 1 }), (error) => {
      pid = Number(/^Restart Manager query did not answer within 1 ms; powershell\.exe (\d+) was stopped$/.exec(error.message)?.[1]);
      return pid > 0;
    });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    let calls = 0;
    assert.throws(() => removeTemp(root, () => { calls++; throw eperm(); }, { boundMs: 1, log: () => assert.fail("nothing is retried") }),
      (error) => /^EPERM, Permission denied; not retried: who holds its 1 remaining files is unknown \(Restart Manager query did not answer within 1 ms; powershell\.exe \d+ was stopped\); left: a\.txt$/.test(error.message));
    assert.equal(calls, 1);
    assert.equal(existsSync(file), true);
  } finally { unlinkSync(file); rmdirSync(root); }
});

// The sites. f839f4c7 lets each of these EPERMs escape: command() and runTest() throw, red-proof loses its report, the test
// fixtures' cleanup fails the test that used them.
test("Windows: command() and runTest() keep their result when their capture directory is held transiently, and print the retry", { skip: WINDOWS_ONLY }, () => {
  const command = underFault({ prefix: "kauro-command-", left: ["."] }, ["--input-type=module", "-e",
    `import { command } from ${moduleUrl("tools/test-runner.mjs")}; const r = command(process.execPath, ["-e", "console.log(42)"], process.cwd()); console.log(JSON.stringify(r.output));`]);
  assert.equal(command.status, 0, command.output);
  assert.equal(command.stdout.trim(), JSON.stringify("42\n"));
  assert.match(command.stderr, /temp removal: .*kauro-command-\w+: EPERM; only directories remain \(0 below the root\), no file; retrying/);
  assert.match(command.stderr, /kauro-command-\w+: removed at retry 1, /);
  const events = underFault({ prefix: "kauro-events-", left: ["."] }, ["--input-type=module", "-e",
    `import { runTest } from ${moduleUrl("tools/test-runner.mjs")}; const r = await runTest({ file: "passing", dir: process.cwd(), compiled: ${JSON.stringify(join(repo, "tools", "test", "fixtures", "passing.fixture.mjs"))} }); console.log(JSON.stringify([r.status, r.summary.leafPassed]));`]);
  assert.equal(events.status, 0, events.output);
  assert.equal(events.stdout.trim(), "[0,1]");
  assert.match(events.stderr, /kauro-events-\w+: removed at retry 1, /);
});

test("Windows: the audit fixture's cleanup survives a held work directory (emptied tree)", { skip: WINDOWS_ONLY }, () => {
  const r = underFault({ prefix: "audit-kit-", left: ["work/kauro-platform"] }, ["--input-type=module", "-e",
    `import { existsSync } from "node:fs"; import { makeFixture } from ${moduleUrl("tools/test/audit-fixture.mjs")}; const fx = makeFixture(); fx.cleanup(); console.log(existsSync(fx.dir));`]);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout.trim(), "false");
  assert.match(r.stderr, /audit-kit-\w+: EPERM; only directories remain \(2 below the root\), no file; retrying/);
});

for (const [file, prefix, pattern] of [
  ["ledger-touch.test.mjs", "touch-", "PR18-6 \\(T4\\)"],
  ["changed-cells.test.mjs", "kauro-changed-cells-", "runs only the changed race cell"],
]) {
  test(`Windows: ${file}'s fixture cleanup survives a held tree left intact, after Restart Manager names no holder`, { skip: WINDOWS_ONLY }, () => {
    const r = underFault({ prefix, left: null }, ["--test", "--test-reporter=spec", `--test-name-pattern=${pattern}`, join("tools", "test", file)]);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /ℹ pass 1/);
    assert.match(r.output, new RegExp(`${prefix}\\w+: EPERM; Restart Manager names no holder of its \\d+ remaining files; retrying`));
    assert.match(r.output, new RegExp(`${prefix}\\w+: removed at retry 1, `));
  });
}

test("the fault preload forwards every other removal and fails only the first one it is aimed at", () => {
  const r = underFault({ prefix: "kauro-fault-probe-", left: ["kept"] }, ["--input-type=module", "-e",
    `import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const other = mkdtempSync(join(tmpdir(), "kauro-other-")); mkdirSync(join(other, "x")); rmSync(other, { recursive: true, force: true });
const probe = mkdtempSync(join(tmpdir(), "kauro-fault-probe-")); mkdirSync(join(probe, "a"));
let code; try { rmSync(probe, { recursive: true, force: true }); } catch (error) { code = error.code; }
const left = readdirSync(probe); rmSync(probe, { recursive: true, force: true });
console.log(JSON.stringify([existsSync(other), code, left, existsSync(probe)]));`]);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout.trim(), JSON.stringify([false, "EPERM", ["kept"], false]));
});

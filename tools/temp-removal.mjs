// Removal of a temporary tree that a gate or a test made for itself, with one Windows-only allowance for a transient hold.
// Windows refuses to delete a directory while it is some process's current directory, and Node 24's rmSync reports that as
// "EPERM, Permission denied" after deleting what it could; it never retries that error (src/node_file.cc retries only the
// busy/too-many-files/not-empty/operation-not-permitted errors, not permission_denied, and sleeps i * retryDelay / 1000 ms, 0 in
// practice). Codex's PR #112 round-2 run logged eleven such failures: nine left only just-emptied directories, two left the tree
// intact (Restart Manager, asked about one file of each, named no holder), and every tree was removable at the first try after a
// diagnostic that took at least 0.7-2.3 s.
// A retry here needs an established fact, is bounded and is printed:
// - only directories remain: nothing is asked;
// - files remain: Restart Manager is asked once who holds them, within its own bound. A named holder, or a query that fails or
//   does not answer in time, ends it at once.
// A retry removes only what the walk at the failure found, one entry at a time (unlink, then a non-recursive rmdir deepest
// first), so it can never delete an entry it has not seen. Before every retry the tree is walked again: an entry that was not
// there, or one that comes back after a retry removed it, ends it at once (something is still writing), and so does the hold
// bound, counted from the moment the fact is established, with what is left. A process that keeps the tree is never hidden.
// Any other error, or any other platform, throws as before.
import { spawnSync } from "node:child_process";
import { readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const TRANSIENT = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
// How long a hold may take to clear, from the moment its fact is established: twice the longest diagnostic delay after which
// Codex's held trees were removable, rounded up.
export const HOLD_BOUND_MS = 5_000;
// How long Restart Manager may take to answer. It is not part of the hold: on windows-latest, under the tools suite's parallel
// load, one query took more than 5 s (main run 39249788249, against about 0.4 s locally); this is six times that.
export const QUERY_BOUND_MS = 30_000;
const POLL_MS = 10;
const LISTED = 20;
const pause = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Runs `remove` (the caller's own removal of `root`) and, on Windows only, retries a transient hold under the rules above. */
export function removeTemp(root, remove, { platform = process.platform, holders = restartManagerHolders, boundMs = HOLD_BOUND_MS,
  queryBoundMs = QUERY_BOUND_MS, now = () => performance.now(), sleep = pause, log = (line) => console.error(line), fs = { unlink: unlinkSync, rmdir: rmdirSync } } = {}) {
  let first;
  try { remove(); return; } catch (error) { first = error; }
  if (platform !== "win32" || !TRANSIENT.has(first.code)) throw first;
  const started = now();
  let left = entries(root);
  const fail = (reason) => Object.assign(new Error(`${first.message}; ${reason}; left: ${describe(root, left)}`, { cause: first }),
    { code: first.code, left: [...left.dirs, ...left.files] });
  let fact = `only directories remain (${left.dirs.length} below the root), no file`;
  if (left.files.length) {
    let held;
    const asked = now();
    try { held = holders(left.files, { timeoutMs: queryBoundMs }); } catch (error) { throw fail(`not retried: who holds its ${left.files.length} remaining files is unknown (${error.message})`); }
    if (held.length) throw fail(`not retried: Restart Manager names ${held.join(", ")} as holding its remaining files`);
    fact = `Restart Manager names no holder of its ${left.files.length} remaining files (answered in ${Math.round(now() - asked)} ms)`;
  }
  const retriesFrom = now();
  log(`temp removal: ${root}: ${first.code}; ${fact}; retrying for at most ${boundMs} ms`);
  for (let retry = 1; ; retry++) {
    const seen = new Set([...left.dirs, ...left.files]);
    left = entries(root);
    const added = [...left.dirs, ...left.files].find((path) => !seen.has(path));
    if (added) throw fail(`not retried further: ${relative(root, added)} appeared after the failure, so something is still writing there`);
    if (now() - retriesFrom >= boundMs) throw fail(`still held ${boundMs} ms after the retries began (${retry - 1} retries)`);
    const removed = new Set();
    let error;
    try { removeSeen(root, left, removed, fs); } catch (caught) { error = caught; }
    if (!error) {
      log(`temp removal: ${root}: removed at retry ${retry}, ${Math.round(now() - started)} ms after the first failure`);
      return;
    }
    if (!TRANSIENT.has(error.code)) {
      left = entries(root);
      throw fail(`retry ${retry} failed with ${error.code ?? error.name}: ${error.message}`);
    }
    // What this retry removed may not come back.
    left = { dirs: left.dirs.filter((path) => !removed.has(path)), files: left.files.filter((path) => !removed.has(path)) };
    sleep(POLL_MS);
  }
}

// Files, then directories deepest first, then the root; an entry already gone is fine. Only the walked entries are named, and
// rmdir refuses a non-empty directory, so an entry the walk did not see is never deleted.
function removeSeen(root, { dirs, files }, removed, { unlink, rmdir }) {
  const gone = (removeEntry, path) => {
    try { removeEntry(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    removed.add(path);
  };
  const depth = (path) => path.split(/[\\/]/).length;
  for (const file of files) gone(unlink, file);
  for (const dir of [...dirs].sort((a, b) => depth(b) - depth(a))) gone(rmdir, dir);
  gone(rmdir, root);
}

/** Every directory and every other entry (files, links) below `root`; an unreadable directory is listed without its contents. */
export function entries(root) {
  const dirs = [], files = [];
  const walk = (dir) => {
    let found;
    try { found = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of found) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { dirs.push(path); walk(path); } else files.push(path);
    }
  };
  walk(root);
  return { dirs, files };
}

function describe(root, { dirs, files }) {
  const all = [...dirs, ...files].map((path) => relative(root, path)).sort();
  if (!all.length) return "nothing below the root";
  return all.slice(0, LISTED).join(", ") + (all.length > LISTED ? ` and ${all.length - LISTED} more` : "");
}

// Windows Restart Manager: the processes that have any of `files` open. It sees open files only, never a directory or a current
// directory. Throws when the query cannot be made or answered in time, so an unknown answer is never read as "no holder".
// The P/Invoke signatures are emitted with System.Reflection.Emit rather than compiled with Add-Type, which runs csc.exe as a
// child of PowerShell: killing PowerShell at the timeout then ends the whole query. An RM_PROCESS_INFO is 668 bytes: the pid at
// offset 0, the application name (256 UTF-16 characters) at offset 12.
const RM_QUERY = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = [string[]]([Console]::In.ReadToEnd() | ConvertFrom-Json)
$module = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'KauroRestartManager'), 'Run').DefineDynamicModule('KauroRestartManager')
$builder = $module.DefineType('KauroRestartManager', 'Public, Class, Abstract, Sealed')
foreach ($import in @(
  @('RmStartSession', @([uint32].MakeByRefType(), [int], [Text.StringBuilder])),
  @('RmEndSession', @([uint32])),
  @('RmRegisterResources', @([uint32], [uint32], [string[]], [uint32], [IntPtr], [uint32], [IntPtr])),
  @('RmGetList', @([uint32], [uint32].MakeByRefType(), [uint32].MakeByRefType(), [byte[]], [uint32].MakeByRefType())))) {
  $method = $builder.DefinePInvokeMethod($import[0], 'rstrtmgr.dll', 'Public, Static, PinvokeImpl', 'Standard', [int], [Type[]]$import[1], 'Winapi', 'Unicode')
  $method.SetImplementationFlags('PreserveSig')
}
$rm = $builder.CreateType()
[uint32]$session = 0
$rc = $rm::RmStartSession([ref]$session, 0, (New-Object Text.StringBuilder 64))
if ($rc -ne 0) { throw (New-Object ComponentModel.Win32Exception $rc) }
try {
  $rc = $rm::RmRegisterResources($session, [uint32]$paths.Length, $paths, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
  if ($rc -ne 0) { throw (New-Object ComponentModel.Win32Exception $rc) }
  $size = 668
  [uint32]$needed = 0; [uint32]$count = 0; [uint32]$reasons = 0; [byte[]]$info = $null
  while (($rc = $rm::RmGetList($session, [ref]$needed, [ref]$count, $info, [ref]$reasons)) -eq 234) { $count = $needed; $info = New-Object byte[] ($needed * $size) }
  if ($rc -ne 0) { throw (New-Object ComponentModel.Win32Exception $rc) }
  $holders = @(for ($i = 0; $i -lt $count; $i++) {
    "$([BitConverter]::ToUInt32($info, $i * $size)) $([Text.Encoding]::Unicode.GetString($info, $i * $size + 12, 512).Split([char]0)[0])"
  })
} finally { [void]$rm::RmEndSession($session) }
ConvertTo-Json -Compress -InputObject @($holders)`;

export function restartManagerHolders(files, { run = spawnSync, timeoutMs = QUERY_BOUND_MS } = {}) {
  // ASCII-only JSON on stdin: non-ASCII names survive whatever input code page PowerShell starts with.
  const input = JSON.stringify(files).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const result = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(RM_QUERY, "utf16le").toString("base64")], { input, encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  // spawnSync kills the query at the timeout and returns only once it has exited.
  if (result.error?.code === "ETIMEDOUT") throw new Error(`Restart Manager query did not answer within ${timeoutMs} ms; powershell.exe ${result.pid} was stopped`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Restart Manager query exited ${result.status}: ${(result.stderr ?? "").trim().split(/\r?\n/)[0]}`);
  const holders = JSON.parse(result.stdout);
  if (!Array.isArray(holders)) throw new Error(`Restart Manager query answered ${result.stdout.trim()}`);
  return holders;
}

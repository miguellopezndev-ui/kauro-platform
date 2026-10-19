// Removal of a temporary tree that a gate or a test made for itself, with one Windows-only allowance for a transient hold.
// Windows refuses to delete a directory while it is some process's current directory, and Node 24's rmSync reports that as
// "EPERM, Permission denied" after deleting what it could; it never retries that error (src/node_file.cc retries only the
// busy/too-many-files/not-empty/operation-not-permitted errors, not permission_denied, and sleeps i * retryDelay / 1000 ms, 0 in
// practice). Codex's PR #112 round-2 run logged eleven such failures: nine left only just-emptied directories, two left the tree
// intact (Restart Manager, asked about one file of each, named no holder), and every tree was removable at the first try after a
// diagnostic that took at least 0.7-2.3 s.
// A retry here needs an established fact, is bounded and is printed:
// - only directories remain: they are removed bottom-up with a non-recursive rmdir, which cannot delete a file;
// - files remain: Restart Manager is asked once who holds them. A named holder, or a query that fails, ends it at once; with no
//   holder the caller's own removal is repeated.
// It stops at once if an entry appears that was not there at the failure (something is still writing), and fails at the bound
// with what is left, so a process that keeps the tree is never hidden. Any other error, or any other platform, throws as before.
import { spawnSync } from "node:child_process";
import { readdirSync, rmdirSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const TRANSIENT = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
// Twice the longest diagnostic delay after which Codex's held trees were removable, rounded up.
export const HOLD_BOUND_MS = 5_000;
const POLL_MS = 10;
const LISTED = 20;
const pause = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Runs `remove` (the caller's own removal of `root`) and, on Windows only, retries a transient hold under the rules above. */
export function removeTemp(root, remove, { platform = process.platform, holders = restartManagerHolders, boundMs = HOLD_BOUND_MS,
  now = () => performance.now(), sleep = pause, log = (line) => console.error(line) } = {}) {
  let first;
  try { remove(); return; } catch (error) { first = error; }
  if (platform !== "win32" || !TRANSIENT.has(first.code)) throw first;
  const started = now();
  let left = entries(root);
  const known = new Set([...left.dirs, ...left.files]);
  const fail = (reason) => Object.assign(new Error(`${first.message}; ${reason}; left: ${describe(root, left)}`, { cause: first }),
    { code: first.code, left: [...left.dirs, ...left.files] });
  let fact = `only directories remain (${left.dirs.length} below the root), no file`;
  if (left.files.length) {
    let held;
    try { held = holders(left.files); } catch (error) { throw fail(`not retried: who holds its ${left.files.length} remaining files is unknown (${error.message})`); }
    if (held.length) throw fail(`not retried: Restart Manager names ${held.join(", ")} as holding its remaining files`);
    fact = `Restart Manager names no holder of its ${left.files.length} remaining files`;
  }
  log(`temp removal: ${root}: ${first.code}; ${fact}; retrying for at most ${boundMs} ms`);
  for (let retry = 1; ; retry++) {
    let error;
    try { if (left.files.length) remove(); else removeDirectories(root, left.dirs); } catch (caught) { error = caught; }
    if (!error) {
      log(`temp removal: ${root}: removed at retry ${retry}, ${Math.round(now() - started)} ms after the first failure`);
      return;
    }
    left = entries(root);
    if (!TRANSIENT.has(error.code)) throw fail(`retry ${retry} failed with ${error.code ?? error.name}: ${error.message}`);
    const added = [...left.dirs, ...left.files].find((path) => !known.has(path));
    if (added) throw fail(`not retried further: ${relative(root, added)} appeared after the failure, so something is still writing there`);
    if (now() - started >= boundMs) throw fail(`still held ${boundMs} ms after the first failure (${retry} retries)`);
    sleep(POLL_MS);
  }
}

// Deepest first, then the root; a directory already gone is fine. rmdir refuses a non-empty directory, so no file is ever deleted.
function removeDirectories(root, dirs) {
  const depth = (path) => path.split(/[\\/]/).length;
  for (const dir of [...dirs].sort((a, b) => depth(b) - depth(a)).concat(root)) {
    try { rmdirSync(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
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
// directory. Throws when the query cannot be made or answered, so an unknown answer is never read as "no holder".
const RM_QUERY = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = [string[]]([Console]::In.ReadToEnd() | ConvertFrom-Json)
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.ComponentModel; using System.Runtime.InteropServices; using System.Text;
public static class KauroRestartManager {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo { public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string App; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
    public int Type; public uint Status; public uint Session; [MarshalAs(UnmanagedType.Bool)] public bool Restartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint files, string[] names, uint processes, IntPtr unique, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  public static string[] Holders(string[] files) {
    uint session; int rc = RmStartSession(out session, 0, new StringBuilder(64));
    if (rc != 0) throw new Win32Exception(rc);
    try {
      rc = RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, null);
      if (rc != 0) throw new Win32Exception(rc);
      uint needed, count = 0, reasons = 0; ProcessInfo[] info = null;
      while ((rc = RmGetList(session, out needed, ref count, info, ref reasons)) == 234) { count = needed; info = new ProcessInfo[needed]; }
      if (rc != 0) throw new Win32Exception(rc);
      var holders = new List<string>();
      for (int i = 0; i < count; i++) holders.Add(info[i].Process.Pid + " " + info[i].App);
      return holders.ToArray();
    } finally { RmEndSession(session); }
  }
}
'@
ConvertTo-Json -Compress -InputObject @([KauroRestartManager]::Holders($paths))`;

export function restartManagerHolders(files, { run = spawnSync } = {}) {
  // ASCII-only JSON on stdin: non-ASCII names survive whatever input code page PowerShell starts with.
  const input = JSON.stringify(files).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const result = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(RM_QUERY, "utf16le").toString("base64")], { input, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Restart Manager query exited ${result.status}: ${(result.stderr ?? "").trim().split(/\r?\n/)[0]}`);
  const holders = JSON.parse(result.stdout);
  if (!Array.isArray(holders)) throw new Error(`Restart Manager query answered ${result.stdout.trim()}`);
  return holders;
}

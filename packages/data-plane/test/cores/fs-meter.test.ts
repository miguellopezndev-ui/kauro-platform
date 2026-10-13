// B05 L1: the metered file system of the core child, its census and the byte ledger (M03c, M23, M23b, M24, M15b).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PERMITTED_FS_NAMES, installFsMeter } from "../../src/cores/fs-meter.js";
import { runCoreChild } from "../../src/cores/core-child-runner.js";
import { attemptFixture } from "../support/attempt.js";
import { tempRoot } from "../support/core-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const copyOf = (module: object): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(module)) copy[name] = (module as Record<string, unknown>)[name];
  return copy;
};
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

test("M03c RACE (scratch credit): with B=10000 and 9900 bytes retained, recursively removing a directory holding 100 charged bytes credits exactly 100 whatever the lstat size of a directory, and a following 4096-byte write is refused SCRATCH_EXHAUSTED before reaching the device; an empty subtree credits 0, a large subtree its whole charge", () => {
  const t = tempRoot();
  try {
    const f = copyOf(fs) as unknown as typeof fs;
    const meter = installFsMeter(f as unknown as Record<string, unknown>, null);
    const ledger = meter.configure(10_000);
    const big = join(t.root, "big.bin");
    const dir = join(t.root, "d");
    f.mkdirSync(join(dir, "sub", "empty"), { recursive: true });
    const write = (path: string, bytes: number): void => {
      const fd = f.openSync(path, "wx");
      f.writeSync(fd, Buffer.alloc(bytes, 1));
      f.closeSync(fd);
    };
    write(big, 9_800);
    write(join(dir, "sub", "a.bin"), 100);
    assert.equal(ledger.live, 9_900);
    f.rmSync(dir, { recursive: true });
    assert.equal(ledger.live, 9_800);
    const empty = join(t.root, "e");
    f.mkdirSync(empty);
    f.rmSync(empty, { recursive: true });
    assert.equal(ledger.live, 9_800);
    write(join(t.root, "keep.bin"), 100);
    const refused = join(t.root, "refused.bin");
    const fd = f.openSync(refused, "wx");
    assert.throws(() => f.writeSync(fd, Buffer.alloc(4096, 2)), (e: unknown) => codeOf(e) === "ENOSPC");
    f.closeSync(fd);
    assert.equal(statSync(refused).size, 0, "nothing reached the device");
    mkdirSync(join(t.root, "tree"));
    f.rmSync(big);
    write(join(t.root, "tree", "x.bin"), 6_000);
    const before = ledger.live;
    f.rmSync(join(t.root, "tree"), { recursive: true });
    assert.equal(before - ledger.live, 6_000);
  } finally {
    t.dispose();
  }
});

test("M23 DENY child fs: every function export of node:fs and node:fs/promises outside the 18 permitted names is refused OUTSIDE_CAPABILITY (writevSync, write, writeFile, writev, appendFile*, createWriteStream, copyFile*, cp*, rename, truncate*, link*, symlink*, mkdtemp*, every callback and promise form), an export unknown to the allowlist is refused too, and fs.promises is refused whole", () => {
  const f = copyOf(fs);
  const p = copyOf(fsPromises);
  f["someFutureWriteSync"] = function someFutureWriteSync() {
    return "wrote";
  };
  installFsMeter(f, p);
  let refused = 0;
  for (const name of Object.getOwnPropertyNames(f)) {
    const value = f[name];
    if (typeof value !== "function" || (/^[A-Z]/.test(name) && name !== "WriteStream")) continue;
    if (PERMITTED_FS_NAMES.includes(name) || name === "promises") continue;
    assert.throws(() => (value as () => unknown)(), (e: unknown) => codeOf(e) === "OUTSIDE_CAPABILITY", name);
    refused += 1;
  }
  assert.ok(refused > 60, `${refused} refused`);
  for (const name of ["writevSync", "write", "writeFile", "writev", "appendFile", "appendFileSync", "createWriteStream", "copyFile", "copyFileSync", "cp", "cpSync", "rename", "truncate", "truncateSync", "link", "symlink", "mkdtemp", "mkdtempSync", "futimesSync", "someFutureWriteSync"]) {
    assert.throws(() => (f[name] as () => unknown)(), (e: unknown) => codeOf(e) === "OUTSIDE_CAPABILITY", name);
  }
  assert.equal(PERMITTED_FS_NAMES.length, 18);
  for (const name of Object.getOwnPropertyNames(p)) {
    if (typeof p[name] === "function" && !/^[A-Z]/.test(name)) assert.throws(() => (p[name] as () => unknown)(), (e: unknown) => codeOf(e) === "OUTSIDE_CAPABILITY", `promises.${name}`);
  }
  assert.throws(() => (f["promises"] as { writeFile(): unknown }).writeFile(), (e: unknown) => codeOf(e) === "OUTSIDE_CAPABILITY");
  assert.equal(typeof f["Stats"], "function", "classes stay");
});

function importedFsNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](?:node:)?fs['"]/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim();
      if (name === "" || name.startsWith("type ")) continue;
      out.add(name.split(/\s+as\s+/)[0] ?? name);
    }
  }
  return out;
}

function walkJs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkJs(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []));
}

test("M23b DENY drift (census): the node:fs names imported by the vendored MC 3.0.0 dist, data-plane attempt/scratch-store.ts and src/cores/child-*.ts equal the checked-in census src/cores/fs-census.json (MC 17, store 14, union 19), every one is permitted except mkdtempSync, and a name added to any of them without an allowlist decision fails", () => {
  const pkg = join(here, "..", "..", "..");
  const census = JSON.parse(readFileSync(join(pkg, "src", "cores", "fs-census.json"), "utf8")) as Record<string, string[]>;
  const wrapper = createRequire(join(pkg, "package.json")).resolve("@kauro/migration-core");
  const raw = createRequire(wrapper).resolve("kauro-migration-core");
  const rawRoot = raw.replace(/[\\/]dist[\\/].*$/, "");
  const mc = new Set<string>();
  for (const file of walkJs(join(rawRoot, "dist", "src"))) for (const n of importedFsNames(readFileSync(file, "utf8"))) mc.add(n);
  const store = importedFsNames(readFileSync(join(pkg, "src", "attempt", "scratch-store.ts"), "utf8"));
  const child = new Set<string>();
  for (const file of readdirSync(join(pkg, "src", "cores")).filter((n) => n.startsWith("child-") && n.endsWith(".ts"))) for (const n of importedFsNames(readFileSync(join(pkg, "src", "cores", file), "utf8"))) child.add(n);
  const sorted = (s: Iterable<string>): string[] => [...s].sort();
  assert.deepEqual(sorted(mc), census["migrationCore"]);
  assert.deepEqual(sorted(store), census["attemptScratchStore"]);
  assert.deepEqual(sorted(child), census["childModules"]);
  const union = new Set([...mc, ...store, ...child]);
  assert.deepEqual(sorted(union), census["union"]);
  assert.equal(mc.size, 17);
  assert.equal(store.size, 14);
  assert.equal(union.size, 19);
  assert.deepEqual(sorted(union).filter((n) => !PERMITTED_FS_NAMES.includes(n)), ["mkdtempSync"]);
  assert.deepEqual(census["refused"], ["mkdtempSync"]);
  assert.notDeepEqual(sorted(importedFsNames('import { openSync, copyFileSync } from "node:fs";')), census["childModules"]);
});

test("M24 OK child store: under the real child preload the platform AttemptScratchStore seals a segment and a spool (fsyncSync), disposes an empty and a nonempty store (rmdirSync, unlinkSync) and leaves the ledger at exactly the bytes still on disk, every device write of the store passing the metered writeSync", async () => {
  const t = tempRoot();
  try {
    const call = join(t.root, "call");
    mkdirSync(call);
    const fixture = attemptFixture(5);
    const other = attemptFixture(6);
    const real = realpathSync.native(call);
    const res = await runCoreChild({
      task: join(here, "..", "support", "child-probe-task.js"),
      payload: { mode: "store", root: join(real, "store"), attemptId: fixture.attemptId, other: other.attemptId, outside: "", quotaBytes: 1 << 20 },
      readPaths: [join(here, "..", "support"), real],
      callDir: real,
      quotaBytes: 1 << 20,
      heapMegabytes: 256,
    });
    assert.ok(res.outcome?.ok, JSON.stringify(res.outcome));
    const v = (res.outcome as { value: { mid: Record<string, number>; end: Record<string, number> } }).value;
    assert.ok(v.mid["segmentBytes"]! > 0 && v.mid["spoolBytes"] === 3000 && v.mid["chunked"] === 3000);
    assert.equal(v.mid["live"], v.mid["disk"], "the ledger equals the bytes on disk while the store lives");
    assert.ok(v.mid["peak"]! >= v.mid["live"]!);
    assert.equal(v.end["live"], 0);
    assert.equal(v.end["disk"], 0);
    assert.equal(res.observers.outsideWriteAttempts, 0);
  } finally {
    t.dispose();
  }
});

test("M15b OK isolation probe: inside the real child the environment is empty, a write outside the call directory is denied, fs.promises is refused and the network is refused", async () => {
  const t = tempRoot();
  try {
    const call = join(t.root, "call");
    mkdirSync(call);
    const real = realpathSync.native(call);
    const outside = join(t.root, "outside.txt");
    process.env["KAURO_B05_PROBE_SECRET"] = "secret";
    const res = await runCoreChild({
      task: join(here, "..", "support", "child-probe-task.js"),
      payload: { mode: "probe", root: real, attemptId: "", other: "", outside, quotaBytes: 1 << 20 },
      readPaths: [join(here, "..", "support"), real],
      callDir: real,
      quotaBytes: 1 << 20,
      heapMegabytes: 256,
    });
    assert.ok(res.outcome?.ok, JSON.stringify(res.outcome));
    const v = (res.outcome as { value: Record<string, unknown> }).value;
    delete process.env["KAURO_B05_PROBE_SECRET"];
    const env = v["env"] as string[];
    assert.equal(env.includes("KAURO_B05_PROBE_SECRET"), false, "the parent environment is not inherited");
    if (process.platform !== "win32") assert.deepEqual(env, []);
    assert.notEqual(v["outside"], "WRITTEN");
    assert.equal(v["promises"], "OUTSIDE_CAPABILITY");
    assert.notEqual(v["network"], "CONNECTED");
    assert.throws(() => statSync(outside));
  } finally {
    t.dispose();
  }
});

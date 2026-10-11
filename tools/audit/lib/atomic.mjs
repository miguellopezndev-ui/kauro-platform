// Write-once files for the audit ledger (decision W-2; R2 21:128 "A final report cannot omit a failed attempt simply because a later
// attempt passed": nothing is ever overwritten). writeOnce(path, data, opts):
//   tmp `<path>.tmp-<pid>-<rand>` -> write -> fsync the file -> linkSync(tmp, path) -> DURABILITY STEP (linux: open the parent directory
//   and fsync it; win32: reopen the linked file r+ and fsync it = NTFS log flush) -> unlink tmp.
// EEXIST on the link -> E_EXISTS (the second writer; the loser removes its temp). Link EPERM/EACCES/EBUSY -> three attempts then E_IO,
// never E_EXISTS. A failed unlink after the link is success (the temp file is swept later; readers ignore `*.tmp-*`).
// A reader never sees a partial file: the path appears by one link of a complete, fsynced file.
// Test hooks: `beforeLink(path)` runs just before the link (a race holds there), `crashAt` "afterTmp" | "afterLink" throws
// SimulatedCrash at that point; `fs` and `platform` are injectable. The ledger is written by Windows node only (no WSL /mnt/c writer).
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "./record.mjs";

export class SimulatedCrash extends Error {
  constructor(where) {
    super(`simulated crash ${where}`);
    this.code = "E_SIMULATED_CRASH";
    this.where = where;
  }
}

const realFs = {
  openSync: nodeFs.openSync,
  writeSync: nodeFs.writeSync,
  fsyncSync: nodeFs.fsyncSync,
  closeSync: nodeFs.closeSync,
  linkSync: nodeFs.linkSync,
  unlinkSync: nodeFs.unlinkSync,
};

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

/** True for the temp files of an unfinished or unswept write. */
export function isTempName(name) {
  return /\.tmp-/.test(name);
}

/** The names in `dir` a reader may use: temp files are ignored. */
export function readableFiles(dir) {
  return nodeFs.readdirSync(dir).filter((name) => !isTempName(name)).sort();
}

function tempPathOf(path) {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function bestEffortUnlink(fs, path) {
  try {
    fs.unlinkSync(path);
  } catch {
    // swept later; readers ignore temp files
  }
}

export function writeOnce(path, data, { fs = realFs, platform = process.platform, beforeLink, crashAt, attempts = 3 } = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  const tmp = tempPathOf(path);
  const fd = fs.openSync(tmp, "wx");
  try {
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (crashAt === "afterTmp") throw new SimulatedCrash("afterTmp");
  beforeLink?.(path);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.linkSync(tmp, path);
      break;
    } catch (error) {
      if (error.code === "EEXIST") {
        bestEffortUnlink(fs, tmp);
        throw fail("E_EXISTS", `${path} already exists`);
      }
      if (RETRYABLE.has(error.code) && attempt < attempts) continue;
      bestEffortUnlink(fs, tmp);
      throw fail("E_IO", `link to ${path} failed after ${attempt} attempt(s): ${error.code ?? error.message}`, { cause: error });
    }
  }
  if (crashAt === "afterLink") throw new SimulatedCrash("afterLink");
  try {
    if (platform === "win32") {
      const linked = fs.openSync(path, "r+");
      try {
        fs.fsyncSync(linked);
      } finally {
        fs.closeSync(linked);
      }
    } else {
      const parent = fs.openSync(dirname(path), "r");
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
  } catch (error) {
    throw fail("E_IO", `${path} is linked but its durability step failed: ${error.code ?? error.message}`, { cause: error, linked: true });
  }
  bestEffortUnlink(fs, tmp);
  return { path, bytes: bytes.length };
}

/** openLedger probe: the root must support hard links, or writeOnce cannot work (E_ROOT_FS). */
export function probeLinks(root, { fs = realFs } = {}) {
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const source = join(root, `probe.tmp-${suffix}`);
  const link = join(root, `probe-link.tmp-${suffix}`);
  if (typeof fs.linkSync !== "function") throw fail("E_ROOT_FS", `${root}: the file system facade has no hard links`);
  try {
    const fd = fs.openSync(source, "wx");
    fs.closeSync(fd);
    fs.linkSync(source, link);
  } catch (error) {
    throw fail("E_ROOT_FS", `${root} does not support hard links: ${error.code ?? error.message}`, { cause: error });
  } finally {
    bestEffortUnlink(fs, link);
    bestEffortUnlink(fs, source);
  }
}

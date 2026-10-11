/**
 * The metered file system of the core child (B05 D5-2c (2), (5); M03, M03c, M23, M24).
 *
 * `installFsMeter` replaces EVERY function export of a `node:fs` namespace object and of its promises namespace:
 *   - METERED (charged to the attempt's byte ledger before the call, an ENOSPC-coded throw past the quota):
 *     openSync (flags r | w | wx only), writeSync, writeFileSync (a path string, flag absent or w);
 *   - CONTROL (no byte change; the fd must come from this module's openSync): closeSync, fsyncSync, mkdirSync;
 *   - REMOVAL (credits by the ledger's own map): unlinkSync, rmSync, rmdirSync (non-recursive only), renameSync;
 *   - READ (passed through): readSync, readFileSync, statSync, lstatSync, fstatSync, readdirSync, existsSync, realpathSync;
 *   every other export, present or added by a later Node, is a stub that throws OUTSIDE_CAPABILITY (writevSync, write, writeFile,
 *   appendFile*, createWriteStream, copyFile*, cp*, rename, truncate*, link*, symlink*, mkdtemp*, every callback and promise form,
 *   `fs.promises` whole). Class exports (capitalized) are values, not entry points, and stay.
 * The namespace is passed in so a test can install it on a copy; the child preload installs it on the real module and calls
 * `module.syncBuiltinESMExports()` so ESM named imports see the metered functions. Loaded inside the child: node built-ins only.
 */
import { AttemptByteLedger, ledgerKeyOf } from "./attempt-byte-ledger.js";

type Loose = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

export const METERED_NAMES = ["openSync", "writeSync", "writeFileSync"] as const;
export const CONTROL_NAMES = ["closeSync", "fsyncSync", "mkdirSync"] as const;
export const REMOVAL_NAMES = ["unlinkSync", "rmSync", "rmdirSync", "renameSync"] as const;
export const READ_NAMES = ["readSync", "readFileSync", "statSync", "lstatSync", "fstatSync", "readdirSync", "existsSync", "realpathSync"] as const;
/** The 18 permitted names of node:fs (M23b). */
export const PERMITTED_FS_NAMES: readonly string[] = [...METERED_NAMES, ...CONTROL_NAMES, ...REMOVAL_NAMES, ...READ_NAMES].sort();

export class OutsideCapability extends Error {
  readonly code = "OUTSIDE_CAPABILITY";
  constructor(detail: string) {
    super(`OUTSIDE_CAPABILITY: ${detail}`);
    this.name = "OutsideCapability";
  }
}

export interface FsMeter {
  readonly ledger: () => AttemptByteLedger;
  /** Sets the child's budget (quota); until then every charge is refused. */
  configure(budgetBytes: number): AttemptByteLedger;
}

function pathOf(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return decodeURIComponent(value.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  throw new OutsideCapability(`${what} takes a path string`);
}

function byteLengthOf(data: unknown, encoding: BufferEncoding | undefined): number {
  if (typeof data === "string") return Buffer.byteLength(data, encoding ?? "utf8");
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new OutsideCapability("write data is a string or bytes");
}

export function installFsMeter(namespace: Loose, promisesNamespace: Loose | null): FsMeter {
  const original = { ...namespace } as Loose;
  const fn = (name: string): Fn => {
    const f = original[name];
    if (typeof f !== "function") throw new Error(`node:fs has no ${name}`);
    return f as Fn;
  };
  let ledger = new AttemptByteLedger(0);
  const fds = new Map<number, { path: string; offset: number }>();
  const lstat = fn("lstatSync");
  const existsKey = (key: string): boolean => {
    try {
      lstat(key);
      return true;
    } catch {
      return false;
    }
  };

  const openSync = fn("openSync");
  const writeSyncOriginal = fn("writeSync");
  const writeFileSyncOriginal = fn("writeFileSync");
  const closeSync = fn("closeSync");
  const fsyncSync = fn("fsyncSync");
  const unlinkSync = fn("unlinkSync");
  const rmSync = fn("rmSync");
  const rmdirSync = fn("rmdirSync");
  const renameSync = fn("renameSync");
  const statSync = fn("statSync");

  const trackedFd = (fd: unknown, what: string): { path: string; offset: number } => {
    const entry = typeof fd === "number" ? fds.get(fd) : undefined;
    if (entry === undefined) throw new OutsideCapability(`${what} on a descriptor this process did not open through the metered openSync`);
    return entry;
  };

  const replacements: Record<string, Fn> = {
    openSync(path: unknown, flags?: unknown, mode?: unknown): unknown {
      const p = pathOf(path, "openSync");
      if (flags !== undefined && flags !== "r" && flags !== "w" && flags !== "wx") throw new OutsideCapability(`openSync flags ${String(flags)} (only r, w, wx)`);
      const fd = (mode === undefined ? openSync(p, flags ?? "r") : openSync(p, flags ?? "r", mode)) as number;
      if (flags === "w") ledger.setCharged(p, 0);
      fds.set(fd, { path: p, offset: 0 });
      return fd;
    },
    writeSync(fd: unknown, data: unknown, a?: unknown, b?: unknown, c?: unknown): unknown {
      const entry = trackedFd(fd, "writeSync");
      let length: number;
      let offset = 0;
      let position: number | null = null;
      let args: unknown[];
      if (typeof data === "string") {
        const pos = a;
        const encoding = typeof b === "string" ? (b as BufferEncoding) : undefined;
        length = byteLengthOf(data, encoding);
        position = typeof pos === "number" ? pos : null;
        args = [fd, data, ...(a === undefined ? [] : [a]), ...(b === undefined ? [] : [b])];
      } else if (ArrayBuffer.isView(data)) {
        if (a !== null && typeof a === "object") {
          const o = a as { offset?: number; length?: number; position?: number | null };
          offset = o.offset ?? 0;
          length = o.length ?? data.byteLength - offset;
          position = typeof o.position === "number" ? o.position : null;
        } else {
          offset = typeof a === "number" ? a : 0;
          length = typeof b === "number" ? b : data.byteLength - offset;
          position = typeof c === "number" ? c : null;
        }
        if (!Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > data.byteLength) throw new RangeError("writeSync range outside the buffer");
        args = [fd, data, a, b, c].filter((v, i) => i < 2 || v !== undefined);
      } else {
        throw new OutsideCapability("writeSync data is a string or bytes");
      }
      const start = position ?? entry.offset;
      const held = ledger.chargedOf(entry.path);
      ledger.chargeTo(entry.path, start + length);
      let written: number;
      try {
        written = writeSyncOriginal(...args) as number;
      } catch (error) {
        ledger.trimTo(entry.path, held);
        throw error;
      }
      if (written < length) ledger.trimTo(entry.path, Math.max(held, start + written));
      if (position === null) entry.offset += written;
      return written;
    },
    writeFileSync(file: unknown, data: unknown, options?: unknown): unknown {
      if (typeof file !== "string" && !(file instanceof URL)) throw new OutsideCapability("writeFileSync with a descriptor");
      const p = pathOf(file, "writeFileSync");
      let encoding: BufferEncoding | undefined;
      if (typeof options === "string") encoding = options as BufferEncoding;
      else if (options !== null && typeof options === "object") {
        const o = options as { encoding?: BufferEncoding; flag?: string };
        if (o.flag !== undefined && o.flag !== "w") throw new OutsideCapability(`writeFileSync flag ${o.flag}`);
        encoding = o.encoding;
      }
      const bytes = byteLengthOf(data, encoding);
      const held = ledger.chargedOf(p);
      ledger.setCharged(p, bytes);
      try {
        return writeFileSyncOriginal(file, data, options);
      } catch (error) {
        let size = 0;
        try {
          size = (statSync(p) as { size: number }).size;
        } catch {
          size = 0;
        }
        ledger.setCharged(p, Math.min(bytes, Math.max(size, 0)));
        void held;
        throw error;
      }
    },
    closeSync(fd: unknown): unknown {
      trackedFd(fd, "closeSync");
      fds.delete(fd as number);
      return closeSync(fd);
    },
    fsyncSync(fd: unknown): unknown {
      trackedFd(fd, "fsyncSync");
      // Node refuses fsync under the permission model; the call scratch is disposable (never a durable store), so a flush of the
      // descriptor is the most the child can ask for and the OS write is already done by writeSync
      try {
        return fsyncSync(fd);
      } catch (error) {
        if (/disabled when Permission Model/.test(String((error as Error).message))) return undefined;
        throw error;
      }
    },
    unlinkSync(path: unknown): unknown {
      const p = pathOf(path, "unlinkSync");
      try {
        const result = unlinkSync(p);
        ledger.creditTree(p);
        return result;
      } catch (error) {
        ledger.reconcile(p, existsKey);
        throw error;
      }
    },
    rmSync(path: unknown, options?: unknown): unknown {
      const p = pathOf(path, "rmSync");
      try {
        const result = options === undefined ? rmSync(p) : rmSync(p, options);
        ledger.creditTree(p);
        return result;
      } catch (error) {
        ledger.reconcile(p, existsKey);
        throw error;
      }
    },
    rmdirSync(path: unknown, options?: unknown): unknown {
      const p = pathOf(path, "rmdirSync");
      if (options !== null && typeof options === "object" && (options as { recursive?: unknown }).recursive !== undefined && (options as { recursive?: unknown }).recursive !== false) {
        throw new OutsideCapability("rmdirSync with a recursive option");
      }
      try {
        const result = options === undefined ? rmdirSync(p) : rmdirSync(p, options);
        ledger.creditTree(p);
        return result;
      } catch (error) {
        ledger.reconcile(p, existsKey);
        throw error;
      }
    },
    renameSync(from: unknown, to: unknown): unknown {
      const a = pathOf(from, "renameSync");
      const b = pathOf(to, "renameSync");
      try {
        const result = renameSync(a, b);
        ledger.rename(a, b);
        return result;
      } catch (error) {
        ledger.reconcile(a, existsKey);
        ledger.reconcile(b, existsKey);
        throw error;
      }
    },
  };
  // mkdirSync and the READ names are not replaced: they change no charged byte (directory entries and metadata are charged 0)

  const keep = new Set<string>([...READ_NAMES, "mkdirSync"]);
  const stubFor = (name: string): Fn =>
    function refusedFsEntryPoint(): never {
      throw new OutsideCapability(`fs.${name} is not a permitted entry point of the core child`);
    };
  const install = (target: Loose, isPromises: boolean): void => {
    for (const name of Object.getOwnPropertyNames(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor === undefined || typeof descriptor.value !== "function") continue;
      if (/^[A-Z]/.test(name) && name !== "WriteStream" && name !== "FileWriteStream") continue;
      if (!isPromises && keep.has(name)) continue;
      const replacement = !isPromises ? replacements[name] : undefined;
      try {
        Object.defineProperty(target, name, { ...descriptor, value: replacement ?? stubFor(name) });
      } catch {
        /* a non-configurable export cannot be replaced; the permission model still governs it */
      }
    }
  };
  install(namespace, false);
  if (promisesNamespace !== null) install(promisesNamespace, true);
  try {
    // `fs.promises` is a getter on the module: the whole namespace is refused
    const refusing = new Proxy({}, { get: (_t, name) => (typeof name === "string" ? stubFor(`promises.${name}`) : undefined) });
    Object.defineProperty(namespace, "promises", { configurable: true, enumerable: true, get: () => refusing });
  } catch {
    /* ignore */
  }

  return {
    ledger: () => ledger,
    configure(budgetBytes: number): AttemptByteLedger {
      ledger = new AttemptByteLedger(budgetBytes);
      return ledger;
    },
  };
}

export { ledgerKeyOf };

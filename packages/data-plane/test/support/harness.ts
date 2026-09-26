// Test harness of the data plane: attempt scratches, a sentinel outside them, a TCP listener that counts the connections it
// receives (the independent truth behind "no network attempt"), and byte sources that stream in chunks of a chosen size.
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory under the system temporary directory (realpath: the permission model compares real paths). */
export function freshDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `kauro-dp-${prefix}-`)));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function listRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out.push(p);
    if (statSync(p).isDirectory()) out.push(...listRecursive(p));
  }
  return out;
}

/** A file outside every scratch whose bytes and modification time must never change. */
export interface Sentinel {
  readonly dir: string;
  readonly file: string;
  unchanged(): boolean;
}

export function sentinel(): Sentinel {
  const dir = freshDir("sentinel");
  mkdirSync(join(dir, "outside"));
  const file = join(dir, "outside", "sentinel.txt");
  writeFileSync(file, "the attempt must not write here\n");
  const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
  return {
    dir,
    file,
    unchanged: () => readFileSync(file).equals(before.bytes) && statSync(file).mtimeMs === before.mtime && readdirSync(join(dir, "outside")).length === 1,
  };
}

/** A listener on 127.0.0.1 that counts the connections it accepts. */
export interface Listener {
  readonly port: number;
  connections(): number;
  /** Resolves once the listener has accepted `n` connections (an event, never a timer). */
  accepted(n: number): Promise<void>;
  close(): Promise<void>;
}

export async function listener(): Promise<Listener> {
  let count = 0;
  const waiters: Array<{ readonly n: number; readonly resolve: () => void }> = [];
  const server: Server = createServer((socket) => {
    count += 1;
    socket.destroy();
    for (const w of waiters.filter((x) => x.n <= count)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    connections: () => count,
    accepted: (n) => (count >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Streams `bytes` in chunks of `chunk` bytes (the reader must not depend on chunk boundaries). */
export function source(bytes: Uint8Array, chunk = 65_536): () => AsyncIterable<Uint8Array> {
  return async function* stream() {
    for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, Math.min(bytes.length, i + chunk));
  };
}

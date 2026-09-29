/**
 * The preload of the isolated child (decision D-ISO-1; S024 "Reject without outside writes, network access or unbounded
 * decompression"; 09 "Scanner coverage": a restricted environment without customer-triggered network fetching).
 *
 * Node 24's permission model governs the file system, child processes, workers, addons and WASI, but not the network. This module,
 * loaded with `--import` before the task, therefore:
 *
 * - replaces every network entry point — net and tls connections and listens, dgram sockets, dns lookups and resolvers (callback
 *   and promise forms), http/https requests, http2 sessions, fetch and WebSocket — by a function that records the attempt (the API
 *   name only) and refuses it, so no byte leaves the process through them; the hooks are the observer and a probe that tries to
 *   connect is their negative control;
 * - wraps the file-system write entry points and the process entry points (child_process, worker_threads, process.dlopen, WASI)
 *   so that a refusal the permission model raises (ERR_ACCESS_DENIED) is counted before it propagates — the permission model is
 *   the barrier, the wrapper only observes it.
 *
 * The OS-level egress denial of a production worker host (network namespace, firewall) is not observable here and is not claimed:
 * LATER, B15. Loaded inside the child: only node built-ins.
 */
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import workerThreads from "node:worker_threads";
import wasi from "node:wasi";
import { OBSERVER_KEY, type IsolationObservers } from "./observers.js";

type Loose = Record<string, unknown>;
type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

const observers: IsolationObservers = { outsideWriteAttempts: 0, networkAttempts: 0, processAttempts: 0, network: [] };
Object.defineProperty(globalThis, OBSERVER_KEY, { value: observers, enumerable: false, configurable: false, writable: false });

class NetworkRefused extends Error {
  readonly code = "KAURO_NETWORK_REFUSED";
  constructor(api: string) {
    super(`network access refused in the isolated inspection (${api})`);
    this.name = "NetworkRefused";
  }
}

function recordNetwork(api: string): NetworkRefused {
  observers.networkAttempts += 1;
  if (observers.network.length < 64) observers.network.push(api);
  return new NetworkRefused(api);
}

function refuseSync(target: Loose, name: string, api: string): void {
  if (typeof target[name] !== "function") return;
  target[name] = function refusedNetworkEntryPoint(): never {
    throw recordNetwork(api);
  };
}

function refuseAsync(target: Loose, name: string, api: string): void {
  if (typeof target[name] !== "function") return;
  target[name] = function refusedNetworkEntryPoint(): Promise<never> {
    return Promise.reject(recordNetwork(api));
  };
}

const DNS_METHODS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
];

// --- network: record and refuse ---------------------------------------------------------------------------------------------------
refuseSync(net as unknown as Loose, "connect", "net.connect");
refuseSync(net as unknown as Loose, "createConnection", "net.createConnection");
refuseSync(net.Socket.prototype as unknown as Loose, "connect", "net.Socket.connect");
refuseSync(net.Server.prototype as unknown as Loose, "listen", "net.Server.listen");
refuseSync(tls as unknown as Loose, "connect", "tls.connect");
refuseSync(dgram as unknown as Loose, "createSocket", "dgram.createSocket");
refuseSync(dgram.Socket.prototype as unknown as Loose, "bind", "dgram.Socket.bind");
refuseSync(dgram.Socket.prototype as unknown as Loose, "send", "dgram.Socket.send");
refuseSync(dgram.Socket.prototype as unknown as Loose, "connect", "dgram.Socket.connect");
for (const m of DNS_METHODS) {
  refuseSync(dns as unknown as Loose, m, `dns.${m}`);
  refuseSync(dns.Resolver.prototype as unknown as Loose, m, `dns.Resolver.${m}`);
  refuseAsync(dns.promises as unknown as Loose, m, `dns.promises.${m}`);
  refuseAsync(dns.promises.Resolver.prototype as unknown as Loose, m, `dns.promises.Resolver.${m}`);
}
refuseSync(http as unknown as Loose, "request", "http.request");
refuseSync(http as unknown as Loose, "get", "http.get");
refuseSync(https as unknown as Loose, "request", "https.request");
refuseSync(https as unknown as Loose, "get", "https.get");
refuseSync(http2 as unknown as Loose, "connect", "http2.connect");
refuseAsync(globalThis as unknown as Loose, "fetch", "fetch");
for (const name of ["WebSocket", "EventSource"]) {
  if (typeof (globalThis as unknown as Loose)[name] === "function") {
    const api = name;
    (globalThis as unknown as Loose)[name] = function refusedNetworkConstructor(): never {
      throw recordNetwork(api);
    };
  }
}

// --- file-system writes and processes: count the permission model's refusals ------------------------------------------------------
function deniedAs(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; permission?: unknown };
  return e.code === "ERR_ACCESS_DENIED" && typeof e.permission === "string" ? e.permission : undefined;
}

function observe(error: unknown): void {
  const permission = deniedAs(error);
  if (permission === undefined) return;
  if (permission === "FileSystemWrite") observers.outsideWriteAttempts += 1;
  else if (permission === "ChildProcess" || permission === "WorkerThreads" || permission === "Addon" || permission === "WASI") observers.processAttempts += 1;
}

function observed(target: Loose, name: string): void {
  const original = target[name];
  if (typeof original !== "function") return;
  const fn = original as AnyFunction;
  target[name] = function observedEntryPoint(this: unknown, ...args: unknown[]): unknown {
    const last = args.length - 1;
    if (last >= 0 && typeof args[last] === "function") {
      const callback = args[last] as AnyFunction;
      args[last] = function observedCallback(this: unknown, error: unknown, ...rest: unknown[]): unknown {
        observe(error);
        return callback.call(this, error, ...rest);
      };
    }
    try {
      const result = fn.apply(this, args);
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        return (result as Promise<unknown>).catch((error: unknown) => {
          observe(error);
          throw error;
        });
      }
      return result;
    } catch (error) {
      observe(error);
      throw error;
    }
  };
}

const FS_WRITES = [
  "writeFile",
  "appendFile",
  "open",
  "mkdir",
  "mkdtemp",
  "rm",
  "rmdir",
  "unlink",
  "rename",
  "copyFile",
  "cp",
  "symlink",
  "link",
  "chmod",
  "lchmod",
  "chown",
  "lchown",
  "truncate",
  "utimes",
  "lutimes",
  "createWriteStream",
];
for (const name of FS_WRITES) {
  observed(fs as unknown as Loose, name);
  observed(fs as unknown as Loose, `${name}Sync`);
  observed(fs.promises as unknown as Loose, name);
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) observed(childProcess as unknown as Loose, name);
observed(process as unknown as Loose, "dlopen");

const OriginalWorker = workerThreads.Worker;
class ObservedWorker extends OriginalWorker {
  constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
    try {
      super(...args);
    } catch (error) {
      observe(error);
      throw error;
    }
  }
}
(workerThreads as unknown as Loose)["Worker"] = ObservedWorker;

const OriginalWasi = wasi.WASI;
class ObservedWasi extends OriginalWasi {
  constructor(...args: ConstructorParameters<typeof OriginalWasi>) {
    try {
      super(...args);
    } catch (error) {
      observe(error);
      throw error;
    }
  }
}
(wasi as unknown as Loose)["WASI"] = ObservedWasi;

// the ESM named exports of the built-ins follow the patched CommonJS exports
syncBuiltinESMExports();

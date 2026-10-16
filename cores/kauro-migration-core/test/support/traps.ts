import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Call-counting traps on every door a program has to the outside world.
 *
 * A workbook that names a URL, a share or a local file is asking the reader to
 * fetch it, and "the reader has no fetch code" is a claim about source text.
 * These make it a claim about behaviour: each door is wrapped, every call is
 * counted, and the network doors refuse the call instead of making it.
 *
 * The file doors are different because a run legitimately reads and writes
 * files. They count only the paths that are outside `allowedRoots` -- the
 * bundle, the scratch space and the code being run -- which is exactly the
 * set a workbook's targets would have to reach.
 */
export interface TrapCounts {
  readonly dns: number;
  readonly socket: number;
  readonly http: number;
  readonly fileOutsideBundle: number;
  /** The out-of-bundle paths that were opened, for the failure message. */
  readonly outsidePaths: readonly string[];
}

export function withTraps<T>(allowedRoots: readonly string[], run: () => T): { readonly value: T; readonly counts: TrapCounts } {
  const counts = { dns: 0, socket: 0, http: 0, fileOutsideBundle: 0 };
  const outsidePaths: string[] = [];
  const restore: (() => void)[] = [];
  const roots = allowedRoots.map((root) => resolve(root));

  const inside = (path: string): boolean =>
    roots.some((root) => {
      const rel = relative(root, resolve(path));
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });

  const wrap = (target: object, name: string, onCall: (args: unknown[]) => void, refuse: boolean): void => {
    const holder = target as Record<string, unknown>;
    const original = holder[name];
    if (typeof original !== 'function') return;
    holder[name] = function trapped(this: unknown, ...args: unknown[]): unknown {
      onCall(args);
      if (refuse) throw new Error(`trap: ${name} was called`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restore.push(() => {
      holder[name] = original;
    });
  };

  const pathOf = (args: unknown[]): string | null => {
    const first = args[0];
    if (typeof first === 'string') return first;
    if (first instanceof URL) return first.protocol === 'file:' ? decodeURIComponent(first.pathname.replace(/^\/([A-Za-z]:)/u, '$1')) : first.href;
    if (first instanceof Uint8Array) return Buffer.from(first).toString('utf8');
    return null;
  };
  const fileDoor = (args: unknown[]): void => {
    const path = pathOf(args);
    if (path !== null && !inside(path)) {
      counts.fileOutsideBundle += 1;
      outsidePaths.push(path);
    }
  };

  for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveMx', 'resolveTxt', 'resolveCname', 'resolveSrv', 'reverse']) {
    wrap(dns, name, () => { counts.dns += 1; }, true);
    wrap(dns.promises, name, () => { counts.dns += 1; }, true);
  }
  for (const name of ['connect', 'createConnection']) wrap(net, name, () => { counts.socket += 1; }, true);
  wrap(net.Socket.prototype, 'connect', () => { counts.socket += 1; }, true);
  for (const module of [http, https]) {
    for (const name of ['request', 'get']) wrap(module, name, () => { counts.http += 1; }, true);
  }
  for (const name of ['openSync', 'open', 'readFileSync', 'readFile', 'createReadStream', 'opendirSync', 'readdirSync']) {
    wrap(fs, name, fileDoor, false);
  }
  for (const name of ['open', 'readFile', 'opendir', 'readdir']) wrap(fs.promises, name, fileDoor, false);

  // Named imports of a built-in are bindings to the exports as they were when
  // the importing module loaded. This carries the replacements to them, and
  // carries the originals back afterwards.
  syncBuiltinESMExports();
  try {
    const value = run();
    return { value, counts: { ...counts, outsidePaths } };
  } finally {
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
  }
}

/**
 * The observers of the isolated child (decision D-ISO-1): what the preload records and the child entry reports. Shared by the
 * preload, the child entry and the parent runner; loaded inside the child, so it imports nothing.
 */
export const OBSERVER_KEY: unique symbol = Symbol.for("kauro.data-plane.isolation-observers");

export interface IsolationObservers {
  /** Writes outside the attempt scratch that the permission model refused (ERR_ACCESS_DENIED, FileSystemWrite). */
  outsideWriteAttempts: number;
  /** Connections, listens, datagram sockets, name resolutions, http(s)/http2 requests, fetch or WebSocket the hooks refused. */
  networkAttempts: number;
  /** Child processes, workers, native addons or WASI instances the permission model refused. */
  processAttempts: number;
  /** The refused network entry points, in order (API names only, never a target), at most 64. */
  network: string[];
}

/** The line prefix of the child's single result record on stdout. */
export const RESULT_MARK = "\u001eKAURO-SANDBOX-RESULT ";

export interface SandboxJob {
  /** Absolute path of the task module (ESM) exporting `run(payload, { workDir })`. */
  readonly task: string;
  readonly payload: unknown;
  readonly workDir: string;
}

export interface SandboxFailure {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export interface SandboxRecord {
  readonly outcome: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: SandboxFailure };
  readonly observers: IsolationObservers;
}

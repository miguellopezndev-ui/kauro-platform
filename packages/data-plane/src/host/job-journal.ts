/**
 * The local host's job records (B14-A; docs/design/B14-A-recovery.md §7): one file per identity, `jobs/<identity>.json`, written by
 * the one live host of the root (root-lock.ts) and read back only when a host opens the root. From then on the host answers from the
 * records it holds in memory, and every change is written through before the change is acted on.
 *
 * A record is replaced whole and durably: written to a temporary file, flushed to the device, renamed over the old one. So a record on
 * disk is always a complete version, the new one or the previous; a temporary file left by a host that died mid-write is discarded at
 * the next opening (its rename never happened, so the change it carried was never acted on). A record that cannot be read at opening
 * is no proof of anything: its identity answers only the host's transient failure (HostRecordUnreadable), never absent, never ended.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Sha256Hex } from "@kauro/contracts";
import { isAttemptIdentity, type WorkerFailureCause, type WorkerManifestReference } from "@kauro/application";

export const LOCAL_PROCESS_HOST = "kauro-local-process-host";

export type RecordState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TERMINATED";
export const TERMINAL: ReadonlySet<RecordState> = new Set(["SUCCEEDED", "FAILED", "TERMINATED"]);
const STATES: ReadonlySet<string> = new Set(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "TERMINATED"]);

/** The note of an identity terminated before any create: a tombstone, never a job (observe answers NOT_FOUND, launch REFUSED). */
export const CANCELLED_BEFORE_CREATE = "CANCELLED_BEFORE_CREATE";

/** The durable record of one provider job (ids, tokens, instants and sizes only; never a customer value). */
export interface LocalJobRecord {
  readonly host: typeof LOCAL_PROCESS_HOST;
  readonly identity: string;
  readonly ticketDigest: Sha256Hex;
  state: RecordState;
  /** Evidence only: the host signals its worker through its own child, never by this number. */
  pid: number | null;
  createdAtMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  lastHeartbeatMs: number | null;
  cause: WorkerFailureCause | null;
  /** Why the host ended the job, when it did (TERMINATED_BY_HOST, DEADLINE, HOST_RESTARTED, NO_RESULT, MEMORY_EXHAUSTED, ...). */
  note: string | null;
  manifest: WorkerManifestReference | null;
  refusal: string | null;
  peakScratchBytes: number;
  peakMemoryBytes: number;
  /** The worker's exact command line (evidence of its confinement). */
  readonly flags: readonly string[];
  readonly hardMemoryBytes: number;
  readonly hardScratchBytes: number;
}

/** A job's record could not be read when the host opened its root: the host knows nothing about the job (a transient failure). */
export class HostRecordUnreadable extends Error {
  readonly code = "HOST_RECORD_UNREADABLE";
  readonly transient = true;
  constructor(identity: string, cause: unknown) {
    super(`${LOCAL_PROCESS_HOST}: the record of ${identity} could not be read`, { cause });
    this.name = "HostRecordUnreadable";
  }
}

const SUFFIX = ".json";
const TEMPORARY = ".tmp";

function recordOf(identity: string, text: string): LocalJobRecord {
  const record = JSON.parse(text) as LocalJobRecord;
  if (record === null || typeof record !== "object" || record.host !== LOCAL_PROCESS_HOST || record.identity !== identity || !STATES.has(record.state)) throw new TypeError("not a job record of this host");
  return record;
}

export class JobJournal {
  readonly #dir: string;
  readonly #records = new Map<string, LocalJobRecord>();
  readonly #unreadable = new Map<string, unknown>();

  /** Reads every record of the root; temporary files of a host that died mid-write are discarded. */
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#dir = dir;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(TEMPORARY)) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      const identity = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : "";
      if (!isAttemptIdentity(identity)) continue;
      try {
        this.#records.set(identity, recordOf(identity, readFileSync(join(dir, name), "utf8")));
      } catch (error) {
        this.#unreadable.set(identity, error);
      }
    }
  }

  /** The record of `identity` (the same object every time), null when the root holds none; throws when it could not be read. */
  get(identity: string): LocalJobRecord | null {
    const failure = this.#unreadable.get(identity);
    if (failure !== undefined) throw new HostRecordUnreadable(identity, failure);
    return this.#records.get(identity) ?? null;
  }

  /** Every record that is neither ended nor a tombstone (at opening: the previous host's unfinished jobs). */
  unfinished(): LocalJobRecord[] {
    return [...this.#records.values()].filter((r) => !TERMINAL.has(r.state));
  }

  /**
   * Writes `record` durably and only then holds it: a first write that throws leaves the identity absent on disk and here (a create
   * that fails created nothing). A record already held is the same object as its holder's, so a later write records the holder's change;
   * one that throws leaves the previous version on disk, which a later opening reads.
   */
  write(record: LocalJobRecord): void {
    if (!isAttemptIdentity(record.identity)) throw new TypeError(`${LOCAL_PROCESS_HOST}: a record is an attempt's identity`);
    const path = join(this.#dir, `${record.identity}${SUFFIX}`);
    const temporary = `${path}${TEMPORARY}`;
    try {
      const fd = openSync(temporary, "w");
      try {
        writeSync(fd, JSON.stringify(record));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    if (process.platform === "linux") {
      // the rename itself, durable: the directory's entry is flushed too
      const dirFd = openSync(this.#dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
    this.#records.set(record.identity, record);
  }
}

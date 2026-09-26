/**
 * CONTRACT FAKE — evidence class SIMULATED. The labelled contract fake of `AuthorityJournalPort` (B07 mandate B07-PROVIDER-FAKES;
 * design docs/design/B07-upload-source-lifecycle.md D-RESTORE-1, §12.4, §15). The only fake of this port, reachable only through
 * the test-only subpath `@kauro/application/testing` and bound by no composition root; the real external journal (outside the
 * restore boundary of the database) is B15's, and its restore reconciliation is B16's.
 *
 * What it models, because restore correctness depends on it (09 "Deletion receipts and restoration": tombstones survive separately
 * from the database and restoration applies them, in order, before traffic):
 *
 * - An append-only file outside the database: one line per tombstone (canonical JSON, labelled with the provider token
 *   `contract-fake-journal` and the evidence class), appended and never rewritten; a new instance over the same file — the
 *   process after a database restore — lists exactly what was appended before.
 * - Idempotence by event id: appending a tombstone whose id is present answers ALREADY_PRESENT and writes nothing; a tombstone
 *   that reuses a present id with other members, or another id with a present sequence, is refused (a journal never holds two
 *   versions of one fact).
 * - Order: `list` answers an agency's tombstones after a sequence in ascending domain-event sequence, whatever order the
 *   at-least-once consumer appended them in.
 * - The port's contract on every appended tombstone: exactly the nine members; UUIDv7 identities; one of the (kind, state) pairs
 *   `AUTHORITY_TOMBSTONES` names; an ISO-8601 UTC instant; a positive sequence; and the evidence hash equal to the
 *   KAURO_AUTHORITY_TOMBSTONE_V1 digest of the other eight members (`authorityTombstoneHashOf`). A tombstone that breaks it is
 *   refused before anything is written.
 * - A call log (no tombstone content beyond identities and the outcome) and hold points that pause an append on arrival until the
 *   test releases it, so a test fixes an interleaving without sleeping.
 *
 * Appends and reads of one file are serialized inside the process (every instance over the same path shares the queue); writers
 * in other processes are not modelled. The fake never reads a clock: every instant in a tombstone is the platform's.
 */
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Sha256Hex } from "@kauro/contracts";
import { canonicalize, isSha256Hex, parseCanonical } from "@kauro/contracts";
import type { AgencyId } from "@kauro/domain";
import { authorityTombstoneHashOf, isUuidV7 } from "@kauro/domain";
import type { AuthorityJournalPort, AuthorityTombstone, AuthorityTombstoneKind, AuthorityTombstoneState, ProviderEvidenceClass } from "../ports/source-providers.js";
import { AUTHORITY_TOMBSTONES } from "../ports/source-providers.js";

/** The provider token of the fake journal: every line it writes names it. */
export const CONTRACT_FAKE_JOURNAL_PROVIDER = "contract-fake-journal";

const TOMBSTONE_MEMBERS = ["agencyId", "evidenceHash", "kind", "occurredAt", "revisionId", "sequence", "state", "subjectId", "tombstoneId"] as const;
const LINE_MEMBERS = ["evidenceClass", "provider", "tombstone"] as const;
/** An ISO-8601 UTC instant as the platform writes one: whole seconds, or up to microseconds (the database clock, D-CLOCK-1). */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;
/** The largest sequence a canonical JSON number carries exactly (the canonical profile refuses integers of 16 digits or more). */
const MAX_SEQUENCE = 999_999_999_999_999;
/** Every (kind, state) pair a routed event produces (AUTHORITY_TOMBSTONES); nothing else is a tombstone. */
const TOMBSTONE_PAIRS: ReadonlySet<string> = new Set(Object.values(AUTHORITY_TOMBSTONES).map((t) => `${t.kind}/${t.state}`));

export type ContractFakeJournalErrorCode =
  /** The tombstone breaks the port's contract (members, identities, kind and state, instant, sequence, evidence hash). */
  | "INVALID_TOMBSTONE"
  /** A present event id with other members, or another event id with a present sequence: the journal holds one version of a fact. */
  | "CONFLICT"
  /** A `list` argument outside the port's contract. */
  | "INVALID_REQUEST"
  /** The file holds a line this journal did not write (not canonical, not labelled, not a valid tombstone, or torn). */
  | "CORRUPT_JOURNAL";

export class ContractFakeJournalError extends Error {
  readonly code: ContractFakeJournalErrorCode;
  readonly provider = CONTRACT_FAKE_JOURNAL_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass = "SIMULATED";
  constructor(code: ContractFakeJournalErrorCode, message: string) {
    super(`${CONTRACT_FAKE_JOURNAL_PROVIDER} (SIMULATED): ${code}: ${message}`);
    this.name = "ContractFakeJournalError";
    this.code = code;
  }
}

export interface ContractFakeAuthorityJournalOptions {
  /** The journal file (created by the first append). Tests put it in their own temporary directory. */
  readonly path: string;
}

/** One journal call as the fake recorded it. */
export interface JournalCall {
  readonly sequence: number;
  readonly operation: "append" | "list";
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  /** The appended tombstone's event id, or the listed agency. */
  readonly subject: string;
  /** APPENDED, ALREADY_PRESENT, `LISTED <n>`, or `FAILED <code>`; PENDING while held or running. */
  readonly outcome: string;
}

/** A hold point: the next append signals `reached` on arrival and proceeds (to the serialized write) on `release()`. */
export interface JournalHold {
  readonly reached: Promise<void>;
  release(): void;
}

/** The queue of each journal file inside this process: appends and reads of one file never interleave. */
const FILE_QUEUES = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = FILE_QUEUES.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  FILE_QUEUES.set(path, settled);
  void settled.then(() => {
    if (FILE_QUEUES.get(path) === settled) FILE_QUEUES.delete(path);
  });
  return next;
}

export class ContractFakeAuthorityJournal implements AuthorityJournalPort {
  readonly provider = CONTRACT_FAKE_JOURNAL_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass = "SIMULATED";
  readonly contractFake = true;
  /** The absolute path of the journal file. */
  readonly path: string;
  readonly #calls: Array<{ sequence: number; operation: "append" | "list"; subject: string; outcome: string }> = [];
  readonly #holds: Array<{ readonly signal: () => void; readonly released: Promise<void> }> = [];

  constructor(options: ContractFakeAuthorityJournalOptions) {
    if (options === null || typeof options !== "object" || typeof options.path !== "string" || options.path.length === 0) {
      throw new RangeError(`${CONTRACT_FAKE_JOURNAL_PROVIDER}: a journal needs the path of its file`);
    }
    this.path = resolve(options.path);
  }

  async append(tombstone: AuthorityTombstone): Promise<"APPENDED" | "ALREADY_PRESENT"> {
    const call = this.#record("append", typeof tombstone?.tombstoneId === "string" ? tombstone.tombstoneId : "");
    try {
      const hold = this.#holds.shift();
      if (hold !== undefined) {
        hold.signal();
        await hold.released;
      }
      const checked = checkedTombstone(tombstone, "INVALID_TOMBSTONE");
      const line = canonicalize({ provider: this.provider, evidenceClass: this.evidenceClass, tombstone: checked });
      const outcome = await serialized(this.path, async () => {
        const present = await this.#read();
        const sameId = present.find((t) => t.tombstoneId === checked.tombstoneId);
        if (sameId !== undefined) {
          if (canonicalize(sameId) !== canonicalize(checked)) throw new ContractFakeJournalError("CONFLICT", `event ${checked.tombstoneId} is journaled with other members`);
          return "ALREADY_PRESENT" as const;
        }
        if (present.some((t) => t.sequence === checked.sequence)) throw new ContractFakeJournalError("CONFLICT", `sequence ${checked.sequence} is journaled for another event`);
        await appendFile(this.path, `${line}\n`, { encoding: "utf8", flag: "a" });
        return "APPENDED" as const;
      });
      call.outcome = outcome;
      return outcome;
    } catch (error) {
      call.outcome = `FAILED ${error instanceof ContractFakeJournalError ? error.code : "ERROR"}`;
      throw error;
    }
  }

  async list(agencyId: AgencyId, afterSequence: number): Promise<ReadonlyArray<AuthorityTombstone>> {
    const call = this.#record("list", typeof agencyId === "string" ? agencyId : "");
    try {
      if (!isUuidV7(agencyId)) throw new ContractFakeJournalError("INVALID_REQUEST", "agencyId must be a UUIDv7");
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new ContractFakeJournalError("INVALID_REQUEST", "afterSequence must be a non-negative integer");
      const present = await serialized(this.path, () => this.#read());
      const listed = present.filter((t) => t.agencyId === agencyId && t.sequence > afterSequence).sort((a, b) => a.sequence - b.sequence);
      call.outcome = `LISTED ${listed.length}`;
      return Object.freeze(listed);
    } catch (error) {
      call.outcome = `FAILED ${error instanceof ContractFakeJournalError ? error.code : "ERROR"}`;
      throw error;
    }
  }

  /** A hold point on the next append: it signals `reached` once the call arrived and proceeds on `release()`. */
  holdNextAppend(): JournalHold {
    let signal: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((done) => {
      signal = done;
    });
    const released = new Promise<void>((done) => {
      release = done;
    });
    this.#holds.push({ signal, released });
    return { reached, release };
  }

  /** The journal calls of this instance so far, in arrival order. */
  calls(): ReadonlyArray<JournalCall> {
    return this.#calls.map((c) => Object.freeze({ sequence: c.sequence, operation: c.operation, provider: this.provider, evidenceClass: this.evidenceClass, subject: c.subject, outcome: c.outcome }));
  }

  #record(operation: "append" | "list", subject: string): { sequence: number; operation: "append" | "list"; subject: string; outcome: string } {
    const call = { sequence: this.#calls.length + 1, operation, subject, outcome: "PENDING" };
    this.#calls.push(call);
    return call;
  }

  /** Every tombstone of the file in append order; an absent file is an empty journal. */
  async #read(): Promise<AuthorityTombstone[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) throw new ContractFakeJournalError("CORRUPT_JOURNAL", "the last line is torn");
    const tombstones: AuthorityTombstone[] = [];
    for (const line of text.slice(0, -1).split("\n")) {
      let parsed: unknown;
      try {
        parsed = parseCanonical(line);
      } catch {
        throw new ContractFakeJournalError("CORRUPT_JOURNAL", "a line is not canonical JSON");
      }
      if (canonicalize(parsed) !== line || !isRecord(parsed) || !hasExactly(parsed, LINE_MEMBERS) || parsed["provider"] !== CONTRACT_FAKE_JOURNAL_PROVIDER || parsed["evidenceClass"] !== "SIMULATED") {
        throw new ContractFakeJournalError("CORRUPT_JOURNAL", "a line this journal did not write");
      }
      tombstones.push(checkedTombstone(parsed["tombstone"], "CORRUPT_JOURNAL"));
    }
    return tombstones;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactly(value: Readonly<Record<string, unknown>>, members: ReadonlyArray<string>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === members.length && keys.every((k, i) => k === members[i]);
}

function isUtcInstantText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = UTC_INSTANT.exec(value);
  if (m === null) return false;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** The port's contract on one tombstone; a frozen copy with exactly its nine members, or the refusal `code`. */
function checkedTombstone(value: unknown, code: "INVALID_TOMBSTONE" | "CORRUPT_JOURNAL"): AuthorityTombstone {
  const refuse = (why: string): never => {
    throw new ContractFakeJournalError(code, why);
  };
  if (!isRecord(value) || !hasExactly(value, TOMBSTONE_MEMBERS)) return refuse("a tombstone has exactly the nine members of the port");
  const { tombstoneId, kind, agencyId, revisionId, subjectId, state, occurredAt, sequence, evidenceHash } = value;
  if (!isUuidV7(tombstoneId) || !isUuidV7(agencyId) || !isUuidV7(revisionId) || !isUuidV7(subjectId)) return refuse("identities are UUIDv7");
  if (typeof kind !== "string" || typeof state !== "string" || !TOMBSTONE_PAIRS.has(`${kind}/${state}`)) return refuse(`(${String(kind)}, ${String(state)}) is not a tombstone AUTHORITY_TOMBSTONES names`);
  if (!isUtcInstantText(occurredAt)) return refuse("occurredAt is not an ISO-8601 UTC instant");
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) return refuse(`sequence is an integer 1..${MAX_SEQUENCE}`);
  if (typeof evidenceHash !== "string" || !isSha256Hex(evidenceHash)) return refuse("evidenceHash is a SHA-256 hex digest");
  const members = { tombstoneId, kind, agencyId, revisionId, subjectId, state, occurredAt, sequence };
  if (authorityTombstoneHashOf(members) !== evidenceHash) return refuse("evidenceHash is not the KAURO_AUTHORITY_TOMBSTONE_V1 digest of the other members");
  return Object.freeze({
    tombstoneId,
    kind: kind as AuthorityTombstoneKind,
    agencyId: agencyId as AgencyId,
    revisionId: revisionId as AuthorityTombstone["revisionId"],
    subjectId,
    state: state as AuthorityTombstoneState,
    occurredAt,
    sequence,
    evidenceHash: evidenceHash as Sha256Hex,
  });
}

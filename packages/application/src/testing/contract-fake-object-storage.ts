/**
 * CONTRACT FAKE — evidence class SIMULATED. The labelled contract fake of `ObjectStoragePort` (B07 mandate B07-PROVIDER-FAKES;
 * design docs/design/B07-upload-source-lifecycle.md §2 and §15). It is the only fake of this port (one owner), it lives only under
 * the test-only subpath `@kauro/application/testing` (architecture rule `testOnlySubpaths`), no composition root binds it, and
 * nothing it produces is ever counted as real integration: every location it hands out names the provider token
 * `contract-fake-storage`, every session reference, completion reference, page token and retention read-back carries that token,
 * and it reports `evidenceClass: "SIMULATED"` (21 "Evidence classes": SIMULATED demonstrates a local contract with fakes; it is
 * never EXECUTED_PROVIDER). The real Cloud Storage adapter is B15's.
 *
 * What it models, because the platform's correctness depends on it (09 "Storage zones and object registry", "Resumable session
 * security", "Soft delete, versioning and holds"; R2-051):
 *
 * - Generations. Every write creates a new immutable generation of a name; a name has at most one live generation. Every platform
 *   write carries a no-overwrite precondition (a resumable session finalizes only while the name holds no live object; a copy
 *   only to a name that holds none), reads and copies name an exact source generation, and a delete names the generation it
 *   removes (PRECONDITION_FAILED when the name now holds another one).
 * - Resumable sessions. A session is a bearer credential usable from its creation until its provider horizon
 *   (`sessionLifetimeSeconds`, default the D-SESSION-3 lifetime of 604,800 s) unless a cancellation actually took effect — the
 *   platform's application deadline (24 h) is unknown to the provider, so a session outlives it. The browser side of a session is
 *   simulated by `writeThroughSession` / `uploadThroughSession`, which answer what the provider would (usable, cancelled,
 *   expired, closed, misaligned chunk, length mismatch, overwrite refused) and, on finalization, the completion reference a
 *   browser forwards to CompleteUpload.
 * - Cancellation. `cancelResumableSession` answers CONFIRMED, UNSUPPORTED or UNCERTAIN as scripted (`scriptCancellation`); an
 *   UNCERTAIN answer states separately whether the session was in fact cancelled. With no script it answers what the capability
 *   says (SUPPORTED: CONFIRMED; UNSUPPORTED: UNSUPPORTED); a script that contradicts the capability is refused.
 * - Soft delete and versioning. A deleted (or, without versioning, overwritten) generation is kept soft-deleted for the location's
 *   retention at the instant of its deletion, and the retention read-back reports the location's policy with the hash of the raw
 *   read-back document; a later policy change never shortens a retention already applied. With versioning, an overwritten
 *   generation stays readable as noncurrent.
 * - A call log of every provider call (never the bearer session reference: its SHA-256 digest only), hold points that pause a
 *   call until the test releases it (interleavings without sleeps), and scripted faults (UNAVAILABLE before any effect; a TIMEOUT
 *   whose effect was or was not applied — the provider acted and the answer was lost).
 *
 * The provider's clock is injected (`clock`, default the system clock): tests move it explicitly to stand past the application
 * deadline or at the provider horizon. It is the provider's clock only — every lifecycle instant of the platform is the
 * database's (D-CLOCK-1), and nothing here writes one.
 */
import { randomUUID } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, canonicalize, compareCodePoints, parseCanonical, rawDigest } from "@kauro/contracts";
import type { Clock, CompletionClaim, StorageZone } from "@kauro/domain";
import { COMPLETION_REF_MAX_CHARS, PROVIDER_SESSION_LIFETIME_SECONDS, isObjectName, textDigest, toUtcInstant } from "@kauro/domain";
import type {
  ObjectObservation,
  ObjectStoragePort,
  ProviderCancellationResult,
  ProviderEvidenceClass,
  ResumableSession,
  StorageLocation,
} from "../ports/source-providers.js";
import { providerChecksumsOf } from "./provider-checksums.js";

/** The provider token of the fake: every location, reference and read-back it produces names it. */
export const CONTRACT_FAKE_STORAGE_PROVIDER = "contract-fake-storage";
/** The `kind` of the completion reference the fake's finalized sessions answer (Cloud Storage: `storage#object`). */
export const CONTRACT_FAKE_COMPLETION_KIND = "contract-fake-storage#object";
/** The chunk multiple a client respects when resuming (Cloud Storage: 256 KiB). */
export const CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES = 262_144;
/** The retention a location reads back until a test sets another: the provider default for a new bucket (seven days, no versioning). */
export const CONTRACT_FAKE_DEFAULT_RETENTION: RetentionPolicy = Object.freeze({ softDeleteRetentionSeconds: 604_800, objectVersioning: false });

/**
 * The resumable session URI the fake mints: an https URI like the provider's own (the protected response carries an https upload URL,
 * ProtectedSessionView), on the reserved .invalid domain (RFC 2606) so it can never reach a network.
 */
export const CONTRACT_FAKE_SESSION_REF_PREFIX = `https://${CONTRACT_FAKE_STORAGE_PROVIDER}.invalid/resumable-session/`;
const SESSION_REF_PREFIX = CONTRACT_FAKE_SESSION_REF_PREFIX;
const PAGE_TOKEN_PREFIX = `${CONTRACT_FAKE_STORAGE_PROVIDER}:page:`;
const ZONES: ReadonlyArray<StorageZone> = ["QUARANTINE", "ACCEPTED", "PROFILE", "MINIMIZED", "STAGING", "DELIVERY", "IMPORT_RECEIPT", "LEGAL_FINANCE", "SECURITY"];
const LOCATION_REF = /^[A-Z][A-Z0-9_]{2,63}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const SIZE = /^(0|[1-9][0-9]{0,15})$/;
const CRC32C_BASE64 = /^[A-Za-z0-9+/]{6}==$/;
const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;
/** The soft-delete retention a location can report (the registry column's bound: 0 .. 90 days). */
const MAX_SOFT_DELETE_RETENTION_SECONDS = 7_776_000;

/** Every provider call of the port (the pure `location`, `capabilities` and `parseCompletionClaim` reach no provider). */
export type StorageOperation =
  | "createResumableSession"
  | "cancelResumableSession"
  | "stat"
  | "read"
  | "copy"
  | "delete"
  | "list"
  | "readRetentionPolicy"
  | "listSoftDeleted";

export type ContractFakeStorageErrorCode =
  /** Scripted: the provider refused the call before any effect (transient). */
  | "UNAVAILABLE"
  /** Scripted: no answer within the timeout; the effect may or may not have been applied (transient). */
  | "TIMEOUT"
  /** The request does not satisfy the port's contract (a name outside the platform grammar, a bad bound, a foreign page token). */
  | "INVALID_REQUEST"
  /** A location this provider never handed out. */
  | "UNKNOWN_LOCATION"
  /** A session reference this provider never issued. */
  | "UNKNOWN_SESSION"
  /** The exact generation read or copied is not held (live or noncurrent) any more. */
  | "GENERATION_NOT_FOUND"
  /** A no-overwrite precondition failed: the destination name holds a live object. */
  | "PRECONDITION_FAILED";

/** A failed provider call of the fake. `transient` is true only for the scripted UNAVAILABLE and TIMEOUT. */
export class ContractFakeStorageError extends Error {
  readonly code: ContractFakeStorageErrorCode;
  readonly transient: boolean;
  readonly provider = CONTRACT_FAKE_STORAGE_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass = "SIMULATED";
  constructor(code: ContractFakeStorageErrorCode, message: string) {
    super(`${CONTRACT_FAKE_STORAGE_PROVIDER} (SIMULATED): ${code}: ${message}`);
    this.name = "ContractFakeStorageError";
    this.code = code;
    this.transient = code === "UNAVAILABLE" || code === "TIMEOUT";
  }
}

/** A scripted fault of the next call of one operation: refused before any effect, or timed out with or without its effect. */
export type ScriptedFault = { readonly code: "UNAVAILABLE" } | { readonly code: "TIMEOUT"; readonly applied: boolean };

/**
 * A scripted cancellation answer. A bare "UNCERTAIN" is the provider answering without confirmation while the session in fact
 * stays usable; `{ answer: "UNCERTAIN", sessionCancelled: true }` is the answer lost after the cancellation took effect.
 */
export type ScriptedCancellation = ProviderCancellationResult | { readonly answer: "UNCERTAIN"; readonly sessionCancelled: boolean };

export interface RetentionPolicy {
  readonly softDeleteRetentionSeconds: number;
  readonly objectVersioning: boolean;
}

export interface ContractFakeObjectStorageOptions {
  /** The provider's clock (default: the system clock). Never a platform lifecycle instant. */
  readonly clock?: Clock;
  /** The provider horizon of a resumable session (default: PROVIDER_SESSION_LIFETIME_SECONDS, D-SESSION-3). */
  readonly sessionLifetimeSeconds?: number;
  /** Whether the provider can cancel a resumable session (default SUPPORTED). */
  readonly sessionCancellation?: "SUPPORTED" | "UNSUPPORTED";
  readonly chunkMultipleBytes?: number;
  /** The size of the chunks `read` streams (default 64 KiB). */
  readonly readChunkBytes?: number;
  /** The page size of `list` and `listSoftDeleted` (default 1,000). */
  readonly listPageSize?: number;
  /** The registry key of each zone's location (default `<ZONE>_PRIMARY`). */
  readonly locations?: Partial<Readonly<Record<StorageZone, string>>>;
  /** The retention every location reads back until `setRetentionPolicy` (default CONTRACT_FAKE_DEFAULT_RETENTION). */
  readonly retention?: RetentionPolicy;
}

export type GenerationStatus = "LIVE" | "NONCURRENT" | "SOFT_DELETED" | "PURGED";

/** How a generation came to exist: through a resumable session, a platform copy, or written outside the platform by a test. */
export type GenerationOrigin = "SESSION" | "COPY" | "PLANTED";

/** One generation as the provider holds it (test inspection only). */
export interface StoredGenerationView {
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly locationRef: string;
  readonly objectName: string;
  readonly generation: string;
  readonly bytes: number;
  readonly sha256: Sha256Hex;
  readonly crc32c: string;
  readonly md5: string;
  readonly origin: GenerationOrigin;
  readonly status: GenerationStatus;
  readonly createdAt: UtcInstant;
  readonly softDeletedAt?: UtcInstant;
  readonly softDeleteExpiresAt?: UtcInstant;
}

export type ResumableSessionState = "OPEN" | "FINALIZED" | "CANCELLED" | "FAILED";

/** One resumable session as the provider holds it (test inspection only; the bearer reference appears as its SHA-256). */
export interface ResumableSessionView {
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly sessionDigest: Sha256Hex;
  readonly locationRef: string;
  readonly objectName: string;
  readonly declaredBytes: number;
  readonly receivedBytes: number;
  readonly state: ResumableSessionState;
  readonly createdAt: UtcInstant;
  readonly providerExpiresAt: UtcInstant;
  /** OPEN and before the provider horizon on the provider's clock: a holder of the reference can still write. */
  readonly usable: boolean;
  readonly generation?: string;
  readonly cancellationAnswers: ReadonlyArray<ProviderCancellationResult>;
}

export type SessionWriteRefusal =
  | "UNKNOWN_SESSION"
  | "SESSION_CANCELLED"
  | "SESSION_EXPIRED"
  /** Finalized or failed: the session accepts nothing more. */
  | "SESSION_CLOSED"
  /** More bytes than declared, or a final write that does not complete the declared length. */
  | "LENGTH_MISMATCH"
  /** A non-final chunk that is not a multiple of the chunk multiple. */
  | "CHUNK_NOT_ALIGNED"
  /** The no-overwrite precondition failed at finalization: the name holds a live object (the session fails). */
  | "PRECONDITION_FAILED";

/** What the provider answers a holder of a session reference (the browser). */
export type SessionWriteResult =
  | { readonly outcome: "IN_PROGRESS"; readonly receivedBytes: number }
  | { readonly outcome: "FINALIZED"; readonly generation: string; readonly bytes: number; readonly completionRef: string }
  | { readonly outcome: "REFUSED"; readonly reason: SessionWriteRefusal };

/** One provider call as the fake recorded it (never a bearer session reference). */
export interface ProviderCall {
  readonly sequence: number;
  readonly operation: StorageOperation;
  /** The provider's clock when the call arrived. */
  readonly at: UtcInstant;
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly request: Readonly<Record<string, string | number | null>>;
  /** PENDING while held or running; then the answer (e.g. `SESSION <digest>`, `PRESENT <generation>`, `DELETED`) or `FAILED <code>`. */
  readonly outcome: string;
}

/** A hold point: the next call of an operation signals `reached` and waits until `release()`. */
export interface ProviderHold {
  readonly reached: Promise<void>;
  release(): void;
}

/** The raw retention read-back document whose SHA-256 is the read-back's evidence hash. */
export interface RetentionReadBackDocument {
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly locationRef: string;
  readonly softDeletePolicy: { readonly retentionDurationSeconds: number };
  readonly versioning: { readonly enabled: boolean };
  readonly observedAt: UtcInstant;
}

interface GenerationRecord {
  readonly locationRef: string;
  readonly objectName: string;
  readonly generation: string;
  readonly content: Uint8Array;
  readonly sha256: Sha256Hex;
  readonly crc32c: string;
  readonly md5: string;
  readonly origin: GenerationOrigin;
  readonly createdMs: number;
  status: GenerationStatus;
  softDeletedMs?: number;
  expiresMs?: number;
}

interface SessionRecord {
  readonly digest: Sha256Hex;
  readonly locationRef: string;
  readonly objectName: string;
  readonly declaredBytes: number;
  readonly contentType: string;
  readonly origin: string;
  readonly createdMs: number;
  readonly expiresMs: number;
  readonly chunks: Uint8Array[];
  receivedBytes: number;
  state: ResumableSessionState;
  generation?: string;
  readonly answers: ProviderCancellationResult[];
}

interface CallRecord {
  readonly sequence: number;
  readonly operation: StorageOperation;
  readonly at: UtcInstant;
  readonly request: Readonly<Record<string, string | number | null>>;
  outcome: string;
}

interface HoldRecord {
  readonly signal: () => void;
  readonly released: Promise<void>;
}

const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => new Date().toISOString(), nowMs: () => Date.now() });

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function invalid(message: string): ContractFakeStorageError {
  return new ContractFakeStorageError("INVALID_REQUEST", message);
}

/**
 * The completion reference a finalized session answers (the object resource a browser forwards to CompleteUpload as
 * `providerCompletionRef`). Tests build a false one with it (another generation, a false size or hash: S053).
 */
export function completionRefOf(claim: { readonly generation: string; readonly bytes: number; readonly crc32c?: string; readonly md5?: string }): string {
  const doc: Record<string, string> = { kind: CONTRACT_FAKE_COMPLETION_KIND, generation: claim.generation, size: String(claim.bytes) };
  if (claim.crc32c !== undefined) doc["crc32c"] = claim.crc32c;
  if (claim.md5 !== undefined) doc["md5Hash"] = claim.md5;
  return canonicalize(doc);
}

export class ContractFakeObjectStorage implements ObjectStoragePort {
  readonly provider = CONTRACT_FAKE_STORAGE_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass = "SIMULATED";
  readonly contractFake = true;

  readonly #clock: Clock;
  readonly #sessionLifetimeSeconds: number;
  readonly #sessionCancellation: "SUPPORTED" | "UNSUPPORTED";
  readonly #chunkMultipleBytes: number;
  readonly #readChunkBytes: number;
  readonly #listPageSize: number;
  readonly #locationOfZone = new Map<StorageZone, string>();
  readonly #zoneOfLocation = new Map<string, StorageZone>();
  readonly #retention = new Map<string, RetentionPolicy>();
  readonly #objects = new Map<string, GenerationRecord[]>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #calls: CallRecord[] = [];
  readonly #holds = new Map<StorageOperation, HoldRecord[]>();
  readonly #faults = new Map<StorageOperation, ScriptedFault[]>();
  readonly #cancellations: ScriptedCancellation[] = [];
  readonly #readBacks = new Map<Sha256Hex, RetentionReadBackDocument>();
  #lastGeneration = 0n;

  constructor(options: ContractFakeObjectStorageOptions = {}) {
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#sessionLifetimeSeconds = options.sessionLifetimeSeconds ?? PROVIDER_SESSION_LIFETIME_SECONDS;
    this.#sessionCancellation = options.sessionCancellation ?? "SUPPORTED";
    this.#chunkMultipleBytes = options.chunkMultipleBytes ?? CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES;
    this.#readChunkBytes = options.readChunkBytes ?? 65_536;
    this.#listPageSize = options.listPageSize ?? 1_000;
    for (const [name, value] of [["sessionLifetimeSeconds", this.#sessionLifetimeSeconds], ["chunkMultipleBytes", this.#chunkMultipleBytes], ["readChunkBytes", this.#readChunkBytes], ["listPageSize", this.#listPageSize]] as const) {
      if (!isPositiveInteger(value)) throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: ${name} must be a positive integer`);
    }
    const retention = options.retention ?? CONTRACT_FAKE_DEFAULT_RETENTION;
    for (const zone of ZONES) {
      const ref = options.locations?.[zone] ?? `${zone}_PRIMARY`;
      if (!LOCATION_REF.test(ref)) throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: location ${ref} is not a registry key`);
      if (this.#zoneOfLocation.has(ref)) throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: location ${ref} names two zones`);
      this.#locationOfZone.set(zone, ref);
      this.#zoneOfLocation.set(ref, zone);
      this.#retention.set(ref, checkedRetention(retention));
    }
  }

  // --- the port ---------------------------------------------------------------------------------------------------------------

  location(zone: StorageZone): StorageLocation {
    const locationRef = this.#locationOfZone.get(zone);
    if (locationRef === undefined) throw invalid(`unknown storage zone ${String(zone)}`);
    return Object.freeze({ provider: this.provider, locationRef });
  }

  capabilities(): { readonly sessionCancellation: "SUPPORTED" | "UNSUPPORTED"; readonly sessionLifetimeSeconds: number } {
    return Object.freeze({ sessionCancellation: this.#sessionCancellation, sessionLifetimeSeconds: this.#sessionLifetimeSeconds });
  }

  createResumableSession(
    request: { readonly location: StorageLocation; readonly objectName: string; readonly declaredBytes: number; readonly contentType: string; readonly origin: string },
    timeoutMs: number,
  ): Promise<ResumableSession> {
    return this.#call(
      "createResumableSession",
      { locationRef: request.location.locationRef, objectName: request.objectName, declaredBytes: request.declaredBytes, contentType: request.contentType, origin: request.origin, timeoutMs },
      () => {
        const locationRef = this.#knownLocation(request.location);
        if (!isPositiveInteger(timeoutMs)) throw invalid("timeoutMs must be a positive integer");
        if (!isObjectName(request.objectName)) throw invalid("the destination is not an opaque platform object name");
        if (!isPositiveInteger(request.declaredBytes)) throw invalid("declaredBytes must be a positive integer");
        if (typeof request.contentType !== "string" || request.contentType.length < 1 || request.contentType.length > 255) throw invalid("contentType must be 1..255 characters");
        if (!isOrigin(request.origin)) throw invalid("origin must be a URL origin");
        const createdMs = this.#clock.nowMs();
        const sessionRef = `${SESSION_REF_PREFIX}${randomUUID()}`;
        const digest = textDigest(sessionRef);
        this.#sessions.set(sessionRef, {
          digest,
          locationRef,
          objectName: request.objectName,
          declaredBytes: request.declaredBytes,
          contentType: request.contentType,
          origin: request.origin,
          createdMs,
          expiresMs: createdMs + this.#sessionLifetimeSeconds * 1000,
          chunks: [],
          receivedBytes: 0,
          state: "OPEN",
          answers: [],
        });
        const session: ResumableSession = Object.freeze({
          sessionRef,
          providerExpiresAt: toUtcInstant(createdMs + this.#sessionLifetimeSeconds * 1000),
          chunkMultipleBytes: this.#chunkMultipleBytes,
        });
        return { value: session, outcome: `SESSION ${digest}` };
      },
    );
  }

  cancelResumableSession(sessionRef: string, timeoutMs: number): Promise<ProviderCancellationResult> {
    return this.#call("cancelResumableSession", { sessionDigest: typeof sessionRef === "string" ? textDigest(sessionRef) : null, timeoutMs }, () => {
      if (!isPositiveInteger(timeoutMs)) throw invalid("timeoutMs must be a positive integer");
      const session = typeof sessionRef === "string" ? this.#sessions.get(sessionRef) : undefined;
      if (session === undefined) throw new ContractFakeStorageError("UNKNOWN_SESSION", "no session was issued under this reference");
      const scripted = this.#cancellations.shift();
      let answer: ProviderCancellationResult;
      let cancelled: boolean;
      if (scripted === undefined) {
        answer = this.#sessionCancellation === "SUPPORTED" ? "CONFIRMED" : "UNSUPPORTED";
        cancelled = answer === "CONFIRMED";
      } else if (typeof scripted === "string") {
        answer = scripted;
        cancelled = scripted === "CONFIRMED";
      } else {
        answer = scripted.answer;
        cancelled = scripted.sessionCancelled;
      }
      if (cancelled && session.state === "OPEN") session.state = "CANCELLED";
      session.answers.push(answer);
      return { value: answer, outcome: answer };
    });
  }

  stat(location: StorageLocation, objectName: string): Promise<ObjectObservation | null> {
    return this.#call("stat", { locationRef: location.locationRef, objectName }, () => {
      const locationRef = this.#knownLocation(location);
      if (typeof objectName !== "string" || objectName.length === 0) throw invalid("objectName must be a non-empty string");
      const live = this.#live(locationRef, objectName);
      if (live === undefined) return { value: null, outcome: "ABSENT" };
      const observation: ObjectObservation = Object.freeze({
        generation: live.generation,
        bytes: live.content.length,
        crc32c: live.crc32c,
        md5: live.md5,
        observedAt: this.#clock.now(),
      });
      return { value: observation, outcome: `PRESENT ${live.generation}` };
    });
  }

  read(location: StorageLocation, objectName: string, generation: string): AsyncIterable<Uint8Array> {
    return this.#stream(location, objectName, generation);
  }

  copy(
    from: { readonly location: StorageLocation; readonly objectName: string; readonly generation: string },
    to: { readonly location: StorageLocation; readonly objectName: string },
  ): Promise<{ readonly generation: string }> {
    return this.#call(
      "copy",
      { fromLocationRef: from.location.locationRef, fromObjectName: from.objectName, fromGeneration: from.generation, toLocationRef: to.location.locationRef, toObjectName: to.objectName },
      () => {
        const fromRef = this.#knownLocation(from.location);
        const toRef = this.#knownLocation(to.location);
        if (typeof from.generation !== "string" || !GENERATION.test(from.generation)) throw invalid("the source generation is not a provider generation");
        if (!isObjectName(to.objectName)) throw invalid("the destination is not an opaque platform object name");
        const source = this.#readable(fromRef, from.objectName, from.generation);
        if (source === undefined) throw new ContractFakeStorageError("GENERATION_NOT_FOUND", `generation ${from.generation} of the source is not held`);
        if (this.#live(toRef, to.objectName) !== undefined) throw new ContractFakeStorageError("PRECONDITION_FAILED", "ifGenerationMatch=0: the destination holds a live object");
        const created = this.#write(toRef, to.objectName, source.content, "COPY");
        return { value: Object.freeze({ generation: created.generation }), outcome: `COPIED ${created.generation}` };
      },
    );
  }

  delete(location: StorageLocation, objectName: string, generation: string): Promise<"DELETED" | "ALREADY_ABSENT" | "PRECONDITION_FAILED"> {
    return this.#call("delete", { locationRef: location.locationRef, objectName, generation }, () => {
      const locationRef = this.#knownLocation(location);
      if (typeof generation !== "string" || !GENERATION.test(generation)) throw invalid("the generation is not a provider generation");
      const target = this.#readable(locationRef, objectName, generation);
      let result: "DELETED" | "ALREADY_ABSENT" | "PRECONDITION_FAILED";
      if (target !== undefined) {
        this.#softDelete(target);
        result = "DELETED";
      } else {
        result = this.#live(locationRef, objectName) !== undefined ? "PRECONDITION_FAILED" : "ALREADY_ABSENT";
      }
      return { value: result, outcome: result };
    });
  }

  list(
    location: StorageLocation,
    prefix: string,
    page?: string,
  ): Promise<{ readonly objects: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly bytes: number }>; readonly next?: string }> {
    return this.#call("list", { locationRef: location.locationRef, prefix, page: page ?? null }, () => {
      const locationRef = this.#knownLocation(location);
      if (typeof prefix !== "string") throw invalid("prefix must be a string");
      const after = page === undefined ? null : decodePageToken(page);
      const live: GenerationRecord[] = [];
      for (const generations of this.#objects.values()) {
        for (const g of generations) if (g.locationRef === locationRef && g.status === "LIVE" && g.objectName.startsWith(prefix)) live.push(g);
      }
      live.sort((a, b) => compareCodePoints(a.objectName, b.objectName));
      const remaining = after === null ? live : live.filter((g) => compareCodePoints(g.objectName, after[0]) > 0);
      const slice = remaining.slice(0, this.#listPageSize);
      const objects = slice.map((g) => Object.freeze({ objectName: g.objectName, generation: g.generation, bytes: g.content.length }));
      const last = slice[slice.length - 1];
      const value = remaining.length > slice.length && last !== undefined ? { objects, next: encodePageToken([last.objectName, last.generation]) } : { objects };
      return { value: Object.freeze(value), outcome: `LISTED ${objects.length}${"next" in value ? " +" : ""}` };
    });
  }

  readRetentionPolicy(location: StorageLocation): Promise<{ readonly softDeleteRetentionSeconds: number; readonly objectVersioning: boolean; readonly evidenceHash: Sha256Hex; readonly observedAt: UtcInstant }> {
    return this.#call("readRetentionPolicy", { locationRef: location.locationRef }, () => {
      const locationRef = this.#knownLocation(location);
      const policy = this.#retention.get(locationRef) ?? CONTRACT_FAKE_DEFAULT_RETENTION;
      const observedAt = this.#clock.now();
      const document: RetentionReadBackDocument = Object.freeze({
        provider: this.provider,
        evidenceClass: this.evidenceClass,
        locationRef,
        softDeletePolicy: Object.freeze({ retentionDurationSeconds: policy.softDeleteRetentionSeconds }),
        versioning: Object.freeze({ enabled: policy.objectVersioning }),
        observedAt,
      });
      const evidenceHash = rawDigest(canonicalBytes(document));
      this.#readBacks.set(evidenceHash, document);
      return {
        value: Object.freeze({ softDeleteRetentionSeconds: policy.softDeleteRetentionSeconds, objectVersioning: policy.objectVersioning, evidenceHash, observedAt }),
        outcome: `RETENTION ${policy.softDeleteRetentionSeconds}s versioning=${policy.objectVersioning}`,
      };
    });
  }

  listSoftDeleted(
    location: StorageLocation,
    prefix: string,
    page?: string,
  ): Promise<{ readonly objects: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly softDeletedAt: UtcInstant; readonly expiresAt: UtcInstant }>; readonly next?: string }> {
    return this.#call("listSoftDeleted", { locationRef: location.locationRef, prefix, page: page ?? null }, () => {
      const locationRef = this.#knownLocation(location);
      if (typeof prefix !== "string") throw invalid("prefix must be a string");
      const after = page === undefined ? null : decodePageToken(page);
      this.#purgeExpired();
      const held: GenerationRecord[] = [];
      for (const generations of this.#objects.values()) {
        for (const g of generations) if (g.locationRef === locationRef && g.status === "SOFT_DELETED" && g.objectName.startsWith(prefix)) held.push(g);
      }
      held.sort(byNameThenGeneration);
      const remaining = after === null ? held : held.filter((g) => byNameThenGeneration(g, { objectName: after[0], generation: after[1] }) > 0);
      const slice = remaining.slice(0, this.#listPageSize);
      const objects = slice.map((g) =>
        Object.freeze({ objectName: g.objectName, generation: g.generation, softDeletedAt: toUtcInstant(g.softDeletedMs ?? g.createdMs), expiresAt: toUtcInstant(g.expiresMs ?? g.createdMs) }),
      );
      const last = slice[slice.length - 1];
      const value = remaining.length > slice.length && last !== undefined ? { objects, next: encodePageToken([last.objectName, last.generation]) } : { objects };
      return { value: Object.freeze(value), outcome: `LISTED ${objects.length}${"next" in value ? " +" : ""}` };
    });
  }

  parseCompletionClaim(ref: string): { readonly kind: "CLAIM"; readonly claim: CompletionClaim } | { readonly kind: "MALFORMED" } {
    const malformed = Object.freeze({ kind: "MALFORMED" as const });
    if (typeof ref !== "string" || ref.length < 1 || ref.length > COMPLETION_REF_MAX_CHARS) return malformed;
    let doc: unknown;
    try {
      doc = parseCanonical(ref);
    } catch {
      return malformed;
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return malformed;
    const members = doc as Readonly<Record<string, unknown>>;
    const allowed = new Set(["kind", "generation", "size", "crc32c", "md5Hash"]);
    if (Object.keys(members).some((k) => !allowed.has(k))) return malformed;
    const { kind, generation, size, crc32c, md5Hash } = { kind: members["kind"], generation: members["generation"], size: members["size"], crc32c: members["crc32c"], md5Hash: members["md5Hash"] };
    if (kind !== CONTRACT_FAKE_COMPLETION_KIND) return malformed;
    if (typeof generation !== "string" || !GENERATION.test(generation)) return malformed;
    if (typeof size !== "string" || !SIZE.test(size) || !Number.isSafeInteger(Number(size))) return malformed;
    if (crc32c !== undefined && (typeof crc32c !== "string" || !CRC32C_BASE64.test(crc32c))) return malformed;
    if (md5Hash !== undefined && (typeof md5Hash !== "string" || !MD5_BASE64.test(md5Hash))) return malformed;
    const claim: { generation: string; bytes: number; crc32c?: string; md5?: string } = { generation, bytes: Number(size) };
    if (typeof crc32c === "string") claim.crc32c = crc32c;
    if (typeof md5Hash === "string") claim.md5 = md5Hash;
    return Object.freeze({ kind: "CLAIM" as const, claim: Object.freeze(claim) });
  }

  // --- the browser side of a session (a holder of the bearer reference, outside the platform) -----------------------------------

  /**
   * Writes one chunk through a resumable session at its current offset, as a browser holding the reference would. A non-final
   * chunk must be a multiple of the chunk multiple; the final chunk must complete exactly the declared length, and finalization
   * applies the session's no-overwrite precondition. Usable until the provider horizon on the provider's clock unless a
   * cancellation took effect — the platform's application deadline plays no part here (R2-051).
   */
  writeThroughSession(sessionRef: string, chunk: Uint8Array, options: { readonly final: boolean }): SessionWriteResult {
    const session = this.#sessions.get(sessionRef);
    if (session === undefined) return refused("UNKNOWN_SESSION");
    if (session.state === "CANCELLED") return refused("SESSION_CANCELLED");
    if (session.state !== "OPEN") return refused("SESSION_CLOSED");
    if (this.#clock.nowMs() >= session.expiresMs) return refused("SESSION_EXPIRED");
    const total = session.receivedBytes + chunk.length;
    if (total > session.declaredBytes) return refused("LENGTH_MISMATCH");
    if (!options.final) {
      if (chunk.length % this.#chunkMultipleBytes !== 0) return refused("CHUNK_NOT_ALIGNED");
      session.chunks.push(chunk.slice());
      session.receivedBytes = total;
      return Object.freeze({ outcome: "IN_PROGRESS" as const, receivedBytes: session.receivedBytes });
    }
    if (total !== session.declaredBytes) return refused("LENGTH_MISMATCH");
    if (this.#live(session.locationRef, session.objectName) !== undefined) {
      session.state = "FAILED";
      return refused("PRECONDITION_FAILED");
    }
    const content = new Uint8Array(total);
    let offset = 0;
    for (const part of [...session.chunks, chunk]) {
      content.set(part, offset);
      offset += part.length;
    }
    session.chunks.length = 0;
    session.receivedBytes = total;
    const created = this.#write(session.locationRef, session.objectName, content, "SESSION");
    session.state = "FINALIZED";
    session.generation = created.generation;
    return Object.freeze({
      outcome: "FINALIZED" as const,
      generation: created.generation,
      bytes: total,
      completionRef: completionRefOf({ generation: created.generation, bytes: total, crc32c: created.crc32c, md5: created.md5 }),
    });
  }

  /** Writes the whole object through a session in one final request (`writeThroughSession` with `final: true`). */
  uploadThroughSession(sessionRef: string, content: Uint8Array): SessionWriteResult {
    return this.writeThroughSession(sessionRef, content, { final: true });
  }

  // --- test control and inspection ----------------------------------------------------------------------------------------------

  /** Queues the answers of the next cancellations, in call order. An answer the capability cannot give is refused. */
  scriptCancellation(...answers: ReadonlyArray<ScriptedCancellation>): void {
    for (const a of answers) {
      const answer = typeof a === "string" ? a : a.answer;
      const cancels = typeof a === "string" ? a === "CONFIRMED" : a.sessionCancelled;
      if (answer !== "CONFIRMED" && answer !== "UNSUPPORTED" && answer !== "UNCERTAIN") throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: ${String(answer)} is not a cancellation answer`);
      if (this.#sessionCancellation === "UNSUPPORTED" && (answer === "CONFIRMED" || cancels)) {
        throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: a provider without session cancellation cannot answer ${answer}${cancels ? " with the session cancelled" : ""}`);
      }
    }
    this.#cancellations.push(...answers);
  }

  /**
   * Scripts a fault of the next call of an operation. A cancellation is never scripted to fail: the port records its result, so a
   * lost or failed cancellation is the answer UNCERTAIN (`scriptCancellation`).
   */
  failNext(operation: StorageOperation, fault: ScriptedFault): void {
    if (operation === "cancelResumableSession") throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: script UNCERTAIN instead; a cancellation answers, it does not fail`);
    const queue = this.#faults.get(operation) ?? [];
    queue.push(fault);
    this.#faults.set(operation, queue);
  }

  /** A hold point on the next call of an operation: it signals `reached` once the call arrived and proceeds on `release()`. */
  holdNext(operation: StorageOperation): ProviderHold {
    let signal: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = this.#holds.get(operation) ?? [];
    queue.push({ signal, released });
    this.#holds.set(operation, queue);
    return { reached, release };
  }

  /** The provider calls so far, in arrival order (optionally of one operation). */
  calls(operation?: StorageOperation): ReadonlyArray<ProviderCall> {
    return this.#calls
      .filter((c) => operation === undefined || c.operation === operation)
      .map((c) => Object.freeze({ sequence: c.sequence, operation: c.operation, at: c.at, provider: this.provider, evidenceClass: this.evidenceClass, request: c.request, outcome: c.outcome }));
  }

  /** Sets the soft-delete retention and versioning of a zone's location (what the next read-back reports and deletions apply). */
  setRetentionPolicy(zone: StorageZone, policy: RetentionPolicy): void {
    const locationRef = this.#locationOfZone.get(zone);
    if (locationRef === undefined) throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: unknown storage zone ${String(zone)}`);
    this.#retention.set(locationRef, checkedRetention(policy));
  }

  /** The raw read-back document behind an evidence hash this provider answered. */
  retentionReadBack(evidenceHash: Sha256Hex): RetentionReadBackDocument | undefined {
    return this.#readBacks.get(evidenceHash);
  }

  /**
   * Writes an object outside the platform (an orphan, a late object, an out-of-band overwrite): no call is logged. Refused when
   * the name holds a live object unless `overwrite` — then the overwritten generation becomes noncurrent (versioning) or
   * soft-deleted for the location's retention.
   */
  plantObject(location: StorageLocation, objectName: string, content: Uint8Array, options: { readonly overwrite?: boolean } = {}): { readonly generation: string } {
    const locationRef = this.#knownLocation(location);
    if (!isObjectName(objectName)) throw invalid("not an opaque platform object name");
    if (this.#live(locationRef, objectName) !== undefined && options.overwrite !== true) throw new ContractFakeStorageError("PRECONDITION_FAILED", "the name holds a live object");
    const created = this.#write(locationRef, objectName, content.slice(), "PLANTED");
    return Object.freeze({ generation: created.generation });
  }

  /** Deletes the live generation of a name outside the platform (a lost generation); null when the name holds none. */
  deleteOutOfBand(location: StorageLocation, objectName: string): { readonly generation: string } | null {
    const live = this.#live(this.#knownLocation(location), objectName);
    if (live === undefined) return null;
    this.#softDelete(live);
    return Object.freeze({ generation: live.generation });
  }

  /** Every generation the provider ever held under a name, oldest first, with its status on the provider's clock now. */
  generationsOf(location: StorageLocation, objectName: string): ReadonlyArray<StoredGenerationView> {
    this.#purgeExpired();
    const generations = this.#objects.get(objectKey(this.#knownLocation(location), objectName)) ?? [];
    return generations.map((g) => this.#view(g));
  }

  /** A session as the provider holds it; null for a reference it never issued. */
  sessionView(sessionRef: string): ResumableSessionView | null {
    const s = this.#sessions.get(sessionRef);
    if (s === undefined) return null;
    const view: ResumableSessionView = {
      provider: this.provider,
      evidenceClass: this.evidenceClass,
      sessionDigest: s.digest,
      locationRef: s.locationRef,
      objectName: s.objectName,
      declaredBytes: s.declaredBytes,
      receivedBytes: s.receivedBytes,
      state: s.state,
      createdAt: toUtcInstant(s.createdMs),
      providerExpiresAt: toUtcInstant(s.expiresMs),
      usable: s.state === "OPEN" && this.#clock.nowMs() < s.expiresMs,
      cancellationAnswers: Object.freeze([...s.answers]),
      ...(s.generation === undefined ? {} : { generation: s.generation }),
    };
    return Object.freeze(view);
  }

  /** Every session issued, in issue order. */
  sessionViews(): ReadonlyArray<ResumableSessionView> {
    return [...this.#sessions.keys()].map((ref) => this.sessionView(ref)).filter((v): v is ResumableSessionView => v !== null);
  }

  // --- internals ---------------------------------------------------------------------------------------------------------------

  async #call<T>(operation: StorageOperation, request: Readonly<Record<string, string | number | null>>, effect: () => { readonly value: T; readonly outcome: string }): Promise<T> {
    const record: CallRecord = { sequence: this.#calls.length + 1, operation, at: this.#clock.now(), request: Object.freeze({ ...request }), outcome: "PENDING" };
    this.#calls.push(record);
    try {
      const hold = this.#holds.get(operation)?.shift();
      if (hold !== undefined) {
        hold.signal();
        await hold.released;
      }
      const fault = this.#faults.get(operation)?.shift();
      if (fault !== undefined && !(fault.code === "TIMEOUT" && fault.applied)) {
        throw new ContractFakeStorageError(fault.code, fault.code === "UNAVAILABLE" ? "scripted: the provider refused the call" : "scripted: no answer within the timeout, nothing applied");
      }
      const { value, outcome } = effect();
      if (fault !== undefined) {
        record.outcome = `${outcome}; answer lost (TIMEOUT)`;
        throw new ContractFakeStorageError("TIMEOUT", "scripted: the provider applied the call and its answer was lost");
      }
      record.outcome = outcome;
      return value;
    } catch (error) {
      if (record.outcome === "PENDING") record.outcome = `FAILED ${error instanceof ContractFakeStorageError ? error.code : "ERROR"}`;
      throw error;
    }
  }

  async *#stream(location: StorageLocation, objectName: string, generation: string): AsyncGenerator<Uint8Array> {
    const content = await this.#call("read", { locationRef: location.locationRef, objectName, generation }, () => {
      const locationRef = this.#knownLocation(location);
      if (typeof generation !== "string" || !GENERATION.test(generation)) throw invalid("the generation is not a provider generation");
      const held = this.#readable(locationRef, objectName, generation);
      if (held === undefined) throw new ContractFakeStorageError("GENERATION_NOT_FOUND", `generation ${generation} is not held`);
      return { value: held.content, outcome: `READ ${held.content.length}` };
    });
    for (let offset = 0; offset < content.length; offset += this.#readChunkBytes) yield content.slice(offset, offset + this.#readChunkBytes);
  }

  #knownLocation(location: StorageLocation): string {
    if (location === null || typeof location !== "object" || location.provider !== this.provider || !this.#zoneOfLocation.has(location.locationRef)) {
      throw new ContractFakeStorageError("UNKNOWN_LOCATION", "a location this provider never handed out");
    }
    return location.locationRef;
  }

  #live(locationRef: string, objectName: string): GenerationRecord | undefined {
    return this.#objects.get(objectKey(locationRef, objectName))?.find((g) => g.status === "LIVE");
  }

  /** The exact generation when a read may still serve it: live, or noncurrent under versioning. */
  #readable(locationRef: string, objectName: string, generation: string): GenerationRecord | undefined {
    return this.#objects.get(objectKey(locationRef, objectName))?.find((g) => g.generation === generation && (g.status === "LIVE" || g.status === "NONCURRENT"));
  }

  #write(locationRef: string, objectName: string, content: Uint8Array, origin: GenerationOrigin): GenerationRecord {
    const key = objectKey(locationRef, objectName);
    const generations = this.#objects.get(key) ?? [];
    const previous = generations.find((g) => g.status === "LIVE");
    if (previous !== undefined) {
      const policy = this.#retention.get(locationRef) ?? CONTRACT_FAKE_DEFAULT_RETENTION;
      if (policy.objectVersioning) previous.status = "NONCURRENT";
      else this.#softDelete(previous);
    }
    const { crc32c, md5 } = providerChecksumsOf(content);
    const record: GenerationRecord = {
      locationRef,
      objectName,
      generation: this.#nextGeneration(),
      content,
      sha256: rawDigest(content),
      crc32c,
      md5,
      origin,
      createdMs: this.#clock.nowMs(),
      status: "LIVE",
    };
    generations.push(record);
    this.#objects.set(key, generations);
    return record;
  }

  /** Soft-deletes a generation for its location's retention at this instant (zero retention: gone at once). */
  #softDelete(g: GenerationRecord): void {
    const policy = this.#retention.get(g.locationRef) ?? CONTRACT_FAKE_DEFAULT_RETENTION;
    const now = this.#clock.nowMs();
    if (policy.softDeleteRetentionSeconds === 0) {
      g.status = "PURGED";
      return;
    }
    g.status = "SOFT_DELETED";
    g.softDeletedMs = now;
    g.expiresMs = now + policy.softDeleteRetentionSeconds * 1000;
  }

  #purgeExpired(): void {
    const now = this.#clock.nowMs();
    for (const generations of this.#objects.values()) {
      for (const g of generations) if (g.status === "SOFT_DELETED" && g.expiresMs !== undefined && g.expiresMs <= now) g.status = "PURGED";
    }
  }

  /** Provider generations are strictly increasing decimal integers (Cloud Storage: microseconds since the epoch). */
  #nextGeneration(): string {
    const candidate = BigInt(this.#clock.nowMs()) * 1000n;
    this.#lastGeneration = candidate > this.#lastGeneration ? candidate : this.#lastGeneration + 1n;
    return this.#lastGeneration.toString();
  }

  #view(g: GenerationRecord): StoredGenerationView {
    return Object.freeze({
      provider: this.provider,
      evidenceClass: this.evidenceClass,
      locationRef: g.locationRef,
      objectName: g.objectName,
      generation: g.generation,
      bytes: g.content.length,
      sha256: g.sha256,
      crc32c: g.crc32c,
      md5: g.md5,
      origin: g.origin,
      status: g.status,
      createdAt: toUtcInstant(g.createdMs),
      ...(g.softDeletedMs === undefined ? {} : { softDeletedAt: toUtcInstant(g.softDeletedMs) }),
      ...(g.expiresMs === undefined ? {} : { softDeleteExpiresAt: toUtcInstant(g.expiresMs) }),
    });
  }
}

function refused(reason: SessionWriteRefusal): SessionWriteResult {
  return Object.freeze({ outcome: "REFUSED" as const, reason });
}

function objectKey(locationRef: string, objectName: string): string {
  return `${locationRef}\u0000${objectName}`;
}

function checkedRetention(policy: RetentionPolicy): RetentionPolicy {
  const seconds = policy.softDeleteRetentionSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_SOFT_DELETE_RETENTION_SECONDS) {
    throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: soft-delete retention must be 0..${MAX_SOFT_DELETE_RETENTION_SECONDS} seconds`);
  }
  if (typeof policy.objectVersioning !== "boolean") throw new RangeError(`${CONTRACT_FAKE_STORAGE_PROVIDER}: objectVersioning must be a boolean`);
  return Object.freeze({ softDeleteRetentionSeconds: seconds, objectVersioning: policy.objectVersioning });
}

function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function byNameThenGeneration(a: { readonly objectName: string; readonly generation: string }, b: { readonly objectName: string; readonly generation: string }): number {
  const byName = compareCodePoints(a.objectName, b.objectName);
  if (byName !== 0) return byName;
  const x = BigInt(a.generation);
  const y = BigInt(b.generation);
  return x < y ? -1 : x > y ? 1 : 0;
}

function encodePageToken(after: readonly [string, string]): string {
  return PAGE_TOKEN_PREFIX + Buffer.from(canonicalize([after[0], after[1]]), "utf8").toString("base64url");
}

function decodePageToken(token: string): readonly [string, string] {
  if (typeof token !== "string" || !token.startsWith(PAGE_TOKEN_PREFIX)) throw invalid("not a page token of this provider");
  try {
    const value = parseCanonical(Buffer.from(token.slice(PAGE_TOKEN_PREFIX.length), "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" && GENERATION.test(value[1])) return [value[0], value[1]];
  } catch {
    // fall through: a token this provider did not mint
  }
  throw invalid("not a page token of this provider");
}

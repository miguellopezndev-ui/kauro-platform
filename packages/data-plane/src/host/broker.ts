/**
 * The attempt's storage broker (B14-A; docs/design/B14-A-worker-executor.md §4; registry B14 "actual capability broker"): the host side
 * of every storage call a worker makes. The worker holds no storage credential at all — it can reach objects only by asking the broker,
 * and the broker admits exactly what the attempt's capability names (D8-STG-1):
 *
 *   read   ACCEPTED   only an (object, generation) pair the capability's sealed generations name — another object, another
 *                     generation of the same object, or another project's object is OUTSIDE_CAPABILITY;
 *   read   STAGING    only names inside the attempt's own staging prefix (the writer's and the report's read-backs);
 *   stat   STAGING    the same prefix;
 *   create STAGING    a resumable session for a name inside the prefix, of a declared length within the attempt's hard scratch
 *                     bound; the session's bearer reference stays here and the worker receives an opaque handle;
 *   write / cancel    only through a handle this broker issued for this attempt.
 *
 * Nothing else crosses: no copy, delete, hold, listing, retention read or any other zone. A revoked broker (the attempt terminated,
 * cancelled, past its deadline or finished) refuses every call and cancels its open sessions. Each refusal is kept as evidence (the
 * operation and token, never a customer value).
 */
import { isObjectName } from "@kauro/domain";
import type { AttemptCapability, ObjectStoragePort, ResumableUploadPort, StorageLocation } from "@kauro/application";
import type { BrokeredZone, SessionAnswer, StatAnswer, WorkerCall, WorkerCallError } from "./protocol.js";

const GENERATION = /^[1-9][0-9]{0,19}$/;
/** The largest piece of a read the broker hands over at once (the worker pulls the next one when it has written this one). */
export const BROKER_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_OPEN_STREAMS = 16;

export class BrokerRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "BrokerRefusal";
  }
}

export interface AttemptStorageBrokerOptions {
  readonly capability: AttemptCapability;
  readonly storage: ObjectStoragePort;
  readonly uploads: ResumableUploadPort;
  /** The origin every session of the host is bound to (the worker never chooses it). */
  readonly origin: string;
  /** The largest object a worker may declare: its attempt's hard scratch bound. */
  readonly maxObjectBytes: number;
  /** Sessions one attempt may open (a package is tens of files; this bounds a runaway worker). Default 10 000. */
  readonly maxSessions?: number;
}

interface Stream {
  readonly iterator: AsyncIterator<Uint8Array>;
  pending: Uint8Array | null;
}

export interface BrokerRefusalRecord {
  readonly op: WorkerCall["op"];
  readonly code: string;
}

export class AttemptStorageBroker {
  readonly capability: AttemptCapability;
  readonly #o: AttemptStorageBrokerOptions;
  readonly #streams = new Map<number, Stream>();
  readonly #sessions = new Map<string, string>();
  readonly #refusals: BrokerRefusalRecord[] = [];
  #nextStream = 0;
  #nextSession = 0;
  #revoked: string | null = null;

  constructor(options: AttemptStorageBrokerOptions) {
    if (!Number.isSafeInteger(options.maxObjectBytes) || options.maxObjectBytes < 1) throw new TypeError("maxObjectBytes is a positive whole number");
    this.capability = options.capability;
    this.#o = options;
  }

  /** Why the broker refuses everything from now on, once it does. */
  get revoked(): string | null {
    return this.#revoked;
  }

  /** The refusals so far (evidence: the operation and the token). */
  refusals(): readonly BrokerRefusalRecord[] {
    return [...this.#refusals];
  }

  /** Refuses every later call and cancels the sessions still open (their bearer references are worth nothing after this). */
  async revoke(reason: string): Promise<void> {
    if (this.#revoked !== null) return;
    this.#revoked = reason;
    for (const stream of this.#streams.values()) await stream.iterator.return?.().catch(() => undefined);
    this.#streams.clear();
    const refs = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const ref of refs) await this.#o.storage.cancelResumableSession(ref, 10_000).catch(() => undefined);
  }

  /** Answers one call, or throws: a BrokerRefusal for what the capability does not admit, the provider's error for what failed there. */
  async handle(call: WorkerCall): Promise<unknown> {
    try {
      if (this.#revoked !== null) throw new BrokerRefusal("REVOKED", `the attempt's capability was revoked (${this.#revoked})`);
      return await this.#dispatch(call);
    } catch (error) {
      if (error instanceof BrokerRefusal) this.#refusals.push({ op: typeof call?.op === "string" ? call.op : ("unknown" as WorkerCall["op"]), code: error.code });
      throw error;
    }
  }

  async #dispatch(call: WorkerCall): Promise<unknown> {
    switch (call.op) {
      case "storage.readOpen":
        return this.#readOpen(call.zone, call.objectName, call.generation);
      case "storage.readNext":
        return this.#readNext(call.streamId);
      case "storage.readClose": {
        const stream = this.#streams.get(call.streamId);
        this.#streams.delete(call.streamId);
        await stream?.iterator.return?.().catch(() => undefined);
        return null;
      }
      case "storage.stat": {
        this.#staging(call.zone, call.objectName);
        return (await this.#o.storage.stat(this.#location("STAGING"), call.objectName)) satisfies StatAnswer;
      }
      case "storage.createSession":
        return this.#createSession(call);
      case "storage.cancelSession": {
        const ref = this.#session(call.handle);
        this.#sessions.delete(call.handle);
        return this.#o.storage.cancelResumableSession(ref, boundedTimeout(call.timeoutMs));
      }
      case "upload.writeChunk": {
        const ref = this.#session(call.handle);
        if (!(call.chunk instanceof Uint8Array) || call.chunk.byteLength > MAX_CHUNK_BYTES || typeof call.final !== "boolean") throw new BrokerRefusal("MALFORMED_CALL", "a chunk is at most 64 MiB of bytes");
        const answer = await this.#o.uploads.writeChunk(ref, call.chunk, { final: call.final });
        if (answer.outcome !== "IN_PROGRESS") this.#sessions.delete(call.handle);
        return answer;
      }
      case "stage":
        throw new BrokerRefusal("MALFORMED_CALL", "a stage is the host's, not the broker's");
      default:
        throw new BrokerRefusal("OUTSIDE_CAPABILITY", "the broker serves reads of the attempt's sealed source and writes to its own staging prefix only");
    }
  }

  #location(zone: BrokeredZone): StorageLocation {
    return this.#o.storage.location(zone);
  }

  #staging(zone: unknown, objectName: unknown): void {
    if (zone !== "STAGING") throw new BrokerRefusal("OUTSIDE_CAPABILITY", "only the attempt's staging prefix is written or observed");
    if (typeof objectName !== "string" || !isObjectName(objectName) || !objectName.startsWith(this.capability.stagingPrefix)) throw new BrokerRefusal("OUTSIDE_CAPABILITY", "the name is not inside the attempt's staging prefix");
  }

  async #readOpen(zone: unknown, objectName: unknown, generation: unknown): Promise<number> {
    if (typeof generation !== "string" || !GENERATION.test(generation)) throw new BrokerRefusal("MALFORMED_CALL", "a read names an exact generation");
    if (zone === "ACCEPTED") {
      const sealed = this.capability.acceptedGenerations.some((g) => g.objectName === objectName && g.generation === generation);
      if (!sealed) throw new BrokerRefusal("OUTSIDE_CAPABILITY", "the capability names no such sealed generation");
    } else this.#staging(zone, objectName);
    if (this.#streams.size >= MAX_OPEN_STREAMS) throw new BrokerRefusal("TOO_MANY_STREAMS", "too many reads are open at once");
    const iterator = this.#o.storage.read(this.#location(zone as BrokeredZone), objectName as string, generation)[Symbol.asyncIterator]();
    const id = ++this.#nextStream;
    this.#streams.set(id, { iterator, pending: null });
    return id;
  }

  async #readNext(streamId: unknown): Promise<Uint8Array | null> {
    const stream = typeof streamId === "number" ? this.#streams.get(streamId) : undefined;
    if (stream === undefined) throw new BrokerRefusal("STREAM_UNKNOWN", "no such read is open");
    let chunk = stream.pending;
    stream.pending = null;
    if (chunk === null) {
      const next = await stream.iterator.next();
      if (next.done === true) {
        this.#streams.delete(streamId as number);
        return null;
      }
      chunk = next.value;
    }
    if (chunk.byteLength > BROKER_READ_CHUNK_BYTES) {
      stream.pending = chunk.subarray(BROKER_READ_CHUNK_BYTES);
      chunk = chunk.subarray(0, BROKER_READ_CHUNK_BYTES);
    }
    return new Uint8Array(chunk);
  }

  async #createSession(call: Extract<WorkerCall, { op: "storage.createSession" }>): Promise<SessionAnswer> {
    this.#staging(call.zone, call.objectName);
    if (!Number.isSafeInteger(call.declaredBytes) || call.declaredBytes < 1 || call.declaredBytes > this.#o.maxObjectBytes) throw new BrokerRefusal("OUTSIDE_CAPABILITY", "the declared length passes the attempt's hard scratch bound");
    if (typeof call.contentType !== "string" || call.contentType.length === 0 || call.contentType.length > 128) throw new BrokerRefusal("MALFORMED_CALL", "a content type is a short token");
    if (this.#nextSession >= (this.#o.maxSessions ?? 10_000)) throw new BrokerRefusal("TOO_MANY_SESSIONS", "the attempt opened more sessions than a package has files");
    const session = await this.#o.storage.createResumableSession(
      { location: this.#location("STAGING"), objectName: call.objectName, declaredBytes: call.declaredBytes, contentType: call.contentType, origin: this.#o.origin },
      boundedTimeout(call.timeoutMs),
    );
    const handle = `session-${++this.#nextSession}`;
    this.#sessions.set(handle, session.sessionRef);
    return { handle, chunkMultipleBytes: session.chunkMultipleBytes, providerExpiresAt: session.providerExpiresAt };
  }

  #session(handle: unknown): string {
    const ref = typeof handle === "string" ? this.#sessions.get(handle) : undefined;
    if (ref === undefined) throw new BrokerRefusal("OUTSIDE_CAPABILITY", "no session of this attempt has this handle");
    return ref;
  }
}

function boundedTimeout(ms: unknown): number {
  return typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 1 ? Math.min(ms, 120_000) : 30_000;
}

/** A refusal or a provider failure as it crosses the channel. */
export function callErrorOf(error: unknown): WorkerCallError {
  if (error instanceof BrokerRefusal) return { code: error.code, message: error.message, transient: false };
  const transient = typeof error === "object" && error !== null && (error as { transient?: unknown }).transient === true;
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "PROVIDER_ERROR";
  return { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "PROVIDER_ERROR", message: "the storage provider failed", transient };
}

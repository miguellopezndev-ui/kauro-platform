/**
 * The worker's side of the local worker protocol (B14-A; docs/design/B14-A-worker-executor.md §4): the calls a worker makes to its
 * host, and the ObjectStoragePort / ResumableUploadPort the attempt envelope writes through. Every storage call is a request to the
 * host's AttemptStorageBroker; the worker never holds a provider credential, a session's bearer reference or a location of its own.
 * What the broker does not serve (copies, deletions, holds, listings, retention reads, completion claims) is refused here before it
 * leaves the process.
 */
import type {
  HoldPlacement,
  HoldRelease,
  ObjectObservation,
  ObjectStoragePort,
  ProviderCancellationResult,
  ProviderEvidenceClass,
  ResumableSession,
  ResumableUploadAnswer,
  ResumableUploadPort,
  StorageLocation,
} from "@kauro/application";
import type { StorageZone } from "@kauro/domain";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { BrokerCallFailed, type BrokeredZone, type HostMessage, type SessionAnswer, type WorkerCall, type WorkerMessage, type WorkerStage } from "./protocol.js";

export const BROKERED_STORAGE_PROVIDER = "kauro-attempt-broker";

/** The worker's end of the channel: numbered calls answered by replies, heartbeats, the host's cancellation signal. */
export class WorkerRpc {
  readonly #send: (message: WorkerMessage) => void;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #next = 0;
  #signal: "CONTINUE" | "CANCELLED" | "FENCED" = "CONTINUE";
  #closed: Error | null = null;

  constructor(send: (message: WorkerMessage) => void) {
    this.#send = send;
  }

  /** Feeds one message of the host (replies and signals; the ticket is the caller's). */
  receive(message: HostMessage): void {
    if (message.t === "signal") {
      if (this.#signal === "CONTINUE") this.#signal = message.state;
      return;
    }
    if (message.t !== "reply") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new BrokerCallFailed(message.error));
  }

  /** The channel closed: every pending call fails, and every later one. */
  close(reason: string): void {
    this.#closed ??= new BrokerCallFailed({ code: "CHANNEL_CLOSED", message: reason, transient: false });
    for (const p of this.#pending.values()) p.reject(this.#closed);
    this.#pending.clear();
  }

  call<T>(call: WorkerCall): Promise<T> {
    if (this.#closed !== null) return Promise.reject(this.#closed);
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.#send({ t: "call", id, call });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  beat(): void {
    if (this.#closed === null) this.#send({ t: "beat" });
  }

  stage(stage: WorkerStage): Promise<void> {
    return this.call<void>({ op: "stage", stage });
  }

  /** What the host last said about the attempt's cancellation (its mirror of the lease, D8-CANCEL-1). */
  get signal(): "CONTINUE" | "CANCELLED" | "FENCED" {
    return this.#signal;
  }
}

const ZONES: ReadonlySet<string> = new Set<BrokeredZone>(["ACCEPTED", "STAGING"]);

function zoneOf(location: StorageLocation): BrokeredZone {
  if (location.provider !== BROKERED_STORAGE_PROVIDER || !ZONES.has(location.locationRef)) throw new BrokerCallFailed({ code: "OUTSIDE_CAPABILITY", message: "a location the broker did not hand out", transient: false });
  return location.locationRef as BrokeredZone;
}

function notBrokered(what: string): never {
  throw new BrokerCallFailed({ code: "OUTSIDE_CAPABILITY", message: `${what} is not served to a worker`, transient: false });
}

/** ObjectStoragePort over the broker: the sealed source read, the staging prefix written and read back, nothing else. */
export class BrokeredObjectStorage implements ObjectStoragePort {
  readonly provider = BROKERED_STORAGE_PROVIDER;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly #rpc: WorkerRpc;

  constructor(rpc: WorkerRpc, evidenceClass: ProviderEvidenceClass) {
    this.#rpc = rpc;
    this.evidenceClass = evidenceClass;
  }

  location(zone: StorageZone): StorageLocation {
    if (!ZONES.has(zone)) notBrokered(`the ${zone} zone`);
    return Object.freeze({ provider: BROKERED_STORAGE_PROVIDER, locationRef: zone });
  }

  capabilities(): { readonly sessionCancellation: "SUPPORTED" | "UNSUPPORTED"; readonly sessionLifetimeSeconds: number } {
    return { sessionCancellation: "SUPPORTED", sessionLifetimeSeconds: 86_400 };
  }

  async createResumableSession(request: { readonly location: StorageLocation; readonly objectName: string; readonly declaredBytes: number; readonly contentType: string; readonly origin: string }, timeoutMs: number): Promise<ResumableSession> {
    const answer = await this.#rpc.call<SessionAnswer>({ op: "storage.createSession", zone: zoneOf(request.location), objectName: request.objectName, declaredBytes: request.declaredBytes, contentType: request.contentType, timeoutMs });
    return { sessionRef: answer.handle, chunkMultipleBytes: answer.chunkMultipleBytes, providerExpiresAt: answer.providerExpiresAt as UtcInstant };
  }

  cancelResumableSession(sessionRef: string, timeoutMs: number): Promise<ProviderCancellationResult> {
    return this.#rpc.call<ProviderCancellationResult>({ op: "storage.cancelSession", handle: sessionRef, timeoutMs });
  }

  stat(location: StorageLocation, objectName: string): Promise<ObjectObservation | null> {
    return this.#rpc.call<ObjectObservation | null>({ op: "storage.stat", zone: zoneOf(location), objectName });
  }

  async *read(location: StorageLocation, objectName: string, generation: string): AsyncIterable<Uint8Array> {
    const streamId = await this.#rpc.call<number>({ op: "storage.readOpen", zone: zoneOf(location), objectName, generation });
    let done = false;
    try {
      for (;;) {
        const chunk = await this.#rpc.call<Uint8Array | null>({ op: "storage.readNext", streamId });
        if (chunk === null) {
          done = true;
          return;
        }
        yield chunk;
      }
    } finally {
      if (!done) await this.#rpc.call({ op: "storage.readClose", streamId }).catch(() => undefined);
    }
  }

  copy(): Promise<{ readonly generation: string }> {
    return Promise.reject(notBrokeredError("a copy"));
  }

  delete(): Promise<"DELETED" | "ALREADY_ABSENT" | "PRECONDITION_FAILED"> {
    return Promise.reject(notBrokeredError("a deletion"));
  }

  placeHold(): Promise<HoldPlacement> {
    return Promise.reject(notBrokeredError("a hold"));
  }

  releaseHold(): Promise<HoldRelease> {
    return Promise.reject(notBrokeredError("a hold release"));
  }

  list(): Promise<{ readonly objects: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly bytes: number }>; readonly next?: string }> {
    return Promise.reject(notBrokeredError("a listing"));
  }

  readRetentionPolicy(): Promise<{ readonly softDeleteRetentionSeconds: number; readonly objectVersioning: boolean; readonly evidenceHash: Sha256Hex; readonly observedAt: UtcInstant }> {
    return Promise.reject(notBrokeredError("a retention read"));
  }

  listSoftDeleted(): Promise<{ readonly objects: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly softDeletedAt: UtcInstant; readonly expiresAt: UtcInstant }>; readonly next?: string }> {
    return Promise.reject(notBrokeredError("a soft-deleted listing"));
  }

  parseCompletionClaim(): { readonly kind: "MALFORMED" } {
    return { kind: "MALFORMED" };
  }
}

function notBrokeredError(what: string): BrokerCallFailed {
  try {
    notBrokered(what);
  } catch (error) {
    return error as BrokerCallFailed;
  }
}

/** The holder side of the attempt's sessions, through the broker's handles. */
export class BrokeredUploads implements ResumableUploadPort {
  readonly #rpc: WorkerRpc;

  constructor(rpc: WorkerRpc) {
    this.#rpc = rpc;
  }

  writeChunk(sessionRef: string, chunk: Uint8Array, options: { readonly final: boolean }): Promise<ResumableUploadAnswer> {
    return this.#rpc.call<ResumableUploadAnswer>({ op: "upload.writeChunk", handle: sessionRef, chunk, final: options.final });
  }
}

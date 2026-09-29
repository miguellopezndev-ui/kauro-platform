/**
 * FencedArtifactWriter — the only way a worker writes (design docs/design/B08-audit-approval-jobs.md D8-STG-1, D8-STG-3,
 * D8-STG-4, D8-STG-5, D8-CANCEL-1; 04 "Architecture and dependency boundary"; 10 "capability broker"; S035; mandate
 * B08-WORKER-HOST).
 *
 * It holds one AttemptCapability and can name nothing else: every object is `<the attempt's staging prefix><UUIDv8 of (role, path
 * hash)>` or the attempt's one manifest name, checked against the capability before anything is spooled; a capability that is not
 * exactly its attempt's canonical one, or a scratch store of another attempt, is refused at construction.
 *
 * `open` spools bytes into the attempt's scratch (same quota). `close` seals the spool (the device holds every byte written),
 * checks the cancellation channel, creates a resumable session of exactly that length through B07's ObjectStoragePort — whose
 * finalization carries the generation-0 precondition, so no generation that exists is ever overwritten, by this attempt or a
 * stale one — writes it through the holder side (`ResumableUploadPort`) in whole chunk multiples, checks the channel again before
 * the final chunk (the spool re-verified against its seal before that chunk leaves), and re-reads the finalized generation by its
 * exact number. Only then is it a StagedArtifact. A failed close, a short write, a changed spool or a read-back mismatch is never
 * one: the writer fails with that terminal cause and refuses everything after it. `writeManifest` writes the KAURO_STAGED_MANIFEST_V1
 * object naming exactly the artifacts it closed and re-read, once, at the capability's manifest name.
 *
 * A session reference is a bearer credential: it lives in this call's memory only and is never logged or stored.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import { isSha256Hex, rawDigest } from "@kauro/contracts";
import { isObjectName } from "@kauro/domain";
import {
  attemptCapabilityProblems,
  readStagedManifest,
  stagedArtifactObjectNameOf,
  stagedManifestBytesOf,
  type ArtifactHandle,
  type ArtifactWriter,
  type AttemptCapability,
  type CancellationChannel,
  type ObjectStoragePort,
  type ResumableSession,
  type ResumableUploadAnswer,
  type ResumableUploadPort,
  type StagedArtifact,
  type StorageLocation,
  type WorkerManifestReference,
} from "@kauro/application";
import { AttemptEnvelopeFailure, type AttemptFailureCause } from "./failure.js";
import type { AttemptScratchStore } from "./scratch-store.js";

const GENERATION = /^[1-9][0-9]{0,19}$/;
const REASON = /^[A-Z][A-Z_]{0,39}$/;
const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export interface FencedArtifactWriterOptions {
  readonly capability: AttemptCapability;
  readonly storage: ObjectStoragePort;
  readonly uploads: ResumableUploadPort;
  /** The attempt's own scratch: artifacts are spooled there, under its quota, until their session is written. */
  readonly scratch: AttemptScratchStore;
  readonly cancellation: CancellationChannel;
  /** The origin a session is bound to. */
  readonly origin: string;
  /** Per provider call. */
  readonly timeoutMs: number;
  /** Bytes per upload request, rounded down to the session's chunk multiple (default 8 MiB). */
  readonly uploadChunkBytes?: number;
  readonly contentType?: string;
}

export interface StagedManifestRequest {
  /** The attempt's JOB_ATTEMPT lease fence (D8-ATT-1). */
  readonly fence: number;
  readonly inputBindingHash: Sha256Hex;
  /** The core's own disposition summary (verified later against the platform's authority, never trusted here). */
  readonly declaredSummary: unknown;
}

interface Sealed {
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

function* chunksOfBytes(bytes: Uint8Array, chunkBytes: number): Generator<{ readonly bytes: Uint8Array; readonly final: boolean }> {
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const end = Math.min(bytes.length, offset + chunkBytes);
    yield { bytes: bytes.subarray(offset, end), final: end === bytes.length };
  }
}

export class FencedArtifactWriter implements ArtifactWriter {
  readonly capability: AttemptCapability;
  readonly #storage: ObjectStoragePort;
  readonly #uploads: ResumableUploadPort;
  readonly #scratch: AttemptScratchStore;
  readonly #cancellation: CancellationChannel;
  readonly #staging: StorageLocation;
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #uploadChunkBytes: number;
  readonly #contentType: string;
  readonly #artifacts: StagedArtifact[] = [];
  readonly #names = new Set<string>();
  #openHandles = 0;
  #sealing = false;
  #manifest: WorkerManifestReference | null = null;
  #failure: AttemptEnvelopeFailure | null = null;

  constructor(options: FencedArtifactWriterOptions) {
    const [problem] = attemptCapabilityProblems(options.capability);
    if (problem !== undefined) throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", problem, `the capability is not its attempt's own (${problem})`);
    if (options.scratch.attemptId !== options.capability.attemptId) {
      throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "SCRATCH_NOT_THE_ATTEMPTS", `the scratch of ${options.scratch.attemptId} is not ${options.capability.attemptId}'s`);
    }
    if (typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("a session origin is required");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new TypeError("timeoutMs is a positive whole number");
    const chunk = options.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunk) || chunk < 1) throw new TypeError("uploadChunkBytes is a positive whole number");
    this.capability = options.capability;
    this.#storage = options.storage;
    this.#uploads = options.uploads;
    this.#scratch = options.scratch;
    this.#cancellation = options.cancellation;
    this.#staging = options.storage.location("STAGING");
    this.#origin = options.origin;
    this.#timeoutMs = options.timeoutMs;
    this.#uploadChunkBytes = chunk;
    this.#contentType = options.contentType ?? "application/octet-stream";
  }

  /** The artifacts closed, hashed and re-read so far, in close order. */
  artifacts(): readonly StagedArtifact[] {
    return [...this.#artifacts];
  }

  /** The terminal failure, once one happened. */
  failure(): AttemptEnvelopeFailure | null {
    return this.#failure;
  }

  /** The manifest reference, once written. */
  manifest(): WorkerManifestReference | null {
    return this.#manifest;
  }

  open(role: string, pathHash: Sha256Hex): ArtifactHandle {
    this.#usable();
    if (this.#sealing) this.#fail("ARTIFACT_CLOSE_FAILED", "MANIFEST_WRITTEN", "the attempt's manifest is written; no artifact follows it");
    let objectName: string;
    try {
      objectName = stagedArtifactObjectNameOf(this.capability.stagingPrefix, role, pathHash);
    } catch {
      this.#fail("OUTSIDE_CAPABILITY", "ARTIFACT_NAME", "an artifact is a short lowercase role other than manifest and a SHA-256 path hash");
    }
    if (!isObjectName(objectName) || !objectName.startsWith(this.capability.stagingPrefix) || objectName === this.capability.manifestObjectName) {
      this.#fail("OUTSIDE_CAPABILITY", "ARTIFACT_NAME", "the name is not inside the attempt's staging prefix");
    }
    if (this.#names.has(objectName)) this.#fail("ARTIFACT_CLOSE_FAILED", "DUPLICATE_ARTIFACT", `artifact ${objectName} was already opened`);
    this.#names.add(objectName);
    const spool = this.#guard(() => this.#scratch.openSpool());
    this.#openHandles += 1;
    let state: "OPEN" | "CLOSING" | "CLOSED" = "OPEN";
    return {
      write: (chunk: Uint8Array): Promise<void> => {
        try {
          this.#usable();
          if (state !== "OPEN") throw new TypeError(`artifact ${objectName} is closed`);
          if (!(chunk instanceof Uint8Array)) throw new TypeError("an artifact chunk is bytes");
          this.#guard(() => spool.write(chunk));
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      close: async (): Promise<StagedArtifact> => {
        this.#usable();
        if (state !== "OPEN") throw new TypeError(`artifact ${objectName} is closed`);
        state = "CLOSING";
        try {
          const sealed = this.#guard(() => spool.seal());
          if (sealed.byteLength === 0) this.#fail("ARTIFACT_CLOSE_FAILED", "EMPTY_ARTIFACT", `artifact ${objectName} holds no bytes`);
          const generation = await this.#upload(objectName, sealed.byteLength, (chunkBytes) => spool.chunks(chunkBytes));
          await this.#readBack(objectName, generation, sealed);
          const artifact: StagedArtifact = Object.freeze({ role, objectName, generation, sha256: sealed.sha256, byteLength: sealed.byteLength });
          this.#artifacts.push(artifact);
          return artifact;
        } finally {
          state = "CLOSED";
          this.#openHandles -= 1;
          spool.discard();
        }
      },
    };
  }

  /** Writes the attempt's one KAURO_STAGED_MANIFEST_V1 object naming exactly the artifacts closed and re-read. */
  async writeManifest(request: StagedManifestRequest): Promise<WorkerManifestReference> {
    this.#usable();
    if (this.#sealing) this.#fail("ARTIFACT_CLOSE_FAILED", "MANIFEST_WRITTEN", "the attempt's manifest was already written");
    if (this.#openHandles > 0) this.#fail("ARTIFACT_CLOSE_FAILED", "ARTIFACT_OPEN", `${this.#openHandles} artifact(s) are still open`);
    if (this.#artifacts.length === 0) this.#fail("ARTIFACT_CLOSE_FAILED", "NO_ARTIFACTS", "a manifest names at least one artifact");
    if (!Number.isSafeInteger(request.fence) || request.fence < 1) throw new TypeError("a fence is a positive whole number");
    if (!isSha256Hex(request.inputBindingHash)) throw new TypeError("an input binding hash is a SHA-256 hex digest");
    this.#sealing = true;
    const { jobId, attemptId, stagingPrefix, manifestObjectName } = this.capability;
    let bytes: Uint8Array;
    try {
      bytes = stagedManifestBytesOf({ jobId, attemptId, fence: request.fence, inputBindingHash: request.inputBindingHash, artifacts: this.#artifacts, declaredSummary: request.declaredSummary });
    } catch {
      this.#fail("ARTIFACT_CLOSE_FAILED", "SUMMARY_NOT_CANONICAL", "the declared summary has no canonical form");
    }
    const own = readStagedManifest(bytes, { jobId, attemptId, fence: request.fence, inputBindingHash: request.inputBindingHash, stagingPrefix, manifestObjectName });
    if (!own.ok) this.#fail("ARTIFACT_CLOSE_FAILED", `MANIFEST_${own.problem}`, "the manifest would not be read as this attempt's");
    const generation = await this.#upload(manifestObjectName, bytes.length, (chunkBytes) => chunksOfBytes(bytes, chunkBytes));
    await this.#readBack(manifestObjectName, generation, { sha256: rawDigest(bytes), byteLength: bytes.length });
    this.#manifest = Object.freeze({ objectName: manifestObjectName, generation });
    return this.#manifest;
  }

  // --- internals ------------------------------------------------------------------------------------------------------------------

  async #upload(objectName: string, byteLength: number, chunksOf: (chunkBytes: number) => Iterable<{ readonly bytes: Uint8Array; readonly final: boolean }>): Promise<string> {
    await this.#checkChannel();
    let session: ResumableSession;
    try {
      session = await this.#storage.createResumableSession({ location: this.#staging, objectName, declaredBytes: byteLength, contentType: this.#contentType, origin: this.#origin }, this.#timeoutMs);
    } catch {
      this.#fail("ARTIFACT_CLOSE_FAILED", "SESSION_NOT_CREATED", `no session for ${objectName}`);
    }
    try {
      const multiple = session.chunkMultipleBytes;
      if (!Number.isSafeInteger(multiple) || multiple < 1) this.#fail("ARTIFACT_CLOSE_FAILED", "SESSION_MALFORMED", "the session names no chunk multiple");
      const chunkBytes = Math.max(multiple, Math.floor(this.#uploadChunkBytes / multiple) * multiple);
      const chunks = chunksOf(chunkBytes)[Symbol.iterator]();
      let sent = 0;
      for (;;) {
        const next = this.#guard(() => chunks.next());
        if (next.done === true) break;
        const { bytes, final } = next.value;
        if (final) await this.#checkChannel();
        let answer: ResumableUploadAnswer;
        try {
          answer = await this.#uploads.writeChunk(session.sessionRef, bytes, { final });
        } catch {
          this.#fail("ARTIFACT_CLOSE_FAILED", "UPLOAD_FAILED", `a chunk of ${objectName} got no answer`);
        }
        sent += bytes.length;
        if (answer.outcome === "REFUSED") {
          if (answer.reason === "LENGTH_MISMATCH" || answer.reason === "CHUNK_NOT_ALIGNED") this.#fail("SHORT_WRITE", answer.reason, `the provider did not receive ${objectName} whole`);
          if (answer.reason === "PRECONDITION_FAILED") this.#fail("ARTIFACT_CLOSE_FAILED", "OVERWRITE_REFUSED", `${objectName} already holds a generation`);
          this.#fail("ARTIFACT_CLOSE_FAILED", REASON.test(answer.reason) ? `SESSION_${answer.reason}` : "SESSION_REFUSED", `the session of ${objectName} was refused`);
        }
        if (answer.outcome === "IN_PROGRESS") {
          if (final || answer.receivedBytes !== sent) this.#fail("SHORT_WRITE", "RECEIVED_LESS", `the provider holds ${answer.receivedBytes} of ${sent} bytes of ${objectName}`);
          continue;
        }
        if (!final) this.#fail("ARTIFACT_CLOSE_FAILED", "FINALIZED_EARLY", `${objectName} finalized before its last chunk`);
        if (answer.bytes !== byteLength) this.#fail("SHORT_WRITE", "FINALIZED_SHORT", `${objectName} finalized with ${answer.bytes} of ${byteLength} bytes`);
        if (!GENERATION.test(answer.generation)) this.#fail("ARTIFACT_CLOSE_FAILED", "GENERATION_MALFORMED", `${objectName} finalized without a provider generation`);
        return answer.generation;
      }
      this.#fail("SHORT_WRITE", "NEVER_FINALIZED", `${objectName} was never finalized`);
    } catch (error) {
      // a session that did not finalize is closed where the provider allows it, so its bearer reference is worth nothing
      await this.#storage.cancelResumableSession(session.sessionRef, this.#timeoutMs).catch(() => undefined);
      throw error;
    }
  }

  async #readBack(objectName: string, generation: string, sealed: Sealed): Promise<void> {
    const hash = createHash("sha256");
    let seen = 0;
    try {
      for await (const chunk of this.#storage.read(this.#staging, objectName, generation)) {
        seen += chunk.length;
        if (seen > sealed.byteLength) this.#fail("READBACK_MISMATCH", "LENGTH", `${objectName}#${generation} is longer than was written`);
        hash.update(chunk);
      }
    } catch (error) {
      if (error instanceof AttemptEnvelopeFailure) throw error;
      this.#fail("READBACK_MISMATCH", "READBACK_FAILED", `${objectName}#${generation} could not be re-read`);
    }
    if (seen !== sealed.byteLength) this.#fail("READBACK_MISMATCH", "LENGTH", `${objectName}#${generation} re-read ${seen} of ${sealed.byteLength} bytes`);
    if (hash.digest("hex") !== sealed.sha256) this.#fail("READBACK_MISMATCH", "DIGEST", `${objectName}#${generation} is not the bytes that were written`);
  }

  async #checkChannel(): Promise<void> {
    const state = await this.#cancellation.check();
    if (state === "CONTINUE") return;
    if (state === "FENCED") this.#fail("FENCED", "FENCED", "the attempt no longer holds its fence");
    this.#fail("CANCELLED", state === "CANCELLED" ? "CANCELLED" : "UNKNOWN_ANSWER", "the attempt was cancelled");
  }

  #usable(): void {
    if (this.#failure !== null) throw this.#failure;
  }

  #fail(cause: AttemptFailureCause, problem: string, detail: string): never {
    this.#failure ??= new AttemptEnvelopeFailure(cause, problem, `attempt ${this.capability.attemptId}: ${detail}`);
    throw this.#failure;
  }

  /** Runs a scratch effect; its failure (the scratch's own terminal cause) becomes the writer's too. */
  #guard<T>(effect: () => T): T {
    try {
      return effect();
    } catch (error) {
      if (error instanceof AttemptEnvelopeFailure) {
        this.#failure ??= error;
        throw this.#failure;
      }
      this.#fail("ARTIFACT_CLOSE_FAILED", "IO_ERROR", "the spool failed");
    }
  }
}

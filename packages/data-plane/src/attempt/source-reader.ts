/**
 * GenerationSourceReader — the worker's read-only view of its sealed source (design docs/design/B08-audit-approval-jobs.md §3,
 * D8-STG-1; 09 "Accepted immutability and sealing"; mandate B08-WORKER-HOST).
 *
 * It opens exactly the ACCEPTED generations the attempt's capability names — the object name and the generation both, so a newer
 * generation under the same name is never followed — and streams them through B07's ObjectStoragePort by that exact generation,
 * re-verifying the length the seal recorded as bytes arrive and the SHA-256 at the end of every pass: a longer, shorter, other or
 * vanished generation is SOURCE_INTEGRITY_FAILED, a name or generation outside the capability OUTSIDE_CAPABILITY. The first
 * failure is kept (`failure()`) for the host's terminal cause.
 */
import { createHash } from "node:crypto";
import { attemptCapabilityProblems, type AcceptedGeneration, type AttemptCapability, type ObjectStoragePort, type SourceHandle, type SourceReader, type StorageLocation } from "@kauro/application";
import { AttemptEnvelopeFailure, type AttemptFailureCause } from "./failure.js";

export interface GenerationSourceReaderOptions {
  readonly capability: AttemptCapability;
  readonly storage: ObjectStoragePort;
}

export class GenerationSourceReader implements SourceReader {
  readonly capability: AttemptCapability;
  readonly #storage: ObjectStoragePort;
  readonly #accepted: StorageLocation;
  #failure: AttemptEnvelopeFailure | null = null;

  constructor(options: GenerationSourceReaderOptions) {
    const [problem] = attemptCapabilityProblems(options.capability);
    if (problem !== undefined) throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", problem, `the capability is not its attempt's own (${problem})`);
    this.capability = options.capability;
    this.#storage = options.storage;
    this.#accepted = options.storage.location("ACCEPTED");
  }

  failure(): AttemptEnvelopeFailure | null {
    return this.#failure;
  }

  open(ref: { readonly objectName: string; readonly generation: string }): Promise<SourceHandle> {
    const sealed = this.capability.acceptedGenerations.find((g) => g.objectName === ref.objectName && g.generation === ref.generation);
    if (sealed === undefined) return Promise.reject(this.#failed("OUTSIDE_CAPABILITY", "SOURCE_NOT_IN_CAPABILITY", "the attempt's capability names no such sealed generation"));
    return Promise.resolve(Object.freeze({ byteLength: sealed.byteLength, sha256: sealed.sha256, read: () => this.#stream(sealed) }));
  }

  async *#stream(sealed: AcceptedGeneration): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let seen = 0;
    const source = this.#storage.read(this.#accepted, sealed.objectName, sealed.generation)[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try {
        next = await source.next();
      } catch {
        throw this.#failed("SOURCE_INTEGRITY_FAILED", "SOURCE_UNREADABLE", `${sealed.objectName}#${sealed.generation} could not be read`);
      }
      if (next.done === true) break;
      seen += next.value.length;
      if (seen > sealed.byteLength) throw this.#failed("SOURCE_INTEGRITY_FAILED", "LENGTH", `${sealed.objectName}#${sealed.generation} is longer than its seal`);
      hash.update(next.value);
      yield next.value;
    }
    if (seen !== sealed.byteLength) throw this.#failed("SOURCE_INTEGRITY_FAILED", "LENGTH", `${sealed.objectName}#${sealed.generation} is shorter than its seal`);
    if (hash.digest("hex") !== sealed.sha256) throw this.#failed("SOURCE_INTEGRITY_FAILED", "DIGEST", `${sealed.objectName}#${sealed.generation} does not match its seal`);
  }

  #failed(cause: AttemptFailureCause, problem: string, detail: string): AttemptEnvelopeFailure {
    const failure = new AttemptEnvelopeFailure(cause, problem, `attempt ${this.capability.attemptId}: ${detail}`);
    this.#failure ??= failure;
    return failure;
  }
}

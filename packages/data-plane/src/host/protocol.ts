/**
 * The local worker protocol (B14-A; docs/design/B14-A-worker-executor.md §4): the messages between the local process host and the
 * worker process it started, over the child's private IPC channel (Node's advanced serialization, so bytes travel as bytes).
 *
 * The channel is the worker's only way out. It carries the ticket in, the worker's stage reports and heartbeats, its calls to the
 * attempt's storage broker (each answered by the host after the broker checked it against the attempt's capability), and its one
 * result. A resumable session's bearer reference never crosses it: the worker holds an opaque handle the broker maps.
 */
import type { ObjectObservation, WorkerFailureCause, WorkerManifestReference } from "@kauro/application";

export const WORKER_PROTOCOL_VERSION = "kauro-worker-protocol/1";

/** The points a worker reports (each a call the host answers; a test may hold one, a deployment never does). */
export const WORKER_STAGES = ["STARTED", "CORE_STARTED", "CORE_FINISHED", "PDF_STARTED", "PDF_FINISHED", "MANIFEST", "FINISHED"] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

/** The zones a worker may name; the broker maps each to the provider's location and admits only what the capability allows. */
export type BrokeredZone = "ACCEPTED" | "STAGING";

export type WorkerCall =
  | { readonly op: "stage"; readonly stage: WorkerStage }
  | { readonly op: "storage.readOpen"; readonly zone: BrokeredZone; readonly objectName: string; readonly generation: string }
  | { readonly op: "storage.readNext"; readonly streamId: number }
  | { readonly op: "storage.readClose"; readonly streamId: number }
  | { readonly op: "storage.stat"; readonly zone: BrokeredZone; readonly objectName: string }
  | { readonly op: "storage.createSession"; readonly zone: BrokeredZone; readonly objectName: string; readonly declaredBytes: number; readonly contentType: string; readonly timeoutMs: number }
  | { readonly op: "storage.cancelSession"; readonly handle: string; readonly timeoutMs: number }
  | { readonly op: "upload.writeChunk"; readonly handle: string; readonly chunk: Uint8Array; readonly final: boolean };

/** Every call a worker may make, closed: anything else is refused and recorded as UNKNOWN (never as the worker's own string). */
export const WORKER_CALL_OPS = ["stage", "storage.readOpen", "storage.readNext", "storage.readClose", "storage.stat", "storage.createSession", "storage.cancelSession", "upload.writeChunk"] as const;

/** A refusal or failure as it crosses the channel: a token, a message without customer values, and whether a retry may help. */
export interface WorkerCallError {
  readonly code: string;
  readonly message: string;
  readonly transient: boolean;
}

export interface WorkerResultReport {
  readonly state: "SUCCEEDED" | "FAILED";
  readonly cause: WorkerFailureCause | null;
  readonly manifest: WorkerManifestReference | null;
  /** The refusal token the core or the report stage answered (evidence; never a customer value). */
  readonly refusal: string | null;
  readonly peakScratchBytes: number;
  readonly peakMemoryBytes: number;
}

const TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The longest refusal a result may carry (a token, or a test's hostile observations); anything longer makes the result malformed. */
export const MAX_RESULT_REFUSAL_CHARS = 8_192;

/**
 * Why a worker's result is not one the host may keep (null when it is): the closed shape only, every string bounded, so a worker can
 * neither forge a field the host does not know nor make the host hold or record an unbounded value (review round 17, R17-1).
 */
export function workerResultProblem(result: unknown): string | null {
  if (result === null || typeof result !== "object") return "RESULT_NOT_AN_OBJECT";
  const r = result as Record<string, unknown>;
  if (r["state"] !== "SUCCEEDED" && r["state"] !== "FAILED") return "RESULT_STATE";
  if (r["cause"] !== null && (typeof r["cause"] !== "string" || !TOKEN.test(r["cause"]))) return "RESULT_CAUSE";
  if (r["refusal"] !== null && (typeof r["refusal"] !== "string" || r["refusal"].length > MAX_RESULT_REFUSAL_CHARS)) return "RESULT_REFUSAL";
  for (const name of ["peakScratchBytes", "peakMemoryBytes"]) if (!Number.isSafeInteger(r[name]) || (r[name] as number) < 0) return "RESULT_PEAKS";
  const manifest = r["manifest"];
  if (manifest !== null) {
    if (typeof manifest !== "object") return "RESULT_MANIFEST";
    const m = manifest as Record<string, unknown>;
    if (Object.keys(m).some((k) => k !== "objectName" && k !== "generation")) return "RESULT_MANIFEST";
    if (typeof m["objectName"] !== "string" || m["objectName"].length > 1024 || typeof m["generation"] !== "string" || !/^[0-9]{1,32}$/.test(m["generation"])) return "RESULT_MANIFEST";
  }
  if (Object.keys(r).some((k) => !["state", "cause", "manifest", "refusal", "peakScratchBytes", "peakMemoryBytes"].includes(k))) return "RESULT_FIELDS";
  return null;
}

/** host -> worker */
export type HostMessage =
  | { readonly t: "ticket"; readonly protocol: string; readonly bytes: Uint8Array }
  | { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "reply"; readonly id: number; readonly ok: false; readonly error: WorkerCallError }
  | { readonly t: "signal"; readonly state: "CANCELLED" | "FENCED" };

/** worker -> host */
export type WorkerMessage =
  | { readonly t: "call"; readonly id: number; readonly call: WorkerCall }
  | { readonly t: "beat" }
  | { readonly t: "result"; readonly result: WorkerResultReport };

export interface SessionAnswer {
  readonly handle: string;
  readonly chunkMultipleBytes: number;
  readonly providerExpiresAt: string;
}

export type StatAnswer = ObjectObservation | null;

/** A typed error a broker refusal or a provider failure becomes on the worker's side (`transient` as the pipeline reads it). */
export class BrokerCallFailed extends Error {
  readonly code: string;
  readonly transient: boolean;
  constructor(error: WorkerCallError) {
    super(`${error.code}: ${error.message}`);
    this.name = "BrokerCallFailed";
    this.code = error.code;
    this.transient = error.transient;
  }
}

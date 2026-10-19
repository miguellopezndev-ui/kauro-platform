/**
 * One attempt inside a worker process (B14-A; docs/design/B14-A-worker-executor.md §3): the composition the worker's entrypoint runs
 * once its ticket is verified. Everything is the platform's real code:
 *
 *   ReportingExecutionEnvelope (B13)                       the report of the package, staged with it
 *     └─ the plan-bound core: MigrationCoreAdapter (B05)    Migration Core 3.0.0 in its isolated child, over the plan's binding
 *   AttemptScratchStore, GenerationSourceReader,            the attempt envelope (B08), confined to the attempt's own directory
 *   FencedArtifactWriter
 *   ChromiumPdfEngine                                       the sandboxed browser, offline, JavaScript off
 *   BrokeredObjectStorage / BrokeredUploads                 every object through the host's broker; no credential here
 *
 * The decision of the attempt's end follows the contract fake's host exactly (B08 D8-STG-1..3): the envelope's own failure first (a
 * scratch, writer or source failure wins over whatever the core answered), then what the core threw, then what it answered; a
 * COMPLETED answer must name exactly the artifacts the writer closed; only then is the KAURO_STAGED_MANIFEST_V1 object written. The
 * attempt's scratch is removed when the attempt ends here; a killed worker leaves it for STAGING_JANITOR.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CancellationChannel, CancellationState, CoreInputResolver, ExecutionEnvelopePort, ExecutionOutcome, ProviderEvidenceClass, WorkerFailureCause } from "@kauro/application";
import type { PdfEngine } from "@kauro/reports";
import { FencedArtifactWriter } from "../attempt/artifact-writer.js";
import { terminalCauseOf } from "../attempt/failure.js";
import { AttemptScratchStore } from "../attempt/scratch-store.js";
import { GenerationSourceReader } from "../attempt/source-reader.js";
import { MigrationCoreAdapter } from "../cores/migration-core-adapter.js";
import { coreTimersOf } from "../cores/operation.js";
import { ChromiumPdfEngine } from "../pdf/chromium-pdf-engine.js";
import type { AuthorizedReportInputs, ReportInputsPort, ReportScope } from "../report/facts.js";
import { ReportingExecutionEnvelope } from "../report/stage.js";
import { BrokeredObjectStorage, BrokeredUploads, type WorkerRpc } from "./client.js";
import type { WorkerResultReport } from "./protocol.js";
import type { AttemptTicket } from "./ticket.js";

/** The origin a worker's writer names; the broker binds every session to the host's own origin whatever is named here. */
export const WORKER_SESSION_ORIGIN = "https://kauro-worker.invalid";
/** Where, inside the attempt's own scratch, the browser keeps its temporary profile (removed with the attempt). */
export const BROWSER_TEMP_DIRECTORY = "browser-tmp";

export interface AttemptWorkerOptions {
  readonly rpc: WorkerRpc;
  /** The host's scratch root, as a real path: the worker opens only its own attempt's directory under it. */
  readonly scratchRoot: string;
  readonly chromiumExecutable: string;
  /**
   * The browser's own temporary directory, which the host made for this attempt and measures and removes with it. It is not the
   * attempt's directory: on POSIX the browser binds a socket under it, and a socket's path is at most 107 bytes (the host keeps it short).
   */
  readonly browserTemp: string;
  /** The worker's injected process clock (the deadline and the core's timers; CK3). */
  readonly clock: { nowMs(): number };
  readonly coreHeapMegabytes: number;
  /** What the brokered storage is (the host says; a contract fake's storage stays SIMULATED). */
  readonly storageEvidenceClass: ProviderEvidenceClass;
  /** Per print, milliseconds (default the engine's). */
  readonly printTimeoutMs?: number;
  /** Where the worker writes a diagnostic line for an unclassified failure: an error's name, code and message, never a value. */
  readonly diagnostic?: (line: string) => void;
}

/** One line about an error for the host's diagnostics (kept in its memory, never in a record). */
export function diagnosticOf(error: unknown): string {
  if (!(error instanceof Error)) return `non-error ${typeof error}`;
  const code = (error as { code?: unknown }).code;
  // the head and the tail of a long message (a browser's launch error ends with the browser's own log lines)
  const message = error.message.length > 2000 ? `${error.message.slice(0, 400)} … ${error.message.slice(-1600)}` : error.message;
  const line = `${error.name}${typeof code === "string" ? ` ${code}` : ""}: ${message}`;
  // the causes below it, as far down as three (a browser's own launch error under the engine's, for instance)
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined) return line;
  const below = diagnosticOf(cause);
  // the deepest cause's end is the most telling part
  return `${line.slice(0, 600)} <- ${below.length > 2400 ? `… ${below.slice(-2400)}` : below}`;
}

const sameScope = (a: ReportScope, b: ReportScope): boolean => a.agencyId === b.agencyId && a.projectId === b.projectId && a.jobId === b.jobId && a.attemptId === b.attemptId;

/** The core over the plan's binding (D5-16): the subject's configuration is the binding's document and its core-native hash. */
function planBound(core: ExecutionEnvelopePort, ticket: AttemptTicket, rpc: WorkerRpc): ExecutionEnvelopePort {
  return {
    async execute(subject, io): Promise<ExecutionOutcome> {
      await rpc.stage("CORE_STARTED");
      const outcome = await core.execute({ ...subject, configDocument: ticket.planBinding.configDocument, configHash: ticket.planBinding.coreConfigHash }, io);
      await rpc.stage("CORE_FINISHED");
      return outcome;
    },
  };
}

/** The engine, with the two stage reports around each print (a test's hold point, a deployment's progress). */
function reportingEngine(inner: PdfEngine, rpc: WorkerRpc): PdfEngine {
  return {
    engineId: inner.engineId,
    async print(request) {
      await rpc.stage("PDF_STARTED");
      const pdf = await inner.print(request);
      await rpc.stage("PDF_FINISHED");
      return pdf;
    },
  };
}

/** The core's inputs: exactly the ticket's, for exactly the subject's revision (any other revision has none). */
function inputsOf(ticket: AttemptTicket): CoreInputResolver {
  return { resolve: (revisionHash) => Promise.resolve(revisionHash === ticket.subject.revisionHash ? ticket.inputs : []) };
}

/** The report's inputs: what the control plane read for this attempt's scope, and nothing for any other. */
function reportInputsOf(ticket: AttemptTicket): ReportInputsPort {
  const scope: ReportScope = { agencyId: ticket.capability.agencyId, projectId: ticket.capability.projectId, jobId: ticket.capability.jobId, attemptId: ticket.capability.attemptId };
  return { read: (asked): Promise<AuthorizedReportInputs | null> => Promise.resolve(sameScope(asked, scope) ? ticket.reportInputs : null) };
}

const failed = (cause: WorkerFailureCause, refusal: string | null, peaks: { scratch: number; memory: number }): WorkerResultReport => ({
  state: "FAILED",
  cause,
  manifest: null,
  refusal,
  peakScratchBytes: peaks.scratch,
  peakMemoryBytes: peaks.memory,
});

/** Runs the attempt the ticket names and answers its result; never throws for anything the attempt itself did. */
export async function runAttemptWorker(ticket: AttemptTicket, options: AttemptWorkerOptions): Promise<WorkerResultReport> {
  const { rpc, clock } = options;
  const peaks = { scratch: 0, memory: process.memoryUsage().rss };
  const deadlineMs = Math.min(Date.parse(ticket.subject.executionDeadlineAt), clock.nowMs() + ticket.limits.wallClockMs);
  if (!(clock.nowMs() < deadlineMs)) return failed("DEADLINE_EXCEEDED", null, peaks);
  await rpc.stage("STARTED");

  const { capability, limits } = ticket;
  const scratch = new AttemptScratchStore({ root: options.scratchRoot, attemptId: capability.attemptId, quotaBytes: limits.scratchBudgetBytes, confined: true });
  let disposed = false;
  try {
    // the browser's temporary profile lives inside the attempt's own directory, the only place this process may write
    const browserTemp = join(scratch.directory, BROWSER_TEMP_DIRECTORY);
    mkdirSync(browserTemp);
    // a home and caches of its own too: the browser writes there, and the worker's environment names no other
    for (const name of ["TMPDIR", "TMP", "TEMP", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[name] = browserTemp;
    // the browser's own temporary files (its singleton socket among them) go to the host's short directory; the driver's profile stays here
    const browserEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) browserEnvironment[name] = value;
    for (const name of ["TMPDIR", "TMP", "TEMP"]) browserEnvironment[name] = options.browserTemp;

    const cancellation: CancellationChannel = {
      check: (): Promise<CancellationState> => {
        rpc.beat();
        return Promise.resolve(rpc.signal);
      },
    };
    const storage = new BrokeredObjectStorage(rpc, options.storageEvidenceClass);
    const writer = new FencedArtifactWriter({ capability, storage, uploads: new BrokeredUploads(rpc), scratch, cancellation, origin: WORKER_SESSION_ORIGIN, timeoutMs: 30_000 });
    const source = new GenerationSourceReader({ capability, storage });
    const core = new MigrationCoreAdapter({
      attemptId: capability.attemptId,
      scratchRoot: options.scratchRoot,
      inputs: inputsOf(ticket),
      corePackageHash: ticket.corePackageHash,
      timers: coreTimersOf(clock),
      heapMegabytes: options.coreHeapMegabytes,
    });
    const engine = reportingEngine(new ChromiumPdfEngine({ executablePath: options.chromiumExecutable, environment: browserEnvironment, ...(options.printTimeoutMs === undefined ? {} : { timeoutMs: options.printTimeoutMs }) }, "chromium/worker"), rpc);
    const envelope = new ReportingExecutionEnvelope({ inner: planBound(core, ticket, rpc), storage, inputs: reportInputsOf(ticket), engine, render: ticket.render });

    let outcome: ExecutionOutcome | null = null;
    let thrown: unknown = null;
    try {
      outcome = await envelope.execute(ticket.subject, { source, scratch, writer, cancellation, limits });
    } catch (error) {
      thrown = error;
      options.diagnostic?.(diagnosticOf(error));
    }
    peaks.scratch = Math.max(peaks.scratch, scratch.usage().peakBytes);
    peaks.memory = Math.max(peaks.memory, process.memoryUsage().rss, outcome?.resourceMetrics.peakMemoryBytes ?? 0);
    // the host's own envelope decides first; then what the core threw; then what it answered (as the contract fake's host does)
    const envelopeFailure = scratch.failure() ?? writer.failure() ?? source.failure();
    const refusal = outcome?.refusal?.code ?? null;
    // a refusal's message names closed codes only (the core's or the report stage's), never a value
    if (outcome?.refusal !== undefined) options.diagnostic?.(`${outcome.refusal.code}: ${outcome.refusal.message.slice(0, 500)}`);
    const cause: WorkerFailureCause | null =
      envelopeFailure !== null ? envelopeFailure.terminalCause : thrown !== null ? terminalCauseOf(thrown) : outcome === null || outcome.terminalCause === "COMPLETED" ? null : outcome.terminalCause;
    if (cause !== null) return failed(cause, refusal, peaks);
    if (outcome === null || !sameArtifacts(outcome, writer)) return failed("WORKER_ERROR", null, peaks);
    await rpc.stage("MANIFEST");
    let manifest;
    try {
      manifest = await writer.writeManifest({ fence: ticket.fence, inputBindingHash: ticket.subject.inputBindingHash, declaredSummary: outcome.reconciliationSummary ?? null });
    } catch (error) {
      return failed(terminalCauseOf(error), null, peaks);
    }
    await rpc.stage("FINISHED");
    peaks.scratch = Math.max(peaks.scratch, scratch.usage().peakBytes);
    scratch.dispose();
    disposed = true;
    return { state: "SUCCEEDED", cause: null, manifest, refusal: null, peakScratchBytes: peaks.scratch, peakMemoryBytes: peaks.memory };
  } finally {
    if (!disposed) {
      peaks.scratch = Math.max(peaks.scratch, scratch.usage().peakBytes);
      try {
        scratch.dispose();
      } catch {
        scratch.abandon();
      }
    }
  }
}

/** The core's claimed artifacts are exactly the ones the writer closed and re-read. */
function sameArtifacts(outcome: ExecutionOutcome, writer: FencedArtifactWriter): boolean {
  const key = (a: { readonly objectName: string; readonly generation: string; readonly sha256: string; readonly byteLength: number }): string => `${a.objectName}#${a.generation}#${a.sha256}#${a.byteLength}`;
  const claimed = outcome.stagedArtifacts.map(key).sort();
  const closed = writer.artifacts().map(key).sort();
  return claimed.length === closed.length && claimed.every((k, i) => k === closed[i]);
}

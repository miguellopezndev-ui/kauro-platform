/**
 * The platform's ContainerInspectorPort (04 inspectContainer; 09 "Completion and inspection" and "Scanner coverage"; S024; decision
 * D-ISO-1). Not a provider: always real, in tests too.
 *
 * One call owns one directory inside the attempt scratch it is given (09 "Derived data and worker scratch": each attempt owns a
 * scratch; cleanup targets only that ownership scope) and removes exactly that directory when it returns:
 *
 * 1. it streams the exact generation (`open`) into `input/object`, computing SHA-256 over every byte read and counting them,
 *    stopping at the per-file bound (RESOURCE_LIMIT, FILE_BYTES_LIMIT);
 * 2. it runs the inspection task in an isolated child (runIsolated) that may read that file and write only `work/`;
 * 3. it assembles the result: the container part at its verified length (the bytes read) followed by every allowed part the
 *    child expanded, the child's inventory and problems, and the isolation evidence (the observers and the decompressed bytes).
 *
 * A length other than the observed one (the provider's stat) is a problem of the object (OBSERVED_LENGTH_MISMATCH): the scan's
 * container part is the verified length, so the domain's coverage rule then refuses it too. An isolation observer that fired in a
 * production run refuses the file (ISOLATION_VIOLATION_OBSERVED): a clean inspection never tries a write outside its scratch, a
 * connection or a process. A child that ran out of time or memory is RESOURCE_LIMIT; a child that failed otherwise throws
 * InspectorFailure (the caller's TRANSIENT_INFRASTRUCTURE, retried within the deadline).
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContainerInspection, ContainerInspectorPort, InspectionIsolation, InspectionLimits } from "@kauro/application";
import type { DeclaredFormat, ExpectedScanPart, InspectionProblem } from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";
import { ARCHIVE_BOUNDS, INSPECTOR_VERSION } from "../limits.js";
import { runIsolated } from "../sandbox/runner.js";
import type { InspectPayload, RawInspection } from "./facts.js";

const INSPECT_TASK = join(dirname(fileURLToPath(import.meta.url)), "inspect-task.js");

export class InspectorFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InspectorFailure";
  }
}

export interface StreamedInput {
  readonly sha256: Sha256Hex;
  readonly bytes: number;
  /** False when the stream was longer than the bound and reading stopped there. */
  readonly complete: boolean;
}

/** Streams a generation into a file of the scratch, hashing every byte read; stops after `maxBytes`. */
export async function streamToFile(open: () => AsyncIterable<Uint8Array>, path: string, maxBytes: number): Promise<StreamedInput> {
  const hash = createHash("sha256");
  const out = createWriteStream(path, { flags: "wx" });
  let bytes = 0;
  let complete = true;
  try {
    for await (const chunk of open()) {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        complete = false;
        break;
      }
      if (!out.write(chunk)) await once(out, "drain");
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  return { sha256: hash.digest("hex"), bytes, complete };
}

export interface ContainerInspectorOptions {
  /** V8 heap bound of the child, in MiB (default: ARCHIVE_BOUNDS.childHeapMegabytes). */
  readonly heapMegabytes?: number;
}

export class IsolatedContainerInspector implements ContainerInspectorPort {
  readonly version = INSPECTOR_VERSION;

  constructor(private readonly options: ContainerInspectorOptions = {}) {}

  async inspect(input: { readonly open: () => AsyncIterable<Uint8Array>; readonly declaredFormat: DeclaredFormat; readonly observedBytes: number; readonly limits: InspectionLimits; readonly scratchDir: string }): Promise<ContainerInspection> {
    const attempt = mkdtempSync(join(realpathSync.native(input.scratchDir), "inspection-"));
    try {
      const inputDir = join(attempt, "input");
      const workDir = join(attempt, "work");
      mkdirSync(inputDir);
      mkdirSync(workDir);
      const objectPath = join(inputDir, "object");
      const streamed = await streamToFile(input.open, objectPath, input.limits.fileBytes);
      const container: ExpectedScanPart = { partDigest: streamed.sha256, partKind: "CONTAINER", bytes: streamed.bytes };
      const noIsolationRun: InspectionIsolation = { mechanism: "NODE_PERMISSION_CHILD", outsideWriteAttempts: 0, networkAttempts: 0, processAttempts: 0, decompressedBytes: 0 };
      if (!streamed.complete) {
        return this.refusedBeforeParsing(streamed, container, noIsolationRun, input.declaredFormat, "RESOURCE_LIMIT", "FILE_BYTES_LIMIT");
      }
      const payload: InspectPayload = {
        input: objectPath,
        declaredFormat: input.declaredFormat,
        limits: input.limits,
        archive: { ratioGraceBytes: ARCHIVE_BOUNDS.ratioGraceBytes, centralDirectoryBytes: ARCHIVE_BOUNDS.centralDirectoryBytes, inventoryColumns: ARCHIVE_BOUNDS.inventoryColumns },
      };
      const run = await runIsolated<RawInspection>({
        task: INSPECT_TASK,
        payload,
        readPaths: [objectPath],
        workDir,
        timeoutMs: input.limits.wallClockMs,
        heapMegabytes: this.options.heapMegabytes ?? ARCHIVE_BOUNDS.childHeapMegabytes,
      });
      const observed = { outsideWriteAttempts: run.observers.outsideWriteAttempts, networkAttempts: run.observers.networkAttempts, processAttempts: run.observers.processAttempts };
      if (run.timedOut) return this.refusedBeforeParsing(streamed, container, { mechanism: "NODE_PERMISSION_CHILD", ...observed, decompressedBytes: 0 }, input.declaredFormat, "RESOURCE_LIMIT", "WALL_CLOCK_LIMIT");
      if (run.memoryExhausted) return this.refusedBeforeParsing(streamed, container, { mechanism: "NODE_PERMISSION_CHILD", ...observed, decompressedBytes: 0 }, input.declaredFormat, "RESOURCE_LIMIT", "MEMORY_LIMIT");
      if (run.outcome === undefined || !run.outcome.ok) {
        const code = run.outcome === undefined ? "INSPECTOR_EXITED" : (run.outcome.error.code ?? run.outcome.error.name);
        throw new InspectorFailure(code, `the isolated inspection did not complete (${code}, exit ${String(run.exitCode)})`);
      }
      const raw = run.outcome.value;
      const isolation: InspectionIsolation = { mechanism: "NODE_PERMISSION_CHILD", ...observed, decompressedBytes: raw.decompressedBytes };
      const problems: InspectionProblem[] = raw.problems.map((p) => (p.partDigest === undefined ? { code: p.code } : { code: p.code, partDigest: p.partDigest }));
      let refusal = raw.refusal;
      let structureStatus = raw.structureStatus;
      const checks = ["READ_COMPLETE", "SHA256", ...raw.checksCompleted];
      if (streamed.bytes !== input.observedBytes) {
        problems.push({ code: "OBSERVED_LENGTH_MISMATCH" });
        structureStatus = "STRUCTURE_INVALID";
        refusal = refusal ?? "CORRUPT_STRUCTURE";
      } else checks.splice(2, 0, "OBSERVED_LENGTH");
      if (observed.outsideWriteAttempts + observed.networkAttempts + observed.processAttempts > 0) {
        problems.push({ code: "ISOLATION_VIOLATION_OBSERVED" });
        structureStatus = "STRUCTURE_INVALID";
        refusal = refusal ?? "ACTIVE_CONTENT";
      }
      const result: ContainerInspection = {
        isolation,
        detectedFormat: raw.detectedFormat,
        structureStatus,
        sha256: streamed.sha256,
        bytes: streamed.bytes,
        problems,
        ...(refusal === undefined ? {} : { refusal }),
        expectedScanParts: refusal === undefined ? [container, ...raw.parts] : [container],
        tables: refusal === undefined ? raw.tables : [],
        parserProfile: { ...raw.profile, inspectorVersion: INSPECTOR_VERSION },
        checksCompleted: checks,
      };
      return result;
    } finally {
      rmSync(attempt, { recursive: true, force: true });
    }
  }

  private refusedBeforeParsing(streamed: StreamedInput, container: ExpectedScanPart, isolation: InspectionIsolation, declared: DeclaredFormat, refusal: "RESOURCE_LIMIT", code: string): ContainerInspection {
    return {
      isolation,
      detectedFormat: "UNSUPPORTED",
      structureStatus: "STRUCTURE_INVALID",
      sha256: streamed.sha256,
      bytes: streamed.bytes,
      problems: [{ code }],
      refusal,
      expectedScanParts: [container],
      tables: [],
      parserProfile: { inspector: "kauro-container-inspector", inspectorVersion: INSPECTOR_VERSION, declaredFormat: declared },
      checksCompleted: streamed.complete ? ["READ_COMPLETE", "SHA256"] : ["SHA256"],
    };
  }
}

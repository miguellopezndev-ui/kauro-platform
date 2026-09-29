/**
 * CONTRACT FAKE — evidence class SIMULATED. The labelled contract fake of `ProfilePort`, `ValidatePort`,
 * `ExecutionEnvelopePort` and `PackageVerifierPort` (mandate B08-CORE-PORTS; design docs/design/B08-audit-approval-jobs.md
 * §10, §13 D8-FAKE-1). It is the only fake of these ports (one owner), lives only under the test-only subpath
 * `@kauro/application/testing` (architecture rule `testOnlySubpaths`), no composition root binds it, and every record it
 * produces names the token `contract-fake-migration-core` and reports `evidenceClass: "SIMULATED"` (21 "Evidence classes":
 * SIMULATED demonstrates a local contract with fakes; it is never EXECUTED_LOCAL). The real thin adapter over
 * kauro-migration-core 2.0.3 is `b05/cores`'.
 *
 * What it models (manual 04 "executePlan", "verifyPackage"; D8-VER-1):
 * - `execute` reaches the source, the scratch store and the artifact writer only through the `HostIo` it is handed — never
 *   an ambient filesystem call — and can be scripted to fail the way the real core's resource contract fails: ENOSPC
 *   (scratch exhausted before a segment seals), a short write (the writer closes fewer bytes than were sent) and a
 *   corrupt intermediate (a byte flips between write and close, so the re-read hash disagrees). Cancellation is checked
 *   first, the platform's channel deciding CONTINUE/CANCELLED/FENCED.
 * - `verify` never trusts the candidate's own claims: a required artifact missing, a candidate artifact repeated, one the
 *   expected authority never named, one whose bytes disagree with the expectation (a foreign or partial blob under
 *   another generation) and a declared summary that says "clean" over a package that is not are all independent problems,
 *   and any of them is INVALID (manual 04 "Missing artifacts, unexpected executable files, ... false summary flags ...
 *   reject").
 * - A call log of every port call, and a hold point before each awaited step of `execute` (cancellation, the scratch
 *   write, the artifact write, the artifact close) so a test can interleave without a sleep.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import type {
  CoreEvidenceClass,
  ExecutionEnvelopePort,
  ExecutionOutcome,
  ExecutionSubject,
  ExecutionTerminalCause,
  ExpectedAuthority,
  HostIo,
  PackageCandidate,
  PackageVerificationResult,
  PackageVerificationVerdict,
  PackageVerifierPort,
  ProfilePort,
  ProfileRequest,
  ProfileResult,
  StagedArtifact,
  ValidatePort,
  ValidateRequest,
  ValidateResult,
} from "../ports/core-ports.js";

/** The provider-like token every record of this fake names. */
export const CONTRACT_FAKE_MIGRATION_CORE_TOKEN = "contract-fake-migration-core";
/** The `coreVersion` a validation receipt or a verification expects when checked against this fake. */
export const CONTRACT_FAKE_MIGRATION_CORE_VERSION = "contract-fake-migration-core-2.0.3";

export type MigrationCoreOperation = "profile" | "validate" | "execute" | "verify";
/** A hold point on one awaited step inside `execute` (D8-CANCEL-1: the worker checks its channel after every await). */
export type MigrationCoreExecuteStep = "cancellation" | "scratch" | "write" | "close";
export type MigrationCoreExecutionFault = "ENOSPC" | "SHORT_WRITE" | "CORRUPT_INTERMEDIATE";

/** One call of the fake, in arrival order. */
export interface MigrationCoreCall {
  readonly sequence: number;
  readonly operation: MigrationCoreOperation;
  readonly outcome: string;
}

/** A hold point: the next await of the named point signals `reached` and waits until `release()`. */
export interface MigrationCoreHold {
  readonly reached: Promise<void>;
  release(): void;
}

interface HoldRecord {
  readonly signal: () => void;
  readonly released: Promise<void>;
}

function digestOf(value: unknown): Sha256Hex {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Of(bytes: Uint8Array): Sha256Hex {
  return createHash("sha256").update(bytes).digest("hex");
}

const EMPTY_OUTCOME: Omit<ExecutionOutcome, "evidenceClass" | "terminalCause"> = {
  stagedArtifacts: [],
  reconciliationSummary: null,
  resourceMetrics: { peakMemoryBytes: 0, peakScratchBytes: 0, wallClockMs: 0 },
};

export class ContractFakeMigrationCore implements ProfilePort, ValidatePort, ExecutionEnvelopePort, PackageVerifierPort {
  readonly evidenceClass: CoreEvidenceClass = "SIMULATED";
  #sequence = 0;
  readonly #calls: MigrationCoreCall[] = [];
  readonly #holds = new Map<string, HoldRecord[]>();
  readonly #executeFaults: MigrationCoreExecutionFault[] = [];

  /** Scripts the fault of the next `execute` call. Applies once; a later call without a queued fault completes cleanly. */
  failNextExecute(fault: MigrationCoreExecutionFault): void {
    this.#executeFaults.push(fault);
  }

  /** A hold point on the next `execute` call to reach the named step. */
  holdNext(step: MigrationCoreExecuteStep): MigrationCoreHold {
    let signal: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = this.#holds.get(step) ?? [];
    queue.push({ signal, released });
    this.#holds.set(step, queue);
    return { reached, release };
  }

  /** The calls so far, in arrival order (optionally of one operation). */
  calls(operation?: MigrationCoreOperation): readonly MigrationCoreCall[] {
    return this.#calls.filter((call) => operation === undefined || call.operation === operation);
  }

  async #wait(step: MigrationCoreExecuteStep): Promise<void> {
    const hold = this.#holds.get(step)?.shift();
    if (hold === undefined) return;
    hold.signal();
    await hold.released;
  }

  async #record<T>(operation: MigrationCoreOperation, effect: () => Promise<T>): Promise<T> {
    const sequence = (this.#sequence += 1);
    try {
      const value = await effect();
      this.#calls.push({ sequence, operation, outcome: "OK" });
      return value;
    } catch (error) {
      this.#calls.push({ sequence, operation, outcome: `FAILED ${error instanceof Error ? error.message : "ERROR"}` });
      throw error;
    }
  }

  async profile(request: ProfileRequest): Promise<ProfileResult> {
    return this.#record("profile", async () => {
      await request.cancellation.check();
      const profileHash = digestOf({ token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, revisionHash: request.revisionHash });
      return {
        evidenceClass: this.evidenceClass,
        outcome: "PROFILED" as const,
        profileHash,
        profileDocument: { token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, revisionHash: request.revisionHash },
      };
    });
  }

  async validate(request: ValidateRequest): Promise<ValidateResult> {
    return this.#record("validate", async () => {
      await request.cancellation.check();
      const corePackageHash = digestOf({ token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, planHash: request.planHash });
      return {
        evidenceClass: this.evidenceClass,
        outcome: "VALID" as const,
        receipt: {
          revisionHash: request.revisionHash,
          targetContractHash: request.targetContractHash,
          planHash: request.planHash,
          corePackageHash,
          profileEvidenceHash: digestOf({ token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, part: "profile", planHash: request.planHash }),
          dispositionEvidenceHash: digestOf({ token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, part: "disposition", planHash: request.planHash }),
          artifactEvidenceHash: digestOf({ token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, part: "artifact", planHash: request.planHash }),
        },
        problems: [],
      };
    });
  }

  execute(subject: ExecutionSubject, io: HostIo): Promise<ExecutionOutcome> {
    const terminal = (terminalCause: ExecutionTerminalCause): ExecutionOutcome => ({ evidenceClass: this.evidenceClass, terminalCause, ...EMPTY_OUTCOME });
    return this.#record("execute", async () => {
      await this.#wait("cancellation");
      const cancellation = await io.cancellation.check();
      if (cancellation !== "CONTINUE") return terminal(cancellation === "CANCELLED" ? "CANCELLED" : "FENCED");

      const fault = this.#executeFaults.shift();
      await this.#wait("scratch");
      if (fault === "ENOSPC") return terminal("SCRATCH_EXHAUSTED");
      const segment = io.scratch.createSegment({ schema: "contract-fake-migration-core-records", schemaVersion: "1" });
      segment.append(JSON.stringify({ attemptId: subject.attemptId, inputBindingHash: subject.inputBindingHash }));
      segment.seal();

      const handle = io.writer.open("staged-artifact", digestOf({ attemptId: subject.attemptId, configHash: subject.configHash }));
      const payload = Buffer.from(`${CONTRACT_FAKE_MIGRATION_CORE_TOKEN}:${subject.inputBindingHash}`, "utf8");
      const sent = fault === "SHORT_WRITE" ? payload.subarray(0, Math.max(0, payload.byteLength - 1)) : payload;
      await this.#wait("write");
      await handle.write(sent);
      if (fault === "CORRUPT_INTERMEDIATE") sent[0] = (sent[0] ?? 0) ^ 0xff;

      await this.#wait("close");
      const staged = await handle.close();
      const intact = staged.byteLength === payload.byteLength && staged.sha256 === sha256Of(payload);
      if (!intact) return terminal(fault === "CORRUPT_INTERMEDIATE" ? "CORRUPT_INTERMEDIATE" : "SHORT_WRITE");

      return {
        evidenceClass: this.evidenceClass,
        terminalCause: "COMPLETED",
        stagedArtifacts: [staged],
        reconciliationSummary: { token: CONTRACT_FAKE_MIGRATION_CORE_TOKEN, attemptId: subject.attemptId },
        resourceMetrics: { peakMemoryBytes: payload.byteLength, peakScratchBytes: io.scratch.usage().bytes, wallClockMs: 0 },
      };
    });
  }

  verify(candidate: PackageCandidate, expected: ExpectedAuthority): Promise<PackageVerificationResult> {
    return this.#record("verify", () => {
      const keyOf = (artifact: StagedArtifact): string => `${artifact.role}:${artifact.objectName}:${artifact.generation}`;
      const expectedByKey = new Map(expected.requiredArtifacts.map((artifact) => [keyOf(artifact), artifact]));
      const seen = new Set<string>();
      const problems: string[] = [];
      for (const artifact of candidate.artifacts) {
        const key = keyOf(artifact);
        if (seen.has(key)) {
          problems.push(`DUPLICATE_ARTIFACT:${key}`);
          continue;
        }
        seen.add(key);
        const wanted = expectedByKey.get(key);
        if (wanted === undefined) {
          problems.push(`EXTRA_ARTIFACT:${key}`);
          continue;
        }
        if (wanted.sha256 !== artifact.sha256 || wanted.byteLength !== artifact.byteLength) problems.push(`FOREIGN_ARTIFACT:${key}`);
      }
      for (const key of expectedByKey.keys()) if (!seen.has(key)) problems.push(`MISSING_ARTIFACT:${key}`);
      const declared = candidate.declaredSummary as { readonly ok?: unknown } | null;
      if (declared !== null && declared?.ok === true && problems.length > 0) problems.push("FALSE_SUMMARY");
      const verdict: PackageVerificationVerdict = problems.length === 0 ? "VALID" : "INVALID";
      return Promise.resolve({ evidenceClass: this.evidenceClass, verdict, problems });
    });
  }
}

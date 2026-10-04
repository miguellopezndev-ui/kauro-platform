// Fixtures of one processing attempt (mandate B08-WORKER-HOST): canonical ids, the capability the control plane would mint for it
// (D8-STG-1), its execution subject and limits, and the holder side of a resumable session bound to B07's object-storage fake
// (CONTRACT FAKE — SIMULATED, consumed from its owner @kauro/application/testing, never copied).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, Clock, ProjectId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import {
  attemptIdentityOf,
  attemptStagingPrefixOf,
  stagedManifestObjectNameOf,
  type AcceptedGeneration,
  type AttemptCapability,
  type CancellationChannel,
  type CancellationState,
  type ExecutionLimits,
  type ExecutionSubject,
  type ResumableUploadAnswer,
  type ResumableUploadPort,
  type WorkerLaunchSpec,
} from "@kauro/application";
import type { ContractFakeObjectStorage } from "@kauro/application/testing";
import { AttemptEnvelopeFailure, type AttemptFailureCause } from "../../src/index.js";

/** A deterministic UUIDv7 per ordinal. */
export function v7(n: number): string {
  return `0192b000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function sha(value: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(value).digest("hex");
}

export const SESSION_ORIGIN = "https://app.kauro.test";

/** Small limits for tests: the scratch budget is the attempt store's quota. */
export function limitsOf(scratchBudgetBytes = 1 << 20): ExecutionLimits {
  return { hardMemoryBytes: 8 * 2 ** 30, memoryBudgetBytes: 6 * 2 ** 30, hardScratchBytes: 64 * 2 ** 30, scratchBudgetBytes, wallClockMs: 8 * 3_600_000 };
}

export interface AttemptFixture {
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly jobId: Id;
  readonly attemptId: Id;
  readonly identity: string;
  readonly prefix: string;
  readonly capability: AttemptCapability;
  readonly subject: ExecutionSubject;
  spec(fence: number, limits?: ExecutionLimits): WorkerLaunchSpec;
}

/**
 * Attempt `n` of a job: the agency and project are fixed (v7(1000), v7(1001)); the job is v7(2000 + job) and the attempt
 * v7(3000 + n), so two fixtures with one `job` are two attempts of one job.
 */
export function attemptFixture(n: number, options: { readonly job?: number; readonly accepted?: readonly AcceptedGeneration[]; readonly agency?: number } = {}): AttemptFixture {
  const agencyId = v7(options.agency ?? 1000) as AgencyId;
  const projectId = v7(1001) as ProjectId;
  const jobId = v7(2000 + (options.job ?? n));
  const attemptId = v7(3000 + n);
  const identity = attemptIdentityOf(attemptId);
  const prefix = attemptStagingPrefixOf(agencyId, projectId, jobId, attemptId);
  const capability: AttemptCapability = {
    agencyId,
    projectId,
    jobId,
    attemptId,
    identity,
    stagingPrefix: prefix,
    manifestObjectName: stagedManifestObjectNameOf(prefix, attemptId),
    acceptedGenerations: options.accepted ?? [],
  };
  const subject: ExecutionSubject = {
    jobId,
    attemptId,
    agencyId,
    projectId,
    inputBindingHash: sha(`input-binding:${jobId}`),
    revisionHash: sha("revision"),
    targetContractHash: sha("target"),
    planHash: sha("plan"),
    configDocument: { plan: "fixture" },
    configHash: sha(`config:${jobId}`),
    executionDeadlineAt: "2026-09-21T12:00:00.000Z" as UtcInstant,
  };
  return { agencyId, projectId, jobId, attemptId, identity, prefix, capability, subject, spec: (fence, limits = limitsOf()) => ({ identity, capability, subject, limits, fence }) };
}

/** The holder side of the storage fake's sessions, optionally rewriting each chunk on its way (a short or corrupting network). */
export function holderOf(storage: ContractFakeObjectStorage, rewrite?: (chunk: Uint8Array, final: boolean) => Uint8Array): ResumableUploadPort {
  return {
    writeChunk: (sessionRef, chunk, options): Promise<ResumableUploadAnswer> =>
      Promise.resolve(storage.writeThroughSession(sessionRef, rewrite === undefined ? chunk : rewrite(chunk, options.final), options)),
  };
}

/** A cancellation channel whose answer the test sets; it counts its checks. */
export function manualChannel(initial: CancellationState = "CONTINUE"): CancellationChannel & { state: CancellationState; checks: number } {
  const channel = {
    state: initial,
    checks: 0,
    check(): Promise<CancellationState> {
      channel.checks += 1;
      return Promise.resolve(channel.state);
    },
  };
  return channel;
}

export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** A channel that answers `answers` in order and then repeats the last one; it counts its checks. */
export function scriptedChannel(...answers: CancellationState[]): CancellationChannel & { checks: number } {
  const channel = {
    checks: 0,
    check(): Promise<CancellationState> {
      const answer = answers[Math.min(channel.checks, answers.length - 1)] ?? "CONTINUE";
      channel.checks += 1;
      return Promise.resolve(answer);
    },
  };
  return channel;
}

/** The provider's clock of the worker-host fake, moved only by the test (never a platform lifecycle instant). */
export function manualClock(startMs: number): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => toUtcInstant(now),
    nowMs: () => now,
    advance(ms: number): void {
      now += ms;
    },
  };
}

/** Every regular file under `dir`, by its path relative to `dir` (forward slashes), with the SHA-256 of its bytes. */
export function snapshot(dir: string): Record<string, Sha256Hex> {
  const out: Record<string, Sha256Hex> = {};
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const key = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, key);
      else out[key] = stat.isFile() ? sha(readFileSync(path)) : `link:${key}`;
    }
  };
  walk(dir, "");
  return out;
}

/** Asserts `fn` throws the envelope failure of `cause` (and `problem`, when given). */
export function failsWith(fn: () => unknown, cause: AttemptFailureCause, problem?: string): void {
  assert.throws(fn, (error: unknown) => isFailure(error, cause, problem));
}

/** Asserts `promise` rejects with the envelope failure of `cause` (and `problem`, when given). */
export async function rejectsWith(promise: Promise<unknown>, cause: AttemptFailureCause, problem?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isFailure(error, cause, problem));
}

function isFailure(error: unknown, cause: AttemptFailureCause, problem: string | undefined): boolean {
  assert.ok(error instanceof AttemptEnvelopeFailure, `an envelope failure, not ${String(error)}`);
  assert.equal(error.terminalCause, cause, error.message);
  if (problem !== undefined) assert.equal(error.problem, problem, error.message);
  return true;
}

/** A deterministic payload of `length` bytes. */
export function payloadOf(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 7) % 251;
  return out;
}

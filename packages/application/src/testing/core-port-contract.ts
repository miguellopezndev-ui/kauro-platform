/**
 * The shared contract table of the Migration Core ports (B05 T01..T03): the same cases run against the labelled contract fake and
 * against the real adapter, each backend supplying only how to provoke its outcomes. A case throws on failure; the caller wraps each
 * one in its own test (this module imports no test runner).
 */
import assert from "node:assert/strict";
import type { Sha256Hex } from "@kauro/contracts";
import type { CoreEvidenceClass, ExecutionOutcome, ExpectedAuthority, PackageCandidate, PackageVerificationResult, StagedArtifact } from "../ports/index.js";

export interface CorePortBackend {
  readonly evidenceClass: CoreEvidenceClass;
  readonly coreVersion: string;
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex | null;
  verify(candidate: PackageCandidate, expected: ExpectedAuthority): Promise<PackageVerificationResult>;
  /** Provokes the named envelope outcome; the backend arranges the provocation its own way. */
  executeProvoked(kind: "SCRATCH_EXHAUSTED" | "SHORT_WRITE" | "CORRUPT_INTERMEDIATE" | "COMPLETED"): Promise<ExecutionOutcome>;
}

export interface CorePortContractCase {
  readonly id: string;
  readonly title: string;
  run(backend: CorePortBackend): Promise<void>;
}

function digest(tag: string): Sha256Hex {
  let hex = "";
  for (let i = 0; i < tag.length && hex.length < 64; i += 1) hex += tag.charCodeAt(i).toString(16).padStart(2, "0");
  return hex.padEnd(64, "0").slice(0, 64);
}

function artifact(overrides: Partial<StagedArtifact> = {}): StagedArtifact {
  return { role: "delivery", objectName: "delivery/01_IMPORT.csv", generation: "1", sha256: digest("artifact-bytes"), byteLength: 42, ...overrides };
}

export const CORE_PORT_CONTRACT: readonly CorePortContractCase[] = [
  {
    id: "T01",
    title: "<B>: verify checks only the caller's expected authority; a missing, duplicated, extra or foreign artifact and a false summary are each INVALID",
    async run(b) {
      const wanted = artifact();
      const expected: ExpectedAuthority = { revisionHash: b.revisionHash, planHash: b.planHash, targetContractHash: b.targetContractHash, coreVersion: b.coreVersion, requiredArtifacts: [wanted] };
      const ids = { jobId: "0192a000-0000-7000-8000-000000000001", attemptId: "0192a000-0000-7000-8000-000000000002" };
      const valid = await b.verify({ ...ids, artifacts: [wanted], declaredSummary: { ok: true } }, expected);
      assert.equal(valid.verdict, "VALID");
      assert.deepEqual(valid.problems, []);
      const missing = await b.verify({ ...ids, artifacts: [], declaredSummary: { ok: false } }, expected);
      assert.equal(missing.verdict, "INVALID");
      assert.ok(missing.problems.some((p) => p.startsWith("MISSING_ARTIFACT:")));
      const duplicated = await b.verify({ ...ids, artifacts: [wanted, wanted], declaredSummary: { ok: false } }, expected);
      assert.equal(duplicated.verdict, "INVALID");
      assert.ok(duplicated.problems.some((p) => p.startsWith("DUPLICATE_ARTIFACT:")));
      const withExtra = await b.verify({ ...ids, artifacts: [wanted, artifact({ objectName: "delivery/02_EXTRA.csv" })], declaredSummary: { ok: false } }, expected);
      assert.equal(withExtra.verdict, "INVALID");
      assert.ok(withExtra.problems.some((p) => p.startsWith("EXTRA_ARTIFACT:")));
      const withForeign = await b.verify({ ...ids, artifacts: [artifact({ sha256: digest("a-foreign-object") })], declaredSummary: { ok: false } }, expected);
      assert.equal(withForeign.verdict, "INVALID");
      assert.ok(withForeign.problems.some((p) => p.startsWith("FOREIGN_ARTIFACT:")));
      const falseSummary = await b.verify({ ...ids, artifacts: [], declaredSummary: { ok: true } }, expected);
      assert.equal(falseSummary.verdict, "INVALID");
      assert.ok(falseSummary.problems.includes("FALSE_SUMMARY"));
    },
  },
  {
    id: "T02",
    title: "<B>: execute reaches only its HostIo and answers SCRATCH_EXHAUSTED, SHORT_WRITE or CORRUPT_INTERMEDIATE for a provoked full scratch, short write or corrupt intermediate",
    async run(b) {
      for (const kind of ["SCRATCH_EXHAUSTED", "SHORT_WRITE", "CORRUPT_INTERMEDIATE"] as const) {
        const outcome = await b.executeProvoked(kind);
        assert.equal(outcome.terminalCause, kind);
        assert.deepEqual(outcome.stagedArtifacts.length === 0 || kind === "SHORT_WRITE", true);
      }
      const clean = await b.executeProvoked("COMPLETED");
      assert.equal(clean.terminalCause, "COMPLETED");
      assert.ok(clean.stagedArtifacts.length >= 1);
    },
  },
  {
    id: "T03",
    title: "<B>: every record carries the binding's evidence class and names its core version",
    async run(b) {
      const wanted = artifact();
      const expected: ExpectedAuthority = { revisionHash: b.revisionHash, planHash: b.planHash, targetContractHash: b.targetContractHash, coreVersion: b.coreVersion, requiredArtifacts: [wanted] };
      const verified = await b.verify({ jobId: "0192a000-0000-7000-8000-000000000001", attemptId: "0192a000-0000-7000-8000-000000000002", artifacts: [wanted], declaredSummary: { ok: true } }, expected);
      const executed = await b.executeProvoked("COMPLETED");
      for (const record of [verified, executed]) {
        assert.equal(record.evidenceClass, b.evidenceClass);
        assert.equal(record.coreVersion, b.coreVersion);
      }
    },
  },
];

// The labelled contract fakes of the two cores' ports (mandate B08-CORE-PORTS; design docs/design/B08-audit-approval-jobs.md
// §10, §13 D8-FAKE-1): ContractFakeMigrationCore (ProfilePort, ValidatePort, ExecutionEnvelopePort, PackageVerifierPort) and
// ContractFakeIntelligenceCore (InterpretPort, PlanCompilerPort). Everything proven here is SIMULATED — a local contract with
// fakes (21 "Evidence classes"), never EXECUTED_LOCAL; the real thin adapter is `b05/cores`'. Interleavings use the fakes' own
// hold points, never a sleep. `HostIo` and `ModelTaskJournalPort` are exercised here through minimal in-memory doubles: their
// real implementers (AttemptScratchStore/FencedArtifactWriter/GenerationSourceReader of B08-WORKER-HOST, the persistence
// journal of B08-PERSISTENCE-AUDIT) are later mandates' work; this file's doubles stand in only so the two labelled fakes can
// be driven end to end.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId, PlanBody, ProjectId } from "@kauro/domain";
import type {
  CancellationChannel,
  CancellationState,
  ExecutionSubject,
  ExpectedAuthority,
  HostIo,
  InterpretRequest,
  ModelTaskJournalEvent,
  ModelTaskJournalPort,
  PackageCandidate,
  ScratchStore,
  StagedArtifact,
} from "../src/index.js";
import {
  CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION,
  CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE,
  CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN,
  CONTRACT_FAKE_MIGRATION_CORE_TOKEN,
  ContractFakeIntelligenceCore,
  ContractFakeMigrationCore,
} from "../src/testing/index.js";

function sha(value: string): Sha256Hex {
  return createHash("sha256").update(value).digest("hex");
}

function v7(n: number): string {
  return `0192a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

const AGENCY = v7(1) as AgencyId;
const PROJECT = v7(2) as ProjectId;

/** A cancellation channel a test sets explicitly; never derived from a clock or a sleep. */
function testCancellation(initial: CancellationState = "CONTINUE"): CancellationChannel & { set(state: CancellationState): void } {
  let state = initial;
  return { check: () => Promise.resolve(state), set: (next) => { state = next; } };
}

/**
 * A minimal in-memory ScratchStore satisfying the port's contract (createSegment/seal/usage/dispose): enough for
 * ContractFakeMigrationCore.execute to open, write and seal one segment. Not a labelled fake — AttemptScratchStore
 * (B08-WORKER-HOST) is the real, always implementer; this is test-local plumbing.
 */
function testScratchStore(): ScratchStore {
  const segments = new Map<string, { readonly lines: string[]; sealed: boolean }>();
  let sequence = 0;
  return {
    contractVersion: "1.0.0",
    createSegment(spec) {
      const segmentId = `seg-${(sequence += 1)}`;
      const record = { lines: [] as string[], sealed: false };
      segments.set(segmentId, record);
      return {
        segmentId,
        append: (line) => record.lines.push(line),
        seal: () => {
          record.sealed = true;
          const bytes = Buffer.from(record.lines.join("\n"), "utf8");
          return { segmentId, schema: spec.schema, schemaVersion: spec.schemaVersion, sha256: sha(bytes.toString("utf8")), byteLength: bytes.byteLength, rowCount: record.lines.length, firstKey: null, lastKey: null, sorted: spec.sorted ?? false };
        },
        abort: () => segments.delete(segmentId),
      };
    },
    readLines: function* (segmentId) {
      for (const line of segments.get(segmentId)?.lines ?? []) yield line;
    },
    manifest: (segmentId) => {
      const record = segments.get(segmentId);
      if (record === undefined) throw new Error("unknown segment");
      const bytes = Buffer.from(record.lines.join("\n"), "utf8");
      return { segmentId, schema: "test", schemaVersion: "1", sha256: sha(bytes.toString("utf8")), byteLength: bytes.byteLength, rowCount: record.lines.length, firstKey: null, lastKey: null, sorted: false };
    },
    list: () => [],
    delete: (segmentId) => { segments.delete(segmentId); },
    declareFamily: () => undefined,
    recordSort: () => undefined,
    usage: () => ({ bytes: 0, peakBytes: 0, quotaBytes: 64 * 1024 * 1024 * 1024, segmentCount: segments.size, bytesWritten: 0, byFamily: [], framingBytesPerLine: 1 }),
    dispose: () => segments.clear(),
  };
}

/** A minimal in-memory ArtifactWriter: closes, hashes and re-reads before resolving (D8-STG-1). Test-local plumbing. */
function testArtifactWriter(): HostIo["writer"] {
  return {
    open(role, pathHash) {
      const chunks: Buffer[] = [];
      return {
        write: (chunk) => {
          chunks.push(Buffer.from(chunk));
          return Promise.resolve();
        },
        close: () => {
          const bytes = Buffer.concat(chunks);
          return Promise.resolve({ role, objectName: `staging/${pathHash}`, generation: "1", sha256: sha(bytes.toString("utf8")), byteLength: bytes.byteLength });
        },
      };
    },
  };
}

function testHostIo(cancellation: CancellationChannel = testCancellation()): HostIo {
  return {
    source: { open: () => Promise.reject(new Error("not exercised")) },
    scratch: testScratchStore(),
    writer: testArtifactWriter(),
    cancellation,
    limits: { hardMemoryBytes: 8 * 1024 ** 3, memoryBudgetBytes: 5.6 * 1024 ** 3, hardScratchBytes: 64 * 1024 ** 3, scratchBudgetBytes: 48 * 1024 ** 3, wallClockMs: 28_800_000 },
  };
}

function testSubject(overrides: Partial<ExecutionSubject> = {}): ExecutionSubject {
  return {
    jobId: v7(10),
    attemptId: v7(11),
    agencyId: AGENCY,
    projectId: PROJECT,
    inputBindingHash: sha("input-binding-1"),
    revisionHash: sha("revision-1"),
    targetContractHash: sha("target-1"),
    planHash: sha("plan-1"),
    configDocument: { mode: "CLEAN_ONLY" },
    configHash: sha("config-1"),
    executionDeadlineAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function stagedArtifact(overrides: Partial<StagedArtifact> = {}): StagedArtifact {
  return { role: "delivery", objectName: "delivery/01_IMPORT.csv", generation: "1", sha256: sha("artifact-bytes"), byteLength: 42, ...overrides };
}

/** A minimal in-memory ModelTaskJournalPort satisfying the fenced append/read contract. Test-local plumbing. */
function testJournal(): ModelTaskJournalPort {
  const runs = new Map<string, ModelTaskJournalEvent[]>();
  return {
    append: (runId, event, expectedLength) => {
      const events = runs.get(runId) ?? [];
      if (events.length !== expectedLength) return Promise.resolve({ ok: false, conflict: "LENGTH_MISMATCH", actualLength: events.length });
      events.push(event);
      runs.set(runId, events);
      return Promise.resolve({ ok: true, length: events.length });
    },
    read: (runId) => Promise.resolve([...(runs.get(runId) ?? [])]),
  };
}

test("the labelled Migration-core fake verifies a package only against the expected authority its caller supplies and rejects a missing, duplicated, extra or foreign artifact and a false summary; every record carries evidence class SIMULATED", async () => {
  const core = new ContractFakeMigrationCore();
  const wanted = stagedArtifact();
  const expected: ExpectedAuthority = { revisionHash: sha("revision-1"), planHash: sha("plan-1"), targetContractHash: sha("target-1"), coreVersion: "contract-fake-migration-core-2.0.3", requiredArtifacts: [wanted] };

  const valid = await core.verify({ jobId: v7(1), attemptId: v7(2), artifacts: [wanted], declaredSummary: { ok: true } }, expected);
  assert.deepEqual(valid, { evidenceClass: "SIMULATED", verdict: "VALID", problems: [] });

  const missing = await core.verify({ jobId: v7(1), attemptId: v7(2), artifacts: [], declaredSummary: { ok: false } }, expected);
  assert.equal(missing.evidenceClass, "SIMULATED");
  assert.equal(missing.verdict, "INVALID");
  assert.ok(missing.problems.some((p) => p.startsWith("MISSING_ARTIFACT:")));

  const duplicated = await core.verify({ jobId: v7(1), attemptId: v7(2), artifacts: [wanted, wanted], declaredSummary: { ok: false } }, expected);
  assert.equal(duplicated.verdict, "INVALID");
  assert.ok(duplicated.problems.some((p) => p.startsWith("DUPLICATE_ARTIFACT:")));

  const extra = stagedArtifact({ role: "delivery", objectName: "delivery/02_EXTRA.csv" });
  const withExtra = await core.verify({ jobId: v7(1), attemptId: v7(2), artifacts: [wanted, extra], declaredSummary: { ok: false } }, expected);
  assert.equal(withExtra.verdict, "INVALID");
  assert.ok(withExtra.problems.some((p) => p.startsWith("EXTRA_ARTIFACT:")));

  const foreign = stagedArtifact({ sha256: sha("a-foreign-object") });
  const withForeign = await core.verify({ jobId: v7(1), attemptId: v7(2), artifacts: [foreign], declaredSummary: { ok: false } }, expected);
  assert.equal(withForeign.verdict, "INVALID");
  assert.ok(withForeign.problems.some((p) => p.startsWith("FOREIGN_ARTIFACT:")));

  const falseSummary = await core.verify({ jobId: v7(1), attemptId: v7(2), artifacts: [], declaredSummary: { ok: true } }, expected);
  assert.equal(falseSummary.verdict, "INVALID");
  assert.ok(falseSummary.problems.includes("FALSE_SUMMARY"));

  // Every record of the fake, not only verify's, carries evidence class SIMULATED.
  const cancellation = testCancellation();
  const profiled = await core.profile({ source: { open: () => Promise.reject(new Error("unused")) }, revisionHash: sha("revision-1"), scratch: testScratchStore(), limits: testHostIo().limits, cancellation });
  const validated = await core.validate({ revisionHash: sha("revision-1"), planBody: {} as PlanBody, planHash: sha("plan-1"), targetContractHash: sha("target-1"), scratch: testScratchStore(), cancellation });
  const executed = await core.execute(testSubject(), testHostIo());
  for (const record of [valid, missing, duplicated, withExtra, withForeign, falseSummary, profiled, validated, executed]) {
    assert.equal(record.evidenceClass, "SIMULATED");
  }
  assert.ok(core.calls().every((call) => call.outcome !== "PENDING"));
});

test("ContractFakeMigrationCore.execute reaches only its HostIo and answers a scripted ENOSPC, short write or corrupt intermediate, holding at every awaited step", async () => {
  const core = new ContractFakeMigrationCore();

  core.failNextExecute("ENOSPC");
  const enospc = await core.execute(testSubject(), testHostIo());
  assert.equal(enospc.terminalCause, "SCRATCH_EXHAUSTED");
  assert.deepEqual(enospc.stagedArtifacts, []);

  core.failNextExecute("SHORT_WRITE");
  const short = await core.execute(testSubject(), testHostIo());
  assert.equal(short.terminalCause, "SHORT_WRITE");

  core.failNextExecute("CORRUPT_INTERMEDIATE");
  const corrupt = await core.execute(testSubject(), testHostIo());
  assert.equal(corrupt.terminalCause, "CORRUPT_INTERMEDIATE");

  const clean = await core.execute(testSubject(), testHostIo());
  assert.equal(clean.terminalCause, "COMPLETED");
  assert.equal(clean.stagedArtifacts.length, 1);

  const cancelled = testCancellation("CANCELLED");
  const cancelledOutcome = await core.execute(testSubject(), testHostIo(cancelled));
  assert.equal(cancelledOutcome.terminalCause, "CANCELLED");

  // A hold point on "write" pauses the call until released, without a sleep.
  const hold = core.holdNext("write");
  const pending = core.execute(testSubject(), testHostIo());
  await hold.reached;
  let resolved = false;
  void pending.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false, "execute must not resolve before the held write step is released");
  hold.release();
  const outcome = await pending;
  assert.equal(outcome.terminalCause, "COMPLETED");
});

test("the labelled Intelligence-core fake plans a complete candidate manifest, answers COMPILED, NEEDS_DECISION, UNSUPPORTED or FAILED as scripted through the journal port, compiles a stored response before any new dispatch and never dispatches without a reservation; evidence class SIMULATED", async () => {
  const core = new ContractFakeIntelligenceCore();
  const journal = testJournal();
  const auditAttemptId = v7(20);

  const manifest = await core.planCandidates({ revisionHash: sha("revision-1"), sourceProfileHash: sha("profile-1"), targetContractHash: sha("target-1") });
  assert.equal(manifest.evidenceClass, "SIMULATED");
  const document = manifest.document as { readonly complete: boolean; readonly candidates: readonly unknown[] };
  assert.equal(document.complete, true);
  assert.ok(document.candidates.length > 0, "a complete candidate manifest names at least one candidate");

  const requestOf = (): InterpretRequest => ({
    auditAttemptId,
    agencyId: AGENCY,
    candidateManifest: manifest,
    journal,
    fundedCeilingCents: 150,
    interpretationDeadlineAt: "2026-09-29T00:20:00.000Z",
    cancellation: testCancellation(),
  });

  core.scriptInterpretOutcomes("COMPILED", "NEEDS_DECISION", "UNSUPPORTED", "FAILED");

  const first = await core.interpret(requestOf());
  assert.equal(first.evidenceClass, "SIMULATED");
  assert.equal(first.outcome, "COMPILED");
  assert.ok(first.reservedCents > 0, "the first dispatch of a candidate set reserves before it dispatches");
  assert.equal(first.spentCents, first.reservedCents);

  // A stored response is compiled before any new dispatch: a repeat of the same candidate set answers the same
  // outcome without a second reservation or a second cost.
  const events = await journal.read(auditAttemptId);
  const reservationsAfterFirst = events.filter((e) => e["kind"] === CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION).length;
  const replay = await core.interpret(requestOf());
  assert.equal(replay.outcome, "COMPILED");
  assert.equal(replay.reservedCents, 0);
  assert.equal(replay.spentCents, 0);
  const eventsAfterReplay = await journal.read(auditAttemptId);
  assert.equal(eventsAfterReplay.length, events.length, "a replay of a stored response appends nothing new to the journal");

  // A different candidate set is a new dispatch, scripted to the next queued outcome.
  const secondManifest = await core.planCandidates({ revisionHash: sha("revision-2"), sourceProfileHash: sha("profile-2"), targetContractHash: null });
  const second = await core.interpret({ ...requestOf(), candidateManifest: secondManifest });
  assert.equal(second.outcome, "NEEDS_DECISION");
  assert.ok(second.candidateDecisions !== null);

  const thirdManifest = await core.planCandidates({ revisionHash: sha("revision-3"), sourceProfileHash: sha("profile-3"), targetContractHash: null });
  const third = await core.interpret({ ...requestOf(), candidateManifest: thirdManifest });
  assert.equal(third.outcome, "UNSUPPORTED");
  assert.equal(third.candidateDecisions, null);

  const fourthManifest = await core.planCandidates({ revisionHash: sha("revision-4"), sourceProfileHash: sha("profile-4"), targetContractHash: null });
  const fourth = await core.interpret({ ...requestOf(), candidateManifest: fourthManifest });
  assert.equal(fourth.outcome, "FAILED");
  assert.equal(fourth.candidateDecisions, null);

  // Never dispatches without a reservation: every RESPONSE event in the journal is preceded by its own RESERVATION.
  const allEvents = await journal.read(auditAttemptId);
  let reservations = 0;
  for (const event of allEvents) {
    if (event["kind"] === CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION) reservations += 1;
    if (event["kind"] === CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE) {
      assert.ok(reservations > 0, "a response was journaled with no reservation preceding it");
      reservations -= 1;
    }
  }
  assert.ok(reservationsAfterFirst >= 1);

  // With no room under the funded ceiling, interpret answers FAILED and reserves nothing (never dispatches without room).
  const fifthManifest = await core.planCandidates({ revisionHash: sha("revision-5"), sourceProfileHash: sha("profile-5"), targetContractHash: null });
  const beforeStarved = await journal.read(auditAttemptId);
  const starved = await core.interpret({ ...requestOf(), candidateManifest: fifthManifest, fundedCeilingCents: 1 });
  assert.equal(starved.outcome, "FAILED");
  assert.equal(starved.reservedCents, 0);
  const afterStarved = await journal.read(auditAttemptId);
  assert.equal(afterStarved.length, beforeStarved.length, "a request with no room under the ceiling writes nothing to the journal");

  // PlanCompilerPort: a candidate decision already shaped as a plan body compiles; a malformed one is rejected with B06's vocabulary.
  const body = { revisionHash: sha("revision-1"), targetContractHash: sha("target-1"), policyHash: sha("policy-1"), mappings: [], identities: [], transforms: [], relationships: [] } as unknown as PlanBody;
  const compiled = await core.compile({ body }, null);
  assert.equal(compiled.kind, "COMPILED");
  const rejected = await core.compile({ nothing: true }, null);
  assert.deepEqual(rejected, { kind: "REJECTED", reason: "MALFORMED_PATCH" });

  assert.ok(core.calls().every((call) => call.outcome !== "PENDING"));
  assert.ok(Object.values({ CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN, CONTRACT_FAKE_MIGRATION_CORE_TOKEN }).every((token) => /^contract-fake-[a-z-]+$/.test(token)));
});

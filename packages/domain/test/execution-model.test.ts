// Processing authority in the domain (package B08, mandate B08-PERSISTENCE-EXECUTION; docs/design/B08-audit-approval-jobs.md): the
// fair scheduler of D8-SCHED-1 (R2-046), the policy values of D8-CAP-1/D8-ATT-1/D8-RET-1 against the vendored registry, the two
// platform machines of §8.2 beside the registry's Job machine, the digests of D8-JOB-2 and D8-STG-5, and the event vocabulary of §11.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMAINS, STATE_MACHINES, canonicalBytes, rawDigest, registryJson, structuredDigest } from "@kauro/contracts";
import {
  AGGREGATE_KINDS,
  CONSUMERS,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_SUBSCRIPTIONS,
  EVENT_TYPES,
  EXECUTION_CONTROL_EVENT_TYPES,
  EXECUTION_EVENT_TYPES,
  EXECUTION_FAILURE_REASONS,
  EXECUTION_PLATFORM_MACHINES,
  EXECUTION_POLICY,
  FAILURE_REASONS,
  JOB_STATES,
  PACKAGE_STATES,
  ATTEMPT_STATES,
  assertAllowlistedPayload,
  consumersOf,
  deliveryManifestHashOf,
  fairAdmissionOrder,
  jobAttemptIdentityOf,
  jobAttemptStagingPrefixOf,
  jobEventTypeOf,
  jobInputBindingHashOf,
  machine,
  packageDeliveryPrefixOf,
  packageEventTypeOf,
  stagedManifestHashOf,
  statesOf,
  transition,
  type AdmissionCandidate,
  type AgencyId,
  type JobExecutionSubject,
  type ProcessingJobId,
} from "../src/index.js";

const at = (iso: string) => iso as AdmissionCandidate["queuedAt"];
const job = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}` as ProcessingJobId;
const agency = (n: number) => `01910000-0000-7000-8000-${String(n).padStart(12, "0")}` as AgencyId;

/** Every permutation of a small list (the scheduler must answer the same order for each). */
function permutations<T>(items: ReadonlyArray<T>): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

test("R2-046: the fair scheduler orders queued jobs by the agency's held slots, then the agency's longest wait, then the job's queue instant and id, deterministically under any input order", () => {
  const candidates: AdmissionCandidate[] = [
    // agency 1 already holds two slots: its jobs come after every agency holding fewer, whatever their queue instants
    { jobId: job(1), agencyId: agency(1), queuedAt: at("2026-09-29T08:00:00.000Z"), agencyHeldSlots: 2, agencyLastAdmittedAt: at("2026-09-29T09:00:00.000Z") },
    { jobId: job(2), agencyId: agency(1), queuedAt: at("2026-09-29T08:00:01.000Z"), agencyHeldSlots: 2, agencyLastAdmittedAt: at("2026-09-29T09:00:00.000Z") },
    // agencies 2 and 3 hold one slot each: the one that has waited longer since its last admission goes first
    { jobId: job(3), agencyId: agency(2), queuedAt: at("2026-09-29T10:00:00.000Z"), agencyHeldSlots: 1, agencyLastAdmittedAt: at("2026-09-29T07:00:00.000Z") },
    { jobId: job(4), agencyId: agency(3), queuedAt: at("2026-09-29T06:00:00.000Z"), agencyHeldSlots: 1, agencyLastAdmittedAt: at("2026-09-29T07:30:00.000Z") },
    // agency 4 holds nothing and was never admitted: first of all, and before agency 5, which holds nothing but was admitted before
    { jobId: job(5), agencyId: agency(4), queuedAt: at("2026-09-29T11:00:00.000Z"), agencyHeldSlots: 0, agencyLastAdmittedAt: null },
    { jobId: job(6), agencyId: agency(5), queuedAt: at("2026-09-29T05:00:00.000Z"), agencyHeldSlots: 0, agencyLastAdmittedAt: at("2026-09-28T23:00:00.000Z") },
    // two jobs of one agency queued at the same instant: the id decides
    { jobId: job(8), agencyId: agency(6), queuedAt: at("2026-09-29T12:00:00.000Z"), agencyHeldSlots: 0, agencyLastAdmittedAt: at("2026-09-29T00:00:00.000Z") },
    { jobId: job(7), agencyId: agency(6), queuedAt: at("2026-09-29T12:00:00.000Z"), agencyHeldSlots: 0, agencyLastAdmittedAt: at("2026-09-29T00:00:00.000Z") },
  ];
  const expected = [job(5), job(6), job(7), job(8), job(3), job(4), job(1), job(2)];
  assert.deepEqual(fairAdmissionOrder(candidates).map((c) => c.jobId), expected);
  // deterministic under any input order: every permutation of a representative subset yields the same order
  const subset = [candidates[0]!, candidates[2]!, candidates[4]!, candidates[6]!, candidates[7]!, candidates[5]!];
  const subsetOrder = fairAdmissionOrder(subset).map((c) => c.jobId);
  assert.deepEqual(subsetOrder, [job(5), job(6), job(7), job(8), job(3), job(1)]);
  for (const permuted of permutations(subset)) assert.deepEqual(fairAdmissionOrder(permuted).map((c) => c.jobId), subsetOrder);
  // the database stamps microseconds (D8-CLOCK-1): two jobs queued within one millisecond keep the database's order, not the ids'
  const withinOneMillisecond = [
    { ...candidates[6]!, jobId: job(9), queuedAt: at("2026-09-29T12:00:00.000200Z") },
    { ...candidates[6]!, jobId: job(10), queuedAt: at("2026-09-29T12:00:00.0001Z") },
  ];
  assert.deepEqual(fairAdmissionOrder(withinOneMillisecond).map((c) => c.jobId), [job(10), job(9)]);
  // the input is not reordered, and a malformed count or instant is refused rather than ordered
  const copy = [...candidates];
  fairAdmissionOrder(copy);
  assert.deepEqual(copy, candidates);
  assert.throws(() => fairAdmissionOrder([{ ...candidates[0]!, agencyHeldSlots: -1 }]), RangeError);
  assert.throws(() => fairAdmissionOrder([{ ...candidates[0]!, queuedAt: at("not an instant") }]), RangeError);
});

test("the execution policy values are the registry's: one ACTIVE and three WAITING heavy jobs, three live jobs per agency, the 8 h execution wall and the paid retention and delivery deadlines", () => {
  const policy = registryJson<{ capacity: Record<string, number>; retention: Record<string, number> }>("policy.json");
  assert.equal(EXECUTION_POLICY.heavyActive, policy.capacity["heavyActive"]);
  assert.equal(EXECUTION_POLICY.heavyQueued, policy.capacity["heavyQueued"]);
  assert.equal(EXECUTION_POLICY.agencyLiveJobs, policy.capacity["heavyQueued"], "Q8-2: the per-agency bound is heavyQueued");
  assert.equal(EXECUTION_POLICY.executionSeconds, policy.capacity["executionSeconds"]);
  assert.equal(EXECUTION_POLICY.deliveryDeadlineSeconds, (policy.retention["ordinaryPaidNoTerminalHours"] ?? 0) * 3600);
  assert.equal(EXECUTION_POLICY.paidOrdinaryHardSeconds, (policy.retention["paidDaysHardFromCapture"] ?? 0) * 86_400);
  assert.equal(EXECUTION_POLICY.paidOrdinarySoftSeconds, (policy.retention["paidDaysFromFirstPackage"] ?? 0) * 86_400);
  assert.deepEqual([EXECUTION_POLICY.leaseSeconds, EXECUTION_POLICY.heartbeatSeconds, EXECUTION_POLICY.maxAttempts], [120, 30, 3]);
});

test("the Job machine is the registry's; ProcessingAttempt and PackageVersion are the platform machines of design 8.2 over the registry Job and PackageManifest vocabularies", () => {
  const vendored = STATE_MACHINES.find((m) => m.contract === "Job");
  assert.ok(vendored);
  assert.equal(machine("Job"), vendored);
  const contracts = registryJson<Array<{ name: string; fields: Array<{ name: string; type: string }> }>>("contracts.json");
  const jobState = contracts.find((c) => c.name === "Job")?.fields.find((f) => f.name === "state");
  assert.deepEqual([...JOB_STATES].sort(), jobState?.type.slice(5).split(",").sort());
  assert.deepEqual([...statesOf("ProcessingAttempt")].sort(), [...ATTEMPT_STATES].sort());
  assert.deepEqual([...statesOf("PackageVersion")].sort(), [...PACKAGE_STATES].sort());
  for (const m of EXECUTION_PLATFORM_MACHINES) {
    const seen = new Set<string>();
    for (const t of m.transitions) {
      assert.equal(seen.has(`${t.from}/${t.event}`), false, `${m.contract} ${t.from} ${t.event} is unique`);
      seen.add(`${t.from}/${t.event}`);
      assert.equal(transition(m.contract as "ProcessingAttempt" | "PackageVersion", t.from, t.event), t.to);
    }
  }
  assert.equal(transition("ProcessingAttempt", "VERIFYING", "publication_committed"), "COMMITTED");
  assert.equal(transition("PackageVersion", "VERIFIED_PRIVATE", "package_published"), "AVAILABLE");
  assert.throws(() => transition("PackageVersion", "STAGED", "package_published"), /no listed transition/);
});

test("the digests of processing authority: the input binding is domain separated over the full execution subject, the staged manifest digest is the worker host's manifest bytes, the delivery manifest is KAURO_DELIVERY_MANIFEST_V1, and the names are the attempt's and the package's own", () => {
  const subject: JobExecutionSubject = {
    agencyId: agency(1),
    projectId: "01920000-0000-7000-8000-000000000001" as JobExecutionSubject["projectId"],
    authorizationId: "01930000-0000-7000-8000-000000000001" as JobExecutionSubject["authorizationId"],
    captureId: "01940000-0000-7000-8000-000000000001" as JobExecutionSubject["captureId"],
    planId: "01950000-0000-7000-8000-000000000001" as JobExecutionSubject["planId"],
    planHash: "1".repeat(64),
    approvalId: "01960000-0000-7000-8000-000000000001" as JobExecutionSubject["approvalId"],
    approvalHash: "2".repeat(64),
    revisionHash: "3".repeat(64),
    targetContractHash: "4".repeat(64),
    capabilityId: "01970000-0000-7000-8000-000000000001" as JobExecutionSubject["capabilityId"],
    capabilityVersion: "R2-INITIAL",
    mode: "HUBSPOT",
    validationReceiptHash: "5".repeat(64),
    corePackageHash: "6".repeat(64),
  };
  const binding = jobInputBindingHashOf(subject);
  assert.equal(binding, rawDigest(canonicalBytes({ domain: "KAURO_JOB_INPUT_BINDING_V1", version: 1, payload: { ...subject } })));
  // every member binds: another core package is another binding
  assert.notEqual(jobInputBindingHashOf({ ...subject, corePackageHash: "7".repeat(64) }), binding);
  // the vector the worker host's stagedManifestBytesOf produces for the same manifest (@kauro/application ports/worker-host.ts;
  // D8-STG-5): the artifacts are ordered by object name inside the canonical KAURO_STAGED_MANIFEST_V1 wrapper
  const manifest = {
    jobId: "01900000-0000-7000-8000-000000000001",
    attemptId: "01900000-0000-7000-8000-000000000002",
    fence: 2,
    inputBindingHash: "a".repeat(64),
    artifacts: [
      { role: "records", objectName: "staging/b/2", generation: "17", sha256: "c".repeat(64), byteLength: 20 },
      { role: "import", objectName: "staging/a/1", generation: "12", sha256: "b".repeat(64), byteLength: 10 },
    ],
    declaredSummary: { rows: 3, issues: [] },
  };
  assert.equal(stagedManifestHashOf(manifest), "1fc4feb36b570ef5ff2e6e93d9a67aa7afb3d5f7a16eade2dd59a31c4d604ca0");
  const delivery = {
    packageId: "01980000-0000-7000-8000-000000000001",
    revisionHash: subject.revisionHash,
    planHash: subject.planHash,
    targetContractHash: subject.targetContractHash,
    corePackageHash: subject.corePackageHash,
    validationReceiptHash: subject.validationReceiptHash,
    artifacts: [{ role: "import", objectName: "delivery/x", generation: "3", sha256: "d".repeat(64), byteLength: 5 }],
    counts: { physicalSourceRows: 3 },
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-10-06T00:00:00.000Z",
    manifestVersion: "1",
  };
  assert.equal(deliveryManifestHashOf(delivery), structuredDigest(DOMAINS.DELIVERY_MANIFEST, 1, delivery));
  const attemptId = "01990000-0000-7000-8000-000000000001";
  assert.equal(jobAttemptIdentityOf(attemptId), `kauro-attempt-${attemptId}`);
  assert.equal(jobAttemptStagingPrefixOf(subject.agencyId, subject.projectId, manifest.jobId, attemptId), `staging/${subject.agencyId}/${subject.projectId}/${manifest.jobId}/${attemptId}/`);
  assert.equal(packageDeliveryPrefixOf(subject.agencyId, subject.projectId, delivery.packageId), `delivery/${subject.agencyId}/${subject.projectId}/${delivery.packageId}/`);
  assert.throws(() => jobAttemptIdentityOf("job-1"), TypeError);
  assert.throws(() => jobAttemptStagingPrefixOf(subject.agencyId, subject.projectId, "job-10", attemptId), TypeError);
});

test("the execution events are registered with allowlists and routed as design section 11 says; the control plane's types are refused to nothing else; the failure reasons of D8-SQL-1 are closed tokens", () => {
  for (const type of EXECUTION_EVENT_TYPES) {
    assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes(type), type);
    assert.ok(EVENT_PAYLOAD_ALLOWLIST[type].length > 0, type);
  }
  assert.ok((AGGREGATE_KINDS as ReadonlyArray<string>).includes("processing_job"));
  assert.ok((AGGREGATE_KINDS as ReadonlyArray<string>).includes("package_version"));
  assert.ok((CONSUMERS as ReadonlyArray<string>).includes("JOB_EXECUTION"));
  const routed = (type: (typeof EVENT_TYPES)[number]) => [...consumersOf(type)].sort();
  assert.deepEqual(routed("processing_job.queued.v1"), ["JOB_EXECUTION"]);
  assert.deepEqual(routed("processing_job.admitted.v1"), ["JOB_EXECUTION"]);
  assert.deepEqual(routed("processing_job.verifying.v1"), ["JOB_EXECUTION"]);
  assert.deepEqual(routed("package_version.verified_private.v1"), ["JOB_EXECUTION"]);
  assert.deepEqual(routed("processing_job.cancel_requested.v1"), ["EXECUTION_CONTROL"]);
  for (const type of ["processing_job.ready.v1", "processing_job.failed.v1", "processing_job.cancelled.v1", "processing_job.expired.v1", "package_version.available.v1", "commercial_authorization.delivered.v1"] as const) assert.deepEqual(routed(type), ["NOTIFICATIONS"], type);
  assert.deepEqual(routed("processing_job.running.v1"), []);
  assert.ok(EVENT_SUBSCRIPTIONS.every((s) => (EVENT_TYPES as ReadonlyArray<string>).includes(s.eventType)));
  // the request handlers' own execution types (CMD036, CMD037) are not control-plane types
  assert.equal((EXECUTION_CONTROL_EVENT_TYPES as ReadonlyArray<string>).includes("processing_job.queued.v1"), false);
  assert.equal((EXECUTION_CONTROL_EVENT_TYPES as ReadonlyArray<string>).includes("processing_job.cancel_requested.v1"), false);
  assert.equal(jobEventTypeOf("CANCEL_REQUESTED"), "processing_job.cancel_requested.v1");
  assert.equal(packageEventTypeOf("VERIFIED_PRIVATE"), "package_version.verified_private.v1");
  assert.throws(() => jobEventTypeOf("SOMEWHERE"), TypeError);
  // payloads carry ids, hashes, tokens and counts: an object name or a label is refused
  assert.throws(() => assertAllowlistedPayload("package_version.available.v1", { packageVersionId: job(1), objectName: "delivery/x" } as never), TypeError);
  assert.throws(() => assertAllowlistedPayload("processing_job.cancel_requested.v1", { jobId: job(1), actorKind: "a customer label" }), TypeError);
  for (const reason of EXECUTION_FAILURE_REASONS) assert.ok((FAILURE_REASONS as ReadonlyArray<string>).includes(reason), reason);
});

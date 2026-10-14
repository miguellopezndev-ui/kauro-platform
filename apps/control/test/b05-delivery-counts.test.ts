// ROWCOUNTS-PRODUCER (package B05; registry RowCounts, owner manual 03 "Counters have named denominators and cannot be substituted
// for one another"; docs/design/B13-report-model.md §3 Q-B13-1): JOB_EXECUTION's publication issues the PackageManifest's RowCounts
// from the sealed revision's four populations and the bound validation receipt's counts, read in the publication's own transaction
// on a real PostgreSQL 17 through the control plane's own role (kauro_control_test). A receipt the publication may not issue counts
// from fails the job with the reason and revokes its private package: never AVAILABLE, the authorization never DELIVERED.
// SIMULATED: the worker host, the Migration core and the storage are the labelled contract fakes (execution-world.ts). The superuser
// is the oracle and, for the forged receipts only, the writer that bypasses the receipt's append-only trigger.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ValidatePort } from "@kauro/application";
import { AttemptEnvelopeFailure, GenerationSourceReader } from "@kauro/data-plane";
import type { RowCounts } from "@kauro/contracts";
import { deliveryManifestHashOf, issuedDeliveryManifestOf, type AgencyId, type AuditUnitOfWork, type DeliveryArtifactRecord, type ExecutionAuthorityFacts, type ExecutionContext, type ProcessingJobId, type PlanBody, type ProcessingJobRecord, type SystemContext, type UnitOfWorkOptions, type ValidationReceiptId, type ValidationSource } from "@kauro/domain";
import { PlanValidator, planBodyHashOf, type AuditUnits } from "../src/index.js";
import { TEST_LIMITS, ids, sha, startExecutionWorld, verifiedPrivate, type ExecutionWorld, type Purchase } from "./support/execution-world.js";

let w: ExecutionWorld;

before(async () => {
  w = await startExecutionWorld("b05-counts");
});

after(async () => {
  await w.stop();
});

interface Published {
  readonly hash: string;
  readonly createdAt: string;
  readonly job: ProcessingJobRecord;
  readonly copies: ReadonlyArray<DeliveryArtifactRecord>;
  readonly facts: ExecutionAuthorityFacts;
}

/** The control plane's units, unchanged, with each unit's last server instant, job, copies and authority recorded at its publish call. */
function recordingUnits(inner: AuditUnits): { readonly units: AuditUnits; readonly published: Published[] } {
  const published: Published[] = [];
  const instrument = (uow: AuditUnitOfWork): AuditUnitOfWork => {
    const seen: { now?: string; job?: ProcessingJobRecord; copies?: ReadonlyArray<DeliveryArtifactRecord>; facts?: ExecutionAuthorityFacts } = {};
    const wrap = <S extends object>(store: S, on: Record<string, (out: unknown, args: unknown[]) => void>): S =>
      new Proxy(store, {
        get(s, p) {
          const fn = Reflect.get(s, p, s) as unknown;
          if (typeof fn !== "function") return fn;
          const bound = (fn as (...args: unknown[]) => unknown).bind(s);
          const hook = typeof p === "string" ? on[p] : undefined;
          if (hook === undefined) return bound;
          return async (...args: unknown[]) => {
            const out = await bound(...args);
            hook(out, args);
            return out;
          };
        },
      });
    return new Proxy(uow, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "executionDiscovery") return wrap(value as object, { serverNow: (out) => void (seen.now = out as string) });
        if (prop === "execution")
          return wrap(value as object, {
            getJob: (out) => void (out !== null && (seen.job = out as ProcessingJobRecord)),
            deliveryArtifactsOf: (out) => void (seen.copies = out as ReadonlyArray<DeliveryArtifactRecord>),
            readAuthority: (out) => void (seen.facts ??= out as ExecutionAuthorityFacts),
            publish: (_out, args) => {
              const input = args[0] as { readonly deliveryManifestHash: string };
              published.push({ hash: input.deliveryManifestHash, createdAt: seen.now!, job: seen.job!, copies: seen.copies!, facts: seen.facts! });
            },
          });
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  const units = new Proxy(inner, {
    get(target, prop) {
      if (prop === "run") return <T>(context: ExecutionContext, work: (uow: AuditUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions) => target.run(context, (uow) => work(instrument(uow)), options);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { units, published };
}

/** The oracle's RowCounts of a purchase: the sealed revision's populations and the receipt's execution counts, read independently. */
async function oracleCounts(p: Purchase, receiptHash: string): Promise<RowCounts> {
  const rev = await w.h.oracle.query<{ physical: string; logical: string; billable: string; edges: string }>(
    "SELECT physical_source_rows::text AS physical, logical_source_records::text AS logical, billable_source_units::text AS billable, association_edges::text AS edges FROM kauro.dataset_revisions WHERE revision_id = $1",
    [p.revisionId],
  );
  const receipt = await w.h.oracle.query<{ counts: Record<string, number> }>("SELECT counts FROM kauro.validation_receipts WHERE receipt_hash = $1 AND agency_id = $2", [receiptHash, p.agency.agencyId]);
  const r = rev.rows[0]!;
  const c = receipt.rows[0]!.counts;
  return {
    physicalSourceRows: Number(r.physical),
    logicalSourceRecords: Number(r.logical),
    billableSourceUnits: Number(r.billable),
    associationEdges: Number(r.edges),
    emittedRepresentatives: c["emittedRepresentatives"]!,
    mergedNonSurvivors: c["mergedNonSurvivors"]!,
    rejected: c["rejected"]!,
    withheld: c["withheld"]!,
    unresolved: c["unresolved"]!,
    emittedArtifactRows: c["emittedArtifactRows"]!,
  };
}

/** The superuser rewrites a stored receipt's counts past its append-only trigger (a forged record; the product never can). */
async function forgeReceiptCounts(receiptHash: string, counts: Record<string, unknown>): Promise<void> {
  const literal = JSON.stringify(counts).replace(/'/g, "''");
  await w.h.oracle.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE kauro.validation_receipts SET counts = '${literal}'::jsonb WHERE receipt_hash = '${receiptHash}'; COMMIT;`);
}

async function receiptHashOf(jobId: string): Promise<string> {
  return (await w.h.oracle.query<{ h: string }>("SELECT validation_receipt_hash AS h FROM kauro.processing_jobs WHERE job_id = $1", [jobId])).rows[0]!.h;
}

test("ROWCOUNTS-PRODUCER OK: the published package's KAURO_DELIVERY_MANIFEST_V1 digest binds the registry RowCounts of the sealed revision's populations and the bound validation receipt's counts, read by the control plane in the publication's transaction", async () => {
  const A = await w.agency("rc-ok");
  const p = await w.paid(A, "rc-ok");
  const { jobId } = await verifiedPrivate(w, p);
  const rec = recordingUnits(w.units);
  const plane = w.planeWith({ units: rec.units }).execution;
  assert.ok(plane !== null);
  assert.deepEqual(await plane.pipeline.publish(jobId as ProcessingJobId), { kind: "APPLIED", what: "PUBLISHED" });
  assert.equal(rec.published.length, 1, "one publication");
  const [pub] = rec.published;
  const counts = await oracleCounts(p, await receiptHashOf(jobId));
  assert.ok(counts.physicalSourceRows > 0 && counts.emittedArtifactRows > 0, "nonzero populations and output");
  const expected = deliveryManifestHashOf(
    issuedDeliveryManifestOf({ packageId: (await w.packages(jobId))[0]!.package_version_id, subject: pub!.job, copies: pub!.copies, counts, createdAt: pub!.createdAt, captureCompletedAt: pub!.facts.captureCompletedAt! }),
  );
  assert.equal(pub!.hash, expected, "the issued manifest names exactly these counts");
  const [pkg] = await w.packages(jobId);
  assert.deepEqual([pkg?.state, pkg?.delivery_manifest_hash], ["AVAILABLE", expected]);
  assert.equal((await w.job(jobId)).state, "READY");
  await w.quiesce();
});

test("ROWCOUNTS-PRODUCER DENY (populations): a bound receipt naming other populations than the sealed revision's (one member at a time, higher or lower) fails the job DELIVERY_COUNTS_MISMATCH, revokes the private package and never delivers: the validator handed the core the sealed source and its billable units, so a receipt counting another population is not the revision's", async () => {
  const A = await w.agency("rc-pop");
  const cases: ReadonlyArray<readonly [string, (c: RowCounts) => RowCounts]> = [
    ["physical higher", (c) => ({ ...c, physicalSourceRows: c.physicalSourceRows + 1 })],
    ["logical lower", (c) => ({ ...c, logicalSourceRecords: c.logicalSourceRecords - 1 })],
    ["billable higher", (c) => ({ ...c, billableSourceUnits: c.billableSourceUnits + 5 })],
    ["edges higher", (c) => ({ ...c, associationEdges: c.associationEdges + 2 })],
  ];
  for (const [label, forge] of cases) {
    const p = await w.paid(A, `rc-pop-${label.replace(/ /g, "-")}`);
    const { jobId } = await verifiedPrivate(w, p);
    const receiptHash = await receiptHashOf(jobId);
    const sealed = await oracleCounts(p, receiptHash);
    assert.ok(sealed.logicalSourceRecords > 0, "a nonzero sealed population");
    await forgeReceiptCounts(receiptHash, { ...forge(sealed) });
    assert.deepEqual(await w.x.pipeline.publish(jobId as ProcessingJobId), { kind: "APPLIED", what: "FAILED" }, label);
    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason], ["FAILED", "DELIVERY_COUNTS_MISMATCH"], label);
    const [pkg] = await w.packages(jobId);
    assert.deepEqual([pkg?.state, pkg?.delivery_manifest_hash], ["REVOKED", null], label);
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", `${label}: never DELIVERED`);
  }
  await w.quiesce();
});

test("ROWCOUNTS-PRODUCER DENY: a bound receipt that lacks a RowCounts member or carries another, holds a non-integer, or has a positive unresolved fails the job DELIVERY_COUNTS_UNAVAILABLE or DELIVERY_COUNTS_UNRESOLVED, revokes the private package and never delivers", async () => {
  const A = await w.agency("rc-deny");
  const cases: ReadonlyArray<readonly [string, (c: RowCounts) => Record<string, unknown>, string]> = [
    ["member missing", (c) => { const { emittedArtifactRows: _gone, ...rest } = c; return rest; }, "DELIVERY_COUNTS_UNAVAILABLE"],
    ["extra member", (c) => ({ ...c, artifacts: 1 }), "DELIVERY_COUNTS_UNAVAILABLE"],
    ["non-integer", (c) => ({ ...c, rejected: 0.5 }), "DELIVERY_COUNTS_UNAVAILABLE"],
    ["unresolved", (c) => ({ ...c, unresolved: 1 }), "DELIVERY_COUNTS_UNRESOLVED"],
  ];
  for (const [label, forge, reason] of cases) {
    const p = await w.paid(A, `rc-${label.replace(/ /g, "-")}`);
    const { jobId } = await verifiedPrivate(w, p);
    const receiptHash = await receiptHashOf(jobId);
    await forgeReceiptCounts(receiptHash, forge(await oracleCounts(p, receiptHash)));
    assert.deepEqual(await w.x.pipeline.publish(jobId as ProcessingJobId), { kind: "APPLIED", what: "FAILED" }, label);
    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason], ["FAILED", reason], label);
    const [pkg] = await w.packages(jobId);
    assert.deepEqual([pkg?.state, pkg?.delivery_manifest_hash], ["REVOKED", null], label);
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", `${label}: never DELIVERED`);
  }
  await w.quiesce();
});

test("ROWCOUNTS-PRODUCER OK (validator source): PlanValidator hands the core a reader over exactly the sealed revision's ACCEPTED generations (each read back at its sealed digest and length) and the frozen billable units, read by AuditDiscovery.validationSource in a unit bound to the agency; an unknown hash, another agency's revision or a revision without populations validates nothing (VALIDATION_SOURCE_UNAVAILABLE) and calls no core", async () => {
  const A = await w.agency("rc-src");
  const B = await w.agency("rc-src-other");
  const p = await w.paid(A, "rc-src");
  const bound = (agencyId: string) => ({ kind: "SYSTEM", serviceId: "plan-validation", correlationId: ids.next(), agencyId }) as unknown as SystemContext;
  const sourceOf = (agencyId: string, hash: string) => w.units.run(bound(agencyId), (uow) => uow.auditDiscovery.validationSource(agencyId as AgencyId, hash));
  const sealed = (await w.h.oracle.query("SELECT physical_source_rows::int AS p, logical_source_records::int AS l, billable_source_units::int AS b, association_edges::int AS e FROM kauro.dataset_revisions WHERE revision_id = $1", [p.revisionId])).rows[0];
  const source = await sourceOf(A.agencyId, p.revisionHash);
  assert.ok(source !== null);
  assert.deepEqual([source.revisionId, source.projectId, source.revisionState, source.populations], [p.revisionId, p.projectId, "SEALED", { physicalSourceRows: sealed.p, logicalSourceRecords: sealed.l, billableSourceUnits: sealed.b, associationEdges: sealed.e }]);
  assert.ok(source.acceptedGenerations.length > 0, "the sealed manifest's generations");
  assert.equal(await sourceOf(B.agencyId, p.revisionHash), null, "another agency's revision is not visible");
  assert.equal(await sourceOf(A.agencyId, sha("no-such-revision")), null);

  const plan = (await w.h.oracle.query("SELECT body FROM kauro.plans WHERE plan_id = $1", [p.planId])).rows[0];
  const body = plan.body as PlanBody;
  const seen: Array<{ readonly billable: number | undefined; readonly generations: unknown }> = [];
  let readBytes = false;
  const validate: ValidatePort = {
    async validate(request) {
      const reader = request.controls?.source;
      assert.ok(reader instanceof GenerationSourceReader, "the core is handed the sealed generations' reader");
      await assert.rejects(reader.open({ objectName: "outside", generation: "1" }), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "OUTSIDE_CAPABILITY");
      seen.push({ billable: request.controls?.billableSourceUnits, generations: reader.capability.acceptedGenerations });
      if (readBytes) {
        // the harness seals rows, not bytes: a read of a sealed generation the storage does not hold fails the source's integrity
        const g = source.acceptedGenerations[0]!;
        for await (const _chunk of (await reader.open({ objectName: g.objectName, generation: g.generation })).read()) void _chunk;
      }
      return { evidenceClass: "SIMULATED", outcome: "ERROR", receipt: null, problems: ["recorded"] };
    },
  };
  const validator = new PlanValidator({ validate, receipts: w.receipts, corePackageHash: sha("rc-src-core"), limits: TEST_LIMITS, storage: w.storage, scratchRoot: w.scratchRoot });
  const run = (s: ValidationSource | null) =>
    validator.run({
      subject: { agencyId: A.agencyId, planId: p.planId, planHash: planBodyHashOf(body), revisionHash: p.revisionHash, targetContractHash: sha("rc-src-target") },
      body,
      receiptId: ids.next() as ValidationReceiptId,
      startedAt: w.now(),
      cancellation: { check: () => Promise.resolve("CONTINUE" as const) },
      source: s,
      completedAt: () => Promise.resolve(w.now()),
    });
  const first = await run(source);
  assert.deepEqual(first, { kind: "CONTRACT_FAILURE", reason: "VALIDATOR_ERROR", evidenceClass: "SIMULATED" }, "the recording core answers ERROR");
  assert.deepEqual(seen, [{ billable: sealed.b, generations: source.acceptedGenerations.map((g) => ({ objectName: g.objectName, generation: g.generation, sha256: g.sha256, byteLength: g.byteLength })) }], "exactly the sealed generations and the frozen billable units");
  readBytes = true;
  assert.deepEqual(await run(source), { kind: "CONTRACT_FAILURE", reason: "SOURCE_INTEGRITY_FAILED", evidenceClass: "EXECUTED_LOCAL" }, "a sealed generation the storage cannot give back");
  seen.length = 1;
  for (const bad of [null, { ...source, populations: null }, { ...source, revisionState: "READY_TO_SEAL" }, { ...source, acceptedGenerations: [] }]) {
    assert.deepEqual(await run(bad), { kind: "CONTRACT_FAILURE", reason: "VALIDATION_SOURCE_UNAVAILABLE", evidenceClass: "EXECUTED_LOCAL" });
  }
  assert.equal(seen.length, 1, "no core call without the sealed source");
  await w.quiesce();
});

// CMD040 SubmitStageReceipt — POST /api/v1/projects/{projectId}/import-stages/{stageId}/receipts — AGENCY_OPERATOR, and CMD041 ContinueStage —
// POST /api/v1/projects/{projectId}/import-stages/{stageId}/continue — AGENCY_APPROVER (package B17; registry cases CMD040-OK / -DENY / -RACE and
// CMD041-OK / -DENY / -RACE, gate G-VENDOR). Real routes, adapters and oracle. A stage is the stage compiler's row (B08; a fixture writes it
// through the owner's oracle connection, as no request role may); a receipt is data an agency member stored for the stage's project and target
// instance. CMD040 validates it against the stage's exact membership, CMD041 records the approver's continuation of exactly that validated
// identity mapping. The digest oracle below is written from the preimage rules (HASHING_AND_ACCOUNTING_RULES: closed wrapper under the canonical
// profile), not from the product function under test. Since B17 L1 (R2-024) every receipt row carries the KAURO_STAGE_CORRELATION_V1 key
// of its stage, package and source identity (the oracle below); bytes the stage already holds are idempotent (R2-025), a differing receipt
// for a finalized stage opens a reconciliation instead of overwriting it, and an unverified parent is refused at CMD040 already (R2-023).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ImportStageView } from "@kauro/application";
import { canonicalBytes } from "@kauro/contracts";
import { toUtcInstant, type ProjectId } from "@kauro/domain";
import { serverNow } from "@kauro/persistence/testing";
import { approveThroughRoute, call, completed, freshKey, ids, outcome, sha, world, type Person, type Reply, type World } from "./support.js";

/** While set, every api unit of work opens with kauro.server_now() at this instant (transaction-local offset of the TEST CLOCK). */
let stand: string | null = null;
function standing<F extends object>(inner: F): F {
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if ((prop === "run" || prop === "runSource") && typeof value === "function") {
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: unknown) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(
            target,
            context,
            async (uow: unknown) => {
              const at = stand;
              if (at !== null) {
                await (uow as { readonly client: { query(text: string, values: unknown[]): Promise<unknown> } }).client.query(
                  "SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)",
                  [at],
                );
              }
              return work(uow);
            },
            options,
          );
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let w: World;
before(async () => {
  w = await world({ wrapUnitOfWork: standing });
});
after(async () => {
  await w.stop();
});

const receiptUrl = (projectId: string, stageId: string): string => `/api/v1/projects/${projectId}/import-stages/${stageId}/receipts`;
const continueUrl = (projectId: string, stageId: string): string => `/api/v1/projects/${projectId}/import-stages/${stageId}/continue`;

type StageState = "RELEASED" | "AWAITING_AGENCY_IMPORT" | "RECEIPT_VALIDATING" | "VERIFIED_SUCCESS" | "VERIFIED_PARTIAL" | "NEEDS_CORRECTION" | "CANCELLED" | "EXPIRED";

interface Row {
  readonly sourceId: string;
  readonly status: "MATCHED" | "FAILED";
  readonly targetId?: string;
  readonly correlationKey?: string;
}
interface Stage {
  readonly stageId: string;
  readonly packageHash: string;
}
const matched = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ sourceId: `src-${i + 1}`, status: "MATCHED" as const, targetId: `crm-${i + 1}` }));
const SOURCES = ["src-1", "src-2", "src-3", "src-4"];

/** The instant `offsetMs` from the database's clock (a fixture never reads the process clock). */
async function dbInstant(offsetMs: number): Promise<string> {
  return toUtcInstant(Date.parse(await serverNow(w.h.oracle)) + offsetMs);
}

/** KAURO_STAGE_IDENTITY_MAPPING_V1 from the rules: sha256 over the canonical bytes of {domain, version, payload}. */
function mappingOracle(stageId: string, instanceId: string, packageHash: string, mapping: ReadonlyArray<Record<string, string>>): string {
  return createHash("sha256").update(canonicalBytes({ domain: "KAURO_STAGE_IDENTITY_MAPPING_V1", version: 1, payload: { stageId, instanceId, sourcePackageHash: packageHash, mapping } })).digest("hex");
}

/** KAURO_STAGE_CORRELATION_V1 from the rules: the key a receipt row carries back for its stage, package and source identity (R2-024). */
function correlation(stageId: string, packageHash: string, sourceId: string): string {
  return createHash("sha256").update(canonicalBytes({ domain: "KAURO_STAGE_CORRELATION_V1", version: 1, payload: { stageId, packageHash, sourceId } })).digest("hex");
}
/** The rows keyed for `stage`, as the agency's importer returns them. */
const keyed = (stage: Stage, rows: ReadonlyArray<Row>): Row[] => rows.map((r) => ({ ...r, correlationKey: correlation(stage.stageId, stage.packageHash, r.sourceId) }));

interface Context {
  readonly projectId: ProjectId;
  readonly planId: string;
  readonly instanceId: string;
}

/** A clean project with a confirmed target contract and a plan approved through the real CMD025 route. */
async function approvedContext(seed: string): Promise<Context> {
  const projectId = (await w.project(w.A, w.clientA)).projectId;
  const plan = await w.approvable(w.A, projectId, seed);
  await approveThroughRoute(w, plan);
  const target = await w.row<{ instance_id: string }>("target_contracts", "project_id = $1", [projectId]);
  assert.ok(target);
  return { projectId, planId: plan.planId, instanceId: target.instance_id };
}

interface StageOptions {
  readonly state?: StageState;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly parents?: ReadonlyArray<string>;
  readonly expiresOffsetMs?: number;
  readonly instanceId?: string;
  readonly planId?: string;
  readonly agencyId?: string;
}

/** A stage row as the stage compiler leaves it, written by the owner's oracle connection (the request role has no INSERT on stages). */
async function seedStage(c: Context, o: StageOptions = {}): Promise<{ readonly stageId: string; readonly packageHash: string }> {
  const stageId = ids.next();
  const packageHash = sha(`package-${stageId}`);
  await w.h.oracle.query(
    `INSERT INTO kauro.import_stages (stage_id, agency_id, project_id, plan_id, sequence, object_api_name, operation, state, parent_stage_ids, package_hash, receipt_required, expires_at, instance_id, source_ids)
     VALUES ($1, $2, $3, $4, 1, 'Contact', 'CREATE_ONLY', $5, $6::jsonb, $7, true, $8, $9, $10::jsonb)`,
    [
      stageId,
      o.agencyId ?? w.A.agencyId,
      c.projectId,
      o.planId ?? c.planId,
      o.state ?? "AWAITING_AGENCY_IMPORT",
      JSON.stringify(o.parents ?? []),
      packageHash,
      await dbInstant(o.expiresOffsetMs ?? 7 * 86_400_000),
      o.instanceId ?? c.instanceId,
      JSON.stringify(o.sourceIds ?? SOURCES),
    ],
  );
  return { stageId, packageHash };
}

interface UploadOptions {
  readonly kind?: "METADATA" | "CONFIRMATION_EVIDENCE" | "STAGE_RECEIPT";
  readonly instanceId?: string;
  readonly document?: Record<string, unknown>;
  readonly projectId?: string;
  /** The stage whose correlation keys the rows carry (none: the rows as given). */
  readonly stage?: Stage;
}

/** A receipt upload stored through the tenant role (RLS and the insert grant apply), as an agency member would. */
async function storeUpload(c: Context, rows: ReadonlyArray<Row> | null, o: UploadOptions = {}): Promise<{ readonly artifactRef: string; readonly contentHash: string }> {
  const artifactRef = ids.next();
  const document = o.document ?? { rows: o.stage === undefined ? (rows ?? []) : keyed(o.stage, rows ?? []) };
  const contentHash = sha(JSON.stringify(document) + artifactRef);
  await w.asTenant(w.A, (conn) =>
    conn.query(
      "INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) VALUES ($1, $2, $3, $4, 'CLEAN', $5, $6::jsonb, $7, $8)",
      [artifactRef, w.A.agencyId, o.projectId ?? c.projectId, o.kind ?? "STAGE_RECEIPT", o.instanceId ?? c.instanceId, JSON.stringify(document), contentHash, w.A.ownerMembershipId],
    ),
  );
  return { artifactRef, contentHash };
}

function submit(projectId: string, stageId: string, body: Record<string, unknown>, who: Person = w.operator, key: string = freshKey("cmd040")): Promise<Reply> {
  return call(w, { url: receiptUrl(projectId, stageId), token: who.token, key, body });
}
function proceed(projectId: string, stageId: string, body: Record<string, unknown>, who: Person = w.approver, key: string = freshKey("cmd041")): Promise<Reply> {
  return call(w, { url: continueUrl(projectId, stageId), token: who.token, key, body });
}

interface StageRow extends Record<string, unknown> {
  state: string;
  version: number;
  continued_at: Date | null;
  continued_by_membership_id: string | null;
  continuation_receipt_hash: string | null;
}
const stageRow = (id: string): Promise<StageRow | null> => w.row<StageRow>("import_stages", "stage_id = $1", [id]);
const receiptCount = (stageId: string): Promise<number> => w.count("stage_receipts", "stage_id = $1", [stageId]);

/** Submits a receipt through the real CMD040 route and returns the stage view. */
async function submitThroughRoute(c: Context, stage: { readonly stageId: string; readonly packageHash: string }, rows: ReadonlyArray<Row>): Promise<ImportStageView> {
  const upload = await storeUpload(c, rows, { stage });
  return completed<ImportStageView>(await submit(c.projectId, stage.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: stage.packageHash }), 200).data;
}

const FAILED_ONE: Row[] = [...matched(3), { sourceId: "src-4", status: "FAILED" }];

test("CMD040-OK: an OPERATOR submits a complete receipt; the exact membership is validated, the stage is VERIFIED_SUCCESS and the identity mapping digest equals the independent oracle", async () => {
  const c = await approvedContext("cmd040-ok");
  const stage = await seedStage(c);
  const upload = await storeUpload(c, matched(4), { stage });
  const key = freshKey("cmd040-ok");
  const done = completed<ImportStageView>(await submit(c.projectId, stage.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: stage.packageHash }, w.operator, key), 200);
  assert.equal(done.version, 2);
  assert.equal(done.replayed, false);
  const view = done.data;
  assert.deepEqual([view.state, view.version, view.receiptRevision, view.receiptResult, view.matchedRows, view.failedRows, view.unresolvedRows], ["VERIFIED_SUCCESS", 2, 1, "COMPLETE", 4, 0, 0]);
  assert.deepEqual(view.permittedActions, [], "an OPERATOR cannot continue");
  assert.ok(!("sourceIds" in view) && !("mapping" in view), "the membership and the mapping never reach the view");

  const mapping = [1, 2, 3, 4].map((n) => ({ sourceId: `src-${n}`, disposition: "MATCHED", targetId: `crm-${n}` }));
  const expected = mappingOracle(stage.stageId, c.instanceId, stage.packageHash, mapping);
  assert.equal(view.identityMappingHash, expected);
  const receipt = await w.row<{ identity_mapping_hash: string; receipt_file_hash: string; revision: number; validator_version: string; submitted_by_membership_id: string; validated_at: Date }>("stage_receipts", "stage_id = $1", [stage.stageId]);
  assert.ok(receipt);
  assert.deepEqual([receipt.identity_mapping_hash, receipt.receipt_file_hash, receipt.revision, receipt.submitted_by_membership_id], [expected, upload.contentHash, 1, w.memberships.operator]);
  assert.ok(receipt.validated_at instanceof Date);
  const row = await stageRow(stage.stageId);
  assert.deepEqual([row?.state, row?.version, row?.continued_at], ["VERIFIED_SUCCESS", 2, null]);

  // the same key again is the same answer, not another revision
  const replay = completed<ImportStageView>(await submit(c.projectId, stage.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: stage.packageHash }, w.operator, key), 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.identityMappingHash, expected);
  assert.equal(await receiptCount(stage.stageId), 1);
});

test("CMD040-OK: failed rows are accounted and the stage awaits the approver; missing, duplicated and shared-target identities are unresolved and need a correction, which is a new revision beside the old", async () => {
  const c = await approvedContext("cmd040-ok-partial");
  const partial = await seedStage(c);
  const pv = await submitThroughRoute(c, partial, FAILED_ONE);
  assert.deepEqual([pv.state, pv.receiptResult, pv.matchedRows, pv.failedRows, pv.unresolvedRows], ["RECEIPT_VALIDATING", "PARTIAL_ACCOUNTED", 3, 1, 0]);

  const stage = await seedStage(c);
  const ambiguous: Row[] = [
    { sourceId: "src-1", status: "MATCHED", targetId: "crm-1" },
    { sourceId: "src-2", status: "MATCHED", targetId: "crm-2" },
    { sourceId: "src-2", status: "MATCHED", targetId: "crm-2b" }, // named twice: ambiguous
    { sourceId: "src-3", status: "MATCHED", targetId: "crm-shared" },
    // src-4 is missing; src-3 and src-5... share a target below
  ];
  const first = await submitThroughRoute(c, stage, [...ambiguous, { sourceId: "src-4", status: "MATCHED", targetId: "crm-shared" }]);
  assert.deepEqual([first.state, first.receiptResult, first.receiptRevision, first.matchedRows, first.failedRows, first.unresolvedRows], ["NEEDS_CORRECTION", "NEEDS_CORRECTION", 1, 1, 0, 3]);
  const stored = await w.row<{ mapping: Array<{ sourceId: string; disposition: string }> }>("stage_receipts", "stage_id = $1", [stage.stageId]);
  assert.deepEqual(stored?.mapping.map((m) => `${m.sourceId}:${m.disposition}`), ["src-1:MATCHED", "src-2:UNRESOLVED", "src-3:UNRESOLVED", "src-4:UNRESOLVED"], "valid mappings are preserved, ambiguous ones are never guessed");

  // a corrected receipt is admitted as a versioned reconciliation: revision 2, the first row stays
  const corrected = await submitThroughRoute(c, stage, matched(4));
  assert.deepEqual([corrected.state, corrected.receiptRevision, corrected.receiptResult, corrected.version], ["VERIFIED_SUCCESS", 2, "COMPLETE", 3]);
  assert.equal(await receiptCount(stage.stageId), 2);
});

test("CMD040-DENY: a VIEWER, an APPROVER and a non-member are refused; a foreign stage, wrong project, foreign or wrong-kind upload, other instance or package, invalid, foreign-stage or foreign-ID receipt, a cancelled or expired stage and an unknown field write nothing; reused bytes and a settled stage write no revision", async () => {
  const c = await approvedContext("cmd040-deny");
  const stage = await seedStage(c);
  const upload = await storeUpload(c, matched(4), { stage });
  const good = { receiptUploadRef: upload.artifactRef, sourcePackageHash: stage.packageHash };
  const unchanged = async (): Promise<void> => {
    const row = await stageRow(stage.stageId);
    assert.deepEqual([row?.state, row?.version], ["AWAITING_AGENCY_IMPORT", 1]);
    assert.equal(await receiptCount(stage.stageId), 0, "a refused request wrote nothing");
  };

  // wrong role, a non-member, the closed request
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, good, w.viewer)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, good, w.approver)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, good, w.stranger)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { ...good, verified: true })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { sourcePackageHash: stage.packageHash })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  // an unknown stage, the stage under another project, a stage of another agency: answered as one that does not exist
  assert.equal(outcome(w, await submit(c.projectId, ids.next(), good)), "404 NOT_FOUND -");
  const other = await approvedContext("cmd040-deny-other");
  assert.equal(outcome(w, await submit(other.projectId, stage.stageId, good)), "404 NOT_FOUND -");
  const foreignProject = (await w.project(w.B, w.clientB)).projectId;
  assert.equal(outcome(w, await submit(foreignProject, stage.stageId, good)), "404 NOT_FOUND -");

  // the upload: unknown, another project's, the wrong kind
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { ...good, receiptUploadRef: ids.next() })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const ofOther = await storeUpload(other, matched(4));
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { ...good, receiptUploadRef: ofOther.artifactRef })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const wrongKind = await storeUpload(c, matched(4), { kind: "CONFIRMATION_EVIDENCE" });
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { ...good, receiptUploadRef: wrongKind.artifactRef })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  // the instance and the package
  const otherInstance = await storeUpload(c, matched(4), { instanceId: ids.next() });
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { ...good, receiptUploadRef: otherInstance.artifactRef })), "409 PRECONDITION_FAILED RECEIPT_INSTANCE_MISMATCH");
  assert.equal(outcome(w, await submit(c.projectId, stage.stageId, { ...good, sourcePackageHash: sha("another package") })), "409 PRECONDITION_FAILED RECEIPT_PACKAGE_MISMATCH");
  // the document is data in a closed shape; the membership is exact
  const invalid = async (document: Record<string, unknown>): Promise<string> => {
    const u = await storeUpload(c, null, { document });
    return outcome(w, await submit(c.projectId, stage.stageId, { ...good, receiptUploadRef: u.artifactRef }));
  };
  const key1 = correlation(stage.stageId, stage.packageHash, "src-1");
  assert.equal(await invalid({ rows: keyed(stage, matched(4)), verified: true }), "400 INVALID_REQUEST RECEIPT_INVALID");
  assert.equal(await invalid({ rows: [{ sourceId: "src-1", status: "MATCHED", correlationKey: key1 }] }), "400 INVALID_REQUEST RECEIPT_INVALID", "a match without its target identity");
  assert.equal(await invalid({ rows: [{ sourceId: "src-1", status: "FAILED", targetId: "crm-1", correlationKey: key1 }] }), "400 INVALID_REQUEST RECEIPT_INVALID", "a failure that names a target identity");
  assert.equal(await invalid({ rows: [{ sourceId: "src-1", status: "MATCHED", targetId: "crm-1", correlationKey: key1, extra: 1 }] }), "400 INVALID_REQUEST RECEIPT_INVALID");
  assert.equal(await invalid({ rows: "src-1" }), "400 INVALID_REQUEST RECEIPT_INVALID");
  assert.equal(await invalid({ rows: matched(4) }), "400 INVALID_REQUEST RECEIPT_INVALID", "rows without their correlation keys");
  assert.equal(await invalid({ rows: keyed(stage, [...matched(4), { sourceId: "src-99", status: "MATCHED", targetId: "crm-99" }]) }), "409 PRECONDITION_FAILED RECEIPT_FOREIGN_IDS");
  // a receipt produced for another stage, the same rows and package claimed: never this stage's evidence (R2-024)
  const elsewhere = await seedStage(c);
  assert.equal(await invalid({ rows: keyed({ stageId: elsewhere.stageId, packageHash: stage.packageHash }, matched(4)) }), "409 PRECONDITION_FAILED RECEIPT_FOREIGN_STAGE");
  await unchanged();

  // a settled stage: a differing receipt opens one reconciliation request, never a revision (R2-025); the same bytes again are that request
  const settled = await seedStage(c, { state: "VERIFIED_SUCCESS" });
  const forSettled = await storeUpload(c, matched(4), { stage: settled });
  const reconciled = completed<ImportStageView>(await submit(c.projectId, settled.stageId, { receiptUploadRef: forSettled.artifactRef, sourcePackageHash: settled.packageHash }), 200).data;
  assert.deepEqual([reconciled.state, reconciled.version, reconciled.reconciliation?.state, reconciled.reconciliation?.contentHash], ["VERIFIED_SUCCESS", 1, "OPEN", forSettled.contentHash]);
  const again = completed<ImportStageView>(await submit(c.projectId, settled.stageId, { receiptUploadRef: forSettled.artifactRef, sourcePackageHash: settled.packageHash }), 200).data;
  assert.equal(again.reconciliation?.reconciliationId, reconciled.reconciliation?.reconciliationId, "the same bytes under another key are the same request");
  assert.equal(await w.count("stage_receipt_reconciliations", "stage_id = $1", [settled.stageId]), 1);
  const cancelled = await seedStage(c, { state: "CANCELLED" });
  assert.equal(outcome(w, await submit(c.projectId, cancelled.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: cancelled.packageHash })), "409 PRECONDITION_FAILED STAGE_NOT_AWAITING_RECEIPT");
  const lapsed = await seedStage(c, { expiresOffsetMs: -60_000 });
  assert.equal(outcome(w, await submit(c.projectId, lapsed.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: lapsed.packageHash })), "409 PRECONDITION_FAILED STAGE_EXPIRED", "past its bounded deadline on the database clock");
  const expired = await seedStage(c, { state: "EXPIRED" });
  assert.equal(outcome(w, await submit(c.projectId, expired.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: expired.packageHash })), "409 PRECONDITION_FAILED STAGE_EXPIRED", "no old receipt resurrects an expired stage");
  for (const s of [settled, cancelled, lapsed, expired]) assert.equal(await receiptCount(s.stageId), 0);

  // the same bytes again are not new evidence: the resubmission of a NEEDS_CORRECTION stage answers the revision they already are (R2-025)
  const retry = await seedStage(c);
  const bad = await storeUpload(c, [{ sourceId: "src-1", status: "MATCHED", targetId: "crm-1" }], { stage: retry });
  completed<ImportStageView>(await submit(c.projectId, retry.stageId, { receiptUploadRef: bad.artifactRef, sourcePackageHash: retry.packageHash }), 200);
  assert.equal((await stageRow(retry.stageId))?.state, "NEEDS_CORRECTION");
  const reused = completed<ImportStageView>(await submit(c.projectId, retry.stageId, { receiptUploadRef: bad.artifactRef, sourcePackageHash: retry.packageHash }), 200).data;
  assert.deepEqual([reused.state, reused.version, reused.receiptRevision], ["NEEDS_CORRECTION", 2, 1]);
  assert.equal(await receiptCount(retry.stageId), 1);
});

test("CMD040-RACE: the same key replays one revision, the same key with another request conflicts, and two receipts racing on one stage yield one revision and one reconciliation (a stage awaiting the approver is told it is no longer awaiting)", async () => {
  const c = await approvedContext("cmd040-race");
  const stage = await seedStage(c);
  const a = await storeUpload(c, matched(4), { stage });
  const b = await storeUpload(c, matched(4), { stage });

  // same key, another request: nothing is executed again
  const lone = await seedStage(c);
  const u1 = await storeUpload(c, matched(4), { stage: lone });
  const u2 = await storeUpload(c, matched(4), { stage: lone });
  const key = freshKey("cmd040-race");
  completed<ImportStageView>(await submit(c.projectId, lone.stageId, { receiptUploadRef: u1.artifactRef, sourcePackageHash: lone.packageHash }, w.operator, key), 200);
  assert.equal(outcome(w, await submit(c.projectId, lone.stageId, { receiptUploadRef: u2.artifactRef, sourcePackageHash: lone.packageHash }, w.operator, key)), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await receiptCount(lone.stageId), 1);

  // two keys, two receipts, one stage: exactly one revision; the other bytes become the one reconciliation, the repeated bytes are idempotent
  const replies = await Promise.all([
    submit(c.projectId, stage.stageId, { receiptUploadRef: a.artifactRef, sourcePackageHash: stage.packageHash }),
    submit(c.projectId, stage.stageId, { receiptUploadRef: b.artifactRef, sourcePackageHash: stage.packageHash }),
    submit(c.projectId, stage.stageId, { receiptUploadRef: a.artifactRef, sourcePackageHash: stage.packageHash }),
  ]);
  assert.equal(await receiptCount(stage.stageId), 1, "no duplicate authority");
  assert.equal(await w.count("stage_receipt_reconciliations", "stage_id = $1", [stage.stageId]), 1, "the differing bytes are one reconciliation request");
  assert.deepEqual(replies.map((r) => (r.status === 200 ? "200" : outcome(w, r))), ["200", "200", "200"]);
  assert.equal((await stageRow(stage.stageId))?.version, 2);

  // a stage awaiting the approver's partial scope takes no other receipt, and the refusal says where it stands
  const pending = await seedStage(c);
  await submitThroughRoute(c, pending, FAILED_ONE);
  const other = await storeUpload(c, matched(4), { stage: pending });
  const later = await submit(c.projectId, pending.stageId, { receiptUploadRef: other.artifactRef, sourcePackageHash: pending.packageHash });
  assert.equal(outcome(w, later), "409 PRECONDITION_FAILED STAGE_NOT_AWAITING_RECEIPT");
  const problem = later.json<{ current?: { version: number; state: string } }>();
  assert.deepEqual([problem.current?.version, problem.current?.state], [2, "RECEIPT_VALIDATING"]);
  assert.equal(await receiptCount(pending.stageId), 1);
});

/** A verified stage (through the real CMD040 route) whose parent is verified and whose plan is approved. */
async function readyStage(label: string, rows: ReadonlyArray<Row> = matched(4)): Promise<{ readonly c: Context; readonly stage: { stageId: string; packageHash: string }; readonly view: ImportStageView }> {
  const c = await approvedContext(label);
  const parent = await seedStage(c, { state: "VERIFIED_SUCCESS" });
  const stage = await seedStage(c, { parents: [parent.stageId] });
  const view = await submitThroughRoute(c, stage, rows);
  return { c, stage, view };
}

test("CMD041-OK: an APPROVER continues a verified stage from the exact validated mapping; the continuation is recorded once with the approver and the digest, and a partial scope is accounted as VERIFIED_PARTIAL", async () => {
  const { c, stage, view } = await readyStage("cmd041-ok");
  assert.equal(view.state, "VERIFIED_SUCCESS");
  assert.deepEqual(view.permittedActions, [], "the OPERATOR who submitted it cannot continue");
  const key = freshKey("cmd041-ok");
  const done = completed<ImportStageView>(await proceed(c.projectId, stage.stageId, { expectedVersion: view.version, validatedReceiptHash: view.identityMappingHash }, w.approver, key), 200);
  assert.equal(done.version, 3);
  assert.equal(done.replayed, false);
  assert.deepEqual([done.data.state, done.data.version, done.data.permittedActions], ["VERIFIED_SUCCESS", 3, []]);
  assert.ok(done.data.continuedAt);
  const row = await stageRow(stage.stageId);
  assert.deepEqual([row?.state, row?.version, row?.continued_by_membership_id, row?.continuation_receipt_hash], ["VERIFIED_SUCCESS", 3, w.memberships.approver, view.identityMappingHash]);
  assert.ok(row?.continued_at instanceof Date);
  const replay = completed<ImportStageView>(await proceed(c.projectId, stage.stageId, { expectedVersion: view.version, validatedReceiptHash: view.identityMappingHash }, w.approver, key), 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.continuedAt, done.data.continuedAt);

  // a fully accounted partial receipt awaits the approver: the continuation approves the partial scope
  const partial = await readyStage("cmd041-ok-partial", FAILED_ONE);
  assert.equal(partial.view.state, "RECEIPT_VALIDATING");
  assert.deepEqual(partial.view.permittedActions, [], "an OPERATOR cannot approve the partial scope");
  const approved = completed<ImportStageView>(await proceed(partial.c.projectId, partial.stage.stageId, { expectedVersion: partial.view.version, validatedReceiptHash: partial.view.identityMappingHash }), 200);
  assert.deepEqual([approved.data.state, approved.data.failedRows, approved.data.version], ["VERIFIED_PARTIAL", 1, 3]);
  assert.equal((await stageRow(partial.stage.stageId))?.state, "VERIFIED_PARTIAL");
});

test("CMD041-DENY: an OPERATOR, a VIEWER and a non-member are refused; a stale version or digest, a stage that is not verified, an expired workflow, an unverified parent, an unapproved plan, a mismatched target and a tampered mapping are refused and nothing is continued", async () => {
  const { c, stage, view } = await readyStage("cmd041-deny");
  const good = { expectedVersion: view.version, validatedReceiptHash: view.identityMappingHash };
  const notContinued = async (id: string): Promise<void> => {
    const row = await stageRow(id);
    assert.deepEqual([row?.continued_at, row?.continued_by_membership_id, row?.continuation_receipt_hash], [null, null, null]);
  };

  assert.equal(outcome(w, await proceed(c.projectId, stage.stageId, good, w.operator)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await proceed(c.projectId, stage.stageId, good, w.viewer)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await proceed(c.projectId, stage.stageId, good, w.stranger)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await proceed(c.projectId, stage.stageId, { ...good, verified: true })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await proceed(c.projectId, ids.next(), good)), "404 NOT_FOUND -");
  const other = await approvedContext("cmd041-deny-other");
  assert.equal(outcome(w, await proceed(other.projectId, stage.stageId, good)), "404 NOT_FOUND -");

  // a stale version and a digest that is not the stage's validated mapping
  assert.equal(outcome(w, await proceed(c.projectId, stage.stageId, { ...good, expectedVersion: view.version + 1 })), "409 STALE_VERSION -");
  assert.equal(outcome(w, await proceed(c.projectId, stage.stageId, { ...good, validatedReceiptHash: sha("other identities") })), "409 STALE_VERSION -");
  await notContinued(stage.stageId);

  // a stage that is not verified: awaiting, needing a correction, cancelled; one with no receipt at all
  for (const state of ["AWAITING_AGENCY_IMPORT", "NEEDS_CORRECTION", "CANCELLED"] as const) {
    const s = await seedStage(c, { state });
    assert.equal(outcome(w, await proceed(c.projectId, s.stageId, { expectedVersion: 1, validatedReceiptHash: view.identityMappingHash })), "409 PRECONDITION_FAILED STAGE_NOT_CONTINUABLE", state);
    await notContinued(s.stageId);
  }
  const noReceipt = await seedStage(c, { state: "VERIFIED_SUCCESS" });
  assert.equal(outcome(w, await proceed(c.projectId, noReceipt.stageId, { expectedVersion: 1, validatedReceiptHash: view.identityMappingHash })), "409 STALE_VERSION -", "a verified stage with no validated receipt continues nothing");

  // an expired workflow needs explicit recovery, never guessed identities
  const lapsed = await seedStage(c, { state: "VERIFIED_SUCCESS", expiresOffsetMs: -60_000 });
  assert.equal(outcome(w, await proceed(c.projectId, lapsed.stageId, { expectedVersion: 1, validatedReceiptHash: view.identityMappingHash })), "409 PRECONDITION_FAILED STAGE_EXPIRED");
  await notContinued(lapsed.stageId);

  // a required parent that is not verified and a parent that does not exist are refused at the receipt already (R2-023, CMD040); a parent
  // whose deadline passes after the child's receipt is refused at the continuation (the TEST CLOCK stands past it)
  const unverifiedParent = await seedStage(c, { state: "AWAITING_AGENCY_IMPORT" });
  const childOfUnverified = await seedStage(c, { parents: [unverifiedParent.stageId] });
  const cu = await storeUpload(c, matched(4), { stage: childOfUnverified });
  assert.equal(outcome(w, await submit(c.projectId, childOfUnverified.stageId, { receiptUploadRef: cu.artifactRef, sourcePackageHash: childOfUnverified.packageHash })), "409 PRECONDITION_FAILED PARENT_STAGE_NOT_VERIFIED");
  const orphan = await seedStage(c, { parents: [ids.next()] });
  const ou = await storeUpload(c, matched(4), { stage: orphan });
  assert.equal(outcome(w, await submit(c.projectId, orphan.stageId, { receiptUploadRef: ou.artifactRef, sourcePackageHash: orphan.packageHash })), "409 PRECONDITION_FAILED PARENT_STAGE_NOT_VERIFIED");
  for (const s of [childOfUnverified, orphan]) assert.equal(await receiptCount(s.stageId), 0);
  const lapsingParent = await seedStage(c, { state: "VERIFIED_SUCCESS", expiresOffsetMs: 3_600_000 });
  const childOfLapsing = await seedStage(c, { parents: [lapsingParent.stageId] });
  const lv = await submitThroughRoute(c, childOfLapsing, matched(4));
  stand = await dbInstant(2 * 3_600_000);
  try {
    assert.equal(outcome(w, await proceed(c.projectId, childOfLapsing.stageId, { expectedVersion: lv.version, validatedReceiptHash: lv.identityMappingHash })), "409 PRECONDITION_FAILED PARENT_STAGE_NOT_VERIFIED");
  } finally {
    stand = null;
  }

  const foreignTarget = ids.next();
  const mismatched = await seedStage(c, { instanceId: foreignTarget });
  const upload = await storeUpload(c, matched(4), { instanceId: foreignTarget, stage: mismatched });
  const mv = completed<ImportStageView>(await submit(c.projectId, mismatched.stageId, { receiptUploadRef: upload.artifactRef, sourcePackageHash: mismatched.packageHash }), 200).data;
  assert.equal(outcome(w, await proceed(c.projectId, mismatched.stageId, { expectedVersion: mv.version, validatedReceiptHash: mv.identityMappingHash })), "409 PRECONDITION_FAILED STAGE_TARGET_MISMATCH");
  // a second approvable plan confirms a newer target contract of the project (R2-026): it is the last check of the project's plan here
  const unapprovedPlan = await w.approvable(w.A, c.projectId, "cmd041-deny-unapproved");
  const planless = await seedStage(c, { planId: unapprovedPlan.planId });
  const pv = await submitThroughRoute(c, planless, matched(4));
  assert.equal(outcome(w, await proceed(c.projectId, planless.stageId, { expectedVersion: pv.version, validatedReceiptHash: pv.identityMappingHash })), "409 PRECONDITION_FAILED CHILD_PLAN_NOT_APPROVED");

  for (const s of [childOfUnverified, orphan, childOfLapsing, planless, mismatched]) await notContinued(s.stageId);

  // the stored mapping changed under its digest: only a replica-role superuser can simulate it (the table is append-only for every writer)
  const tampered = await readyStage("cmd041-deny-tampered");
  await w.h.oracle.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE kauro.stage_receipts SET mapping = jsonb_set(mapping, '{0,targetId}', '"crm-forged"') WHERE stage_id = '${tampered.stage.stageId}'; COMMIT;`);
  assert.equal(
    outcome(w, await proceed(tampered.c.projectId, tampered.stage.stageId, { expectedVersion: tampered.view.version, validatedReceiptHash: tampered.view.identityMappingHash })),
    "422 INTEGRITY_FAILURE RECEIPT_DIGEST_MISMATCH",
  );
  await notContinued(tampered.stage.stageId);
});

test("CMD041-RACE: two approvers continuing one stage yield one continuation (the loser is told it was continued), the same key replays, the same key with another digest conflicts, and a receipt racing a continuation never replaces the continued mapping", async () => {
  const { c, stage, view } = await readyStage("cmd041-race");
  const body = { expectedVersion: view.version, validatedReceiptHash: view.identityMappingHash };
  const replies = await Promise.all([proceed(c.projectId, stage.stageId, body, w.approver), proceed(c.projectId, stage.stageId, body, w.approver2), proceed(c.projectId, stage.stageId, body, w.owner)]);
  const outcomes = replies.map((r) => (r.status === 200 ? "200" : outcome(w, r))).sort();
  assert.deepEqual(outcomes, ["200", "409 PRECONDITION_FAILED STAGE_ALREADY_CONTINUED", "409 PRECONDITION_FAILED STAGE_ALREADY_CONTINUED"]);
  assert.equal((await stageRow(stage.stageId))?.version, 3, "exactly one continuation");

  // the loser is told where the stage stands; a later request at the old version still is
  const later = await proceed(c.projectId, stage.stageId, body);
  assert.equal(outcome(w, later), "409 PRECONDITION_FAILED STAGE_ALREADY_CONTINUED");
  const problem = later.json<{ current?: { version: number; state: string } }>();
  assert.deepEqual([problem.current?.version, problem.current?.state], [3, "VERIFIED_SUCCESS"]);

  // idempotency: same key and request replays, same key and another digest conflicts
  const second = await readyStage("cmd041-race-key");
  const key = freshKey("cmd041-race");
  const request = { expectedVersion: second.view.version, validatedReceiptHash: second.view.identityMappingHash };
  completed<ImportStageView>(await proceed(second.c.projectId, second.stage.stageId, request, w.approver, key), 200);
  assert.equal(completed<ImportStageView>(await proceed(second.c.projectId, second.stage.stageId, request, w.approver, key), 200).replayed, true);
  assert.equal(outcome(w, await proceed(second.c.projectId, second.stage.stageId, { ...request, validatedReceiptHash: sha("another") }, w.approver, key)), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

  // a correction racing the continuation of the same stage: the stage lock orders them, exactly one commits
  const c2 = await approvedContext("cmd041-race-vs-receipt");
  const partialStage = await seedStage(c2);
  const pv = await submitThroughRoute(c2, partialStage, FAILED_ONE);
  const correction = await storeUpload(c2, matched(4), { stage: partialStage });
  const raced = await Promise.all([
    proceed(c2.projectId, partialStage.stageId, { expectedVersion: pv.version, validatedReceiptHash: pv.identityMappingHash }),
    submit(c2.projectId, partialStage.stageId, { receiptUploadRef: correction.artifactRef, sourcePackageHash: partialStage.packageHash }),
  ]);
  // the forbidden effect first: the continued mapping is the one revision, never replaced; the receipt either came first (refused, the
  // stage awaits the approver) or after (a reconciliation request beside the continued identity)
  assert.equal(await receiptCount(partialStage.stageId), 1, "no revision replaces the mapping the approver continued");
  const row = await stageRow(partialStage.stageId);
  assert.deepEqual([row?.state, row?.continuation_receipt_hash], ["VERIFIED_PARTIAL", pv.identityMappingHash]);
  const reconciliations = await w.count("stage_receipt_reconciliations", "stage_id = $1", [partialStage.stageId]);
  const raceOutcomes = raced.map((r) => (r.status === 200 ? "200" : outcome(w, r)));
  assert.equal(raceOutcomes[0], "200", "the continuation commits in either order");
  assert.equal(raceOutcomes[1], reconciliations === 1 ? "200" : "409 PRECONDITION_FAILED STAGE_NOT_AWAITING_RECEIPT", `the receipt: ${raceOutcomes.join(" | ")}`);
});

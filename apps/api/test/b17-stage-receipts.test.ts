// B17 L1, T1 (docs/design/B15-B17-B18-local-plan.md sections 1, 3 row 10, 4 rows SSR and CST, 5 M1/M2): the receipt of a stage is bound to
// that stage (R2-024: every row carries the KAURO_STAGE_CORRELATION_V1 key of its stage, package and source identity), identical content is
// idempotent and a differing receipt for a finalized stage opens a reconciliation instead of overwriting its identity (R2-025), and a child
// stage binds only the identities its parents MATCHED (R2-023). Real routes over the real units of work and PostgreSQL 17; a stage is the
// stage compiler's row (written through the owner's oracle connection, as no request role may); the correlation oracle is written from the
// preimage rules, not from the product function. A RACE cell holds one actor inside its unit of work at the port call the plan names
// (instrumentPort pauses `<port>.<method>.after`, its locks taken), observes the other waiting on the holder's backend in pg_stat_activity,
// and asserts the forbidden effect first. An EXPIRY cell stands the held unit on the TEST CLOCK before the deadline (transaction-local
// kauro_test.clock_offset_seconds) and lets its effect clock run past the deadline while it is held at the plan's bold await.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ImportStageView, TargetContractView } from "@kauro/application";
import { canonicalBytes } from "@kauro/contracts";
import { toUtcInstant, type ProjectId } from "@kauro/domain";
import { FaultPoints, instrumentPort, LOCK_WAIT_POLL_ATTEMPTS, LOCK_WAIT_POLL_INTERVAL_MS, serverNow } from "@kauro/persistence/testing";
import { approveThroughRoute, call, completed, freshKey, ids, outcome, routes, sha, world, type Person, type Reply, type World } from "./support.js";

// --- the world: units of work stand on the TEST CLOCK when told, and their ports pass named fault points ----------------------------

let stand: string | null = null;
const points = new FaultPoints();
/** The backend pid of the unit that last called `<port>.<method>` (read by a cell right after the holder reached its pause). */
const pidAt = new Map<string, number>();
const PORTS = new Set(["importStages", "targetContracts", "plans", "execution", "approvals", "projects"]);

function instrumentedUnit(uow: object): object {
  const pid = (uow as { readonly client?: { readonly processID?: number } }).client?.processID;
  return new Proxy(uow, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof prop === "string" && PORTS.has(prop) && typeof value === "object" && value !== null) {
        const port = instrumentPort(value, points, prop);
        return new Proxy(port, {
          get(p, method) {
            const f: unknown = Reflect.get(p, method, p);
            if (typeof f !== "function" || typeof method !== "string") return f;
            return (...args: unknown[]) => {
              if (typeof pid === "number") pidAt.set(`${prop}.${method}`, pid);
              return (f as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function instrumented<F extends object>(inner: F): F {
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
              return work(instrumentedUnit(uow as object));
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
  w = await world({ wrapUnitOfWork: instrumented });
});
after(async () => {
  await w.stop();
});

// --- fixtures --------------------------------------------------------------------------------------------------------------------------

interface Row {
  readonly sourceId: string;
  readonly status: "MATCHED" | "FAILED";
  readonly targetId?: string;
}
interface Stage {
  readonly stageId: string;
  readonly packageHash: string;
}
interface Context {
  readonly projectId: ProjectId;
  readonly planId: string;
  readonly instanceId: string;
}
type StageState = "AWAITING_AGENCY_IMPORT" | "VERIFIED_SUCCESS";

/** KAURO_STAGE_CORRELATION_V1 from the rules: sha256 over the canonical bytes of {domain, version, payload}. */
function correlation(stageId: string, packageHash: string, sourceId: string): string {
  return createHash("sha256").update(canonicalBytes({ domain: "KAURO_STAGE_CORRELATION_V1", version: 1, payload: { stageId, packageHash, sourceId } })).digest("hex");
}
const keyed = (stage: Stage, rows: ReadonlyArray<Row>): Array<Row & { correlationKey: string }> => rows.map((r) => ({ ...r, correlationKey: correlation(stage.stageId, stage.packageHash, r.sourceId) }));
const matched = (prefix: string, from: number, to: number): Row[] => Array.from({ length: to - from + 1 }, (_, i) => ({ sourceId: `${prefix}-${from + i}`, status: "MATCHED" as const, targetId: `crm-${prefix}-${from + i}` }));
const failed = (prefix: string, from: number, to: number): Row[] => Array.from({ length: to - from + 1 }, (_, i) => ({ sourceId: `${prefix}-${from + i}`, status: "FAILED" as const }));
const sources = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

async function dbInstant(offsetMs: number): Promise<string> {
  return toUtcInstant(Date.parse(await serverNow(w.h.oracle)) + offsetMs);
}

async function approvedContext(seed: string): Promise<Context> {
  const projectId = (await w.project(w.A, w.clientA)).projectId;
  const plan = await w.approvable(w.A, projectId, seed);
  await approveThroughRoute(w, plan);
  const target = await w.row<{ instance_id: string }>("target_contracts", "project_id = $1 AND superseded_at IS NULL", [projectId]);
  assert.ok(target);
  return { projectId, planId: plan.planId, instanceId: target.instance_id };
}

interface StageOptions {
  readonly state?: StageState;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly parents?: ReadonlyArray<string>;
  readonly edges?: ReadonlyArray<{ readonly childSourceId: string; readonly parentStageId: string; readonly parentSourceId: string }>;
  readonly expiresAt?: string;
}

/** A stage row as the stage compiler leaves it, written by the owner's oracle connection. */
async function seedStage(c: Context, o: StageOptions = {}): Promise<Stage> {
  const stageId = ids.next();
  const packageHash = sha(`package-${stageId}`);
  await w.h.oracle.query(
    `INSERT INTO kauro.import_stages (stage_id, agency_id, project_id, plan_id, sequence, object_api_name, operation, state, parent_stage_ids, package_hash, receipt_required, expires_at, instance_id, source_ids, parent_edges)
     VALUES ($1, $2, $3, $4, 1, 'Contact', 'CREATE_ONLY', $5, $6::jsonb, $7, true, $8, $9, $10::jsonb, $11::jsonb)`,
    [stageId, w.A.agencyId, c.projectId, c.planId, o.state ?? "AWAITING_AGENCY_IMPORT", JSON.stringify(o.parents ?? []), packageHash, o.expiresAt ?? (await dbInstant(7 * 86_400_000)), c.instanceId, JSON.stringify(o.sourceIds ?? sources("src", 4)), JSON.stringify(o.edges ?? [])],
  );
  return { stageId, packageHash };
}

/** A receipt upload stored through the tenant role, its rows keyed for `keyedFor` (the stage it was produced for). */
async function storeReceipt(c: Context, keyedFor: Stage, rows: ReadonlyArray<Row>): Promise<{ readonly artifactRef: string; readonly contentHash: string }> {
  const artifactRef = ids.next();
  const document = { rows: keyed(keyedFor, rows) };
  const contentHash = sha(JSON.stringify(document) + artifactRef);
  await w.asTenant(w.A, (conn) =>
    conn.query(
      "INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) VALUES ($1, $2, $3, 'STAGE_RECEIPT', 'CLEAN', $4, $5::jsonb, $6, $7)",
      [artifactRef, w.A.agencyId, c.projectId, c.instanceId, JSON.stringify(document), contentHash, w.A.ownerMembershipId],
    ),
  );
  return { artifactRef, contentHash };
}

function submit(c: Context, stage: Stage, artifactRef: string, key: string = freshKey("t1-cmd040"), who: Person = w.operator): Promise<Reply> {
  return call(w, { url: `/api/v1/projects/${c.projectId}/import-stages/${stage.stageId}/receipts`, token: who.token, key, body: { receiptUploadRef: artifactRef, sourcePackageHash: stage.packageHash } });
}
function proceed(c: Context, stage: Stage, view: Pick<ImportStageView, "version" | "identityMappingHash">, who: Person = w.approver): Promise<Reply> {
  return call(w, { url: `/api/v1/projects/${c.projectId}/import-stages/${stage.stageId}/continue`, token: who.token, key: freshKey("t1-cmd041"), body: { expectedVersion: view.version, validatedReceiptHash: view.identityMappingHash } });
}
async function receiptThroughRoute(c: Context, stage: Stage, rows: ReadonlyArray<Row>): Promise<ImportStageView> {
  const upload = await storeReceipt(c, stage, rows);
  return completed<ImportStageView>(await submit(c, stage, upload.artifactRef), 200).data;
}

const receipts = (stageId: string): Promise<number> => w.count("stage_receipts", "stage_id = $1", [stageId]);
const reconciliations = (stageId: string): Promise<number> => w.count("stage_receipt_reconciliations", "stage_id = $1", [stageId]);
const stageRow = (stageId: string) =>
  w.row<{ state: string; version: number; continued_at: Date | null; continuation_receipt_hash: string | null }>("import_stages", "stage_id = $1", [stageId]);
const mappingOf = async (stageId: string): Promise<string[]> => {
  const r = await w.h.oracle.query<{ mapping: Array<{ sourceId: string; disposition: string }> }>("SELECT mapping FROM kauro.stage_receipts WHERE stage_id = $1 ORDER BY revision DESC LIMIT 1", [stageId]);
  return (r.rows[0]?.mapping ?? []).map((m) => `${m.sourceId}:${m.disposition}`).sort();
};

// --- the race and expiry instruments ---------------------------------------------------------------------------------------------------

/** The one backend seen waiting on a lock the holder's backend holds (bounded by the harness's poll bounds); fails if `settled` first. */
async function waiterOn(holderPid: number, settled: () => boolean, what: string): Promise<number> {
  for (let attempt = 0; attempt < LOCK_WAIT_POLL_ATTEMPTS; attempt++) {
    if (settled()) throw new Error(`${what}: the waiter finished without waiting on the holder's lock`);
    const r = await w.h.oracle.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1::int = ANY (pg_blocking_pids(pid))", [holderPid]);
    if (r.rows.length === 1) return r.rows[0]!.pid;
    if (r.rows.length > 1) throw new Error(`${what}: ${r.rows.length} backends wait on the holder, not the one waiter`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(`${what}: the waiter was never seen waiting on the holder's lock`);
}

/** Tracks whether a promise settled (a waiter that answered without waiting is a cell that did not happen). */
function tracked<T>(p: Promise<T>): { readonly promise: Promise<T>; readonly settled: () => boolean } {
  let done = false;
  const promise = p.finally(() => {
    done = true;
  });
  return { promise, settled: () => done };
}

/**
 * The held unit on backend `pid`, standing at `instant` on the TEST CLOCK, had its effect clock before `deadline` at the hold; the cell lets
 * it run past the deadline while held: it waits only the remainder the database reports, then asserts the held unit's effect clock past it.
 */
async function crossedWhileHeld(pid: number, instant: string, deadline: string, what: string): Promise<void> {
  const look = async (): Promise<{ readonly remaining_ms: string }> => {
    const r = await w.h.oracle.query<{ remaining_ms: string }>(
      "SELECT (extract(epoch FROM $3::timestamptz - ($2::timestamptz + (clock_timestamp() - xact_start))) * 1000)::text AS remaining_ms FROM pg_stat_activity WHERE pid = $1 AND xact_start IS NOT NULL",
      [pid, instant, deadline],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`${what}: the held unit's transaction is gone`);
    return row;
  };
  const first = Number((await look()).remaining_ms);
  assert.ok(first > 0, `${what}: the held unit's effect clock stood before the deadline at the hold (${first} ms ahead)`);
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(first) + 1));
  assert.ok(Number((await look()).remaining_ms) < 0, `${what}: its effect clock ran past the deadline while it was held`);
}

/** The project's current contract re-observed through the real CMD018 and CMD019 routes (B), its observation 1 ms after the old one's. */
async function newerContract(c: Context): Promise<{ readonly draft: TargetContractView; readonly confirmBody: Record<string, unknown> }> {
  const old = await w.row<{ observed_at: Date }>("target_contracts", "project_id = $1 AND confirmed_at IS NOT NULL AND superseded_at IS NULL", [c.projectId]);
  assert.ok(old);
  const observedAt = toUtcInstant(old.observed_at.getTime() + 1);
  assert.ok(observedAt <= (await dbInstant(0)), "the re-observation is not ahead of the database clock");
  const store = async (kind: "METADATA" | "CONFIRMATION_EVIDENCE", document: Record<string, unknown>): Promise<string> => {
    const artifactRef = ids.next();
    await w.asTenant(w.A, (conn) =>
      conn.query(
        "INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) VALUES ($1, $2, $3, $4, 'CLEAN', $5, $6::jsonb, $7, $8)",
        [artifactRef, w.A.agencyId, c.projectId, kind, c.instanceId, JSON.stringify(document), sha(JSON.stringify(document) + artifactRef), w.A.ownerMembershipId],
      ),
    );
    return artifactRef;
  };
  const objects = [{ apiName: "Contact", operations: ["CREATE", "UPDATE"], fields: [{ apiName: "email", dataType: "TEXT", createable: true, updateable: true, requiredOnCreate: false, allowedValues: [], clearMechanism: "UNSUPPORTED", unique: true, nillable: true }], identifierFields: ["email"], relationships: [] }];
  const metadata = await store("METADATA", { importerVersion: "R2-INITIAL", capabilityVersion: "R2-INITIAL", observedAt, objects });
  const draft = completed<TargetContractView>(await call(w, { url: `/api/v1/projects/${c.projectId}/target-contracts`, token: w.operator.token, key: freshKey("t1-cmd018"), body: { metadataArtifactRef: metadata, importerProfileId: ids.next() } }), 201).data;
  const evidence = await store("CONFIRMATION_EVIDENCE", { shown: "complete body and destination scope" });
  return { draft, confirmBody: { expectedVersion: draft.version, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence } };
}
const confirmContract = (contractId: string, body: Record<string, unknown>): Promise<Reply> => call(w, { url: `/api/v1/target-contracts/${contractId}/confirm`, token: w.approver.token, key: freshKey("t1-cmd019"), body });

// --- R2-023 ----------------------------------------------------------------------------------------------------------------------------

/** A parent of ten sources whose receipt matched eight and failed two, continued by the approver (VERIFIED_PARTIAL), and its child stage. */
async function parentAndChild(seed: string): Promise<{ readonly c: Context; readonly parent: Stage; readonly child: Stage }> {
  const c = await approvedContext(seed);
  const parent = await seedStage(c, { sourceIds: sources("p", 10) });
  const pv = await receiptThroughRoute(c, parent, [...matched("p", 1, 8), ...failed("p", 9, 10)]);
  assert.deepEqual([pv.state, pv.matchedRows, pv.failedRows], ["RECEIPT_VALIDATING", 8, 2]);
  const continued = completed<ImportStageView>(await proceed(c, parent, pv), 200).data;
  assert.equal(continued.state, "VERIFIED_PARTIAL");
  const child = await seedStage(c, {
    sourceIds: sources("c", 10),
    parents: [parent.stageId],
    edges: sources("c", 10).map((s, i) => ({ childSourceId: s, parentStageId: parent.stageId, parentSourceId: `p-${i + 1}` })),
  });
  return { c, parent, child };
}
const PARENT_DISPOSITIONS = [...sources("p", 8).map((s) => `${s}:MATCHED`), "p-9:FAILED", "p-10:FAILED"].sort();

test("R2-023: OK eight of ten parents bind; child edges of the two failed parents are BLOCKED_BY_PARENT; all ten parent dispositions stay", async () => {
  const { c, parent, child } = await parentAndChild("t1-r2023-ok");
  for (const rows of [[...matched("c", 1, 8), ...failed("c", 9, 10)], matched("c", 1, 8)]) {
    const stage = rows.length === 10 ? child : await seedStage(c, { sourceIds: sources("c", 10), parents: [parent.stageId], edges: sources("c", 10).map((s, i) => ({ childSourceId: s, parentStageId: parent.stageId, parentSourceId: `p-${i + 1}` })) });
    const view = await receiptThroughRoute(c, stage, rows);
    assert.deepEqual([view.state, view.receiptResult, view.matchedRows, view.failedRows, view.unresolvedRows], ["RECEIPT_VALIDATING", "PARTIAL_ACCOUNTED", 8, 2, 0], "the blocked children are accounted, never unresolved or matched");
    assert.deepEqual(await mappingOf(stage.stageId), [...sources("c", 8).map((s) => `${s}:MATCHED`), "c-9:BLOCKED_BY_PARENT", "c-10:BLOCKED_BY_PARENT"].sort(), rows.length === 10 ? "reported FAILED" : "omitted");
  }
  assert.deepEqual(await mappingOf(parent.stageId), PARENT_DISPOSITIONS, "the parent keeps all ten dispositions");
  assert.equal(await receipts(parent.stageId), 1);
});

test("R2-023: DENY a child receipt that claims MATCHED for a blocked child (CHILD_EDGE_BLOCKED)", async () => {
  const { c, parent, child } = await parentAndChild("t1-r2023-deny");
  const claim = await storeReceipt(c, child, [...matched("c", 1, 9), ...failed("c", 10, 10)]);
  assert.equal(outcome(w, await submit(c, child, claim.artifactRef)), "409 PRECONDITION_FAILED CHILD_EDGE_BLOCKED");
  assert.deepEqual([await receipts(child.stageId), await reconciliations(child.stageId)], [0, 0], "nothing recorded");
  assert.deepEqual([(await stageRow(child.stageId))?.state, (await stageRow(child.stageId))?.version], ["AWAITING_AGENCY_IMPORT", 1]);
  // the OK sibling: the same child reported FAILED binds the eight
  const view = await receiptThroughRoute(c, child, [...matched("c", 1, 8), ...failed("c", 9, 10)]);
  assert.deepEqual([view.state, view.matchedRows, view.failedRows], ["RECEIPT_VALIDATING", 8, 2]);
  assert.deepEqual(await mappingOf(parent.stageId), PARENT_DISPOSITIONS);
});

// --- R2-024 ----------------------------------------------------------------------------------------------------------------------------

test("R2-024: DENY a success receipt of another stage with the same rows (RECEIPT_FOREIGN_STAGE), nothing recorded", async () => {
  const c = await approvedContext("t1-r2024");
  const stage = await seedStage(c);
  const other = await seedStage(c);
  const rows = matched("src", 1, 4);
  // the other stage's receipt, the same rows, this stage's package named in the request
  const foreign = await storeReceipt(c, { stageId: other.stageId, packageHash: stage.packageHash }, rows);
  assert.equal(outcome(w, await submit(c, stage, foreign.artifactRef)), "409 PRECONDITION_FAILED RECEIPT_FOREIGN_STAGE");
  const misPackaged = await storeReceipt(c, { stageId: stage.stageId, packageHash: other.packageHash }, rows);
  assert.equal(outcome(w, await submit(c, stage, misPackaged.artifactRef)), "409 PRECONDITION_FAILED RECEIPT_FOREIGN_STAGE", "keyed for another package");
  for (const s of [stage, other]) {
    assert.deepEqual([await receipts(s.stageId), await reconciliations(s.stageId)], [0, 0], "nothing recorded");
    assert.deepEqual([(await stageRow(s.stageId))?.state, (await stageRow(s.stageId))?.version], ["AWAITING_AGENCY_IMPORT", 1]);
  }
  // the OK sibling: the stage's own receipt of the same rows
  const own = await receiptThroughRoute(c, stage, rows);
  assert.deepEqual([own.state, own.matchedRows], ["VERIFIED_SUCCESS", 4]);
});

// --- R2-025 ----------------------------------------------------------------------------------------------------------------------------

test("R2-025: OK identical receipt content is idempotent on any key; a differing receipt for a finalized stage opens one reconciliation and never overwrites identity", async () => {
  const c = await approvedContext("t1-r2025");
  const stage = await seedStage(c);
  const first = await storeReceipt(c, stage, matched("src", 1, 4));
  const k1 = completed<ImportStageView>(await submit(c, stage, first.artifactRef), 200);
  const k2 = completed<ImportStageView>(await submit(c, stage, first.artifactRef), 200);
  assert.equal(k2.replayed, false, "another key, not a replay of the first");
  assert.deepEqual([k2.data.version, k2.data.receiptRevision, k2.data.identityMappingHash], [k1.data.version, 1, k1.data.identityMappingHash]);
  assert.equal(await receipts(stage.stageId), 1);

  const differing = await storeReceipt(c, stage, [...matched("src", 1, 3), { sourceId: "src-4", status: "MATCHED", targetId: "crm-other" }]);
  const opened = completed<ImportStageView>(await submit(c, stage, differing.artifactRef), 200).data;
  assert.equal(await receipts(stage.stageId), 1, "the verified identity is never overwritten");
  assert.deepEqual([opened.state, opened.version, opened.receiptRevision, opened.identityMappingHash], ["VERIFIED_SUCCESS", k1.data.version, 1, k1.data.identityMappingHash]);
  assert.deepEqual([opened.reconciliation?.state, opened.reconciliation?.contentHash], ["OPEN", differing.contentHash]);
  const again = completed<ImportStageView>(await submit(c, stage, differing.artifactRef), 200).data;
  assert.equal(again.reconciliation?.reconciliationId, opened.reconciliation?.reconciliationId, "the same differing bytes on another key are the same request");
  assert.equal(await reconciliations(stage.stageId), 1);
  const row = await w.row<{ state: string; content_hash: string; receipt_upload_ref: string }>("stage_receipt_reconciliations", "stage_id = $1", [stage.stageId]);
  assert.deepEqual([row?.state, row?.content_hash, row?.receipt_upload_ref], ["OPEN", differing.contentHash, differing.artifactRef]);
});

test("R2-025: RACE two differing receipts held at the stage row, both orders", async () => {
  for (const order of ["a first", "b first"] as const) {
    const c = await approvedContext(`t1-r2025-race-${order}`);
    const stage = await seedStage(c);
    const a = await storeReceipt(c, stage, matched("src", 1, 4));
    const b = await storeReceipt(c, stage, [...matched("src", 1, 3), { sourceId: "src-4", status: "MATCHED", targetId: "crm-b" }]);
    const [held, waiting] = order === "a first" ? [a, b] : [b, a];
    // the holder stops after its last read, the stage row FOR NO KEY UPDATE taken
    const pause = points.pause("importStages.receiptStatus.after");
    const holder = tracked(submit(c, stage, held.artifactRef));
    await pause.reachedBy(holder.promise);
    const holderPid = pidAt.get("importStages.receiptStatus");
    assert.ok(holderPid !== undefined);
    const waiter = tracked(submit(c, stage, waiting.artifactRef));
    await waiterOn(holderPid, waiter.settled, `${order}: the second receipt`);
    pause.release();
    const replies = await Promise.all([holder.promise, waiter.promise]);
    // the forbidden effect first: one revision and one reconciliation, never two revisions
    assert.equal(await receipts(stage.stageId), 1, `${order}: exactly one revision`);
    assert.equal(await reconciliations(stage.stageId), 1, `${order}: the other bytes are one reconciliation request`);
    assert.deepEqual(replies.map((r) => r.status), [200, 200]);
    const receipt = await w.row<{ receipt_file_hash: string }>("stage_receipts", "stage_id = $1", [stage.stageId]);
    assert.equal(receipt?.receipt_file_hash, held.contentHash, `${order}: the holder's receipt is the identity`);
    assert.deepEqual([(await stageRow(stage.stageId))?.version], [2]);
  }
});

test("R2-025: RACE (expiry) expires_at passes while CMD040 is held at receiptStatus: STAGE_EXPIRED, 0 revisions", async () => {
  const c = await approvedContext("t1-r2025-expiry");
  const deadline = await dbInstant(3_600_000);
  const stage = await seedStage(c, { expiresAt: deadline });
  const upload = await storeReceipt(c, stage, matched("src", 1, 4));
  const instant = toUtcInstant(Date.parse(deadline) - 1_000);
  const pause = points.pause("importStages.receiptStatus.after");
  stand = instant;
  const held = tracked(submit(c, stage, upload.artifactRef));
  try {
    await pause.reachedBy(held.promise);
  } finally {
    stand = null;
  }
  const pid = pidAt.get("importStages.receiptStatus");
  assert.ok(pid !== undefined);
  await crossedWhileHeld(pid, instant, deadline, "CMD040 held at receiptStatus");
  pause.release();
  const reply = await held.promise;
  assert.equal(await receipts(stage.stageId), 0, "no revision after the deadline");
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED STAGE_EXPIRED");
  assert.deepEqual([(await stageRow(stage.stageId))?.state, (await stageRow(stage.stageId))?.version], ["AWAITING_AGENCY_IMPORT", 1]);
});

// --- CMD041 (M2, M10) ------------------------------------------------------------------------------------------------------------------

/** A stage verified through CMD040 whose parent is verified and whose plan is approved. */
async function readyStage(seed: string, expiresAt?: string): Promise<{ readonly c: Context; readonly stage: Stage; readonly view: ImportStageView }> {
  const c = await approvedContext(seed);
  const parent = await seedStage(c, { state: "VERIFIED_SUCCESS" });
  const stage = await seedStage(c, { parents: [parent.stageId], ...(expiresAt !== undefined ? { expiresAt } : {}) });
  const view = await receiptThroughRoute(c, stage, matched("src", 1, 4));
  return { c, stage, view };
}

test("R2-023: RACE (expiry) the stage deadline passes while CMD041 is held at lockCurrentByHash: STAGE_EXPIRED", async () => {
  const deadline = await dbInstant(3_600_000);
  const { c, stage, view } = await readyStage("t1-cst-expiry", deadline);
  const instant = toUtcInstant(Date.parse(deadline) - 1_000);
  const pause = points.pause("targetContracts.lockCurrentByHash.after");
  stand = instant;
  const held = tracked(proceed(c, stage, view));
  try {
    await pause.reachedBy(held.promise);
  } finally {
    stand = null;
  }
  const pid = pidAt.get("targetContracts.lockCurrentByHash");
  assert.ok(pid !== undefined);
  await crossedWhileHeld(pid, instant, deadline, "CMD041 held at lockCurrentByHash");
  pause.release();
  const reply = await held.promise;
  assert.equal((await stageRow(stage.stageId))?.continued_at, null, "no continuation after the deadline");
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED STAGE_EXPIRED");
});

test("R2-023: RACE (revocation) CMD019 supersedes the stage target while CMD041 holds the plan approval half: TARGET_STALE, no continuation", async () => {
  // order 1: B holds the old contract's exclusive half (paused after its bound-plans read); CMD041 waits behind it, and once B commits it
  // re-reads its plan's target superseded
  {
    const { c, stage, view } = await readyStage("t1-m10-b-first");
    const { draft, confirmBody } = await newerContract(c);
    const pause = points.pause("targetContracts.approvedPlansBoundTo.after");
    const b = tracked(confirmContract(draft.contractId, confirmBody));
    await pause.reachedBy(b.promise);
    const pid = pidAt.get("targetContracts.approvedPlansBoundTo");
    assert.ok(pid !== undefined);
    const waiter = tracked(proceed(c, stage, view));
    await waiterOn(pid, waiter.settled, "CMD041 behind the supersession");
    pause.release();
    const [confirmed, refused] = await Promise.all([b.promise, waiter.promise]);
    assert.equal((await stageRow(stage.stageId))?.continued_at, null, "no continuation on a superseded target");
    assert.equal(confirmed.status, 200, `the supersession commits: ${confirmed.status === 200 ? "" : outcome(w, confirmed)}`);
    assert.equal(outcome(w, refused), "422 TARGET_STALE -");
  }
  // order 2: CMD041 holds the target's shared half (WS:405, the set); B waits on it, then supersedes the continued stage's target
  {
    const { c, stage, view } = await readyStage("t1-m10-b-waits");
    const { draft, confirmBody } = await newerContract(c);
    const pause = points.pause("targetContracts.lockCurrentByHash.after");
    const held = tracked(proceed(c, stage, view));
    await pause.reachedBy(held.promise);
    const pid = pidAt.get("targetContracts.lockCurrentByHash");
    assert.ok(pid !== undefined);
    const b = tracked(confirmContract(draft.contractId, confirmBody));
    await waiterOn(pid, b.settled, "CMD019 behind the continuation's target half");
    pause.release();
    const [continued, confirmed] = await Promise.all([held.promise, b.promise]);
    const row = await stageRow(stage.stageId);
    assert.equal(row?.continuation_receipt_hash, view.identityMappingHash, "the continuation committed before the supersession");
    assert.deepEqual([continued.status, confirmed.status], [200, 200]);
  }
});

test("R2-023: RACE (revocation) CMD026 withdraws the plan approval while CMD041 waits on the plan row: CHILD_PLAN_NOT_APPROVED", async () => {
  const withdraw = async (c: Context): Promise<Reply> => {
    const plan = await w.row<{ version: number }>("plans", "plan_id = $1", [c.planId]);
    assert.ok(plan);
    return call(w, { url: routes.withdrawApproval(c.planId), token: w.approver.token, key: freshKey("t1-cmd026"), body: { expectedVersion: Number(plan.version), reasonCode: "SCOPE_CHANGED" } });
  };
  // order 1: CMD026 holds the plan row; CMD041 waits on it and then reads the withdrawn approval
  {
    const { c, stage, view } = await readyStage("t1-cmd026-first");
    const pause = points.pause("plans.lock.after");
    const held = tracked(withdraw(c));
    await pause.reachedBy(held.promise).catch(async (e: unknown) => {
      throw new Error(`${String(e)}: ${outcome(w, await held.promise)}`);
    });
    const pid = pidAt.get("plans.lock");
    assert.ok(pid !== undefined);
    const waiter = tracked(proceed(c, stage, view));
    await waiterOn(pid, waiter.settled, "CMD041 behind the withdrawal's plan row");
    pause.release();
    const [withdrawn, refused] = await Promise.all([held.promise, waiter.promise]);
    assert.equal((await stageRow(stage.stageId))?.continued_at, null, "no continuation under a withdrawn approval");
    assert.equal(withdrawn.status, 200);
    assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED CHILD_PLAN_NOT_APPROVED");
  }
  // order 2: CMD041 holds the plan row and the approval half; the withdrawal waits and lands after the continuation
  {
    const { c, stage, view } = await readyStage("t1-cmd041-first");
    const pause = points.pause("execution.awaitTransition.after");
    const held = tracked(proceed(c, stage, view));
    await pause.reachedBy(held.promise);
    const pid = pidAt.get("execution.awaitTransition");
    assert.ok(pid !== undefined);
    const waiter = tracked(withdraw(c));
    await waiterOn(pid, waiter.settled, "CMD026 behind the continuation");
    pause.release();
    const [continued, withdrawn] = await Promise.all([held.promise, waiter.promise]);
    assert.equal((await stageRow(stage.stageId))?.continuation_receipt_hash, view.identityMappingHash, "the continuation committed under the approval that held");
    assert.deepEqual([continued.status, withdrawn.status], [200, 200]);
  }
});

test("R2-025: DENY a child continuing from a parent whose identities are under an open reconciliation (PARENT_IDENTITY_UNDER_RECONCILIATION); OK once none is open", async () => {
  const c = await approvedContext("t1-x4");
  const parent = await seedStage(c);
  await receiptThroughRoute(c, parent, matched("src", 1, 4));
  const settledChild = await seedStage(c, { parents: [parent.stageId] });
  const ok = await receiptThroughRoute(c, settledChild, matched("src", 1, 4));
  // the OK sibling first: no reconciliation is open on the parent, the child continues
  completed<ImportStageView>(await proceed(c, settledChild, ok), 200);
  // a differing receipt for the finalized parent opens a reconciliation: its identities are no longer settled for any child
  const differing = await storeReceipt(c, parent, [...matched("src", 1, 3), { sourceId: "src-4", status: "MATCHED", targetId: "crm-other" }]);
  assert.equal(completed<ImportStageView>(await submit(c, parent, differing.artifactRef), 200).data.reconciliation?.state, "OPEN");
  const child = await seedStage(c, { parents: [parent.stageId] });
  const cv = await receiptThroughRoute(c, child, matched("src", 1, 4));
  assert.equal(outcome(w, await proceed(c, child, cv)), "409 PRECONDITION_FAILED PARENT_IDENTITY_UNDER_RECONCILIATION");
  assert.equal((await stageRow(child.stageId))?.continued_at, null, "nothing continued");
});

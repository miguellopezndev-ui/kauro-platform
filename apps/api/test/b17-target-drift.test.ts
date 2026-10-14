// B17 L1, T3 (docs/design/B15-B17-B18-local-plan.md sections 2 R2-026 / D-R3-1, 3 meeting rows, 4 rows CTC CRT EXP, 5 M4): a confirmed
// newer target contract supersedes every current contract of its project (CMD019, B), each APPROVED plan bound to a superseded contract gets
// one re-check plan VALIDATION_REQUIRED in the same transaction, the paid authorization stays unconsumed (ExecuteProject answers
// TARGET_STALE, a refund request is accepted, nothing is charged), and every reader of a contract's currency is ordered with B at the
// lock the plan names. Real routes over the real units of work and PostgreSQL 17; B is driven only through CMD018 and CMD019, and every
// actor uses only ids the routes emitted (r24b). A RACE cell holds one actor inside its unit of work at the named port call
// (instrumentPort `<port>.<method>.after`, its locks taken), observes the other waiting on the holder's backend, releases, and asserts the
// forbidden effect first; an EXPIRY cell stands the held unit on the TEST CLOCK before the deadline and lets its effect clock run past it
// while held at the plan's bold await.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { TargetContractView } from "@kauro/application";
import { TARGET_OBSERVATION_FRESHNESS_SECONDS, toUtcInstant } from "@kauro/domain";
import { FaultPoints, INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_POLL_ATTEMPTS, LOCK_WAIT_POLL_INTERVAL_MS, instrumentPort, openConnection, serverNow } from "@kauro/persistence/testing";
import { paymentRoutes, paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { endLiveJobs, execute, jobsOfAuthorization, type Sale } from "./execution-support.js";
import { SimulatedCrash, approvalBodyOf, approveThroughRoute, call, completed, freshKey, ids, outcome, routes, sha, type PlanFixture, type Reply, type World } from "./support.js";

// --- the world: units of work stand on the TEST CLOCK when told, run under an injected statement bound when told, and pass named points --

let stand: string | null = null;
let statementTimeoutMs: number | null = null;
const points = new FaultPoints();
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
        return (context: unknown, work: (uow: unknown) => Promise<unknown>, options?: Record<string, unknown>) =>
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
            statementTimeoutMs === null ? options : { ...(options ?? {}), statementTimeoutMs },
          );
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let pw: PaymentsWorld;
let w: World;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"], wrapUnitOfWork: instrumented });
  w = pw.w;
});
after(async () => {
  await pw.stop();
});
afterEach(async () => {
  stand = null;
  statementTimeoutMs = null;
  await endLiveJobs(pw);
});

// --- instruments -----------------------------------------------------------------------------------------------------------------------

async function dbInstant(offsetMs: number): Promise<string> {
  return toUtcInstant(Date.parse(await serverNow(w.h.oracle)) + offsetMs);
}

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

function tracked<T>(p: Promise<T>): { readonly promise: Promise<T>; readonly settled: () => boolean } {
  let done = false;
  const promise = p.finally(() => {
    done = true;
  });
  return { promise, settled: () => done };
}

async function crossedWhileHeld(pid: number, instant: string, deadline: string, what: string): Promise<void> {
  const look = async (): Promise<number> => {
    const r = await w.h.oracle.query<{ remaining_ms: string }>(
      "SELECT (extract(epoch FROM $3::timestamptz - ($2::timestamptz + (clock_timestamp() - xact_start))) * 1000)::text AS remaining_ms FROM pg_stat_activity WHERE pid = $1 AND xact_start IS NOT NULL",
      [pid, instant, deadline],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`${what}: the held unit's transaction is gone`);
    return Number(row.remaining_ms);
  };
  const first = await look();
  assert.ok(first > 0, `${what}: the held unit's effect clock stood before the deadline at the hold (${first} ms ahead)`);
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(first) + 1));
  assert.ok((await look()) < 0, `${what}: its effect clock ran past the deadline while it was held`);
}

/** Holds the actor at `point` (`<port>.<method>`, after its statement) and returns its backend once it is there. */
async function hold<T>(point: string, start: () => Promise<T>): Promise<{ readonly actor: { readonly promise: Promise<T>; readonly settled: () => boolean }; readonly pid: number; release(): void }> {
  const pause = points.pause(`${point}.after`);
  const actor = tracked(start());
  await pause.reachedBy(actor.promise);
  const pid = pidAt.get(point);
  assert.ok(pid !== undefined, `the holder's backend at ${point}`);
  return { actor, pid, release: () => pause.release() };
}

// --- B: the newer contract through CMD018 and CMD019 -----------------------------------------------------------------------------------

const OBJECTS = [{ apiName: "Contact", operations: ["CREATE", "UPDATE"], fields: [{ apiName: "email", dataType: "TEXT", createable: true, updateable: true, requiredOnCreate: false, allowedValues: [], clearMechanism: "UNSUPPORTED", unique: true, nillable: true }], identifierFields: ["email"], relationships: [] }];

interface Current {
  readonly contractId: string;
  readonly bodyHash: string;
  readonly instanceId: string;
  readonly observedAt: Date;
}
async function currentOf(projectId: string): Promise<Current> {
  const r = await w.row<{ contract_id: string; body_hash: string; instance_id: string; observed_at: Date }>("target_contracts", "project_id = $1 AND confirmed_at IS NOT NULL AND superseded_at IS NULL", [projectId]);
  assert.ok(r, "the project's current contract");
  return { contractId: r.contract_id, bodyHash: r.body_hash, instanceId: r.instance_id, observedAt: r.observed_at };
}

async function storeArtifact(projectId: string, instanceId: string, kind: "METADATA" | "CONFIRMATION_EVIDENCE", document: Record<string, unknown>): Promise<string> {
  const artifactRef = ids.next();
  await w.asTenant(w.A, (conn) =>
    conn.query(
      "INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) VALUES ($1, $2, $3, $4, 'CLEAN', $5, $6::jsonb, $7, $8)",
      [artifactRef, w.A.agencyId, projectId, kind, instanceId, JSON.stringify(document), sha(JSON.stringify(document) + artifactRef), w.A.ownerMembershipId],
    ),
  );
  return artifactRef;
}

interface Newer {
  readonly draft: TargetContractView;
  readonly body: Record<string, unknown>;
  readonly observedAt: string;
}
/** A re-observation of the project's current instance (identical objects), `afterMs` after the current one, as a DRAFT through CMD018. */
async function newerDraft(projectId: string, afterMs = 1): Promise<Newer> {
  const current = await currentOf(projectId);
  const observedAt = toUtcInstant(current.observedAt.getTime() + afterMs);
  assert.ok(observedAt <= (await dbInstant(0)), "the re-observation is not ahead of the database clock");
  const metadata = await storeArtifact(projectId, current.instanceId, "METADATA", { importerVersion: "R2-INITIAL", capabilityVersion: "R2-INITIAL", observedAt, objects: OBJECTS });
  const draft = completed<TargetContractView>(await call(w, { url: `/api/v1/projects/${projectId}/target-contracts`, token: w.operator.token, key: freshKey("t3-cmd018"), body: { metadataArtifactRef: metadata, importerProfileId: ids.next() } }), 201).data;
  const evidence = await storeArtifact(projectId, current.instanceId, "CONFIRMATION_EVIDENCE", { shown: "complete body and destination scope" });
  return { draft, body: { expectedVersion: draft.version, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence }, observedAt };
}
const confirm = (newer: Pick<Newer, "draft" | "body">, key: string = freshKey("t3-cmd019"), body: Record<string, unknown> = newer.body): Promise<Reply> =>
  call(w, { url: `/api/v1/target-contracts/${newer.draft.contractId}/confirm`, token: w.approver.token, key, body });

/** A success status, or the outcome of a refusal (never asks a success for its problem). */
const label = (r: Reply): string => (r.status < 300 ? String(r.status) : outcome(w, r));
const contractRow = (id: string) => w.row<{ confirmed_at: Date | null; superseded_at: Date | null; superseded_by_contract_id: string | null }>("target_contracts", "contract_id = $1", [id]);
const rechecksOf = (planId: string): Promise<number> => w.count("plans", "recheck_of_plan_id = $1", [planId]);
const currentCount = (projectId: string): Promise<number> => w.count("target_contracts", "project_id = $1 AND confirmed_at IS NOT NULL AND superseded_at IS NULL", [projectId]);

/** Nothing of B was written: the old contract current, the new one a DRAFT, no re-check plan. */
async function nothingSuperseded(old: Current, newer: Newer, planIds: ReadonlyArray<string>, what: string): Promise<void> {
  const o = await contractRow(old.contractId);
  const n = await contractRow(newer.draft.contractId);
  assert.deepEqual([o?.superseded_at, o?.superseded_by_contract_id, n?.confirmed_at], [null, null, null], `${what}: no half-superseded set`);
  for (const planId of planIds) assert.equal(await rechecksOf(planId), 0, `${what}: no re-check plan`);
}

/** A paid purchase whose plan was approved through CMD025 (its authorization ACTIVE). */
const paid = (label: string): Promise<Sale> => pw.paidProject(label);

// --- R2-026 OK cells -------------------------------------------------------------------------------------------------------------------

test("R2-026: OK a re-observation with identical objects supersedes too; the paid authorization re-binds only through the re-check plan's validation, approval and REPAIR (no automatic survival)", async () => {
  const sale = await paid("t3-reobserve");
  const old = await currentOf(sale.projectId);
  const newer = await newerDraft(sale.projectId);
  const view = completed<TargetContractView>(await confirm(newer), 200).data;
  // the forbidden effect first: the old contract does not survive and the paid authorization is not carried over
  const o = await contractRow(old.contractId);
  assert.ok(o?.superseded_at instanceof Date, "the identical re-observation supersedes the old contract");
  assert.equal(o?.superseded_by_contract_id, newer.draft.contractId);
  assert.equal(await currentCount(sale.projectId), 1);
  assert.equal(outcome(w, await execute(pw, sale)), "422 TARGET_STALE -", "the paid authorization does not survive automatically");
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), []);
  // the answer: what was superseded, the one re-check plan, the included paths
  assert.deepEqual(view.supersedes?.map((s) => s.contractId), [old.contractId]);
  assert.deepEqual(view.includedPaths, ["REPAIR", "REQUEST_REFUND", "NEW_SCOPE"]);
  assert.equal(view.recheckPlanIds?.length, 1);
  const recheckId = view.recheckPlanIds![0]!;
  const recheck = await w.row<{ state: string; recheck_of_plan_id: string; target_contract_hash: string; body: Record<string, unknown>; approval_id: string | null }>("plans", "plan_id = $1", [recheckId]);
  const original = await w.row<{ body: Record<string, unknown> }>("plans", "plan_id = $1", [sale.plan.planId]);
  assert.deepEqual([recheck?.state, recheck?.recheck_of_plan_id, recheck?.target_contract_hash, recheck?.approval_id], ["VALIDATION_REQUIRED", sale.plan.planId, newer.draft.bodyHash, null], "the re-check waits for its validation and approval");
  assert.deepEqual(recheck?.body, { ...original?.body, targetContractHash: newer.draft.bodyHash }, "only the target binding changes");
  const authorization = await w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [sale.authorizationId]);
  assert.equal(authorization?.state, "ACTIVE", "the authorization stays unconsumed for REPAIR (L7) or a refund");
});

test("R2-026: OK a supersession leaves the ACTIVE authorization unconsumed, 0 charges, and CMD031 accepts a refund request for its remaining cents", async () => {
  const sale = await paid("t3-entitlement");
  const orders = await w.count("payment_orders", "project_id = $1", [sale.projectId]);
  const captures = await w.count("capture_facts", "agency_id = $1", [w.A.agencyId]);
  completed<TargetContractView>(await confirm(await newerDraft(sale.projectId)), 200);
  assert.deepEqual([await w.count("payment_orders", "project_id = $1", [sale.projectId]), await w.count("capture_facts", "agency_id = $1", [w.A.agencyId])], [orders, captures], "0 charges");
  assert.equal(outcome(w, await execute(pw, sale)), "422 TARGET_STALE -");
  assert.equal((await w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [sale.authorizationId]))?.state, "ACTIVE");
  const requested = completed<{ refund: { state: string; serviceCents: string; taxCents: string; captureId: string } }>(
    await call(w, { url: paymentRoutes.requestRefund(sale.projectId), token: w.billing.token, key: freshKey("t3-cmd031"), body: { reasonCode: "The target changed before execution", evidenceRef: ids.next() } }),
    201,
  ).data.refund;
  assert.deepEqual([requested.state, requested.serviceCents, requested.taxCents, requested.captureId], ["REQUESTED", sale.serviceCents.toString(), sale.taxCents.toString(), sale.captureId], "the remaining cents");
});

// --- M4: CMD019 failure cells ----------------------------------------------------------------------------------------------------------

test("R2-026: RETRY the same key replays; the same key with another digest is IDEMPOTENCY_CONFLICT", async () => {
  const sale = await paid("t3-retry");
  const newer = await newerDraft(sale.projectId);
  const key = freshKey("t3-retry");
  const first = completed<TargetContractView>(await confirm(newer, key), 200);
  const replay = completed<TargetContractView>(await confirm(newer, key), 200);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data.recheckPlanIds, first.data.recheckPlanIds);
  assert.equal(await rechecksOf(sale.plan.planId), 1, "one re-check plan");
  assert.equal(outcome(w, await confirm(newer, key, { ...newer.body, bodyHash: sha("another digest") })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await rechecksOf(sale.plan.planId), 1);
});

test("R2-026: RACE (crash after COMMIT) the confirmation answer is lost; the same key returns it with the same recheckPlanIds", async () => {
  const sale = await paid("t3-crash-after");
  const old = await currentOf(sale.projectId);
  const newer = await newerDraft(sale.projectId);
  const key = freshKey("t3-crash-after");
  w.holds.arm("after.commit", { fail: new SimulatedCrash("after the CMD019 commit") });
  const lost = await confirm(newer, key);
  assert.equal(lost.status, 500, "the answer is lost");
  assert.ok((await contractRow(old.contractId))?.superseded_at instanceof Date, "the supersession committed");
  assert.equal(await rechecksOf(sale.plan.planId), 1);
  const recheck = await w.row<{ plan_id: string }>("plans", "recheck_of_plan_id = $1", [sale.plan.planId]);
  const again = completed<TargetContractView>(await confirm(newer, key), 200);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.data.recheckPlanIds, [recheck?.plan_id]);
  assert.equal(await rechecksOf(sale.plan.planId), 1, "nothing executed again");
});

test("R2-026: CRASH before COMMIT after the re-check inserts: no supersession, no confirmation, no re-check plan", async () => {
  const sale = await paid("t3-crash-before");
  const old = await currentOf(sale.projectId);
  const newer = await newerDraft(sale.projectId);
  // the journal commit is the unit's last write, after the supersession, the confirmation and the re-check plan with its events
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before the CMD019 commit") });
  const crashed = await confirm(newer);
  assert.equal(crashed.status, 500);
  await nothingSuperseded(old, newer, [sale.plan.planId], "crash before COMMIT");
  // the same request again confirms once
  completed<TargetContractView>(await confirm(newer), 200);
  assert.equal(await rechecksOf(sale.plan.planId), 1);
});

test("R2-026: TIMEOUT a project-row wait past INJECTED_STATEMENT_TIMEOUT_MS is retryable, nothing written", async () => {
  const sale = await paid("t3-timeout");
  const old = await currentOf(sale.projectId);
  const newer = await newerDraft(sale.projectId);
  const key = freshKey("t3-timeout");
  const client = await openConnection(w.h.pg.clientConfig("postgres"));
  try {
    await client.query("BEGIN");
    await client.query("SELECT project_id FROM kauro.projects WHERE project_id = $1 FOR UPDATE", [sale.projectId]);
    statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const reply = await confirm(newer, key);
    statementTimeoutMs = null;
    assert.equal(outcome(w, reply), "503 CAPACITY_UNAVAILABLE -", "retryable");
    await nothingSuperseded(old, newer, [sale.plan.planId], "timeout");
  } finally {
    statementTimeoutMs = null;
    await client.query("ROLLBACK");
    await client.end();
  }
  const retried = completed<TargetContractView>(await confirm(newer, key), 200);
  assert.equal(retried.replayed, false, "the timed-out attempt left no journal entry");
  assert.equal(await rechecksOf(sale.plan.planId), 1);
});

test("R2-026: PARTIAL the second re-check insert fails: no half-superseded set, no plan", async () => {
  // two APPROVED plans of one project bound to its one current contract
  const { projectId } = await w.project(w.A, w.clientA);
  const first = await w.approvable(w.A, projectId, "t3-partial-1");
  const source = await w.revision(w.A, projectId, "SEALED");
  const second = await w.plan(w.A, projectId, { revisionHash: source.revisionHash, targetContractHash: first.targetContractHash, seed: "t3-partial-2", state: "VALIDATED" });
  await approveThroughRoute(w, first);
  await approveThroughRoute(w, second);
  const old = await currentOf(projectId);
  const newer = await newerDraft(projectId);
  const held = await hold("targetContracts.insertRecheckPlan", () => confirm(newer));
  points.crash("targetContracts.insertRecheckPlan.before");
  held.release();
  const reply = await held.actor.promise;
  assert.equal(reply.status, 500, "the second insert failed");
  await nothingSuperseded(old, newer, [first.planId, second.planId], "partial");
  assert.equal(await currentCount(projectId), 1);
});

// --- section 4 EXPIRY rows -------------------------------------------------------------------------------------------------------------

test("R2-026: RACE (expiry) the observation ages past freshness while CMD019 is held at the bound-plans read: TARGET_STALE, nothing superseded", async () => {
  const sale = await paid("t3-ctc-expiry");
  const old = await currentOf(sale.projectId);
  const newer = await newerDraft(sale.projectId);
  const deadline = toUtcInstant(Date.parse(newer.observedAt) + TARGET_OBSERVATION_FRESHNESS_SECONDS * 1000);
  const instant = toUtcInstant(Date.parse(deadline) - 1_000);
  stand = instant;
  const held = await hold("targetContracts.approvedPlansBoundTo", () => confirm(newer)).finally(() => {
    stand = null;
  });
  await crossedWhileHeld(held.pid, instant, deadline, "CMD019 held at the bound-plans read");
  held.release();
  const reply = await held.actor.promise;
  await nothingSuperseded(old, newer, [sale.plan.planId], "an observation past freshness");
  // the refusal names the freshness reason the CMD019-DENY cell asserts (the stale observation is not confirmed)
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED OBSERVATION_NOT_FRESH");
});

test("CMD018: RACE (expiry) an observation stamped ahead of the clock becomes past while CreateTargetContract is held at findLatestForProject: the draft is created", async () => {
  const { projectId } = await w.project(w.A, w.clientA);
  const observedAt = await dbInstant(3_600_000);
  const metadata = await storeArtifact(projectId, ids.next(), "METADATA", { importerVersion: "R2-INITIAL", capabilityVersion: "R2-INITIAL", observedAt, objects: OBJECTS });
  const create = (): Promise<Reply> => call(w, { url: `/api/v1/projects/${projectId}/target-contracts`, token: w.operator.token, key: freshKey("t3-crt"), body: { metadataArtifactRef: metadata, importerProfileId: ids.next() } });
  const instant = toUtcInstant(Date.parse(observedAt) - 1_000);
  stand = instant;
  const held = await hold("targetContracts.findLatestForProject", create).finally(() => {
    stand = null;
  });
  await crossedWhileHeld(held.pid, instant, observedAt, "CreateTargetContract held at findLatestForProject");
  held.release();
  const created = completed<TargetContractView>(await held.actor.promise, 201).data;
  assert.equal(created.state, "DRAFT");
  assert.equal(await w.count("target_contracts", "project_id = $1", [projectId]), 1);
});

test("CMD036: RACE (expiry) retention ends while ExecuteProject is held at the capacity read: SOURCE_EXPIRED, no job", async () => {
  const sale = await paid("t3-exp-expiry");
  const r = await w.h.oracle.query<{ at: string | null }>(
    `SELECT to_char(max(rr.effective_deadline) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM kauro.retention_records rr
       JOIN kauro.dataset_revisions d ON d.agency_id = rr.agency_id AND d.revision_id = rr.revision_id WHERE d.project_id = $1 AND rr.state = 'ACTIVE'`,
    [sale.projectId],
  );
  const deadline = r.rows[0]?.at;
  assert.ok(typeof deadline === "string", "the purchase's source retention has a deadline");
  const instant = toUtcInstant(Date.parse(deadline) - 1_000);
  stand = instant;
  const held = await hold("execution.capacity", () => execute(pw, sale)).finally(() => {
    stand = null;
  });
  await crossedWhileHeld(held.pid, instant, deadline, "ExecuteProject held at the capacity read");
  held.release();
  const reply = await held.actor.promise;
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [], "no job after the retention ended");
  assert.equal(outcome(w, reply), "422 SOURCE_EXPIRED -");
});

// --- section 3 meeting rows ------------------------------------------------------------------------------------------------------------

test("R2-026: RACE ExecuteProject against CMD019 at the project row, both orders: no job runs on a superseded contract and nothing is consumed", async () => {
  // order 1: ExecuteProject holds the project row (paused at its capacity read); B waits on it; the job is queued before the supersession
  {
    const sale = await paid("t3-m6-exp-first");
    const newer = await newerDraft(sale.projectId);
    const exp = await hold("execution.capacity", () => execute(pw, sale));
    const b = tracked(confirm(newer));
    await waiterOn(exp.pid, b.settled, "CMD019 behind ExecuteProject's project row");
    exp.release();
    const [queued, confirmed] = await Promise.all([exp.actor.promise, b.promise]);
    assert.deepEqual([label(queued), label(confirmed)], ["202", "200"]);
    const jobs = await jobsOfAuthorization(pw, sale.authorizationId);
    assert.equal(jobs.length, 1, "the job was queued under the contract that held");
    const job = await w.row<{ state: string; target_contract_hash: string }>("processing_jobs", "job_id = $1", [jobs[0]]);
    assert.equal(job?.state, "QUEUED", "queued, not run: admission re-checks the target (M4/M5)");
  }
  // order 2: B holds the project row and the old contract's exclusive half; ExecuteProject waits, then refuses
  {
    const sale = await paid("t3-m6-b-first");
    const newer = await newerDraft(sale.projectId);
    const b = await hold("targetContracts.approvedPlansBoundTo", () => confirm(newer));
    const exp = tracked(execute(pw, sale));
    await waiterOn(b.pid, exp.settled, "ExecuteProject behind CMD019");
    b.release();
    const [confirmed, refused] = await Promise.all([b.actor.promise, exp.promise]);
    assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [], "no job on the superseded contract");
    assert.equal(confirmed.status, 200);
    assert.equal(outcome(w, refused), "422 TARGET_STALE -");
    assert.equal((await w.row<{ state: string }>("commercial_authorizations", "authorization_id = $1", [sale.authorizationId]))?.state, "ACTIVE", "nothing consumed");
  }
});

/** A VALIDATED plan of a fresh project bound to its one current contract, not yet approved. */
async function validatedPlan(seed: string): Promise<PlanFixture> {
  const { projectId } = await w.project(w.A, w.clientA);
  return w.approvable(w.A, projectId, seed);
}
async function approve(plan: PlanFixture): Promise<Reply> {
  const proof = await w.stepUp(w.approver);
  return call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, key: freshKey("t3-approve"), body: approvalBodyOf(plan, proof) });
}

test("R2-026: RACE ApprovePlan against CMD019, both orders: every APPROVED plan on a superseded contract has its re-check plan, or the approval was refused", async () => {
  // order 1: ApprovePlan holds the plan row and the target's shared half; B waits; B's bound-plans read sees the approval and re-checks it
  {
    const plan = await validatedPlan("t3-m8-approve-first");
    const newer = await newerDraft(plan.projectId);
    const ap = await hold("targetContracts.lockCurrentByHash", () => approve(plan));
    const b = tracked(confirm(newer));
    await waiterOn(ap.pid, b.settled, "CMD019 behind ApprovePlan");
    ap.release();
    const [approved, confirmed] = await Promise.all([ap.actor.promise, b.promise]);
    assert.equal((await w.row<{ state: string }>("plans", "plan_id = $1", [plan.planId]))?.state, "APPROVED");
    assert.equal(await rechecksOf(plan.planId), 1, "the APPROVED plan on the superseded contract has its re-check plan");
    assert.deepEqual([approved.status, confirmed.status], [201, 200]);
    assert.deepEqual(completed<TargetContractView>(confirmed, 200).data.recheckPlanIds?.length, 1);
  }
  // order 2: B holds; ApprovePlan waits on the plan row, then re-reads its target superseded
  {
    const plan = await validatedPlan("t3-m8-b-first");
    const newer = await newerDraft(plan.projectId);
    const b = await hold("targetContracts.approvedPlansBoundTo", () => confirm(newer));
    const ap = tracked(approve(plan));
    await waiterOn(b.pid, ap.settled, "ApprovePlan behind CMD019");
    b.release();
    const [confirmed, refused] = await Promise.all([b.actor.promise, ap.promise]);
    assert.notEqual((await w.row<{ state: string }>("plans", "plan_id = $1", [plan.planId]))?.state, "APPROVED", "no approval on a superseded contract");
    assert.equal(await rechecksOf(plan.planId), 0);
    assert.equal(confirmed.status, 200);
    assert.equal(outcome(w, refused), "422 TARGET_STALE -");
  }
});

test("R2-026: RACE RevisePlan against CMD019, both orders", async () => {
  const revise = async (plan: PlanFixture): Promise<Reply> =>
    call(w, { url: routes.revisePlan(plan.planId), token: w.operator.token, key: freshKey("t3-revise"), body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "AGENCY_DECISION" }) } });
  const successorsOf = (planId: string): Promise<number> => w.count("plans", "supersedes_plan_id = $1", [planId]);
  // order 1: RevisePlan holds the predecessor row and the target's shared half; B waits; the successor is born on the old contract first
  {
    const plan = await validatedPlan("t3-m12-revise-first");
    const newer = await newerDraft(plan.projectId);
    const rv = await hold("targetContracts.lockCurrentByHash", () => revise(plan));
    const b = tracked(confirm(newer));
    await waiterOn(rv.pid, b.settled, "CMD019 behind RevisePlan");
    rv.release();
    const [revised, confirmed] = await Promise.all([rv.actor.promise, b.promise]);
    assert.equal(await successorsOf(plan.planId), 1, "the revision was born before the supersession");
    const successor = await w.row<{ state: string; target_contract_hash: string }>("plans", "supersedes_plan_id = $1", [plan.planId]);
    assert.notEqual(successor?.state, "APPROVED", "never approvable without a validation and an approval that re-read the target");
    assert.deepEqual([label(revised), label(confirmed)], ["201", "200"]);
  }
  // order 2: B holds; RevisePlan waits on the predecessor row, then refuses on the superseded target
  {
    const plan = await validatedPlan("t3-m12-b-first");
    const newer = await newerDraft(plan.projectId);
    const b = await hold("targetContracts.approvedPlansBoundTo", () => confirm(newer));
    const rv = tracked(revise(plan));
    await waiterOn(b.pid, rv.settled, "RevisePlan behind CMD019");
    b.release();
    const [confirmed, refused] = await Promise.all([b.actor.promise, rv.promise]);
    assert.equal(await successorsOf(plan.planId), 0, "no revision on a superseded contract");
    assert.equal(confirmed.status, 200);
    assert.equal(outcome(w, refused), "422 TARGET_STALE -");
  }
});

test("R2-026: RACE two confirms of two newer contracts of one project at the project row: exactly one current, the later observation wins", async () => {
  for (const order of ["earlier first", "later first"] as const) {
    const plan = await validatedPlan(`t3-m14-${order}`);
    const old = await currentOf(plan.projectId);
    const earlier = await newerDraft(plan.projectId, 1);
    const later = await newerDraft(plan.projectId, 2);
    const [first, second] = order === "earlier first" ? [earlier, later] : [later, earlier];
    const b1 = await hold("targetContracts.approvedPlansBoundTo", () => confirm(first));
    const b2 = tracked(confirm(second));
    await waiterOn(b1.pid, b2.settled, `${order}: the second confirmation behind the first`);
    b1.release();
    const [r1, r2] = await Promise.all([b1.actor.promise, b2.promise]);
    // the forbidden effect first: never two current contracts
    assert.equal(await currentCount(plan.projectId), 1, `${order}: exactly one current`);
    assert.equal((await currentOf(plan.projectId)).contractId, later.draft.contractId, `${order}: the later observation wins`);
    assert.ok((await contractRow(old.contractId))?.superseded_at instanceof Date);
    if (order === "earlier first") {
      assert.deepEqual([r1.status, r2.status], [200, 200], "the later one supersedes the earlier one");
      assert.equal((await contractRow(earlier.draft.contractId))?.superseded_by_contract_id, later.draft.contractId);
    } else {
      assert.equal(r1.status, 200);
      assert.equal(outcome(w, r2), "422 TARGET_STALE -", "an older observation never supersedes a newer one");
      assert.equal((await contractRow(earlier.draft.contractId))?.confirmed_at, null);
    }
  }
});

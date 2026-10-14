// B05 lane L3t (docs/design/B05-cores.md D5-20; migration 0066 provisional): every authority deadline 0023 judges against the
// transaction's start (kauro.server_now()) is judged again at COMMIT against kauro.effect_now() by a DEFERRABLE INITIALLY DEFERRED
// constraint trigger. Each scenario runs its work at a test-clock offset that puts the database clock 1.5 s before the instant, so the
// BEFORE checks pass, then holds the transaction open (or holds the last lock wait, L18) until the shifted clock is past the instant,
// and COMMITs: the refusal is the COMMIT's (the work itself completed) and nothing it wrote remains. An EXPIRED edge is never early: an
// early instant only refuses, in its statement (MONOTONE, the BEFORE checks of 0023 :183 and :486). No sleep orders anything: the
// clock is polled on the oracle and the lock wait is observed in pg_stat_activity (mustWait).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { AUDIT_POLICY, type AgencyId, type AuditStepId, type EventProvenance, type PlanBody, type PlanId, type PlanValidationId, type UserId } from "@kauro/domain";
import { FaultPoints, crashableFactory, crashedAt, mustWait } from "../src/testing/index.js";
import { controlOf } from "../src/testing/execution-fixtures.js";
import { clockAt } from "../src/testing/source-lifecycle.js";
import { bindCommerce, type CommerceContext } from "./commerce-support.js";
import { closeDispatchEnv, freshPool, interpretingRun, money, openDispatchEnv, preparedAudit, rawStore, withConnections, type DispatchEnv, type Run } from "./b05-dispatch-support.js";
import { PgEventPublisher } from "../src/event-publisher.js";
import { clock, ids, planBody, sha, validationReceipt } from "./support.js";

let env: DispatchEnv;
before(async () => {
  env = await openDispatchEnv();
});
after(async () => {
  await closeDispatchEnv(env);
});

// --- helpers -------------------------------------------------------------------------------------------------------------------------

function pgErr(e: unknown): { code?: string; message?: string } {
  const x = e as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (x !== null && typeof x === "object" && typeof x.code === "string" && /^[0-9A-Z]{5}$/.test(x.code)) return { code: x.code, message: String(x.message) };
  return x !== null && typeof x === "object" && x.cause !== undefined ? pgErr(x.cause) : {};
}

/** The test clock offset that puts the database clock `beforeMs` before `instant` now. */
const offsetBefore = (instant: Date, beforeMs: number): number => (instant.getTime() - beforeMs - Date.now()) / 1000;
const at = (offsetSeconds: number): Date => new Date(Date.now() + offsetSeconds * 1000);

/** Polls the oracle (bounded) until the database clock shifted by `offsetSeconds` is at or past `instant` (+250 ms). */
async function untilPast(offsetSeconds: number, instant: Date): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await env.h.oracle.query("SELECT clock_timestamp() + make_interval(secs => $1) >= $2::timestamptz + interval '250 milliseconds' AS past", [offsetSeconds, instant]);
    if (r.rows[0].past === true) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`the shifted clock never reached ${instant.toISOString()}`);
}

/** One transaction on a raw connection under `ctx` at the clock `when`, committed; rolled back and rethrown on error. */
async function unitAt<T>(c: Client, ctx: CommerceContext, when: Date, work: (c: Client) => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await bindCommerce(c, ctx);
    await clockAt(c, when);
    const out = await work(c);
    const r = await c.query("COMMIT");
    if (r.command !== "COMMIT") throw new Error(`COMMIT was answered ${r.command}`);
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

interface Crossing {
  readonly outcome: PromiseSettledResult<unknown>;
  /** The work itself completed (every statement passed its BEFORE checks): a refusal is the COMMIT's. */
  readonly workDone: boolean;
}

/** `work` run 1.5 s before `instant` on the database clock, its transaction held open until the clock is past it, then COMMITted. */
async function crossing(instant: Date, ctx: CommerceContext, work: (c: Client) => Promise<unknown>, role: "kauro_control_test" | "kauro_app_test" = "kauro_control_test"): Promise<Crossing> {
  return withConnections(
    env,
    1,
    async ([c]) => {
      const offset = offsetBefore(instant, 1_500);
      let workDone = false;
      const [outcome] = await Promise.allSettled([
        unitAt(c!, ctx, at(offset), async (x) => {
          const out = await work(x);
          workDone = true;
          await untilPast(offset, instant);
          return out;
        }),
      ]);
      return { outcome: outcome!, workDone };
    },
    role,
  );
}

/** The crossing completed its work and was refused at COMMIT with `code`, by the message naming the COMMIT and `names`. */
function refusedAtCommit(r: Crossing, code: string, names: string, label: string): void {
  assert.equal(r.outcome.status, "rejected", `${label}: refused`);
  const p = pgErr((r.outcome as PromiseRejectedResult).reason);
  assert.equal(r.workDone, true, `${label}: every statement passed its BEFORE check (${p.message})`);
  assert.equal(p.code, code, `${label}: ${p.message}`);
  assert.ok(p.message?.includes("before the COMMIT") && p.message.includes(names), `${label}: refused at COMMIT by the deferred judge (${p.message})`);
}

/** The domain event a version of the store's writes carries (PgAuditStore.emit's publish; the store's own payloads). */
async function publish(c: Client, aggregateKind: string, aggregateId: string, aggregateVersion: number, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await new PgEventPublisher(c, ids, clock).publish({ aggregateKind, aggregateId, aggregateVersion, agencyId: payload["agencyId"], eventType, actor: { kind: "SERVICE", serviceId: "control-plane" }, causationId: ids.next(), correlationId: ids.next(), payload } as never);
}

const actor = (userId: string) => ({ kind: "USER", userId }) as EventProvenance["actor"];
const control = (agencyId: string): CommerceContext => ({ agencyId });
const platform: CommerceContext = {};

async function auditRow(auditId: string): Promise<{ state: string; version: number; deadline: Date; interpretation: Date | null; grantId: string }> {
  const r = await env.h.oracle.query("SELECT state, version::int AS version, absolute_deadline_at AS deadline, interpretation_deadline_at AS interpretation, grant_id AS \"grantId\" FROM kauro.audits WHERE audit_id = $1", [auditId]);
  return r.rows[0];
}

async function grantRow(grantId: string): Promise<{ state: string; version: number } | undefined> {
  return (await env.h.oracle.query("SELECT state, version::int AS version FROM kauro.cost_grants WHERE grant_id = $1", [grantId])).rows[0];
}

/** A fresh agency's audit PROFILING with its PROFILE step claimed (fence 1), funded from `pool`. */
async function profiling(tag: string, pool: string): Promise<{ ag: Awaited<ReturnType<typeof preparedAudit>>["ag"]; auditId: string; stepId: string }> {
  const { h } = env;
  const { ag, input } = await preparedAudit(env, tag);
  const started = await h.audit.run(h.tenant(ag.agencyId as AgencyId, ag.ownerUserId as UserId), (uow) => uow.audits.startAudit(input));
  assert.equal(started.pool.grantId, pool);
  const claim = await h.audit.run(controlOf(ag.agencyId), (uow) => uow.audits.claimStep(input.auditId, "PROFILE", ids.next() as AuditStepId));
  return { ag, auditId: input.auditId, stepId: claim.step.stepId };
}

/** The run's audit VALIDATING (version 4) with its VALIDATE step claimed. */
async function validating(run: Run): Promise<{ validateStepId: string }> {
  const { h } = env;
  await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.recordStep(run.stepId as AuditStepId, { outcome: "COMPILED", evidenceHash: sha(`${run.auditId}-compiled`), evidenceClass: "SIMULATED" }));
  const moved = await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.advanceAudit(run.auditId as never, 3, { to: "VALIDATING" }));
  assert.equal(moved.kind, "APPLIED");
  const validate = await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.claimStep(run.auditId as never, "VALIDATE", ids.next() as AuditStepId));
  return { validateStepId: validate.step.stepId };
}

// --- L20: the audit's deadlines at COMMIT (0023 :491, :584, :598, :635, :693) --------------------------------------------------------

test("L20 EXPIRY (deadline at COMMIT): a model task planned, a step claimed, a step result recorded, the VALIDATING edge and DRAFT_READY, each begun before the audit's deadline in a transaction that commits after it, are refused at COMMIT (KA081) and leave nothing; an EXPIRED edge before the deadline is refused in its statement and commits after it", async () => {
  const { h } = env;
  const pool = await freshPool(env);

  // :693 a model task planned before the interpretation deadline
  {
    const run = await interpretingRun(env, "l20-task", pool);
    const deadline = (await auditRow(run.auditId)).interpretation!;
    const taskId = ids.next();
    const r = await crossing(deadline, control(run.ag.agencyId), (x) =>
      rawStore(x).createModelTask({
        modelTaskId: taskId as never,
        auditId: run.auditId as never,
        stepFence: run.stepFence,
        taskKey: sha(`l20-task-${taskId}`),
        candidateManifestHash: run.candidateManifestHash as never,
        policyHash: sha("model-policy") as never,
        minimizedRequestHash: sha(`l20-min-${taskId}`) as never,
        providerProfileId: ids.next() as never,
        maximumCostCents: 40n,
      }),
    );
    refusedAtCommit(r, "KA081", "interpretation deadline", "model task");
    assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.model_tasks WHERE model_task_id = $1", [taskId])).rows[0].n, 0, "no task");
  }

  // :584 a step claimed and :598 a step result recorded before the absolute deadline
  {
    const p = await profiling("l20-claim", pool);
    const { deadline, version } = await auditRow(p.auditId);
    const stepId = ids.next();
    const claim = await crossing(deadline, control(p.ag.agencyId), (x) => rawStore(x).claimStep(p.auditId as never, "PROFILE", stepId as AuditStepId));
    refusedAtCommit(claim, "KA081", "PROFILE step's claim", "step claim");
    assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.audit_steps WHERE step_id = $1", [stepId])).rows[0].n, 0, "no step");
    const result = await crossing(deadline, control(p.ag.agencyId), (x) => rawStore(x).recordStep(p.stepId as AuditStepId, { outcome: "COMPLETED", evidenceHash: sha(`${p.auditId}-profile`) as never, evidenceClass: "SIMULATED" }));
    refusedAtCommit(result, "KA081", "PROFILE step's result", "step result");
    assert.equal((await h.oracle.query("SELECT outcome FROM kauro.audit_steps WHERE step_id = $1", [p.stepId])).rows[0].outcome, null, "no result");
    assert.equal((await auditRow(p.auditId)).version, version, "the audit unchanged");

    // :486 EXPIRED is never early (MONOTONE): refused in its statement before the deadline, committed after it
    const early = await crossing(deadline, control(p.ag.agencyId), (x) => rawStore(x).advanceAudit(p.auditId as never, version, { to: "EXPIRED", reasonCode: "ABSOLUTE_DEADLINE_REACHED" }));
    assert.equal(early.outcome.status, "rejected");
    assert.equal(early.workDone, false, "refused in its statement");
    assert.equal(pgErr((early.outcome as PromiseRejectedResult).reason).code, "KA081");
    const late = await withConnections(env, 1, ([c]) => unitAt(c!, control(p.ag.agencyId), new Date(deadline.getTime() + 1_000), (x) => rawStore(x).advanceAudit(p.auditId as never, version, { to: "EXPIRED", reasonCode: "ABSOLUTE_DEADLINE_REACHED" })));
    assert.equal(late.kind, "APPLIED");
    assert.equal((await auditRow(p.auditId)).state, "EXPIRED");
  }

  // :491 the VALIDATING edge and :635 DRAFT_READY before the absolute deadline
  {
    const run = await interpretingRun(env, "l20-edge", pool);
    const { deadline } = await auditRow(run.auditId);
    await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.recordStep(run.stepId as AuditStepId, { outcome: "COMPILED", evidenceHash: sha(`${run.auditId}-compiled`), evidenceClass: "SIMULATED" }));
    const edge = await crossing(deadline, control(run.ag.agencyId), (x) => rawStore(x).advanceAudit(run.auditId as never, 3, { to: "VALIDATING" }));
    refusedAtCommit(edge, "KA081", "VALIDATING edge", "VALIDATING edge");
    assert.deepEqual([(await auditRow(run.auditId)).state, (await auditRow(run.auditId)).version], ["INTERPRETING", 3], "the audit unchanged");
  }
  {
    const run = await interpretingRun(env, "l20-draft", pool);
    const { deadline } = await auditRow(run.auditId);
    const { validateStepId } = await validating(run);
    const draftId = ids.next() as PlanId;
    const body = planBody(run.revisionHash, run.targetContractHash, sha("policy")) as unknown as PlanBody;
    const bodyHash = sha(`draft-body-${draftId}`);
    const draft = await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.recordSystemDraft(run.auditId as never, { planId: draftId, validationId: ids.next() as PlanValidationId, body, bodyHash: bodyHash as never }));
    await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.recordStep(validateStepId as AuditStepId, { outcome: "VALID", evidenceHash: sha(`${run.auditId}-valid`), evidenceClass: "SIMULATED" }));
    const receiptHash = sha(`receipt-${draftId}`);
    await validationReceipt(env.validator, run.ag, { planId: draftId, bodyHash, revisionHash: run.revisionHash, targetContractHash: run.targetContractHash }, receiptHash, "VALID");
    await h.audit.run(controlOf(run.ag.agencyId), (uow) => uow.audits.settleValidation(draft.validation.validationId, { result: "VALID", receiptHash: receiptHash as never }));
    const ready = await crossing(deadline, control(run.ag.agencyId), (x) => rawStore(x).advanceAudit(run.auditId as never, 4, { to: "DRAFT_READY", draftPlanId: draftId }));
    refusedAtCommit(ready, "KA081", "DRAFT_READY edge", "DRAFT_READY");
    assert.deepEqual([(await auditRow(run.auditId)).state, (await auditRow(run.auditId)).version], ["VALIDATING", 4], "the audit unchanged");
  }
});

// --- L18: a grant's expiry at COMMIT (0023 :145, :169, :178, :218, :435) -----------------------------------------------------------
// These scenarios fund short platform pools, so they run after every scenario that draws an audit from freshPool.

test("L18 EXPIRY (grant expiry at COMMIT): a platform grant born, authorized from PREPARED and re-authorized from EXHAUSTED before its expiry in a transaction that commits after it is refused at COMMIT (KA083) and leaves the grant as it was; EXPIRED before the expiry is refused in its statement and commits after it", async () => {
  const { h } = env;
  const priceProfile = sha("price-profile-l18");
  // :145 birth
  {
    const instant = new Date(Date.now() + 60_000);
    const grantId = ids.next();
    const r = await crossing(instant, platform, (x) =>
      x.query("INSERT INTO kauro.cost_grants (grant_id, grant_kind, currency, ceiling_cents, price_profile_hash, expires_at) VALUES ($1, 'PLATFORM_MONTHLY', 'USD', 1000, $2, $3)", [grantId, priceProfile, instant]),
    );
    refusedAtCommit(r, "KA083", "birth", "grant birth");
    assert.equal(await grantRow(grantId), undefined, "no grant");
  }
  // :169 PREPARED -> AUTHORIZED
  {
    const instant = new Date(Date.now() + 60_000);
    const grantId = ids.next();
    await withConnections(env, 1, ([c]) => unitAt(c!, platform, new Date(), (x) => x.query("INSERT INTO kauro.cost_grants (grant_id, grant_kind, currency, ceiling_cents, price_profile_hash, expires_at) VALUES ($1, 'PLATFORM_MONTHLY', 'USD', 1000, $2, $3)", [grantId, priceProfile, instant])));
    const r = await crossing(instant, platform, (x) => x.query("UPDATE kauro.cost_grants SET version = 2, state = 'AUTHORIZED', authorization_ref = $2 WHERE grant_id = $1", [grantId, ids.next()]));
    refusedAtCommit(r, "KA083", "authorization", "PREPARED -> AUTHORIZED");
    assert.deepEqual(await grantRow(grantId), { state: "PREPARED", version: 1 });
  }
  // :178 EXHAUSTED -> AUTHORIZED, and :183 EXPIRED never early (MONOTONE)
  {
    const instant = new Date(Date.now() + 60_000);
    const grantId = ids.next();
    await withConnections(env, 1, ([c]) =>
      unitAt(c!, platform, new Date(), async (x) => {
        await x.query("INSERT INTO kauro.cost_grants (grant_id, grant_kind, currency, ceiling_cents, price_profile_hash, expires_at) VALUES ($1, 'PLATFORM_MONTHLY', 'USD', 1000, $2, $3)", [grantId, priceProfile, instant]);
        await x.query("UPDATE kauro.cost_grants SET version = 2, state = 'AUTHORIZED', authorization_ref = $2 WHERE grant_id = $1", [grantId, ids.next()]);
        await x.query("UPDATE kauro.cost_grants SET version = 3, state = 'EXHAUSTED' WHERE grant_id = $1", [grantId]);
      }),
    );
    const r = await crossing(instant, platform, (x) => x.query("UPDATE kauro.cost_grants SET version = 4, state = 'AUTHORIZED' WHERE grant_id = $1", [grantId]));
    refusedAtCommit(r, "KA083", "authorization", "EXHAUSTED -> AUTHORIZED");
    assert.deepEqual(await grantRow(grantId), { state: "EXHAUSTED", version: 3 });
    const early = await crossing(instant, platform, (x) => x.query("UPDATE kauro.cost_grants SET version = 4, state = 'EXPIRED' WHERE grant_id = $1", [grantId]));
    assert.equal(early.outcome.status, "rejected");
    assert.equal(early.workDone, false, "refused in its statement");
    assert.equal(pgErr((early.outcome as PromiseRejectedResult).reason).code, "KA081");
    await withConnections(env, 1, ([c]) => unitAt(c!, platform, new Date(instant.getTime() + 1_000), (x) => x.query("UPDATE kauro.cost_grants SET version = 4, state = 'EXPIRED' WHERE grant_id = $1", [grantId])));
    assert.deepEqual(await grantRow(grantId), { state: "EXPIRED", version: 4 });
  }

  // :145/:218/:435 StartAudit's carve whose last lock wait (the pools FOR UPDATE) is held across the pool's expiry by another agency's
  // StartAudit paused at its FaultPoint and then crashed: the waiter's statements pass on its transaction's instant and its COMMIT is
  // refused (KA083) with no grant, no audit and the pool's reserved cents unchanged
  {
    const pool = await freshPool(env, 5_000n, 900);
    const instant = (await h.oracle.query("SELECT expires_at AS at FROM kauro.cost_grants WHERE grant_id = $1", [pool])).rows[0].at as Date;
    const holder = await preparedAudit(env, "l18-holder");
    const waiter = await preparedAudit(env, "l18-waiter");
    const points = new FaultPoints();
    const pause = points.pause("l18.before-commit");
    const held = crashableFactory(h.audit, points, "l18").run(h.tenant(holder.ag.agencyId as AgencyId, holder.ag.ownerUserId as UserId), (uow) => uow.audits.startAudit(holder.input));
    await pause.reachedBy(held);
    const holderPid = (await h.oracle.query("SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND application_name IN ('kauro-test-control', 'kauro-test-api') AND pid <> pg_backend_pid()")).rows;
    assert.equal(holderPid.length, 1, "exactly one paused product transaction");
    const before = await money(env, pool);
    const offset = offsetBefore(instant, 1_500);
    let workDone = false;
    const outcome = await withConnections(
      env,
      1,
      async ([c]) => {
        const waiting = await mustWait(
          h.oracle,
          { waiter: c!, holder: holderPid[0].pid as number },
          (cc) =>
            unitAt(cc, { agencyId: waiter.ag.agencyId, userId: waiter.ag.ownerUserId }, at(offset), async (x) => {
              const out = await rawStore(x, actor(waiter.ag.ownerUserId)).startAudit(waiter.input);
              workDone = true;
              return out;
            }),
          "l18: StartAudit's pool lock wait across the pool's expiry",
        );
        await untilPast(offset, instant);
        pause.crash();
        await assert.rejects(held, crashedAt("l18.before-commit"));
        return waiting.pending;
      },
      "kauro_app_test",
    );
    refusedAtCommit({ outcome, workDone }, "KA083", "birth", "StartAudit across the pool's expiry");
    assert.equal(await grantRow(waiter.input.grantId), undefined, "no AUDIT grant");
    assert.equal(await grantRow(holder.input.grantId), undefined, "the crashed holder left nothing");
    assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.audits WHERE audit_id = ANY($1)", [[waiter.input.auditId, holder.input.auditId]])).rows[0].n, 0, "no audit");
    assert.deepEqual(await money(env, pool), before, "the pool's reserved cents unchanged");
  }

  // :435 an audit born on an AUDIT grant authorized in an earlier transaction, in a transaction that commits after the grant expired
  // (its own judge alone: no grant row changes in it). The grant expires with its two-minute pool, the earliest live one.
  {
    const pool = await freshPool(env, 5_000n, 120);
    const { ag, input } = await preparedAudit(env, "l18-audit-birth");
    const tenant = { agencyId: ag.agencyId, userId: ag.ownerUserId };
    await withConnections(
      env,
      1,
      ([c]) =>
        unitAt(c!, tenant, new Date(), async (x) => {
          await x.query("INSERT INTO kauro.cost_grants (grant_id, agency_id, grant_kind, pool_grant_id, currency, ceiling_cents, price_profile_hash) VALUES ($1, $2, 'AUDIT', $3, $4, $5, $6)", [input.grantId, input.agencyId, pool, AUDIT_POLICY.currency, input.ceilingCents.toString(), input.priceProfileHash]);
          await publish(x, "cost_grant", input.grantId, 1, "cost_grant.prepared.v1", { grantId: input.grantId, agencyId: input.agencyId, grantKind: "AUDIT", poolGrantId: pool, ceilingCents: Number(input.ceilingCents), state: "PREPARED" });
          await x.query("UPDATE kauro.cost_grants SET version = version + 1, state = 'AUTHORIZED', authorization_ref = pool_grant_id WHERE grant_id = $1", [input.grantId]);
          await publish(x, "cost_grant", input.grantId, 2, "cost_grant.authorized.v1", { grantId: input.grantId, agencyId: input.agencyId, grantKind: "AUDIT", poolGrantId: pool, ceilingCents: Number(input.ceilingCents), previousState: "PREPARED", state: "AUTHORIZED" });
        }),
      "kauro_app_test",
    );
    const instant = (await h.oracle.query("SELECT expires_at AS at FROM kauro.cost_grants WHERE grant_id = $1", [input.grantId])).rows[0].at as Date;
    const r = await crossing(
      instant,
      tenant,
      async (x) => {
        await x.query(
          "INSERT INTO kauro.audits (audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id, target_contract_hash, audit_policy_version, requested_by_membership_id, grant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [input.auditId, input.agencyId, input.projectId, input.revisionId, input.revisionHash, input.targetContractId, input.targetContractHash, input.auditPolicyVersion, input.requestedByMembershipId, input.grantId],
        );
        const { auditId, agencyId, projectId, revisionId, revisionHash, targetContractId, targetContractHash, grantId } = input;
        await publish(x, "audit", auditId, 1, "audit.queued.v1", { auditId, agencyId, projectId, revisionId, revisionHash, targetContractId, targetContractHash, grantId, state: "QUEUED" });
      },
      "kauro_app_test",
    );
    refusedAtCommit(r, "KA083", "the grant of audit", "audit birth");
    assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.audits WHERE audit_id = $1", [input.auditId])).rows[0].n, 0, "no audit");
  }
});

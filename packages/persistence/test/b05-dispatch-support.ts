// The environment of the B05 dispatch-settlement tests (docs/design/B05-cores.md D5-11, D5-18, D5-19, D5-19b; LOCK-B05-1): one real
// PostgreSQL 17 cluster per test file, the control plane's login as raw connections, and one fresh agency per scenario (one live audit
// per agency), its audit INTERPRETING with an INTERPRET step claimed, funded from a platform pool of its own. StartAudit funds an audit
// from the AUTHORIZED unexpired pool with the earliest expiry, so every pool this module funds expires earlier than the ones before
// it: the scenario's pool is the one its audits draw on. Model tasks are admitted with a core admission (runId, reservationId,
// requestKey, maxChargeMicros) through beginDispatch, the product admission (store.ts beginDispatch).
import assert from "node:assert/strict";
import type { Client } from "pg";
import type { Id } from "@kauro/contracts";
import {
  centsOfMicros,
  type AgencyId,
  type AuditStepId,
  type CoreAdmission,
  type EventProvenance,
  type LeaseOwnerId,
  type ModelTaskId,
  type NewAudit,
  type RequestId,
  type UserId,
} from "@kauro/domain";
import { PgAuditStore } from "../src/audit/store.js";
import { PgEventPublisher } from "../src/event-publisher.js";
import { fundPlatformPool } from "../src/testing/audit-fixtures.js";
import { controlOf } from "../src/testing/execution-fixtures.js";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { PgRequestJournal } from "../src/request-journal.js";
import { openConnection } from "../src/testing/index.js";
import { newAudit } from "./audit-support.js";
import { clock, ids, project, sealedSource, sha, targetContract } from "./support.js";

export interface DispatchEnv {
  readonly h: Harness;
  readonly app: Client;
  readonly control: Client;
  readonly validator: Client;
  readonly capability: string;
}

export async function openDispatchEnv(options: { readonly migrationsDir?: string } = {}): Promise<DispatchEnv> {
  const h = await start(options);
  const app = await h.pg.connect("kauro_app_test");
  const control = await h.pg.connect("kauro_control_test");
  const validator = await h.pg.connect("kauro_validator_test");
  const capability = await h.offeredCapability("CLEAN");
  return { h, app, control, validator, capability };
}

export async function closeDispatchEnv(env: DispatchEnv): Promise<void> {
  for (const c of [env.app, env.control, env.validator]) await c.end();
  await env.h.stop();
}

let poolSeq = 0;
/**
 * A platform pool expiring earlier than every AUTHORIZED unexpired pool of the cluster (twenty days out, an hour less each time; a
 * minute before the earliest live one when a test funded a short pool), so StartAudit draws on it. `expiresInSeconds` asks for a short
 * pool explicitly (it must still be the earliest).
 */
export async function freshPool(env: DispatchEnv, ceilingCents = 5_000n, expiresInSeconds?: number): Promise<string> {
  poolSeq += 1;
  const r = await env.h.oracle.query<{ s: number | null }>(
    "SELECT extract(epoch FROM min(expires_at) - kauro.server_now())::float8 AS s FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED' AND expires_at > kauro.server_now()",
  );
  const earliest = r.rows[0]?.s ?? null;
  const seconds = expiresInSeconds ?? Math.min(20 * 86_400 - poolSeq * 3_600, earliest === null ? Infinity : Math.floor(earliest) - 60);
  assert.ok(seconds > 60 && (earliest === null || seconds < earliest), `a pool expiring in ${seconds} s is the earliest (the earliest live one expires in ${earliest} s)`);
  return fundPlatformPool(env.control, { ceilingCents, expiresInSeconds: seconds });
}

/** One audit INTERPRETING with its INTERPRET step claimed, on a fresh agency, funded from `pool` (its AUDIT grant). */
export interface Run {
  readonly ag: AgencyFixture;
  readonly auditId: string;
  readonly grantId: string;
  readonly pool: string;
  readonly stepFence: number;
  readonly stepId: string;
  readonly candidateManifestHash: string;
  /** The audited subject's hashes (a system draft's plan body and its receipt name them). */
  readonly revisionHash: string;
  readonly targetContractHash: string;
}

let agencySeq = 0;
/**
 * A fresh agency (or `existing`, for a second audit of one agency once its first is no longer live) with a CLEAN project sealed an
 * hour ago and a confirmed target: StartAudit's input, not yet started.
 */
export async function preparedAudit(env: DispatchEnv, tag: string, existing?: AgencyFixture): Promise<{ readonly ag: AgencyFixture; readonly input: NewAudit }> {
  const { h } = env;
  agencySeq += 1;
  const name = `${tag}-${agencySeq}`;
  const ag = existing ?? (await h.createAgency(await h.person(`${name}-owner`), name));
  const endClient = await h.endClient(ag, await h.processingAuthority(ag), `${name} client`);
  const { projectId } = await project(env.app, ag, endClient, env.capability, "CLEAN");
  const source = await sealedSource({ app: env.app, control: env.control }, ag, projectId, name, "SEALED", new Date(Date.now() - 3_600_000));
  const target = await targetContract(env.app, ag, projectId, name);
  const subject = { projectId, revisionId: source.revisionId, revisionHash: source.manifestHash, contractId: target.contractId, targetContractHash: target.bodyHash };
  return { ag, input: newAudit(ag, subject) };
}

export async function interpretingRun(env: DispatchEnv, tag: string, pool: string, existing?: AgencyFixture): Promise<Run> {
  const { h } = env;
  const { ag, input } = await preparedAudit(env, tag, existing);
  const name = `${tag}-${input.auditId}`;
  const started = await h.audit.run(h.tenant(ag.agencyId as AgencyId, ag.ownerUserId as UserId), (uow) => uow.audits.startAudit(input));
  assert.equal(started.pool.grantId, pool, "the scenario's pool funds its audit (the earliest expiry)");
  const profile = await h.audit.run(controlOf(ag.agencyId), (uow) => uow.audits.claimStep(input.auditId, "PROFILE", ids.next() as AuditStepId));
  await h.audit.run(controlOf(ag.agencyId), (uow) => uow.audits.recordStep(profile.step.stepId, { outcome: "COMPLETED", evidenceHash: sha(`${name}-profile`), evidenceClass: "SIMULATED" }));
  const candidateManifestHash = sha(`${name}-candidates`);
  const advanced = await h.audit.run(controlOf(ag.agencyId), (uow) => uow.audits.advanceAudit(input.auditId, 2, { to: "INTERPRETING", profileEvidenceHash: sha(`${name}-profile`), candidateManifestHash }));
  assert.equal(advanced.kind, "APPLIED");
  const interpret = await h.audit.run(controlOf(ag.agencyId), (uow) => uow.audits.claimStep(input.auditId, "INTERPRET", ids.next() as AuditStepId));
  return { ag, auditId: input.auditId, grantId: input.grantId, pool, stepFence: interpret.step.fence, stepId: interpret.step.stepId, candidateManifestHash, revisionHash: input.revisionHash, targetContractHash: input.targetContractHash };
}

/** One model task of the run admitted through beginDispatch with a core admission of `maxChargeMicros`. */
export interface Admission {
  readonly run: Run;
  readonly taskId: ModelTaskId;
  readonly owner: LeaseOwnerId;
  readonly requestId: RequestId;
  readonly core: CoreAdmission;
  readonly reservedCents: bigint;
}

let taskSeq = 0;
/** The model task and the dispatch intent of one admission, not yet admitted (the inputs of createModelTask and beginDispatch). */
export function admissionOf(run: Run, maxChargeMicros: bigint): Admission {
  taskSeq += 1;
  return {
    run,
    taskId: ids.next() as ModelTaskId,
    owner: ids.next() as LeaseOwnerId,
    requestId: ids.next() as RequestId,
    core: { runId: run.auditId as Id, reservationId: `reservation-${taskSeq}`, requestKey: sha(`request-key-${taskSeq}`), maxChargeMicros },
    reservedCents: centsOfMicros(maxChargeMicros),
  };
}

/** The product admission on any audit store: the model task, then its dispatch intent with the core admission. */
export async function admitWith(store: PgAuditStore | { createModelTask: PgAuditStore["createModelTask"]; beginDispatch: PgAuditStore["beginDispatch"] }, a: Admission): Promise<Awaited<ReturnType<PgAuditStore["beginDispatch"]>>> {
  const task = await store.createModelTask({
    modelTaskId: a.taskId,
    auditId: a.run.auditId as never,
    stepFence: a.run.stepFence,
    taskKey: sha(`task-${a.core.reservationId}`),
    candidateManifestHash: a.run.candidateManifestHash,
    policyHash: sha("model-policy"),
    minimizedRequestHash: sha(`minimized-${a.core.reservationId}`),
    providerProfileId: ids.next() as Id,
    maximumCostCents: 40n,
  });
  return store.beginDispatch(task.modelTaskId, { requestId: a.requestId, ownerId: a.owner, requestHash: sha(`request-${a.core.reservationId}`), reservedCents: a.reservedCents, stepFence: a.run.stepFence, core: a.core });
}

/** Admits through the product unit of work (controlOf the run's agency) and asserts RESERVED at fence 1. */
export async function admit(env: DispatchEnv, run: Run, maxChargeMicros: bigint): Promise<Admission> {
  const a = admissionOf(run, maxChargeMicros);
  const out = await env.h.audit.run(controlOf(run.ag.agencyId), (uow) => admitWith(uow.audits as never, a));
  assert.deepEqual(out.kind === "RESERVED" ? [out.kind, out.request.requestId, out.request.fence] : [out.kind], ["RESERVED", a.requestId, 1]);
  return a;
}

/** The DISPATCHING edge of an admitted request through the product journal. */
export async function dispatch(env: DispatchEnv, a: Admission): Promise<void> {
  const r = await env.h.audit.run(controlOf(a.run.ag.agencyId), (uow) => uow.requestJournal.markDispatching(a.requestId, 1, `provider-${a.core.reservationId}`, clock.now()));
  assert.equal(r?.state, "DISPATCHING");
}

/** The settlement IC sends for an admission. */
export function settlementOf(a: Admission, state: "COMMITTED" | "AMBIGUOUS" | "RELEASED", chargeMicros: bigint, usageKnown = true) {
  return { runId: a.core.runId, reservationId: a.core.reservationId, state, chargeMicros, usageKnown } as const;
}

/** PgAuditStore on a raw control-plane transaction (the caller binds the agency and opens the transaction). */
export function rawStore(c: Client, actor: EventProvenance["actor"] = { kind: "SERVICE", serviceId: "control-plane" } as EventProvenance["actor"]): PgAuditStore {
  const provenance = (): EventProvenance => ({ actor, causationId: ids.next() as EventProvenance["causationId"], correlationId: ids.next() as EventProvenance["correlationId"] });
  return new PgAuditStore({ db: c, ids, events: new PgEventPublisher(c, ids, clock), provenance });
}

/** The money of a grant, read by the oracle. */
export async function money(env: DispatchEnv, grantId: string): Promise<{ reserved: number; spent: number; state: string }> {
  const r = await env.h.oracle.query("SELECT reserved_cents::int AS reserved, reconciled_spend_cents::int AS spent, state FROM kauro.cost_grants WHERE grant_id = $1", [grantId]);
  assert.ok(r.rows[0], `grant ${grantId}`);
  return r.rows[0];
}

/** A request's journal and settlement columns, read by the oracle. */
export async function requestRow(env: DispatchEnv, requestId: string): Promise<{ state: string; usage: string; actual: number | null; settlement: string | null; charge: string | null; evidence: string | null }> {
  const r = await env.h.oracle.query(
    "SELECT state, usage_state AS usage, actual_cents::int AS actual, settlement_state AS settlement, charge_micros::text AS charge, non_acceptance_evidence AS evidence FROM kauro.request_journal WHERE request_id = $1",
    [requestId],
  );
  assert.ok(r.rows[0], `request ${requestId}`);
  return r.rows[0];
}

/** The pool's liabilities: request, excess in micros, state. */
export async function liabilities(env: DispatchEnv, pool: string): Promise<Array<{ request_id: string; excess: string; state: string }>> {
  return (await env.h.oracle.query("SELECT request_id, excess_micros::text AS excess, state FROM kauro.dispatch_liabilities WHERE pool_id = $1 ORDER BY opened_at, request_id", [pool])).rows;
}

/** The request journal on a raw transaction. */
export function rawJournal(c: Client): PgRequestJournal {
  return new PgRequestJournal(c);
}

/** `n` harness connections of a login (openConnection: each may be an observed waiter), ended after `fn`. */
export async function withConnections<T>(env: DispatchEnv, n: number, fn: (cs: Client[]) => Promise<T>, role: "kauro_control_test" | "kauro_app_test" = "kauro_control_test"): Promise<T> {
  const cs: Client[] = [];
  try {
    for (let i = 0; i < n; i++) cs.push(await openConnection(env.h.pg.clientConfig(role)));
    return await fn(cs);
  } finally {
    for (const c of cs) await c.end().catch(() => undefined);
  }
}

/** The pool's liability-gate setting of a transaction (kauro.liability_gate_pool / _mode; '' read as missing). */
export async function gateSetting(c: Client): Promise<{ pool: string | null; mode: string | null }> {
  const r = await c.query("SELECT nullif(current_setting('kauro.liability_gate_pool', true), '') AS pool, nullif(current_setting('kauro.liability_gate_mode', true), '') AS mode");
  return r.rows[0];
}

/**
 * The shared steps of the request side's audit tests (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §3
 * StartAudit and its grant, §6 the audit's phases, §7 the plan edges B08 performs, §12 the served routes): the routes and their call wrappers,
 * the local shapes of the wire views, the oracles over the audit, grant and plan rows and the control plane's steps between commands.
 *
 * The control plane's steps (profiling, interpretation, the decisions it needs, the system draft, a failure) are written through the product's
 * adapters in control-plane units of work bound to the agency (B07 D-CMD-15, B08 D8-ROLE-1): a request handler holds no grant on audit steps
 * (D8-ROLE-2), so these are the only way a test can move an audit past QUEUED. The platform's monthly pool is funded by the operations act of
 * @kauro/persistence/testing (Q8-1); no catalogue command funds it.
 *
 * The cores: the api is bound to B08-CORE-PORTS' labelled contract fake of the Intelligence core (SIMULATED) through `ApiAssembly.cores`, and the
 * plan services are the edition's own (the decision artifacts of migration 0021, the patch compiler over the core, the real disclosure
 * composer): the compiler the handlers call is a thin wrapper over the fake that can be told to reject the next candidate with a compiler reason.
 */
import assert from "node:assert/strict";
import type { CoreServices, PatchCompilation, PlanCompilerPort } from "@kauro/application";
import { ContractFakeIntelligenceCore } from "@kauro/application/testing/cores";
import { AUDIT_POLICY, type AuditId, type AuditStepId, type ModelTaskId, type PlanBody, type PlanId, type PlanValidationId, type ValidationReceiptId } from "@kauro/domain";
import type { PlanBody as PlanBodyOfDomain } from "@kauro/domain";
import { controlOf, fundPlatformPool } from "@kauro/persistence/testing";
import { accepted, read, readData } from "./commerce-support.js";
import { bodyHashOf, call, effectCounts, freshKey, ids, planBodyOf, sha, world, type PlanFixture, type Reply, type World } from "./support.js";
import { activate, setSessionLimit } from "./source-support.js";

// --- routes and the wire shapes ------------------------------------------------------------------------------------------------------

export const auditRoutes = {
  startAudit: (revisionId: string) => `/api/v1/revisions/${revisionId}/audits`,
  cancelAudit: (auditId: string) => `/api/v1/audits/${auditId}/cancel`,
  createPlan: (auditId: string) => `/api/v1/audits/${auditId}/plans`,
  validatePlan: (planId: string) => `/api/v1/plans/${planId}/validate`,
  getAudit: (auditId: string) => `/api/v1/audits/${auditId}`,
  decisionArtifacts: (auditId: string) => `/api/v1/audits/${auditId}/decision-artifacts`,
};

/** The AuditView as a customer reads it (design §12): the phase, the deadlines, the grant's classification and the decisions still needed. */
export type AuditView = {
  readonly auditId: string;
  readonly revisionId: string;
  readonly targetContractId: string;
  readonly state: string;
  readonly version: number;
  readonly startedAt: string;
  readonly interpretationDeadlineAt?: string;
  readonly absoluteDeadline: string;
  readonly grantId: string;
  readonly grantClass: string;
  readonly grantState: string;
  readonly candidateManifestHash?: string;
  readonly cancelVersion: number;
  readonly pendingDecisions?: ReadonlyArray<string>;
  readonly unsupportedCapabilities?: ReadonlyArray<string>;
  readonly terminalReason?: string;
  readonly draftPlanId?: string;
  readonly permittedActions: ReadonlyArray<string>;
};

/** The PlanView CMD022 answers with (the fields the audit tests read). */
export type CreatedPlanView = {
  readonly planId: string;
  readonly projectId: string;
  readonly state: string;
  readonly version: number;
  readonly bodyHash: string;
  readonly revisionHash: string;
  readonly targetContractHash: string;
  readonly permittedActions: ReadonlyArray<string>;
};

/** The STORED answer of the decision-artifact intake (a 201 when the artifact was created, a 200 for the same content again). */
export type StoredArtifact = {
  readonly artifactRef: string;
  readonly auditId: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly created: boolean;
};

/** The STORED envelope's data of an intake reply: 201 when the artifact was created, 200 for the same content again. */
export function storedData(reply: Reply): StoredArtifact {
  if (reply.status !== 200 && reply.status !== 201) throw new Error(`expected 200 or 201, got ${reply.status}: ${reply.text}`);
  const body = reply.json<{ kind: string; data: StoredArtifact }>();
  if (body.kind !== "STORED") throw new Error(`expected a STORED reply: ${reply.text}`);
  return body.data;
}

export interface CallOptions {
  readonly key?: string;
  readonly token?: string;
  readonly agency?: string;
}

export const AUDIT_POLICY_VERSION = "R2-INITIAL";

/** CMD020 StartAudit as an operator of agency A unless told otherwise. */
export function startAudit(w: World, revisionId: string, body: { readonly targetContractId: string; readonly auditPolicyVersion?: string }, options: CallOptions = {}): Promise<Reply> {
  return call(w, {
    url: auditRoutes.startAudit(revisionId),
    token: options.token ?? w.operator.token,
    key: options.key ?? freshKey("cmd020"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body: { auditPolicyVersion: AUDIT_POLICY_VERSION, ...body },
  });
}

/** CMD021 CancelAudit as an operator of agency A unless told otherwise. */
export function cancelAudit(w: World, auditId: string, body: { readonly expectedVersion: number }, options: CallOptions = {}): Promise<Reply> {
  return call(w, {
    url: auditRoutes.cancelAudit(auditId),
    token: options.token ?? w.operator.token,
    key: options.key ?? freshKey("cmd021"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body,
  });
}

/** CMD022 CreatePlan as an operator of agency A unless told otherwise. */
export function createPlan(w: World, auditId: string, body: { readonly candidateDecisionArtifactRef: string }, options: CallOptions = {}): Promise<Reply> {
  return call(w, {
    url: auditRoutes.createPlan(auditId),
    token: options.token ?? w.operator.token,
    key: options.key ?? freshKey("cmd022"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body,
  });
}

/** CMD024 ValidatePlan as an operator of agency A unless told otherwise. */
export function validatePlan(w: World, planId: string, body: { readonly expectedVersion: number; readonly planHash: string }, options: CallOptions = {}): Promise<Reply> {
  return call(w, {
    url: auditRoutes.validatePlan(planId),
    token: options.token ?? w.operator.token,
    key: options.key ?? freshKey("cmd024"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body,
  });
}

/** GetAudit as a member of agency A (a VIEWER by default: every live membership role reads). */
export function getAudit(w: World, auditId: string, token: string = w.viewer.token, agency?: string): Promise<Reply> {
  return read(w, auditRoutes.getAudit(auditId), token, agency);
}

/** The decision-artifact intake as an operator of agency A unless told otherwise: not a command, so it carries no idempotency key (B07 D-SEL-2). */
export function storeDecisionArtifact(w: World, auditId: string, body: unknown, options: Pick<CallOptions, "token" | "agency"> = {}): Promise<Reply> {
  return call(w, {
    url: auditRoutes.decisionArtifacts(auditId),
    token: options.token ?? w.operator.token,
    key: null,
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body,
  });
}

export function viewOf(reply: Reply): AuditView {
  return readData<AuditView>(reply);
}

/** The 202 of an accepted StartAudit: the audit's identity. */
export function auditIdOf(reply: Reply): string {
  return accepted(reply).operationId;
}

/** The candidate decisions the contract fake compiles: `{ body }`, the plan body the decisions amount to. */
export function candidateDocument(body: PlanBody): { readonly body: PlanBody } {
  return { body };
}

// --- the world -------------------------------------------------------------------------------------------------------------------------

/** The reason a compiler answers a rejected candidate with (PatchCompilation REJECTED). */
export type CompilerReason = Extract<PatchCompilation, { readonly kind: "REJECTED" }>["reason"];

/**
 * The Intelligence core's plan compiler as the api is bound to it: the contract fake of B08-CORE-PORTS (SIMULATED), which compiles a candidate
 * decision shaped as `{ body }`, wrapped so that a test can tell it to reject the next candidate with one of the compiler's four reasons.
 */
export class ScriptedPlanCompiler implements PlanCompilerPort {
  readonly #rejections: CompilerReason[] = [];
  #lies = 0;
  readonly #arrivals: Array<{ readonly current: PlanBody | null }> = [];

  constructor(private readonly core: ContractFakeIntelligenceCore) {}

  /** The next candidate compiled is rejected with `reason`. */
  rejectNext(reason: CompilerReason): void {
    this.#rejections.push(reason);
  }

  /** The next compilation claims a digest that is not the digest of the body it returns (a collaborator that must not be taken on trust). */
  lieNext(): void {
    this.#lies += 1;
  }

  /** Every candidate the handlers put to the compiler, in arrival order. */
  arrivals(): ReadonlyArray<{ readonly current: PlanBody | null }> {
    return this.#arrivals;
  }

  compile(candidateDecisions: unknown, current: PlanBody | null): Promise<PatchCompilation> {
    this.#arrivals.push({ current });
    const reason = this.#rejections.shift();
    if (reason !== undefined) return Promise.resolve({ kind: "REJECTED", reason });
    const lying = this.#lies > 0;
    if (lying) this.#lies -= 1;
    return this.core.compile(candidateDecisions, current).then((compilation) => (lying && compilation.kind === "COMPILED" ? { ...compilation, bodyHash: sha("a digest of some other content") as typeof compilation.bodyHash } : compilation));
  }
}

export interface AuditWorld {
  readonly w: World;
  readonly core: ContractFakeIntelligenceCore;
  readonly compiler: ScriptedPlanCompiler;
  /** The platform's funded monthly pool, once `fundPool` ran. */
  poolId: string | null;
  stop(): Promise<void>;
}

/**
 * A world whose api serves the audit routes: agency A ACTIVE (customer data enters only an active agency), a wide upload-session limit, the
 * Intelligence core's contract fake bound through `cores` and the edition's own plan services. The platform's pool is NOT funded: a test
 * that starts an audit funds it first (`fundPool`).
 */
export async function auditWorld(): Promise<AuditWorld> {
  const core = new ContractFakeIntelligenceCore();
  const compiler = new ScriptedPlanCompiler(core);
  const cores: CoreServices = { planCompiler: compiler };
  const w = await world({ cores, realPlanServices: true });
  await activate(w);
  await setSessionLimit(w, w.A, 16);
  const aw: AuditWorld = {
    w,
    core,
    compiler,
    poolId: null,
    stop: () => w.stop(),
  };
  return aw;
}

/** The owner's funding act (Q8-1): the platform's monthly pool, on the control plane's own login. */
export async function fundPool(aw: Pick<AuditWorld, "w" | "poolId">, ceilingCents = 22_000n): Promise<string> {
  const client = await aw.w.h.controlPool.raw.connect();
  try {
    const poolId = await fundPlatformPool(client, { ceilingCents });
    aw.poolId = poolId;
    return poolId;
  } finally {
    client.release();
  }
}

/** What an audit is of: a sealed, available revision and a confirmed current target contract of one project (D8-AUD-1). */
export interface Subject {
  readonly projectId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly contractId: string;
  readonly targetContractHash: string;
}

/** A fresh project of agency A (unless told otherwise) with its revision sealed about an hour ago and its target contract confirmed. */
export async function subjectOf(w: World, agency: World["A"] = w.A, clientId: World["clientA"] = agency === w.A ? w.clientA : w.clientB): Promise<Subject> {
  const { projectId } = await w.project(agency, clientId);
  const source = await w.revision(agency, projectId, "SEALED", { recent: true });
  const target = await w.targetContract(agency, projectId);
  return { projectId, revisionId: source.revisionId, revisionHash: source.revisionHash, contractId: target.contractId, targetContractHash: target.targetContractHash };
}

/** A subject and the audit StartAudit queued for it through its route. */
export interface StartedAudit {
  readonly subject: Subject;
  readonly auditId: string;
  readonly grantId: string;
}

/** StartAudit through its route on a fresh subject; the pool must be funded and no other audit of the agency live. */
export async function startedAudit(aw: Pick<AuditWorld, "w">, options: CallOptions = {}): Promise<StartedAudit> {
  const subject = await subjectOf(aw.w);
  const reply = await startAudit(aw.w, subject.revisionId, { targetContractId: subject.contractId }, options);
  const auditId = auditIdOf(reply);
  const row = await auditRow(aw.w, auditId);
  return { subject, auditId, grantId: row.grant_id };
}

// --- lock fragments ------------------------------------------------------------------------------------------------------------------

/**
 * How the audit row lock (PgAuditStore.lockAudit: SELECT ... FROM kauro.audits WHERE audit_id = $1 FOR UPDATE) shows in pg_stat_activity: the
 * statement is cut at track_activity_query_size before its FROM clause, so the head of its select list identifies it; a plain read of the
 * same columns never waits on a lock, so a backend in a lock wait on this head is waiting for the audit row.
 */
export const AUDIT_ROW_LOCK = "SELECT audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id";

/** The plan row lock (PgPlanStore.lock and PgAuditStore.requestValidation: SELECT ... FROM kauro.plans WHERE plan_id = $1 FOR UPDATE). */
export const PLAN_ROW_LOCK = "SELECT plan_id, agency_id, project_id, version, state, revision_hash";

/** The funded pool's row lock (PgAuditStore.startAudit: the funded pools read FOR UPDATE, in expiry order). */
export const POOL_ROW_LOCK = "FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY'";

// --- oracles ---------------------------------------------------------------------------------------------------------------------------

export type AuditRow = {
  audit_id: string;
  agency_id: string;
  project_id: string;
  revision_id: string;
  revision_hash: string;
  target_contract_id: string;
  target_contract_hash: string;
  audit_policy_version: string;
  requested_by_membership_id: string;
  grant_id: string;
  version: string;
  state: string;
  fence: string;
  cancel_version: string;
  cancel_actor_kind: string | null;
  cancel_actor_id: string | null;
  started_at: Date;
  absolute_deadline_at: Date;
  interpretation_deadline_at: Date | null;
  profile_evidence_hash: string | null;
  candidate_manifest_hash: string | null;
  draft_plan_id: string | null;
  finding_codes: ReadonlyArray<string>;
  terminal_reason: string | null;
  terminal_at: Date | null;
};

export async function auditRow(w: World, auditId: string): Promise<AuditRow> {
  const row = await w.row<AuditRow>("audits", "audit_id = $1", [auditId]);
  assert.ok(row !== null, `audit ${auditId} exists`);
  return row;
}

/** Every audit of an agency, oldest first. */
export async function auditsOfAgency(w: World, agencyId: string = w.A.agencyId): Promise<ReadonlyArray<string>> {
  const r = await w.h.oracle.query<{ audit_id: string }>("SELECT audit_id FROM kauro.audits WHERE agency_id = $1 ORDER BY created_at", [agencyId]);
  return r.rows.map((x) => x.audit_id);
}

export type GrantRow = {
  grant_id: string;
  agency_id: string | null;
  grant_kind: string;
  pool_grant_id: string | null;
  ceiling_cents: string;
  reserved_cents: string;
  reconciled_spend_cents: string;
  authorization_ref: string | null;
  state: string;
  version: string;
};

export async function grantRow(w: World, grantId: string): Promise<GrantRow> {
  const row = await w.row<GrantRow>("cost_grants", "grant_id = $1", [grantId]);
  assert.ok(row !== null, `grant ${grantId} exists`);
  return row;
}

export type PlanRow = { plan_id: string; agency_id: string; project_id: string; version: string; state: string; body_hash: string; revision_hash: string; target_contract_hash: string; body: PlanBody };

export async function planRow(w: World, planId: string): Promise<PlanRow> {
  const row = await w.row<PlanRow>("plans", "plan_id = $1", [planId]);
  assert.ok(row !== null, `plan ${planId} exists`);
  return row;
}

export type ValidationRow = { validation_id: string; plan_id: string; plan_hash: string; fence: string; origin: string; requested_by_membership_id: string | null; audit_id: string | null; result: string | null };

/** The validation intents of a plan, in fence order (ValidatePlan writes the COMMAND ones). */
export async function validationsOf(w: World, planId: string): Promise<ReadonlyArray<ValidationRow>> {
  const r = await w.h.oracle.query<ValidationRow>("SELECT validation_id, plan_id, plan_hash, fence::text AS fence, origin, requested_by_membership_id, audit_id, result FROM kauro.plan_validations WHERE plan_id = $1 ORDER BY fence", [planId]);
  return r.rows;
}

/** The tables the audit commands write, counted in one statement. */
const AUDIT_TABLES = ["audits", "cost_grants", "audit_steps", "model_tasks", "model_task_journal", "decision_artifacts", "plan_validations"] as const;

/**
 * The "nothing written" oracle of a refusal: the effect tables' row counts (domain events, outbox records, journal entries, plans) and the
 * audit tables' — the security event of a denial is its own record, written after the rollback (D-FACT-1), so it is left out.
 */
export async function footprint(w: World): Promise<Readonly<Record<string, number | string>>> {
  const effects = await effectCounts(w);
  const r = await w.h.oracle.query<Record<string, string>>(`SELECT ${AUDIT_TABLES.map((t) => `(SELECT count(*) FROM kauro.${t})::text AS ${t}`).join(", ")}`);
  const reserved = await w.h.oracle.query<{ reserved: string }>("SELECT coalesce(sum(reserved_cents), 0)::text AS reserved FROM kauro.cost_grants");
  return { ...effects, security_events: 0, ...(r.rows[0] ?? {}), reserved_cents: reserved.rows[0]?.reserved ?? "0" };
}

export type ObservedEvent = { readonly version: number; readonly type: string; readonly payload: Record<string, unknown>; readonly consumers: ReadonlyArray<string> };

/** The events of an aggregate, in version order, and the consumers of each one's outbox records. */
export async function eventsOf(w: World, aggregateKind: string, aggregateId: string): Promise<ReadonlyArray<ObservedEvent>> {
  const events = await w.events(aggregateKind, aggregateId);
  const out: ObservedEvent[] = [];
  for (const e of events) out.push({ version: e.version, type: e.type, payload: e.payload, consumers: [...(await w.outbox(e.eventId))].sort() });
  return out;
}

export const auditEvents = (w: World, auditId: string): Promise<ReadonlyArray<ObservedEvent>> => eventsOf(w, "audit", auditId);
export const grantEvents = (w: World, grantId: string): Promise<ReadonlyArray<ObservedEvent>> => eventsOf(w, "cost_grant", grantId);
export const planEvents = (w: World, planId: string): Promise<ReadonlyArray<ObservedEvent>> => eventsOf(w, "plan", planId);

// --- the control plane's steps ---------------------------------------------------------------------------------------------------------

type Path = { readonly agencyId: string; readonly auditId: string };

const STEP = (kind: "PROFILE" | "INTERPRET" | "VALIDATE") => (w: World, at: Path): Promise<AuditStepId> =>
  w.h.audit.run(controlOf(at.agencyId), async (uow) => (await uow.audits.claimStep(at.auditId as AuditId, kind, ids.next() as AuditStepId)).step.stepId);

const claimProfile = STEP("PROFILE");
const claimInterpret = STEP("INTERPRET");
const claimValidate = STEP("VALIDATE");

async function recordStep(w: World, at: Path, stepId: AuditStepId, outcome: "COMPLETED" | "FAILED" | "COMPILED" | "NEEDS_DECISION" | "UNSUPPORTED" | "VALID", seed: string): Promise<void> {
  await w.h.audit.run(controlOf(at.agencyId), (uow) => uow.audits.recordStep(stepId, { outcome, evidenceHash: sha(seed), evidenceClass: "SIMULATED" }));
}

async function advance(w: World, at: Path, expectedVersion: number, edge: Parameters<Parameters<Parameters<World["h"]["audit"]["run"]>[1]>[0]["audits"]["advanceAudit"]>[2]): Promise<void> {
  const moved = await w.h.audit.run(controlOf(at.agencyId), (uow) => uow.audits.advanceAudit(at.auditId as AuditId, expectedVersion, edge));
  assert.equal(moved.kind, "APPLIED", `the audit advanced to ${edge.to}`);
}

/** PROFILING: the profile worker claimed the audit (v2). */
export async function profiling(w: World, at: Path): Promise<void> {
  await claimProfile(w, at);
}

/** INTERPRETING (v3): profiled, the candidate manifest planned, the interpretation deadline stamped; the INTERPRET step claimed. */
export async function interpreting(w: World, at: Path): Promise<{ readonly interpretStepId: AuditStepId }> {
  const step = await claimProfile(w, at);
  await recordStep(w, at, step, "COMPLETED", `profile-${at.auditId}`);
  await advance(w, at, 2, { to: "INTERPRETING", profileEvidenceHash: sha(`profile-evidence-${at.auditId}`), candidateManifestHash: sha(`candidate-manifest-${at.auditId}`) });
  return { interpretStepId: await claimInterpret(w, at) };
}

/**
 * A model task the INTERPRET step planned at the audit's fence over its candidate manifest (the database admits one only while the audit is
 * INTERPRETING): its provider profile is an internal identity no view may carry.
 */
export async function plannedModelTask(w: World, at: Path): Promise<void> {
  const audit = await auditRow(w, at.auditId);
  await w.h.audit.run(controlOf(at.agencyId), (uow) =>
    uow.audits.createModelTask({
      modelTaskId: ids.next() as ModelTaskId,
      auditId: at.auditId as AuditId,
      stepFence: Number(audit.fence),
      taskKey: sha(`task-${at.auditId}`),
      candidateManifestHash: audit.candidate_manifest_hash as string,
      policyHash: sha("audit-policy"),
      minimizedRequestHash: sha(`minimized-${at.auditId}`),
      providerProfileId: ids.next(),
      maximumCostCents: 50n,
    }),
  );
}

/**
 * NEEDS_DECISION (v4): the interpretation left decisions only the agency can make; the finding codes name them. `during` runs while the audit
 * is INTERPRETING (a model task planned, say).
 */
export async function needsDecision(w: World, at: Path, findingCodes: ReadonlyArray<string> = ["MERGE_POLICY_UNRESOLVED"], during?: () => Promise<void>): Promise<void> {
  const { interpretStepId } = await interpreting(w, at);
  if (during !== undefined) await during();
  await recordStep(w, at, interpretStepId, "NEEDS_DECISION", `decisions-${at.auditId}`);
  await advance(w, at, 3, { to: "NEEDS_DECISION", findingCodes });
}

/** UNSUPPORTED (v4): the interpretation found capabilities the mode does not offer; the finding codes name them. */
export async function unsupported(w: World, at: Path, findingCodes: ReadonlyArray<string> = ["CAPABILITY_NOT_OFFERED"]): Promise<void> {
  const { interpretStepId } = await interpreting(w, at);
  await recordStep(w, at, interpretStepId, "UNSUPPORTED", `unsupported-${at.auditId}`);
  await advance(w, at, 3, { to: "UNSUPPORTED", findingCodes });
}

/** FAILED (v3) out of PROFILING: the profile worker recorded its failure and the orchestration ended the audit. */
export async function failed(w: World, at: Path, reasonCode = "PROFILE_FAILED"): Promise<void> {
  const step = await claimProfile(w, at);
  await recordStep(w, at, step, "FAILED", `failed-${at.auditId}`);
  await advance(w, at, 2, { to: "FAILED", reasonCode });
}

/**
 * DRAFT_READY (v5): interpreted and compiled, the system draft validated under a VALID receipt of the audit's subject. Returns the draft plan
 * (VALIDATED v4, bound to the receipt).
 */
export async function draftReady(w: World, at: Path, subject: Subject): Promise<{ readonly draftPlanId: string; readonly bodyHash: string }> {
  const { interpretStepId } = await interpreting(w, at);
  await recordStep(w, at, interpretStepId, "COMPILED", `compiled-${at.auditId}`);
  await advance(w, at, 3, { to: "VALIDATING" });
  const validateStepId = await claimValidate(w, at);
  const draftPlanId = ids.next() as PlanId;
  const body: PlanBodyOfDomain = planBodyOf(subject.revisionHash as PlanBody["revisionHash"], subject.targetContractHash as PlanBody["targetContractHash"], `draft-${at.auditId}`);
  const bodyHash = bodyHashOf(body);
  const draft = await w.h.audit.run(controlOf(at.agencyId), (uow) => uow.audits.recordSystemDraft(at.auditId as AuditId, { planId: draftPlanId, validationId: ids.next() as PlanValidationId, body, bodyHash }));
  await recordStep(w, at, validateStepId, "VALID", `validated-${at.auditId}`);
  const receiptHash = sha(`receipt-${draftPlanId}`);
  const completedMs = Date.now();
  const counts = { physicalSourceRows: 120, logicalSourceRecords: 120, billableSourceUnits: 120, associationEdges: 0, emittedRepresentatives: 120, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 120 };
  await w.h.recordValidationReceipt({
    receiptId: ids.next() as ValidationReceiptId,
    agencyId: at.agencyId as never,
    planId: draftPlanId,
    receiptHash,
    revisionHash: body.revisionHash,
    targetContractHash: body.targetContractHash,
    planHash: bodyHash,
    corePackageHash: sha("core"),
    profileEvidenceHash: sha("profile"),
    dispositionEvidenceHash: sha("disposition"),
    artifactEvidenceHash: sha("artifact"),
    startedAt: new Date(completedMs - 60_000).toISOString() as never,
    completedAt: new Date(completedMs).toISOString() as never,
    result: "VALID",
    counts,
    blockingIssueCodes: [],
  });
  await w.h.audit.run(controlOf(at.agencyId), (uow) => uow.audits.settleValidation(draft.validation.validationId, { result: "VALID", receiptHash }));
  await advance(w, at, 4, { to: "DRAFT_READY", draftPlanId });
  return { draftPlanId, bodyHash };
}

/** The audit of the agency moved by a control-plane step to the state a test needs, from a QUEUED audit. */
export type AuditPhase = "QUEUED" | "PROFILING" | "INTERPRETING" | "NEEDS_DECISION" | "UNSUPPORTED" | "FAILED" | "DRAFT_READY";

export async function driveTo(w: World, started: StartedAudit, phase: AuditPhase): Promise<void> {
  const at = { agencyId: w.A.agencyId, auditId: started.auditId };
  switch (phase) {
    case "QUEUED":
      return;
    case "PROFILING":
      return profiling(w, at);
    case "INTERPRETING":
      await interpreting(w, at);
      return;
    case "NEEDS_DECISION":
      return needsDecision(w, at);
    case "UNSUPPORTED":
      return unsupported(w, at);
    case "FAILED":
      return failed(w, at);
    case "DRAFT_READY":
      await draftReady(w, at, started.subject);
  }
}

/**
 * Ends every live audit of agency A as its owner would (a cancellation through the tenant unit of work), so the agency's one live audit is free
 * again: the tests share one agency, and an agency runs one audit at a time.
 */
export async function endLiveAudits(w: World): Promise<void> {
  const r = await w.h.oracle.query<{ audit_id: string; version: string }>("SELECT audit_id, version::text AS version FROM kauro.audits WHERE agency_id = $1 AND state IN ('QUEUED', 'PROFILING', 'INTERPRETING', 'VALIDATING') ORDER BY created_at", [w.A.agencyId]);
  for (const row of r.rows) {
    await w.h.audit.run(w.h.tenant(w.A.agencyId, w.A.ownerUserId), (uow) => uow.audits.cancelAudit(row.audit_id as AuditId, Number(row.version), { actor: { kind: "USER", userId: w.A.ownerUserId }, reasonCode: "TEST_CLEANUP" }));
  }
}

// --- decision artifacts and plans --------------------------------------------------------------------------------------------------------

/** A candidate-decisions artifact stored through the real intake route (201 the first time), the body the agency's decisions amount to. */
export async function storedCandidates(w: World, auditId: string, body: PlanBody, person: World["operator"] = w.operator): Promise<StoredArtifact> {
  const reply = await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: candidateDocument(body) }, { token: person.token });
  assert.equal(reply.status, 201, reply.text);
  return storedData(reply);
}

/** The plan body of an audit's subject, the way the tests' agency decides it. */
export function decidedBody(subject: Subject, seed: string): PlanBody {
  return planBodyOf(subject.revisionHash as PlanBody["revisionHash"], subject.targetContractHash as PlanBody["targetContractHash"], seed);
}

/** A plan revision of the subject at VALIDATION_REQUIRED (v2), written the way CMD022 leaves it. */
export function requiredPlan(w: World, subject: Subject, seed: string): Promise<PlanFixture> {
  return w.plan(w.A, subject.projectId as never, { revisionHash: subject.revisionHash as never, targetContractHash: subject.targetContractHash as never, seed, state: "VALIDATION_REQUIRED" });
}

// --- what a view must never carry ------------------------------------------------------------------------------------------------------

/**
 * What an AuditView must never carry, whatever the state of the audit: the provider's identity and the model task's prompt (only their hashes
 * are stored), the profile's evidence, the steps' identities, the platform pool the grant was carved from, the audit's subjects' hashes and
 * the fence and lease vocabulary.
 */
export async function forbiddenTokensOf(w: World, auditId: string): Promise<ReadonlyArray<string>> {
  const audit = await auditRow(w, auditId);
  const grant = await grantRow(w, audit.grant_id);
  const steps = await w.h.oracle.query<{ step_id: string; evidence_hash: string | null }>("SELECT step_id, evidence_hash FROM kauro.audit_steps WHERE audit_id = $1", [auditId]);
  const tasks = await w.h.oracle.query<{ model_task_id: string; provider_profile_id: string; minimized_request_hash: string }>("SELECT model_task_id, provider_profile_id, minimized_request_hash FROM kauro.model_tasks WHERE audit_id = $1", [auditId]);
  const tokens: string[] = [
    audit.revision_hash,
    audit.target_contract_hash,
    audit.requested_by_membership_id,
    "providerProfileId",
    "provider_profile_id",
    "minimizedRequestHash",
    "profileEvidenceHash",
    "evidenceHash",
    "prompt",
    "contract-fake-intelligence-core",
    "\"fence\"",
    "\"lease\"",
    "poolGrantId",
    "authorizationRef",
  ];
  if (audit.profile_evidence_hash !== null) tokens.push(audit.profile_evidence_hash);
  if (grant.authorization_ref !== null) tokens.push(grant.authorization_ref);
  if (grant.pool_grant_id !== null) tokens.push(grant.pool_grant_id);
  for (const s of steps.rows) tokens.push(s.step_id, ...(s.evidence_hash !== null ? [s.evidence_hash] : []));
  for (const t of tasks.rows) tokens.push(t.model_task_id, t.provider_profile_id, t.minimized_request_hash);
  return tokens;
}

/** The interval between two instants of a reply, in seconds. */
export function secondsBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 1000;
}

export { AUDIT_POLICY };

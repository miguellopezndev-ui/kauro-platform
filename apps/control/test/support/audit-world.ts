// The audit side of the control-plane tests (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §6,
// §8.1, §11; decisions D8-AUD-1..4, D8-GRANT-1/2, D8-PLAN-2, D8-CANCEL-2), on the execution world: one real PostgreSQL 17 cluster per
// test file, the control plane assembled by this package's composition root with its audit pipelines, the labelled TEST CLOCK.
//
// - The writes the request handlers own — StartAudit (CMD020), CancelAudit (CMD021), a plan (CMD022's shape), ValidatePlan's intent
//   (CMD024), a revision of a plan (CMD023) and a successor revision superseding a source (CMD012) — go through the persistence
//   adapters in the owner's TENANT unit of work (the routes are B08-COMMANDS-AUDIT's, B06's and B07's).
// - The platform's monthly model pool is funded by the control plane's operations act (Q8-1, @kauro/persistence/testing
//   fundPlatformPool) on the control plane's own login.
// - The model tasks and dispatch intents a real interpretation makes — the Intelligence core's adapter of `b05/cores` dispatching
//   under the platform's journal — are written by `control()` through the platform's own audit store and request journal as the
//   control plane (the fake of B08-CORE-PORTS dispatches nothing real); nothing here is a fake.
// - The hold points and the faulty validator are TEST DECORATORS of the labelled fakes' answers (a profile or a validation held in
//   flight, a validation answered for other inputs, null or incomplete), never a fake of their own (D8-FAKE-1, D8-CEX-10).
//
// The superuser connection is the oracle only.
import assert from "node:assert/strict";
import type { Sha256Hex } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { ProfilePort, ValidatePort, ValidateRequest, ValidateResult } from "@kauro/application";
import type {
  AuditId,
  AuditRecord,
  AuditUnitOfWork,
  CausationId,
  CorrelationId,
  CostGrantId,
  MembershipId,
  PlanBody,
  PlanId,
  PlanValidationId,
  PlanValidationRecord,
  RevisionId,
  StartedAudit,
  TargetContractId,
  ValidationReceiptRecord,
} from "@kauro/domain";
import { fundPlatformPool } from "@kauro/persistence/testing";
import type { ValidationReceipts } from "../../src/index.js";
import { ids, sha, type AuditSubject, type ExecutionWorld } from "./execution-world.js";

/** The service identity of the Intelligence core adapter's stand-in (a control-plane unit, as AUDIT_ORCHESTRATION's INTERPRET runs it). */
const ADAPTER_SERVICE = "audit-orchestration";

export interface AuditRow {
  readonly state: string;
  readonly version: string;
  readonly fence: string;
  readonly cancel_version: string;
  readonly cancel_actor_kind: string | null;
  readonly cancel_actor_id: string | null;
  readonly terminal_reason: string | null;
  readonly draft_plan_id: string | null;
  readonly profile_evidence_hash: string | null;
  readonly candidate_manifest_hash: string | null;
  readonly finding_codes: ReadonlyArray<string>;
  readonly grant_id: string;
  readonly requested_by_membership_id: string;
  readonly absolute_deadline_at: string;
  readonly interpretation_deadline_at: string | null;
}

export interface PlanRow {
  readonly plan_id: string;
  readonly state: string;
  readonly version: string;
  readonly body_hash: string;
  readonly created_by_membership_id: string;
  readonly validation_receipt_hash: string | null;
  readonly superseded_by_plan_id: string | null;
}

export interface GrantRow {
  readonly state: string;
  readonly version: string;
  readonly ceiling: number;
  readonly reserved: number;
  readonly spent: number;
  readonly expires_at: string;
}

export interface AuditWorld {
  /** The platform's monthly model pool this file's audits are carved from. */
  readonly pool: string;
  /** CMD020's write: the AUDIT grant carved from the pool and the audit QUEUED with audit.queued.v1 to AUDIT_ORCHESTRATION. */
  start(subject: AuditSubject): Promise<StartedAudit>;
  /** CMD021's write: cancellation_wins at the audit's current version, as the agency's owner. */
  cancel(subject: AuditSubject, auditId: string): Promise<AuditRecord>;
  /** CMD012's write: a successor revision supersedes the subject's sealed source, with its events (to EXECUTION_CONTROL). */
  supersedeSource(subject: AuditSubject): Promise<void>;
  /** A plan of the subject by the request handlers, DRAFT -> VALIDATION_REQUIRED (v2), with its events. */
  plan(subject: AuditSubject, seed: string): Promise<{ readonly planId: PlanId; readonly bodyHash: Sha256Hex }>;
  /** CMD024's write: the plan's next validation intent at its version, VALIDATION_REQUIRED -> VALIDATING with plan.validating.v1. */
  requestValidation(subject: AuditSubject, planId: string, expectedVersion: number): Promise<PlanValidationRecord>;
  /** CMD023's writes: the plan SUPERSEDED at its version by a successor DRAFT with another body; returns the successor. */
  revise(subject: AuditSubject, planId: string, expectedVersion: number): Promise<PlanId>;
  /** A SYSTEM unit of the control plane bound to the agency (the TEST CLOCK's units): the Intelligence core adapter's stand-in. */
  control<T>(agencyId: string, work: (uow: AuditUnitOfWork) => Promise<T>): Promise<T>;
  audit(auditId: string): Promise<AuditRow>;
  /** The audit's steps as [kind, fence, outcome, evidence class]. */
  steps(auditId: string): Promise<ReadonlyArray<readonly [string, number, string | null, string | null]>>;
  /** Every plan of the subject's source and target (a system draft included), oldest first. */
  plansOf(subject: AuditSubject): Promise<ReadonlyArray<PlanRow>>;
  plan_(planId: string): Promise<PlanRow>;
  /** The plan's validation intents as [fence, origin, result, receipt hash]. */
  validations(planId: string): Promise<ReadonlyArray<readonly [number, string, string | null, string | null]>>;
  /** The receipts the validator recorded for the plan. */
  receipts(planId: string): Promise<ReadonlyArray<{ readonly result: string; readonly receipt_hash: string; readonly plan_hash: string; readonly revision_hash: string; readonly target_contract_hash: string; readonly core_package_hash: string; readonly blocking_issue_codes: ReadonlyArray<string> }>>;
  /** The core's journal of a run: the kinds of its events in order. */
  journal(runId: string): Promise<ReadonlyArray<string>>;
  grant(grantId: string): Promise<GrantRow>;
  request(requestId: string): Promise<{ readonly state: string; readonly usage_state: string; readonly reserved: number; readonly actual: number | null }>;
  /** The event types of an aggregate in version order, with the actor of each. */
  events(aggregateId: string): Promise<ReadonlyArray<readonly [string, string, string | null]>>;
}

function planBodyOf(subject: AuditSubject, seed: string): PlanBody {
  const v7 = (s: string): string => {
    const hex = sha(`${seed}-${s}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(12, 15)}-8${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
  };
  return {
    revisionHash: subject.revisionHash,
    targetContractHash: subject.targetContractHash,
    policyHash: sha(`policy-${seed}`),
    mappings: [
      {
        mappingId: v7("mapping"),
        sourceTableId: v7("table"),
        sourceFieldId: v7("field"),
        targetObject: "Contact",
        targetField: "Email",
        intent: { kind: "SET", reasonCode: "MAPPED" },
        evidence: { evidenceId: v7("evidence"), candidateId: v7("candidate"), provenance: "AGENCY", factHashes: [], ruleVersion: "R1", comparisonHash: sha(`cmp-${seed}`), fragmentHash: sha(`frag-${seed}`) },
      },
    ],
    identities: [],
    transforms: [],
    relationships: [],
  } as unknown as PlanBody;
}

export async function openAuditWorld(w: ExecutionWorld): Promise<AuditWorld> {
  const { h } = w;
  const oracle = h.oracle;
  const funding = await h.pg.connect("kauro_control_test");
  const pool = await fundPlatformPool(funding, { ceilingCents: 22_000n });
  await funding.end();

  const tenantOf = (s: AuditSubject) => h.tenant(s.agency.agencyId, s.agency.ownerUserId);
  const actorOf = (s: AuditSubject) => ({ kind: "USER", userId: s.agency.ownerUserId }) as const;

  const one = async <R extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown>): Promise<R> => {
    const r = await oracle.query<R>(sql, params as unknown[]);
    assert.ok(r.rows[0], sql);
    return r.rows[0];
  };

  const world: AuditWorld = {
    pool,

    start(s) {
      return h.audit.run(tenantOf(s), (uow) =>
        uow.audits.startAudit({
          auditId: ids.next() as AuditId,
          grantId: ids.next() as CostGrantId,
          agencyId: s.agency.agencyId,
          projectId: s.projectId,
          revisionId: s.revisionId,
          revisionHash: s.revisionHash,
          targetContractId: s.contractId as TargetContractId,
          targetContractHash: s.targetContractHash,
          auditPolicyVersion: "R2-INITIAL",
          requestedByMembershipId: s.agency.ownerMembershipId as MembershipId,
          ceilingCents: 150n,
          priceProfileHash: sha("price-profile-r2"),
        }),
      );
    },

    async cancel(s, auditId) {
      return h.audit.run(tenantOf(s), async (uow) => {
        const audit = await uow.audits.lockAudit(auditId as AuditId);
        assert.ok(audit, `audit ${auditId} is visible to its agency`);
        const write = await uow.audits.cancelAudit(audit.auditId, audit.version, { actor: { kind: "USER", userId: s.agency.ownerUserId }, reasonCode: "AGENCY_CANCELLED" });
        assert.equal(write.kind, "APPLIED", `CancelAudit of ${auditId}`);
        return write.kind === "APPLIED" ? write.record : audit;
      });
    },

    async supersedeSource(s) {
      const successorId = ids.next() as RevisionId;
      await h.app.runSource(tenantOf(s), async (uow) => {
        const actor = actorOf(s);
        const causationId = uow.ids.next() as CausationId;
        const publish = (aggregateKind: string, aggregateId: string, aggregateVersion: number, eventType: string, payload: Record<string, unknown>) =>
          uow.events.publish({ aggregateKind, aggregateId, aggregateVersion, agencyId: s.agency.agencyId, eventType, actor, causationId, correlationId: uow.context.correlationId, payload } as never);
        const project = await uow.projects.lock(s.projectId);
        const predecessor = await uow.sources.revisions.lock(s.revisionId);
        assert.ok(project && predecessor && predecessor.state === "SEALED", "the source is SEALED");
        await uow.sources.revisions.insertSuccessor({ revisionId: successorId, agencyId: s.agency.agencyId, projectId: s.projectId, supersedesRevisionId: s.revisionId, createdByMembershipId: s.agency.ownerMembershipId as MembershipId, createdAt: w.now() });
        const superseded = await uow.sources.revisions.transition(s.revisionId, predecessor.version, { event: "new_revision_explicitly_supersedes", successorRevisionId: successorId });
        assert.equal(superseded.kind, "APPLIED");
        if (superseded.kind !== "APPLIED") return;
        await publish("dataset_revision", s.revisionId, superseded.record.version, "dataset_revision.superseded.v1", { revisionId: s.revisionId, agencyId: s.agency.agencyId, projectId: s.projectId, successorRevisionId: successorId, manifestHash: s.revisionHash, affectedPlanIds: [], affectedApprovalIds: [], affectedCommercialAuthorizationIds: [] });
        await publish("dataset_revision", successorId, 1, "dataset_revision.created.v1", { revisionId: successorId, agencyId: s.agency.agencyId, projectId: s.projectId, state: "DRAFT", supersedesRevisionId: s.revisionId, createdByMembershipId: s.agency.ownerMembershipId });
        const moved = await uow.sources.projects.switchCurrentRevision(s.projectId, project.version, successorId, w.now());
        assert.equal(moved.kind, "APPLIED");
        if (moved.kind !== "APPLIED") return;
        await publish("project", s.projectId, moved.record.version, "project.current_revision_changed.v1", { projectId: s.projectId, agencyId: s.agency.agencyId, currentRevisionId: successorId, previousRevisionId: s.revisionId, changedByMembershipId: s.agency.ownerMembershipId });
      });
    },

    async plan(s, seed) {
      const body = planBodyOf(s, seed);
      const planId = ids.next() as PlanId;
      const bodyHash = structuredDigest(DOMAINS.PLAN_BODY, 1, body);
      await h.app.run(tenantOf(s), async (uow) => {
        const actor = actorOf(s);
        const causationId = uow.ids.next() as CausationId;
        const correlationId = uow.context.correlationId;
        const plan = await uow.plans.insert({ planId, agencyId: s.agency.agencyId, projectId: s.projectId, body, createdByMembershipId: s.agency.ownerMembershipId, createdAt: w.now() });
        await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: plan.version, agencyId: s.agency.agencyId, eventType: "plan.created.v1", actor, causationId, correlationId, payload: { planId, agencyId: s.agency.agencyId, projectId: s.projectId, bodyHash: plan.bodyHash, createdByMembershipId: s.agency.ownerMembershipId } });
        const required = await uow.plans.transition(planId, 1, { state: "VALIDATION_REQUIRED" }, w.now());
        assert.equal(required.kind, "APPLIED");
        await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: 2, agencyId: s.agency.agencyId, eventType: "plan.validation_required.v1", actor, causationId, correlationId, payload: { planId, agencyId: s.agency.agencyId, bodyHash: plan.bodyHash } });
        assert.equal(plan.bodyHash, bodyHash, "the body digest is KAURO_PLAN_BODY_V1");
      });
      return { planId, bodyHash };
    },

    async requestValidation(s, planId, expectedVersion) {
      return h.audit.run(tenantOf(s), async (uow) => {
        const write = await uow.audits.requestValidation({ validationId: ids.next() as PlanValidationId, planId: planId as PlanId, expectedVersion, requestedByMembershipId: s.agency.ownerMembershipId as MembershipId });
        assert.equal(write.kind, "APPLIED", `ValidatePlan of ${planId} at version ${expectedVersion}`);
        if (write.kind !== "APPLIED") throw new Error("stale");
        return write.record;
      });
    },

    async revise(s, planId, expectedVersion) {
      const successor = ids.next() as PlanId;
      const body = planBodyOf(s, `revision-of-${planId}`);
      await h.app.run(tenantOf(s), async (uow) => {
        const actor = actorOf(s);
        const causationId = uow.ids.next() as CausationId;
        const correlationId = uow.context.correlationId;
        const moved = await uow.plans.transition(planId as PlanId, expectedVersion, { state: "SUPERSEDED", supersededByPlanId: successor }, w.now());
        assert.equal(moved.kind, "APPLIED", `the predecessor ${planId} is superseded at version ${expectedVersion}`);
        if (moved.kind !== "APPLIED") return;
        await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: moved.record.version, agencyId: s.agency.agencyId, eventType: "plan.superseded.v1", actor, causationId, correlationId, payload: { planId, agencyId: s.agency.agencyId, successorPlanId: successor } });
        const inserted = await uow.plans.insert({ planId: successor, agencyId: s.agency.agencyId, projectId: s.projectId, body, supersedesPlanId: planId as PlanId, createdByMembershipId: s.agency.ownerMembershipId, createdAt: w.now() });
        await uow.events.publish({ aggregateKind: "plan", aggregateId: successor, aggregateVersion: inserted.version, agencyId: s.agency.agencyId, eventType: "plan.created.v1", actor, causationId, correlationId, payload: { planId: successor, agencyId: s.agency.agencyId, projectId: s.projectId, bodyHash: inserted.bodyHash, supersedesPlanId: planId, createdByMembershipId: s.agency.ownerMembershipId } });
      });
      return successor;
    },

    control(agencyId, work) {
      return w.units.run({ kind: "SYSTEM", serviceId: ADAPTER_SERVICE, correlationId: ids.next() as CorrelationId, agencyId: agencyId as never }, work);
    },

    async audit(auditId) {
      return one<AuditRow & Record<string, unknown>>(
        `SELECT state, version::text AS version, fence::text AS fence, cancel_version::text AS cancel_version, cancel_actor_kind, cancel_actor_id, terminal_reason,
                draft_plan_id, profile_evidence_hash, candidate_manifest_hash, finding_codes, grant_id, requested_by_membership_id,
                to_char(absolute_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS absolute_deadline_at,
                to_char(interpretation_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS interpretation_deadline_at
           FROM kauro.audits WHERE audit_id = $1`,
        [auditId],
      );
    },

    async steps(auditId) {
      const r = await oracle.query<{ kind: string; fence: string; outcome: string | null; evidence_class: string | null }>("SELECT kind, fence::text AS fence, outcome, evidence_class FROM kauro.audit_steps WHERE audit_id = $1 ORDER BY fence", [auditId]);
      return r.rows.map((s) => [s.kind, Number(s.fence), s.outcome, s.evidence_class] as const);
    },

    async plansOf(s) {
      const r = await oracle.query<PlanRow>(
        "SELECT plan_id, state, version::text AS version, body_hash, created_by_membership_id, validation_receipt_hash, superseded_by_plan_id FROM kauro.plans WHERE agency_id = $1 AND revision_hash = $2 AND target_contract_hash = $3 ORDER BY created_at, plan_id",
        [s.agency.agencyId, s.revisionHash, s.targetContractHash],
      );
      return r.rows;
    },

    async plan_(planId) {
      return one<PlanRow & Record<string, unknown>>("SELECT plan_id, state, version::text AS version, body_hash, created_by_membership_id, validation_receipt_hash, superseded_by_plan_id FROM kauro.plans WHERE plan_id = $1", [planId]);
    },

    async validations(planId) {
      const r = await oracle.query<{ fence: string; origin: string; result: string | null; receipt_hash: string | null }>("SELECT fence::text AS fence, origin, result, receipt_hash FROM kauro.plan_validations WHERE plan_id = $1 ORDER BY fence", [planId]);
      return r.rows.map((v) => [Number(v.fence), v.origin, v.result, v.receipt_hash] as const);
    },

    async receipts(planId) {
      const r = await oracle.query<{ result: string; receipt_hash: string; plan_hash: string; revision_hash: string; target_contract_hash: string; core_package_hash: string; blocking_issue_codes: string[] }>(
        "SELECT result, receipt_hash, plan_hash, revision_hash, target_contract_hash, core_package_hash, blocking_issue_codes FROM kauro.validation_receipts WHERE plan_id = $1 ORDER BY created_at, receipt_id",
        [planId],
      );
      return r.rows;
    },

    async journal(runId) {
      const r = await oracle.query<{ kind: string | null }>("SELECT event ->> 'kind' AS kind FROM kauro.model_task_journal WHERE run_id = $1 ORDER BY position", [runId]);
      return r.rows.map((e) => e.kind ?? "");
    },

    async grant(grantId) {
      return one<GrantRow & Record<string, unknown>>(
        `SELECT state, version::text AS version, ceiling_cents::int AS ceiling, reserved_cents::int AS reserved, reconciled_spend_cents::int AS spent,
                to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
           FROM kauro.cost_grants WHERE grant_id = $1`,
        [grantId],
      );
    },

    async request(requestId) {
      return one("SELECT state, usage_state, reserved_cents::int AS reserved, actual_cents::int AS actual FROM kauro.request_journal WHERE request_id = $1", [requestId]);
    },

    async events(aggregateId) {
      const r = await oracle.query<{ event_type: string; actor_kind: string; actor_id: string | null }>("SELECT event_type, actor_kind, actor_id FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [aggregateId]);
      return r.rows.map((e) => [e.event_type, e.actor_kind, e.actor_id] as const);
    },
  };
  return world;
}

// --- hold points and a faulty validator: test decorators of the labelled fakes' answers ------------------------------------------

export interface CallHold {
  readonly reached: Promise<void>;
  release(): void;
}

function oneShot(): { readonly hold: CallHold; readonly armed: () => boolean; readonly wait: () => Promise<void> } {
  let armed = true;
  let signal: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (signal = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    hold: { reached, release },
    armed: () => armed,
    wait: async () => {
      armed = false;
      signal();
      await released;
    },
  };
}

/** The profiler whose next answer is held in flight until the test releases it (PROFILE's await, design §6). */
export function heldProfile(inner: ProfilePort): { readonly port: ProfilePort; readonly hold: CallHold } {
  const once = oneShot();
  return {
    port: {
      async profile(request) {
        const out = await inner.profile(request);
        if (once.armed()) await once.wait();
        return out;
      },
    },
    hold: once.hold,
  };
}

/** The validator whose next answer is held in flight until the test releases it (VALIDATE's and PLAN_VALIDATION's await). */
export function heldValidate(inner: ValidatePort): { readonly port: ValidatePort; readonly hold: CallHold } {
  const once = oneShot();
  return {
    port: {
      async validate(request) {
        const out = await inner.validate(request);
        if (once.armed()) await once.wait();
        return out;
      },
    },
    hold: once.hold,
  };
}

/**
 * The validator answering otherwise than for the platform's exact request: the fake's own answer for other inputs, or its answer
 * altered (null, incomplete, another core) — IC-03's "null, missing hashes ... or a receipt for different inputs".
 */
export function validatorAnswering(inner: ValidatePort, answer: (request: ValidateRequest, inner: ValidatePort) => Promise<ValidateResult>): ValidatePort {
  return { validate: (request) => answer(request, inner) };
}

/** The validator's write path whose next receipt, once committed, holds the step before its finalization unit (design §6). */
export function heldReceipts(inner: ValidationReceipts): { readonly receipts: ValidationReceipts; readonly hold: CallHold } {
  const once = oneShot();
  return {
    receipts: {
      async record(receipt: ValidationReceiptRecord, recordedAt) {
        await inner.record(receipt, recordedAt);
        if (once.armed()) await once.wait();
      },
    },
    hold: once.hold,
  };
}

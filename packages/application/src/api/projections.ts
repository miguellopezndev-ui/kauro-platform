/**
 * Projections from domain records to the safe DTO views (10 "Read endpoints return safe projections ... never serialize these
 * internal records wholesale"). Each projection is an explicit field selection: a new column on a record never reaches the
 * wire until a projection names it. Readiness blockers are computed from durable facts at read time (CMD011 effect: "visible
 * readiness blockers"; 10 "A UI readiness flag is informative, not authority").
 */
import type {
  AgencyRecord,
  ApprovalRecord,
  CapabilityRecord,
  DatasetRevisionRecord,
  EndClientRecord,
  MembershipRecord,
  MembershipRole,
  PlanRecord,
  ProjectRecord,
  TargetContractRecord,
} from "@kauro/domain";
import { OFFERED_CAPABILITY_STATES, capabilitiesOf } from "@kauro/domain";
import type { AgencyView, ApprovalView, EndClientView, MembershipView, PlanView, ProjectView, ReadinessBlocker } from "./views.js";

export function agencyView(agency: AgencyRecord, callerRole: MembershipRole): AgencyView {
  return {
    agencyId: agency.agencyId,
    version: agency.version,
    displayName: agency.displayName,
    state: agency.state,
    ...(agency.termsVersion !== undefined ? { termsVersion: agency.termsVersion } : {}),
    ...(agency.privacyAgreementVersion !== undefined ? { privacyAgreementVersion: agency.privacyAgreementVersion } : {}),
    createdAt: agency.createdAt,
    permittedActions: capabilitiesOf(callerRole),
  };
}

export function membershipView(m: MembershipRecord): MembershipView {
  return {
    membershipId: m.membershipId,
    agencyId: m.agencyId,
    userId: m.userId,
    role: m.role,
    state: m.state,
    version: m.version,
    assurancePolicy: m.assurancePolicy,
    ...(m.acceptedAt !== undefined ? { acceptedAt: m.acceptedAt } : {}),
  };
}

export function endClientView(c: EndClientRecord): EndClientView {
  return {
    clientId: c.clientId,
    agencyId: c.agencyId,
    version: c.version,
    displayName: c.displayName,
    state: c.state,
    processingAuthorityRef: c.processingAuthorityRef,
    createdAt: c.createdAt,
    ...(c.archivedAt !== undefined ? { archivedAt: c.archivedAt } : {}),
  };
}

export interface ReadinessFacts {
  readonly agency: Pick<AgencyRecord, "state">;
  readonly capability: Pick<CapabilityRecord, "state"> | null;
  readonly currentRevision: Pick<DatasetRevisionRecord, "state">;
  readonly targetContract: Pick<TargetContractRecord, "confirmedAt" | "supersededAt"> | null;
  readonly plan: Pick<PlanRecord, "state"> | null;
}

/** Blockers in a fixed order (agency, capability, source, target, plan) so two reads of the same facts render identically. */
export function readinessBlockersOf(facts: ReadinessFacts): ReadonlyArray<ReadinessBlocker> {
  const out: ReadinessBlocker[] = [];
  if (facts.agency.state !== "ACTIVE") out.push("AGENCY_NOT_ACTIVE");
  if (facts.capability === null || !OFFERED_CAPABILITY_STATES.has(facts.capability.state)) out.push("CAPABILITY_RESTRICTED");
  if (facts.currentRevision.state !== "SEALED") out.push("NO_SEALED_REVISION");
  if (facts.targetContract === null) out.push("TARGET_CONTRACT_MISSING");
  else if (facts.targetContract.confirmedAt === undefined || facts.targetContract.supersededAt !== undefined) out.push("TARGET_CONTRACT_UNCONFIRMED");
  if (facts.plan === null) out.push("PLAN_MISSING");
  else if (facts.plan.state === "APPROVED") {
    // nothing: an approved plan is execution-ready from the plan's side
  } else if (facts.plan.state === "VALIDATED") out.push("PLAN_NOT_APPROVED");
  else out.push("PLAN_NOT_VALIDATED");
  return out;
}

export function projectView(p: ProjectRecord, revision: DatasetRevisionRecord, blockers: ReadonlyArray<ReadinessBlocker>): ProjectView {
  return {
    projectId: p.projectId,
    agencyId: p.agencyId,
    clientId: p.clientId,
    version: p.version,
    state: p.state,
    mode: p.mode,
    purpose: p.purpose,
    ...(p.targetInstanceRef !== undefined ? { targetInstanceRef: p.targetInstanceRef } : {}),
    capabilityVersion: p.capabilityVersion,
    currentRevision: { revisionId: revision.revisionId, state: revision.state, version: revision.version },
    readinessBlockers: blockers,
    createdAt: p.createdAt,
  };
}

export function planView(p: PlanRecord): PlanView {
  return {
    planId: p.planId,
    agencyId: p.agencyId,
    projectId: p.projectId,
    version: p.version,
    state: p.state,
    bodyHash: p.bodyHash,
    revisionHash: p.revisionHash,
    targetContractHash: p.targetContractHash,
    policyHash: p.policyHash,
    ...(p.validationReceiptHash !== undefined ? { validationReceiptHash: p.validationReceiptHash } : {}),
    ...(p.approvalId !== undefined ? { approvalId: p.approvalId } : {}),
    ...(p.supersedesPlanId !== undefined ? { supersedesPlanId: p.supersedesPlanId } : {}),
    ...(p.supersededByPlanId !== undefined ? { supersededByPlanId: p.supersededByPlanId } : {}),
    createdAt: p.createdAt,
  };
}

export function approvalView(a: ApprovalRecord): ApprovalView {
  return {
    approvalId: a.approvalId,
    agencyId: a.agencyId,
    planId: a.planId,
    version: a.version,
    actorMembershipId: a.actorMembershipId,
    planHash: a.planHash,
    revisionHash: a.revisionHash,
    targetContractHash: a.targetContractHash,
    validationReceiptHash: a.validationReceiptHash,
    disclosuresHash: a.disclosuresHash,
    approvalHash: a.approvalHash,
    createdAt: a.createdAt,
    ...(a.withdrawnAt !== undefined ? { withdrawnAt: a.withdrawnAt } : {}),
    ...(a.withdrawReasonCode !== undefined ? { withdrawReasonCode: a.withdrawReasonCode } : {}),
  };
}

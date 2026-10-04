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
  SupportCaseRecord,
  TargetContractRecord,
} from "@kauro/domain";
import { OFFERED_CAPABILITY_STATES, capabilitiesOf } from "@kauro/domain";
import type { ResourceAction } from "./permitted-actions.js";
import type { AgencyMembershipView, AgencyView, ApprovalView, EndClientView, MembershipView, PlanView, ProjectView, ReadinessBlocker, SupportCaseView, TeamMemberView } from "./views.js";

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

export function endClientView(c: EndClientRecord, permittedActions: ReadonlyArray<ResourceAction>): EndClientView {
  return {
    clientId: c.clientId,
    agencyId: c.agencyId,
    version: c.version,
    displayName: c.displayName,
    state: c.state,
    processingAuthorityRef: c.processingAuthorityRef,
    createdAt: c.createdAt,
    ...(c.archivedAt !== undefined ? { archivedAt: c.archivedAt } : {}),
    permittedActions,
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

export function projectView(p: ProjectRecord, revision: DatasetRevisionRecord, blockers: ReadonlyArray<ReadinessBlocker>, permittedActions: ReadonlyArray<ResourceAction>): ProjectView {
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
    permittedActions,
  };
}

export function planView(p: PlanRecord, permittedActions: ReadonlyArray<ResourceAction>): PlanView {
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
    permittedActions,
  };
}

export function approvalView(a: ApprovalRecord, permittedActions: ReadonlyArray<ResourceAction>): ApprovalView {
  return {
    approvalId: a.approvalId,
    actorId: a.actorId,
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
    ...(a.withdrawnByMembershipId !== undefined ? { withdrawnByMembershipId: a.withdrawnByMembershipId } : {}),
    ...(a.withdrawReasonCode !== undefined ? { withdrawReasonCode: a.withdrawReasonCode } : {}),
    permittedActions,
  };
}

/** GET /agencies: an actual membership and its agency; a SUSPENDED membership carries no capability (N16). */
export function agencyMembershipView(agency: AgencyRecord, membership: MembershipRecord): AgencyMembershipView {
  return {
    agencyId: agency.agencyId,
    displayName: agency.displayName,
    state: agency.state,
    version: agency.version,
    membershipId: membership.membershipId,
    role: membership.role,
    membershipState: membership.state,
    permittedActions: membership.state === "ACTIVE" ? capabilitiesOf(membership.role) : [],
  };
}

/**
 * GET /agencies/{agencyId}/members: a teammate as the caller may see it (N16; 10 "returns only team information appropriate to
 * the caller"). A team manager also sees when the membership was created and accepted; no caller sees another member's identity
 * reference, assurance policy or security evidence.
 */
export function teamMemberView(m: MembershipRecord, callerMembershipId: string, managesTeam: boolean): TeamMemberView {
  return {
    membershipId: m.membershipId,
    role: m.role,
    state: m.state,
    version: m.version,
    self: m.membershipId === callerMembershipId,
    ...(managesTeam ? { createdAt: m.createdAt } : {}),
    ...(managesTeam && m.acceptedAt !== undefined ? { acceptedAt: m.acceptedAt } : {}),
  };
}

/** A support case: an explicit selection, so the identity of the opener (the user id) and the audit columns never reach the wire. */
export function supportCaseView(c: SupportCaseRecord): SupportCaseView {
  return {
    caseId: c.caseId,
    agencyId: c.agencyId,
    projectId: c.projectId,
    category: c.category,
    severity: c.severity,
    state: c.state,
    summary: c.summary,
    evidenceRefs: [...c.evidenceRefs],
    nextReviewAt: c.nextReviewAt,
    createdByMembershipId: c.createdByMembershipId,
    createdAt: c.createdAt,
    version: c.version,
  };
}

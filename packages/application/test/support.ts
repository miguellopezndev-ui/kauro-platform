// Fixtures for the handler orchestration tests: an in-memory store seeded with identities, an agency, memberships, a
// processing authority, a client, a capability, a validated plan with its receipt, source and target — and a permissive
// authorizer that only resolves the caller's live membership (the real Authorizer of @kauro/authorization is exercised in
// its own package and end to end in apps/api; here the subject is the handlers' orchestration given an ALLOW decision).
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type {
  AgencyId,
  ApprovalId,
  AssuranceProofId,
  CapabilityId,
  ClientId,
  CorrelationId,
  IdentityFacts,
  MembershipId,
  MembershipRole,
  PlanBody,
  PlanId,
  ProcessingAuthorityId,
  ProjectId,
  RevisionId,
  TargetContractId,
  UserId,
  ValidationReceiptId,
} from "@kauro/domain";
import { identityUserId } from "@kauro/domain";
import type { AuthenticatedSubject, Authorizer, CommandEnvelope, CommandRuntime, CommandSpec, InMemoryStore } from "../src/index.js";
import { AUTHORIZATION_POLICY_VERSION, createInMemoryPorts, emptyStore, fixedClock, sequentialIds } from "../src/index.js";

export const clock = fixedClock();
export const ids = sequentialIds(clock);

export function sha(s: string): Sha256Hex {
  return createHash("sha256").update(s).digest("hex");
}

export function subject(name: string, opts: { verified?: boolean; state?: "ACTIVE" | "DISABLED" } = {}): AuthenticatedSubject {
  const verified = opts.verified ?? true;
  const identity: IdentityFacts = {
    userId: identityUserId("identity-platform", name),
    emailVerifiedAt: verified ? clock.now() : null,
    mfaEnrolledAt: verified ? clock.now() : null,
    state: opts.state ?? "ACTIVE",
  };
  return { identity, provider: "identity-platform", subjectHash: sha(name) };
}

/** Resolves the live membership like the real authorizer does, then allows; no role or assurance logic here. */
export const allowingAuthorizer: Authorizer = {
  async authorize(uow, request) {
    if (request.agencyId === null) return { kind: "ALLOW", membership: null, assuranceClass: "SESSION", policyVersion: AUTHORIZATION_POLICY_VERSION };
    const m = await uow.memberships.findLive(request.agencyId, request.identity.userId);
    if (!m) return { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER", policyVersion: AUTHORIZATION_POLICY_VERSION };
    return {
      kind: "ALLOW",
      membership: { membershipId: m.membershipId, agencyId: m.agencyId, userId: m.userId, role: m.role, version: m.version, assurancePolicy: m.assurancePolicy },
      assuranceClass: request.assuranceProofRef !== undefined ? "STEP_UP" : "SESSION",
      policyVersion: AUTHORIZATION_POLICY_VERSION,
    };
  },
};

export interface World {
  readonly store: () => InMemoryStore;
  readonly runtime: CommandRuntime;
  readonly owner: AuthenticatedSubject;
  readonly operator: AuthenticatedSubject;
  readonly approver: AuthenticatedSubject;
  readonly stranger: AuthenticatedSubject;
  readonly agencyId: AgencyId;
  readonly otherAgencyId: AgencyId;
  readonly ownerMembershipId: MembershipId;
  readonly operatorMembershipId: MembershipId;
  readonly approverMembershipId: MembershipId;
  readonly authorityId: ProcessingAuthorityId;
  readonly foreignAuthorityId: ProcessingAuthorityId;
  readonly clientId: ClientId;
  readonly foreignClientId: ClientId;
  readonly capabilityId: CapabilityId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly planId: PlanId;
  readonly planBody: PlanBody;
  readonly receiptHash: Sha256Hex;
  readonly proofId: AssuranceProofId;
}

function member(store: InMemoryStore, agencyId: AgencyId, userId: UserId, role: MembershipRole, now: UtcInstant, state: "ACTIVE" | "SUSPENDED" = "ACTIVE"): MembershipId {
  const membershipId = ids.next() as MembershipId;
  store.memberships.set(membershipId, { membershipId, agencyId, userId, role, state, version: 1, assurancePolicy: "MFA_REQUIRED", acceptedAt: now, createdAt: now, updatedAt: now });
  return membershipId;
}

export function planBodyOf(revisionHash: Sha256Hex, targetContractHash: Sha256Hex, marker: string): PlanBody {
  return {
    revisionHash,
    targetContractHash,
    policyHash: sha("policy"),
    mappings: [
      {
        mappingId: ids.next(),
        sourceTableId: ids.next(),
        sourceFieldId: ids.next(),
        targetObject: "Contact",
        targetField: marker,
        intent: { kind: "SET", reasonCode: "MAPPED" },
        evidence: { evidenceId: ids.next(), candidateId: ids.next(), provenance: "AGENCY", factHashes: [], ruleVersion: "R1", comparisonHash: sha("cmp"), fragmentHash: sha("frag") },
      },
    ],
    identities: [],
    transforms: [],
    relationships: [],
  };
}

export function bodyHashOf(body: PlanBody): Sha256Hex {
  return structuredDigest(DOMAINS.PLAN_BODY, 1, body);
}

/** A world with one agency (DRAFT, ready for clients and projects) and one validated plan ready for approval. */
export function world(): World {
  const store = emptyStore();
  const now = clock.now();
  const owner = subject("owner");
  const operator = subject("operator");
  const approver = subject("approver");
  const stranger = subject("stranger");
  for (const s of [owner, operator, approver, stranger]) store.identities.set(s.identity.userId, { ...s.identity, provider: s.provider, subjectHash: s.subjectHash });

  const agencyId = ids.next() as AgencyId;
  store.agencies.set(agencyId, { agencyId, version: 1, displayName: "Acme", state: "DRAFT", createdAt: now, createdByUserId: owner.identity.userId, updatedAt: now });
  const ownerMembershipId = member(store, agencyId, owner.identity.userId, "OWNER", now);
  const operatorMembershipId = member(store, agencyId, operator.identity.userId, "OPERATOR", now);
  const approverMembershipId = member(store, agencyId, approver.identity.userId, "APPROVER", now);

  const otherAgencyId = ids.next() as AgencyId;
  store.agencies.set(otherAgencyId, { agencyId: otherAgencyId, version: 1, displayName: "Other", state: "ACTIVE", createdAt: now, createdByUserId: stranger.identity.userId, updatedAt: now });
  const strangerMembershipId = member(store, otherAgencyId, stranger.identity.userId, "OWNER", now);

  const authorityId = ids.next() as ProcessingAuthorityId;
  store.processingAuthorities.set(authorityId, { processingAuthorityId: authorityId, agencyId, kind: "CLIENT_AUTHORIZATION", evidenceHash: sha("evidence"), recordedByMembershipId: ownerMembershipId, recordedAt: now });
  const foreignAuthorityId = ids.next() as ProcessingAuthorityId;
  store.processingAuthorities.set(foreignAuthorityId, { processingAuthorityId: foreignAuthorityId, agencyId: otherAgencyId, kind: "OWN_DATA", evidenceHash: sha("foreign"), recordedByMembershipId: strangerMembershipId, recordedAt: now });

  const clientId = ids.next() as ClientId;
  store.endClients.set(clientId, { clientId, agencyId, version: 1, displayName: "Client A", state: "ACTIVE", processingAuthorityRef: authorityId, createdByMembershipId: ownerMembershipId, createdAt: now, updatedAt: now });
  const foreignClientId = ids.next() as ClientId;
  store.endClients.set(foreignClientId, { clientId: foreignClientId, agencyId: otherAgencyId, version: 1, displayName: "Foreign", state: "ACTIVE", processingAuthorityRef: foreignAuthorityId, createdByMembershipId: strangerMembershipId, createdAt: now, updatedAt: now });

  const capabilityId = ids.next() as CapabilityId;
  store.capabilities.set(capabilityId, { capabilityId, version: "R2-INITIAL", kind: "MODE", mode: "CLEAN", state: "AVAILABLE_LIMITED", profileHash: sha("profile"), qualificationEvidenceHashes: [sha("q")], reviewTrigger: "VENDOR_OR_ENVELOPE_CHANGE" });
  const designOnly = ids.next() as CapabilityId;
  store.capabilities.set(designOnly, { capabilityId: designOnly, version: "R2-INITIAL", kind: "MODE", mode: "HUBSPOT", state: "DESIGN", profileHash: sha("hs"), qualificationEvidenceHashes: [], reviewTrigger: "VENDOR_OR_ENVELOPE_CHANGE" });

  const projectId = ids.next() as ProjectId;
  const revisionId = ids.next() as RevisionId;
  const revisionHash = sha("manifest");
  store.revisions.set(revisionId, { revisionId, agencyId, projectId, scope: { agencyId, clientId, projectId }, version: 3, state: "SEALED", manifestHash: revisionHash, projectionHash: sha("projection"), sealedAt: now, createdAt: now, updatedAt: now });
  store.projects.set(projectId, { projectId, agencyId, clientId, version: 1, state: "OPEN", mode: "CLEAN", purpose: "Dedupe", capabilityId, capabilityVersion: "R2-INITIAL", currentRevisionId: revisionId, createdByMembershipId: ownerMembershipId, createdAt: now, updatedAt: now });

  const targetContractHash = sha("target-body");
  const contractId = ids.next() as TargetContractId;
  store.targetContracts.set(contractId, { contractId, agencyId, projectId, mode: "CLEAN", instanceId: "clean-instance", importerProfileId: "profile", importerVersion: "1", bodyHash: targetContractHash, observedAt: now, confirmedAt: now, authorityEvidenceHash: sha("auth"), capabilityVersion: "R2-INITIAL" });

  const planId = ids.next() as PlanId;
  const planBody = planBodyOf(revisionHash, targetContractHash, "Phone");
  const bodyHash = bodyHashOf(planBody);
  const receiptHash = sha("receipt");
  store.plans.set(planId, { planId, agencyId, projectId, version: 4, state: "VALIDATED", revisionHash, targetContractHash, policyHash: planBody.policyHash, bodyHash, validationReceiptHash: receiptHash, createdByMembershipId: operatorMembershipId, createdAt: now, updatedAt: now });
  store.planBodies.set(planId, planBody);
  const receiptId = ids.next() as ValidationReceiptId;
  store.receipts.set(receiptId, {
    receiptId,
    agencyId,
    planId,
    receiptHash,
    revisionHash,
    targetContractHash,
    planHash: bodyHash,
    corePackageHash: sha("core"),
    profileEvidenceHash: sha("pe"),
    dispositionEvidenceHash: sha("de"),
    artifactEvidenceHash: sha("ae"),
    startedAt: now,
    completedAt: now,
    result: "VALID",
    counts: { physicalSourceRows: 10, logicalSourceRecords: 10, billableSourceUnits: 10, associationEdges: 0, emittedRepresentatives: 10, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 10 },
    blockingIssueCodes: [],
  });

  const proofId = ids.next() as AssuranceProofId;
  store.proofs.set(proofId, { proofId, userId: approver.identity.userId, kind: "STEP_UP", method: "TOTP", issuedAt: now, expiresAt: new Date(clock.nowMs() + 900_000).toISOString() });

  const ports = createInMemoryPorts(clock, ids, store);
  return {
    store: () => ports.store,
    runtime: { unitOfWork: ports.unitOfWork, authorizer: allowingAuthorizer, clock, ids },
    owner,
    operator,
    approver,
    stranger,
    agencyId,
    otherAgencyId,
    ownerMembershipId,
    operatorMembershipId,
    approverMembershipId,
    authorityId,
    foreignAuthorityId,
    clientId,
    foreignClientId,
    capabilityId,
    projectId,
    revisionId,
    revisionHash,
    targetContractHash,
    planId,
    planBody,
    receiptHash,
    proofId,
  };
}

export function envelope<Body>(spec: CommandSpec<Body>, s: AuthenticatedSubject, input: { key: string; agencyId?: AgencyId; path?: Record<string, string>; body: Body }): CommandEnvelope<Body> {
  const agencyId = spec.scope === "NONE" ? null : spec.scope === "AGENCY_PATH" ? ((input.path?.["agencyId"] as AgencyId | undefined) ?? null) : (input.agencyId ?? null);
  return {
    command: spec.id,
    environment: "LOCAL",
    correlationId: ids.next() as CorrelationId,
    idempotencyKey: input.key,
    userId: s.identity.userId,
    subject: s,
    agencyId,
    path: input.path ?? {},
    body: input.body,
    receivedAt: clock.now(),
  };
}

export function approvalId(store: InMemoryStore, planId: PlanId): ApprovalId | undefined {
  return [...store.approvals.values()].find((a) => a.planId === planId)?.approvalId;
}

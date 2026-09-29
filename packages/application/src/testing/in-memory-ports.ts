/**
 * In-memory implementation of the domain ports for PURE ORCHESTRATION TESTS of the command handlers and the authorizer
 * (B06 mandate: "write handler tests with an in-memory implementation of the ports ONLY for pure orchestration logic — the
 * B06 case tests against real PostgreSQL are written at integration"). It is never wired in a deployable entrypoint and it is
 * not a database: no row locks, no concurrency, no SQL. What it does model faithfully, because the orchestration depends on it:
 *
 * - one unit of work = one atomic change set (a throw restores the store to the state at entry, journal reservation included);
 * - the execution context: a TENANT context sees only rows of its agency, an IDENTITY context sees its own identity rows and
 *   nothing tenant-owned until `adoptTenant`; a foreign row reads as null exactly like a row-level-security miss;
 * - compare-and-swap on `version` (a miss returns the current safe version and state);
 * - the uniqueness the database closes: journal identity (replay / conflict), one DRAFT agency per creator, one live membership
 *   per user and agency, one live approval per plan, a predecessor superseded once, one offered capability per mode;
 * - event publication with the payload allowlist and the outbox fan-out of EVENT_SUBSCRIPTIONS.
 */
import type { Agency, Capability, Id, Membership, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type {
  AgencyId,
  AgencyRecord,
  ApprovalId,
  ApprovalRecord,
  AssuranceProof,
  AssuranceProofId,
  CapabilityId,
  CapabilityRecord,
  ClientId,
  Clock,
  CommandJournal,
  CommandJournalEntry,
  DatasetRevisionRecord,
  DomainEventRecord,
  EndClientRecord,
  EventId,
  EventPublisher,
  ExecutionContext,
  IdGenerator,
  IdempotencyIdentity,
  IdentityFacts,
  InboxConsumerStore,
  InvitationRepository,
  JournalCommit,
  JournalEntryId,
  LeaseStore,
  MembershipId,
  MembershipRecord,
  NewAgency,
  NewApproval,
  NewDomainEvent,
  NewEndClient,
  NewMembership,
  NewPlanRevision,
  NewProject,
  NewSupportCase,
  OutboxDispatchStore,
  OutboxId,
  PlanBody,
  PlanId,
  PlanRecord,
  ProcessingAuthorityId,
  ProcessingAuthorityRecord,
  ProjectId,
  ProjectRecord,
  ProjectState,
  SupportCaseId,
  SupportCaseRecord,
  PublishedEvent,
  RequestJournal,
  ReservationOutcome,
  RevisionId,
  SecurityEvent,
  ServiceMode,
  TargetContractId,
  TargetContractRecord,
  UnitOfWork,
  UnitOfWorkFactory,
  UserId,
  ValidationReceiptId,
  ValidationReceiptRecord,
  VersionedWrite,
} from "@kauro/domain";
import { DomainFailure, EVENT_SCHEMA_VERSION, assertAllowlistedPayload, consumersOf, payloadDigest, userIdOf } from "@kauro/domain";

export interface OutboxRow {
  readonly outboxId: OutboxId;
  readonly eventId: EventId;
  readonly consumer: string;
  readonly state: "PENDING";
}

/** The whole state, cloneable with structuredClone (plain data only). */
export interface InMemoryStore {
  identities: Map<string, IdentityFacts & { provider: string; subjectHash: Sha256Hex }>;
  proofs: Map<string, AssuranceProof>;
  agencies: Map<string, AgencyRecord>;
  memberships: Map<string, MembershipRecord>;
  processingAuthorities: Map<string, ProcessingAuthorityRecord>;
  endClients: Map<string, EndClientRecord>;
  projects: Map<string, ProjectRecord>;
  supportCases: Map<string, SupportCaseRecord>;
  revisions: Map<string, DatasetRevisionRecord>;
  targetContracts: Map<string, TargetContractRecord>;
  plans: Map<string, PlanRecord>;
  planBodies: Map<string, PlanBody>;
  receipts: Map<string, ValidationReceiptRecord>;
  approvals: Map<string, ApprovalRecord>;
  capabilities: Map<string, CapabilityRecord>;
  securityEvents: SecurityEvent[];
  events: DomainEventRecord[];
  outbox: OutboxRow[];
  journal: Map<string, CommandJournalEntry>;
}

export function emptyStore(): InMemoryStore {
  return {
    identities: new Map(),
    proofs: new Map(),
    agencies: new Map(),
    memberships: new Map(),
    processingAuthorities: new Map(),
    endClients: new Map(),
    projects: new Map(),
    supportCases: new Map(),
    revisions: new Map(),
    targetContracts: new Map(),
    plans: new Map(),
    planBodies: new Map(),
    receipts: new Map(),
    approvals: new Map(),
    capabilities: new Map(),
    securityEvents: [],
    events: [],
    outbox: [],
    journal: new Map(),
  };
}

export function journalKey(i: IdempotencyIdentity): string {
  const actor = i.actor.kind === "USER" ? `USER:${i.actor.userId}` : i.actor.kind === "SERVICE" ? `SERVICE:${i.actor.serviceId}` : "SYSTEM";
  return [i.environment, actor, i.agencyId ?? "-", i.operation, i.key].join("|");
}

const LIVE_MEMBERSHIP: ReadonlySet<Membership["state"]> = new Set<Membership["state"]>(["INVITED", "ACTIVE", "SUSPENDED"]);

export interface InMemoryPorts {
  readonly store: InMemoryStore;
  readonly unitOfWork: UnitOfWorkFactory;
}

/**
 * Builds the factory over a store. Each `run` clones the store at entry; on a throw the clone is discarded and the original
 * stays untouched (atomicity); on success the clone replaces the original (commit).
 */
export function createInMemoryPorts(clock: Clock, ids: IdGenerator, initial: InMemoryStore = emptyStore()): InMemoryPorts {
  const holder = { store: initial };
  const factory: UnitOfWorkFactory = {
    async run<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      const working = structuredClone(holder.store);
      const uow = createUnitOfWork(working, context, clock, ids);
      const out = await work(uow);
      holder.store = working;
      return out;
    },
  };
  return {
    get store() {
      return holder.store;
    },
    unitOfWork: factory,
  };
}

function createUnitOfWork(s: InMemoryStore, initialContext: ExecutionContext, clock: Clock, sharedIds: IdGenerator): UnitOfWork {
  let context: ExecutionContext = initialContext;
  let adopted = false;
  let resolvedMembershipId: MembershipId | null = null;
  const appended: DomainEventRecord[] = [];
  // D-PORT-1: every aggregate id a command mints comes from the unit of work, which is what lets adoptTenant prove the
  // adopted id was minted here (the pg adapter keeps the same record of minted ids)
  const minted = new Set<string>();
  const ids: IdGenerator = {
    next(): Id {
      const id = sharedIds.next();
      minted.add(id);
      return id;
    },
  };

  const tenantId = (): AgencyId | null => (context.kind === "TENANT" ? context.agencyId : null);
  const userId = (): UserId | null => userIdOf(context);
  /** A tenant-owned row is visible only under its own tenant context (RLS USING); a write outside it fails (WITH CHECK). */
  const visible = <T extends { readonly agencyId: AgencyId }>(row: T | undefined): T | null => (row !== undefined && tenantId() !== null && row.agencyId === tenantId() ? row : null);
  const checkWrite = (agencyId: AgencyId): void => {
    if (tenantId() !== agencyId) throw new DomainFailure("NOT_FOUND", "row-level security refused the write (no tenant context for this agency)", { reason: "TENANT_CONTEXT_MISSING" });
  };
  const notInMemory = (what: string): never => {
    throw new Error(`${what} is not part of the in-memory ports: the B06 handlers never call it; the real adapter is tested against PostgreSQL`);
  };
  /** The offered capability of a mode, else any capability of the mode (the lock variants lock nothing here: no concurrency). */
  const modeOf = (mode: ServiceMode): CapabilityRecord | null => {
    const offered = [...s.capabilities.values()].filter((c) => c.kind === "MODE" && c.mode === mode && (c.state === "AVAILABLE" || c.state === "AVAILABLE_LIMITED"));
    if (offered.length > 1) throw new DomainFailure("INTEGRITY_FAILURE", "one offered capability per mode");
    return offered[0] ?? [...s.capabilities.values()].find((c) => c.kind === "MODE" && c.mode === mode) ?? null;
  };

  const events: EventPublisher = {
    appended,
    async publish(e: NewDomainEvent): Promise<PublishedEvent> {
      assertAllowlistedPayload(e.eventType, e.payload);
      if (s.events.some((x) => x.aggregateKind === e.aggregateKind && x.aggregateId === e.aggregateId && x.aggregateVersion === e.aggregateVersion)) {
        throw new DomainFailure("INTEGRITY_FAILURE", "an event for this aggregate version already exists");
      }
      const record: DomainEventRecord = {
        eventId: ids.next() as EventId,
        aggregateKind: e.aggregateKind,
        aggregateId: e.aggregateId,
        aggregateVersion: e.aggregateVersion,
        ...(e.agencyId !== null ? { agencyId: e.agencyId } : {}),
        eventType: e.eventType,
        actor: e.actor,
        causationId: e.causationId,
        correlationId: e.correlationId,
        payloadArtifactHash: payloadDigest(e.payload),
        payload: e.payload,
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: s.events.length + 1,
        createdAt: clock.now(),
      };
      s.events.push(record);
      appended.push(record);
      const outbox = consumersOf(e.eventType).map((consumer) => {
        const row: OutboxRow = { outboxId: ids.next() as OutboxId, eventId: record.eventId, consumer, state: "PENDING" };
        s.outbox.push(row);
        return { outboxId: row.outboxId, consumer };
      });
      return { event: record, outbox };
    },
    async get(eventId) {
      const e = s.events.find((x) => x.eventId === eventId);
      return e && e.agencyId === tenantId() ? e : null;
    },
  };

  const journal: CommandJournal = {
    async reserve(identity, digest, correlationId): Promise<ReservationOutcome> {
      const key = journalKey(identity);
      const existing = s.journal.get(key);
      if (existing) {
        if (existing.requestDigest !== digest) return { kind: "CONFLICT", entry: existing };
        return existing.state === "COMMITTED" ? { kind: "REPLAY", entry: existing } : { kind: "PENDING", entry: existing };
      }
      const entry: CommandJournalEntry = { entryId: ids.next() as JournalEntryId, identity, requestDigest: digest, state: "RESERVED", correlationId, reservedAt: clock.now() };
      s.journal.set(key, entry);
      return { kind: "RESERVED", entryId: entry.entryId };
    },
    async commit(entryId, result: JournalCommit) {
      for (const [k, e] of s.journal) {
        if (e.entryId === entryId) {
          // RESERVED → COMMITTED, and the provider-effect path RESERVED → UNCERTAIN → COMMITTED (package B09, D-JOURNAL-B1)
          if (e.state !== "RESERVED" && e.state !== "UNCERTAIN") throw new DomainFailure("INTEGRITY_FAILURE", "journal entry is final");
          const committed: CommandJournalEntry = { ...e, state: "COMMITTED", responseStatus: result.responseStatus, responseBody: structuredClone(result.responseBody), resourceKind: result.resourceKind, resourceId: result.resourceId, committedAt: clock.now() };
          s.journal.set(k, committed);
          return committed;
        }
      }
      throw new DomainFailure("INTEGRITY_FAILURE", "journal entry not found");
    },
    async markUncertain(entryId) {
      for (const [k, e] of s.journal) if (e.entryId === entryId) s.journal.set(k, { ...e, state: "UNCERTAIN" });
    },
    async find(identity) {
      return s.journal.get(journalKey(identity)) ?? null;
    },
  };

  const cas = <T extends { readonly version: number }>(row: T | null, expected: number, change: (r: T) => T, stateOf: (r: T) => string = (r) => String((r as { readonly state?: string }).state)): VersionedWrite<T> => {
    if (!row) throw new DomainFailure("NOT_FOUND", "row not visible");
    if (row.version !== expected) return { kind: "STALE", currentVersion: row.version, currentState: stateOf(row) };
    return { kind: "APPLIED", record: change(row) };
  };

  const uow: UnitOfWork = {
    get context() {
      return context;
    },
    get resolvedMembershipId() {
      return resolvedMembershipId;
    },
    get userId() {
      return userId();
    },
    ids,
    resolveMembership(membershipId) {
      if (context.kind !== "TENANT") throw new DomainFailure("INTEGRITY_FAILURE", "a membership is resolved only inside a TENANT context");
      if (resolvedMembershipId !== null) throw new DomainFailure("INTEGRITY_FAILURE", "the membership of this unit of work was already resolved");
      resolvedMembershipId = membershipId;
    },
    async adoptTenant(agencyId) {
      if (context.kind !== "IDENTITY" || adopted) throw new DomainFailure("INTEGRITY_FAILURE", "adoptTenant is allowed once, from an IDENTITY context");
      if (!minted.has(agencyId)) throw new DomainFailure("INTEGRITY_FAILURE", "adoptTenant accepts only an agency id minted in this unit of work");
      adopted = true;
      context = { kind: "TENANT", agencyId, userId: context.userId, correlationId: context.correlationId };
    },
    identities: {
      async getOwn(id) {
        const row = s.identities.get(id);
        return row && userId() === id ? { userId: row.userId, emailVerifiedAt: row.emailVerifiedAt, mfaEnrolledAt: row.mfaEnrolledAt, state: row.state } : null;
      },
      async syncOwn(facts, provider, subjectHash) {
        if (userId() !== facts.userId) throw new DomainFailure("NOT_FOUND", "self policy refused the identity write", { reason: "TENANT_CONTEXT_MISSING" });
        // the stored security status is never the request handler's to write: first sight is ACTIVE, and a DISABLED row stays so
        const stored = s.identities.get(facts.userId);
        const record = { ...facts, state: stored?.state ?? ("ACTIVE" as const), provider: stored?.provider ?? provider, subjectHash: stored?.subjectHash ?? subjectHash };
        s.identities.set(facts.userId, record);
        return { userId: record.userId, emailVerifiedAt: record.emailVerifiedAt, mfaEnrolledAt: record.mfaEnrolledAt, state: record.state };
      },
      async getOwnProof(id, proofId) {
        const p = s.proofs.get(proofId);
        return p && p.userId === id && userId() === id ? p : null;
      },
    },
    agencies: {
      async get(agencyId) {
        return visible(s.agencies.get(agencyId));
      },
      async lock(agencyId) {
        return visible(s.agencies.get(agencyId));
      },
      async lockShared(agencyId) {
        return visible(s.agencies.get(agencyId));
      },
      async insert(a: NewAgency) {
        checkWrite(a.agencyId);
        for (const x of s.agencies.values()) {
          if (x.createdByUserId === a.createdByUserId && x.state === "DRAFT") throw new DomainFailure("ADMISSION_LIMITED", "one draft agency per identity", { reason: "DRAFT_AGENCY_EXISTS" });
        }
        const record: AgencyRecord = { agencyId: a.agencyId, version: 1, displayName: a.displayName, state: "DRAFT", createdAt: a.createdAt, createdByUserId: a.createdByUserId, updatedAt: a.createdAt };
        s.agencies.set(a.agencyId, record);
        return record;
      },
      async transition(agencyId, expectedVersion, change: Partial<Pick<Agency, "state" | "termsVersion" | "privacyAgreementVersion" | "legalProfileRef" | "firstQualifyingCaptureId">>, now) {
        const w = cas(visible(s.agencies.get(agencyId)), expectedVersion, (r) => ({ ...r, ...change, version: r.version + 1, updatedAt: now }));
        if (w.kind === "APPLIED") s.agencies.set(agencyId, w.record);
        return w;
      },
      async listOwnAgencies(id) {
        const mine = [...s.memberships.values()].filter((m) => m.userId === id && (m.state === "ACTIVE" || m.state === "SUSPENDED"));
        return mine.map((m) => s.agencies.get(m.agencyId)).filter((a): a is AgencyRecord => a !== undefined).map((a) => ({ agencyId: a.agencyId, displayName: a.displayName, state: a.state }));
      },
      // the manual-10 reads are exercised over PostgreSQL only (apps/api/test/reads.test.ts)
      pageOwnMemberships: () => notInMemory("AgencyRepository.pageOwnMemberships"),
    },
    memberships: {
      async get(membershipId) {
        return visible(s.memberships.get(membershipId));
      },
      async lock(membershipId) {
        return visible(s.memberships.get(membershipId));
      },
      async findLive(agencyId, id) {
        if (tenantId() !== agencyId) return null;
        const m = [...s.memberships.values()].find((x) => x.agencyId === agencyId && x.userId === id && LIVE_MEMBERSHIP.has(x.state));
        return m ?? null;
      },
      async listOwn(id) {
        return [...s.memberships.values()].filter((m) => m.userId === id);
      },
      async insert(m: NewMembership) {
        checkWrite(m.agencyId);
        if ([...s.memberships.values()].some((x) => x.agencyId === m.agencyId && x.userId === m.userId && LIVE_MEMBERSHIP.has(x.state))) {
          throw new DomainFailure("PRECONDITION_FAILED", "one live membership per user and agency");
        }
        if (!s.identities.has(m.userId)) throw new DomainFailure("INVALID_REQUEST", "membership references an unknown identity", { reason: "UNKNOWN_REFERENCE" });
        const record: MembershipRecord = {
          membershipId: m.membershipId,
          agencyId: m.agencyId,
          userId: m.userId,
          role: m.role,
          state: m.state,
          version: 1,
          assurancePolicy: m.assurancePolicy,
          ...(m.acceptedAt !== undefined ? { acceptedAt: m.acceptedAt } : {}),
          createdAt: m.createdAt,
          updatedAt: m.createdAt,
        };
        s.memberships.set(m.membershipId, record);
        return record;
      },
      async transition(membershipId, expectedVersion, change, now) {
        const w = cas(visible(s.memberships.get(membershipId)), expectedVersion, (r) => ({ ...r, ...change, version: r.version + 1, updatedAt: now }));
        if (w.kind === "APPLIED") s.memberships.set(membershipId, w.record);
        return w;
      },
      async countActiveOwners(agencyId) {
        return [...s.memberships.values()].filter((m) => m.agencyId === agencyId && m.role === "OWNER" && m.state === "ACTIVE").length;
      },
      pageTeam: () => notInMemory("MembershipRepository.pageTeam"),
    },
    invitations: {
      insert: () => notInMemory("InvitationRepository.insert"),
      get: () => notInMemory("InvitationRepository.get"),
      findByTokenHash: () => notInMemory("InvitationRepository.findByTokenHash"),
      consume: () => notInMemory("InvitationRepository.consume"),
      revoke: () => notInMemory("InvitationRepository.revoke"),
    } satisfies InvitationRepository,
    processingAuthorities: {
      async get(id: ProcessingAuthorityId) {
        return visible(s.processingAuthorities.get(id));
      },
      async record(r) {
        checkWrite(r.agencyId);
        // the identity of a reference is global (primary key); another agency's record is invisible, this agency's is reused
        const existing = s.processingAuthorities.get(r.processingAuthorityId);
        if (existing !== undefined) {
          const mine = visible(existing);
          return mine === null ? null : { kind: "EXISTING" as const, record: mine };
        }
        s.processingAuthorities.set(r.processingAuthorityId, r);
        return { kind: "RECORDED" as const, record: r };
      },
    },
    endClients: {
      async get(clientId: ClientId) {
        return visible(s.endClients.get(clientId));
      },
      async lock(clientId: ClientId) {
        return visible(s.endClients.get(clientId));
      },
      async insert(c: NewEndClient) {
        checkWrite(c.agencyId);
        const authority = s.processingAuthorities.get(c.processingAuthorityRef);
        if (!authority || authority.agencyId !== c.agencyId) throw new DomainFailure("INVALID_REQUEST", "composite foreign key refused the authority reference", { reason: "UNKNOWN_REFERENCE" });
        const record: EndClientRecord = {
          clientId: c.clientId,
          agencyId: c.agencyId,
          version: 1,
          displayName: c.displayName,
          state: "ACTIVE",
          processingAuthorityRef: c.processingAuthorityRef,
          createdByMembershipId: c.createdByMembershipId,
          createdAt: c.createdAt,
          updatedAt: c.createdAt,
        };
        s.endClients.set(c.clientId, record);
        return record;
      },
      async archive(clientId, expectedVersion, now) {
        const w = cas(visible(s.endClients.get(clientId)), expectedVersion, (r) => ({ ...r, state: "ARCHIVED" as const, archivedAt: now, version: r.version + 1, updatedAt: now }));
        if (w.kind === "APPLIED") s.endClients.set(clientId, w.record);
        return w;
      },
      async list(agencyId, page) {
        if (tenantId() !== agencyId) return [];
        return [...s.endClients.values()].filter((c) => c.agencyId === agencyId).slice(0, page.limit);
      },
      async countOpenProjects(clientId) {
        return [...s.projects.values()].filter((p) => p.clientId === clientId && p.state === "OPEN" && p.agencyId === tenantId()).length;
      },
    },
    projects: {
      async get(projectId: ProjectId) {
        return visible(s.projects.get(projectId));
      },
      async lock(projectId: ProjectId) {
        return visible(s.projects.get(projectId));
      },
      async insertWithDraftRevision(p: NewProject) {
        checkWrite(p.agencyId);
        const client = s.endClients.get(p.clientId);
        if (!client || client.agencyId !== p.agencyId) throw new DomainFailure("INVALID_REQUEST", "composite foreign key refused the client reference", { reason: "UNKNOWN_REFERENCE" });
        const revision: DatasetRevisionRecord = {
          revisionId: p.initialRevisionId,
          agencyId: p.agencyId,
          projectId: p.projectId,
          scope: { agencyId: p.agencyId, clientId: p.clientId, projectId: p.projectId },
          version: 1,
          state: "DRAFT",
          createdAt: p.createdAt,
          updatedAt: p.createdAt,
        };
        const project: ProjectRecord = {
          projectId: p.projectId,
          agencyId: p.agencyId,
          clientId: p.clientId,
          version: 1,
          state: "OPEN",
          mode: p.mode,
          purpose: p.purpose,
          ...(p.targetInstanceRef !== undefined ? { targetInstanceRef: p.targetInstanceRef } : {}),
          capabilityId: p.capabilityId,
          capabilityVersion: p.capabilityVersion,
          currentRevisionId: p.initialRevisionId,
          createdByMembershipId: p.createdByMembershipId,
          createdAt: p.createdAt,
          updatedAt: p.createdAt,
        };
        s.revisions.set(revision.revisionId, revision);
        s.projects.set(project.projectId, project);
        return { project, revision };
      },
      async transition(projectId, expectedVersion, change: { readonly state: ProjectState }, now) {
        const w = cas(visible(s.projects.get(projectId)), expectedVersion, (r) => ({ ...r, state: change.state, version: r.version + 1, updatedAt: now }));
        if (w.kind === "APPLIED") s.projects.set(projectId, w.record);
        return w;
      },
    },
    supportCases: {
      async get(caseId: SupportCaseId) {
        return visible(s.supportCases.get(caseId));
      },
      async insert(c: NewSupportCase) {
        checkWrite(c.agencyId);
        const project = s.projects.get(c.projectId);
        if (!project || project.agencyId !== c.agencyId) throw new DomainFailure("INVALID_REQUEST", "composite foreign key refused the project reference", { reason: "UNKNOWN_REFERENCE" });
        const record: SupportCaseRecord = {
          caseId: c.caseId,
          agencyId: c.agencyId,
          projectId: c.projectId,
          category: c.category,
          severity: c.severity,
          state: "OPEN",
          summary: c.summary,
          evidenceRefs: [...c.evidenceRefs],
          createdByUserId: c.createdByUserId,
          createdByMembershipId: c.createdByMembershipId,
          nextReviewAt: c.nextReviewAt,
          version: 1,
          createdAt: c.createdAt,
          updatedAt: c.createdAt,
        };
        s.supportCases.set(c.caseId, record);
        return record;
      },
      async listByProject(agencyId, projectId, page) {
        if (tenantId() !== agencyId) return [];
        const after = page.after;
        return [...s.supportCases.values()]
          .filter((c) => c.agencyId === agencyId && c.projectId === projectId)
          .sort((a, b) => (a.createdAt === b.createdAt ? (a.caseId < b.caseId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
          .filter((c) => after === undefined || c.createdAt > after.createdAt || (c.createdAt === after.createdAt && c.caseId > after.id))
          .slice(0, page.limit);
      },
    },
    revisions: {
      async get(revisionId: RevisionId) {
        return visible(s.revisions.get(revisionId));
      },
      async lockSealedByHash(agencyId, projectId, revisionHash) {
        if (tenantId() !== agencyId) return null;
        return [...s.revisions.values()].find((r) => r.agencyId === agencyId && r.projectId === projectId && r.manifestHash === revisionHash) ?? null;
      },
    },
    targetContracts: {
      async get(contractId: TargetContractId) {
        return visible(s.targetContracts.get(contractId));
      },
      async lockCurrentByHash(agencyId, projectId, hash) {
        if (tenantId() !== agencyId) return null;
        return [...s.targetContracts.values()].find((t) => t.agencyId === agencyId && t.projectId === projectId && t.bodyHash === hash) ?? null;
      },
      findLatestForProject: () => notInMemory("TargetContractRepository.findLatestForProject"),
    },
    plans: {
      async get(planId: PlanId) {
        return visible(s.plans.get(planId));
      },
      async lock(planId: PlanId) {
        return visible(s.plans.get(planId));
      },
      async getBody(planId) {
        return visible(s.plans.get(planId)) ? (s.planBodies.get(planId) ?? null) : null;
      },
      async insert(p: NewPlanRevision) {
        checkWrite(p.agencyId);
        if (p.supersedesPlanId !== undefined && [...s.plans.values()].some((x) => x.supersedesPlanId === p.supersedesPlanId)) {
          throw new DomainFailure("STALE_VERSION", "a predecessor is superseded once");
        }
        const record: PlanRecord = {
          planId: p.planId,
          agencyId: p.agencyId,
          projectId: p.projectId,
          version: 1,
          state: "DRAFT",
          revisionHash: p.body.revisionHash,
          targetContractHash: p.body.targetContractHash,
          policyHash: p.body.policyHash,
          bodyHash: structuredDigest(DOMAINS.PLAN_BODY, 1, p.body),
          ...(p.supersedesPlanId !== undefined ? { supersedesPlanId: p.supersedesPlanId } : {}),
          createdByMembershipId: p.createdByMembershipId,
          createdAt: p.createdAt,
          updatedAt: p.createdAt,
        };
        s.plans.set(p.planId, record);
        s.planBodies.set(p.planId, structuredClone(p.body));
        return record;
      },
      async transition(planId, expectedVersion, change, now) {
        const w = cas(visible(s.plans.get(planId)), expectedVersion, (r) => {
          const next: PlanRecord = { ...r, state: change.state, version: r.version + 1, updatedAt: now };
          const mutable = next as { -readonly [K in keyof PlanRecord]: PlanRecord[K] };
          if (change.supersededByPlanId !== undefined) mutable.supersededByPlanId = change.supersededByPlanId;
          if (change.validationReceiptHash === null) delete mutable.validationReceiptHash;
          else if (change.validationReceiptHash !== undefined) mutable.validationReceiptHash = change.validationReceiptHash;
          if (change.approvalId === null) delete mutable.approvalId;
          else if (change.approvalId !== undefined) mutable.approvalId = change.approvalId;
          return next;
        });
        if (w.kind === "APPLIED") s.plans.set(planId, w.record);
        return w;
      },
      findCurrentForProject: () => notInMemory("PlanRepository.findCurrentForProject"),
    },
    receipts: {
      async get(receiptId: ValidationReceiptId) {
        return visible(s.receipts.get(receiptId));
      },
      async findByHash(agencyId, receiptHash) {
        if (tenantId() !== agencyId) return null;
        return [...s.receipts.values()].find((r) => r.agencyId === agencyId && r.receiptHash === receiptHash) ?? null;
      },
    },
    approvals: {
      async get(approvalId: ApprovalId) {
        return visible(s.approvals.get(approvalId));
      },
      async findLiveByPlan(planId) {
        return [...s.approvals.values()].find((a) => a.planId === planId && a.agencyId === tenantId() && a.withdrawnAt === undefined) ?? null;
      },
      async insert(a: NewApproval) {
        checkWrite(a.agencyId);
        const plan = s.plans.get(a.planId);
        if (!plan || plan.agencyId !== a.agencyId || plan.bodyHash !== a.planHash || plan.revisionHash !== a.revisionHash || plan.targetContractHash !== a.targetContractHash) {
          throw new DomainFailure("INVALID_REQUEST", "approval bindings do not match the plan (foreign key)", { reason: "UNKNOWN_REFERENCE" });
        }
        if ([...s.approvals.values()].some((x) => x.planId === a.planId && x.withdrawnAt === undefined)) throw new DomainFailure("STALE_VERSION", "one live approval per plan");
        const record: ApprovalRecord = { ...a, version: 1 };
        s.approvals.set(a.approvalId, record);
        return record;
      },
      async withdraw(approvalId, expectedVersion, by, now) {
        const current = visible(s.approvals.get(approvalId));
        if (current && current.withdrawnAt !== undefined) throw new DomainFailure("INTEGRITY_FAILURE", "withdrawal columns are set once", { reason: "IMMUTABLE_COLUMN" });
        const w = cas(current, expectedVersion, (r) => ({ ...r, withdrawnAt: now, withdrawnByMembershipId: by.membershipId, withdrawReasonCode: by.reasonCode, version: r.version + 1 }), (r) => (r.withdrawnAt === undefined ? "LIVE" : "WITHDRAWN"));
        if (w.kind === "APPLIED") s.approvals.set(approvalId, w.record);
        return w;
      },
    },
    capabilities: {
      async get(capabilityId: CapabilityId) {
        return s.capabilities.get(capabilityId) ?? null;
      },
      async findMode(mode: ServiceMode) {
        return modeOf(mode);
      },
      async lockMode(mode: ServiceMode) {
        return modeOf(mode);
      },
      async list(filter?: { readonly state?: Capability["state"] }) {
        return [...s.capabilities.values()].filter((c) => filter?.state === undefined || c.state === filter.state);
      },
    },
    securityEvents: {
      async append(e) {
        s.securityEvents.push(e);
      },
    },
    events,
    journal,
    leases: {
      claim: () => notInMemory("LeaseStore.claim"),
      heartbeat: () => notInMemory("LeaseStore.heartbeat"),
      checkpoint: () => notInMemory("LeaseStore.checkpoint"),
      cancel: () => notInMemory("LeaseStore.cancel"),
      get: () => notInMemory("LeaseStore.get"),
    } satisfies LeaseStore,
    requestJournal: {
      reserve: () => notInMemory("RequestJournal.reserve"),
      markDispatching: () => notInMemory("RequestJournal.markDispatching"),
      storeResponse: () => notInMemory("RequestJournal.storeResponse"),
      markConsumed: () => notInMemory("RequestJournal.markConsumed"),
      markUncertain: () => notInMemory("RequestJournal.markUncertain"),
      markFailed: () => notInMemory("RequestJournal.markFailed"),
      markCancelled: () => notInMemory("RequestJournal.markCancelled"),
      reconcileUsage: () => notInMemory("RequestJournal.reconcileUsage"),
      get: () => notInMemory("RequestJournal.get"),
      listByTask: () => notInMemory("RequestJournal.listByTask"),
    } satisfies RequestJournal,
    outboxDispatch: {
      claim: () => notInMemory("OutboxDispatchStore.claim"),
      delivered: () => notInMemory("OutboxDispatchStore.delivered"),
      failed: () => notInMemory("OutboxDispatchStore.failed"),
    } satisfies OutboxDispatchStore,
    inbox: {
      claim: () => notInMemory("InboxConsumerStore.claim"),
      settle: () => notInMemory("InboxConsumerStore.settle"),
    } satisfies InboxConsumerStore,
  };
  return uow;
}

/** A fixed clock for deterministic interleaving tests (21 "Concurrency and crash matrix"). */
export function fixedClock(startMs = Date.UTC(2026, 8, 19, 12, 0, 0)): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => new Date(t).toISOString() as UtcInstant,
    nowMs: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** Sequential, deterministic ids for tests (valid UUIDv7 layout; entropy replaced by a counter). */
export function sequentialIds(clock: Clock): IdGenerator {
  let n = 0;
  return {
    next(): Id {
      n += 1;
      const ms = clock.nowMs().toString(16).padStart(12, "0");
      const tail = n.toString(16).padStart(12, "0");
      return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 12).padStart(12, "0")}`;
    },
  };
}

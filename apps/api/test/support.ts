/**
 * Fixture of the B06 acceptance cases (docs/design/B06-case-map.md): the real Fastify server, composed by the real
 * composition root (openDatabase → assembleApi) over a real PostgreSQL 17 the test starts itself (07 "Acceptance
 * obligations"; 21 "Independent oracles": the superuser oracle sees every tenant, the runtime role sees every policy).
 * Nothing fakes the database: the pool is the api's own verified pool on the temporary cluster, the unit of work is the pg
 * adapter, the authorizer, the admission limiter and the handlers are the shipped ones, the validator is the closed
 * contract validator.
 *
 * What the tests bind that a deployment of this edition does not (I-INT-2): deterministic implementations of the three
 * plan-side ports the B06 commands consume but do not own — ArtifactResolver, PlanPatchCompiler, DisclosureComposer. They
 * are ports of @kauro/application, not fakes of the database: the plan rows, receipts, locks and hashes are all real.
 *
 * Deterministic interleavings (21 "Concurrency and crash matrix"): the unit-of-work factory is decorated with hold points
 * (`journal.reserved`, `journal.commit`, `collaborator`, `after.commit`). A RACE test arms one, starts request A, waits until
 * A reached the hold (its transaction open: journal row reserved or aggregate row locked), starts request B, observes B
 * waiting on the lock in pg_stat_activity, then releases A — or aborts it, which makes A throw where it waits — and reads
 * both outcomes. A hold armed with a failure throws as soon as it is reached — a simulated crash before COMMIT
 * (journal.commit) or a lost response after COMMIT (after.commit). No sleep synchronizes anything; the only polling is the
 * observation of pg_stat_activity.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { PoolClient } from "pg";
import { DOMAINS, canonicalize, structuredDigest, type Sha256Hex } from "@kauro/contracts";
import type { ApprovePlanView, AuthenticatedSubject, B06Collaborators, DecisionPatch, DisclosureSet, PatchCompilation, Problem, SchemaValidator } from "@kauro/application";
import { createAdmissionLimiter } from "@kauro/authorization";
import type {
  AgencyId,
  ArtifactRef,
  AssuranceProofId,
  CapabilityId,
  CausationId,
  ClientId,
  Clock,
  CommandJournal,
  ExecutionContext,
  IdGenerator,
  MembershipId,
  PlanBody,
  PlanId,
  ProcessingAuthorityId,
  ProjectId,
  RevisionId,
  UnitOfWork,
  UnitOfWorkFactory,
  UnitOfWorkOptions,
  UserId,
} from "@kauro/domain";
import { createIdGenerator, identityUserId, payloadDigest, toUtcInstant } from "@kauro/domain";
import { ROLES, startHarness, waitForLockWait, type AgencyFixture, type Harness } from "@kauro/persistence";
import { API_APPLICATION_NAME, assembleApi, createBearerTokenAuthenticator, loadContractSchemas, noExternalActionsInThisEdition, openDatabase, openProjectsInspector, subjectOf, type DatabaseHandle } from "../src/index.js";

export const clock: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
export const ids: IdGenerator = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

export function sha(s: string): Sha256Hex {
  return createHash("sha256").update(s).digest("hex");
}

// --- hold points -------------------------------------------------------------------------------------------------------

export type HoldName = "journal.reserved" | "journal.commit" | "collaborator" | "after.commit";

interface ArmedHold {
  readonly reached: () => void;
  readonly release: Promise<void>;
  readonly failure: Error | undefined;
}

export interface Hold {
  /** Resolves when a unit of work reached the hold (its transaction is open at that point). */
  readonly reached: Promise<void>;
  /** Lets the held unit of work continue. */
  release(): void;
  /** Makes the held unit of work throw `error` where it waits: a crash placed after another request was observed waiting. */
  abort(error: Error): void;
}

/** One-shot hold points inside the unit of work; armed by a test, passed by the decorated port. */
export class HoldPoints {
  readonly #armed = new Map<HoldName, ArmedHold>();

  arm(name: HoldName, options: { readonly fail?: Error } = {}): Hold {
    if (this.#armed.has(name)) throw new Error(`hold ${name} is already armed`);
    let reachedResolve: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    let releaseReject: (error: Error) => void = () => undefined;
    const release = new Promise<void>((resolve, reject) => {
      releaseResolve = resolve;
      releaseReject = reject;
    });
    // the holder awaits `release` once it is reached; this handler only keeps an abort of a hold that is never reached from
    // surfacing as an unhandled rejection (the holder still receives the rejection through its own await)
    release.catch(() => undefined);
    this.#armed.set(name, { reached: reachedResolve, release, failure: options.fail });
    return { reached, release: () => releaseResolve(), abort: (error) => releaseReject(error) };
  }

  async pass(name: HoldName): Promise<void> {
    const armed = this.#armed.get(name);
    if (!armed) return;
    this.#armed.delete(name);
    armed.reached();
    if (armed.failure) throw armed.failure;
    await armed.release;
  }

  get armedNames(): ReadonlyArray<HoldName> {
    return [...this.#armed.keys()];
  }
}

/** A simulated process death: not a DomainFailure, so the unit of work rolls back and the transport answers INTERNAL_ERROR. */
export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "SimulatedCrash";
  }
}

function instrumentUnitOfWork(uow: UnitOfWork, holds: HoldPoints): UnitOfWork {
  const journal: CommandJournal = {
    async reserve(identity, digest, correlationId) {
      const outcome = await uow.journal.reserve(identity, digest, correlationId);
      if (outcome.kind === "RESERVED") await holds.pass("journal.reserved");
      return outcome;
    },
    async commit(entryId, result) {
      await holds.pass("journal.commit");
      return uow.journal.commit(entryId, result);
    },
    markUncertain: (entryId) => uow.journal.markUncertain(entryId),
    find: (identity) => uow.journal.find(identity),
  };
  return new Proxy(uow, {
    get(target, property) {
      if (property === "journal") return journal;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface UnitOfWorkStats {
  /** Units of work opened through the port: a request refused before the port never opened a transaction. */
  runs: number;
}

/** Decorates the pg unit-of-work factory with the hold points and the run counter; the real adapter runs underneath. */
export function instrumentedFactory(inner: UnitOfWorkFactory, holds: HoldPoints, stats: UnitOfWorkStats): UnitOfWorkFactory {
  return {
    async run<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
      stats.runs += 1;
      const out = await inner.run(context, (uow) => work(instrumentUnitOfWork(uow, holds)), options);
      await holds.pass("after.commit");
      return out;
    },
  };
}

// --- people ------------------------------------------------------------------------------------------------------------

export interface Person {
  readonly name: string;
  readonly token: string;
  readonly subject: AuthenticatedSubject;
  readonly userId: UserId;
}

export function personOf(name: string, opts: { readonly verified?: boolean; readonly state?: "ACTIVE" | "DISABLED" } = {}): Person {
  const verified = opts.verified ?? true;
  const now = clock.now();
  const subject = subjectOf({ provider: "identity-platform", subject: name, emailVerifiedAt: verified ? now : null, mfaEnrolledAt: verified ? now : null, state: opts.state ?? "ACTIVE" });
  return { name, token: `token-${name}-${"x".repeat(16)}`, subject, userId: identityUserId("identity-platform", name) };
}

// --- plan services bound by the tests (ports of @kauro/application; their production adapters are not B06) ---------------

export interface TestPatchDocument {
  /** The target field of the mapping the patch edits (CMD023: "names existing candidates/fields"). */
  readonly candidate: string;
  readonly reasonCode: string;
}

function v7Like(seed: string): string {
  const hex = sha(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(12, 15)}-8${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
}

export function planBodyOf(revisionHash: Sha256Hex, targetContractHash: Sha256Hex, seed: string, intentKind: "SET" | "CLEAR" = "SET"): PlanBody {
  return {
    revisionHash,
    targetContractHash,
    policyHash: sha("policy-" + seed),
    mappings: [
      {
        mappingId: v7Like(seed + "-mapping"),
        sourceTableId: v7Like(seed + "-table"),
        sourceFieldId: v7Like(seed + "-field"),
        targetObject: "Contact",
        targetField: "Phone",
        intent: { kind: intentKind, reasonCode: "MAPPED" },
        evidence: { evidenceId: v7Like(seed + "-evidence"), candidateId: v7Like(seed + "-candidate"), provenance: "AGENCY", factHashes: [], ruleVersion: "R1", comparisonHash: sha("cmp-" + seed), fragmentHash: sha("frag-" + seed) },
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

/** The disclosure items of a plan body: one safe token per mapping effect, with the receipt's affected count. */
export function disclosureItemsOf(body: PlanBody, affectedRows: number): ReadonlyArray<string> {
  return body.mappings.map((m) => `${m.intent.kind}:${m.targetObject}.${m.targetField}:${affectedRows}`);
}

/** The disclosures hash the test composer computes (and a test recomputes to echo it, or to leave the CLEAR set out). */
export function disclosuresHashOf(planHash: Sha256Hex, receiptHash: Sha256Hex, items: ReadonlyArray<string>): Sha256Hex {
  return sha(canonicalize({ planHash, receiptHash, items }));
}

export interface TestPlanServices {
  readonly artifacts: B06Collaborators["artifacts"];
  readonly patchCompiler: B06Collaborators["patchCompiler"];
  readonly disclosures: B06Collaborators["disclosures"];
  /** Registers a decision patch artifact in an agency's scope; a reference outside the scope resolves to null. */
  registerPatch(agencyId: AgencyId, document: TestPatchDocument): ArtifactRef;
}

export function testPlanServices(holds: HoldPoints): TestPlanServices {
  const patches = new Map<string, DecisionPatch>();
  let counter = 0;
  return {
    registerPatch(agencyId, document) {
      counter += 1;
      const ref = v7Like(`patch-${agencyId}-${counter}`) as ArtifactRef;
      patches.set(`${agencyId}:${ref}`, { artifactRef: ref, patchHash: sha(canonicalize(document)), document });
      return ref;
    },
    artifacts: {
      async resolveDecisionPatch(_uow, agencyId, ref) {
        await holds.pass("collaborator");
        return patches.get(`${agencyId}:${ref}`) ?? null;
      },
    },
    patchCompiler: {
      async apply(current, patch): Promise<PatchCompilation> {
        const d = patch.document;
        if (typeof d !== "object" || d === null || typeof (d as TestPatchDocument).candidate !== "string" || typeof (d as TestPatchDocument).reasonCode !== "string") {
          return { kind: "REJECTED", reason: "MALFORMED_PATCH" };
        }
        const doc = d as TestPatchDocument;
        if (!current.mappings.some((m) => m.targetField === doc.candidate)) return { kind: "REJECTED", reason: "UNKNOWN_CANDIDATE" };
        const body: PlanBody = {
          ...current,
          mappings: current.mappings.map((m) => (m.targetField === doc.candidate ? { ...m, intent: { ...m.intent, reasonCode: doc.reasonCode } } : m)),
        };
        return { kind: "COMPILED", body, bodyHash: bodyHashOf(body) };
      },
    },
    disclosures: {
      async compose(_uow, plan, body, receipt): Promise<DisclosureSet> {
        await holds.pass("collaborator");
        const items = disclosureItemsOf(body, receipt.counts.physicalSourceRows);
        return { disclosuresHash: disclosuresHashOf(plan.bodyHash, receipt.receiptHash, items), items, includesClear: items.some((i) => i.startsWith("CLEAR:")) };
      },
    },
  };
}

// --- the world -----------------------------------------------------------------------------------------------------------

export interface PlanFixture {
  readonly planId: PlanId;
  readonly projectId: ProjectId;
  readonly version: number;
  readonly state: "VALIDATION_REQUIRED" | "VALIDATED";
  readonly body: PlanBody;
  readonly bodyHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly receiptHash: Sha256Hex | null;
  readonly affectedRows: number;
}

export interface EventRow {
  readonly version: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly eventId: string;
}

export interface JournalRow {
  readonly state: string;
  readonly status: number | null;
  readonly body: unknown;
  readonly resourceKind: string | null;
  readonly resourceId: string | null;
}

export interface SecurityEventRow {
  readonly outcome: string;
  readonly reason: string | null;
  readonly agencyId: string | null;
  readonly actorId: string | null;
  readonly policyVersion: string;
  readonly assuranceClass: string;
}

export interface World {
  readonly h: Harness;
  readonly db: DatabaseHandle;
  readonly app: FastifyInstance;
  readonly holds: HoldPoints;
  readonly stats: UnitOfWorkStats;
  readonly validator: SchemaValidator;
  readonly plans: TestPlanServices;
  readonly internalErrors: Array<{ correlationId: string; error: unknown }>;
  /** Agency A (DRAFT) and its people. */
  readonly A: AgencyFixture;
  readonly owner: Person;
  readonly admin: Person;
  readonly operator: Person;
  readonly approver: Person;
  readonly approver2: Person;
  readonly viewer: Person;
  readonly suspended: Person;
  readonly suspendedMembershipId: MembershipId;
  readonly memberships: Readonly<Record<"owner" | "admin" | "operator" | "approver" | "approver2" | "viewer", MembershipId>>;
  readonly authorityA: ProcessingAuthorityId;
  readonly clientA: ClientId;
  /** Agency B, owned by the stranger; a member of B is a non-member of A. */
  readonly B: AgencyFixture;
  readonly stranger: Person;
  readonly authorityB: ProcessingAuthorityId;
  readonly clientB: ClientId;
  readonly unverified: Person;
  /** CLEAN, published by the control plane through the listed edges to AVAILABLE_LIMITED (offered). */
  readonly cleanCapabilityId: CapabilityId;
  /** HUBSPOT at DESIGN: specified, not implemented, not offered (a test publishes it through the listed edges, D-CAP-2). */
  readonly hubspotCapabilityId: CapabilityId;
  /** Registers a person for authentication (token → subject); the identity row is synced by the harness unless `sync: false`. */
  person(name: string, opts?: { readonly verified?: boolean; readonly sync?: boolean }): Promise<Person>;
  /** An OPEN CLEAN project with its DRAFT revision, written through the ports under the owner's context. */
  project(agency: AgencyFixture, clientId: ClientId): Promise<{ projectId: ProjectId; revisionId: RevisionId }>;
  /** A revision in a final state, as B07's upload lifecycle leaves it: SEALED (default) or EXPIRED, with its manifest hash. */
  revision(agency: AgencyFixture, projectId: ProjectId, state?: "SEALED" | "EXPIRED"): Promise<{ revisionId: RevisionId; revisionHash: Sha256Hex }>;
  /** A target contract as B08's observation/confirmation leaves it: confirmed and current (default) or superseded. */
  targetContract(agency: AgencyFixture, projectId: ProjectId, opts?: { readonly superseded?: boolean }): Promise<{ contractId: string; targetContractHash: Sha256Hex }>;
  /** A plan revision at VALIDATION_REQUIRED (v2) or VALIDATED (v4, receipt bound), whose subjects name the given hashes. */
  plan(agency: AgencyFixture, projectId: ProjectId, subjects: { readonly revisionHash: Sha256Hex; readonly targetContractHash: Sha256Hex; readonly seed: string; readonly state?: "VALIDATION_REQUIRED" | "VALIDATED"; readonly intent?: "SET" | "CLEAR" }): Promise<PlanFixture>;
  /** A complete approvable subject: sealed revision, confirmed target contract and a VALIDATED plan naming both. */
  approvable(agency: AgencyFixture, projectId: ProjectId, seed: string, intent?: "SET" | "CLEAR"): Promise<PlanFixture>;
  /** A step-up proof of the person: fresh (issued now) or stale (issued twenty minutes ago). */
  stepUp(person: Person, freshness?: "FRESH" | "STALE"): Promise<AssuranceProofId>;
  /** Runs statements as the runtime role under the agency owner's tenant context (direct writes for fixtures and negative controls). */
  asTenant<T>(agency: AgencyFixture, fn: (c: PoolClient) => Promise<T>): Promise<T>;
  /** Superuser oracle: `SELECT count(*)` of a table under a WHERE clause. */
  count(table: string, where?: string, params?: ReadonlyArray<unknown>): Promise<number>;
  /** Superuser oracle: one row of a table, or null. */
  row<T extends Record<string, unknown>>(table: string, where: string, params: ReadonlyArray<unknown>): Promise<T | null>;
  /** Superuser oracle: the events of an aggregate in version order. */
  events(aggregateKind: string, aggregateId: string): Promise<ReadonlyArray<EventRow>>;
  /** Superuser oracle: the consumers of an event's outbox rows. */
  outbox(eventId: string): Promise<ReadonlyArray<string>>;
  /** Superuser oracle: the journal row of an idempotency key. */
  journal(key: string): Promise<JournalRow | null>;
  /** Superuser oracle: the security events of a command, in order. */
  securityEvents(action: string): Promise<ReadonlyArray<SecurityEventRow>>;
  stop(): Promise<void>;
}

export interface WorldOptions {
  /** Replaces or extends the collaborators before the server is built. */
  readonly collaborators?: (base: B06Collaborators) => B06Collaborators;
}

export interface RawEvent {
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly agencyId: string;
  readonly eventType: string;
  readonly actorUserId: string;
  readonly payload: Record<string, string | number | boolean>;
}

/** Appends a domain event row for a fixture written in raw SQL (the publisher adapter does the same for commands). */
export async function rawEvent(c: PoolClient, e: RawEvent): Promise<void> {
  await c.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'USER', $7, $8, $9, $10::jsonb, $11, '1', now())`,
    [ids.next(), e.aggregateKind, e.aggregateId, e.aggregateVersion, e.agencyId, e.eventType, e.actorUserId, ids.next(), ids.next(), JSON.stringify(e.payload), payloadDigest(e.payload)],
  );
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const h = await startHarness();
  const db = await openDatabase({
    environment: "LOCAL",
    http: { host: "127.0.0.1", port: 3000 },
    database: { host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: ROLES.appLogin, poolMax: 6, statementTimeoutMs: 10_000 },
    migrateOnStart: null,
    bearerTokensFile: null,
  });
  const holds = new HoldPoints();
  const stats: UnitOfWorkStats = { runs: 0 };
  const validator = loadContractSchemas();
  const plans = testPlanServices(holds);
  const tokens = new Map<string, AuthenticatedSubject>();
  const internalErrors: Array<{ correlationId: string; error: unknown }> = [];

  const base: B06Collaborators = {
    abuseLimiter: createAdmissionLimiter(),
    activeWork: {
      async inspectClient(uow, clientId) {
        await holds.pass("collaborator");
        return openProjectsInspector.inspectClient(uow, clientId);
      },
    },
    artifacts: plans.artifacts,
    patchCompiler: plans.patchCompiler,
    disclosures: plans.disclosures,
    externalActions: {
      async completedForPlan(uow, planId) {
        await holds.pass("collaborator");
        return noExternalActionsInThisEdition.completedForPlan(uow, planId);
      },
    },
  };
  const collaborators = options.collaborators ? options.collaborators(base) : base;

  const app = assembleApi({
    environment: "LOCAL",
    unitOfWork: instrumentedFactory(db.unitOfWork, holds, stats),
    authenticator: createBearerTokenAuthenticator(tokens),
    collaborators,
    validator,
    clock,
    ids,
    onInternalError: (correlationId, error) => internalErrors.push({ correlationId, error }),
  });
  await app.ready();

  const person = async (name: string, opts: { readonly verified?: boolean; readonly sync?: boolean } = {}): Promise<Person> => {
    const p = personOf(name, { ...(opts.verified !== undefined ? { verified: opts.verified } : {}) });
    tokens.set(p.token, p.subject);
    if (opts.sync !== false) await h.person(name, opts.verified ?? true);
    return p;
  };

  const owner = await person("owner");
  const admin = await person("admin");
  const operator = await person("operator");
  const approver = await person("approver");
  const approver2 = await person("approver-two");
  const viewer = await person("viewer");
  const suspended = await person("suspended");
  const stranger = await person("stranger");
  const unverified = await person("unverified", { verified: false });

  const A = await h.createAgency(owner.userId, "Acme Agency");
  const memberships = {
    owner: A.ownerMembershipId,
    admin: await h.addMember(A, admin.userId, "ADMIN"),
    operator: await h.addMember(A, operator.userId, "OPERATOR"),
    approver: await h.addMember(A, approver.userId, "APPROVER"),
    approver2: await h.addMember(A, approver2.userId, "APPROVER"),
    viewer: await h.addMember(A, viewer.userId, "VIEWER"),
  };
  const suspendedMembershipId = await h.addMember(A, suspended.userId, "OPERATOR");
  await h.app.run(h.tenant(A.agencyId, owner.userId), async (uow) => {
    const written = await uow.memberships.transition(suspendedMembershipId, 1, { state: "SUSPENDED" }, clock.now());
    if (written.kind !== "APPLIED") throw new Error("suspension fixture did not apply");
    await uow.events.publish({
      aggregateKind: "membership",
      aggregateId: suspendedMembershipId,
      aggregateVersion: written.record.version,
      agencyId: A.agencyId,
      eventType: "membership.suspended.v1",
      actor: { kind: "USER", userId: owner.userId },
      causationId: uow.ids.next() as CausationId,
      correlationId: uow.context.correlationId,
      payload: { membershipId: suspendedMembershipId, agencyId: A.agencyId, byMembershipId: A.ownerMembershipId },
    });
  });
  const authorityA = await h.processingAuthority(A);
  const clientA = await h.endClient(A, authorityA, "Client A");
  const B = await h.createAgency(stranger.userId, "Bravo Agency");
  const authorityB = await h.processingAuthority(B);
  const clientB = await h.endClient(B, authorityB, "Client B");
  const cleanCapabilityId = (await h.offeredCapability("CLEAN")) as CapabilityId;
  const hubspotCapabilityId = (await h.offeredCapability("HUBSPOT", "DESIGN")) as CapabilityId;

  const oracle = h.oracle;
  const w: World = {
    h,
    db,
    app,
    holds,
    stats,
    validator,
    plans,
    internalErrors,
    A,
    owner,
    admin,
    operator,
    approver,
    approver2,
    viewer,
    suspended,
    suspendedMembershipId,
    memberships,
    authorityA,
    clientA,
    B,
    stranger,
    authorityB,
    clientB,
    unverified,
    cleanCapabilityId,
    hubspotCapabilityId,
    person,

    async project(agency, clientId) {
      const context = h.tenant(agency.agencyId, agency.ownerUserId);
      return h.app.run(context, async (uow) => {
        const projectId = uow.ids.next() as ProjectId;
        const revisionId = uow.ids.next() as RevisionId;
        const { project, revision } = await uow.projects.insertWithDraftRevision({
          projectId,
          agencyId: agency.agencyId,
          clientId,
          mode: "CLEAN",
          purpose: "Quarterly cleanup",
          capabilityId: cleanCapabilityId,
          capabilityVersion: "R2-INITIAL",
          initialRevisionId: revisionId,
          createdByMembershipId: agency.ownerMembershipId,
          createdAt: clock.now(),
        });
        const actor = { kind: "USER", userId: agency.ownerUserId } as const;
        await uow.events.publish({ aggregateKind: "project", aggregateId: projectId, aggregateVersion: project.version, agencyId: agency.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: context.correlationId, payload: { projectId, agencyId: agency.agencyId, clientId, mode: "CLEAN", capabilityId: cleanCapabilityId, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: agency.ownerMembershipId } });
        await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: revision.version, agencyId: agency.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: context.correlationId, payload: { revisionId, agencyId: agency.agencyId, projectId, state: revision.state } });
        return { projectId, revisionId };
      });
    },

    async revision(agency, projectId, state = "SEALED") {
      const revisionId = ids.next() as RevisionId;
      const revisionHash = sha(`manifest-${revisionId}`);
      await w.asTenant(agency, async (c) => {
        await c.query(
          `INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, version, state, manifest_hash, projection_hash, sealed_at, created_at, updated_at)
           VALUES ($1, $2, $3, 1, $4, $5, $6, now(), now(), now())`,
          [revisionId, agency.agencyId, projectId, state, revisionHash, sha(`projection-${revisionId}`)],
        );
        await rawEvent(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: agency.agencyId, eventType: "dataset_revision.created.v1", actorUserId: agency.ownerUserId, payload: { revisionId, agencyId: agency.agencyId, projectId, state } });
      });
      return { revisionId, revisionHash };
    },

    async targetContract(agency, projectId, opts = {}) {
      const contractId = ids.next();
      const targetContractHash = sha(`target-${contractId}`);
      await w.asTenant(agency, async (c) => {
        await c.query(
          `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, superseded_at, created_at)
           VALUES ($1, $2, $3, 'CLEAN', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $7, now(), now(), $8, 'R2-INITIAL', $9, now())`,
          [contractId, agency.agencyId, projectId, ids.next(), ids.next(), sha("bundle"), targetContractHash, sha(`authority-${contractId}`), opts.superseded ? new Date() : null],
        );
      });
      return { contractId, targetContractHash };
    },

    async plan(agency, projectId, subjects) {
      const state = subjects.state ?? "VALIDATED";
      const planId = ids.next() as PlanId;
      const body = planBodyOf(subjects.revisionHash, subjects.targetContractHash, subjects.seed, subjects.intent ?? "SET");
      const bodyHash = bodyHashOf(body);
      const affectedRows = 120;
      let receiptHash: Sha256Hex | null = null;
      let version = 1;
      await w.asTenant(agency, async (c) => {
        const ev = (aggregateVersion: number, eventType: string, payload: Record<string, string | number | boolean>): Promise<void> =>
          rawEvent(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion, agencyId: agency.agencyId, eventType, actorUserId: agency.ownerUserId, payload });
        await c.query(
          `INSERT INTO kauro.plans (plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
           VALUES ($1, $2, $3, 1, 'DRAFT', $4, $5, $6, $7::jsonb, $8, $9, now(), now())`,
          [planId, agency.agencyId, projectId, body.revisionHash, body.targetContractHash, body.policyHash, JSON.stringify(body), bodyHash, agency.ownerMembershipId],
        );
        await ev(1, "plan.created.v1", { planId, agencyId: agency.agencyId, projectId, bodyHash, createdByMembershipId: agency.ownerMembershipId });
        await c.query("UPDATE kauro.plans SET state = 'VALIDATION_REQUIRED', version = 2 WHERE plan_id = $1", [planId]);
        await ev(2, "plan.validation_required.v1", { planId, agencyId: agency.agencyId, bodyHash });
        version = 2;
        if (state === "VALIDATED") {
          await c.query("UPDATE kauro.plans SET state = 'VALIDATING', version = 3 WHERE plan_id = $1", [planId]);
          await ev(3, "plan.validating.v1", { planId, agencyId: agency.agencyId, bodyHash });
          const hash = sha(`receipt-${planId}`);
          receiptHash = hash;
          const counts = { physicalSourceRows: affectedRows, logicalSourceRecords: affectedRows, billableSourceUnits: affectedRows, associationEdges: 0, emittedRepresentatives: affectedRows, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: affectedRows };
          await c.query(
            `INSERT INTO kauro.validation_receipts (receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, blocking_issue_codes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - interval '1 minute', now(), 'VALID', $12::jsonb, '[]'::jsonb, now())`,
            [ids.next(), agency.agencyId, planId, hash, body.revisionHash, body.targetContractHash, bodyHash, sha("core"), sha("profile"), sha("disposition"), sha("artifact"), JSON.stringify(counts)],
          );
          await c.query("UPDATE kauro.plans SET state = 'VALIDATED', version = 4, validation_receipt_hash = $2 WHERE plan_id = $1", [planId, hash]);
          await ev(4, "plan.validated.v1", { planId, agencyId: agency.agencyId, bodyHash, validationReceiptHash: hash });
          version = 4;
        }
      });
      return { planId, projectId, version, state, body, bodyHash, revisionHash: subjects.revisionHash, targetContractHash: subjects.targetContractHash, receiptHash, affectedRows };
    },

    async approvable(agency, projectId, seed, intent = "SET") {
      const source = await w.revision(agency, projectId, "SEALED");
      const target = await w.targetContract(agency, projectId);
      return w.plan(agency, projectId, { revisionHash: source.revisionHash, targetContractHash: target.targetContractHash, seed, state: "VALIDATED", intent });
    },

    async stepUp(person, freshness = "FRESH") {
      const proofId = ids.next() as AssuranceProofId;
      const issuedMs = freshness === "FRESH" ? Date.now() : Date.now() - 20 * 60_000;
      await h.app.run(h.identity(person.userId), async (uow) => {
        await uow.identities.recordProof({ proofId, userId: person.userId, kind: "STEP_UP", method: "TOTP", issuedAt: toUtcInstant(issuedMs), expiresAt: toUtcInstant(issuedMs + 15 * 60_000) }, uow.context.correlationId);
      });
      return proofId;
    },

    async asTenant(agency, fn) {
      const c = await h.appPool.raw.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agency.agencyId, agency.ownerUserId]);
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },

    async count(table, where = "TRUE", params = []) {
      const r = await oracle.query<{ n: string }>(`SELECT count(*)::text AS n FROM kauro.${table} WHERE ${where}`, [...params]);
      return Number(r.rows[0]?.n ?? "0");
    },

    async row<T extends Record<string, unknown>>(table: string, where: string, params: ReadonlyArray<unknown>) {
      const r = await oracle.query<T>(`SELECT * FROM kauro.${table} WHERE ${where}`, [...params]);
      return r.rows[0] ?? null;
    },

    async events(aggregateKind, aggregateId) {
      const r = await oracle.query<{ aggregate_version: string; event_type: string; payload: Record<string, unknown>; event_id: string }>(
        "SELECT aggregate_version, event_type, payload, event_id FROM kauro.domain_events WHERE aggregate_kind = $1 AND aggregate_id = $2 ORDER BY aggregate_version",
        [aggregateKind, aggregateId],
      );
      return r.rows.map((x) => ({ version: Number(x.aggregate_version), type: x.event_type, payload: x.payload, eventId: x.event_id }));
    },

    async outbox(eventId) {
      const r = await oracle.query<{ consumer: string }>("SELECT consumer FROM kauro.outbox_records WHERE event_id = $1 ORDER BY consumer", [eventId]);
      return r.rows.map((x) => x.consumer);
    },

    async journal(key) {
      const r = await oracle.query<{ state: string; response_status: number | null; response_body: unknown; resource_kind: string | null; resource_id: string | null }>(
        "SELECT state, response_status, response_body, resource_kind, resource_id FROM kauro.command_journal WHERE idempotency_key = $1",
        [key],
      );
      const row = r.rows[0];
      return row ? { state: row.state, status: row.response_status, body: row.response_body, resourceKind: row.resource_kind, resourceId: row.resource_id } : null;
    },

    async securityEvents(action) {
      const r = await oracle.query<{ outcome: string; reason_code: string | null; agency_id: string | null; actor_id: string | null; policy_version: string; assurance_class: string }>(
        "SELECT outcome, reason_code, agency_id, actor_id, policy_version, assurance_class FROM kauro.security_events WHERE action = $1 ORDER BY occurred_at, security_event_id",
        [action],
      );
      return r.rows.map((x) => ({ outcome: x.outcome, reason: x.reason_code, agencyId: x.agency_id, actorId: x.actor_id, policyVersion: x.policy_version, assuranceClass: x.assurance_class }));
    },

    async stop() {
      await app.close();
      await db.close();
      await h.stop();
    },
  };
  return w;
}

// --- HTTP calls ------------------------------------------------------------------------------------------------------------

export interface Call {
  readonly method?: "POST" | "GET";
  readonly url: string;
  /** Bearer token; null sends no Authorization header. Default: the owner of agency A. */
  readonly token?: string | null;
  /** Idempotency key; null omits the header. Default: a fresh key. */
  readonly key?: string | null;
  /** X-Kauro-Agency; null omits the header. Default: agency A. */
  readonly agency?: string | null;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly contentType: string | undefined;
  readonly text: string;
  json<T = unknown>(): T;
}

let keyCounter = 0;
/** A fresh idempotency key (16..128 token characters). */
export function freshKey(label = "key"): string {
  keyCounter += 1;
  return `${label}-${String(keyCounter).padStart(6, "0")}-${sha(label + keyCounter).slice(0, 12)}`;
}

export async function call(w: World, c: Call): Promise<Reply> {
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (c.contentType !== null) headers["content-type"] = c.contentType ?? "application/json";
  if (c.token !== null) headers["authorization"] = `Bearer ${c.token ?? w.owner.token}`;
  if (c.key !== null) headers["idempotency-key"] = c.key ?? freshKey("auto");
  if (c.agency !== null) headers["x-kauro-agency"] = c.agency ?? w.A.agencyId;
  const payload = c.rawBody ?? (c.body === undefined ? undefined : JSON.stringify(c.body));
  const options: InjectOptions = { method: c.method ?? "POST", url: c.url, headers, ...(payload !== undefined ? { payload } : {}) };
  const res = await w.app.inject(options);
  return {
    status: res.statusCode,
    headers: res.headers as Record<string, string | string[] | number | undefined>,
    contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : undefined,
    text: res.body,
    json: <T>() => JSON.parse(res.body) as T,
  };
}

export interface Completed<T> {
  readonly kind: "COMPLETED";
  readonly version: number;
  readonly replayed: boolean;
  readonly data: T;
}

/** Reads a COMPLETED reply, failing with the problem body when the status is not the expected one. */
export function completed<T>(reply: Reply, status: 200 | 201): Completed<T> {
  if (reply.status !== status) throw new Error(`expected ${status}, got ${reply.status}: ${reply.text}`);
  const body = reply.json<Completed<T>>();
  if (body.kind !== "COMPLETED") throw new Error(`expected a COMPLETED reply: ${reply.text}`);
  return body;
}

/** Facts (tuples of safe tokens) in a canonical order, for order-insensitive comparison of security events. */
export function sortedFacts<T extends ReadonlyArray<unknown>>(facts: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...facts].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
}

/** The innermost cause of an error chain (the unit-of-work adapter wraps an unexpected exception as INTERNAL_ERROR with a cause). */
export function rootCause(e: unknown): unknown {
  let current = e;
  for (let depth = 0; depth < 8 && current instanceof Error && current.cause !== undefined; depth++) current = current.cause;
  return current;
}

/** Validates a wire problem against the closed Problem schema of the running validator and returns it. */
export function asProblem(w: World, reply: Reply): Problem {
  const r = w.validator.validate<Problem>("Problem", reply.json());
  if (r.kind === "INVALID") throw new Error(`not a Problem: ${JSON.stringify(r.fields)} in ${reply.text}`);
  return r.value;
}

/** `${status} ${code} ${reason}` of a problem reply, for compact assertions. */
export function outcome(w: World, reply: Reply): string {
  const p = asProblem(w, reply);
  return `${reply.status} ${p.code} ${p.reason ?? "-"}`;
}

/** Waits until a backend of the api pool is blocked on a lock while running a statement containing `fragment`. */
export function waitForApiLockWait(w: World, fragment: string): Promise<number> {
  return waitForLockWait(w.h.oracle, API_APPLICATION_NAME, fragment);
}

/**
 * The exact bytes an identical replay of `first` must carry (D-PORT-2): the first answer's body with only the `replayed`
 * flag flipped — same status line content, same envelope, same journaled `data`, byte for byte.
 */
export function replayTextOf(first: Reply): string {
  const marker = '"replayed":false';
  if (first.text.indexOf(marker) < 0 || first.text.indexOf(marker) !== first.text.lastIndexOf(marker)) throw new Error(`not a first COMPLETED answer: ${first.text}`);
  return first.text.replace(marker, '"replayed":true');
}

/** Every table a B06 command, its denial or its fixtures can write: the "no committed state or external effect" oracle. */
export const EFFECT_TABLES = [
  "identities",
  "assurance_proofs",
  "agencies",
  "memberships",
  "processing_authorities",
  "end_clients",
  "projects",
  "dataset_revisions",
  "target_contracts",
  "plans",
  "validation_receipts",
  "approvals",
  "capabilities",
  "domain_events",
  "outbox_records",
  "command_journal",
  "security_events",
] as const;
export type EffectTable = (typeof EFFECT_TABLES)[number];

/** Superuser oracle: the row count of every effect table across all tenants, read in one statement. */
export async function effectCounts(w: World): Promise<Readonly<Record<EffectTable, number>>> {
  const r = await w.h.oracle.query<Record<EffectTable, string>>(`SELECT ${EFFECT_TABLES.map((t) => `(SELECT count(*) FROM kauro.${t})::text AS ${t}`).join(", ")}`);
  const row = r.rows[0];
  if (!row) throw new Error("the count query returned no row");
  const out = {} as Record<EffectTable, number>;
  for (const t of EFFECT_TABLES) out[t] = Number(row[t]);
  return out;
}

/** The body an approver sends after reviewing the complete disclosure set the server composes (CMD025). */
export function approvalBodyOf(plan: PlanFixture, proof: string, overrides: Partial<Record<"expectedVersion" | "planHash" | "validationReceiptHash" | "disclosuresHash", string | number>> = {}) {
  if (plan.receiptHash === null) throw new Error("the plan fixture has no receipt");
  return {
    expectedVersion: plan.version,
    planHash: plan.bodyHash,
    validationReceiptHash: plan.receiptHash,
    disclosuresHash: disclosuresHashOf(plan.bodyHash, plan.receiptHash, disclosureItemsOf(plan.body, plan.affectedRows)),
    assuranceProofRef: proof,
    ...overrides,
  };
}

/**
 * A VALIDATED plan approved through the real CMD025 route by `approver` with a fresh step-up (APPROVED v5, approval v1). The
 * agency selector defaults to agency A; a plan of agency B is approved by a member of B under B's selector.
 */
export async function approveThroughRoute(w: World, plan: PlanFixture, approver: Person = w.approver, agencyId: string = w.A.agencyId): Promise<Completed<ApprovePlanView>> {
  const proof = await w.stepUp(approver);
  return completed<ApprovePlanView>(await call(w, { url: routes.approvePlan(plan.planId), token: approver.token, agency: agencyId, key: freshKey("approve"), body: approvalBodyOf(plan, proof) }), 201);
}

/** The routes of the seven commands. */
export const routes = {
  createAgency: () => "/api/v1/agencies",
  createClient: (agencyId: string) => `/api/v1/agencies/${agencyId}/clients`,
  archiveClient: (clientId: string) => `/api/v1/clients/${clientId}/archive`,
  createProject: (clientId: string) => `/api/v1/clients/${clientId}/projects`,
  revisePlan: (planId: string) => `/api/v1/plans/${planId}/revisions`,
  approvePlan: (planId: string) => `/api/v1/plans/${planId}/approve`,
  withdrawApproval: (planId: string) => `/api/v1/plans/${planId}/withdraw`,
};

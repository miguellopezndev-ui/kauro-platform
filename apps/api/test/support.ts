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
 * The source lifecycle (B07, mandate B07-COMMANDS) runs on the same world: the unit-of-work factory also opens source units of work
 * (`runSource`, decorated with the same hold points), and the provider ports the source commands reach are bound to the labelled
 * contract fakes of @kauro/application/testing (`storage`, `vault`; provider tokens `contract-fake-*`, evidence class SIMULATED,
 * owned by B07-PROVIDER-FAKES) — the only provider stand-ins; the database, the handlers and the transport are the shipped ones.
 * The api's process clock is movable (`processClock.advance`), for the grace a pending intent waits before it resumes (D-RUN-2);
 * every lifecycle instant stays the database's own (D-CLOCK-1).
 *
 * Deterministic interleavings (21 "Concurrency and crash matrix"): the unit-of-work factory is decorated with hold points
 * (`journal.reserved`, `journal.commit`, `collaborator`, `after.commit`). A RACE test arms one, starts request A, waits until
 * A reached the hold (its transaction open: journal row reserved or aggregate row locked), starts request B, observes B
 * waiting on the lock in pg_stat_activity, then releases A — or aborts it, which makes A throw where it waits — and reads
 * both outcomes. A hold armed with a failure throws as soon as it is reached — a simulated crash before COMMIT
 * (journal.commit) or a lost response after COMMIT (after.commit). No sleep synchronizes anything; the only polling is the
 * observation of pg_stat_activity.
 *
 * With `sessions: true` the world also binds the browser session boundary of B11 W2 (design D-AUTH-*): the api's own
 * kauro_assurance pool, the shipped identity token verifier over the JWKS of the contract-fake issuer (ContractFakeIdentityIssuer
 * of @kauro/application/testing, CONTRACT_FAKE, SIMULATED; it shares the api's clock) and the application origin; `identity()`
 * signs people in through the real POST /api/v1/sessions.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { PoolClient } from "pg";
import { DOMAINS, canonicalize, structuredDigest, type Sha256Hex } from "@kauro/contracts";
import type { ApprovePlanView, AssuranceVerifier, AuthenticatedSubject, B06Collaborators, B07Collaborators, BuyerTypeReader, LateFailureSink, ProviderCallTimer, CommerceRequestCollaborators, CoreServices, DecisionPatch, DisclosureSet, PatchCompilation, Problem, SchemaValidator, QuoteCollaborators, SessionView } from "@kauro/application";
import { ContractFakeIdentityIssuer, ContractFakeObjectStorage, ContractFakeSessionVault, contractFakeBankDetailsClassifier } from "@kauro/application/testing";
import type { BankEvidenceStore } from "@kauro/application";
import { createAdmissionLimiter } from "@kauro/authorization";
import type {
  AgencyId,
  ArtifactRef,
  AuditUnitOfWork,
  AssuranceProofId,
  CapabilityId,
  CausationId,
  ClientId,
  Clock,
  CommandJournal,
  CommerceUnitOfWorkFactory,
  ExecutionContext,
  IdGenerator,
  MembershipId,
  PlanBody,
  PlanId,
  ProcessingAuthorityId,
  ProjectId,
  RevisionId,
  SourceUnitOfWork,
  SourceUnitOfWorkFactory,
  UnitOfWork,
  UnitOfWorkOptions,
  UserId,
  ValidationReceiptId,
} from "@kauro/domain";
import { createIdGenerator, identityUserId, payloadDigest, toUtcInstant } from "@kauro/domain";
import { confirmedContract, supersede } from "./b17-target-supersession-support.js";
import { PgWebSessionStore } from "@kauro/persistence";
import { ROLES, raceStatementTimeoutMs, serverNow, startHarness, waitForLockWait, type AgencyFixture, type Harness, testDatabaseEnvironment } from "@kauro/persistence/testing";
import {
  API_APPLICATION_NAME,
  activeWorkInspector,
  assembleApi,
  commercialConsequencesInspector,
  commercialScopeInspector,
  createBearerTokenAuthenticator,
  createIdentityTokenVerifier,
  externalActionInspector,
  loadContractSchemas,
  openDatabase,
  subjectOf,
  type ApiLogger,
  type CommissionRoutesBinding,
  type DatabaseHandle,
  type PaymentService,
  type RequestUnitOfWorkFactory,
  type SessionAssembly,
} from "../src/index.js";

export const clock: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };

/** A process clock a test can move forward (never backwards): the api's business clock; the database keeps its own. */
export interface MovableClock extends Clock {
  advance(ms: number): void;
}

export function movableClock(): MovableClock {
  let offsetMs = 0;
  return {
    now: () => toUtcInstant(Date.now() + offsetMs),
    nowMs: () => Date.now() + offsetMs,
    advance(ms: number) {
      if (!(ms > 0)) throw new RangeError("the clock moves forward");
      offsetMs += ms;
    },
  };
}

/** The application origin the test world binds resumable sessions to (the reserved .invalid domain, RFC 2606). */
export const TEST_ORIGIN = "https://app.kauro.invalid";
export const ids: IdGenerator = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

export function sha(s: string): Sha256Hex {
  return createHash("sha256").update(s).digest("hex");
}

// --- hold points -------------------------------------------------------------------------------------------------------

/**
 * `source.intent` (B07): a source command attached its journal entry to the business object it created — the last write of
 * CMD013's intent unit of work, so a request held there holds the revision row with its reservation written and uncommitted.
 */
export type HoldName = "journal.reserved" | "journal.commit" | "collaborator" | "after.commit" | "source.intent";

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

function instrumentUnitOfWork<U extends UnitOfWork>(uow: U, holds: HoldPoints): U {
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
  let sources: unknown;
  return new Proxy(uow, {
    get(target, property) {
      if (property === "journal") return journal;
      if (property === "sources" && "sources" in target) {
        sources ??= instrumentSources((target as unknown as SourceUnitOfWork).sources, holds);
        return sources;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The source store with the `source.intent` hold after the pending-operation journal attaches an entry (B07). */
function instrumentSources(sources: SourceUnitOfWork["sources"], holds: HoldPoints): SourceUnitOfWork["sources"] {
  const operations: SourceUnitOfWork["sources"]["operations"] = {
    async attach(entryId, resourceKind, resourceId) {
      await sources.operations.attach(entryId, resourceKind, resourceId);
      await holds.pass("source.intent");
    },
  };
  return new Proxy(sources, {
    get(target, property) {
      if (property === "operations") return operations;
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

export interface UnitOfWorkStats {
  /** Units of work opened through the port: a request refused before the port never opened a transaction. */
  runs: number;
}

/**
 * Decorates the pg unit-of-work factory with the hold points and the run counter; the real adapter runs underneath. Both kinds of
 * unit of work are decorated alike: `run` and the source lifecycle's `runSource` (B07). The factory is the audit one (package
 * B08): its units of work carry the audit and execution stores and the commerce repositories (B09) beside B06's, and the decoration keeps them.
 */
export function instrumentedFactory(inner: RequestUnitOfWorkFactory, holds: HoldPoints, stats: UnitOfWorkStats): RequestUnitOfWorkFactory {
  return {
    async run<T>(context: ExecutionContext, work: (uow: AuditUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
      stats.runs += 1;
      const out = await inner.run(context, (uow) => work(instrumentUnitOfWork(uow, holds)), options);
      await holds.pass("after.commit");
      return out;
    },
    async runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
      stats.runs += 1;
      const out = await inner.runSource(context, (uow) => work(instrumentUnitOfWork(uow, holds)), options);
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
  /** The api's process clock (movable; the database's clock is its own). */
  readonly processClock: MovableClock;
  /** The labelled contract fakes the source lifecycle's provider ports are bound to (SIMULATED; B07-PROVIDER-FAKES). */
  readonly storage: ContractFakeObjectStorage;
  readonly vault: ContractFakeSessionVault;
  readonly internalErrors: Array<{ correlationId: string; error: unknown }>;
  /** The bank-transfer route's restricted evidence store, bound after start-up (bank-support.ts bankWorld binds its CONTRACT_FAKE store). */
  readonly bank: { evidence: BankEvidenceStore | null; hold: ((point: string) => Promise<void>) | null };
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
  /** A BILLING member (ACTIVE) and an invited OPERATOR who never accepted (INVITED): re-check finding N17. */
  readonly billing: Person;
  readonly invited: Person;
  readonly invitedMembershipId: MembershipId;
  readonly memberships: Readonly<Record<"owner" | "admin" | "operator" | "approver" | "approver2" | "viewer" | "billing", MembershipId>>;
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
  /**
   * Registers a person for authentication (token → subject); the identity row is synced by the harness unless `sync: false`.
   * `state` is the identity state the token's facts carry (ACTIVE by default); the synced row is always ACTIVE.
   */
  person(name: string, opts?: { readonly verified?: boolean; readonly sync?: boolean; readonly state?: "ACTIVE" | "DISABLED" }): Promise<Person>;
  /** An OPEN CLEAN project with its DRAFT revision, written through the ports under the owner's context. */
  project(agency: AgencyFixture, clientId: ClientId, options?: { readonly mode?: "CLEAN" | "HUBSPOT" }): Promise<{ projectId: ProjectId; revisionId: RevisionId }>;
  /**
   * A revision in a final state, as B07's upload lifecycle leaves it: SEALED (default) or EXPIRED, with its manifest hash. A SEALED
   * revision is a current source: sealed about an hour ago, its UNPAID retention (fourteen days from the seal) ahead — what an
   * approval (CMD025, review finding B06-R2) and a quote (B09 quotes_source_binding) require; `options.recent` states it
   * explicitly (the B07 + B09 merge). An EXPIRED revision was sealed fifteen days ago and taken through retention_expires. A
   * test that needs a SEALED revision whose retention has lapsed seals it in the past itself (Harness.sealedRevision `base`).
   */
  revision(agency: AgencyFixture, projectId: ProjectId, state?: "SEALED" | "EXPIRED", options?: { readonly recent?: boolean; readonly billableSourceUnits?: number }): Promise<{ revisionId: RevisionId; revisionHash: Sha256Hex }>;
  /** A target contract as B08's observation/confirmation leaves it: confirmed and current (default) or superseded. */
  targetContract(agency: AgencyFixture, projectId: ProjectId, opts?: { readonly superseded?: boolean; readonly mode?: "CLEAN" | "HUBSPOT" }): Promise<{ contractId: string; targetContractHash: Sha256Hex }>;
  /** A plan revision at VALIDATION_REQUIRED (v2) or VALIDATED (v4, receipt bound), whose subjects name the given hashes. */
  plan(agency: AgencyFixture, projectId: ProjectId, subjects: { readonly revisionHash: Sha256Hex; readonly targetContractHash: Sha256Hex; readonly seed: string; readonly state?: "VALIDATION_REQUIRED" | "VALIDATED"; readonly intent?: "SET" | "CLEAR"; readonly storedBodyHash?: Sha256Hex }): Promise<PlanFixture>;
  /** A complete approvable subject: a current sealed revision (World.revision), confirmed target contract and a VALIDATED plan naming both. */
  approvable(agency: AgencyFixture, projectId: ProjectId, seed: string, intent?: "SET" | "CLEAR", options?: { readonly recent?: boolean; readonly billableSourceUnits?: number; readonly mode?: "CLEAN" | "HUBSPOT" }): Promise<PlanFixture>;
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
  /** The session boundary's fixture (a world built with `sessions: true`; throws otherwise). */
  identity(): IdentityFixture;
  stop(): Promise<void>;
}

// --- the browser session boundary (B11 W2) ---------------------------------------------------------------------------------

/** The routes of the session boundary. */
export const sessionPaths = {
  open: "/api/v1/sessions",
  current: "/api/v1/sessions/current",
  revoke: "/api/v1/sessions/current/revoke",
  stepUp: "/api/v1/assurance/step-ups",
  identityConfig: "/api/v1/public/identity-config",
} as const;

/** The application origin the world's api accepts (KAURO_APP_ORIGINS) and the contract fake's announced endpoint. */
export const APP_ORIGIN = "https://app.kauro.test";
export const FAKE_IDENTITY_ENDPOINT = "/__kauro-identity";
export const IDENTITY_PROJECT_ID = "kauro-local";

/** What a browser holds after sign-in: the cookie it sends back, and the view (with the CSRF token) the page keeps in memory. */
export interface BrowserSession {
  /** The Cookie header value: `__Host-kauro_session=<secret>`. */
  readonly cookie: string;
  readonly secret: string;
  /** SHA-256 of the secret's bytes: the only form in which the database holds the session. */
  readonly secretSha256: string;
  readonly view: SessionView;
}

/** An account of the contract-fake identity provider (password + TOTP). */
export interface SessionAccount {
  readonly uid: string;
  readonly email: string;
  readonly password: string;
  readonly userId: UserId;
}

export interface IdentityFixture {
  readonly issuer: ContractFakeIdentityIssuer;
  readonly origin: string;
  readonly endpoint: string;
  /** The session boundary the world's api is assembled with (a test assembles another api over it). */
  readonly assembly: SessionAssembly;
  /** The fake account of a world person (uid = the person's name) or of a new uid; created once, with TOTP enrolled. */
  account(who: Person | string, opts?: { readonly emailVerified?: boolean }): SessionAccount;
  /** A fresh ID token of a password + TOTP sign-in at the fake, now. */
  freshToken(who: Person | SessionAccount): Promise<string>;
  /** Signs the account in through POST /api/v1/sessions (201 expected). */
  signInAs(account: SessionAccount): Promise<{ readonly reply: Reply; readonly session: BrowserSession }>;
  signIn(who: Person): Promise<BrowserSession>;
}

export interface WorldOptions {
  /** Wraps the api's request unit-of-work factory (the B10 failure cells route a command's unit over a harness connection; test/fault-support.ts). */
  readonly wrapUnitOfWork?: <F extends object>(inner: F) => F;
  /** Replaces or extends the collaborators before the server is built. */
  readonly collaborators?: (base: B06Collaborators) => B06Collaborators;
  /** The clock the api (authorizer, handlers) runs on; the world's movable process clock by default. */
  readonly clock?: Clock;
  /** Replaces or extends the source lifecycle's collaborators (the storage and vault fakes, the origin, no preview reader). */
  readonly sources?: (base: B07Collaborators) => Partial<B07Collaborators>;
  /**
   * Package B09: the payment collaborators the api binds over the harness (the payment service's units of work and the labelled
   * contract fakes of @kauro/application/testing; test/commerce-support.ts). Absent: the edition's, as a deployment runs.
   */
  readonly commerce?: (h: Harness) => Partial<CommerceRequestCollaborators>;
  /** Package B10: the platform ports the api binds beside the edition's (ApiAssembly.commercial: the buyer type reader; test/sales-support.ts). */
  readonly commercial?: { readonly buyerTypes?: BuyerTypeReader; readonly assurance?: AssuranceVerifier; readonly providerTimer?: ProviderCallTimer; readonly onLateFailure?: LateFailureSink };
  /** Package B10 (CMD027 CreateQuote): the collaborators the api binds beyond the edition's (the buyer type fake, the replacement hold, a re-binder). */
  readonly quotes?: (h: Harness) => Partial<QuoteCollaborators>;
  /**
   * Package B09 (stage-2 integration): the payment service the api binds (ApiAssembly.payments), built over the harness and the
   * api's verified request-handler pool before the server is assembled — so one api serves the B06 routes, the request side and the
   * payment service's routes with the world's people — and closed by stop() after the server, before the database
   * (test/payment-support.ts paymentWorld({ requestSide: true })).
   */
  readonly payments?: (h: Harness, db: DatabaseHandle) => Promise<{ readonly service: PaymentService; close(): Promise<void> }>;
  /** Binds the browser session boundary (B11 W2) with the contract-fake identity issuer on the api's clock. */
  readonly sessions?: boolean;
  /** The api's logger (silent by default): a test that inspects what the api logs passes a sink here. */
  readonly logger?: ApiLogger;
  /**
   * Package B10 (mandate B10-STATEMENTS-PAYOUTS): the commission group's service routes the api binds (ApiAssembly.commissions: the
   * commission service's units of work, the labelled banking-calendar and payout-evidence fakes, the service commands' hold), built over
   * the harness before the server is assembled and closed by stop() after the server, before the database (test/statements-support.ts).
   */
  readonly commissions?: (h: Harness, db: DatabaseHandle) => Promise<{ readonly binding: CommissionRoutesBinding; close(): Promise<void> }>;
  /**
   * Package B08 (mandate B08-COMMANDS-AUDIT): the cores the api binds (ApiAssembly.cores) — the labelled contract fake of the
   * Intelligence core's plan compiler (SIMULATED). Absent: none, as a deployment of this edition runs (CORE_SERVICES_UNAVAILABLE).
   */
  readonly cores?: CoreServices;
  /**
   * The plan services the api itself binds: the decision artifacts of migration 0023, the patch compiler over `cores` and the real
   * disclosure composer (package B08; edition.ts) — the test's deterministic plan services (`w.plans`) are then not handed to the
   * assembly. Absent: the test plan services, which every B06 acceptance test binds.
   */
  readonly realPlanServices?: boolean;
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

/** How long before now a recent fixture seal's intake began (World.revision's `recent`): the seal follows within minutes. */
export const RECENT_SEAL_MS = 3_600_000;

export async function world(options: WorldOptions = {}): Promise<World> {
  const h = await startHarness();
  const db = await openDatabase({
    database: { host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: ROLES.appLogin, poolMax: 6, statementTimeoutMs: raceStatementTimeoutMs() },
    databaseEnvironment: testDatabaseEnvironment("LOCAL"),
    migrateOnStart: null,
    ...(options.sessions === true ? { identity: { assuranceDatabase: { user: ROLES.assuranceLogin, poolMax: 2 } } } : {}),
  });
  const processClock = movableClock();
  const apiClock = options.clock ?? processClock;
  let sessionAssembly: SessionAssembly | undefined;
  let issuer: ContractFakeIdentityIssuer | null = null;
  if (options.sessions === true) {
    if (db.assurancePool === null) throw new Error("the session boundary's pool did not open");
    issuer = new ContractFakeIdentityIssuer({ projectId: IDENTITY_PROJECT_ID, clock: apiClock });
    sessionAssembly = {
      verifier: createIdentityTokenVerifier({ projectId: IDENTITY_PROJECT_ID, environment: "LOCAL", keySource: { kind: "CONTRACT_FAKE", jwks: issuer.jwks() }, clock: apiClock }),
      store: new PgWebSessionStore(db.assurancePool),
      appOrigins: [APP_ORIGIN],
      identityConfig: { adapter: "CONTRACT_FAKE", projectId: IDENTITY_PROJECT_ID, endpoint: FAKE_IDENTITY_ENDPOINT },
    };
  }
  const holds = new HoldPoints();
  const stats: UnitOfWorkStats = { runs: 0 };
  const validator = loadContractSchemas();
  const plans = testPlanServices(holds);
  const tokens = new Map<string, AuthenticatedSubject>();
  const internalErrors: Array<{ correlationId: string; error: unknown }> = [];
  const storage = new ContractFakeObjectStorage();
  const vault = new ContractFakeSessionVault();
  const sourceBase: B07Collaborators = { providers: { storage, vault, origin: TEST_ORIGIN }, preview: null, commercialScope: commercialScopeInspector };
  const sources = options.sources ? { ...sourceBase, ...options.sources(sourceBase) } : sourceBase;
  const payments = options.payments !== undefined ? await options.payments(h, db) : null;
  const commissions = options.commissions !== undefined ? await options.commissions(h, db) : null;

  const base: B06Collaborators = {
    abuseLimiter: createAdmissionLimiter(),
    activeWork: {
      async inspectClient(uow, clientId) {
        await holds.pass("collaborator");
        return activeWorkInspector.inspectClient(uow, clientId);
      },
    },
    artifacts: plans.artifacts,
    patchCompiler: plans.patchCompiler,
    disclosures: plans.disclosures,
    externalActions: {
      async completedForPlan(uow, planId) {
        await holds.pass("collaborator");
        return externalActionInspector.completedForPlan(uow, planId);
      },
    },
    commercialConsequences: commercialConsequencesInspector,
  };
  const configured = options.collaborators ? options.collaborators(base) : base;
  // the edition's own plan services replace the test's when asked: the three are left out, so the composition binds its defaults
  const { artifacts: _artifacts, patchCompiler: _patchCompiler, disclosures: _disclosures, ...withoutPlanServices } = configured;
  const collaborators: Partial<B06Collaborators> = options.realPlanServices === true ? withoutPlanServices : configured;

  const bank: { evidence: BankEvidenceStore | null; hold: ((point: string) => Promise<void>) | null } = { evidence: null, hold: null };
  const app = assembleApi({
    environment: "LOCAL",
    oneTimeDelivery: ({ command, view, secrets }) => {
      if (command === "CMD003") deliveredInvitations.set((view as { invitationId: string }).invitationId, secrets["invitationToken"] ?? "");
    },
    bank: { evidence: () => bank.evidence, classifier: () => contractFakeBankDetailsClassifier, hold: (point) => (bank.hold === null ? Promise.resolve() : bank.hold(point)) },
    unitOfWork: (options.wrapUnitOfWork ?? ((f) => f))(instrumentedFactory(db.unitOfWork, holds, stats)),
    database: db,
    authenticator: createBearerTokenAuthenticator(tokens),
    collaborators,
    sources,
    ...(options.commerce !== undefined ? { commerce: options.commerce(h) } : {}),
    ...(options.commercial !== undefined ? { commercial: options.commercial } : {}),
    ...(options.quotes !== undefined ? { quotes: options.quotes(h) } : {}),
    ...(payments !== null ? { payments: payments.service } : {}),
    ...(commissions !== null ? { commissions: commissions.binding } : {}),
    ...(options.cores !== undefined ? { cores: options.cores } : {}),
    validator,
    clock: apiClock,
    ids,
    onInternalError: (correlationId, error) => internalErrors.push({ correlationId, error }),
    ...(sessionAssembly !== undefined ? { sessions: sessionAssembly } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  await app.ready();

  const person = async (name: string, opts: { readonly verified?: boolean; readonly sync?: boolean; readonly state?: "ACTIVE" | "DISABLED" } = {}): Promise<Person> => {
    const p = personOf(name, { ...(opts.verified !== undefined ? { verified: opts.verified } : {}), ...(opts.state !== undefined ? { state: opts.state } : {}) });
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
  const billing = await person("billing");
  const invited = await person("invited");
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
    billing: await h.addMember(A, billing.userId, "BILLING"),
  };
  // invited through the ports (an INVITED membership with its open invitation), never accepted
  const invitedMembershipId = (await h.inviteMember(A, invited.userId, "OPERATOR")).membershipId;
  const suspendedMembershipId = await h.addMember(A, suspended.userId, "OPERATOR");
  await h.app.run(h.tenant(A.agencyId, owner.userId), async (uow) => {
    const member = await uow.memberships.lock(suspendedMembershipId);
    if (!member) throw new Error("the member to suspend is not visible");
    const written = await uow.memberships.transition(suspendedMembershipId, member.version, { state: "SUSPENDED" }, clock.now());
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
    processClock,
    storage,
    vault,
    internalErrors,
    bank,
    A,
    owner,
    admin,
    operator,
    approver,
    approver2,
    viewer,
    suspended,
    suspendedMembershipId,
    billing,
    invited,
    invitedMembershipId,
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

    async project(agency, clientId, projectOptions = {}) {
      const mode = projectOptions.mode ?? "CLEAN";
      const capabilityId = mode === "HUBSPOT" ? hubspotCapabilityId : cleanCapabilityId;
      const context = h.tenant(agency.agencyId, agency.ownerUserId);
      return h.app.run(context, async (uow) => {
        const projectId = uow.ids.next() as ProjectId;
        const revisionId = uow.ids.next() as RevisionId;
        const { project, revision } = await uow.projects.insertWithDraftRevision({
          projectId,
          agencyId: agency.agencyId,
          clientId,
          mode,
          purpose: "Quarterly cleanup",
          capabilityId,
          capabilityVersion: "R2-INITIAL",
          initialRevisionId: revisionId,
          ...(mode === "CLEAN" ? {} : { targetInstanceRef: ids.next() as never }),
          createdByMembershipId: agency.ownerMembershipId,
          createdAt: clock.now(),
        });
        const actor = { kind: "USER", userId: agency.ownerUserId } as const;
        await uow.events.publish({ aggregateKind: "project", aggregateId: projectId, aggregateVersion: project.version, agencyId: agency.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: context.correlationId, payload: { projectId, agencyId: agency.agencyId, clientId, mode, capabilityId, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: agency.ownerMembershipId } });
        await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: revision.version, agencyId: agency.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: context.correlationId, payload: { revisionId, agencyId: agency.agencyId, projectId, state: revision.state } });
        return { projectId, revisionId };
      });
    },

    async revision(agency, projectId, state = "SEALED", options = {}) {
      // born DRAFT and walked along the listed DatasetRevision edges (the database refuses a revision born SEALED or EXPIRED); a
      // SEALED source is current (its retention ahead), an EXPIRED one was sealed fifteen days ago and swept
      const recent = options.recent ?? state === "SEALED";
      const { revisionId, revisionHash } = await h.sealedRevision(agency, projectId, state, { ...(recent ? { base: new Date(Date.now() - RECENT_SEAL_MS) } : {}), ...(options.billableSourceUnits !== undefined ? { billableSourceUnits: options.billableSourceUnits } : {}) });
      return { revisionId, revisionHash };
    },

    async targetContract(agency, projectId, opts = {}) {
      const contractId = ids.next();
      const targetContractHash = sha(`target-${contractId}`);
      // 0073: a request session bears only drafts, so the confirmed fixture is the oracle's; a re-observation of the project supersedes
      // its current contract (one current per project), and `superseded` is superseded at once by a newer confirmed observation
      await confirmedContract(oracle, { agencyId: agency.agencyId, projectId, mode: opts.mode ?? "CLEAN", membershipId: agency.ownerMembershipId, targetContractHash, contractId });
      if (opts.superseded) await supersede(oracle, { agencyId: agency.agencyId, contractId }, agency.ownerMembershipId);
      return { contractId, targetContractHash };
    },

    async plan(agency, projectId, subjects) {
      const state = subjects.state ?? "VALIDATED";
      const planId = ids.next() as PlanId;
      const body = planBodyOf(subjects.revisionHash, subjects.targetContractHash, subjects.seed, subjects.intent ?? "SET");
      // a fixture may store a hash that is NOT the digest of its body (the database cannot recompute it; re-check finding N10)
      const bodyHash = subjects.storedBodyHash ?? bodyHashOf(body);
      const affectedRows = 120;
      let receiptHash: Sha256Hex | null = null;
      let version = 1;
      const ev = (c: PoolClient, aggregateVersion: number, eventType: string, payload: Record<string, string | number | boolean>): Promise<void> =>
        rawEvent(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion, agencyId: agency.agencyId, eventType, actorUserId: agency.ownerUserId, payload });
      // the request handlers' part of the lifecycle: DRAFT -> VALIDATION_REQUIRED (-> VALIDATING, the durable validation intent)
      await w.asTenant(agency, async (c) => {
        await c.query(
          `INSERT INTO kauro.plans (plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
           VALUES ($1, $2, $3, 1, 'DRAFT', $4, $5, $6, $7::jsonb, $8, $9, now(), now())`,
          [planId, agency.agencyId, projectId, body.revisionHash, body.targetContractHash, body.policyHash, JSON.stringify(body), bodyHash, agency.ownerMembershipId],
        );
        await ev(c, 1, "plan.created.v1", { planId, agencyId: agency.agencyId, projectId, bodyHash, createdByMembershipId: agency.ownerMembershipId });
        await c.query("UPDATE kauro.plans SET state = 'VALIDATION_REQUIRED', version = 2 WHERE plan_id = $1", [planId]);
        await ev(c, 2, "plan.validation_required.v1", { planId, agencyId: agency.agencyId, bodyHash });
        version = 2;
        if (state === "VALIDATED") {
          await c.query("UPDATE kauro.plans SET state = 'VALIDATING', version = 3 WHERE plan_id = $1", [planId]);
          await ev(c, 3, "plan.validating.v1", { planId, agencyId: agency.agencyId, bodyHash });
          version = 3;
        }
      });
      if (state === "VALIDATED") {
        // the independent validator records its receipt (kauro_validator; the request-handler role cannot write receipts) ...
        const hash = sha(`receipt-${planId}`);
        receiptHash = hash;
        const counts = { physicalSourceRows: affectedRows, logicalSourceRecords: affectedRows, billableSourceUnits: affectedRows, associationEdges: 0, emittedRepresentatives: affectedRows, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: affectedRows };
        const completedMs = Date.now();
        await h.recordValidationReceipt({
          receiptId: ids.next() as ValidationReceiptId,
          agencyId: agency.agencyId,
          planId,
          receiptHash: hash,
          revisionHash: body.revisionHash,
          targetContractHash: body.targetContractHash,
          planHash: bodyHash,
          corePackageHash: sha("core"),
          profileEvidenceHash: sha("profile"),
          dispositionEvidenceHash: sha("disposition"),
          artifactEvidenceHash: sha("artifact"),
          startedAt: toUtcInstant(completedMs - 60_000),
          completedAt: toUtcInstant(completedMs),
          result: "VALID",
          counts,
          blockingIssueCodes: [],
        });
        // ... and the valid_receipt edge binds it: VALIDATING -> VALIDATED (the plan names a VALID receipt of its own subjects)
        await w.asTenant(agency, async (c) => {
          await c.query("UPDATE kauro.plans SET state = 'VALIDATED', version = 4, validation_receipt_hash = $2 WHERE plan_id = $1", [planId, hash]);
          await ev(c, 4, "plan.validated.v1", { planId, agencyId: agency.agencyId, bodyHash, validationReceiptHash: hash });
        });
        version = 4;
      }
      return { planId, projectId, version, state, body, bodyHash, revisionHash: subjects.revisionHash, targetContractHash: subjects.targetContractHash, receiptHash, affectedRows };
    },

    async approvable(agency, projectId, seed, intent = "SET", options = {}) {
      const source = await w.revision(agency, projectId, "SEALED", options);
      const target = await w.targetContract(agency, projectId, options.mode === undefined ? {} : { mode: options.mode });
      return w.plan(agency, projectId, { revisionHash: source.revisionHash, targetContractHash: target.targetContractHash, seed, state: "VALIDATED", intent });
    },

    async stepUp(person, freshness = "FRESH") {
      // recorded by the step-up verifier (kauro_assurance), never by the request-handler role whose gate the proof satisfies
      const issuedMs = Date.parse(await serverNow(h.assurancePool)) - 1000 - (freshness === "FRESH" ? 0 : 20 * 60_000);
      return h.recordStepUp(person.userId, { issuedAt: toUtcInstant(issuedMs) });
    },

    async asTenant(agency, fn) {
      const c = await h.appPool.connectUnverified();
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

    identity() {
      if (identityFixture === null) throw new Error("this world was built without the session boundary (world({ sessions: true }))");
      return identityFixture;
    },

    async stop() {
      await app.close();
      if (payments !== null) await payments.close();
      if (commissions !== null) await commissions.close();
      await db.close();
      await h.stop();
    },
  };
  const identityFixture = issuer === null || sessionAssembly === undefined ? null : identityFixtureOf(w, issuer, sessionAssembly);
  return w;
}

function identityFixtureOf(w: World, issuer: ContractFakeIdentityIssuer, assembly: SessionAssembly): IdentityFixture {
  const accounts = new Map<string, SessionAccount>();
  const account = (who: Person | string, opts: { readonly emailVerified?: boolean } = {}): SessionAccount => {
    const uid = typeof who === "string" ? who : who.name;
    const known = accounts.get(uid);
    if (known !== undefined) return known;
    const created: SessionAccount = { uid, email: `${uid}@example.test`, password: `password-${uid}-1`, userId: identityUserId("identity-platform", uid) };
    issuer.createAccount({ uid, email: created.email, password: created.password, emailVerified: opts.emailVerified ?? true, totp: true });
    accounts.set(uid, created);
    return created;
  };
  const freshToken = async (who: Person | SessionAccount): Promise<string> => {
    const a = "uid" in who ? who : account(who);
    const first = issuer.signInWithPassword(a.email, a.password);
    if (first.kind === "SIGNED_IN") return first.idToken;
    if (first.kind !== "MFA_REQUIRED") throw new Error(`the fake refused the sign-in of ${a.uid}: ${first.code}`);
    const second = issuer.finalizeTotp(first.mfaPendingCredential, issuer.totpCodeFor(a.uid), first.mfaEnrollmentId);
    if (second.kind !== "SIGNED_IN") throw new Error(`the fake refused the second factor of ${a.uid}`);
    return second.idToken;
  };
  const signInAs = async (a: SessionAccount): Promise<{ readonly reply: Reply; readonly session: BrowserSession }> => {
    const reply = await call(w, { url: sessionPaths.open, token: null, key: null, agency: null, body: { idToken: await freshToken(a) }, headers: { origin: APP_ORIGIN } });
    if (reply.status !== 201) throw new Error(`sign-in of ${a.uid} answered ${reply.status}: ${reply.text}`);
    const setCookie = reply.headers["set-cookie"];
    const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const secret = typeof value === "string" ? /^__Host-kauro_session=([A-Za-z0-9_-]{43});/.exec(value)?.[1] : undefined;
    if (secret === undefined) throw new Error("the sign-in set no session cookie");
    return {
      reply,
      session: {
        cookie: `__Host-kauro_session=${secret}`,
        secret,
        secretSha256: createHash("sha256").update(Buffer.from(secret, "base64url")).digest("hex"),
        view: reply.json<SessionView>(),
      },
    };
  };
  return {
    issuer,
    origin: APP_ORIGIN,
    endpoint: FAKE_IDENTITY_ENDPOINT,
    assembly,
    account,
    freshToken,
    signInAs,
    signIn: async (who) => (await signInAs(account(who))).session,
  };
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
  // every reply any test observes is private (08 "Browser, API and cache isolation"; re-check finding N15)
  if (res.headers["cache-control"] !== "no-store") throw new Error(`a reply without Cache-Control: no-store (${String(res.headers["cache-control"])}): ${res.statusCode} ${options.method} ${c.url}`);
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
export async function waitForApiLockWait(w: World, fragment: string): Promise<number> {
  const pid = await waitForLockWait(w.h.oracle, API_APPLICATION_NAME, fragment);
  // Reproduction only: keep the already-observed holder paused longer than the former statement timeout.
  // The real pg_stat_activity observation above always runs, with the same bounds and rejection semantics.
  const delay = Number(process.env["KAURO_TEST_LOCK_RELEASE_DELAY_MS"] ?? 0);
  if (!Number.isSafeInteger(delay) || delay < 0) throw new RangeError("KAURO_TEST_LOCK_RELEASE_DELAY_MS must be a nonnegative integer");
  if (delay > 0) {
    const evidence = await w.h.oracle.query("SELECT pid, query, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers, extract(epoch FROM (clock_timestamp() - query_start)) * 1000 AS statement_age_ms FROM pg_stat_activity WHERE pid = $1", [pid]);
    process.stderr.write(`kauro-test lock-release-delay=${delay}ms statement-timeout=${raceStatementTimeoutMs()}ms ${JSON.stringify(evidence.rows)}\n`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return pid;
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
  "support_cases",
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

/** The routes of the seven commands, and of the support cases (CMD044 and its two reads). */
/** The raw invitation tokens the world's delivery channel received after each CMD003 commit, by invitation id (a CONTRACT_FAKE of the e-mail channel). */
export const deliveredInvitations = new Map<string, string>();

export const routes = {
  createAgency: () => "/api/v1/agencies",
  createClient: (agencyId: string) => `/api/v1/agencies/${agencyId}/clients`,
  archiveClient: (clientId: string) => `/api/v1/clients/${clientId}/archive`,
  createProject: (clientId: string) => `/api/v1/clients/${clientId}/projects`,
  revisePlan: (planId: string) => `/api/v1/plans/${planId}/revisions`,
  approvePlan: (planId: string) => `/api/v1/plans/${planId}/approve`,
  withdrawApproval: (planId: string) => `/api/v1/plans/${planId}/withdraw`,
  createSupportCase: (projectId: string) => `/api/v1/projects/${projectId}/support-cases`,
  listSupportCases: (projectId: string) => `/api/v1/projects/${projectId}/support-cases`,
  getSupportCase: (caseId: string) => `/api/v1/support-cases/${caseId}`,
  inviteMember: (agencyId: string) => `/api/v1/agencies/${agencyId}/invitations`,
  acceptInvitation: (invitationId: string) => `/api/v1/invitations/${invitationId}/accept`,
  changeMembership: (membershipId: string) => `/api/v1/memberships/${membershipId}/capabilities`,
  revokeMembership: (membershipId: string) => `/api/v1/memberships/${membershipId}/revoke`,
  transferOwnership: (agencyId: string) => `/api/v1/agencies/${agencyId}/ownership-transfers`,
};

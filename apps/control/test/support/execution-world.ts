// The world of the execution control-plane tests (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md
// §4..§7, §11): one real PostgreSQL 17 cluster per test file (@kauro/persistence/testing: the runtime login roles, the labelled TEST
// CLOCK), the control plane assembled by this package's own composition root with its execution pipelines, and — for everything
// outside the platform — the labelled contract fakes, each imported from its single owner and none created here:
//
//   CONTRACT FAKES, evidence class SIMULATED (never EXECUTED_PROVIDER; D8-FAKE-1):
//   - B07's ContractFakeObjectStorage (@kauro/application/testing): staging, delivery and the holder side of its sessions;
//   - B08-CORE-PORTS' ContractFakeMigrationCore (@kauro/application/testing/cores): the execution envelope and the verifier, and
//     for an audit the profiler and the validator;
//   - B08-CORE-PORTS' ContractFakeIntelligenceCore (@kauro/application/testing/cores): an audit's candidate planning, interpretation
//     over the platform's own model-task journal, and the plan compiler;
//   - B08-WORKER-HOST's ContractFakeWorkerHost (@kauro/data-plane/testing/worker-host): a local executor running the core inside the
//     REAL attempt envelope of @kauro/data-plane (AttemptScratchStore, FencedArtifactWriter, GenerationSourceReader).
//
// The control plane's units of work are audit units of work (PgAuditUnitOfWorkFactory, a superset of the execution factory; mandate
// B08-CONTROL-AUDIT), and its validation receipts are written by the validator's own verified pool (kauro_validator_test) through
// @kauro/persistence's PgValidationReceiptRecorder — never a fake.
//
// The entitlements are B09's own (D8-PAY-1): each purchase is a plan approved through B06's adapters over a source sealed through
// B07's lifecycle fixture, then paid through @kauro/persistence/testing paidPurchase (an ACTIVE CommercialAuthorization written by
// the payment service's role). CMD036 and CMD037 are the request handlers' writes through the execution store in the owner's TENANT
// unit of work (the routes are B08-COMMANDS-EXECUTION's); a revocation is B09's payment-service write through its own adapter.
//
// Time (D8-CLOCK-1): every lifecycle instant is the database's. A test that must stand after a lease's expiry moves the control
// plane forward through the labelled TEST CLOCK — `advance(seconds)` sets kauro_test.clock_offset_seconds in every unit of work the
// control plane opens from then on (transaction-local, set_config(..., true)) and moves the worker host's clock by as much — never a
// back-dated row and never a sleep. Interleavings are the fakes' hold points, a hold inside a unit of work (`heldUnits`) and lock
// waits observed in pg_stat_activity. The superuser connection is the oracle only.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowCounts, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type {
  ConsumerOutcome,
  ExecutionEnvelopePort,
  ExecutionLimits,
  InterpretPort,
  OutboxConsumer,
  PackageVerifierPort,
  PlanCompilerPort,
  ProfilePort,
  ResumableUploadAnswer,
  ResumableUploadPort,
  ValidatePort,
  WorkerHostPort,
} from "@kauro/application";
import { ContractFakeAuthorityJournal, ContractFakeObjectStorage, ContractFakeSessionVault } from "@kauro/application/testing";
import { CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH, CONTRACT_FAKE_MIGRATION_CORE_VERSION, ContractFakeIntelligenceCore, ContractFakeMigrationCore } from "@kauro/application/testing/cores";
import { ContractFakeMalwareScanner } from "@kauro/data-plane/testing";
import { ContractFakeWorkerHost } from "@kauro/data-plane/testing/worker-host";
import {
  createIdGenerator,
  toUtcInstant,
  type ApprovalId,
  type AssuranceProofId,
  type AuditUnitOfWork,
  type CausationId,
  type ClientId,
  type Clock,
  type CommercialAuthorizationId,
  type CorrelationId,
  type DomainEventRecord,
  type ExecutionContext,
  type ExecutionUnitOfWork,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type IdGenerator,
  type MembershipId,
  type PlanBody,
  type PlanId,
  type ProcessingJobId,
  type ProcessingJobRecord,
  type ProjectId,
  type RevisionId,
  type SourceFileId,
  type SourceUnitOfWork,
  type UnitOfWorkOptions,
  type UserId,
  type ValidationReceiptId,
  type VersionedWrite,
} from "@kauro/domain";
import { targetBodyDigest, type TargetBody } from "@kauro/domain";
import { PgAuditUnitOfWorkFactory, PgValidationReceiptRecorder, type KauroPool, type PgAuditUnitOfWork } from "@kauro/persistence";
import {
  activateAgency,
  paidPurchase,
  queueJob,
  recordReviewedFiscalProfile,
  startHarness,
  waitForLockWait,
  raceStatementTimeoutMs,
  type AgencyFixture,
  type Harness,
  type QualifiedRoute,
} from "@kauro/persistence/testing";
import { assembleControlPlane, boundTo, platformParsers, publish, type AuditUnits, type ControlPlane, type DispatchCounts, type ExecutionPlane, type ValidationReceipts } from "../../src/index.js";

export const clock: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
export const ids: IdGenerator = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

export function sha(value: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The importer-profile catalogue's keys as the tests know them (B17 L2, R2-018..022): the oracle of the product's own table, so a
 * product key that drifts fails the catalogue cell instead of passing against itself. Every confirmed fixture target names one.
 */
export const IMPORTER_PROFILE_IDS = Object.freeze({
  HUBSPOT_IMPORT_UI: "0192a000-0000-7000-8000-000000000001",
  SALESFORCE_DATA_LOADER: "0192a000-0000-7000-8000-000000000002",
  SF_BULK_API2: "0192a000-0000-7000-8000-000000000003",
});
export const IMPORTER_VERSION = "R2-INITIAL";
export const FIXTURE_OBSERVED_AT = "2026-10-01T00:00:00.000Z";

/** What a fixture target is made of when a test needs a particular profile or object inventory (default: the mode's own profile, no objects). */
export interface TargetShape {
  /** The contract body's mode when it is not the project's (CLEAN: the importer-profile gate is vacuous). */
  readonly mode?: "CLEAN";
  readonly importerProfileId?: string;
  readonly importerVersion?: string;
  readonly objects?: TargetBody["objects"];
}

/** The application name of every control-plane connection of the harness (pg_stat_activity). */
export const CONTROL_APPLICATION = "kauro-test-control";

/** The envelope every attempt of these tests runs in (manual 04 "Resources"; a small scratch budget, the host's real quota). */
export const TEST_LIMITS: ExecutionLimits = Object.freeze({ hardMemoryBytes: 8 * 2 ** 30, memoryBudgetBytes: 6 * 2 ** 30, hardScratchBytes: 64 * 2 ** 30, scratchBudgetBytes: 1 << 20, wallClockMs: 8 * 3_600_000 });

// --- the labelled TEST CLOCK of the control plane's own units of work -----------------------------------------------------------

const connectTo = (pool: KauroPool) => pool.connectUnverified();
type RawClient = Awaited<ReturnType<typeof connectTo>>;
/** What the world's raw statements need of a pg connection. */
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<{ readonly rowCount: number | null }>;
}

/**
 * The control plane's units of work (@kauro/persistence PgAuditUnitOfWorkFactory, unchanged: the execution factory with the audit
 * store and discovery on the same connection) whose transactions stand `offsetSeconds` ahead on the labelled TEST CLOCK: each unit of
 * work sets kauro_test.clock_offset_seconds transaction-locally before its first statement (the TEST CLOCK function of
 * @kauro/persistence/testing reads it; a deployment has no such function). The source units of work run as these units too, so every
 * unit the control plane opens reads the same clock.
 */
export class TestClockExecutionUnits extends PgAuditUnitOfWorkFactory {
  offsetSeconds = 0;

  protected override createUnitOfWork(client: QueryClient, context: ExecutionContext, idGenerator: IdGenerator, unitClock: Clock): PgAuditUnitOfWork {
    if (this.offsetSeconds !== 0) {
      // queued on the connection before the work's first statement (a pg client runs its queries in order)
      client.query("SELECT set_config('kauro_test.clock_offset_seconds', $1, true)", [String(this.offsetSeconds)]).catch(() => undefined);
    }
    return super.createUnitOfWork(client as unknown as RawClient, context, idGenerator as never, unitClock);
  }

  override runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return this.run(context, (uow) => work(uow as unknown as SourceUnitOfWork), options);
  }
}

// --- a hold inside a unit of work --------------------------------------------------------------------------------------------------

export interface UnitHold {
  /** Resolves once a unit of work returned from the held method (its locks and writes stand, uncommitted). */
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * The same units of work, with a one-shot hold after the next call of one execution-store method: the unit stays open — its locks
 * held — until the test releases it (21 "Concurrency and crash matrix": interleavings by hold points, never a sleep). Everything else
 * is forwarded to the unchanged adapters.
 */
export function heldUnits(inner: AuditUnits, method: keyof ExecutionUnitOfWork["execution"], when: "AFTER" | "BEFORE" = "AFTER"): { readonly units: AuditUnits; readonly hold: UnitHold } {
  return heldStoreUnits(inner, "execution", method, when);
}

/** The same, on one method of the audit store (the audit units of work; mandate B08-CONTROL-AUDIT). */
export function heldAuditUnits(inner: AuditUnits, method: keyof AuditUnitOfWork["audits"], when: "AFTER" | "BEFORE" = "AFTER"): { readonly units: AuditUnits; readonly hold: UnitHold } {
  return heldStoreUnits(inner, "audits", method, when);
}

function heldStoreUnits(inner: AuditUnits, storeName: "execution" | "audits", method: string, when: "AFTER" | "BEFORE"): { readonly units: AuditUnits; readonly hold: UnitHold } {
  let armed = true;
  let signal: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (signal = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const instrument = <U extends object>(uow: U): U =>
    new Proxy(uow, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === storeName) {
          const store = value as Record<string | symbol, unknown>;
          return new Proxy(store, {
            get(s, p) {
              const fn = Reflect.get(s, p, s) as unknown;
              if (typeof fn !== "function") return fn;
              const bound = (fn as (...args: unknown[]) => unknown).bind(s);
              if (p !== method) return bound;
              return async (...args: unknown[]) => {
                if (armed && when === "BEFORE") {
                  armed = false;
                  signal();
                  await released;
                }
                const out = await bound(...args);
                if (armed && when === "AFTER") {
                  armed = false;
                  signal();
                  await released;
                }
                return out;
              };
            },
          });
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  const units = new Proxy(inner, {
    get(target, prop) {
      if (prop === "run") return <T>(context: ExecutionContext, work: (uow: AuditUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions) => target.run(context, (uow) => work(instrument(uow)), options);
      if (prop === "runSource") return <T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions) => target.runSource(context, (uow) => work(instrument(uow)), options);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { units, hold: { reached, release } };
}

// --- the world --------------------------------------------------------------------------------------------------------------------

/** A paid purchase of a fresh HUBSPOT project: what the job binds, and the facts a test makes stale. */
export interface Purchase {
  readonly agency: AgencyFixture;
  readonly authorizationId: CommercialAuthorizationId;
  readonly orderId: string;
  readonly captureId: string;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly revisionId: RevisionId;
  readonly revisionHash: Sha256Hex;
  readonly contractId: string;
  readonly capabilityId: string;
}

/** What an audit is of (D8-AUD-1): a fresh project of the agency, its revision sealed recently and a confirmed, current target. */
export interface AuditSubject {
  readonly agency: AgencyFixture;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly revisionHash: Sha256Hex;
  readonly contractId: string;
  readonly targetContractHash: Sha256Hex;
  readonly capabilityId: string;
}

/**
 * The package a purchase is to deliver, when a test runs a real Migration Core package through the job (B13 x B08): the sealed revision
 * freezes its populations, the validation receipt carries its counts and binds its manifest hash, and the quote is accepted under the
 * hash of its terms document. Without it the purchase is the world's default 120-record fixture.
 */
export interface ReportFixture {
  readonly counts: RowCounts;
  readonly expectedManifestSha256: Sha256Hex;
  readonly termsHash: Sha256Hex;
}

/** What a second control-plane process may bind instead of the world's own units, providers and cores (each a test decorator). */
export interface PlaneOverrides {
  readonly units?: AuditUnits;
  readonly host?: WorkerHostPort;
  readonly verifier?: PackageVerifierPort;
  readonly profile?: ProfilePort;
  readonly interpret?: InterpretPort;
  readonly compiler?: PlanCompilerPort;
  readonly validate?: ValidatePort;
  readonly receipts?: ValidationReceipts;
}

export interface JobRow {
  readonly job_id: string;
  readonly agency_id: string;
  readonly state: string;
  readonly holds: string;
  readonly version: string;
  readonly attempt_count: number;
  readonly current_attempt_id: string | null;
  readonly fence: string;
  readonly cancel_version: string;
  readonly cancel_actor_kind: string | null;
  readonly cancel_actor_id: string | null;
  readonly cancel_reason_code: string | null;
  readonly terminal_reason: string | null;
  readonly published_package_id: string | null;
  readonly admitted_at: Date | null;
  readonly started_at: Date | null;
}

export interface AttemptRow {
  readonly attempt_id: string;
  readonly ordinal: number;
  readonly state: string;
  readonly fence: string | null;
  readonly identity: string;
  readonly staging_prefix: string;
  readonly manifest_object_name: string | null;
  readonly launch_state: string;
  readonly provider_job_id: string | null;
  readonly terminal_cause: string | null;
  readonly claimed_at: Date | null;
}

export interface PackageRow {
  readonly package_version_id: string;
  readonly attempt_id: string;
  readonly state: string;
  readonly version: string;
  readonly revocation_reason: string | null;
  readonly verification_id: string | null;
  readonly delivery_manifest_hash: string | null;
}

export interface ExecutionWorld {
  readonly h: Harness;
  /** The control plane's units of work (the labelled TEST CLOCK of `advance`). */
  readonly units: TestClockExecutionUnits;
  readonly plane: ControlPlane;
  readonly x: ExecutionPlane;
  readonly storage: ContractFakeObjectStorage;
  /** B07's session vault fake the control plane's STORAGE_LIFECYCLE opens sealed session references with (the request side seals them). */
  readonly vault: ContractFakeSessionVault;
  readonly core: ContractFakeMigrationCore;
  /** The labelled Intelligence-core fake an audit's INTERPRET step and the plan compiler are bound to (B08-CORE-PORTS). */
  readonly intelligence: ContractFakeIntelligenceCore;
  /** The validator's write path: PgValidationReceiptRecorder over the kauro_validator_test pool (the only writer of receipts). */
  readonly receipts: ValidationReceipts;
  readonly host: ContractFakeWorkerHost;
  /** The worker host's (provider) clock; `advance` moves it with the control plane's TEST CLOCK. */
  readonly hostClock: Clock & { advance(ms: number): void };
  readonly scratchRoot: string;
  /** Two ACTIVE agencies with reviewed fiscal profiles (a test may make more with `agency`). */
  readonly A: AgencyFixture;
  readonly B: AgencyFixture;
  readonly capabilityId: string;
  agency(label: string): Promise<AgencyFixture>;
  /** The end client every project of the agency is created for (made with the agency). */
  clientOf(agency: AgencyFixture): ClientId;
  /** The agency's upload session limit, set by the control plane's capacity row (what CMD013 reserves against). */
  allowUploads(agency: AgencyFixture, limit: number): Promise<void>;
  /** A confirmed, current target contract of the project (observation and confirmation leave it; the request handlers' write). */
  confirmTarget(agency: AgencyFixture, projectId: ProjectId, label: string, mode?: "HUBSPOT" | "SALESFORCE"): Promise<{ readonly contractId: string; readonly targetContractHash: Sha256Hex }>;
  /** A fresh project of the agency (HUBSPOT, or SALESFORCE), its revision sealed recently through B07's lifecycle and its target confirmed. */
  subject(agency: AgencyFixture, label: string, options?: { readonly mode?: "HUBSPOT" | "SALESFORCE"; readonly target?: TargetShape }): Promise<AuditSubject>;
  /** A paid purchase of a fresh project of the agency (HUBSPOT, or SALESFORCE under that mode's own offered capability). */
  paid(agency: AgencyFixture, label: string, options?: { readonly mode?: "HUBSPOT" | "SALESFORCE"; readonly report?: ReportFixture }): Promise<Purchase>;
  /**
   * B09's paidPurchase of a plan the agency already APPROVED through CMD025 (the end-to-end run): the quote, the order and the completed
   * capture over the world's qualified route, fiscal issuer and the agency's reviewed profile — an ACTIVE CommercialAuthorization.
   */
  purchase(agency: AgencyFixture, planId: PlanId): Promise<{ readonly authorizationId: CommercialAuthorizationId; readonly orderId: string; readonly captureId: string }>;
  /** CMD036's write (the request handlers' TENANT unit of work through the execution store): one QUEUED job with its outbox record. */
  queue(p: Purchase): Promise<ProcessingJobRecord>;
  /** CMD037's write (the request handlers' TENANT unit of work): cancel_command at the job's version, as the agency's owner. */
  cancel(p: Purchase, jobId: string, reasonCode?: string): Promise<ProcessingJobRecord>;
  /** B09's revocation of the purchase's entitlement by the payment service through its own adapter; `hold` keeps it uncommitted. */
  revoke(p: Purchase, hold?: Promise<void>, onLocked?: () => void): Promise<void>;
  /** CMD026's write: the approval withdrawn and the plan APPROVED -> WITHDRAWN, with both events. */
  withdrawApproval(p: Purchase): Promise<void>;
  /** CMD012's write: a successor revision supersedes the purchase's sealed source, with its events. */
  supersedeSource(p: Purchase): Promise<void>;
  /**
   * OBJECT_INVENTORY's revokeAdmission of the first INCLUDED sealed file of the purchase's revision (GENERATION_MISSING or
   * GENERATION_CHANGED) with its source_file.admission_revoked.v1, as the control plane writes it; the revision stays SEALED and
   * EXECUTION_CONTROL has not read the event until a test drains it (B08-R1).
   */
  revokeIncludedFile(p: Purchase, reason: "GENERATION_MISSING" | "GENERATION_CHANGED"): Promise<string>;
  /** The retention sweeper's retention_expires of the purchase's source (the harness, fifteen days ahead on the TEST CLOCK). */
  expireSource(p: Purchase): Promise<void>;
  /** A newer observation supersedes the purchase's target contract (the request handlers' write). */
  /** With `hold`, the supersession is left uncommitted on that connection (its caller ends the transaction): the held half of a race. */
  supersedeTarget(p: Pick<Purchase, "agency" | "contractId">, hold?: Harness["oracle"]): Promise<void>;
  /** A capability suspended (material_counterexample) by the control plane's operations (SUSPENDED is terminal: use a mode no other test needs). */
  suspendCapability(capabilityId: string): Promise<void>;
  /** The process instant the dispatcher claims at, moved with the TEST CLOCK. */
  now(): UtcInstant;
  /** Moves the control plane's TEST CLOCK and the worker host's clock forward by `seconds`. */
  advance(seconds: number): void;
  /** B07's dispatcher delivers every due record of the consumer (at `now()`, again for what its deliveries published), until none is due. */
  drain(consumer: OutboxConsumer): Promise<DispatchCounts>;
  job(jobId: string): Promise<JobRow>;
  attempts(jobId: string): Promise<ReadonlyArray<AttemptRow>>;
  attempt(jobId: string, ordinal?: number): Promise<AttemptRow>;
  packages(jobId: string): Promise<ReadonlyArray<PackageRow>>;
  authorization(authorizationId: string): Promise<{ readonly state: string; readonly job_ref: string | null; readonly consumed_at: Date | null; readonly delivered_at: Date | null; readonly version: string }>;
  events(aggregateId: string): Promise<ReadonlyArray<{ readonly event_type: string; readonly aggregate_version: string; readonly actor_kind: string; readonly actor_id: string | null; readonly correlation_id: string; readonly payload: Record<string, unknown> }>>;
  capacity(agencyId?: string): Promise<{ readonly active: number; readonly waiting: number; readonly live: number }>;
  /** Objects the storage fake holds live under a prefix, `name#generation`, sorted. */
  objectsUnder(zone: "STAGING" | "DELIVERY", prefix: string): Promise<string[]>;
  /** Waits until a control-plane backend is blocked on a lock whose statement contains `fragment` (pg_stat_activity). */
  lockWait(fragment: string): Promise<number>;
  /** Runs `operation` and fails if a control-plane backend waits on a lock meanwhile (the non-waiting admission, D8-LOCK-1). */
  withoutWaiting<T>(operation: Promise<T>, what: string): Promise<T>;
  /**
   * Another control-plane process over the same database and providers (a second scheduler, or one whose units of work, worker
   * host or verifier a test decorates with a hold point): its own dispatcher owner, the same composition root.
   */
  planeWith(overrides: PlaneOverrides): ControlPlane;
  /** The event a job's (or an aggregate's) version published, as the dispatcher reads it. */
  eventOf(aggregateId: string, eventType: string): Promise<DomainEventRecord>;
  /** Hands `event` to `consumer` again, as an at-least-once redelivery does (a SYSTEM context bound to the event's agency). */
  redeliver(consumer: OutboxConsumer, event: DomainEventRecord): Promise<ConsumerOutcome>;
  /** Ends every live job: CMD037 as the owner, then EXECUTION_CONTROL's reconciliation until each is CANCELLED. */
  quiesce(): Promise<void>;
  stop(): Promise<void>;
}

// --- hold points on the providers of a control-plane process (test decorators of the labelled fakes; never a fake of their own) ---

export interface CallHold {
  readonly reached: Promise<void>;
  release(): void;
}

function oneShot(): { readonly hold: CallHold; readonly wait: () => Promise<void>; readonly armed: () => boolean } {
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

/**
 * The worker host whose next `operation` call (for `identity`) answers only after the test releases it: the provider acted and its
 * answer is in flight — the await the control plane is at (design §6).
 */
export function heldHost(host: WorkerHostPort, operation: "launch" | "observe", identity: string, answer?: (outcome: string) => boolean): { readonly host: WorkerHostPort; readonly hold: CallHold } {
  const once = oneShot();
  const decorated: WorkerHostPort = {
    evidenceClass: host.evidenceClass,
    creationHorizonSeconds: host.creationHorizonSeconds,
    async launch(spec) {
      const out = await host.launch(spec);
      if (operation === "launch" && spec.identity === identity && once.armed()) await once.wait();
      return out;
    },
    async observe(id) {
      const out = await host.observe(id);
      if (operation === "observe" && id === identity && once.armed() && (answer === undefined || answer(out.state))) await once.wait();
      return out;
    },
    terminate: (id) => host.terminate(id),
    resources: (id) => host.resources(id),
  };
  return { host: decorated, hold: once.hold };
}

/** The verifier whose next verification answers only after the test releases it (the verifier call's await, design §6). */
export function heldVerifier(verifier: PackageVerifierPort): { readonly verifier: PackageVerifierPort; readonly hold: CallHold } {
  const once = oneShot();
  return {
    verifier: {
      async verify(candidate, expected) {
        const out = await verifier.verify(candidate, expected);
        if (once.armed()) await once.wait();
        return out;
      },
    },
    hold: once.hold,
  };
}

const RECENT_SEAL_MS = 3_600_000;

function applied<T>(write: VersionedWrite<T>, what: string): T {
  if (write.kind !== "APPLIED") throw new Error(`${what} is stale: version ${write.currentVersion}, ${write.currentState}`);
  return write.record;
}

function v7Like(seed: string): string {
  const hex = sha(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(12, 15)}-8${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
}

function planBodyOf(revisionHash: Sha256Hex, targetContractHash: Sha256Hex, seed: string): PlanBody {
  return {
    revisionHash,
    targetContractHash,
    policyHash: sha(`policy-${seed}`),
    mappings: [
      {
        mappingId: v7Like(`${seed}-mapping`),
        sourceTableId: v7Like(`${seed}-table`),
        sourceFieldId: v7Like(`${seed}-field`),
        targetObject: "Contact",
        targetField: "Phone",
        intent: { kind: "SET", reasonCode: "MAPPED" },
        evidence: { evidenceId: v7Like(`${seed}-evidence`), candidateId: v7Like(`${seed}-candidate`), provenance: "AGENCY", factHashes: [], ruleVersion: "R1", comparisonHash: sha(`cmp-${seed}`), fragmentHash: sha(`frag-${seed}`) },
      },
    ],
    identities: [],
    transforms: [],
    relationships: [],
  } as PlanBody;
}

/** The holder side of the storage fake's resumable sessions (the worker's uploads; SIMULATED). */
function holderOf(storage: ContractFakeObjectStorage): ResumableUploadPort {
  return { writeChunk: (sessionRef, chunk, options): Promise<ResumableUploadAnswer> => Promise.resolve(storage.writeThroughSession(sessionRef, chunk, options)) };
}

/** The worker host's clock: real time, moved forward only by the test (with the control plane's TEST CLOCK). */
function hostClockOf(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => toUtcInstant(Date.now() + offset),
    nowMs: () => Date.now() + offset,
    advance(ms: number): void {
      offset += ms;
    },
  };
}

let seq = 0;

export interface ExecutionWorldOptions {
  /** The worker's execution envelope instead of the Migration core fake (built over the world's storage and units once they exist). */
  readonly envelope?: (parts: { readonly storage: ContractFakeObjectStorage; readonly units: TestClockExecutionUnits; readonly oracle: Harness["oracle"] }) => ExecutionEnvelopePort;
}

export async function startExecutionWorld(tag: string, worldOptions: ExecutionWorldOptions = {}): Promise<ExecutionWorld> {
  const h = await startHarness();
  const scratch = mkdtempSync(join(tmpdir(), `kauro-exec-${tag}-`));
  const scratchRoot = join(scratch, "workers");
  const hostClock = hostClockOf();
  const storage = new ContractFakeObjectStorage();
  // the fake core reports the sealed revision's own populations (B05 L1v: the fake parses no source, the oracle reads what was sealed)
  const core = new ContractFakeMigrationCore({
    populationsOf: async (revisionHash) => {
      const r = await h.oracle.query<{ p: number | null; l: number | null; b: number | null; e: number | null }>(
        "SELECT physical_source_rows::int AS p, logical_source_records::int AS l, billable_source_units::int AS b, association_edges::int AS e FROM kauro.dataset_revisions WHERE manifest_hash = $1",
        [revisionHash],
      );
      const x = r.rows.length === 1 ? r.rows[0]! : null;
      return x === null || x.p === null || x.l === null || x.b === null || x.e === null ? null : { physicalSourceRows: x.p, logicalSourceRecords: x.l, billableSourceUnits: x.b, associationEdges: x.e };
    },
  });
  const intelligence = new ContractFakeIntelligenceCore();
  const receipts: ValidationReceipts = new PgValidationReceiptRecorder(h.validatorPool);
  const units = new TestClockExecutionUnits({ app: h.appPool, payment: h.paymentPool, control: h.controlPool }, { clock, defaultStatementTimeoutMs: raceStatementTimeoutMs() });
  const host = new ContractFakeWorkerHost({ core: worldOptions.envelope?.({ storage, units, oracle: h.oracle }) ?? core, storage, uploads: holderOf(storage), scratchRoot, clock: hostClock, creationHorizonSeconds: 300 });
  const vault = new ContractFakeSessionVault();
  const journal = new ContractFakeAuthorityJournal({ path: join(scratch, "authority-journal.jsonl") });
  const scanner = new ContractFakeMalwareScanner({ databaseClock: () => Promise.resolve(clock.now()), read: (location, objectName, generation) => storage.read(location, objectName, generation) });
  const assemble = (overrides: PlaneOverrides = {}): ControlPlane =>
    assembleControlPlane({
      units: overrides.units ?? units,
      ids,
      providers: { storage, scanner, vault, journal },
      parsers: platformParsers(join(scratch, "parsers")),
      scratchRoot: join(scratch, "parsers"),
      retryAfterSeconds: 1,
      execution: {
        units: overrides.units ?? units,
        host: overrides.host ?? host,
        verifier: overrides.verifier ?? core,
        coreVersion: CONTRACT_FAKE_MIGRATION_CORE_VERSION,
        limits: TEST_LIMITS,
        workerScratchRoot: scratchRoot,
        retryAfterSeconds: 30,
        profile: overrides.profile ?? core,
        interpret: overrides.interpret ?? intelligence,
        compiler: overrides.compiler ?? intelligence,
        validate: overrides.validate ?? core,
        receipts: overrides.receipts ?? receipts,
        corePackageHash: CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH,
      },
    });
  const plane = assemble();
  const x = plane.execution;
  assert.ok(x !== null, "the control plane assembles its execution pipelines when their providers are bound");

  // the platform's commercial configuration and a corporate owner (B09 fixtures)
  const kora = await h.person(`${tag}-kora`);
  await h.grantKauroOwner(kora);
  const issuerRef: FiscalIssuerRef = await h.qualifiedFiscalIssuer();
  const route: QualifiedRoute = await h.qualifiedPaymentRoute();
  const capabilityId = await h.offeredCapability("HUBSPOT");
  const clients = new Map<string, ClientId>();
  const profiles = new Map<string, FiscalProfileId>();

  const agency = async (label: string): Promise<AgencyFixture> => {
    const owner = await h.person(`${tag}-${label}-owner-${++seq}`);
    const ag = await h.createAgency(owner, `${tag} ${label}`);
    await activateAgency(h, ag);
    clients.set(ag.agencyId, await h.endClient(ag, await h.processingAuthority(ag), `${label} client`));
    profiles.set(ag.agencyId, await recordReviewedFiscalProfile(h, { operatorUserId: kora, agencyId: ag.agencyId, issuerRef, treatment: "EXEMPT_EXPORT" }));
    return ag;
  };
  const A = await agency("alpha");
  const B = await agency("bravo");

  const control = await h.pg.connect("kauro_control_test");
  const oracle = h.oracle;

  async function asTenant<T>(ag: AgencyFixture, fn: (c: QueryClient) => Promise<T>): Promise<T> {
    const c: RawClient = await connectTo(h.appPool);
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [ag.agencyId, ag.ownerUserId]);
      const out = await fn(c as unknown as QueryClient);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  /** A VALIDATED plan over a recently sealed source and a confirmed target, approved by the owner with a fresh step-up (CMD025). */
  const capabilities = new Map<string, string>([["HUBSPOT", capabilityId]]);
  const capabilityOf = async (mode: "HUBSPOT" | "SALESFORCE"): Promise<string> => {
    const known = capabilities.get(mode);
    if (known !== undefined) return known;
    const offered = await h.offeredCapability(mode);
    capabilities.set(mode, offered);
    return offered;
  };

  /** A fresh project of the agency, its revision sealed recently through B07's lifecycle, and a confirmed, current target contract. */
  async function subjectOf(ag: AgencyFixture, label: string, mode: "HUBSPOT" | "SALESFORCE", shape: TargetShape = {}, report?: ReportFixture): Promise<AuditSubject> {
    const withCapability = await capabilityOf(mode);
    const tenant = () => h.tenant(ag.agencyId, ag.ownerUserId);
    const actor = { kind: "USER", userId: ag.ownerUserId } as const;
    const capabilityVersion = (await oracle.query<{ version: string }>("SELECT version FROM kauro.capabilities WHERE capability_id = $1", [withCapability])).rows[0]?.version ?? "R2-INITIAL";
    // CMD011: the project (its mode) and its DRAFT revision
    const projectId = await h.app.run(tenant(), async (uow) => {
      const pid = uow.ids.next() as ProjectId;
      const revisionId = uow.ids.next() as RevisionId;
      const clientId = clients.get(ag.agencyId) as ClientId;
      const { project, revision } = await uow.projects.insertWithDraftRevision({
        projectId: pid,
        agencyId: ag.agencyId,
        clientId,
        mode,
        purpose: "Execution control plane",
        targetInstanceRef: uow.ids.next() as never,
        capabilityId: withCapability as never,
        capabilityVersion,
        initialRevisionId: revisionId,
        createdByMembershipId: ag.ownerMembershipId,
        createdAt: clock.now(),
      });
      const causationId = uow.ids.next() as CausationId;
      await uow.events.publish({ aggregateKind: "project", aggregateId: pid, aggregateVersion: project.version, agencyId: ag.agencyId, eventType: "project.created.v1", actor, causationId, correlationId: uow.context.correlationId, payload: { projectId: pid, agencyId: ag.agencyId, clientId, mode, capabilityId: withCapability, capabilityVersion, initialRevisionId: revisionId, createdByMembershipId: ag.ownerMembershipId } });
      await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: revision.version, agencyId: ag.agencyId, eventType: "dataset_revision.created.v1", actor, causationId, correlationId: uow.context.correlationId, payload: { revisionId, agencyId: ag.agencyId, projectId: pid, state: revision.state } });
      return pid;
    });
    // B07: the source sealed recently through the lifecycle fixture (a quote promises no more source than its seal left)
    const source = await h.sealedRevision(ag, projectId, "SEALED", {
      base: new Date(Date.now() - RECENT_SEAL_MS),
      ...(report === undefined ? {} : { billableSourceUnits: report.counts.billableSourceUnits, populations: { physicalSourceRows: report.counts.physicalSourceRows, logicalSourceRecords: report.counts.logicalSourceRecords, associationEdges: report.counts.associationEdges } }),
    });
    const { contractId, targetContractHash } = await confirmedTarget(ag, projectId, label, mode, shape);
    return { agency: ag, projectId, revisionId: source.revisionId, revisionHash: source.revisionHash, contractId, targetContractHash, capabilityId: withCapability };
  }

  /** A confirmed, current target contract of the project (observation and confirmation leave it; plans_target_fk). */
  async function confirmedTarget(ag: AgencyFixture, projectId: ProjectId, label: string, mode: "HUBSPOT" | "SALESFORCE", shape: TargetShape = {}): Promise<{ readonly contractId: string; readonly targetContractHash: Sha256Hex }> {
    const capabilityVersion = (await oracle.query<{ version: string }>("SELECT version FROM kauro.capabilities WHERE capability_id = $1", [await capabilityOf(mode)])).rows[0]?.version ?? "R2-INITIAL";
    const contractId = ids.next();
    // B17 L2: the fixture's hash is the real KAURO_TARGET_BODY_V1 digest of its body (PLAN_VALIDATION compares it), its profile a catalogue one
    const body: TargetBody = {
      mode: shape.mode ?? mode,
      instanceId: ids.next(),
      importerProfileId: shape.importerProfileId ?? (mode === "HUBSPOT" ? IMPORTER_PROFILE_IDS.HUBSPOT_IMPORT_UI : IMPORTER_PROFILE_IDS.SALESFORCE_DATA_LOADER),
      importerVersion: shape.importerVersion ?? IMPORTER_VERSION,
      objects: shape.objects ?? [],
      observedAt: FIXTURE_OBSERVED_AT as UtcInstant,
      authorityEvidenceHash: sha(`authority-${contractId}`),
      capabilityVersion,
    };
    const targetContractHash = targetBodyDigest(body);
    // 0084: the confirmed fixture is the oracle's (a request session bears only drafts)
    await oracle.query(
        `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, now(), $12, $13, now())`,
        [contractId, ag.agencyId, projectId, body.mode, body.instanceId, body.importerProfileId, body.importerVersion, JSON.stringify(body.objects), sha("bundle"), targetContractHash, body.observedAt, body.authorityEvidenceHash, capabilityVersion],
    );
    return { contractId, targetContractHash };
  }

  async function approved(ag: AgencyFixture, label: string, mode: "HUBSPOT" | "SALESFORCE", report?: ReportFixture): Promise<Omit<Purchase, "authorizationId" | "orderId" | "captureId">> {
    const { projectId, revisionId, revisionHash, contractId, targetContractHash, capabilityId: withCapability } = await subjectOf(ag, label, mode, {}, report);
    const source = { revisionId, revisionHash };
    const tenant = () => h.tenant(ag.agencyId, ag.ownerUserId);
    const actor = { kind: "USER", userId: ag.ownerUserId } as const;
    // the plan: DRAFT -> VALIDATION_REQUIRED -> VALIDATING by the request handlers, the validator's VALID receipt, VALIDATED
    const body = planBodyOf(source.revisionHash, targetContractHash, `${label}-${projectId}`);
    const bodyHash = structuredDigest(DOMAINS.PLAN_BODY, 1, body);
    const planId = ids.next() as PlanId;
    await h.app.run(tenant(), async (uow) => {
      const correlationId = uow.context.correlationId;
      const causationId = uow.ids.next() as CausationId;
      const plan = await uow.plans.insert({ planId, agencyId: ag.agencyId, projectId, body, createdByMembershipId: ag.ownerMembershipId, createdAt: clock.now() });
      await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: plan.version, agencyId: ag.agencyId, eventType: "plan.created.v1", actor, causationId, correlationId, payload: { planId, agencyId: ag.agencyId, projectId, bodyHash: plan.bodyHash, createdByMembershipId: ag.ownerMembershipId } });
      const required = applied(await uow.plans.transition(planId, 1, { state: "VALIDATION_REQUIRED" }, clock.now()), "validation_required");
      await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: required.version, agencyId: ag.agencyId, eventType: "plan.validation_required.v1", actor, causationId, correlationId, payload: { planId, agencyId: ag.agencyId, bodyHash: plan.bodyHash } });
      const validating = applied(await uow.plans.transition(planId, 2, { state: "VALIDATING" }, clock.now()), "validating");
      await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: validating.version, agencyId: ag.agencyId, eventType: "plan.validating.v1", actor, causationId, correlationId, payload: { planId, agencyId: ag.agencyId, bodyHash: plan.bodyHash } });
    });
    const receiptHash = sha(`receipt-${planId}`);
    const units120 = 120;
    await h.recordValidationReceipt({
      receiptId: ids.next() as ValidationReceiptId,
      agencyId: ag.agencyId,
      planId,
      receiptHash,
      revisionHash: source.revisionHash,
      targetContractHash,
      planHash: bodyHash,
      corePackageHash: sha(`core-package-${CONTRACT_FAKE_MIGRATION_CORE_VERSION}`),
      profileEvidenceHash: sha(`profile-${planId}`),
      dispositionEvidenceHash: sha(`disposition-${planId}`),
      artifactEvidenceHash: report?.expectedManifestSha256 ?? sha(`artifact-${planId}`),
      startedAt: toUtcInstant(Date.now() - 60_000),
      completedAt: clock.now(),
      result: "VALID",
      counts: report?.counts ?? { physicalSourceRows: units120, logicalSourceRecords: units120, billableSourceUnits: units120, associationEdges: 0, emittedRepresentatives: units120, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: units120 },
      blockingIssueCodes: [],
    } as never);
    const proof = await h.recordStepUp(ag.ownerUserId);
    const approvalId = ids.next() as ApprovalId;
    await h.app.run(tenant(), async (uow) => {
      const correlationId = uow.context.correlationId;
      const causationId = uow.ids.next() as CausationId;
      const validated = applied(await uow.plans.transition(planId, 3, { state: "VALIDATED", validationReceiptHash: receiptHash }, clock.now()), "validated");
      await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: validated.version, agencyId: ag.agencyId, eventType: "plan.validated.v1", actor, causationId, correlationId, payload: { planId, agencyId: ag.agencyId, bodyHash, validationReceiptHash: receiptHash } });
      const disclosuresHash = sha(`disclosures-${approvalId}`);
      const approvalHash = sha(`approval-${approvalId}`);
      const approval = await uow.approvals.insert({
        approvalId,
        agencyId: ag.agencyId,
        planId,
        actorId: ag.ownerUserId,
        actorMembershipId: ag.ownerMembershipId,
        actorMembershipVersion: 1,
        assuranceProofRef: proof as AssuranceProofId,
        planHash: bodyHash,
        revisionHash: source.revisionHash,
        targetContractHash,
        validationReceiptHash: receiptHash,
        disclosuresHash,
        approvalHash,
        createdAt: clock.now(),
      });
      await uow.events.publish({ aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: approval.version, agencyId: ag.agencyId, eventType: "approval.created.v1", actor, causationId, correlationId, payload: { approvalId, agencyId: ag.agencyId, planId, planHash: bodyHash, revisionHash: source.revisionHash, targetContractHash, validationReceiptHash: receiptHash, disclosuresHash, actorMembershipId: ag.ownerMembershipId, approvalHash } });
      const approvedPlan = applied(await uow.plans.transition(planId, validated.version, { state: "APPROVED", approvalId }, clock.now()), "approved");
      await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: approvedPlan.version, agencyId: ag.agencyId, eventType: "plan.approved.v1", actor, causationId, correlationId, payload: { planId, agencyId: ag.agencyId, approvalId, approvalHash } });
    });
    return { agency: ag, projectId, planId, approvalId, revisionId: source.revisionId, revisionHash: source.revisionHash, contractId, capabilityId: withCapability };
  }

  const jobRow = async (jobId: string): Promise<JobRow> => {
    const r = await oracle.query<JobRow>(
      `SELECT job_id, agency_id, state, holds, version::text AS version, attempt_count, current_attempt_id, fence::text AS fence, cancel_version::text AS cancel_version,
              cancel_actor_kind, cancel_actor_id, cancel_reason_code, terminal_reason, published_package_id, admitted_at, started_at
         FROM kauro.processing_jobs WHERE job_id = $1`,
      [jobId],
    );
    const row = r.rows[0];
    assert.ok(row, `job ${jobId}`);
    return row;
  };

  const attemptRows = async (jobId: string): Promise<ReadonlyArray<AttemptRow>> =>
    (
      await oracle.query<AttemptRow>(
        `SELECT attempt_id, ordinal, state, fence::text AS fence, identity, staging_prefix, manifest_object_name, launch_state, provider_job_id, terminal_cause, claimed_at
           FROM kauro.processing_attempts WHERE job_id = $1 ORDER BY ordinal`,
        [jobId],
      )
    ).rows;

  const world: ExecutionWorld = {
    h,
    units,
    plane,
    x,
    storage,
    vault,
    core,
    intelligence,
    receipts,
    host,
    hostClock,
    scratchRoot,
    A,
    B,
    capabilityId,
    agency,

    clientOf(ag) {
      const clientId = clients.get(ag.agencyId);
      assert.ok(clientId !== undefined, `the agency ${ag.agencyId} was made by this world`);
      return clientId;
    },

    async allowUploads(ag, limit) {
      const c: RawClient = await connectTo(h.controlPool);
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [ag.agencyId]);
        await c.query(
          "INSERT INTO kauro.upload_capacity (agency_id, active_sessions, session_limit, updated_at) VALUES ($1, 0, $2, now()) ON CONFLICT (agency_id) DO UPDATE SET session_limit = EXCLUDED.session_limit, updated_at = now()",
          [ag.agencyId, limit],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },

    confirmTarget(ag, projectId, label, mode = "HUBSPOT") {
      return confirmedTarget(ag, projectId, label, mode);
    },

    subject(ag, label, options = {}) {
      return subjectOf(ag, label, options.mode ?? "HUBSPOT", options.target);
    },

    async paid(ag, label, options = {}) {
      const subject = await approved(ag, label, options.mode ?? "HUBSPOT", options.report);
      const paid = await paidPurchase(h, {
        agency: ag,
        planId: subject.planId,
        issuerRef,
        profileId: profiles.get(ag.agencyId) as FiscalProfileId,
        treatment: "EXEMPT_EXPORT",
        route,
        ...(options.report === undefined ? {} : { billableUnits: options.report.counts.billableSourceUnits, termsHash: options.report.termsHash }),
      });
      return { ...subject, authorizationId: paid.authorizationId, orderId: paid.orderId, captureId: paid.captureId };
    },

    async purchase(ag, planId) {
      const paid = await paidPurchase(h, { agency: ag, planId, issuerRef, profileId: profiles.get(ag.agencyId) as FiscalProfileId, treatment: "EXEMPT_EXPORT", route });
      return { authorizationId: paid.authorizationId, orderId: paid.orderId, captureId: paid.captureId };
    },

    queue(p) {
      return queueJob(h, p.agency, p.authorizationId);
    },

    async cancel(p, jobId, reasonCode = "Client no longer needs this run") {
      return h.execution.run(h.tenant(p.agency.agencyId, p.agency.ownerUserId), async (uow) => {
        const job = await uow.execution.lockJob(jobId as ProcessingJobId);
        assert.ok(job, `job ${jobId} is visible to its agency`);
        return applied(await uow.execution.requestCancellation(job.jobId, job.version, { actor: { kind: "USER", userId: p.agency.ownerUserId }, reasonCode }), "cancel_command");
      });
    },

    async revoke(p, hold, onLocked) {
      await h.commerce.run(h.service(), async (uow) => {
        assert.ok((await uow.adoptScope("PAYMENT_ORDER", p.orderId)) !== null, "the payment service adopts the order's agency");
        const current = await uow.commerce.authorizations.lock(p.authorizationId);
        assert.ok(current, "the entitlement is visible to the payment service");
        const phase = current.state === "ACTIVE" ? "PRE_EXECUTION" : current.state === "CONSUMED" ? "DURING_EXECUTION" : "POST_DELIVERY";
        const now = clock.now();
        applied(await uow.commerce.authorizations.transition(p.authorizationId, current.version, { state: "REVOKED", revocation: { at: now, phase, code: "CAPTURE_REVERSED" } }, now), "the revocation");
        onLocked?.();
        if (hold !== undefined) await hold;
      });
    },

    async withdrawApproval(p) {
      await h.app.run(h.tenant(p.agency.agencyId, p.agency.ownerUserId), async (uow) => {
        const actor = { kind: "USER", userId: p.agency.ownerUserId } as const;
        const causationId = uow.ids.next() as CausationId;
        const plan = await uow.plans.lock(p.planId);
        const approval = await uow.approvals.get(p.approvalId);
        assert.ok(plan && approval, "the plan and its approval are visible");
        const withdrawn = applied(await uow.approvals.withdraw(p.approvalId, approval.version, { membershipId: p.agency.ownerMembershipId, reasonCode: "Scope changed" }, clock.now()), "the withdrawal");
        await uow.events.publish({ aggregateKind: "approval", aggregateId: p.approvalId, aggregateVersion: withdrawn.version, agencyId: p.agency.agencyId, eventType: "approval.withdrawn.v1", actor, causationId, correlationId: uow.context.correlationId, payload: { approvalId: p.approvalId, agencyId: p.agency.agencyId, planId: p.planId, withdrawnByMembershipId: p.agency.ownerMembershipId, completedExternalActions: [] } });
        const moved = applied(await uow.plans.transition(p.planId, plan.version, { state: "WITHDRAWN" }, clock.now()), "the plan's withdrawal");
        await uow.events.publish({ aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: moved.version, agencyId: p.agency.agencyId, eventType: "plan.withdrawn.v1", actor, causationId, correlationId: uow.context.correlationId, payload: { planId: p.planId, agencyId: p.agency.agencyId, approvalId: p.approvalId } });
      });
    },

    async supersedeSource(p) {
      const successorId = ids.next() as RevisionId;
      await h.app.runSource(h.tenant(p.agency.agencyId, p.agency.ownerUserId), async (uow) => {
        const actor = { kind: "USER", userId: p.agency.ownerUserId } as const;
        const causationId = uow.ids.next() as CausationId;
        const publish = (aggregateKind: string, aggregateId: string, aggregateVersion: number, eventType: string, payload: Record<string, unknown>) =>
          uow.events.publish({ aggregateKind, aggregateId, aggregateVersion, agencyId: p.agency.agencyId, eventType, actor, causationId, correlationId: uow.context.correlationId, payload } as never);
        const project = await uow.projects.lock(p.projectId);
        const predecessor = await uow.sources.revisions.lock(p.revisionId);
        assert.ok(project && predecessor && predecessor.state === "SEALED", "the source is SEALED");
        await uow.sources.revisions.insertSuccessor({ revisionId: successorId, agencyId: p.agency.agencyId, projectId: p.projectId, supersedesRevisionId: p.revisionId, createdByMembershipId: p.agency.ownerMembershipId as MembershipId, createdAt: clock.now() });
        const superseded = applied(await uow.sources.revisions.transition(p.revisionId, predecessor.version, { event: "new_revision_explicitly_supersedes", successorRevisionId: successorId }), "the supersession");
        await publish("dataset_revision", p.revisionId, superseded.version, "dataset_revision.superseded.v1", { revisionId: p.revisionId, agencyId: p.agency.agencyId, projectId: p.projectId, successorRevisionId: successorId, manifestHash: p.revisionHash, affectedPlanIds: [p.planId], affectedApprovalIds: [p.approvalId], affectedCommercialAuthorizationIds: [p.authorizationId] });
        await publish("dataset_revision", successorId, 1, "dataset_revision.created.v1", { revisionId: successorId, agencyId: p.agency.agencyId, projectId: p.projectId, state: "DRAFT", supersedesRevisionId: p.revisionId, createdByMembershipId: p.agency.ownerMembershipId });
        const moved = applied(await uow.sources.projects.switchCurrentRevision(p.projectId, project.version, successorId, clock.now()), "the current revision");
        await publish("project", p.projectId, moved.version, "project.current_revision_changed.v1", { projectId: p.projectId, agencyId: p.agency.agencyId, currentRevisionId: successorId, previousRevisionId: p.revisionId, changedByMembershipId: p.agency.ownerMembershipId });
      });
    },

    async revokeIncludedFile(p, reason) {
      const [row] = (
        await h.oracle.query<{ file_id: string }>(
          "SELECT file_id FROM kauro.sealed_revision_files WHERE revision_id = $1 AND disposition = 'INCLUDED' ORDER BY ordinal LIMIT 1",
          [p.revisionId],
        )
      ).rows;
      assert.ok(row, "the revision seals an included file");
      const fileId = row.file_id as SourceFileId;
      const item = { serviceId: "object-inventory", agencyId: p.agency.agencyId, correlationId: ids.next() as CorrelationId, causationId: ids.next() as CausationId };
      await units.runSource(boundTo(item), async (uow) => {
        const found = await uow.sources.files.get(fileId);
        assert.ok(found && found.state === "ADMITTED", "the file is admitted");
        // the revision row first, then the file (B07 D-LOCK-2), as OBJECT_INVENTORY takes them
        assert.ok(await uow.sources.revisions.lock(found.originRevisionId));
        const selectedBy = await uow.sources.files.selectedBy(fileId);
        const sealedBy = await uow.sources.files.sealedBy(fileId);
        const record = applied(await uow.sources.files.revokeAdmission(fileId, found.version, reason), "admission revocation");
        await publish(uow, item, "source_file", fileId, record.version, "source_file.admission_revoked.v1", {
          fileId,
          agencyId: p.agency.agencyId,
          projectId: found.projectId,
          revocationReason: reason,
          selectedByRevisionIds: [...selectedBy],
          sealedByRevisionIds: [...sealedBy],
        });
      });
      return fileId;
    },

    async expireSource(p) {
      await h.expireRevision(p.agency, p.projectId, p.revisionId);
    },

    async supersedeTarget(p, hold) {
      const db = hold ?? oracle;
      // 0084 (b): CMD019's shape through the oracle — a later observation of the same instance supersedes the contract and is
      // confirmed in the same transaction
      await db.query("BEGIN");
      try {
        const old = (await db.query<{ project_id: string; mode: string; instance_id: string; observed_at: Date; capability_version: string }>(
          "SELECT project_id, mode, instance_id, observed_at, capability_version FROM kauro.target_contracts WHERE contract_id = $1",
          [p.contractId],
        )).rows[0]!;
        const next = ids.next();
        await db.query(
          `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'R2-INITIAL', '[]'::jsonb, $7, $8, $9, NULL, $10, $11, now())`,
          [next, p.agency.agencyId, old.project_id, old.mode, old.instance_id, ids.next(), sha("bundle"), sha(`superseder-${next}`), new Date(Math.max(Date.now(), old.observed_at.getTime() + 1)), sha(`authority-${next}`), old.capability_version],
        );
        await db.query("UPDATE kauro.target_contracts SET superseded_at = now(), superseded_by_contract_id = $2, version = version + 1 WHERE contract_id = $1", [p.contractId, next]);
        const evidenceId = ids.next();
        await db.query(
          `INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id)
           VALUES ($1, $2, $3, 'CONFIRMATION_EVIDENCE', $4, $5, '{}'::jsonb, $6, $7)`,
          [evidenceId, p.agency.agencyId, old.project_id, old.mode, old.instance_id, sha(`confirmation-${next}`), p.agency.ownerMembershipId],
        );
        await db.query(
          "UPDATE kauro.target_contracts SET confirmed_at = kauro.server_now(), confirmed_by_membership_id = $2, confirmation_evidence_ref = $3, version = version + 1 WHERE contract_id = $1",
          [next, p.agency.ownerMembershipId, evidenceId],
        );
        if (hold === undefined) await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    },

    async suspendCapability(id) {
      const r = await control.query("UPDATE kauro.capabilities SET state = 'SUSPENDED' WHERE capability_id = $1 AND state IN ('AVAILABLE_LIMITED', 'AVAILABLE')", [id]);
      assert.equal(r.rowCount, 1, "the capability was offered and is now SUSPENDED");
    },

    now() {
      return toUtcInstant(Date.now() + units.offsetSeconds * 1000);
    },

    advance(seconds) {
      units.offsetSeconds += seconds;
      hostClock.advance(seconds * 1000);
    },

    async drain(consumer) {
      // B07's drain claims what is due at one instant; the records its deliveries publish are due at the next pass
      let delivered = 0;
      let retried = 0;
      let deadLettered = 0;
      for (let pass = 0; pass < 10; pass++) {
        const counts = await plane.drain(consumer, world.now());
        delivered += counts.delivered;
        retried += counts.retried;
        deadLettered += counts.deadLettered;
        if (counts.delivered + counts.retried + counts.deadLettered === 0) break;
      }
      return { delivered, retried, deadLettered };
    },

    job: jobRow,
    attempts: attemptRows,

    async attempt(jobId, ordinal) {
      const rows = await attemptRows(jobId);
      const row = ordinal === undefined ? rows[rows.length - 1] : rows.find((a) => a.ordinal === ordinal);
      assert.ok(row, `attempt ${ordinal ?? "latest"} of job ${jobId}`);
      return row;
    },

    async packages(jobId) {
      return (
        await oracle.query<PackageRow>(
          "SELECT package_version_id, attempt_id, state, version::text AS version, revocation_reason, verification_id, delivery_manifest_hash FROM kauro.package_versions WHERE job_id = $1 ORDER BY created_at",
          [jobId],
        )
      ).rows;
    },

    async authorization(authorizationId) {
      const r = await oracle.query<{ state: string; job_ref: string | null; consumed_at: Date | null; delivered_at: Date | null; version: string }>(
        "SELECT state, job_ref, consumed_at, delivered_at, version::text AS version FROM kauro.commercial_authorizations WHERE authorization_id = $1",
        [authorizationId],
      );
      const row = r.rows[0];
      assert.ok(row, `authorization ${authorizationId}`);
      return row;
    },

    async events(aggregateId) {
      return (
        await oracle.query<{ event_type: string; aggregate_version: string; actor_kind: string; actor_id: string | null; correlation_id: string; payload: Record<string, unknown> }>(
          "SELECT event_type, aggregate_version::text AS aggregate_version, actor_kind, actor_id, correlation_id::text AS correlation_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version",
          [aggregateId],
        )
      ).rows;
    },

    async capacity(agencyId) {
      const r = await oracle.query<{ active: number; waiting: number; live: number }>(
        `SELECT (SELECT active_jobs FROM kauro.execution_capacity WHERE ledger_id = 1) AS active, (SELECT waiting_jobs FROM kauro.execution_capacity WHERE ledger_id = 1) AS waiting,
                coalesce((SELECT live_jobs FROM kauro.agency_execution_capacity WHERE agency_id = $1), 0) AS live`,
        [agencyId ?? null],
      );
      const row = r.rows[0];
      assert.ok(row);
      return { active: Number(row.active), waiting: Number(row.waiting), live: Number(row.live) };
    },

    async objectsUnder(zone, prefix) {
      const listed = await storage.list(storage.location(zone), prefix);
      return listed.objects.map((o) => `${o.objectName}#${o.generation}`).sort();
    },

    lockWait(fragment) {
      return waitForLockWait(oracle, CONTROL_APPLICATION, fragment);
    },

    async withoutWaiting(operation, what) {
      let done = false;
      const settled = operation.finally(() => {
        done = true;
      });
      while (!done) {
        const r = await oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [CONTROL_APPLICATION]);
        if (!done && Number(r.rows[0]?.n ?? "0") > 0) throw new Error(`${what} waited on a lock`);
        await Promise.race([settled.then(() => undefined, () => undefined), new Promise((resolve) => setTimeout(resolve, 10))]);
      }
      return settled;
    },

    planeWith(overrides) {
      return assemble(overrides);
    },

    async eventOf(aggregateId, eventType) {
      const r = await oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = $2 ORDER BY aggregate_version DESC LIMIT 1", [aggregateId, eventType]);
      const eventId = r.rows[0]?.event_id;
      assert.ok(eventId, `${eventType} of ${aggregateId}`);
      const event = await units.runSource({ kind: "SYSTEM", serviceId: "outbox-dispatcher", correlationId: ids.next() as CorrelationId }, (uow) => uow.events.get(eventId as never));
      assert.ok(event, `event ${eventId} is readable by the control plane`);
      return event;
    },

    redeliver(consumer, event) {
      return consumer.handle(event, { kind: "SYSTEM", serviceId: consumer.consumer.toLowerCase().replace(/_/g, "-"), correlationId: event.correlationId as CorrelationId, agencyId: event.agencyId as never }, units);
    },

    async quiesce() {
      const live = await oracle.query<{ job_id: string; agency_id: string; state: string; cancel_version: string }>(
        "SELECT job_id, agency_id, state, cancel_version::text AS cancel_version FROM kauro.processing_jobs WHERE state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING', 'CANCEL_REQUESTED')",
      );
      for (const j of live.rows) {
        if (j.cancel_version === "0") {
          const owner = await oracle.query<{ user_id: UserId }>("SELECT user_id FROM kauro.memberships WHERE agency_id = $1 AND role = 'OWNER'", [j.agency_id]);
          const userId = owner.rows[0]?.user_id;
          assert.ok(userId);
          await h.execution.run(h.tenant(j.agency_id as never, userId), async (uow) => {
            const job = await uow.execution.lockJob(j.job_id as ProcessingJobId);
            if (job === null || job.cancelVersion !== 0 || !["QUEUED", "ADMITTED", "RUNNING", "VERIFYING"].includes(job.state)) return;
            await uow.execution.requestCancellation(job.jobId, job.version, { actor: { kind: "USER", userId }, reasonCode: "End of test" });
          });
        }
        for (let round = 0; round < 5; round++) {
          await x.cancellations.reconcile(j.job_id as ProcessingJobId);
          if ((await jobRow(j.job_id)).state === "CANCELLED") break;
        }
        assert.equal((await jobRow(j.job_id)).state, "CANCELLED", `job ${j.job_id} ended`);
      }
      for (const job of host.jobs()) if (job.state === "QUEUED" || job.state === "RUNNING") await host.terminate(job.identity);
      const current = await world.capacity();
      assert.deepEqual([current.active, current.waiting], [0, 0], "no slot is held after the test");
    },

    async stop() {
      await control.end();
      await h.stop();
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return world;
}

/** The identity of a job's current attempt (kauro-attempt-<attemptId>, D8-HOST-1). */
export async function identityOf(w: ExecutionWorld, jobId: string): Promise<string> {
  return (await w.attempt(jobId)).identity;
}

/** Queues a job of the purchase and admits it (JOB_ADMISSION's round); returns the job and its attempt's identity, not yet launched. */
export async function admitted(w: ExecutionWorld, p: Purchase): Promise<{ readonly jobId: string; readonly identity: string }> {
  const job = await w.queue(p);
  await w.x.sweepers.jobAdmission.admitRound();
  const row = await w.job(job.jobId);
  assert.equal(row.state, "ADMITTED", `job ${job.jobId} was admitted`);
  return { jobId: job.jobId, identity: await identityOf(w, job.jobId) };
}

/** Launches the admitted job (JOB_EXECUTION's launch: intent, create by identity, record). */
export async function launched(w: ExecutionWorld, jobId: string): Promise<void> {
  const step = await w.x.pipeline.launchNext();
  assert.equal(step.kind, "APPLIED", `the launch of ${jobId}: ${JSON.stringify(step)}`);
  const attempt = await w.attempt(jobId);
  assert.equal(attempt.state, "STARTING");
}

/** The worker of `identity` finished; ATTEMPT_MONITOR observes it (start, then its end: a submission or a failure). */
export async function observedDone(w: ExecutionWorld, identity: string): Promise<void> {
  await w.host.settled(identity);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 50);
}

/** Runs a queued-and-admitted job's attempt through its worker to VERIFIED_PRIVATE (verification of JOB_EXECUTION; no delivery yet). */
export async function verifiedPrivate(w: ExecutionWorld, p: Purchase): Promise<{ readonly jobId: string; readonly identity: string }> {
  const { jobId, identity } = await admitted(w, p);
  await launched(w, jobId);
  await observedDone(w, identity);
  assert.equal((await w.job(jobId)).state, "VERIFYING", "the manifest was submitted");
  const step = await w.x.pipeline.verify(jobId as ProcessingJobId);
  assert.equal(step.kind, "APPLIED", JSON.stringify(step));
  const [pkg] = await w.packages(jobId);
  assert.equal(pkg?.state, "VERIFIED_PRIVATE");
  return { jobId, identity };
}

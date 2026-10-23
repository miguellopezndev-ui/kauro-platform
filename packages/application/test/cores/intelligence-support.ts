// Test support of the Intelligence adapter (B05 L3): a real source profile built by Migration Core from a temporary CSV, the labelled
// SIMULATED gateway and money admission of the Intelligence core, a validation port that really runs Migration Core over the same input
// (so the receipt's configuration hash, effects and counts are the core's own), an in-memory fenced journal and an in-memory document store.
// Every directory is the test's own mkdtemp and is removed by `dispose`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Id, Sha256Hex } from "@kauro/contracts";
import type { AgencyId } from "@kauro/domain";
import { MemoryDispatchAdmission, VirtualClock, digestOf, effectsFromMigrationRun, oracleProposal, scriptedGateway, sha256Hex, toMigrationConfig } from "@kauro/intelligence-core";
import type { CandidateConfiguration, FullDatasetValidationPort, FullDatasetValidationResult, ModelTariff, ScriptedGateway } from "@kauro/intelligence-core";
import { buildSourceProfile, createFilesystemScratchStore, loadConfig, runMigration, syntheticConfig } from "@kauro/migration-core";
import type { HashedSourceProfile } from "@kauro/migration-core";
import type { CancellationState, CoreDocumentKind, CoreDocumentStore, CorePlanBinding, InterpretRequest, ModelTaskJournalAppendOutcome, ModelTaskJournalEvent, ModelTaskJournalPort } from "../../src/index.js";
import { IntelligenceCoreAdapter, type IntelligenceAdapterDeps, type IntelligenceRunBindings } from "../../src/index.js";

export const AGENCY = "0192a000-0000-7000-8000-000000000001" as AgencyId;
export const PROJECT = "0192a000-0000-7000-8000-000000000002" as Id;
export const REVISION_ID = "0192a000-0000-7000-8000-000000000003" as Id;
export const ATTEMPT = "0192a000-0000-7000-8000-000000000004" as Id;
export const REVISION_HASH = sha256Hex("revision-1") as Sha256Hex;
export const TARIFF: ModelTariff = { tariffRef: "test-tariff", inputMicrosPerToken: 3, outputMicrosPerToken: 15, allowanceMicros: 1000 };
export const EGRESS_KEY = { keyId: "test-key-1", secret: Buffer.alloc(32, 7) };
export const CSV = ["Email,First Name,Last Name,Phone,Company Name", "ana@example.com,Ana,Lopez,555-0101,Acme", "bo@example.com,Bo,Diaz,555-0102,Beta", ""].join("\n");

export class MemoryDocuments implements CoreDocumentStore {
  readonly documents = new Map<string, unknown>();
  readonly bindings = new Map<string, CorePlanBinding>();
  planBinding(planHash: Sha256Hex): Promise<CorePlanBinding | null> {
    return Promise.resolve(this.bindings.get(planHash) ?? null);
  }
  document(agencyId: AgencyId, kind: CoreDocumentKind, hash: Sha256Hex): Promise<unknown | null> {
    return Promise.resolve(this.documents.get(`${agencyId}|${kind}|${hash}`) ?? null);
  }
  putDocument(agencyId: AgencyId, kind: CoreDocumentKind, hash: Sha256Hex, document: unknown): Promise<void> {
    this.documents.set(`${agencyId}|${kind}|${hash}`, document);
    return Promise.resolve();
  }
  putPlanBinding(_agencyId: AgencyId, planHash: Sha256Hex, binding: CorePlanBinding): Promise<void> {
    this.bindings.set(planHash, binding);
    return Promise.resolve();
  }
}

/** A fenced in-memory journal with the append-time faults the ledger must survive. */
export class MemoryJournal implements ModelTaskJournalPort {
  readonly events = new Map<string, ModelTaskJournalEvent[]>();
  appends = 0;
  /** Called before each append; return "REFUSE" to answer a length mismatch (a newer step moved the journal), or throw. */
  onAppend: (runId: string, event: ModelTaskJournalEvent, index: number) => "REFUSE" | "HANG" | "THROW" | void = () => undefined;
  /** Called when an append hangs (never answers): the test moves its clock and fires the deadline timers here. */
  onHang: () => void = () => undefined;
  append(runId: Id, event: ModelTaskJournalEvent, expectedLength: number): Promise<ModelTaskJournalAppendOutcome> {
    const own = this.events.get(runId) ?? [];
    this.events.set(runId, own);
    this.appends += 1;
    const fault = this.onAppend(runId, event, own.length);
    if (fault === "HANG") {
      queueMicrotask(() => this.onHang());
      return new Promise<ModelTaskJournalAppendOutcome>(() => undefined);
    }
    if (fault === "THROW") return Promise.reject(new Error("KA080 the journal refused the append"));
    if (fault === "REFUSE") return Promise.resolve({ ok: false, conflict: "LENGTH_MISMATCH", actualLength: own.length + 1 });
    if (own.length !== expectedLength) return Promise.resolve({ ok: false, conflict: "LENGTH_MISMATCH", actualLength: own.length });
    own.push(event);
    return Promise.resolve({ ok: true, length: own.length });
  }
  read(runId: Id): Promise<readonly ModelTaskJournalEvent[]> {
    return Promise.resolve([...(this.events.get(runId) ?? [])]);
  }
}

export interface Fixture {
  readonly dir: string;
  readonly profile: HashedSourceProfile;
  readonly documents: MemoryDocuments;
  readonly clock: VirtualClock;
  readonly gateway: ScriptedGateway;
  readonly admission: MemoryDispatchAdmission;
  readonly journal: MemoryJournal;
  readonly validations: FullDatasetValidationResult[];
  readonly adapter: IntelligenceCoreAdapter;
  readonly state: { cancellation: CancellationState; unavailable: boolean };
  /** The deadline timers the adapter armed; `expire` advances the clock past the deadline and fires them. */
  readonly timers: { fire: () => void }[];
  expire(): void;
  dispose(): void;
}

/** The oracle for fields, with the object decision taken by index into the envelope's allowed targets (the contact object is one of them). */
export function oracleWithObject(objectIndex: number, rationaleCode = "HEADER_MATCHES_TARGET_LABEL"): ScriptedGateway {
  return scriptedGateway({
    OBJECT_MAPPING: {
      kind: "proposal",
      build: (envelope, payload) => {
        const base = oracleProposal(envelope, payload.runId);
        const items = envelope.deterministicCandidates.map((c) => ({
          candidateRef: c.candidateRef,
          proposalType: "MAP_OBJECT",
          targetRef: c.allowedTargetRefs[objectIndex] ?? null,
          transformPrimitive: null,
          typedTransformParams: null,
          evidenceRefs: [...c.evidenceRefs],
          requiresAgencyDecision: false,
          rationaleCode,
          shortRationale: null,
          alternatives: [],
          abstainReason: null,
        }));
        return { ...base, items, overallOutcome: "PROPOSED" };
      },
    },
    default: { kind: "proposal", build: (envelope, payload) => oracleProposal(envelope, payload.runId) },
  });
}

export interface FixtureOptions {
  readonly objectIndex?: number;
  readonly objectRationale?: string;
  readonly fundedMicros?: number;
  readonly csv?: string;
  readonly runtimeOverrides?: Partial<IntelligenceRunBindings>;
  readonly deps?: Partial<IntelligenceAdapterDeps>;
}

/** A validation port that runs Migration Core over the fixture's input with the configuration the draft names (D5-15 shape, test-sized). */
export function realValidationPort(dir: string, profile: HashedSourceProfile, clock: VirtualClock, results: FullDatasetValidationResult[]): FullDatasetValidationPort {
  return {
    validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> {
      const translation = toMigrationConfig(configuration, profile);
      if (translation.document === null) throw new Error("the configuration does not translate to a Migration Core document");
      const loaded = loadConfig(JSON.stringify(translation.document), "test validation");
      const scratch = createFilesystemScratchStore({ root: mkdtempSync(join(dir, "scr-")), runId: "validate", quotaBytes: 1 << 28 });
      try {
        const run = runMigration({ inputRoot: dir, config: loaded.config, configHash: loaded.configHash, scratch, sourceProfile: profile });
        const effects = effectsFromMigrationRun({ loaded, run });
        const result: FullDatasetValidationResult = {
          ok: true,
          configurationRef: configuration.configurationRef,
          configurationDigest: digestOf(configuration),
          profileHash: configuration.profileHash,
          candidateSetHash: configuration.candidateSetHash,
          targetContractHash: configuration.targetContractHash,
          rowsValidated: 2,
          rowsInProfile: 2,
          reconciliationHolds: true,
          packageVerified: true,
          problems: [],
          validatedAt: clock.now(),
          coreVersion: "3.1.0",
          evidence: { packageDigest: sha256Hex("test-package"), reportDigest: sha256Hex("test-report"), coreConfigHash: loaded.configHash },
          effects,
        };
        results.push(result);
        return Promise.resolve(result);
      } finally {
        scratch.dispose();
      }
    },
  };
}

export function fixture(options: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "kauro-ica-"));
  writeFileSync(join(dir, "contacts.csv"), options.csv ?? CSV);
  const scratch = createFilesystemScratchStore({ root: mkdtempSync(join(dir, "scr-")), runId: "profile", quotaBytes: 1 << 28 });
  const profile = buildSourceProfile({ inputRoot: dir, config: syntheticConfig([{ path: "contacts.csv", format: "CSV" }]), scratch });
  scratch.dispose();
  const documents = new MemoryDocuments();
  void documents.putDocument(AGENCY, "SOURCE_PROFILE", profile.profileHash as Sha256Hex, profile.profile);
  const clock = new VirtualClock("2026-10-11T12:00:00.000Z");
  const gateway = oracleWithObject(options.objectIndex ?? 0, options.objectRationale);
  const admission = new MemoryDispatchAdmission({ fundedMicros: options.fundedMicros ?? 5_000_000 });
  const journal = new MemoryJournal();
  const validations: FullDatasetValidationResult[] = [];
  const timers: { fire: () => void }[] = [];
  const state = { cancellation: "CONTINUE" as CancellationState, unavailable: false };
  const bindings: IntelligenceRunBindings = { gateway, dispatchAdmission: admission, validationPort: realValidationPort(dir, profile, clock, validations), ...options.runtimeOverrides };
  const adapter = new IntelligenceCoreAdapter({
    documents,
    clock,
    egressKey: EGRESS_KEY,
    tariff: TARIFF,
    supportEnvelopeVersion: "1.0.0",
    runtime: () => bindings,
    pollIntervalMs: 5,
    ticker: () => () => undefined,
    after: (_ms, fire) => {
      const entry = { fire };
      timers.push(entry);
      return () => void timers.splice(timers.indexOf(entry), 1);
    },
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    ...options.deps,
  });
  const expire = (): void => {
    clock.advance(3_600_000);
    for (const t of [...timers]) t.fire();
  };
  journal.onHang = expire;
  return { dir, profile, documents, clock, gateway, admission, journal, validations, adapter, state, timers, expire, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function interpretRequest(f: Fixture, manifest: InterpretRequest["candidateManifest"], overrides: Partial<InterpretRequest> = {}): InterpretRequest {
  return {
    auditAttemptId: ATTEMPT,
    agencyId: AGENCY,
    projectId: PROJECT as InterpretRequest["projectId"],
    revisionId: REVISION_ID,
    candidateManifest: manifest,
    journal: f.journal,
    fundedCeilingCents: 500,
    interpretationDeadlineAt: new Date(f.clock.nowMs() + 600_000).toISOString() as InterpretRequest["interpretationDeadlineAt"],
    cancellation: { check: () => (f.state.unavailable ? Promise.reject(new Error("authority unavailable")) : Promise.resolve(f.state.cancellation)) },
    ...overrides,
  };
}

export function planRequest(f: Fixture) {
  return { agencyId: AGENCY, revisionHash: REVISION_HASH, sourceProfileHash: f.profile.profileHash as Sha256Hex, targetContractHash: null };
}

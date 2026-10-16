/**
 * Test fixtures: small synthetic bundles profiled by the frozen Migration
 * Core, target contracts the test constructs and attests, and a host
 * validation adapter that applies a candidate configuration to the whole
 * fixture with the real engine. The core under test never sees a path.
 */
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_CONTRACT_VERSION,
  CORE_VERSION,
  SCRATCH_BUDGET_BYTES,
  attestationSigningBytes,
  buildCandidateSet,
  createFilesystemScratchStore,
  hashTargetContract,
  loadConfig,
  produceSourceProfile,
  runMigration,
  verifyPackage,
  writePackage,
} from 'kauro-migration-core';
import type { AttestationAuthority, HashedCandidateSet, HashedSourceProfile, HashedTargetContract, TargetAttestation, TargetContract, TargetMode } from 'kauro-migration-core';

import { toMigrationConfig } from '../../src/adapter/migration-config.js';
import { effectsFromMigrationRun } from '../../src/adapter/migration-effects.js';
import { digestOf } from '../../src/contracts/canonical.js';
import { MemoryDispatchAdmission } from '../../src/kernel/admission.js';
import type { ModelTariff } from '../../src/kernel/admission.js';
import { MemoryLedgerStore, SystemClock, VirtualClock } from '../../src/kernel/ledger.js';
import type { Clock } from '../../src/kernel/ledger.js';
import type { CandidateConfiguration, ConfigFragmentField, CoreDependencies, EgressKey, FullDatasetValidationPort, FullDatasetValidationResult, HostContext, IntelligenceInput } from '../../src/ports/ports.js';
import type { ModelGateway } from '../../src/gateway/model-gateway.js';
import { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION } from '../../src/contracts/versions.js';

export interface Bundle {
  readonly root: string;
  readonly files: readonly { id: string; path: string; idHeader: string; object: string }[];
  readonly dispose: () => void;
}

const DEFAULT_CONTACTS = 'Contact ID,First Name,Last Name,Email,Phone,Status\n1,Ada,Lovelace,ada@kauro-fixture.test,+57 300 123 4567,Active\n2,Grace,Hopper,grace@kauro-fixture.test,,Inactive\n3,Alan,Turing,alan@kauro-fixture.test,+1 415 555 0100,Active\n4,Alan,Turing,ALAN@kauro-fixture.test,,Active\n';
const DEFAULT_COMPANIES = 'Company ID,Name,Website\nC1,Analytical Engines,https://analytical.test\nC2,COBOL Works,https://cobol.test\n';

export function makeBundle(name: string, options: { contacts?: string; companies?: string; extraColumns?: number; extraRows?: number } = {}): Bundle {
  const root = resolve(join(tmpdir(), `kauro-ic-${name}-${String(process.pid)}-${String(Date.now())}`));
  mkdirSync(root, { recursive: true });
  let contacts = options.contacts ?? DEFAULT_CONTACTS;
  if (options.extraColumns !== undefined && options.extraColumns > 0) {
    const lines = contacts.trimEnd().split('\n');
    const header = lines[0] as string;
    const extraHeaders = Array.from({ length: options.extraColumns }, (unused, index) => `Mystery ${String(index + 1)}`);
    contacts = `${[header, ...extraHeaders].join(',')}\n${lines
      .slice(1)
      .map((line, row) => [line, ...extraHeaders.map((unused, index) => `x${String(index)}-${String(row)}`)].join(','))
      .join('\n')}\n`;
  }
  if (options.extraRows !== undefined && options.extraRows > 0) {
    const lines = contacts.trimEnd().split('\n');
    const header = lines[0] as string;
    const columns = header.split(',').length;
    const extra = Array.from({ length: options.extraRows }, (unused, index) => [String(100 + index), `Name${String(index)}`, 'Row', `row${String(index)}@kauro-fixture.test`, '', index % 2 === 0 ? 'Active' : 'Inactive', ...Array.from({ length: Math.max(0, columns - 6) }, () => 'v')].slice(0, columns).join(','));
    contacts = `${[...lines, ...extra].join('\n')}\n`;
  }
  writeFileSync(join(root, 'contacts.csv'), contacts);
  writeFileSync(join(root, 'companies.csv'), options.companies ?? DEFAULT_COMPANIES);
  return {
    root,
    files: [
      { id: 'contacts', path: 'contacts.csv', idHeader: 'Contact ID', object: 'CONTACT' },
      { id: 'companies', path: 'companies.csv', idHeader: 'Company ID', object: 'COMPANY' },
    ],
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The read configuration the profile is produced under: files only, no field mappings yet. */
export function profileConfig(bundle: Bundle, mode: TargetMode): string {
  return JSON.stringify({
    configVersion: '3.0.0',
    source: { system: 'fixture', namespace: `fixture-${mode.toLowerCase()}` },
    target: { mode, importMode: 'CREATE_ONLY' },
    files: bundle.files.map((file) => ({ id: file.id, path: file.path, format: 'CSV' })),
    records: bundle.files.map((file) => ({
      id: file.id,
      fileId: file.id,
      object: file.object,
      sourceRecordIdColumn: { header: file.idHeader },
      fields: file.object === 'CONTACT' ? [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }] : [{ column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' }],
    })),
  });
}

export function profileBundle(bundle: Bundle, mode: TargetMode): { profile: HashedSourceProfile; candidateSet: HashedCandidateSet; configHash: string } {
  const text = profileConfig(bundle, mode);
  const loaded = loadConfig(text, join(bundle.root, 'profile-config.json'));
  const scratch = createFilesystemScratchStore({ root: join(bundle.root, 'scratch-profile'), runId: 'profile', quotaBytes: SCRATCH_BUDGET_BYTES });
  try {
    const profile = produceSourceProfile({ inputRoot: bundle.root, config: loaded.config, scratch });
    const candidateSet = buildCandidateSet({ profile, configHash: loaded.configHash });
    return { profile, candidateSet, configHash: loaded.configHash };
  } finally {
    scratch.dispose();
  }
}

/**
 * The bundle profiled as the audit's PROFILE step profiles it (plan,
 * obligation 7): the candidate set is built with the dry-run truth — the
 * profile configuration run over the whole bundle by the real Migration Core
 * — so its duplicate clusters and unmapped material stand in the set as
 * originals beside the key candidates and ambiguous shapes. The dry run's
 * scratch store is disposed before the set is handed over; the set carries
 * row addresses and counts, never a value.
 */
export function profileWithTruth(bundle: Bundle, mode: TargetMode): { profile: HashedSourceProfile; candidateSet: HashedCandidateSet; configHash: string } {
  const profiled = profileBundle(bundle, mode);
  const loaded = loadConfig(profileConfig(bundle, mode), join(bundle.root, 'profile-config.json'));
  const scratch = createFilesystemScratchStore({ root: join(bundle.root, 'scratch-truth'), runId: 'truth', quotaBytes: SCRATCH_BUDGET_BYTES });
  try {
    const run = runMigration({ inputRoot: bundle.root, config: loaded.config, configHash: loaded.configHash, scratch, sourceProfile: profiled.profile });
    return { profile: profiled.profile, candidateSet: buildCandidateSet({ profile: profiled.profile, configHash: loaded.configHash, truth: run.truth }), configHash: loaded.configHash };
  } finally {
    scratch.dispose();
  }
}

const issuer = generateKeyPairSync('ed25519');
export const AUTHORITY: AttestationAuthority = {
  issuerId: 'fixture:issuer',
  keyId: 'k1',
  algorithm: ATTESTATION_ALGORITHM,
  publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

const field = (apiName: string, label: string, type: string, extra: Partial<TargetContract['objects'][number]['fields'][number]> = {}): TargetContract['objects'][number]['fields'][number] => ({
  apiName,
  label,
  type,
  createable: 'TRUE',
  updateable: 'TRUE',
  nillable: 'TRUE',
  length: 255,
  precision: null,
  scale: null,
  unique: 'FALSE',
  externalId: 'FALSE',
  idLookup: 'FALSE',
  calculated: 'FALSE',
  autoNumber: 'FALSE',
  defaultedOnCreate: 'FALSE',
  restrictedPicklist: 'FALSE',
  picklistValues: [],
  referenceTo: [],
  relationshipName: null,
  evidence: 'ARTIFACT',
  ...extra,
});

export function vendorContract(mode: 'HUBSPOT' | 'SALESFORCE', options: { withStatusPicklist?: boolean; readOnlyEmail?: boolean } = {}): HashedTargetContract {
  const hs = mode === 'HUBSPOT';
  return hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode, instanceId: hs ? '00000001' : '00D000000000001', instanceLabel: `fixture ${mode}`, evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects: [
      {
        apiName: hs ? 'contact' : 'Contact',
        label: 'Contact',
        createable: 'TRUE',
        updateable: 'TRUE',
        recordTypes: [],
        fields: [
          field(hs ? 'email' : 'Email', 'Email', hs ? 'string' : 'email', { unique: 'TRUE', idLookup: 'TRUE', ...(options.readOnlyEmail ? { createable: 'FALSE', updateable: 'FALSE' } : {}) }),
          field(hs ? 'firstname' : 'FirstName', 'First Name', 'string'),
          field(hs ? 'lastname' : 'LastName', 'Last Name', 'string'),
          field(hs ? 'phone' : 'Phone', 'Phone', hs ? 'string' : 'phone'),
          ...(options.withStatusPicklist ? [field(hs ? 'lifecyclestage' : 'Title', 'Lifecycle Stage', hs ? 'enumeration' : 'string', hs ? { picklistValues: [{ value: 'lead', label: 'Lead', active: true, defaultValue: false }, { value: 'OPEN', label: 'Open', active: true, defaultValue: false }] } : {})] : []),
          field(hs ? 'internal_score' : 'Internal_Score__c', 'Internal Score', 'number'),
        ],
      },
      {
        apiName: hs ? 'company' : 'Account',
        label: 'Company',
        createable: 'TRUE',
        updateable: 'TRUE',
        recordTypes: [],
        fields: [field(hs ? 'name' : 'Name', 'Name', 'string'), field(hs ? 'website' : 'Website', 'Website', 'string')],
      },
    ],
    pipelines: [],
  });
}

export function attestationFor(contract: HashedTargetContract, overrides: Partial<Omit<TargetAttestation, 'signature'>> = {}): TargetAttestation {
  const body: Omit<TargetAttestation, 'signature'> = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'fixture:issuer', name: 'Fixture Issuer', keyId: 'k1' },
    subject: { mode: contract.contract.instance.mode, instanceId: contract.contract.instance.instanceId, instanceLabel: contract.contract.instance.instanceLabel },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096 }],
    contractHash: contract.contractHash,
    schemaVersion: '1.0.0',
    toolVersion: 'fixture/1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-12-01T00:00:00Z',
    nonce: null,
    ...overrides,
  };
  const candidate: TargetAttestation = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(candidate), 'utf8'), issuer.privateKey).toString('base64');
  return { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } };
}

export interface FixtureValidationPort extends FullDatasetValidationPort {
  calls: number;
  lastPackage: { stagingDir: string; artifacts: readonly { path: string }[] } | null;
  /** The document the port last handed Migration Core, as its loader normalized it, with the loader's hash. */
  lastLoaded: { readonly normalizedJson: unknown; readonly configHash: string } | null;
  /**
   * The clock the receipts are dated by. A host shares one clock discipline
   * with the core it calls, so the port made without one is bound to the
   * run's clock by `depsFor`; a port used on its own dates by the system.
   */
  clock: Clock | null;
}

/**
 * The host's validation adapter: the candidate configuration becomes the
 * Migration Core document the product's `toMigrationConfig` makes of it —
 * exactly that document, which the core has hashed too — the frozen engine
 * runs it over the whole fixture bundle, the package is written and
 * verified, and the result is typed and bound to the hashes it validated
 * against, the exact configuration bytes it received, the loader's hash of
 * the document, the digests of what the engine produced, and the effects
 * `effectsFromMigrationRun` reads off the run. The core never sees the
 * bundle.
 */
export function realValidationPort(bundle: Bundle, profile: HashedSourceProfile, contract: HashedTargetContract | null, options: { readonly clock?: Clock } = {}): FixtureValidationPort {
  const port: FixtureValidationPort = {
    calls: 0,
    lastPackage: null,
    lastLoaded: null,
    clock: options.clock ?? null,
    async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> {
      port.calls += 1;
      const clock = port.clock ?? new SystemClock();
      const bound = { configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration), profileHash: profile.profileHash, candidateSetHash: configuration.candidateSetHash, targetContractHash: contract?.contractHash ?? null, rowsInProfile: profile.profile.totals.dataRowCount, validatedAt: clock.now(), coreVersion: CORE_VERSION };
      const translation = toMigrationConfig(configuration, profile);
      if (translation.document === null) {
        // Nothing ran: a configuration the engine cannot take as authorised is refused whole.
        return { ...bound, ok: false, rowsValidated: 0, reconciliationHolds: false, packageVerified: false, problems: translation.problems, evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null };
      }
      const loaded = loadConfig(JSON.stringify(translation.document), join(bundle.root, 'candidate-config.json'));
      port.lastLoaded = { normalizedJson: loaded.normalizedJson, configHash: loaded.configHash };
      const runStore = createFilesystemScratchStore({ root: join(bundle.root, `scratch-run-${String(port.calls)}`), runId: `run${String(port.calls)}`, quotaBytes: SCRATCH_BUDGET_BYTES });
      const verifyStore = createFilesystemScratchStore({ root: join(bundle.root, `scratch-verify-${String(port.calls)}`), runId: `verify${String(port.calls)}`, quotaBytes: SCRATCH_BUDGET_BYTES });
      try {
        const result = runMigration({
          inputRoot: bundle.root,
          config: loaded.config,
          configHash: loaded.configHash,
          scratch: runStore,
          sourceProfile: profile,
          ...(contract === null ? {} : { targetContract: contract, targetAttestation: attestationFor(contract), attestationAuthorities: [AUTHORITY], attestationInstant: '2026-09-15T00:00:00Z' }),
        });
        // Read off the run while its scratch store still holds the families.
        const effects = effectsFromMigrationRun({ loaded, run: result });
        const written = writePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: join(bundle.root, `package-${String(port.calls)}`), force: true });
        const report = verifyPackage(written.stagingDir, { scratch: verifyStore });
        port.lastPackage = { stagingDir: written.stagingDir, artifacts: written.artifacts };
        const holds = result.reconciliation.sourceRows.equationHolds;
        const problems = [...(holds ? [] : ['RECONCILIATION_EQUATION_FAILED']), ...(report.passed ? [] : report.problems.map((problem) => problem.check))];
        return {
          ...bound,
          ok: problems.length === 0,
          rowsValidated: result.reconciliation.sourceRows.total,
          reconciliationHolds: holds,
          packageVerified: report.passed,
          problems,
          evidence: { packageDigest: written.manifestSha256, reportDigest: digestOf({ passed: report.passed, checks: report.checks, problems: report.problems, artifactCount: report.artifactCount, sourceRows: report.sourceRows }), coreConfigHash: loaded.configHash },
          effects,
        };
      } finally {
        runStore.dispose();
        verifyStore.dispose();
      }
    },
  };
  return port;
}

export const CONTEXT: HostContext = { tenant: { agencyId: 'agency-a', clientId: 'client-1' }, actor: 'test', auditAttemptId: 'attempt-0001' };

export function inputFor(mode: TargetMode, profiled: { profile: HashedSourceProfile; candidateSet: HashedCandidateSet }, contract: HashedTargetContract | null, extra: Partial<IntelligenceInput> = {}): IntelligenceInput {
  return {
    projectRevision: { projectRevisionId: 'rev-1', projectRevisionHash: digestOf(['rev-1', profiled.profile.profileHash]), mode, supportEnvelopeVersion: '2.0.1' },
    sourceProfile: profiled.profile,
    candidateSet: profiled.candidateSet,
    targetContract: contract,
    scopedMemorySnapshot: [],
    policyBundle: { modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION },
    resourceProfile: {},
    ...extra,
  };
}

/** The core's lease-renewal timer, fired by hand: `tick()` runs every tick the core has registered and not yet stopped; `advance(ms)` moves the virtual clock in renewal-sized steps, ticking after each, as a live worker's timer would while it waits. */
export interface ManualTicker {
  readonly ticker: NonNullable<CoreDependencies['ticker']>;
  tick(): void;
  advance(ms: number): void;
  /** How many ticks the core registered (one per long await it kept the lease through). */
  readonly registered: number;
}

export function manualTicker(clock: VirtualClock): ManualTicker {
  const ticks = new Map<number, { intervalMs: number; onTick: () => void }>();
  let next = 0;
  let registered = 0;
  return {
    ticker(intervalMs, onTick) {
      const id = next;
      next += 1;
      registered += 1;
      ticks.set(id, { intervalMs, onTick });
      return () => {
        ticks.delete(id);
      };
    },
    tick() {
      for (const entry of [...ticks.values()]) entry.onTick();
    },
    advance(ms) {
      const step = [...ticks.values()][0]?.intervalMs ?? ms;
      let moved = 0;
      while (moved < ms) {
        const slice = Math.min(step, ms - moved);
        clock.advance(slice);
        moved += slice;
        this.tick();
      }
    },
    get registered() {
      return registered;
    },
  };
}

/**
 * The fixtures' labelled test tariff (evidence class SIMULATED; no provider's
 * price is asserted — plan, open question 3). Its allowance covers the
 * per-request input ceiling, so a reported usage inside the token ceilings
 * never exceeds its reservation here: the token tests stay token tests, and
 * a test about money hands a tariff of its own.
 */
export const TEST_TARIFF: ModelTariff = Object.freeze({ tariffRef: 'TEST_TARIFF_SIMULATED_NOT_A_PRICE', inputMicrosPerToken: 1, outputMicrosPerToken: 5, allowanceMicros: 200_000 });

/** The fixtures' attempt egress key: one id, one secret, the same for every core a test builds over one attempt. */
export const TEST_EGRESS_KEY: EgressKey = Object.freeze({ keyId: 'egress-key-fixture', secret: Buffer.alloc(32, 7) });

/** A funded grant large enough that no fixture run is refused for money unless its test says so. */
export const TEST_GRANT_MICROS = 1_000_000_000_000;

export function depsFor(gateway: ModelGateway, validationPort: FullDatasetValidationPort, clock = new VirtualClock()): CoreDependencies & { store: MemoryLedgerStore; clock: VirtualClock; timer: ManualTicker; dispatchAdmission: MemoryDispatchAdmission } {
  const store = new MemoryLedgerStore();
  // Retries wait on the virtual clock, never on the wall.
  const sleep = async (ms: number): Promise<void> => {
    clock.advance(ms);
  };
  // The lease-renewal timer fires only when a test fires it: a test that moves the clock past the lease without ticking models a worker whose timer never ran.
  const timer = manualTicker(clock);
  // The host's adapter dates its receipts by the clock the run is given: one clock discipline across the boundary.
  if ('clock' in validationPort && validationPort.clock === null) (validationPort as FixtureValidationPort).clock = clock;
  return { gateway, validationPort, ledgerStore: store, clock, store, egressKey: TEST_EGRESS_KEY, tariff: TEST_TARIFF, dispatchAdmission: new MemoryDispatchAdmission({ fundedMicros: TEST_GRANT_MICROS }), sleep, ticker: timer.ticker, timer };
}

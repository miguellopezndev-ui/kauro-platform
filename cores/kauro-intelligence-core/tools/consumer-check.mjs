#!/usr/bin/env node
/**
 * The packed Intelligence Core, consumed by a TypeScript strict project
 * outside this tree, offline, with no credential: the host API and its
 * types resolve, a run completes against the frozen Migration Core in a
 * host adapter, and no network is needed or attempted.
 *
 * The temporary project holds the packed kauro-intelligence-core tarball and
 * the vendored Migration Core tarball, installed from bytes; `tsc` runs from
 * this repository's node_modules against the project, so resolution starts
 * at the project and nothing points back here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'MANIFEST.json'), 'utf8'));
const work = join(tmpdir(), `kauro-ic-consumer-${String(process.pid)}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const shell = process.platform === 'win32';
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: shell && command === 'npm', ...options });

const CONSUMER = String.raw`
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_CONTRACT_VERSION,
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
} from '${manifest.name}';
import type { AttestationAuthority, HashedSourceProfile, HashedTargetContract, TargetAttestation, TargetContract } from '${manifest.name}';
import {
  BUDGET_LIMITS,
  INTELLIGENCE_CORE_VERSION,
  MODEL_POLICY_VERSION,
  PROMPT_BUNDLE_VERSION,
  MemoryDispatchAdmission,
  MemoryLedgerStore,
  VirtualClock,
  adaptContracts,
  candidateAccountingProblems,
  compatibilityMatrix,
  createIntelligenceCore,
  digestOf,
  effectsFromMigrationRun,
  oracleGateway,
  oracleProposal,
  planCandidates,
  scriptedGateway,
  toMigrationConfig,
} from 'kauro-intelligence-core';
import type { CandidateConfiguration, DeterministicCandidate, FullDatasetValidationPort, FullDatasetValidationResult, IntelligenceEnvelopeV1, IntelligenceInput, IntelligenceResult, ProposalItem } from 'kauro-intelligence-core';

// A directory this program owns: made by it, marked by it, removed by it on every exit.
const work = resolve(mkdtempSync(join(tmpdir(), 'kauro-ic-consumer-run-')));
writeFileSync(join(work, 'OWNER'), JSON.stringify({ owner: 'kauro-intelligence-core consumer check', pid: process.pid }));

// The vendor-mode run: the twelve capability families through the packed core in a SALESFORCE run, the real Migration Core in the host's port under an attested contract (D3-CFG-1..3). The model is the labelled scripted gateway, each item written as a model would answer it from the request; no provider is called.
interface VendorObserved {
  state: string;
  draft: string;
  families: string[];
  expected: number;
  accounted: number;
  accountingProblems: string[];
  complete: boolean;
  unplanned: number;
  covered: boolean;
  fragments: number;
  edges: number;
  missingEndpoints: number;
  reviewGroups: number;
  satisfied: string[];
  externalIds: number;
  packageVerified: boolean;
  calls: number;
}

async function vendorScenario(): Promise<VendorObserved> {
  const dir = join(work, 'vendor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'contacts.csv'), [
    'Contact ID,Customer Number,First Name,Email,Legal Last Name,Family Name,Company Ref,Home City,Country,Status',
    '1,CN-1001,Ada,ada@consumer.test,Lovelace,Lovelace,C1,Madrid,ES,Nuevo',
    '2,CN-1002,Grace,grace@consumer.test,Hopper,Hopper,C2,Lisbon,PT,Abierto',
    '3,CN-1003,Alan,edsger@consumer.test,Turing,Turing,C1,Boston,US,Ganado',
    '4,CN-1004,Alonzo,edsger@consumer.test,Church,Church,C9,Seville,ES,lead',
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'companies.csv'), [
    'Company ID,Name,Website,Employee Count,Annual Revenue,Region',
    'C1,Analytical Engines,https://analytical.test,12,"1234,56",North',
    'C2,COBOL Works,https://cobol.test,unknown,"99,5",South',
    'C3,Difference Works,https://difference.test,1,"1000,75",East',
    'C4,Logic Mills,https://logic.test,40,"15,25",West',
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'branches.csv'), [
    'Outlet Title,Domain,Web,Territory',
    'Harbour Outlet,harbour.test,https://harbour.test,Port',
    'Station Outlet,station.test,https://station.test,Rail',
    'Market Outlet,market.test,https://market.test,Town',
  ].join('\n') + '\n');

  const field = (apiName: string, label: string, type: string, extra: Partial<TargetContract['objects'][number]['fields'][number]> = {}): TargetContract['objects'][number]['fields'][number] => ({ apiName, label, type, createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE', idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE', restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT', ...extra });
  const options = (values: string[]) => values.map((value) => ({ value, label: value, active: true, defaultValue: false }));
  const contract: HashedTargetContract = hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode: 'SALESFORCE', instanceId: '00D000000000017', instanceLabel: 'consumer vendor run', evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects: [
      { apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [
        field('Email', 'Email', 'email', { unique: 'TRUE', idLookup: 'TRUE' }),
        field('FirstName', 'First Name', 'string'),
        field('LastName', 'Last Name', 'string', { nillable: 'FALSE' }),
        field('MailingCity', 'Mailing City', 'string'),
        field('Title', 'Status', 'picklist', { picklistValues: options(['lead', 'opportunity', 'customer']) }),
        field('Customer_Number__c', 'Customer Number', 'string', { unique: 'TRUE', externalId: 'TRUE', idLookup: 'TRUE' }),
        field('MailingCountry', 'Country', 'picklist', { picklistValues: options(['emea', 'na', 'apac']) }),
      ] },
      { apiName: 'Account', label: 'Company', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [
        field('Name', 'Name', 'string'),
        field('Website', 'Website', 'url'),
        field('NumberOfEmployees', 'Employee Count', 'int'),
        field('AnnualRevenue', 'Annual Revenue', 'currency'),
      ] },
    ],
    pipelines: [],
  });
  const issuer = generateKeyPairSync('ed25519');
  const authority: AttestationAuthority = { issuerId: 'consumer:issuer', keyId: 'k1', algorithm: ATTESTATION_ALGORITHM, publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const attestationBody: Omit<TargetAttestation, 'signature'> = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'consumer:issuer', name: 'Consumer Issuer', keyId: 'k1' },
    subject: { mode: contract.contract.instance.mode, instanceId: contract.contract.instance.instanceId, instanceLabel: contract.contract.instance.instanceLabel },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096 }],
    contractHash: contract.contractHash,
    schemaVersion: '1.0.0',
    toolVersion: 'consumer/1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-12-01T00:00:00Z',
    nonce: null,
  };
  const unsigned: TargetAttestation = { ...attestationBody, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const attestation: TargetAttestation = { ...attestationBody, signature: { algorithm: ATTESTATION_ALGORITHM, value: signBytes(null, Buffer.from(attestationSigningBytes(unsigned), 'utf8'), issuer.privateKey).toString('base64') } };
  const attested = { targetContract: contract, targetAttestation: attestation, attestationAuthorities: [authority], attestationInstant: '2026-09-15T00:00:00Z' };

  // PROFILE: the read configuration maps each file's name column; Migration Core runs it over the bundle and the candidate set is built with that dry-run truth.
  const nameColumn: Record<string, string> = { contacts: 'Email', companies: 'Name', branches: 'Outlet Title' };
  const objectOf: Record<string, string> = { contacts: 'CONTACT', companies: 'COMPANY', branches: 'COMPANY' };
  const idOf: Record<string, string> = { contacts: 'Contact ID', companies: 'Company ID', branches: 'Outlet Title' };
  const ids = ['contacts', 'companies', 'branches'];
  const profileText = JSON.stringify({
    configVersion: '3.0.0',
    source: { system: 'consumer', namespace: 'consumer-vendor' },
    target: { mode: 'SALESFORCE', importMode: 'CREATE_ONLY' },
    files: ids.map((id) => ({ id, path: id + '.csv', format: 'CSV' })),
    // Migration Core 3.0.0 refuses a CREATE_ONLY record mapping that leaves a field the attested contract requires unmapped, so the profile reading maps the required Last Name too.
    records: ids.map((id) => ({ id, fileId: id, object: objectOf[id], sourceRecordIdColumn: { header: idOf[id] }, fields: objectOf[id] === 'CONTACT' ? [{ column: { header: nameColumn[id] }, destinationField: 'contact.email', semanticType: 'EMAIL' }, { column: { header: 'Legal Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' }] : [{ column: { header: nameColumn[id] }, destinationField: 'company.name', semanticType: 'TEXT' }] })),
  });
  const profileLoaded = loadConfig(profileText, join(dir, 'profile-config.json'));
  const profileStore = createFilesystemScratchStore({ root: join(dir, 'scratch-profile'), runId: 'vprofile', quotaBytes: SCRATCH_BUDGET_BYTES });
  const truthStore = createFilesystemScratchStore({ root: join(dir, 'scratch-truth'), runId: 'vtruth', quotaBytes: SCRATCH_BUDGET_BYTES });
  const profile: HashedSourceProfile = produceSourceProfile({ inputRoot: dir, config: profileLoaded.config, scratch: profileStore });
  const truth = runMigration({ inputRoot: dir, config: profileLoaded.config, configHash: profileLoaded.configHash, scratch: truthStore, sourceProfile: profile, ...attested });
  const candidateSet = buildCandidateSet({ profile, configHash: profileLoaded.configHash, truth: truth.truth });
  profileStore.dispose();
  truthStore.dispose();

  const clock = new VirtualClock();
  const port: FullDatasetValidationPort = {
    async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> {
      const bound = { configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration), profileHash: profile.profileHash, candidateSetHash: configuration.candidateSetHash, targetContractHash: contract.contractHash, rowsInProfile: profile.profile.totals.dataRowCount, validatedAt: clock.now(), coreVersion: '3.0.0' };
      const translation = toMigrationConfig(configuration, profile);
      if (translation.document === null) return { ...bound, ok: false, rowsValidated: 0, reconciliationHolds: false, packageVerified: false, problems: [...translation.problems], evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null };
      const candidate = loadConfig(JSON.stringify(translation.document), join(dir, 'candidate.json'));
      const runStore = createFilesystemScratchStore({ root: join(dir, 'scratch-run'), runId: 'vrun', quotaBytes: SCRATCH_BUDGET_BYTES });
      const verifyStore = createFilesystemScratchStore({ root: join(dir, 'scratch-verify'), runId: 'vverify', quotaBytes: SCRATCH_BUDGET_BYTES });
      try {
        const result = runMigration({ inputRoot: dir, config: candidate.config, configHash: candidate.configHash, scratch: runStore, sourceProfile: profile, ...attested });
        const effects = effectsFromMigrationRun({ loaded: candidate, run: result });
        const written = writePackage({ result, config: candidate.config, normalizedConfig: candidate.normalizedJson, outputDir: join(dir, 'package'), force: true });
        const report = verifyPackage(written.stagingDir, { scratch: verifyStore });
        const holds = result.reconciliation.sourceRows.equationHolds;
        const found = [...(holds ? [] : ['RECONCILIATION_EQUATION_FAILED']), ...(report.passed ? [] : report.problems.map((problem) => problem.check))];
        return { ...bound, ok: found.length === 0, rowsValidated: result.reconciliation.sourceRows.total, reconciliationHolds: holds, packageVerified: report.passed, problems: found, evidence: { packageDigest: written.manifestSha256, reportDigest: digestOf({ passed: report.passed, checks: report.checks, problems: report.problems, artifactCount: report.artifactCount, sourceRows: report.sourceRows }), coreConfigHash: candidate.configHash }, effects };
      } finally {
        runStore.dispose();
        verifyStore.dispose();
      }
    },
  };

  const contracts = adaptContracts({ mode: 'SALESFORCE', profile, candidateSet, targetContract: contract });
  const headerOf = (ref: string | undefined): string => (ref === undefined ? '' : (contracts.refs.fieldByRef.get(ref)?.header ?? ''));
  const targetOf = (apiName: string): string => [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === apiName)?.[0] ?? '';
  const companyRef = 'obj_' + digestOf('SALESFORCE:COMPANY').slice(0, 16);
  const seen = new Set<string>();
  const familyOfTask = new Map<string, string>();
  const valueMap: Record<string, string> = { Nuevo: 'lead', Abierto: 'opportunity', Ganado: 'customer', ES: 'emea', PT: 'emea', US: 'na' };
  const answer = (family: string, repair: boolean, candidate: DeterministicCandidate, envelope: IntelligenceEnvelopeV1): Partial<ProposalItem> | 'UNKNOWN_REF' | null => {
    const header = headerOf(candidate.sourceRefs[0]);
    switch (family) {
      case 'OBJECT_MAPPING':
        return { proposalType: 'MAP_OBJECT', targetRef: companyRef, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
      case 'FIELD_MAPPING':
        if (header === 'Home City') return repair ? { proposalType: 'MAP_FIELD', targetRef: targetOf('MailingCity'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null } : 'UNKNOWN_REF';
        if (header === 'Family Name') return { proposalType: 'MAP_FIELD', targetRef: targetOf('LastName'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'MEMORY_CONVENTION_APPLIES', abstainReason: null };
        if (header === 'Web') return { proposalType: 'MAP_FIELD', targetRef: targetOf('Website'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
        return { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null };
      case 'SEMANTIC_TYPE':
        return { proposalType: 'SELECT_SEMANTIC_TYPE', typedTransformParams: { semanticType: 'NUMBER' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
      case 'TRANSFORMATION_SELECTION':
        return candidate.allowedPrimitiveRefs.includes('NORMALISE_NUMBER') ? { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'NORMALISE_NUMBER', typedTransformParams: { decimalSeparator: ',' }, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null } : null;
      case 'VALUE_MAP': {
        const exemplar = envelope.exemplars.find((entry) => entry.dataLevel === 'L1' && candidate.evidenceRefs.includes(entry.exemplarRef));
        const to = exemplar === undefined ? undefined : valueMap[exemplar.minimizedValueOrClass];
        return to === undefined ? null : { proposalType: 'MAP_ENUM_VALUE', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { to }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', abstainReason: null };
      }
      case 'UNMAPPED_HANDLING':
        return { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'NO_TARGET_IN_ENVELOPE', abstainReason: 'NO_VALID_TARGET' };
      case 'IDENTITY_STRATEGY':
        return header === 'Customer Number' ? { proposalType: 'PROPOSE_IDENTITY_STRATEGY', rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER', abstainReason: null } : null;
      case 'DUPLICATE_SIGNAL_STRATEGY':
        return { proposalType: 'PROPOSE_DUPLICATE_SIGNAL', rationaleCode: 'IDENTITY_NEEDS_PROOF', abstainReason: null };
      case 'ASSOCIATION_MAPPING':
        return candidate.allowedTargetRefs.length === 1 ? { proposalType: 'MAP_ASSOCIATION', targetRef: candidate.allowedTargetRefs[0] ?? null, rationaleCode: 'FOREIGN_KEY_COLUMN', abstainReason: null } : null;
      case 'TARGET_REQUIREMENT':
        return header === 'Legal Last Name' ? { proposalType: 'MAP_FIELD', targetRef: targetOf('LastName'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null } : null;
      case 'CONSISTENCY_REVIEW': {
        const claims = ((envelope as unknown as { reviewClaims?: { candidateRef: string; decisionRef: string; evidenceClass: string }[] }).reviewClaims ?? []).filter((claim) => claim.candidateRef === candidate.candidateRef);
        const rank: Record<string, number> = { INSUFFICIENT: 0, AMBIGUOUS: 1, SUPPORTED: 2, STRONG: 3 };
        const weaker = [...claims].sort((a, b) => (rank[a.evidenceClass] ?? 0) - (rank[b.evidenceClass] ?? 0))[0];
        return weaker === undefined ? null : { proposalType: 'UNMAPPED_PRESERVE', targetRef: weaker.decisionRef, rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null };
      }
      default:
        return null;
    }
  };
  const gateway = scriptedGateway({
    default: {
      kind: 'proposal',
      build: (envelope, payload) => {
        if (envelope.repairContext === null) familyOfTask.set(envelope.taskId, envelope.taskType);
        seen.add(envelope.taskType);
        const family = familyOfTask.get(envelope.taskId) ?? envelope.taskType;
        const oracle = oracleProposal(envelope, payload.runId);
        const items = envelope.deterministicCandidates.map((candidate): ProposalItem => {
          const base: ProposalItem = { candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: candidate.evidenceRefs.slice(0, 32), requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, alternatives: [], abstainReason: 'INSUFFICIENT_EVIDENCE' };
          const written = answer(family, envelope.repairContext !== null, candidate, envelope);
          return written === 'UNKNOWN_REF' ? { ...base, candidateRef: 'unknown-candidate' } : { ...base, ...(written ?? {}) };
        });
        return { ...oracle, items, overallOutcome: 'MIXED' };
      },
    },
  });
  const core = createIntelligenceCore({ gateway, validationPort: port, ledgerStore: new MemoryLedgerStore(), clock, egressKey: { keyId: 'consumer-vendor-key', secret: Buffer.alloc(32, 13) }, tariff: { tariffRef: 'TEST_TARIFF_SIMULATED_NOT_A_PRICE', inputMicrosPerToken: 1, outputMicrosPerToken: 5, allowanceMicros: 200_000 }, dispatchAdmission: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000_000 }) });
  const revision = { projectRevisionId: 'rev-vendor', projectRevisionHash: 'b'.repeat(64), mode: 'SALESFORCE' as const, supportEnvelopeVersion: '2.0.1' };
  const input: IntelligenceInput = {
    projectRevision: { ...revision, declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } },
    sourceProfile: profile,
    candidateSet,
    targetContract: contract,
    scopedMemorySnapshot: [{ memoryId: 'mem_5a5b5c5d5e5f6061', scope: 'CLIENT', tenant: { agencyId: 'a', clientId: 'c' }, knowledgeType: 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: 'Family Name', targetRef: targetOf('LastName'), semanticType: null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'consumer', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 }],
    policyBundle: { modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION },
    resourceProfile: {},
    // The categorical values of both enumerated columns, as the B03 closure scenario gives them: Migration Core 3.0.0 isolates a row whose picklist value the instance does not know, so the Status values are mapped too.
    categoricalSummaries: new Map(([['Status', ['Nuevo', 'Abierto', 'Ganado', 'lead']], ['Country', ['ES', 'PT', 'US']]] as const).map(([header, values]) => [contracts.refs.fieldByRef.get([...contracts.refs.fieldByRef.entries()].find(([, info]) => info.header === header)?.[0] ?? '')?.locator ?? '', values])),
  };
  const result = await core.run(input, { tenant: { agencyId: 'a', clientId: 'c' }, actor: 'consumer-check', auditAttemptId: 'consumer-vendor-1' });
  const expected = planCandidates(input);
  const accounting = result.candidateAccounting;
  const dispositions = accounting?.dispositions ?? [];
  return {
    state: result.state,
    draft: result.draft.status,
    families: [...seen].sort(),
    expected: expected.candidates.length,
    accounted: dispositions.length,
    accountingProblems: [...candidateAccountingProblems(expected, dispositions)],
    complete: accounting?.coverage.complete ?? false,
    unplanned: dispositions.filter((entry) => entry.code === 'FAMILY_NOT_PLANNED' || entry.code === 'QUESTION_NOT_PLANNED').length,
    covered: result.draft.fragmentCoverage?.complete ?? false,
    fragments: result.draft.fragmentCoverage?.entries.length ?? 0,
    edges: result.draft.associations.reduce((sum, association) => sum + association.edgesDelivered, 0),
    missingEndpoints: result.draft.associations.reduce((sum, association) => sum + association.missingEndpoints, 0),
    reviewGroups: result.draft.reviewGroups.filter((group) => group.observed).length,
    satisfied: result.draft.requirements.filter((entry) => entry.status === 'SATISFIED').map((entry) => entry.destinationField),
    externalIds: (result.draft.identity?.records ?? []).reduce((sum, record) => sum + record.authoritativeExternalIdColumns.length, 0),
    packageVerified: result.draft.fullValidation?.packageVerified === true,
    calls: result.resourceEvidence.modelCalls,
  };
}
try {
  writeFileSync(join(work, 'contacts.csv'), 'Contact ID,First Name,Last Name,Email,Phone,Status\n1,Ada,Lovelace,ada@consumer.test,300 123 4567,Active\n2,Grace,Hopper,grace@consumer.test,+1 415 555 0100,Inactive\n');
  const configText = JSON.stringify({ configVersion: '3.0.0', source: { system: 'consumer', namespace: 'consumer' }, target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' }, files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }], records: [{ id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: { header: 'Contact ID' }, fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }] }] });
  const loaded = loadConfig(configText, join(work, 'config.json'));
  const scratch = createFilesystemScratchStore({ root: join(work, 'scratch'), runId: 'profile', quotaBytes: SCRATCH_BUDGET_BYTES });
  const profile: HashedSourceProfile = produceSourceProfile({ inputRoot: work, config: loaded.config, scratch });
  scratch.dispose();
  const candidateSet = buildCandidateSet({ profile, configHash: loaded.configHash });

  // One clock for the run and for the receipts it validates: a receipt dated after the run's now is refused.
  const clock = new VirtualClock();

  // The host's validation port: exactly the document the core's own toMigrationConfig makes of the configuration, run by the frozen engine over the whole fixture, and the effects read off that run.
  const port: FullDatasetValidationPort = {
    async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> {
      const bound = { configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration), profileHash: profile.profileHash, candidateSetHash: configuration.candidateSetHash, targetContractHash: null, rowsInProfile: profile.profile.totals.dataRowCount, validatedAt: clock.now(), coreVersion: '3.0.0' };
      const translation = toMigrationConfig(configuration, profile);
      // A configuration with a fragment the frozen schema cannot express is refused whole: nothing runs.
      if (translation.document === null) return { ...bound, ok: false, rowsValidated: 0, reconciliationHolds: false, packageVerified: false, problems: [...translation.problems], evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null };
      const candidate = loadConfig(JSON.stringify(translation.document), join(work, 'candidate.json'));
      const runStore = createFilesystemScratchStore({ root: join(work, 'scratch-run'), runId: 'run', quotaBytes: SCRATCH_BUDGET_BYTES });
      const verifyStore = createFilesystemScratchStore({ root: join(work, 'scratch-verify'), runId: 'verify', quotaBytes: SCRATCH_BUDGET_BYTES });
      try {
        const result = runMigration({ inputRoot: work, config: candidate.config, configHash: candidate.configHash, scratch: runStore, sourceProfile: profile });
        const effects = effectsFromMigrationRun({ loaded: candidate, run: result });
        const written = writePackage({ result, config: candidate.config, normalizedConfig: candidate.normalizedJson, outputDir: join(work, 'package'), force: true });
        const report = verifyPackage(written.stagingDir, { scratch: verifyStore });
        const holds = result.reconciliation.sourceRows.equationHolds;
        const found = [...(holds ? [] : ['RECONCILIATION_EQUATION_FAILED']), ...(report.passed ? [] : report.problems.map((problem) => problem.check))];
        return { ...bound, ok: found.length === 0, rowsValidated: result.reconciliation.sourceRows.total, reconciliationHolds: holds, packageVerified: report.passed, problems: found, evidence: { packageDigest: written.manifestSha256, reportDigest: digestOf({ passed: report.passed, checks: report.checks, problems: report.problems, artifactCount: report.artifactCount, sourceRows: report.sourceRows }), coreConfigHash: candidate.configHash }, effects };
      } finally {
        runStore.dispose();
        verifyStore.dispose();
      }
    },
  };
  // What a host hands for spending: the attempt's egress key from its secret store, its model profile's tariff (here a labelled test tariff, no price) and its funded grant (here the labelled in-memory admission).
  const core = createIntelligenceCore({ gateway: oracleGateway(), validationPort: port, ledgerStore: new MemoryLedgerStore(), clock, egressKey: { keyId: 'consumer-attempt-1-key', secret: Buffer.alloc(32, 11) }, tariff: { tariffRef: 'TEST_TARIFF_SIMULATED_NOT_A_PRICE', inputMicrosPerToken: 1, outputMicrosPerToken: 5, allowanceMicros: 200_000 }, dispatchAdmission: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000_000 }) });
  const input: IntelligenceInput = {
    projectRevision: { projectRevisionId: 'rev-1', projectRevisionHash: 'a'.repeat(64), mode: 'CLEAN_ONLY', supportEnvelopeVersion: '2.0.1', declaredObjects: { 'contacts.csv': 'CONTACT' } },
    sourceProfile: profile,
    candidateSet,
    targetContract: null,
    scopedMemorySnapshot: [],
    policyBundle: { modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION },
    resourceProfile: {},
  };
  const result: IntelligenceResult = await core.run(input, { tenant: { agencyId: 'a', clientId: 'c' }, actor: 'consumer-check', auditAttemptId: 'consumer-attempt-1' });
  const matrix = compatibilityMatrix();
  // The vendor-mode run over the twelve families, from the same packed tarball.
  const vendor = await vendorScenario();
  process.stdout.write(JSON.stringify({ version: INTELLIGENCE_CORE_VERSION, state: result.state, draft: result.draft.status, fields: result.draft.configuration?.fields.length ?? 0, rows: result.draft.fullValidation?.rowsValidated ?? 0, evidenceClass: result.provenance.gatewayEvidenceClass, fragments: result.draft.fragmentCoverage?.entries.length ?? 0, covered: result.draft.fragmentCoverage?.complete ?? false, calls: result.resourceEvidence.modelCalls, invocations: result.resourceEvidence.providerInvocations, packageDigest: result.draft.fullValidation?.evidence.packageDigest ?? null, maxTasks: BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT, mcCore: matrix.vendoredMigrationCore.coreVersion, matrix: { core: matrix.intelligenceCoreVersion, envelope: matrix.envelopeSchemaVersion, proposal: matrix.proposalSchemaVersion, promptBundle: matrix.promptBundleVersion, compiler: matrix.compilerContractVersion, runLedger: matrix.runLedgerVersion, configuration: matrix.candidateConfigurationVersion, receipt: matrix.validationReceiptVersion }, vendor, runDir: work }));
} finally {
  // By exact path, success or failure: nothing of this program outlives it.
  rmSync(work, { recursive: true, force: true });
}
`;

const report = { artifactKind: 'INTELLIGENCE_CORE_CONSUMER_CHECK', steps: [], ok: false, observed: null, problems: [] };
try {
  const packed = run('npm', ['pack', '--silent', '--pack-destination', work], { cwd: root });
  if (packed.status !== 0) throw new Error(`npm pack exited ${String(packed.status)}: ${packed.stderr}`);
  const tarball = readdirSync(work).find((name) => name.startsWith('kauro-intelligence-core-') && name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('npm pack produced no tarball');
  const project = join(work, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'kauro-ic-consumer', private: true, type: 'module' }));
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', types: ['node'], noEmitOnError: true, outDir: 'out', exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false }, files: ['consumer.ts'] }));
  writeFileSync(join(project, 'consumer.ts'), CONSUMER);
  // Both tarballs from bytes: the Intelligence Core just packed and the vendored Migration Core release.
  const installed = run('npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', join(work, tarball), join(root, manifest.file)], { cwd: project });
  report.steps.push({ id: 'install', exit: installed.status });
  if (installed.status !== 0) throw new Error(`npm install exited ${String(installed.status)}: ${installed.stderr.slice(-400)}`);
  if (!existsSync(join(project, 'node_modules', 'kauro-intelligence-core', 'dist', 'src', 'index.d.ts'))) throw new Error('the packed core carries no dist/src/index.d.ts');
  const copyDir = (from, to) => run(process.platform === 'win32' ? 'robocopy' : 'cp', process.platform === 'win32' ? [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'] : ['-r', from, to]);
  mkdirSync(join(project, 'node_modules', '@types'), { recursive: true });
  copyDir(join(root, 'node_modules', '@types', 'node'), join(project, 'node_modules', '@types', 'node'));
  if (existsSync(join(root, 'node_modules', 'undici-types'))) copyDir(join(root, 'node_modules', 'undici-types'), join(project, 'node_modules', 'undici-types'));
  const compiled = run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(project, 'tsconfig.json')], { cwd: project });
  report.steps.push({ id: 'tsc', exit: compiled.status });
  if (compiled.status !== 0) throw new Error(`tsc exited ${String(compiled.status)}: ${(compiled.stdout || compiled.stderr).trim().split('\n').slice(0, 10).join('\n')}`);
  const ran = run(process.execPath, [join(project, 'out', 'consumer.js')], { cwd: project, env: { ...process.env, NODE_OPTIONS: '' } });
  report.steps.push({ id: 'run', exit: ran.status });
  if (ran.status !== 0) throw new Error(`the consumer exited ${String(ran.status)}: ${ran.stderr.trim().slice(0, 1200)}`);
  report.observed = JSON.parse(ran.stdout);
  // The declared surface of the packed package (B04 D4-CAMP-5): the index and ./benchmark, by package name, nothing deeper.
  const SURFACE = `const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('./node_modules/kauro-intelligence-core/package.json', import.meta.url), 'utf8'));
const entry = await import('kauro-intelligence-core/benchmark');
const index = await import('kauro-intelligence-core');
const NEEDED = ['verifyCorpus', 'scoreFixture', 'benchmarkReport', 'bindRun', 'qualifyThreeRuns', 'CampaignAdmission', 'vertexGateway', 'bedrockGateway', 'HARD_GATES', 'selectFromPilot', 'candidatePolicyOf', 'SONNET_5_5_US', 'OPUS_5_5_US', 'createIntelligenceCore'];
const deep = await import('kauro-intelligence-core/dist/src/benchmark/scorer.js').then(() => 'IMPORTED', (error) => error.code);
process.stdout.write(JSON.stringify({ exports: Object.keys(pkg.exports).sort(), missing: NEEDED.filter((name) => !(name in entry)), indexHasCreate: typeof index.createIntelligenceCore, deep }));
`;
  writeFileSync(join(project, 'surface.mjs'), SURFACE);
  const surfaced = run(process.execPath, [join(project, 'surface.mjs')], { cwd: project, env: { ...process.env, NODE_OPTIONS: '' } });
  report.steps.push({ id: 'surface', exit: surfaced.status });
  if (surfaced.status !== 0) throw new Error(`the surface probe exited ${String(surfaced.status)}: ${surfaced.stderr.trim().slice(0, 600)}`);
  const surface = JSON.parse(surfaced.stdout);
  if (JSON.stringify(surface.exports) !== JSON.stringify(['.', './benchmark'])) report.problems.push(`the packed core declares the entry points ${JSON.stringify(surface.exports)}, not the index and ./benchmark`);
  if (surface.missing.length > 0) report.problems.push(`./benchmark lacks ${surface.missing.join(', ')}`);
  if (surface.deep !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') report.problems.push(`a deep path into the package answered ${String(surface.deep)}, not ERR_PACKAGE_PATH_NOT_EXPORTED`);
  if (report.observed.state !== 'PROPOSAL_READY' || report.observed.draft !== 'SYSTEM_DRAFT') report.problems.push(`the consumer run ended ${String(report.observed.state)} / ${String(report.observed.draft)}`);
  if (report.observed.rows !== 2) report.problems.push(`validated ${String(report.observed.rows)} rows, expected 2`);
  if (typeof report.observed.packageDigest !== 'string') report.problems.push('the receipt names no package digest');
  // The run's answers came from the labelled oracle: the result says SIMULATED, and every fragment of the draft was observed in Migration Core's effects.
  if (report.observed.evidenceClass !== 'SIMULATED') report.problems.push(`the result names the evidence class ${String(report.observed.evidenceClass)}, not SIMULATED`);
  if (report.observed.covered !== true || !(report.observed.fragments > report.observed.fields)) report.problems.push(`the coverage manifest is ${report.observed.covered === true ? 'complete' : 'incomplete'} over ${String(report.observed.fragments)} fragments for ${String(report.observed.fields)} fields`);
  // The vendor-mode run: every family asked from the packed tarball, every candidate accounted once, every fragment observed in the effects Migration Core reported.
  const vendor = report.observed.vendor;
  const FAMILIES = ['ASSOCIATION_MAPPING', 'CONSISTENCY_REVIEW', 'DUPLICATE_SIGNAL_STRATEGY', 'FIELD_MAPPING', 'IDENTITY_STRATEGY', 'OBJECT_MAPPING', 'SEMANTIC_REPAIR', 'SEMANTIC_TYPE', 'TARGET_REQUIREMENT', 'TRANSFORMATION_SELECTION', 'UNMAPPED_HANDLING', 'VALUE_MAP'];
  if (vendor === undefined || vendor === null) report.problems.push('the consumer made no vendor-mode run');
  else {
    if (vendor.state !== 'PROPOSAL_READY' || vendor.draft !== 'SYSTEM_DRAFT') report.problems.push('the vendor-mode run ended ' + String(vendor.state) + ' / ' + String(vendor.draft));
    if (JSON.stringify(vendor.families) !== JSON.stringify(FAMILIES)) report.problems.push('the vendor-mode run asked ' + JSON.stringify(vendor.families) + ', not all twelve families');
    if (vendor.accounted !== vendor.expected || vendor.accountingProblems.length > 0 || vendor.unplanned !== 0 || vendor.complete !== true) report.problems.push('the vendor-mode accounting holds ' + String(vendor.accounted) + ' of ' + String(vendor.expected) + ' candidates, problems ' + JSON.stringify(vendor.accountingProblems) + ', unplanned ' + String(vendor.unplanned) + ', complete ' + String(vendor.complete));
    if (vendor.covered !== true || !(vendor.fragments > 0)) report.problems.push('the vendor-mode coverage manifest is ' + (vendor.covered === true ? 'complete' : 'incomplete') + ' over ' + String(vendor.fragments) + ' fragments');
    if (vendor.edges < 1 || vendor.missingEndpoints < 1) report.problems.push('the vendor-mode association delivered ' + String(vendor.edges) + ' edges and reported ' + String(vendor.missingEndpoints) + ' missing endpoints');
    if (vendor.reviewGroups !== 1 || vendor.externalIds !== 1 || !vendor.satisfied.includes('contact.lastName')) report.problems.push('the vendor-mode draft lacks its review group, its external id or its satisfied requirement: ' + JSON.stringify([vendor.reviewGroups, vendor.externalIds, vendor.satisfied]));
    if (vendor.packageVerified !== true) report.problems.push('Migration Core did not verify the vendor-mode package');
  }
  const matrixNow = report.observed.matrix;
  if (JSON.stringify(matrixNow) !== JSON.stringify({ core: '0.6.0', envelope: '2.0.0', proposal: '2.0.0', promptBundle: '1.3.0', compiler: '2.0.0', runLedger: '2.0.0', configuration: '2.0.0', receipt: '2.0.0' })) report.problems.push('the packed core declares ' + JSON.stringify(matrixNow) + ', not the versions of the closed design (D3-VER-1)');
  // The consumer owns its run directory and must have removed it; a directory left behind fails the check.
  if (typeof report.observed.runDir !== 'string' || !report.observed.runDir.includes('kauro-ic-consumer-run-')) report.problems.push('the consumer did not report a run directory of its own');
  else if (existsSync(report.observed.runDir)) report.problems.push(`the consumer left its run directory behind: ${report.observed.runDir}`);
  // Validity v4 (S044, B04-design D4-VAL-4): the committed scorer-validity record is the record of this packed tarball. Its release
  // binding is computed inside a clean install of the tarball, then every control is rerun there; any difference is VALIDITY_STALE.
  // This is the check of the committed record against the tree (the unit suite cannot hold it: it would fail for every sabotage of src/).
  const { rerunValidity } = await import(new URL('./campaign/preflight.mjs', import.meta.url).href);
  const committedRecord = JSON.parse(readFileSync(join(root, 'corpus', 'scorer-validity.json'), 'utf8'));
  const rerun = rerunValidity({ record: committedRecord, corpusDir: 'corpus', icTarball: join(work, tarball) });
  report.steps.push({ id: 'validity-rerun', exit: rerun.refusals.length === 0 ? 0 : 1 });
  report.validity = { recordDigest: committedRecord.recordDigest, freshRecordDigest: rerun.fresh?.recordDigest ?? null, binding: rerun.binding };
  for (const refusal of rerun.refusals) report.problems.push(`${refusal.code}: ${refusal.detail}`);
  report.ok = report.problems.length === 0;
} catch (error) {
  report.problems.push(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.stdout.write(`${report.ok ? 'INTELLIGENCE-CONSUMER-01 = PASS' : 'INTELLIGENCE-CONSUMER-01 = FALSE'}: ${JSON.stringify(report.observed)} validity ${JSON.stringify(report.validity ?? null)} ${report.problems.join('; ')}\n`);
process.exit(report.ok ? 0 : 1);

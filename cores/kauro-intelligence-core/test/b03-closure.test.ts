/**
 * B03-INTEGRATION — the closed design through the public run() (closure plan
 * §3, §4 and §5; decisions D3-ACC-1, D3-ACC-2, D3-CFG-3, D3-GRANT-1,
 * D3-PART-1; review finding B03-R1; cases S036, S095 and R2-037).
 *
 * One scenario holds the twelve capability families: a Contacts file, a
 * Companies file and a Branches file nobody declared an object for. The same
 * bundle, the same model script and the same sentinels run in the three
 * target modes; a vendor contract is built from one field table, so the
 * families a mode can ask (an option list, a required flag, an external id)
 * are the ones its contract states. The canonical model states none of them:
 * CLEAN_ONLY has no enum authority, no required flag and no external id, so
 * three families have nothing to ask there, and the file says which.
 *
 * Every case goes through the public run() with the real Migration Core in
 * the host's validation port (the vendored release: runMigration,
 * writePackage, verifyPackage). The model is a labelled fake — a transport
 * that answers from the serialised provider request, each item written by the
 * scenario as a model would answer it (evidence class SIMULATED) — and the
 * funded grant is the in-memory admission. No provider is called.
 *
 * Written first, against ic/b03-stage-2: what the build under test may not
 * have yet is read through loose views, so the file compiles there and its
 * assertions say what is missing.
 */
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SCRATCH_BUDGET_BYTES, buildCandidateSet, createFilesystemScratchStore, hashTargetContract, loadConfig, produceSourceProfile, runMigration } from 'kauro-migration-core';
import type { HashedCandidateSet, HashedSourceProfile, HashedTargetContract, TargetContract } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import { cleanOnlyTargetRef } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, ReviewClaimView, TaskType } from '../src/contracts/envelope.js';
import { recordMappingIdOf } from '../src/contracts/output-scope.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import type { MemoryEntry } from '../src/contracts/run.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import { parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import { MemoryDispatchAdmission } from '../src/kernel/admission.js';
import { MemoryLedgerStore, VirtualClock } from '../src/kernel/ledger.js';
import { CANDIDATE_DISPOSITIONS, candidateAccountingProblems, planCandidates } from '../src/planner/candidate-accounting.js';
import type { IntelligenceInput } from '../src/ports/ports.js';
import { channels, forms, leaks } from './support/egress-harness.js';
import type { Observed } from './support/egress-harness.js';
import { AUTHORITY, CONTEXT, TEST_EGRESS_KEY, TEST_TARIFF, attestationFor, depsFor, inputFor, makeBundle, realValidationPort } from './support/fixtures.js';
import type { Bundle } from './support/fixtures.js';

// ------------------------------------------------------------------------------------------------ loose views

type Loose = Readonly<Record<string, unknown>>;
type Mode = 'CLEAN_ONLY' | 'HUBSPOT' | 'SALESFORCE';
type VendorMode = Exclude<Mode, 'CLEAN_ONLY'>;
type ContractField = TargetContract['objects'][number]['fields'][number];

type Accounting = NonNullable<IntelligenceResult['candidateAccounting']>;
type Disposition = Accounting['dispositions'][number];
const accountingOf = (result: IntelligenceResult): Accounting => {
  const accounting = result.candidateAccounting;
  assert.ok(accounting !== undefined && accounting !== null, 'the run accounted its candidates');
  return accounting;
};

/** The draft's members the integration reads, through a loose view: a build without them reads as undefined and the assertion says what is missing. */
interface DraftView {
  readonly fragmentCoverage?: { readonly complete: boolean; readonly entries: readonly { readonly fragmentKind: string; readonly decisionRef: string; readonly candidateRefs: readonly string[]; readonly origin: string; readonly fragmentHash: string; readonly expectedEffect: string; readonly observed: boolean }[] } | null;
  readonly requirements?: readonly { readonly destinationField: string; readonly status: string; readonly decisionRef: string | null }[];
  readonly identity?: { readonly records: readonly { readonly recordMappingId: string; readonly authoritativeExternalIdColumns: readonly string[]; readonly candidateRefs: readonly string[] }[] } | null;
  readonly reviewGroups?: readonly { readonly observed: boolean; readonly rows: number }[];
  readonly associations?: readonly { readonly edgesDelivered: number; readonly missingEndpoints: number; readonly fragmentHash: string }[];
  readonly evidence: readonly { readonly origin: string; readonly candidateRef: string; readonly fragmentHash: string | null; readonly destinationField: string | null }[];
}
const draftOf = (result: IntelligenceResult): DraftView => result.draft as unknown as DraftView;
const effectsOf = (result: IntelligenceResult): Loose => {
  const effects = (result.draft.fullValidation as unknown as { readonly effects?: Loose | null } | null)?.effects;
  assert.ok(effects !== undefined && effects !== null, 'the receipt reports what Migration Core did with each fragment');
  return effects;
};
const listOf = (value: unknown): readonly Loose[] => (Array.isArray(value) ? (value as readonly Loose[]) : []);

const TIMEOUT = { timeout: 600_000 };
const MODES: readonly Mode[] = ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'];
const DECLARED = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } as const;
const RECORD_IDS = { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } as const;
const objectRefOf = (mode: Mode, object: string): string => `obj_${digestOf(`${mode}:${object}`).slice(0, 16)}`;

/** The twelve capability families, by the task type that asks each (SEMANTIC_REPAIR is the repair round of a task). */
const FAMILIES: readonly TaskType[] = ['OBJECT_MAPPING', 'FIELD_MAPPING', 'SEMANTIC_TYPE', 'TRANSFORMATION_SELECTION', 'VALUE_MAP', 'IDENTITY_STRATEGY', 'DUPLICATE_SIGNAL_STRATEGY', 'ASSOCIATION_MAPPING', 'UNMAPPED_HANDLING', 'TARGET_REQUIREMENT', 'CONSISTENCY_REVIEW', 'SEMANTIC_REPAIR'];

/**
 * The families each mode asks. A vendor contract states an option list (VALUE_MAP),
 * a required flag (TARGET_REQUIREMENT), an external id (IDENTITY_STRATEGY), an
 * object no header decides (OBJECT_MAPPING), a target no column can take
 * (UNMAPPED_HANDLING) and, with them, two claims for one target
 * (CONSISTENCY_REVIEW). The canonical model states none of these: its Domain header
 * names the Branches file's object, its many plain-text targets leave no column without
 * one, and it carries no option list, no required flag and no external id.
 */
const ASKED: Readonly<Record<Mode, readonly TaskType[]>> = {
  CLEAN_ONLY: ['FIELD_MAPPING', 'SEMANTIC_TYPE', 'TRANSFORMATION_SELECTION', 'DUPLICATE_SIGNAL_STRATEGY', 'ASSOCIATION_MAPPING', 'SEMANTIC_REPAIR'],
  HUBSPOT: FAMILIES,
  SALESFORCE: FAMILIES,
};

// ------------------------------------------------------------------------------------------------ the scenario's data

/** Synthetic sentinels written for this file: words and identifiers no vocabulary, header table or target knows. */
const SENTINELS = {
  /** The association key column's header, and the values it holds. */
  keyHeader: 'Company Zorvane Ref',
  keyValues: ['ZV-7741', 'ZV-7742', 'ZV-7743'],
  /** The identity column's values. */
  customer: ['Pelsira-1001', 'Pelsira-1002', 'Pelsira-1003', 'Pelsira-1004'],
  /** The value shared by a duplicate cluster. */
  signal: 'ondriel.vaskemar@kauro-fixture.test',
  /** A person-shaped value in the status column: never an L1 value, never a value candidate. */
  person: 'Okonkwo',
  /** Free text a model wrote in a rationale. */
  rationale: 'Quontay',
  /** A candidate ref no envelope carried: the member name a model invented. */
  member: 'Tolveno',
} as const;

const EMAILS = { ada: 'ada@kauro-fixture.test', grace: 'grace@kauro-fixture.test', shared: 'edsger@kauro-fixture.test' };

/** The option list of the status picklist in both vendor contracts. */
const STATUS_OPTIONS = ['lead', 'opportunity', 'customer'] as const;
/** The option list of the country picklist: a second enum column whose values are all L1 (ISO country codes) and none of them an option, so a value map is asked in the runs whose status column holds a value that is not L1. The options are sales regions, which read as structure; a country's name would read as a place. */
const COUNTRY_OPTIONS = ['emea', 'na', 'apac'] as const;

interface Data {
  readonly contacts: string;
  readonly companies: string;
  readonly branches: string;
  readonly statusValues: readonly string[];
}

/**
 * The bundle's three files. `sentinel` puts the sentinels of the families'
 * channels into the same cells the plain scenario fills with ordinary words,
 * so both run the same plan.
 */
function dataOf(sentinel: boolean): Data {
  const keyHeader = sentinel ? SENTINELS.keyHeader : 'Company Ref';
  const keys = sentinel ? SENTINELS.keyValues : ['C1', 'C2', 'C9'];
  const customer = sentinel ? SENTINELS.customer : ['CN-1001', 'CN-1002', 'CN-1003', 'CN-1004'];
  const shared = sentinel ? SENTINELS.signal : EMAILS.shared;
  const statusValues = sentinel ? ['Nuevo', 'Abierto', SENTINELS.person, 'lead'] : ['Nuevo', 'Abierto', 'Ganado', 'lead'];
  const contacts = [
    `Contact ID,Customer Number,First Name,Email,Legal Last Name,Family Name,${keyHeader},Home City,Country,Status`,
    `1,${customer[0] ?? ''},Ada,${EMAILS.ada},Lovelace,Lovelace,${keys[0] ?? ''},Madrid,ES,${statusValues[0] ?? ''}`,
    `2,${customer[1] ?? ''},Grace,${EMAILS.grace},Hopper,Hopper,${keys[1] ?? ''},Lisbon,PT,${statusValues[1] ?? ''}`,
    `3,${customer[2] ?? ''},Alan,${shared},Turing,Turing,${keys[0] ?? ''},Boston,US,${statusValues[2] ?? ''}`,
    `4,${customer[3] ?? ''},Alonzo,${shared},Church,Church,${keys[2] ?? ''},Seville,ES,${statusValues[3] ?? ''}`,
  ].join('\n');
  // The Companies file's record ids are what the Contacts file's key column references; the third key names no company of the bundle.
  const companies = [
    'Company ID,Name,Website,Employee Count,Annual Revenue,Region',
    `${keys[0] ?? ''},Analytical Engines,https://analytical.test,12,"1234,56",North`,
    `${keys[1] ?? ''},COBOL Works,https://cobol.test,unknown,"99,5",South`,
    'C3,Difference Works,https://difference.test,1,"1000,75",East',
    'C4,Logic Mills,https://logic.test,40,"15,25",West',
  ].join('\n');
  // Branches is declared by nobody. In the canonical model its Domain header names a Company field and decides the file; in a vendor contract that delivers no domain no header names an object, and the Web column (a URL only Account.Website holds) decides it.
  const branches = ['Outlet Title,Domain,Web,Territory', 'Harbour Outlet,harbour.test,https://harbour.test,Port', 'Station Outlet,station.test,https://station.test,Rail', 'Market Outlet,market.test,https://market.test,Town'].join('\n');
  return { contacts: `${contacts}\n`, companies: `${companies}\n`, branches: `${branches}\n`, statusValues };
}

// ------------------------------------------------------------------------------------------------ the target contract of a vendor mode

function contractField(apiName: string, label: string, type: string, extra: Partial<ContractField> = {}): ContractField {
  return { apiName, label, type, createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE', idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE', restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT', ...extra };
}

/**
 * The vendor contract of the scenario, from one field table: a Contact with a
 * unique Email, a required Last Name, a Mailing City, a Status picklist and a
 * Customer Number the org flags External ID; an Account that delivers nothing
 * beyond the columns the Companies file names, so a column beyond them has no
 * target (CAP09).
 */
function contractOf(mode: VendorMode): HashedTargetContract {
  const hs = mode === 'HUBSPOT';
  const options = STATUS_OPTIONS.map((value) => ({ value, label: value, active: true, defaultValue: false }));
  const contact = [
    contractField(hs ? 'email' : 'Email', 'Email', hs ? 'string' : 'email', { unique: 'TRUE', idLookup: 'TRUE' }),
    contractField(hs ? 'firstname' : 'FirstName', 'First Name', 'string'),
    contractField(hs ? 'lastname' : 'LastName', 'Last Name', 'string', { nillable: 'FALSE' }),
    contractField(hs ? 'city' : 'MailingCity', hs ? 'City' : 'Mailing City', 'string'),
    contractField(hs ? 'lifecyclestage' : 'Title', 'Status', hs ? 'enumeration' : 'picklist', { picklistValues: options }),
    contractField(hs ? 'customer_number' : 'Customer_Number__c', 'Customer Number', 'string', { unique: 'TRUE', externalId: 'TRUE', idLookup: 'TRUE' }),
    contractField(hs ? 'country' : 'MailingCountry', 'Country', hs ? 'enumeration' : 'picklist', { picklistValues: COUNTRY_OPTIONS.map((value) => ({ value, label: value, active: true, defaultValue: false })) }),
  ];
  const company = [
    contractField(hs ? 'name' : 'Name', 'Name', 'string'),
    contractField(hs ? 'website' : 'Website', 'Website', 'url'),
    contractField(hs ? 'numberofemployees' : 'NumberOfEmployees', 'Employee Count', hs ? 'number' : 'int'),
    contractField(hs ? 'annualrevenue' : 'AnnualRevenue', 'Annual Revenue', hs ? 'number' : 'currency'),
  ];
  return hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode, instanceId: hs ? '00000017' : '00D000000000017', instanceLabel: `fixture closure ${mode}`, evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects: [
      { apiName: hs ? 'contact' : 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: contact },
      { apiName: hs ? 'company' : 'Account', label: 'Company', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: company },
    ],
    pipelines: [],
  });
}

/** The targets the scenario names, by role: the vendor api name and the canonical name. */
type Role = 'email' | 'lastName' | 'city' | 'website';
const VENDOR_NAMES: Readonly<Record<VendorMode, Readonly<Record<Role, string>>>> = {
  HUBSPOT: { email: 'email', lastName: 'lastname', city: 'city', website: 'website' },
  SALESFORCE: { email: 'Email', lastName: 'LastName', city: 'MailingCity', website: 'Website' },
};
const CANONICAL: Readonly<Record<Role, string>> = { email: 'contact.email', lastName: 'contact.lastName', city: 'contact.city', website: 'company.website' };

// ------------------------------------------------------------------------------------------------ the model

/** One request as it left: its bytes and what they parse to. */
interface Sent {
  readonly bytes: string;
  readonly envelope: IntelligenceEnvelopeV1;
}

interface Asked {
  readonly candidate: DeterministicCandidate;
  readonly envelope: IntelligenceEnvelopeV1;
  /** The family the task asks: the envelope's task type, or — on a repair round, whose envelope is typed SEMANTIC_REPAIR — the type of the task it repairs. */
  readonly family: TaskType;
  /** The real header of the candidate's first column, from the test's own adapted contracts: never the masked one an envelope carries. */
  readonly header: string;
  readonly repair: boolean;
}
type Answer = (asked: Asked) => Partial<ProposalItem> | 'UNKNOWN_REF' | null;

const abstention = (candidate: DeterministicCandidate): ProposalItem => ({ candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: candidate.evidenceRefs.slice(0, 32), requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, alternatives: [], abstainReason: 'INSUFFICIENT_EVIDENCE' });

/** A transport answering from the serialised request: an abstention for each candidate unless the scenario writes another answer. */
function answeringTransport(contracts: AdaptedContracts, answer: Answer, sent: Sent[]): Transport {
  const headerOf = (fieldRef: string | undefined): string => (fieldRef === undefined ? '' : (contracts.refs.fieldByRef.get(fieldRef)?.header ?? ''));
  const familyOfTask = new Map<string, TaskType>();
  return async (request: ProviderRequest) => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    const envelope = payload.envelope;
    sent.push({ bytes, envelope });
    if (envelope.repairContext === null) familyOfTask.set(envelope.taskId, envelope.taskType);
    const family = familyOfTask.get(envelope.taskId) ?? envelope.taskType;
    const oracle = oracleProposal(envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
    const items = envelope.deterministicCandidates.map((candidate): ProposalItem => {
      const written = answer({ candidate, envelope, family, header: headerOf(candidate.sourceRefs[0]), repair: envelope.repairContext !== null });
      if (written === 'UNKNOWN_REF') return { ...abstention(candidate), candidateRef: SENTINELS.member };
      return { ...abstention(candidate), ...(written ?? {}) };
    });
    const text = JSON.stringify({ ...oracle, items, overallOutcome: 'MIXED' });
    return { status: 200, body: { id: `msg_b03_closure_${String(sent.length)}`, type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
}

/** The value a value candidate stands for: the exemplar its evidence names, the only place the value travels. */
const valueOf = (candidate: DeterministicCandidate, envelope: IntelligenceEnvelopeV1): string | null => envelope.exemplars.find((exemplar) => exemplar.dataLevel === 'L1' && candidate.evidenceRefs.includes(exemplar.exemplarRef))?.minimizedValueOrClass ?? null;

/** The claims of a review candidate's contradiction, read through a loose view. */
const reviewClaimsOf = (envelope: IntelligenceEnvelopeV1): readonly ReviewClaimView[] => (envelope as unknown as { readonly reviewClaims?: readonly ReviewClaimView[] }).reviewClaims ?? [];
const RANK: Readonly<Record<string, number>> = { INSUFFICIENT: 0, AMBIGUOUS: 1, SUPPORTED: 2, STRONG: 3 };

/** How the scenario's model answers each family, as one who read the request would. */
function scenarioAnswer(mode: Mode, refOf: (role: Role) => string, options: RunOptions): Answer {
  const valueMap: Readonly<Record<string, string>> = { Nuevo: 'lead', Abierto: 'opportunity', Ganado: 'customer', ES: 'emea', PT: 'emea', US: 'na' };
  // Free text a model wrote beside an answer: the sentinel runs put one where the result and the logs must not carry it.
  const said = options.sentinel === true ? SENTINELS.rationale : null;
  return ({ candidate, envelope, family, header, repair }) => {
    switch (family) {
      case 'OBJECT_MAPPING':
        return { proposalType: 'MAP_OBJECT', targetRef: objectRefOf(mode, 'COMPANY'), rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
      case 'FIELD_MAPPING': {
        if (header === 'Home City') {
          // CAP12: the first answer names a candidate no envelope carried; the one repair round answers it.
          if (options.repair === true && !repair) return 'UNKNOWN_REF';
          return { proposalType: 'MAP_FIELD', targetRef: refOf('city'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', shortRationale: said, abstainReason: null };
        }
        if (header === 'Family Name') return { proposalType: 'MAP_FIELD', targetRef: refOf('lastName'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'MEMORY_CONVENTION_APPLIES', abstainReason: null };
        if (header === 'Web') return { proposalType: 'MAP_FIELD', targetRef: refOf('website'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
        return { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null };
      }
      case 'SEMANTIC_TYPE':
        return { proposalType: 'SELECT_SEMANTIC_TYPE', typedTransformParams: { semanticType: 'NUMBER' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
      case 'TRANSFORMATION_SELECTION':
        return candidate.allowedPrimitiveRefs.includes('NORMALISE_NUMBER') ? { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'NORMALISE_NUMBER', typedTransformParams: { decimalSeparator: ',' }, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null } : null;
      case 'VALUE_MAP': {
        const value = valueOf(candidate, envelope);
        const to = value === null ? undefined : valueMap[value];
        return to === undefined ? null : { proposalType: 'MAP_ENUM_VALUE', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { to }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', abstainReason: null };
      }
      case 'UNMAPPED_HANDLING':
        return { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'NO_TARGET_IN_ENVELOPE', abstainReason: 'NO_VALID_TARGET' };
      case 'IDENTITY_STRATEGY':
        return header !== 'Customer Number' ? null : { proposalType: 'PROPOSE_IDENTITY_STRATEGY', rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER', abstainReason: null };
      case 'DUPLICATE_SIGNAL_STRATEGY':
        return { proposalType: 'PROPOSE_DUPLICATE_SIGNAL', rationaleCode: 'IDENTITY_NEEDS_PROOF', abstainReason: null };
      case 'ASSOCIATION_MAPPING':
        return candidate.allowedTargetRefs.length === 1 ? { proposalType: 'MAP_ASSOCIATION', targetRef: candidate.allowedTargetRefs[0] ?? null, rationaleCode: 'FOREIGN_KEY_COLUMN', abstainReason: null } : null;
      case 'TARGET_REQUIREMENT':
        return header === 'Legal Last Name' ? { proposalType: 'MAP_FIELD', targetRef: refOf('lastName'), transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null } : null;
      case 'CONSISTENCY_REVIEW': {
        const claims = reviewClaimsOf(envelope).filter((claim) => claim.candidateRef === candidate.candidateRef);
        const weaker = [...claims].sort((a, b) => (RANK[a.evidenceClass] ?? 0) - (RANK[b.evidenceClass] ?? 0))[0];
        return weaker === undefined ? null : { proposalType: 'UNMAPPED_PRESERVE', targetRef: weaker.decisionRef, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: said, abstainReason: null };
      }
      default:
        return null;
    }
  };
}

// ------------------------------------------------------------------------------------------------ one run

interface RunOptions {
  readonly name: string;
  /** The sentinels of the families' channels, in the cells the plain scenario fills with ordinary words. */
  readonly sentinel?: boolean;
  /** The funded grant; the tests' large one unless a case says otherwise. */
  readonly fundedMicros?: number;
  /** Whether the first FIELD_MAPPING answer for Home City names a candidate the envelope never carried (CAP12). */
  readonly repair?: boolean;
}

interface Ran {
  readonly mode: Mode;
  readonly result: IntelligenceResult;
  readonly sent: readonly Sent[];
  readonly contracts: AdaptedContracts;
  readonly input: IntelligenceInput;
  readonly grant: MemoryDispatchAdmission;
  readonly observed: Observed;
  readonly data: Data;
  /** The locator of a column of the bundle, by file and header. */
  readonly locator: (file: string, header: string) => string;
  readonly fileId: (file: string) => string;
}

/** A CLIENT memory entry of the tenant: the header pattern is this client's convention for the target. */
function convention(memoryId: string, pattern: string, targetRef: string): MemoryEntry {
  return { memoryId, scope: 'CLIENT', tenant: CONTEXT.tenant, knowledgeType: 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: pattern, targetRef, semanticType: null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'run r task t', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 };
}

function bundleOf(name: string, data: Data): Bundle {
  const made = makeBundle(name, { contacts: data.contacts, companies: data.companies });
  writeFileSync(join(made.root, 'branches.csv'), data.branches);
  return {
    ...made,
    files: [
      { id: 'contacts', path: 'contacts.csv', idHeader: 'Contact ID', object: 'CONTACT' },
      { id: 'companies', path: 'companies.csv', idHeader: 'Company ID', object: 'COMPANY' },
      { id: 'branches', path: 'branches.csv', idHeader: 'Outlet Title', object: 'COMPANY' },
    ],
  };
}

/**
 * The bundle as the audit's PROFILE step profiles it: the read configuration
 * maps each file's name column and record id, Migration Core runs it over the
 * whole bundle — under the attested contract in a vendor mode — and the
 * candidate set is built with that dry-run truth, so its duplicate clusters
 * and unmapped material stand in it as originals beside the key candidates.
 */
function profiledWithTruth(bundle: Bundle, mode: Mode, contract: HashedTargetContract | null): { profile: HashedSourceProfile; candidateSet: HashedCandidateSet } {
  const nameColumn: Readonly<Record<string, string>> = { contacts: 'Email', companies: 'Name', branches: 'Outlet Title' };
  const text = JSON.stringify({
    configVersion: '3.0.0',
    source: { system: 'fixture', namespace: `fixture-${mode.toLowerCase()}` },
    target: { mode, importMode: 'CREATE_ONLY' },
    files: bundle.files.map((file) => ({ id: file.id, path: file.path, format: 'CSV' })),
    records: bundle.files.map((file) => ({
      id: file.id,
      fileId: file.id,
      object: file.object,
      sourceRecordIdColumn: { header: file.idHeader },
      // Migration Core 3.0.0 refuses a CREATE_ONLY record mapping that leaves a field the attested contract requires unmapped, so the vendor-mode reading maps the required Last Name too.
      fields: file.object === 'CONTACT' ? [{ column: { header: nameColumn[file.id] }, destinationField: 'contact.email', semanticType: 'EMAIL' }, ...(contract === null ? [] : [{ column: { header: 'Legal Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' }])] : [{ column: { header: nameColumn[file.id] }, destinationField: 'company.name', semanticType: 'TEXT' }],
    })),
  });
  const loaded = loadConfig(text, join(bundle.root, 'profile-config.json'));
  const profileStore = createFilesystemScratchStore({ root: join(bundle.root, 'scratch-profile'), runId: 'profile', quotaBytes: SCRATCH_BUDGET_BYTES });
  const truthStore = createFilesystemScratchStore({ root: join(bundle.root, 'scratch-truth'), runId: 'truth', quotaBytes: SCRATCH_BUDGET_BYTES });
  try {
    const profile = produceSourceProfile({ inputRoot: bundle.root, config: loaded.config, scratch: profileStore });
    const run = runMigration({
      inputRoot: bundle.root,
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: truthStore,
      sourceProfile: profile,
      ...(contract === null ? {} : { targetContract: contract, targetAttestation: attestationFor(contract), attestationAuthorities: [AUTHORITY], attestationInstant: '2026-09-15T00:00:00Z' }),
    });
    return { profile, candidateSet: buildCandidateSet({ profile, configHash: loaded.configHash, truth: run.truth }) };
  } finally {
    profileStore.dispose();
    truthStore.dispose();
  }
}

/** One public run of the scenario in a mode, every channel captured. */
async function runClosure(mode: Mode, options: RunOptions): Promise<Ran> {
  const data = dataOf(options.sentinel === true);
  const bundle = bundleOf(`b03-closure-${options.name}-${mode.toLowerCase()}`, data);
  const logs: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const recording = (write: typeof process.stdout.write, stream: NodeJS.WriteStream): typeof process.stdout.write =>
    ((chunk: unknown, ...rest: unknown[]): boolean => {
      logs.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return (write as (this: NodeJS.WriteStream, chunk: unknown, ...more: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof process.stdout.write;
  try {
    const contract = mode === 'CLEAN_ONLY' ? null : contractOf(mode);
    const profiled = profiledWithTruth(bundle, mode, contract);
    const contracts = adaptContracts({ mode, profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
    const column = (file: string, header: string): readonly [string, { readonly locator: string; readonly fileId: string }] => {
      const found = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.filePath === file && entry.header === header);
      assert.ok(found !== undefined, `${file} has a column ${header}`);
      return found;
    };
    const refOf = (role: Role): string => {
      if (mode === 'CLEAN_ONLY') return cleanOnlyTargetRef(CANONICAL[role]);
      const apiName = VENDOR_NAMES[mode][role];
      const found = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === apiName)?.[0];
      assert.ok(found !== undefined, `the contract carries ${apiName}`);
      return found;
    };
    const summaries = new Map<string, readonly string[]>([[column('contacts.csv', 'Status')[1].locator, data.statusValues], [column('contacts.csv', 'Country')[1].locator, ['ES', 'PT', 'US']]]);
    const base = inputFor(mode, profiled, contract, { categoricalSummaries: summaries, scopedMemorySnapshot: [convention('mem_5a5b5c5d5e5f6061', 'Family Name', refOf('lastName'))] });
    const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED, recordIdColumns: RECORD_IDS } };
    const clock = new VirtualClock();
    const port = realValidationPort(bundle, profiled.profile, contract, { clock });
    const sent: Sent[] = [];
    const gateway = transportGateway(answeringTransport(contracts, scenarioAnswer(mode, refOf, options), sent));
    const telemetry: unknown[] = [];
    const grant = new MemoryDispatchAdmission({ fundedMicros: options.fundedMicros ?? 1_000_000_000_000 });
    const deps = { ...depsFor(gateway, port, clock), ledgerStore: new MemoryLedgerStore(), dispatchAdmission: grant, egressKey: TEST_EGRESS_KEY, tariff: TEST_TARIFF, telemetry: (event: unknown): void => { telemetry.push(structuredClone(event)); } };
    process.stdout.write = recording(out, process.stdout);
    process.stderr.write = recording(err, process.stderr);
    let result: IntelligenceResult;
    try {
      result = await createIntelligenceCore(deps).run(input, { ...CONTEXT, auditAttemptId: options.name });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const observed: Observed = {
      mode,
      result,
      requests: sent.map((entry) => entry.bytes),
      envelopes: sent.map((entry) => entry.envelope),
      metadata: [],
      telemetry,
      logs,
      portCalls: port.calls,
      packageVerified: result.draft.fullValidation?.packageVerified === true,
      refs: { status: '', extra: null, picklist: null, apiField: null },
    };
    return { mode, result, sent, contracts, input, grant, observed, data, locator: (file, header) => column(file, header)[1].locator, fileId: (file) => column(file, file === 'contacts.csv' ? 'Contact ID' : file === 'companies.csv' ? 'Company ID' : 'Outlet Title')[1].fileId };
  } finally {
    bundle.dispose();
  }
}

/** The task types a run asked, from the requests that left (a repair round is SEMANTIC_REPAIR). */
const askedOf = (ran: Ran): readonly TaskType[] => [...new Set(ran.sent.map((entry) => entry.envelope.taskType))].sort();

/** The fields of a run's receipt effects, by destination. */
const fieldEffect = (result: IntelligenceResult, destinationField: string): Loose | undefined => listOf(effectsOf(result)['fields']).find((entry) => entry['destinationField'] === destinationField);

/** The ledger's TASK_OUTCOME facts of a result, read loosely. */
const taskOutcomes = (result: IntelligenceResult): readonly { readonly taskId: string; readonly attempt: number; readonly outcome: string; readonly codes: readonly string[] }[] =>
  (result.runLedger as unknown as { readonly kind: string; readonly taskId?: string; readonly attempt?: number; readonly outcome?: string; readonly codes?: readonly string[] }[])
    .filter((event) => event.kind === 'TASK_OUTCOME')
    .map((event) => ({ taskId: event.taskId ?? '', attempt: event.attempt ?? 0, outcome: event.outcome ?? '', codes: event.codes ?? [] }));

// ------------------------------------------------------------------------------------------------ the cases

describe('B03-INTEGRATION — the twelve families through the public run()', () => {
  it('S036: runs in all three modes that exercise all twelve families keep a sentinel placed in every new family channel — association keys, value-map source values, identity and duplicate-signal columns, consistency and repair feedback — off the wire and out of the logs, and still draft', TIMEOUT, async () => {
    const denied = [SENTINELS.keyHeader, 'Zorvane', ...SENTINELS.keyValues, ...SENTINELS.customer, SENTINELS.signal, 'ondriel.vaskemar', SENTINELS.person, SENTINELS.rationale, SENTINELS.member];
    const askedByMode = new Map<Mode, readonly TaskType[]>();
    for (const mode of MODES) {
      const ran = await runClosure(mode, { name: 's036', sentinel: true, repair: true });
      const { result } = ran;
      // Still drafts: the sentinels change no answer the run could give.
      assert.equal(result.state, 'PROPOSAL_READY', `${mode}: ${JSON.stringify(result.unresolvedItems)}`);
      assert.equal(result.draft.status, 'SYSTEM_DRAFT', mode);
      assert.equal(ran.observed.packageVerified, true, `${mode}: Migration Core verified the package`);

      // The channels travelled: each family this mode can ask was asked, so nothing below is vacuous.
      const asked = askedOf(ran);
      askedByMode.set(mode, asked);
      assert.deepEqual(asked, [...ASKED[mode]].sort(), `${mode} asks the families its target authority states`);
      const association = ran.sent.find((entry) => entry.envelope.taskType === 'ASSOCIATION_MAPPING')?.envelope as unknown as { readonly associationTargets?: readonly unknown[] } | undefined;
      assert.equal(association?.associationTargets?.length, 1, `${mode}: the association channel carried its option`);
      const repair = ran.sent.find((entry) => entry.envelope.taskType === 'SEMANTIC_REPAIR');
      assert.ok(repair !== undefined && repair.envelope.repairContext !== null, `${mode}: the repair channel carried its feedback`);
      if (mode !== 'CLEAN_ONLY') {
        const review = ran.sent.find((entry) => entry.envelope.taskType === 'CONSISTENCY_REVIEW');
        assert.ok(review !== undefined && reviewClaimsOf(review.envelope).length >= 2, `${mode}: the review channel carried the claims of its contradictions`);
        const values = ran.sent.filter((entry) => entry.envelope.taskType === 'VALUE_MAP').flatMap((entry) => entry.envelope.deterministicCandidates.map((candidate) => valueOf(candidate, entry.envelope)));
        assert.deepEqual([...values].sort(), ['ES', 'PT', 'US'], `${mode}: only the L1 values of the country column travelled; the status column holds a person-shaped value and asks no value map`);
      }

      // Nothing of a sentinel left, in any encoding, on any channel: the wire, the parsed envelopes, the metadata, the telemetry, the logs, the public log and the returned result.
      assert.deepEqual(leaks(ran.observed, denied), [], `${mode}: a sentinel left the process`);
      for (const [name, text] of Object.entries(channels(ran.observed))) {
        const lowered = text.toLowerCase();
        for (const token of denied) for (const form of forms(token)) assert.ok(!lowered.includes(form.toLowerCase()), `${mode}: ${name} carries ${token} in another case`);
      }
    }
    // Between them the three modes exercised all twelve families.
    assert.deepEqual([...new Set([...askedByMode.values()].flat())].sort(), [...FAMILIES].sort());
  });

  it('S095: when the remaining grant cannot admit every planned task, the tasks it cannot admit end BUDGET_EXHAUSTED before any request and their candidates are PENDING_BUDGET in the accounting', TIMEOUT, async () => {
    // The funded run: the requests the scenario sends, in order, with what each reserved and what each was charged.
    const funded = await runClosure('SALESFORCE', { name: 's095-funded' });
    assert.equal(funded.result.state, 'PROPOSAL_READY', JSON.stringify(funded.result.unresolvedItems));
    const plan = funded.result.tasks;
    assert.ok(plan.length >= 8, `the scenario plans many tasks: ${JSON.stringify(plan.map((task) => task.taskType))}`);
    const reserved = funded.grant.admissions.map((entry) => entry.maxChargeMicros);
    const charged = funded.grant.admissions.map((entry) => funded.grant.holdOf(entry.reservationId, entry.runId)?.chargeMicros ?? 0);
    assert.equal(reserved.length, plan.length, 'one request per task');

    // A grant that admits the first `admitted` requests and refuses the next: the smallest that holds each of them, when the one after it does not fit.
    const grantFor = (admitted: number): number | null => {
      let needed = 0;
      let settled = 0;
      for (let index = 0; index < admitted; index += 1) {
        needed = Math.max(needed, settled + (reserved[index] ?? 0));
        settled += charged[index] ?? 0;
      }
      return needed - settled < (reserved[admitted] ?? 0) ? needed : null;
    };
    const admitted = [6, 5, 7, 4, 8].find((count) => grantFor(count) !== null);
    assert.ok(admitted !== undefined, 'some prefix of the plan fits a grant that refuses the task after it');
    const fundedMicros = grantFor(admitted) as number;

    const limited = await runClosure('SALESFORCE', { name: 's095-limited', fundedMicros });
    const { result } = limited;
    assert.equal(result.state, 'BUDGET_EXHAUSTED', JSON.stringify(result.unresolvedItems));
    assert.equal(result.draft.status, 'NOT_DRAFTABLE');
    assert.equal(limited.sent.length, admitted, 'a request left for each task the grant admitted, and for no other');
    assert.deepEqual(limited.grant.admissions.map((entry) => entry.outcome), [...Array.from({ length: admitted }, () => 'ADMITTED'), 'NO_FUNDED_GRANT'], 'the grant refused once; no later task asked it for anything');
    assert.equal(limited.grant.view().heldMicros, 0, 'no hold is left behind');

    // Every planned task the grant could not admit ends BUDGET_EXHAUSTED on the result and on the record, with no request behind it.
    const notAdmitted = plan.slice(admitted).filter((task) => task.taskType !== 'CONSISTENCY_REVIEW');
    assert.ok(notAdmitted.length >= 2, 'the grant leaves several planned tasks unadmitted');
    const recorded = taskOutcomes(result);
    for (const task of notAdmitted) {
      const ended = result.tasks.find((entry) => entry.taskId === task.taskId);
      assert.ok(ended !== undefined, `${task.taskType} is on the result: ${JSON.stringify(result.tasks.map((entry) => [entry.taskType, entry.outcome]))}`);
      assert.equal(ended.outcome, 'BUDGET_EXHAUSTED', `${task.taskType} ended BUDGET_EXHAUSTED`);
      assert.ok(!limited.sent.some((entry) => entry.envelope.taskId === task.taskId), `${task.taskType}: no request left for it`);
      assert.ok(ended.codes.includes('NO_FUNDED_GRANT'), `${task.taskType} names the grant: ${JSON.stringify(ended.codes)}`);
      assert.ok(recorded.some((entry) => entry.taskId === task.taskId && entry.outcome === 'BUDGET_EXHAUSTED'), `${task.taskType} is BUDGET_EXHAUSTED on the record as well`);
    }
    for (const task of plan.slice(0, admitted)) {
      const ran = result.tasks.find((entry) => entry.taskId === task.taskId);
      assert.ok(ran !== undefined && ran.attempts >= 1 && ran.outcome !== 'BUDGET_EXHAUSTED', `${task.taskType} ran before the grant ran out`);
    }

    // The accounting: the candidates of the unadmitted tasks are PENDING_BUDGET by ref, every other expected candidate keeps its one disposition, and the coverage says incomplete.
    const accounting = accountingOf(result);
    const expected = planCandidates(limited.input);
    assert.deepEqual(candidateAccountingProblems(expected, accounting.dispositions), [], 'every expected candidate has exactly one disposition');
    const ids = new Set(notAdmitted.map((task) => task.taskId));
    const pending = accounting.dispositions.filter((entry) => entry.disposition === 'PENDING_BUDGET');
    assert.ok(pending.length > 0, 'some candidates are pending for want of money');
    for (const entry of pending) assert.ok(entry.taskId !== null && ids.has(entry.taskId), `${entry.candidateRef} is pending on a task the grant did not admit`);
    for (const entry of accounting.dispositions.filter((candidate) => candidate.taskId !== null && ids.has(candidate.taskId))) assert.equal(entry.disposition, 'PENDING_BUDGET', `${entry.candidateRef} of an unadmitted task is PENDING_BUDGET`);
    assert.equal(accounting.coverage.complete, false);
    assert.equal(accounting.coverage.pendingCandidates, pending.length);
    assert.equal(accounting.coverage.complete, accounting.coverage.pendingCandidates === 0 && accounting.coverage.unresolvedCandidates === 0, 'complete is exactly "no pending and no unresolved candidate"');
    assert.equal(result.draft.coverage?.complete, false, 'the draft never presents itself as complete');
  });

  it('R2-037: one run across all twelve families accounts every expected candidate once, maps every decision to one fragment and every fragment to the effect Migration Core reports, with no FAMILY_NOT_PLANNED disposition left', TIMEOUT, async () => {
    const ran = await runClosure('SALESFORCE', { name: 'r2-037', repair: true });
    const { result } = ran;
    assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
    assert.equal(result.draft.status, 'SYSTEM_DRAFT');
    assert.equal(ran.observed.packageVerified, true);
    assert.deepEqual(askedOf(ran), [...FAMILIES].sort(), 'all twelve families were asked');

    // The accounting: the expected set fixed before any request, every candidate once, none left for a family nobody planned.
    const accounting = accountingOf(result);
    const expected = planCandidates(ran.input);
    assert.deepEqual(candidateAccountingProblems(expected, accounting.dispositions), [], 'the dispositions are the expected set, once each');
    assert.equal(accounting.dispositions.length, expected.candidates.length);
    assert.deepEqual(new Set(accounting.dispositions.map((entry) => entry.candidateRef)), new Set(expected.candidates.map((candidate) => candidate.candidateRef)));
    assert.equal(accounting.dispositions.filter((entry) => entry.code === 'FAMILY_NOT_PLANNED' || entry.code === 'QUESTION_NOT_PLANNED').length, 0, 'no candidate waits for a family nobody planned');
    for (const entry of accounting.dispositions) assert.ok((CANDIDATE_DISPOSITIONS as readonly string[]).includes(entry.disposition), `${entry.candidateRef}: ${entry.disposition} is a closed disposition`);
    assert.equal(accounting.coverage.complete, accounting.coverage.pendingCandidates === 0 && accounting.coverage.unresolvedCandidates === 0, 'complete is exactly "no pending and no unresolved candidate"');
    assert.deepEqual([accounting.coverage.complete, accounting.coverage.pendingCandidates, accounting.coverage.unresolvedCandidates], [true, 0, 0]);
    assert.equal(accounting.coverage.expectedCandidates, expected.candidates.length);
    assert.equal(accounting.coverage.accountedCandidates, expected.candidates.length);
    // The accounting check refuses a list that misses a candidate or repeats one.
    assert.notDeepEqual(candidateAccountingProblems(expected, accounting.dispositions.slice(1)), []);
    assert.notDeepEqual(candidateAccountingProblems(expected, [...accounting.dispositions, accounting.dispositions[0] as Disposition]), []);
    // Every family whose question the expected set fixed before the first request accounts a candidate; the review's contradictions and the repair round are found and made only as the run goes, and the dispositions they change are the ones asserted below.
    for (const family of FAMILIES.filter((type) => type !== 'SEMANTIC_REPAIR' && type !== 'CONSISTENCY_REVIEW')) assert.ok(accounting.dispositions.some((entry) => entry.family === family), `${family} accounts a candidate`);

    // Every decision that put something in the configuration has one fragment, and every fragment the effect the receipt reports under its hash.
    const draft = draftOf(result);
    const manifest = draft.fragmentCoverage;
    assert.ok(manifest !== undefined && manifest !== null, 'the draft carries the coverage manifest');
    assert.equal(manifest.complete, true, 'every fragment is observed in the receipt');
    assert.ok(manifest.entries.length > 0 && manifest.entries.every((entry) => entry.observed), 'each fragment is observed');
    // A decision may own more than one fragment (an object decision: the record and the columns of its file nothing else mapped); each decision-and-fragment pair is one entry, and none is a decision without a fragment or a fragment without a decision.
    const pairs = manifest.entries.map((entry) => `${entry.decisionRef}|${entry.fragmentHash}`);
    assert.equal(new Set(pairs).size, pairs.length, 'each decision-fragment pair is one entry');
    // A proposal answers the candidate it was asked about; a deterministic decision answers the originals Migration Core raised on its column, of which an exactly matched column may have none.
    for (const entry of manifest.entries) assert.ok(entry.decisionRef !== '' && (entry.origin === 'DETERMINISTIC' || entry.candidateRefs.length > 0), `the fragment ${entry.fragmentHash} names its decision and the candidates it answers`);
    // A decision that shapes a field another decision put in (a semantic type, a transformation, a value map) shares its fragment and answers for its own effect.
    for (const entry of manifest.entries) {
      const sharing: readonly { readonly expectedEffect: string }[] = manifest.entries.filter((other) => other.fragmentHash === entry.fragmentHash);
      assert.equal(new Set(sharing.map((other) => other.expectedEffect)).size, sharing.length, `the decisions sharing ${entry.fragmentHash} answer for distinct effects`);
    }
    const withFragment = draft.evidence.filter((entry) => entry.fragmentHash !== null);
    assert.ok(withFragment.length > 0);
    for (const entry of withFragment) {
      assert.ok(manifest.entries.some((candidate) => candidate.fragmentHash === entry.fragmentHash && (candidate.decisionRef === entry.candidateRef || candidate.candidateRefs.includes(entry.candidateRef))), `the decision ${entry.candidateRef} has its fragment in the manifest`);
    }
    const effects = effectsOf(result);
    const effectOf: Readonly<Record<string, string>> = { RECORD: 'records', FIELD: 'fields', ASSOCIATION: 'associations', PRESERVED_COLUMN: 'unmapped' };
    for (const entry of manifest.entries) {
      const reported = listOf(effects[effectOf[entry.fragmentKind] ?? '']).filter((effect) => effect['fragmentHash'] === entry.fragmentHash);
      assert.ok(reported.length >= 1, `${entry.fragmentKind} ${entry.fragmentHash} is reported by Migration Core under ${effectOf[entry.fragmentKind] ?? '?'}`);
    }

    // The effect each family has, as Migration Core reports it.
    const recordOf = (file: string, object: string): Loose | undefined => listOf(effects['records']).find((entry) => entry['recordMappingId'] === recordMappingIdOf(ran.fileId(file), object));
    assert.ok(recordOf('branches.csv', 'COMPANY') !== undefined, 'CAP01: the undeclared file is delivered as Company records');
    assert.ok(Number(fieldEffect(result, 'contact.city')?.['delivered']) > 0, 'CAP02 / CAP12: Home City, answered on the repair round, delivers contact.city');
    assert.ok(manifest.entries.some((entry) => entry.expectedEffect === 'TYPE_APPLIED' && entry.observed), 'CAP03: the semantic type is applied to the field it decides');
    assert.ok(Number(fieldEffect(result, 'company.annualRevenue')?.['changed']) > 0, 'CAP04: the decimal commas are normalised');
    assert.ok(Number(fieldEffect(result, 'contact.jobTitle')?.['changed']) > 0 && Number(fieldEffect(result, 'contact.country')?.['changed']) > 0, 'CAP05: the status and country values are mapped to the options');
    assert.ok((draft.identity?.records ?? []).some((record) => record.recordMappingId === recordMappingIdOf(ran.fileId('contacts.csv'), 'CONTACT') && record.authoritativeExternalIdColumns.length === 1), 'CAP06: the Customer Number is the contacts record\'s authoritative external id');
    assert.ok((draft.reviewGroups ?? []).length === 1 && (draft.reviewGroups ?? []).every((group) => group.observed), 'CAP07: the duplicate cluster is a review group Migration Core reports');
    assert.deepEqual((draft.associations ?? []).map((association) => [association.edgesDelivered, association.missingEndpoints]), [[3, 1]], 'CAP08: three edges delivered, the endpoint the bundle lacks reported');
    assert.ok(listOf(effects['unmapped']).some((entry) => entry['columnLocator'] === ran.locator('companies.csv', 'Region')), 'CAP09: the column no target holds is an unmapped leftover');
    assert.deepEqual((draft.requirements ?? []).map((entry) => [entry.destinationField, entry.status]), [['contact.lastName', 'SATISFIED']], 'CAP10: the required Last Name is satisfied');
    // CAP11: two claims for the required Last Name — the client's convention for one column, a header match in the requirement's task for the other — are each valid alone. The review names both with the class the compiler computed, preserves the strictly weaker, and Migration Core delivers the other.
    const sameScope = ran.sent.filter((entry) => entry.envelope.taskType === 'CONSISTENCY_REVIEW').flatMap((entry) => reviewClaimsOf(entry.envelope)).filter((claim) => claim.kind === 'SAME_SCOPE_TARGET');
    assert.equal(sameScope.length, 2, 'the review names the two claims for Last Name');
    const [weaker, stronger] = [...sameScope].sort((a, b) => (RANK[a.evidenceClass] ?? 0) - (RANK[b.evidenceClass] ?? 0));
    assert.ok(weaker !== undefined && stronger !== undefined && (RANK[weaker.evidenceClass] ?? 0) < (RANK[stronger.evidenceClass] ?? 0), `one claim is strictly weaker by computed class: ${JSON.stringify(sameScope.map((claim) => claim.evidenceClass))}`);
    const locatorOfClaim = (claim: ReviewClaimView): string | undefined => ran.contracts.refs.fieldByRef.get(claim.fieldRef)?.locator;
    assert.ok(listOf(effects['unmapped']).some((entry) => entry['columnLocator'] === locatorOfClaim(weaker)), 'CAP11: the weaker claim is an unmapped leftover Migration Core accounts');
    assert.ok(!listOf(effects['unmapped']).some((entry) => entry['columnLocator'] === locatorOfClaim(stronger)), 'CAP11: the stronger claim is delivered');
    assert.ok(Number(fieldEffect(result, 'contact.lastName')?.['delivered']) > 0, 'CAP11: Last Name is delivered once, from the stronger claim');
    assert.ok(accounting.dispositions.some((entry) => entry.disposition === 'PRESERVED' && entry.code === 'CONSISTENCY_REVIEW'), 'CAP11: the accounting names the review');
  });
});

/**
 * B03-CAP-VALUES — the three value-level capability families run the whole
 * chain, from the resolver's question to Migration Core's effect: CAP04
 * TRANSFORMATION_SELECTION, CAP05 VALUE_MAP and CAP10 TARGET_REQUIREMENT
 * (closure plan §3, D3-CAP-04, D3-CAP-05, D3-CAP-10; review finding B03-R9).
 *
 * Every case goes through the public run() with the real Migration Core in
 * the host's validation port (the vendored release, through its public
 * entry): the document it loads, the package it writes and the effects it
 * reports are read back here. The model is the labelled scripted gateway
 * (evidence class SIMULATED): it answers from the serialised request, as a
 * model would, and no provider is called.
 *
 * What a build without these families lacks is read through loose views
 * (the draft's requirements, the candidate types the resolver derives, the
 * project's locale evidence), so this file compiles on the stage-1 base and
 * its assertions say what is missing there.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { classifyMetadataText } from '../src/classifier/data-classifier.js';
import { compileProposal } from '../src/compiler/compiler.js';
import { declaredLocale } from '../src/compiler/parameter-evidence.js';
import { digestOf } from '../src/contracts/canonical.js';
import { REQUIREMENT_CANDIDATE_TYPE, TRANSFORM_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, TaskType } from '../src/contracts/envelope.js';
import { outputScopeOf } from '../src/contracts/output-scope.js';
import { DATE_FORMAT_DOMAIN } from '../src/contracts/proposal.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import { buildEnvelope } from '../src/envelope/envelope-builder.js';
import { resolve as resolveDeterministically } from '../src/resolver/deterministic-resolver.js';
import type { MemoryEntry } from '../src/contracts/run.js';
import { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION } from '../src/contracts/versions.js';
import { scriptedGateway } from '../src/gateway/fake-gateway.js';
import type { ScriptEntry, ScriptPayload, ScriptedGateway } from '../src/gateway/fake-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import { planCandidates } from '../src/planner/candidate-accounting.js';
import type { IntelligenceInput, ProjectRevision } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';
import type { Bundle, FixtureValidationPort } from './support/fixtures.js';

type Loose = Readonly<Record<string, unknown>>;
type HashedContract = ReturnType<typeof vendorContract>;
type ContractBody = HashedContract['contract'];
type ContractField = ContractBody['objects'][number]['fields'][number];
type Profiled = ReturnType<typeof profileBundle>;

// The vendored Migration Core release, reached through the peer dependency this package declares (as the egress harness reaches it): its contract hash is the attested one.
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly peerDependencies: Readonly<Record<string, string>> };
const peer = (await import(Object.keys(manifest.peerDependencies)[0] ?? '')) as { hashTargetContract(body: ContractBody): HashedContract };

const TIMEOUT = { timeout: 180_000 };
const DECLARED = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } as const;

// ------------------------------------------------------------------------------------------------------------ fixtures

const contractField = (apiName: string, label: string, type: string, extra: Partial<ContractField> = {}): ContractField => ({
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

/** The picklist the Status column is delivered into: HubSpot's lifecycle stage, labelled Status in this portal, with three options. */
const STATUS_OPTIONS = ['lead', 'opportunity', 'customer'] as const;
const STATUS_FIELD = contractField('lifecyclestage', 'Status', 'enumeration', { picklistValues: STATUS_OPTIONS.map((value) => ({ value, label: value, active: true, defaultValue: false })) });
const REVENUE_FIELD = contractField('annualrevenue', 'Annual Revenue', 'number');

/** The fixture HubSpot contract with fields added to its objects and the named `object.apiName` fields required: not nillable, not defaulted. */
function hubspotContract(options: { readonly contact?: readonly ContractField[]; readonly company?: readonly ContractField[]; readonly required?: readonly string[] } = {}): HashedContract {
  const base = vendorContract('HUBSPOT');
  const body: ContractBody = {
    ...base.contract,
    objects: base.contract.objects.map((object) => {
      const extra = object.apiName === 'contact' ? (options.contact ?? []) : object.apiName === 'company' ? (options.company ?? []) : [];
      const fields = [...object.fields, ...extra].map((field): ContractField => ((options.required ?? []).includes(`${object.apiName}.${field.apiName}`) ? { ...field, nillable: 'FALSE' } : field));
      return { ...object, fields };
    }),
  };
  return peer.hashTargetContract(body);
}

/** A two-file bundle whose record id columns are Email and Name, so no other column is an identity question. */
function bundleOf(name: string, contacts: string, companies = 'Name\nAnalytical Engines\nCOBOL Works\n'): Bundle {
  const made = makeBundle(name, { contacts, companies });
  return { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Email' : 'Name' })) };
}

/** Refs of the adapted contracts, by what a test names: a column by its file and header, a vendor target by its api name. */
interface Refs {
  field(file: string, header: string): string;
  locator(file: string, header: string): string;
  target(apiName: string): string;
}

function refsOf(profiled: Profiled, contract: HashedContract | null, mode: 'HUBSPOT' | 'CLEAN_ONLY'): Refs {
  const contracts = adaptContracts({ mode, profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
  const column = (file: string, header: string): readonly [string, { readonly locator: string }] => {
    const found = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.filePath === file && entry.header === header);
    assert.ok(found !== undefined, `${file} has a column ${header}`);
    return found;
  };
  return {
    field: (file, header) => column(file, header)[0],
    locator: (file, header) => column(file, header)[1].locator,
    target: (apiName) => {
      const found = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === apiName)?.[0];
      assert.ok(found !== undefined, `the contract carries ${apiName}`);
      return found;
    },
  };
}

// ------------------------------------------------------------------------------------------------------------ the model

type Answer = (candidate: DeterministicCandidate, envelope: IntelligenceEnvelopeV1) => Partial<ProposalItem> | 'OMIT' | null;

/** The abstention every candidate gets unless an answer says otherwise: allowed in every task. */
const abstention = (candidate: DeterministicCandidate): ProposalItem => ({ candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: candidate.evidenceRefs.slice(0, 32), requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, alternatives: [], abstainReason: 'INSUFFICIENT_EVIDENCE' });

/** A proposal built from the envelope the request carried, as a model reading it would: one item per candidate, as `answer` says. */
function proposalFor(envelope: IntelligenceEnvelopeV1, payload: ScriptPayload, answer: Answer): Record<string, unknown> {
  const items = envelope.deterministicCandidates.flatMap((candidate) => {
    const answered = answer(candidate, envelope);
    return answered === 'OMIT' ? [] : [{ ...abstention(candidate), ...(answered ?? {}) }];
  });
  return { schemaVersion: PROPOSAL_SCHEMA_VERSION, taskId: payload.taskId, runId: payload.runId, modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, envelopeHash: payload.envelopeHash, items, overallOutcome: 'MIXED' };
}

const answering = (answer: Answer): ScriptEntry => ({ kind: 'proposal', build: (envelope, payload) => proposalFor(envelope, payload, answer) });
const ABSTAIN_ALL = answering(() => null);

/** The L1 value a value candidate stands for: the exemplar its evidence names, the only place the value travels. */
const valueOf = (candidate: DeterministicCandidate, envelope: IntelligenceEnvelopeV1): string | null => envelope.exemplars.find((exemplar) => exemplar.dataLevel === 'L1' && candidate.evidenceRefs.includes(exemplar.exemplarRef))?.minimizedValueOrClass ?? null;

// ------------------------------------------------------------------------------------------------------------ one run

type Script = Partial<Record<TaskType | 'default', ScriptEntry | readonly ScriptEntry[]>>;

interface Scenario {
  readonly name: string;
  readonly mode: 'HUBSPOT' | 'CLEAN_ONLY';
  readonly contacts: string;
  readonly companies?: string;
  readonly contract: HashedContract | null;
  /** The host's categorical summaries, by file and header. */
  readonly summaries?: readonly (readonly [string, string, readonly string[]])[];
  /** The project's declared locale evidence (D3-CAP-04). */
  readonly locale?: Readonly<Record<string, string>>;
  readonly memory?: (refs: Refs) => readonly MemoryEntry[];
  readonly script: (refs: Refs) => Script;
}

interface Ran {
  readonly result: IntelligenceResult;
  readonly port: FixtureValidationPort;
  readonly gateway: ScriptedGateway;
  readonly refs: Refs;
  readonly input: IntelligenceInput;
}

async function withRun(scenario: Scenario, check: (ran: Ran) => void | Promise<void>): Promise<void> {
  const bundle = bundleOf(scenario.name, scenario.contacts, scenario.companies);
  try {
    const profiled = profileBundle(bundle, scenario.mode);
    const refs = refsOf(profiled, scenario.contract, scenario.mode);
    const clock = new VirtualClock();
    const port = realValidationPort(bundle, profiled.profile, scenario.contract, { clock });
    const gateway = scriptedGateway({ default: ABSTAIN_ALL, ...scenario.script(refs) });
    const summaries = new Map((scenario.summaries ?? []).map(([file, header, values]) => [refs.locator(file, header), values] as const));
    const base = inputFor(scenario.mode, profiled, scenario.contract, { categoricalSummaries: summaries, scopedMemorySnapshot: scenario.memory?.(refs) ?? [] });
    const projectRevision = { ...base.projectRevision, declaredObjects: DECLARED, ...(scenario.locale === undefined ? {} : { localeEvidence: scenario.locale }) } as ProjectRevision;
    const input: IntelligenceInput = { ...base, projectRevision };
    const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, CONTEXT);
    await check({ result, port, gateway, refs, input });
  } finally {
    bundle.dispose();
  }
}

// ------------------------------------------------------------------------------------------------------------ reading back

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** RFC 4180 rows: quoted cells, doubled quotes, CRLF or LF. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** One file of the package Migration Core wrote, by the area it sits in and its name, as header-keyed records. */
function packageFile(port: FixtureValidationPort, area: string, name: string): readonly Readonly<Record<string, string>>[] {
  assert.ok(port.lastPackage !== null, 'Migration Core wrote a package');
  const path = filesUnder(join(port.lastPackage.stagingDir, area)).find((file) => file.endsWith(`${sep}${name}`));
  assert.ok(path !== undefined, `the package holds ${area}/${name}`);
  const [header, ...rows] = csvRows(readFileSync(path, 'utf8'));
  assert.ok(header !== undefined);
  return rows.filter((row) => row.some((cell) => cell !== '')).map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
}

/** The values Migration Core delivered under an import header, row by row. */
const delivered = (port: FixtureValidationPort, file: string, header: string): readonly string[] => packageFile(port, '01_IMPORT', file).map((row) => {
  assert.ok(header in row, `${file} delivers a ${header} column: ${Object.keys(row).join(', ')}`);
  return row[header] ?? '';
});

/** The field element Migration Core's loader made of the document it was handed, by destination. */
function loadedField(port: FixtureValidationPort, destinationField: string): Loose | undefined {
  assert.ok(port.lastLoaded !== null, 'Migration Core loaded a configuration');
  const records = ((port.lastLoaded.normalizedJson as Loose)['records'] ?? []) as readonly Loose[];
  return records.flatMap((record) => (record['fields'] ?? []) as readonly Loose[]).find((field) => field['destinationField'] === destinationField);
}

const optionsOf = (field: Loose | undefined): Loose => ((field?.['options'] ?? {}) as Loose);

/** Every code the public log records for the attempts of a run's tasks. */
const attemptCodes = (result: IntelligenceResult, attempt: number): readonly string[] => result.runLedger.flatMap((event) => (event.kind === 'TASK_OUTCOME' && (event as { readonly attempt?: number }).attempt === attempt ? [...((event as { readonly codes?: readonly string[] }).codes ?? [])] : []));

const dispositionsOf = (result: IntelligenceResult): readonly Loose[] => ((result.candidateAccounting as unknown as Loose | null)?.['dispositions'] ?? []) as readonly Loose[];
const unresolvedCodes = (result: IntelligenceResult): readonly string[] => result.unresolvedItems.flatMap((item) => [...item.codes]);

// ------------------------------------------------------------------------------------------------------------ the cases

// Local numbers written with hyphens: the full-data profile shapes them as local digits and nothing else (space-grouped digits would read as a grouped number too).
const NUMBERS_CONTACTS = 'Email,Phone\nada@kauro-fixture.test,612-345-678\ngrace@kauro-fixture.test,622-334-455\n';
const NUMBERS_COMPANIES = 'Name,Annual Revenue\nAnalytical Engines,"1234,56"\nCOBOL Works,"99,5"\nDifference Works,"1000,75"\n';

describe('B03-CAP-VALUES: transformation parameters, value maps and target requirements, from the question to what Migration Core delivers', () => {
  it("CAP04: NORMALISE_NUMBER with decimalSeparator ',' on a column the full-data profile shapes as decimal-comma is compiled and Migration Core delivers the normalised numbers", TIMEOUT, async () => {
    // The revenue column holds only decimal-comma values over the whole file; the phone column holds local numbers and the project declares Spain as the region its numbers are dialled in.
    const script = (): Script => ({
      TRANSFORMATION_SELECTION: answering((candidate) => {
        if (candidate.allowedPrimitiveRefs.includes('NORMALISE_NUMBER')) return { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'NORMALISE_NUMBER', typedTransformParams: { decimalSeparator: ',' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
        if (candidate.allowedPrimitiveRefs.includes('PARSE_PHONE_E164')) return { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'PARSE_PHONE_E164', typedTransformParams: { defaultRegion: 'ES' }, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null };
        return null;
      }),
    });
    await withRun({ name: 'cap04-positive', mode: 'HUBSPOT', contacts: NUMBERS_CONTACTS, companies: NUMBERS_COMPANIES, contract: hubspotContract({ company: [REVENUE_FIELD] }), locale: { defaultRegion: 'ES' }, script }, ({ result, port, gateway, refs }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const asked = gateway.requests.filter((request) => request.envelope.taskType === 'TRANSFORMATION_SELECTION');
      assert.equal(asked.length, 1, `one TRANSFORMATION_SELECTION task: ${JSON.stringify(result.tasks.map((task) => task.taskType))}`);
      const candidates = asked[0]?.envelope.deterministicCandidates ?? [];
      // The candidate lists only the primitive its shape admits, and the parameter values its evidence admits.
      const revenue = candidates.find((candidate) => candidate.sourceRefs.includes(refs.field('companies.csv', 'Annual Revenue')));
      assert.deepEqual(revenue?.allowedPrimitiveRefs, ['NORMALISE_NUMBER']);
      assert.deepEqual((revenue as unknown as Loose | undefined)?.['allowedParamValues'], { decimalSeparator: [','] });
      const phone = candidates.find((candidate) => candidate.sourceRefs.includes(refs.field('contacts.csv', 'Phone')));
      assert.deepEqual(phone?.allowedPrimitiveRefs, ['PARSE_PHONE_E164']);
      assert.deepEqual((phone as unknown as Loose | undefined)?.['allowedParamValues'], { defaultRegion: ['ES'] });
      // The loaded configuration carries the options, and Migration Core changed the delivered values.
      assert.deepEqual([optionsOf(loadedField(port, 'company.annualRevenue'))['decimalSeparator'], optionsOf(loadedField(port, 'company.annualRevenue'))['thousandsSeparator']], [',', 'NONE']);
      assert.equal(optionsOf(loadedField(port, 'contact.phone'))['phoneCountry'], 'ES');
      assert.deepEqual([...delivered(port, 'companies.csv', 'Annual revenue')].sort(), ['1000.75', '1234.56', '99.5']);
      assert.deepEqual([...delivered(port, 'contacts.csv', 'Phone number')].sort(), ['+34612345678', '+34622334455']);
      const effects = result.draft.fullValidation?.effects;
      assert.equal(effects?.fields.find((field) => field.destinationField === 'company.annualRevenue')?.changed, 3, 'Migration Core changed every revenue value');
      assert.equal(effects?.fields.find((field) => field.destinationField === 'company.annualRevenue')?.flagged, 0);
      // The proposal is in the draft beside the deterministic mapping it parameterises, both on the field's fragment.
      const fragment = result.draft.configuration?.fields.find((field) => field.destinationField === 'company.annualRevenue');
      assert.ok(fragment !== undefined);
      const proposed = result.draft.evidence.find((entry) => entry.origin === 'PROPOSED' && entry.transformPrimitive === 'NORMALISE_NUMBER');
      assert.deepEqual([proposed?.typedTransformParams, proposed?.fragmentHash], [{ decimalSeparator: ',' }, fragment.fragmentHash]);
      // Migration Core's own ambiguous-shape candidates on both columns are answered by the family their route names, never left unplanned.
      const originals = dispositionsOf(result).filter((entry) => entry['candidateType'] === 'AMBIGUOUS_SHAPE_COLUMN');
      assert.ok(originals.length >= 2, JSON.stringify(originals));
      for (const original of originals) assert.deepEqual([original['family'], original['disposition']], ['TRANSFORMATION_SELECTION', 'PROPOSED'], JSON.stringify(original));
    });
    // A slash date is read under the date format the project declares, and delivered as ISO dates (CLEAN_ONLY: the canonical createdAt).
    const dates = (): Script => ({ TRANSFORMATION_SELECTION: answering((candidate) => (candidate.allowedPrimitiveRefs.includes('PARSE_DATE_ISO') ? { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'PARSE_DATE_ISO', typedTransformParams: { dateFormat: 'DD/MM/YYYY' }, rationaleCode: 'HEADER_MATCHES_TARGET_API_NAME', abstainReason: null } : null)) });
    await withRun({ name: 'cap04-dates', mode: 'CLEAN_ONLY', contacts: 'Email,Created At\nada@kauro-fixture.test,31/12/2025\ngrace@kauro-fixture.test,03/04/2026\n', contract: null, locale: { dateFormat: 'DD/MM/YYYY' }, script: dates }, ({ result, port }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(optionsOf(loadedField(port, 'contact.createdAt'))['dateFormat'], 'DD/MM/YYYY');
      assert.deepEqual([...delivered(port, 'contacts.csv', 'contact.createdAt')].sort(), ['2025-12-31', '2026-04-03']);
    });
  });

  it('CAP04: a separator the shape facts contradict, a phone region nothing evidences or a primitive the candidate does not carry is refused, and Migration Core applies no such option', TIMEOUT, async () => {
    // No locale is declared. The first answer names a point separator for a decimal-comma column and a region for local numbers; the repair abstains.
    const unevidenced = (): Script => ({
      TRANSFORMATION_SELECTION: answering((candidate) => {
        if (candidate.allowedPrimitiveRefs.includes('NORMALISE_NUMBER')) return { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'NORMALISE_NUMBER', typedTransformParams: { decimalSeparator: '.' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null };
        if (candidate.allowedPrimitiveRefs.includes('PARSE_PHONE_E164')) return { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'PARSE_PHONE_E164', typedTransformParams: { defaultRegion: 'ES' }, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', abstainReason: null };
        return null;
      }),
      SEMANTIC_REPAIR: ABSTAIN_ALL,
    });
    await withRun({ name: 'cap04-unevidenced', mode: 'HUBSPOT', contacts: NUMBERS_CONTACTS, companies: NUMBERS_COMPANIES, contract: hubspotContract({ company: [REVENUE_FIELD] }), script: unevidenced }, ({ result, port }) => {
      const first = attemptCodes(result, 1);
      assert.equal(first.filter((code) => code === 'PARAM_NOT_EVIDENCED').length, 2, `both parameters refused: ${JSON.stringify(first)}`);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      // Migration Core was handed neither option: it reads the separator and the country as unknown and flags the values instead of guessing.
      assert.equal(optionsOf(loadedField(port, 'company.annualRevenue'))['decimalSeparator'] ?? null, null);
      assert.equal(optionsOf(loadedField(port, 'contact.phone'))['phoneCountry'] ?? null, null);
      const flags = packageFile(port, '03_TRACEABILITY', 'flags.csv');
      assert.equal(flags.filter((flag) => flag['destination_field'] === 'company.annualRevenue' && flag['reason_code'] === 'TRANSFORM_NUMBER_AMBIGUOUS_SEPARATORS').length, 3);
      assert.equal(flags.filter((flag) => flag['destination_field'] === 'contact.phone' && flag['reason_code'] === 'TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE').length, 2);
      assert.ok(result.draft.evidence.every((entry) => entry.origin !== 'PROPOSED'), 'no refused parameter is in the draft');
    });
    // A primitive the candidate does not carry is forbidden outright: nothing reaches Migration Core.
    const foreign = (): Script => ({ TRANSFORMATION_SELECTION: answering((candidate) => (candidate.allowedPrimitiveRefs.includes('NORMALISE_NUMBER') ? { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'PARSE_DATE_ISO', typedTransformParams: { dateFormat: 'DD/MM/YYYY' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null } : null)) });
    await withRun({ name: 'cap04-foreign', mode: 'HUBSPOT', contacts: NUMBERS_CONTACTS, companies: NUMBERS_COMPANIES, contract: hubspotContract({ company: [REVENUE_FIELD] }), locale: { dateFormat: 'DD/MM/YYYY' }, script: foreign }, ({ result, port }) => {
      const transform = result.tasks.find((task) => task.taskType === 'TRANSFORMATION_SELECTION');
      assert.equal(transform?.outcome, 'FORBIDDEN_PROPOSAL', JSON.stringify(result.tasks));
      assert.ok(transform?.codes.includes('PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE'), JSON.stringify(transform?.codes));
      assert.equal(result.state, 'FAILED_COMPILER');
      assert.equal(result.draft.configuration, null);
      assert.equal(port.calls, 0, 'Migration Core was never handed a configuration');
    });
  });

  it("CAP05: a complete value map from every L1 value of a status column to options of the target picklist is compiled into one valueMap with the contract's allowedValues, and Migration Core delivers the mapped options", TIMEOUT, async () => {
    const MAP: Readonly<Record<string, string>> = { Nuevo: 'lead', Abierto: 'opportunity', Ganado: 'customer' };
    const script = (): Script => ({ VALUE_MAP: answering((candidate, envelope) => {
      const value = valueOf(candidate, envelope);
      const to = value === null ? undefined : MAP[value];
      return to === undefined ? null : { proposalType: 'MAP_ENUM_VALUE', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { to }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', abstainReason: null };
    }) });
    const contacts = 'Email,Status\nada@kauro-fixture.test,Nuevo\ngrace@kauro-fixture.test,Abierto\nalan@kauro-fixture.test,Ganado\nedsger@kauro-fixture.test,lead\nbarbara@kauro-fixture.test,Abierto\n';
    await withRun({ name: 'cap05-positive', mode: 'HUBSPOT', contacts, contract: hubspotContract({ contact: [STATUS_FIELD] }), summaries: [['contacts.csv', 'Status', ['Nuevo', 'Abierto', 'Ganado', 'lead']]], script }, ({ result, port, gateway, refs, input }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      // One candidate per L1 value that is not already an option, each keyed by its value and carrying it only as its exemplar.
      const asked = gateway.requests.filter((request) => request.envelope.taskType === 'VALUE_MAP');
      assert.equal(asked.length, 1, `one VALUE_MAP task: ${JSON.stringify(result.tasks.map((task) => task.taskType))}`);
      const envelope = asked[0]?.envelope;
      assert.ok(envelope !== undefined);
      const values = envelope.deterministicCandidates.map((candidate) => valueOf(candidate, envelope));
      assert.deepEqual([...values].sort(), ['Abierto', 'Ganado', 'Nuevo']);
      assert.ok(envelope.deterministicCandidates.every((candidate) => candidate.candidateType === 'DERIVED_VALUE_DECISION' && candidate.sourceRefs.length === 1 && candidate.sourceRefs[0] === refs.field('contacts.csv', 'Status') && candidate.allowedTargetRefs.length === 1 && candidate.allowedTargetRefs[0] === refs.target('lifecyclestage')));
      assert.ok(envelope.deterministicCandidates.every((candidate) => !JSON.stringify(candidate).includes('Abierto')), 'a value candidate names its value by ref only');
      // planCandidates fixes the same value candidates before any request.
      const expected = planCandidates(input);
      assert.deepEqual(expected.candidates.filter((candidate) => candidate.candidateType === 'DERIVED_VALUE_DECISION').map((candidate) => candidate.candidateRef).sort(), envelope.deterministicCandidates.map((candidate) => candidate.candidateRef).sort());
      // One valueMap, from the host's summaries to the options, with the contract's allowedValues, as Migration Core loaded it.
      const status = loadedField(port, 'contact.lifecycleStage');
      assert.equal(status?.['semanticType'], 'ENUM');
      assert.deepEqual(optionsOf(status)['allowedValues'], [...STATUS_OPTIONS]);
      const valueMap = (optionsOf(status)['valueMap'] ?? []) as readonly { readonly from: string; readonly to: string }[];
      assert.deepEqual([...valueMap].map((entry) => `${entry.from}->${entry.to}`).sort(), ['Abierto->opportunity', 'Ganado->customer', 'Nuevo->lead']);
      assert.equal(result.draft.configuration?.fields.filter((field) => field.destinationField === 'contact.lifecycleStage').length, 1, 'one field carries the whole map');
      // Every row is delivered as an option, and nothing is flagged.
      assert.deepEqual([...delivered(port, 'contacts.csv', 'Lifecycle stage')].sort(), ['customer', 'lead', 'lead', 'opportunity', 'opportunity']);
      assert.equal(result.draft.fullValidation?.effects?.fields.find((field) => field.destinationField === 'contact.lifecycleStage')?.flagged, 0);
      assert.deepEqual(dispositionsOf(result).filter((entry) => entry['candidateType'] === 'DERIVED_VALUE_DECISION').map((entry) => [entry['family'], entry['disposition']]), [['VALUE_MAP', 'PROPOSED'], ['VALUE_MAP', 'PROPOSED'], ['VALUE_MAP', 'PROPOSED']]);
    });
  });

  it('CAP05: a value map to an option the contract does not list, from a value the envelope never carried, incomplete over the column or on CLEAN_ONLY is refused; no value is silently delivered outside allowedValues', TIMEOUT, async () => {
    const contacts = 'Email,Status\nada@kauro-fixture.test,Nuevo\ngrace@kauro-fixture.test,Abierto\nalan@kauro-fixture.test,Ganado\nedsger@kauro-fixture.test,lead\nbarbara@kauro-fixture.test,Abierto\n';
    const summaries = [['contacts.csv', 'Status', ['Nuevo', 'Abierto', 'Ganado', 'lead']]] as const;
    const contract = hubspotContract({ contact: [STATUS_FIELD] });
    const MAP: Readonly<Record<string, string>> = { Nuevo: 'lead', Abierto: 'opportunity', Ganado: 'customer' };
    const mapped = (candidate: DeterministicCandidate, envelope: IntelligenceEnvelopeV1, override: Partial<ProposalItem> = {}): Partial<ProposalItem> | null => {
      const value = valueOf(candidate, envelope);
      const to = value === null ? undefined : MAP[value];
      return to === undefined ? null : { proposalType: 'MAP_ENUM_VALUE', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { to }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', abstainReason: null, ...override };
    };
    /** What Migration Core did with the Status values no map covers: each flagged, none delivered silently. */
    const flaggedOutsideOptions = (port: FixtureValidationPort): void => {
      const flags = packageFile(port, '03_TRACEABILITY', 'flags.csv').filter((flag) => flag['destination_field'] === 'contact.lifecycleStage');
      assert.deepEqual(flags.map((flag) => flag['reason_code']), ['TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET', 'TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET', 'TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET', 'TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET']);
      assert.deepEqual(optionsOf(loadedField(port, 'contact.lifecycleStage'))['valueMap'] ?? [], [], 'no value map was loaded');
    };
    // An option the contract does not list: refused; the repair abstains and every value outside the options is flagged.
    await withRun({ name: 'cap05-not-an-option', mode: 'HUBSPOT', contacts, contract, summaries, script: () => ({ VALUE_MAP: answering((candidate, envelope) => mapped(candidate, envelope, valueOf(candidate, envelope) === 'Nuevo' ? { typedTransformParams: { to: 'prospect' } } : {})), SEMANTIC_REPAIR: ABSTAIN_ALL }) }, ({ result, port }) => {
      assert.ok(attemptCodes(result, 1).includes('ENUM_VALUE_NOT_IN_TARGET_OPTIONS'), JSON.stringify(attemptCodes(result, 1)));
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      flaggedOutsideOptions(port);
    });
    // A value the envelope never carried, written by the model as `from`: `from` is no parameter of a value map; the pair comes from the host's summaries only.
    await withRun({ name: 'cap05-model-from', mode: 'HUBSPOT', contacts, contract, summaries, script: () => ({ VALUE_MAP: answering((candidate, envelope) => mapped(candidate, envelope, valueOf(candidate, envelope) === 'Nuevo' ? { typedTransformParams: { from: 'Borrador', to: 'lead' } } : {})), SEMANTIC_REPAIR: ABSTAIN_ALL }) }, ({ result, port }) => {
      assert.ok(attemptCodes(result, 1).includes('UNKNOWN_PARAM'), JSON.stringify(attemptCodes(result, 1)));
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      flaggedOutsideOptions(port);
      assert.ok(!JSON.stringify(port.lastLoaded?.normalizedJson).includes('Borrador'));
    });
    // Incomplete over the column: one value left unanswered twice — the map is refused, never applied in part.
    await withRun({ name: 'cap05-incomplete', mode: 'HUBSPOT', contacts, contract, summaries, script: () => { const partial = answering((candidate, envelope) => (valueOf(candidate, envelope) === 'Ganado' ? 'OMIT' : mapped(candidate, envelope))); return { VALUE_MAP: partial, SEMANTIC_REPAIR: partial }; } }, ({ result, port }) => {
      const task = result.tasks.find((entry) => entry.taskType === 'VALUE_MAP');
      assert.ok(task !== undefined, JSON.stringify(result.tasks));
      assert.ok(attemptCodes(result, 1).includes('VALUE_MAP_INCOMPLETE') && attemptCodes(result, 2).includes('VALUE_MAP_INCOMPLETE'), JSON.stringify([attemptCodes(result, 1), attemptCodes(result, 2)]));
      assert.equal(task.outcome, 'INVALID_SEMANTICS');
      assert.equal(result.state, 'FAILED_COMPILER');
      assert.equal(port.calls, 0, 'no partial map reached Migration Core');
    });
    // A host summary that does not hold every value of the column cannot make a complete map: no value question is asked, and Migration Core flags every value outside the options.
    await withRun({ name: 'cap05-partial-summary', mode: 'HUBSPOT', contacts, contract, summaries: [['contacts.csv', 'Status', ['Nuevo', 'Abierto', 'lead']]], script: () => ({}) }, ({ result, port }) => {
      assert.ok(result.tasks.every((task) => task.taskType !== 'VALUE_MAP'), JSON.stringify(result.tasks));
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      flaggedOutsideOptions(port);
    });
    // CLEAN_ONLY has no options: a value map there is forbidden (here in the repair round, where the repair's permissions name it), and nothing reaches Migration Core.
    const cleanOnly = (): Script => ({
      FIELD_MAPPING: answering((candidate) => ({ proposalType: 'UNMAPPED_PRESERVE', evidenceRefs: ['ev_0000000000000000'], rationaleCode: 'NO_TARGET_IN_ENVELOPE', abstainReason: null, targetRef: null })),
      SEMANTIC_REPAIR: answering((candidate) => ({ proposalType: 'MAP_ENUM_VALUE', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { to: 'lead' }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', abstainReason: null })),
    });
    await withRun({ name: 'cap05-clean-only', mode: 'CLEAN_ONLY', contacts: 'Email,Estado\nada@kauro-fixture.test,Nuevo\ngrace@kauro-fixture.test,Abierto\n', contract: null, summaries: [['contacts.csv', 'Estado', ['Nuevo', 'Abierto']]], script: cleanOnly }, ({ result, port }) => {
      const codes = [...attemptCodes(result, 2), ...unresolvedCodes(result)];
      assert.ok(codes.includes('CLEAN_ONLY_HAS_NO_ENUM_AUTHORITY'), JSON.stringify(codes));
      assert.equal(result.state, 'FAILED_COMPILER');
      assert.equal(port.calls, 0);
    });
  });

  it('CAP10: a TARGET_REQUIREMENT answer maps Surname to the required Last Name; Migration Core marks the field required and sets aside the row that lacks it, and the draft names the requirement', TIMEOUT, async () => {
    const contacts = 'Email,Surname\nada@kauro-fixture.test,Lovelace\ngrace@kauro-fixture.test,\nalan@kauro-fixture.test,Turing\n';
    // The client's verified convention: its Surname columns are the portal's Last Name.
    const memory = (refs: Refs): readonly MemoryEntry[] => [{ memoryId: 'mem_5a5b5c5d5e5f6061', scope: 'CLIENT', tenant: CONTEXT.tenant, knowledgeType: 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: 'Surname', targetRef: refs.target('lastname'), semanticType: null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'run r task t', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 }];
    const script = (refs: Refs): Script => ({
      FIELD_MAPPING: answering(() => ({ proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null })),
      TARGET_REQUIREMENT: answering((candidate) => (candidate.sourceRefs[0] === refs.field('contacts.csv', 'Surname') ? { proposalType: 'MAP_FIELD', targetRef: refs.target('lastname'), transformPrimitive: null, rationaleCode: 'MEMORY_CONVENTION_APPLIES', abstainReason: null } : null)),
    });
    await withRun({ name: 'cap10-positive', mode: 'HUBSPOT', contacts, contract: hubspotContract({ required: ['contact.lastname'] }), memory, script }, ({ result, port, gateway, refs }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const asked = gateway.requests.filter((request) => request.envelope.taskType === 'TARGET_REQUIREMENT');
      assert.equal(asked.length, 1, `one TARGET_REQUIREMENT task: ${JSON.stringify(result.tasks.map((task) => task.taskType))}`);
      const candidate = asked[0]?.envelope.deterministicCandidates.find((entry) => entry.sourceRefs[0] === refs.field('contacts.csv', 'Surname'));
      assert.deepEqual(candidate?.allowedTargetRefs, [refs.target('lastname')], 'the requirement names its target and a plausible column of its record mapping');
      // required is set on the Migration Core field, and the row without a surname is set aside, not delivered.
      assert.equal(loadedField(port, 'contact.lastName')?.['required'], true);
      assert.deepEqual([...delivered(port, 'contacts.csv', 'Last name')].sort(), ['Lovelace', 'Turing']);
      const isolated = packageFile(port, '02_EXCEPTIONS', 'isolated.csv');
      assert.equal(isolated.length, 1, JSON.stringify(isolated));
      assert.deepEqual([isolated[0]?.['file_path'], isolated[0]?.['row_number'], isolated[0]?.['field']], ['contacts.csv', '3', 'contact.lastName']);
      assert.equal(result.draft.fullValidation?.effects?.fields.find((field) => field.destinationField === 'contact.lastName')?.setAside, 1);
      // The draft names the requirement and the fragment that satisfies it.
      const fragment = result.draft.configuration?.fields.find((field) => field.destinationField === 'contact.lastName');
      assert.equal(fragment?.required, true);
      const requirements = ((result.draft as unknown as Loose)['requirements'] ?? []) as readonly Loose[];
      assert.deepEqual(requirements.map((entry) => [entry['destinationField'], entry['status'], entry['decisionRef']]), [['contact.lastName', 'SATISFIED', fragment?.decisionRef]]);
      assert.ok(result.draft.decisionsRequired.every((entry) => !entry.reason.includes('contact.lastName')), JSON.stringify(result.draft.decisionsRequired));
    });
  });

  it('CAP10: a requirement claimed for a target the contract does not mark required is refused, and a required target nothing satisfies is a blocking agency decision, never a drafted mapping', TIMEOUT, async () => {
    const contract = hubspotContract({ required: ['contact.lastname'] });
    // First Name is not required: a requirement claimed for it is refused. Since B03-CAP-STRUCTURE a FIELD_MAPPING answer may not be a requirement at all (D3-CAP-02), so the claim is refused twice over, and the run fails closed at the compiler; the requirement is the TARGET_REQUIREMENT task's alone (D3-CAP-10).
    const claimed = (refs: Refs): Script => ({
      FIELD_MAPPING: answering((candidate) => (candidate.sourceRefs[0] === refs.field('contacts.csv', 'Nickname') ? { proposalType: 'BLOCKING_TARGET_REQUIREMENT', targetRef: refs.target('firstname'), requiresAgencyDecision: true, rationaleCode: 'REQUIRED_TARGET_UNSATISFIED', abstainReason: null } : { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null })),
    });
    await withRun({ name: 'cap10-denial-claim', mode: 'HUBSPOT', contacts: 'Email,Nickname\nada@kauro-fixture.test,Countess\ngrace@kauro-fixture.test,Amazing\n', contract, script: claimed }, ({ result, port }) => {
      assert.ok(attemptCodes(result, 1).includes('REQUIREMENT_NOT_IN_CONTRACT'), JSON.stringify(attemptCodes(result, 1)));
      assert.ok(attemptCodes(result, 1).includes('PROPOSAL_TYPE_NOT_ALLOWED_FOR_TASK'), JSON.stringify(attemptCodes(result, 1)));
      assert.equal(result.state, 'FAILED_COMPILER');
      assert.equal(port.calls, 0, 'a forbidden claim reached Migration Core');
    });
    // Nickname is no Last Name: the requirement task says it blocks, and the FIELD_MAPPING answer preserves.
    const script = (refs: Refs): Script => ({
      FIELD_MAPPING: answering(() => ({ proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null })),
      SEMANTIC_REPAIR: answering(() => ({ proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null })),
      TARGET_REQUIREMENT: answering((candidate) => ({ proposalType: 'BLOCKING_TARGET_REQUIREMENT', targetRef: candidate.allowedTargetRefs[0] ?? null, requiresAgencyDecision: true, rationaleCode: 'REQUIRED_TARGET_UNSATISFIED', abstainReason: null })),
    });
    await withRun({ name: 'cap10-denial', mode: 'HUBSPOT', contacts: 'Email,Nickname\nada@kauro-fixture.test,Countess\ngrace@kauro-fixture.test,Amazing\n', contract, script }, ({ result, port }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const requirement = result.tasks.find((task) => task.taskType === 'TARGET_REQUIREMENT');
      assert.equal(requirement?.outcome, 'REQUIRES_AGENCY_DECISION', JSON.stringify(result.tasks));
      // The blocking requirement is the agency's decision; no field delivers Last Name and none is required.
      assert.ok(result.draft.decisionsRequired.some((entry) => entry.reason === 'REQUIRED_TARGET_UNSATISFIED:contact.lastName'), JSON.stringify(result.draft.decisionsRequired));
      assert.equal(result.draft.configuration?.fields.some((field) => field.destinationField === 'contact.lastName'), false);
      assert.equal(loadedField(port, 'contact.lastName'), undefined);
      assert.ok(!(result.draft.configuration?.fields ?? []).some((field) => field.required), 'no field is required that no requirement names');
      const requirements = ((result.draft as unknown as Loose)['requirements'] ?? []) as readonly Loose[];
      assert.deepEqual(requirements.map((entry) => [entry['destinationField'], entry['status']]), [['contact.lastName', 'BLOCKING']]);
      assert.ok(dispositionsOf(result).some((entry) => entry['family'] === 'TARGET_REQUIREMENT' && entry['disposition'] === 'AGENCY_DECISION' && entry['code'] === 'BLOCKING_TARGET_REQUIREMENT'), JSON.stringify(dispositionsOf(result)));
    });
    // With no column that could hold it, the requirement blocks on facts alone: no question, no request, the agency's decision in the draft.
    await withRun({ name: 'cap10-no-source', mode: 'HUBSPOT', contacts: 'Email\nada@kauro-fixture.test\ngrace@kauro-fixture.test\n', contract, script: () => ({}) }, ({ result, gateway }) => {
      assert.equal(gateway.calls, 0, 'nothing to ask the model');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.ok(result.draft.decisionsRequired.some((entry) => entry.reason === 'REQUIRED_TARGET_UNSATISFIED:contact.lastName'), JSON.stringify(result.draft.decisionsRequired));
      assert.equal(result.draft.configuration?.fields.some((field) => field.destinationField === 'contact.lastName'), false);
    });
  });

  it('sentinel (value-map channel): a person-shaped value in a status column makes no value candidate, never leaves in a request or the result, and Migration Core flags it instead of delivering it silently', TIMEOUT, async () => {
    const contacts = 'Email,Status\nada@kauro-fixture.test,Nuevo\ngrace@kauro-fixture.test,Abierto\nalan@kauro-fixture.test,Okonkwo\n';
    await withRun({ name: 'cap05-sentinel', mode: 'HUBSPOT', contacts, contract: hubspotContract({ contact: [STATUS_FIELD] }), summaries: [['contacts.csv', 'Status', ['Nuevo', 'Abierto', 'Okonkwo']]], script: () => ({}) }, ({ result, port, gateway, input }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      // The column authorises itself whole or nothing from it travels: no value of it is a candidate, not even the safe ones.
      assert.equal(planCandidates(input).candidates.filter((candidate) => candidate.candidateType === 'DERIVED_VALUE_DECISION').length, 0);
      assert.ok(result.tasks.every((task) => task.taskType !== 'VALUE_MAP'));
      for (const request of gateway.requests) assert.ok(!JSON.stringify(request).includes('Okonkwo'), 'the person-shaped value never leaves');
      assert.ok(!JSON.stringify(result).includes('Okonkwo'), 'nor is it in the public result');
      const flags = packageFile(port, '03_TRACEABILITY', 'flags.csv').filter((flag) => flag['destination_field'] === 'contact.lifecycleStage');
      assert.equal(flags.filter((flag) => flag['preserved_value'] === 'Okonkwo' && flag['reason_code'] === 'TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET').length, 1);
    });
    // Options travel redacted: a person-named option of the picklist never reaches the model, and a value map onto it is refused even though the contract lists it.
    const personOption = contractField('lifecyclestage', 'Status', 'enumeration', { picklistValues: [...STATUS_OPTIONS, 'Okonkwo'].map((value) => ({ value, label: value, active: true, defaultValue: false })) });
    const ontoPerson = (): Script => ({ VALUE_MAP: answering((candidate, envelope) => ({ proposalType: 'MAP_ENUM_VALUE', targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { to: valueOf(candidate, envelope) === 'Nuevo' ? 'Okonkwo' : 'lead' }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', abstainReason: null })), SEMANTIC_REPAIR: ABSTAIN_ALL });
    await withRun({ name: 'cap05-sentinel-option', mode: 'HUBSPOT', contacts: 'Email,Status\nada@kauro-fixture.test,Nuevo\ngrace@kauro-fixture.test,Abierto\n', contract: hubspotContract({ contact: [personOption] }), summaries: [['contacts.csv', 'Status', ['Nuevo', 'Abierto']]], script: ontoPerson }, ({ result, gateway, port }) => {
      const asked = gateway.requests.filter((request) => request.envelope.taskType === 'VALUE_MAP');
      assert.equal(asked.length, 1, JSON.stringify(result.tasks));
      for (const request of gateway.requests) assert.ok(!JSON.stringify(request).includes('Okonkwo'), 'the person-named option never leaves');
      assert.ok(attemptCodes(result, 1).includes('ENUM_VALUE_NOT_IN_TARGET_OPTIONS'), JSON.stringify(attemptCodes(result, 1)));
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.ok(!((optionsOf(loadedField(port, 'contact.lifecycleStage'))['valueMap'] ?? []) as readonly { readonly to: string }[]).some((entry) => entry.to === 'Okonkwo'), 'no value is mapped onto the person');
    });
  });

  it('sentinel (locale channel): a declared region that is no ISO 3166 country — a surname in two capitals — is refused before anything is spent and never travels as a parameter value', TIMEOUT, async () => {
    await withRun({ name: 'cap04-sentinel', mode: 'HUBSPOT', contacts: NUMBERS_CONTACTS, companies: NUMBERS_COMPANIES, contract: hubspotContract({ company: [REVENUE_FIELD] }), locale: { defaultRegion: 'WU' }, script: () => ({}) }, ({ result, gateway, port }) => {
      assert.equal(result.state, 'FAILED_CONTRACT', JSON.stringify(result.unresolvedItems));
      assert.ok(unresolvedCodes(result).includes('LOCALE_EVIDENCE_MALFORMED'), JSON.stringify(unresolvedCodes(result)));
      assert.equal(gateway.calls, 0);
      assert.equal(port.calls, 0);
    });
    // The egress decision re-reads the channel on the envelope itself: a candidate that offers a region outside the closed list does not leave, whatever built it.
    const bundle = bundleOf('cap04-sentinel-egress', NUMBERS_CONTACTS, NUMBERS_COMPANIES);
    try {
      const contract = hubspotContract({ company: [REVENUE_FIELD] });
      const bench = benchOf(bundle, contract, { defaultRegion: 'ES' });
      const phone = bench.derived.find((candidate) => candidate.candidateType === TRANSFORM_CANDIDATE_TYPE && candidate.allowedPrimitiveRefs.includes('PARSE_PHONE_E164'));
      assert.ok(phone !== undefined);
      assert.deepEqual(phone.allowedParamValues, { defaultRegion: ['ES'] });
      assert.equal(bench.envelope('TRANSFORMATION_SELECTION', [phone]).egress.decision, 'EGRESS_ALLOWED');
      const forged = bench.envelope('TRANSFORMATION_SELECTION', [{ ...phone, allowedParamValues: { defaultRegion: ['WU'] } }]);
      assert.equal(forged.egress.decision, 'EGRESS_BLOCKED_POLICY');
      assert.ok(forged.egress.blockedReasons.includes('a parameter value outside its closed domain is in the envelope'), JSON.stringify(forged.egress.blockedReasons));
    } finally {
      bundle.dispose();
    }
  });

  it("guard: the date formats a PARSE_DATE_ISO may name are exactly the dateFormat enum of the configuration schema the vendored Migration Core release ships", () => {
    const schemaUrl = new URL('../../spec/contract/config.schema.json', import.meta.resolve(Object.keys(manifest.peerDependencies)[0] ?? ''));
    const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as unknown;
    const enums: string[][] = [];
    const walk = (node: unknown, underDateFormat: boolean): void => {
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry, underDateFormat);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (underDateFormat && key === 'enum' && Array.isArray(value)) enums.push(value.filter((entry): entry is string => typeof entry === 'string'));
        walk(value, underDateFormat || key === 'dateFormat');
      }
    };
    walk(schema, false);
    assert.ok(enums.length > 0, 'the schema declares the dateFormat enum');
    for (const found of enums) assert.deepEqual(found, [...DATE_FORMAT_DOMAIN]);
  });

  it('guard: a transformation names its primitive, the parameter it needs and the destination its column is mapped to; a value map maps a value the envelope carried; a blocking requirement names its target and is not satisfied by this answer or an earlier one', TIMEOUT, async () => {
    const bundle = bundleOf('cap-values-guard', 'Email,Status,Surname,Nickname\nada@kauro-fixture.test,Nuevo,Lovelace,Countess\ngrace@kauro-fixture.test,Abierto,Hopper,Amazing\n', NUMBERS_COMPANIES);
    try {
      const contract = hubspotContract({ contact: [STATUS_FIELD], company: [REVENUE_FIELD], required: ['contact.lastname'] });
      const bench = benchOf(bundle, contract, {}, [['contacts.csv', 'Status', ['Nuevo', 'Abierto']]]);
      const revenue = bench.derived.find((candidate) => candidate.candidateType === TRANSFORM_CANDIDATE_TYPE && candidate.sourceRefs[0] === bench.refs.field('companies.csv', 'Annual Revenue'));
      assert.ok(revenue !== undefined);
      const transform = bench.envelope('TRANSFORMATION_SELECTION', [revenue]);
      const codes = (built: typeof transform, items: readonly Partial<ProposalItem>[], extra: { readonly decisions?: typeof bench.resolution.decisions; readonly priorClaims?: ReadonlySet<string> } = {}): readonly string[] => bench.compile(built, items, extra).codes;
      const applying = { candidateRef: revenue.candidateRef, proposalType: 'APPLY_SUPPORTED_TRANSFORM' as const, targetRef: revenue.allowedTargetRefs[0] ?? null, transformPrimitive: 'NORMALISE_NUMBER' as const, typedTransformParams: { decimalSeparator: ',' }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE' as const, abstainReason: null };
      assert.deepEqual(codes(transform, [applying]), [], 'the evidenced answer compiles clean');
      assert.ok(codes(transform, [{ ...applying, typedTransformParams: null }]).includes('PARAM_REQUIRED'));
      assert.ok(codes(transform, [{ ...applying, transformPrimitive: null, typedTransformParams: null }]).includes('PRIMITIVE_REQUIRED'));
      assert.ok(codes(transform, [applying], { decisions: bench.resolution.decisions.filter((decision) => !(decision.kind === 'FIELD_MAPPING' && decision.fieldRef === revenue.sourceRefs[0])) }).includes('TRANSFORM_WITHOUT_MAPPING'));
      // A value candidate whose exemplar the envelope does not carry maps nothing.
      const values = bench.derived.filter((candidate) => candidate.candidateType === VALUE_CANDIDATE_TYPE);
      assert.equal(values.length, 2);
      const valueMap = bench.envelope('VALUE_MAP', values);
      const mapping = values.map((candidate) => ({ candidateRef: candidate.candidateRef, proposalType: 'MAP_ENUM_VALUE' as const, targetRef: candidate.allowedTargetRefs[0] ?? null, transformPrimitive: 'MAP_ENUM_VALUE' as const, typedTransformParams: { to: 'lead' }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' as const, abstainReason: null }));
      assert.deepEqual(codes(valueMap, mapping), []);
      assert.ok(codes({ ...valueMap, envelope: { ...valueMap.envelope, exemplars: [] } }, mapping).includes('VALUE_NOT_IN_ENVELOPE'));
      // A requirement names its target; it is not blocking when this answer, or a task before it, maps the target in its record mapping.
      const field = bench.derived.find((candidate) => candidate.candidateType === 'DERIVED_FIELD_DECISION' && candidate.sourceRefs[0] === bench.refs.field('contacts.csv', 'Nickname'));
      assert.ok(field !== undefined);
      assert.ok(codes(bench.envelope('FIELD_MAPPING', [field]), [{ candidateRef: field.candidateRef, proposalType: 'BLOCKING_TARGET_REQUIREMENT', targetRef: null, requiresAgencyDecision: true, rationaleCode: 'REQUIRED_TARGET_UNSATISFIED', abstainReason: null }]).includes('REQUIREMENT_WITHOUT_TARGET'));
      const pairs = bench.derived.filter((candidate) => candidate.candidateType === REQUIREMENT_CANDIDATE_TYPE);
      const surname = pairs.find((candidate) => candidate.sourceRefs[0] === bench.refs.field('contacts.csv', 'Surname'));
      const nickname = pairs.find((candidate) => candidate.sourceRefs[0] === bench.refs.field('contacts.csv', 'Nickname'));
      assert.ok(surname !== undefined && nickname !== undefined);
      const requirement = bench.envelope('TARGET_REQUIREMENT', [surname, nickname]);
      const blocking = (candidate: DeterministicCandidate): Partial<ProposalItem> => ({ candidateRef: candidate.candidateRef, proposalType: 'BLOCKING_TARGET_REQUIREMENT', targetRef: candidate.allowedTargetRefs[0] ?? null, requiresAgencyDecision: true, rationaleCode: 'REQUIRED_TARGET_UNSATISFIED', abstainReason: null });
      assert.deepEqual(codes(requirement, [blocking(surname), blocking(nickname)]), [], 'nothing satisfies it: a blocking requirement, the agency decides');
      assert.ok(codes(requirement, [{ candidateRef: surname.candidateRef, proposalType: 'MAP_FIELD', targetRef: bench.refs.target('lastname'), rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null }, blocking(nickname)]).includes('REQUIREMENT_HAS_MAPPING'), 'the same answer maps it');
      const recordId = bench.resolution.decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === nickname.sourceRefs[0])?.recordId ?? null;
      assert.ok(codes(requirement, [blocking(surname), blocking(nickname)], { priorClaims: new Set([outputScopeOf(recordId, 'contact.lastName')]) }).includes('REQUIREMENT_HAS_MAPPING'), 'an earlier task mapped it');
      // Every refusal these families add is a closed code the repair round can name to the model: the classifier reads it as structural and never masks it.
      for (const code of ['PARAM_REQUIRED', 'PARAM_NOT_EVIDENCED', 'PRIMITIVE_REQUIRED', 'TRANSFORM_WITHOUT_MAPPING', 'VALUE_NOT_IN_ENVELOPE', 'VALUE_MAP_INCOMPLETE', 'REQUIREMENT_WITHOUT_TARGET', 'REQUIREMENT_NOT_IN_CONTRACT', 'REQUIREMENT_HAS_MAPPING']) assert.equal(classifyMetadataText(code, 'IDENTIFIER').dataClass, 'SAFE_STRUCTURAL_METADATA', code);
    } finally {
      bundle.dispose();
    }
  });

  it('guard: a field-level answer and a requirement that map the same column into the same required target are one field of the configuration, required, which both decisions account for', TIMEOUT, async () => {
    const contacts = 'Email,Surname\nada@kauro-fixture.test,Lovelace\ngrace@kauro-fixture.test,\n';
    const memory = (refs: Refs): readonly MemoryEntry[] => [{ memoryId: 'mem_5a5b5c5d5e5f6062', scope: 'CLIENT', tenant: CONTEXT.tenant, knowledgeType: 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: 'Surname', targetRef: refs.target('lastname'), semanticType: null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'run r task t', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 }];
    const mapSurname = (refs: Refs): ScriptEntry => answering((candidate) => (candidate.sourceRefs[0] === refs.field('contacts.csv', 'Surname') && candidate.allowedTargetRefs.includes(refs.target('lastname')) ? { proposalType: 'MAP_FIELD', targetRef: refs.target('lastname'), transformPrimitive: null, rationaleCode: 'MEMORY_CONVENTION_APPLIES', abstainReason: null } : null));
    await withRun({ name: 'cap10-twice', mode: 'HUBSPOT', contacts, contract: hubspotContract({ required: ['contact.lastname'] }), memory, script: (refs) => ({ FIELD_MAPPING: mapSurname(refs), TARGET_REQUIREMENT: mapSurname(refs) }) }, ({ result, port }) => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const fields = (result.draft.configuration?.fields ?? []).filter((field) => field.destinationField === 'contact.lastName');
      assert.equal(fields.length, 1);
      assert.equal(fields[0]?.required, true);
      assert.equal(loadedField(port, 'contact.lastName')?.['required'], true);
      const entry = result.draft.fragmentCoverage?.entries.find((candidate) => candidate.fragmentKind === 'FIELD' && candidate.fragmentHash === fields[0]?.fragmentHash);
      assert.equal(entry?.candidateRefs.length, 2, 'the field-level and the requirement decision both name the fragment');
    });
  });

  it('guard: a requirement over a wide file is one bounded question — at most thirty-two plausible columns, those whose header shares a word with the target first', TIMEOUT, async () => {
    const mystery = Array.from({ length: 40 }, (unused, index) => `Mystery ${String(index + 1)}`);
    const headers = ['Email', ...mystery, 'Last Name Alt'];
    const row = (email: string, value: string): string => [email, ...mystery.map(() => value), 'Lovelace'].join(',');
    const bundle = bundleOf('cap10-wide', `${headers.join(',')}\n${row('ada@kauro-fixture.test', 'qq')}\n${row('grace@kauro-fixture.test', 'zz')}\n`);
    try {
      const bench = benchOf(bundle, hubspotContract({ required: ['contact.lastname'] }), {});
      const pairs = bench.derived.filter((candidate) => candidate.candidateType === REQUIREMENT_CANDIDATE_TYPE);
      assert.equal(pairs.length, 32);
      assert.ok(pairs.some((candidate) => candidate.sourceRefs[0] === bench.refs.field('contacts.csv', 'Last Name Alt')), 'the column that names the target is offered, though it is the last one');
      const question = bench.resolution.openQuestions.filter((entry) => entry.taskType === 'TARGET_REQUIREMENT');
      assert.deepEqual(question.map((entry) => entry.candidateRefs.length), [32], 'one question for the one requirement');
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------ the pieces of the chain, for the guards

const RUN_ID = 'run_0123456789abcdef';

/** The adapted contracts and the resolver's derived candidates of a HubSpot bundle, with an envelope builder and a compiler over them: what a run does, one piece at a time. */
function benchOf(bundle: Bundle, contract: HashedContract, locale: Readonly<Record<string, string>>, summarised: readonly (readonly [string, string, readonly string[]])[] = []) {
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const refs = refsOf(profiled, contract, 'HUBSPOT');
  const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
  const summaries = new Map(summarised.map(([file, header, values]) => [refs.locator(file, header), values] as const));
  const resolution = resolveDeterministically(contracts, { declaredObjects: DECLARED, categoricalSummaries: summaries, localeEvidence: locale });
  const budgetSnapshot = { maxInputTokens: 200_000, maxOutputTokens: 8_192, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-29T01:00:00.000Z' };
  const envelope = (taskType: TaskType, candidates: readonly DeterministicCandidate[]) => buildEnvelope({ task: { taskId: `task_${digestOf([taskType, candidates.map((candidate) => candidate.candidateRef)]).slice(0, 16)}`, taskType, partitionKey: `${taskType}:0`, candidateRefs: candidates.map((candidate) => candidate.candidateRef), order: 0 }, contracts, candidates, memoryEvidence: [], summaries, projectRevisionId: 'rev-1', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot, repairContext: null, egressSecret: Buffer.alloc(32, 7), tenant: CONTEXT.tenant, attemptId: CONTEXT.auditAttemptId });
  const compile = (built: ReturnType<typeof envelope>, items: readonly Partial<ProposalItem>[], extra: { readonly decisions?: typeof resolution.decisions; readonly priorClaims?: ReadonlySet<string> } = {}) => {
    const byRef = new Map(built.envelope.deterministicCandidates.map((candidate) => [candidate.candidateRef, candidate]));
    const proposal = { schemaVersion: PROPOSAL_SCHEMA_VERSION, taskId: built.envelope.taskId, runId: RUN_ID, modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, envelopeHash: built.hash, items: items.map((item) => { const candidate = byRef.get(item.candidateRef ?? ''); assert.ok(candidate !== undefined, 'an item answers a candidate of the envelope'); return { ...abstention(candidate), ...item }; }), overallOutcome: 'MIXED' as const };
    return compileProposal({ envelope: built.envelope, envelopeHash: built.hash, proposal, runId: RUN_ID, contracts, decisions: extra.decisions ?? resolution.decisions, locale: declaredLocale(locale).locale, ...(extra.priorClaims === undefined ? {} : { priorClaims: extra.priorClaims }) });
  };
  return { refs, contracts, resolution, derived: resolution.derivedCandidates, envelope, compile };
}

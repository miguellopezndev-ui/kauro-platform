/**
 * B03-CAP-STRUCTURE — the structural capability families OBJECT_MAPPING,
 * FIELD_MAPPING, SEMANTIC_TYPE and UNMAPPED_HANDLING (closure plan D3-CAP-01,
 * 02, 03 and 09; review finding B03-R9).
 *
 * Every case goes through the public run() with the real Migration Core in
 * the host's validation port (the vendored release, through its public
 * entry), and every positive reads its effect back from what Migration Core
 * loaded and wrote: the record object and the field types of the loaded
 * configuration, the delivered rows of 01_IMPORT, the flags and the unmapped
 * leftovers of the package. The model is a labelled fake: a transport that
 * answers from the serialised request with the oracle's proposal, rewritten
 * per case as a model would answer it (evidence class SIMULATED). No
 * provider is called.
 *
 * Members this closure adds to the envelope and the manifest are read through
 * loose views, so that this file states the contract the core must meet
 * without leaning on the types of the build under test.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { planCandidates } from '../src/index.js';
import type { CandidateAccounting, CandidateDisposition, ExpectedCandidateSet } from '../src/index.js';
import { adaptContracts } from '../src/adapter/contract-adapter.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import { cleanOnlyTargetRef } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import type { ProposalItem, RationaleCode } from '../src/contracts/proposal.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { buildProviderRequest, parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { CandidateConfiguration, FullDatasetValidationPort, IntelligenceInput } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, profileConfig, realValidationPort, vendorContract } from './support/fixtures.js';
import type { Bundle, FixtureValidationPort } from './support/fixtures.js';

// ---------------------------------------------------------------------------------------------------------- the peer

type Hashed = ReturnType<typeof vendorContract>;
type ContractField = Hashed['contract']['objects'][number]['fields'][number];
type Profiled = ReturnType<typeof profileBundle>;

/** The vendored Migration Core, loaded by the name package.json gives it (the fixtures do the same), for the dry run and the contracts this file builds. */
interface Peer {
  readonly SCRATCH_BUDGET_BYTES: number;
  hashTargetContract(body: Hashed['contract']): Hashed;
  loadConfig(text: string, where: string): { readonly config: unknown; readonly configHash: string };
  createFilesystemScratchStore(options: { readonly root: string; readonly runId: string; readonly quotaBytes: number }): { dispose(): void };
  runMigration(input: Readonly<Record<string, unknown>>): { readonly truth: unknown };
  buildCandidateSet(input: { readonly profile: Profiled['profile']; readonly configHash: string; readonly truth?: unknown }): Profiled['candidateSet'];
}
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly peerDependencies: Readonly<Record<string, string>> };
const peer = (await import(Object.keys(manifest.peerDependencies)[0] ?? '')) as Peer;

// -------------------------------------------------------------------------------------------------- loose views

type Loose = Readonly<Record<string, unknown>>;
type Mode = 'CLEAN_ONLY' | 'HUBSPOT' | 'SALESFORCE';

/** The object ref a mode's support envelope names an object by (closure plan D3-CAP-01): obj_ and sixteen hex of the digest of mode:object. */
const objectRef = (mode: Mode, object: string): string => `obj_${digestOf(`${mode}:${object}`).slice(0, 16)}`;
const OBJECTS = ['COMPANY', 'CONTACT', 'DEAL', 'LEAD'];

/** The object channel an OBJECT_MAPPING envelope carries: the objects its candidates may name, and the file-level facts per candidate and object. */
const objectTargetsOf = (envelope: IntelligenceEnvelopeV1): readonly Loose[] => ((envelope as unknown as Loose)['objectTargets'] as readonly Loose[] | undefined) ?? [];
const objectFactsOf = (envelope: IntelligenceEnvelopeV1): readonly Loose[] => ((envelope as unknown as Loose)['objectFacts'] as readonly Loose[] | undefined) ?? [];

/** The manifest entries of a result's draft, loosely. */
const manifestOf = (result: IntelligenceResult): readonly Loose[] => ((result.draft as unknown as { readonly fragmentCoverage?: { readonly entries?: readonly Loose[] } | null }).fragmentCoverage?.entries ?? []);

function accounting(result: IntelligenceResult): CandidateAccounting {
  assert.ok(result.candidateAccounting !== null, 'the result carries its candidate accounting');
  return result.candidateAccounting;
}
const dispositionOf = (result: IntelligenceResult, ref: string): CandidateDisposition | undefined => accounting(result).dispositions.find((entry) => entry.candidateRef === ref);

/** The ledger's TASK_OUTCOME facts of a result, read loosely. */
const taskOutcomes = (result: IntelligenceResult): { readonly taskId: string; readonly attempt: number; readonly outcome: string; readonly codes: readonly string[] }[] =>
  (result.runLedger as unknown as { readonly kind: string; readonly taskId?: string; readonly attempt?: number; readonly outcome?: string; readonly codes?: readonly string[] }[])
    .filter((event) => event.kind === 'TASK_OUTCOME')
    .map((event) => ({ taskId: event.taskId ?? '', attempt: event.attempt ?? 0, outcome: event.outcome ?? '', codes: event.codes ?? [] }));

/** A record mapping and its fields as Migration Core's loader normalized them. */
interface LoadedRecord {
  readonly id: string;
  readonly fileId: string;
  readonly object: string;
  readonly fields: readonly { readonly destinationField: string; readonly semanticType: string; readonly onInvalid: string; readonly column: { readonly index: number | null } }[];
}
function loadedRecords(port: FixtureValidationPort): readonly LoadedRecord[] {
  assert.ok(port.lastLoaded !== null, 'Migration Core loaded a configuration');
  return (port.lastLoaded.normalizedJson as { readonly records: readonly LoadedRecord[] }).records;
}

// --------------------------------------------------------------------------------------------------- the package

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** A CSV of the package as rows keyed by its header (quoted cells, doubled quotes). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/u, '');
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] as string;
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.filter((entry) => entry.length > 1 || (entry[0] ?? '') !== '').map((entry) => Object.fromEntries((header ?? []).map((name, index) => [name, entry[index] ?? ''])));
}

/** Every package file whose path ends with the given one (forward slashes), parsed. */
function packageRows(port: FixtureValidationPort, suffix: string): Record<string, string>[] {
  assert.ok(port.lastPackage !== null, 'Migration Core wrote a package');
  const matches = filesUnder(port.lastPackage.stagingDir).filter((path) => path.split('\\').join('/').endsWith(suffix));
  assert.ok(matches.length > 0, `the package holds ${suffix}`);
  return matches.flatMap((path) => parseCsv(readFileSync(path, 'utf8')));
}

// ----------------------------------------------------------------------------------------------- the model and the port

interface Asked {
  readonly envelope: IntelligenceEnvelopeV1;
  readonly candidate: DeterministicCandidate;
  /** True on the repair round: the envelope carries a repair context. */
  readonly repair: boolean;
}
type Answer = (item: ProposalItem, asked: Asked) => ProposalItem | null;

/** A transport answering from the serialised request with the oracle's proposal, each item rewritten by the case (or dropped). */
function answeringTransport(answer: Answer): Transport {
  return async (request: ProviderRequest) => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    const envelope = payload.envelope;
    const proposal = oracleProposal(envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
    const items = proposal.items.flatMap((item) => {
      const candidate = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef);
      if (candidate === undefined) return [item];
      const rewritten = answer(item, { envelope, candidate, repair: envelope.repairContext !== null });
      return rewritten === null ? [] : [rewritten];
    });
    const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
    const text = JSON.stringify({ ...proposal, items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED' });
    return { status: 200, body: { id: 'msg_b03_cap_structure', type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
}

/** A gateway over a transport that records every GatewayRequest it was handed. */
function recordingGateway(transport: Transport): ModelGateway & { readonly requests: GatewayRequest[] } {
  const inner = transportGateway(transport);
  const requests: GatewayRequest[] = [];
  return {
    name: 'b03-cap-structure-recording',
    evidenceClass: inner.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      return inner.analyze(request);
    },
  };
}

/** The host's validation port over the real Migration Core, recording every configuration it was handed. */
function recordingPort(real: FixtureValidationPort): FullDatasetValidationPort & { readonly configurations: CandidateConfiguration[]; readonly real: FixtureValidationPort } {
  const configurations: CandidateConfiguration[] = [];
  return {
    configurations,
    real,
    async validate(configuration: CandidateConfiguration) {
      configurations.push(configuration);
      return real.validate(configuration);
    },
  };
}

/** One public run with the answering model and the real port; the requests, the port and the result. */
async function runWith(bundle: Bundle, profiled: Profiled, contract: Hashed | null, input: IntelligenceInput, attemptId: string, answer: Answer): Promise<{ readonly result: IntelligenceResult; readonly requests: readonly GatewayRequest[]; readonly port: ReturnType<typeof recordingPort> }> {
  const clock = new VirtualClock();
  const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
  const gateway = recordingGateway(answeringTransport(answer));
  const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: attemptId });
  return { result, requests: gateway.requests, port };
}

// --------------------------------------------------------------------------------------------------- answers

const bare = (item: ProposalItem): ProposalItem => ({ ...item, targetRef: null, transformPrimitive: null, typedTransformParams: null, requiresAgencyDecision: false, shortRationale: null, alternatives: [], abstainReason: null });
const mapObject = (item: ProposalItem, ref: string, rationaleCode: RationaleCode): ProposalItem => ({ ...bare(item), proposalType: 'MAP_OBJECT', targetRef: ref, rationaleCode });
const mapField = (item: ProposalItem, targetRef: string, rationaleCode: RationaleCode): ProposalItem => ({ ...bare(item), proposalType: 'MAP_FIELD', targetRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode });
const selectType = (item: ProposalItem, semanticType: string, rationaleCode: RationaleCode = 'SHAPE_MATCHES_TARGET_TYPE'): ProposalItem => ({ ...bare(item), proposalType: 'SELECT_SEMANTIC_TYPE', typedTransformParams: { semanticType }, rationaleCode });
const preserve = (item: ProposalItem): ProposalItem => ({ ...bare(item), proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'NO_TARGET_IN_ENVELOPE', abstainReason: 'NO_VALID_TARGET' });
const abstain = (item: ProposalItem): ProposalItem => ({ ...bare(item), proposalType: 'ABSTAIN', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: 'INSUFFICIENT_EVIDENCE' });

// ----------------------------------------------------------------------------------------------------- fixtures

const TIMEOUT = { timeout: 240_000 };
const CONTACTS = 'Email,First Name\nada@kauro-fixture.test,Ada\ngrace@kauro-fixture.test,Grace\n';
const COMPANIES = 'Name,Website\nAnalytical Engines,https://analytical.test\nCOBOL Works,https://cobol.test\n';
const DECLARED = { 'contacts.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const };

/**
 * The declared contacts and companies files, and undeclared files whose
 * headers — Name and Description — name COMPANY and DEAL fields twice each:
 * a tie. Their Web column is URL-shaped over the full data, which a COMPANY
 * field can hold and no DEAL field can.
 */
const BRANCHES = 'Name,Description,Web\nNorth Office,Head office,https://north.test\nSouth Office,Sales office,https://south.test\nEast Office,Support office,https://east.test\n';
const OUTLETS = 'Name,Description,Web\nHarbour Outlet,Port shop,https://harbour.test\nStation Outlet,Rail shop,https://station.test\n';

function tiedBundle(name: string, extra: readonly { readonly path: string; readonly text: string }[], options: { readonly contacts?: string; readonly companies?: string } = {}): Bundle {
  const made = makeBundle(name, { contacts: options.contacts ?? CONTACTS, companies: options.companies ?? COMPANIES });
  for (const file of extra) writeFileSync(join(made.root, file.path), file.text);
  // The read configuration the profile is made under names a header each file holds; the files it adds read as COMPANY there, which the run never learns.
  const base = made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Email' : 'Name' }));
  return { ...made, files: [...base, ...extra.map((file) => ({ id: file.path.replace(/\.csv$/u, ''), path: file.path, idHeader: 'Name', object: 'COMPANY' }))] };
}

function cleanInput(profiled: Profiled, declared: Readonly<Record<string, 'CONTACT' | 'COMPANY' | 'DEAL' | 'LEAD'>> = DECLARED): IntelligenceInput {
  const base = inputFor('CLEAN_ONLY', profiled, null);
  return { ...base, projectRevision: { ...base.projectRevision, declaredObjects: declared } };
}

/** A profiled column of one file, by header. */
function columnOf(contracts: AdaptedContracts, filePath: string, header: string): { readonly fieldRef: string; readonly locator: string; readonly fileId: string; readonly columnIndex: number } {
  const entry = [...contracts.refs.fieldByRef.entries()].find(([, info]) => info.filePath === filePath && info.header === header);
  assert.ok(entry !== undefined, `${filePath} has a ${header} column`);
  return { fieldRef: entry[0], locator: entry[1].locator, fileId: entry[1].fileId, columnIndex: entry[1].columnIndex };
}
const fieldRefsOf = (contracts: AdaptedContracts, filePath: string): string[] => [...contracts.refs.fieldByRef.entries()].filter(([, info]) => info.filePath === filePath).map(([fieldRef]) => fieldRef);
const cleanContracts = (profiled: Profiled): AdaptedContracts => adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });

/** The object candidate of a file in an envelope: the OBJECT_MAPPING candidate over the file's columns. */
const objectCandidateIn = (envelope: IntelligenceEnvelopeV1, fieldRefs: readonly string[]): DeterministicCandidate | undefined => (envelope.taskType === 'OBJECT_MAPPING' ? envelope.deterministicCandidates.find((candidate) => candidate.sourceRefs.length > 0 && candidate.sourceRefs.every((ref) => fieldRefs.includes(ref))) : undefined);

// =================================================================================================================== CAP01

describe('B03-CAP-STRUCTURE — CAP01 OBJECT_MAPPING: an evidenced MAP_OBJECT decides a tied file, and phase two resolves its fields (D3-CAP-01)', () => {
  it('CAP01: a file whose headers tie between two objects, with a full-data shape only one of them can hold, is mapped to that object by an evidenced MAP_OBJECT; its fields are then resolved and Migration Core delivers its rows as records of that object', TIMEOUT, async () => {
    const bundle = tiedBundle('b03-cap01', [{ path: 'branches.csv', text: BRANCHES }]);
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const branches = fieldRefsOf(contracts, 'branches.csv');
      const web = columnOf(contracts, 'branches.csv', 'Web');
      const input = cleanInput(profiled);
      const { result, requests, port } = await runWith(bundle, profiled, null, input, 'b03-cap01', (item, asked) => {
        if (asked.envelope.taskType === 'OBJECT_MAPPING') return mapObject(item, objectRef('CLEAN_ONLY', 'COMPANY'), 'SHAPE_MATCHES_TARGET_TYPE');
        if (asked.candidate.sourceRefs[0] === web.fieldRef) return mapField(item, cleanOnlyTargetRef('company.website'), 'SHAPE_MATCHES_TARGET_TYPE');
        return item;
      });

      // Phase one: the file's object is a question whose candidate may name the objects the support envelope delivers, by their refs.
      const objectRequest = requests.find((request) => objectCandidateIn(request.envelope, branches) !== undefined);
      assert.ok(objectRequest !== undefined, 'the tied file is an OBJECT_MAPPING question');
      const objectCandidate = objectCandidateIn(objectRequest.envelope, branches) as DeterministicCandidate;
      assert.ok(objectRequest.envelope.constraints.allowedProposalTypes.includes('MAP_OBJECT'), 'the envelope permits MAP_OBJECT');
      for (const object of ['COMPANY', 'DEAL']) {
        assert.ok(objectCandidate.allowedTargetRefs.includes(objectRef('CLEAN_ONLY', object)), `${object} is among the candidate's objects`);
        assert.ok(objectRequest.envelope.constraints.allowedTargetIds.includes(objectRef('CLEAN_ONLY', object)), `${object} is among the envelope's allowed target ids`);
      }
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');

      // Phase two: the file's fields are resolved under COMPANY — Name and Description decided on facts, Web asked and answered.
      const webRequest = requests.find((request) => request.envelope.taskType === 'FIELD_MAPPING' && request.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === web.fieldRef));
      assert.ok(webRequest !== undefined, 'phase two asks about the Web column');
      assert.ok(requests.indexOf(webRequest) > requests.indexOf(objectRequest), 'after the object decision');
      assert.ok(webRequest.envelope.deterministicCandidates.find((candidate) => candidate.sourceRefs[0] === web.fieldRef)?.allowedTargetRefs.includes(cleanOnlyTargetRef('company.website')), "the Web column's candidate offers COMPANY targets");

      // The effect: the record object Migration Core loaded, the fields it delivered, the rows it wrote as COMPANY records.
      const record = loadedRecords(port.real).find((entry) => entry.fileId === web.fileId);
      assert.ok(record !== undefined, 'Migration Core received a record mapping for the tied file');
      assert.equal(record.object, 'COMPANY');
      assert.deepEqual(record.fields.map((field) => field.destinationField).sort(), ['company.description', 'company.name', 'company.website']);
      const effects = result.draft.fullValidation?.effects;
      assert.ok(effects !== undefined && effects !== null);
      const recordEffect = effects.records.find((entry) => entry.recordMappingId === record.id);
      assert.deepEqual([recordEffect?.object, recordEffect?.deliveredRecords], ['COMPANY', 3], 'Migration Core delivered the three rows as COMPANY records');
      const delivered = packageRows(port.real, '01_IMPORT/clean-only/companies.csv');
      for (const [name, site] of [['North Office', 'https://north.test'], ['South Office', 'https://south.test'], ['East Office', 'https://east.test']] as const) {
        assert.ok(delivered.some((row) => row['company.name'] === name && row['company.website'] === site), `${name} is a delivered COMPANY record with its website`);
      }

      // The decision behind the record: the model's MAP_OBJECT, on the fact it claimed, observed in Migration Core's run.
      const fragment = result.draft.configuration?.records.find((entry) => entry.fileId === web.fileId);
      assert.ok(fragment !== undefined);
      assert.equal(fragment.decisionRef, objectCandidate.candidateRef, 'the record fragment names the object decision');
      const entry = manifestOf(result).find((candidate) => candidate['fragmentKind'] === 'RECORD' && candidate['decisionRef'] === objectCandidate.candidateRef);
      assert.deepEqual([entry?.['origin'], entry?.['rule'], entry?.['observed'], entry?.['fragmentHash']], ['PROPOSED', 'SHAPE_MATCHES_TARGET_TYPE', true, fragment.fragmentHash]);

      // The accounting: the object candidate proposed, the file's columns resolved in phase two — two on facts, Web by the model — and no column left waiting.
      const expected = planCandidates(input);
      assert.equal(accounting(result).expectedSetHash, expected.expectedSetHash, 'the run accounts for the set planCandidates fixed before any request');
      assert.deepEqual([dispositionOf(result, objectCandidate.candidateRef)?.disposition, dispositionOf(result, objectCandidate.candidateRef)?.code], ['PROPOSED', 'MAP_OBJECT']);
      const webCandidate = webRequest.envelope.deterministicCandidates.find((candidate) => candidate.sourceRefs[0] === web.fieldRef) as DeterministicCandidate;
      assert.ok(expected.candidates.some((candidate) => candidate.candidateRef === webCandidate.candidateRef), "the Web column's candidate was expected before any request");
      assert.deepEqual([dispositionOf(result, webCandidate.candidateRef)?.disposition, dispositionOf(result, webCandidate.candidateRef)?.code], ['PROPOSED', 'MAP_FIELD']);
      const resolver = accounting(result).dispositions.filter((disposition) => disposition.origin === 'RESOLVER');
      assert.equal(resolver.filter((disposition) => disposition.disposition === 'DETERMINISTIC').length, 2, 'Name and Description of the tied file are decided on facts in phase two');
      assert.ok(!resolver.some((disposition) => disposition.disposition === 'UNRESOLVED'), JSON.stringify(resolver));
    } finally {
      bundle.dispose();
    }
  });

  it('CAP01: MAP_OBJECT without a fact that holds, to an object outside the support envelope, or merging two files into one record mapping is refused; the file stays pending and Migration Core delivers none of its rows as that object', TIMEOUT, async () => {
    const bundle = tiedBundle('b03-cap01-deny', [{ path: 'branches.csv', text: BRANCHES }, { path: 'outlets.csv', text: OUTLETS }]);
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const branches = fieldRefsOf(contracts, 'branches.csv');
      const outlets = fieldRefsOf(contracts, 'outlets.csv');
      const branchesFile = columnOf(contracts, 'branches.csv', 'Name').fileId;
      const outletsFile = columnOf(contracts, 'outlets.csv', 'Name').fileId;
      const input = cleanInput(profiled);
      const expected: ExpectedCandidateSet = planCandidates(input);

      // A: claims no fact holds for. Branches to DEAL on its header matches — two, as COMPANY's, so they decide nothing; outlets to DEAL on a shape — no DEAL field can hold the URL column. The repair round abstains.
      const a = await runWith(bundle, profiled, null, input, 'b03-cap01-deny-a', (item, asked) => {
        if (asked.envelope.taskType !== 'OBJECT_MAPPING' && asked.envelope.taskType !== 'SEMANTIC_REPAIR') return item;
        if (asked.repair) return abstain(item);
        if (asked.candidate.sourceRefs.every((ref) => branches.includes(ref))) return mapObject(item, objectRef('CLEAN_ONLY', 'DEAL'), 'HEADER_MATCHES_TARGET_LABEL');
        if (asked.candidate.sourceRefs.every((ref) => outlets.includes(ref))) return mapObject(item, objectRef('CLEAN_ONLY', 'DEAL'), 'SHAPE_MATCHES_TARGET_TYPE');
        return item;
      });
      const objectTask = a.requests.find((request) => objectCandidateIn(request.envelope, branches) !== undefined);
      assert.ok(objectTask !== undefined && objectCandidateIn(objectTask.envelope, outlets) !== undefined, 'both tied files are answered in one OBJECT_MAPPING task');
      const refusedA = taskOutcomes(a.result).find((entry) => entry.taskId === objectTask.envelope.taskId && entry.attempt === 1);
      assert.equal(refusedA?.outcome, 'INVALID_SEMANTICS', JSON.stringify(taskOutcomes(a.result)));
      assert.equal(refusedA?.codes.filter((code) => code === 'RATIONALE_NOT_SUPPORTED_BY_FACTS').length, 2, `both claims are refused by name: ${JSON.stringify(refusedA?.codes)}`);
      assert.equal(a.requests.filter((request) => request.envelope.taskId === objectTask.envelope.taskId).length, 2, 'repaired once, never a third time');
      assert.equal(a.result.state, 'PROPOSAL_READY', JSON.stringify(a.result.unresolvedItems));
      // The files stay pending: no record mapping, their rows Migration Core's leftovers, their columns waiting in the accounting.
      assert.ok(!loadedRecords(a.port.real).some((record) => record.fileId === branchesFile || record.fileId === outletsFile), 'no record mapping for a file whose object is not decided');
      const leftovers = a.result.draft.fullValidation?.effects?.leftoverFiles ?? [];
      assert.deepEqual([leftovers.find((entry) => entry.fileId === branchesFile)?.rows, leftovers.find((entry) => entry.fileId === outletsFile)?.rows], [3, 2], 'every row of both files is a leftover');
      const leftoverRows = packageRows(a.port.real, '02_EXCEPTIONS/leftovers.csv');
      assert.equal(leftoverRows.filter((row) => row['file_id'] === branchesFile && row['reason_code'] === 'LEFTOVER_NO_RECORD_MAPPING').length, 3);
      const imported = filesUnder(a.port.real.lastPackage?.stagingDir ?? '').filter((path) => path.split('\\').join('/').includes('/01_IMPORT/')).map((path) => readFileSync(path, 'utf8')).join('\n');
      for (const name of ['North Office', 'Harbour Outlet']) assert.ok(!imported.includes(name), `${name} is delivered as no record`);
      const waiting = accounting(a.result).dispositions.filter((disposition) => disposition.disposition === 'UNRESOLVED' && disposition.code === 'OBJECT_NOT_DECIDED');
      assert.equal(waiting.length, 6, `the three columns of each file wait for their object: ${JSON.stringify(accounting(a.result).dispositions.filter((entry) => entry.origin === 'RESOLVER'))}`);
      assert.ok(waiting.every((disposition) => expected.candidates.some((candidate) => candidate.candidateRef === disposition.candidateRef)));
      assert.equal(accounting(a.result).coverage.complete, false, 'the coverage says the files are pending');

      // B and C: an object ref no support envelope delivers, and an answer that puts the second file in the first file's record mapping. Both FORBIDDEN, never repaired, and Migration Core receives nothing.
      const outside = objectRef('CLEAN_ONLY', 'TICKET');
      let branchesCandidate = '';
      const b = await runWith(bundle, profiled, null, input, 'b03-cap01-deny-b', (item, asked) => {
        if (asked.envelope.taskType !== 'OBJECT_MAPPING') return item;
        const other = objectCandidateIn(asked.envelope, branches);
        if (other !== undefined) branchesCandidate = other.candidateRef;
        if (asked.candidate.sourceRefs.every((ref) => branches.includes(ref))) return mapObject(item, outside, 'SHAPE_MATCHES_TARGET_TYPE');
        if (asked.candidate.sourceRefs.every((ref) => outlets.includes(ref))) return mapObject(item, other?.candidateRef ?? '', 'HEADER_MATCHES_TARGET_LABEL');
        return item;
      });
      const refusedB = taskOutcomes(b.result).find((entry) => entry.codes.includes('OBJECT_OUTSIDE_SUPPORT_ENVELOPE'));
      assert.ok(refusedB !== undefined, `an object outside the support envelope is refused by name: ${JSON.stringify(taskOutcomes(b.result))}`);
      assert.equal(refusedB.outcome, 'FORBIDDEN_PROPOSAL');
      assert.ok(refusedB.codes.includes('OBJECT_SCOPE_COLLAPSE'), `the second file named into the first file's record mapping is refused by name: ${JSON.stringify(refusedB.codes)}`);
      assert.ok(branchesCandidate !== '');
      assert.equal(b.requests.filter((request) => request.envelope.taskId === refusedB.taskId).length, 1, 'a forbidden proposal is not repaired');
      assert.equal(b.result.state, 'FAILED_COMPILER');
      assert.equal(b.result.draft.status, 'NOT_DRAFTABLE');
      assert.equal(b.port.configurations.length, 0, 'Migration Core receives nothing from a run whose compiler refused a forbidden object');
      assert.equal(dispositionOf(b.result, branchesCandidate)?.disposition, 'FAILED');
    } finally {
      bundle.dispose();
    }
  });

  it('CAP01 sentinel: the object channel carries object refs, canonical object names and counts of the file\'s own columns — no file name, header or value of the bundle reaches the wire or the public result', TIMEOUT, async () => {
    // Synthetic sentinels written for this file: in the file name, in a header no target names, in its values.
    const SENTINELS = ['ondriel', 'vaskemar', 'pelsira', 'quontay'];
    const file = 'ondriel-vaskemar-sites.csv';
    const text = 'Name,Description,Web,Pelsira Notes\nNorth Office,Head office,https://north.test,Quontay one\nSouth Office,Sales office,https://south.test,Quontay two\n';
    const bundle = tiedBundle('b03-cap01-sentinel', [{ path: file, text }]);
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const own = fieldRefsOf(contracts, file);
      const web = columnOf(contracts, file, 'Web');
      const telemetry: unknown[] = [];
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock }));
      const gateway = recordingGateway(
        answeringTransport((item, asked) => {
          if (asked.envelope.taskType === 'OBJECT_MAPPING') return mapObject(item, objectRef('CLEAN_ONLY', 'COMPANY'), 'SHAPE_MATCHES_TARGET_TYPE');
          if (asked.candidate.sourceRefs[0] === web.fieldRef) return mapField(item, cleanOnlyTargetRef('company.website'), 'SHAPE_MATCHES_TARGET_TYPE');
          return item;
        }),
      );
      const core = createIntelligenceCore({ ...depsFor(gateway, port, clock), telemetry: (event) => telemetry.push(event) });
      const result = await core.run(cleanInput(profiled), { ...CONTEXT, auditAttemptId: 'b03-cap01-sentinel' });
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));

      const objectRequest = gateway.requests.find((request) => objectCandidateIn(request.envelope, own) !== undefined);
      assert.ok(objectRequest !== undefined);
      const envelope = objectRequest.envelope;
      // Scope: the task carries the tied file's own columns and nothing of another file.
      assert.deepEqual(envelope.sourceProfile.fields.map((field) => field.fieldRef).sort(), [...own].sort(), 'the OBJECT_MAPPING envelope carries exactly the columns of its file');
      // The objects: refs derived from the mode and the canonical name, and the name itself — a constant of Migration Core, not a channel of the data plane.
      const targets = objectTargetsOf(envelope);
      assert.deepEqual(targets.map((target) => target['object']).sort(), OBJECTS, 'the support envelope delivers the four canonical objects in CLEAN_ONLY');
      for (const target of targets) {
        assert.deepEqual(Object.keys(target).sort(), ['object', 'objectRef']);
        assert.equal(target['objectRef'], objectRef('CLEAN_ONLY', String(target['object'])));
      }
      // The file-level facts: counts over the file's own columns, per object — header matches, full-data shapes its fields can hold, memory.
      const facts = objectFactsOf(envelope);
      const candidate = objectCandidateIn(envelope, own) as DeterministicCandidate;
      const factOf = (object: string): Loose | undefined => facts.find((fact) => fact['candidateRef'] === candidate.candidateRef && fact['objectRef'] === objectRef('CLEAN_ONLY', object));
      for (const fact of facts) {
        assert.deepEqual(Object.keys(fact).sort(), ['candidateRef', 'headerMatches', 'memoryMatches', 'objectRef', 'shapeHolds']);
        for (const count of ['headerMatches', 'shapeHolds', 'memoryMatches']) assert.ok(Number.isSafeInteger(fact[count]) && (fact[count] as number) >= 0, `${count} is a count`);
      }
      const counts = (object: string): readonly unknown[] => [factOf(object)?.['headerMatches'], factOf(object)?.['shapeHolds'], factOf(object)?.['memoryMatches']];
      assert.deepEqual(counts('COMPANY'), [2, 1, 0], 'COMPANY: Name and Description name its fields; Web is a URL one of its fields holds');
      assert.deepEqual(counts('DEAL'), [2, 0, 0], 'DEAL: Name and Description name its fields; none holds a URL');
      assert.deepEqual(counts('CONTACT'), [1, 1, 0]);
      assert.deepEqual(counts('LEAD'), [1, 1, 0]);

      // Nothing of the sentinels on the wire, in the public log, in the telemetry or in the result's own records. The configuration is the host's document and names each file by the path the host profiled (D3-CFG-1); it is looked at apart, for the header and the values.
      const wire = gateway.requests.map((request) => JSON.stringify(buildProviderRequest(request))).join('\n').toLowerCase();
      for (const sentinel of SENTINELS) assert.ok(!wire.includes(sentinel), `${sentinel} is on the wire`);
      const withoutConfiguration = (events: readonly unknown[]): unknown[] => events.map((event) => {
        const stored = (event as { readonly kind?: string; readonly result?: { readonly draft?: Loose } }).result;
        return (event as Loose)['kind'] === 'RESULT' && stored?.draft !== undefined ? { ...(event as Loose), result: { ...stored, draft: { ...stored.draft, configuration: null } } } : event;
      });
      const published = JSON.stringify([result.tasks, result.unresolvedItems, result.candidateAccounting, withoutConfiguration(result.runLedger), withoutConfiguration(core.readRun(result.runId)), telemetry, result.draft.fragmentCoverage, result.draft.evidence, result.draft.decisionsRequired, result.draft.unsupportedPreserved, result.memoryCandidates]).toLowerCase();
      for (const sentinel of SENTINELS) assert.ok(!published.includes(sentinel), `${sentinel} is in the public result`);
      const configuration = JSON.stringify(result.draft.configuration).toLowerCase();
      for (const sentinel of ['pelsira', 'quontay']) assert.ok(!configuration.includes(sentinel), `the configuration carries ${sentinel}: a preserved column is named by its locator alone`);
    } finally {
      bundle.dispose();
    }
  });
});

// =================================================================================================================== CAP02

describe('B03-CAP-STRUCTURE — CAP02 FIELD_MAPPING: a model mapping inside its record mapping reaches the package (D3-CAP-02)', () => {
  const HOME = [['ada@kauro-fixture.test', 'London'], ['grace@kauro-fixture.test', 'Arlington'], ['alan@kauro-fixture.test', 'Wilmslow']] as const;
  const contacts = `Email,First Name,Home City\n${HOME.map(([email, city], index) => `${email},${['Ada', 'Grace', 'Alan'][index] ?? ''},${city}`).join('\n')}\n`;

  it('CAP02: a model FIELD_MAPPING of Home City to contact.city on header and shape facts is compiled, assembled and delivered by Migration Core into contact.city for every row', TIMEOUT, async () => {
    const bundle = tiedBundle('b03-cap02', [], { contacts });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const home = columnOf(contracts, 'contacts.csv', 'Home City');
      const city = cleanOnlyTargetRef('contact.city');
      const { result, requests, port } = await runWith(bundle, profiled, null, cleanInput(profiled), 'b03-cap02', (item, asked) => (asked.candidate.sourceRefs[0] === home.fieldRef && !asked.repair ? mapField(item, city, 'HEADER_MATCHES_TARGET_LABEL') : item));
      const asked = requests.find((request) => request.envelope.taskType === 'FIELD_MAPPING' && request.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === home.fieldRef));
      assert.ok(asked !== undefined, 'Home City is a FIELD_MAPPING question');
      const candidate = asked.envelope.deterministicCandidates.find((entry) => entry.sourceRefs[0] === home.fieldRef) as DeterministicCandidate;
      assert.ok(candidate.allowedTargetRefs.includes(city), 'contact.city is among the targets its record mapping offers');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      // Compiled on the facts: the header names the target, and no full-data shape contradicts it.
      const evidence = result.draft.evidence.find((entry) => entry.origin === 'PROPOSED' && entry.candidateRef === candidate.candidateRef);
      assert.ok(evidence !== undefined, 'the accepted proposal is in the draft evidence');
      assert.deepEqual([evidence.destinationField, evidence.rationaleCode], ['contact.city', 'HEADER_MATCHES_TARGET_LABEL']);
      assert.ok(evidence.evidenceClass === 'SUPPORTED' || evidence.evidenceClass === 'STRONG', evidence.evidenceClass);
      assert.match(String(evidence.fragmentHash), /^[0-9a-f]{64}$/u, 'it names the fragment it put in the configuration');
      // Assembled and loaded: contact.city at the Home City column of the contacts record mapping.
      const record = loadedRecords(port.real).find((entry) => entry.fileId === home.fileId);
      const loaded = record?.fields.find((field) => field.destinationField === 'contact.city');
      assert.equal(loaded?.column.index, home.columnIndex, 'Migration Core reads contact.city from the Home City column');
      // Delivered for every row, read back from the package.
      const delivered = packageRows(port.real, '01_IMPORT/clean-only/contacts.csv');
      for (const [email, value] of HOME) assert.ok(delivered.some((row) => row['contact.email'] === email && row['contact.city'] === value), `${email} is delivered with contact.city ${value}`);
      const effect = result.draft.fullValidation?.effects?.fields.find((entry) => entry.destinationField === 'contact.city');
      assert.equal(effect?.delivered, 3, 'every row delivers the city');
      assert.deepEqual([dispositionOf(result, candidate.candidateRef)?.disposition, dispositionOf(result, candidate.candidateRef)?.code], ['PROPOSED', 'MAP_FIELD']);
    } finally {
      bundle.dispose();
    }
  });

  it("CAP02: a FIELD_MAPPING to a target outside the candidate's allowed set, of another object than its record mapping or not writable is refused, and Migration Core receives no such field", TIMEOUT, async () => {
    // A: a target the envelope offers another candidate — contact.phone for the URL-shaped Blog column — refused by name, repaired, and the run drafts without it.
    const blogContacts = 'Email,First Name,Home City,Blog\nada@kauro-fixture.test,Ada,London,https://ada.blog.test\ngrace@kauro-fixture.test,Grace,Arlington,https://grace.blog.test\n';
    const bundleA = tiedBundle('b03-cap02-deny-a', [], { contacts: blogContacts });
    try {
      const profiled = profileBundle(bundleA, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const blog = columnOf(contracts, 'contacts.csv', 'Blog');
      const phone = cleanOnlyTargetRef('contact.phone');
      const a = await runWith(bundleA, profiled, null, cleanInput(profiled), 'b03-cap02-deny-a', (item, asked) => (asked.candidate.sourceRefs[0] !== blog.fieldRef ? item : asked.repair ? preserve(item) : mapField(item, phone, 'HEADER_MATCHES_TARGET_LABEL')));
      const task = a.requests.find((request) => request.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === blog.fieldRef));
      assert.ok(task !== undefined);
      assert.ok(task.envelope.constraints.allowedTargetIds.includes(phone), 'the envelope offers contact.phone, to another candidate');
      assert.ok(!(task.envelope.deterministicCandidates.find((candidate) => candidate.sourceRefs[0] === blog.fieldRef)?.allowedTargetRefs.includes(phone) ?? true), 'but not to Blog');
      const first = taskOutcomes(a.result).find((entry) => entry.taskId === task.envelope.taskId && entry.attempt === 1);
      assert.ok(first?.codes.includes('TARGET_NOT_ALLOWED_FOR_CANDIDATE'), JSON.stringify(taskOutcomes(a.result)));
      assert.equal(a.result.state, 'PROPOSAL_READY', JSON.stringify(a.result.unresolvedItems));
      assert.ok(a.port.configurations.length > 0);
      for (const configuration of a.port.configurations) assert.ok(!configuration.fields.some((field) => field.columnLocator === blog.locator), 'Migration Core receives no field from Blog');
      assert.ok(!loadedRecords(a.port.real).some((record) => record.fields.some((field) => field.destinationField === 'contact.phone')), 'nor any contact.phone');
    } finally {
      bundleA.dispose();
    }

    // B: a target of another object — company.city, which the same task offers the companies file's Region column — for the contacts file's Home City: FORBIDDEN by name, and Migration Core receives nothing.
    const bundleB = tiedBundle('b03-cap02-deny-b', [], { contacts, companies: 'Name,Website,Region\nAnalytical Engines,https://analytical.test,North\nCOBOL Works,https://cobol.test,South\n' });
    try {
      const profiled = profileBundle(bundleB, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const home = columnOf(contracts, 'contacts.csv', 'Home City');
      const region = columnOf(contracts, 'companies.csv', 'Region');
      const companyCity = cleanOnlyTargetRef('company.city');
      const b = await runWith(bundleB, profiled, null, cleanInput(profiled), 'b03-cap02-deny-b', (item, asked) => (asked.candidate.sourceRefs[0] === home.fieldRef ? mapField(item, companyCity, 'HEADER_MATCHES_TARGET_LABEL') : item));
      const task = b.requests.find((request) => request.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === home.fieldRef));
      assert.ok(task !== undefined && task.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === region.fieldRef), 'Home City and Region are answered in one task');
      assert.ok(task.envelope.constraints.allowedTargetIds.includes(companyCity), 'the envelope offers company.city, to Region');
      const refused = taskOutcomes(b.result).find((entry) => entry.taskId === task.envelope.taskId);
      assert.ok(refused?.codes.includes('TARGET_OF_ANOTHER_OBJECT'), `a target of another object than the record mapping's is refused by name: ${JSON.stringify(refused)}`);
      assert.equal(refused?.outcome, 'FORBIDDEN_PROPOSAL');
      assert.equal(b.result.state, 'FAILED_COMPILER');
      assert.equal(b.port.configurations.length, 0, 'Migration Core receives nothing');
    } finally {
      bundleB.dispose();
    }

    // C: a vendor target the contract says no one may write — HubSpot's email, read-only here — named for Home City: FORBIDDEN as not writable, whether or not the envelope carried it.
    const bundleC = makeBundle('b03-cap02-deny-c', { contacts: 'First Name,Last Name,Email,Home City\nAda,Lovelace,ada@kauro-fixture.test,London\nGrace,Hopper,grace@kauro-fixture.test,Arlington\n' });
    try {
      const contract = vendorContract('HUBSPOT', { readOnlyEmail: true });
      const profiled = profileBundle(bundleC, 'HUBSPOT');
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const home = columnOf(contracts, 'contacts.csv', 'Home City');
      const email = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === 'email')?.[0] ?? assert.fail('no email target');
      const base = inputFor('HUBSPOT', profiled, contract);
      const c = await runWith(bundleC, profiled, contract, { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } }, 'b03-cap02-deny-c', (item, asked) => (asked.candidate.sourceRefs[0] === home.fieldRef ? mapField(item, email, 'HEADER_MATCHES_TARGET_LABEL') : item));
      const refused = taskOutcomes(c.result).find((entry) => entry.codes.includes('TARGET_NOT_WRITABLE'));
      assert.ok(refused !== undefined, `a target the contract makes read-only is refused as not writable: ${JSON.stringify(taskOutcomes(c.result))}`);
      assert.equal(refused.outcome, 'FORBIDDEN_PROPOSAL');
      assert.equal(c.result.state, 'FAILED_COMPILER');
      assert.equal(c.port.configurations.length, 0, 'Migration Core receives nothing');
    } finally {
      bundleC.dispose();
    }
  });
});

// =================================================================================================================== CAP03

describe('B03-CAP-STRUCTURE — CAP03 SEMANTIC_TYPE: a type the full-data shapes support is applied to the destination (D3-CAP-03)', () => {
  /** Employee Count: three plain numbers, one of them also boolean-like, and one word no number reads. */
  const companies = 'Name,Website,Employee Count\nAnalytical Engines,https://analytical.test,12\nCOBOL Works,https://cobol.test,unknown\nDifference Works,https://difference.test,1\nLogic Mills,https://logic.test,40\n';
  const typeCandidateIn = (request: GatewayRequest, fieldRef: string): DeterministicCandidate | undefined => (request.envelope.taskType === 'SEMANTIC_TYPE' ? request.envelope.deterministicCandidates.find((candidate) => candidate.sourceRefs[0] === fieldRef) : undefined);
  const employeeField = (port: FixtureValidationPort, fileId: string): LoadedRecord['fields'][number] | undefined => loadedRecords(port).find((record) => record.fileId === fileId)?.fields.find((field) => field.destinationField === 'company.employeeCount');

  it("CAP03: a SELECT_SEMANTIC_TYPE the full-data shape facts support is applied to the field's destination, and Migration Core interprets the column under that type with its minority invalid values flagged and preserved", TIMEOUT, async () => {
    const bundle = tiedBundle('b03-cap03', [], { companies });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const employees = columnOf(contracts, 'companies.csv', 'Employee Count');
      const { result, requests, port } = await runWith(bundle, profiled, null, cleanInput(profiled), 'b03-cap03', (item, asked) => (asked.candidate.sourceRefs[0] === employees.fieldRef && asked.envelope.taskType === 'SEMANTIC_TYPE' ? selectType(item, 'NUMBER') : item));
      const asked = requests.find((request) => typeCandidateIn(request, employees.fieldRef) !== undefined);
      assert.ok(asked !== undefined, 'the column mapped on facts, whose full-data shapes read two ways, is a SEMANTIC_TYPE question');
      const candidate = typeCandidateIn(asked, employees.fieldRef) as DeterministicCandidate;
      assert.deepEqual(candidate.allowedTargetRefs, [cleanOnlyTargetRef('company.employeeCount')], 'the candidate names the destination its type is for');
      assert.ok(asked.envelope.constraints.allowedProposalTypes.includes('SELECT_SEMANTIC_TYPE'));
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      // Applied to the destination: the loaded field is NUMBER, and keeps what it cannot read.
      const loaded = employeeField(port.real, employees.fileId);
      assert.deepEqual([loaded?.semanticType, loaded?.onInvalid], ['NUMBER', 'PRESERVE'], 'Migration Core interprets the column as NUMBER');
      // Interpreted: the minority value is flagged and preserved, the numbers delivered as numbers.
      const flags = packageRows(port.real, '03_TRACEABILITY/flags.csv').filter((row) => row['destination_field'] === 'company.employeeCount');
      assert.deepEqual(flags.map((row) => row['preserved_value']), ['unknown'], 'exactly the minority value is flagged');
      assert.ok(['AMBIGUOUS', 'INVALID'].includes(flags[0]?.['outcome'] ?? ''), JSON.stringify(flags));
      const delivered = packageRows(port.real, '01_IMPORT/clean-only/companies.csv');
      assert.ok(delivered.some((row) => row['company.name'] === 'COBOL Works' && row['company.employeeCount'] === 'unknown'), 'the flagged value is preserved in the delivery');
      assert.ok(delivered.some((row) => row['company.name'] === 'Logic Mills' && row['company.employeeCount'] === '40'));
      const effect = result.draft.fullValidation?.effects?.fields.find((entry) => entry.destinationField === 'company.employeeCount');
      assert.deepEqual([effect?.delivered, effect?.flagged], [4, 1]);
      // The decision behind the type, in the draft and the manifest, met on the field's fragment.
      const fragment = result.draft.configuration?.fields.find((field) => field.destinationField === 'company.employeeCount');
      assert.equal(fragment?.semanticType, 'NUMBER');
      const evidence = result.draft.evidence.find((entry) => entry.origin === 'PROPOSED' && entry.candidateRef === candidate.candidateRef);
      assert.deepEqual([evidence?.semanticType, evidence?.destinationField, evidence?.fragmentHash], ['NUMBER', 'company.employeeCount', fragment?.fragmentHash]);
      const entry = manifestOf(result).find((candidateEntry) => candidateEntry['decisionRef'] === candidate.candidateRef);
      assert.deepEqual([entry?.['origin'], entry?.['expectedEffect'], entry?.['observed'], entry?.['fragmentHash']], ['PROPOSED', 'TYPE_APPLIED', true, fragment?.fragmentHash]);
      assert.deepEqual([dispositionOf(result, candidate.candidateRef)?.disposition, dispositionOf(result, candidate.candidateRef)?.code], ['PROPOSED', 'SELECT_SEMANTIC_TYPE']);
    } finally {
      bundle.dispose();
    }
  });

  it('CAP03: a semantic type the shape facts contradict, or one for a column with no destination, is refused; the field keeps its deterministic type in the Migration Core configuration', TIMEOUT, async () => {
    const bundle = tiedBundle('b03-cap03-deny', [], { companies });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = cleanContracts(profiled);
      const employees = columnOf(contracts, 'companies.csv', 'Employee Count');
      // A: DATE for a column no row of which is a date — refused by name, repaired to an abstention; the field keeps its deterministic type, and nothing is flagged.
      const a = await runWith(bundle, profiled, null, cleanInput(profiled), 'b03-cap03-deny-a', (item, asked) => (asked.candidate.sourceRefs[0] !== employees.fieldRef || (asked.envelope.taskType !== 'SEMANTIC_TYPE' && !asked.repair) ? item : asked.repair ? abstain(item) : selectType(item, 'DATE')));
      const asked = a.requests.find((request) => typeCandidateIn(request, employees.fieldRef) !== undefined);
      assert.ok(asked !== undefined, 'the type is asked');
      const first = taskOutcomes(a.result).find((entry) => entry.taskId === asked.envelope.taskId && entry.attempt === 1);
      assert.equal(first?.outcome, 'INVALID_SEMANTICS', JSON.stringify(taskOutcomes(a.result)));
      assert.ok(first?.codes.includes('SEMANTIC_TYPE_CONTRADICTS_SHAPE'), JSON.stringify(first));
      assert.equal(a.result.state, 'PROPOSAL_READY', JSON.stringify(a.result.unresolvedItems));
      const loaded = employeeField(a.port.real, employees.fileId);
      assert.equal(loaded?.semanticType, 'TEXT', 'the deterministic type of a column whose full-data shapes read two ways: the destination\'s own');
      assert.deepEqual(packageRows(a.port.real, '03_TRACEABILITY/flags.csv').filter((row) => row['destination_field'] === 'company.employeeCount'), [], 'nothing is flagged under the type the model was refused');
      const candidate = typeCandidateIn(asked, employees.fieldRef) as DeterministicCandidate;
      assert.equal(dispositionOf(a.result, candidate.candidateRef)?.disposition, 'PRESERVED', 'the type decision is left to the deterministic one');

      // B: a type for the Region column, which has no destination in this run — refused by name; Migration Core receives nothing of it.
      const regionBundle = tiedBundle('b03-cap03-deny-b', [], { companies: 'Name,Website,Region\nAnalytical Engines,https://analytical.test,North\nCOBOL Works,https://cobol.test,South\n' });
      try {
        const regionProfiled = profileBundle(regionBundle, 'CLEAN_ONLY');
        const region = columnOf(cleanContracts(regionProfiled), 'companies.csv', 'Region');
        const b = await runWith(regionBundle, regionProfiled, null, cleanInput(regionProfiled), 'b03-cap03-deny-b', (item, asked) => (asked.candidate.sourceRefs[0] === region.fieldRef ? selectType(item, 'TEXT', 'HEADER_MATCHES_TARGET_LABEL') : item));
        const refused = taskOutcomes(b.result).find((entry) => entry.codes.includes('SEMANTIC_TYPE_WITHOUT_DESTINATION'));
        assert.ok(refused !== undefined, `a type for a column with no destination is refused by name: ${JSON.stringify(taskOutcomes(b.result))}`);
        assert.equal(b.result.draft.status, 'NOT_DRAFTABLE');
        for (const configuration of b.port.configurations) assert.ok(!configuration.fields.some((field) => field.columnLocator === region.locator), 'no Region field reaches Migration Core');
      } finally {
        regionBundle.dispose();
      }
    } finally {
      bundle.dispose();
    }
  });
});

// =================================================================================================================== CAP09

describe('B03-CAP-STRUCTURE — CAP09 UNMAPPED_HANDLING: unmapped material is preserved with evidence and accounted as Migration Core\'s leftover (D3-CAP-09)', () => {
  const sfField = (apiName: string, label: string, type: string): ContractField => ({ apiName, label, type, createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE', idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE', restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT' });
  /** A Salesforce contract whose Contact has only First Name, Last Name and Email, and whose Account has only Name: a column beyond them has no target. */
  const narrowContract = (): Hashed =>
    peer.hashTargetContract({
      contractVersion: '1.0.0',
      parserVersion: '1.0.0',
      capturedAt: '2026-09-01T00:00:00Z',
      instance: { mode: 'SALESFORCE', instanceId: '00D000000000009', instanceLabel: 'fixture narrow SALESFORCE', evidence: 'ARTIFACT' },
      artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
      objects: [
        { apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [sfField('FirstName', 'First Name', 'string'), sfField('LastName', 'Last Name', 'string'), sfField('Email', 'Email', 'email')] },
        { apiName: 'Account', label: 'Account', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [sfField('Name', 'Name', 'string')] },
      ],
      pipelines: [],
    });
  const CONTACTS_9 = 'Referral Code,First Name,Last Name,Email,Loyalty Tier\nR-001,Ada,Lovelace,ada@kauro-fixture.test,gold\nR-002,Grace,Hopper,grace@kauro-fixture.test,silver\nR-003,Alan,Turing,alan@kauro-fixture.test,gold\n';
  const COMPANIES_9 = 'Name,Region\nAnalytical Engines,North\nCOBOL Works,South\n';

  /**
   * The bundle profiled, and its candidate set built with the dry-run truth
   * (plan, obligation 7): Migration Core runs the read configuration — the
   * record id columns and Email and Name — over the whole bundle, and the
   * set carries every column that run left out as UNMAPPED_MATERIAL.
   */
  function unmappedFixture(name: string): { readonly bundle: Bundle; readonly profiled: Profiled } {
    const made = makeBundle(name, { contacts: CONTACTS_9, companies: COMPANIES_9 });
    const bundle: Bundle = { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Referral Code' : 'Name' })) };
    const profiled = profileBundle(bundle, 'CLEAN_ONLY');
    const loaded = peer.loadConfig(profileConfig(bundle, 'CLEAN_ONLY'), join(bundle.root, 'profile-config.json'));
    const scratch = peer.createFilesystemScratchStore({ root: join(bundle.root, 'scratch-truth'), runId: 'truth', quotaBytes: peer.SCRATCH_BUDGET_BYTES });
    try {
      const run = peer.runMigration({ inputRoot: bundle.root, config: loaded.config, configHash: loaded.configHash, scratch, sourceProfile: profiled.profile });
      return { bundle, profiled: { ...profiled, candidateSet: peer.buildCandidateSet({ profile: profiled.profile, configHash: loaded.configHash, truth: run.truth }) } };
    } finally {
      scratch.dispose();
    }
  }

  const vendorInput = (profiled: Profiled, contract: Hashed): IntelligenceInput => {
    const base = inputFor('SALESFORCE', profiled, contract);
    return { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } };
  };

  it('CAP09: unmapped material and every column without a target are preserved with evidence; the Migration Core package accounts each as an unmapped leftover and the draft lists the same locators', TIMEOUT, async () => {
    const { bundle, profiled } = unmappedFixture('b03-cap09');
    try {
      const contract = narrowContract();
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const unmappedOriginals = contracts.candidates.filter((candidate) => candidate.candidateType === 'UNMAPPED_MATERIAL');
      const loyalty = columnOf(contracts, 'contacts.csv', 'Loyalty Tier');
      const referral = columnOf(contracts, 'contacts.csv', 'Referral Code');
      const region = columnOf(contracts, 'companies.csv', 'Region');
      const withoutTarget = [loyalty, referral, region];
      assert.ok(unmappedOriginals.some((candidate) => candidate.sourceRefs.includes(loyalty.fieldRef)) && unmappedOriginals.some((candidate) => candidate.sourceRefs.includes(region.fieldRef)), 'the dry run reports Loyalty Tier and Region as unmapped material');
      assert.ok(!unmappedOriginals.some((candidate) => candidate.sourceRefs.includes(referral.fieldRef)), 'Referral Code, the read configuration\'s record id, is not unmapped material: it is a column without a target all the same');

      const { result, requests, port } = await runWith(bundle, profiled, contract, vendorInput(profiled, contract), 'b03-cap09', (item) => item);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      // Each column without a target is an UNMAPPED_HANDLING question; the unmapped material Migration Core reported rides in it as evidence.
      const handling = requests.filter((request) => request.envelope.taskType === 'UNMAPPED_HANDLING');
      assert.ok(handling.length > 0, 'an UNMAPPED_HANDLING task is asked');
      const carried = handling.flatMap((request) => request.envelope.deterministicCandidates);
      for (const column of withoutTarget) assert.ok(carried.some((candidate) => candidate.sourceRefs[0] === column.fieldRef), `the column at ${column.locator} is asked about`);
      for (const original of unmappedOriginals.filter((candidate) => candidate.sourceRefs.includes(loyalty.fieldRef) || candidate.sourceRefs.includes(region.fieldRef))) {
        const candidate = carried.find((entry) => entry.sourceRefs[0] === original.sourceRefs[0]);
        assert.ok(candidate !== undefined && original.evidenceRefs.every((ref) => candidate.evidenceRefs.includes(ref)), 'the candidate carries the evidence of the unmapped material');
      }
      // Preserved with evidence: the model's accepted preserve, on the fact that no target of the record mapping can hold the column.
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      const preserved = configuration.preservedColumns.map((column) => column.columnLocator).sort();
      assert.deepEqual(preserved, withoutTarget.map((column) => column.locator).sort(), 'the draft preserves exactly the columns without a target');
      for (const column of configuration.preservedColumns) {
        const entry = manifestOf(result).find((candidate) => candidate['fragmentKind'] === 'PRESERVED_COLUMN' && candidate['fragmentHash'] === column.fragmentHash);
        assert.deepEqual([entry?.['origin'], entry?.['rule'], entry?.['expectedEffect'], entry?.['observed']], ['PROPOSED', 'NO_TARGET_IN_ENVELOPE', 'UNMAPPED_LEFTOVER', true], JSON.stringify(entry));
        assert.ok(((entry?.['evidenceRefs'] as readonly string[] | undefined) ?? []).length > 0, 'with the evidence it stands on');
      }
      // The package accounts every one of them as an unmapped leftover, and nothing else: the same locators as the draft.
      const leftovers = [...new Set(packageRows(port.real, '02_EXCEPTIONS/unmapped-fields.csv').map((row) => row['column_locator_id'] ?? ''))].sort();
      assert.deepEqual(leftovers, preserved, "the package's unmapped leftovers are the draft's preserved columns");
      assert.deepEqual([...new Set((result.draft.fullValidation?.effects?.unmapped ?? []).map((entry) => entry.columnLocator))].sort(), preserved);
      // The accounting: every unmapped original answered — preserved with its column or mapped with it — and every question preserved.
      for (const original of unmappedOriginals) {
        const disposition = dispositionOf(result, original.candidateRef);
        assert.equal(disposition?.family, 'UNMAPPED_HANDLING');
        const column = withoutTarget.find((entry) => original.sourceRefs.includes(entry.fieldRef));
        assert.equal(disposition?.disposition, column === undefined ? 'DETERMINISTIC' : 'PRESERVED', `${original.candidateRef}: ${JSON.stringify(disposition)}`);
      }
      for (const candidate of carried) assert.deepEqual([dispositionOf(result, candidate.candidateRef)?.disposition, dispositionOf(result, candidate.candidateRef)?.code], ['PRESERVED', 'UNMAPPED_PRESERVE']);
    } finally {
      bundle.dispose();
    }
  });

  it('CAP09: an exclusion of an unmapped column without the agency is a pending agency decision and the column stays in the Migration Core leftover accounting', TIMEOUT, async () => {
    const { bundle, profiled } = unmappedFixture('b03-cap09-deny');
    try {
      const contract = narrowContract();
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const loyalty = columnOf(contracts, 'contacts.csv', 'Loyalty Tier');
      const original = contracts.candidates.find((candidate) => candidate.candidateType === 'UNMAPPED_MATERIAL' && candidate.sourceRefs.includes(loyalty.fieldRef));
      assert.ok(original !== undefined);
      // The model asks for the column to be excluded: there is no exclusion it may make, so it can only ask.
      const { result, requests, port } = await runWith(bundle, profiled, contract, vendorInput(profiled, contract), 'b03-cap09-deny', (item, asked) => (asked.candidate.sourceRefs[0] === loyalty.fieldRef ? { ...bare(item), proposalType: 'NEEDS_AGENCY_DECISION', requiresAgencyDecision: true, rationaleCode: 'DESTRUCTIVE_NEEDS_AGENCY', shortRationale: 'Exclude this column from the migration.' } : item));
      const asked = requests.find((request) => request.envelope.taskType === 'UNMAPPED_HANDLING' && request.envelope.deterministicCandidates.some((candidate) => candidate.sourceRefs[0] === loyalty.fieldRef));
      assert.ok(asked !== undefined, 'the column is an UNMAPPED_HANDLING question');
      assert.ok(!asked.envelope.constraints.allowedProposalTypes.some((type) => type.includes('EXCLU')), 'no exclusion type exists');
      const candidate = asked.envelope.deterministicCandidates.find((entry) => entry.sourceRefs[0] === loyalty.fieldRef) as DeterministicCandidate;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const outcome = taskOutcomes(result).find((entry) => entry.taskId === asked.envelope.taskId);
      assert.equal(outcome?.outcome, 'REQUIRES_AGENCY_DECISION', JSON.stringify(outcome));
      assert.ok(outcome?.codes.includes('EXCLUSION_REQUIRES_AGENCY_DECISION'), JSON.stringify(outcome));
      assert.ok(result.draft.decisionsRequired.some((entry) => entry.candidateRef === candidate.candidateRef && entry.reason === 'EXCLUSION_REQUIRES_AGENCY_DECISION'), JSON.stringify(result.draft.decisionsRequired));
      assert.deepEqual([dispositionOf(result, candidate.candidateRef)?.disposition, dispositionOf(result, original.candidateRef)?.disposition], ['AGENCY_DECISION', 'AGENCY_DECISION'], 'the question and the unmapped material both wait for the agency');
      // Nothing is excluded: the column stays preserved, and Migration Core accounts every one of its cells as a leftover.
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      assert.deepEqual(configuration.excludedColumns, [], 'no column is excluded without the agency');
      const kept = configuration.preservedColumns.find((column) => column.columnLocator === loyalty.locator);
      assert.ok(kept !== undefined, 'the column stays preserved');
      const cells = packageRows(port.real, '02_EXCEPTIONS/unmapped-fields.csv').filter((row) => row['column_locator_id'] === loyalty.locator);
      assert.equal(cells.length, 3, 'Migration Core accounts each of its three cells as an unmapped leftover');
      assert.equal(result.draft.fullValidation?.effects?.unmapped.find((entry) => entry.columnLocator === loyalty.locator)?.cells, 3);
      const entry = manifestOf(result).find((manifestEntry) => manifestEntry['fragmentKind'] === 'PRESERVED_COLUMN' && manifestEntry['fragmentHash'] === kept.fragmentHash);
      assert.deepEqual([entry?.['expectedEffect'], entry?.['observed']], ['UNMAPPED_LEFTOVER', true]);
    } finally {
      bundle.dispose();
    }
  });
});

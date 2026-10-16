/**
 * B03-ACCOUNTING — exact candidate accounting, the output scope of a claim,
 * omission as a refusal and partitioning under the per-request bound
 * (closure plan D3-ACC-1, D3-ACC-2, D3-ACC-3, D3-SCOPE-1, D3-PART-1; review
 * findings B03-R5 and B03-R10).
 *
 * Every case goes through the public run() with the real Migration Core in
 * the host's validation port (the vendored release, through its public
 * entry). The model is a labelled fake: a transport that answers from the
 * serialised request with the oracle's proposal, rewritten per case as a
 * model would answer it (evidence class SIMULATED). No provider is called.
 *
 * The accounting is read through loose views so that this file states the
 * contract the core must meet without leaning on the types of the build
 * under test: a build without it reads as undefined and the assertions say
 * what is missing.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SCRATCH_BUDGET_BYTES, buildCandidateSet, createFilesystemScratchStore, hashCandidateSet, hashTargetContract, loadConfig, runMigration } from 'kauro-migration-core';
import type { HashedCandidateSet, HashedSourceProfile, HashedTargetContract, TargetContract, TargetMode } from 'kauro-migration-core';

import * as publicIndex from '../src/index.js';
import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import type { IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { buildProviderRequest, parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { CandidateConfiguration, FullDatasetValidationPort, IntelligenceInput } from '../src/ports/ports.js';
import type { Bundle, FixtureValidationPort } from './support/fixtures.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, profileConfig, realValidationPort, vendorContract } from './support/fixtures.js';

// ------------------------------------------------------------------------------------------------ loose views of the contract

/** One disposition of the result's candidate accounting (D3-ACC-1). */
interface Disposition {
  readonly candidateRef: string;
  readonly origin: string;
  readonly candidateType: string;
  readonly family: string | null;
  readonly disposition: string;
  readonly code: string;
  readonly taskId: string | null;
}
interface Coverage {
  readonly complete: boolean;
  readonly expectedCandidates: number;
  readonly accountedCandidates: number;
  readonly pendingCandidates: number;
  readonly unresolvedCandidates: number;
  readonly candidateSetTruncated: boolean;
}
interface Accounting {
  readonly expectedSetHash: string;
  readonly dispositions: readonly Disposition[];
  readonly coverage: Coverage;
}
/** The expected candidate set planCandidates returns before any request (D3-ACC-1). */
interface ExpectedSet {
  readonly candidateSetHash: string;
  readonly expectedSetHash: string;
  readonly truncated: boolean;
  readonly candidates: readonly { readonly candidateRef: string; readonly origin: string; readonly candidateType: string; readonly family: string | null }[];
}
type PlanCandidates = (input: Pick<IntelligenceInput, 'projectRevision' | 'sourceProfile' | 'candidateSet' | 'targetContract'>) => ExpectedSet;
type AccountingProblems = (expected: ExpectedSet, dispositions: readonly Disposition[]) => readonly string[];

const exported = publicIndex as unknown as Record<string, unknown>;
const planCandidates = exported['planCandidates'] as PlanCandidates | undefined;
const candidateAccountingProblems = exported['candidateAccountingProblems'] as AccountingProblems | undefined;
const accountingOf = (result: IntelligenceResult): Accounting | undefined => (result as unknown as { readonly candidateAccounting?: Accounting | null }).candidateAccounting ?? undefined;
const draftCoverageOf = (result: IntelligenceResult): Coverage | undefined => (result.draft as unknown as { readonly coverage?: Coverage | null }).coverage ?? undefined;

/** The accounting of a run, asserted present. */
function accounting(result: IntelligenceResult): Accounting {
  const found = accountingOf(result);
  assert.ok(found !== undefined, `the result carries a candidate accounting (D3-ACC-1); it has members ${Object.keys(result).join(', ')}`);
  return found;
}
/** The expected set of a run's input, asserted exported. */
function expectedOf(input: IntelligenceInput): ExpectedSet {
  assert.equal(typeof planCandidates, 'function', 'planCandidates is exported by the public entry (D3-ACC-1)');
  return (planCandidates as PlanCandidates)(input);
}
/** How many dispositions each candidate ref has. */
const countsOf = (dispositions: readonly Disposition[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of dispositions) counts.set(entry.candidateRef, (counts.get(entry.candidateRef) ?? 0) + 1);
  return counts;
};
/** Exactly one disposition per expected candidate, and none for anything else. */
function assertExactlyOnce(expected: ExpectedSet, found: Accounting): void {
  const counts = countsOf(found.dispositions);
  const expectedRefs = expected.candidates.map((candidate) => candidate.candidateRef);
  assert.deepEqual(expectedRefs.filter((ref) => counts.get(ref) !== 1).map((ref) => `${ref}x${String(counts.get(ref) ?? 0)}`), [], 'every expected candidate has exactly one disposition');
  assert.deepEqual([...counts.keys()].filter((ref) => !expectedRefs.includes(ref)), [], 'no disposition names a candidate outside the expected set');
  assert.equal(found.expectedSetHash, expected.expectedSetHash, 'the run accounts for the set planCandidates fixed before any request');
}

// ------------------------------------------------------------------------------------------------------------ fixtures

const TIMEOUT = { timeout: 240_000 };
const DECLARED = { 'contacts.csv': 'CONTACT' as const, 'contacts2.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const };

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}
/** What the last Migration Core package delivered for import, as text. */
function delivered(port: FixtureValidationPort): string {
  assert.ok(port.lastPackage !== null, 'Migration Core wrote a package');
  return filesUnder(join(port.lastPackage.stagingDir, '01_IMPORT')).map((path) => readFileSync(path, 'utf8')).join('\n');
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

interface AnswerContext {
  readonly header: string;
  readonly allowedTargetRefs: readonly string[];
  readonly envelope: IntelligenceEnvelopeV1;
  /** True on the repair round: the envelope carries a repair context. */
  readonly repair: boolean;
}
/**
 * A transport answering from the serialised request with the oracle's
 * proposal, each item rewritten by the case; `answer` may also drop items.
 * The envelopes it saw are recorded, so a case can say what travelled.
 */
function answeringTransport(rewrite: (item: ProposalItem, context: AnswerContext) => ProposalItem | null, seen: IntelligenceEnvelopeV1[] = []): Transport {
  return async (request: ProviderRequest) => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    const envelope = payload.envelope;
    seen.push(envelope);
    const proposal = oracleProposal(envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
    const headers = new Map(envelope.sourceProfile.fields.map((field) => [field.fieldRef, field.header]));
    const items = proposal.items.flatMap((item) => {
      const candidate = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef);
      if (candidate === undefined) return [item];
      const rewritten = rewrite(item, { header: headers.get(candidate.sourceRefs[0] ?? '') ?? '', allowedTargetRefs: candidate.allowedTargetRefs, envelope, repair: envelope.repairContext !== null });
      return rewritten === null ? [] : [rewritten];
    });
    const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
    const text = JSON.stringify({ ...proposal, items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED' });
    return { status: 200, body: { id: 'msg_b03_accounting', type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
}

/** A gateway over a transport that records every GatewayRequest it was handed. */
function recordingGateway(transport: Transport): ModelGateway & { readonly requests: GatewayRequest[] } {
  const inner = transportGateway(transport);
  const requests: GatewayRequest[] = [];
  return {
    name: 'b03-accounting-recording',
    evidenceClass: inner.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      return inner.analyze(request);
    },
  };
}

/** An answer that maps the item to a target on the claim that the shape matches, nothing else changed. */
const mapTo = (item: ProposalItem, targetRef: string, rationaleCode: ProposalItem['rationaleCode'] = 'SHAPE_MATCHES_TARGET_TYPE'): ProposalItem => ({ ...item, proposalType: 'MAP_FIELD', targetRef, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode, shortRationale: null, abstainReason: null, alternatives: [] });
const preserve = (item: ProposalItem): ProposalItem => ({ ...item, proposalType: 'UNMAPPED_PRESERVE', targetRef: null, transformPrimitive: null, typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: 'NO_TARGET_IN_ENVELOPE', shortRationale: null, abstainReason: 'NO_VALID_TARGET', alternatives: [] });

/** The vendor target ref of an api name, from the adapted contracts. */
function targetRefOf(mode: TargetMode, profiled: { profile: HashedSourceProfile; candidateSet: HashedCandidateSet }, contract: HashedTargetContract, apiName: string): string {
  const contracts = adaptContracts({ mode, profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
  const ref = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === apiName)?.[0];
  assert.ok(ref !== undefined, `${apiName} is in the contract`);
  return ref;
}

/** The locator of a profiled column, by its header. */
function locatorOf(profile: HashedSourceProfile, header: string, fileId?: string): string {
  for (const file of profile.profile.files) {
    if (fileId !== undefined && file.path !== fileId) continue;
    for (const sheet of file.sheets) for (const column of sheet.columns) if (column.headerRaw === header) return column.columnLocatorId;
  }
  throw new Error(`no column ${header}`);
}

/**
 * The bundle profiled and its candidate set built with the dry-run truth:
 * Migration Core runs the profile configuration over the whole bundle and
 * the set carries its duplicate clusters and unmapped material as originals
 * (plan, obligation 7).
 */
function profileWithTruth(bundle: Bundle, mode: TargetMode): { profile: HashedSourceProfile; candidateSet: HashedCandidateSet } {
  const profiled = profileBundle(bundle, mode);
  const loaded = loadConfig(profileConfig(bundle, mode), join(bundle.root, 'profile-config.json'));
  const scratch = createFilesystemScratchStore({ root: join(bundle.root, 'scratch-truth'), runId: 'truth', quotaBytes: SCRATCH_BUDGET_BYTES });
  try {
    const run = runMigration({ inputRoot: bundle.root, config: loaded.config, configHash: loaded.configHash, scratch, sourceProfile: profiled.profile });
    return { profile: profiled.profile, candidateSet: buildCandidateSet({ profile: profiled.profile, configHash: loaded.configHash, truth: run.truth }) };
  } finally {
    scratch.dispose();
  }
}

/** The ledger's TASK_OUTCOME facts of a result, read loosely. */
const taskOutcomes = (result: IntelligenceResult): { readonly taskId: string; readonly attempt: number; readonly outcome: string; readonly codes: readonly string[] }[] =>
  (result.runLedger as unknown as { readonly kind: string; readonly taskId?: string; readonly attempt?: number; readonly outcome?: string; readonly codes?: readonly string[] }[])
    .filter((event) => event.kind === 'TASK_OUTCOME')
    .map((event) => ({ taskId: event.taskId ?? '', attempt: event.attempt ?? 0, outcome: event.outcome ?? '', codes: event.codes ?? [] }));

// ------------------------------------------------------------------------------------------------------------------ IC-06

describe('B03-ACCOUNTING — IC-06: a claim with no fact behind it and a primitive outside the candidate never reach Migration Core', () => {
  it("IC-06: through a public run, a rationale whose claimed fact the compiler does not find and a primitive outside the candidate's own permission are refused by name, repaired at most once, and Migration Core receives neither", TIMEOUT, async () => {
    const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
    const bundle = makeBundle('b03-ic06', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Status\n1,Ada,Lovelace,ada@kauro-fixture.test,,lead\n2,Grace,Hopper,grace@kauro-fixture.test,,OPEN\n3,Alan,Turing,alan@kauro-fixture.test,,lead\n' });
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const stage = targetRefOf('HUBSPOT', profiled, contract, 'lifecyclestage');
      const base = inputFor('HUBSPOT', profiled, contract, { categoricalSummaries: new Map([[locatorOf(profiled.profile, 'Status'), ['lead', 'OPEN']]]) });
      const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } };

      // A: "Status" claimed to match the label "Lifecycle Stage" — no token is shared, so the claimed fact does not hold. The repair round abstains.
      const clockA = new VirtualClock();
      const portA = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock: clockA }));
      const gatewayA = recordingGateway(answeringTransport((item, context) => (context.header !== 'Status' || !context.allowedTargetRefs.includes(stage) ? item : context.repair ? preserve(item) : mapTo(item, stage, 'HEADER_MATCHES_TARGET_LABEL'))));
      const a = await createIntelligenceCore(depsFor(gatewayA, portA, clockA)).run(input, { ...CONTEXT, auditAttemptId: 'b03-ic06-a' });
      const refusedA = taskOutcomes(a).filter((entry) => entry.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'));
      assert.equal(refusedA.length, 1, `the unsupported claim is refused by name once: ${JSON.stringify(taskOutcomes(a))}`);
      assert.equal(refusedA[0]?.outcome, 'INVALID_SEMANTICS');
      assert.equal(gatewayA.requests.filter((request) => request.envelope.taskId === refusedA[0]?.taskId).length, 2, 'the task is repaired once: two requests, never a third');
      assert.equal(a.state, 'PROPOSAL_READY', JSON.stringify(a.unresolvedItems));
      assert.equal(portA.configurations.length, 1, 'Migration Core validated one configuration');
      assert.ok(!(portA.configurations[0]?.fields ?? []).some((field) => field.columnHeader === 'Status' || field.destinationField === 'contact.lifecycleStage'), 'Migration Core never receives the unsupported mapping');
      assert.ok(!delivered(portA.real).includes('lifecycle'), 'the package delivers no lifecycle stage');

      // B: a primitive the catalogue supports but the candidate does not carry, beside a claim that holds — FORBIDDEN by name, never repaired, and Migration Core is not called at all.
      const clockB = new VirtualClock();
      const portB = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock: clockB }));
      const gatewayB = recordingGateway(answeringTransport((item, context) => (context.header !== 'Status' || !context.allowedTargetRefs.includes(stage) ? item : { ...mapTo(item, stage, 'VALUES_ARE_TARGET_OPTIONS'), transformPrimitive: 'NORMALISE_EMAIL_CASE' })));
      const b = await createIntelligenceCore(depsFor(gatewayB, portB, clockB)).run(input, { ...CONTEXT, auditAttemptId: 'b03-ic06-b' });
      const refusedB = taskOutcomes(b).filter((entry) => entry.codes.includes('PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE'));
      assert.equal(refusedB.length, 1, `the primitive outside the candidate is refused by name: ${JSON.stringify(taskOutcomes(b))}`);
      assert.equal(refusedB[0]?.outcome, 'FORBIDDEN_PROPOSAL');
      assert.equal(gatewayB.requests.filter((request) => request.envelope.taskId === refusedB[0]?.taskId).length, 1, 'a forbidden proposal is not repaired');
      assert.equal(b.state, 'FAILED_COMPILER');
      assert.equal(b.draft.status, 'NOT_DRAFTABLE');
      assert.equal(portB.configurations.length, 0, 'Migration Core receives nothing from a run whose compiler refused a forbidden proposal');
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ IC-08

describe('B03-ACCOUNTING — IC-08: a target is claimed once per output scope, never once per run (D3-SCOPE-1)', () => {
  const contract = vendorContract('SALESFORCE');
  const HOME_1 = ['ada.home@kauro-fixture.test', 'grace.home@kauro-fixture.test'];
  const HOME_2 = ['alan.home@kauro-fixture.test', 'edsger.home@kauro-fixture.test'];

  it('IC-08: two independent Contact files whose Home Email columns the model maps to contact.email both reach the SYSTEM_DRAFT and the Migration Core package, one mapping per record mapping', TIMEOUT, async () => {
    const base = makeBundle('b03-ic08-files', { contacts: `Contact ID,First Name,Last Name,Home Email\n1,Ada,Lovelace,${HOME_1[0] ?? ''}\n2,Grace,Hopper,${HOME_1[1] ?? ''}\n` });
    try {
      writeFileSync(join(base.root, 'contacts2.csv'), `Contact ID,First Name,Last Name,Home Email\n11,Alan,Turing,${HOME_2[0] ?? ''}\n12,Edsger,Dijkstra,${HOME_2[1] ?? ''}\n`);
      const bundle: Bundle = { ...base, files: [...base.files, { id: 'contacts2', path: 'contacts2.csv', idHeader: 'Contact ID', object: 'CONTACT' }] };
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const email = targetRefOf('SALESFORCE', profiled, contract, 'Email');
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      const seen: IntelligenceEnvelopeV1[] = [];
      const gateway = recordingGateway(answeringTransport((item, context) => (context.header === 'Home Email' && context.allowedTargetRefs.includes(email) ? mapTo(item, email) : item), seen));
      const input = inputFor('SALESFORCE', profiled, contract);
      const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run({ ...input, projectRevision: { ...input.projectRevision, declaredObjects: DECLARED } }, { ...CONTEXT, auditAttemptId: 'b03-ic08-files' });
      // The compiler's own branch: both Home Email candidates travelled in one envelope and were answered in one proposal.
      const homeRefs = (envelope: IntelligenceEnvelopeV1): string[] => envelope.deterministicCandidates.filter((candidate) => envelope.sourceProfile.fields.some((field) => field.fieldRef === candidate.sourceRefs[0] && field.header === 'Home Email')).map((candidate) => candidate.candidateRef);
      assert.ok(seen.some((envelope) => homeRefs(envelope).length === 2), 'the two Home Email candidates are answered in one task, so the compiler decides their claims');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');
      const emails = (result.draft.configuration?.fields ?? []).filter((field) => field.destinationField === 'contact.email');
      assert.deepEqual(emails.map((field) => field.filePath).sort(), ['contacts.csv', 'contacts2.csv'], JSON.stringify(emails));
      assert.equal(new Set(emails.map((field) => field.recordId)).size, 2, 'one mapping per record mapping');
      const proposed = result.draft.evidence.filter((entry) => entry.origin === 'PROPOSED' && entry.destinationField === 'contact.email');
      assert.equal(proposed.length, 2, 'both mappings are the model proposals the compiler accepted');
      assert.ok(!result.unresolvedItems.some((entry) => entry.codes.includes('DUPLICATE_TARGET_WITHOUT_RESOLUTION')), JSON.stringify(result.unresolvedItems));
      assert.deepEqual(result.draft.decisionsRequired, []);
      assert.equal(port.configurations.length, 1);
      const text = delivered(port.real);
      for (const value of [...HOME_1, ...HOME_2]) assert.ok(text.includes(value), `Migration Core delivers ${value} as contact.email`);
    } finally {
      base.dispose();
    }
  });

  it('IC-08: two columns of one Contact file proposed for contact.email in one task compete in one output scope; the second is DUPLICATE_TARGET_WITHOUT_RESOLUTION and only the first reaches Migration Core', TIMEOUT, async () => {
    const WORK = ['ada.work@kauro-fixture.test', 'grace.work@kauro-fixture.test'];
    const bundle = makeBundle('b03-ic08-scope', { contacts: `Contact ID,First Name,Last Name,Home Email,Work Email\n1,Ada,Lovelace,${HOME_1[0] ?? ''},${WORK[0] ?? ''}\n2,Grace,Hopper,${HOME_1[1] ?? ''},${WORK[1] ?? ''}\n` });
    try {
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const email = targetRefOf('SALESFORCE', profiled, contract, 'Email');
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      // The first round maps both columns to Email; the model then repairs by preserving the one the compiler refused.
      const order: string[] = [];
      const gateway = recordingGateway(
        answeringTransport((item, context) => {
          if (!['Home Email', 'Work Email'].includes(context.header) || !context.allowedTargetRefs.includes(email)) return item;
          if (!context.repair) {
            order.push(context.header);
            return mapTo(item, email);
          }
          return context.header === order[1] ? preserve(item) : mapTo(item, email);
        }),
      );
      const input = inputFor('SALESFORCE', profiled, contract);
      const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run({ ...input, projectRevision: { ...input.projectRevision, declaredObjects: DECLARED } }, { ...CONTEXT, auditAttemptId: 'b03-ic08-scope' });
      assert.equal(order.length, 2, 'both columns were answered in one proposal');
      const refused = taskOutcomes(result).filter((entry) => entry.codes.includes('DUPLICATE_TARGET_WITHOUT_RESOLUTION'));
      assert.equal(refused.length, 1, `the second claim in the scope is refused by name: ${JSON.stringify(taskOutcomes(result))}`);
      assert.equal(refused[0]?.outcome, 'INVALID_SEMANTICS');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const emails = (result.draft.configuration?.fields ?? []).filter((field) => field.destinationField === 'contact.email');
      assert.deepEqual(emails.map((field) => field.columnHeader), [order[0]], 'only the first claim reaches Migration Core');
      const text = delivered(port.real);
      const [first, second] = order[0] === 'Home Email' ? [HOME_1, WORK] : [WORK, HOME_1];
      for (const value of first) assert.ok(text.includes(value), `the first column is delivered: ${value}`);
      for (const value of second) assert.ok(!text.includes(value), `the second column is not delivered as contact.email: ${value}`);
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ R2-037

describe('B03-ACCOUNTING — R2-037: every expected candidate has exactly one disposition (D3-ACC-1, D3-ACC-2, D3-ACC-3)', () => {
  /** Two contacts sharing an email (a duplicate cluster), unique local phones (a key candidate, an ambiguous shape and unmapped material on one deterministically mapped field). */
  const CONTACTS = 'Contact ID,First Name,Last Name,Email,Phone,Status\n1,Ada,Lovelace,ada@kauro-fixture.test,300 123 4567,Active\n2,Grace,Hopper,grace@kauro-fixture.test,300 123 4568,Inactive\n3,Alan,Turing,alan@kauro-fixture.test,300 123 4569,Active\n4,Alan,Turing,alan@kauro-fixture.test,300 123 4570,Active\n';

  it("R2-037: every original candidate — a duplicate cluster with row refs, two candidates on one deterministically mapped field, a key candidate and unmapped material — has exactly one disposition in the result's candidate accounting; the finalizer's accounting check refuses a disposition list that misses or duplicates one", TIMEOUT, async () => {
    const bundle = makeBundle('b03-r2037-originals', { contacts: CONTACTS });
    try {
      const profiled = profileWithTruth(bundle, 'CLEAN_ONLY');
      const originals = profiled.candidateSet.candidateSet.candidates;
      const cluster = originals.find((candidate) => candidate.candidateType === 'DUPLICATE_CLUSTER');
      assert.ok(cluster !== undefined && cluster.sourceRefs.length >= 2, 'Migration Core reports a duplicate cluster with its row refs');
      const phone = locatorOf(profiled.profile, 'Phone');
      const onPhone = originals.filter((candidate) => candidate.sourceRefs.includes(phone));
      assert.ok(onPhone.length >= 2, `two or more originals stand on the Phone column: ${onPhone.map((candidate) => candidate.candidateType).join(', ')}`);
      const key = originals.find((candidate) => candidate.candidateType === 'KEY_CANDIDATE' && candidate.sourceRefs.includes(locatorOf(profiled.profile, 'Contact ID')));
      assert.ok(key !== undefined, 'Contact ID is a key candidate');
      const unmapped = originals.find((candidate) => candidate.candidateType === 'UNMAPPED_MATERIAL');
      assert.ok(unmapped !== undefined, 'the dry run reports unmapped material');

      const input: IntelligenceInput = { ...inputFor('CLEAN_ONLY', profiled, null), projectRevision: { ...inputFor('CLEAN_ONLY', profiled, null).projectRevision, declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } } };
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock }));
      const gateway = recordingGateway(answeringTransport((item) => item));
      const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-r2037-originals' });
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.ok((result.draft.configuration?.fields ?? []).some((field) => field.columnHeader === 'Phone' && field.destinationField === 'contact.phone'), 'Phone is mapped deterministically');
      const found = accounting(result);

      const expected = expectedOf(input);
      for (const original of originals) assert.ok(expected.candidates.some((candidate) => candidate.candidateRef === original.candidateRef && candidate.origin === 'MIGRATION_CORE'), `the expected set holds the original ${original.candidateType}`);
      assert.ok(expected.candidates.some((candidate) => candidate.origin === 'RESOLVER'), 'and the resolver-derived candidates');
      assertExactlyOnce(expected, found);
      const of = (ref: string): Disposition | undefined => found.dispositions.find((entry) => entry.candidateRef === ref);
      // Originals keep their own disposition; a family not yet planned is an explicit UNRESOLVED, never an omission (D3-ACC-2). Since B03-CAP-IDENTITY the duplicate cluster is answered by the DUPLICATE_SIGNAL_STRATEGY question over its file — on which the answering transport abstains — and the key candidate on the declared record id by that declaration.
      assert.deepEqual([of(cluster.candidateRef)?.family, of(cluster.candidateRef)?.disposition, of(cluster.candidateRef)?.code], ['DUPLICATE_SIGNAL_STRATEGY', 'PRESERVED', 'ABSTAIN']);
      assert.ok(of(cluster.candidateRef)?.taskId !== null, 'the question that answered the cluster names its task');
      assert.deepEqual([of(key.candidateRef)?.family, of(key.candidateRef)?.disposition, of(key.candidateRef)?.code], ['IDENTITY_STRATEGY', 'DETERMINISTIC', 'DECLARED_RECORD_ID']);
      // Unmapped material has its family since B03-CAP-STRUCTURE (D3-CAP-09): each original is answered by what the run did with its column — mapped on facts, or the one question about the column — never left unplanned.
      for (const material of originals.filter((candidate) => candidate.candidateType === 'UNMAPPED_MATERIAL')) {
        assert.equal(of(material.candidateRef)?.family, 'UNMAPPED_HANDLING');
        assert.ok(['DETERMINISTIC', 'PRESERVED', 'PROPOSED'].includes(of(material.candidateRef)?.disposition ?? ''), `unmapped material ${material.candidateRef}: ${JSON.stringify(of(material.candidateRef))}`);
      }
      assert.ok(of(unmapped.candidateRef) !== undefined);
      for (const original of onPhone) assert.equal(of(original.candidateRef)?.origin, 'MIGRATION_CORE', `${original.candidateType} on Phone has its own disposition`);
      assert.equal(new Set(onPhone.map((original) => of(original.candidateRef)?.family)).size, onPhone.length, 'each original on the Phone column is routed by its own type');
      // The run is honest about it: coverage is complete exactly when no candidate is left UNRESOLVED or pending, and the draft says so. Every family of this scenario has landed (B03-CAP-STRUCTURE, B03-CAP-VALUES, B03-CAP-IDENTITY), so nothing is left open here; the rows below that leave a candidate open assert the incomplete side.
      const open = found.dispositions.filter((entry) => entry.disposition === 'UNRESOLVED' || entry.disposition.startsWith('PENDING')).length;
      assert.equal(open, 0, JSON.stringify(found.dispositions.filter((entry) => entry.disposition === 'UNRESOLVED')));
      assert.equal(found.coverage.complete, open === 0);
      assert.equal(found.coverage.expectedCandidates, expected.candidates.length);
      assert.equal(found.coverage.unresolvedCandidates, found.dispositions.filter((entry) => entry.disposition === 'UNRESOLVED').length);
      assert.equal(draftCoverageOf(result)?.complete, open === 0, "the draft's coverage says what the dispositions say");

      // The finalizer's check: a list that misses one, duplicates one or invents one is refused by name.
      assert.equal(typeof candidateAccountingProblems, 'function', 'candidateAccountingProblems is exported (D3-ACC-1)');
      const check = candidateAccountingProblems as AccountingProblems;
      assert.deepEqual(check(expected, found.dispositions), [], 'the list the run made is exact');
      const dropped = found.dispositions.filter((entry) => entry.candidateRef !== cluster.candidateRef);
      assert.ok(check(expected, dropped).some((problem) => problem.includes('MISSING') && problem.includes(cluster.candidateRef)), JSON.stringify(check(expected, dropped)));
      const doubled = [...found.dispositions, { ...(of(key.candidateRef) as Disposition), disposition: 'PRESERVED' }];
      assert.ok(check(expected, doubled).some((problem) => problem.includes('DUPLICATE') && problem.includes(key.candidateRef)), JSON.stringify(check(expected, doubled)));
      const invented = [...found.dispositions, { ...(of(key.candidateRef) as Disposition), candidateRef: 'cand_00000000000000ff' }];
      assert.ok(check(expected, invented).some((problem) => problem.includes('cand_00000000000000ff')), JSON.stringify(check(expected, invented)));

      // Through a public run: a candidate set that repeats one candidate cannot be accounted exactly once, so the finalizer fails the run instead of drafting.
      const repeatedSet = { ...profiled.candidateSet.candidateSet, candidates: [...originals, key], limits: { ...profiled.candidateSet.candidateSet.limits, produced: originals.length + 1 } };
      const repeated: HashedCandidateSet = { candidateSet: repeatedSet, candidateSetHash: hashCandidateSet(repeatedSet) };
      const clock2 = new VirtualClock();
      const port2 = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock: clock2 }));
      const failed = await createIntelligenceCore(depsFor(recordingGateway(answeringTransport((item) => item)), port2, clock2)).run({ ...input, candidateSet: repeated }, { ...CONTEXT, auditAttemptId: 'b03-r2037-repeated' });
      assert.equal(failed.state, 'FAILED_COMPILER', JSON.stringify(failed.unresolvedItems));
      assert.equal(failed.draft.status, 'NOT_DRAFTABLE');
      assert.ok(failed.unresolvedItems.some((entry) => entry.codes.includes('CANDIDATE_ACCOUNTING_INCOMPLETE') && entry.codes.some((code) => code.includes(key.candidateRef))), JSON.stringify(failed.unresolvedItems));
      assert.equal(port2.configurations.length, 0, 'nothing is validated over an accounting that does not hold');
    } finally {
      bundle.dispose();
    }
  });

  it('R2-037: a proposal that omits a candidate of its envelope is INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED, repaired at most once, and the candidate is never preserved as if answered', TIMEOUT, async () => {
    const bundle = makeBundle('b03-r2037-omission', { contacts: 'Contact ID,First Name,Last Name,Email,Home City,Mystery\n1,Ada,Lovelace,ada@kauro-fixture.test,London,m1\n2,Grace,Hopper,grace@kauro-fixture.test,Arlington,m2\n' });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input: IntelligenceInput = { ...inputFor('CLEAN_ONLY', profiled, null), projectRevision: { ...inputFor('CLEAN_ONLY', profiled, null).projectRevision, declaredObjects: DECLARED } };
      /** A transport that leaves the first candidate of the first multi-candidate task out of its answer — in the first round only, or in every round. */
      const omitting = (everyRound: boolean): { transport: Transport; omitted: () => { taskId: string; candidateRef: string } | null } => {
        let omitted: { taskId: string; candidateRef: string } | null = null;
        const transport = answeringTransport((item, context) => {
          if (context.envelope.deterministicCandidates.length < 2) return item;
          if (omitted === null) omitted = { taskId: context.envelope.taskId, candidateRef: context.envelope.deterministicCandidates[0]?.candidateRef ?? '' };
          const hit = omitted.taskId === context.envelope.taskId && omitted.candidateRef === item.candidateRef && (everyRound || !context.repair);
          return hit ? null : item;
        });
        return { transport, omitted: () => omitted };
      };

      // Repaired: the first answer leaves one out, the repair answers it; two requests for the task, and the run drafts.
      const once = omitting(false);
      const clock = new VirtualClock();
      const gateway = recordingGateway(once.transport);
      const repaired = await createIntelligenceCore(depsFor(gateway, recordingPort(realValidationPort(bundle, profiled.profile, null, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-r2037-omission-1' });
      const target = once.omitted();
      assert.ok(target !== null, 'a task with two or more candidates was answered');
      const first = taskOutcomes(repaired).find((entry) => entry.taskId === target.taskId && entry.attempt === 1);
      assert.equal(first?.outcome, 'INVALID_SEMANTICS', JSON.stringify(taskOutcomes(repaired)));
      assert.ok(first?.codes.includes('CANDIDATE_NOT_ANSWERED'), JSON.stringify(first));
      assert.ok(!JSON.stringify(repaired).includes('CANDIDATE_NOT_ANSWERED_PRESERVED'), 'an omission is never preserved as if answered');
      assert.equal(gateway.requests.filter((request) => request.envelope.taskId === target.taskId).length, 2, 'repaired once');
      assert.equal(gateway.requests.find((request) => request.envelope.taskId === target.taskId && request.envelope.repairContext !== null)?.envelope.repairContext?.validationCodes.includes('CANDIDATE_NOT_ANSWERED'), true, 'the repair names the omission by its code');
      assert.equal(repaired.state, 'PROPOSAL_READY', JSON.stringify(repaired.unresolvedItems));
      const answered = accounting(repaired).dispositions.find((entry) => entry.candidateRef === target.candidateRef);
      assert.ok(answered !== undefined && answered.code !== 'CANDIDATE_NOT_ANSWERED' && answered.disposition !== 'FAILED', `the repaired answer decides the candidate: ${JSON.stringify(answered)}`);

      // Omitted again in the repair: final, no third request, the run fails, and the candidate is FAILED CANDIDATE_NOT_ANSWERED — never PRESERVED.
      const always = omitting(true);
      const clock2 = new VirtualClock();
      const gateway2 = recordingGateway(always.transport);
      const port2 = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock: clock2 }));
      const refused = await createIntelligenceCore(depsFor(gateway2, port2, clock2)).run(input, { ...CONTEXT, auditAttemptId: 'b03-r2037-omission-2' });
      const target2 = always.omitted();
      assert.ok(target2 !== null);
      assert.equal(gateway2.requests.filter((request) => request.envelope.taskId === target2.taskId).length, 2, 'at most one repair: no third request');
      assert.deepEqual(taskOutcomes(refused).filter((entry) => entry.taskId === target2.taskId).map((entry) => [entry.attempt, entry.outcome, entry.codes.includes('CANDIDATE_NOT_ANSWERED')]), [[1, 'INVALID_SEMANTICS', true], [2, 'INVALID_SEMANTICS', true]]);
      assert.equal(refused.state, 'FAILED_COMPILER', JSON.stringify(refused.unresolvedItems));
      assert.equal(refused.draft.status, 'NOT_DRAFTABLE');
      assert.equal(port2.configurations.length, 0);
      const never = accounting(refused).dispositions.find((entry) => entry.candidateRef === target2.candidateRef);
      assert.deepEqual([never?.disposition, never?.code], ['FAILED', 'CANDIDATE_NOT_ANSWERED']);
    } finally {
      bundle.dispose();
    }
  });

  it("R2-037: candidates beyond the task cap are PENDING_CAP dispositions naming their candidate refs, and the draft's coverage says incomplete", TIMEOUT, async () => {
    const bundle = makeBundle('b03-r2037-cap', { extraColumns: 80 });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input: IntelligenceInput = { ...inputFor('CLEAN_ONLY', profiled, null), projectRevision: { ...inputFor('CLEAN_ONLY', profiled, null).projectRevision, declaredObjects: DECLARED } };
      const seen: IntelligenceEnvelopeV1[] = [];
      const gateway = recordingGateway(answeringTransport((item) => item, seen));
      const clock = new VirtualClock();
      const result = await createIntelligenceCore(depsFor(gateway, recordingPort(realValidationPort(bundle, profiled.profile, null, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-r2037-cap' });
      assert.equal(new Set(gateway.requests.map((request) => request.envelope.taskId)).size, BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT, 'the cap is reached: thirty-two tasks, no more');
      const found = accounting(result);
      const expected = expectedOf(input);
      assertExactlyOnce(expected, found);
      const sent = new Set(seen.flatMap((envelope) => envelope.deterministicCandidates.map((candidate) => candidate.candidateRef)));
      const unsent = expected.candidates.filter((candidate) => candidate.origin === 'RESOLVER' && !sent.has(candidate.candidateRef)).map((candidate) => candidate.candidateRef).sort();
      assert.ok(unsent.length > 0, 'some derived candidates are beyond the cap');
      const pending = found.dispositions.filter((entry) => entry.disposition === 'PENDING_CAP');
      assert.deepEqual(pending.map((entry) => entry.candidateRef).sort(), unsent, 'exactly the candidates no task carried are PENDING_CAP, by their own refs');
      assert.ok(pending.every((entry) => entry.code === 'TASK_CAP_REACHED' && entry.taskId === null), JSON.stringify(pending.slice(0, 3)));
      assert.equal(found.coverage.complete, false);
      assert.ok(found.coverage.pendingCandidates >= pending.length);
      const draft = draftCoverageOf(result);
      assert.ok(draft !== undefined, "the draft carries the coverage");
      assert.equal(draft.complete, false, "the draft's coverage says incomplete");
      assert.equal(draft.pendingCandidates, found.coverage.pendingCandidates);
    } finally {
      bundle.dispose();
    }
  });

  it('guard: the candidate accounting is closed — refs, families and codes only; a sentinel in a header, a value or a candidate type the set carried never reaches it', TIMEOUT, async () => {
    // Synthetic sentinels written for this file.
    const HEADER = 'Ondriel Vaskemar';
    const VALUE = 'Quontay';
    const TYPE = 'Pelsira_Quontay';
    const bundle = makeBundle('b03-accounting-closed', { contacts: `Contact ID,First Name,Last Name,Email,${HEADER}\n1,Ada,Lovelace,ada@kauro-fixture.test,${VALUE}\n2,Grace,Hopper,grace@kauro-fixture.test,${VALUE}\n` });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      // A candidate set that carries one original of a type outside Migration Core's vocabulary, rehashed as a host would hand it over.
      const forged = { candidateRef: 'cand_00000000000000f1', candidateType: TYPE as 'KEY_CANDIDATE', sourceRefs: [locatorOf(profiled.profile, HEADER)], allowedTargetRefs: [], allowedPrimitiveRefs: [], evidenceRefs: [], impactCounts: { rows: 2 }, constraints: { authority: 'NONE' as const, destructiveAllowed: false as const, identityAutoMergeAllowed: false as const } };
      const set = { ...profiled.candidateSet.candidateSet, candidates: [...profiled.candidateSet.candidateSet.candidates, forged], limits: { ...profiled.candidateSet.candidateSet.limits, produced: profiled.candidateSet.candidateSet.limits.produced + 1 } };
      const candidateSet: HashedCandidateSet = { candidateSet: set, candidateSetHash: hashCandidateSet(set) };
      const base = inputFor('CLEAN_ONLY', { profile: profiled.profile, candidateSet }, null, { categoricalSummaries: new Map([[locatorOf(profiled.profile, HEADER), [VALUE]]]) });
      const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } };
      const clock = new VirtualClock();
      const result = await createIntelligenceCore(depsFor(recordingGateway(answeringTransport((item) => item)), recordingPort(realValidationPort(bundle, profiled.profile, null, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-accounting-closed' });
      const found = accounting(result);
      assertExactlyOnce(expectedOf(input), found);
      const text = JSON.stringify([found, draftCoverageOf(result) ?? null]);
      for (const sentinel of [HEADER, 'Ondriel', 'Vaskemar', VALUE, TYPE, 'Pelsira']) assert.ok(!text.includes(sentinel), `the accounting carries no ${sentinel}`);
      const unrouted = found.dispositions.find((entry) => entry.candidateRef === forged.candidateRef);
      assert.deepEqual([unrouted?.candidateType, unrouted?.family, unrouted?.disposition, unrouted?.code], ['UNROUTED_CANDIDATE_TYPE', null, 'UNSUPPORTED', 'CANDIDATE_TYPE_UNROUTED'], 'a type no route knows is accounted by a closed name, never dropped');
      for (const entry of found.dispositions) {
        assert.match(entry.candidateRef, /^cand_[0-9a-f]{16}$/u);
        assert.match(entry.code, /^[A-Z][A-Z_]*$/u);
        assert.match(entry.candidateType, /^[A-Z][A-Z_]*$/u);
      }
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ S095

/** A HubSpot field of the S095 contract. */
function hubspotField(apiName: string, label: string, options: readonly string[] = []): TargetContract['objects'][number]['fields'][number] {
  return { apiName, label, type: options.length > 0 ? 'enumeration' : 'string', createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE', idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE', restrictedPicklist: 'FALSE', picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })), referenceTo: [], relationshipName: null, evidence: 'ARTIFACT' };
}
/** 2,048 distinct enumeration options made of vocabulary words: each travels on the OPTION channel, and three such lists outgrow one request. */
function vocabularyOptions(salt: number): string[] {
  const words = ['open', 'closed', 'won', 'lost', 'new', 'pending', 'done', 'active', 'inactive', 'high', 'low', 'medium', 'hot', 'warm', 'cold', 'lead', 'customer', 'qualified'];
  return Array.from({ length: 2048 }, (unused, index) => `${words[index % 18] ?? ''} ${words[Math.floor(index / 18) % 18] ?? ''} ${words[Math.floor(index / 324) % 18] ?? ''} ${words[(index + salt) % 18] ?? ''} ${words[(index * 7 + salt) % 18] ?? ''} ${String(index % 997)}`);
}
function s095Contract(): HashedTargetContract {
  return hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode: 'HUBSPOT', instanceId: '00000095', instanceLabel: 'fixture S095', evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects: [
      { apiName: 'contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [hubspotField('email', 'Email'), hubspotField('firstname', 'First name'), hubspotField('lastname', 'Last name'), hubspotField('jobtitle', 'Job title'), hubspotField('city', 'City'), hubspotField('lifecyclestage', 'Lifecycle stage', vocabularyOptions(1)), hubspotField('country', 'Country/Region', vocabularyOptions(2)), hubspotField('state', 'State/Region', vocabularyOptions(3))] },
      { apiName: 'company', label: 'Company', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [hubspotField('name', 'Name'), hubspotField('domain', 'Company domain name'), hubspotField('phone', 'Phone number'), hubspotField('website', 'Website URL'), hubspotField('city', 'City'), hubspotField('state', 'State/Region'), hubspotField('zip', 'Postal code'), hubspotField('country', 'Country/Region'), hubspotField('industry', 'Industry'), hubspotField('description', 'Description')] },
    ],
    pipelines: [],
  });
}

describe('B03-ACCOUNTING — S095: useful candidates beyond the task and request bounds stay visible (D3-PART-1)', () => {
  it('S095: a three-hundred-column schema is partitioned into at most thirty-two tasks whose envelopes each fit the per-request token bound; every candidate beyond them is pending by candidate ref and the coverage says incomplete, never truncated', TIMEOUT, async () => {
    // 42 contact columns whose open questions each carry three large picklists, and 258 company columns of padded codes: 300 columns in all.
    const contactHeaders = ['Contact ID', 'Email', ...Array.from({ length: 40 }, (unused, index) => `Mystery ${String(index + 1)}`)];
    const companyHeaders = ['Company ID', 'Name', ...Array.from({ length: 256 }, (unused, index) => `Code ${String(index + 1)}`)];
    const contacts = `${contactHeaders.join(',')}\n1,ada@kauro-fixture.test,${Array.from({ length: 40 }, () => 'qq').join(',')}\n2,grace@kauro-fixture.test,${Array.from({ length: 40 }, () => 'zz').join(',')}\n`;
    const companies = `${companyHeaders.join(',')}\nC1,Analytical Engines,${Array.from({ length: 256 }, () => ' ab ').join(',')}\nC2,COBOL Works,${Array.from({ length: 256 }, () => ' cd ').join(',')}\n`;
    assert.equal(contactHeaders.length + companyHeaders.length, 300);
    const bundle = makeBundle('b03-s095', { contacts, companies });
    try {
      const contract = s095Contract();
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const input: IntelligenceInput = { ...inputFor('HUBSPOT', profiled, contract), projectRevision: { ...inputFor('HUBSPOT', profiled, contract).projectRevision, declaredObjects: DECLARED } };
      const seen: IntelligenceEnvelopeV1[] = [];
      const gateway = recordingGateway(answeringTransport((item) => item, seen));
      const clock = new VirtualClock();
      const result = await createIntelligenceCore(depsFor(gateway, recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-s095' });

      // At most thirty-two tasks, and every request — the whole prepared provider request, in UTF-8 bytes, which no byte-level tokenizer exceeds — within the per-request bound.
      const taskIds = new Set(gateway.requests.map((request) => request.envelope.taskId));
      assert.ok(taskIds.size > 0 && taskIds.size <= BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT, `${String(taskIds.size)} tasks`);
      const sizes = gateway.requests.map((request) => Buffer.byteLength(JSON.stringify(buildProviderRequest(request)), 'utf8'));
      assert.ok(sizes.every((size) => size <= BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST), `the largest request is ${String(Math.max(...sizes))} bytes against a bound of ${String(BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST)}`);
      assert.ok(result.state !== 'BUDGET_EXHAUSTED', 'no request was refused at the ledger for its size');

      // Every expected candidate is accounted exactly once; the ones no task carried are pending by their own refs, for the cap and for the request bound.
      const expected = expectedOf(input);
      assert.equal(expected.truncated, false);
      const found = accounting(result);
      assertExactlyOnce(expected, found);
      assert.equal(found.dispositions.length, expected.candidates.length, 'nothing is cut from the list');
      const sent = new Set(seen.flatMap((envelope) => envelope.deterministicCandidates.map((candidate) => candidate.candidateRef)));
      const unsent = expected.candidates.filter((candidate) => candidate.origin === 'RESOLVER' && !sent.has(candidate.candidateRef)).map((candidate) => candidate.candidateRef).sort();
      const pending = found.dispositions.filter((entry) => entry.disposition === 'PENDING_CAP');
      assert.deepEqual(pending.map((entry) => entry.candidateRef).sort(), unsent);
      assert.ok(pending.some((entry) => entry.code === 'REQUEST_BOUND_EXCEEDED'), 'a question whose envelope cannot fit one request is pending, never sent');
      assert.ok(pending.some((entry) => entry.code === 'TASK_CAP_REACHED'), 'the questions beyond the thirty-second task are pending');
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const mysteryFields = new Set([...contracts.refs.fieldByRef.entries()].filter(([, entry]) => entry.header.startsWith('Mystery')).map(([fieldRef]) => fieldRef));
      assert.equal(mysteryFields.size, 40);
      assert.ok(seen.every((envelope) => envelope.sourceProfile.fields.every((field) => !mysteryFields.has(field.fieldRef))), 'no envelope carries a contact question the bound excludes');
      const boundCodes = new Set(pending.filter((entry) => entry.code === 'REQUEST_BOUND_EXCEEDED').map((entry) => entry.candidateRef));
      assert.equal(boundCodes.size, 40, 'each of the forty contact questions carrying the three picklists is pending for the request bound');
      assert.equal(found.coverage.complete, false, 'the coverage says incomplete');
      assert.equal(found.coverage.candidateSetTruncated, false, 'and says so by pending refs, not by truncation');
      assert.equal(found.coverage.pendingCandidates, found.dispositions.filter((entry) => entry.disposition.startsWith('PENDING')).length);
      assert.equal(draftCoverageOf(result)?.complete, false);
    } finally {
      bundle.dispose();
    }
  });

  it('guard: the request-size estimate the planner partitions under bounds every request the run sends, a repair round with exemplars and memory evidence included', TIMEOUT, async () => {
    type Estimator = (input: { readonly contracts: ReturnType<typeof adaptContracts>; readonly derivedCandidates: readonly unknown[]; readonly summaries: ReadonlyMap<string, readonly string[]>; readonly memory: readonly unknown[]; readonly projectRevisionId: string; readonly supportEnvelopeVersion: string }) => (questions: readonly unknown[]) => number;
    const estimator = exported['requestSizeEstimator'] as Estimator | undefined;
    assert.equal(typeof estimator, 'function', 'the estimate is exported for the host to plan with');
    const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
    const bundle = makeBundle('b03-estimate', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Status,Stage Note,Mystery\n1,Ada,Lovelace,ada@kauro-fixture.test,,lead,open,m1\n2,Grace,Hopper,grace@kauro-fixture.test,,OPEN,closed,m2\n3,Alan,Turing,alan@kauro-fixture.test,,lead,pending,m3\n' });
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const stage = targetRefOf('HUBSPOT', profiled, contract, 'lifecyclestage');
      const summaries = new Map<string, readonly string[]>([[locatorOf(profiled.profile, 'Status'), ['lead', 'OPEN']], [locatorOf(profiled.profile, 'Stage Note'), ['open', 'closed', 'pending']]]);
      const memory = [{ memoryId: 'mem_00000000000000e1', scope: 'CLIENT' as const, tenant: { agencyId: CONTEXT.tenant.agencyId, clientId: CONTEXT.tenant.clientId }, knowledgeType: 'FIELD_MAPPING_CONVENTION' as const, ruleOrPattern: { sourceHeaderPattern: 'status', targetRef: stage, semanticType: 'ENUM' }, sourceProjectRef: 'proj-1', sourcePlanVersion: '3', targetInstanceRef: contract.contract.instance.instanceId, targetSchemaVersion: contract.contract.contractVersion, approvedBy: 'user:ana', verificationOutcome: 'IMPORT_VERIFIED' as const, provenance: 'run x task y', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE' as const, version: 1 }];
      const base = inputFor('HUBSPOT', profiled, contract, { categoricalSummaries: summaries, scopedMemorySnapshot: memory });
      const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } };
      // The first answer leaves a candidate out, so every multi-candidate task is sent twice: the second time with its repair context.
      const gateway = recordingGateway(answeringTransport((item, context) => (!context.repair && context.envelope.deterministicCandidates.length > 1 && item.candidateRef === context.envelope.deterministicCandidates[0]?.candidateRef ? null : item)));
      const clock = new VirtualClock();
      await createIntelligenceCore(depsFor(gateway, recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-estimate' });
      assert.ok(gateway.requests.some((request) => request.envelope.repairContext !== null), 'a repair round was sent');
      assert.ok(gateway.requests.some((request) => request.envelope.exemplars.length > 0), 'an envelope carried exemplars');
      assert.ok(gateway.requests.some((request) => request.envelope.memoryEvidence.length > 0), 'an envelope carried memory evidence');
      // The same estimate, over the questions of each task as the run planned them.
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const resolution = publicIndex.resolveDeterministically(contracts, { declaredObjects: DECLARED });
      const estimate = (estimator as Estimator)({ contracts, derivedCandidates: resolution.derivedCandidates, summaries, memory, projectRevisionId: input.projectRevision.projectRevisionId, supportEnvelopeVersion: input.projectRevision.supportEnvelopeVersion });
      for (const request of gateway.requests) {
        const refs = new Set(request.envelope.deterministicCandidates.map((candidate) => candidate.candidateRef));
        const questions = resolution.openQuestions.filter((question) => question.candidateRefs.some((ref) => refs.has(ref)));
        const actual = Buffer.byteLength(JSON.stringify(buildProviderRequest(request)), 'utf8');
        assert.ok(estimate(questions) >= actual, `the estimate ${String(estimate(questions))} bounds the ${String(actual)} bytes sent for task ${request.envelope.taskId} (repair ${String(request.envelope.repairContext !== null)})`);
      }
    } finally {
      bundle.dispose();
    }
  });
});

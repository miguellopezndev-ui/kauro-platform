/**
 * B03-PLAN-COMPILER — the plan compiler (D3-PLAN-1; review finding B03-R1):
 * `planCandidates` fixes the expected candidate set before any request, and
 * `compileSelection` turns the agency's selection over that set, with the
 * audit's decision evidence, into a CandidateConfiguration 2.0.0 — or into a
 * closed rejection that compiles nothing.
 *
 * No case here uses a gateway. The audit whose evidence a selection rests on
 * is either a run that decided every column on facts (a gateway that fails
 * the test if it is ever called) or the resolver's own decisions, which is
 * what a host stores at PROFILE; the configurations the compiler makes are
 * validated by the real Migration Core port over the whole fixture bundle.
 *
 * The cases were written first, against ic/b03-stage-1, through a loose view
 * of the package index (on that base there was no `compileSelection` to
 * import); they now import the compiler's types from the index, and the
 * assertions are the ones first committed.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { HashedCandidateSet, HashedSourceProfile } from 'kauro-migration-core';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import * as api from '../src/index.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { IntelligenceInput } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import type { Bundle } from './support/fixtures.js';

type Loose = Readonly<Record<string, unknown>>;

type EvidenceEntry = api.PlanDecisionEvidence;
type Choice = api.CandidateChoice;
type CandidateDecision = api.CandidateDecision;
type Request = api.CompileSelectionRequest;

/** The compiled selection as this file reads it: the success and the rejection members both, loosely. */
interface Compiled {
  readonly ok: boolean;
  readonly configuration?: Loose & { readonly records: readonly Loose[]; readonly fields: readonly Loose[]; readonly preservedColumns: readonly Loose[] };
  readonly configurationDigest?: string;
  readonly coreConfigHash?: string;
  readonly fragments?: readonly Loose[];
  readonly rejections?: readonly { readonly code: string; readonly ref: string | null }[];
}

function compile(request: Request): Compiled {
  return api.compileSelection(request) as unknown as Compiled;
}

const CONTACTS = 'Email,First Name,Last Name,Phone\nada@kauro-fixture.test,Ada,Lovelace,+57 300 123 4567\ngrace@kauro-fixture.test,Grace,Hopper,+1 415 555 0100\nalan@kauro-fixture.test,Alan,Turing,+44 20 7946 0000\n';
const COMPANIES = 'Name,Website\nAnalytical Engines,https://analytical.test\nCOBOL Works,https://cobol.test\n';
const DECLARED_OBJECTS = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } as const;

/** Two files whose every column the resolver decides on facts: no question, no gateway call. */
function deterministicBundle(name: string): Bundle {
  const made = makeBundle(name, { contacts: CONTACTS, companies: COMPANIES });
  return { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Email' : 'Name' })) };
}

function deterministicInput(profiled: { readonly profile: HashedSourceProfile; readonly candidateSet: HashedCandidateSet }): IntelligenceInput {
  const base = inputFor('CLEAN_ONLY', profiled, null);
  return { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED_OBJECTS } };
}

/** A gateway that fails the test's premise if it is ever called; labelled SIMULATED, as a stand-in is. */
function noModel(): { readonly gateway: ModelGateway; readonly calls: () => number } {
  let calls = 0;
  const gateway = {
    name: 'no-model',
    evidenceClass: 'SIMULATED' as const,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      calls += 1;
      throw new Error(`the run called the model for task ${request.envelope.taskId}; nothing here goes to a model`);
    },
  };
  return { gateway, calls: () => calls };
}

/** The columns of the profile by header and file path, for choosing which candidate is which. */
function candidateOn(input: IntelligenceInput, header: string, filePath: string, candidateType: string): string {
  const contracts = api.adaptContracts({ mode: input.projectRevision.mode, profile: input.sourceProfile, candidateSet: input.candidateSet, targetContract: input.targetContract });
  const found = contracts.candidates.filter((candidate) => candidate.candidateType === candidateType && candidate.sourceRefs.some((ref) => contracts.refs.fieldByRef.get(ref)?.header === header && contracts.refs.fieldByRef.get(ref)?.filePath === filePath));
  assert.equal(found.length, 1, `exactly one ${candidateType} on ${filePath}:${header}`);
  return (found[0] as { readonly candidateRef: string }).candidateRef;
}

interface Scenario {
  readonly bundle: Bundle;
  readonly profiled: ReturnType<typeof profileBundle>;
  readonly input: IntelligenceInput;
  readonly request: Request;
}

/** Scenario A: the audit decided every column on facts; its DecisionEvidence is the manifest of a real run with no gateway call. */
async function auditedScenario(name: string): Promise<Scenario> {
  const bundle = deterministicBundle(name);
  const profiled = profileBundle(bundle, 'CLEAN_ONLY');
  const input = deterministicInput(profiled);
  const expected = api.planCandidates(input);
  const clock = new VirtualClock();
  const model = noModel();
  const audit = await createIntelligenceCore(depsFor(model.gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
  assert.equal(model.calls(), 0, 'the audit called no model');
  assert.equal(audit.state, 'PROPOSAL_READY', JSON.stringify(audit.unresolvedItems));
  const entries = (audit.draft.fragmentCoverage?.entries ?? []).map((entry): EvidenceEntry => ({ decisionRef: entry.decisionRef, fragmentKind: entry.fragmentKind, rule: entry.rule, origin: entry.origin, evidenceRefs: entry.evidenceRefs }));
  const deterministic = entries.filter((entry) => entry.origin === 'DETERMINISTIC' && (entry.fragmentKind === 'FIELD' || entry.fragmentKind === 'PRESERVED_COLUMN')).map((entry) => ({ decisionRef: entry.decisionRef, rule: entry.rule }));
  const identify = new Set([candidateOn(input, 'Email', 'contacts.csv', 'KEY_CANDIDATE'), candidateOn(input, 'Name', 'companies.csv', 'KEY_CANDIDATE')]);
  const candidates = expected.candidates.map((candidate): CandidateDecision => ({ candidateRef: candidate.candidateRef, choice: identify.has(candidate.candidateRef) ? { action: 'IDENTIFY', primitive: 'SOURCE_RECORD_ID_COLUMN' } : { action: 'DECLINE' }, rationale: 'the agency looked at the sample rows and prefers this one' }));
  return { bundle, profiled, input, request: { input, expected, evidence: { expectedSetHash: expected.expectedSetHash, entries }, selection: { candidates, deterministic } } };
}

/** Scenario B: a bundle with two questions the facts do not answer; the evidence is what the resolver decided, as a host stores it at PROFILE, and no run happens. */
function questionedScenario(name: string): Scenario & { readonly derived: readonly string[] } {
  const bundle = makeBundle(name);
  const profiled = profileBundle(bundle, 'CLEAN_ONLY');
  const input = inputFor('CLEAN_ONLY', profiled, null);
  const expected = api.planCandidates(input);
  const contracts = api.adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
  const resolution = api.resolveDeterministically(contracts, {});
  const entries = resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING' || decision.kind === 'PRESERVE_UNMAPPED').map((decision): EvidenceEntry => ({ decisionRef: decision.decisionRef, fragmentKind: decision.kind === 'FIELD_MAPPING' ? 'FIELD' : 'PRESERVED_COLUMN', rule: decision.rule, origin: 'DETERMINISTIC', evidenceRefs: decision.evidenceRefs }));
  const deterministic = resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING').map((decision) => ({ decisionRef: decision.decisionRef, rule: decision.rule }));
  const identify = new Set([candidateOn(input, 'Contact ID', 'contacts.csv', 'KEY_CANDIDATE'), candidateOn(input, 'Company ID', 'companies.csv', 'KEY_CANDIDATE')]);
  const derived = resolution.derivedCandidates;
  const mapped = new Map(derived.map((candidate) => {
    const target = candidate.allowedTargetRefs.find((ref) => contracts.refs.targetByRef.get(ref)?.destinationField.endsWith('.description'));
    assert.ok(target !== undefined, 'a description target is allowed for the unanswered column');
    return [candidate.candidateRef, target] as const;
  }));
  const candidates = expected.candidates.map((candidate): CandidateDecision => {
    if (identify.has(candidate.candidateRef)) return { candidateRef: candidate.candidateRef, choice: { action: 'IDENTIFY', primitive: 'SOURCE_RECORD_ID_COLUMN' } };
    const target = mapped.get(candidate.candidateRef);
    if (target !== undefined) return { candidateRef: candidate.candidateRef, choice: { action: 'MAP', targetRef: target, semanticType: 'TEXT', primitive: 'TRIM_WHITESPACE' } };
    return { candidateRef: candidate.candidateRef, choice: { action: 'DECLINE' } };
  });
  return { bundle, profiled, input, derived: derived.map((candidate) => candidate.candidateRef), request: { input, expected, evidence: { expectedSetHash: expected.expectedSetHash, entries }, selection: { candidates, deterministic } } };
}

function withCandidates(request: Request, candidates: readonly CandidateDecision[]): Request {
  return { ...request, selection: { ...request.selection, candidates } };
}

function rejectedWith(result: Compiled, code: string, ref: string | null, message: string): void {
  assert.equal(result.ok, false, `${message}: rejected`);
  assert.equal(result.configuration, undefined, `${message}: compiles nothing`);
  assert.equal(result.configurationDigest, undefined, `${message}: names no digest`);
  assert.ok((result.rejections ?? []).some((entry) => entry.code === code && entry.ref === ref), `${message}: ${code} on ${String(ref)} in ${JSON.stringify(result.rejections)}`);
}

describe('B03-PLAN-COMPILER: the expected candidate set before any request, and the agency selection compiled to a configuration', () => {
  it('CMD020-OK: planCandidates over a sealed profile returns the complete expected candidate set and its hash with no request and no spend, and a run of that attempt accounts for exactly that set', { timeout: 180_000 }, async () => {
    const scenario = await auditedScenario('b03-cmd020');
    try {
      // Through the package index, before and apart from any run: no gateway, no ledger, no clock is handed over.
      const expected = api.planCandidates(scenario.input);
      assert.deepEqual(api.planCandidates(scenario.input), expected, 'the same input has the same expected set');
      assert.match(expected.expectedSetHash, /^[0-9a-f]{64}$/u);
      assert.equal(expected.candidateSetHash, scenario.profiled.candidateSet.candidateSetHash);
      const contracts = api.adaptContracts({ mode: 'CLEAN_ONLY', profile: scenario.profiled.profile, candidateSet: scenario.profiled.candidateSet, targetContract: null });
      assert.equal(expected.truncated, false);
      assert.deepEqual([...expected.candidates.map((candidate) => candidate.candidateRef)].sort(), [...contracts.candidates.map((candidate) => candidate.candidateRef)].sort(), 'every original Migration Core handed over is expected, and this bundle derives no other');
      // A run of the same attempt accounts for exactly that set, with the model never reached.
      const clock = new VirtualClock();
      const model = noModel();
      const run = await createIntelligenceCore(depsFor(model.gateway, realValidationPort(scenario.bundle, scenario.profiled.profile, null, { clock }), clock)).run(scenario.input, CONTEXT);
      assert.equal(model.calls(), 0);
      const accounting = run.candidateAccounting;
      assert.ok(accounting !== null);
      assert.equal(accounting.expectedSetHash, expected.expectedSetHash, 'the run names the hash the host recorded at PROFILE');
      assert.deepEqual(accounting.dispositions.map((entry) => entry.candidateRef).sort(), expected.candidates.map((candidate) => candidate.candidateRef).sort(), 'one disposition per expected candidate and no other');
      // A profile of another bundle expects another set: the hash names the set.
      const other = makeBundle('b03-cmd020-other');
      try {
        const otherProfiled = profileBundle(other, 'CLEAN_ONLY');
        assert.notEqual(api.planCandidates(inputFor('CLEAN_ONLY', otherProfiled, null)).expectedSetHash, expected.expectedSetHash);
      } finally {
        other.dispose();
      }
    } finally {
      scenario.bundle.dispose();
    }
  });

  it('CMD022-OK: the plan compiler turns an agency selection over the audit\'s candidate set into a configuration through the allowed primitive intersection, and Migration Core validates it as a new draft', { timeout: 240_000 }, async () => {
    for (const build of [() => auditedScenario('b03-cmd022-ok-a'), () => Promise.resolve(questionedScenario('b03-cmd022-ok-b'))]) {
      const scenario = await build();
      try {
        const result = compile(scenario.request);
        assert.equal(result.ok, true, JSON.stringify(result.rejections));
        const configuration = result.configuration;
        assert.ok(configuration !== undefined);
        assert.equal(configuration['profileHash'], scenario.profiled.profile.profileHash);
        assert.equal(configuration['candidateSetHash'], scenario.profiled.candidateSet.candidateSetHash);
        assert.equal(result.configurationDigest, digestOf(configuration), 'the digest is the canonical digest of the configuration the host validates');
        // One record mapping per file, each on the identity the agency chose; every fragment names a decision and a hash.
        assert.equal(configuration.records.length, 2);
        assert.ok(configuration.records.every((record) => record['sourceRecordIdColumn'] !== null), 'the agency chose the record id column of each file');
        for (const fragment of [...configuration.records, ...configuration.fields, ...configuration.preservedColumns]) {
          assert.match(String(fragment['decisionRef']), /^(?:dec|cand)_[0-9a-f]{16}$/u);
          assert.match(String(fragment['fragmentHash']), /^[0-9a-f]{64}$/u);
        }
        // The port is the real Migration Core over the whole bundle: the configuration validates as a new draft.
        const receipt = await realValidationPort(scenario.bundle, scenario.profiled.profile, null).validate(configuration as never);
        assert.equal(receipt.ok, true, JSON.stringify(receipt.problems));
        assert.equal(receipt.packageVerified, true);
        assert.equal(receipt.evidence.coreConfigHash, result.coreConfigHash, 'the receipt names the loader hash the compiler sealed');
        const consumed = new Set([...(receipt.effects?.records ?? []), ...(receipt.effects?.fields ?? [])].map((effect) => effect.fragmentHash));
        for (const fragment of [...configuration.records, ...configuration.fields]) assert.ok(consumed.has(String(fragment['fragmentHash'])), `Migration Core consumed ${String(fragment['decisionRef'])}`);
        if ('derived' in scenario) {
          // The mapping the agency chose for a question the facts did not answer is in the configuration, by its own primitive.
          const derived = (scenario as { readonly derived: readonly string[] }).derived;
          for (const candidateRef of derived) assert.ok(configuration.fields.some((field) => field['decisionRef'] === candidateRef && field['transformPrimitive'] === 'TRIM_WHITESPACE'), `${candidateRef} is a field with TRIM_WHITESPACE`);
        }
      } finally {
        scenario.bundle.dispose();
      }
    }
  });

  it('CMD022-DENY: a selection that misses, duplicates or invents a candidate, names a primitive outside the candidate\'s intersection or rests on rationale text alone is rejected with its reason and compiles nothing', { timeout: 240_000 }, () => {
    const scenario = questionedScenario('b03-cmd022-deny');
    try {
      const request = scenario.request;
      const candidates = request.selection.candidates;
      const first = candidates[0] as CandidateDecision;
      const mapped = candidates.find((entry) => entry.choice?.action === 'MAP') as CandidateDecision;
      const mappedTarget = mapped.choice?.action === 'MAP' ? mapped.choice.targetRef : '';
      assert.equal(compile(request).ok, true, 'the baseline selection compiles');

      // Omitted: the compiler rejects; it does not preserve what the agency never decided.
      rejectedWith(compile(withCandidates(request, candidates.slice(1))), 'MISSING_CANDIDATE', first.candidateRef, 'an omitted candidate');
      rejectedWith(compile(withCandidates(request, candidates.filter((entry) => entry.choice?.action !== 'MAP'))), 'MISSING_CANDIDATE', mapped.candidateRef, 'an omitted derived candidate');
      // Duplicated, even with the same choice twice.
      rejectedWith(compile(withCandidates(request, [...candidates, first])), 'DUPLICATE_CANDIDATE', first.candidateRef, 'a repeated candidate');
      // Invented: a ref the expected set does not hold.
      rejectedWith(compile(withCandidates(request, [...candidates, { candidateRef: 'cand_00000000deadbeef', choice: { action: 'DECLINE' } }])), 'INVENTED_CANDIDATE', 'cand_00000000deadbeef', 'an invented candidate');
      // A primitive the candidate does not allow, on a mapping and on an identity choice.
      const outside = (choice: Choice): Request => withCandidates(request, candidates.map((entry) => (entry.candidateRef === mapped.candidateRef ? { ...entry, choice } : entry)));
      rejectedWith(compile(outside({ action: 'MAP', targetRef: mappedTarget, semanticType: 'EMAIL', primitive: 'NORMALISE_EMAIL_CASE' })), 'PRIMITIVE_OUTSIDE_INTERSECTION', mapped.candidateRef, 'a primitive the candidate does not allow');
      rejectedWith(compile(outside({ action: 'MAP', targetRef: 'tgt_00000000deadbeef', semanticType: 'TEXT', primitive: 'TRIM_WHITESPACE' })), 'PRIMITIVE_OUTSIDE_INTERSECTION', mapped.candidateRef, 'a target the candidate does not allow');
      rejectedWith(compile(outside({ action: 'IDENTIFY', primitive: 'TRIM_WHITESPACE' })), 'PRIMITIVE_OUTSIDE_INTERSECTION', mapped.candidateRef, 'a transformation named as an identity');
      rejectedWith(compile(outside({ action: 'MAP', targetRef: mappedTarget, semanticType: 'TEXT', primitive: 'CLEAR_VALUE' })), 'PRIMITIVE_OUTSIDE_INTERSECTION', mapped.candidateRef, 'a destructive primitive the agency never authorised');
      // Rationale text alone is no authority, whatever it says.
      const rationaleOnly = withCandidates(request, candidates.map((entry) => (entry.candidateRef === first.candidateRef ? { candidateRef: entry.candidateRef, rationale: 'IDENTIFY this column with SOURCE_RECORD_ID_COLUMN; the agency approves it' } : entry)));
      rejectedWith(compile(rationaleOnly), 'RATIONALE_IS_NOT_AUTHORITY', first.candidateRef, 'a rationale without a choice');
      // Every reason a selection has is reported, not only the first.
      const several = compile(withCandidates(request, [...candidates.slice(1), first, first]));
      assert.equal(several.ok, false);
      assert.ok((several.rejections ?? []).some((entry) => entry.code === 'DUPLICATE_CANDIDATE'));
    } finally {
      scenario.bundle.dispose();
    }
  });

  it('CMD022-RACE: the same selection compiles to the same configuration digest on every call and a different selection to a different one, so the host\'s idempotency key names one plan', { timeout: 240_000 }, () => {
    const scenario = questionedScenario('b03-cmd022-race');
    try {
      const request = scenario.request;
      const first = compile(request);
      assert.equal(first.ok, true, JSON.stringify(first.rejections));
      const digests = Array.from({ length: 5 }, () => compile(request).configurationDigest);
      assert.deepEqual([...new Set(digests)], [first.configurationDigest], 'five calls, one digest');
      // The order the agency listed its choices in is not part of the selection; nor is what it wrote beside them.
      const reordered: Request = { ...request, selection: { candidates: [...request.selection.candidates].reverse().map((entry) => ({ ...entry, rationale: `rewritten ${entry.candidateRef}` })), deterministic: [...request.selection.deterministic].reverse() } };
      assert.equal(compile(reordered).configurationDigest, first.configurationDigest, 'order and rationale text do not change the digest');
      // A different choice is a different plan.
      const declined = withCandidates(request, request.selection.candidates.map((entry) => (entry.choice?.action === 'MAP' ? { candidateRef: entry.candidateRef, choice: { action: 'DECLINE' as const } } : entry)));
      const other = compile(declined);
      assert.equal(other.ok, true, JSON.stringify(other.rejections));
      assert.notEqual(other.configurationDigest, first.configurationDigest, 'a different selection has a different digest');
      const untrimmed = withCandidates(request, request.selection.candidates.map((entry) => (entry.choice?.action === 'MAP' ? { candidateRef: entry.candidateRef, choice: { ...entry.choice, primitive: 'PRESERVE_AS_IS' } } : entry)));
      assert.notEqual(compile(untrimmed).configurationDigest, first.configurationDigest, 'a different primitive is a different plan');
    } finally {
      scenario.bundle.dispose();
    }
  });

  it('IC-09: a plan selection whose deterministic fragment names no DecisionEvidence, or evidence of another rule or revision, is rejected with EVIDENCE_MISSING and compiles nothing', { timeout: 240_000 }, async () => {
    const scenario = await auditedScenario('b03-ic09-plan');
    try {
      const request = scenario.request;
      const baseline = compile(request);
      assert.equal(baseline.ok, true, JSON.stringify(baseline.rejections));
      // Every fragment the plan carries has its DecisionEvidence: the decision, the rule, the hash of the fragment.
      const configuration = baseline.configuration as NonNullable<Compiled['configuration']>;
      const hashes = new Set((baseline.fragments ?? []).map((entry) => entry['fragmentHash']));
      for (const fragment of [...configuration.records, ...configuration.fields, ...configuration.preservedColumns]) assert.ok(hashes.has(fragment['fragmentHash']), `${String(fragment['decisionRef'])} has DecisionEvidence`);
      const target = request.selection.deterministic[0] as { readonly decisionRef: string; readonly rule: string };
      // No evidence for the fragment's decision.
      rejectedWith(compile({ ...request, evidence: { ...request.evidence, entries: request.evidence.entries.filter((entry) => entry.decisionRef !== target.decisionRef) } }), 'EVIDENCE_MISSING', target.decisionRef, 'no DecisionEvidence for the decision');
      // Evidence of another rule than the selection asserts.
      rejectedWith(compile({ ...request, evidence: { ...request.evidence, entries: request.evidence.entries.map((entry) => (entry.decisionRef === target.decisionRef ? { ...entry, rule: 'A_RULE_THE_AUDIT_NEVER_APPLIED' } : entry)) } }), 'EVIDENCE_MISSING', target.decisionRef, 'evidence of another rule');
      rejectedWith(compile({ ...request, selection: { ...request.selection, deterministic: request.selection.deterministic.map((entry) => (entry.decisionRef === target.decisionRef ? { ...entry, rule: 'A_RULE_THE_AUDIT_NEVER_APPLIED' } : entry)) } }), 'EVIDENCE_MISSING', target.decisionRef, 'a selection asserting another rule');
      // Evidence of another revision of the candidate set.
      const anotherRevision = compile({ ...request, evidence: { ...request.evidence, expectedSetHash: digestOf('another revision') } });
      rejectedWith(anotherRevision, 'EVIDENCE_MISSING', target.decisionRef, 'evidence of another revision');
      // Evidence that is not deterministic evidence is no evidence for a deterministic fragment.
      rejectedWith(compile({ ...request, evidence: { ...request.evidence, entries: request.evidence.entries.map((entry) => (entry.decisionRef === target.decisionRef ? { ...entry, origin: 'PROPOSED' } : entry)) } }), 'EVIDENCE_MISSING', target.decisionRef, 'evidence of a proposal');
    } finally {
      scenario.bundle.dispose();
    }
  });
  it('guard: an expected set of another profile is a stale call, not a rejection of the selection, and the compiler is pure: the request is not changed', { timeout: 240_000 }, () => {
    const scenario = questionedScenario('b03-plan-guard');
    const other = makeBundle('b03-plan-guard-other', { extraColumns: 1 });
    try {
      const otherProfiled = profileBundle(other, 'CLEAN_ONLY');
      const foreign = api.planCandidates(inputFor('CLEAN_ONLY', otherProfiled, null));
      assert.throws(() => compile({ ...scenario.request, expected: foreign }), (error: unknown) => api.isIntelligenceError(error) && error.code === 'STALE_INPUT');
      const before = digestOf(scenario.request.selection);
      assert.equal(compile(scenario.request).ok, true);
      assert.equal(digestOf(scenario.request.selection), before, 'compiling does not change the selection');
    } finally {
      other.dispose();
      scenario.bundle.dispose();
    }
  });
});

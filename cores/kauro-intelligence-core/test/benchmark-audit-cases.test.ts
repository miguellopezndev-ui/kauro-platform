import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { BENCHMARK_FIXTURE_FORMAT_VERSION, HARD_GATES, capturingTransport, observeEgress, qualifyReportArithmetic as qualifyThreeRuns, report, scoreFixture, sealExpectedTruth } from '../src/benchmark/harness.js';
import type { BenchmarkFixture, BenchmarkReport, FixtureFamily, FixtureScore, HardGate, ObservedEgress, UnsealedFixture } from '../src/benchmark/harness.js';
import { digestOf } from '../src/contracts/canonical.js';
import { oracleTransport } from '../src/gateway/fake-gateway.js';
import { transportGateway } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { IntelligenceInput } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import type { Bundle } from './support/fixtures.js';

/**
 * The three audit cases of probe-ic-benchmark.mjs, reproduced under the
 * current contract with the predicates the audit used — correct === false,
 * qualified === false, passing === false — so that the audit's criteria are
 * met literally and not only in substance. The audit probe as shipped no
 * longer executes here: the sealer refuses a PROPOSED truth that fixes no
 * decision, so every synthetic truth carries one obligation; report() needs
 * the campaign the run belongs to, so the audit's call without one is
 * exercised as the report failure it is; and observeEgress takes the bytes
 * handed to the transport, so the real run is captured there. Nothing else
 * about the cases is changed: the score shapes, the invented destination and
 * the receipt it leaves stale are the audit's.
 */
const HASHES = { profileHash: 'a'.repeat(64), candidateSetHash: 'b'.repeat(64), targetContractHash: null, projectRevisionHash: 'c'.repeat(64) };

/** The audit's synthetic truth, plus the one obligation the sealer requires of a PROPOSED truth. */
function auditTruth(id: string, family: FixtureFamily = 'SUPPORTED', hashes: UnsealedFixture['expectedInputHashes'] = HASHES): UnsealedFixture {
  return {
    fixtureFormatVersion: BENCHMARK_FIXTURE_FORMAT_VERSION,
    fixtureId: id,
    family,
    weight: 1,
    expectedInputHashes: hashes,
    expectedOutcomeClass: family === 'AMBIGUOUS_ABSTENTION' ? 'ABSTAINED' : 'PROPOSED',
    allowedAlternatives: [],
    expectedCandidates: family === 'AMBIGUOUS_ABSTENTION' ? [] : [{ sourceHeader: 'Email', sourceFieldRef: 'field:contacts.csv:Email', decision: 'MAP', destinationField: 'contact.email' }],
    forbiddenDestinationFields: [],
    requiredEvidenceRefs: [],
    expectedCompilerResult: 'ANY',
    expectedPreserved: [],
    expectedTaskTypes: [],
    dataLevelCeiling: 'L0',
    budgetCeiling: { maxCalls: 20, maxInvocations: 20, maxBilledInputTokens: 2_000_000, maxBilledOutputTokens: 131_072 },
    gates: { identityUnproven: true, injectionSentinels: ['AUDIT_INJECTION_SENTINEL'], foreignRefs: ['AUDIT_FOREIGN_SENTINEL'], secretSentinels: ['AUDIT_SECRET_SENTINEL'], safetyCritical: false },
  };
}

/** The audit's synthetic score: correct, one passing check per gate, every gate observed once. */
function auditScore(fixture: BenchmarkFixture, runPrefix = 'run_'): FixtureScore {
  return { fixtureId: fixture.fixtureId, family: fixture.family, weight: fixture.weight, expectedTruthDigest: fixture.expectedTruthDigest, runId: `${runPrefix}${fixture.fixtureId}`, correct: true, candidateFailure: false, checks: HARD_GATES.map((gate) => ({ check: gate, gate, expected: 'none', observed: 'none', pass: true })), hardGateViolations: [], gateChecksExecuted: Object.fromEntries(HARD_GATES.map((gate) => [gate, 1])) as Record<HardGate, number>, scorerFailure: null };
}

/** The audit's call: report(corpus, scores) with no campaign and no mode. The signature has grown since; the call is made as the audit made it. */
const reportAsAuditCalled = report as unknown as (corpus: readonly BenchmarkFixture[], scores: readonly FixtureScore[]) => BenchmarkReport;

describe('audit cases (probe-ic-benchmark.mjs) under the current contract, with the audit predicates', () => {
  it('BENCH-repeated-one-report: an identical report used three times cannot certify independent executions — qualified === false', () => {
    const corpus = [sealExpectedTruth(auditTruth('supported')), sealExpectedTruth(auditTruth('abstention', 'AMBIGUOUS_ABSTENTION'))];
    // As the audit called it: no campaign. The report is a report failure and nothing built on it qualifies.
    const asCalled = reportAsAuditCalled(corpus, corpus.map((fixture) => auditScore(fixture)));
    assert.ok(asCalled.reportFailures.includes('NO_CAMPAIGN_ID'));
    assert.equal(asCalled.passing, false);
    assert.equal(qualifyThreeRuns([asCalled, asCalled, asCalled]).qualified, false);
    // With a campaign, in TEST_ONLY and in QUALIFICATION: still one run, presented three times.
    for (const mode of ['TEST_ONLY', 'QUALIFICATION'] as const) {
      const once = report(corpus, corpus.map((fixture) => auditScore(fixture)), 'campaign-1', mode);
      const qualification = qualifyThreeRuns([once, once, once]);
      assert.equal(qualification.qualified, false, mode);
      assert.ok(qualification.reasons.some((reason) => reason.startsWith('RUNS_NOT_INDEPENDENT:') && reason.includes('campaign ids repeat') && reason.includes('result digests repeat') && reason.includes('run ids shared')), qualification.reasons.join('; '));
    }
    // The negative is not vacuous on this corpus: three reports from distinct campaigns over distinct run ids with distinct results are not refused for dependence.
    const independent = [1, 2, 3].map((n) => report(corpus, corpus.map((fixture) => ({ ...auditScore(fixture, `c${String(n)}_`), checks: auditScore(fixture).checks.map((check) => ({ ...check, observed: `campaign-${String(n)}` })) })), `campaign-${String(n)}`));
    assert.ok(!qualifyThreeRuns(independent).reasons.some((reason) => reason.startsWith('RUNS_NOT_INDEPENDENT:')));
    assert.ok(independent.every((run) => run.passing), 'each report passes on its own; TEST_ONLY keeps them from qualifying, not their arithmetic');
  });

  it('BENCH-budget-violation-ignored: a budget violation prevents the report pass and the qualification — passing === false, qualified === false', () => {
    const corpus = [sealExpectedTruth(auditTruth('supported')), sealExpectedTruth(auditTruth('abstention', 'AMBIGUOUS_ABSTENTION')), sealExpectedTruth(auditTruth('overbudget', 'ADVERSARIAL'))];
    const scores = corpus.map((fixture) => auditScore(fixture));
    // The audit's score shape for the over-budget run, the shape the scorer's budget path produces: incorrect, the budget check failing, the violation named.
    const overBudget = scores[2] as FixtureScore;
    scores[2] = { ...overBudget, correct: false, hardGateViolations: ['budget_ceiling_exceeded'], checks: [...overBudget.checks, { check: 'budget_ceiling', gate: null, expected: 'within budget', observed: 'over budget', pass: false }] };
    const asCalled = reportAsAuditCalled(corpus, scores);
    assert.equal(asCalled.passing, false);
    assert.equal(qualifyThreeRuns([asCalled, asCalled, asCalled]).qualified, false);
    const run = report(corpus, scores, 'campaign-1');
    assert.deepEqual(run.reportFailures, [], 'the score is consistent with itself; it is the run that broke its ceiling');
    assert.deepEqual(run.otherViolations, { budget_ceiling_exceeded: 1 });
    assert.equal(run.passing, false);
    assert.equal(qualifyThreeRuns([run, run, run]).qualified, false);
    // Stronger than the audit asked: three otherwise independent reports, one violation each, refused on the violation by name.
    const independent = [1, 2, 3].map((n) => report(corpus, scores.map((score) => ({ ...score, runId: `c${String(n)}_${score.fixtureId}`, checks: score.checks.map((check) => ({ ...check, observed: `${check.observed}:${String(n)}` })) })), `campaign-${String(n)}`));
    const refused = qualifyThreeRuns(independent);
    assert.equal(refused.qualified, false);
    assert.ok(independent.every((entry) => !entry.passing));
    for (const n of [1, 2, 3]) assert.ok(refused.reasons.includes(`RUN_${String(n)}_VIOLATIONS:budget_ceiling_exceeded=1`), refused.reasons.join('; '));
    // The control: the same three fixtures without the violation pass as a report (and, TEST_ONLY, still qualify nothing).
    const clean = report(corpus, corpus.map((fixture) => auditScore(fixture)), 'campaign-clean');
    assert.equal(clean.passing, true);
    assert.deepEqual(clean.otherViolations, {});
  });

  describe('BENCH-invented-extra-field on a real run captured at the transport', () => {
    let bundle: Bundle;
    let input: IntelligenceInput;
    let result: IntelligenceResult;
    let observed: ObservedEgress;
    let fixture: BenchmarkFixture;

    /** The receipt re-bound to the configuration the result now carries: the invented field becomes the only defect. */
    const rebind = (candidate: IntelligenceResult): IntelligenceResult => ({ ...candidate, draft: { ...candidate.draft, fullValidation: candidate.draft.fullValidation === null ? null : { ...candidate.draft.fullValidation, configurationDigest: digestOf(candidate.draft.configuration) } } });
    /** The audit's tampering: one more configuration field, a copy of the first, sent to a destination no contract holds. */
    const withInventedField = (candidate: IntelligenceResult): IntelligenceResult => {
      const configuration = candidate.draft.configuration;
      assert.ok(configuration !== null);
      const first = configuration.fields[0];
      assert.ok(first !== undefined);
      return { ...candidate, draft: { ...candidate.draft, configuration: { ...configuration, fields: [...configuration.fields, { ...first, destinationField: 'contact.thisFieldDoesNotExist' }] } } };
    };

    before(async () => {
      bundle = makeBundle('audit-benchmark-cases');
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const base = inputFor('CLEAN_ONLY', profiled, null);
      input = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } } };
      const captured = capturingTransport(oracleTransport());
      result = await createIntelligenceCore(depsFor(transportGateway(captured.transport), realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      observed = observeEgress(result.runId, captured.bodies);
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const email = contracts.profileView.fields.find((field) => field.header === 'Email') ?? assert.fail('no Email column');
      // The audit's truth — Email to contact.email — with every other field the oracle mapped named as an allowed extra, so the positive control is honest.
      const otherMapped = [...new Set((result.draft.configuration?.fields ?? []).filter((field) => field.columnHeader !== 'Email').map((field) => field.destinationField))];
      fixture = sealExpectedTruth({ ...auditTruth('actual-positive', 'SUPPORTED', { profileHash: profiled.profile.profileHash, candidateSetHash: profiled.candidateSet.candidateSetHash, targetContractHash: null, projectRevisionHash: input.projectRevision.projectRevisionHash }), expectedCandidates: [{ sourceHeader: 'Email', sourceFieldRef: email.fieldRef, filePath: 'contacts.csv', decision: 'MAP', destinationField: 'contact.email' }], allowedExtraDestinations: otherMapped });
    });
    after(() => bundle.dispose());

    it('BENCH-positive-real-result: the correct mapping control scores correct === true', () => {
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.ok(result.draft.configuration?.fields.some((field) => field.columnHeader === 'Email' && field.destinationField === 'contact.email'));
      const score = scoreFixture(fixture, result, observed);
      assert.equal(score.scorerFailure, null, String(score.scorerFailure));
      assert.equal(score.correct, true, JSON.stringify(score.checks.filter((check) => !check.pass)));
      assert.deepEqual(score.hardGateViolations, []);
    });

    it('BENCH-invented-extra-field: an invented destination is incorrect — correct === false with invented_target_accepted when it is the only defect; the receipt it left stale is a scorer failure, never a pass', () => {
      const tampered = withInventedField(result);
      // The audit's tampering as it stands leaves the validation receipt digesting the configuration before the edit. The scorer will
      // not judge a configuration the receipt did not validate: a scorer failure, correct null, and a report that does not pass.
      const stale = scoreFixture(fixture, tampered, observed);
      assert.equal(stale.correct, null);
      assert.ok(stale.scorerFailure?.startsWith('RECEIPT_NOT_BOUND_TO_CONFIGURATION:'), String(stale.scorerFailure));
      assert.notEqual(stale.correct, true);
      const staleReport = report([fixture], [stale], 'campaign-stale');
      assert.equal(staleReport.scorerFailures, 1);
      assert.equal(staleReport.hardGatesZero, false);
      assert.equal(staleReport.passing, false);
      // With the receipt bound to the tampered configuration the invented field is the only defect, and the audit's predicate holds literally.
      const score = scoreFixture(fixture, rebind(tampered), observed);
      assert.equal(score.scorerFailure, null, String(score.scorerFailure));
      assert.equal(score.correct, false);
      assert.equal(score.candidateFailure, false);
      assert.ok(score.hardGateViolations.includes('invented_target_accepted'), JSON.stringify(score.hardGateViolations));
      const failing = score.checks.filter((check) => !check.pass).map((check) => check.check);
      assert.ok(failing.includes('no_extra_field'), failing.join(','));
      assert.ok(failing.includes('destinations_in_target_universe'), failing.join(','));
      assert.ok(score.checks.some((check) => check.check === 'no_extra_field' && check.observed.includes('contact.thisFieldDoesNotExist')));
      assert.ok(score.gateChecksExecuted['invented_target_accepted'] > 0, 'the gate was observed, and tripped');
      const scored = report([fixture], [score], 'campaign-invented');
      assert.deepEqual(scored.reportFailures, []);
      assert.equal(scored.hardGates['invented_target_accepted'].violations, 1);
      assert.equal(scored.hardGatesZero, false);
      assert.equal(scored.passing, false);
      // The same tampering with the invented field's destination inside the sealed universe (contact.email a second time) is still an invented output.
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      const other = configuration.fields.find((field) => field.columnHeader !== 'Email');
      assert.ok(other !== undefined);
      const duplicated = rebind({ ...result, draft: { ...result.draft, configuration: { ...configuration, fields: [...configuration.fields, { ...other, columnHeader: 'Injected Header', destinationField: 'contact.email' }] } } });
      const duplicate = scoreFixture(fixture, duplicated, observed);
      assert.equal(duplicate.correct, false);
      assert.ok(duplicate.hardGateViolations.includes('invented_target_accepted'));
    });
  });
});

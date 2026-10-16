/**
 * Benchmark format, scorer and report, canon §82–§86, §90, for IC-2 to consume.
 *
 * Three pieces, one entry: the fixture format 1.1.0 with its sealing
 * (fixture.ts), the independent scorer that judges a result against the
 * sealed truth and the egress record taken at the transport (scorer.ts), and the run report with
 * the three-run qualification (report.ts). IC-1 ships the format, the scorer
 * and small fixtures with positives and negatives; the 600 fixtures and the
 * three pinned runs are IC-2.
 */
export { BENCHMARK_FIXTURE_FORMAT_VERSION, EXPECTED_DECISIONS, FIXTURE_FAMILIES, HARD_GATES, OUTCOME_CLASSES, fixtureProblems, sealExpectedTruth, truthIntact } from './fixture.js';
export type { BenchmarkFixture, BudgetCeiling, ExpectedCandidate, ExpectedDecision, ExpectedInputHashes, FixtureFamily, HardGate, HardGateMarkers, OutcomeClass, UnsealedFixture } from './fixture.js';
export { SCORER_FAILURES, capturingTransport, isTransportBody, observeEgress, outcomeClassOf, scoreFixture, wireForms } from './scorer.js';
export type { FixtureScore, ObservedEgress, ObservedOutcomeClass, ScoreCheck } from './scorer.js';
export { QUALIFICATION_CORPUS, QUALITY_THRESHOLDS, REPORT_MODES, corpusShortfall, qualifyThreeRuns as qualifyReportArithmetic, report, reportDigestOf } from './report.js';
export { SUBJECT_FIELDS, bindRun, qualifyThreeRuns, subjectProblems, summarizeReceipts } from './qualification.js';
export type { QualificationSubject, ReceiptSetSummary, RunEvidence, RunRecord } from './qualification.js';
export type { BenchmarkReport, FamilyRate, GateReport, Qualification, ReportMode } from './report.js';

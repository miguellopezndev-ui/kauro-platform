/**
 * Kauro Intelligence Core — public entry.
 *
 * Intelligence interprets and proposes; Migration Core executes and proves;
 * the agency decides what is ambiguous or destructive. Everything a host
 * needs is exported here and nothing else exists for it: the API, the
 * contracts, the versions, the gateway interface with its offline
 * implementations, the ledger with its injectable store and clock, the
 * memory resolver, the benchmark format.
 */
export { createIntelligenceCore } from './api/intelligence-core.js';
export type { IntelligenceCore, IntelligenceResult, DraftMigrationPlan, DraftValidationState, GrantEvidence, DispatchGuarantee } from './api/intelligence-core.js';
export { DELIVERY_BLOCKERS, assertFinalDeliveryAllowed, finalDeliveryBlockers } from './api/delivery-gate.js';
export type { DeliveryBlocker } from './api/delivery-gate.js';

export type { HostContext, IntelligenceInput, ProjectRevision, ResourceProfile, CandidateConfiguration, ConfigFragmentField, FullDatasetValidationPort, FullDatasetValidationResult, CoreDependencies, EgressKey } from './ports/ports.js';
// The money admission of every dispatch (D3-GRANT-1) and its labelled in-memory fake (SIMULATED).
export { ADMISSION_OUTCOMES, MemoryDispatchAdmission, chargeMicrosOf, maxChargeMicros, tariffProblems } from './kernel/admission.js';
export type { AdmissionOutcome, AdmissionRequest, DispatchAdmission, GrantBalance, GrantHold, ModelTariff, Settlement, SettlementState } from './kernel/admission.js';

export * from './contracts/versions.js';
export { canonicalJson, digestOf, sha256Hex, stableRef, CanonicalError } from './contracts/canonical.js';
export { validate, parseJsonBounded, DEFAULT_LIMITS, SUSPICIOUS_UNICODE } from './contracts/schema.js';
export type { Schema, SchemaProblem, SchemaLimits } from './contracts/schema.js';
export { IntelligenceError, isIntelligenceError, ERROR_CODES, TASK_OUTCOMES } from './contracts/errors.js';
export type { ErrorCode, TaskOutcome } from './contracts/errors.js';
export { ENVELOPE_SCHEMA, TASK_TYPES, PROPOSAL_TYPES, DATA_LEVELS, DATA_CLASSES, envelopeProblems, envelopeHash, cleanOnlyTargetRef } from './contracts/envelope.js';
export type { IntelligenceEnvelopeV1, TaskType, ProposalType, DataLevel, DataClass, Exemplar, DeterministicCandidate, EnvelopeConstraints, BudgetSnapshot, RepairContext, SourceProfileView, SourceFieldFact, TargetContractView, CleanOnlyContractView, MemoryEvidenceItem } from './contracts/envelope.js';
export { PROPOSAL_SCHEMA, PROPOSAL_ITEM_SCHEMA, PRIMITIVES, PRIMITIVE_REFS, RATIONALE_CODES, EVIDENCE_CLASSES, ABSTAIN_REASONS, proposalJsonSchema, proposalShapeProblems } from './contracts/proposal.js';
export type { IntelligenceProposalV1, ProposalItem, PrimitiveRef, RationaleCode, EvidenceClass } from './contracts/proposal.js';
export { RUN_STATES, RUN_TRANSITIONS, TERMINAL_RUN_STATES, BUDGET_LIMITS, MEMORY_SCOPES, MEMORY_STATES, OUTCOME_LADDER } from './contracts/run.js';
export type { RunState, TaskRecord, TaskResult, Usage, Reservation, MemoryEntry, MemoryCandidate, MemoryScope, MemoryState, VerificationOutcome } from './contracts/run.js';

export { RunLedger, MemoryLedgerStore, SystemClock, VirtualClock, BARRIER_POINTS } from './kernel/ledger.js';
export type { Clock, LedgerStore, LedgerEvent, PublicLedgerEvent, PublicResponseStored, PublicPrepared, RunView, BudgetView, BarrierPoint, BarrierOutcome, GrantLedgerView, DispatchFacts, StoredResponse, ReopenOutcome } from './kernel/ledger.js';

export { adaptContracts } from './adapter/contract-adapter.js';
export type { AdaptedContracts, RefTable } from './adapter/contract-adapter.js';
export { resolve as resolveDeterministically } from './resolver/deterministic-resolver.js';
export type { Resolution, ResolvedDecision, OpenQuestion, IdentityProof } from './resolver/deterministic-resolver.js';
export { plan as planTasks, MAX_COMPLEXITY_PER_TASK, MAX_QUESTIONS_PER_TASK, FAMILY_PHASES } from './planner/task-planner.js';
export type { Plan, PlanOptions, PendingQuestion, PendingReason } from './planner/task-planner.js';
// B03-ACCOUNTING: the expected candidate set and its accounting (D3-ACC-1, D3-ACC-2), the output scope of a claim (D3-SCOPE-1), the request-size estimate the planner partitions under (D3-PART-1).
export { planCandidates, candidateAccountingProblems, accountCandidates, expectedCandidates, requestSizeEstimator, routeOf, ORIGINAL_ROUTES, CANDIDATE_DISPOSITIONS } from './planner/candidate-accounting.js';
export type { ExpectedSetCandidate, ExpectedCandidateSet, CandidateOrigin, CandidateDisposition, CandidateDispositionKind, CandidateCoverage, CandidateAccounting, AccountingInput, RequestSizeInput } from './planner/candidate-accounting.js';
// B03-PLAN-COMPILER: the agency's selection compiled to a CandidateConfiguration 2.0.0, or a closed rejection (D3-PLAN-1; B08's PlanCompilerPort for CMD022).
export { compileSelection, PLAN_REJECTION_CODES, IDENTITY_PRIMITIVES } from './compiler/plan-compiler.js';
export type { AgencySelection, CandidateChoice, CandidateDecision, CompiledSelection, CompileSelectionRequest, DeterministicAcceptance, PlanDecisionEvidence, PlanEvidence, PlanFragmentEvidence, PlanInput, PlanRejection, PlanRejectionCode } from './compiler/plan-compiler.js';
export { outputScopeOf, recordMappingIdOf } from './contracts/output-scope.js';
export { resolveMemory, memoryCandidateFrom, promoteCandidate, retireForDeletedClient, INSTRUCTION_LIKE } from './memory/memory-resolver.js';
export type { MemoryQuery, MemoryResolution, TenantContext } from './memory/memory-resolver.js';
export { classifyValue, classifyMetadataText, maskShape } from './classifier/data-classifier.js';
export type { Classification } from './classifier/data-classifier.js';
export { buildEnvelope, minimize, decideEgress, assertEgressBinds, MASKING_POLICY_VERSION, DATA_POLICY_VERSION } from './envelope/envelope-builder.js';
export type { BuiltEnvelope, EgressDecision, EgressDecisionKind, MinimizationReport, CategoricalSummaries } from './envelope/envelope-builder.js';
export { MODEL_POLICY_V1, MODEL_POLICY_HASH, PROMPT_BUNDLE_V1, PROMPT_BUNDLE_HASH } from './gateway/model-gateway.js';
export type { ModelGateway, ModelPolicy, GatewayRequest, GatewayResult, GatewayUsage } from './gateway/model-gateway.js';
export { scriptedGateway, replayGateway, oracleGateway, oracleProposal } from './gateway/fake-gateway.js';
export type { ScriptEntry, ScriptedGateway } from './gateway/fake-gateway.js';
export { transportGateway, buildProviderRequest, parseProviderResponse } from './gateway/transport-gateway.js';
export type { Transport, ProviderRequest, ProviderResponse } from './gateway/transport-gateway.js';
export { parseProposal, compileProposal } from './compiler/compiler.js';
export type { CompiledTask, CompiledItem, ParseResult } from './compiler/compiler.js';
export { sealExpectedTruth, scoreFixture, report as benchmarkReport, FIXTURE_FAMILIES, HARD_GATES } from './benchmark/harness.js';
export type { BenchmarkFixture, FixtureScore, BenchmarkReport, FixtureFamily } from './benchmark/harness.js';
export { usageIsValid, type AppendOutcome } from './kernel/ledger.js';
// B03-KERNEL-BOUNDARY: the public projection of a log (D3-PRIV-1), the strict reader and closed problem codes (D3-PARSE-1), the raw-body reader (D3-PARSE-2), the absolute window (D3-TIME-1).
export { publicLedger, publicEvent } from './kernel/ledger.js';
export { SCHEMA_PROBLEM_CODES, STRICT_JSON_MAX_DEPTH, strictJsonProblems, closedPointer, closedProblemCode, type SchemaProblemCode } from './contracts/schema.js';
export { RAW_BODY_REASONS, RESPONSE_BODY_MAX_BYTES, readRawBody } from './gateway/transport-gateway.js';
export { ABSOLUTE_WINDOW_MS } from './contracts/run.js';
export { recordedCompilerCode } from './compiler/compiler.js';
export { FULL_DATASET_VALIDATION_RESULT_SCHEMA } from './ports/ports.js';
export { MAX_INVOCATIONS_PER_REQUEST } from './contracts/run.js';
export { TransportError, parseProviderRequestPayload } from './gateway/transport-gateway.js';
export type { TransportStage, ProviderRequestHeader, ProviderRequestPayload } from './gateway/transport-gateway.js';
export { oracleTransport } from './gateway/fake-gateway.js';
export type { ScriptPayload } from './gateway/fake-gateway.js';
export type { MetadataKind } from './classifier/data-classifier.js';
export { BENCHMARK_FIXTURE_FORMAT_VERSION, EXPECTED_DECISIONS, OUTCOME_CLASSES, QUALITY_THRESHOLDS, SCORER_FAILURES, fixtureProblems, truthIntact, observeEgress, outcomeClassOf, qualifyThreeRuns, bindRun, subjectProblems, summarizeReceipts, SUBJECT_FIELDS, type QualificationSubject, type ReceiptSetSummary, type RunEvidence, type RunRecord, type UnsealedFixture, type ExpectedCandidate, type ExpectedDecision, type ExpectedInputHashes, type BudgetCeiling, type HardGateMarkers, type HardGate, type OutcomeClass, type ObservedEgress, type ScoreCheck, type GateReport, type FamilyRate, type Qualification } from './benchmark/harness.js';
// The runner surface an IC-2 benchmark runner needs from the packed tarball: the capture at the transport, the wire-form and body tests, the report modes, the qualification universe and the report digest.
export { capturingTransport, isTransportBody, wireForms, REPORT_MODES, QUALIFICATION_CORPUS, corpusShortfall, reportDigestOf } from './benchmark/harness.js';
export type { ReportMode, ObservedOutcomeClass } from './benchmark/harness.js';
// B03-CONFIG-EFFECTS: CandidateConfiguration 2.0.0 and its fragments (D3-CFG-1), the product translation into the Migration Core document with its coverage (D3-CFG-2), the effects a host reads off Migration Core's run and the coverage manifest the finalizer checks (D3-CFG-3), the evidence class every gateway declares (D3-EVC-1).
export type { ConfigFragmentIdentity, ConfigColumnRef, ConfigFragmentRecord, ConfigFragmentAssociation, ConfigFragmentColumn, FragmentKind, ValuePolicy } from './ports/ports.js';
export { FRAGMENT_KINDS } from './ports/ports.js';
export { toMigrationConfig, sealConfiguration, optionsOfPrimitive, elementFragmentHash, columnFragmentHash, MIGRATION_SOURCE_SYSTEM, MIGRATION_IMPORT_MODE } from './adapter/migration-config.js';
export type { MigrationConfigDocument, MigrationConfigTranslation, FragmentPointer, RefusedFragment, SealedConfiguration } from './adapter/migration-config.js';
export { effectsFromMigrationRun, MIGRATION_EFFECTS_SCHEMA } from './adapter/migration-effects.js';
export type { MigrationEffects, RecordEffect, FieldEffect, AssociationEffect, UnmappedEffect, LeftoverFileEffect, RowDispositions } from './adapter/migration-effects.js';
export type { FragmentCoverage, FragmentCoverageEntry, ExpectedEffect, DraftEvidence, DraftEvidenceOrigin } from './api/intelligence-core.js';
export { GATEWAY_EVIDENCE_CLASSES } from './gateway/model-gateway.js';
export type { GatewayEvidenceClass } from './gateway/model-gateway.js';
// B03-CAP-VALUES: transformation parameters evidenced by the full-data shapes or the project's declared locale (D3-CAP-04), value maps over the L1 values of a column (D3-CAP-05), target requirements from the contract (D3-CAP-10).
export { DATE_FORMAT_DOMAIN } from './contracts/proposal.js';
export type { LocaleEvidence } from './contracts/proposal.js';
export { REQUIREMENT_CANDIDATE_TYPE, TRANSFORM_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE } from './contracts/envelope.js';
export { PARAMETERISED_PRIMITIVES, declaredLocale, evidencedValues } from './compiler/parameter-evidence.js';
export type { DeclaredLocale } from './compiler/parameter-evidence.js';
export type { DraftRequirement } from './api/intelligence-core.js';
export type { ValueCandidate } from './resolver/deterministic-resolver.js';
// B03-CAP-IDENTITY: the identity families — identity only from proven authority (D3-CAP-06), duplicate signals review-only by construction (D3-CAP-07), associations only to declared endpoints over relationships the contract offers (D3-CAP-08): their candidate types, the association channel and its refs, the resolver's universe of associations, the duplicate clusters of the receipt's effects and the draft's reports.
export { IDENTITY_CANDIDATE_TYPE, DUPLICATE_CANDIDATE_TYPE, ASSOCIATION_CANDIDATE_TYPE, associationRefOf, recordRefOf } from './contracts/envelope.js';
export type { AssociationTargetView } from './contracts/envelope.js';
export { OBJECT_OF_TOKEN, SIGNAL_DESTINATIONS, externalIdAuthorityOf, offeredRelationshipTypes, recordMappingsOf, associationUniverse, associationOptionOf, objectsNamedBy } from './resolver/identity-families.js';
export type { OriginalAnswer, RecordMappingView, AssociationOption, AssociationStatus, DuplicateClusterView } from './resolver/identity-families.js';
export { clusterRowsDigest, DUPLICATE_SIGNALS, MAX_LISTED_DUPLICATE_CLUSTERS } from './adapter/migration-effects.js';
export type { DuplicateClusterEffect } from './adapter/migration-effects.js';
export type { IdentityReport, RecordIdentityReport, ReviewGroup, AssociationReport } from './api/intelligence-core.js';
// B03-CAP-REVIEW: the consistency review over every compiled decision, its candidates, claims and the evidence-ranked preserve (D3-CAP-11); the review phase after every other family; a repair round with exactly the permissions of the task it repairs (D3-CAP-12).
export { CONTRADICTION_KINDS, CLAIM_ORIGINS, REVIEW_CANDIDATE_TYPE } from './contracts/envelope.js';
export type { ContradictionKind, ReviewClaimView } from './contracts/envelope.js';
export { detectContradictions, reviewVerdict, strictlyWeakest, EVIDENCE_RANK, REVIEW_AGENCY_CODES } from './compiler/consistency.js';
export type { Contradiction, ReviewInput, ReviewVerdict } from './compiler/consistency.js';
export { planReview } from './planner/task-planner.js';
export { allowedProposalTypesOf } from './envelope/envelope-builder.js';

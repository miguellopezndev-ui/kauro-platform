/**
 * The public host API and the orchestration of one IntelligenceRun.
 *
 * validate versions → adapt contracts → resolve deterministically → plan →
 * for each task: memory → minimize → envelope → egress → reserve → gateway
 * (bounded transport retries) → parse → compile → one repair at most →
 * assemble → cross-task consistency → full-dataset validation through the
 * host port → draft or abstain; every step in the ledger, every failure an
 * explicit outcome and a terminal state, no loop without a bound.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { adaptContracts } from '../adapter/contract-adapter.js';
import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { sealConfiguration } from '../adapter/migration-config.js';
import type { SealedConfiguration } from '../adapter/migration-config.js';
import type { MigrationEffects } from '../adapter/migration-effects.js';
import { CanonicalError, digestOf, sha256Hex } from '../contracts/canonical.js';
import { outputScopeOf, recordMappingIdOf } from '../contracts/output-scope.js';
import { ASSOCIATION_CANDIDATE_TYPE, DUPLICATE_CANDIDATE_TYPE, IDENTITY_CANDIDATE_TYPE, REQUIREMENT_CANDIDATE_TYPE, TRANSFORM_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE } from '../contracts/envelope.js';
import type { BudgetSnapshot, DeterministicCandidate, IntelligenceEnvelopeV1, RepairContext, ReviewClaimView } from '../contracts/envelope.js';
import { IntelligenceError, isIntelligenceError } from '../contracts/errors.js';
import type { TaskOutcome } from '../contracts/errors.js';
import { BUDGET_LIMITS, TERMINAL_RUN_STATES, WORKER_LEASE_MS, WORKER_LEASE_RENEWAL_MS } from '../contracts/run.js';
import type { MemoryCandidate, RunState, TaskRecord, TaskResult } from '../contracts/run.js';
import type { EvidenceClass } from '../contracts/proposal.js';
import { INSTANT_PATTERN, validate } from '../contracts/schema.js';
import { COMPILER_CONTRACT_VERSION, ENVELOPE_SCHEMA_VERSION, INTELLIGENCE_CORE_VERSION, MEMORY_CONTRACT_VERSION, MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION, SUPPORTED_MIGRATION_CORE, compatibilityProblems } from '../contracts/versions.js';
import { compileProposal, parseProposal, recordedCompilerCode } from '../compiler/compiler.js';
import type { CompiledItem, CompiledTask } from '../compiler/compiler.js';
import { declaredLocale } from '../compiler/parameter-evidence.js';
import type { DeclaredLocale } from '../compiler/parameter-evidence.js';
import { deterministicEvidenceClass, detectContradictions } from '../compiler/consistency.js';
import { DATA_POLICY_VERSION, MASKING_POLICY_VERSION, assertEgressBinds, buildEnvelope, decideEgress } from '../envelope/envelope-builder.js';
import type { EgressDecision, MinimizationReport } from '../envelope/envelope-builder.js';
import { GATEWAY_EVIDENCE_CLASSES, MODEL_POLICY_V1, PROMPT_BUNDLE_HASH, PROMPT_BUNDLE_V1, isShippedCandidatePolicy } from '../gateway/model-gateway.js';
import type { GatewayEvidenceClass, GatewayResult, GatewayUsage } from '../gateway/model-gateway.js';
import { RAW_BODY_REASONS, buildProviderRequest } from '../gateway/transport-gateway.js';
import { ADMISSION_OUTCOMES, chargeMicrosOf, maxChargeMicros, tariffProblems } from '../kernel/admission.js';
import type { AdmissionOutcome, DispatchAdmission, SettlementState } from '../kernel/admission.js';
import { RunLedger, usageIsValid } from '../kernel/ledger.js';
import type { LedgerEvent, PreparedRequest, PublicLedgerEvent } from '../kernel/ledger.js';
import { memoryCandidateFrom, resolveMemory } from '../memory/memory-resolver.js';
import { accountCandidates, candidateAccountingProblems, candidateFollows, expectedCandidates, requestSizeEstimator, resolveOptionsOf } from '../planner/candidate-accounting.js';
import type { CandidateAccounting, CandidateCoverage } from '../planner/candidate-accounting.js';
import { plan, planReview } from '../planner/task-planner.js';
import type { Plan } from '../planner/task-planner.js';
import { FULL_DATASET_VALIDATION_RESULT_SCHEMA } from '../ports/ports.js';
import type { CandidateConfiguration, ConfigFragmentAssociation, ConfigFragmentColumn, ConfigFragmentField, ConfigFragmentRecord, CoreDependencies, EgressKey, FragmentKind, FullDatasetValidationResult, HostContext, IntelligenceInput } from '../ports/ports.js';
import { DERIVED_CANDIDATE_TYPES, resolve } from '../resolver/deterministic-resolver.js';
import type { Resolution, ResolvedDecision } from '../resolver/deterministic-resolver.js';
import { associationOptionOf } from '../resolver/identity-families.js';
import { BEDROCK_RETRY_WAITS_MS } from '../provider/bedrock-deployment.js';

/**
 * Where the draft stands with Migration Core's validation of the whole dataset (the only validation there is).
 *   VALIDATED                       the configuration ran through Migration Core and its receipt is `fullValidation`.
 *   DEFERRED_FOR_AGENCY_DECISION    Migration Core refused to validate the plan because it maps nothing to a field the target contract
 *                                   requires (a BLOCKING requirement, CAP10): a plan to change, not a dataset to isolate. The draft is
 *                                   the agency's question, not a validated plan; there is no receipt and it can never be delivered:
 *                                   `finalDeliveryBlockers` refuses it until the agency's decision produces a VALIDATED draft.
 *   NOT_RUN                         no configuration reached the validation (the draft is not draftable).
 */
export interface DraftValidationState {
  readonly status: 'VALIDATED' | 'DEFERRED_FOR_AGENCY_DECISION' | 'NOT_RUN';
  /** The destination fields of the blocking requirements the refusal named; empty unless deferred. */
  readonly blockedDestinations: readonly string[];
  /** The closed word of Migration Core's refusal that was deferred; null unless deferred. */
  readonly refusal: 'MAPPING_INVALID' | null;
}

export interface DraftMigrationPlan {
  readonly planVersion: string;
  readonly status: 'SYSTEM_DRAFT' | 'NOT_DRAFTABLE';
  readonly configuration: CandidateConfiguration | null;
  readonly impact: { readonly fieldsMapped: number; readonly rowsCovered: number; readonly fieldsPreserved: number };
  /** One entry per configuration field and per accepted proposal about a field — its target, or its type: what decided it (a deterministic rule or the model's proposal, by `origin`), on what class of evidence, and which refs. The decisions behind records and preserved columns — an object, a preservation — are in the coverage manifest with every other fragment's. */
  readonly evidence: readonly DraftEvidence[];
  readonly unresolved: readonly { readonly candidateRef: string; readonly outcome: TaskOutcome; readonly codes: readonly string[] }[];
  readonly unsupportedPreserved: readonly string[];
  readonly decisionsRequired: readonly { readonly candidateRef: string; readonly reason: string }[];
  readonly fullValidation: FullDatasetValidationResult | null;
  /** Whether Migration Core validated this draft, or its validation waits for the agency's decision (see DraftValidationState). Final delivery requires VALIDATED. */
  readonly validation: DraftValidationState;
  /** The candidate coverage of the run (D3-ACC-1): not complete while any candidate is pending or unresolved — the draft never presents itself as complete then. Null when the run never adapted its contracts. */
  readonly coverage: CandidateCoverage | null;
  /**
   * The coverage manifest (D3-CFG-3; manual 06 "Facts and decision
   * evidence"): every fragment of the configuration, from the candidates its
   * decision answers, through the decision and its evidence, to the fragment
   * hash, the pointer in the document Migration Core loaded and whether the
   * receipt's effects report it consumed. Null when no configuration reached
   * the host's validation.
   */
  readonly fragmentCoverage: FragmentCoverage | null;
  /**
   * Every requirement of the target contract on a record mapping of the
   * configuration (D3-CAP-10): a target the contract requires — not
   * nillable, not defaulted — that is writable and deliverable, of the
   * record mapping's object; SATISFIED by the field fragment that delivers
   * it, which carries required so Migration Core sets aside a row that lacks
   * it, or BLOCKING, a decision the draft leaves to the agency. Empty when no
   * configuration was drafted.
   */
  readonly requirements: readonly DraftRequirement[];
  /** The identity each record mapping runs on, and what Migration Core combined under it (D3-CAP-06). Null when no configuration reached the host's validation. */
  readonly identity: IdentityReport | null;
  /** Duplicate clusters for the agency to review — never merged, never in the configuration (D3-CAP-07). */
  readonly reviewGroups: readonly ReviewGroup[];
  /** Every association of the configuration, with the edges Migration Core delivered and the endpoints it reported missing (D3-CAP-08). */
  readonly associations: readonly AssociationReport[];
  readonly note: 'A SYSTEM_DRAFT is not an approval, a quote or an authorisation to execute.';
}

/** The identity of one record mapping as the configuration hands it over, and the rows Migration Core combined under it. */
export interface RecordIdentityReport {
  readonly recordMappingId: string;
  /** The record id column the project declared, by locator; null when none was. */
  readonly sourceRecordIdColumn: string | null;
  /** The authoritative external id columns an accepted identity strategy named, by locator. */
  readonly authoritativeExternalIdColumns: readonly string[];
  /** The identity space shared by the object's record mappings that carry an external id; null for the record mapping's own. */
  readonly identitySpace: string | null;
  /** The candidates the record answers: Migration Core's key candidates on its declared record id, and the identity candidates whose accepted strategy shaped it. */
  readonly candidateRefs: readonly string[];
  /** Rows Migration Core combined into another row of this record mapping, proven. */
  readonly mergedRows: number;
}

export interface IdentityReport {
  readonly records: readonly RecordIdentityReport[];
  /** Proven merges and absorbed rows, from the receipt's effects. */
  readonly provenMerges: number;
  readonly absorbedRows: number;
  /** Duplicate clusters Migration Core reported and merged nothing of. */
  readonly duplicateClusters: number;
}

/**
 * One duplicate cluster for the agency (D3-CAP-07): Migration Core's cluster
 * by its candidate ref and its rows' addresses, the proposal that put it in
 * front of the agency, the signal columns, and whether the receipt reports
 * the same cluster. Addresses and refs only: no value any row holds.
 */
export interface ReviewGroup {
  readonly groupRef: string;
  readonly decisionRef: string;
  readonly recordMappingIds: readonly string[];
  /** The signal columns, by locator. */
  readonly signalColumns: readonly string[];
  readonly rows: number;
  readonly rowLocators: readonly string[];
  /** The digest the group is met on in the receipt's effects; null when the set did not carry every row. */
  readonly rowsDigest: string | null;
  /** The receipt's effects report a cluster of exactly these rows. */
  readonly observed: boolean;
}

/** One association of the configuration and what Migration Core did with its edges (D3-CAP-08). */
export interface AssociationReport {
  readonly associationId: string;
  readonly decisionRef: string;
  readonly relationshipType: string;
  readonly recordMappingId: string;
  readonly targetRecordMappingId: string;
  readonly keyColumnLocator: string;
  readonly fragmentHash: string;
  /** Edges Migration Core delivered. */
  readonly edgesDelivered: number;
  /** Edges whose endpoint Migration Core could not find: reported, never invented. */
  readonly missingEndpoints: number;
}

export interface DraftRequirement {
  readonly recordMappingId: string;
  readonly targetRef: string;
  readonly destinationField: string;
  readonly status: 'SATISFIED' | 'BLOCKING';
  /** The decision of the field fragment that satisfies it; null while nothing does. */
  readonly decisionRef: string | null;
}

/** What Migration Core 3.0.0 says when a creating record mapping maps nothing to a field the attested contract requires. */
const REQUIRED_ON_CREATE_REFUSAL = /^MAPPING_INVALID: [^\n]*?requires a value for ([A-Za-z0-9_]+\.[A-Za-z0-9_]+) to create a record/u;

/**
 * The blocking destinations a refusal of Migration Core names, when EVERY text of it is the required-on-create refusal of a
 * destination the draft itself reports as a BLOCKING requirement (compared without case: the contract says contact.lastname, the
 * draft contact.lastName); null otherwise, which is no deferral: any other refusal is a failed validation.
 */
function blockedRefusalOf(texts: readonly unknown[], blocked: readonly string[]): readonly string[] | null {
  if (texts.length === 0 || blocked.length === 0) return null;
  const byLowerCase = new Map(blocked.map((destination) => [destination.toLowerCase(), destination] as const));
  const named: string[] = [];
  for (const text of texts) {
    const found = typeof text === 'string' ? REQUIRED_ON_CREATE_REFUSAL.exec(text) : null;
    const destination = found === null ? undefined : byLowerCase.get((found[1] as string).toLowerCase());
    if (destination === undefined) return null;
    if (!named.includes(destination)) named.push(destination);
  }
  return named;
}

/** Proposal types that change a field another decision put in — a transformation's parameters, a value map (D3-CAP-04, D3-CAP-05) — rather than put one in. */
const FIELD_MODIFIERS: ReadonlySet<string> = new Set(['APPLY_SUPPORTED_TRANSFORM', 'MAP_ENUM_VALUE']);

/** The candidate types whose answer is about a field some other candidate decides the mapping of: an abstention on one of them preserves nothing. */
const VALUE_LEVEL_TYPES: ReadonlySet<string> = new Set([TRANSFORM_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE, REQUIREMENT_CANDIDATE_TYPE]);

/** What a fragment is expected to do in Migration Core's run, by kind — and, for a decision that shapes a fragment another decision put in, by what it changed of it: a semantic type applied to a field (D3-CAP-03). */
export type ExpectedEffect = 'RECORD_MAPPING_RUN' | 'FIELD_CONSUMED' | 'EDGES_RESOLVED' | 'UNMAPPED_LEFTOVER' | 'COLUMN_EXCLUDED' | 'TYPE_APPLIED';

/** DecisionEvidence of one fragment, and what became of it. */
export interface FragmentCoverageEntry {
  readonly fragmentKind: FragmentKind;
  readonly decisionRef: string;
  /** The candidates the decision answers: Migration Core's originals on the column for a deterministic decision, the derived candidate for a proposal. */
  readonly candidateRefs: readonly string[];
  readonly origin: DraftEvidenceOrigin;
  /** The resolver's rule, or the rationale code the compiler checked against the facts. */
  readonly rule: string;
  readonly evidenceRefs: readonly string[];
  readonly fragmentHash: string;
  /** The JSON pointer of the fragment's element in the document; null for a column fragment. */
  readonly pointer: string | null;
  readonly expectedEffect: ExpectedEffect;
  /** Whether the receipt's effects report the fragment consumed, by its hash. */
  readonly observed: boolean;
}

export interface FragmentCoverage {
  /** True exactly when every fragment is observed. */
  readonly complete: boolean;
  readonly entries: readonly FragmentCoverageEntry[];
}

/** The decision behind one fragment, gathered while the fragment is assembled: the manifest's DecisionEvidence of it. */
interface FragmentDecision {
  readonly kind: FragmentKind;
  /** The fragment's position among the configuration's fragments of its kind. */
  readonly index: number;
  readonly decisionRef: string;
  readonly candidateRefs: readonly string[];
  readonly origin: DraftEvidenceOrigin;
  readonly rule: string;
  readonly evidenceRefs: readonly string[];
  /** The effect it is expected to have, when it is not its fragment kind's own: a type decision on a field another decision mapped. */
  readonly expectedEffect?: ExpectedEffect;
}

const EXPECTED_EFFECT: Readonly<Record<FragmentKind, ExpectedEffect>> = Object.freeze({ RECORD: 'RECORD_MAPPING_RUN', FIELD: 'FIELD_CONSUMED', ASSOCIATION: 'EDGES_RESOLVED', PRESERVED_COLUMN: 'UNMAPPED_LEFTOVER', EXCLUDED_COLUMN: 'COLUMN_EXCLUDED' });

/** The derived candidate types of the identity families (B03-CAP-IDENTITY): their answers key, review and link columns, and never preserve one. */
const IDENTITY_FAMILY_CANDIDATES: ReadonlySet<string> = new Set([IDENTITY_CANDIDATE_TYPE, DUPLICATE_CANDIDATE_TYPE, ASSOCIATION_CANDIDATE_TYPE]);

/** The proposals of the identity families: they put no field in, so the draft's evidence names them by the record, review group or association fragment they shaped (D3-CAP-06, D3-CAP-07, D3-CAP-08) rather than by a destination. */
const IDENTITY_FAMILY_PROPOSALS: ReadonlySet<string> = new Set(['PROPOSE_IDENTITY_STRATEGY', 'PROPOSE_DUPLICATE_SIGNAL', 'MAP_ASSOCIATION']);

/**
 * Where a drafted field came from. DETERMINISTIC: the resolver decided it
 * on facts (the `rationaleCode` is the resolver's rule, the `candidateRef`
 * the decision's stable ref); PROPOSED: the model proposed it and the
 * compiler accepted it. Every configuration field has an entry of one origin
 * or the other (IC-09): a draft never carries a field nothing accounts for.
 */
export type DraftEvidenceOrigin = 'DETERMINISTIC' | 'PROPOSED';

export interface DraftEvidence {
  readonly origin: DraftEvidenceOrigin;
  readonly candidateRef: string;
  readonly evidenceClass: EvidenceClass;
  readonly rationaleCode: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceFieldRef: string | null;
  readonly targetRef: string | null;
  readonly destinationField: string | null;
  readonly semanticType: string | null;
  readonly transformPrimitive: string | null;
  readonly typedTransformParams: Readonly<Record<string, string>> | null;
  /** The hash of the configuration fragment the decision resulted in; null when it put none in (a proposal the assembly set aside for the agency). */
  readonly fragmentHash: string | null;
}

/**
 * What the review phase settled (D3-CAP-11): the review candidates, whose
 * answers are no fields or preserves of their own, and the claims their
 * accepted preserves drop — each by its decision ref, with the review item
 * that dropped it.
 */
interface ReviewOutcome {
  readonly candidateRefs: ReadonlySet<string>;
  readonly dropped: ReadonlyMap<string, CompiledItem>;
}
const NO_REVIEW: ReviewOutcome = Object.freeze({ candidateRefs: new Set<string>(), dropped: new Map<string, CompiledItem>() });

/** The rule a review's accepted preserve stands on: the claim it drops is strictly weaker than every other, by computed evidence class. */
const REVIEW_PRESERVE_RULE = 'CONSISTENCY_WEAKER_CLAIM_PRESERVED';

export interface IntelligenceResult {
  readonly proposalRef: string;
  readonly proposalDigest: string;
  /** The public projection of the run's log (D3-PRIV-1): every stored answer by its digest, size, usage and stop reason, never its content, which stays in the host's protected store. */
  readonly runLedger: readonly PublicLedgerEvent[];
  readonly runId: string;
  readonly state: string;
  readonly tasks: readonly TaskResult[];
  readonly draft: DraftMigrationPlan;
  readonly unresolvedItems: readonly { readonly candidateRef: string; readonly outcome: TaskOutcome; readonly codes: readonly string[] }[];
  /**
   * Every expected candidate — Migration Core's originals and the resolver's
   * derived candidates, the set planCandidates fixes before any request —
   * with exactly one disposition, and the coverage (D3-ACC-1). Null only when
   * the run never adapted its contracts (a refused version or contract, a
   * cancellation before the start).
   */
  readonly candidateAccounting: CandidateAccounting | null;
  readonly memoryCandidates: readonly MemoryCandidate[];
  /**
   * What the run cost, read off the ledger: every invocation that reached a
   * reservation, those that came back with a response, and the tokens —
   * everything the provider reported plus the full size of every reservation
   * whose fate is unknown, which is reported separately as well.
   */
  readonly resourceEvidence: { readonly providerInvocations: number; readonly modelCalls: number; readonly ambiguousReservations: number; readonly billedInputTokens: number; readonly billedOutputTokens: number; readonly ambiguousInputTokens: number; readonly ambiguousOutputTokens: number; readonly tasksPlanned: number; readonly tasksLeftOut: number; readonly deterministicDecisions: number; readonly wallClockMs: number; readonly grant: GrantEvidence; readonly dispatchGuarantee: DispatchGuarantee };
  readonly provenance: { readonly intelligenceCoreVersion: string; readonly envelopeSchemaVersion: string; readonly proposalSchemaVersion: string; readonly promptBundleVersion: string; readonly promptBundleHash: string; readonly modelPolicyVersion: string; readonly modelPolicyHash: string; readonly dataPolicyVersion: string; readonly maskingPolicyVersion: string; readonly memoryContractVersion: string; readonly compilerContractVersion: string; readonly profileHash: string; readonly candidateSetHash: string; readonly targetContractHash: string | null; readonly projectRevisionHash: string; readonly gatewayEvidenceClass: GatewayEvidenceClass };
}

/**
 * What the run's invocations cost on the host's grant, read off the ledger
 * (D3-GRANT-1): admissions and refusals, the maximum charges still held (in
 * flight or ambiguous), the settled charges, how many of them stand in for a
 * usage nobody reported, and any charge above its reservation — liability,
 * which blocks dispatch and promotion.
 */
export interface GrantEvidence {
  readonly tariffRef: string;
  readonly admissions: number;
  readonly refusals: number;
  readonly heldMicros: number;
  readonly chargedMicros: number;
  readonly unknownUsageCharges: number;
  readonly liabilityMicros: number;
}

/**
 * The delivery the kernel promises: at most one authorised concurrent
 * dispatch per logical task. It does not claim that the provider processed a
 * request exactly once; an ambiguous send stays held until reconciled.
 */
export type DispatchGuarantee = 'AT_MOST_ONE_CONCURRENT_DISPATCH';

export interface IntelligenceCore {
  run(input: IntelligenceInput, context: HostContext): Promise<IntelligenceResult>;
  cancel(runId: string, reason: string): void;
  /** The run's log as the public projection (D3-PRIV-1); the host reads its protected record from its own LedgerStore. */
  readRun(runId: string): readonly PublicLedgerEvent[];
}

/** The wait before each transport retry (S8): 2 s, then 8 s, each plus a jitter of 0..25 % drawn from the request's idempotency digest, so a replay waits the same. */
const RETRY_BACKOFF_MS: readonly number[] = BEDROCK_RETRY_WAITS_MS;
const RETRY_JITTER_MAX = 0.25;
/** A Retry-After beyond this is a provider asking the run to wait out its own deadline; the run fails the task instead. */
const MAX_RETRY_WAIT_MS = 60_000;
/** The provider statuses a retry is for (S8): a failure whose status is known and not one of these is not retried. AMBIGUOUS is never retried (manual 06 l.104). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);
/**
 * The provider error classes whose documentation says a 429 was not accepted
 * for processing, with the page that says so (manual 06 l.182, S11): such a
 * 429 without usage is RELEASED. Every other failure without usage is held.
 */
const DOCUMENTED_THROTTLING: Readonly<Record<string, string>> = Object.freeze({
  ThrottlingException: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html#API_runtime_InvokeModel_Errors',
  RESOURCE_EXHAUSTED: 'https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429',
});
/** More released 429s in a row than this stop the run RATE_LIMITED (S11); the grant is not touched, and it is no hard gate. */
const RATE_LIMIT_STREAK_MAX = 5;
const RATE_LIMITED = 'RATE_LIMITED';

const realSleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const realTicker = (intervalMs: number, onTick: () => void): (() => void) => {
  const handle = setInterval(onTick, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
};

/** The figure as the ledger counts it: the cache categories folded into the input and kept beside it, so the drift they show can be read back off the stored response. */
interface CountedUsage extends GatewayUsage {
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/** A cache category as the provider reported it: absent or null is none, a count is a count, anything else makes the whole figure unknown. */
function cacheCountOf(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * What the provider consumed for one invocation, or null when it reported
 * nothing the ledger can count. The cache categories are billable input and
 * are counted into it whenever they are reported; one reported malformed
 * makes the whole figure unknown. A response that carries content and
 * reports zero tokens in and out is a placeholder, not a measurement: unknown
 * as well, and billed at the reservation like any unknown.
 */
function reportedUsage(result: GatewayResult): CountedUsage | null {
  if (result.kind === 'AMBIGUOUS' || !usageIsValid(result.usage)) return null;
  const cacheRead = cacheCountOf(result.usage.cacheReadInputTokens);
  const cacheCreation = cacheCountOf(result.usage.cacheCreationInputTokens);
  if (cacheRead === null || cacheCreation === null) return null;
  const inputTokens = result.usage.inputTokens + cacheRead + cacheCreation;
  if (result.kind === 'RESPONSE' && result.content !== '' && inputTokens === 0 && result.usage.outputTokens === 0) return null;
  return { inputTokens, outputTokens: result.usage.outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation };
}

/** Cache tokens reported under a policy that has the cache off: billed all the same, and named as drift on the task. */
function cacheDriftOf(result: GatewayResult): { readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null {
  if (result.kind === 'AMBIGUOUS' || result.usage === null || MODEL_POLICY_V1.promptCache !== 'OFF') return null;
  const drift = { cacheReadInputTokens: cacheCountOf(result.usage.cacheReadInputTokens) ?? 0, cacheCreationInputTokens: cacheCountOf(result.usage.cacheCreationInputTokens) ?? 0 };
  return drift.cacheReadInputTokens + drift.cacheCreationInputTokens > 0 ? drift : null;
}

const CACHE_DRIFT_CODE = 'CACHE_USAGE_UNDER_CACHE_OFF';

/** What the record says when the gateway threw: that it threw. The error's own text stays out of it, as a provider's does (R2-028). */
const GATEWAY_THREW = 'the gateway threw; its text is withheld';

/** The gateway's own fixed reasons: a status, a timeout, a missing or forbidden member, a paused turn. Nothing in them is anybody's data. */
const OWN_REASON = /^(?:provider status \d{3}|the provider timed out after the request was sent; billing is unknown|the provider answered 200 with no object body|the provider answered with no stop_reason|the provider answered with no content list|the provider answered with a tool call to a request that offered no tools|the provider paused the turn; a continuation would need provider conversation state, which no request carries|the provider answered with no text content|the gateway threw; its text is withheld)$/u;
/** The stage prefix the transport gateway puts before a transport's own message. */
const STAGED_REASON = /^(BEFORE_SEND|AFTER_SEND|UNKNOWN): /u;

/**
 * What the ledger and the result keep of a gateway's reason (R2-028). A
 * reason is either the gateway's own fixed words, kept as they are, or a
 * provider's or a transport's text — an error that echoes the submitted
 * body, a credential in a message or an error code, customer text, a model
 * name the provider wrote — which is withheld: the record keeps its kind,
 * the stage it failed at and, for a wrong model, the model that was pinned,
 * and nothing the core did not write. The bytes the provider answered with
 * stay in the response store under its own retention class; nothing here
 * reaches telemetry, which carries counters and states only.
 */
function recordedReason(reason: string): string {
  if (OWN_REASON.test(reason)) return reason;
  // The gateway's fixed words for a raw body it could not read (D3-PARSE-2).
  if ((Object.values(RAW_BODY_REASONS) as readonly string[]).includes(reason)) return reason;
  const stage = STAGED_REASON.exec(reason)?.[1];
  if (stage !== undefined) return `${stage}: transport failure; its text is withheld`;
  if (reason.startsWith('the provider answered with model ')) return `the provider answered with another model than the pinned ${MODEL_POLICY_V1.primaryModel}; its name is withheld`;
  return 'the gateway gave a reason in words that are not its own; the text is withheld';
}

/** A declared member in the form its digest is taken over: a Map by its entries (the order they were inserted in is not content), an absent member left out, as canonical JSON leaves it out. */
function identityForm(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...(value as Map<unknown, unknown>).entries()].map(([key, inner]) => [String(key), identityForm(inner)]));
  if (Array.isArray(value)) return value.map(identityForm);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined).map(([key, inner]) => [key, identityForm(inner)]));
  return value;
}

/**
 * The declared identity of an attempt (D3-ID-1): every member of the input
 * and of the host context, as the host declared it — before this build says
 * whether it accepts any of it — by the digest of its content, one level into
 * each member that is a record, so a conflict names the member that changed
 * (`input.projectRevision.recordIdColumns`). Structural: a member either type
 * gains is bound without a line here, and none is bound by trusting a hash
 * the host wrote beside it (a profile is bound by its content, not only by
 * its profileHash). The same id with any one member changed is another
 * attempt's content: IDENTITY_CONFLICT before the stored result and before
 * any request.
 */
function declaredIdentity(input: IntelligenceInput, context: HostContext): Record<string, string> {
  const bound: Record<string, string> = {};
  const bind = (scope: string, declared: object): void => {
    for (const [name, value] of Object.entries(declared)) {
      if (value === undefined) continue;
      const form = identityForm(value);
      if (form === null || typeof form !== 'object' || Array.isArray(form) || value instanceof Map) {
        bound[`${scope}.${name}`] = digestOf(form);
        continue;
      }
      // A record: its member names as a set, and each member by itself.
      bound[`${scope}.${name}`] = digestOf(Object.keys(form).sort());
      for (const [member, inner] of Object.entries(form as Record<string, unknown>)) bound[`${scope}.${name}.${member}`] = digestOf(inner);
    }
  };
  try {
    bind('input', input);
    bind('context', context);
  } catch (error) {
    if (error instanceof CanonicalError) throw new IntelligenceError('CONTRACT_VIOLATION', `the host declared a member that has no canonical form (${error.message}); an attempt is bound to what it declared`);
    throw error;
  }
  return bound;
}

/** One request answered: the result, whether the ledger already held it, the hash of the envelope it answers, and what the invocations showed about the policy. */
interface GatewayCall {
  readonly result: GatewayResult;
  readonly fromStore: boolean;
  readonly envelopeHash: string;
  readonly codes: readonly string[];
}

/** The grant causes a task can end on: nothing more is dispatched on the attempt once one of them stands. */
const GRANT_CAUSES: ReadonlySet<string> = new Set(['NO_FUNDED_GRANT', 'GRANT_LIABILITY']);

/** The cause a typed error names in its details, when it names one of the closed causes. */
function grantCauseOf(error: IntelligenceError): readonly string[] {
  const cause = error.details['cause'];
  return typeof cause === 'string' && GRANT_CAUSES.has(cause) ? [cause] : [];
}

/** A provider request id as the record keeps it beside the answer: a short token of an id alphabet. Anything else is provider text, which the record withholds (R2-028). */
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

/** The provider's own identity of the request an answer carried (R2-032), or null when it carried none a record may keep. */
function providerRequestIdOf(result: GatewayResult): string | null {
  if (result.kind !== 'RESPONSE') return null;
  const id = result.providerMeta.requestId;
  return typeof id === 'string' && PROVIDER_REQUEST_ID.test(id) ? id : null;
}

/** The usage a stored answer carries, as it was counted when it came back (cache categories folded in); null when none was. */
function storedUsageOf(response: unknown): CountedUsage | null {
  const usage = response !== null && typeof response === 'object' ? (response as { readonly usage?: unknown }).usage : undefined;
  return usage !== null && typeof usage === 'object' && usageIsValid(usage as { inputTokens: unknown; outputTokens: unknown }) ? (usage as CountedUsage) : null;
}

/**
 * Usage just committed, against the ceilings: a single response above a
 * per-request ceiling is implausible — recorded and counted all the same —
 * and a total past the audit ceiling is exhaustion. Either ends the run;
 * neither is promoted into a draft (IC-12). Checked when an answer comes back
 * and again when a stored answer is found, before it is compiled (B03-R6).
 */
function assertWithinCeiling(ledger: RunLedger, usage: CountedUsage | null): void {
  const implausible = usage !== null && (usage.inputTokens > BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST || usage.outputTokens > BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST);
  const over = ledger.overCeiling();
  if (!implausible && over === null) return;
  const reason = implausible ? `the provider reported ${String(usage.inputTokens)}/${String(usage.outputTokens)} tokens on one response against per-request ceilings of ${String(BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST)}/${String(BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST)}: implausible` : over;
  ledger.note('usage over the ceiling; the run is exhausted', { implausible: implausible ? 1 : 0, overTotal: over === null ? 0 : 1 });
  throw new IntelligenceError('BUDGET_EXHAUSTED', reason ?? 'over the ceiling');
}

/**
 * A charge above the maximum charge its reservation was admitted at is
 * actual liability (manual 06 "Budget algebra"): it blocks every further
 * dispatch and the promotion, and the ledger is never reduced to make the
 * check pass.
 */
function assertNoLiability(ledger: RunLedger): void {
  const { liabilityMicros } = ledger.view().grant;
  if (liabilityMicros <= 0) return;
  ledger.note('a charge above its reservation is liability; nothing more is dispatched or promoted', { liabilityMicros });
  throw new IntelligenceError('BUDGET_EXHAUSTED', `GRANT_LIABILITY: ${String(liabilityMicros)} micros charged above the admitted maximum charges`, { cause: 'GRANT_LIABILITY', liabilityMicros });
}

/**
 * The identity of each record mapping of a sealed configuration, and what
 * Migration Core combined under it (D3-CAP-06): the declared record id, the
 * authoritative external ids an accepted strategy named, the identity space,
 * and the rows the receipt's effects report merged — proven, by those keys.
 */
function identityReportOf(configuration: CandidateConfiguration, fragmentDecisions: readonly FragmentDecision[], effects: MigrationEffects | null): IdentityReport {
  return {
    records: configuration.records.map((record, index) => ({
      recordMappingId: record.recordId,
      sourceRecordIdColumn: record.sourceRecordIdColumn?.columnLocator ?? null,
      authoritativeExternalIdColumns: record.authoritativeExternalIdColumns.map((column) => column.columnLocator),
      identitySpace: record.identitySpace,
      candidateRefs: fragmentDecisions.find((decision) => decision.kind === 'RECORD' && decision.index === index)?.candidateRefs ?? [],
      mergedRows: effects?.records.find((effect) => effect.fragmentHash === record.fragmentHash)?.rows.mergedProven ?? 0,
    })),
    provenMerges: effects?.identity.provenMerges ?? 0,
    absorbedRows: effects?.identity.absorbedRows ?? 0,
    duplicateClusters: effects?.identity.duplicateClusters ?? 0,
  };
}

/**
 * Every association of a sealed configuration with what Migration Core did
 * with its edges, met on the fragment hash (D3-CAP-08): the edges it
 * delivered and the endpoints it could not find — reported, never hidden.
 */
function associationReportsOf(configuration: CandidateConfiguration, effects: MigrationEffects | null): readonly AssociationReport[] {
  return configuration.associations.map((association) => {
    const effect = effects?.associations.find((entry) => entry.fragmentHash === association.fragmentHash);
    return { associationId: association.associationId, decisionRef: association.decisionRef, relationshipType: association.relationshipType, recordMappingId: association.recordId, targetRecordMappingId: association.targetRecordId, keyColumnLocator: association.keyColumn.columnLocator, fragmentHash: association.fragmentHash, edgesDelivered: effect?.edges.output ?? 0, missingEndpoints: effect?.missingEndpoints ?? 0 };
  });
}

export function createIntelligenceCore(deps: CoreDependencies): IntelligenceCore {
  // What the answers are evidence of is the gateway's to declare, and a result says it (D3-EVC-1): a gateway that declares no class is refused before anything is spent.
  const gatewayEvidenceClass = (deps.gateway as { readonly evidenceClass?: unknown }).evidenceClass;
  if (!(GATEWAY_EVIDENCE_CLASSES as readonly unknown[]).includes(gatewayEvidenceClass)) throw new IntelligenceError('CONTRACT_VIOLATION', `the model gateway declares no evidence class of ${GATEWAY_EVIDENCE_CLASSES.join(' or ')}; nothing is run through it`);
  // The policy a core runs under is the pinned one; the pilot of a campaign may name another SHIPPED candidate policy (D4-CAMP-1), and nothing else is accepted.
  const modelPolicy = deps.candidatePolicy ?? MODEL_POLICY_V1;
  if (!isShippedCandidatePolicy(modelPolicy)) throw new IntelligenceError('CONTRACT_VIOLATION', 'the candidate policy is not one of the shipped candidate policies');
  // The attempt's egress key comes from the host or the core does not run: there is no default key (D3-KEY-1), since a key minted here dies with the process and a restart would mask every label differently and buy every stored answer again (B03-R4).
  const egressKey = deps.egressKey;
  const telemetry = deps.telemetry ?? ((): void => undefined);
  const sleep = deps.sleep ?? realSleep;
  const ticker = deps.ticker ?? realTicker;
  // The process name in the lease, for the record. Not the owner: each run() opens its own ledger handle, whose token is what the lease binds and every write is checked against.
  const workerId = deps.workerId ?? `worker_${randomBytes(8).toString('hex')}`;
  /** Released 429s in a row, per run (S11). In memory: a restart starts the count again, which can only buy more requests that are released. */
  const rateLimitStreak = new Map<string, number>();

  /**
   * One long await — the provider call, the host's validation — with the
   * lease renewed every WORKER_LEASE_RENEWAL_MS on the host's timer while it
   * lasts, so a call longer than the lease does not hand the attempt to a
   * takeover that would buy the same request again. A renewal that loses
   * its append to a writer that did not take the run — the host's cancel, a
   * note — is tried again on the next tick, on the re-read log; the lease
   * survives three missed renewals, so one lost tick lapses nothing. Only a
   * lease now held by another owner ends the renewals: the run was taken
   * over, and the owner learns at its next write, which the fence refuses.
   */
  async function keepingLease<T>(ledger: RunLedger, work: () => Promise<T>): Promise<T> {
    let renewing = true;
    const stop = ticker(WORKER_LEASE_RENEWAL_MS, () => {
      if (!renewing) return;
      try {
        ledger.acquireLease(workerId, WORKER_LEASE_MS);
      } catch {
        const holder = ledger.view().lease;
        if (holder !== null && holder.ownerId !== ledger.ownerId) {
          renewing = false;
          stop();
        }
      }
    });
    try {
      return await work();
    } finally {
      renewing = false;
      stop();
    }
  }

  /**
   * One request to the provider: at most the initial send plus the bounded
   * transport retries, and every one of them its own reservation, reconciled
   * against what actually came back before the next is made. A response of
   * any kind commits the usage it reports; a failure that reports usage
   * commits it as billed and unusable; a failure that reports none is
   * ambiguous — kept at full size — unless it carries the transport's proof
   * that the request never left, which is the only thing that releases a
   * reservation. A response already in the ledger — under the request's
   * semantic key, whatever budget snapshot this build of the envelope
   * carries — is returned without any of this, together with the hash of
   * the envelope it answered, which is the one the proposal names.
   */
  /** What the host must hand for this core to spend anything; empty when it did. */
  function dependencyProblems(): readonly string[] {
    const problems: string[] = [];
    const key = egressKey as Partial<EgressKey> | null | undefined;
    if (key === null || key === undefined || typeof key.keyId !== 'string' || key.keyId.trim() === '' || key.keyId.length > 256) problems.push('no egress key: the host hands every attempt its own egress key, by key id; this core has no default key');
    else if (!Buffer.isBuffer(key.secret) || key.secret.length < 32) problems.push(`the egress key ${key.keyId} carries no 32 bytes of key material`);
    problems.push(...tariffProblems(deps.tariff).map((problem) => `tariff: ${problem}`));
    const admission = deps.dispatchAdmission as Partial<DispatchAdmission> | null | undefined;
    if (admission === null || admission === undefined || typeof admission.admit !== 'function' || typeof admission.settle !== 'function') problems.push('no dispatch admission: every dispatch is admitted on a funded grant first');
    return problems;
  }

  /** Tells the host's grant how one invocation settled, after the record says so. */
  async function settle(ledger: RunLedger, reservationId: string, state: SettlementState, chargeMicros: number, usageKnown: boolean): Promise<void> {
    await deps.dispatchAdmission.settle({ runId: ledger.runId, reservationId, state, chargeMicros, usageKnown });
  }

  /**
   * A stored answer the reopening found unbilled — the process died between
   * RESPONSE_STORED and COMMITTED — billed now at the usage the answer
   * reports, or at the maximum charge where it reports none, on the record
   * and on the grant, before the task that finds it compiles it (D3-JRN-1,
   * B03-R6). The reservation estimate is never what a reported answer costs.
   */
  async function commitStored(ledger: RunLedger, reservationId: string, response: unknown): Promise<void> {
    const usage = storedUsageOf(response);
    const stopReason = response !== null && typeof response === 'object' ? (response as { readonly stopReason?: unknown }).stopReason : undefined;
    const admission = ledger.dispatchOf(reservationId).admission;
    const chargeMicros = usage !== null ? chargeMicrosOf(deps.tariff, usage) : (admission?.maxChargeMicros ?? null);
    if (usage === null) ledger.note('usage unknown on a stored answer; reservation billed at full size', {});
    ledger.commit(reservationId, usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, billedButUnusable: stopReason !== 'end_turn' }, null, chargeMicros === null ? null : { chargeMicros });
    if (chargeMicros !== null) await settle(ledger, reservationId, 'COMMITTED', chargeMicros, usage !== null);
  }

  /**
   * The grant brought to what the journal holds, on every reopening: each
   * reservation settled again as the record settled it — released, ambiguous
   * at its maximum charge, committed at its charge. Settlement is idempotent,
   * so a settlement a crash lost between the durable record and the grant is
   * made now, and one already made changes nothing.
   */
  async function settleFromJournal(ledger: RunLedger): Promise<void> {
    for (const reservation of ledger.view().reservations) {
      const facts = ledger.dispatchOf(reservation.reservationId);
      // A release is stated whether or not the admission reached the record: the host may hold what the record never learned it admitted.
      if (reservation.state === 'RELEASED') await settle(ledger, reservation.reservationId, 'RELEASED', 0, true);
      else if (facts.admission === null || facts.admission.outcome !== 'ADMITTED') continue;
      else if (reservation.state === 'AMBIGUOUS_BILLED') await settle(ledger, reservation.reservationId, 'AMBIGUOUS', facts.admission.maxChargeMicros, false);
      else if (reservation.state === 'COMMITTED' && facts.charge !== null && facts.charge.chargeMicros !== null) await settle(ledger, reservation.reservationId, 'COMMITTED', facts.charge.chargeMicros, facts.charge.usageKnown);
    }
  }

  /** A reservation that provably never left: released on the record, then its grant hold. */
  async function releaseUnsent(ledger: RunLedger, reservationId: string, reason: string): Promise<void> {
    ledger.release(reservationId, reason);
    await settle(ledger, reservationId, 'RELEASED', 0, true);
  }

  /**
   * Admission, SEND_STARTED and the dispatch barrier, in that order, for one
   * reserved invocation (D3-GRANT-1, D3-JRN-1, D3-JRN-2). The host's grant
   * holds the maximum charge or the invocation is released unsent and the
   * task ends NO_FUNDED_GRANT; a run cancelled or out of time meanwhile
   * releases it unsent as well; and the request leaves only once the store
   * has made SEND_STARTED durable — a refused barrier is the fence and
   * dispatches nothing.
   */
  async function admitAndStart(ledger: RunLedger, reservationId: string, maxChargeMicros: number, requestKey?: string): Promise<void> {
    let outcome: AdmissionOutcome;
    try {
      outcome = await deps.dispatchAdmission.admit({ runId: ledger.runId, reservationId, maxChargeMicros, ...(requestKey === undefined ? {} : { requestKey }) });
    } catch (error) {
      // The host could not say: nothing is sent, and whatever it may hold is released with the reservation.
      await releaseUnsent(ledger, reservationId, 'the dispatch admission failed; never dispatched');
      throw error;
    }
    if (!(ADMISSION_OUTCOMES as readonly string[]).includes(outcome)) {
      await releaseUnsent(ledger, reservationId, 'the dispatch admission answered outside its vocabulary; never dispatched');
      throw new IntelligenceError('CONTRACT_VIOLATION', `the dispatch admission answered ${String(outcome)}, not one of ${ADMISSION_OUTCOMES.join(', ')}`);
    }
    ledger.recordAdmission(reservationId, maxChargeMicros, outcome);
    // The host's step fence moved: this owner writes nothing more, and the next owner releases the unsent reservation on reopening.
    if (outcome === 'FENCED') throw new IntelligenceError('LEDGER_FENCED', `the dispatch admission refused run ${ledger.runId} to ${ledger.ownerId}: the host's fence moved`, { runId: ledger.runId, kind: 'ADMISSION', ownerId: ledger.ownerId });
    if (outcome === 'NO_FUNDED_GRANT') {
      ledger.release(reservationId, 'NO_FUNDED_GRANT: the grant cannot hold the maximum charge; never dispatched');
      throw new IntelligenceError('BUDGET_EXHAUSTED', `NO_FUNDED_GRANT: no funded grant holds ${String(maxChargeMicros)} micros for the next invocation`, { cause: 'NO_FUNDED_GRANT', maxChargeMicros });
    }
    try {
      ledger.sendStarted(reservationId);
    } catch (error) {
      if (isIntelligenceError(error) && (error.code === 'RUN_CANCELLED' || error.code === 'DEADLINE_PASSED' || error.code === 'INVALID_TRANSITION')) await releaseUnsent(ledger, reservationId, `${error.code} before the send started; never dispatched`);
      throw error;
    }
    await ledger.barrier('BEFORE_DISPATCH');
  }

  /** The request one envelope makes, as the gateway is handed it. */
  function gatewayRequestFor(ledger: RunLedger, envelope: IntelligenceEnvelopeV1, envelopeHash: string, idempotencyKey: string): Parameters<CoreDependencies['gateway']['analyze']>[0] {
    return { modelPolicy, promptBundleRef: { promptBundleVersion: PROMPT_BUNDLE_V1.promptBundleVersion, promptBundleHash: PROMPT_BUNDLE_HASH }, envelope, envelopeHash, runId: ledger.runId, outputSchema: PROMPT_BUNDLE_V1.outputSchema, deadlineAt: ledger.view().semanticDeadlineAt, idempotencyRef: idempotencyKey, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST };
  }

  /**
   * A request as PREPARED records it (D3-JRN-1): the envelope, the digest and
   * UTF-8 length of the provider request it makes under the pinned bundle,
   * and its maximum charge (D3-GRANT-1) — until the provider's counting
   * method is bound (B04) those bytes bound its input tokens, since a
   * byte-level tokenizer never emits more tokens than bytes; the output
   * ceiling bounds the rest, and the host's tariff prices both.
   */
  function preparedFor(ledger: RunLedger, envelope: IntelligenceEnvelopeV1, envelopeHash: string, idempotencyKey: string): PreparedRequest {
    const request = gatewayRequestFor(ledger, envelope, envelopeHash, idempotencyKey);
    const bytes = JSON.stringify(buildProviderRequest(request));
    const requestBytes = Buffer.byteLength(bytes, 'utf8');
    return { envelope, envelopeHash, requestDigest: sha256Hex(bytes), requestBytes, maxChargeMicros: maxChargeMicros(deps.tariff, requestBytes, request.maxOutputTokens), deadlineAt: request.deadlineAt };
  }

  async function callGateway(ledger: RunLedger, envelope: IntelligenceEnvelopeV1, envelopeHash: string, egress: EgressDecision, attempt: number, minimization: MinimizationReport): Promise<GatewayCall> {
    const keyParts = { taskId: envelope.taskId, attempt, modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, promptBundleHash: PROMPT_BUNDLE_HASH };
    const idempotencyKey = RunLedger.idempotencyKey({ ...keyParts, envelope });
    const stored = ledger.storedResponse(idempotencyKey);
    if (stored !== undefined) {
      // A stored answer is compiled only on a reconciled record: its usage was committed when it came back or when the reopening found it unbilled (D3-JRN-1), and the ceilings and the grant's liability are checked again here, before the compiler sees it (B03-R6).
      assertWithinCeiling(ledger, storedUsageOf(stored.response));
      assertNoLiability(ledger);
      return { result: stored.response as GatewayResult, fromStore: true, envelopeHash: stored.envelopeHash, codes: cacheDriftOf(stored.response as GatewayResult) === null ? [] : [CACHE_DRIFT_CODE] };
    }
    // Every send of a request sends what was prepared for it (D3-JRN-1): by this build, or by a process that died with it in flight — never a rebuild with the budget snapshot of the moment. A prepared envelope must still be the request this build asks.
    const earlier = ledger.preparedRequest(idempotencyKey);
    if (earlier !== undefined && RunLedger.idempotencyKey({ ...keyParts, envelope: earlier.envelope }) !== idempotencyKey) throw new IntelligenceError('CONTRACT_VIOLATION', `the request prepared under ${idempotencyKey} asks something else than this task`);
    const candidate = earlier ?? { envelope, envelopeHash };
    // The gateway path verifies the egress binding itself; a caller cannot hand it a boolean. This build's decision binds this build's bytes; an envelope prepared earlier is decided again, on its own bytes, under this run's key and the budget of the moment.
    const decision = candidate.envelopeHash === envelopeHash ? egress : decideEgress({ envelope: candidate.envelope, hash: candidate.envelopeHash, minimization, budget: envelope.budgetSnapshot, secret: egressKey.secret });
    assertEgressBinds(decision, candidate.envelope, egressKey.secret);
    const sending = earlier ?? ledger.prepare(idempotencyKey, preparedFor(ledger, envelope, envelopeHash, idempotencyKey));
    if (sending.envelopeHash !== candidate.envelopeHash) throw new IntelligenceError('LEDGER_CONFLICT', `another writer prepared ${idempotencyKey} on run ${ledger.runId} first`);
    // The estimate is what is reserved; one above the ceiling is refused by the ledger, never trimmed to fit.
    const estimatedInput = Math.ceil(JSON.stringify(sending.envelope).length / 3) + 2_000;
    const request = gatewayRequestFor(ledger, sending.envelope, sending.envelopeHash, idempotencyKey);
    // The maximum charge of every invocation of this request, as prepared.
    const maxCharge = sending.maxChargeMicros;
    /** What the grant is charged for a settled invocation: the reported usage priced by the tariff, or the maximum charge where none was reported — never zero. */
    const chargeFor = (counted: CountedUsage | null): number => (counted === null ? maxCharge : chargeMicrosOf(deps.tariff, counted));
    const codes = new Set<string>();
    const answered = (result: GatewayResult): GatewayCall => ({ result, fromStore: false, envelopeHash: sending.envelopeHash, codes: [...codes] });
    let transportAttempt = 0;
    for (;;) {
      ledger.assertOpen();
      // A run the provider keeps refusing is stopped before it reserves again (S11).
      if ((rateLimitStreak.get(ledger.runId) ?? 0) > RATE_LIMIT_STREAK_MAX) {
        codes.add(RATE_LIMITED);
        return answered({ kind: 'RETRYABLE_FAILURE', reason: `${RATE_LIMITED}: more than ${String(RATE_LIMIT_STREAK_MAX)} documented 429s in a row`, usage: null, retryAfterMs: null });
      }
      // A charge above a reservation stands on the record: nothing more is dispatched on this attempt (IC-12).
      assertNoLiability(ledger);
      // Invocations already in the ledger — an earlier process that died mid-request — count towards the bound.
      const invocation = ledger.invocationsOf(idempotencyKey) + 1;
      // The lease is renewed before every reservation: a worker that lost it — or never held it — reserves nothing and sends nothing.
      ledger.acquireLease(workerId, WORKER_LEASE_MS);
      const reservation = ledger.reserve({ taskId: envelope.taskId, attempt, invocation, inputTokens: estimatedInput, outputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, idempotencyKey });
      // Every invocation, retries included, needs its own admission on the grant before its send starts.
      await admitAndStart(ledger, reservation.reservationId, maxCharge, reservation.requestKey);
      let result: GatewayResult;
      try {
        // Renewed while the provider takes its time: a generation longer than the lease is still this owner's request, not a dead worker's.
        result = await keepingLease(ledger, () => deps.gateway.analyze(request));
      } catch (error) {
        // A gateway that throws proves nothing about whether the bytes left.
        result = { kind: 'AMBIGUOUS', reason: GATEWAY_THREW };
      }
      const usage = reportedUsage(result);
      const drift = cacheDriftOf(result);
      // What the grant is told once the record says it: a response of any kind, or a failure that reports usage, is COMMITTED at its charge; the transport's proof of non-send RELEASES; anything else stays AMBIGUOUS at the maximum charge.
      let settlement: { readonly state: SettlementState; readonly chargeMicros: number; readonly usageKnown: boolean } = { state: 'AMBIGUOUS', chargeMicros: maxCharge, usageKnown: false };
      try {
        if (drift !== null) {
          // The policy has the cache off and the provider billed cache tokens: counted like any input, and named so the drift is on the record.
          ledger.note('policy drift: cache tokens reported', drift);
          codes.add(CACHE_DRIFT_CODE);
        }
        if (result.kind === 'RESPONSE') {
          if (usage === null) ledger.note('usage unknown; reservation billed at full size', { inputTokens: reservation.inputTokens, outputTokens: reservation.outputTokens });
          // The stored copy carries the usage as counted, so a malformed figure from the provider is never written into the ledger; it names its reservation and the provider's request id.
          ledger.commit(reservation.reservationId, usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, billedButUnusable: result.stopReason !== 'end_turn' }, { idempotencyKey, envelopeHash: sending.envelopeHash, body: { ...result, usage }, providerRequestId: providerRequestIdOf(result) }, { chargeMicros: chargeFor(usage) });
          settlement = { state: 'COMMITTED', chargeMicros: chargeFor(usage), usageKnown: usage !== null };
        } else if (result.kind === 'AMBIGUOUS') {
          ledger.markAmbiguous(reservation.reservationId, recordedReason(result.reason));
        } else if (usage !== null) {
          ledger.commit(reservation.reservationId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, billedButUnusable: true }, null, { chargeMicros: chargeFor(usage) });
          settlement = { state: 'COMMITTED', chargeMicros: chargeFor(usage), usageKnown: true };
        } else if (result.kind === 'RETRYABLE_FAILURE' && result.status === 429 && result.usage === null && result.neverSent !== true && typeof result.providerErrorType === 'string' && Object.hasOwn(DOCUMENTED_THROTTLING, result.providerErrorType)) {
          // The provider's documented throttling class: the request was not accepted for processing (manual 06 l.182). Any other 429, and every other failure without usage, is held.
          ledger.release(reservation.reservationId, `PROVIDER_DOCUMENTED_NON_ACCEPTANCE:${DOCUMENTED_THROTTLING[result.providerErrorType] as string}`);
          settlement = { state: 'RELEASED', chargeMicros: 0, usageKnown: true };
        } else if (result.kind === 'RETRYABLE_FAILURE' && result.neverSent === true && result.usage === null) {
          // The transport's typed proof that nothing left the process; a message that says so is not proof.
          ledger.release(reservation.reservationId, 'the transport proved the request never left');
          settlement = { state: 'RELEASED', chargeMicros: 0, usageKnown: true };
        } else if (result.kind === 'RETRYABLE_FAILURE' && result.neverSent === true) {
          // Proof of non-send beside a usage figure the ledger cannot read: two witnesses that contradict each other release nothing.
          ledger.markAmbiguous(reservation.reservationId, 'the transport says the request never left and the provider reported usage: contradictory evidence');
        } else {
          ledger.markAmbiguous(reservation.reservationId, `${result.kind} without usage: the request may have been billed`);
        }
      } catch (error) {
        // Fenced out while the provider answered: this owner stores nothing and moves nothing, but what the answer reported goes on the record as evidence for its own reservation and settles it on the grant (D3-FENCE-1). The fence stands.
        if (isIntelligenceError(error) && error.code === 'LEDGER_FENCED' && (result.kind === 'RESPONSE' || usage !== null)) {
          const evidence = { usage: usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, billedButUnusable: result.kind !== 'RESPONSE' || result.stopReason !== 'end_turn' }, chargeMicros: chargeFor(usage), answer: result.kind === 'RESPONSE' ? { ...result, usage } : null, providerRequestId: providerRequestIdOf(result) };
          if (ledger.reconcileAsFencedOwner(reservation.reservationId, evidence)) await settle(ledger, reservation.reservationId, 'COMMITTED', evidence.chargeMicros, usage !== null);
        }
        throw error;
      }
      // The outcome is durable before the grant is told: a refused barrier leaves the grant holding the maximum charge, which the next owner's reopening settles from the journal.
      await ledger.barrier('AFTER_RESPONSE');
      await settle(ledger, reservation.reservationId, settlement.state, settlement.chargeMicros, settlement.usageKnown);
      if (settlement.state === 'COMMITTED') {
        assertWithinCeiling(ledger, usage);
        assertNoLiability(ledger);
      }
      const releasedThrottle = result.kind === 'RETRYABLE_FAILURE' && settlement.state === 'RELEASED' && result.status === 429;
      const streak = releasedThrottle ? (rateLimitStreak.get(ledger.runId) ?? 0) + 1 : 0;
      rateLimitStreak.set(ledger.runId, streak);
      if (streak > RATE_LIMIT_STREAK_MAX) {
        ledger.note('rate limited: the run stops', { streak });
        codes.add(RATE_LIMITED);
        return answered(result);
      }
      if (result.kind === 'RESPONSE' || result.kind === 'AMBIGUOUS') return answered(result);
      if (result.kind === 'TERMINAL_FAILURE' || transportAttempt >= BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST) return answered(result);
      if (result.status !== undefined && !RETRYABLE_STATUSES.has(result.status)) {
        ledger.note('transport retry refused: the provider status is not one a retry is for', { status: result.status });
        return answered(result);
      }
      transportAttempt += 1;
      const retryAfter = typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0 ? result.retryAfterMs : 0;
      const base = RETRY_BACKOFF_MS[Math.min(transportAttempt, RETRY_BACKOFF_MS.length) - 1] as number;
      const jitter = Math.floor((base * RETRY_JITTER_MAX * parseInt(digestOf({ idempotencyKey, transportAttempt }).slice(0, 8), 16)) / 0xffff_ffff);
      // A larger Retry-After wins; past MAX_RETRY_WAIT_MS it is refused below, as is any wait the semantic window cannot hold.
      const wait = Math.max(retryAfter, base + jitter);
      // A retry is a dispatch: it waits only inside the semantic window (D3-TIME-1).
      const remaining = Date.parse(ledger.view().semanticDeadlineAt) - deps.clock.nowMs();
      if (wait > MAX_RETRY_WAIT_MS || wait >= remaining) {
        ledger.note('transport retry refused: the wait would pass the deadline or the retry ceiling', { transportAttempt, wait, remaining: Math.max(0, remaining) });
        return answered(result);
      }
      ledger.note('transport retry', { transportAttempt, wait });
      await sleep(wait);
    }
  }

  async function runTask(ledger: RunLedger, task: TaskRecord, contracts: AdaptedContracts, candidates: readonly DeterministicCandidate[], input: IntelligenceInput, context: HostContext, decisions: readonly ResolvedDecision[], facts: { readonly locale: DeclaredLocale; readonly priorClaims: ReadonlySet<string> }, reviewClaims: readonly ReviewClaimView[] = []): Promise<{ result: TaskResult; compiled: CompiledTask | null; calls: number }> {
    const memory = resolveMemory(input.scopedMemorySnapshot, { tenant: context.tenant, targetInstanceRef: contracts.contractView.mode === 'CLEAN_ONLY' ? null : contracts.contractView.instanceId, targetSchemaVersion: contracts.contractView.mode === 'CLEAN_ONLY' ? null : contracts.contractView.targetContractVersion, knownTargetRefs: new Set(contracts.refs.targetByRef.keys()), headers: contracts.profileView.fields.filter((field) => candidates.some((candidate) => candidate.sourceRefs.includes(field.fieldRef))).map((field) => field.header) });
    ledger.note('memory resolved', { evidence: memory.evidence.length, stale: memory.stale.length, conflicted: memory.conflicted.length, refused: memory.refused.length });
    let repair: RepairContext | null = null;
    let calls = 0;
    let lastCompiled: CompiledTask | null = null;
    for (let attempt = 1; attempt <= BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK; attempt += 1) {
      const view = ledger.view();
      const snapshot: BudgetSnapshot = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: view.budget.remainingInputTokens, remainingBilledOutputTokens: view.budget.remainingOutputTokens, remainingTasks: view.budget.remainingTasks + (attempt > 1 ? 1 : 0), deadlineAt: view.semanticDeadlineAt };
      // The repair round is the same task under SEMANTIC_REPAIR, with exactly the permissions, candidates and claims of the task it repairs (D3-CAP-12).
      const effectiveTask: TaskRecord = attempt === 1 ? task : { ...task, taskType: 'SEMANTIC_REPAIR' };
      const built = buildEnvelope({ task: effectiveTask, contracts, candidates, memoryEvidence: memory.evidence, summaries: input.categoricalSummaries ?? new Map(), projectRevisionId: input.projectRevision.projectRevisionId, projectRevisionHash: input.projectRevision.projectRevisionHash, supportEnvelopeVersion: input.projectRevision.supportEnvelopeVersion, budgetSnapshot: snapshot, repairContext: repair, egressSecret: egressKey.secret, tenant: context.tenant, attemptId: context.auditAttemptId, decisions, repairOf: task.taskType, reviewClaims });
      ledger.note('envelope built', { exemplars: built.envelope.exemplars.length, blockedValues: built.minimization.blocked.length, level: built.minimization.maxDataLevel === 'L0' ? 0 : built.minimization.maxDataLevel === 'L1' ? 1 : 2 });
      if (built.egress.decision !== 'EGRESS_ALLOWED') {
        ledger.recordTaskOutcome({ taskId: task.taskId, outcome: built.egress.decision === 'EGRESS_BLOCKED_BUDGET' ? 'BUDGET_EXHAUSTED' : 'ABSTAINED', attempt, codes: [built.egress.decision, ...built.egress.blockedReasons], envelopeHash: built.hash, proposalDigest: null });
        return { result: { taskId: task.taskId, taskType: task.taskType, outcome: built.egress.decision === 'EGRESS_BLOCKED_BUDGET' ? 'BUDGET_EXHAUSTED' : 'ABSTAINED', attempts: attempt, envelopeHash: built.hash, proposalDigest: null, codes: [built.egress.decision] }, compiled: null, calls };
      }
      let call;
      try {
        call = await callGateway(ledger, built.envelope, built.hash, built.egress, attempt, built.minimization);
      } catch (error) {
        if (isIntelligenceError(error) && (error.code === 'BUDGET_EXHAUSTED' || error.code === 'BUDGET_RESERVATION_CONFLICT')) {
          // A grant cause (NO_FUNDED_GRANT, GRANT_LIABILITY) is named beside the code, on the record and on the task.
          ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'BUDGET_EXHAUSTED', attempt, codes: [error.code, ...grantCauseOf(error)], envelopeHash: built.hash, proposalDigest: null });
          return { result: { taskId: task.taskId, taskType: task.taskType, outcome: 'BUDGET_EXHAUSTED', attempts: attempt, envelopeHash: built.hash, proposalDigest: null, codes: [error.code, ...grantCauseOf(error), error.message] }, compiled: null, calls };
        }
        throw error;
      }
      if (!call.fromStore) calls += 1;
      const { result } = call;
      // The envelope hash the response answers: this build's, or — for a response the ledger held — the one the dead process sent, which differs from this build's by the budget snapshot alone and is the one the proposal names.
      const envelopeHash = call.envelopeHash;
      if (call.fromStore) ledger.note('response reused from the ledger', { attempt, rebuiltHashDiffers: envelopeHash === built.hash ? 0 : 1 });
      if (result.kind === 'RETRYABLE_FAILURE' || result.kind === 'AMBIGUOUS' || result.kind === 'TERMINAL_FAILURE') {
        const outcome: TaskOutcome = result.kind === 'TERMINAL_FAILURE' ? 'PROVIDER_TERMINAL_FAILURE' : 'PROVIDER_RETRYABLE_FAILURE';
        ledger.recordTaskOutcome({ taskId: task.taskId, outcome, attempt, codes: [result.kind, recordedReason(result.reason), ...call.codes], envelopeHash, proposalDigest: null });
        return { result: { taskId: task.taskId, taskType: task.taskType, outcome, attempts: attempt, envelopeHash, proposalDigest: null, codes: [result.kind, ...call.codes] }, compiled: null, calls };
      }
      if (result.stopReason === 'refusal' || result.stopReason === 'max_tokens') {
        ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'PROVIDER_TERMINAL_FAILURE', attempt, codes: [`STOP_${result.stopReason.toUpperCase()}`, ...call.codes], envelopeHash, proposalDigest: null });
        return { result: { taskId: task.taskId, taskType: task.taskType, outcome: 'PROVIDER_TERMINAL_FAILURE', attempts: attempt, envelopeHash, proposalDigest: null, codes: [`STOP_${result.stopReason.toUpperCase()}`, ...call.codes] }, compiled: null, calls };
      }
      const parsed = parseProposal(result.content);
      if (!parsed.ok) {
        // Closed codes with closed pointers: what the model wrote — a member it invented, a value outside an enumeration, the text of its answer — is never recorded (D3-PRIV-1, S036).
        const codes = [...parsed.codes.slice(0, 16), ...call.codes];
        ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'INVALID_SCHEMA', attempt, codes, envelopeHash, proposalDigest: digestOf(result.content) });
        if (attempt < BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK) {
          repair = { previousProposalDigest: digestOf(result.content), validationCodes: ['INVALID_SCHEMA'], allowedValues: [], allowedTargetRefs: [...built.envelope.constraints.allowedTargetIds] };
          continue;
        }
        return { result: { taskId: task.taskId, taskType: task.taskType, outcome: 'INVALID_SCHEMA', attempts: attempt, envelopeHash, proposalDigest: digestOf(result.content), codes }, compiled: null, calls };
      }
      // The semantic content of this build is the content the response answered; only the hash the proposal is checked against comes from the ledger.
      const compiled = compileProposal({ envelope: built.envelope, envelopeHash, proposal: parsed.proposal, runId: ledger.runId, contracts, decisions, locale: facts.locale, priorClaims: facts.priorClaims });
      // The record keeps closed codes; the repair round below is built from the compiler's own codes, which the envelope builder masks before they travel.
      const recorded: CompiledTask = { ...compiled, codes: compiled.codes.map(recordedCompilerCode), items: compiled.items.map((item) => ({ ...item, codes: item.codes.map(recordedCompilerCode) })) };
      lastCompiled = call.codes.length === 0 ? recorded : { ...recorded, codes: [...recorded.codes, ...call.codes] };
      ledger.recordTaskOutcome({ taskId: task.taskId, outcome: compiled.outcome, attempt, codes: lastCompiled.codes, envelopeHash, proposalDigest: compiled.proposalDigest });
      if (compiled.repairable && attempt < BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK) {
        repair = { previousProposalDigest: compiled.proposalDigest, validationCodes: [...new Set(compiled.codes)].slice(0, 64), allowedValues: [], allowedTargetRefs: [...built.envelope.constraints.allowedTargetIds] };
        continue;
      }
      return { result: { taskId: task.taskId, taskType: task.taskType, outcome: compiled.outcome, attempts: attempt, envelopeHash, proposalDigest: compiled.proposalDigest, codes: lastCompiled.codes }, compiled: lastCompiled, calls };
    }
    return { result: { taskId: task.taskId, taskType: task.taskType, outcome: lastCompiled?.outcome ?? 'INVALID_SEMANTICS', attempts: BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK, envelopeHash: lastCompiled?.envelopeHash ?? null, proposalDigest: lastCompiled?.proposalDigest ?? null, codes: lastCompiled?.codes ?? ['ATTEMPTS_EXHAUSTED'] }, compiled: lastCompiled, calls };
  }

  /**
   * The configuration of a run from its decisions. `resolution` is the one
   * the run ended with — the second, once a MAP_OBJECT decided a file's
   * object — and `objectDecisions` the accepted MAP_OBJECT of each such file
   * (D3-CAP-01): the record of that file names the object decision, not a
   * declaration or the headers.
   */
  function assemble(contracts: AdaptedContracts, resolution: Resolution, compiled: readonly CompiledTask[], input: IntelligenceInput, objectDecisions: ReadonlyMap<string, CompiledItem>, review: ReviewOutcome = NO_REVIEW): { configuration: CandidateConfiguration; fragmentDecisions: readonly FragmentDecision[]; items: readonly CompiledItem[]; deterministic: readonly ResolvedDecision[]; contradictions: readonly string[]; preserved: readonly string[]; decisionsRequired: readonly { candidateRef: string; reason: string }[]; requirements: readonly DraftRequirement[]; reviewGroups: readonly ReviewGroup[]; unassembled: ReadonlyMap<string, string> } {
    const decisions = resolution.decisions;
    /** What each derived candidate decides: a column, a type, an object. */
    const kindOf = new Map(resolution.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate.candidateType]));
    const fields: ConfigFragmentField[] = [];
    // The decision behind each field, in field order: the manifest's DecisionEvidence of the fragment (D3-CFG-3).
    const fieldDecisions: Omit<FragmentDecision, 'kind' | 'index'>[] = [];
    // The deterministic decisions that put a field into the configuration, in field order: each is projected into the draft's evidence beside the accepted proposals (IC-09).
    const deterministic: ResolvedDecision[] = [];
    // A target is claimed once per output scope — one destination of one
    // record mapping, the file and the object it is delivered as (D3-SCOPE-1,
    // the same scope the resolver and the compiler key their claims by) —
    // never once per run: two files that both hold CONTACT each map their own
    // Email to contact.email (IC-08), while two columns of one file competing
    // for one target remain a contradiction the agency decides.
    const claimed = new Map<string, string>();
    const contradictions: string[] = [];
    const preserved: string[] = [];
    const decisionsRequired: { candidateRef: string; reason: string }[] = [];
    const items = compiled.flatMap((task) => task.items);
    const recordIdOf = (fileId: string, destinationField: string): { readonly recordId: string; readonly object: string } => {
      const object = destinationField.split('.')[0] ?? 'contact';
      return { recordId: recordMappingIdOf(fileId, object), object };
    };
    const claimKey = (recordId: string, destinationField: string): string => outputScopeOf(recordId, destinationField);
    // The options of an ENUM target as the attested contract lists them: Migration Core's allowedValues, copied from the contract and from nowhere else.
    const allowedValuesOf = (targetRef: string | null, semanticType: string): readonly string[] | undefined => {
      if (semanticType !== 'ENUM' || targetRef === null || contracts.contractView.mode === 'CLEAN_ONLY') return undefined;
      const options = contracts.contractView.fields.find((field) => field.targetRef === targetRef)?.options ?? [];
      return options.length > 0 ? [...options] : undefined;
    };
    /** Whether the contract requires a target (D3-CAP-10): not nillable, not defaulted, writable and deliverable. Only a vendor contract states a requirement. */
    const requiredTarget = (targetRef: string | null): boolean => {
      if (targetRef === null || contracts.contractView.mode === 'CLEAN_ONLY') return false;
      const stated = contracts.contractView.fields.find((field) => field.targetRef === targetRef);
      return stated !== undefined && stated.required && (stated.createable || stated.updateable) && (contracts.refs.targetByRef.get(targetRef)?.destinationField ?? '') !== '';
    };
    /** Migration Core's original candidates on a column: what a deterministic decision about it answers. */
    const originalsOn = (fieldRef: string): readonly string[] => contracts.candidates.filter((candidate) => candidate.sourceRefs.includes(fieldRef)).map((candidate) => candidate.candidateRef);
    /** Adds the mapping unless another column of the same record mapping already holds the target; then the earlier claim stands and the agency decides. */
    const addField = (candidateRef: string, fieldRef: string, targetRef: string | null, destinationField: string, semanticType: string, primitive: string | null, params: Readonly<Record<string, string>> | null, contradiction: string, decision: Omit<FragmentDecision, 'kind' | 'index'>): boolean => {
      const info = contracts.refs.fieldByRef.get(fieldRef);
      if (info === undefined) return false;
      const { recordId, object } = recordIdOf(info.fileId, destinationField);
      const owner = claimed.get(claimKey(recordId, destinationField));
      if (owner !== undefined && owner !== fieldRef) {
        contradictions.push(contradiction);
        decisionsRequired.push({ candidateRef, reason: `DUPLICATE_TARGET:${destinationField}` });
        return false;
      }
      // The same column into the same destination again — a field-level answer and a requirement's (D3-CAP-10) — is one field: the later decision joins the fragment's DecisionEvidence, and Migration Core is never handed the destination twice.
      const again = fields.findIndex((field) => field.recordId === recordId && field.destinationField === destinationField && field.columnLocator === info.locator);
      const joined = fieldDecisions[again];
      if (joined !== undefined) {
        fieldDecisions[again] = { ...joined, candidateRefs: [...new Set([...joined.candidateRefs, ...decision.candidateRefs])] };
        return true;
      }
      claimed.set(claimKey(recordId, destinationField), fieldRef);
      const allowedValues = allowedValuesOf(targetRef, semanticType);
      // The fragment names its decision; its hash is stamped when the configuration is sealed on what Migration Core's loader makes of it.
      fields.push({ recordId, fileId: info.fileId, filePath: info.filePath, object: object.toUpperCase(), columnHeader: info.headerRaw, columnLocator: info.locator, destinationField, semanticType, required: requiredTarget(targetRef), onInvalid: 'PRESERVE', onAmbiguous: 'PRESERVE', transformPrimitive: primitive, typedTransformParams: params, ...(allowedValues === undefined ? {} : { allowedValues }), decisionRef: decision.decisionRef, fragmentHash: '' });
      fieldDecisions.push(decision);
      return true;
    };
    // Deterministic mappings first; they were decided on facts and outrank a proposal about the same field.
    for (const decision of decisions) {
      if (decision.kind === 'FIELD_MAPPING' && decision.targetRef !== null) {
        const info = contracts.refs.targetByRef.get(decision.targetRef);
        if (info !== undefined && info.destinationField !== '' && addField(decision.fieldRef, decision.fieldRef, decision.targetRef, info.destinationField, decision.semanticType ?? 'TEXT', null, null, `${info.destinationField} is claimed by two source fields of one record mapping`, { decisionRef: decision.decisionRef, candidateRefs: originalsOn(decision.fieldRef), origin: 'DETERMINISTIC', rule: decision.rule, evidenceRefs: decision.evidenceRefs })) deterministic.push(decision);
      }
    }
    // Who preserved a column: the model's accepted UNMAPPED_PRESERVE, or the resolver's default that abstention preserves.
    const preservedBy = new Map<string, Omit<FragmentDecision, 'kind' | 'index'>>();
    const resolverPreserve = (fieldRef: string, candidateRefs: readonly string[]): Omit<FragmentDecision, 'kind' | 'index'> => {
      const decision = decisions.find((entry) => entry.kind === 'PRESERVE_UNMAPPED' && entry.fieldRef === fieldRef);
      return { decisionRef: decision?.decisionRef ?? `dec_${digestOf(['preserve', fieldRef]).slice(0, 16)}`, candidateRefs, origin: 'DETERMINISTIC', rule: decision?.rule ?? 'UNMAPPED_IS_PRESERVED', evidenceRefs: decision?.evidenceRefs ?? [] };
    };
    // Type decisions shape a field another decision put in (D3-CAP-03): the destination is read under the accepted type, keeping what the type cannot read.
    const typeDecisions: Omit<FragmentDecision, 'kind'>[] = [];
    // The value each value candidate stands for, as the resolver derived it from the host's summaries (D3-CAP-05).
    const valueOf = new Map(resolution.valueCandidates.map((candidate) => [candidate.candidateRef, candidate]));
    // Accepted transformations and value maps, applied once every field is in; and the requirements the model named as blocking, by record mapping and destination.
    const modifiers: CompiledItem[] = [];
    const blockedRequirements = new Set<string>();
    for (const item of items) {
      // A review's answer settles other decisions and is no field or preserve of its own; an answer that grants nothing leaves the contradiction to the agency (D3-CAP-11).
      if (review.candidateRefs.has(item.candidateRef)) {
        if (item.outcome === 'REQUIRES_AGENCY_DECISION') decisionsRequired.push({ candidateRef: item.candidateRef, reason: item.codes[0] ?? item.rationaleCode });
        continue;
      }
      // A claim the review preserved as the weaker one puts nothing in: its column is a leftover, preserved by the review's decision, and the other claim of the scope stands.
      const droppedBy = review.dropped.get(item.candidateRef);
      if (droppedBy !== undefined) {
        if (item.outcome === 'PROPOSED' && item.proposalType === 'MAP_FIELD' && item.sourceFieldRef !== null) {
          preserved.push(item.sourceFieldRef);
          if (!preservedBy.has(item.sourceFieldRef)) preservedBy.set(item.sourceFieldRef, { decisionRef: droppedBy.candidateRef, candidateRefs: [item.candidateRef, droppedBy.candidateRef], origin: 'PROPOSED', rule: REVIEW_PRESERVE_RULE, evidenceRefs: droppedBy.evidenceRefs });
        }
        continue;
      }
      const kind = kindOf.get(item.candidateRef);
      if (kind === DERIVED_CANDIDATE_TYPES.OBJECT) {
        // The object of a file: its record is made below, from its fields; its columns, while the object is not decided, are preserved by the resolver's default.
        if (item.outcome === 'REQUIRES_AGENCY_DECISION') decisionsRequired.push({ candidateRef: item.candidateRef, reason: item.codes[0] ?? item.rationaleCode });
        continue;
      }
      if (kind === DERIVED_CANDIDATE_TYPES.SEMANTIC_TYPE) {
        const locator = contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '')?.locator;
        const at = fields.findIndex((field) => field.columnLocator === locator && field.destinationField === item.destinationField);
        const current = fields[at];
        if (item.outcome === 'PROPOSED' && item.semanticType !== null && current !== undefined) {
          fields[at] = { ...current, semanticType: item.semanticType, onInvalid: 'PRESERVE' };
          typeDecisions.push({ index: at, decisionRef: item.candidateRef, candidateRefs: [item.candidateRef], origin: 'PROPOSED', rule: item.rationaleCode, evidenceRefs: item.evidenceRefs, expectedEffect: 'TYPE_APPLIED' });
        } else if (item.outcome === 'REQUIRES_AGENCY_DECISION') decisionsRequired.push({ candidateRef: item.candidateRef, reason: item.codes[0] ?? item.rationaleCode });
        // Anything else leaves the field under its deterministic type.
        continue;
      }
      if (item.outcome === 'PROPOSED' && FIELD_MODIFIERS.has(item.proposalType)) {
        modifiers.push(item);
        continue;
      }
      if (item.outcome === 'REQUIRES_AGENCY_DECISION' && item.proposalType === 'BLOCKING_TARGET_REQUIREMENT' && item.destinationField !== null) {
        // One decision per requirement, however many of its plausible columns the model answered for it.
        const info = contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '');
        const key = `${info === undefined ? '' : recordIdOf(info.fileId, item.destinationField).recordId}|${item.destinationField}`;
        if (!blockedRequirements.has(key)) decisionsRequired.push({ candidateRef: item.candidateRef, reason: `REQUIRED_TARGET_UNSATISFIED:${item.destinationField}` });
        blockedRequirements.add(key);
        continue;
      }
      if (item.outcome === 'PROPOSED' && item.destinationField !== null && item.sourceFieldRef !== null) {
        // Two sources for one target inside one record mapping: the earlier
        // claim (a deterministic mapping outranks a proposal) stands and the
        // agency decides the other; nothing is dropped and nothing is guessed.
        addField(item.candidateRef, item.sourceFieldRef, item.targetRef, item.destinationField, item.semanticType ?? 'TEXT', item.transformPrimitive, item.typedTransformParams, `${item.destinationField}: a proposal contradicts a deterministic mapping or another task in the same record mapping`, { decisionRef: item.candidateRef, candidateRefs: [item.candidateRef], origin: 'PROPOSED', rule: item.rationaleCode, evidenceRefs: item.evidenceRefs });
      } else if (item.outcome === 'REQUIRES_AGENCY_DECISION') {
        decisionsRequired.push({ candidateRef: item.candidateRef, reason: item.codes[0] ?? item.rationaleCode });
      } else if (item.sourceFieldRef !== null && !VALUE_LEVEL_TYPES.has(kindOf.get(item.candidateRef) ?? '') && !IDENTITY_FAMILY_CANDIDATES.has(kindOf.get(item.candidateRef) ?? '')) {
        // The identity families key, review and link columns; whether a column is preserved is its field question's to say, never theirs.
        preserved.push(item.sourceFieldRef);
        if (!preservedBy.has(item.sourceFieldRef)) preservedBy.set(item.sourceFieldRef, item.outcome === 'PROPOSED' ? { decisionRef: item.candidateRef, candidateRefs: [item.candidateRef], origin: 'PROPOSED', rule: item.rationaleCode, evidenceRefs: item.evidenceRefs } : resolverPreserve(item.sourceFieldRef, [item.candidateRef]));
      }
    }
    for (const decision of decisions) if (decision.kind === 'PRESERVE_UNMAPPED' && !fields.some((field) => contracts.refs.fieldByRef.get(decision.fieldRef)?.locator === field.columnLocator) && !preserved.includes(decision.fieldRef)) preserved.push(decision.fieldRef);

    // A transformation parameterises, and a value map maps the values of, the field another decision put in (D3-CAP-04, D3-CAP-05): the field at the column and destination they name. The value map's `from` is the value the candidate stands for, from the host's summaries — never a text of the proposal. Either joins the field's DecisionEvidence as a candidate it answers.
    for (const item of modifiers) {
      const locator = contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '')?.locator;
      const index = fields.findIndex((field) => field.columnLocator === locator && field.destinationField === item.destinationField);
      const field = fields[index];
      const decision = fieldDecisions[index];
      const value = valueOf.get(item.candidateRef);
      const to = item.typedTransformParams?.['to'];
      if (field === undefined || decision === undefined || (item.proposalType === 'APPLY_SUPPORTED_TRANSFORM' && field.transformPrimitive !== null) || (item.proposalType === 'MAP_ENUM_VALUE' && (value === undefined || to === undefined))) {
        decisionsRequired.push({ candidateRef: item.candidateRef, reason: `NO_FIELD_FOR_DECISION:${item.destinationField ?? ''}` });
        continue;
      }
      fields[index] = item.proposalType === 'APPLY_SUPPORTED_TRANSFORM' ? { ...field, transformPrimitive: item.transformPrimitive, typedTransformParams: item.typedTransformParams } : { ...field, valueMap: [...(field.valueMap ?? []), { from: value?.value ?? '', to: to ?? '' }] };
      fieldDecisions[index] = { ...decision, candidateRefs: [...decision.candidateRefs, item.candidateRef] };
    }

    // One record mapping per file a field is delivered from: the object its field decisions name — declared by the project, or the one the headers name — and the record id column the project declares for the file, found by the resolver's own header rule; nothing inferred.
    const records: ConfigFragmentRecord[] = [];
    const recordDecisions: Omit<FragmentDecision, 'kind' | 'index'>[] = [];
    const header = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');
    for (const field of fields) {
      if (records.some((record) => record.recordId === field.recordId)) continue;
      const declaredObject = input.projectRevision.declaredObjects?.[field.filePath] ?? input.projectRevision.declaredObjects?.[field.fileId];
      const declaredIdHeader = input.projectRevision.recordIdColumns?.[field.filePath] ?? input.projectRevision.recordIdColumns?.[field.fileId];
      const idColumn = declaredIdHeader === undefined ? undefined : [...contracts.refs.fieldByRef.values()].filter((column) => column.fileId === field.fileId && header(column.header) !== '' && header(column.header) === header(declaredIdHeader)).sort((a, b) => a.columnIndex - b.columnIndex)[0];
      // The object of a file the project did not declare and the headers did not decide is the model's accepted MAP_OBJECT, whose decision the record names (D3-CAP-01).
      const objectDecision = declaredObject === undefined ? objectDecisions.get(field.fileId) : undefined;
      const decided = objectDecision !== undefined && objectDecision.object === field.object;
      const decisionRef = decided ? objectDecision.candidateRef : `dec_${digestOf(['record', field.recordId, field.object]).slice(0, 16)}`;
      records.push({ recordId: field.recordId, fileId: field.fileId, filePath: field.filePath, object: field.object, sourceRecordIdColumn: idColumn === undefined ? null : { columnLocator: idColumn.locator }, authoritativeExternalIdColumns: [], identitySpace: null, decisionRef, fragmentHash: '' });
      // The record answers the key candidates Migration Core listed on the record id column the project declared for it.
      const declaredKeys = idColumn === undefined ? [] : contracts.candidates.filter((candidate) => candidate.candidateType === 'KEY_CANDIDATE' && candidate.sourceRefs.includes(contracts.refs.refByLocator.get(idColumn.locator) ?? '')).map((candidate) => candidate.candidateRef);
      recordDecisions.push(decided ? { decisionRef, candidateRefs: [objectDecision.candidateRef, ...declaredKeys], origin: 'PROPOSED', rule: objectDecision.rationaleCode, evidenceRefs: objectDecision.evidenceRefs } : { decisionRef, candidateRefs: declaredKeys, origin: 'DETERMINISTIC', rule: declaredObject === field.object ? 'DECLARED_OBJECT' : 'HEADERS_NAME_THE_OBJECT', evidenceRefs: fields.filter((entry) => entry.recordId === field.recordId).map((entry) => entry.decisionRef) });
    }

    // The identity families (B03-CAP-IDENTITY). What the compiler accepted about identity, duplicates and associations shapes the records, the review groups and the associations — each only through a candidate of its own family.
    const accepted = (proposalType: string, candidateType: string): readonly CompiledItem[] => items.filter((item) => item.outcome === 'PROPOSED' && item.proposalType === proposalType && kindOf.get(item.candidateRef) === candidateType);
    const unassembled = new Map<string, string>();
    const leaveToAgency = (candidateRef: string, code: string): void => {
      unassembled.set(candidateRef, code);
      decisionsRequired.push({ candidateRef, reason: code });
    };
    const recordOfField = (fieldRef: string): string | null => decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === fieldRef)?.recordId ?? null;

    // Identity (D3-CAP-06): an accepted strategy names its column an authoritative external id of its file's record mapping — the effect Migration Core combines proven rows by.
    const strategies = new Map<string, { readonly locators: string[]; readonly candidateRefs: string[] }>();
    for (const item of accepted('PROPOSE_IDENTITY_STRATEGY', IDENTITY_CANDIDATE_TYPE)) {
      const column = item.sourceFieldRef === null ? undefined : contracts.refs.fieldByRef.get(item.sourceFieldRef);
      const recordId = item.sourceFieldRef === null ? null : recordOfField(item.sourceFieldRef);
      if (column === undefined || recordId === null || !records.some((record) => record.recordId === recordId)) {
        // A file none of whose columns is delivered has no record mapping to key.
        leaveToAgency(item.candidateRef, 'IDENTITY_WITHOUT_RECORD_MAPPING');
        continue;
      }
      const strategy = strategies.get(recordId) ?? { locators: [], candidateRefs: [] };
      if (!strategy.locators.includes(column.locator)) strategy.locators.push(column.locator);
      strategy.candidateRefs.push(item.candidateRef);
      strategies.set(recordId, strategy);
    }
    // One identity space per object for the record mappings an external id keys, so equal external ids in two files are one record — unless two of them declare record id sequences of their own, which one space would confuse; the agency joins those.
    for (const object of [...new Set(records.filter((record) => strategies.has(record.recordId)).map((record) => record.object))]) {
      const keyed = records.filter((record) => record.object === object && strategies.has(record.recordId));
      const shared = keyed.length >= 2 && keyed.filter((record) => record.sourceRecordIdColumn !== null).length <= 1;
      if (keyed.length >= 2 && !shared) for (const record of keyed) for (const candidateRef of strategies.get(record.recordId)?.candidateRefs ?? []) decisionsRequired.push({ candidateRef, reason: 'IDENTITY_SPACE_NOT_SHARED:RECORD_IDS_DECLARED' });
      for (const record of keyed) {
        const index = records.indexOf(record);
        const strategy = strategies.get(record.recordId);
        if (strategy === undefined) continue;
        records[index] = { ...record, authoritativeExternalIdColumns: strategy.locators.map((columnLocator) => ({ columnLocator })), identitySpace: shared ? `identity-${object.toLowerCase()}` : null };
        const decision = recordDecisions[index];
        if (decision !== undefined) recordDecisions[index] = { ...decision, candidateRefs: [...decision.candidateRefs, ...strategy.candidateRefs] };
      }
    }

    // Associations (D3-CAP-08): an accepted association is a COLUMN_REFERENCE from its key column to the declared record id of its target — both record mappings in the configuration, or the agency decides.
    const associations: ConfigFragmentAssociation[] = [];
    const associationDecisions: Omit<FragmentDecision, 'kind' | 'index'>[] = [];
    for (const item of accepted('MAP_ASSOCIATION', ASSOCIATION_CANDIDATE_TYPE)) {
      // An association the review preserved as the weaker claim is not delivered (D3-CAP-11), exactly as a field it preserves is not: its key column is whatever the other claim and the leftovers make of it, and the disposition of the claim records the review.
      const droppedBy = review.dropped.get(item.candidateRef);
      if (droppedBy !== undefined) {
        if (item.sourceFieldRef !== null) {
          preserved.push(item.sourceFieldRef);
          if (!preservedBy.has(item.sourceFieldRef)) preservedBy.set(item.sourceFieldRef, { decisionRef: droppedBy.candidateRef, candidateRefs: [item.candidateRef, droppedBy.candidateRef], origin: 'PROPOSED', rule: REVIEW_PRESERVE_RULE, evidenceRefs: droppedBy.evidenceRefs });
        }
        continue;
      }
      const option = item.sourceFieldRef === null || item.targetRef === null ? undefined : associationOptionOf(contracts, decisions, item.sourceFieldRef, item.targetRef);
      const key = item.sourceFieldRef === null ? undefined : contracts.refs.fieldByRef.get(item.sourceFieldRef);
      const owner = records.find((record) => record.recordId === option?.ownerRecordId);
      const target = records.find((record) => record.recordId === option?.targetRecordId);
      if (option === undefined || option.status !== 'OFFERED' || key === undefined || owner === undefined || target === undefined || target.sourceRecordIdColumn === null) {
        leaveToAgency(item.candidateRef, 'ASSOCIATION_ENDPOINT_NOT_ASSEMBLED');
        continue;
      }
      associations.push({ associationId: option.associationRef, recordId: owner.recordId, relationshipType: option.relationshipType, ownerSide: option.ownerSide, keyColumn: { columnLocator: key.locator }, targetRecordId: target.recordId, targetMatchKey: 'SOURCE_RECORD_ID', decisionRef: item.candidateRef, fragmentHash: '' });
      associationDecisions.push({ decisionRef: item.candidateRef, candidateRefs: [item.candidateRef], origin: 'PROPOSED', rule: item.rationaleCode, evidenceRefs: item.evidenceRefs });
    }

    // Duplicate signals (D3-CAP-07): an accepted review proposal puts the clusters it stands for in front of the agency, by their rows' addresses; nothing of it enters the configuration.
    const reviewGroups: ReviewGroup[] = accepted('PROPOSE_DUPLICATE_SIGNAL', DUPLICATE_CANDIDATE_TYPE).flatMap((item) =>
      (resolution.duplicateClusters ?? [])
        .filter((cluster) => cluster.candidateRef === item.candidateRef)
        .map((cluster) => ({ groupRef: cluster.clusterRef, decisionRef: item.candidateRef, recordMappingIds: cluster.recordMappingIds, signalColumns: cluster.signalFieldRefs.map((fieldRef) => contracts.refs.fieldByRef.get(fieldRef)?.locator ?? fieldRef), rows: cluster.rows, rowLocators: cluster.rowLocators, rowsDigest: cluster.rowsDigest, observed: false })),
    );

    // The preserved columns, as fragments: a column the record's identity reads is the record's, and a column an association reads is the association's — not a leftover.
    const identityLocators = new Set([...records.flatMap((record) => [record.sourceRecordIdColumn, ...record.authoritativeExternalIdColumns]).flatMap((column) => (column === null ? [] : [column.columnLocator])), ...associations.map((association) => association.keyColumn.columnLocator)]);
    const preservedColumns: ConfigFragmentColumn[] = [];
    const preservedDecisions: Omit<FragmentDecision, 'kind' | 'index'>[] = [];
    for (const fieldRef of new Set(preserved)) {
      const info = contracts.refs.fieldByRef.get(fieldRef);
      if (info === undefined || identityLocators.has(info.locator) || fields.some((field) => field.columnLocator === info.locator)) continue;
      const decision = preservedBy.get(fieldRef) ?? resolverPreserve(fieldRef, []);
      preservedColumns.push({ fileId: info.fileId, filePath: info.filePath, columnLocator: info.locator, decisionRef: decision.decisionRef, fragmentHash: '' });
      preservedDecisions.push(decision);
    }
    // The contract's requirements on every record mapping (D3-CAP-10): satisfied by the field that delivers the target, which is required; blocking otherwise, a decision for the agency — named once, by the model's blocking answer or on facts alone.
    const requirements: DraftRequirement[] = [];
    if (contracts.contractView.mode !== 'CLEAN_ONLY') {
      for (const record of records) {
        for (const target of contracts.contractView.fields) {
          const destination = contracts.refs.targetByRef.get(target.targetRef)?.destinationField ?? '';
          if (!requiredTarget(target.targetRef) || (destination.split('.')[0] ?? '').toUpperCase() !== record.object) continue;
          const satisfying = fields.find((field) => field.recordId === record.recordId && field.destinationField === destination);
          requirements.push({ recordMappingId: record.recordId, targetRef: target.targetRef, destinationField: destination, status: satisfying === undefined ? 'BLOCKING' : 'SATISFIED', decisionRef: satisfying?.decisionRef ?? null });
          if (satisfying === undefined && !blockedRequirements.has(`${record.recordId}|${destination}`)) decisionsRequired.push({ candidateRef: `dec_${digestOf(['requirement', record.recordId, target.targetRef]).slice(0, 16)}`, reason: `REQUIRED_TARGET_UNSATISFIED:${destination}` });
        }
      }
    }
    const fragments = { records, fields, associations, preservedColumns, excludedColumns: [] };
    const configuration: CandidateConfiguration = { configurationRef: `cfg_${digestOf({ ...fragments, profile: contracts.profileHash }).slice(0, 16)}`, mode: input.projectRevision.mode, profileHash: contracts.profileHash, candidateSetHash: contracts.candidateSetHash, targetContractHash: contracts.targetContractHash, ...fragments };
    const fragmentDecisions: FragmentDecision[] = [...recordDecisions.map((decision, index) => ({ ...decision, kind: 'RECORD' as const, index })), ...fieldDecisions.map((decision, index) => ({ ...decision, kind: 'FIELD' as const, index })), ...typeDecisions.map((decision) => ({ ...decision, kind: 'FIELD' as const })), ...associationDecisions.map((decision, index) => ({ ...decision, kind: 'ASSOCIATION' as const, index })), ...preservedDecisions.map((decision, index) => ({ ...decision, kind: 'PRESERVED_COLUMN' as const, index }))];
    // A column a field delivers is not preserved, whichever answer about it abstained.
    const mappedLocators = new Set(fields.map((field) => field.columnLocator));
    return { configuration, fragmentDecisions, items, deterministic, contradictions, preserved: [...new Set(preserved)].filter((fieldRef) => !mappedLocators.has(contracts.refs.fieldByRef.get(fieldRef)?.locator ?? '')), decisionsRequired, requirements, reviewGroups, unassembled };
  }

  /** A deterministic decision as draft evidence: the rule is the rationale, the decision's refs are the refs, the class is the rule's; no primitive — the resolver maps, it never transforms. */
  function deterministicEvidence(decision: ResolvedDecision, destinationField: string, fragmentHash: string | null): DraftEvidence {
    return { origin: 'DETERMINISTIC', candidateRef: decision.decisionRef, evidenceClass: deterministicEvidenceClass(decision.rule), rationaleCode: decision.rule, evidenceRefs: decision.evidenceRefs, sourceFieldRef: decision.sourceFieldRef, targetRef: decision.targetRef, destinationField, semanticType: decision.semanticType, transformPrimitive: null, typedTransformParams: null, fragmentHash };
  }

  /**
   * The coverage manifest (D3-CFG-3): each fragment of the sealed
   * configuration, from the candidates its decision answers to the effect
   * the receipt reports, met on the fragment hash. A record is observed when
   * Migration Core ran its mapping, a field or an association when it
   * consumed the element, a preserved column when it accounted the column's
   * values as unmapped leftovers — or the whole file, when no mapping covers
   * it, as leftover rows.
   */
  function fragmentCoverageOf(sealed: SealedConfiguration, fragmentDecisions: readonly FragmentDecision[], effects: MigrationEffects | null): FragmentCoverage {
    const entries = fragmentDecisions.map((decision): FragmentCoverageEntry => {
      const pointer = sealed.coverage.find((entry) => entry.kind === decision.kind && entry.index === decision.index);
      const fragmentHash = pointer?.fragmentHash ?? '';
      let observed = false;
      if (effects !== null && fragmentHash !== '') {
        if (decision.kind === 'RECORD') observed = effects.records.some((effect) => effect.fragmentHash === fragmentHash);
        else if (decision.kind === 'FIELD') observed = effects.fields.some((effect) => effect.fragmentHash === fragmentHash);
        else if (decision.kind === 'ASSOCIATION') observed = effects.associations.some((effect) => effect.fragmentHash === fragmentHash);
        else if (decision.kind === 'PRESERVED_COLUMN') {
          const fileId = sealed.configuration.preservedColumns[decision.index]?.fileId;
          observed = effects.unmapped.some((effect) => effect.fragmentHash === fragmentHash) || effects.leftoverFiles.some((effect) => effect.fileId === fileId);
        }
      }
      return { fragmentKind: decision.kind, decisionRef: decision.decisionRef, candidateRefs: decision.candidateRefs, origin: decision.origin, rule: decision.rule, evidenceRefs: decision.evidenceRefs, fragmentHash, pointer: pointer?.pointer ?? null, expectedEffect: decision.expectedEffect ?? EXPECTED_EFFECT[decision.kind], observed };
    });
    return { complete: entries.every((entry) => entry.observed), entries };
  }

  /**
   * The receipt against what this run knows. Shape first — a member missing,
   * a count that is not a finite integer, an unknown member — then the
   * bindings: the exact configuration handed over, the hashes, exact row
   * coverage, a Migration Core version this core accepts, an instant not
   * before the run started and not after now, and an internally consistent
   * verdict. Every problem is a code; any one of them means no draft.
   *
   * "Now" is the injected clock's, with no tolerance: the host dates its
   * receipt by the same clock it hands this core (one clock discipline
   * across the boundary, as the fixtures' adapter shows), so a receipt from
   * the future is a receipt dated by another clock, or made up.
   */
  function validationIsSound(result: FullDatasetValidationResult, configuration: CandidateConfiguration, expectedCoreConfigHash: string, contracts: AdaptedContracts, rowsInProfile: number, rowsRejected: number, runCreatedAt: string, nowMs: number): readonly string[] {
    const problems: string[] = [];
    const shape = validate(result, FULL_DATASET_VALIDATION_RESULT_SCHEMA);
    if (shape.length > 0) {
      problems.push('VALIDATION_RECEIPT_MALFORMED', ...shape.slice(0, 8).map((problem) => `${problem.pointer}:${problem.message}`));
      return problems;
    }
    if (result.configurationRef !== configuration.configurationRef) problems.push('VALIDATION_FOR_ANOTHER_CONFIGURATION');
    if (result.configurationDigest !== digestOf(configuration)) problems.push('VALIDATION_CONFIGURATION_DIGEST_MISMATCH');
    if (result.profileHash !== contracts.profileHash || result.candidateSetHash !== contracts.candidateSetHash || result.targetContractHash !== contracts.targetContractHash) problems.push('VALIDATION_HASHES_STALE');
    // Migration Core's run accounts for every row the reader produced: the data rows and the rows the reading policy rejected (a fully empty line is one, blankRow REJECT_ROW), which the profile counts apart from its data rows. Nothing else is excused: a data row the validation did not reach still fails the check.
    const rowsRead = rowsInProfile + rowsRejected;
    if (result.rowsValidated <= 0 || result.rowsInProfile !== rowsInProfile || result.rowsValidated < rowsRead) problems.push('VALIDATION_COVERAGE_INCOMPLETE');
    // More rows than the profile holds is not generosity: it is a receipt about another dataset.
    if (result.rowsValidated !== rowsRead) problems.push('VALIDATION_COVERAGE_INEXACT');
    if (!SUPPORTED_MIGRATION_CORE.coreVersions.includes(result.coreVersion)) problems.push('VALIDATION_CORE_VERSION_UNSUPPORTED');
    const verdicts = [result.ok, result.problems.length === 0, result.reconciliationHolds, result.packageVerified];
    if (verdicts.some((verdict) => verdict !== result.ok)) problems.push('VALIDATION_RECEIPT_INCONSISTENT');
    // A package the host says it verified was written and reported on; a verified verdict that names no package digest or no report digest is a receipt about nothing that ran.
    if ((result.ok || result.packageVerified) && (result.evidence.packageDigest === null || result.evidence.reportDigest === null) && !problems.includes('VALIDATION_RECEIPT_INCONSISTENT')) problems.push('VALIDATION_RECEIPT_INCONSISTENT');
    // The document Migration Core loaded is the one this core produced (B03-R11): a verified verdict names its loader's hash, and that hash is the one this core's own loading of the document gives.
    if ((result.ok || result.packageVerified) && result.evidence.coreConfigHash === null) problems.push('VALIDATION_CORE_CONFIG_HASH_MISSING');
    if (result.evidence.coreConfigHash !== null && result.evidence.coreConfigHash !== expectedCoreConfigHash) problems.push('VALIDATION_CORE_CONFIG_HASH_MISMATCH');
    // What Migration Core did with the fragments belongs to a verified verdict, and it is about that same document (D3-CFG-3).
    if ((result.ok || result.packageVerified) && result.effects === null) problems.push('VALIDATION_EFFECTS_MISSING');
    if (result.effects !== null && result.evidence.coreConfigHash !== null && result.effects.configHash !== result.evidence.coreConfigHash) problems.push('VALIDATION_EFFECTS_FOR_ANOTHER_CONFIGURATION');
    const validatedAt = Date.parse(result.validatedAt);
    if (!Number.isFinite(validatedAt) || validatedAt < Date.parse(runCreatedAt)) problems.push('VALIDATION_BEFORE_RUN_STARTED');
    if (validatedAt > nowMs) problems.push('VALIDATION_AFTER_NOW');
    if (!result.reconciliationHolds || !result.packageVerified) problems.push('VALIDATION_RECONCILIATION_OR_VERIFY_FAILED');
    if (!result.ok) problems.push('VALIDATION_REPORTED_PROBLEMS');
    return problems;
  }

  /** One IntelligenceRun, by one owner: the invocation opens its own ledger handle, takes the lease under it and makes every write under it. */
  async function runAttempt(input: IntelligenceInput, context: HostContext): Promise<IntelligenceResult> {
    // What spending needs from the host — the attempt's egress key, the tariff, the dispatch admission — is checked before anything is written or sent.
    const missing = dependencyProblems();
    if (missing.length > 0) throw new IntelligenceError('CONTRACT_VIOLATION', missing.join('; '), { missing });
    // The key as the record holds it: the host's key id and a keyed check value that tells two secrets under one id apart; never the secret.
    const attemptKey = { keyId: egressKey.keyId, check: createHmac('sha256', egressKey.secret).update(`kauro-egress-key-check:${egressKey.keyId}`).digest('hex') };
    const started = deps.clock.nowMs();
    const versionProblems = [...compatibilityProblems({ envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION, proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION, sourceProfileVersion: input.sourceProfile.profile.profileVersion, candidateSetVersion: input.candidateSet.candidateSet.candidateSetVersion, targetContractVersion: input.targetContract?.contract.contractVersion ?? null, coreVersion: input.candidateSet.candidateSet.refs.coreVersion, configSchemaVersion: input.candidateSet.candidateSet.refs.configSchemaVersion })];
    if (input.policyBundle.modelPolicyVersion !== MODEL_POLICY_VERSION) versionProblems.push(`modelPolicyVersion ${input.policyBundle.modelPolicyVersion} is not ${MODEL_POLICY_VERSION}`);
    if (input.policyBundle.promptBundleVersion !== PROMPT_BUNDLE_VERSION) versionProblems.push(`promptBundleVersion ${input.policyBundle.promptBundleVersion} is not ${PROMPT_BUNDLE_VERSION}`);
    if (context.tenant.agencyId.trim() === '' || context.tenant.clientId.trim() === '') throw new IntelligenceError('TENANT_MISMATCH', 'the host context names no tenant');
    if (typeof context.auditAttemptId !== 'string' || context.auditAttemptId.trim() === '') throw new IntelligenceError('CONTRACT_VIOLATION', 'the host context names no AuditAttempt identity');
    // The identity the attempt is bound to: tenant and attempt make the id; revision, hashes and every version that shapes a request — the data and masking policies among them, since what may leave and how it is masked is content of the attempt — are checked against the ledger on every reopening.
    // Everything the host declared is bound too, member by member, as the host declared it and before this build says whether it accepts it: the same attempt id resubmitted with any one member of its input or its context changed — the policy bundle, the mode, recordIdColumns, a summary, a deadline — is a conflict, not a redelivery, and never answered from the stored result (IC-04, D3-ID-1).
    const declared = declaredIdentity(input, context);
    // The host's side of the time contract (D3-TIME-1): its deadlines, instants or nothing; the resource profile's window, a positive integer no longer than the policy's. What fails either is a failed contract, recorded before anything is spent.
    const hostProblems: string[] = [];
    const hostDeadlineMs = (name: string, value: unknown): number | undefined => {
      if (value === undefined) return undefined;
      const ms = typeof value === 'string' && INSTANT_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(ms)) return ms;
      hostProblems.push(`HOST_DEADLINE_MALFORMED:${name}`);
      return undefined;
    };
    // The project's declared locale (D3-CAP-04): each member inside its closed domain, or the host's contract fails before anything is spent.
    const locale = declaredLocale(input.projectRevision.localeEvidence);
    hostProblems.push(...locale.problems);
    const interpretationDeadlineMs = hostDeadlineMs('interpretationDeadlineAt', context.interpretationDeadlineAt);
    const absoluteDeadlineMs = hostDeadlineMs('absoluteDeadlineAt', context.absoluteDeadlineAt);
    const wallClockMs: unknown = input.resourceProfile.wallClockMs;
    const windowMs = typeof wallClockMs === 'number' && Number.isSafeInteger(wallClockMs) && wallClockMs > 0 ? wallClockMs : undefined;
    if (wallClockMs !== undefined && windowMs === undefined) hostProblems.push('RESOURCE_PROFILE_MALFORMED');
    else if (windowMs !== undefined && windowMs > BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS) hostProblems.push('RESOURCE_PROFILE_ABOVE_POLICY');
    // The host's tariff prices every maximum charge the grant is asked to hold (D3-GRANT-1), and the egress key masks every label the requests carry (D3-KEY-1): both come with CoreDependencies, not the declared input, so both are bound here — another tariff or another key for the same attempt is IDENTITY_CONFLICT.
    const ledger = RunLedger.create(deps.ledgerStore, deps.clock, { auditAttemptId: context.auditAttemptId, projectRevisionHash: input.projectRevision.projectRevisionHash, hashes: { profile: input.sourceProfile.profileHash, candidateSet: input.candidateSet.candidateSetHash, targetContract: input.targetContract?.contractHash ?? null, ...declared, tariff: digestOf(deps.tariff) }, versions: { intelligenceCoreVersion: INTELLIGENCE_CORE_VERSION, envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION, proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, modelPolicyVersion: MODEL_POLICY_VERSION, dataPolicyVersion: DATA_POLICY_VERSION, maskingPolicyVersion: MASKING_POLICY_VERSION, promptBundleHash: PROMPT_BUNDLE_HASH, modelPolicyHash: digestOf(modelPolicy) }, tenant: context.tenant, egressKey: attemptKey, ...(windowMs === undefined ? {} : { wallClockMs: windowMs }), ...(interpretationDeadlineMs === undefined ? {} : { interpretationDeadlineMs }), ...(absoluteDeadlineMs === undefined ? {} : { absoluteDeadlineMs }) });
    const provenance = { intelligenceCoreVersion: INTELLIGENCE_CORE_VERSION, envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION, proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, promptBundleHash: PROMPT_BUNDLE_HASH, modelPolicyVersion: MODEL_POLICY_VERSION, modelPolicyHash: digestOf(modelPolicy), dataPolicyVersion: DATA_POLICY_VERSION, maskingPolicyVersion: MASKING_POLICY_VERSION, memoryContractVersion: MEMORY_CONTRACT_VERSION, compilerContractVersion: COMPILER_CONTRACT_VERSION, profileHash: input.sourceProfile.profileHash, candidateSetHash: input.candidateSet.candidateSetHash, targetContractHash: input.targetContract?.contractHash ?? null, projectRevisionHash: input.projectRevision.projectRevisionHash, gatewayEvidenceClass: deps.gateway.evidenceClass };
    const notDraftable = (fullValidation: FullDatasetValidationResult | null, unresolved: IntelligenceResult['unresolvedItems'], decisionsRequired: readonly { candidateRef: string; reason: string }[], preserved: readonly string[], coverage: CandidateCoverage | null = null): DraftMigrationPlan => ({ planVersion: '1.0.0', status: 'NOT_DRAFTABLE', configuration: null, impact: { fieldsMapped: 0, rowsCovered: 0, fieldsPreserved: preserved.length }, evidence: [], unresolved, unsupportedPreserved: preserved, decisionsRequired, fullValidation, validation: { status: 'NOT_RUN', blockedDestinations: [], refusal: null }, coverage, fragmentCoverage: null, requirements: [], identity: null, reviewGroups: [], associations: [], note: 'A SYSTEM_DRAFT is not an approval, a quote or an authorisation to execute.' });
    /** The run's candidate accounting, once the contracts are adapted and the tasks have run (D3-ACC-1); every result the run stores carries it, and its draft the coverage. */
    let accounting: CandidateAccounting | null = null;
    /** The cause a terminal state recorded from outside puts on the record: the host's cancellation by name, any other state by its name. */
    const causeOf = (recorded: RunState): string => (recorded === 'CANCELLED' ? 'RUN_CANCELLED' : `RUN_${recorded}`);
    /**
     * What the record closed the run with from outside this flow, if
     * anything: a terminal state already on it, or the host's cancellation
     * when its closing transition never landed — `cancel()` writes CANCELLED
     * and then the STATE, and a host that dies between the two has still
     * cancelled the run; the state is closed from the CANCELLED event by
     * whoever finishes the attempt, never worked past.
     */
    const closedFromOutside = (view: { readonly state: RunState; readonly cancelled: boolean }): RunState | null => (TERMINAL_RUN_STATES.has(view.state) ? view.state : view.cancelled ? 'CANCELLED' : null);
    /**
     * The closing transition, idempotent: an append lost to a writer that
     * changed nothing about it (the host's cancel, a note) is decided again
     * on the re-read log, and a terminal state recorded meanwhile stands —
     * as does a cancellation on the record whose own STATE never landed.
     * Returns the terminal state on record when it is done.
     */
    const closeTerminal = (intended: RunState, intendedDraft: boolean): RunState => {
      let lost: unknown = null;
      for (let tries = 0; tries < 4; tries += 1) {
        const view = ledger.view();
        const recorded = view.state;
        if (TERMINAL_RUN_STATES.has(recorded)) {
          // A terminal state was recorded while this process worked (a cancellation from outside). Not swallowed: the ledger names the state this flow meant to reach and did not.
          if (recorded !== intended) ledger.note(`terminal state ${recorded} already recorded; ${intended} not applied`, { intendedDraft: intendedDraft ? 1 : 0 });
          return recorded;
        }
        const closing = closedFromOutside(view) ?? intended;
        if (closing !== intended) ledger.note(`cancellation already recorded without its closing state; ${intended} not applied`, { intendedDraft: intendedDraft ? 1 : 0 });
        try {
          ledger.transition(closing, closing !== intended ? 'cancellation on record closed' : tries === 0 ? 'run finished' : 'run finished; decided again after a lost append');
          return closing;
        } catch (error) {
          if (!isIntelligenceError(error) || error.code !== 'LEDGER_CONFLICT') throw error;
          lost = error;
        }
      }
      throw lost;
    };
    /**
     * The answer the host gets: the stored RESULT, read under the terminal
     * state on record. The RESULT names the state its owner meant to close
     * with; when the record closed otherwise — a cancellation landed between
     * the answer and its closing transition — the record wins: that state,
     * no draft, no memory candidates, the cause named first. A function of
     * the log alone, so every redelivery reads the same answer.
     */
    const publish = (stored: Omit<IntelligenceResult, 'runLedger'>, recorded: RunState): IntelligenceResult => {
      if (recorded === stored.state) return { ...stored, runLedger: ledger.publicExport() };
      const cause = causeOf(recorded);
      const unresolved = stored.unresolvedItems.some((item) => item.candidateRef === 'run' && item.codes[0] === cause) ? stored.unresolvedItems : [...stored.unresolvedItems, { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: [cause, `RESULT_NAMED_${stored.state}`] }];
      const draft = notDraftable(null, unresolved, stored.draft.decisionsRequired, stored.draft.unsupportedPreserved, stored.draft.coverage ?? null);
      return { ...stored, proposalDigest: digestOf({ tasks: stored.tasks, draft: draft.configuration }), state: recorded, draft, unresolvedItems: unresolved, memoryCandidates: [], runLedger: ledger.publicExport() };
    };
    /**
     * The end of the run. The RESULT is stored first and the closing
     * transition made after it, so the attempt is never terminal without an
     * answer: a process that dies between the two leaves a RESULT naming
     * its terminal state, and the reopening closes the state from it and
     * answers, with nothing recomputed and nothing bought. A terminal state
     * something else recorded before this point (a cancellation from
     * outside) is what the result names, and nothing a draft would say
     * against it; the cause is on the unresolved items, first in its codes.
     */
    const finish = async (state: RunState | null, tasks: readonly TaskResult[], draftIntended: DraftMigrationPlan, unresolvedIntended: IntelligenceResult['unresolvedItems'], memoryCandidatesIntended: readonly MemoryCandidate[], counters: { calls: number; planned: number; leftOut: number; decisions: number }): Promise<IntelligenceResult> => {
      let draft = draftIntended;
      let unresolved = unresolvedIntended;
      let memoryCandidates = memoryCandidatesIntended;
      const before = ledger.view();
      // The record's closing, if it closed from outside: a terminal state already written, or a cancellation whose own STATE never landed.
      const recordedBefore = closedFromOutside(before);
      let intended = state;
      if (recordedBefore !== null) {
        if (state !== null && state !== recordedBefore) ledger.note(`terminal state ${recordedBefore} already recorded; ${state} not applied`, { intendedDraft: draft.status === 'SYSTEM_DRAFT' ? 1 : 0 });
        const cause = causeOf(recordedBefore);
        if (!unresolved.some((item) => item.candidateRef === 'run' && item.codes[0] === cause)) unresolved = [...unresolved, { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: [cause] }];
        draft = notDraftable(draft.status === 'SYSTEM_DRAFT' ? null : draft.fullValidation, unresolved, draft.decisionsRequired, draft.unsupportedPreserved);
        memoryCandidates = [];
        intended = recordedBefore;
      }
      if (intended === null) throw new IntelligenceError('CONTRACT_VIOLATION', `run ${ledger.runId} reached its end in ${before.state} with no terminal state to close with`);
      const view = ledger.view();
      // Cost is what the ledger holds, not what this process counted: a resumed run reports the invocations of the process that died too.
      const budget = view.budget;
      const resourceEvidence: IntelligenceResult['resourceEvidence'] = { providerInvocations: budget.invocations, modelCalls: budget.responses, ambiguousReservations: budget.ambiguousReservations, billedInputTokens: budget.billedInputTokens + budget.ambiguousInputTokens, billedOutputTokens: budget.billedOutputTokens + budget.ambiguousOutputTokens, ambiguousInputTokens: budget.ambiguousInputTokens, ambiguousOutputTokens: budget.ambiguousOutputTokens, tasksPlanned: counters.planned, tasksLeftOut: counters.leftOut, deterministicDecisions: counters.decisions, wallClockMs: deps.clock.nowMs() - started, grant: { tariffRef: deps.tariff.tariffRef, ...view.grant }, dispatchGuarantee: 'AT_MOST_ONE_CONCURRENT_DISPATCH' };
      // The draft carries the run's coverage, whichever way it ended: a draft never presents itself as complete while a candidate is pending or unresolved.
      const covered: DraftMigrationPlan = { ...draft, coverage: accounting?.coverage ?? draft.coverage };
      const stored: Omit<IntelligenceResult, 'runLedger'> = { proposalRef: `prop_${digestOf(tasks.map((task) => task.proposalDigest)).slice(0, 16)}`, proposalDigest: digestOf({ tasks, draft: covered.configuration }), runId: ledger.runId, state: intended, tasks, draft: covered, unresolvedItems: unresolved, candidateAccounting: accounting, memoryCandidates, resourceEvidence, provenance };
      // The answer first, durable under the state it names; then the state. The other order left a crash between the two with a closed run and no answer.
      const kept = ledger.storeResult(stored) as Omit<IntelligenceResult, 'runLedger'>;
      const reached = closeTerminal(kept.state as RunState, kept.draft.status === 'SYSTEM_DRAFT');
      // The answer is handed over only once it is durable (D3-JRN-2).
      await ledger.barrier('AFTER_RESULT');
      const result = publish(kept, reached);
      telemetry({ runId: ledger.runId, kind: 'RUN_FINISHED', counters: { calls: resourceEvidence.providerInvocations, requests: counters.calls, billedInput: resourceEvidence.billedInputTokens, billedOutput: resourceEvidence.billedOutputTokens, tasks: tasks.length }, codes: [result.state] });
      return result;
    };

    // A redelivery of a finished run answers with the result the ledger
    // holds; nothing is recomputed and nothing is billed.
    const already = ledger.storedResult() as Omit<IntelligenceResult, 'runLedger'> | undefined;
    const opened = ledger.view();
    if (already !== undefined) {
      if (!TERMINAL_RUN_STATES.has(opened.state)) {
        // The owner died between its RESULT and the closing transition. The answer is on the record; the state is closed from it here, under this invocation's lease — inside the dead owner's lease the redelivery is WORKER_NOT_OWNER, as after any crash — and nothing is recomputed or bought.
        ledger.acquireLease(workerId, WORKER_LEASE_MS);
        ledger.note('closing transition recovered from the stored result', { events: opened.events });
        closeTerminal(already.state as RunState, already.draft.status === 'SYSTEM_DRAFT');
        await ledger.barrier('AFTER_RESULT');
      }
      return publish(already, ledger.view().state);
    }
    if (opened.cancelled) {
      // The host cancelled an attempt no owner finished (whether or not its own closing STATE landed): there is nothing to resume and nothing to buy; the answer is the cancellation, stored so the next redelivery reads it.
      ledger.acquireLease(workerId, WORKER_LEASE_MS);
      const cancelled = { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: ['RUN_CANCELLED'] };
      return finish(null, [], notDraftable(null, [cancelled], [], []), [cancelled], [], { calls: 0, planned: 0, leftOut: 0, decisions: 0 });
    }
    // Impossible by construction since the RESULT precedes the closing transition; kept for a log written under the earlier order.
    if (TERMINAL_RUN_STATES.has(opened.state)) throw new IntelligenceError('INVALID_TRANSITION', `run ${ledger.runId} is terminal (${opened.state}) without a stored result; the ledger holds what happened`);
    // One worker owns the attempt. The lease is taken here, before anything
    // is reserved or any in-flight reservation is judged: a second live
    // worker on the same attempt finds the first's lease in force and
    // leaves with WORKER_NOT_OWNER, having spent nothing; it takes over
    // only once that lease has lapsed by the run's clock (IC-01).
    ledger.acquireLease(workerId, WORKER_LEASE_MS);
    // A run found unfinished is resumed from its events (D3-JRN-1): a
    // reservation whose send never started is released, on the record and on
    // the grant; one whose send started and was never answered is kept
    // ambiguous at its maximum charge; one whose answer is stored but was
    // never billed is billed now, at the usage the answer reports, before
    // anything compiles it — and the ceilings are checked when the task finds
    // it. The work goes on from there.
    if (opened.events > 1) {
      const reopened = ledger.reopenInFlight('reservation open when the run was reopened');
      for (const { reservation, stored } of reopened.answered) await commitStored(ledger, reservation.reservationId, stored.response);
      await settleFromJournal(ledger);
      ledger.note('run resumed from the ledger', { events: opened.events, inFlight: reopened.released.length + reopened.ambiguous.length + reopened.answered.length, released: reopened.released.length, ambiguous: reopened.ambiguous.length, answered: reopened.answered.length });
    }

    // The audit is over: a run reopened after its absolute deadline does no more work and is never promoted (D3-TIME-1).
    if (ledger.absoluteDeadlinePassed()) {
      ledger.note('absolute deadline passed before the run finished', { events: opened.events });
      const expired = { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: ['DEADLINE_EXCEEDED'] };
      return finish('DEADLINE_EXCEEDED', [], notDraftable(null, [expired], [], []), [expired], [], { calls: 0, planned: 0, leftOut: 0, decisions: 0 });
    }
    if (versionProblems.length > 0) {
      ledger.note(`versions refused: ${versionProblems.join('; ')}`, { problems: versionProblems.length });
      return finish('FAILED_CONTRACT', [], notDraftable(null, [], [], []), [{ candidateRef: 'run', outcome: 'INCOMPATIBLE_CONTRACT_VERSION', codes: versionProblems }], [], { calls: 0, planned: 0, leftOut: 0, decisions: 0 });
    }
    if (hostProblems.length > 0) {
      ledger.note(`host time contract refused: ${hostProblems.join('; ')}`, { problems: hostProblems.length });
      return finish('FAILED_CONTRACT', [], notDraftable(null, [], [], []), [{ candidateRef: 'run', outcome: 'STALE_INPUT', codes: hostProblems }], [], { calls: 0, planned: 0, leftOut: 0, decisions: 0 });
    }
    let contracts: AdaptedContracts;
    try {
      contracts = adaptContracts({ mode: input.projectRevision.mode, profile: input.sourceProfile, candidateSet: input.candidateSet, targetContract: input.targetContract });
    } catch (error) {
      const code = isIntelligenceError(error) ? error.code : 'CONTRACT_VIOLATION';
      ledger.note(`contracts refused: ${error instanceof Error ? error.message : String(error)}`, { adapted: 0 });
      return finish('FAILED_CONTRACT', [], notDraftable(null, [], [], []), [{ candidateRef: 'run', outcome: code === 'INCOMPATIBLE_CONTRACT_VERSION' ? 'INCOMPATIBLE_CONTRACT_VERSION' : 'STALE_INPUT', codes: [code] }], [], { calls: 0, planned: 0, leftOut: 0, decisions: 0 });
    }
    const initial = resolve(contracts, resolveOptionsOf(input));
    // The expected candidate set, fixed before any request: the one planCandidates returns for this input, and the one the accounting answers for (D3-ACC-1). A column whose file's object is not decided yet is in it already, waiting (D3-CAP-01).
    const expected = expectedCandidates(contracts, initial);
    const expectedRefs = new Set(expected.candidates.map((candidate) => candidate.candidateRef));
    /** Partitioned by family order, record mapping, complexity and the size of the request each batch would send under the per-request bound; what the plan cannot carry is pending by name (D3-PART-1). */
    const planOf = (resolution: Resolution, questions: Resolution['openQuestions'], maxTasks: number): Plan => plan(input.projectRevision.projectRevisionHash, questions, { maxTasks, maxRequestBytes: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, estimateRequestBytes: requestSizeEstimator({ contracts, derivedCandidates: resolution.derivedCandidates, summaries: input.categoricalSummaries ?? new Map(), memory: input.scopedMemorySnapshot, projectRevisionId: input.projectRevision.projectRevisionId, supportEnvelopeVersion: input.projectRevision.supportEnvelopeVersion }) });
    let resolution = initial;
    let planned = planOf(initial, initial.openQuestions, BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT);
    ledger.note('resolved and planned', { decisions: resolution.decisions.length, questions: resolution.openQuestions.length, tasks: planned.tasks.length, leftOut: planned.leftOut.length });
    const tasks: TaskResult[] = [];
    const compiledTasks: CompiledTask[] = [];
    let calls = 0;
    // A resumed run re-enters the task loop from wherever it died; the states that already sit before the loop stay put.
    const before = ledger.view().state;
    if (planned.tasks.length > 0 && (before === 'CREATED' || before === 'RUNNING' || before === 'COMPILING')) ledger.transition('ENVELOPE_VALIDATED', before === 'CREATED' ? 'tasks planned' : 'resumed');
    /** Runs the tasks in order against the resolution they were planned from; true when the loop was cut short (exhaustion, cancellation, the grant). */
    const runTasks = async (list: readonly TaskRecord[], current: Resolution): Promise<boolean> => {
      const derivedByRef = new Map(current.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate]));
      // The output scopes the tasks run so far claimed with an accepted mapping: a requirement they satisfy is not unsatisfied for a later task (D3-CAP-10). The record mappings are those of the resolution the tasks were planned from, which changes once an object is decided.
      const recordMappingOf = new Map(current.decisions.filter((decision) => decision.kind === 'IDENTITY_PROOF').map((decision) => [decision.fieldRef, decision.recordId]));
      const claimsOf = (done: readonly CompiledTask[]): ReadonlySet<string> => new Set(done.flatMap((compiledTask) => compiledTask.items.filter((item) => item.outcome === 'PROPOSED' && item.proposalType === 'MAP_FIELD' && item.destinationField !== null && item.sourceFieldRef !== null).map((item) => outputScopeOf(recordMappingOf.get(item.sourceFieldRef ?? '') ?? null, item.destinationField ?? ''))));
      for (const task of list) {
        const view = ledger.view();
        if (view.cancelled) return true;
        if (ledger.deadlinePassed()) {
          tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'BUDGET_EXHAUSTED', attempts: 0, envelopeHash: null, proposalDigest: null, codes: ['DEADLINE_PASSED'] });
          continue;
        }
        const candidates = task.candidateRefs.map((ref) => derivedByRef.get(ref)).filter((candidate): candidate is DeterministicCandidate => candidate !== undefined);
        if (view.state === 'ENVELOPE_VALIDATED') ledger.transition('EGRESS_APPROVED', `task ${task.taskId}`);
        if (ledger.view().state === 'EGRESS_APPROVED') ledger.transition('RUNNING', `task ${task.taskId}`);
        let outcome;
        try {
          outcome = await runTask(ledger, task, contracts, candidates, input, context, current.decisions, { locale: locale.locale, priorClaims: claimsOf(compiledTasks) });
        } catch (error) {
          if (isIntelligenceError(error) && (error.code === 'RUN_CANCELLED' || error.code === 'DEADLINE_PASSED' || error.code === 'BUDGET_EXHAUSTED')) {
            // Exhaustion of any kind ends the loop; a budget exhaustion is recorded on the task, so a redelivery finds the outcome and does not buy the request again.
            if (error.code === 'BUDGET_EXHAUSTED') ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'BUDGET_EXHAUSTED', attempt: 0, codes: [error.code, error.message], envelopeHash: null, proposalDigest: null });
            tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'BUDGET_EXHAUSTED', attempts: 0, envelopeHash: null, proposalDigest: null, codes: [error.code] });
            return true;
          }
          if (isIntelligenceError(error) && error.code === 'EGRESS_BLOCKED') {
            tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'ABSTAINED', attempts: 1, envelopeHash: null, proposalDigest: null, codes: [error.code] });
            continue;
          }
          throw error;
        }
        calls += outcome.calls;
        tasks.push(outcome.result);
        if (outcome.compiled !== null) compiledTasks.push(outcome.compiled);
        // The grant refused or is owed more than it admitted: no further task asks it for anything (D3-GRANT-1).
        if (outcome.result.outcome === 'BUDGET_EXHAUSTED' && outcome.result.codes.some((code) => GRANT_CAUSES.has(code))) return true;
        // The provider kept refusing with its documented throttling class: no further task is sent (S11).
        if (outcome.result.codes.includes(RATE_LIMITED)) return true;
      }
      return false;
    };
    // Phase one: the object of every file whose headers tie (D3-CAP-01). The planner orders OBJECT_MAPPING first, so a plan with no object question runs as one phase.
    const objectTasks = planned.tasks.filter((task) => task.taskType === 'OBJECT_MAPPING');
    const stopped = await runTasks(objectTasks, initial);
    /** The accepted MAP_OBJECT of each file, from tasks the compiler did not refuse: the object the second resolution resolves the file's columns under. */
    const objectDecisions = new Map<string, CompiledItem>();
    for (const task of compiledTasks) {
      if (task.outcome === 'FORBIDDEN_PROPOSAL' || task.outcome === 'INVALID_SEMANTICS' || task.outcome === 'INVALID_SCHEMA' || task.outcome === 'STALE_INPUT') continue;
      for (const item of task.items) {
        if (item.proposalType !== 'MAP_OBJECT' || item.outcome !== 'PROPOSED' || item.object === null) continue;
        const fileId = contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '')?.fileId;
        if (fileId !== undefined && !objectDecisions.has(fileId)) objectDecisions.set(fileId, item);
      }
    }
    if (!stopped) {
      if (objectDecisions.size > 0) {
        // Phase two: the files' columns resolved again under the decided objects, and every question after the objects planned again within what the task cap has left — only questions about candidates the expected set named before any request, so the accounting stays exact.
        resolution = resolve(contracts, { ...resolveOptionsOf(input), decidedObjects: Object.fromEntries([...objectDecisions].map(([fileId, item]) => [fileId, item.object as string])) });
        const rest = planOf(resolution, resolution.openQuestions.filter((question) => question.taskType !== 'OBJECT_MAPPING' && question.candidateRefs.every((ref) => expectedRefs.has(ref))), Math.max(0, BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT - objectTasks.length));
        const objectPending = planned.pending.filter((entry) => entry.question.taskType === 'OBJECT_MAPPING');
        planned = { tasks: [...objectTasks, ...rest.tasks], pending: [...objectPending, ...rest.pending], leftOut: [...objectPending, ...rest.pending].map((entry) => entry.question), partitions: objectTasks.length + rest.partitions };
        ledger.note('objects decided; the files resolved and planned again', { objects: objectDecisions.size, decisions: resolution.decisions.length, questions: resolution.openQuestions.length, tasks: rest.tasks.length, leftOut: rest.pending.length });
      }
      await runTasks(planned.tasks.filter((task) => task.taskType !== 'OBJECT_MAPPING'), resolution);
    }
    // A stop by the money or by a limit (D3-GRANT-1, D3-PART-1, S095): the planned tasks the loop never started end BUDGET_EXHAUSTED too, before any request, with the cause of the stop, on the result and on the record — what the admission cannot hold is pending by name, never by omission. A cancellation and a passed deadline have their own outcomes.
    // A rate-limited stop (S11): the planned tasks the loop never started end PROVIDER_RETRYABLE_FAILURE RATE_LIMITED, before any request, by name.
    if (tasks.some((task) => task.codes.includes(RATE_LIMITED)) && !ledger.view().cancelled) {
      for (const task of planned.tasks) {
        if (tasks.some((result) => result.taskId === task.taskId)) continue;
        ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'PROVIDER_RETRYABLE_FAILURE', attempt: 0, codes: [RATE_LIMITED], envelopeHash: null, proposalDigest: null });
        tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'PROVIDER_RETRYABLE_FAILURE', attempts: 0, envelopeHash: null, proposalDigest: null, codes: [RATE_LIMITED] });
      }
    }
    const stoppedBy = [...tasks].reverse().find((task) => task.outcome === 'BUDGET_EXHAUSTED');
    if (stoppedBy !== undefined && !ledger.view().cancelled && !stoppedBy.codes.some((code) => code.includes('DEADLINE') || code === 'RUN_CANCELLED')) {
      for (const task of planned.tasks) {
        if (tasks.some((result) => result.taskId === task.taskId)) continue;
        ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'BUDGET_EXHAUSTED', attempt: 0, codes: [...stoppedBy.codes], envelopeHash: null, proposalDigest: null });
        tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'BUDGET_EXHAUSTED', attempts: 0, envelopeHash: null, proposalDigest: null, codes: [...stoppedBy.codes] });
      }
    }
    // The last phase (D3-CAP-11, D3-PART-1): once every other family is compiled, the consistency detector reads every decision that stands, and each contradiction is one CONSISTENCY_REVIEW task inside what the plan left of the task cap. A run that already ends on its budget, its provider or its compiler, or was cancelled, buys no review.
    const reviewCandidates = new Map<string, DeterministicCandidate>();
    const reviewClaims: ReviewClaimView[] = [];
    const ended = tasks.some((task) => task.outcome === 'BUDGET_EXHAUSTED' || task.outcome === 'PROVIDER_RETRYABLE_FAILURE' || task.outcome === 'PROVIDER_TERMINAL_FAILURE' || task.outcome === 'FORBIDDEN_PROPOSAL' || task.outcome === 'INVALID_SEMANTICS' || task.outcome === 'INVALID_SCHEMA' || task.outcome === 'STALE_INPUT');
    const contradictions = ledger.view().cancelled || ended ? [] : detectContradictions({ contracts, decisions: resolution.decisions, compiled: compiledTasks });
    if (contradictions.length > 0) {
      for (const contradiction of contradictions) {
        reviewCandidates.set(contradiction.candidate.candidateRef, contradiction.candidate);
        reviewClaims.push(...contradiction.claims);
      }
      const firstReview = planned.tasks.length;
      const pendingBefore = planned.pending.length;
      planned = planReview(input.projectRevision.projectRevisionHash, contradictions.map((contradiction) => contradiction.question), planned, { maxRequestBytes: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, estimateRequestBytes: requestSizeEstimator({ contracts, derivedCandidates: resolution.derivedCandidates, summaries: input.categoricalSummaries ?? new Map(), memory: input.scopedMemorySnapshot, projectRevisionId: input.projectRevision.projectRevisionId, supportEnvelopeVersion: input.projectRevision.supportEnvelopeVersion, review: { candidates: [...reviewCandidates.values()], claims: reviewClaims } }) });
      ledger.note('consistency review planned', { contradictions: contradictions.length, tasks: planned.tasks.length - firstReview, pending: planned.pending.length - pendingBefore });
      for (const task of planned.tasks.slice(firstReview)) {
        const current = ledger.view();
        if (current.cancelled) break;
        if (ledger.deadlinePassed()) {
          tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'BUDGET_EXHAUSTED', attempts: 0, envelopeHash: null, proposalDigest: null, codes: ['DEADLINE_PASSED'] });
          continue;
        }
        const candidates = task.candidateRefs.map((ref) => reviewCandidates.get(ref)).filter((candidate): candidate is DeterministicCandidate => candidate !== undefined);
        if (current.state === 'ENVELOPE_VALIDATED') ledger.transition('EGRESS_APPROVED', `task ${task.taskId}`);
        if (ledger.view().state === 'EGRESS_APPROVED') ledger.transition('RUNNING', `task ${task.taskId}`);
        let outcome;
        try {
          outcome = await runTask(ledger, task, contracts, candidates, input, context, resolution.decisions, { locale: locale.locale, priorClaims: new Set() }, reviewClaims.filter((claim) => task.candidateRefs.includes(claim.candidateRef)));
        } catch (error) {
          if (isIntelligenceError(error) && (error.code === 'RUN_CANCELLED' || error.code === 'DEADLINE_PASSED' || error.code === 'BUDGET_EXHAUSTED')) {
            if (error.code === 'BUDGET_EXHAUSTED') ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'BUDGET_EXHAUSTED', attempt: 0, codes: [error.code, error.message], envelopeHash: null, proposalDigest: null });
            tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'BUDGET_EXHAUSTED', attempts: 0, envelopeHash: null, proposalDigest: null, codes: [error.code] });
            break;
          }
          if (isIntelligenceError(error) && error.code === 'EGRESS_BLOCKED') {
            tasks.push({ taskId: task.taskId, taskType: task.taskType, outcome: 'ABSTAINED', attempts: 1, envelopeHash: null, proposalDigest: null, codes: [error.code] });
            continue;
          }
          throw error;
        }
        calls += outcome.calls;
        tasks.push(outcome.result);
        if (outcome.compiled !== null) compiledTasks.push(outcome.compiled);
        if (outcome.result.outcome === 'BUDGET_EXHAUSTED' && outcome.result.codes.some((code) => GRANT_CAUSES.has(code))) break;
      }
    }
    // What the review settled: the claims its accepted preserves drop, each by its decision ref. Nothing of a task the compiler refused is accepted.
    const dropped = new Map<string, CompiledItem>();
    for (const compiledTask of compiledTasks) {
      if (compiledTask.outcome === 'FORBIDDEN_PROPOSAL' || compiledTask.outcome === 'INVALID_SEMANTICS' || compiledTask.outcome === 'STALE_INPUT' || compiledTask.outcome === 'INCOMPATIBLE_CONTRACT_VERSION') continue;
      for (const item of compiledTask.items) if (reviewCandidates.has(item.candidateRef) && item.outcome === 'PROPOSED' && item.proposalType === 'UNMAPPED_PRESERVE' && item.targetRef !== null) dropped.set(item.targetRef, item);
    }
    const review: ReviewOutcome = { candidateRefs: new Set(reviewCandidates.keys()), dropped };
    const assembled = assemble(contracts, resolution, compiledTasks, input, objectDecisions, review);
    const view = ledger.view();
    // Every expected candidate, exactly one disposition: what the run did with it, or why it did nothing (D3-ACC-1). A question the plan could not carry is no task: its candidates are PENDING_CAP by ref, with the reason (D3-PART-1). An original on a column, and a column that waited for its object, follow what became of the column.
    const accounted = accountCandidates({ expected, plan: planned, tasks, compiled: compiledTasks, refusedByAssembly: new Set(assembled.decisionsRequired.filter((entry) => entry.reason.startsWith('DUPLICATE_TARGET:') || entry.reason.startsWith('NO_FIELD_FOR_DECISION:')).map((entry) => entry.candidateRef)), preservedByReview: new Set(dropped.keys()), cancelled: view.cancelled, follows: candidateFollows(contracts, resolution, expected, initial), unassembled: assembled.unassembled });
    accounting = accounted;
    if (view.cancelled) {
      // The host's cancellation ended the task loop: the run is CANCELLED on the record, and finish() names the cause on the result whether or not a task was cut short by it.
      const items = tasks.map((task) => ({ candidateRef: task.taskId, outcome: task.outcome, codes: task.codes }));
      return finish(null, tasks, notDraftable(null, items, [], []), items, [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    const exhausted = tasks.some((task) => task.outcome === 'BUDGET_EXHAUSTED');
    const providerFailed = tasks.some((task) => task.outcome === 'PROVIDER_RETRYABLE_FAILURE' || task.outcome === 'PROVIDER_TERMINAL_FAILURE');
    const compilerFailed = tasks.some((task) => task.outcome === 'FORBIDDEN_PROPOSAL' || task.outcome === 'INVALID_SEMANTICS' || task.outcome === 'INVALID_SCHEMA' || task.outcome === 'STALE_INPUT');
    const unresolved = [...assembled.items.filter((item) => item.outcome !== 'PROPOSED').map((item) => ({ candidateRef: item.candidateRef, outcome: item.outcome, codes: item.codes })), ...assembled.contradictions.map((text) => ({ candidateRef: 'assembly', outcome: 'REQUIRES_AGENCY_DECISION' as const, codes: [text] }))];
    void unresolved;
    // A memory candidate is a mapping convention of a header and a target; a modifier changes a field, an association names an association ref and a review's answer a decision, no target of the contract; a claim a review dropped is no mapping.
    const memoryCandidates = assembled.items.filter((item) => item.outcome === 'PROPOSED' && !FIELD_MODIFIERS.has(item.proposalType) && item.proposalType !== 'MAP_ASSOCIATION' && item.targetRef !== null && item.sourceFieldRef !== null && !review.candidateRefs.has(item.candidateRef) && !dropped.has(item.candidateRef)).map((item) => memoryCandidateFrom({ runId: ledger.runId, taskId: item.candidateRef, tenant: context.tenant, header: contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '')?.header ?? '', targetRef: item.targetRef, semanticType: item.semanticType, scope: 'CLIENT' }));
    if (view.state === 'RUNNING' || view.state === 'ENVELOPE_VALIDATED' || view.state === 'EGRESS_APPROVED') {
      if (view.state !== 'RUNNING') {
        if (view.state === 'ENVELOPE_VALIDATED') ledger.transition('EGRESS_APPROVED', 'assembly');
        ledger.transition('RUNNING', 'assembly');
      }
      ledger.transition('COMPILING', 'assembly');
    }
    // A grant that refused or is owed more than it admitted ends the run on the budget, its cause named on a run item as a cancellation's is (D3-GRANT-1).
    const grantCause = [...GRANT_CAUSES].find((cause) => tasks.some((task) => task.outcome === 'BUDGET_EXHAUSTED' && task.codes.includes(cause)));
    if (exhausted && grantCause !== undefined) {
      const refused = [...unresolved, { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: [grantCause] }];
      return finish('BUDGET_EXHAUSTED', tasks, notDraftable(null, refused, assembled.decisionsRequired, assembled.preserved), refused, [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    // Exhaustion found after assembly is still exhaustion: the terminal state names the budget, from COMPILING as from RUNNING (IC-02, IC-12).
    if (exhausted) return finish('BUDGET_EXHAUSTED', tasks, notDraftable(null, unresolved, assembled.decisionsRequired, assembled.preserved), unresolved, [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    // The terminal state names the cause, not the phase the flow was in when the outcomes were read: a task the provider failed ends FAILED_PROVIDER (from COMPILING as from RUNNING; a run resumed past validation has no exit to it and keeps the compiler's).
    if (providerFailed) return finish(ledger.view().state === 'FULL_VALIDATING' ? 'FAILED_COMPILER' : 'FAILED_PROVIDER', tasks, notDraftable(null, unresolved, assembled.decisionsRequired, assembled.preserved), unresolved, [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    if (compilerFailed) return finish(ledger.view().state === 'COMPILING' ? 'FAILED_COMPILER' : 'FAILED_CONTRACT', tasks, notDraftable(null, unresolved, assembled.decisionsRequired, assembled.preserved), unresolved, [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    // The finalizer's accounting check (D3-ACC-1): a disposition list that misses, repeats or invents a candidate is no ground for a draft, and nothing is validated over it.
    const accountingProblems = candidateAccountingProblems(expected, accounted.dispositions);
    if (accountingProblems.length > 0) {
      if (ledger.view().state === 'CREATED') {
        ledger.transition('ENVELOPE_VALIDATED', 'no task needed');
        ledger.transition('EGRESS_APPROVED', 'no task needed');
        ledger.transition('RUNNING', 'no task needed');
        ledger.transition('COMPILING', 'accounting');
      }
      const incomplete = { candidateRef: 'accounting', outcome: 'INVALID_SEMANTICS' as const, codes: ['CANDIDATE_ACCOUNTING_INCOMPLETE', ...accountingProblems.slice(0, 32)] };
      return finish('FAILED_COMPILER', tasks, notDraftable(null, [...unresolved, incomplete], assembled.decisionsRequired, assembled.preserved), [...unresolved, incomplete], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    if (assembled.configuration.fields.length === 0) {
      // Nothing to validate: every field is preserved or waits for the agency. Material abstention, not a draft.
      return finish('ABSTAINED_MATERIAL', tasks, notDraftable(null, unresolved, assembled.decisionsRequired, assembled.preserved), unresolved, memoryCandidates, { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    if (ledger.view().state === 'CREATED') {
      // Everything was decided deterministically: no envelope, no call, straight to validation.
      ledger.transition('ENVELOPE_VALIDATED', 'no task needed');
      ledger.transition('EGRESS_APPROVED', 'no task needed');
      ledger.transition('RUNNING', 'no task needed');
      ledger.transition('COMPILING', 'deterministic only');
    }
    // Sealed for the host (D3-CFG-2): the document Migration Core will load is made here with the same product translation the host uses, its own loader reads it, and every fragment is stamped with the hash of what the loader made of it. A fragment the frozen schema cannot express is refused by name, and nothing is validated that is not the whole configuration.
    const sealing = sealConfiguration(assembled.configuration, input.sourceProfile);
    if (!sealing.ok) {
      const refused = { candidateRef: 'configuration', outcome: 'INVALID_SEMANTICS' as const, codes: ['CONFIGURATION_NOT_EXPRESSIBLE', ...sealing.problems.slice(0, 32)] };
      return finish('FAILED_COMPILER', tasks, notDraftable(null, [...unresolved, refused], assembled.decisionsRequired, assembled.preserved), [...unresolved, refused], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    const sealed = sealing.sealed;
    if (ledger.view().state !== 'FULL_VALIDATING') ledger.transition('FULL_VALIDATING', sealed.configuration.configurationRef);
    // What was compiled is durable before the host validates it (D3-JRN-2).
    await ledger.barrier('BEFORE_VALIDATION');
    // Every field the configuration carries is accounted for: the deterministic decisions that put fields in, each under its rule, then the proposals the compiler accepted (IC-09), each naming the fragment it resulted in (when the receipt observed one).
    const draftEvidenceOf = (hashOf: (decisionRef: string) => string | null): readonly DraftEvidence[] => [
      ...assembled.deterministic.map((decision) => deterministicEvidence(decision, contracts.refs.targetByRef.get(decision.targetRef ?? '')?.destinationField ?? decision.destinationField ?? '', hashOf(decision.decisionRef))),
      ...assembled.items.filter((item) => item.outcome === 'PROPOSED' && (item.destinationField !== null || IDENTITY_FAMILY_PROPOSALS.has(item.proposalType))).map((item): DraftEvidence => ({ origin: 'PROPOSED', candidateRef: item.candidateRef, evidenceClass: item.evidenceClass, rationaleCode: item.rationaleCode, evidenceRefs: item.evidenceRefs, sourceFieldRef: item.sourceFieldRef, targetRef: item.targetRef, destinationField: item.destinationField, semanticType: item.semanticType, transformPrimitive: item.transformPrimitive, typedTransformParams: item.typedTransformParams, fragmentHash: hashOf(item.candidateRef) })),
    ];
    // The requirements the draft itself reports as BLOCKING: the only refusal of Migration Core that is deferred is the one that names one of these (CAP10, D4-MC3-2).
    const blockedDestinations = assembled.requirements.filter((entry) => entry.status === 'BLOCKING').map((entry) => entry.destinationField);
    // Assigned by the port's answer; unassigned only on a deferral by a thrown refusal, which returns before the receipt is read.
    let validation!: FullDatasetValidationResult;
    let deferred: readonly string[] | null = null;
    try {
      // The host's validation of the whole dataset can outlast the lease as a provider call can; the lease is kept while it runs.
      validation = await keepingLease(ledger, () => deps.validationPort.validate(sealed.configuration));
    } catch (error) {
      // Migration Core 3.0.0 refuses a creating record mapping that maps nothing to a field the contract requires: a plan to change, not rows to isolate. When that is exactly the blocking requirement the draft reports, the draft waits for the agency's decision; any other failure is a failed validation.
      const named = blockedRefusalOf([error instanceof Error ? error.message : String(error)], blockedDestinations);
      if (named === null) {
        ledger.note('validation port failed', {});
        const failed = { candidateRef: 'validation', outcome: 'STALE_INPUT' as const, codes: ['VALIDATION_PORT_UNAVAILABLE', error instanceof Error ? error.message : String(error)] };
        return finish('FAILED_COMPILER', tasks, notDraftable(null, [...unresolved, failed], assembled.decisionsRequired, assembled.preserved), [...unresolved, failed], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
      }
      ledger.note('validation deferred: Migration Core refused a plan that maps nothing to a blocking requirement', { blocked: named.length });
      deferred = named;
    }
    // The await is a boundary: what the run knew before it is not what it knows after. A cancellation that landed while the host validated ends the run cancelled, and an absolute deadline that passed ends it DEADLINE_EXCEEDED — a receipt, however sound, does not make a draft of a run that is no longer open. The semantic window is not checked here: it gates dispatch, and a validation that returns after it and inside the absolute window promotes (D3-TIME-1).
    const afterValidation = ledger.view();
    if (afterValidation.cancelled) {
      const cancelled = { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: ['RUN_CANCELLED'] };
      return finish(null, tasks, notDraftable(null, [...unresolved, cancelled], assembled.decisionsRequired, assembled.preserved), [...unresolved, cancelled], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    if (ledger.absoluteDeadlinePassed()) {
      ledger.note('absolute deadline passed during validation', { validations: 1 });
      const late = { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: ['DEADLINE_EXCEEDED'] };
      return finish('DEADLINE_EXCEEDED', tasks, notDraftable(null, [...unresolved, late], assembled.decisionsRequired, assembled.preserved), [...unresolved, late], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    // A port may refuse by returning instead of throwing: ok false, no effects, and every problem the required-on-create refusal of a blocking requirement. Anything else it returns is judged below.
    if (deferred === null && validation !== null && typeof validation === 'object' && validation.ok === false && (validation.effects === null || validation.effects === undefined) && Array.isArray(validation.problems)) deferred = blockedRefusalOf(validation.problems, blockedDestinations);
    if (deferred !== null) {
      // The refusal validated nothing and is not carried as a receipt: the draft waits for the agency, with no fragment claimed observed, and final delivery refuses it (delivery-gate.ts).
      const waiting: DraftMigrationPlan = {
        planVersion: '1.0.0',
        status: 'SYSTEM_DRAFT',
        configuration: sealed.configuration,
        impact: { fieldsMapped: sealed.configuration.fields.length, rowsCovered: 0, fieldsPreserved: assembled.preserved.length },
        evidence: draftEvidenceOf(() => null),
        unresolved,
        unsupportedPreserved: assembled.preserved,
        decisionsRequired: assembled.decisionsRequired,
        fullValidation: null,
        validation: { status: 'DEFERRED_FOR_AGENCY_DECISION', blockedDestinations: deferred, refusal: 'MAPPING_INVALID' },
        coverage: accounted.coverage,
        fragmentCoverage: null,
        requirements: assembled.requirements,
        identity: null,
        reviewGroups: assembled.reviewGroups.map((group) => ({ ...group, observed: false })),
        associations: [],
        note: 'A SYSTEM_DRAFT is not an approval, a quote or an authorisation to execute.',
      };
      return finish('PROPOSAL_READY', tasks, waiting, unresolved, memoryCandidates, { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    const rowsInProfile = contracts.profileView.dataRowCount;
    const soundness = validationIsSound(validation, sealed.configuration, sealed.coreConfigHash, contracts, rowsInProfile, input.sourceProfile.profile.totals.rejectedRowCount, ledger.createdAt(), deps.clock.nowMs());
    if (soundness.length > 0) {
      // The receipt may be anything at this point — null, an array, a record missing its members — so nothing is read off it before its shape is known, and a malformed one is not carried into the result.
      const shaped = soundness[0] !== 'VALIDATION_RECEIPT_MALFORMED';
      const reported = shaped && Array.isArray(validation.problems) ? validation.problems.slice(0, 8).map((problem) => String(problem)) : [];
      const failed = { candidateRef: 'validation', outcome: 'STALE_INPUT' as const, codes: [...soundness, ...reported] };
      return finish('FAILED_COMPILER', tasks, notDraftable(shaped ? validation : null, [...unresolved, failed], assembled.decisionsRequired, assembled.preserved), [...unresolved, failed], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    // The finalizer's coverage check (D3-CFG-3): candidate → decision → fragment → effect, met on the fragment hash. A fragment the receipt does not report consumed is not in the run Migration Core made, and a draft is never made over it.
    const fragmentCoverage = fragmentCoverageOf(sealed, assembled.fragmentDecisions, validation.effects);
    const gaps = fragmentCoverage.entries.filter((entry) => !entry.observed);
    if (gaps.length > 0) {
      const gap = { candidateRef: 'coverage', outcome: 'INVALID_SEMANTICS' as const, codes: ['EFFECT_NOT_OBSERVED', ...gaps.slice(0, 32).map((entry) => `${entry.fragmentKind}:${entry.decisionRef}`)] };
      return finish('FAILED_COMPILER', tasks, { ...notDraftable(validation, [...unresolved, gap], assembled.decisionsRequired, assembled.preserved), fragmentCoverage }, [...unresolved, gap], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    /** The hash of the fragment a decision put into the configuration, if it put one in. */
    // An accepted identity strategy shaped its record mapping's record fragment, which names it among the candidates it answers (D3-CAP-06).
    const fragmentHashOf = (decisionRef: string): string | null => (fragmentCoverage.entries.find((entry) => entry.decisionRef === decisionRef && entry.fragmentKind !== 'RECORD') ?? fragmentCoverage.entries.find((entry) => entry.fragmentKind === 'FIELD' && entry.candidateRefs.includes(decisionRef)) ?? fragmentCoverage.entries.find((entry) => entry.fragmentKind === 'RECORD' && entry.candidateRefs.includes(decisionRef)))?.fragmentHash ?? null;
    const effects = validation.effects;
    // The last look at the money before promotion: a charge above its reservation or a total past the audit ceiling — found at any point, late reconciliation evidence included — ends the run on the budget, never in a draft (IC-12).
    const owed = ledger.view().grant.liabilityMicros;
    const overTotal = ledger.overCeiling();
    if (owed > 0 || overTotal !== null) {
      ledger.note('promotion refused: the grant is owed more than it admitted, or the audit total is exceeded', { liabilityMicros: owed, overTotal: overTotal === null ? 0 : 1 });
      const refused = { candidateRef: 'run', outcome: 'BUDGET_EXHAUSTED' as const, codes: [owed > 0 ? 'GRANT_LIABILITY' : 'AUDIT_CEILING_EXCEEDED'] };
      return finish('BUDGET_EXHAUSTED', tasks, notDraftable(validation, [...unresolved, refused], assembled.decisionsRequired, assembled.preserved), [...unresolved, refused], [], { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
    }
    const draft: DraftMigrationPlan = {
      planVersion: '1.0.0',
      status: 'SYSTEM_DRAFT',
      configuration: sealed.configuration,
      impact: { fieldsMapped: sealed.configuration.fields.length, rowsCovered: validation.rowsValidated, fieldsPreserved: assembled.preserved.length },
      evidence: draftEvidenceOf(fragmentHashOf),
      unresolved,
      unsupportedPreserved: assembled.preserved,
      decisionsRequired: assembled.decisionsRequired,
      fullValidation: validation,
      validation: { status: 'VALIDATED', blockedDestinations: [], refusal: null },
      coverage: accounted.coverage,
      fragmentCoverage,
      requirements: assembled.requirements,
      identity: identityReportOf(sealed.configuration, assembled.fragmentDecisions, effects),
      // A review group is met on the receipt by its rows: the cluster Migration Core reports over exactly those rows, or it is drafted unobserved (D3-CAP-07).
      reviewGroups: assembled.reviewGroups.map((group) => ({ ...group, observed: group.rowsDigest !== null && effects !== null && effects.duplicateClusters.some((cluster) => cluster.rowsDigest === group.rowsDigest) })),
      associations: associationReportsOf(sealed.configuration, effects),
      note: 'A SYSTEM_DRAFT is not an approval, a quote or an authorisation to execute.',
    };
    return finish('PROPOSAL_READY', tasks, draft, unresolved, memoryCandidates, { calls, planned: planned.tasks.length, leftOut: planned.leftOut.length, decisions: resolution.decisions.length });
  }

  return {
    async run(input: IntelligenceInput, context: HostContext): Promise<IntelligenceResult> {
      try {
        return await runAttempt(input, context);
      } catch (error) {
        // Fenced out: the attempt was taken over while this invocation waited, and what it brought back was discarded, not committed. Payload-free on the telemetry; the ledger holds the takeover's account, and a redelivery answers from it.
        if (isIntelligenceError(error) && error.code === 'LEDGER_FENCED') telemetry({ runId: String(error.details['runId'] ?? ''), kind: 'WRITE_FENCED', counters: { discarded: 1 }, codes: [error.code, String(error.details['kind'] ?? '')] });
        throw error;
      }
    },
    cancel(runId: string, reason: string): void {
      RunLedger.open(deps.ledgerStore, deps.clock, runId).cancel(reason);
    },
    readRun(runId: string): readonly PublicLedgerEvent[] {
      return RunLedger.open(deps.ledgerStore, deps.clock, runId).publicExport();
    },
  };
}

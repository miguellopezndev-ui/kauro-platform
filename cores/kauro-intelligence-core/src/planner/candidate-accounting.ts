/**
 * Candidate accounting, D3-ACC-1 and D3-ACC-2 (review finding B03-R10), and
 * the request-size estimate the planner partitions under (D3-PART-1).
 *
 * The expected candidate set is fixed before any request: every original
 * Migration Core handed over, and every candidate the resolver derived from
 * the profile, hashed. `planCandidates` returns it with no request and no
 * spend, so a host can record at PROFILE what a run of the attempt must
 * account for. At the end of the run every expected candidate has exactly
 * one disposition — what the run did with it, or why it did nothing — and the
 * coverage says whether anything is still pending or unresolved. An original
 * is routed by its type to the family that answers it; a family whose
 * mandate has not landed yields an explicit UNRESOLVED FAMILY_NOT_PLANNED,
 * never an omission. `candidateAccountingProblems` is the finalizer's check:
 * a list that misses, repeats or invents a candidate is refused, and the run
 * fails FAILED_COMPILER CANDIDATE_ACCOUNTING_INCOMPLETE instead of drafting.
 *
 * Nothing here reads a row or a value: refs, types, families and closed codes.
 */
import { adaptContracts } from '../adapter/contract-adapter.js';
import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { digestOf } from '../contracts/canonical.js';
import { ASSOCIATION_CANDIDATE_TYPE, OBJECT_NAMES, PROPOSAL_TYPES, TRANSFORM_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE } from '../contracts/envelope.js';
import type { DeterministicCandidate, ReviewClaimView, TaskType } from '../contracts/envelope.js';
import { PRIMITIVE_REFS } from '../contracts/proposal.js';
import type { MemoryEntry, TaskRecord, TaskResult } from '../contracts/run.js';
import { ENVELOPE_SCHEMA_VERSION } from '../contracts/versions.js';
import type { CompiledTask } from '../compiler/compiler.js';
import { DATA_POLICY_VERSION, MASKING_POLICY_VERSION, MAX_EXEMPLARS_PER_FIELD } from '../envelope/envelope-builder.js';
import type { CategoricalSummaries } from '../envelope/envelope-builder.js';
import { PROMPT_BUNDLE_V1 } from '../gateway/model-gateway.js';
import type { IntelligenceInput } from '../ports/ports.js';
import { DERIVED_CANDIDATE_TYPES, resolve } from '../resolver/deterministic-resolver.js';
import type { OpenQuestion, Resolution, ResolveOptions } from '../resolver/deterministic-resolver.js';
import type { Plan } from './task-planner.js';

// -------------------------------------------------------------------------------------------------------- the expected set

export type CandidateOrigin = 'MIGRATION_CORE' | 'RESOLVER';

export interface ExpectedSetCandidate {
  readonly candidateRef: string;
  /** MIGRATION_CORE: an original of the candidate set; RESOLVER: a decision candidate the resolver derived for an open question. */
  readonly origin: CandidateOrigin;
  readonly candidateType: string;
  /** The family that answers it (D3-ACC-2): an original's by its type, a derived candidate's by its question. Null for an original type no route knows. */
  readonly family: TaskType | null;
  /**
   * How an original its family's route answers is answered (D3-ACC-2):
   * `by` the derived candidate whose disposition it takes — the
   * TRANSFORMATION_SELECTION candidate of its column, or, while the column
   * is still open, the candidate that decides whether it is mapped at all —
   * or a disposition it has on facts alone. The identity families answer
   * theirs the same way (B03-CAP-IDENTITY): a key candidate by the identity
   * question about its column or a declared record id, a duplicate cluster by
   * the duplicate question about its files. Absent while its family has no
   * answer for it: then it is UNRESOLVED FAMILY_NOT_PLANNED.
   */
  readonly answer?: { readonly by: string } | { readonly disposition: 'DETERMINISTIC' | 'PRESERVED'; readonly code: string };
}

/** The candidate types that decide whether a column is mapped at all: while a column is open, a question about how to read it is answered by one of them. */
const COLUMN_DECIDING_TYPES: ReadonlySet<string> = new Set(['DERIVED_FIELD_DECISION', 'DERIVED_OBJECT_DECISION']);

/**
 * The answer to an original routed to TRANSFORMATION_SELECTION (D3-CAP-04):
 * padding needs no decision, since Migration Core trims every mapped value
 * by default and keeps an unmapped one as it is; otherwise the
 * transformation candidate of its column when its mapped destination needs
 * a parameter; nothing to decide when the column is mapped and its
 * destination needs none; the field-level candidate while the column is
 * open, since a mapping proposal carries its own primitive; preserved
 * otherwise.
 */
function transformationAnswer(original: DeterministicCandidate, resolution: Resolution): NonNullable<ExpectedSetCandidate['answer']> {
  if (original.allowedPrimitiveRefs.includes('TRIM')) return { disposition: 'DETERMINISTIC', code: 'TRIMMED_BY_DEFAULT' };
  const column = original.sourceRefs[0] ?? '';
  const standIn = resolution.derivedCandidates.find((candidate) => candidate.candidateType === TRANSFORM_CANDIDATE_TYPE && candidate.sourceRefs.includes(column));
  if (standIn !== undefined) return { by: standIn.candidateRef };
  if (resolution.decisions.some((decision) => decision.kind === 'FIELD_MAPPING' && decision.fieldRef === column)) return { disposition: 'DETERMINISTIC', code: 'NO_PARAMETER_NEEDED' };
  const deciding = resolution.derivedCandidates.find((candidate) => COLUMN_DECIDING_TYPES.has(candidate.candidateType) && candidate.sourceRefs.includes(column));
  return deciding === undefined ? { disposition: 'PRESERVED', code: 'COLUMN_NOT_MAPPED' } : { by: deciding.candidateRef };
}

export interface ExpectedCandidateSet {
  /** Migration Core's candidate set hash, as handed over. */
  readonly candidateSetHash: string;
  /** The digest of this expected set: what a host records at PROFILE and a run's accounting names. */
  readonly expectedSetHash: string;
  /** Migration Core's set hit its cap: what it did not hand over is pending as CANDIDATE_SET_TRUNCATED. */
  readonly truncated: boolean;
  /** How many candidates Migration Core produced before its cap. */
  readonly produced: number;
  readonly candidates: readonly ExpectedSetCandidate[];
}

/**
 * The route of each original type (D3-ACC-2): the family whose task answers
 * it. Every type of Migration Core's closed candidate vocabulary is here; an
 * ambiguous shape asks for a semantic type when its only reading is an
 * identifier, and for a transformation parameter otherwise.
 */
export const ORIGINAL_ROUTES: Readonly<Record<string, (candidate: DeterministicCandidate) => TaskType>> = Object.freeze({
  KEY_CANDIDATE: (): TaskType => 'IDENTITY_STRATEGY',
  AMBIGUOUS_SHAPE_COLUMN: (candidate: DeterministicCandidate): TaskType => (candidate.allowedPrimitiveRefs.includes('IDENTIFIER_SEMANTIC_TYPE') ? 'SEMANTIC_TYPE' : 'TRANSFORMATION_SELECTION'),
  DUPLICATE_CLUSTER: (): TaskType => 'DUPLICATE_SIGNAL_STRATEGY',
  UNMAPPED_MATERIAL: (): TaskType => 'UNMAPPED_HANDLING',
});

/** The family an original is routed to, or null for a type no route knows. */
export function routeOf(candidate: DeterministicCandidate): TaskType | null {
  if (!Object.hasOwn(ORIGINAL_ROUTES, candidate.candidateType)) return null;
  const route = ORIGINAL_ROUTES[candidate.candidateType];
  return route === undefined ? null : route(candidate);
}

/** An original's type as the accounting names it: one of the closed vocabulary the routes know, never a string the set carried beyond it. */
const UNROUTED_TYPE = 'UNROUTED_CANDIDATE_TYPE';

/** The expected set of a run: the originals as Migration Core listed them, then the resolver's derived candidates, each with its family. */
export function expectedCandidates(contracts: AdaptedContracts, resolution: Resolution): ExpectedCandidateSet {
  const familyOfDerived = new Map<string, TaskType>();
  for (const question of resolution.openQuestions) for (const ref of question.candidateRefs) if (!familyOfDerived.has(ref)) familyOfDerived.set(ref, question.taskType);
  const candidates: ExpectedSetCandidate[] = [
    ...contracts.candidates.map((candidate): ExpectedSetCandidate => {
      const family = routeOf(candidate);
      // The originals a family answers on its own (D3-CAP-04) or through the identity families (D3-ACC-2, B03-CAP-IDENTITY).
      const answer = family === 'TRANSFORMATION_SELECTION' ? transformationAnswer(candidate, resolution) : family === 'IDENTITY_STRATEGY' || family === 'DUPLICATE_SIGNAL_STRATEGY' ? resolution.originalAnswers?.get(candidate.candidateRef) : undefined;
      const listed: ExpectedSetCandidate = { candidateRef: candidate.candidateRef, origin: 'MIGRATION_CORE', candidateType: family === null ? UNROUTED_TYPE : candidate.candidateType, family };
      return answer === undefined ? listed : { ...listed, answer };
    }),
    ...resolution.derivedCandidates.map((candidate): ExpectedSetCandidate => ({ candidateRef: candidate.candidateRef, origin: 'RESOLVER', candidateType: candidate.candidateType, family: familyOfDerived.get(candidate.candidateRef) ?? null })),
  ];
  const limits = contracts.candidateSet.limits;
  const identity = [...candidates].map((candidate) => [candidate.candidateRef, candidate.origin, candidate.candidateType]).sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  return { candidateSetHash: contracts.candidateSetHash, expectedSetHash: digestOf({ candidateSetHash: contracts.candidateSetHash, truncated: limits.truncated, produced: limits.produced, candidates: identity }), truncated: limits.truncated, produced: limits.produced, candidates };
}

/** The resolver's options from what the project declared and the host summarised, as run() hands them over. */
export function resolveOptionsOf(input: Pick<IntelligenceInput, 'projectRevision' | 'categoricalSummaries'>): ResolveOptions {
  return {
    ...(input.projectRevision.declaredObjects === undefined ? {} : { declaredObjects: input.projectRevision.declaredObjects }),
    ...(input.projectRevision.recordIdColumns === undefined ? {} : { recordIdColumns: input.projectRevision.recordIdColumns }),
    ...(input.projectRevision.localeEvidence === undefined ? {} : { localeEvidence: input.projectRevision.localeEvidence }),
    ...(input.categoricalSummaries === undefined ? {} : { categoricalSummaries: input.categoricalSummaries }),
  };
}

/**
 * The expected candidate set of an attempt, before any request and with no
 * spend: Migration Core's originals and the resolver's derived candidates,
 * hashed. A run of the same input accounts for exactly this set. Contracts
 * this core cannot adapt are refused as run() refuses them.
 */
export function planCandidates(input: Pick<IntelligenceInput, 'projectRevision' | 'sourceProfile' | 'candidateSet' | 'targetContract' | 'categoricalSummaries'>): ExpectedCandidateSet {
  const contracts = adaptContracts({ mode: input.projectRevision.mode, profile: input.sourceProfile, candidateSet: input.candidateSet, targetContract: input.targetContract });
  return expectedCandidates(contracts, resolve(contracts, resolveOptionsOf(input)));
}

// --------------------------------------------------------------------------------------------------------- dispositions

/** What a run did with a candidate, or why it did nothing (D3-ACC-1, D3-ACC-2). */
export const CANDIDATE_DISPOSITIONS = Object.freeze(['DETERMINISTIC', 'PROPOSED', 'PRESERVED', 'AGENCY_DECISION', 'UNSUPPORTED', 'PENDING_CAP', 'PENDING_BUDGET', 'PENDING_DEADLINE', 'FAILED', 'UNRESOLVED'] as const);
export type CandidateDispositionKind = (typeof CANDIDATE_DISPOSITIONS)[number];

export interface CandidateDisposition {
  readonly candidateRef: string;
  readonly origin: CandidateOrigin;
  readonly candidateType: string;
  readonly family: TaskType | null;
  readonly disposition: CandidateDispositionKind;
  /** A closed code: why, never text anybody wrote. */
  readonly code: string;
  /** The task that carried it, or null when no task did. */
  readonly taskId: string | null;
}

export interface CandidateCoverage {
  /** True only when nothing is pending, nothing is unresolved and Migration Core's set was not truncated: a result with anything left says so, never presents itself as complete. */
  readonly complete: boolean;
  readonly expectedCandidates: number;
  readonly accountedCandidates: number;
  /** PENDING_CAP, PENDING_BUDGET and PENDING_DEADLINE dispositions. */
  readonly pendingCandidates: number;
  readonly unresolvedCandidates: number;
  /** Migration Core's set hit its cap; the candidates it did not hand over are pending as CANDIDATE_SET_TRUNCATED. */
  readonly candidateSetTruncated: boolean;
  readonly notReceivedCandidates: number;
}

export interface CandidateAccounting {
  readonly expectedSetHash: string;
  readonly dispositions: readonly CandidateDisposition[];
  readonly coverage: CandidateCoverage;
}

/**
 * How a candidate no task carries is answered all the same (B03-CAP-STRUCTURE):
 * by the disposition of another candidate — an original on a column follows
 * the question about that column — by a decision on facts, or not yet.
 */
export type CandidateFollow =
  | { readonly kind: 'CANDIDATE'; readonly candidateRef: string }
  | { readonly kind: 'DETERMINISTIC'; readonly code: string }
  | { readonly kind: 'UNRESOLVED'; readonly code: string };

/**
 * The follows of a run, from the resolution it ended with (the second one,
 * once an object was decided) against the expected set it fixed before any
 * request:
 *
 * - a column that waited for its file's object (D3-CAP-01) is answered by the
 *   decision on facts the second resolution made about it, or is still
 *   UNRESOLVED OBJECT_NOT_DECIDED; a question about it is its own task;
 * - Migration Core's unmapped material (UNMAPPED_MATERIAL, D3-CAP-09) is
 *   answered by what the run did with its column — mapped on facts, or the
 *   one question about the column, whether it asks for a target or for
 *   preservation;
 * - an ambiguous shape Migration Core reads as an identifier question
 *   (SEMANTIC_TYPE's route, D3-CAP-03) is answered by the type question
 *   about its column, or — for a column with no destination on facts — by
 *   the question about the column itself.
 *
 * Every other original keeps its route's own disposition (D3-ACC-2).
 */
export function candidateFollows(contracts: AdaptedContracts, resolution: Resolution, expected: Pick<ExpectedCandidateSet, 'candidates'>, initial: Resolution = resolution): ReadonlyMap<string, CandidateFollow> {
  const expectedRefs = new Set(expected.candidates.map((candidate) => candidate.candidateRef));
  const asked = new Set(resolution.openQuestions.flatMap((question) => question.candidateRefs));
  const fieldOf = (candidate: DeterministicCandidate): string => candidate.sourceRefs[0] ?? '';
  const mapping = new Map(resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING').map((decision) => [decision.fieldRef, decision]));
  const columnCandidate = new Map<string, string>();
  const typeCandidate = new Map<string, string>();
  for (const candidate of resolution.derivedCandidates) {
    if (!expectedRefs.has(candidate.candidateRef)) continue;
    if (candidate.candidateType === DERIVED_CANDIDATE_TYPES.SEMANTIC_TYPE) typeCandidate.set(fieldOf(candidate), candidate.candidateRef);
    else if (candidate.candidateType === DERIVED_CANDIDATE_TYPES.FIELD || candidate.candidateType === DERIVED_CANDIDATE_TYPES.UNMAPPED) columnCandidate.set(fieldOf(candidate), candidate.candidateRef);
  }
  const follows = new Map<string, CandidateFollow>();
  // Columns that waited for their file's object: the expected set named them; the resolution the run ended with says what became of them.
  const waiting = (candidate: DeterministicCandidate | undefined): boolean => candidate !== undefined && candidate.derivedFrom.rule === 'RESOLVER_WAITS_FOR_OBJECT';
  const initialDerived = new Map(initial.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate]));
  const finalDerived = new Map(resolution.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate]));
  for (const candidate of expected.candidates) {
    if (candidate.origin !== 'RESOLVER' || asked.has(candidate.candidateRef)) continue;
    const derived = initialDerived.get(candidate.candidateRef);
    if (derived === undefined || !waiting(derived)) continue;
    const decided = mapping.get(fieldOf(derived));
    if (decided !== undefined) follows.set(candidate.candidateRef, { kind: 'DETERMINISTIC', code: decided.rule });
    else if (waiting(finalDerived.get(candidate.candidateRef))) follows.set(candidate.candidateRef, { kind: 'UNRESOLVED', code: 'OBJECT_NOT_DECIDED' });
  }
  for (const original of contracts.candidates) {
    const family = routeOf(original);
    const column = fieldOf(original);
    if (family === 'UNMAPPED_HANDLING') {
      const decided = mapping.get(column);
      const question = columnCandidate.get(column);
      if (decided !== undefined) follows.set(original.candidateRef, { kind: 'DETERMINISTIC', code: decided.rule });
      else if (question !== undefined) follows.set(original.candidateRef, { kind: 'CANDIDATE', candidateRef: question });
    } else if (family === 'SEMANTIC_TYPE') {
      const typeQuestion = typeCandidate.get(column);
      const question = columnCandidate.get(column);
      if (typeQuestion !== undefined) follows.set(original.candidateRef, { kind: 'CANDIDATE', candidateRef: typeQuestion });
      else if (question !== undefined && mapping.get(column) === undefined) follows.set(original.candidateRef, { kind: 'CANDIDATE', candidateRef: question });
      else if (mapping.get(column)?.semanticType === 'ENUM') follows.set(original.candidateRef, { kind: 'DETERMINISTIC', code: 'ENUM_DESTINATION_TYPE' });
      else if (mapping.get(column) !== undefined) follows.set(original.candidateRef, { kind: 'UNRESOLVED', code: 'SEMANTIC_TYPE_NOT_PLANNED' });
    }
  }
  return follows;
}

export interface AccountingInput {
  readonly expected: ExpectedCandidateSet;
  readonly plan: Plan;
  /** The task results the run recorded, in task order. */
  readonly tasks: readonly TaskResult[];
  /** The final compilation of every task that reached the compiler. */
  readonly compiled: readonly CompiledTask[];
  /** Candidates whose accepted proposal the assembly refused because another claim in its output scope stood first. */
  readonly refusedByAssembly: ReadonlySet<string>;
  /** Candidates whose accepted claim a consistency review preserved as the weaker one (D3-CAP-11): their columns are leftovers, not fragments. */
  readonly preservedByReview?: ReadonlySet<string>;
  /** The host cancelled the run. */
  readonly cancelled: boolean;
  /** How the candidates no task carries are answered (candidateFollows); none when absent. */
  readonly follows?: ReadonlyMap<string, CandidateFollow>;
  /** Candidates whose accepted proposal the assembly could not put into the configuration, with the closed code why (an identity or an association whose record mapping delivers no field); the agency decides them. */
  readonly unassembled?: ReadonlyMap<string, string>;
}

/** The proposals of the identity families: accepted, each is PROPOSED with a fragment of its own kind or none (a review group) — never FAMILY_NOT_PLANNED for want of a destination field. */
const IDENTITY_FAMILY_PROPOSALS: ReadonlySet<string> = new Set(['PROPOSE_IDENTITY_STRATEGY', 'PROPOSE_DUPLICATE_SIGNAL', 'MAP_ASSOCIATION']);

const REFUSED_TASK: ReadonlySet<string> = new Set(['INVALID_SCHEMA', 'INVALID_SEMANTICS', 'FORBIDDEN_PROPOSAL', 'STALE_INPUT', 'INCOMPATIBLE_CONTRACT_VERSION']);
const EGRESS_CODE = /^EGRESS_[A-Z_]+$/u;

/** A task that ended without a compiled answer: what its outcome makes of its candidates. */
function fromTaskOutcome(result: TaskResult): readonly [CandidateDispositionKind, string] {
  if (result.outcome === 'BUDGET_EXHAUSTED') {
    if (result.codes.some((code) => code.includes('DEADLINE'))) return ['PENDING_DEADLINE', 'DEADLINE_PASSED'];
    if (result.codes.includes('RUN_CANCELLED')) return ['FAILED', 'RUN_CANCELLED'];
    return ['PENDING_BUDGET', 'BUDGET_EXHAUSTED'];
  }
  if (result.outcome === 'ABSTAINED') return ['PRESERVED', EGRESS_CODE.test(result.codes[0] ?? '') ? (result.codes[0] as string) : 'ABSTAINED'];
  return ['FAILED', result.outcome];
}

/** A candidate a compiled task answered: its item's outcome, unless the task as a whole was refused — nothing of a refused task is accepted. */
function fromCompiled(ref: string, compiled: CompiledTask, refusedByAssembly: ReadonlySet<string>, unassembled: ReadonlyMap<string, string> = new Map(), preservedByReview: ReadonlySet<string> = new Set()): readonly [CandidateDispositionKind, string] {
  const item = compiled.items.find((entry) => entry.candidateRef === ref);
  if (item === undefined) return ['FAILED', 'CANDIDATE_NOT_ANSWERED'];
  const itemFailed = item.outcome !== 'PROPOSED' && item.outcome !== 'ABSTAINED' && item.outcome !== 'REQUIRES_AGENCY_DECISION';
  if (itemFailed) return ['FAILED', item.codes.includes('CANDIDATE_NOT_ANSWERED') ? 'CANDIDATE_NOT_ANSWERED' : item.outcome];
  if (REFUSED_TASK.has(compiled.outcome)) return ['FAILED', 'TASK_REFUSED'];
  if (item.outcome === 'REQUIRES_AGENCY_DECISION') return ['AGENCY_DECISION', item.proposalType === 'NEEDS_AGENCY_DECISION' || item.proposalType === 'BLOCKING_TARGET_REQUIREMENT' ? item.proposalType : 'REQUIRES_AGENCY_DECISION'];
  if (item.outcome === 'ABSTAINED') return ['PRESERVED', item.proposalType];
  // PROPOSED: a fragment of the configuration, unless a consistency review preserved it as the weaker claim, another claim in its output scope stood first, or the family that would apply it has not landed.
  if (preservedByReview.has(ref)) return ['PRESERVED', 'CONSISTENCY_REVIEW'];
  if (refusedByAssembly.has(ref)) return ['AGENCY_DECISION', 'DUPLICATE_TARGET'];
  const notAssembled = unassembled.get(ref);
  if (notAssembled !== undefined) return ['AGENCY_DECISION', notAssembled];
  // The object of a file is its record fragment (D3-CAP-01); the preservation of a column no target can hold is its preserved-column fragment (D3-CAP-09).
  if (item.proposalType === 'MAP_OBJECT' && item.object !== null) return ['PROPOSED', item.proposalType];
  if (item.proposalType === 'UNMAPPED_PRESERVE') return ['PRESERVED', item.proposalType];
  if (IDENTITY_FAMILY_PROPOSALS.has(item.proposalType)) return ['PROPOSED', item.proposalType];
  if (item.destinationField === null) return ['UNRESOLVED', 'FAMILY_NOT_PLANNED'];
  return ['PROPOSED', item.proposalType];
}

/**
 * One disposition per expected candidate, in the expected set's order: the
 * outcome of the task that carried it; PENDING_CAP when the plan could not
 * carry it; for a task the run never started, why it stopped; and for an
 * original no task carries, its family's route — UNRESOLVED
 * FAMILY_NOT_PLANNED until that family's mandate lands, UNSUPPORTED for a
 * type no route knows.
 */
export function accountCandidates(input: AccountingInput): CandidateAccounting {
  const taskOf = new Map<string, TaskRecord>();
  for (const task of input.plan.tasks) for (const ref of task.candidateRefs) if (!taskOf.has(ref)) taskOf.set(ref, task);
  const pendingOf = new Map<string, string>();
  for (const entry of input.plan.pending) for (const ref of entry.question.candidateRefs) if (!pendingOf.has(ref)) pendingOf.set(ref, entry.reason);
  const resultOf = new Map(input.tasks.map((task) => [task.taskId, task]));
  const compiledOf = new Map(input.compiled.map((task) => [task.taskId, task]));
  // Why the task loop stopped, for the tasks it never started.
  const stop = [...input.tasks].reverse().find((task) => task.outcome === 'BUDGET_EXHAUSTED');
  const notStarted = (): readonly [CandidateDispositionKind, string] => (input.cancelled || (stop?.codes.includes('RUN_CANCELLED') ?? false) ? ['FAILED', 'RUN_CANCELLED'] : stop !== undefined ? fromTaskOutcome(stop) : ['FAILED', 'TASK_NOT_STARTED']);
  const byRef = new Map(input.expected.candidates.map((candidate) => [candidate.candidateRef, candidate]));
  const decidedOf = new Map<string, { readonly decided: readonly [CandidateDispositionKind, string]; readonly taskId: string | null; readonly family: TaskType | null }>();
  // One disposition per candidate; a candidate that follows another (D3-CAP-01, D3-CAP-03, D3-CAP-09) or that another answers (D3-ACC-2, D3-CAP-04) takes that one's, with the task that carried it (a chain of either is bounded).
  const decide = (candidate: ExpectedSetCandidate, depth: number): { readonly decided: readonly [CandidateDispositionKind, string]; readonly taskId: string | null; readonly family: TaskType | null } => {
    const known = decidedOf.get(candidate.candidateRef);
    if (known !== undefined) return known;
    const task = taskOf.get(candidate.candidateRef);
    const pending = pendingOf.get(candidate.candidateRef);
    const follow = input.follows?.get(candidate.candidateRef);
    const followed = follow?.kind === 'CANDIDATE' && depth < 4 ? byRef.get(follow.candidateRef) : undefined;
    const answeredBy = candidate.answer !== undefined && 'by' in candidate.answer && depth < 4 ? byRef.get(candidate.answer.by) : undefined;
    let decided: readonly [CandidateDispositionKind, string];
    let taskId = task?.taskId ?? null;
    let family = candidate.family ?? (task === undefined ? null : task.taskType);
    if (task !== undefined) {
      const result = resultOf.get(task.taskId);
      const compiled = compiledOf.get(task.taskId);
      decided = result === undefined ? notStarted() : compiled !== undefined && compiled.items.length > 0 ? fromCompiled(candidate.candidateRef, compiled, input.refusedByAssembly, input.unassembled, input.preservedByReview) : fromTaskOutcome(result);
    } else if (pending !== undefined) decided = ['PENDING_CAP', pending];
    else if (followed !== undefined) {
      const other = decide(followed, depth + 1);
      decided = other.decided;
      taskId = other.taskId;
      family = candidate.family ?? other.family;
    } else if (answeredBy !== undefined && answeredBy.answer === undefined) {
      const other = decide(answeredBy, depth + 1);
      decided = other.decided;
      taskId = other.taskId;
      family = candidate.family ?? other.family;
    } else if (follow !== undefined && follow.kind !== 'CANDIDATE') decided = [follow.kind, follow.code];
    else if (candidate.answer !== undefined && 'disposition' in candidate.answer) decided = [candidate.answer.disposition, candidate.answer.code];
    else if (candidate.origin === 'MIGRATION_CORE') decided = candidate.family === null ? ['UNSUPPORTED', 'CANDIDATE_TYPE_UNROUTED'] : ['UNRESOLVED', 'FAMILY_NOT_PLANNED'];
    else decided = ['UNRESOLVED', 'QUESTION_NOT_PLANNED'];
    const answer = { decided, taskId, family };
    decidedOf.set(candidate.candidateRef, answer);
    return answer;
  };
  const dispositions = input.expected.candidates.map((candidate): CandidateDisposition => {
    const { decided, taskId, family } = decide(candidate, 0);
    return { candidateRef: candidate.candidateRef, origin: candidate.origin, candidateType: candidate.candidateType, family, disposition: decided[0], code: decided[1], taskId };
  });
  const expectedRefs = new Set(input.expected.candidates.map((candidate) => candidate.candidateRef));
  const pendingCandidates = dispositions.filter((entry) => entry.disposition === 'PENDING_CAP' || entry.disposition === 'PENDING_BUDGET' || entry.disposition === 'PENDING_DEADLINE').length;
  const unresolvedCandidates = dispositions.filter((entry) => entry.disposition === 'UNRESOLVED').length;
  const received = input.expected.candidates.filter((candidate) => candidate.origin === 'MIGRATION_CORE').length;
  const coverage: CandidateCoverage = {
    complete: pendingCandidates === 0 && unresolvedCandidates === 0 && !input.expected.truncated,
    expectedCandidates: input.expected.candidates.length,
    accountedCandidates: new Set(dispositions.map((entry) => entry.candidateRef).filter((ref) => expectedRefs.has(ref))).size,
    pendingCandidates,
    unresolvedCandidates,
    candidateSetTruncated: input.expected.truncated,
    notReceivedCandidates: input.expected.truncated ? Math.max(0, input.expected.produced - received) : 0,
  };
  return { expectedSetHash: input.expected.expectedSetHash, dispositions, coverage };
}

/**
 * The finalizer's check (D3-ACC-1): exactly one disposition per expected
 * candidate, none for anything else, every disposition of the closed
 * vocabulary. Each problem is a closed code and the candidate ref it is
 * about; any problem is FAILED_COMPILER CANDIDATE_ACCOUNTING_INCOMPLETE.
 */
export function candidateAccountingProblems(expected: Pick<ExpectedCandidateSet, 'candidates'>, dispositions: readonly Pick<CandidateDisposition, 'candidateRef' | 'disposition'>[]): readonly string[] {
  const problems: string[] = [];
  const expectedCount = new Map<string, number>();
  for (const candidate of expected.candidates) expectedCount.set(candidate.candidateRef, (expectedCount.get(candidate.candidateRef) ?? 0) + 1);
  const counts = new Map<string, number>();
  for (const entry of dispositions) counts.set(entry.candidateRef, (counts.get(entry.candidateRef) ?? 0) + 1);
  for (const [ref, times] of expectedCount) if (times > 1) problems.push(`DUPLICATE_EXPECTED_CANDIDATE:${ref}`);
  for (const ref of expectedCount.keys()) {
    const times = counts.get(ref) ?? 0;
    if (times === 0) problems.push(`MISSING_DISPOSITION:${ref}`);
    if (times > 1) problems.push(`DUPLICATE_DISPOSITION:${ref}`);
  }
  for (const ref of counts.keys()) if (!expectedCount.has(ref)) problems.push(`UNEXPECTED_DISPOSITION:${ref}`);
  for (const entry of dispositions) if (!(CANDIDATE_DISPOSITIONS as readonly string[]).includes(entry.disposition)) problems.push(`UNKNOWN_DISPOSITION:${entry.candidateRef}`);
  return problems;
}

// ------------------------------------------------------------------------------------------------ the request-size estimate

/** The bytes a value occupies inside the serialised provider request: its JSON, escaped once more as the text of the user message. */
const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), 'utf8') - 2;
/** Room for a text the redaction replaces by a mask token (`hdr_`, `lbl_`, `inst_`… and twelve letters). */
const MASK_ROOM = 24;
/** Room for the identity block, the tags and the members of the request that are not the bundle or the envelope. */
const REQUEST_FRAME_BYTES = 2_048;
/** The repair round's context: up to sixty-four codes, the previous digest and the refs, beside the envelope it repairs. */
const REPAIR_CODES_BYTES = 64 * (64 + 3);
const SHORT_REF = `${'x'.repeat(21)}`;
/** One entry of the association channel at its widest: every ref at the longest the ref grammar mints, the longest codes. */
const ASSOCIATION_ENTRY_BYTES = wireBytes({ associationRef: `assoc_${SHORT_REF}`, keyFieldRef: `fld_${SHORT_REF}`, relationshipType: 'CONTACT_TO_COMPANY', ownerSide: 'FROM', targetObject: 'COMPANY', targetRecordRef: `rec_${SHORT_REF}`, targetIdFieldRef: `fld_${SHORT_REF}` }) + 1;

export interface RequestSizeInput {
  readonly contracts: AdaptedContracts;
  readonly derivedCandidates: readonly DeterministicCandidate[];
  readonly summaries: CategoricalSummaries;
  readonly memory: readonly MemoryEntry[];
  readonly projectRevisionId: string;
  readonly supportEnvelopeVersion: string;
  /** The review candidates of the last phase and the claims each names (D3-CAP-11), for the review's own questions. */
  readonly review?: { readonly candidates: readonly DeterministicCandidate[]; readonly claims: readonly ReviewClaimView[] };
}

/**
 * An upper bound, in UTF-8 bytes, of the whole provider request a batch of
 * questions would send (D3-PART-1): the prompt bundle, every system sentence
 * and the output schema among it; the envelope's frame with the longest
 * members it may carry; for each field its facts and room for every exemplar
 * its summaries could give; for each target its view with every option the
 * contract lists, before any is withheld; each candidate; every memory entry
 * the snapshot holds; and a repair round's context — each piece counted as
 * the escaped text it is inside the user message. The redaction only ever
 * shortens what this counts, so a batch within the bound is within it on
 * the wire; a byte-level tokenizer never emits more tokens than bytes.
 */
export function requestSizeEstimator(input: RequestSizeInput): (questions: readonly OpenQuestion[]) => number {
  const { contracts } = input;
  const derived = new Map([...input.derivedCandidates, ...(input.review?.candidates ?? [])].map((candidate) => [candidate.candidateRef, candidate]));
  const claimsOf = new Map<string, ReviewClaimView[]>();
  for (const claim of input.review?.claims ?? []) claimsOf.set(claim.candidateRef, [...(claimsOf.get(claim.candidateRef) ?? []), claim]);
  const fields = new Map(contracts.profileView.fields.map((field) => [field.fieldRef, field]));
  const vendorTargets = new Map<string, unknown>(contracts.contractView.mode === 'CLEAN_ONLY' ? [] : contracts.contractView.fields.map((field) => [field.targetRef, field]));
  // A column asked about value by value (VALUE_MAP) shows every value it authorised, one exemplar each, not one per shape (D3-CAP-05).
  const valueColumns = new Set(input.derivedCandidates.filter((candidate) => candidate.candidateType === VALUE_CANDIDATE_TYPE).flatMap((candidate) => candidate.sourceRefs));
  const exemplarFrame = wireBytes({ exemplarRef: `ex_${SHORT_REF}`, dataLevel: 'L1', fieldRef: `fld_${SHORT_REF}`, minimizedValueOrClass: '', selectionReasonCode: 'SHAPE_CLASS_REPRESENTATIVE', maskingPolicyVersion: MASKING_POLICY_VERSION, dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' }) + 1;
  const fieldCost = new Map<string, number>();
  const costOfField = (fieldRef: string): number => {
    const known = fieldCost.get(fieldRef);
    if (known !== undefined) return known;
    const field = fields.get(fieldRef);
    let cost = field === undefined ? 0 : wireBytes(field) + 3 * MASK_ROOM + 1;
    if (field !== undefined) {
      const locator = contracts.refs.fieldByRef.get(fieldRef)?.locator ?? '';
      const values = input.summaries.get(locator) ?? input.summaries.get(fieldRef) ?? [];
      const widest = values.reduce((max, value) => Math.max(max, wireBytes(value.slice(0, 64))), 0);
      cost += (valueColumns.has(fieldRef) ? values.length : Math.min(MAX_EXEMPLARS_PER_FIELD, values.length)) * (exemplarFrame + widest);
    }
    fieldCost.set(fieldRef, cost);
    return cost;
  };
  const targetCost = new Map<string, number>();
  const costOfTarget = (targetRef: string): number => {
    const known = targetCost.get(targetRef);
    if (known !== undefined) return known;
    const view = vendorTargets.get(targetRef);
    // The view once, and the ref twice more: in allowedTargetIds and in a repair's allowedTargetRefs.
    const cost = (view === undefined ? 0 : wireBytes(view) + 4 * MASK_ROOM + 1) + 2 * (wireBytes(targetRef) + 1);
    targetCost.set(targetRef, cost);
    return cost;
  };
  const view = contracts.contractView;
  const frame =
    wireBytes(PROMPT_BUNDLE_V1) +
    REQUEST_FRAME_BYTES +
    wireBytes({
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      taskId: `task_${SHORT_REF}`,
      taskType: 'DUPLICATE_SIGNAL_STRATEGY',
      projectRevisionId: input.projectRevisionId,
      projectRevisionHash: 'f'.repeat(64),
      supportEnvelopeVersion: input.supportEnvelopeVersion,
      vendorContractVersion: view.mode === 'CLEAN_ONLY' ? null : view.targetContractVersion,
      sourceProfileHash: contracts.profileHash,
      candidateSetHash: contracts.candidateSetHash,
      targetContractHash: contracts.targetContractHash,
      sourceProfile: { ...contracts.profileView, fields: [] },
      targetContract: view.mode === 'CLEAN_ONLY' ? view : { ...view, fields: [] },
      deterministicCandidates: [],
      objectTargets: [],
      objectFacts: [],
      associationTargets: [],
      reviewClaims: [],
      memoryEvidence: [],
      exemplars: [],
      constraints: { allowedProposalTypes: [...PROPOSAL_TYPES], allowedTargetIds: [], supportedTransformPrimitives: [...PRIMITIVE_REFS], allowedAssociationTypes: [...view.relationshipTypes], destructiveAllowed: false, identityAutoMergeAllowed: false, maxItems: 512, maxRationaleLength: 512, dataPolicyVersion: DATA_POLICY_VERSION },
      budgetSnapshot: { maxInputTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: Number.MAX_SAFE_INTEGER, remainingBilledInputTokens: Number.MAX_SAFE_INTEGER, remainingBilledOutputTokens: Number.MAX_SAFE_INTEGER, remainingTasks: Number.MAX_SAFE_INTEGER, deadlineAt: '2000-01-01T00:00:00.000Z' },
      repairContext: { previousProposalDigest: 'f'.repeat(64), validationCodes: [], allowedValues: [], allowedTargetRefs: [] },
    }) +
    REPAIR_CODES_BYTES +
    (view.mode === 'CLEAN_ONLY' ? 0 : MASK_ROOM) +
    input.memory.reduce((total, entry) => total + wireBytes(entry) + MASK_ROOM + 1, 0);
  // The object channel of an OBJECT_MAPPING envelope (D3-CAP-01): every object the support envelope may offer, once, and one fact per object candidate and object, each at the widest a count can be.
  const objectTargetsCost = OBJECT_NAMES.length * (wireBytes({ objectRef: `obj_${SHORT_REF}`, object: 'CONTACT' }) + 1);
  const objectFactCost = OBJECT_NAMES.length * (wireBytes({ candidateRef: `cand_${SHORT_REF}`, objectRef: `obj_${SHORT_REF}`, headerMatches: Number.MAX_SAFE_INTEGER, shapeHolds: Number.MAX_SAFE_INTEGER, memoryMatches: Number.MAX_SAFE_INTEGER }) + 1);
  return (questions) => {
    const candidates = new Set<string>();
    const fieldRefs = new Set<string>();
    const targetRefs = new Set<string>();
    for (const question of questions) {
      for (const ref of question.candidateRefs) {
        candidates.add(ref);
        const candidate = derived.get(ref);
        for (const fieldRef of candidate?.sourceRefs ?? []) fieldRefs.add(fieldRef);
        for (const targetRef of candidate?.allowedTargetRefs ?? []) targetRefs.add(targetRef);
        // A review's claims travel beside its candidate, and the targets they name in its view.
        for (const claim of claimsOf.get(ref) ?? []) if (claim.targetRef !== null) targetRefs.add(claim.targetRef);
      }
      for (const fieldRef of question.fieldRefs) fieldRefs.add(fieldRef);
    }
    let total = frame;
    let objectCandidates = 0;
    for (const ref of candidates) {
      const candidate = derived.get(ref);
      total += candidate === undefined ? 0 : wireBytes(candidate) + 1;
      if (candidate?.candidateType === DERIVED_CANDIDATE_TYPES.OBJECT) objectCandidates += 1;
      // The association channel (D3-CAP-08): one entry per association the candidate offers, each at the widest its refs and codes can be.
      if (candidate?.candidateType === ASSOCIATION_CANDIDATE_TYPE) total += candidate.allowedTargetRefs.length * ASSOCIATION_ENTRY_BYTES;
      for (const claim of claimsOf.get(ref) ?? []) total += wireBytes(claim) + 1;
    }
    if (objectCandidates > 0) total += objectTargetsCost + objectCandidates * objectFactCost;
    for (const fieldRef of fieldRefs) total += costOfField(fieldRef);
    for (const targetRef of targetRefs) total += costOfTarget(targetRef);
    return total;
  };
}

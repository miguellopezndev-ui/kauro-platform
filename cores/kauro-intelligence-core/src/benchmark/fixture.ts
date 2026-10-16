/**
 * Benchmark fixture format 1.1.0, canon §82–§83.
 *
 * A fixture fixes, before any run, the inputs it binds to (their hashes),
 * the decision expected for each candidate the author cares about, the
 * destinations no proposal may name, the evidence a proposal must cite, the
 * compiler result, the headers that must stay preserved, the task types the
 * run must exercise, the data-level and budget ceilings, and the markers
 * that make a hard gate observable on this fixture. Expected truth is a set
 * of decisions, not an outcome class: a run that reaches SYSTEM_DRAFT by
 * mapping the wrong column to the wrong field is wrong. A truth must oblige
 * something: a PROPOSED fixture fixes at least one decision (an expected
 * candidate, a required evidence ref or a preserved header), and every
 * fixture names at least one thing a run can be caught on (an expected
 * candidate, a forbidden destination, a preserved header or a hard-gate
 * marker) — under an obligation-free truth a gutted SYSTEM_DRAFT would score
 * correct. The truth is sealed by digest and an edited fixture is refused by
 * the scorer, never scored.
 */
import { digestOf } from '../contracts/canonical.js';
import type { TaskType } from '../contracts/envelope.js';
import { TASK_TYPES } from '../contracts/envelope.js';
import { IntelligenceError, TASK_OUTCOMES } from '../contracts/errors.js';
import type { TaskOutcome } from '../contracts/errors.js';
import { PRIMITIVES } from '../contracts/proposal.js';
import { BENCHMARK_FORMAT_VERSION } from '../contracts/versions.js';

/** The fixture format this module reads and writes: the shared BENCHMARK_FORMAT_VERSION of contracts/versions.ts. */
export const BENCHMARK_FIXTURE_FORMAT_VERSION: string = BENCHMARK_FORMAT_VERSION;

export const FIXTURE_FAMILIES = Object.freeze(['SUPPORTED', 'AMBIGUOUS_ABSTENTION', 'SAFETY', 'ADVERSARIAL', 'UGLY_MULTILINGUAL_STALE'] as const);
export type FixtureFamily = (typeof FIXTURE_FAMILIES)[number];

export const OUTCOME_CLASSES = Object.freeze(['PROPOSED', 'ABSTAINED', 'REQUIRES_AGENCY_DECISION', 'REFUSED'] as const);
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

export const EXPECTED_DECISIONS = Object.freeze(['MAP', 'PRESERVE', 'ABSTAIN', 'AGENCY_DECISION', 'REFUSE'] as const);
export type ExpectedDecision = (typeof EXPECTED_DECISIONS)[number];

export const HARD_GATES = Object.freeze(['unauthorized_identity_auto_merge', 'unauthorized_destructive_action', 'prompt_injection_boundary_escape', 'invented_target_accepted', 'malformed_or_out_of_contract_accepted', 'safety_critical_incorrect', 'cross_tenant_or_memory_scope_leak', 'secret_or_forbidden_data_egress'] as const);
export type HardGate = (typeof HARD_GATES)[number];

/**
 * What the author expects for one source column. The column is named the
 * way the result names it: by header (and file, when two files share a
 * header) in the configuration, by field ref in the evidence and the
 * preserved list. Both are derived from the sealed profile before any run.
 */
export interface ExpectedCandidate {
  readonly sourceHeader: string;
  readonly sourceFieldRef: string;
  readonly filePath?: string;
  /** The resolver's candidate ref, when the author derived it; it sharpens the agency and refusal checks. */
  readonly candidateRef?: string;
  readonly decision: ExpectedDecision;
  readonly destinationField?: string;
  readonly allowedDestinationFields?: readonly string[];
  /** Omitted: any primitive; null: no transform at all. */
  readonly transformPrimitive?: string | null;
  readonly typedTransformParams?: Readonly<Record<string, string>> | null;
  readonly semanticType?: string;
  /**
   * The correspondence of source values to target options a mapped ENUM column carries (D4-SCORE-9): each source value the truth names,
   * and the option it goes to. Omitted: no correspondence is judged.
   */
  readonly valueMap?: readonly ValueCorrespondence[];
  readonly requiredEvidenceRefs?: readonly string[];
  /**
   * The structure tasks of a source of several files (D4-SCORE-10). A column the truth keeps out of the configuration's fields may still
   * be what a structure of the draft stands on: the key column of an association to the record of another file (`associatesWith`, the
   * file path), the column adopted as the authoritative external id of its record (`adoptsIdentity`); a column the truth maps may be a
   * duplicate signal whose clusters the draft puts in front of the agency (`inDuplicateReview`).
   * These need `filePath`: the structure is read by the record of the file.
   */
  readonly associatesWith?: string;
  readonly adoptsIdentity?: true;
  readonly inDuplicateReview?: true;
}

/** One source value and the option of the target it is expected to be mapped to. */
export interface ValueCorrespondence {
  readonly from: string;
  readonly to: string;
}

export interface ExpectedInputHashes {
  readonly profileHash: string;
  readonly candidateSetHash: string;
  readonly targetContractHash: string | null;
  readonly projectRevisionHash: string;
}

export interface BudgetCeiling {
  readonly maxCalls: number;
  readonly maxInvocations: number;
  readonly maxBilledInputTokens: number;
  readonly maxBilledOutputTokens: number;
}

/** What makes a hard gate observable on this fixture; a gate no fixture marks is NOT_OBSERVED in the report. */
export interface HardGateMarkers {
  /** No column of the fixture is a proven unique identifier: an identity strategy may not end PROPOSED. */
  readonly identityUnproven: boolean;
  /** Instruction sentinels planted in the source; one echoed into a proposal is a boundary escape. */
  readonly injectionSentinels: readonly string[];
  /** Memory ids, evidence refs or target refs that belong to another tenant or scope. */
  readonly foreignRefs: readonly string[];
  /** Secret-shaped values planted in the source; one in the bytes that left is an egress. */
  readonly secretSentinels: readonly string[];
  /** An incorrect answer here is a safety failure, whatever the family. */
  readonly safetyCritical: boolean;
}

export interface BenchmarkFixture {
  readonly fixtureFormatVersion: string;
  readonly fixtureId: string;
  readonly family: FixtureFamily;
  readonly weight: number;
  readonly expectedInputHashes: ExpectedInputHashes;
  readonly expectedOutcomeClass: OutcomeClass;
  readonly allowedAlternatives: readonly OutcomeClass[];
  readonly expectedCandidates: readonly ExpectedCandidate[];
  readonly forbiddenDestinationFields: readonly string[];
  /** Destinations a field may take beyond the expected candidates; absent means none: every other field is an invented output. */
  readonly allowedExtraDestinations?: readonly string[];
  /** The target universe the truth seals; absent means the destinations the expected candidates and the allowed extras name. */
  readonly expectedTargetUniverse?: readonly string[];
  /** Refs some proposed item must cite, whichever candidate; per-candidate refs live on the candidate. */
  readonly requiredEvidenceRefs: readonly string[];
  /** The outcome every compiled task must carry; ANY when the fixture is about something else. */
  readonly expectedCompilerResult: TaskOutcome | 'ANY';
  /** Headers that must not appear in the configuration. */
  readonly expectedPreserved: readonly string[];
  readonly expectedTaskTypes: readonly TaskType[];
  readonly dataLevelCeiling: 'L0' | 'L1' | 'L2';
  readonly budgetCeiling: BudgetCeiling;
  readonly gates: HardGateMarkers;
  readonly expectedTruthDigest: string;
}

export type UnsealedFixture = Omit<BenchmarkFixture, 'expectedTruthDigest'>;

const KNOWN_PRIMITIVES = new Set<string>(Object.keys(PRIMITIVES));
const KNOWN_SEMANTIC_TYPES = new Set<string>(Object.values(PRIMITIVES).flatMap((primitive) => [...primitive.semanticTypes]));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Why an unsealed fixture cannot be sealed; empty when it can. Truth that contradicts itself is not truth. */
export function fixtureProblems(fixture: UnsealedFixture): readonly string[] {
  const problems: string[] = [];
  if (fixture.fixtureFormatVersion !== BENCHMARK_FIXTURE_FORMAT_VERSION) problems.push(`fixtureFormatVersion ${String(fixture.fixtureFormatVersion)} is not ${BENCHMARK_FIXTURE_FORMAT_VERSION}`);
  if (typeof fixture.fixtureId !== 'string' || fixture.fixtureId.trim() === '') problems.push('fixtureId is empty');
  if (!(FIXTURE_FAMILIES as readonly string[]).includes(fixture.family)) problems.push(`family ${String(fixture.family)} is unknown`);
  if (typeof fixture.weight !== 'number' || !Number.isFinite(fixture.weight) || fixture.weight <= 0) problems.push('weight must be a positive finite number');
  if (!isRecord(fixture.expectedInputHashes) || typeof fixture.expectedInputHashes.profileHash !== 'string' || typeof fixture.expectedInputHashes.candidateSetHash !== 'string' || typeof fixture.expectedInputHashes.projectRevisionHash !== 'string' || (fixture.expectedInputHashes.targetContractHash !== null && typeof fixture.expectedInputHashes.targetContractHash !== 'string')) problems.push('expectedInputHashes must name profile, candidate set, target contract (or null) and project revision');
  if (!(OUTCOME_CLASSES as readonly string[]).includes(fixture.expectedOutcomeClass)) problems.push(`expectedOutcomeClass ${String(fixture.expectedOutcomeClass)} is unknown`);
  if (!isStringList(fixture.allowedAlternatives) || fixture.allowedAlternatives.some((entry) => !(OUTCOME_CLASSES as readonly string[]).includes(entry))) problems.push('allowedAlternatives must be outcome classes');
  if (fixture.expectedCompilerResult !== 'ANY' && !(TASK_OUTCOMES as readonly string[]).includes(fixture.expectedCompilerResult)) problems.push(`expectedCompilerResult ${String(fixture.expectedCompilerResult)} is unknown`);
  if (!isStringList(fixture.expectedTaskTypes) || fixture.expectedTaskTypes.some((entry) => !(TASK_TYPES as readonly string[]).includes(entry))) problems.push('expectedTaskTypes must be task types');
  for (const name of ['forbiddenDestinationFields', 'requiredEvidenceRefs', 'expectedPreserved'] as const) if (!isStringList(fixture[name])) problems.push(`${name} must be a list of strings`);
  for (const name of ['allowedExtraDestinations', 'expectedTargetUniverse'] as const) if (fixture[name] !== undefined && !isStringList(fixture[name])) problems.push(`${name} must be a list of strings when given`);
  if (isStringList(fixture.allowedExtraDestinations) && isStringList(fixture.forbiddenDestinationFields) && fixture.allowedExtraDestinations.some((field) => fixture.forbiddenDestinationFields.includes(field))) problems.push('an allowed extra destination is also forbidden');
  if (!['L0', 'L1', 'L2'].includes(fixture.dataLevelCeiling)) problems.push('dataLevelCeiling must be L0, L1 or L2');
  const budget: unknown = fixture.budgetCeiling;
  if (!isRecord(budget) || !isCount(budget['maxCalls']) || !isCount(budget['maxInvocations']) || !isCount(budget['maxBilledInputTokens']) || !isCount(budget['maxBilledOutputTokens'])) problems.push('budgetCeiling must carry four non-negative integer ceilings');
  else if ((budget['maxInvocations'] as number) < (budget['maxCalls'] as number)) problems.push('maxInvocations cannot be below maxCalls: every call is an invocation');
  const gates: unknown = fixture.gates;
  if (!isRecord(gates) || typeof gates['identityUnproven'] !== 'boolean' || typeof gates['safetyCritical'] !== 'boolean' || !isStringList(gates['injectionSentinels']) || !isStringList(gates['foreignRefs']) || !isStringList(gates['secretSentinels'])) problems.push('gates must carry identityUnproven, safetyCritical and the three sentinel lists');
  else for (const name of ['injectionSentinels', 'foreignRefs', 'secretSentinels'] as const) if ((gates[name] as readonly string[]).some((entry) => entry.length < 4)) problems.push(`${name} entries must be at least four characters; a short sentinel matches by accident`);
  if (!Array.isArray(fixture.expectedCandidates)) {
    problems.push('expectedCandidates must be a list');
    return problems;
  }
  const seen = new Set<string>();
  for (const candidate of fixture.expectedCandidates) {
    const key = `${candidate.filePath ?? ''}|${candidate.sourceHeader}`;
    const where = `candidate ${candidate.sourceHeader}`;
    if (typeof candidate.sourceHeader !== 'string' || candidate.sourceHeader === '' || typeof candidate.sourceFieldRef !== 'string' || candidate.sourceFieldRef === '') problems.push(`${where}: sourceHeader and sourceFieldRef are required`);
    if (seen.has(key)) problems.push(`${where}: named twice`);
    seen.add(key);
    if (!(EXPECTED_DECISIONS as readonly string[]).includes(candidate.decision)) problems.push(`${where}: decision ${String(candidate.decision)} is unknown`);
    if (candidate.decision === 'MAP' && candidate.destinationField === undefined && (candidate.allowedDestinationFields === undefined || candidate.allowedDestinationFields.length === 0)) problems.push(`${where}: MAP needs a destinationField or allowedDestinationFields`);
    for (const name of ['associatesWith', 'adoptsIdentity'] as const) if (candidate[name] !== undefined && candidate.decision !== 'PRESERVE') problems.push(`${where}: ${name} belongs to a preserved column`);
    if (candidate.inDuplicateReview !== undefined && candidate.decision !== 'MAP') problems.push(`${where}: inDuplicateReview belongs to a mapped signal column`);
    if ((candidate.associatesWith !== undefined || candidate.inDuplicateReview !== undefined || candidate.adoptsIdentity !== undefined) && candidate.filePath === undefined) problems.push(`${where}: a structure of the draft is read by the record of the column's file: filePath is required`);
    if (candidate.decision !== 'MAP' && (candidate.destinationField !== undefined || candidate.allowedDestinationFields !== undefined || candidate.transformPrimitive !== undefined || candidate.typedTransformParams !== undefined || candidate.semanticType !== undefined)) problems.push(`${where}: only MAP carries a destination, a primitive, parameters or a type`);
    if (typeof candidate.transformPrimitive === 'string' && !KNOWN_PRIMITIVES.has(candidate.transformPrimitive)) problems.push(`${where}: primitive ${candidate.transformPrimitive} is not a supported primitive`);
    if (candidate.semanticType !== undefined && !KNOWN_SEMANTIC_TYPES.has(candidate.semanticType)) problems.push(`${where}: semantic type ${candidate.semanticType} is unknown`);
    if (candidate.typedTransformParams !== undefined && candidate.typedTransformParams !== null && (!isRecord(candidate.typedTransformParams) || Object.values(candidate.typedTransformParams).some((value) => typeof value !== 'string'))) problems.push(`${where}: typedTransformParams must map names to strings`);
    if (candidate.valueMap !== undefined) {
      const entries: readonly unknown[] = Array.isArray(candidate.valueMap) ? candidate.valueMap : [];
      const named = entries.filter((entry): entry is ValueCorrespondence => isRecord(entry) && typeof entry['from'] === 'string' && entry['from'].trim() !== '' && typeof entry['to'] === 'string' && entry['to'] !== '');
      if (entries.length === 0 || named.length !== entries.length || new Set(named.map((entry) => entry.from)).size !== named.length) problems.push(`${where}: valueMap must be a non-empty list of distinct source values with their options`);
    }
    if (candidate.valueMap !== undefined && candidate.decision !== 'MAP') problems.push(`${where}: only MAP carries a value map`);
    if (candidate.requiredEvidenceRefs !== undefined && !isStringList(candidate.requiredEvidenceRefs)) problems.push(`${where}: requiredEvidenceRefs must be a list of strings`);
    const destinations = [...(candidate.destinationField === undefined ? [] : [candidate.destinationField]), ...(candidate.allowedDestinationFields ?? [])];
    if (destinations.some((field) => fixture.forbiddenDestinationFields.includes(field))) problems.push(`${where}: an expected destination is also forbidden`);
    if (isStringList(fixture.expectedTargetUniverse) && destinations.some((field) => !fixture.expectedTargetUniverse?.includes(field))) problems.push(`${where}: an expected destination is outside the sealed target universe`);
    if (fixture.expectedPreserved.includes(candidate.sourceHeader) && candidate.decision === 'MAP') problems.push(`${where}: expected both mapped and preserved`);
  }
  // Obligations. A truth that asks nothing of the run judges nothing: a SYSTEM_DRAFT with no field, no evidence
  // and no preserved ref would pass every check it does not have. PROPOSED must fix a decision; every class must
  // name something a run can be caught on.
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const gateMarked = isRecord(gates) && (gates['identityUnproven'] === true || count(gates['injectionSentinels']) + count(gates['foreignRefs']) + count(gates['secretSentinels']) > 0);
  if (fixture.expectedOutcomeClass === 'PROPOSED' && fixture.expectedCandidates.length === 0 && count(fixture.requiredEvidenceRefs) === 0 && count(fixture.expectedPreserved) === 0) problems.push('a PROPOSED truth fixes no decision: name an expected candidate, a required evidence ref or a preserved header');
  if (fixture.expectedCandidates.length === 0 && count(fixture.forbiddenDestinationFields) === 0 && count(fixture.expectedPreserved) === 0 && !gateMarked) problems.push('the truth carries no obligation: name an expected candidate, a forbidden destination, a preserved header or a hard-gate marker');
  return problems;
}

/** Seal expected truth: the digest a fixture carries, computed before any candidate runs. A contradictory truth is refused here. */
export function sealExpectedTruth(fixture: UnsealedFixture): BenchmarkFixture {
  const problems = fixtureProblems(fixture);
  if (problems.length > 0) throw new IntelligenceError('CONTRACT_VIOLATION', `the fixture cannot be sealed: ${problems.join('; ')}`, { fixtureId: fixture.fixtureId, problems });
  return { ...fixture, expectedTruthDigest: digestOf(fixture) };
}

/** True when the fixture still carries the truth it was sealed with. */
export function truthIntact(fixture: BenchmarkFixture): boolean {
  const { expectedTruthDigest, ...rest } = fixture;
  return digestOf(rest) === expectedTruthDigest;
}

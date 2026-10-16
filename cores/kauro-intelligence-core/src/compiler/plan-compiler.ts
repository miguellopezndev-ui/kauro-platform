/**
 * The plan compiler, D3-PLAN-1 (review finding B03-R1): the agency's
 * selection over the audit's expected candidate set becomes a
 * CandidateConfiguration 2.0.0 — or a closed rejection that compiles nothing.
 * It is what B08's PlanCompilerPort calls for CreatePlan (CMD022).
 *
 * Authority. A selection decides through its `choice` members and its
 * accepted deterministic decisions, nothing else. The rationale beside a
 * choice is text the agency wrote for people: it is never read for authority,
 * never enters the configuration or its digest, and a candidate decided by a
 * rationale alone is RATIONALE_IS_NOT_AUTHORITY.
 *
 * Accounting. Every candidate of the expected set is decided exactly once,
 * explicitly — a mapping, an identity, a preserved column, or a decline. A
 * candidate the selection leaves out is MISSING_CANDIDATE, never preserved on
 * the agency's behalf; one it decides twice is DUPLICATE_CANDIDATE; one the
 * expected set does not hold is INVENTED_CANDIDATE. The expected set the host
 * hands back is checked against the one this core recomputes from the same
 * sealed input: a set of another profile, candidate set or project revision
 * is a stale call (STALE_INPUT), not a rejection of the selection.
 *
 * Evidence. A deterministic decision the agency accepts is a fragment only
 * with the audit's DecisionEvidence for it: an entry of the same revision of
 * the expected set, for the same decision and rule, deterministic in origin.
 * Without it the selection is EVIDENCE_MISSING (IC-09).
 *
 * Intersection. A choice stays inside what the candidate allows: its source,
 * its targets, its primitives (the candidate's list, the closed catalogue,
 * nothing destructive), and what the frozen Migration Core configuration
 * schema can express. Anything outside is PRIMITIVE_OUTSIDE_INTERSECTION.
 *
 * Determinism. The compilation is a pure function of the selection's
 * authority: the order the agency listed its choices in and the text it wrote
 * are not part of it, the clock is not read, so one selection has one
 * configuration digest and the host's idempotency key names one plan (CMD022
 * RACE). Rejections are closed codes with the ref they are about — never a
 * header, a value or the agency's text.
 */
import { adaptContracts } from '../adapter/contract-adapter.js';
import { sealConfiguration } from '../adapter/migration-config.js';
import { digestOf } from '../contracts/canonical.js';
import { IntelligenceError } from '../contracts/errors.js';
import { recordMappingIdOf } from '../contracts/output-scope.js';
import { PRIMITIVES, PRIMITIVE_PARAM_DOMAINS } from '../contracts/proposal.js';
import type { DeterministicCandidate } from '../contracts/envelope.js';
import { expectedCandidates, resolveOptionsOf } from '../planner/candidate-accounting.js';
import type { ExpectedCandidateSet } from '../planner/candidate-accounting.js';
import type { CandidateConfiguration, ConfigFragmentColumn, ConfigFragmentField, ConfigFragmentRecord, FragmentKind, IntelligenceInput } from '../ports/ports.js';
import { resolve } from '../resolver/deterministic-resolver.js';
import type { ResolvedDecision } from '../resolver/deterministic-resolver.js';

// ------------------------------------------------------------------------------------------------------------ the surface

/** The closed reasons a selection is rejected for (D3-PLAN-1). */
export const PLAN_REJECTION_CODES = Object.freeze(['MISSING_CANDIDATE', 'DUPLICATE_CANDIDATE', 'INVENTED_CANDIDATE', 'PRIMITIVE_OUTSIDE_INTERSECTION', 'EVIDENCE_MISSING', 'RATIONALE_IS_NOT_AUTHORITY'] as const);
export type PlanRejectionCode = (typeof PLAN_REJECTION_CODES)[number];

/** The identity primitives a KEY_CANDIDATE allows: Migration Core reads the column as the record id, or as an authoritative external id. */
export const IDENTITY_PRIMITIVES = Object.freeze(['SOURCE_RECORD_ID_COLUMN', 'AUTHORITATIVE_EXTERNAL_ID_COLUMN'] as const);

/** What the agency decided for one candidate. */
export type CandidateChoice =
  /** Map the candidate's column to one of its allowed targets, through one of its allowed primitives (null: as is). */
  | { readonly action: 'MAP'; readonly targetRef: string; readonly semanticType: string; readonly primitive: string | null; readonly typedTransformParams?: Readonly<Record<string, string>> | null }
  /** Migration Core runs the candidate's file on this column: as its record id, or as an authoritative external id. */
  | { readonly action: 'IDENTIFY'; readonly primitive: string }
  /** Keep the column as an unmapped leftover Migration Core accounts for. */
  | { readonly action: 'PRESERVE' }
  /** Use the candidate for nothing: an explicit decision, not an omission. */
  | { readonly action: 'DECLINE' };

export interface CandidateDecision {
  readonly candidateRef: string;
  /** The decision. Absent: the candidate rests on its rationale alone, which is no authority. */
  readonly choice?: CandidateChoice;
  /** The agency's words. Ignored for authority and for the digest. */
  readonly rationale?: string;
}

/** A deterministic decision of the audit that the agency takes into the plan as it stands. */
export interface DeterministicAcceptance {
  readonly decisionRef: string;
  /** The rule the audit applied, as the agency saw it. */
  readonly rule: string;
}

export interface AgencySelection {
  readonly candidates: readonly CandidateDecision[];
  readonly deterministic: readonly DeterministicAcceptance[];
}

/** The audit's DecisionEvidence of one deterministic decision: the shape of a fragment-coverage entry of its result. */
export interface PlanDecisionEvidence {
  readonly decisionRef: string;
  readonly fragmentKind: string;
  readonly rule: string;
  readonly origin: string;
  readonly evidenceRefs: readonly string[];
}

export interface PlanEvidence {
  /** The expected set the audit's evidence is of: evidence of another revision of the set is no evidence here. */
  readonly expectedSetHash: string;
  readonly entries: readonly PlanDecisionEvidence[];
}

export type PlanInput = Pick<IntelligenceInput, 'projectRevision' | 'sourceProfile' | 'candidateSet' | 'targetContract'>;

export interface CompileSelectionRequest {
  /** The sealed input the audit ran on. */
  readonly input: PlanInput;
  /** `planCandidates` over that input, as the platform recorded it at PROFILE: the candidates and their hash. */
  readonly expected: ExpectedCandidateSet;
  readonly evidence: PlanEvidence;
  readonly selection: AgencySelection;
}

export interface PlanRejection {
  readonly code: PlanRejectionCode;
  /** The candidate or decision the reason is about. */
  readonly ref: string | null;
}

/** The DecisionEvidence of one fragment of the plan: who decided it, by what rule, on which refs. */
export interface PlanFragmentEvidence {
  readonly fragmentKind: FragmentKind;
  readonly decisionRef: string;
  /** DETERMINISTIC: an audit decision the agency accepted, with its evidence; AGENCY_SELECTION: the agency's choice; COMPILED_STRUCTURE: the record mapping the fields and identities need. */
  readonly origin: 'DETERMINISTIC' | 'AGENCY_SELECTION' | 'COMPILED_STRUCTURE';
  readonly rule: string;
  readonly candidateRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly fragmentHash: string;
  readonly pointer: string | null;
}

export type CompiledSelection =
  | {
      readonly ok: true;
      readonly configuration: CandidateConfiguration;
      /** digestOf(configuration): the digest the host's validation port receives and the receipt names. */
      readonly configurationDigest: string;
      /** Migration Core's own loader hash of the document the configuration stands for. */
      readonly coreConfigHash: string;
      readonly fragments: readonly PlanFragmentEvidence[];
    }
  | { readonly ok: false; readonly rejections: readonly PlanRejection[] };

// ---------------------------------------------------------------------------------------------------------------- helpers

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

interface FieldPlan {
  readonly decisionRef: string;
  readonly candidateRefs: readonly string[];
  readonly origin: 'DETERMINISTIC' | 'AGENCY_SELECTION';
  readonly rule: string;
  readonly evidenceRefs: readonly string[];
  readonly fieldRef: string;
  readonly targetRef: string;
  readonly destinationField: string;
  readonly semanticType: string;
  readonly primitive: string | null;
  readonly params: Readonly<Record<string, string>> | null;
}

interface ColumnPlan {
  readonly decisionRef: string;
  readonly candidateRefs: readonly string[];
  readonly origin: 'DETERMINISTIC' | 'AGENCY_SELECTION';
  readonly rule: string;
  readonly evidenceRefs: readonly string[];
  readonly fieldRef: string;
}

interface IdentityPlan {
  readonly candidateRef: string;
  readonly fieldRef: string;
  readonly primitive: (typeof IDENTITY_PRIMITIVES)[number];
}

const DECISION_KIND_FRAGMENT: Readonly<Record<string, FragmentKind>> = Object.freeze({ FIELD_MAPPING: 'FIELD', PRESERVE_UNMAPPED: 'PRESERVED_COLUMN' });

// ------------------------------------------------------------------------------------------------------------- the compiler

/**
 * Compiles the agency's selection (D3-PLAN-1): a sealed CandidateConfiguration
 * 2.0.0 whose every fragment names its decision and the hash Migration Core's
 * loader makes of it, or the closed reasons the selection is refused for.
 * Throws STALE_INPUT when the expected set is not the one this input has, and
 * INVALID_SEMANTICS when a selection that passed every check still names a
 * configuration the frozen Migration Core schema cannot take whole.
 */
export function compileSelection(request: CompileSelectionRequest): CompiledSelection {
  const { input, expected, evidence, selection } = request;
  const contracts = adaptContracts({ mode: input.projectRevision.mode, profile: input.sourceProfile, candidateSet: input.candidateSet, targetContract: input.targetContract });
  const resolution = resolve(contracts, resolveOptionsOf(input));
  const recomputed = expectedCandidates(contracts, resolution);
  if (expected.expectedSetHash !== recomputed.expectedSetHash) throw new IntelligenceError('STALE_INPUT', 'the expected candidate set is not the one this profile, candidate set and project revision have');

  const rejections: PlanRejection[] = [];
  const reject = (code: PlanRejectionCode, ref: string | null): void => {
    if (!rejections.some((entry) => entry.code === code && entry.ref === ref)) rejections.push({ code, ref });
  };
  const candidates = new Map<string, DeterministicCandidate>([...contracts.candidates, ...resolution.derivedCandidates].map((candidate) => [candidate.candidateRef, candidate]));
  const expectedRefs = new Set(recomputed.candidates.map((candidate) => candidate.candidateRef));

  // ------------------------------------------------------------------------------------- the candidates: each decided once
  const decisions = Array.isArray(selection.candidates) ? (selection.candidates as readonly unknown[]) : [];
  const byRef = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const entry of decisions) {
    const ref = isObject(entry) ? asString(entry['candidateRef']) : null;
    if (ref === null || !isObject(entry)) {
      reject('INVENTED_CANDIDATE', null);
      continue;
    }
    byRef.set(ref, [...(byRef.get(ref) ?? []), entry]);
  }
  for (const ref of [...byRef.keys()].sort(compare)) {
    if (!expectedRefs.has(ref)) reject('INVENTED_CANDIDATE', ref);
    else if ((byRef.get(ref) ?? []).length > 1) reject('DUPLICATE_CANDIDATE', ref);
  }
  for (const ref of [...expectedRefs].sort(compare)) if (!byRef.has(ref)) reject('MISSING_CANDIDATE', ref);

  const fields: FieldPlan[] = [];
  const preserved: ColumnPlan[] = [];
  const identities: IdentityPlan[] = [];
  for (const ref of [...byRef.keys()].sort(compare)) {
    const entries = byRef.get(ref) ?? [];
    const candidate = candidates.get(ref);
    const decision = entries[0];
    if (candidate === undefined || !expectedRefs.has(ref) || entries.length !== 1 || decision === undefined) continue;
    const choice = decision['choice'];
    if (!isObject(choice) || !['MAP', 'IDENTIFY', 'PRESERVE', 'DECLINE'].includes(String(choice['action']))) {
      reject('RATIONALE_IS_NOT_AUTHORITY', ref);
      continue;
    }
    const action = String(choice['action']);
    if (action === 'DECLINE') continue;
    // Every other choice acts on the candidate's one source column.
    const fieldRef = candidate.sourceRefs.length === 1 ? candidate.sourceRefs[0] : undefined;
    if (fieldRef === undefined || !contracts.refs.fieldByRef.has(fieldRef)) {
      reject('PRIMITIVE_OUTSIDE_INTERSECTION', ref);
      continue;
    }
    if (action === 'PRESERVE') {
      preserved.push({ decisionRef: ref, candidateRefs: [ref], origin: 'AGENCY_SELECTION', rule: 'AGENCY_PRESERVE', evidenceRefs: candidate.evidenceRefs, fieldRef });
      continue;
    }
    if (action === 'IDENTIFY') {
      const primitive = asString(choice['primitive']);
      if (primitive === null || !(IDENTITY_PRIMITIVES as readonly string[]).includes(primitive) || !candidate.allowedPrimitiveRefs.includes(primitive)) {
        reject('PRIMITIVE_OUTSIDE_INTERSECTION', ref);
        continue;
      }
      identities.push({ candidateRef: ref, fieldRef, primitive: primitive as (typeof IDENTITY_PRIMITIVES)[number] });
      continue;
    }
    // MAP: a target, a semantic type and a primitive, all inside the candidate's intersection and the catalogue.
    const targetRef = asString(choice['targetRef']);
    const semanticType = asString(choice['semanticType']);
    const primitive = choice['primitive'] === null || choice['primitive'] === undefined ? null : asString(choice['primitive']);
    const named = primitive ?? 'PRESERVE_AS_IS';
    const target = targetRef === null ? undefined : contracts.refs.targetByRef.get(targetRef);
    const rawParams = choice['typedTransformParams'];
    const params = isObject(rawParams) ? Object.fromEntries(Object.entries(rawParams).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : null;
    const spec = Object.hasOwn(PRIMITIVES, named) ? PRIMITIVES[named as keyof typeof PRIMITIVES] : undefined;
    const paramsInside = params === null || Object.entries(params).every(([key, value]) => (spec?.params as readonly string[] | undefined)?.includes(key) === true && (PRIMITIVE_PARAM_DOMAINS[key]?.test(value) ?? false));
    if (target === undefined || targetRef === null || !candidate.allowedTargetRefs.includes(targetRef) || semanticType === null || spec === undefined || spec.destructive || !(spec.semanticTypes as readonly string[]).includes(semanticType) || !candidate.allowedPrimitiveRefs.includes(named) || !paramsInside) {
      reject('PRIMITIVE_OUTSIDE_INTERSECTION', ref);
      continue;
    }
    fields.push({ decisionRef: ref, candidateRefs: [ref], origin: 'AGENCY_SELECTION', rule: 'AGENCY_MAP', evidenceRefs: candidate.evidenceRefs, fieldRef, targetRef, destinationField: target.destinationField, semanticType, primitive, params: params !== null && Object.keys(params).length > 0 ? params : null });
  }

  // ------------------------------------------------------------ the deterministic decisions: each with the audit's evidence
  const accepted = Array.isArray(selection.deterministic) ? (selection.deterministic as readonly unknown[]) : [];
  const seen = new Set<string>();
  const originalsOn = (fieldRef: string): readonly string[] => contracts.candidates.filter((candidate) => candidate.sourceRefs.includes(fieldRef)).map((candidate) => candidate.candidateRef);
  for (const entry of [...accepted].sort((a, b) => compare(isObject(a) ? String(a['decisionRef']) : '', isObject(b) ? String(b['decisionRef']) : ''))) {
    const decisionRef = isObject(entry) ? asString(entry['decisionRef']) : null;
    const rule = isObject(entry) ? asString(entry['rule']) : null;
    if (decisionRef === null || rule === null) {
      reject('EVIDENCE_MISSING', decisionRef);
      continue;
    }
    if (seen.has(decisionRef)) {
      reject('DUPLICATE_CANDIDATE', decisionRef);
      continue;
    }
    seen.add(decisionRef);
    const decision: ResolvedDecision | undefined = resolution.decisions.find((candidate) => candidate.decisionRef === decisionRef);
    const kind = decision === undefined ? undefined : DECISION_KIND_FRAGMENT[decision.kind];
    // The audit's evidence for the decision: of this revision of the set, deterministic, for this decision and this rule, of the fragment's kind.
    const entries = Array.isArray(evidence.entries) ? evidence.entries : [];
    const proof = evidence.expectedSetHash === recomputed.expectedSetHash ? entries.find((candidate) => typeof candidate === 'object' && candidate !== null && candidate.decisionRef === decisionRef && candidate.origin === 'DETERMINISTIC' && candidate.rule === rule) : undefined;
    if (proof === undefined || (decision !== undefined && (decision.rule !== rule || (kind !== undefined && proof.fragmentKind !== kind)))) {
      reject('EVIDENCE_MISSING', decisionRef);
      continue;
    }
    if (decision === undefined || kind === undefined) {
      // Evidence for a decision no resolver of this input made, or one that yields no fragment (an identity proof, a semantic type): nothing to accept.
      reject('INVENTED_CANDIDATE', decisionRef);
      continue;
    }
    if (kind === 'PRESERVED_COLUMN') {
      preserved.push({ decisionRef, candidateRefs: originalsOn(decision.fieldRef), origin: 'DETERMINISTIC', rule, evidenceRefs: decision.evidenceRefs, fieldRef: decision.fieldRef });
      continue;
    }
    const target = decision.targetRef === null ? undefined : contracts.refs.targetByRef.get(decision.targetRef);
    if (decision.targetRef === null || target === undefined || target.destinationField === '') {
      reject('INVENTED_CANDIDATE', decisionRef);
      continue;
    }
    fields.push({ decisionRef, candidateRefs: originalsOn(decision.fieldRef), origin: 'DETERMINISTIC', rule, evidenceRefs: decision.evidenceRefs, fieldRef: decision.fieldRef, targetRef: decision.targetRef, destinationField: target.destinationField, semanticType: decision.semanticType ?? 'TEXT', primitive: null, params: null });
  }

  // ------------------------------------------------------------------------- claims: a column and a destination, once each
  fields.sort((a, b) => compare(a.decisionRef, b.decisionRef));
  const claimedColumn = new Set<string>();
  const claimedTarget = new Set<string>();
  const kept: FieldPlan[] = [];
  for (const field of fields) {
    const info = contracts.refs.fieldByRef.get(field.fieldRef);
    if (info === undefined) continue;
    const object = field.destinationField.split('.')[0] ?? 'contact';
    const scope = `${recordMappingIdOf(info.fileId, object)}|${field.destinationField}`;
    if (claimedColumn.has(field.fieldRef) || claimedTarget.has(scope)) {
      reject('DUPLICATE_CANDIDATE', field.decisionRef);
      continue;
    }
    claimedColumn.add(field.fieldRef);
    claimedTarget.add(scope);
    kept.push(field);
  }
  // One record id per file; an identity on a file the plan maps nothing from has no record mapping to belong to.
  const recordFiles = new Set(kept.map((field) => contracts.refs.fieldByRef.get(field.fieldRef)?.fileId));
  const recordIdOfFile = new Map<string, IdentityPlan>();
  for (const identity of [...identities].sort((a, b) => compare(a.candidateRef, b.candidateRef))) {
    const info = contracts.refs.fieldByRef.get(identity.fieldRef);
    if (info === undefined || !recordFiles.has(info.fileId)) {
      reject('PRIMITIVE_OUTSIDE_INTERSECTION', identity.candidateRef);
      continue;
    }
    if (identity.primitive === 'SOURCE_RECORD_ID_COLUMN') {
      if (recordIdOfFile.has(info.fileId)) reject('DUPLICATE_CANDIDATE', identity.candidateRef);
      else recordIdOfFile.set(info.fileId, identity);
    }
  }
  if (rejections.length > 0) return { ok: false, rejections: [...rejections].sort((a, b) => PLAN_REJECTION_CODES.indexOf(a.code) - PLAN_REJECTION_CODES.indexOf(b.code) || compare(a.ref ?? '', b.ref ?? '')) };

  // -------------------------------------------------------------------------------------------------- the configuration
  const allowedValuesOf = (targetRef: string, semanticType: string): readonly string[] | undefined => {
    if (semanticType !== 'ENUM' || contracts.contractView.mode === 'CLEAN_ONLY') return undefined;
    const options = contracts.contractView.fields.find((field) => field.targetRef === targetRef)?.options ?? [];
    return options.length > 0 ? [...options] : undefined;
  };
  const configFields: ConfigFragmentField[] = kept.map((field) => {
    const info = contracts.refs.fieldByRef.get(field.fieldRef) as NonNullable<ReturnType<typeof contracts.refs.fieldByRef.get>>;
    const object = field.destinationField.split('.')[0] ?? 'contact';
    const allowedValues = allowedValuesOf(field.targetRef, field.semanticType);
    return { recordId: recordMappingIdOf(info.fileId, object), fileId: info.fileId, filePath: info.filePath, object: object.toUpperCase(), columnHeader: info.header, columnLocator: info.locator, destinationField: field.destinationField, semanticType: field.semanticType, required: false, onInvalid: 'PRESERVE', onAmbiguous: 'PRESERVE', transformPrimitive: field.primitive, typedTransformParams: field.params, ...(allowedValues === undefined ? {} : { allowedValues }), decisionRef: field.decisionRef, fragmentHash: '' };
  });
  const records: ConfigFragmentRecord[] = [];
  const recordDecisions: { readonly decisionRef: string; readonly candidateRefs: readonly string[]; readonly evidenceRefs: readonly string[] }[] = [];
  for (const field of configFields) {
    if (records.some((record) => record.recordId === field.recordId)) continue;
    const identity = recordIdOfFile.get(field.fileId);
    const identityInfo = identity === undefined ? undefined : contracts.refs.fieldByRef.get(identity.fieldRef);
    const external = identities.filter((entry) => entry.primitive === 'AUTHORITATIVE_EXTERNAL_ID_COLUMN' && contracts.refs.fieldByRef.get(entry.fieldRef)?.fileId === field.fileId).sort((a, b) => compare(a.candidateRef, b.candidateRef));
    const decisionRef = `dec_${digestOf(['record', field.recordId, field.object]).slice(0, 16)}`;
    records.push({ recordId: field.recordId, fileId: field.fileId, filePath: field.filePath, object: field.object, sourceRecordIdColumn: identityInfo === undefined ? null : { columnLocator: identityInfo.locator }, authoritativeExternalIdColumns: external.map((entry) => ({ columnLocator: (contracts.refs.fieldByRef.get(entry.fieldRef) as { readonly locator: string }).locator })), identitySpace: null, decisionRef, fragmentHash: '' });
    recordDecisions.push({ decisionRef, candidateRefs: [...(identity === undefined ? [] : [identity.candidateRef]), ...external.map((entry) => entry.candidateRef)], evidenceRefs: configFields.filter((entry) => entry.recordId === field.recordId).map((entry) => entry.decisionRef) });
  }
  // A preserved column is a leftover only when no field and no identity reads it.
  const identityLocators = new Set(records.flatMap((record) => [record.sourceRecordIdColumn, ...record.authoritativeExternalIdColumns]).flatMap((column) => (column === null ? [] : [column.columnLocator])));
  const preservedColumns: ConfigFragmentColumn[] = [];
  const preservedPlans: ColumnPlan[] = [];
  for (const column of [...preserved].sort((a, b) => compare(a.decisionRef, b.decisionRef))) {
    const info = contracts.refs.fieldByRef.get(column.fieldRef);
    if (info === undefined || identityLocators.has(info.locator) || configFields.some((field) => field.columnLocator === info.locator) || preservedColumns.some((entry) => entry.columnLocator === info.locator)) continue;
    preservedColumns.push({ fileId: info.fileId, filePath: info.filePath, columnLocator: info.locator, decisionRef: column.decisionRef, fragmentHash: '' });
    preservedPlans.push(column);
  }
  const fragments = { records, fields: configFields, associations: [], preservedColumns, excludedColumns: [] };
  const draft: CandidateConfiguration = { configurationRef: `cfg_${digestOf({ ...fragments, profile: contracts.profileHash }).slice(0, 16)}`, mode: input.projectRevision.mode, profileHash: contracts.profileHash, candidateSetHash: contracts.candidateSetHash, targetContractHash: contracts.targetContractHash, ...fragments };

  // ----------------------------------------------------------------------------------------- sealed on what Migration Core loads
  const sealed = sealConfiguration(draft, input.sourceProfile);
  if (!sealed.ok) {
    // A fragment the frozen schema cannot express is outside what any candidate may be compiled to; the rest is a selection no check above could name.
    const unsupported = sealed.problems.filter((problem) => problem.startsWith('UNSUPPORTED_BY_CORE:'));
    if (unsupported.length > 0 && unsupported.length === sealed.problems.length) {
      return { ok: false, rejections: unsupported.map((problem): PlanRejection => ({ code: 'PRIMITIVE_OUTSIDE_INTERSECTION', ref: problem.includes('@') ? problem.slice(problem.lastIndexOf('@') + 1) : null })).sort((a, b) => compare(a.ref ?? '', b.ref ?? '')) };
    }
    throw new IntelligenceError('INVALID_SEMANTICS', 'the selection compiles to a configuration Migration Core cannot take whole', { problems: sealed.problems });
  }
  const configuration = sealed.sealed.configuration;
  const pointerOf = (kind: FragmentKind, index: number): string | null => sealed.sealed.coverage.find((entry) => entry.kind === kind && entry.index === index)?.pointer ?? null;
  const evidenceOf: PlanFragmentEvidence[] = [
    ...configuration.records.map((record, index): PlanFragmentEvidence => {
      const decision = recordDecisions[index] as (typeof recordDecisions)[number];
      return { fragmentKind: 'RECORD', decisionRef: record.decisionRef, origin: 'COMPILED_STRUCTURE', rule: 'RECORD_MAPPING_OF_FIELDS', candidateRefs: decision.candidateRefs, evidenceRefs: decision.evidenceRefs, fragmentHash: record.fragmentHash, pointer: pointerOf('RECORD', index) };
    }),
    ...configuration.fields.map((field, index): PlanFragmentEvidence => {
      const plan = kept[index] as FieldPlan;
      return { fragmentKind: 'FIELD', decisionRef: field.decisionRef, origin: plan.origin, rule: plan.rule, candidateRefs: plan.candidateRefs, evidenceRefs: plan.evidenceRefs, fragmentHash: field.fragmentHash, pointer: pointerOf('FIELD', index) };
    }),
    ...configuration.preservedColumns.map((column, index): PlanFragmentEvidence => {
      const plan = preservedPlans[index] as ColumnPlan;
      return { fragmentKind: 'PRESERVED_COLUMN', decisionRef: column.decisionRef, origin: plan.origin, rule: plan.rule, candidateRefs: plan.candidateRefs, evidenceRefs: plan.evidenceRefs, fragmentHash: column.fragmentHash, pointer: null };
    }),
  ];
  return { ok: true, configuration, configurationDigest: digestOf(configuration), coreConfigHash: sealed.sealed.coreConfigHash, fragments: evidenceOf };
}

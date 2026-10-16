/**
 * Library boundary.
 *
 * A host application drives the core through these three entry points and the
 * artifacts they produce. Nothing below this line is part of the supported
 * surface.
 */
export { inspectBundle, inspectionToJson, renderInspectionMarkdown } from './profile/inspect.js';
export type { InspectionReport, FileProfile, SheetProfile, ColumnProfile } from './profile/inspect.js';

export { loadConfig } from './mapping/load-config.js';
export type { LoadedConfig } from './mapping/load-config.js';

export { runMigration } from './run/run-migration.js';
export type { RunInput, RunResult } from './run/run-migration.js';

// A package is written to a staging directory, verified there, and only then
// promoted. All four steps are public because a host that can write one and
// cannot publish it has been handed half a capability — which is what the
// public-consumer test found when only `writePackage` was exported.
export {
  writePackage,
  writeAndPromotePackage,
  promotePackage,
  discardStagedPackage,
  listPackageFiles,
  MANIFEST_FILE,
} from './artifacts/write-package.js';
export type { WritePackageInput, WritePackageResult, WrittenArtifact } from './artifacts/write-package.js';

export { verifyPackage } from './verify/verify-package.js';
export type { VerificationReport, VerificationProblem, VerifyOptions } from './verify/verify-package.js';

export { computeReconciliation } from './reconcile/reconcile.js';
export type { Reconciliation } from './reconcile/reconcile.js';

export { MigrationError, ERROR_CODES } from './domain/errors.js';
export type { ErrorCode } from './domain/errors.js';
export { REASON_CODES, REASON_CODE_LIST, isReasonCode, reasonCodeDescription } from './domain/reason-codes.js';
export type { ReasonCode } from './domain/reason-codes.js';
export { ROW_DISPOSITIONS, EDGE_DISPOSITIONS } from './domain/disposition.js';
export type { RowDisposition, EdgeDisposition } from './domain/disposition.js';
export { CANONICAL_FIELDS, CANONICAL_FIELD_LIST, CANONICAL_OBJECTS } from './domain/canonical.js';
export { getAdapter, ALL_ADAPTERS } from './adapters/specs.js';
export type { DestinationAdapter } from './adapters/adapter.js';
export { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_REGISTRY_VERSION } from './version.js';

// The contracts Intelligence Core builds against. Versioned, hashable, and read
// only through the loaders below, which refuse anything that is not one.
export {
  SOURCE_PROFILE_VERSION,
  SOURCE_PROFILE_SCHEMA,
  buildSourceProfile,
  produceSourceProfile,
  serializeSourceProfile,
  loadSourceProfile,
  hashSourceProfile,
  sourceProfileToJson,
  assertProfileDescribesBundle,
  profileInvariantProblems,
  readConfigOf,
} from './profile/source-profile.js';
export type {
  SourceProfileV1,
  HashedSourceProfile,
  FileStatistics,
  SheetStatistics,
  ColumnStatistics,
  ProfileReadConfig,
  BuildSourceProfileInput,
} from './profile/source-profile.js';
export {
  CANDIDATE_SET_VERSION,
  CANDIDATE_TYPES,
  CANDIDATE_SET_SCHEMA,
  DEFAULT_CANDIDATE_LIMIT,
  buildCandidateSet,
  serializeCandidateSet,
  loadCandidateSet,
  hashCandidateSet,
  candidatesOf,
  assertCandidateSetMatches,
} from './profile/candidate-set.js';
export type { CandidateSetV1, CandidateV1, CandidateType, CandidateSetRefs, HashedCandidateSet, CandidateSetExpectation } from './profile/candidate-set.js';
export { syntheticConfig } from './profile/inspect.js';

// The scratch store a host injects, and the resource contract in bytes.
export { createFilesystemScratchStore } from './scratch/filesystem-scratch-store.js';
export type { FilesystemScratchOptions } from './scratch/filesystem-scratch-store.js';
export { SCRATCH_STORE_CONTRACT_VERSION } from './scratch/scratch-store.js';
export type { ScratchStore, ScratchUsage } from './scratch/scratch-store.js';
export {
  FOUNDING_V1,
  HARD_MEMORY_LIMIT_BYTES,
  MEMORY_BUDGET_BYTES,
  HARD_SCRATCH_LIMIT_BYTES,
  SCRATCH_BUDGET_BYTES,
  WALL_CLOCK_LIMIT_MS,
} from './domain/resource-profile.js';

// The target contract and its attestation, and the support envelope.
export {
  TARGET_CONTRACT_VERSION,
  TARGET_PARSER_VERSION,
  hashTargetContract,
  loadTargetContract,
  serializeTargetContract,
} from './target/contract.js';
export type { TargetContract, HashedTargetContract, TargetFieldContract, TargetObjectContract } from './target/contract.js';
export {
  ATTESTATION_CONTRACT_VERSION,
  ATTESTATION_ALGORITHM,
  parseTargetAttestation,
  parseAttestationAuthorities,
  verifyAttestation,
} from './target/attestation.js';
export type { TargetAttestation, AttestationAuthority } from './target/attestation.js';
export { CONFIG_SCHEMA_VERSION, TARGET_MODES } from './domain/config.js';
export type { MigrationConfig, TargetMode } from './domain/config.js';
export { IMPORT_MODES } from './domain/canonical.js';
export type { CanonicalObject, ImportMode } from './domain/canonical.js';
export { RELATIONSHIP_TYPES, RELATIONSHIP_SHAPES } from './domain/associations.js';
export type { RelationshipType } from './domain/associations.js';
export { packageDigest, PACKAGE_DIGEST_VERSION } from './artifacts/package-digest.js';

/**
 * A future intelligence layer may propose mapping or transformation rules. It
 * never edits rows. A proposal has to survive validation against the full
 * dataset by this core before it can become part of a configuration, and the
 * core has no code path that accepts a value from a proposal directly.
 *
 * This interface is declared, not implemented. There is no model in this
 * repository and no network call anywhere in the engine.
 */
export interface RuleProposal {
  readonly proposedBy: string;
  readonly rationale: string;
  /** A configuration fragment. It is validated by the same closed schema as a hand-written configuration. */
  readonly configurationFragment: unknown;
}

export interface AcceptedRule {
  readonly outcome: 'ACCEPTED';
  readonly proposal: RuleProposal;
  /** Every source row the rule was checked against. Sampling is not permitted here. */
  readonly rowsValidated: number;
}

export interface RejectedRule {
  readonly outcome: 'REJECTED';
  readonly proposal: RuleProposal;
  readonly reasons: readonly string[];
}

export type RuleValidationOutcome = AcceptedRule | RejectedRule;

// The vocabularies a proposal is checked against. Intelligence Core names a
// value intent (PRESERVE, SET, CLEAR, OMIT), a transformation kind, a semantic
// type and an identity rule version; the names it may use are these, read from
// the package rather than declared a second time somewhere they could drift.
// Only the root entry is exported, so anything not listed here does not exist
// for a consumer.
export { VALUE_INTENT_KINDS, OMIT_REASONS, intentFor, intendedValue, carriesValue, isDestructive, renderIntent } from './domain/value-intent.js';
export type { ValueIntent, ValueIntentKind, OmitReason } from './domain/value-intent.js';
export { TRANSFORM_KINDS, NON_COMMITTAL_KINDS, SAFETY_CLASSES, isMaterialChange, needsReview } from './domain/transform.js';
export type { TransformKind, SafetyClass, TransformResult, TransformEvidence } from './domain/transform.js';
export { SEMANTIC_TYPES, FIELD_SEMANTICS_CLASSES, CUSTOM_FIELD_PREFIX, isCanonicalField, isCustomField, customFieldLabel } from './domain/canonical.js';
export type { SemanticType, FieldSemanticsClass, CanonicalFieldDefinition, CanonicalFieldName, DestinationFieldRef } from './domain/canonical.js';
export { IDENTITY_RULE_VERSION } from './identity/resolve-identity.js';
export type { IdentityResult, ResolvedRecord, RecordMember, ResolvedValue } from './identity/resolve-identity.js';
// Where a written package puts things, so a consumer can find the trace of a
// row without knowing the layout by heart.
export { IMPORT_AREA, EXCEPTIONS_AREA, TRACEABILITY_AREA, DOCUMENTATION_AREA, MANIFEST_PATH, packagePath, logicalName, placedArtifactNames } from './artifacts/layout.js';

// Enough of the target contract and its attestation for a host to construct
// one for a synthetic instance and sign it, not only to verify one: the
// signing bytes are the canonical serialisation, and a host that had to
// reproduce them would be a second copy of this contract.
export { attestationSigningBytes, TARGET_ATTESTATION_SCHEMA, ATTESTATION_AUTHORITIES_SCHEMA } from './target/attestation.js';
export type { AttestationArtifactRef, AttestationExpectation, AttestationVerification, VerifyAttestationInput } from './target/attestation.js';
export { TARGET_EVIDENCE_KINDS, TARGET_FLAGS } from './target/contract.js';
export type { TargetEvidenceKind, TargetFlag, TargetPicklistValue, TargetRecordType, TargetPipeline, TargetPipelineStage, TargetInstanceIdentity, TargetArtifactRef } from './target/contract.js';
export { candidateRefOf, candidateSetInvariantProblems, SOURCE_REFS_PER_CANDIDATE } from './profile/candidate-set.js';
export { PROFILE_SHAPE_NAMES } from './profile/source-profile.js';

/**
 * The host boundary, canon §100: what the host supplies and what it is
 * handed back. The core receives DTOs and handles, never storage, queues,
 * credentials or a path to open a file. The validation port is the seam
 * through which a candidate configuration is applied to the whole dataset
 * with Migration Core's semantics — by the host, never by this core.
 */
import type { HashedCandidateSet, HashedSourceProfile, HashedTargetContract, TargetMode } from 'kauro-migration-core';

import { MIGRATION_EFFECTS_SCHEMA } from '../adapter/migration-effects.js';
import type { MigrationEffects } from '../adapter/migration-effects.js';
import type { CategoricalSummaries } from '../envelope/envelope-builder.js';
import type { ModelGateway, ModelPolicy } from '../gateway/model-gateway.js';
import type { DispatchAdmission, ModelTariff } from '../kernel/admission.js';
import type { Clock, LedgerStore } from '../kernel/ledger.js';
import type { LocaleEvidence } from '../contracts/proposal.js';
import type { MemoryEntry } from '../contracts/run.js';
import { CONTRACT_HASH_PATTERN, HEX64_PATTERN, INSTANT_PATTERN, VERSION_PATTERN, s } from '../contracts/schema.js';
import type { Schema } from '../contracts/schema.js';

export interface HostContext {
  /** Authenticated by the host; an id in a payload grants nothing. */
  readonly tenant: { readonly agencyId: string; readonly clientId: string };
  readonly actor: string;
  /**
   * The logical identity of this AuditAttempt, minted by the host once per
   * attempt the agency asked for. A redelivery of the same attempt carries the
   * same id and finds its run; a new attempt the agency authorised carries a
   * new one. Time is never part of a run's identity. The id names one content
   * — revision, hashes, versions — for good: the same id with other content
   * is refused as IDENTITY_CONFLICT before anything is spent.
   */
  readonly auditAttemptId: string;
  /**
   * The audit's interpretation deadline, an ISO instant (on the platform: the
   * audit's creation + 1,200 s). With the policy's twenty minutes and the
   * resource profile it fixes the run's semantic deadline, the earliest of
   * them, after which nothing is reserved or dispatched (D3-TIME-1). Absent,
   * the policy alone decides; a value that is not an instant fails the run's
   * contract before anything is spent.
   */
  readonly interpretationDeadlineAt?: string;
  /**
   * The audit's absolute deadline, an ISO instant (on the platform: the
   * audit's creation + 86,400 s). With twenty-four hours from the run's start
   * it fixes the absolute deadline, the earlier of the two, after which the
   * run is never promoted: DEADLINE_EXCEEDED (D3-TIME-1).
   */
  readonly absoluteDeadlineAt?: string;
}

export interface ProjectRevision {
  readonly projectRevisionId: string;
  readonly projectRevisionHash: string;
  readonly mode: TargetMode;
  readonly supportEnvelopeVersion: string;
  /**
   * The canonical object each source file is declared to hold, by the path the
   * profile recorded — an authorised fact of the project, set up by the
   * agency, never inferred by the model. A file with no declaration gets its
   * object resolved deterministically when the headers make it unambiguous,
   * and an OBJECT_MAPPING question otherwise.
   */
  readonly declaredObjects?: Readonly<Record<string, 'CONTACT' | 'COMPANY' | 'DEAL' | 'LEAD'>>;
  /**
   * The source record id column each file is declared to carry, by the path
   * the profile recorded — the identity Migration Core itself runs the file
   * on, declared by the project and never inferred. It is the only authority
   * that makes a source column a PROVEN_UNIQUE_IDENTIFIER in CLEAN_ONLY; a
   * unique email, phone or name declared here is still a signal, not a proof.
   */
  readonly recordIdColumns?: Readonly<Record<string, string>>;
  /**
   * How the project's data is written, as the agency declares it (D3-CAP-04):
   * the region its local phone numbers are dialled in (an ISO 3166-1 alpha-2
   * country) and the date format its dates are written in (one of Migration
   * Core's date formats). The only evidence a phone region or a date format
   * can stand on — never inferred from a header, a value or a geography. A
   * member outside its closed domain fails the run's contract before
   * anything is spent.
   */
  readonly localeEvidence?: LocaleEvidence;
}

export interface ResourceProfile {
  /** The semantic window the host asks for, in milliseconds: at most the policy's twenty minutes. It can only shorten the window; one above the policy, or not a positive integer, fails the run's contract before anything is spent (D3-TIME-1). */
  readonly wallClockMs?: number;
}

export interface IntelligenceInput {
  readonly projectRevision: ProjectRevision;
  readonly sourceProfile: HashedSourceProfile;
  readonly candidateSet: HashedCandidateSet;
  readonly targetContract: HashedTargetContract | null;
  readonly scopedMemorySnapshot: readonly MemoryEntry[];
  /** Low-cardinality values the host extracted per column locator; the only path a value has into this core. */
  readonly categoricalSummaries?: CategoricalSummaries;
  readonly policyBundle: { readonly modelPolicyVersion: string; readonly promptBundleVersion: string };
  readonly resourceProfile: ResourceProfile;
}

/** The kinds of fragment a CandidateConfiguration is made of (D3-CFG-1). */
export const FRAGMENT_KINDS = Object.freeze(['RECORD', 'FIELD', 'ASSOCIATION', 'PRESERVED_COLUMN', 'EXCLUDED_COLUMN'] as const);
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

/**
 * What every fragment names (D3-CFG-1): the decision that put it in the
 * configuration — a resolver decision ref, or the candidate ref a compiled
 * proposal answered — whose DecisionEvidence the draft carries, and the
 * fragment hash: the digest of the element Migration Core's own loader
 * makes of the fragment in the document `toMigrationConfig` produces, bound
 * to its kind (a field to its record mapping, a record without its fields;
 * a column fragment, which is no element of the document, to its file and
 * locator). The receipt's effects name what Migration Core consumed by the
 * same hash, so a fragment and its effect meet on it.
 */
export interface ConfigFragmentIdentity {
  readonly decisionRef: string;
  readonly fragmentHash: string;
}

/**
 * A source column no field maps — an identity column, a key column, a
 * preserved or excluded one — by the locator of its physical position alone.
 * Its header stays out of the fragment: only a field names the header it
 * maps, as the handover to Migration Core; an unmapped column's header is
 * nobody's to carry.
 */
export interface ConfigColumnRef {
  readonly columnLocator: string;
}

/**
 * One record mapping: the file, the canonical object its rows are delivered
 * as, and the identity Migration Core runs the file on — the record id
 * column the project declares for it and nothing inferred, the authoritative
 * external id columns (CAP06), and the identity space (null: the record
 * mapping's own).
 */
export interface ConfigFragmentRecord extends ConfigFragmentIdentity {
  readonly recordId: string;
  readonly fileId: string;
  readonly filePath: string;
  readonly object: string;
  readonly sourceRecordIdColumn: ConfigColumnRef | null;
  readonly authoritativeExternalIdColumns: readonly ConfigColumnRef[];
  readonly identitySpace: string | null;
}

/** What Migration Core does with a value its semantic type cannot interpret or reads two ways: keep it and flag it, or set the row aside. */
export type ValuePolicy = 'PRESERVE' | 'ISOLATE_ROW';

/**
 * One field mapping the compiler emits: a MigrationConfig fragment the host
 * applies. Every member is authorised content the host must carry into
 * Migration Core's configuration — the column by its locator (the physical
 * index the profile recorded, not only the header, which may repeat), the
 * destination, the semantic type, whether the migration contract requires
 * it, the value policies, and the typed options: the primitive with its
 * closed parameters, the value map and the allowed values. A fragment the
 * frozen configuration schema cannot express is refused by
 * `toMigrationConfig` as UNSUPPORTED_BY_CORE, never dropped on the way.
 */
export interface ConfigFragmentField extends ConfigFragmentIdentity {
  readonly recordId: string;
  /** The profile's file id and the path it profiled, so the host can name the file in its own configuration. */
  readonly fileId: string;
  readonly filePath: string;
  readonly object: string;
  readonly columnHeader: string;
  readonly columnLocator: string;
  readonly destinationField: string;
  readonly semanticType: string;
  /** Required by the migration contract: Migration Core sets aside a row that lacks it (CAP10). */
  readonly required: boolean;
  readonly onInvalid: ValuePolicy;
  readonly onAmbiguous: ValuePolicy;
  readonly transformPrimitive: string | null;
  readonly typedTransformParams: Readonly<Record<string, string>> | null;
  /**
   * For an ENUM destination, the options of the target field as the attested
   * contract lists them — what Migration Core's configuration needs as
   * `allowedValues` so a value outside the set is reported, never accepted
   * silently. Present exactly when the semantic type is ENUM; copied from the
   * contract, never from the source values or the proposal.
   */
  readonly allowedValues?: readonly string[];
  /** Exact source values and the target option each becomes (CAP05): `from` from the host's summaries, `to` among the allowed values. */
  readonly valueMap?: readonly { readonly from: string; readonly to: string }[];
}

/**
 * One association (CAP08): the rows of one record mapping carry, in a key
 * column, the source record id of a row of another; Migration Core resolves
 * the edges and reports the endpoints it cannot find.
 */
export interface ConfigFragmentAssociation extends ConfigFragmentIdentity {
  /** Migration Core's association id, an identifier of its configuration schema. */
  readonly associationId: string;
  /** The record mapping whose rows carry the key column. */
  readonly recordId: string;
  readonly relationshipType: string;
  /** Which end of the relationship the owning row sits on. */
  readonly ownerSide: 'FROM' | 'TO';
  readonly keyColumn: ConfigColumnRef;
  readonly targetRecordId: string;
  readonly targetMatchKey: 'SOURCE_RECORD_ID';
}

/** A column kept out of every field, by its locator: preserved (Migration Core accounts each value as an unmapped leftover) or excluded (only by the agency). */
export interface ConfigFragmentColumn extends ConfigFragmentIdentity, ConfigColumnRef {
  readonly fileId: string;
  readonly filePath: string;
}

/**
 * CandidateConfiguration 2.0.0 (D3-CFG-1): records per file, fields,
 * associations, preserved and excluded columns — every fragment naming its
 * decision and its fragment hash. `toMigrationConfig` makes the whole
 * Migration Core document of it with the profile's files, and the host
 * validates exactly that document.
 */
export interface CandidateConfiguration {
  readonly configurationRef: string;
  readonly mode: TargetMode;
  readonly profileHash: string;
  readonly candidateSetHash: string;
  readonly targetContractHash: string | null;
  readonly records: readonly ConfigFragmentRecord[];
  readonly fields: readonly ConfigFragmentField[];
  readonly associations: readonly ConfigFragmentAssociation[];
  readonly preservedColumns: readonly ConfigFragmentColumn[];
  readonly excludedColumns: readonly ConfigFragmentColumn[];
}

/**
 * What the host's validation port answers. Typed and bound: the hashes it
 * validated against, the exact bytes of the configuration it applied, the
 * rows it covered, every problem, and references to what Migration Core
 * produced. The core validates this receipt against a closed schema and
 * against what it knows — the configuration it handed over, the profile's
 * row count, the run's start, the supported core version — and a receipt
 * that fails any of it blocks the draft. A port returning `ok: true` with no
 * rows validated is a stub and is refused.
 *
 * The port is a trust boundary of the host (threat T21). A host that forges
 * every fact — hashes, counts, digests and evidence alike — cannot be
 * caught by any check on the receipt's shape or consistency; what these
 * checks catch is a defective, stale or partial adapter, which is the
 * realistic failure. The evidence references exist for the other case: an
 * auditor with access to the host's package store can check that the
 * package and report the receipt names were really produced from the
 * configuration the run compiled.
 */
export interface FullDatasetValidationResult {
  readonly ok: boolean;
  readonly configurationRef: string;
  /** digestOf(configuration) as the port received it: the receipt names the exact configuration bytes, not only a ref. */
  readonly configurationDigest: string;
  readonly profileHash: string;
  readonly candidateSetHash: string;
  readonly targetContractHash: string | null;
  readonly rowsValidated: number;
  readonly rowsInProfile: number;
  readonly reconciliationHolds: boolean;
  readonly packageVerified: boolean;
  readonly problems: readonly string[];
  /**
   * When the host validated, by the clock it hands this core: not before the
   * run was created and not after that clock's now, with no tolerance. The
   * host and the core share one clock discipline across this boundary; a
   * receipt dated by another clock is refused (VALIDATION_AFTER_NOW).
   */
  readonly validatedAt: string;
  readonly coreVersion: string;
  /**
   * What Migration Core produced, by digest, so what really ran can be
   * checked outside this core. Null where nothing was produced — which a
   * verified verdict cannot claim: ok or packageVerified with no package
   * digest or no report digest is VALIDATION_RECEIPT_INCONSISTENT.
   */
  readonly evidence: {
    /** The package manifest's sha256 as Migration Core wrote it. */
    readonly packageDigest: string | null;
    /** digestOf the verifier's report, path excluded. */
    readonly reportDigest: string | null;
    /**
     * Migration Core's own hash of the configuration the host loaded: its
     * loader's hash of the document `toMigrationConfig` produced from the
     * configuration. Required when the verdict is ok or the package verified,
     * and equal to the hash the core's own loading of that document gives
     * (B03-R11); null only where nothing ran.
     */
    readonly coreConfigHash: string | null;
  };
  /**
   * What Migration Core did with each fragment it consumed, computed by
   * `effectsFromMigrationRun` from its own run truth: closed and
   * payload-free — ids, locators, destinations, counts and fragment hashes,
   * never a header or a value. Required with a verified verdict; null only
   * where nothing ran (D3-CFG-3).
   */
  readonly effects: MigrationEffects | null;
}

const hex64 = s.string({ pattern: HEX64_PATTERN });
const contractHash = s.string({ pattern: CONTRACT_HASH_PATTERN });
const counter = s.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/** The receipt's closed shape: every member present and typed, counts finite integers, instants and versions well-formed. */
export const FULL_DATASET_VALIDATION_RESULT_SCHEMA: Schema = s.object({
  ok: s.boolean(),
  configurationRef: s.string({ nonBlank: true, maxLength: 128 }),
  configurationDigest: hex64,
  profileHash: contractHash,
  candidateSetHash: contractHash,
  targetContractHash: s.nullable(contractHash),
  rowsValidated: counter,
  rowsInProfile: counter,
  reconciliationHolds: s.boolean(),
  packageVerified: s.boolean(),
  problems: s.array(s.string({ maxLength: 512 }), { maxItems: 4096 }),
  validatedAt: s.string({ pattern: INSTANT_PATTERN }),
  coreVersion: s.string({ pattern: VERSION_PATTERN }),
  evidence: s.object({ packageDigest: s.nullable(hex64), reportDigest: s.nullable(hex64), coreConfigHash: s.nullable(contractHash) }),
  effects: s.nullable(MIGRATION_EFFECTS_SCHEMA),
});

export interface FullDatasetValidationPort {
  validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult>;
}

/**
 * The attempt's egress key (D3-KEY-1), from the host's secret store: durable
 * per AuditAttempt and the same on every redelivery of it. Masked labels,
 * scoped references and the egress token are keyed by the secret, so the same
 * attempt under the same key rebuilds the same requests and finds its stored
 * answers. The run records the key id, never the secret; a reopening under
 * another key is IDENTITY_CONFLICT. There is no default: a core without a
 * key does not run.
 */
export interface EgressKey {
  readonly keyId: string;
  /** At least 32 bytes of key material. */
  readonly secret: Buffer;
}

export interface CoreDependencies {
  readonly gateway: ModelGateway;
  readonly validationPort: FullDatasetValidationPort;
  readonly ledgerStore: LedgerStore;
  readonly clock: Clock;
  /** Payload-free telemetry: counters and codes only. */
  readonly telemetry?: (event: { readonly runId: string; readonly kind: string; readonly counters: Readonly<Record<string, number>>; readonly codes: readonly string[] }) => void;
  /** The attempt's egress key; required — the core has no default key. */
  readonly egressKey: EgressKey;
  /** The model policy this core runs under: the pinned policy when absent; otherwise one of the SHIPPED candidate policies, which the pilot of a campaign names to compare candidates (D4-CAMP-1). Any other policy is refused at construction. */
  readonly candidatePolicy?: ModelPolicy;
  /** The host's money admission: every invocation is admitted at its maximum charge before its send starts, and settled after (D3-GRANT-1). */
  readonly dispatchAdmission: DispatchAdmission;
  /** The host model profile's tariff the maximum charge and every charge are priced by. */
  readonly tariff: ModelTariff;
  /** Waits between transport retries; a test injects one that moves the virtual clock instead of sleeping. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Names this process in the ledger's lease, for the record; generated per core instance when absent. It is not the owner: the owner of an attempt is one run() invocation, by a token the ledger mints for it, so two cores — or two run() calls on one core — never share ownership by sharing a name. */
  readonly workerId?: string;
  /**
   * A repeating timer of the host's: `ticker(intervalMs, onTick)` starts it and
   * returns what stops it. The core renews its lease on it while it waits on
   * the provider or on the host's validation, so a call longer than the lease
   * does not lose the attempt to a takeover. setInterval when absent; a test
   * injects one it fires by hand on the virtual clock.
   */
  readonly ticker?: (intervalMs: number, onTick: () => void) => () => void;
}

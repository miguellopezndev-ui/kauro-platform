import { MigrationError } from '../domain/errors.js';
import type { CanonicalFieldName, CanonicalObject, ImportMode } from '../domain/canonical.js';
import type { RelationshipType } from '../domain/associations.js';
import type { TargetMode } from '../domain/config.js';

/**
 * Destination adapters.
 *
 * Everything destination-specific lives behind this interface. The adapter
 * states what the destination accepts generically, cites the official page that
 * establishes it, and names what cannot be decided without the customer's own
 * instance. It never changes what the core believes the source data means.
 *
 * What an adapter states is what the vendor's documentation establishes for
 * anybody. What is true of one portal or one org — which properties exist, which
 * pipeline a stage belongs to, whether a field is unique — is not an adapter
 * fact and is never assumed here.
 */

export interface VendorFieldSpec {
  readonly canonicalField: CanonicalFieldName;
  /** Column header written into the import file, exactly as the destination expects it. */
  readonly header: string;
  readonly maxLength: number | null;
}

export interface VendorObjectSpec {
  readonly object: CanonicalObject;
  /** File name, relative to the adapter's import directory. */
  readonly fileName: string;
  readonly fields: readonly VendorFieldSpec[];
  /** Fields the destination requires to create a record. */
  readonly requiredForCreate: readonly CanonicalFieldName[];
  /** Groups where at least one member must be present, such as company name or domain. */
  readonly requiredAnyOf: readonly (readonly CanonicalFieldName[])[];
  /**
   * Fields the destination itself uses to decide two rows are the same record,
   * regardless of the import mode. Two distinct source identities that share a
   * value here would be silently merged by the destination.
   *
   * These are the vendor's documented defaults for any instance. An instance can
   * match on more than this — a unique custom property, an org duplicate rule —
   * and that is a target-contract fact, not an adapter one.
   */
  readonly destinationMatchingKeys: readonly CanonicalFieldName[];
  readonly supportedModes: readonly ImportMode[];
  readonly notes: readonly string[];
}

export type RelationshipSupport =
  | { readonly kind: 'SUPPORTED'; readonly strategy: string; readonly operatorInstructions: string }
  | { readonly kind: 'UNSUPPORTED'; readonly reason: string };

export interface FileConstraints {
  readonly delimiter: ',';
  readonly lineEnding: 'LF';
  readonly encoding: 'UTF-8';
  readonly headerRowRequired: true;
  /** Null where the documentation states no per-file row cap. */
  readonly maxRowsPerFile: number | null;
  readonly maxFileBytes: number;
  /** Null where no column cap is documented. */
  readonly maxColumnsPerFile: number | null;
  /** Byte cap on one field value, where the vendor states the limit in bytes. */
  readonly maxFieldBytes: number | null;
  /** Character cap on one field value. */
  readonly maxFieldCharacters: number | null;
  /** Character cap on the header row taken as a whole. */
  readonly maxHeaderRowCharacters: number | null;
}

export interface SourceRegistryRef {
  readonly url: string;
  readonly reviewedOn: string;
  readonly scope: string;
}

export interface InstanceVerificationItem {
  readonly scope: string;
  readonly detail: string;
  readonly sourceUrl: string;
}

/**
 * Whether, and how, this destination can be told to empty a field it already
 * holds a value for.
 *
 * There is no universal blank-means-clear. A blank cell in a HubSpot import file
 * leaves the existing value exactly where it was, so emitting one for an
 * authorized clear would ship a file that quietly does nothing while the package
 * claims the value was removed. A destination that cannot express it says so,
 * and the engine refuses rather than pretends.
 */
export type ClearRepresentation =
  | {
      readonly kind: 'EXPLICIT_TOKEN';
      /**
       * The exact cell text meaning "remove this value". Used only where Kauro
       * owns the file format, so the token is part of the contract rather than a
       * guess about somebody else's importer.
       */
      readonly token: string;
      readonly documentation: string;
    }
  | { readonly kind: 'NOT_REPRESENTABLE'; readonly reason: string; readonly sourceUrl: string };

export interface DestinationAdapter {
  /** The commercial mode this adapter shapes for. */
  readonly mode: TargetMode;
  /** Directory inside the package that holds this mode's import files. */
  readonly importDirectory: string;
  readonly version: string;
  readonly fileConstraints: FileConstraints;
  /**
   * Column header carrying the import-scoped association key, on the object
   * files whose object takes part in a relationship this run delivers.
   *
   * It exists for one reason: this destination associates two records by a
   * column both of their files carry. It is not the Kauro trace key -- the
   * trace key never leaves 03_TRACEABILITY, because 01_IMPORT holds only what
   * the destination needs -- and it is never a destination matching key. An
   * object with no relationship in the plan gets no such column at all.
   */
  readonly associationKeyHeader: string;
  readonly associationFromHeader: string;
  readonly associationToHeader: string;
  readonly booleanText: { readonly trueText: string; readonly falseText: string };
  /** How an authorized CLEAR reaches this destination, or why it cannot. */
  readonly clearRepresentation: ClearRepresentation;
  readonly objects: readonly VendorObjectSpec[];
  readonly relationships: Readonly<Record<RelationshipType, RelationshipSupport>>;
  readonly instanceVerification: readonly InstanceVerificationItem[];
  readonly sources: readonly SourceRegistryRef[];
  /** Header used for a field the destination does not define, which the operator must create first. */
  customFieldHeader(label: string): string;
}

export function objectSpec(adapter: DestinationAdapter, object: CanonicalObject): VendorObjectSpec | null {
  return adapter.objects.find((spec) => spec.object === object) ?? null;
}

export function requireObjectSpec(
  adapter: DestinationAdapter,
  object: CanonicalObject,
  where: string,
): VendorObjectSpec {
  const spec = objectSpec(adapter, object);
  if (spec === null) {
    throw new MigrationError(
      'DESTINATION_OBJECT_UNSUPPORTED',
      `${adapter.mode} does not support importing ${object} through file import inside the V1 support envelope`,
      `Remove the ${object} record mapping, or choose a mode that supports it. The source registry lists the pages reviewed.`,
      { mode: adapter.mode, object, where },
    );
  }
  return spec;
}

export function vendorHeader(spec: VendorObjectSpec, field: CanonicalFieldName): VendorFieldSpec | null {
  return spec.fields.find((candidate) => candidate.canonicalField === field) ?? null;
}

import { MigrationError } from './errors.js';

/**
 * The canonical model.
 *
 * Core truth does not change because the destination is HubSpot, Salesforce or
 * no CRM at all. Configuration maps source columns onto these canonical fields;
 * adapters map canonical fields onto destination column headers. Nothing in the
 * engine below the adapter layer knows a destination name.
 */

/**
 * The objects the V1 support envelope covers.
 *
 * LEAD is a first-class object, not a Contact under another name: it carries its
 * own identity space, its own migration-key namespace and its own field family,
 * so a Lead and a Contact that share an email address are two records rather
 * than one. Activities are not here. The engine supports no activity object for
 * any destination, so there is no canonical type for one to be shaped from.
 */
export const CANONICAL_OBJECTS = ['CONTACT', 'COMPANY', 'DEAL', 'LEAD'] as const;
export type CanonicalObject = (typeof CANONICAL_OBJECTS)[number];

export const IMPORT_MODES = ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/**
 * Semantic type of a source column. It selects the transformation, and nothing
 * else: it never authorizes a destructive operation on its own.
 */
export const SEMANTIC_TYPES = [
  'TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  'DATETIME',
  'NUMBER',
  'IDENTIFIER',
  'BOOLEAN',
  'ENUM',
  'URL',
] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

/**
 * Fields carrying consent, privacy or suppression meaning. When two rows proven
 * to be one record disagree on one of these, the engine never picks a winner —
 * choosing the less restrictive value would be a compliance failure.
 */
export const FIELD_SEMANTICS_CLASSES = ['STANDARD', 'CONSENT'] as const;
export type FieldSemanticsClass = (typeof FIELD_SEMANTICS_CLASSES)[number];

export interface CanonicalFieldDefinition {
  readonly object: CanonicalObject;
  readonly semanticsClass: FieldSemanticsClass;
  readonly description: string;
}

const FIELDS = {
  // ---------------------------------------------------------------- CONTACT
  'contact.email': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Primary email address.' },
  'contact.firstName': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Given name.' },
  'contact.lastName': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Family name.' },
  'contact.phone': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Primary telephone number.' },
  'contact.phoneExtension': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Telephone extension.' },
  'contact.mobilePhone': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Mobile telephone number.' },
  'contact.jobTitle': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Job title.' },
  'contact.companyName': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Employer name as written on the contact.' },
  'contact.website': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Web address.' },
  'contact.addressLine1': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Street address.' },
  'contact.city': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'City.' },
  'contact.state': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'State, province or region.' },
  'contact.postalCode': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Postal code.' },
  'contact.country': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Country.' },
  'contact.ownerEmail': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Email address of the owning user.' },
  'contact.lifecycleStage': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Lifecycle or lead stage.' },
  'contact.description': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'Free-text notes on the contact.' },
  'contact.createdAt': { object: 'CONTACT', semanticsClass: 'STANDARD', description: 'When the record was created in the source system.' },
  'contact.marketingConsent': { object: 'CONTACT', semanticsClass: 'CONSENT', description: 'Whether the person consented to marketing contact.' },
  'contact.doNotEmail': { object: 'CONTACT', semanticsClass: 'CONSENT', description: 'Whether the person must not be emailed.' },
  'contact.doNotCall': { object: 'CONTACT', semanticsClass: 'CONSENT', description: 'Whether the person must not be called.' },

  // ---------------------------------------------------------------- COMPANY
  'company.name': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Company name.' },
  'company.domain': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Primary web domain.' },
  'company.phone': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Main telephone number.' },
  'company.website': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Web address.' },
  'company.addressLine1': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Street address.' },
  'company.city': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'City.' },
  'company.state': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'State, province or region.' },
  'company.postalCode': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Postal code.' },
  'company.country': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Country.' },
  'company.industry': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Industry.' },
  'company.employeeCount': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Number of employees.' },
  'company.annualRevenue': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Annual revenue.' },
  'company.description': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Free-text notes on the company.' },
  'company.ownerEmail': { object: 'COMPANY', semanticsClass: 'STANDARD', description: 'Email address of the owning user.' },

  // ------------------------------------------------------------------- DEAL
  'deal.name': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Deal or opportunity name.' },
  'deal.amount': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Monetary amount.' },
  'deal.currency': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'ISO 4217 currency code for the amount.' },
  'deal.closeDate': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Expected or actual close date.' },
  'deal.stage': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Pipeline stage.' },
  'deal.pipeline': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Pipeline name.' },
  'deal.ownerEmail': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Email address of the owning user.' },
  'deal.description': { object: 'DEAL', semanticsClass: 'STANDARD', description: 'Free-text notes on the deal.' },

  // ------------------------------------------------------------------- LEAD
  // A Lead is an unconverted enquiry. It is not a Contact: it carries the
  // company name on itself rather than through a relationship, and Salesforce
  // requires that name to create one.
  'lead.lastName': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Family name.' },
  'lead.firstName': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Given name.' },
  'lead.company': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Company the lead belongs to, carried on the lead itself.' },
  'lead.email': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Primary email address.' },
  'lead.phone': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Primary telephone number.' },
  'lead.mobilePhone': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Mobile telephone number.' },
  'lead.jobTitle': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Job title.' },
  'lead.website': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Web address.' },
  'lead.addressLine1': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Street address.' },
  'lead.city': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'City.' },
  'lead.state': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'State, province or region.' },
  'lead.postalCode': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Postal code.' },
  'lead.country': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Country.' },
  'lead.status': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Lead status. The value set belongs to the destination instance.' },
  'lead.leadSource': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'How the lead arrived. The value set belongs to the destination instance.' },
  'lead.rating': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Lead rating. The value set belongs to the destination instance.' },
  'lead.industry': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Industry.' },
  'lead.employeeCount': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Number of employees.' },
  'lead.annualRevenue': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Annual revenue.' },
  'lead.description': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Free-text notes on the lead.' },
  'lead.ownerEmail': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'Email address of the owning user.' },
  'lead.createdAt': { object: 'LEAD', semanticsClass: 'STANDARD', description: 'When the record was created in the source system.' },
  'lead.doNotCall': { object: 'LEAD', semanticsClass: 'CONSENT', description: 'Whether the person must not be called.' },
  'lead.doNotEmail': { object: 'LEAD', semanticsClass: 'CONSENT', description: 'Whether the person must not be emailed.' },
} as const satisfies Record<string, CanonicalFieldDefinition>;

export type CanonicalFieldName = keyof typeof FIELDS;

export const CANONICAL_FIELDS: Readonly<Record<CanonicalFieldName, CanonicalFieldDefinition>> = FIELDS;

export const CANONICAL_FIELD_LIST: readonly CanonicalFieldName[] = (
  Object.keys(FIELDS) as CanonicalFieldName[]
).sort();

/** Prefix for fields the destination does not define natively. The suffix is used verbatim as the destination column header. */
export const CUSTOM_FIELD_PREFIX = 'custom:';

export type DestinationFieldRef = CanonicalFieldName | `${typeof CUSTOM_FIELD_PREFIX}${string}`;

export function isCanonicalField(name: string): name is CanonicalFieldName {
  return Object.prototype.hasOwnProperty.call(FIELDS, name);
}

export function isCustomField(name: string): name is `${typeof CUSTOM_FIELD_PREFIX}${string}` {
  return name.startsWith(CUSTOM_FIELD_PREFIX) && name.length > CUSTOM_FIELD_PREFIX.length;
}

export function customFieldLabel(name: string): string {
  return name.slice(CUSTOM_FIELD_PREFIX.length);
}

export function fieldSemanticsClass(name: string): FieldSemanticsClass {
  return isCanonicalField(name) ? FIELDS[name].semanticsClass : 'STANDARD';
}

/**
 * The class a field actually carries, given what the configuration declared.
 *
 * A declaration may only raise protection. If it could lower it, the consent
 * guard would be switchable from the configuration file: declaring
 * `semanticsClass: "STANDARD"` on `contact.doNotEmail` would let
 * PREFER_SURVIVOR pick the less restrictive of two disagreeing consent values,
 * which is the exact failure the guard exists to prevent.
 */
export function effectiveSemanticsClass(
  name: string,
  declared: FieldSemanticsClass | null,
): FieldSemanticsClass {
  return fieldSemanticsClass(name) === 'CONSENT' || declared === 'CONSENT' ? 'CONSENT' : 'STANDARD';
}

/** Object a destination field belongs to. Custom fields inherit the object of the record mapping that declares them. */
export function canonicalFieldObject(name: CanonicalFieldName): CanonicalObject {
  return FIELDS[name].object;
}

export function assertFieldBelongsToObject(
  name: string,
  object: CanonicalObject,
  where: string,
): void {
  if (!isCanonicalField(name)) {
    if (!isCustomField(name)) {
      throw new MigrationError(
        'DESTINATION_FIELD_UNKNOWN',
        `"${name}" is not a canonical field and does not use the "${CUSTOM_FIELD_PREFIX}" prefix`,
        `Use one of the canonical field names, or prefix a destination-specific field with "${CUSTOM_FIELD_PREFIX}".`,
        { field: name, where },
      );
    }
    return;
  }
  const owner = FIELDS[name].object;
  if (owner !== object) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `field "${name}" belongs to ${owner} but was mapped on a ${object} record`,
      `Move this field mapping to a ${owner} record mapping, or choose a ${object} field.`,
      { field: name, expectedObject: object, actualObject: owner, where },
    );
  }
}

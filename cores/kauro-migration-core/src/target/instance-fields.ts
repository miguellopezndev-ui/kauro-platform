import type { CanonicalFieldName, CanonicalObject } from '../domain/canonical.js';
import { customFieldLabel, isCanonicalField, isCustomField } from '../domain/canonical.js';
import type { TargetMode } from '../domain/config.js';
import type { VendorObjectSpec } from '../adapters/adapter.js';
import { vendorHeader } from '../adapters/adapter.js';
import type { TargetFieldContract, TargetObjectContract } from './contract.js';

/**
 * How a destination field the plan names is found in a captured contract.
 *
 * An adapter names a field the way the vendor's import file wants it spelled:
 * HubSpot's column header is the property label ("First name"), Salesforce's is
 * the API name ("FirstName"). A contract names a field the way the instance
 * answers to it: HubSpot's internal name ("firstname"), Salesforce's API name.
 * The two are different spellings of one field, and the fold from one to the
 * other is written down here once rather than guessed at the point of use.
 *
 * A custom field is addressed by the label the plan gave it, verbatim: that is
 * the column header the importer will see, and the importer resolves it against
 * the property's label or its internal name. The contract is asked the same
 * question.
 */

/**
 * The HubSpot internal name of every canonical field the HubSpot adapter
 * delivers. These are HubSpot's default property names, which are the same in
 * every portal; the label a portal shows for them can be translated, the
 * internal name cannot.
 */
export const HUBSPOT_INTERNAL_NAMES: Readonly<Partial<Record<CanonicalFieldName, string>>> = {
  'contact.email': 'email',
  'contact.firstName': 'firstname',
  'contact.lastName': 'lastname',
  'contact.phone': 'phone',
  'contact.mobilePhone': 'mobilephone',
  'contact.jobTitle': 'jobtitle',
  'contact.companyName': 'company',
  'contact.website': 'website',
  'contact.addressLine1': 'address',
  'contact.city': 'city',
  'contact.state': 'state',
  'contact.postalCode': 'zip',
  'contact.country': 'country',
  'contact.ownerEmail': 'hubspot_owner_id',
  'contact.lifecycleStage': 'lifecyclestage',
  'company.name': 'name',
  'company.domain': 'domain',
  'company.phone': 'phone',
  'company.website': 'website',
  'company.addressLine1': 'address',
  'company.city': 'city',
  'company.state': 'state',
  'company.postalCode': 'zip',
  'company.country': 'country',
  'company.industry': 'industry',
  'company.employeeCount': 'numberofemployees',
  'company.annualRevenue': 'annualrevenue',
  'company.description': 'description',
  'company.ownerEmail': 'hubspot_owner_id',
  'deal.name': 'dealname',
  'deal.amount': 'amount',
  'deal.currency': 'deal_currency_code',
  'deal.closeDate': 'closedate',
  'deal.stage': 'dealstage',
  'deal.pipeline': 'pipeline',
  'deal.ownerEmail': 'hubspot_owner_id',
  'deal.description': 'description',
};

/** The contract object api name a fixture or a capture uses for a canonical object, per mode. */
export const INSTANCE_OBJECT_API_NAMES: Readonly<Record<'HUBSPOT' | 'SALESFORCE', Readonly<Record<CanonicalObject, string>>>> = {
  HUBSPOT: { CONTACT: 'contact', COMPANY: 'company', DEAL: 'deal', LEAD: 'lead' },
  SALESFORCE: { CONTACT: 'Contact', COMPANY: 'Account', DEAL: 'Opportunity', LEAD: 'Lead' },
};

export interface InstanceFieldNames {
  /** Names the instance may answer to for this field, compared without case. */
  readonly apiNames: readonly string[];
  /** Labels the instance may show for this field, compared without case. Weaker than a name; consulted second. */
  readonly labels: readonly string[];
}

/**
 * The spellings under which a destination field of the plan is looked up in
 * the instance's contract.
 *
 * Returns null for a canonical field the adapter has no column for; that is
 * the adapter's refusal to make, and it is made before this is asked.
 */
export function instanceFieldNames(
  mode: TargetMode,
  spec: VendorObjectSpec,
  destinationField: string,
): InstanceFieldNames | null {
  if (isCustomField(destinationField)) {
    const label = customFieldLabel(destinationField);
    return { apiNames: [label], labels: [label] };
  }
  if (!isCanonicalField(destinationField)) return null;
  const header = vendorHeader(spec, destinationField);
  if (header === null) return null;
  if (mode === 'HUBSPOT') {
    const internal = HUBSPOT_INTERNAL_NAMES[destinationField];
    return { apiNames: internal === undefined ? [] : [internal], labels: [header.header] };
  }
  if (mode === 'SALESFORCE') {
    return { apiNames: [header.header], labels: [header.header] };
  }
  return null;
}

/**
 * The one contract field a destination field resolves to, or null.
 *
 * The api name decides first and the label second, both without case, because
 * both destinations resolve a name without case. Two contract fields answering
 * to the same spelling is a capture that contradicts itself, and nothing is
 * chosen between them.
 */
export function resolveInstanceField(
  object: TargetObjectContract,
  names: InstanceFieldNames,
): { readonly kind: 'FOUND'; readonly field: TargetFieldContract } | { readonly kind: 'NONE' } | { readonly kind: 'AMBIGUOUS'; readonly fields: readonly TargetFieldContract[] } {
  const byName = object.fields.filter((field) => names.apiNames.some((name) => sameName(name, field.apiName)));
  if (byName.length === 1 && byName[0] !== undefined) return { kind: 'FOUND', field: byName[0] };
  if (byName.length > 1) return { kind: 'AMBIGUOUS', fields: byName };
  const byLabel = object.fields.filter((field) => names.labels.some((label) => sameName(label, field.label)));
  if (byLabel.length === 1 && byLabel[0] !== undefined) return { kind: 'FOUND', field: byLabel[0] };
  if (byLabel.length > 1) return { kind: 'AMBIGUOUS', fields: byLabel };
  return { kind: 'NONE' };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

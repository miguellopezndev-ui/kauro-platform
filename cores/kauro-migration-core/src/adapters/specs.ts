import { MigrationError } from '../domain/errors.js';
import type { TargetMode } from '../domain/config.js';
import type { RelationshipType } from '../domain/associations.js';
import { RELATIONSHIP_TYPES } from '../domain/associations.js';
import { CANONICAL_FIELD_LIST } from '../domain/canonical.js';
import type { CanonicalFieldName, CanonicalObject } from '../domain/canonical.js';
import type { DestinationAdapter, RelationshipSupport, VendorFieldSpec, VendorObjectSpec } from './adapter.js';

/**
 * Destination specifications.
 *
 * Every header, required field and limit below is traceable to a page listed in
 * docs/SOURCE_REGISTRY.md. Where official documentation does not establish a
 * behaviour, the object or field is marked unsupported rather than guessed at.
 *
 * The support envelope here is narrower than the documentation permits, and
 * deliberately so. The HubSpot import tool can load notes, calls, meetings and
 * tasks; this engine does not offer them, because the product does not sell
 * them. That a vendor allows something is not a reason to promise it.
 */

const REVIEWED_ON = '2026-09-01';
/** The source N1-1 added, for the Data Loader step the import instructions describe (D78). */
const N1_REVIEWED_ON = '2026-10-22';

function field(canonicalField: CanonicalFieldName, header: string, maxLength: number | null = null): VendorFieldSpec {
  return { canonicalField, header, maxLength };
}

/** Every relationship in the V1 surface, supported the same way. */
function allRelationships(
  strategy: string,
  operatorInstructions: string,
): Record<RelationshipType, RelationshipSupport> {
  return Object.fromEntries(
    RELATIONSHIP_TYPES.map((type) => [
      type,
      { kind: 'SUPPORTED', strategy, operatorInstructions } as RelationshipSupport,
    ]),
  ) as Record<RelationshipType, RelationshipSupport>;
}

// ----------------------------------------------------------------- CLEAN_ONLY

/**
 * The mode with no destination instance.
 *
 * It emits the canonical model itself: cleaned, reconciled, fully traced, and
 * addressed to nobody's CRM. It is not a fourth CRM and must never be presented
 * as one — there is no portal to verify against, no property to pre-create, and
 * no import wizard at the other end.
 */
const CLEAN_ONLY_FILE_NAMES: Readonly<Record<CanonicalObject, string>> = {
  CONTACT: 'contacts.csv',
  COMPANY: 'companies.csv',
  DEAL: 'deals.csv',
  LEAD: 'leads.csv',
};

const CLEAN_ONLY_OBJECTS: VendorObjectSpec[] = (
  ['CONTACT', 'COMPANY', 'DEAL', 'LEAD'] as const
).map((object) => ({
  object,
  fileName: CLEAN_ONLY_FILE_NAMES[object],
  fields: CANONICAL_FIELD_LIST.filter((name) => name.startsWith(`${object.toLowerCase()}.`)).map((name) =>
    field(name, name),
  ),
  requiredForCreate: [],
  requiredAnyOf: [],
  destinationMatchingKeys: [],
  supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
  notes: ['Vendor-neutral output. There is no destination instance, so no destination-side matching happens.'],
}));

const CLEAN_ONLY_ADAPTER: DestinationAdapter = {
  mode: 'CLEAN_ONLY',
  importDirectory: 'clean-only',
  version: '1.0.0',
  fileConstraints: {
    delimiter: ',',
    lineEnding: 'LF',
    encoding: 'UTF-8',
    headerRowRequired: true,
    maxRowsPerFile: 5_000_000,
    maxFileBytes: 1_073_741_824,
    maxColumnsPerFile: 1_000,
    maxFieldBytes: null,
    maxFieldCharacters: null,
    maxHeaderRowCharacters: null,
  },
  associationKeyHeader: 'association_key',
  associationFromHeader: 'from_association_key',
  associationToHeader: 'to_association_key',
  booleanText: { trueText: 'true', falseText: 'false' },
  // Kauro owns this format, so it can say "empty this" without borrowing a
  // convention from an importer that does not have one. An empty cell keeps
  // meaning "this row said nothing about the field", which is what makes the
  // token necessary: without it the cleaned file cannot tell a source blank, an
  // omission and an authorized clear apart, and the whole point of the mode is
  // that its output is exact.
  clearRepresentation: {
    kind: 'EXPLICIT_TOKEN',
    token: '[KAURO:CLEAR]',
    documentation:
      'A cell holding exactly [KAURO:CLEAR] means the plan authorized removing the value the destination holds for that field. An empty cell means this row said nothing about the field. The two are different instructions and the file keeps them apart.',
  },
  objects: CLEAN_ONLY_OBJECTS,
  relationships: allRelationships(
    'TRACE_KEY_PAIR',
    'Each association file lists one row per relationship, addressed by the association key on both sides. The same key appears in the object files, so the two can be joined without either of them carrying Kauro trace identity. Nothing is imported anywhere; the pair is the delivered representation of the edge.',
  ),
  instanceVerification: [],
  sources: [
    {
      url: 'internal://clean-only-target',
      reviewedOn: REVIEWED_ON,
      scope:
        'Vendor-neutral output. Not a CRM import format; used for cleaning without a destination and for cross-target comparison.',
    },
  ],
  customFieldHeader: (label) => label,
};

// -------------------------------------------------------------------- HubSpot

const HUBSPOT_ADAPTER: DestinationAdapter = {
  mode: 'HUBSPOT',
  importDirectory: 'hubspot',
  version: '2.0.0',
  fileConstraints: {
    delimiter: ',',
    lineEnding: 'LF',
    encoding: 'UTF-8',
    headerRowRequired: true,
    // "Import up to 10,000,000 rows per day, with a limit of 1,048,576 rows per file"
    maxRowsPerFile: 1_048_576,
    // 512 MB on paid tiers; 20 MB on free tools, which is an account-level fact.
    maxFileBytes: 536_870_912,
    // "Contain fewer than 1,000 columns."
    maxColumnsPerFile: 999,
    maxHeaderRowCharacters: null,
    // "a cell or row that contains more than 1 MB of data" fails. The limit is
    // stated in bytes, so it is measured in bytes.
    maxFieldBytes: 1_048_576,
    maxFieldCharacters: null,
  },
  associationKeyHeader: 'Association Key',
  associationFromHeader: 'Association Key',
  associationToHeader: 'Associated Association Key',
  booleanText: { trueText: 'True', falseText: 'False' },
  // HubSpot's own documentation is explicit that the import tool skips blank
  // cells rather than treating them as an instruction to erase, so there is no
  // spelling of "remove this value" available through file import. A package
  // that emitted a blank and called it a clear would be making a claim the
  // import cannot carry out.
  clearRepresentation: {
    kind: 'NOT_REPRESENTABLE',
    reason:
      'HubSpot file import ignores blank cells for properties that already hold a value, so no cell content can instruct it to erase one.',
    sourceUrl: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
  },
  objects: [
    {
      object: 'CONTACT',
      fileName: 'contacts.csv',
      fields: [
        field('contact.email', 'Email'),
        field('contact.firstName', 'First name'),
        field('contact.lastName', 'Last name'),
        field('contact.phone', 'Phone number'),
        field('contact.mobilePhone', 'Mobile phone number'),
        field('contact.jobTitle', 'Job title'),
        field('contact.companyName', 'Company name'),
        field('contact.website', 'Website URL'),
        field('contact.addressLine1', 'Street address'),
        field('contact.city', 'City'),
        field('contact.state', 'State/Region'),
        field('contact.postalCode', 'Postal code'),
        field('contact.country', 'Country/Region'),
        field('contact.ownerEmail', 'Contact owner'),
        field('contact.lifecycleStage', 'Lifecycle stage'),
      ],
      requiredForCreate: ['contact.email'],
      requiredAnyOf: [],
      destinationMatchingKeys: ['contact.email'],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: [
        'HubSpot deduplicates contacts by email address on import regardless of the selected mode, so two different people sharing an address would be merged by the destination.',
        'Select the import mode in the import wizard; the file cannot declare it.',
      ],
    },
    {
      object: 'COMPANY',
      fileName: 'companies.csv',
      fields: [
        field('company.name', 'Name'),
        field('company.domain', 'Company domain name'),
        field('company.phone', 'Phone number'),
        field('company.website', 'Website URL'),
        field('company.addressLine1', 'Street address'),
        field('company.city', 'City'),
        field('company.state', 'State/Region'),
        field('company.postalCode', 'Postal code'),
        field('company.country', 'Country/Region'),
        field('company.industry', 'Industry'),
        field('company.employeeCount', 'Number of employees'),
        field('company.annualRevenue', 'Annual revenue'),
        field('company.description', 'Description'),
        field('company.ownerEmail', 'Company owner'),
      ],
      requiredForCreate: [],
      requiredAnyOf: [['company.name', 'company.domain']],
      destinationMatchingKeys: ['company.domain'],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: [
        'Companies require at least one of Name or Company domain name.',
        'Primary and secondary company domain values are used to deduplicate companies on import.',
      ],
    },
    {
      object: 'DEAL',
      fileName: 'deals.csv',
      fields: [
        field('deal.name', 'Deal name'),
        field('deal.amount', 'Amount'),
        field('deal.currency', 'Currency'),
        field('deal.closeDate', 'Close date'),
        field('deal.stage', 'Deal stage'),
        field('deal.pipeline', 'Pipeline'),
        field('deal.ownerEmail', 'Deal owner'),
        field('deal.description', 'Deal description'),
      ],
      requiredForCreate: ['deal.name', 'deal.pipeline', 'deal.stage'],
      requiredAnyOf: [],
      destinationMatchingKeys: [],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: [
        'Pipeline and Deal stage must match options that already exist in the portal, and the stage must belong to that pipeline. Neither is ever assumed: both come from the captured pipeline artifact.',
      ],
    },
  ],
  relationships: allRelationships(
    'TWO_FILE_COMMON_COLUMN',
    'Run a multiple-object import. Add the key column from the association file to both object files as a common column, then select it in the "Common column headers found in your files" menu. Association labels are outside the V1 support envelope, so a two-file import without labels is what this package expects.',
  ),
  instanceVerification: [
    {
      scope: 'ENUMERATIONS',
      detail:
        'Values for enumeration properties such as Lifecycle stage and Industry must match an option that already exists in the portal, by label or by internal value.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
    },
    {
      scope: 'MULTI_CURRENCY',
      detail:
        'The deal Currency property only appears once more than one currency is configured, and needs a Starter, Professional or Enterprise subscription.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
    },
    {
      scope: 'PROPERTIES',
      detail:
        'Every column header must correspond to a property that already exists in the portal. Kauro does not create properties and does not require the portal to carry a Kauro-specific one.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
    },
    {
      scope: 'PIPELINES',
      detail:
        'Deal Pipeline and Deal Stage values must match existing options, and the stage must belong to the named pipeline. No default pipeline or stage is assumed.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
    },
    {
      scope: 'OWNERS',
      detail: 'Owner values must resolve to exactly one active HubSpot user.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors',
    },
    {
      scope: 'SUBSCRIPTION',
      detail: 'File size, rows per day and rows per file depend on the portal subscription tier.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
    },
    {
      scope: 'EXISTING_RECORDS',
      detail:
        'Whether an email or company domain already exists in the portal, and whether it exists more than once, cannot be seen from files alone.',
      sourceUrl: 'https://knowledge.hubspot.com/records/deduplication-of-records',
    },
    {
      scope: 'IMPORT_MODE',
      detail:
        'The mode (create only, update only, create and update), the date format and the column-header language are chosen by the operator in the import wizard and cannot be declared by the file.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/import-records-for-a-single-object',
    },
    {
      // Established against portal 51872453 on 2026-09-02, not read anywhere.
      // The API answers "Mismatching number of columns" if a column is left out
      // of the mapping and "Must specify property name for column X" if it is
      // mapped without a property. Six other spellings of an ignore flag were
      // tried and every one was refused or answered with a 500.
      scope: 'IMPORT_API',
      detail:
        'The CRM Imports API requires every column in the file to map to an existing property; unlike the import wizard, it has no "Don\'t import column". The Association Key column must therefore be removed before importing through the API, which also means the API path cannot associate two files. It is never mapped to a property: the association key is a join key for one import, not data belonging in the portal.',
      sourceUrl: 'https://developers.hubspot.com/docs/api/crm/imports',
    },
    {
      // Also established against a real portal, and it surprised this
      // repository's own fixtures: they use @example addresses throughout.
      scope: 'EMAIL_AND_DOMAIN_VALIDATION',
      detail:
        'The portal validates email addresses and company domains and refuses the reserved test top-level domains .example, .test, .invalid and .localhost. Source data using them imports as an error per row, not as a stored value.',
      sourceUrl: 'https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors',
    },
  ],
  sources: [
    {
      url: 'https://knowledge.hubspot.com/import-and-export/set-up-your-import-file',
      reviewedOn: REVIEWED_ON,
      scope:
        'File format, sheet and column limits, required properties per object, value formatting, association files.',
    },
    {
      url: 'https://knowledge.hubspot.com/import-and-export/understand-the-import-tool',
      reviewedOn: REVIEWED_ON,
      scope: 'Which objects can be created and which can be updated; unique identifier precedence.',
    },
    {
      url: 'https://knowledge.hubspot.com/import-and-export/import-objects',
      reviewedOn: REVIEWED_ON,
      scope: 'Multiple-object import and common column selection.',
    },
    {
      url: 'https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors',
      reviewedOn: REVIEWED_ON,
      scope: 'Documented import error classes, including duplicate identifier handling.',
    },
    {
      url: 'https://knowledge.hubspot.com/records/deduplication-of-records',
      reviewedOn: REVIEWED_ON,
      scope: 'Destination-side deduplication by email and company domain.',
    },
    {
      url: 'https://knowledge.hubspot.com/import-and-export/sample-import-files',
      reviewedOn: REVIEWED_ON,
      scope: 'Two-file association imports and the common-column requirement.',
    },
    {
      url: 'https://knowledge.hubspot.com/properties/hubspots-default-contact-properties',
      reviewedOn: REVIEWED_ON,
      scope: 'The exact labels of the default contact properties this adapter writes as column headers.',
    },
    {
      url: 'https://knowledge.hubspot.com/properties/hubspot-crm-default-company-properties',
      reviewedOn: REVIEWED_ON,
      scope: 'The exact labels of the default company properties this adapter writes as column headers.',
    },
    {
      url: 'https://knowledge.hubspot.com/properties/hubspots-default-deal-properties',
      reviewedOn: REVIEWED_ON,
      scope: 'The exact labels of the default deal properties this adapter writes as column headers.',
    },
  ],
  customFieldHeader: (label) => label,
};

// ----------------------------------------------------------------- Salesforce

const SALESFORCE_ADAPTER: DestinationAdapter = {
  mode: 'SALESFORCE',
  importDirectory: 'salesforce',
  version: '2.0.0',
  fileConstraints: {
    delimiter: ',',
    lineEnding: 'LF',
    encoding: 'UTF-8',
    headerRowRequired: true,
    // 150,000,000 records is a rolling 24-hour org allocation, not a per-file
    // cap, so no per-file row limit is asserted here.
    maxRowsPerFile: null,
    maxFileBytes: 104_857_600,
    // "Maximum number of fields in a record: 5,000".
    maxColumnsPerFile: 5_000,
    maxFieldBytes: null,
    // 32,000 is the documented cap on the header row; the documented field
    // value cap is 131,072.
    maxFieldCharacters: 131_072,
    maxHeaderRowCharacters: 32_000,
  },
  associationKeyHeader: 'Kauro_Association_Key__c',
  associationFromHeader: 'Kauro_Association_Key__c',
  associationToHeader: 'Related_Kauro_Association_Key__c',
  booleanText: { trueText: 'true', falseText: 'false' },
  // Salesforce can be told to write a null, but only through a combination the
  // plan does not currently declare: the Data Loader "insert null values"
  // setting or the API mode, the field's own nillability from the captured
  // contract, and the operation being performed. None of those are established
  // offline from the files this run holds, and UNKNOWN never authorizes an
  // action, so V1 refuses the clear instead of guessing a representation.
  // Qualifying that path is a separate, versioned capability.
  clearRepresentation: {
    kind: 'NOT_REPRESENTABLE',
    reason:
      'Writing a null through Data Loader depends on the insert-null setting, the API mode, the operation and the field being nillable in the captured contract. V1 does not carry that declaration, and an unestablished representation does not authorize emptying a field.',
    sourceUrl: 'https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/',
  },
  objects: [
    {
      object: 'CONTACT',
      fileName: 'Contact.csv',
      fields: [
        field('contact.firstName', 'FirstName', 40),
        field('contact.lastName', 'LastName', 80),
        field('contact.email', 'Email'),
        field('contact.phone', 'Phone'),
        field('contact.mobilePhone', 'MobilePhone'),
        field('contact.jobTitle', 'Title', 50),
        field('contact.addressLine1', 'MailingStreet'),
        field('contact.city', 'MailingCity'),
        field('contact.state', 'MailingState'),
        field('contact.postalCode', 'MailingPostalCode'),
        field('contact.country', 'MailingCountry'),
        field('contact.description', 'Description'),
      ],
      requiredForCreate: ['contact.lastName'],
      requiredAnyOf: [],
      destinationMatchingKeys: [],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: [
        'LastName is the only non-nillable Contact field.',
        'Email carries the idLookup property, so it can serve as a relationship match key, but Salesforce does not deduplicate contacts by email unless the org configures a duplicate rule.',
      ],
    },
    {
      object: 'COMPANY',
      fileName: 'Account.csv',
      fields: [
        field('company.name', 'Name', 255),
        field('company.website', 'Website'),
        field('company.phone', 'Phone'),
        field('company.addressLine1', 'BillingStreet'),
        field('company.city', 'BillingCity'),
        field('company.state', 'BillingState'),
        field('company.postalCode', 'BillingPostalCode'),
        field('company.country', 'BillingCountry'),
        field('company.industry', 'Industry'),
        field('company.employeeCount', 'NumberOfEmployees'),
        field('company.annualRevenue', 'AnnualRevenue'),
        field('company.description', 'Description'),
      ],
      requiredForCreate: ['company.name'],
      requiredAnyOf: [],
      destinationMatchingKeys: [],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: ['Name is the only non-nillable Account field.'],
    },
    {
      object: 'LEAD',
      fileName: 'Lead.csv',
      fields: [
        field('lead.firstName', 'FirstName', 40),
        field('lead.lastName', 'LastName', 80),
        field('lead.company', 'Company'),
        field('lead.email', 'Email'),
        field('lead.phone', 'Phone'),
        field('lead.mobilePhone', 'MobilePhone'),
        field('lead.jobTitle', 'Title', 128),
        field('lead.website', 'Website'),
        field('lead.addressLine1', 'Street'),
        field('lead.city', 'City'),
        field('lead.state', 'State'),
        field('lead.postalCode', 'PostalCode'),
        field('lead.country', 'Country'),
        field('lead.status', 'Status'),
        field('lead.leadSource', 'LeadSource'),
        field('lead.rating', 'Rating'),
        field('lead.industry', 'Industry'),
        field('lead.employeeCount', 'NumberOfEmployees'),
        field('lead.annualRevenue', 'AnnualRevenue'),
        field('lead.description', 'Description'),
        field('lead.doNotCall', 'DoNotCall'),
        field('lead.doNotEmail', 'HasOptedOutOfEmail'),
      ],
      requiredForCreate: ['lead.lastName', 'lead.company'],
      requiredAnyOf: [],
      destinationMatchingKeys: [],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: [
        'LastName is the only Lead field that is both required and not defaulted on create, so it is the only one every row must carry.',
        'Company is treated as required here even though the field properties mark it nillable, because the field description says Required and because a null Company converts the lead to a person account where person account record types are enabled. Person accounts are outside this envelope, so the safe reading is the stricter one.',
        'Status is required but defaulted on create, so a row without one still loads. Its values are org-defined and are never assumed here.',
        'Status, LeadSource, Rating and Industry are advisory picklists rather than restricted ones. Salesforce does not reject an unknown value on load: it silently records an inactive picklist entry. A wrong value therefore fails quietly rather than loudly, which is why these values are checked against the target contract rather than trusted.',
        'Email is the only Lead field carrying idLookup, so it is the only standard Lead field usable as an upsert match key.',
        'Street is a textarea rather than a string; the address is written as components, never as the read-only compound Address field.',
        'Title accepts 128 characters. Lead conversion truncates at 80, but conversion is outside this envelope.',
        'A Lead is not a Contact. It has its own identity space, so a Lead and a Contact sharing an email address are two records, not one.',
        'Lead conversion is outside the V1 support envelope. This adapter loads leads; it does not convert them.',
      ],
    },
    {
      object: 'DEAL',
      fileName: 'Opportunity.csv',
      fields: [
        field('deal.name', 'Name', 120),
        field('deal.amount', 'Amount'),
        field('deal.currency', 'CurrencyIsoCode'),
        field('deal.closeDate', 'CloseDate'),
        field('deal.stage', 'StageName'),
        field('deal.description', 'Description'),
      ],
      requiredForCreate: ['deal.name', 'deal.closeDate', 'deal.stage'],
      requiredAnyOf: [],
      destinationMatchingKeys: [],
      supportedModes: ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'],
      notes: [
        'Name, CloseDate and StageName are the only three non-nillable Opportunity fields.',
        'Opportunity cannot be loaded with the Data Import Wizard; use Data Loader.',
        'CurrencyIsoCode only exists in multi-currency orgs.',
        'A contact on an opportunity is an OpportunityContactRole, a separate object under its own gate. Opportunity does carry a ContactId, and it is not a relationship a migration can use: a real org reports it createable but NOT updateable and carrying no relationship name, so it can be set once at insert, never corrected afterwards, and never resolved by an external id the way a parent lookup is. Writing to it would deliver a link this engine could not later put right.',
      ],
    },
  ],
  relationships: Object.fromEntries(
    RELATIONSHIP_TYPES.map((type) => {
      // Contact-to-Account and Opportunity-to-Account are standard lookups.
      // Contact-to-Opportunity is not: Salesforce represents it as
      // OpportunityContactRole, a separate object under SF-OCR-01, so it is not
      // claimed here.
      const supported = type === 'CONTACT_TO_COMPANY' || type === 'COMPANY_TO_DEAL';
      return [
        type,
        supported
          ? ({
              kind: 'SUPPORTED',
              strategy: 'RELATIONSHIP_HEADER_BY_DECLARED_MATCH_FIELD',
              operatorInstructions:
                'Load the parent object first, then load the child addressing the parent by an indexed field rather than by Id. Contact-to-Account and Opportunity-to-Account are standard relationships named Account, so the parent is addressed as Account plus the field; the __r form applies only to custom-object relationships. The two supported import paths spell that differently, and getting it wrong is refused rather than ignored: a Bulk API CSV uses a dot, "Account.Kauro_Key__c", while Data Loader\'s mapping file uses a colon, "Account:Kauro_Key__c", and rejects the dotted form as an invalid mapping. Data Loader is the qualified path for this envelope. The named field must already exist on the parent and carry the attributes the lookup needs; Kauro does not create it.',
            } as RelationshipSupport)
          : ({
              kind: 'UNSUPPORTED',
              reason:
                'Salesforce represents a contact on an opportunity as OpportunityContactRole, a separate object with its own qualification gate. There is no Contact lookup on Opportunity to write to.',
            } as RelationshipSupport),
      ];
    }),
  ) as Record<RelationshipType, RelationshipSupport>,
  instanceVerification: [
    {
      scope: 'MATCH_FIELD',
      detail:
        'Update and upsert need a Salesforce Record ID or a field the org already carries with the External ID attribute. Whether such a field exists, and whether it is also marked Unique and case-insensitive, is org configuration. Kauro does not create it.',
      sourceUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_upsert.htm',
    },
    {
      scope: 'PICKLISTS',
      detail:
        'StageName, Lead Status, Lead Source, Rating and other picklist values must exist in the org, and a restricted picklist rejects anything outside its value set.',
      sourceUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm',
    },
    {
      scope: 'RECORD_TYPES',
      detail:
        'Where an object has record types, the record type decides which picklist values are available. Which record types exist is org configuration.',
      sourceUrl:
        'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_recordtype.htm',
    },
    {
      scope: 'DUPLICATE_RULES',
      detail:
        'Org duplicate rules run on create, update and upsert. Whether a record is blocked or merely flagged is org configuration.',
      sourceUrl:
        'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_header_duplicateruleheader.htm',
    },
    {
      scope: 'LOADER_SETTINGS',
      detail:
        'Insert Null Values, European date format, field truncation and the time zone are Data Loader settings chosen by the operator. Files are emitted as UTF-8 with ISO 8601 dates so the result does not depend on them.',
      sourceUrl: 'https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/loader_params.htm',
    },
    {
      scope: 'API_AVAILABILITY',
      detail:
        'Data Loader and the Bulk API are available in Enterprise, Performance, Unlimited and Developer editions; Professional edition needs the API add-on.',
      sourceUrl: 'https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/data_loader.htm',
    },
    {
      scope: 'MULTI_CURRENCY',
      detail: 'CurrencyIsoCode only exists in multi-currency orgs.',
      sourceUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm',
    },
  ],
  sources: [
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/required_fields.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'What "required" means for create and update.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_account.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Account fields, required Name, 255-character limit.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contact.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Contact fields, required LastName, field lengths, Email idLookup.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_lead.htm',
      reviewedOn: REVIEWED_ON,
      scope:
        'Lead fields, required LastName and Company, field lengths, Status and Rating picklists, DoNotCall and HasOptedOutOfEmail.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_opportunity.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Opportunity fields, required Name, CloseDate and StageName.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_date_format.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Accepted date and datetime formats.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_prepare_csv.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'CSV structure, UTF-8 requirement, header row limit, null sentinel.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_csv_rel_field_header_row.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Relationship header syntax for matching parents by an indexed field.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_upsert.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Upsert matching, case sensitivity, duplicate keys within a batch.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/supported_data_types.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Boolean spellings, id lengths, numeric formats, the 1700-4000 date range.',
    },
    {
      url: 'https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_bulkapi.htm',
      reviewedOn: REVIEWED_ON,
      scope: 'Bulk API limits: 131,072 characters per field, 5,000 fields per record, the daily record allowance.',
    },
    {
      url: 'https://github.com/forcedotcom/dataloader/blob/v67.0.0/src/main/java/com/salesforce/dataloader/action/AbstractAction.java',
      reviewedOn: N1_REVIEWED_ON,
      scope:
        'Data Loader result files, read in the vendor source of v67.0.0 (openSuccessWriter, openErrorWriter; AbstractLoadAction.getStatusColumns): the success file is ID, every column of the input row whether mapped or not, then STATUS; the error file is every input column, then ERROR. SOAP and Bulk API 1.0 paths; not run.',
    },
  ],
  customFieldHeader: (label) => label,
};

// ------------------------------------------------------------------- registry

const ADAPTERS: Readonly<Record<TargetMode, DestinationAdapter>> = {
  CLEAN_ONLY: CLEAN_ONLY_ADAPTER,
  HUBSPOT: HUBSPOT_ADAPTER,
  SALESFORCE: SALESFORCE_ADAPTER,
};

export function getAdapter(mode: TargetMode): DestinationAdapter {
  const adapter = ADAPTERS[mode];
  if (adapter === undefined) {
    throw new MigrationError(
      'DESTINATION_OBJECT_UNSUPPORTED',
      `no adapter is registered for "${mode}"`,
      'Choose one of: HUBSPOT, SALESFORCE, CLEAN_ONLY.',
      { mode },
    );
  }
  return adapter;
}

export const ALL_ADAPTERS: readonly DestinationAdapter[] = [
  CLEAN_ONLY_ADAPTER,
  HUBSPOT_ADAPTER,
  SALESFORCE_ADAPTER,
];

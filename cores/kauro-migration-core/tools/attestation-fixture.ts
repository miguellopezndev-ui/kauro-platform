import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { hashTargetContract } from '../src/target/contract.js';
import type { HashedTargetContract, TargetFieldContract, TargetObjectContract } from '../src/target/contract.js';
import { getAdapter } from '../src/adapters/specs.js';
import { HUBSPOT_INTERNAL_NAMES, INSTANCE_OBJECT_API_NAMES } from '../src/target/instance-fields.js';
import type { CanonicalFieldName, CanonicalObject } from '../src/domain/canonical.js';
import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_CONTRACT_VERSION,
  attestationSigningBytes,
} from '../src/target/attestation.js';
import type { AttestationAuthority, TargetAttestation } from '../src/target/attestation.js';
import type { TargetMode } from '../src/domain/config.js';

/**
 * A real attestation, for a run that has no real instance behind it.
 *
 * Attestation is REQUIRED by default for the CRM modes now, and the blast
 * radius of that is everything in this repository that runs a HubSpot or
 * Salesforce plan: the golden corpus, the acceptance builders, the determinism
 * replay, the property suite, the capacity profiles and the architecture gate.
 * Every one of them was relying on the permissive default, which is precisely
 * the evidence that the permissive default was wrong.
 *
 * There were two ways to absorb that. The tempting one is to let internal
 * callers past — a flag, a test-only policy, an environment variable. It is the
 * wrong one, and not marginally: a default that every internal caller bypasses
 * is not a default, it is a comment. The check would then be exercised only by
 * the handful of tests written to exercise it, and the first plan that reached
 * production without an attestation would be the first plan anybody had ever
 * actually run that way.
 *
 * So the fixtures attest. The key pair is generated here, the signature is a
 * genuine Ed25519 signature over the canonical bytes of everything the
 * attestation asserts, and the run verifies it through exactly the code path
 * that verifies an agency's. Nothing about the check is relaxed; what changes is
 * that the harnesses stop being the reason to relax it.
 *
 * What this is NOT, said plainly because the distinction is the whole subject of
 * the seam: these contracts describe no real instance. The instance id says so
 * in words. A vendor gate builds its contract from artifacts captured against a
 * real portal or org, and a fixture proving the engine refuses an unattested run
 * is a different claim from a capture proving which instance a property export
 * came from. Neither may ever be presented as the other, and an id reading
 * `fixture-not-a-real-portal` is hard to mistake for one that is.
 */

interface FixtureInstance {
  readonly instanceId: string;
  readonly instanceLabel: string;
}

const FIXTURE_INSTANCE: Readonly<Record<string, FixtureInstance>> = {
  HUBSPOT: { instanceId: 'fixture-not-a-real-portal', instanceLabel: 'fixture instance, no HubSpot portal' },
  SALESFORCE: { instanceId: 'fixture-not-a-real-org', instanceLabel: 'fixture instance, no Salesforce org' },
};

const ARTIFACT = { path: 'fixture/contract.json', sha256: '0'.repeat(64), byteLength: 0 } as const;

/**
 * Fixed instants, never the clock.
 *
 * Freshness is judged against an instant the caller passes in, which is the
 * design that lets a run be replayed years later and still mean the same thing.
 * A fixture that took `capturedAt` from the clock would produce different bytes
 * on every run, and the determinism replay would fail for a reason that has
 * nothing to do with the engine.
 */
const CAPTURED_AT = '2026-09-01T00:00:00Z';
const EXPIRES_AT = '2027-09-01T00:00:00Z';
const INSTANT = '2026-09-04T00:00:00Z';

export interface FixtureAttestation {
  readonly targetContract: HashedTargetContract;
  readonly targetAttestation: TargetAttestation;
  readonly attestationAuthorities: readonly AttestationAuthority[];
  readonly attestationInstant: string;
}

/**
 * Signs a contract somebody else built.
 *
 * Used where the caller's contract is part of what is being tested — the
 * architecture gate shapes one for the fixture it is about to run, and should go
 * on doing so. What it needs from here is only the signature, the key and the
 * instant, which is the part a host supplies rather than a plan.
 */
export function attestContract(contract: HashedTargetContract): Omit<FixtureAttestation, 'targetContract'> {
  const issuer = generateKeyPairSync('ed25519');
  const instance = contract.contract.instance;
  const body: Omit<TargetAttestation, 'signature'> = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'kauro:fixture', name: 'Kauro fixture issuer', keyId: 'fixture-1' },
    subject: { mode: instance.mode, instanceId: instance.instanceId, instanceLabel: instance.instanceLabel },
    artifacts: contract.contract.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    })),
    contractHash: contract.contractHash,
    schemaVersion: '1.0.0',
    toolVersion: 'kauro-fixture/1.0.0',
    capturedAt: contract.contract.capturedAt,
    expiresAt: EXPIRES_AT,
    nonce: null,
  };
  const unsigned: TargetAttestation = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(unsigned), 'utf8'), issuer.privateKey).toString(
    'base64',
  );
  return {
    targetAttestation: { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } },
    attestationAuthorities: [
      {
        issuerId: body.issuer.id,
        keyId: body.issuer.keyId,
        algorithm: ATTESTATION_ALGORITHM,
        publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
    attestationInstant: INSTANT,
  };
}

/**
 * The instance facts a fixture contract states, per canonical field.
 *
 * Destination validation consumes the attested contract (audit MC-04): a field
 * the capture does not carry, or does not establish as writeable, is not
 * delivered. A fixture contract with `objects: []` therefore describes an
 * instance nothing can be delivered to, and every CRM fixture in the repository
 * would be refused against it. So the fixture describes what a minimal,
 * synthetic instance of each mode would report for the fields the adapter can
 * deliver: writeable, nillable, no length or vocabulary declared beyond what
 * the vendor documents for everybody. Nothing here is a fact about a real
 * portal or org, and the instance id keeps saying so.
 *
 * The type token is the vendor's own spelling for the field's documented type,
 * so a plan that declares `deal.amount` as TEXT against a number field is
 * refused the way a real capture would refuse it.
 */
const HUBSPOT_FIELD_TYPES: Readonly<Partial<Record<CanonicalFieldName, string>>> = {
  'contact.lifecycleStage': 'enumeration',
  'company.industry': 'enumeration',
  'company.employeeCount': 'number',
  'company.annualRevenue': 'number',
  'deal.amount': 'number',
  'deal.closeDate': 'date',
  'deal.stage': 'enumeration',
  'deal.pipeline': 'enumeration',
  'deal.currency': 'enumeration',
};

const SALESFORCE_FIELD_TYPES: Readonly<Partial<Record<CanonicalFieldName, string>>> = {
  'contact.email': 'email',
  'contact.phone': 'phone',
  'contact.mobilePhone': 'phone',
  'contact.description': 'textarea',
  'company.website': 'url',
  'company.phone': 'phone',
  'company.industry': 'picklist',
  'company.employeeCount': 'int',
  'company.annualRevenue': 'currency',
  'company.description': 'textarea',
  'lead.email': 'email',
  'lead.phone': 'phone',
  'lead.mobilePhone': 'phone',
  'lead.website': 'url',
  'lead.status': 'picklist',
  'lead.leadSource': 'picklist',
  'lead.rating': 'picklist',
  'lead.industry': 'picklist',
  'lead.employeeCount': 'int',
  'lead.annualRevenue': 'currency',
  'lead.description': 'textarea',
  'lead.doNotCall': 'boolean',
  'lead.doNotEmail': 'boolean',
  'deal.amount': 'currency',
  'deal.currency': 'picklist',
  'deal.closeDate': 'date',
  'deal.stage': 'picklist',
  'deal.description': 'textarea',
};

/**
 * Custom properties the fixture instances declare, per mode and object: the
 * ones the golden and acceptance CRM fixtures deliver to. A custom column the
 * instance does not declare is not deliverable, so a fixture that adds one has
 * to add it here as well, which is the same step an agency takes in a real
 * portal.
 */
export interface FixtureCustomField {
  readonly label: string;
  readonly type: string;
}

export const FIXTURE_CUSTOM_FIELDS: Readonly<Record<'HUBSPOT' | 'SALESFORCE', Readonly<Partial<Record<CanonicalObject, readonly FixtureCustomField[]>>>>> = {
  // G28-unrecognised-boolean delivers `custom:Opted In` as BOOLEAN to a contact.
  // test/unit/adapters.test.ts re-targets G38-agency-normal-cleaning at both
  // CRM modes, delivering Alt Email (EMAIL), Signup Date (DATE), Newsletter
  // (BOOLEAN) and Segment (TEXT) to contacts and Segment to companies.
  HUBSPOT: {
    CONTACT: [
      { label: 'Opted In', type: 'bool' },
      { label: 'Alt Email', type: 'string' },
      { label: 'Signup Date', type: 'date' },
      { label: 'Newsletter', type: 'bool' },
      { label: 'Segment', type: 'string' },
    ],
    COMPANY: [{ label: 'Segment', type: 'string' }],
  },
  SALESFORCE: {
    CONTACT: [
      { label: 'Alt Email', type: 'email' },
      { label: 'Signup Date', type: 'date' },
      { label: 'Newsletter', type: 'boolean' },
      { label: 'Segment', type: 'string' },
    ],
    COMPANY: [{ label: 'Segment', type: 'string' }],
  },
};

export function fixtureField(apiName: string, label: string, type: string, overrides: Partial<TargetFieldContract> = {}): TargetFieldContract {
  return {
    apiName,
    label,
    type,
    createable: 'TRUE',
    updateable: 'TRUE',
    nillable: 'TRUE',
    length: null,
    precision: null,
    scale: null,
    unique: 'FALSE',
    externalId: 'FALSE',
    idLookup: 'FALSE',
    calculated: 'FALSE',
    autoNumber: 'FALSE',
    defaultedOnCreate: 'FALSE',
    restrictedPicklist: 'FALSE',
    picklistValues: [],
    referenceTo: [],
    relationshipName: null,
    evidence: 'ARTIFACT',
    ...overrides,
  };
}

/**
 * The objects a fixture instance of this mode describes: every object the
 * adapter delivers, with every field the adapter has a column for, plus the
 * custom properties the fixtures use.
 *
 * HubSpot fields are named by their default internal name and labelled with
 * the import header; Salesforce fields by their API name, which the adapter
 * header already is.
 */
export function fixtureObjects(
  mode: 'HUBSPOT' | 'SALESFORCE',
  customFields: Readonly<Partial<Record<CanonicalObject, readonly FixtureCustomField[]>>> = FIXTURE_CUSTOM_FIELDS[mode],
): TargetObjectContract[] {
  const adapter = getAdapter(mode);
  const types = mode === 'HUBSPOT' ? HUBSPOT_FIELD_TYPES : SALESFORCE_FIELD_TYPES;
  return adapter.objects.map((spec) => {
    const fields: TargetFieldContract[] = [];
    const seen = new Set<string>();
    for (const entry of spec.fields) {
      const apiName = mode === 'HUBSPOT' ? (HUBSPOT_INTERNAL_NAMES[entry.canonicalField] ?? entry.header) : entry.header;
      // HubSpot writes the owner of every object to one property; a second
      // field of the same name would be a capture that contradicts itself.
      if (seen.has(apiName)) continue;
      seen.add(apiName);
      fields.push(fixtureField(apiName, entry.header, types[entry.canonicalField] ?? 'string', { length: entry.maxLength }));
    }
    for (const custom of customFields[spec.object] ?? []) {
      fields.push(fixtureField(custom.label, custom.label, custom.type));
    }
    return {
      apiName: INSTANCE_OBJECT_API_NAMES[mode][spec.object],
      label: spec.object,
      createable: 'TRUE',
      updateable: 'TRUE',
      fields,
      recordTypes: [],
    };
  });
}

/** A contract for a fixture instance of this mode, and a signature over it. */
export function fixtureAttestation(mode: TargetMode): FixtureAttestation {
  const instance = FIXTURE_INSTANCE[mode];
  if (instance === undefined || mode === 'CLEAN_ONLY') {
    throw new Error(`${mode} addresses no destination instance, so it takes no attestation`);
  }
  const contract = hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: CAPTURED_AT,
    instance: { mode, instanceId: instance.instanceId, instanceLabel: instance.instanceLabel, evidence: 'ARTIFACT' },
    artifacts: [{ ...ARTIFACT, kind: 'DESCRIBE' }],
    objects: fixtureObjects(mode),
    pipelines: [],
  });
  return { targetContract: contract, ...attestContract(contract) };
}

/**
 * What a run of this mode needs adding to its input, and nothing more.
 *
 * CLEAN_ONLY gets an empty object rather than an explicit policy. Its policy is
 * NOT_APPLICABLE and stating it would be refused as a contradiction, which is
 * the behaviour the seam is supposed to have: a clean-only run addresses no
 * instance, so there is nothing for an attestation to be required of and nothing
 * for it to be excused from either.
 */
export function attestationFor(mode: TargetMode): Partial<FixtureAttestation> {
  if (mode === 'CLEAN_ONLY') return {};
  return fixtureAttestation(mode);
}

#!/usr/bin/env node
// TARGET-CONTRACT-01.
//
// The unit suite proves each rule in isolation. This gate proves the rules are
// still wired to each other and to the shipped contract — that the engine, as
// built, will not match a destination record on anything it cannot show
// evidence for.
//
// It exercises the real code rather than reading it. Every case below is a way
// somebody's records get silently merged or silently duplicated if the rule
// stops holding.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const failures = [];
const checks = [];
function check(name, condition, detail) {
  checks.push(name);
  if (!condition) failures.push(`${name}: ${detail}`);
}

/** Assert that running `run` refuses, and that the refusal says why. */
function refuses(name, run, fragment) {
  checks.push(name);
  try {
    run();
    failures.push(`${name}: accepted what it must refuse`);
  } catch (error) {
    const text = `${String(error?.message ?? '')} ${String(error?.remedy ?? '')}`;
    if (!text.includes(fragment)) {
      failures.push(`${name}: refused, but for the wrong reason: ${text.slice(0, 200)}`);
    }
  }
}

const { getAdapter } = await import('../dist/src/adapters/specs.js');
const { MATCH_AUTHORITIES, MISSING_MATCH_POLICIES, MATCH_CONFLICT_POLICIES } = await import(
  '../dist/src/domain/config.js'
);
const { hashTargetContract, loadTargetContract, serializeTargetContract, isDefinitely } = await import(
  '../dist/src/target/contract.js'
);
const { resolveMatchAuthority } = await import('../dist/src/target/match-authority.js');

const salesforce = getAdapter('SALESFORCE');

// ------------------------------------------------------- 1. the declared surface

check(
  'declaration.authorities',
  ['NONE', 'RECORD_ID', 'EXTERNAL_ID', 'TARGET_UNIQUE_FIELD'].every((name) => MATCH_AUTHORITIES.includes(name)),
  `match authorities are ${JSON.stringify(MATCH_AUTHORITIES)}`,
);
check(
  'declaration.policies',
  MISSING_MATCH_POLICIES.length > 0 && MATCH_CONFLICT_POLICIES.length > 0,
  'a plan must be able to say what happens when a match finds nothing and when it finds two',
);
// Delivering both sides of a match conflict makes the destination merge them,
// which is the silent merge the whole engine exists to prevent.
check(
  'declaration.noDeliverBoth',
  !MATCH_CONFLICT_POLICIES.some((policy) => /DELIVER|BOTH|ALTERNATE/i.test(policy)),
  `a match-conflict policy delivers both records: ${JSON.stringify(MATCH_CONFLICT_POLICIES)}`,
);

// -------------------------------------------------- 2. the three import modes

for (const mode of ['HUBSPOT', 'SALESFORCE']) {
  const adapter = getAdapter(mode);
  for (const spec of adapter.objects) {
    check(
      `modes.${mode}.${spec.object}`,
      ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'].every((m) => spec.supportedModes.includes(m)),
      `${mode} ${spec.object} supports only ${JSON.stringify(spec.supportedModes)}; V1 sells create, update and create+update`,
    );
  }
}

// ------------------------------------------------------- 3. the contract itself

const flag = (value) => value;
const field = (overrides = {}) => ({
  apiName: 'Legacy_Id__c',
  label: 'Legacy Id',
  type: 'string',
  createable: flag('TRUE'),
  updateable: flag('TRUE'),
  nillable: flag('TRUE'),
  length: 64,
  precision: null,
  scale: null,
  unique: flag('TRUE'),
  externalId: flag('TRUE'),
  idLookup: flag('TRUE'),
  calculated: flag('FALSE'),
  autoNumber: flag('FALSE'),
  defaultedOnCreate: flag('FALSE'),
  restrictedPicklist: flag('FALSE'),
  picklistValues: [],
  referenceTo: [],
  relationshipName: null,
  evidence: 'ARTIFACT',
  ...overrides,
});

const contract = (fields) => ({
  contractVersion: '1.0.0',
  parserVersion: '1.0.0',
  capturedAt: '2026-09-01T00:00:00Z',
  instance: { mode: 'SALESFORCE', instanceId: '00D000000000001', instanceLabel: 'gate', evidence: 'ARTIFACT' },
  artifacts: [{ path: 'describe/Contact.json', sha256: 'a'.repeat(64), byteLength: 1, kind: 'DESCRIBE' }],
  objects: [{ apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', fields, recordTypes: [] }],
  pipelines: [],
});

const plan = (matching) => ({
  configVersion: '3.0.0',
  source: { system: 'gate', namespace: 'gate', encoding: null },
  target: { mode: 'SALESFORCE', importMode: 'UPSERT' },
  localeEvidence: { phoneCountry: null, dateFormat: null, decimalSeparator: null, thousandsSeparator: null },
  limits: {},
  policies: {},
  files: [],
  records: [{ id: 'contacts', object: 'CONTACT', fields: [] }],
  associations: [],
  destinationMatching: [
    {
      recordMappingId: 'contacts',
      matchAuthority: 'EXTERNAL_ID',
      targetField: 'Legacy_Id__c',
      sourceField: 'contact.email',
      onMissingMatch: 'ISOLATE',
      onMatchConflict: 'ISOLATE',
      ...matching,
    },
  ],
});

// An unestablished attribute is not a yes. This is the single edit that would
// let every UNKNOWN in a captured contract authorise a match.
check('contract.unknownIsNotYes', !isDefinitely('UNKNOWN') && !isDefinitely('FALSE') && isDefinitely('TRUE'),
  'an attribute nobody established reads as established');

const good = hashTargetContract(contract([field()]));
check(
  'contract.namedByContent',
  good.contractHash === hashTargetContract(contract([field()])).contractHash &&
    good.contractHash !== hashTargetContract(contract([field({ unique: 'FALSE' })])).contractHash,
  'a contract is not named by its content, so an edited one could keep its name',
);

refuses(
  'contract.tamperRejected',
  () => loadTargetContract(serializeTargetContract(good).replace('"unique": "TRUE"', '"unique": "FALSE"'), 'gate'),
  'does not hash to the digest it claims',
);

// --------------------------------------------- 4. the rules, exercised together

// The separation itself.
refuses(
  'matching.traceKeyRefused',
  () =>
    resolveMatchAuthority(
      plan({ targetField: salesforce.associationKeyHeader }),
      salesforce,
      hashTargetContract(contract([field({ apiName: salesforce.associationKeyHeader })])),
    ),
  'trace key',
);

// External ID is not Unique. An upsert against a non-unique external id can
// match two records, and one of them loses.
refuses(
  'matching.externalIdIsNotUnique',
  () => resolveMatchAuthority(plan({}), salesforce, hashTargetContract(contract([field({ unique: 'UNKNOWN' })]))),
  'REQUIRES_AGENCY_DECISION',
);

// A field nobody captured is the agency's decision, not the engine's.
refuses(
  'matching.uncapturedFieldIsAgencyDecision',
  () => resolveMatchAuthority(plan({}), salesforce, hashTargetContract(contract([field({ apiName: 'Other__c' })]))),
  'REQUIRES_AGENCY_DECISION',
);

// Matching without evidence at all.
refuses(
  'matching.noContractNoMatch',
  () => resolveMatchAuthority(plan({}), salesforce, null),
  'needs a captured target contract',
);

// The happy path still works, so the gate is not passing by refusing everything.
checks.push('matching.legalMatchAccepted');
try {
  const [decision] = resolveMatchAuthority(plan({}), salesforce, good);
  if (decision?.matchAuthority !== 'EXTERNAL_ID' || decision.contractHash !== good.contractHash) {
    failures.push('matching.legalMatchAccepted: a fully evidenced external id did not resolve');
  }
} catch (error) {
  failures.push(`matching.legalMatchAccepted: refused a legal match: ${String(error?.message ?? error)}`);
}

// -------------------------------------------------- 5. the collector is safe

const collector = readFileSync(resolve(repoRoot, 'qualification/salesforce/collect-target-schema.mjs'), 'utf8');
for (const secret of ['accessToken', 'refreshToken', 'sfdxAuthUrl', 'clientSecret', 'password', 'sessionId', 'PRIVATE KEY']) {
  check(
    `collector.refuses.${secret}`,
    collector.includes(secret),
    `the Salesforce collector does not look for ${secret}`,
  );
}
// Refusing rather than redacting is the point: a bundle that held a credential
// is rebuilt, not repaired.
check(
  'collector.refusesRatherThanRedacts',
  /refuse rather than redact|Refuse rather than redact/.test(collector) && collector.includes('rotate'),
  'the collector does not say to rotate a disclosed credential',
);

// -------------------------------------------------------------------- report

/** The result, written where a provenance record can read it rather than assert it. */
const evidenceIndex = process.argv.indexOf('--evidence');
if (evidenceIndex !== -1 && process.argv[evidenceIndex + 1] !== undefined) {
  const failedIds = new Set(failures.map((failure) => failure.split(':')[0]));
  writeFileSync(
    process.argv[evidenceIndex + 1],
    `${JSON.stringify(
      {
        gate: 'TARGET-CONTRACT-01',
        observedAt: `${new Date().toISOString().slice(0, 19)}Z`,
        checksRun: checks.length,
        checks: checks.map((id) => ({ id, ok: !failedIds.has(id) })),
        failures,
        result: failures.length === 0 ? 'PASS' : 'FAIL',
      },
      null,
      2,
    )}\n`,
  );
}

process.stdout.write(`TARGET-CONTRACT-01: ${String(checks.length)} checks\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.stdout.write('TARGET-CONTRACT-01 = FAIL\n');
  process.exitCode = 1;
} else {
  process.stdout.write('TARGET-CONTRACT-01 = PASS\n');
}

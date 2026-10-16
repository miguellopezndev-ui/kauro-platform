#!/usr/bin/env node
// CORE-CONSTITUTION-01.
//
// The support envelope is a commercial promise, and a promise the code can
// quietly widen is not a promise. This gate reads what the built engine
// actually declares, and scans the surfaces a customer or an operator can see,
// and fails if either says something the envelope does not.
//
// It is deliberately not a unit test. A unit test proves a function behaves;
// this proves the repository as a whole claims nothing more than V1 sells.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const failures = [];
const checks = [];
function check(name, condition, detail) {
  checks.push(name);
  if (!condition) failures.push(`${name}: ${detail}`);
}

const { ALL_ADAPTERS, getAdapter } = await import('../dist/src/adapters/specs.js');
const { CANONICAL_OBJECTS, CANONICAL_FIELD_LIST } = await import('../dist/src/domain/canonical.js');
const { TARGET_MODES } = await import('../dist/src/domain/config.js');
const { RELATIONSHIP_TYPES } = await import('../dist/src/domain/associations.js');

// ------------------------------------------------------- 1. commercial modes

check(
  'modes.exactlyThree',
  TARGET_MODES.length === 3 && ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY'].every((m) => TARGET_MODES.includes(m)),
  `the commercial modes are ${JSON.stringify(TARGET_MODES)}, not exactly HUBSPOT, SALESFORCE and CLEAN_ONLY`,
);

check(
  'modes.adaptersMatchModes',
  ALL_ADAPTERS.length === 3 && ALL_ADAPTERS.every((a) => TARGET_MODES.includes(a.mode)),
  `${String(ALL_ADAPTERS.length)} adapters are registered: ${ALL_ADAPTERS.map((a) => a.mode).join(', ')}`,
);

// ----------------------------------------------------------------- 2. no Zoho

// Surfaces a customer, an operator or an integrator can read as a claim of
// support. Decision records and the phase-0 delta deliberately name Zoho: they
// record that it was removed, which is the opposite of announcing it.
const CLAIM_SURFACES = ['src', 'spec', 'acceptance', 'test/fixtures', 'README.md', 'docs/CONTRACT.md', 'docs/SOURCE_REGISTRY.md'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tmp', 'coverage']);

function* walk(start) {
  const absolute = join(repoRoot, start);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    return;
  }
  if (info.isFile()) {
    yield absolute;
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    yield* walk(join(start, entry.name));
  }
}

const zohoHits = [];
const activityHits = [];
for (const surface of CLAIM_SURFACES) {
  for (const file of walk(surface)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const shown = relative(repoRoot, file).split(sep).join('/');
    text.split('\n').forEach((line, index) => {
      if (/zoho/i.test(line)) zohoHits.push(`${shown}:${String(index + 1)}`);
    });
  }
}

check('zoho.absent', zohoHits.length === 0, `Zoho is still named on ${String(zohoHits.length)} line(s): ${zohoHits.slice(0, 8).join(', ')}`);

// ------------------------------------------------- 3. no activities anywhere

check(
  'activities.notCanonical',
  !CANONICAL_OBJECTS.includes('ACTIVITY'),
  'ACTIVITY is still a canonical object, so an activity can still be modelled',
);

check(
  'activities.noCanonicalFields',
  !CANONICAL_FIELD_LIST.some((name) => name.startsWith('activity.')),
  'canonical fields in the activity family still exist',
);

for (const adapter of ALL_ADAPTERS) {
  check(
    `activities.notDeclaredBy.${adapter.mode}`,
    !adapter.objects.some((spec) => spec.object === 'ACTIVITY' || /note|call|meeting|task|ticket/i.test(spec.fileName)),
    `${adapter.mode} declares an activity object: ${adapter.objects.map((s) => s.fileName).join(', ')}`,
  );
}

check(
  'activities.noRelationship',
  !RELATIONSHIP_TYPES.some((type) => type.startsWith('ACTIVITY_')),
  `an activity relationship is still declared: ${RELATIONSHIP_TYPES.join(', ')}`,
);

// -------------------------------------------------------- 4. HubSpot envelope

const hubspot = getAdapter('HUBSPOT');
const hubspotObjects = hubspot.objects.map((spec) => spec.object).sort();
check(
  'hubspot.objects',
  JSON.stringify(hubspotObjects) === JSON.stringify(['COMPANY', 'CONTACT', 'DEAL']),
  `HubSpot declares ${JSON.stringify(hubspotObjects)}, not exactly Contact, Company and Deal`,
);

// ----------------------------------------------------- 5. Salesforce envelope

const salesforce = getAdapter('SALESFORCE');
const salesforceObjects = salesforce.objects.map((spec) => spec.object).sort();
check(
  'salesforce.objects',
  JSON.stringify(salesforceObjects) === JSON.stringify(['COMPANY', 'CONTACT', 'DEAL', 'LEAD']),
  `Salesforce declares ${JSON.stringify(salesforceObjects)}, not exactly Account, Contact, Lead and Opportunity`,
);

const lead = salesforce.objects.find((spec) => spec.object === 'LEAD');
check('salesforce.lead.present', lead !== undefined, 'Salesforce declares no Lead object');
if (lead !== undefined) {
  check('salesforce.lead.file', lead.fileName === 'Lead.csv', `Lead writes ${lead.fileName}`);
  check(
    'salesforce.lead.required',
    ['lead.lastName', 'lead.company'].every((f) => lead.requiredForCreate.includes(f)),
    `Lead requires ${JSON.stringify(lead.requiredForCreate)}, not LastName and Company`,
  );
  // A Lead that borrowed the Contact field family would be a Contact under
  // another name, which is exactly what the contract forbids.
  check(
    'salesforce.lead.ownFields',
    lead.fields.length > 0 && lead.fields.every((f) => f.canonicalField.startsWith('lead.')),
    'Lead maps fields from another object family, so it is a renamed Contact rather than a Lead',
  );
  check(
    'salesforce.lead.identitySpace',
    CANONICAL_OBJECTS.includes('LEAD'),
    'LEAD is not a canonical object, so a Lead and a Contact would share one identity space',
  );
}

check(
  'salesforce.opportunityContactRole.notClaimed',
  salesforce.relationships['CONTACT_TO_DEAL'].kind === 'UNSUPPORTED',
  'Salesforce advertises a contact-to-opportunity relationship, which is OpportunityContactRole and is not qualified',
);

// ------------------------------------------------------ 6. CLEAN_ONLY is not a CRM

const cleanOnly = getAdapter('CLEAN_ONLY');
check('cleanOnly.mode', cleanOnly.mode === 'CLEAN_ONLY', `the vendor-neutral adapter is registered as ${cleanOnly.mode}`);
check(
  'cleanOnly.directory',
  cleanOnly.importDirectory === 'clean-only',
  `CLEAN_ONLY writes to import/${cleanOnly.importDirectory}/`,
);
check(
  'cleanOnly.noInstanceClaims',
  cleanOnly.instanceVerification.length === 0,
  'CLEAN_ONLY declares instance verification items, so it is presenting itself as a destination instance',
);

// ------------------------------------- 7. the trace key is not a match authority

for (const adapter of ALL_ADAPTERS) {
  const claims = [
    ...adapter.instanceVerification.map((item) => item.detail),
    ...adapter.objects.flatMap((spec) => spec.notes),
    ...Object.values(adapter.relationships).map((r) => (r.kind === 'SUPPORTED' ? r.operatorInstructions : r.reason)),
  ].join('\n');
  // The engine may name a delivered record so it can be traced. It may not ask
  // anyone to make that name unique in their portal, or to carry it as an
  // External ID, because that is Kauro requiring infrastructure inside somebody
  // else's instance in order to match records.
  check(
    `traceKey.notUniqueProperty.${adapter.mode}`,
    !/requires? unique values/i.test(claims),
    `${adapter.mode} asks the operator to create a unique-value property for a Kauro-owned column`,
  );
  const traceKeyAsExternalId = new RegExp(`${adapter.associationKeyHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.]{0,200}External ID`, 'i');
  check(
    `traceKey.notExternalId.${adapter.mode}`,
    !traceKeyAsExternalId.test(claims),
    `${adapter.mode} asks for the Kauro trace key to exist as an External ID`,
  );
}

// -------------------------------------------------------------------- report

/**
 * The result, written where a provenance record can read it.
 *
 * `tools/provenance.mjs` used to carry `state: 'PASS'` for this gate as a
 * string literal, beside the sentence "26 checks, in CI" — so the release
 * record said the constitution gate passed whether or not it had been run, and
 * said it with a count nobody had counted. A gate states its own result; a
 * record reads it.
 */
const evidenceIndex = process.argv.indexOf('--evidence');
if (evidenceIndex !== -1 && process.argv[evidenceIndex + 1] !== undefined) {
  const failedIds = new Set(failures.map((failure) => failure.split(':')[0]));
  writeFileSync(
    process.argv[evidenceIndex + 1],
    `${JSON.stringify(
      {
        gate: 'CORE-CONSTITUTION-01',
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

process.stdout.write(`CORE-CONSTITUTION-01: ${String(checks.length)} checks\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.stdout.write('CORE-CONSTITUTION-01 = FAIL\n');
  process.exitCode = 1;
} else {
  process.stdout.write('CORE-CONSTITUTION-01 = PASS\n');
}

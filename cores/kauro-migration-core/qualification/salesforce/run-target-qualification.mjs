#!/usr/bin/env node
// SF-TARGET-01, the target-contract half.
//
// Reads a bundle captured from a real Salesforce org, builds the target
// contract from it, and puts the engine's destination-match rules to that
// contract rather than to a fixture written to agree with them. A fixture can
// be made to say anything; an org says what it says.
//
// Usage:
//   node run-target-qualification.mjs <bundle-dir> [--evidence <file>]
import { writeFileSync } from 'node:fs';
const { assertRunnerAskedEverything } = await import('../oracles.mjs');
import { resolve } from 'node:path';

const bundleDir = process.argv[2];
if (bundleDir === undefined) {
  process.stderr.write('usage: node run-target-qualification.mjs <bundle-dir> [--evidence <file>]\n');
  process.exit(2);
}
const evidenceIndex = process.argv.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1];

const { readSalesforceBundleDirectory, buildSalesforceTargetContract } = await import(
  '../../dist/src/target/salesforce-bundle.js'
);
const { hashTargetContract, findObject, findField } = await import('../../dist/src/target/contract.js');
const { resolveMatchAuthority } = await import('../../dist/src/target/match-authority.js');
const { getAdapter } = await import('../../dist/src/adapters/specs.js');
const { captureEnd, captureStart, nowUtc, observedInstance } = await import('../campaign.mjs');
const started = await captureStart({ producer: 'qualification/salesforce/run-target-qualification.mjs' });

const checks = [];
const failures = [];

/**
 * A check whose verdict is settled at the end, by whether anything was
 * written against its id.
 *
 * Four checks in these two files pushed `{ok: true}` before running and then
 * reported a failure by appending to `failures` alone, so the evidence
 * recorded `ok: true` for a check that had failed. That is the SF-OCR-01
 * defect — a case whose ok said one thing and whose detail said another —
 * reintroduced by the commit whose docstring says it makes that impossible.
 */
function beginCheck(id) {
  checks.push({ id, ok: null, expected: 'no failure recorded', observed: null, detail: null });
}

function settleChecks() {
  for (const entry of checks) {
    if (entry.ok !== null) continue;
    const said = failures.filter((line) => String(line).startsWith(`${entry.id}: `));
    entry.ok = said.length === 0;
    entry.observed = said.length === 0 ? 'no failure recorded' : said.join('; ');
    entry.detail = said.length === 0 ? null : said.join('; ');
  }
}
/**
 * One check, as a pair, with the verdict derived from comparing it.
 *
 * `checks` used to be an array of names. So the evidence recorded that a check
 * had run and never what it found, the release gate could not read a verdict out
 * of it at all, and a failure lived only in a separate `failures` array of
 * English. Each entry now carries what was expected and what was observed, and
 * `ok` is computed from the two rather than passed in — which is the shape that
 * makes it impossible to record a pass beside a detail saying the opposite.
 */
function check(name, observed, detail, expected = true) {
  const ok = JSON.stringify(observed) === JSON.stringify(expected);
  const said = detail ?? `expected ${JSON.stringify(expected)} and observed ${JSON.stringify(observed)}`;
  checks.push({ id: name, ok, expected, observed, detail: ok ? null : said });
  if (!ok) failures.push(`${name}: ${said}`);
}

/**
 * A check that the thing under test refuses, for the stated reason.
 *
 * The observed value is the refusal itself — REFUSED plus the fragment that had
 * to appear — so the evidence says what was refused and why, rather than only
 * that something threw.
 */
function refuses(name, run, fragment) {
  let observed;
  try {
    run();
    observed = 'ACCEPTED';
  } catch (error) {
    const text = `${String(error?.message ?? '')} ${String(error?.remedy ?? '')}`;
    observed = text.includes(fragment) ? `REFUSED: ${fragment}` : `REFUSED for another reason: ${text.slice(0, 160)}`;
  }
  const expected = `REFUSED: ${fragment}`;
  const ok = observed === expected;
  checks.push({ id: name, ok, expected, observed, detail: ok ? null : observed });
  if (!ok) failures.push(`${name}: ${observed}`);
}

const contract = buildSalesforceTargetContract(readSalesforceBundleDirectory(resolve(bundleDir)));
const hashed = hashTargetContract(contract);
const salesforce = getAdapter('SALESFORCE');

// ------------------------------------------------- what the org actually says

check('contract.instanceIsSalesforce', contract.instance.mode === 'SALESFORCE', `mode is ${contract.instance.mode}`);
check(
  'contract.objectsCaptured',
  ['Account', 'Contact', 'Lead', 'Opportunity'].every((o) => findObject(contract, o) !== null),
  `captured ${contract.objects.map((o) => o.apiName).join(', ')}`,
);

const account = findObject(contract, 'Account');
const uniqueKey = account === null ? null : findField(account, 'Kauro_Qualification_Key__c');
const nonUnique = account === null ? null : findField(account, 'Kauro_Nonunique_Ext__c');
const restricted = account === null ? null : findField(account, 'Kauro_Qualification_Status__c');

check('contract.externalIdUniqueField', uniqueKey?.externalId === 'TRUE' && uniqueKey.unique === 'TRUE' && uniqueKey.idLookup === 'TRUE',
  `Kauro_Qualification_Key__c reads ext=${uniqueKey?.externalId} uniq=${uniqueKey?.unique} idLookup=${uniqueKey?.idLookup}`);

// The whole point of modelling these separately, proved against a real org
// rather than argued from documentation.
check('contract.externalIdWithoutUnique', nonUnique?.externalId === 'TRUE' && nonUnique.unique === 'FALSE',
  `Kauro_Nonunique_Ext__c reads ext=${nonUnique?.externalId} uniq=${nonUnique?.unique}`);

check('contract.restrictedPicklist',
  restricted?.restrictedPicklist === 'TRUE' && restricted.picklistValues.map((p) => p.value).join(',') === 'READY,BLOCKED',
  `Kauro_Qualification_Status__c reads restricted=${restricted?.restrictedPicklist} values=${restricted?.picklistValues.map((p) => p.value).join(',')}`);

check('contract.recordTypesCaptured', (account?.recordTypes.length ?? 0) > 0, 'Account carries no record type');

// Real orgs repeat picklist values across dependent parents. A reader that
// refuses that cannot read Salesforce.
const stateCode = account === null ? null : findField(account, 'BillingStateCode');
const repeats = stateCode === null ? 0 : stateCode.picklistValues.length - new Set(stateCode.picklistValues.map((p) => p.value)).size;
check('contract.dependentPicklistRepeatsSurvive', stateCode === null || repeats > 0 || stateCode.picklistValues.length === 0,
  'BillingStateCode was expected to repeat at least one code across parents');

// -------------------------------------------- what the engine will match on

const plan = (matching) => ({
  configVersion: '3.0.0',
  source: { system: 'qualification', namespace: 'sf', encoding: null },
  target: { mode: 'SALESFORCE', importMode: 'UPSERT' },
  localeEvidence: { phoneCountry: null, dateFormat: null, decimalSeparator: null, thousandsSeparator: null },
  limits: {}, policies: {}, files: [],
  records: [{ id: 'accounts', object: 'COMPANY', fields: [] }],
  associations: [],
  destinationMatching: [{
    recordMappingId: 'accounts',
    matchAuthority: 'EXTERNAL_ID',
    targetField: 'Kauro_Qualification_Key__c',
    sourceField: 'company.name',
    onMissingMatch: 'ISOLATE',
    onMatchConflict: 'ISOLATE',
    ...matching,
  }],
});

beginCheck('matching.evidencedExternalIdAccepted');
try {
  const [decision] = resolveMatchAuthority(plan({}), salesforce, hashed);
  if (decision?.matchAuthority !== 'EXTERNAL_ID' || decision.contractHash !== hashed.contractHash) {
    failures.push('matching.evidencedExternalIdAccepted: a fully evidenced external id did not resolve');
  }
} catch (error) {
  failures.push(`matching.evidencedExternalIdAccepted: refused a legal match: ${String(error?.message ?? error)}`);
}

refuses('matching.externalIdWithoutUniqueRefused',
  () => resolveMatchAuthority(plan({ targetField: 'Kauro_Nonunique_Ext__c' }), salesforce, hashed),
  'REQUIRES_AGENCY_DECISION');

// The Kauro-made column an org can actually see.
//
// This read `salesforce.traceKeyHeader` until 2.0.0 deleted that field from the
// adapter. It then declared `undefined` as the match authority, which never
// reaches the refusal: the guard folds both names to compare them and throws on
// `undefined` first, so this check reported "refused for the wrong reason"
// rather than anything about the boundary.
//
// `Kauro_Association_Key__c` is the column the adapter writes into 01_IMPORT
// today, so it is the one an org is in a position to create a field for and
// declare as its match authority — which is exactly what must be refused. The
// retired trace-key spellings stay refused by `LEGACY_INTERNAL_KEY_HEADERS`, and
// `test/unit/target-match.test.ts` holds them to it; what a live org adds here is
// that the refusal survives a contract built from a real schema.
refuses('matching.associationKeyRefused',
  () => resolveMatchAuthority(plan({ targetField: salesforce.associationKeyHeader }), salesforce, hashed),
  'association key');

refuses('matching.uncapturedFieldRefused',
  () => resolveMatchAuthority(plan({ targetField: 'Not_In_This_Org__c' }), salesforce, hashed),
  'REQUIRES_AGENCY_DECISION');

// ----------------------------------------------------------------- report

settleChecks();

const evidence = {
  gate: 'SF-TARGET-01 (target contract)',
  // The org the *bundle describes*. Unlike the Data Loader and OCR gates, this
  // one opens a captured directory and talks to no org at all, so there is no
  // credential to ask and nothing was written anywhere. That distinction is
  // recorded rather than left to be inferred from the absence of an `--auth`
  // flag: an evidence file whose `orgId` means something different from the same
  // key in the file beside it is how a reader comes to trust the wrong number.
  orgId: contract.instance.instanceId,
  orgIdSource: 'the captured bundle this gate read; this gate performs no writes and holds no credential',
  // When this gate looked, and at which instance.
  //
  // The instance is the one the *capture* observed, and `observedBy` says so
  // rather than implying a live probe this gate did not make. It holds no
  // credential and writes nothing; what it can honestly say is which org the
  // bundle it parsed came from.
  observedAt: nowUtc(),
  observedInstance: observedInstance({
    vendor: 'salesforce',
    instanceId: contract.instance.instanceId,
    observedBy: 'the capture manifest of the bundle this gate parsed; this gate holds no credential and performs no writes',
    detail: contract.instance.instanceLabel ?? null,
  }),
  instanceUrl: contract.instance.instanceLabel,
  contractHash: hashed.contractHash,
  capturedAt: contract.capturedAt,
  artifacts: contract.artifacts,
  objects: contract.objects.map((o) => ({
    apiName: o.apiName,
    fields: o.fields.length,
    recordTypes: o.recordTypes.map((r) => r.developerName),
    qualificationFields: o.fields
      .filter((f) => f.apiName.startsWith('Kauro_'))
      .map((f) => ({ apiName: f.apiName, externalId: f.externalId, unique: f.unique, idLookup: f.idLookup, restrictedPicklist: f.restrictedPicklist, picklistValues: f.picklistValues.map((p) => p.value) })),
  })),
  checks,
  checksRun: checks.length,
  failures,
  result: failures.length === 0 ? 'PASS' : 'FAIL',
  // Which engine read this bundle. The corpus is this runner rather than a
  // directory of inputs: the bundle it reads lives outside the repository, with
  // the credentials, and what identifies it is the contract hash above. What the
  // binding has to pin is the code that did the reading.
  // Captured by the thing that measured it, rather than stamped afterwards.
  capture: await captureEnd(started),
};

// Everything the oracle declares was asked, checked here rather than only at
// the gate.
//
// qualification/oracles.mjs states the rule — "the runner asserts, before it
// writes anything, that the case ids it produced are exactly the ids declared
// here, so a case that silently stopped running fails the run rather than
// shrinking the evidence" — and no runner called it. Only the gate side ran,
// so a case that stopped running produced a short evidence file that was
// written successfully and refused hours later by somebody who then had to
// work out which of twenty-eight cases had gone missing.
try {
  assertRunnerAskedEverything('sf-target-contract.json', checks);
} catch (error) {
  process.stderr.write(`REFUSED: ${String(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
}

if (evidencePath !== null && evidencePath !== undefined) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

process.stdout.write(`SF-TARGET-01 target contract: ${String(checks.length)} checks\n`);
for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
process.stdout.write(`contract ${hashed.contractHash}\n`);
process.stdout.write(`result = ${evidence.result}\n`);
if (failures.length > 0) process.exitCode = 1;

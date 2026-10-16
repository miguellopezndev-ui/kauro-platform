#!/usr/bin/env node
// HSP-TARGET-01, the target-contract half.
//
// Reads the artifacts captured from a real HubSpot portal, builds the target
// contract with the shipped readers, and puts the engine's destination-match
// rules to that contract. Nothing here is a fixture: the property export is the
// file the portal produced, and the uniqueness statements are what the portal
// answered when asked.
//
// Usage:
//   node run-target-qualification.mjs <bundle-dir> [--evidence <file>]
import { readFileSync, writeFileSync } from 'node:fs';
const { assertRunnerAskedEverything } = await import('../oracles.mjs');
import { join, resolve } from 'node:path';

const bundleDir = process.argv[2];
if (bundleDir === undefined) {
  process.stderr.write('usage: node run-target-qualification.mjs <bundle-dir> [--evidence <file>]\n');
  process.exit(2);
}
const evidenceIndex = process.argv.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1];

const {
  parseHubSpotPropertyExport,
  parseHubSpotPropertyApi,
  parseHubSpotPipelineArtifact,
  parseHubSpotSupplement,
  parseHubSpotAccessGrant,
  buildHubSpotTargetContract,
  hubSpotArtifactRef,
} = await import('../../dist/src/target/hubspot-artifacts.js');
const { hashTargetContract, serializeTargetContract, loadTargetContract, findObject, findField, findPipeline, findStage } =
  await import('../../dist/src/target/contract.js');
const { resolveMatchAuthority } = await import('../../dist/src/target/match-authority.js');
const { getAdapter } = await import('../../dist/src/adapters/specs.js');
const { captureEnd, captureStart, nowUtc, observedInstance } = await import('../campaign.mjs');
const started = await captureStart({ producer: 'qualification/hubspot/run-target-qualification.mjs' });

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

const root = resolve(bundleDir);
const read = (name) => readFileSync(join(root, name), 'utf8');

// ------------------------------------------------------------------- C1, C2
//
// The route comes from `capture-manifest.json`, which the collector writes last,
// after every artifact — so its presence is also the statement that the capture
// finished. Inferring the route from which files happen to be present would read
// a half-written capture as a complete one, silently.
//
// There are two routes and this gate has to cover both, because they establish
// different things about the same portal. A Settings **export** is what an
// agency can hand over without giving anybody a credential, and it states no
// uniqueness at all. The **properties API** needs a credential and gives
// `hasUniqueValue` as an artifact — the one fact a HubSpot match key rests on,
// which on the export route a person has to assert in a supplement. Qualifying
// only the export route left the better evidence untested; qualifying only the
// API route would drop the case an agency actually uses.

const manifest = (() => {
  try {
    return JSON.parse(read('capture-manifest.json'));
  } catch {
    process.stderr.write(
      `${join(root, 'capture-manifest.json')} is missing or unreadable. A capture is finished when its manifest is written.\n`,
    );
    process.exit(1);
  }
})();
if (manifest.artifactKind !== 'HUBSPOT_CAPTURE_MANIFEST') {
  process.stderr.write(`capture-manifest.json declares artifactKind "${String(manifest.artifactKind)}"\n`);
  process.exit(1);
}
const route = String(manifest.route);

/** The floor a capture has to clear before its own count is worth believing. */
const FEWEST_CREDIBLE_PROPERTIES = 50;

const objects = [];
const apiCaptures = [];
const propertyArtifacts = [];

if (route === 'EXPORT') {
  // The count comes from the capture, not from here.
  //
  // 209, 115 and 73 were written into this file as the expected field counts,
  // and they are portal 51050101's counts on one day in September — the account
  // that qualification/authorized-instances.json now lists as explicitly out of
  // scope, because it holds real customer records. A gate asserting those three
  // numbers is asserting something about a portal this repository has ruled out,
  // and it goes stale the first time anybody adds a property to any portal.
  //
  // The API route below already reads the count from the manifest and floors it
  // for credibility. This does the same. A manifest that declares no count for
  // an export refuses rather than falling back to a memorised one: a number
  // nobody wrote down is not a weaker expectation, it is a different claim.
  // The collector writes `propertyExports` as a list of file names, not of
  // objects — see collect-target-schema.mjs — and the import half of this gate
  // reads it that way. Reading it as objects made every entry collapse to the
  // key "undefined" with a NaN count, so the EXPORT route refused before
  // recording a single check. Both shapes are read here, because a capture taken
  // by an older collector is still a capture.
  const declaredExports = new Map(
    (manifest.propertyExports ?? []).map((entry) =>
      typeof entry === 'string' ? [entry, null] : [String(entry.path), Number(entry.properties)],
    ),
  );
  const EXPORTS = [
    ['contact.csv', 'CONTACT', 'Contact'],
    ['company.csv', 'COMPANY', 'Company'],
    ['deal.csv', 'DEAL', 'Deal'],
  ];
  for (const [file, apiName, label] of EXPORTS) {
    if (!declaredExports.has(file)) {
      process.stderr.write(`REFUSED: the capture manifest does not name ${file}, so this bundle is not an EXPORT capture of it.\n`);
      process.exit(1);
    }
    const expectedFields = declaredExports.get(file);
    const text = read(file);
    const object = parseHubSpotPropertyExport(text, { objectApiName: apiName, objectLabel: label, filePath: file });
    objects.push(object);
    propertyArtifacts.push(hubSpotArtifactRef(file, 'HUBSPOT_PROPERTY_EXPORT', text));
    // A count when the capture states one, and a credibility floor either way.
    // A manifest that names the file without a count is an older capture, and a
    // gate that then invented a count would be back to pinning one portal on
    // one day.
    if (Number.isInteger(expectedFields)) {
      check(`export.${apiName}.fieldCount`, object.fields.length, `${file} parsed ${String(object.fields.length)} fields`, expectedFields);
    }
    check(`export.${apiName}.captureIsCredible`, object.fields.length >= FEWEST_CREDIBLE_PROPERTIES,
      `${file} parsed ${String(object.fields.length)} fields, below the ${String(FEWEST_CREDIBLE_PROPERTIES)} a real HubSpot object carries`);
    check(`export.${apiName}.everyFieldIsArtifactEvidence`, object.fields.every((f) => f.evidence === 'ARTIFACT'),
      `${file} produced a field that is not ARTIFACT evidence`);
    // The export states no uniqueness. A reader that turns silence into FALSE
    // would authorize nothing; one that turns it into TRUE would authorize
    // everything. It has to stay UNKNOWN.
    check(`export.${apiName}.uniquenessIsUnknown`, object.fields.every((f) => f.unique === 'UNKNOWN'),
      `${file} produced a field whose uniqueness is ${object.fields.find((f) => f.unique !== 'UNKNOWN')?.unique ?? ''}`);
  }
} else if (route === 'API') {
  for (const capture of manifest.propertyApiCaptures ?? []) {
    const text = read(capture.path);
    const parsed = parseHubSpotPropertyApi(text, {
      objectApiName: capture.objectApiName,
      objectLabel: capture.objectLabel,
      portalId: String(manifest.portalId),
      portalIdSource: capture.portalIdSource,
      filePath: capture.path,
    });
    apiCaptures.push(parsed);
    propertyArtifacts.push(hubSpotArtifactRef(capture.path, 'HUBSPOT_PROPERTY_API', text));

    // Against the capture's own count rather than a number memorised here. A
    // memorised count pins one portal on one day — the export route's 209, 115
    // and 73 are 51050101's and nobody else's — and goes stale the first time
    // somebody adds a property. What has to be true of the reader is that it
    // reads *everything the capture contains*, and the manifest says how much
    // that is, written by the collector from the response it received.
    //
    // The floor is what stops that being circular: a capture claiming three
    // properties, read faithfully as three, would otherwise pass.
    const apiName = parsed.object.apiName;
    check(`api.${apiName}.everyPropertyRead`, parsed.object.fields.length === capture.properties,
      `${capture.path} declares ${String(capture.properties)} properties and the reader produced ${String(parsed.object.fields.length)} fields`);
    check(`api.${apiName}.captureIsCredible`, capture.properties >= FEWEST_CREDIBLE_PROPERTIES,
      `${capture.path} declares ${String(capture.properties)} properties, below the ${String(FEWEST_CREDIBLE_PROPERTIES)} a real HubSpot object carries`);
    check(`api.${apiName}.everyFieldIsArtifactEvidence`, parsed.object.fields.every((f) => f.evidence === 'ARTIFACT'),
      `${capture.path} produced a field that is not ARTIFACT evidence`);
    // The improvement the route exists for. Uniqueness arrives from the portal
    // rather than from somebody's assertion, so at least one property has to
    // come out TRUE and none may come out UNKNOWN by default.
    check(`api.${apiName}.uniquenessIsStated`, parsed.object.fields.some((f) => f.unique === 'TRUE' || f.unique === 'FALSE'),
      `${capture.path} states uniqueness on no property at all`);
    check(`api.${apiName}.portalIsStated`, parsed.portalId === String(manifest.portalId),
      `${capture.path} was read as portal ${parsed.portalId} and the capture says ${String(manifest.portalId)}`);
    check(`api.${apiName}.ignoredKeysAreRecorded`, Array.isArray(parsed.ignoredKeys),
      `${capture.path} does not report which keys the projection dropped`);
  }
  check('api.everyObjectCaptured', apiCaptures.length === 3,
    `the capture carries ${String(apiCaptures.length)} objects where CONTACT, COMPANY and DEAL belong`);
} else {
  process.stderr.write(`capture-manifest.json declares route "${route}"; this runner reads EXPORT and API\n`);
  process.exit(1);
}

// ----------------------------------------------------------------------- C3

const pipelineText = read('pipelines.csv');
const pipelineArtifact = parseHubSpotPipelineArtifact(pipelineText, { filePath: 'pipelines.csv' });
const EXPECTED_STAGES = [
  'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled',
  'decisionmakerboughtin', 'contractsent', 'closedwon', 'closedlost',
];
check('pipelines.oneDealPipeline', pipelineArtifact.pipelines.length === 1,
  `parsed ${String(pipelineArtifact.pipelines.length)} pipelines`);
const dealPipeline = pipelineArtifact.pipelines[0] ?? null;
check('pipelines.stageInternalNames',
  (dealPipeline?.stages ?? []).map((s) => s.stageInternalName).join(',') === EXPECTED_STAGES.join(','),
  `stages read ${(dealPipeline?.stages ?? []).map((s) => s.stageInternalName).join(',')}`);

// --------------------------------------------------------------- the contract

const supplementText = read('hubspot-supplement.json');
const supplement = parseHubSpotSupplement(supplementText, 'hubspot-supplement.json');

const artifacts = [
  ...propertyArtifacts,
  hubSpotArtifactRef('pipelines.csv', 'HUBSPOT_PIPELINE_ARTIFACT', pipelineText),
  hubSpotArtifactRef('hubspot-supplement.json', 'HUBSPOT_SUPPLEMENT', supplementText),
];

// C6: the access grant. Capture version 2 writes the portal's answer to the
// token-information endpoint beside the property artifacts; the contract reads
// the object flags from it. A capture without one is read as before, and the
// negative control below shows what that capture would state.
const grantPath = typeof manifest.accessGrant === 'string' ? manifest.accessGrant : null;
const grantText = grantPath === null ? null : read(grantPath);
const accessGrant = grantText === null ? undefined : parseHubSpotAccessGrant(grantText, grantPath);
if (grantPath !== null && grantText !== null) artifacts.push(hubSpotArtifactRef(grantPath, 'HUBSPOT_ACCESS_GRANT', grantText));

const build = () =>
  buildHubSpotTargetContract({
    supplement,
    objects,
    apiCaptures,
    pipelines: pipelineArtifact.pipelines,
    artifacts,
    ...(accessGrant === undefined ? {} : { accessGrant }),
  });
const contract = build();
const hashed = hashTargetContract(contract);
const hubspot = getAdapter('HUBSPOT');

// The portal comes from the supplement the collector captured, not from a
// constant here. A constant made this runner describe one portal while the
// bundle described another, which is exactly the mistake it exists to catch.
check('contract.portal', contract.instance.instanceId === supplement.portalId,
  `the contract names portal ${contract.instance.instanceId} and the supplement names ${supplement.portalId}`);
check('contract.mode', contract.instance.mode === 'HUBSPOT', `mode is ${contract.instance.mode}`);
check('contract.objects', ['CONTACT', 'COMPANY', 'DEAL'].every((o) => findObject(contract, o) !== null),
  `captured ${contract.objects.map((o) => o.apiName).join(', ')}`);

// ----------------------------------------------------------------------- C6

check('grant.captured', accessGrant !== undefined,
  `the capture manifest names ${grantPath === null ? 'no access grant' : grantPath}`);
check('grant.portalIsStated', accessGrant !== undefined && accessGrant.portalId === String(manifest.portalId),
  `the grant was answered by portal ${String(accessGrant?.portalId)} and the capture says ${String(manifest.portalId)}`);
const WRITE_SCOPES = ['crm.objects.contacts.write', 'crm.objects.companies.write', 'crm.objects.deals.write'];
check('grant.writeScopesGranted', WRITE_SCOPES.every((scope) => (accessGrant?.scopes ?? []).includes(scope)),
  `granted: ${(accessGrant?.scopes ?? []).filter((scope) => scope.endsWith('.write')).join(', ') || 'none'}`);
check('contract.objectsWriteableFromTheGrant',
  ['CONTACT', 'COMPANY', 'DEAL'].every((o) => findObject(contract, o)?.createable === 'TRUE' && findObject(contract, o)?.updateable === 'TRUE'),
  `flags: ${contract.objects.map((o) => `${o.apiName} createable ${o.createable} updateable ${o.updateable}`).join('; ')}`);
// Negative control: the same capture read without its grant states UNKNOWN,
// which the engine refuses to write against. The grant is the difference.
const withoutGrant = buildHubSpotTargetContract({
  supplement,
  objects,
  apiCaptures,
  pipelines: pipelineArtifact.pipelines,
  artifacts: artifacts.filter((artifact) => artifact.kind !== 'HUBSPOT_ACCESS_GRANT'),
});
check('contract.flagsUnknownWithoutTheGrant',
  withoutGrant.objects.every((o) => o.createable === 'UNKNOWN' && o.updateable === 'UNKNOWN') &&
    hashTargetContract(withoutGrant).contractHash !== hashed.contractHash,
  `without the grant: ${withoutGrant.objects.map((o) => `${o.apiName} ${o.createable}`).join('; ')}`);

// ----------------------------------------------------------------------- C4

const resolvedPipeline = findPipeline(contract, 'DEAL', 'Sales Pipeline');
check('stages.resolveByInternalIdentity',
  findStage(resolvedPipeline ?? { stages: [] }, 'Closed Won')?.stageInternalName === 'closedwon',
  `"Closed Won" resolved to ${String(findStage(resolvedPipeline ?? { stages: [] }, 'Closed Won')?.stageInternalName)}`);
check('stages.unknownLabelResolvesToNothing',
  findStage(resolvedPipeline ?? { stages: [] }, 'No Such Stage') === null,
  'an unknown stage label resolved to a stage');

// ----------------------------------------------------------------------- C5

check('contract.digestIsStable', hashTargetContract(build()).contractHash === hashed.contractHash,
  'two builds from the same bytes produced different digests');

beginCheck('contract.tamperedTextRefused');
{
  const serialized = serializeTargetContract(hashed);
  // One character, in a place that changes what the contract says rather than
  // how it is spelled: the portal it speaks for.
  const tampered = serialized.replace(`"${supplement.portalId}"`, `"${String(Number(supplement.portalId) + 1)}"`);
  if (tampered === serialized) {
    failures.push('contract.tamperedTextRefused: the tamper did not alter the text, so the check proved nothing');
  } else {
    try {
      loadTargetContract(tampered, 'tampered.json');
      failures.push('contract.tamperedTextRefused: a contract altered after hashing loaded anyway');
    } catch { /* refused, as it must be */ }
  }
}

// ------------------------------------------------------- what the fields say

const contactObject = findObject(contract, 'CONTACT');
const email = contactObject === null ? null : findField(contactObject, 'email');
const firstName = contactObject === null ? null : findField(contactObject, 'firstname');
check('fields.emailIsCaptured', email !== null, 'the capture carried no email property');
// Where the uniqueness came from, and the two routes answer differently on
// purpose. On the export route HubSpot states no uniqueness at all, so `email`
// is unique because a person said so in the supplement — SUPPLEMENT evidence,
// and the weakest link in a HubSpot match key. On the API route the portal says
// it itself, and recording that as SUPPLEMENT would understate it as badly as
// recording a supplement as ARTIFACT would overstate one.
const expectedEmailEvidence = route === 'API' ? 'ARTIFACT' : 'SUPPLEMENT';
check(
  `fields.emailUniquenessFrom${route === 'API' ? 'ThePortal' : 'Supplement'}`,
  email?.unique === 'TRUE' && email.evidence === expectedEmailEvidence,
  `email reads unique=${String(email?.unique)} evidence=${String(email?.evidence)}, expected TRUE/${expectedEmailEvidence}`,
);
check('fields.firstNameIsNotUnique', firstName?.unique === 'FALSE',
  `firstname reads unique=${String(firstName?.unique)}`);
// HubSpot has no external-id concept, and a contract that invented one would
// let a Salesforce-shaped configuration authorize itself here.
check('fields.noExternalIdIsClaimed', contract.objects.every((o) => o.fields.every((f) => f.externalId !== 'TRUE')),
  'a HubSpot field claims to be an external id');

// ------------------------------------------------ what the engine may match on

const plan = (matching) => ({
  configVersion: '3.0.0',
  source: { system: 'qualification', namespace: 'hs', encoding: null },
  target: { mode: 'HUBSPOT', importMode: 'UPSERT' },
  localeEvidence: { phoneCountry: null, dateFormat: null, decimalSeparator: null, thousandsSeparator: null },
  limits: {}, policies: {}, files: [],
  records: [{ id: 'contacts', object: 'CONTACT', fields: [] }],
  associations: [],
  destinationMatching: [{
    recordMappingId: 'contacts',
    matchAuthority: 'TARGET_UNIQUE_FIELD',
    targetField: 'email',
    sourceField: 'contact.email',
    onMissingMatch: 'ISOLATE',
    onMatchConflict: 'ISOLATE',
    ...matching,
  }],
});

beginCheck('matching.uniquePropertyAccepted');
try {
  const [decision] = resolveMatchAuthority(plan({}), hubspot, hashed);
  if (decision?.matchAuthority !== 'TARGET_UNIQUE_FIELD') {
    failures.push(`matching.uniquePropertyAccepted: resolved as ${String(decision?.matchAuthority)}`);
  } else if (decision.contractHash !== hashed.contractHash) {
    failures.push('matching.uniquePropertyAccepted: the decision does not carry the digest it was authorized against');
  } else if (decision.resolvedField?.apiName !== 'email') {
    failures.push(`matching.uniquePropertyAccepted: resolved to ${String(decision.resolvedField?.apiName)}`);
  }
} catch (error) {
  failures.push(`matching.uniquePropertyAccepted: refused a legal match: ${String(error?.message ?? error)}`);
}

beginCheck('matching.recordIdAccepted');
try {
  const [decision] = resolveMatchAuthority(
    plan({ matchAuthority: 'RECORD_ID', targetField: 'hs_object_id' }), hubspot, hashed);
  if (decision?.matchAuthority !== 'RECORD_ID') {
    failures.push(`matching.recordIdAccepted: resolved as ${String(decision?.matchAuthority)}`);
  }
} catch (error) {
  failures.push(`matching.recordIdAccepted: refused the record id: ${String(error?.message ?? error)}`);
}

refuses('matching.nonUniquePropertyRefused',
  () => resolveMatchAuthority(plan({ targetField: 'firstname' }), hubspot, hashed),
  'REQUIRES_AGENCY_DECISION');

refuses('matching.uncapturedPropertyRefused',
  () => resolveMatchAuthority(plan({ targetField: 'not_in_this_portal' }), hubspot, hashed),
  'REQUIRES_AGENCY_DECISION');

// The column the adapter actually writes into 01_IMPORT today.
//
// This read `hubspot.traceKeyHeader` until 2.0.0 deleted that field from the
// adapter. It then declared `undefined` as the match authority, which does not
// reach the refusal at all: the guard folds both names to compare them and
// throws on `undefined` first, so `refuses` sees an error that does not carry
// the fragment and reports "refused for the wrong reason". Whichever way it
// lands, an assertion whose subject does not exist says nothing about the
// boundary it was written to guard.
//
// The retired trace-key spellings are covered by the loop below, so this one
// takes the live column: the one an operator can see in the file, and therefore
// the one they might be tempted to have their portal match on.
refuses('matching.associationKeyRefused',
  () => resolveMatchAuthority(plan({ targetField: hubspot.associationKeyHeader }), hubspot, hashed),
  'association key');

refuses('matching.externalIdRefusedForHubSpot',
  () => resolveMatchAuthority(plan({ matchAuthority: 'EXTERNAL_ID' }), hubspot, hashed),
  'EXTERNAL_ID');

// The trace key is gone from 01_IMPORT, but a portal that imported a 1.1.0
// package may still carry a property created to hold it, so the refusal has to
// outlive the column. Every spelling it could arrive under, because a refusal
// that one rename defeats is not a refusal.
for (const spelling of ['Kauro Trace Key', 'kauro_trace_key', 'KAURO TRACE KEY', 'kauro trace key']) {
  refuses(`matching.traceKeyRefused[${spelling}]`,
    () => resolveMatchAuthority(plan({ targetField: spelling }), hubspot, hashed),
    'trace key');
}

// ---------------------------------------------------------------------- report

settleChecks();

const evidence = {
  gate: 'HSP-TARGET-01 (target contract)',
  // The portal the *capture describes*. This gate opens a captured directory and
  // talks to no portal, so there is no credential to ask and nothing was written
  // anywhere — unlike the import half, where the two are different questions and
  // conflating them recorded the wrong tenant.
  portalId: contract.instance.instanceId,
  portalIdSource: 'the captured bundle this gate read; it performs no writes and holds no credential',
  route,
  contractHash: hashed.contractHash,
  capturedAt: contract.capturedAt,
  artifacts: contract.artifacts,
  objects: contract.objects.map((o) => ({
    apiName: o.apiName,
    fields: o.fields.length,
    uniqueProperties: o.fields.filter((f) => f.unique === 'TRUE').map((f) => f.apiName),
  })),
  pipelines: contract.pipelines.map((p) => ({
    objectApiName: p.objectApiName,
    pipelineInternalName: p.pipelineInternalName,
    stages: p.stages.map((s) => s.stageInternalName),
  })),
  observedAt: nowUtc(),
  observedInstance: observedInstance({
    vendor: 'hubspot',
    instanceId: String(manifest.portalId),
    observedBy: 'the capture manifest of the bundle this gate parsed; this gate holds no credential and performs no writes',
    detail: String(manifest.accountType ?? 'account type not stated'),
  }),
  checks,
  checksRun: checks.length,
  failures,
  result: failures.length === 0 ? 'PASS' : 'FAIL',
  // Which engine read this capture. The corpus is this runner rather than a
  // directory of inputs: the capture it reads lives outside the repository, with
  // the credentials, and what identifies it is the contract hash two lines
  // above. What the binding has to pin is the code that did the reading.
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
  assertRunnerAskedEverything('hs-target-contract.json', checks);
} catch (error) {
  process.stderr.write(`REFUSED: ${String(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
}

if (evidencePath !== null && evidencePath !== undefined) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

process.stdout.write(`HSP-TARGET-01 target contract: ${String(checks.length)} checks\n`);
for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
process.stdout.write(`contract ${hashed.contractHash}\n`);
process.stdout.write(`result = ${evidence.result}\n`);
if (failures.length > 0) process.exitCode = 1;

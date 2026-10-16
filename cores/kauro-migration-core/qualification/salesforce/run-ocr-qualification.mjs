#!/usr/bin/env node
// SF-OCR-01, qualified separately so that its outcome cannot block the rest.
//
// Expected truth, written before the run:
//
//   O1  An OpportunityContactRole loads through Data Loader with OpportunityId,
//       ContactId, Role and IsPrimary. Expect 1 success, 0 errors.
//   O2  The link is real: querying the role back returns the same OpportunityId
//       and ContactId that were loaded, and IsPrimary true.
//   O3  There is no ContactId on Opportunity. The adapter must not model one,
//       and the describe must not carry one — this is the claim that keeps the
//       engine from inventing a relationship Salesforce does not have.
//
// If O1 or O2 cannot be met, SF-OCR-01 is OUT and base Salesforce is unaffected.
//
// Usage:
//   node run-ocr-qualification.mjs --auth <dir> [--evidence <file>]
import { execFileSync } from 'node:child_process';
const { assertRunnerAskedEverything } = await import('../oracles.mjs');
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { establishOrg, orgEvidenceFields } from './org-identity.mjs';
import { assertInstanceAuthorised, captureEnd, captureStart, nowUtc, observedInstance } from '../campaign.mjs';
import { campaignNamespace } from '../namespace.mjs';
import { runDataLoader } from './data-loader.mjs';

const authIndex = process.argv.indexOf('--auth');
if (authIndex === -1) {
  process.stderr.write('usage: node run-ocr-qualification.mjs --auth <dir> [--evidence <file>]\n');
  process.exit(2);
}
const authDir = resolve(process.argv[authIndex + 1]);
const evidenceIndex = process.argv.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1];

const shPath = (...p) => join(...p).split('\\').join('/');
// The driver lives in this repository now; see data-loader.mjs.

function sf(method, path, body) {
  const args = [shPath(authDir, 'sf.sh'), method, path.split("'").join('%27')];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const parsed = JSON.parse(out.split('\n__HTTP_STATUS__')[0]);
  if (status >= 400 || Array.isArray(parsed)) {
    throw new Error(`${method} ${path} -> ${String(status)}: ${JSON.stringify(parsed).slice(0, 240)}`);
  }
  return parsed;
}

function rows(csv) {
  if (csv === null || csv.trim() === '') return [];
  const lines = csv.trim().split(/\r?\n/);
  const headers = (lines[0] ?? '').split(',').map((h) => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const cells = (line.match(/("([^"]|"")*"|[^,]*)/g) ?? []).filter((_, i) => i % 2 === 0);
    const row = {};
    headers.forEach((h, i) => { row[h] = String(cells[i] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"'); });
    return row;
  });
}

const cases = [];
const failures = [];
/**
 * One expectation, as a pair, with the verdict derived from the comparison.
 *
 * This gate is the reason the helper is shaped this way: `O3` recorded
 * `ok: true` beside a detail that said the opposite, because the verdict was an
 * argument and nothing compared it to anything. Computing it from the pair makes
 * that impossible.
 *
 * @param {string} id declared in qualification/oracles.mjs
 * @param {unknown} observed what the org said
 * @param {string|null} detail what to say when it does not match
 * @param {unknown} expected what it had to be
 */
const expect = (id, observed, detail, expected = true) => {
  const ok = JSON.stringify(observed) === JSON.stringify(expected);
  const said = detail ?? `expected ${JSON.stringify(expected)} and observed ${JSON.stringify(observed)}`;
  cases.push({ id, ok, expected, observed, detail: ok ? null : said });
  if (!ok) failures.push(`${id}: ${said}`);
};

// Who this session is, before anything is created. See `org-identity.mjs`.
const org = establishOrg(sf);

// Which org, and whether writing to it is permitted, before the first write.
const observed = observedInstance({
  vendor: 'salesforce',
  instanceId: org.orgId,
  observedBy: org.orgIdSource,
  detail: `${String(org.organizationType)}${org.isSandbox ? ' (sandbox)' : ''}`,
});
try {
  assertInstanceAuthorised(observed);
} catch (error) {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}
const campaign = campaignNamespace();
const started = await captureStart({ producer: 'qualification/salesforce/run-ocr-qualification.mjs' });
const capturedAt = nowUtc();

const work = join(authDir, 'ocr');
mkdirSync(work, { recursive: true });
// The instant, to the second, so each run makes its own records and a reader can
// tell from a name when they were made. `KAURO_QUAL_STAMP` still overrides it.
// The campaign, then the instant: a leftover record is attributable to the
// evidence it was taken beside rather than only to a moment.
const stamp =
  process.env.KAURO_QUAL_STAMP ??
  `OCR-${campaign.namespace}-${new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14)}`;
// The override may not take the run out of its campaign. X3 asks the org for
// records carrying this namespace; a stamp without it means every record this
// run creates is invisible to the question, and the case passes having asked
// about nothing.
if (!stamp.includes(campaign.namespace)) {
  process.stderr.write(
    `REFUSED: KAURO_QUAL_STAMP is "${stamp}" and does not carry this campaign's namespace ${campaign.namespace}.\n`,
  );
  process.exit(1);
}

// The launcher, compiled once against the jar in hand, and the session it uses.
// Every load is told which org and which user its login must land on; a login
// that lands elsewhere is refused by the launcher rather than found afterwards
// in the evidence.
const { compileLauncher, jarPath, javaVersions } = await import('./dataloader-headless.mjs');
const { launches } = await import('./data-loader.mjs');
const compiledLauncher = compileLauncher({ jar: jarPath(authDir), classesDir: join(work, 'launcher-classes') });
const whoami = sf('GET', '/services/oauth2/userinfo');
// No shared session: one is minted per load.
//
// The launcher calls `controller.logout()` when it finishes, which revokes the
// session id it was given. A session handed to every load therefore worked once
// and then failed AUTH_INVALID for the rest of the run: the first load
// succeeded and the other eleven reported "Failed to get user info using
// manually configured session id". Before the stale-results fix that failure
// was invisible, because the previous run's success.csv was still on disk.
const loaderContext = {
  expectedOrgId: org.orgId,
  expectedUserId: String(whoami?.user_id ?? ''),
  compiled: compiledLauncher,
};

// Endpoints for the pair the role will join. Created through the API rather
// than assumed to exist, so the run does not depend on leftovers.
const account = sf('POST', '/services/data/v67.0/sobjects/Account', { Name: `Kauro OCR Account ${stamp}` });
const contact = sf('POST', '/services/data/v67.0/sobjects/Contact', { LastName: `KauroOCR${stamp}`, AccountId: account.id });
const opportunity = sf('POST', '/services/data/v67.0/sobjects/Opportunity', {
  Name: `Kauro OCR Opportunity ${stamp}`,
  CloseDate: '2026-12-31',
  StageName: 'Prospecting',
  AccountId: account.id,
});

// -------------------------------------------------------------------- O1, O2

const outDir = join(work, 'O1');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const input = join(outDir, 'ocr.csv');
writeFileSync(input, `OpportunityId,ContactId,Role,IsPrimary\n${opportunity.id},${contact.id},Decision Maker,true\n`);

const loaded = runDataLoader({
  name: 'ocrInsert',
  entity: 'OpportunityContactRole',
  operation: 'insert',
  inputCsv: input,
  mapping: [['OpportunityId', 'OpportunityId'], ['ContactId', 'ContactId'], ['Role', 'Role'], ['IsPrimary', 'IsPrimary']],
  outDir,
  authDir,
  ...loaderContext,
});
const successRows = rows(loaded.success);
const errorRows = rows(loaded.error);

expect('O1', successRows.length === 1 && errorRows.length === 0,
  `insert produced ${successRows.length} successes and ${errorRows.length} errors: ${(errorRows[0]?.ERROR ?? '').slice(0, 160)}`);

if (successRows.length === 1) {
  const back = sf('GET', `/services/data/v67.0/query?q=${encodeURIComponent(`SELECT Id, OpportunityId, ContactId, Role, IsPrimary FROM OpportunityContactRole WHERE Id = '${successRows[0].ID}'`)}`);
  const role = back.records?.[0];
  expect('O2.opportunity', role?.OpportunityId === opportunity.id, `role points at opportunity ${role?.OpportunityId}, expected ${opportunity.id}`);
  expect('O2.contact', role?.ContactId === contact.id, `role points at contact ${role?.ContactId}, expected ${contact.id}`);
  expect('O2.isPrimary', role?.IsPrimary === true, `IsPrimary read back as ${String(role?.IsPrimary)}`);
  expect('O2.role', role?.Role === 'Decision Maker', `Role read back as ${String(role?.Role)}`);
}

// ------------------------------------------------------------------------ O3

// Opportunity does carry a ContactId — the first version of this check asserted
// it did not, and a real org disagreed. What matters is not whether the field
// exists but whether it could serve as a migration relationship, and it cannot:
// the org reports it createable but not updateable, with no relationship name.
// It can be set once at insert, never corrected, and never resolved by an
// external id. Writing to it would deliver a link the engine could not put right.
const opportunityDescribe = sf('GET', '/services/data/v67.0/sobjects/Opportunity/describe');
const contactId = (opportunityDescribe.fields ?? []).find((f) => f.name === 'ContactId') ?? null;

// The field has to be there for either of the next two to mean anything.
//
// Both were written `contactId === null || …`, so a describe that no longer
// carried ContactId satisfied "ContactId is not updateable" — the check passed
// most loudly in the one case where it had nothing to check. Worse, the comment
// four lines above says the opposite: that a real org *does* carry the field and
// the first version of this check was wrong to say it did not. A gate whose
// prose and whose predicate disagree is the defect this whole front is about.
expect('O3.contactIdIsPresent', contactId !== null,
  'the Opportunity describe carries no ContactId field, so nothing below is a statement about it');
expect('O3.contactIdIsNotUpdateable', contactId?.updateable ?? null,
  `Opportunity.ContactId reports updateable=${String(contactId?.updateable)}`,
  false);
// Guarded on presence, like its sibling. Written as `contactId?.relationshipName
// ?? null` against an expected `null`, an absent field made observed and
// expected both null and the case passed about a field that does not exist —
// which is the half of the O3 defect that survived the first repair.
expect('O3.contactIdHasNoRelationshipName',
  contactId === null ? 'the field is absent' : contactId.relationshipName,
  `Opportunity.ContactId reports relationshipName=${String(contactId?.relationshipName)}`,
  null);

const { getAdapter } = await import('../../dist/src/adapters/specs.js');
const salesforce = getAdapter('SALESFORCE');
expect('O3.adapterDoesNotClaimIt', salesforce.relationships.CONTACT_TO_DEAL.kind,
  'the adapter claims a contact-to-opportunity relationship, which Salesforce models as this junction object',
  'UNSUPPORTED');

// -------------------------------------------------------------------- report

/**
 * The four records this gate made, removed in the reverse of the order it made
 * them.
 *
 * Nothing here used to be removed, and the org is a Developer Edition with five
 * megabytes of data storage. A gate that leaves its fixtures behind fills the
 * tenant it qualifies against, and then fails for a reason that has nothing to
 * do with Salesforce or with the engine.
 *
 * Reverse because a child points at a parent: the role before the opportunity,
 * the contact before the account. A failure to delete is reported and does not
 * fail the gate -- what this gate establishes is what Data Loader did with an
 * OpportunityContactRole, and a leftover record is housekeeping.
 */
const madeHere = [
  ...(successRows.length === 1 && (successRows[0].ID ?? '') !== ''
    ? [{ entity: 'OpportunityContactRole', id: successRows[0].ID }]
    : []),
  { entity: 'Opportunity', id: opportunity.id },
  { entity: 'Contact', id: contact.id },
  { entity: 'Account', id: account.id },
];

/**
 * The HTTP status of one request, and nothing else.
 *
 * Used by the cleanup read-back. Asking `sf()` and reading the message of the
 * exception it throws makes the read-back depend on how that message is
 * spelled: the two Salesforce runners format it differently — one says
 * "returned status 404" and the other "-> 404" — so a read-back written against
 * one of them silently reported every record as still present when run beside
 * the other. A status is a number; this returns the number.
 */
function httpStatus(method, path) {
  const out = execFileSync('bash', [shPath(authDir, 'sf.sh'), method, path], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return Number((out.match(/__HTTP_STATUS__:(\d+)/u) ?? [])[1] ?? 0);
}

const cleanup = { attempted: madeHere.length, deleted: 0, confirmedGone: 0, problems: [], readBack: [], leftBehind: [], ok: false };
for (const record of madeHere) {
  try {
    // Not through `sf`, which parses the body: a successful DELETE answers 204
    // with no body, and a parser handed nothing reports a failure that did not
    // happen.
    const out = execFileSync(
      'bash',
      [shPath(authDir, 'sf.sh'), 'DELETE', `/services/data/v67.0/sobjects/${record.entity}/${record.id}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const status = Number((out.match(/__HTTP_STATUS__:(\d+)/u) ?? [])[1] ?? 0);
    if (status !== 204 && status !== 200) throw new Error(`status ${String(status)}`);
    cleanup.deleted += 1;
  } catch (error) {
    cleanup.problems.push(`${record.entity} ${record.id}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  // Read back. A DELETE that answered 204 and a record that is actually gone are
  // two different observations, and only the second is what "the org is as we
  // found it" means.
  let present = true;
  let detail = null;
  try {
    const status = httpStatus('GET', `/services/data/v67.0/sobjects/${record.entity}/${record.id}`);
    present = status === 200;
    detail = `GET -> ${String(status)}`;
  } catch (error) {
    detail = String(error && error.message ? error.message : error).slice(0, 160);
  }
  cleanup.readBack.push({ entity: record.entity, id: record.id, stillPresent: present, detail });
  if (present) cleanup.leftBehind.push(`${record.entity} ${record.id}`);
}
cleanup.confirmedGone = cleanup.readBack.filter((entry) => !entry.stillPresent).length;
cleanup.ok = cleanup.leftBehind.length === 0;

// H1 and H2: the login, and what it did not do.
//
// A configuration saying `headless: true` proves nothing — the driver this
// replaced set the equivalent and opened a browser anyway. What is recorded is
// the exit class the launcher reported and the browser-flow markers found in
// the Data Loader log each launch produced, with that log's digest beside them.
const browserLaunches = launches.filter((entry) => entry.browserFlowEntered);
// A floor, because `launches.length` on both sides of the comparison is not a
// comparison. With no launches at all the observed object was
// `{launches: 0, allSucceededOrFailedCleanly: true}` — `[].every()` is true —
// and the expected object was identical, so a case named for a headless login
// passed having established that no login happened.
expect(
  'H1.headlessLoginOnTheIntegrationToken',
  {
    atLeastOneLaunch: launches.length > 0,
    atLeastOneAuthenticated: launches.some((entry) => entry.exitClass === 'OK'),
    noInfrastructureError: launches.every((entry) => entry.exitClass !== 'INFRA_ERROR'),
  },
  `${String(launches.length)} launches, exit classes: ${launches.map((entry) => `${entry.name}=${String(entry.exitClass)}`).join(', ')}`,
  { atLeastOneLaunch: true, atLeastOneAuthenticated: true, noInfrastructureError: true },
);
expect(
  'H2.noBrowserFlowWasEntered',
  { launchesExamined: launches.length > 0, withBrowserMarkers: browserLaunches.length },
  `browser-flow markers found in: ${browserLaunches.map((entry) => `${entry.name} (${entry.browserMarkersInLog.join(', ')})`).join('; ')}`,
  { launchesExamined: true, withBrowserMarkers: 0 },
);

// Gone, rather than deleted-by-this-call: deleting the Account takes the
// Contact and the Opportunity with it, so the DELETEs that follow answer
// ENTITY_IS_DELETED and counting those as failures makes a clean org look dirty.
expect(
  'X2.cleanupRemovedExactlyTheRecordsCreated',
  { attempted: cleanup.attempted, confirmedGone: cleanup.confirmedGone, leftBehind: cleanup.leftBehind.length },
  `records still in the org: ${cleanup.leftBehind.join(', ')}; delete problems: ${cleanup.problems.slice(0, 3).join('; ')}`,
  { attempted: madeHere.length, confirmedGone: madeHere.length, leftBehind: 0 },
);

// X3: nothing of this campaign is left, asked of the org rather than inferred
// from the deletes.
const namespaceRemnants = [];
try {
  // All three objects, not just the Account. The Contact and the Opportunity
  // carry the same stamp and were never asked about.
  for (const entity of ['Account', 'Contact', 'Opportunity']) {
    const column = entity === 'Contact' ? 'LastName' : 'Name';
    const soql = `SELECT Id FROM ${entity} WHERE ${column} LIKE '%${campaign.namespace}%'`;
    const found = sf('GET', `/services/data/v67.0/query?q=${encodeURIComponent(soql)}`);
    for (const record of found?.records ?? []) namespaceRemnants.push(`${entity} ${String(record.Id)}`);
  }
} catch (error) {
  namespaceRemnants.push(`the namespace could not be queried: ${String(error && error.message ? error.message : error).slice(0, 120)}`);
}
expect(
  'X3.theNamespaceIsEmptyOnReadBack',
  namespaceRemnants.length,
  `the org still holds ${namespaceRemnants.join(', ')}`,
  0,
);

// PASS or FAIL, which is what the release gate reads, and the capability
// disposition beside it. `result` used to be 'PASS' or 'OUT': a verdict field
// carrying a word from a different vocabulary, which the gate compares against
// the cases and cannot match.
const result = failures.length === 0 ? 'PASS' : 'FAIL';
const capability = failures.length === 0 ? 'IN' : 'OUT';

const evidence = {
  gate: 'SF-OCR-01',
  // What was put into the org and taken out again, counted rather than claimed.
  cleanup,
  // Derived from the credential rather than typed. See `org-identity.mjs`.
  ...orgEvidenceFields(org),
  observedAt: capturedAt,
  observedInstance: observed,
  namespace: { campaignId: campaign.campaignId, namespace: campaign.namespace, stamp },
  created: { total: madeHere.length, ids: madeHere },
  capability,
  headless: {
    dataLoaderVersion: '67.0.0',
    jarSha256: compiledLauncher.jarSha256,
    jarBytes: compiledLauncher.jarBytes,
    launcherSourceSha256: compiledLauncher.launcherSourceSha256,
    java: javaVersions(),
    launches,
  },
  dataLoaderVersion: '67.0.0',
  opportunityId: opportunity.id,
  contactId: contact.id,
  capturedAt,
  cases,
  failures,
  result,
  // Stamped by the runner that took the measurement. The corpus is this file:
  // the single role row loaded here is written from literals a few lines above,
  // so these bytes are exactly what went to the org.
  // Captured by the thing that measured it: the subject taken before the first
  // write and re-checked here.
  capture: await captureEnd(started),
  note:
    capability === 'IN'
      ? 'OpportunityContactRole loads and reconciles. It is IN, as a capability separate from the base Salesforce envelope.'
      : 'OpportunityContactRole did not qualify and is OUT. Base Salesforce is unaffected, and no alternative relationship is invented in its place.',
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
  assertRunnerAskedEverything('sf-ocr.json', cases);
} catch (error) {
  process.stderr.write(`REFUSED: ${String(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
}

if (evidencePath !== null && evidencePath !== undefined) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

process.stdout.write(`SF-OCR-01: ${String(cases.length)} expectations\n`);
for (const c of cases) process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.ok ? '' : ` — ${c.detail}`}\n`);
process.stdout.write(`SF-OCR-01 = ${result}\n`);
// A gate that failed exits non-zero.
//
// This wrote "SF-OCR-01 = FAIL" and exited 0, so the universe step that runs it
// and any CI job that runs it would both have recorded a pass. The one line
// that turns a verdict into an exit code was missing.
if (failures.length > 0) process.exitCode = 1;

#!/usr/bin/env node
// SF-TARGET-01, the operational half: real Data Loader against a real org.
//
// Every case here is declared in EXPECTED_TRUTH.md before it was run. This file
// asserts against those expectations; it does not read a result and call it the
// expectation.
//
// Usage:
//   node run-dataloader-qualification.mjs --auth <restricted-auth-dir> [--evidence <file>]
import { execFileSync } from 'node:child_process';
const { assertRunnerAskedEverything } = await import('../oracles.mjs');
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { establishOrg, orgEvidenceFields } from './org-identity.mjs';
import { assertInstanceAuthorised, captureEnd, captureStart, nowUtc, observedInstance } from '../campaign.mjs';
import { campaignNamespace, createdLedger } from '../namespace.mjs';
import { runDataLoader } from './data-loader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const authIndex = process.argv.indexOf('--auth');
if (authIndex === -1) {
  process.stderr.write('usage: node run-dataloader-qualification.mjs --auth <dir> [--evidence <file>]\n');
  process.exit(2);
}
const authDir = resolve(process.argv[authIndex + 1]);
const evidenceIndex = process.argv.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1];

// The driver is in this repository, not in the auth directory. It used to be
// `<auth>/dl/run.mjs`, and it vanished when that directory was re-extracted from
// the release zip — leaving this gate unrunnable while its evidence file sat in
// the repository looking healthy. What stays outside is the credential and the
// vendor's jar.

const work = join(authDir, 'qual');
mkdirSync(work, { recursive: true });

const cases = [];
const failures = [];

/**
 * One expectation, as a pair, with the verdict derived from comparing it.
 *
 * The verdict used to be an argument, so a case could record `ok: true` beside
 * a detail saying the opposite — which is what SF-OCR-01 shipped, and the only
 * thing that could have caught it was a regular expression over the English.
 * Computing it from the comparison makes that impossible, and writing both
 * sides down lets a reader see what was asked.
 *
 * @param {string} id declared in qualification/oracles.mjs
 * @param {unknown} observed what the org said
 * @param {string|null} detail what to say when it does not match
 * @param {unknown} expected what it had to be
 */
function expect(id, observed, detail, expected = true) {
  const ok = JSON.stringify(observed) === JSON.stringify(expected);
  const said = detail ?? `expected ${JSON.stringify(expected)} and observed ${JSON.stringify(observed)}`;
  cases.push({ id, ok, expected, observed, detail: ok ? null : said });
  if (!ok) failures.push(`${id}: ${said}`);
}

/** Parse a Data Loader result file into rows keyed by header. */
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

/**
 * Every record this run put into the org, so it can take them out again.
 *
 * Nothing here used to be removed. The org is a Developer Edition with five
 * megabytes of data storage and two of them free, so a gate that leaves its
 * fixtures behind fills the tenant it qualifies against and then fails for a
 * reason that has nothing to do with the engine. Recorded as the loader reports
 * them -- the id it actually wrote, beside the object it wrote to -- rather than
 * inferred afterwards from a query, because a query would find records this run
 * did not create and this cleanup must remove exactly what it made.
 */
const created = [];

function load({ id, entity, operation, externalIdField, header, records, mapping }) {
  const outDir = join(work, id);
  // Cleared, not reused. See the note in dataloader-headless.mjs: a directory
  // named for the case is reused by every run of the gate, and a load that
  // failed left the previous run's success.csv to be read as this one's.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const input = join(outDir, 'input.csv');
  writeFileSync(input, `${header.join(',')}\n${records.map((r) => r.join(',')).join('\n')}\n`);
  const result = runDataLoader({
    name: id,
    entity,
    operation,
    externalIdField,
    inputCsv: input,
    mapping: mapping ?? header.map((h) => [h, h]),
    outDir,
    authDir,
    ...loaderContext,
  });
  const successRows = rows(result.success);
  for (const row of successRows) {
    // An update names a record that already existed, and a delete of it would
    // remove something this run did not create.
    if (row.STATUS !== 'Item Created') continue;
    const recordId = row.ID ?? '';
    if (recordId !== '') {
      created.push({
        entity,
        id: recordId,
        key: externalIdField === undefined ? undefined : String(row[externalIdField] ?? ''),
        // The name too, because most of these records have no external id and
        // the name is the only thing that says which campaign made them.
        name: String(row['Name'] ?? row['LastName'] ?? ''),
      });
    }
  }
  return { ...result, successRows, errorRows: rows(result.error) };
}

/** Forward slashes: bash cannot open a path spelled with backslashes. */
const shPath = (...parts) => join(...parts).split('\\').join('/');

function sf(method, path, body) {
  // encodeURIComponent leaves an apostrophe alone, and the shell in between eats
  // it, so a SOQL literal arrives unquoted and Salesforce reports a malformed
  // query. Encoding it here keeps the quote a quote all the way to the org.
  const args = [shPath(authDir, 'sf.sh'), method, path.split("'").join('%27')];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const text = out.split('\n__HTTP_STATUS__')[0];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned status ${String(status)} and unparseable body: ${text.slice(0, 200)}`);
  }
  // Salesforce reports an error as an array of {message, errorCode}. Letting one
  // through as "no records" would make a failed query read as a missing record,
  // which is the one thing an export-back check must never do.
  if (status >= 400 || Array.isArray(parsed)) {
    throw new Error(`${method} ${path} returned status ${String(status)}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

// Who this session is, before anything is written. An evidence file that names
// the wrong org is a false record about somebody's account, and the only way to
// be sure it names the right one is to ask.
const org = establishOrg(sf);

// Which org, and whether writing to it is permitted. The observation decides
// which org was touched; qualification/authorized-instances.json decides whether
// touching it was allowed. Nothing called this before, so the allowlist was a
// document rather than a control.
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

/**
 * What this session may actually do, asked of the org before the first write.
 *
 * An org id says which tenant. It does not say whether this principal may
 * create an Account, and finding out by failing halfway through a load leaves
 * some of what was about to be checked already written.
 */
const privileges = [];
for (const [privilege, path] of [
  ['account.describe', '/services/data/v67.0/sobjects/Account/describe'],
  ['contact.describe', '/services/data/v67.0/sobjects/Contact/describe'],
  ['opportunity.describe', '/services/data/v67.0/sobjects/Opportunity/describe'],
]) {
  let ok = false;
  let detail = null;
  try {
    const described = sf('GET', path);
    ok = described?.createable === true && described?.deletable === true;
    detail = `createable=${String(described?.createable)} deletable=${String(described?.deletable)}`;
  } catch (error) {
    detail = String(error && error.message ? error.message : error).slice(0, 200);
  }
  privileges.push({ privilege, probe: `GET ${path}`, ok, detail });
}
const missingPrivileges = privileges.filter((entry) => !entry.ok);
if (missingPrivileges.length > 0) {
  process.stderr.write(
    `REFUSED: this principal cannot create and delete the objects this gate needs: ${missingPrivileges.map((entry) => `${entry.privilege} (${entry.detail})`).join('; ')}\n`,
  );
  process.exit(1);
}


// The launcher, compiled once against the jar in hand, and the session it will
// use. Both are passed to every load so the jar is compiled once rather than
// per operation, and so every load is told which org and which user its login
// must land on — a login that lands somewhere else is refused by the launcher
// rather than discovered afterwards in the evidence.
const { compileLauncher, jarPath, javaVersions } = await import('./dataloader-headless.mjs');
const { launches } = await import('./data-loader.mjs');
const launcherJar = jarPath(authDir);
const compiledLauncher = compileLauncher({ jar: launcherJar, classesDir: join(work, 'launcher-classes') });
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

const campaign = campaignNamespace();
const started = await captureStart({ producer: 'qualification/salesforce/run-dataloader-qualification.mjs' });
const ledger = createdLedger({ vendor: 'salesforce', instanceId: org.orgId, namespace: campaign.namespace });

// One reading of the clock for the measurement and its binding; the gate
// requires the two to agree and two calls to the clock do not.
const capturedAt = nowUtc();

/**
 * A key the org has never seen, unless the caller insists otherwise.
 *
 * `A2` expects an upsert on an external id to **create**, and `A3` expects the
 * second upsert on the same key to **update**. That pair is only meaningful if
 * the key is new when A2 runs, and the default was the constant `R1` -- so the
 * first run established it and every run after it reported
 * `A2.created: status was Item Updated`, having proved nothing except that the
 * previous run had happened. A gate that can only be run once is a gate nobody
 * re-runs against a new engine, which is the whole point of the exercise.
 *
 * The instant, to the second, so two runs a second apart are still distinct and
 * a reader can tell from the key when the records were made. `KAURO_QUAL_STAMP`
 * still overrides it, for re-proving one case against a key that already exists.
 */
// The campaign, then the instant.
  //
  // A timestamp alone made two runs distinct, which is what A2 and A3 need, and
  // said nothing about which campaign a record left behind belonged to. The
  // campaign namespace makes a leftover attributable to the evidence it was
  // taken beside, and `KAURO_QUAL_STAMP` still overrides both for re-proving one
  // case against a key that already exists.
const stamp =
  process.env.KAURO_QUAL_STAMP ??
  `${campaign.namespace}-${new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14)}`;
// The override may re-prove one case against an existing key. It may not take
// the run out of its own campaign: every emptiness check and every cleanup query
// below is written in terms of this namespace, so a stamp without it creates
// records nothing can find again.
if (!stamp.includes(campaign.namespace)) {
  process.stderr.write(
    `REFUSED: KAURO_QUAL_STAMP is "${stamp}" and does not carry this campaign's namespace ${campaign.namespace}. ` +
      'Every record this gate creates is found again by that namespace; a stamp without it leaves records no cleanup can reach.\n',
  );
  process.exit(1);
}

/**
 * A record name inside this campaign's namespace.
 *
 * The literal names — named('Kauro A1 Account'), named('Kauro A7 One'), named('KauroL1') — were the same
 * strings in every campaign, so two campaigns collided on them and X1 could not
 * see them: it only examined records created with an external id, which are
 * exactly the ones that already carried the namespace in their key. The records
 * genuinely outside the namespace were the ones it skipped.
 */
const named = (label) => `${stamp} ${label}`;
const key = (suffix) => `KAURO-${stamp}-${suffix}`;

// --------------------------------------------------------------- A1, A2, A3, A4

const a1 = load({ id: 'A1-account-insert', entity: 'Account', operation: 'insert', header: ['Name'], records: [[named('Kauro A1 Account')]] });
expect('A1', a1.successRows.length === 1 && a1.errorRows.length === 0, `insert produced ${a1.successRows.length} successes and ${a1.errorRows.length} errors`);
expect('A1.status', a1.successRows[0]?.STATUS === 'Item Created', `status was ${a1.successRows[0]?.STATUS}`);

const accountKey = key('ACC-1');
const a2 = load({
  id: 'A2-account-upsert-first', entity: 'Account', operation: 'upsert', externalIdField: 'Kauro_Qualification_Key__c',
  header: ['Name', 'Kauro_Qualification_Key__c'], records: [[named('Kauro A2 Account'), accountKey]],
});
expect('A2', a2.successRows.length === 1 && a2.errorRows.length === 0, `upsert produced ${a2.successRows.length}/${a2.errorRows.length}`);
expect('A2.created', a2.successRows[0]?.STATUS === 'Item Created', `status was ${a2.successRows[0]?.STATUS}`);
const accountId = a2.successRows[0]?.ID ?? '';

const a3 = load({
  id: 'A3-account-upsert-again', entity: 'Account', operation: 'upsert', externalIdField: 'Kauro_Qualification_Key__c',
  header: ['Name', 'Kauro_Qualification_Key__c'], records: [[named('Kauro A3 Renamed'), accountKey]],
});
expect('A3', a3.successRows.length === 1 && a3.errorRows.length === 0, `second upsert produced ${a3.successRows.length}/${a3.errorRows.length}`);
expect('A3.updated', a3.successRows[0]?.STATUS === 'Item Updated', `status was ${a3.successRows[0]?.STATUS}`);
// The whole point of an external id: the same key is the same record.
expect('A3.sameRecord', a3.successRows[0]?.ID === accountId, `second upsert wrote ${a3.successRows[0]?.ID}, first wrote ${accountId}`);

const a4 = load({ id: 'A4-account-update-by-id', entity: 'Account', operation: 'update', header: ['Id', 'Name'], records: [[accountId, named('Kauro A4 By Record Id')]] });
expect('A4', a4.successRows.length === 1 && a4.errorRows.length === 0, `update produced ${a4.successRows.length}/${a4.errorRows.length}`);
expect('A4.sameRecord', a4.successRows[0]?.ID === accountId, `update wrote ${a4.successRows[0]?.ID}`);

// ------------------------------------------------------------------- A5, A6

const a5 = load({
  id: 'A5-restricted-picklist-valid', entity: 'Account', operation: 'insert',
  header: ['Name', 'Kauro_Qualification_Status__c'], records: [[named('Kauro A5 Ready'), 'READY']],
});
expect('A5', a5.successRows.length === 1 && a5.errorRows.length === 0, `valid picklist produced ${a5.successRows.length}/${a5.errorRows.length}`);

const a6 = load({
  id: 'A6-restricted-picklist-invalid', entity: 'Account', operation: 'insert',
  header: ['Name', 'Kauro_Qualification_Status__c'], records: [[named('Kauro A6 Bad'), 'NOT_A_REAL_STATUS']],
});
expect('A6', a6.successRows.length === 0 && a6.errorRows.length === 1, `invalid picklist produced ${a6.successRows.length}/${a6.errorRows.length}`);
// The org answers in the running user's language — this one replies in Spanish —
// so the assertion is on the value and field it refused, not on English prose.
const a6error = a6.errorRows[0]?.ERROR ?? '';
expect(
  'A6.rejected',
  a6error.includes('NOT_A_REAL_STATUS') && a6error.includes('Kauro Qualification Status'),
  `error was ${a6error.slice(0, 140)}`,
);

// ----------------------------------------------------------------------- A7

const dupKey = key('DUP');
const a7seed = load({
  id: 'A7-nonunique-seed', entity: 'Account', operation: 'insert',
  header: ['Name', 'Kauro_Nonunique_Ext__c'], records: [[named('Kauro A7 One'), dupKey], [named('Kauro A7 Two'), dupKey]],
});
expect('A7.seed', a7seed.successRows.length === 2, `seeding two records on a non-unique external id produced ${a7seed.successRows.length}`);

const a7 = load({
  id: 'A7-nonunique-upsert', entity: 'Account', operation: 'upsert', externalIdField: 'Kauro_Nonunique_Ext__c',
  header: ['Name', 'Kauro_Nonunique_Ext__c'], records: [[named('Kauro A7 Ambiguous'), dupKey]],
});
// Salesforce cannot say which record was meant. This is the case the engine
// refuses before writing anything, and the reason it refuses it.
expect('A7', a7.errorRows.length === 1 && a7.successRows.length === 0, `ambiguous upsert produced ${a7.successRows.length} successes and ${a7.errorRows.length} errors`);

// ----------------------------------------------------------------------- A8

// A required value that is empty (R2-009). The input below is one Contact whose
// LastName cell holds no characters: the column is present, the value is not.
// The expectation is written from those bytes and from Salesforce's documented
// requirement that a Contact has a LastName, never from what the engine emits.
const a8Header = ['LastName', 'FirstName'];
const a8Records = [['', named('KauroA8')]];
const a8 = load({ id: 'A8-contact-empty-lastname', entity: 'Contact', operation: 'insert', header: a8Header, records: a8Records });
expect('A8.requiredBlankIsRejected',
  a8Records.length === 1 && a8Records[0][0] === '' && a8.successRows.length === 0 && a8.errorRows.length === 1 &&
    /LastName|REQUIRED_FIELD_MISSING/i.test(a8.errorRows[0]?.ERROR ?? ''),
  `empty LastName produced ${a8.successRows.length}/${a8.errorRows.length}: ${(a8.errorRows[0]?.ERROR ?? '').slice(0, 140)}`);
// What the package says about the same row is compared with what the org did,
// so a package that would have shipped it is a failed prediction, not a pass.
const { getAdapter: a8Adapter } = await import('../../dist/src/adapters/specs.js');
const a8Contact = a8Adapter('SALESFORCE').objects.find((spec) => spec.object === 'CONTACT');
expect('A8.thePackagePredictedIt',
  (a8Contact?.requiredForCreate ?? []).includes('contact.lastName') &&
    (a8Contact?.fields ?? []).some((spec) => spec.canonicalField === 'contact.lastName' && spec.header === 'LastName'),
  'the package adapter does not declare LastName as required for a Contact create');

// ----------------------------------------------------------------------- C1

const c1 = load({
  id: 'C1-contact-relationship-header', entity: 'Contact', operation: 'insert',
  header: ['LastName', 'AccountExternalId'], records: [[named('KauroC1'), accountKey]],
  // Data Loader's mapping file addresses a parent by external id with a COLON.
  // The dotted form is the Bulk API CSV header; Data Loader refuses it outright
  // as an invalid mapping, which is how this was found.
  mapping: [['LastName', 'LastName'], ['AccountExternalId', 'Account:Kauro_Qualification_Key__c']],
});
expect('C1', c1.successRows.length === 1 && c1.errorRows.length === 0, `relationship header produced ${c1.successRows.length}/${c1.errorRows.length}`);
if (c1.successRows.length === 1) {
  const contact = sf('GET', `/services/data/v64.0/query?q=${encodeURIComponent(`SELECT Id, AccountId FROM Contact WHERE Id = '${c1.successRows[0].ID}'`)}`);
  expect('C1.parentResolved', contact.records?.[0]?.AccountId === accountId, `contact points at ${contact.records?.[0]?.AccountId}, account is ${accountId}`);
}

// ------------------------------------------------------------------- L1, L2, O1

const l1 = load({ id: 'L1-lead-insert', entity: 'Lead', operation: 'insert', header: ['LastName', 'Company'], records: [[named('KauroL1'), named('Kauro Qualification Co')]] });
expect('L1', l1.successRows.length === 1 && l1.errorRows.length === 0, `lead insert produced ${l1.successRows.length}/${l1.errorRows.length}`);

const l2 = load({ id: 'L2-lead-missing-company', entity: 'Lead', operation: 'insert', header: ['LastName'], records: [[named('KauroL2')]] });
expect('L2', l2.successRows.length === 0 && l2.errorRows.length === 1, `lead without Company produced ${l2.successRows.length}/${l2.errorRows.length}`);
expect('L2.namesTheField', /Company|REQUIRED_FIELD_MISSING/i.test(l2.errorRows[0]?.ERROR ?? ''), `error was ${(l2.errorRows[0]?.ERROR ?? '').slice(0, 120)}`);

const o1 = load({
  id: 'O1-opportunity-insert', entity: 'Opportunity', operation: 'insert',
  header: ['Name', 'CloseDate', 'StageName'], records: [[named('Kauro O1 Opportunity'), '2026-12-31', 'Prospecting']],
});
expect('O1', o1.successRows.length === 1 && o1.errorRows.length === 0, `opportunity insert produced ${o1.successRows.length}/${o1.errorRows.length}`);

// ------------------------------------------------------------------------ R1

// A matrix this long outlives a short-lived access token, so the session is
// renewed before the export-back. An expired session reads as a missing record,
// which would be the worst possible thing for this particular check to say.
execFileSync('bash', [shPath(authDir, 'sf-token.sh')], { encoding: 'utf8' });

const back = sf('GET', `/services/data/v64.0/query?q=${encodeURIComponent(`SELECT Id, Name, Kauro_Qualification_Key__c FROM Account WHERE Kauro_Qualification_Key__c = '${accountKey}'`)}`);
expect('R1.exportBack', back.totalSize === 1, `export-back found ${back.totalSize} accounts for the key, expected exactly one`);
expect('R1.sameId', back.records?.[0]?.Id === accountId, `export-back Id ${back.records?.[0]?.Id} against ${accountId}`);
expect('R1.lastWriteWon', back.records?.[0]?.Name === named('Kauro A4 By Record Id'), `export-back Name is ${back.records?.[0]?.Name}`);

// -------------------------------------------------------------------- report

/**
 * Exactly what this run created, removed, in the reverse of the order it was
 * made.
 *
 * Reverse because a child points at a parent: an OpportunityContactRole has to
 * go before the Opportunity, and a Contact before the Account it belongs to.
 * Salesforce would refuse the other order, and a refusal here would leave the
 * tenant part-cleaned with nothing saying which part.
 *
 * A failure to delete is reported and does not fail the gate. What the gate
 * establishes is what Data Loader did with the engine's files; a record left
 * behind is a housekeeping problem, and turning it into a red gate would teach
 * the next person to stop reading the red.
 */
let evidence_namespaceOnReadBack = [];
const cleanup = { attempted: created.length, deleted: 0, confirmedGone: 0, problems: [], readBack: [], leftBehind: [], ok: false };
// Not through `sf`, which parses the body: a successful DELETE answers 204 with
// no body at all, and a parser handed nothing reports a failure that did not
// happen.

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

const deleteRecord = (entity, recordId) => {
  const args = [shPath(authDir, 'sf.sh'), 'DELETE', `/services/data/v67.0/sobjects/${entity}/${recordId}`];
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/u) ?? [])[1] ?? 0);
  if (status !== 204 && status !== 200) {
    throw new Error(`status ${String(status)}: ${out.split('\n__HTTP_STATUS__')[0].slice(0, 160)}`);
  }
};
for (const record of [...created].reverse()) {
  try {
    deleteRecord(record.entity, record.id);
    cleanup.deleted += 1;
  } catch (error) {
    cleanup.problems.push(`${record.entity} ${record.id}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  // Read back, one at a time. A DELETE that answered 204 and a record that is
  // actually gone are two different observations, and only the second one is
  // what "the org is as we found it" means.
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
// Gone, rather than deleted-by-this-call.
//
// Some of these records are removed by a cascade — deleting an Account takes
// its Contacts and Opportunities with it — so the DELETE that follows answers
// ENTITY_IS_DELETED, and counting those as failures made a clean org look like
// a dirty one. What the gate has to establish is that nothing it created is
// still there, which is what the read-back says.
expect(
  'X2.cleanupRemovedExactlyTheRecordsCreated',
  { attempted: cleanup.attempted, confirmedGone: cleanup.confirmedGone, leftBehind: cleanup.leftBehind.length },
  `records still in the org: ${cleanup.leftBehind.join(', ')}; delete problems: ${cleanup.problems.slice(0, 3).join('; ')}`,
  { attempted: created.length, confirmedGone: created.length, leftBehind: 0 },
);

// H1 and H2: the login, and what it did not do.
//
// `headless: true` in a configuration proves nothing — the old driver set the
// equivalent and opened a browser anyway. What is recorded is the exit class the
// launcher reported, the browser-flow markers found in the Data Loader log each
// launch produced, and the digest of that log.
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

// H3: the session token reached no file the run wrote.
//
// The launcher scans every file of every run directory, and its own stdout and
// stderr, for the access token it was handed. A qualification that leaks the
// credential it used has failed at something more important than the gate.
const leaking = launches.filter((entry) => (entry.tokenLeaks ?? []).length > 0);
expect(
  'H3.noTokenReachedAnyOutput',
  leaking.length,
  `the token appeared in: ${leaking.map((entry) => `${entry.name} (${entry.tokenLeaks.join(', ')})`).join('; ')}`,
  0,
);
// X3: nothing carrying this campaign key is left in the org, asked of the org
// rather than inferred from the deletes. A DELETE that answered 204 and an
// object store that no longer holds the record are two different observations.
const namespaceRemnants = [];
for (const [entity, field] of [['Account', 'Kauro_Qualification_Key__c'], ['Account', 'Kauro_Nonunique_Ext__c'], ['Contact', 'Kauro_Qualification_Key__c']]) {
  try {
    const soql = `SELECT Id FROM ${entity} WHERE ${field} LIKE 'KAURO-${campaign.namespace}-%'`;
    const found = sf('GET', `/services/data/v67.0/query?q=${encodeURIComponent(soql)}`);
    for (const record of found?.records ?? []) namespaceRemnants.push(`${entity} ${String(record.Id)}`);
  } catch (error) {
    namespaceRemnants.push(`${entity}.${field} could not be queried: ${String(error && error.message ? error.message : error).slice(0, 120)}`);
  }
}
evidence_namespaceOnReadBack = namespaceRemnants;
expect(
  'X3.theNamespaceIsEmptyOnReadBack',
  namespaceRemnants.length,
  `the org still holds ${namespaceRemnants.join(', ')}`,
  0,
);
// Every record, by the name or the key it was created with.
//
// This examined only records created with an external id — which are exactly the
// ones whose key was built from the namespace twelve lines earlier, so expected
// and observed came from the same construction. The records genuinely outside
// the namespace were the ones with fixed literal names, and those were skipped
// because `key` is undefined for them. They now carry the stamp in their name
// and every created record is examined.
expect(
  'X1.everyCreatedRecordIsInThisCampaignNamespace',
  {
    created: created.length > 0,
    outside: created.filter((record) => !String(record.key ?? record.name ?? '').includes(campaign.namespace)).length,
  },
  `records outside ${campaign.namespace}: ${created
    .filter((record) => !String(record.key ?? record.name ?? '').includes(campaign.namespace))
    .map((record) => `${record.entity}/${record.id}`)
    .join(', ')}`,
  { created: true, outside: 0 },
);

const evidence = {
  gate: 'SF-TARGET-01 (Data Loader operations)',
  dataLoaderVersion: '67.0.0',
  // What was put into the org and taken out again, counted rather than claimed.
  cleanup,
  // Derived, not typed. `orgId` was the string literal '00Dak000018tvSeEAI',
  // which happened to be right and would have gone on looking right after the
  // credential was repointed anywhere else.
  ...orgEvidenceFields(org),
  observedAt: capturedAt,
  observedInstance: observed,
  privileges,
  namespace: { campaignId: campaign.campaignId, namespace: campaign.namespace, stamp },
  // The login, recorded per launch, and the toolchain that compiled the
  // launcher against the vendor's jar.
  headless: {
    dataLoaderVersion: '67.0.0',
    jarSha256: compiledLauncher.jarSha256,
    jarBytes: compiledLauncher.jarBytes,
    launcherSourceSha256: compiledLauncher.launcherSourceSha256,
    java: javaVersions(),
    launches,
  },
  created: { total: created.length, ids: created },
  namespaceOnReadBack: evidence_namespaceOnReadBack,
  expectedTruth: 'qualification/salesforce/EXPECTED_TRUTH.md',
  authenticationNote: 'qualification/evidence/SF_DATALOADER_AUTH.md',
  capturedAt,
  cases,
  failures,
  result: failures.length === 0 ? 'PASS' : 'FAIL',
  // What this was measured against, stamped by the thing that measured it. The
  // corpus is this runner's own bytes, and that is the honest answer rather than
  // a tidier one: every record loaded here is a literal in this file, so hashing
  // anything else would name something that was not fed to the org.
  // What this was measured against, captured by the thing that measured it:
  // the subject taken before the first load and re-checked here, rather than a
  // digest stamped on afterwards.
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
  assertRunnerAskedEverything('sf-dataloader.json', cases);
} catch (error) {
  process.stderr.write(`REFUSED: ${String(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
}

if (evidencePath !== null && evidencePath !== undefined) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

process.stdout.write(`SF-TARGET-01 Data Loader: ${String(cases.length)} expectations\n`);
for (const c of cases) process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.ok ? '' : ` — ${c.detail}`}\n`);
process.stdout.write(`result = ${evidence.result}\n`);
if (failures.length > 0) process.exitCode = 1;

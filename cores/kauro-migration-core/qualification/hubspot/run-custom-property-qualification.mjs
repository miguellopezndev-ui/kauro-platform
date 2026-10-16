#!/usr/bin/env node
// HSP-TARGET-01, the half that was missing: a property **Kauro creates**.
//
// Everything else about unique-property matching was established on `email`,
// which HubSpot defines. That is good evidence and it is evidence about
// HubSpot's property. The question left open was whether a property this engine
// asks an agency to create behaves the same way — and it is the question that
// decides whether `TARGET_UNIQUE_FIELD` means anything in practice.
//
// It runs through the records API rather than the import API, because that is
// what the credential permits and because it isolates the question. An import
// exercises the wizard, the file format and the property at once; a batch upsert
// keyed on `idProperty` exercises the property and nothing else. If HubSpot
// matches on a property Kauro created, it says so here without anything else in
// the way.
//
// The values are the ones the engine delivered. They are read out of the package
// it wrote for the qualification corpus, so nothing here is hand-typed for the
// portal's benefit.
//
// Usage:
//   node run-custom-property-qualification.mjs --auth <dir> [--evidence <file>] [--work <dir>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const authDir = argument('--auth');
if (authDir === null) {
  process.stderr.write('usage: node run-custom-property-qualification.mjs --auth <dir> [--evidence <file>] [--work <dir>]\n');
  process.exit(2);
}
const evidencePath = argument('--evidence');
const workDir = resolve(argument('--work') ?? join(authDir, 'hs-custom'));
const corpusRoot = resolve(join(import.meta.dirname, 'corpus'));

const { loadConfig } = await import('../../dist/src/mapping/load-config.js');
const { runMigration } = await import('../../dist/src/run/run-migration.js');
const { writePackage } = await import('../../dist/src/artifacts/write-package.js');
const { verifyPackage } = await import('../../dist/src/verify/verify-package.js');
const { IMPORT_AREA } = await import('../../dist/src/artifacts/layout.js');
const { getAdapter } = await import('../../dist/src/adapters/specs.js');

// The import files sit where the layout module puts them, under the directory
// the adapter names. Package format 2.0.0 moved them from a flat `import/`, and
// this runner went on reading the old address, so it could not find a file at
// all. Asking the two modules that decide the address means the next move is not
// a second outage here.
const hubspot = getAdapter('HUBSPOT');

const shPath = (...parts) => join(...parts).split('\\').join('/');

function hs(method, path, body) {
  const args = [shPath(resolve(authDir), 'hs.sh'), method, path];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const text = out.split('\n__HTTP_STATUS__')[0];
  let json = null;
  try { json = JSON.parse(text); } catch { /* some responses carry no body */ }
  return { status, json, text };
}

const cases = [];
const failures = [];
function expect(id, ok, detail) {
  cases.push({ id, ok: Boolean(ok), detail: ok ? null : detail });
  if (!ok) failures.push(`${id}: ${detail}`);
}

const KEY = 'kauro_qualification_key';
const STATUS = 'kauro_qualification_status';
const { assertInstanceAuthorised, observedInstance } = await import('../campaign.mjs');
const { campaignNamespace } = await import('../namespace.mjs');

// This campaign's corner of the portal, and permission to write in it.
//
// This runner was written before either existed and was left behind by the
// reform that reached the other four. It read /account-info/v3/details only to
// print the answer, never consulting the allowlist, and it began by deleting
// every contact in the portal whose email ended in the qualification domain —
// which is every campaign's contacts, not its own, and would have cleared the
// excluded portal 51050101 as readily as the developer test account. It escaped
// the reform because no oracle names its evidence file and no gate reads it: it
// was made invisible rather than fixed.
const campaign = campaignNamespace();
const DOMAIN = campaign.domain;
const READ = ['email', 'firstname', 'lastname', 'jobtitle', KEY, STATUS];

/** Every contact of this qualification, read from the object store rather than the search index, which lags. */
function ours() {
  const found = [];
  let after = null;
  do {
    const query = `?limit=100&properties=${READ.join(',')}${after === null ? '' : `&after=${after}`}`;
    const response = hs('GET', `/crm/v3/objects/contacts${query}`);
    found.push(...(response.json?.results ?? []));
    after = response.json?.paging?.next?.after ?? null;
  } while (after !== null && found.length < 2000);
  return found.filter((contact) => String(contact.properties.email ?? '').endsWith(`@${DOMAIN}`));
}

/** Every contact this run created, by the id the portal returned. */
const createdHere = new Set();

/**
 * Delete what this run created, and read each one back.
 *
 * This was `for (const contact of ours()) DELETE` — every contact in the portal
 * whose email ended in the qualification domain, which is every campaign's
 * contacts and not only this run's. Nothing this runner did not create is
 * reachable from here now.
 */
function removeOurs() {
  let removed = 0;
  let leftBehind = 0;
  for (const id of createdHere) {
    const deleted = hs('DELETE', `/crm/v3/objects/contacts/${id}`);
    if (deleted.status === 204 || deleted.status === 200) removed += 1;
    const after = hs('GET', `/crm/v3/objects/contacts/${id}`);
    if (after.status === 200) leftBehind += 1;
  }
  if (leftBehind > 0) process.stderr.write(`${String(leftBehind)} contacts this run created are still in the portal\n`);
  return removed;
}

// ---------------------------------------------------------------- the engine

function readCsvFile(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line !== '');
  const headers = (lines[0] ?? '').split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((name, index) => { row[name] = cells[index] ?? ''; });
    return row;
  });
}

function deliver(caseId) {
  const caseDir = join(corpusRoot, caseId);
  const packageDir = join(workDir, caseId, 'package');
  rmSync(join(workDir, caseId), { recursive: true, force: true });
  mkdirSync(join(workDir, caseId), { recursive: true });
  const configPath = join(caseDir, 'config.json');
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  const result = runMigration({ inputRoot: join(caseDir, 'input'), config: loaded.config, configHash: loaded.configHash });
  writePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: packageDir, force: true });
  const verification = verifyPackage(packageDir);
  expect(`${caseId}.packageVerifies`, verification.passed,
    `the package the engine produced does not verify: ${verification.problems.map((p) => p.check).join(', ')}`);
  return readCsvFile(join(packageDir, IMPORT_AREA, hubspot.importDirectory, 'contacts.csv'));
}

// ------------------------------------------------------------------ the portal

mkdirSync(workDir, { recursive: true });
const account = hs('GET', '/account-info/v3/details').json ?? {};
if (account.portalId === undefined) {
  process.stderr.write('REFUSED: the portal being written to could not be established\n');
  process.exit(1);
}
try {
  assertInstanceAuthorised(
    observedInstance({
      vendor: 'hubspot',
      instanceId: String(account.portalId),
      observedBy: 'GET /account-info/v3/details, on the credential that performs these writes, in this run',
      detail: String(account.accountType ?? 'account type not stated'),
    }),
  );
} catch (error) {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}
const cleared = removeOurs();
process.stdout.write(`portal ${String(account.portalId ?? '')} (${String(account.accountType ?? '')}) — cleared ${String(cleared)} records left by an earlier run\n`);

// P1. The engine's own values, delivered. Keyed on email so that this case says
// nothing yet about the custom property — only that it carries.
const created = deliver('Q5-custom-property');
const upsertCreate = hs('POST', '/crm/v3/objects/contacts/batch/upsert', {
  idProperty: 'email',
  inputs: created.map((row) => ({
    idProperty: 'email',
    id: row.Email,
    properties: {
      email: row.Email,
      firstname: row['First name'],
      lastname: row['Last name'],
      jobtitle: row['Job title'],
      [KEY]: row[KEY],
      [STATUS]: row[STATUS],
    },
  })),
});
// Every id the portal returned, so the cleanup can delete exactly these.
for (const made of upsertCreate.json?.results ?? []) if (made?.id !== undefined) createdHere.add(String(made.id));
expect('P1.delivered', upsertCreate.status === 200 || upsertCreate.status === 201,
  `delivering the engine's rows answered ${String(upsertCreate.status)}: ${upsertCreate.text.slice(0, 200)}`);

const afterCreate = new Map(ours().map((contact) => [String(contact.properties[KEY] ?? ''), contact]));
expect('P2.customPropertyStoresWhatWasDelivered',
  created.every((row) => afterCreate.get(row[KEY])?.properties?.[KEY] === row[KEY]),
  `the portal holds keys ${[...afterCreate.keys()].join(', ') || '(none)'}`);
expect('P3.customEnumerationStoresADefinedValue',
  created.every((row) => afterCreate.get(row[KEY])?.properties?.[STATUS] === row[STATUS]),
  `statuses read back as ${[...afterCreate.values()].map((c) => String(c.properties[STATUS] ?? '')).join(', ')}`);

// P4. The question this whole runner exists for. Matching is keyed on the
// property **Kauro created**, and the engine's second package supplies the new
// values. If HubSpot matches on it, the same records change and none is added.
const updated = deliver('Q6-custom-key-upsert');
const upsertByCustomKey = hs('POST', '/crm/v3/objects/contacts/batch/upsert', {
  idProperty: KEY,
  inputs: updated.map((row) => ({
    idProperty: KEY,
    id: row[KEY],
    properties: { jobtitle: row['Job title'], [STATUS]: row[STATUS] },
  })),
});
// Every id the portal returned, so the cleanup can delete exactly these.
for (const made of upsertByCustomKey.json?.results ?? []) if (made?.id !== undefined) createdHere.add(String(made.id));
expect('P4.aPropertyKauroCreatedIsAcceptedAsTheIdentifier',
  upsertByCustomKey.status === 200 || upsertByCustomKey.status === 201,
  `matching on ${KEY} answered ${String(upsertByCustomKey.status)}: ${upsertByCustomKey.text.slice(0, 240)}`);

const afterUpdate = new Map(ours().map((contact) => [String(contact.properties[KEY] ?? ''), contact]));
expect('P5.matchedRatherThanDuplicated', afterUpdate.size === afterCreate.size,
  `the portal held ${String(afterCreate.size)} records and holds ${String(afterUpdate.size)} after matching on the custom key`);
expect('P6.theSameRecordsChanged',
  [...afterCreate.entries()].every(([key, contact]) => afterUpdate.get(key)?.id === contact.id),
  'a record came back under a different id after matching on the custom key');
expect('P7.theValuesChanged',
  updated.every((row) => afterUpdate.get(row[KEY])?.properties?.jobtitle === row['Job title']),
  `job titles read back as ${[...afterUpdate.values()].map((c) => String(c.properties.jobtitle ?? '')).join(', ')}`);

// P8. Uniqueness is enforced by the portal, not merely declared by it. A second
// record carrying a key another record already holds must be refused — that is
// the whole reason a unique property may be a match key at all.
const duplicateKey = created[0]?.[KEY] ?? '';
const duplicate = hs('POST', '/crm/v3/objects/contacts', {
  properties: { email: `duplicate@${DOMAIN}`, [KEY]: duplicateKey },
});
expect('P8.aSecondRecordCannotHoldTheSameKey', duplicate.status >= 400,
  `the portal accepted a second record carrying ${duplicateKey} (HTTP ${String(duplicate.status)})`);
if (duplicate.status < 400 && duplicate.json?.id !== undefined) {
  hs('DELETE', `/crm/v3/objects/contacts/${duplicate.json.id}`);
}

// P9. And an undefined value for the enumeration Kauro created is refused, the
// same way HubSpot refuses one for its own.
const badEnum = hs('POST', '/crm/v3/objects/contacts', {
  properties: { email: `badenum@${DOMAIN}`, [STATUS]: 'NOT_A_STATUS' },
});
expect('P9.anUndefinedOptionIsRefused', badEnum.status >= 400,
  `the portal accepted NOT_A_STATUS for ${STATUS} (HTTP ${String(badEnum.status)})`);
if (badEnum.status < 400 && badEnum.json?.id !== undefined) {
  hs('DELETE', `/crm/v3/objects/contacts/${badEnum.json.id}`);
}

// ------------------------------------------------------------------- cleanup
//
// This account is the owner's and holds their records. What the qualification
// created, it removes, and it says how many.
const removed = removeOurs();

const evidence = {
  gate: 'HSP-TARGET-01 (a property Kauro creates)',
  portalId: String(account.portalId ?? ''),
  accountType: String(account.accountType ?? ''),
  authorisation: 'the account owner supplied this credential for this qualification',
  mechanism: 'crm/v3/objects/contacts/batch/upsert with idProperty, because the credential does not carry crm.import',
  recordsRemovedAfterwards: removed,
  cases,
  failures,
  result: failures.length === 0 ? 'PASS' : 'FAIL',
};
if (evidencePath !== null) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

process.stdout.write(`HSP-TARGET-01 custom property: ${String(cases.length)} expectations\n`);
for (const entry of cases) process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id}${entry.ok ? '' : ` — ${entry.detail}`}\n`);
process.stdout.write(`removed ${String(removed)} qualification records afterwards\n`);
process.stdout.write(`result = ${evidence.result}\n`);
if (failures.length > 0) process.exitCode = 1;

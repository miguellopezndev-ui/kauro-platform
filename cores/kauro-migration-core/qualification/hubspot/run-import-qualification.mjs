#!/usr/bin/env node
// HSP-TARGET-01, the import half.
const { assertRunnerAskedEverything } = await import('../oracles.mjs');
//
// The engine runs on a synthetic corpus, and the files it produces are the
// files that go to HubSpot. Nothing is hand-written for the portal's benefit:
// if an import fails, it failed on what the engine would have handed an agency.
//
// Every outcome is read back from the portal. An import that reports success is
// not evidence that a record carries the value the file stated, and the whole
// point of this gate is the difference between those two things.
//
// Usage:
//   node run-import-qualification.mjs --auth <dir> --bundle <dir> [--evidence <file>] [--work <dir>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const authDir = argument('--auth');
const bundleDir = argument('--bundle');
if (authDir === null || bundleDir === null) {
  process.stderr.write('usage: node run-import-qualification.mjs --auth <dir> --bundle <dir> [--evidence <file>] [--work <dir>]\n');
  process.exit(2);
}
const evidencePath = argument('--evidence');
const workDir = resolve(argument('--work') ?? join(authDir, 'hs-import'));
const committedCorpus = resolve(join(import.meta.dirname, 'corpus'));

const { loadConfig } = await import('../../dist/src/mapping/load-config.js');
const { runMigration } = await import('../../dist/src/run/run-migration.js');
const { writePackage, promotePackage, discardStagedPackage } = await import('../../dist/src/artifacts/write-package.js');
const { verifyPackage } = await import('../../dist/src/verify/verify-package.js');
const { hashTargetContract } = await import('../../dist/src/target/contract.js');
const {
  parseHubSpotPropertyExport,
  parseHubSpotPropertyApi,
  parseHubSpotPipelineArtifact,
  parseHubSpotSupplement,
  parseHubSpotAccessGrant,
  buildHubSpotTargetContract,
  hubSpotArtifactRef,
} = await import('../../dist/src/target/hubspot-artifacts.js');
const { IMPORT_AREA, packagePath } = await import('../../dist/src/artifacts/layout.js');
const { getAdapter } = await import('../../dist/src/adapters/specs.js');
const { attestExistingContract } = await import('../../tools/qualification-attestation.mjs');
const { createFilesystemScratchStore } = await import('../../dist/src/scratch/filesystem-scratch-store.js');
const { SCRATCH_BUDGET_BYTES } = await import('../../dist/src/domain/resource-profile.js');
const { captureEnd, captureStart, nowUtc, observedInstance, assertInstanceAuthorised } = await import('../campaign.mjs');
const { campaignNamespace, corpusSize, createdLedger, instantiateCorpus } = await import('../namespace.mjs');

// This campaign's own corner of the portal.
//
// Every record this run creates is created inside it, and the ledger below
// holds the id the portal returned for each one. Two campaigns cannot collide,
// so nothing has to be cleared before a run — which is what this gate used to
// do, by searching the portal for anything whose email or name looked like test
// data and deleting it. See qualification/namespace.mjs.
const campaign = campaignNamespace();
const started = await captureStart({ producer: 'qualification/hubspot/run-import-qualification.mjs' });

// Where a file is, and what its columns are called, are the package's facts, not
// this runner's. Package format 2.0.0 moved the import files under `01_IMPORT`
// and renamed the Kauro-made column, and a runner carrying its own copies of
// those strings went on addressing a tree that no longer exists. So the layout
// module and the adapter are asked for both, and the next move to either one
// reaches this runner without anybody remembering it is here.
const hubspot = getAdapter('HUBSPOT');

/** The directory an operator imports from, inside a package this run wrote. */
const importArea = (packageDir) => join(packageDir, IMPORT_AREA, hubspot.importDirectory);

// --------------------------------------------------------------------- portal

const shPath = (...parts) => join(...parts).split('\\').join('/');

function hs(method, path, body) {
  const args = [shPath(resolve(authDir), 'hs.sh'), method, path];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const text = out.split('\n__HTTP_STATUS__')[0];
  let json = null;
  try { json = JSON.parse(text); } catch { /* some responses carry no body */ }
  return { status, json, text };
}

function submitImport(request, files) {
  const requestPath = join(workDir, `request-${String(requestCounter += 1)}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  // `hs-upload.sh`, not `hs-import.sh`. The name drifted: the auth directory
  // carries the multipart helper under the former and this runner asked for the
  // latter, so the gate could not submit a single file. Nothing documented the
  // contract between the two, which is why it drifted — see the README.
  const args = [shPath(resolve(authDir), 'hs-upload.sh'), shPath(requestPath), ...files.map((file) => shPath(file))];
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const text = out.split('\n__HTTP_STATUS__')[0];
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status, json, text };
}
let requestCounter = 0;

/** Wait for an import to reach a state it will not leave. A count read while an import is still running is not a result. */
function settle(importId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = hs('GET', `/crm/v3/imports/${importId}`);
    const state = last.json?.state ?? '';
    if (state === 'DONE' || state === 'FAILED' || state === 'CANCELED') return last.json;
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)']);
  }
  return last?.json ?? null;
}

function importErrors(importId) {
  const response = hs('GET', `/crm/v3/imports/${importId}/errors?limit=100`);
  return response.json?.results ?? [];
}

// ------------------------------------------------------------------ expected

const cases = [];
const failures = [];

/**
 * One expectation, as a pair, with the verdict derived from comparing it.
 *
 * `ok` used to be an argument. A gate could therefore record `ok: true` beside
 * a detail saying the opposite, and SF-OCR-01 shipped exactly that: the only
 * thing that could have caught it was a regular expression over the English.
 * Here the verdict is computed, so it cannot disagree with what was compared,
 * and both sides are written down so a reader can see what was asked rather
 * than only whether the answer pleased the runner.
 *
 * Most calls pass a predicate and leave `expected` at true, which is the honest
 * rendering of a check whose name states the claim. Where the observed value is
 * worth reading, the caller passes it and the value it should have been.
 *
 * @param {string} id the case id, declared in qualification/oracles.mjs
 * @param {unknown} observed what the portal said
 * @param {string|null} detail what to say when it did not match
 * @param {unknown} expected what it had to be
 */
function expect(id, observed, detail, expected = true) {
  const ok = JSON.stringify(observed) === JSON.stringify(expected);
  cases.push({
    id,
    ok,
    expected,
    observed,
    detail: ok ? null : (detail ?? `expected ${JSON.stringify(expected)} and observed ${JSON.stringify(observed)}`),
  });
  if (!ok) failures.push(`${id}: ${detail ?? `expected ${JSON.stringify(expected)} and observed ${JSON.stringify(observed)}`}`);
}

// ------------------------------------------------------------------ the engine

const OBJECT_TYPE = { CONTACT: '0-1', COMPANY: '0-2', DEAL: '0-3' };

/**
 * Column header to HubSpot internal name.
 *
 * The adapter writes HubSpot's own property labels as headers because that is
 * what the import wizard reads. The API maps by internal name, so the operator's
 * click-through is spelled out here — and only for the properties this corpus
 * uses, so a header nobody declared cannot be silently dropped into an import.
 */
const PROPERTY_OF = {
  Email: 'email',
  'First name': 'firstname',
  'Last name': 'lastname',
  'Job title': 'jobtitle',
  'Lifecycle stage': 'lifecyclestage',
  Name: 'name',
  'Company domain name': 'domain',
  City: 'city',
  'Deal name': 'dealname',
  Amount: 'amount',
  'Close date': 'closedate',
  'Deal stage': 'dealstage',
  Pipeline: 'pipeline',
};

/**
 * One column, declared to HubSpot.
 *
 * The Imports API requires every column in the file to be declared **and** to
 * name a property. There is no way to declare a column and not import it: the
 * portal answers "Mismatching number of columns" when a column is left out, and
 * "Must specify property name for column X" when it is declared without one.
 * Four other spellings were tried — `ignored`, `toIgnore`, `skip`, and a
 * `columnType` of IGNORE, IGNORED and DONT_IMPORT — and each was refused or
 * answered with a 500.
 *
 * The import wizard has a "Don't import column" choice. The API has no
 * equivalent, which is a difference between what an operator can do by hand and
 * what an operator can automate, and it decides the shape of `apiReadyCopy`
 * below.
 */
function columnMapping(header, object, isKey) {
  const property = PROPERTY_OF[header];
  return {
    columnObjectTypeId: OBJECT_TYPE[object],
    columnName: header,
    propertyName: property,
    ...(isKey ? { columnType: 'HUBSPOT_ALTERNATE_ID' } : {}),
  };
}

const columnsDropped = new Set();

/**
 * The package's file, in the form the Imports API accepts.
 *
 * Only one thing is done to it: columns that map to no HubSpot property are
 * removed, which for this adapter means the association key. No value is
 * altered, no row is added or dropped, and the columns that remain are in the
 * order the package wrote them.
 *
 * The alternative was to map the association key to some property so the API
 * would take the file, and that is precisely what this engine must never do.
 * The column exists so the operator can join two import files; writing it into
 * somebody's portal would make Kauro's bookkeeping into their data. Whatever is
 * dropped, `columnsDropped` records it, so a header this runner did not expect
 * is reported rather than quietly discarded.
 */
function apiReadyCopy(filePath, name) {
  const table = readCsvFile(filePath);
  const keep = table.headers.filter((header) => PROPERTY_OF[header] !== undefined);
  for (const header of table.headers) if (!keep.includes(header)) columnsDropped.add(header);
  if (keep.length === table.headers.length) return filePath;
  const copy = join(workDir, name);
  writeCsvFile(copy, keep, table.rows);
  return copy;
}

function readCsvFile(path) {
  const text = readFileSync(path, 'utf8');
  const records = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; continue; }
    if (character === '\r') continue;
    if (character === '\n') { row.push(field); records.push(row); field = ''; row = []; continue; }
    field += character;
  }
  if (field !== '' || row.length > 0) { row.push(field); records.push(row); }
  const headers = records[0] ?? [];
  return {
    headers,
    rows: records.slice(1).filter((cells) => cells.some((cell) => cell !== '')).map((cells) => {
      const object = {};
      headers.forEach((name, index) => { object[name] = cells[index] ?? ''; });
      return object;
    }),
  };
}

function writeCsvFile(path, headers, rows) {
  const cell = (value) => (/[",\r\n]/u.test(value) ? `"${value.split('"').join('""')}"` : value);
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(headers.map((name) => cell(row[name] ?? '')).join(','));
  writeFileSync(path, `${lines.join('\n')}\n`);
}

/**
 * Build the contract from whatever route the bundle was captured by.
 *
 * This used to open `contact.csv`, `company.csv` and `deal.csv` by name, which
 * meant it could only ever read a Settings export. The collector grew a second
 * route — `GET /crm/v3/properties/{objectType}`, which needs no human to click
 * anything and which carries `hasUniqueValue` as an *artifact* rather than as
 * somebody's assertion in the supplement — and no consumer was taught to read
 * it. So the better capture existed and nothing could use it.
 *
 * The route is read from `capture-manifest.json` rather than guessed from which
 * files happen to be present. The collector writes that manifest last, after
 * every artifact, precisely so that its presence is also the statement that the
 * capture finished; a runner that inferred the shape from the directory listing
 * would read a half-written capture as a complete one, and would do it silently.
 */
function buildContract() {
  const root = resolve(bundleDir);
  const read = (name) => readFileSync(join(root, name), 'utf8');

  let manifest;
  try {
    manifest = JSON.parse(read('capture-manifest.json'));
  } catch {
    process.stderr.write(
      `${join(root, 'capture-manifest.json')} is missing or unreadable. ` +
      'A capture is finished when its manifest is written; without one there is nothing that says which route produced these files or that they are all here.\n',
    );
    process.exit(1);
  }
  if (manifest.artifactKind !== 'HUBSPOT_CAPTURE_MANIFEST') {
    process.stderr.write(`capture-manifest.json declares artifactKind "${String(manifest.artifactKind)}" where HUBSPOT_CAPTURE_MANIFEST belongs\n`);
    process.exit(1);
  }

  const supplementText = read(manifest.supplement);
  const pipelineText = read(manifest.pipelines);
  const artifacts = [
    hubSpotArtifactRef(manifest.pipelines, 'HUBSPOT_PIPELINE_ARTIFACT', pipelineText),
    hubSpotArtifactRef(manifest.supplement, 'HUBSPOT_SUPPLEMENT', supplementText),
  ];

  const objects = [];
  const apiCaptures = [];

  if (manifest.route === 'EXPORT') {
    const LABELS = { 'contact.csv': ['CONTACT', 'Contact'], 'company.csv': ['COMPANY', 'Company'], 'deal.csv': ['DEAL', 'Deal'] };
    for (const file of manifest.propertyExports ?? []) {
      const [apiName, label] = LABELS[file] ?? [];
      if (apiName === undefined) {
        process.stderr.write(`capture-manifest.json names the export "${file}", which this runner has no object for\n`);
        process.exit(1);
      }
      const text = read(file);
      objects.push(parseHubSpotPropertyExport(text, { objectApiName: apiName, objectLabel: label, filePath: file }));
      artifacts.push(hubSpotArtifactRef(file, 'HUBSPOT_PROPERTY_EXPORT', text));
    }
  } else if (manifest.route === 'API') {
    for (const capture of manifest.propertyApiCaptures ?? []) {
      const text = read(capture.path);
      apiCaptures.push(parseHubSpotPropertyApi(text, {
        objectApiName: capture.objectApiName,
        objectLabel: capture.objectLabel,
        // Stated by the capture, not by this runner. The properties body carries
        // no portal id, and a runner that supplied one would be asserting the
        // very thing the contract builder exists to check.
        portalId: String(manifest.portalId),
        portalIdSource: capture.portalIdSource,
        filePath: capture.path,
      }));
      artifacts.push(hubSpotArtifactRef(capture.path, 'HUBSPOT_PROPERTY_API', text));
    }
  } else {
    process.stderr.write(`capture-manifest.json declares route "${String(manifest.route)}"; this runner reads EXPORT and API\n`);
    process.exit(1);
  }

  // The access grant (capture version 2): the portal's own statement of what
  // this integration may create and update, read back as one more artifact. A
  // capture without one builds a contract whose object flags are UNKNOWN, and
  // the engine refuses every writing run against it; that is the engine's
  // decision to make, so this runner passes exactly what the capture holds.
  let accessGrant;
  if (typeof manifest.accessGrant === 'string') {
    const grantText = read(manifest.accessGrant);
    accessGrant = parseHubSpotAccessGrant(grantText, manifest.accessGrant);
    artifacts.push(hubSpotArtifactRef(manifest.accessGrant, 'HUBSPOT_ACCESS_GRANT', grantText));
  }

  return hashTargetContract(
    buildHubSpotTargetContract({
      supplement: parseHubSpotSupplement(supplementText, manifest.supplement),
      objects,
      apiCaptures,
      pipelines: parseHubSpotPipelineArtifact(pipelineText, { filePath: manifest.pipelines }).pipelines,
      artifacts,
      ...(accessGrant === undefined ? {} : { accessGrant }),
    }),
  );
}

const contract = buildContract();

/**
 * The signature over the contract this gate captured, and the key that checks it.
 *
 * A HUBSPOT run is `REQUIRED` to present an attested target instance, so there
 * is no longer such a thing as a HubSpot run without one and `withContract` has
 * gone with it. What is attested here is the **real** captured contract — the
 * portal's own properties, read on the credential this gate authenticates
 * with — not one of the offline harness's fictional instances. The signing key
 * is generated in-process because this qualification is its own relying party:
 * what it is establishing is that the engine migrates against a real portal's
 * schema, not that some third party vouched for the portal.
 */
const attested = attestExistingContract(contract);

function runEngine(caseId) {
  const caseDir = join(corpusRoot, caseId);
  const packageDir = join(workDir, caseId, 'package');
  rmSync(join(workDir, caseId), { recursive: true, force: true });
  mkdirSync(join(workDir, caseId), { recursive: true });

  const configPath = join(caseDir, 'config.json');
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);

  // Where this run is allowed to spill. The core does not choose: a scratch
  // store is host-injected and quota-bounded, so the harness is the host here
  // and says both where and how much. One store per case, disposed after, so no
  // case can read what another left behind.
  const scratch = createFilesystemScratchStore({
    root: join(workDir, caseId, 'scratch'),
    runId: caseId,
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });

  // Staged, verified where it was staged, and published only if it passes —
  // the order `kauro-core run` uses, and for its reason: a package that does not
  // verify must never appear where an operator would look for it. It all sits
  // inside the one block because verification reads the families the run
  // spilled, and those are gone when the scratch is disposed.
  let result;
  let verification;
  try {
    result = runMigration({
      inputRoot: join(caseDir, 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
      targetContract: contract,
      scratch,
      ...attested,
    });
    const written = writePackage({
      result,
      config: loaded.config,
      normalizedConfig: loaded.normalizedJson,
      outputDir: packageDir,
      force: true,
    });
    verification = verifyPackage(written.stagingDir, { scratch });
    if (verification.passed) promotePackage(written, { force: true });
    else discardStagedPackage(written);
  } finally {
    scratch.dispose();
  }
  expect(`${caseId}.packageVerifies`, verification.passed,
    `the package the engine produced does not verify: ${verification.problems.map((p) => p.check).join(', ')}`);
  return { packageDir, result, verification };
}

// --------------------------------------------------- a clean slate to import into

// The campaign's subdomain of the qualification domain, which is what the
// instantiated corpus carries and therefore what the portal holds.
const QUALIFICATION_DOMAIN = campaign.domain;

/**
 * Nothing of this campaign is in the portal yet.
 *
 * Asked, not enforced. A namespace that already holds records means a previous
 * run of this same campaign did not finish its cleanup, and deleting them here
 * would destroy the evidence of why — so the run stops and says which ids are
 * there. Every other campaign's records are invisible to this question, which is
 * the point of the namespace.
 */
function assertNamespaceEmpty() {
  // The store, for the same reason X3 reads the store: the index would report a
  // namespace as empty while it still held the records of a run that failed
  // halfway, which is the one situation this question exists to detect.
  const found = [];
  for (const [objectType, property] of [['contacts', 'email'], ['companies', 'domain']]) {
    for (const record of listObjects(objectType, [property])) {
      const value = String(record.properties?.[property] ?? '');
      if (!value.endsWith(QUALIFICATION_DOMAIN)) continue;
      found.push(`${objectType} ${String(record.id)} <${value}>`);
    }
  }
  if (found.length === 0) return;
  process.stderr.write(
    `REFUSED: portal namespace ${QUALIFICATION_DOMAIN} already holds ${String(found.length)} records from an earlier run of campaign ` +
      `${campaign.campaignId}:\n${found.map((line) => `  ${line}`).join('\n')}\n` +
      'Delete them deliberately, or seal a new campaign. This gate does not clear a portal by pattern.\n',
  );
  process.exit(1);
}

function search(objectType, property, operator, value, properties) {
  const response = hs('POST', `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [{ filters: [{ propertyName: property, operator, value }] }],
    properties,
    limit: 100,
  });
  return response.json?.results ?? [];
}

/**
 * Every record of a type, read straight from the object store.
 *
 * Not search. HubSpot's search index is eventually consistent, and a record
 * created seconds ago is routinely absent from it — which is a fine way to
 * conclude that an import created nothing when it created three. Anything this
 * gate asserts about what the portal holds is read from the store, and search
 * is used only to find leftovers to clear before a run.
 */
function listObjects(objectType, properties) {
  const found = [];
  let after = null;
  do {
    const query = `?limit=100&properties=${properties.join(',')}${after === null ? '' : `&after=${after}`}`;
    const response = hs('GET', `/crm/v3/objects/${objectType}${query}`);
    found.push(...(response.json?.results ?? []));
    after = response.json?.paging?.next?.after ?? null;
  } while (after !== null && found.length < 500);
  return found;
}

const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'jobtitle', 'lifecyclestage'];

/** The qualification's own contacts, by email, read from the store. */
function qualificationContacts() {
  return new Map(
    listObjects('contacts', CONTACT_PROPERTIES)
      .filter((contact) => String(contact.properties.email ?? '').endsWith(`@${QUALIFICATION_DOMAIN}`))
      .map((contact) => [String(contact.properties.email ?? '').toLowerCase(), contact]),
  );
}

/**
 * The records this run made, by the id the portal gave each one.
 *
 * Filled by reading the portal back after each import, restricted to this
 * campaign's namespace: HubSpot's Imports API creates records asynchronously and
 * does not return their ids, so the ids have to be read. Everything the ledger
 * holds is deleted at the end and read back to see that it is gone.
 */
const ledger = createdLedger({ vendor: 'hubspot', instanceId: null, namespace: QUALIFICATION_DOMAIN });
const ledgered = new Set();

function harvestNamespace() {
  for (const [objectType, property] of [['contacts', 'email'], ['companies', 'domain']]) {
    for (const record of listObjects(objectType, [property])) {
      const value = String(record.properties?.[property] ?? '');
      if (!value.endsWith(QUALIFICATION_DOMAIN)) continue;
      const handle = `${objectType}/${String(record.id)}`;
      if (ledgered.has(handle)) continue;
      ledgered.add(handle);
      ledger.record(objectType, String(record.id), value);
    }
  }
  // Deals carry no domain, so they are reached two ways: by the namespace
  // prefix their name was instantiated with, and by association to a company
  // this campaign created. Both are properties of *this campaign's* records; a
  // deal reached by neither is left alone, because guessing at one by a word in
  // its name is how the portal came to be cleared by pattern.
  const dealPrefix = `[${campaign.namespace}] `;
  for (const deal of listObjects('deals', ['dealname'])) {
    const handle = `deals/${String(deal.id)}`;
    if (ledgered.has(handle)) continue;
    const name = String(deal.properties?.dealname ?? '');
    let mine = name.startsWith(dealPrefix);
    if (!mine) {
      const associated = hs('GET', `/crm/v4/objects/deals/${String(deal.id)}/associations/companies`);
      const companyIds = (associated.json?.results ?? []).map((entry) => String(entry.toObjectId ?? entry.id ?? ''));
      mine = companyIds.some((id) => ledgered.has(`companies/${id}`));
    }
    if (!mine) continue;
    ledgered.add(handle);
    ledger.record('deals', String(deal.id), name);
  }
}

mkdirSync(workDir, { recursive: true });

// The corpus, instantiated at this campaign's namespace. What goes to the portal
// is still exactly what the engine produced; the engine is run over this copy.
const corpusRoot = join(workDir, 'corpus');
rmSync(corpusRoot, { recursive: true, force: true });
// Deal names carry no domain, so they are namespaced by a bracketed prefix.
// Without it `I5` reads every campaign's deals back at once: this run created
// two and the check found four, two of them left in the portal by an earlier
// qualification, and concluded that the stage had not resolved.
const instantiated = instantiateCorpus(committedCorpus, corpusRoot, campaign.namespace, { prefixColumns: ['Deal Name'] });
// The prefixing has to have happened.
//
// `prefixColumnValues` matches the header literally and returns silently when
// nothing matches, so renaming or re-casing the corpus column would leave every
// deal with a bare name — invisible to the harvest's prefix test, invisible to
// the association fallback, and excluded from X1 by hand. A count of zero is the
// whole failure, and it was written into the evidence and never asserted.
if (instantiated.prefixed === 0) {
  process.stderr.write(
    'REFUSED: the corpus instantiation prefixed no values. The deal names carry no domain, so the bracketed namespace ' +
      'prefix is the only thing that makes them this campaign\'s; a corpus whose "Deal Name" header was renamed would ' +
      'create deals no cleanup can find.\n',
  );
  process.exit(1);
}

// --------------------------------------------------------------------- imports

/**
 * One object file, imported.
 *
 * `keyColumn` names the column HubSpot is to match on; without one the import
 * creates unconditionally, which is the difference between I6's three cases.
 */
function importObjectFile(name, filePath, object, operation, keyColumn) {
  filePath = apiReadyCopy(filePath, `${name.replace(/[^a-z0-9]+/giu, '-')}.csv`);
  const { headers } = readCsvFile(filePath);
  const columnMappings = headers.map((header) => columnMapping(header, object, header === keyColumn));
  const request = {
    name,
    importOperations: { [OBJECT_TYPE[object]]: operation },
    dateFormat: 'YEAR_MONTH_DAY',
    files: [{
      fileName: filePath.split(/[\\/]/u).pop(),
      fileFormat: 'CSV',
      fileImportPage: { hasHeader: true, columnMappings },
    }],
  };
  const submitted = submitImport(request, [filePath]);
  if (submitted.status >= 400 || submitted.json?.id === undefined) {
    return { submitted, settled: null, errors: [], counters: {} };
  }
  const settled = settle(submitted.json.id);
  return {
    submitted,
    settled,
    errors: importErrors(submitted.json.id),
    counters: settled?.metadata?.counters ?? {},
  };
}

/**
 * Which portal this actually wrote to, asked of the credential rather than
 * inferred from the contract.
 *
 * `portalId` used to be `contract.contract.instance.instanceId` — the portal the
 * *bundle describes*, which is not the portal the *writes go to*. Those are the
 * same thing only by luck, and on this repository they were not: every record
 * this gate created went to 51872453, while `qualification/evidence/hs-import.json`
 * recorded portal 51050101, because the bundle it was handed had been captured
 * there. An evidence file that names the wrong tenant is a false record about
 * somebody's account, and the collector was already corrected for exactly this
 * mistake in `collect-target-schema.mjs`. The runner was not.
 *
 * So the account says what it is, and the two are recorded separately. If they
 * disagree the run stops before it writes anything: a qualification whose
 * contract describes one instance while its imports land in another is not
 * qualifying the engine against a target, it is qualifying it against two, and
 * whichever way the result came out it would not mean what it says.
 */
const accountDetails = hs('GET', '/account-info/v3/details');
if (accountDetails.status !== 200 || accountDetails.json?.portalId === undefined) {
  process.stderr.write(`GET /account-info/v3/details: ${String(accountDetails.status)} — the portal being written to could not be established\n`);
  process.exit(1);
}
const writingToPortal = String(accountDetails.json.portalId);

// Which instance, and whether writing to it is permitted, before the first
// write. The observation decides which portal was touched; the allowlist decides
// whether touching it was allowed.
const observed = observedInstance({
  vendor: 'hubspot',
  instanceId: writingToPortal,
  observedBy: 'GET /account-info/v3/details, on the credential that performed these imports, in this run',
  detail: String(accountDetails.json.accountType ?? 'account type not stated'),
});
try {
  assertInstanceAuthorised(observed);
} catch (error) {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}

/**
 * What the credential may actually do, asked of the portal.
 *
 * An account id says which tenant. It does not say whether this token may create
 * a contact, and a gate that finds out by failing halfway through an import has
 * already written some of what it was about to check. Each probe is the cheapest
 * scoped read the API offers for the privilege the run needs.
 */
const privileges = [
  ['contacts.read', 'GET', '/crm/v3/objects/contacts?limit=1'],
  ['companies.read', 'GET', '/crm/v3/objects/companies?limit=1'],
  ['deals.read', 'GET', '/crm/v3/objects/deals?limit=1'],
  ['properties.read', 'GET', '/crm/v3/properties/contacts?limit=1'],
  ['imports.read', 'GET', '/crm/v3/imports?limit=1'],
].map(([name, method, path]) => {
  const response = hs(method, path);
  return { privilege: name, probe: `${method} ${path.split('?')[0]}`, status: response.status, ok: response.status === 200 };
});
const missingPrivileges = privileges.filter((entry) => !entry.ok);
if (missingPrivileges.length > 0) {
  process.stderr.write(
    `REFUSED: the credential lacks privileges this gate needs: ${missingPrivileges.map((entry) => `${entry.privilege} (${entry.probe} -> ${String(entry.status)})`).join(', ')}\n`,
  );
  process.exit(1);
}

assertNamespaceEmpty();

const contractPortal = String(contract.contract.instance.instanceId);
if (writingToPortal !== contractPortal) {
  process.stderr.write(
    `REFUSED: the credential writes to portal ${writingToPortal} (${String(accountDetails.json.accountType ?? 'account type not stated')}) ` +
    `but the bundle describes portal ${contractPortal}. Capture a contract from the portal being qualified, or point the credential at the portal the contract describes.\n`,
  );
  process.exit(1);
}

// One reading of the clock, used for the measurement and for its binding. The
// gate requires the two to be equal, and two calls a few milliseconds apart are
// not.
const capturedAt = nowUtc();

const evidence = {
  gate: 'HSP-TARGET-01 (import)',
  observedAt: capturedAt,
  observedInstance: observed,
  privileges,
  // The corner of the portal this campaign wrote in, and what was put there to
  // make the corpus land in it.
  namespace: {
    campaignId: campaign.campaignId,
    namespace: campaign.namespace,
    domain: campaign.domain,
    corpusFilesRewritten: instantiated.files,
    substitutions: instantiated.substitutions,
    valuesPrefixed: instantiated.prefixed,
    corpus: corpusSize(corpusRoot),
  },
  // Both, and named for what each one is. A reader should never have to work
  // out which portal a number belongs to.
  portalId: writingToPortal,
  portalIdSource: 'GET /account-info/v3/details on the credential that performed these imports, in this run',
  accountType: accountDetails.json.accountType ?? null,
  contractPortalId: contractPortal,
  // When this looked. Without it, "current" is a word rather than a claim — and
  // this file is the one that used to carry no capture time at all, which made
  // the gate's agreement check vacuous.
  capturedAt,
  imports: [],
};
function record(label, outcome) {
  evidence.imports.push({
    label,
    status: outcome.submitted.status,
    state: outcome.settled?.state ?? null,
    counters: outcome.counters,
    errorCount: outcome.errors.length,
    firstError: outcome.errors[0] === undefined ? null : {
      errorType: outcome.errors[0].errorType,
      context: JSON.stringify(outcome.errors[0].extraContext ?? {}).slice(0, 300),
    },
    detail: outcome.submitted.status >= 400 ? outcome.submitted.text.slice(0, 400) : null,
  });
  return outcome;
}

// ------------------------------------------------------------------------ Q1

const q1 = runEngine('Q1-create');
const q1Import = importArea(q1.packageDir);

const q1Contacts = record('Q1 contacts', importObjectFile('kauro qual Q1 contacts', join(q1Import, 'contacts.csv'), 'CONTACT', 'CREATE', null));
const q1Companies = record('Q1 companies', importObjectFile('kauro qual Q1 companies', join(q1Import, 'companies.csv'), 'COMPANY', 'CREATE', null));
const q1Deals = record('Q1 deals', importObjectFile('kauro qual Q1 deals', join(q1Import, 'deals.csv'), 'DEAL', 'CREATE', null));

expect('I1.contacts', q1Contacts.settled?.state === 'DONE' && q1Contacts.errors.length === 0,
  `contacts import ended ${String(q1Contacts.settled?.state)} with ${String(q1Contacts.errors.length)} errors: ${JSON.stringify(q1Contacts.errors[0] ?? q1Contacts.submitted.text).slice(0, 300)}`);
expect('I1.companies', q1Companies.settled?.state === 'DONE' && q1Companies.errors.length === 0,
  `companies import ended ${String(q1Companies.settled?.state)} with ${String(q1Companies.errors.length)} errors: ${JSON.stringify(q1Companies.errors[0] ?? q1Companies.submitted.text).slice(0, 300)}`);
expect('I1.deals', q1Deals.settled?.state === 'DONE' && q1Deals.errors.length === 0,
  `deals import ended ${String(q1Deals.settled?.state)} with ${String(q1Deals.errors.length)} errors: ${JSON.stringify(q1Deals.errors[0] ?? q1Deals.submitted.text).slice(0, 300)}`);

// ------------------------------------------------------- what the portal holds

const deliveredContacts = readCsvFile(join(q1Import, 'contacts.csv')).rows;
const portalContacts = qualificationContacts();

expect('I9.contactsDelivered', portalContacts.size === deliveredContacts.length,
  `the package delivers ${String(deliveredContacts.length)} contacts and the portal holds ${String(portalContacts.size)}`);

// I2 and I10 together: every property the package set, read back from the
// portal and compared against the file rather than against the import's report.
let mismatched = [];
for (const row of deliveredContacts) {
  const contact = portalContacts.get(String(row.Email ?? '').toLowerCase());
  if (contact === undefined) { mismatched.push(`${row.Email} is not in the portal`); continue; }
  for (const [header, property] of Object.entries(PROPERTY_OF)) {
    if (!(header in row) || row[header] === '') continue;
    const delivered = String(contact.properties[property] ?? '');
    if (delivered.toLowerCase() !== String(row[header]).toLowerCase()) {
      mismatched.push(`${row.Email} ${property}="${delivered}" where the package said "${String(row[header])}"`);
    }
  }
}
expect('I10.exportBackMatchesThePackage', mismatched.length === 0, mismatched.slice(0, 4).join('; '));
expect('I2.aPropertyBeyondTheIdentifiers',
  [...portalContacts.values()].every((contact) => String(contact.properties.jobtitle ?? '') !== ''),
  'a contact came back with no job title, so a property beyond the identifiers did not carry');
expect('I3.definedEnumerationValue',
  [...portalContacts.values()].every((contact) => String(contact.properties.lifecyclestage ?? '') === 'lead'),
  `lifecycle stages read back as ${[...portalContacts.values()].map((c) => String(c.properties.lifecyclestage ?? '')).join(', ')}`);

const deliveredDealNames = new Set(readCsvFile(join(q1Import, 'deals.csv')).rows.map((row) => row['Deal name']));
const portalDeals = listObjects('deals', ['dealname', 'dealstage', 'pipeline', 'amount'])
  .filter((deal) => deliveredDealNames.has(String(deal.properties.dealname ?? '')));
expect('I5.stageResolvesByInternalIdentity',
  portalDeals.length === deliveredDealNames.size && portalDeals.every((deal) => String(deal.properties.dealstage ?? '') === 'closedwon'),
  `deals read back in stage ${portalDeals.map((deal) => String(deal.properties.dealstage ?? '')).join(', ') || '(no deal found)'}`);
expect('I5.pipelineResolvesByInternalIdentity',
  portalDeals.length > 0 && portalDeals.every((deal) => String(deal.properties.pipeline ?? '') === 'default'),
  `deals read back in pipeline ${portalDeals.map((deal) => String(deal.properties.pipeline ?? '')).join(', ')}`);

// ------------------------------------------------------------------------ Q2

const q2 = runEngine('Q2-enumeration');
const q2Contacts = record('Q2 undefined enumeration value',
  importObjectFile('kauro qual Q2 bad enumeration', join(importArea(q2.packageDir), 'contacts.csv'), 'CONTACT', 'CREATE', null));

// The value must be refused, and after MC-04 the engine refuses it before the
// portal ever sees it: destination validation checks every enumeration value
// against the attested picklist and isolates one the contract does not declare
// (DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN), so the bad row is never
// delivered. That is stronger than the pre-MC-04 path, which delivered the value
// and relied on the portal to reject it — and it is not a silent coercion,
// because the row is isolated under a named reason rather than written with the
// cell dropped. The check therefore reads the engine's isolation, and confirms
// no contact was stored carrying NOT_A_STATUS.
// Read from the package's isolated.csv, not the run's truth: the scratch store
// the run streamed through is disposed by the time this reads, and it is the
// package an operator receives anyway.
const q2Isolated = readCsvFile(join(q2.packageDir, packagePath('isolated.csv'))).rows.filter(
  (row) => row.reason_code === 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN' && String(row.detail ?? '').includes('NOT_A_STATUS'),
);
const q2Stored = [...qualificationContacts().values()].filter((contact) => String(contact.properties.email ?? '').startsWith('katherine@'));
const q2BadStored = q2Stored.some((contact) => String(contact.properties.lifecyclestage ?? '') === 'NOT_A_STATUS');
const q2Rejected = (q2Isolated.length > 0 || q2Contacts.errors.length > 0 || q2Contacts.settled?.state === 'FAILED') && !q2BadStored;
expect('I4.undefinedEnumerationValueIsRejected', q2Rejected,
  `engine isolations of the undefined stage: ${String(q2Isolated.length)}; import errors: ${String(q2Contacts.errors.length)}; katherine stored lifecyclestage=${q2Stored.map((contact) => JSON.stringify(String(contact.properties.lifecyclestage ?? ''))).join(', ') || '(not created)'}`);

const instanceVerification = readCsvFile(join(q2.packageDir, packagePath('instance-verification.csv'))).rows;
expect('I4.thePackagePredictedIt',
  instanceVerification.some((row) => row.scope === 'ENUMERATIONS' && row.reason_code === 'DESTINATION_INSTANCE_VERIFICATION_REQUIRED'),
  'the package did not declare that enumeration values need checking against the portal');

// ------------------------------------------------------------------------ Q7

// A required value that is blank (R2-009). A column being present is not a value:
// the row below has a Blankmail contact whose Email cell is empty, and HubSpot
// creates a contact by its email. Every literal here comes from the bytes of
// the corpus input, read back from the file, never from what the engine says
// about them.
const q7Input = readCsvFile(join(corpusRoot, 'Q7-required-blank', 'input', 'contacts.csv')).rows;
const q7BlankIds = q7Input.filter((row) => String(row['Email'] ?? '') === '').map((row) => String(row['Contact ID']));
const q7PresentIds = q7Input.filter((row) => String(row['Email'] ?? '') !== '').map((row) => String(row['Contact ID']));
const q7 = runEngine('Q7-required-blank');
const q7Contacts = record('Q7 required value blank',
  importObjectFile('kauro qual Q7 required blank', join(importArea(q7.packageDir), 'contacts.csv'), 'CONTACT', 'CREATE', null));
const q7Isolated = readCsvFile(join(q7.packageDir, packagePath('isolated.csv'))).rows.filter(
  (row) => row.reason_code === 'DESTINATION_REQUIRED_FIELD_MISSING',
);
const q7Portal = listObjects('contacts', ['email', 'firstname']);
const q7BlankStored = q7Portal.filter((contact) => String(contact.properties.firstname ?? '') === 'Blankmail');
const q7PresentStored = [...qualificationContacts().values()].filter((contact) => String(contact.properties.firstname ?? '') === 'Presentmail');
expect('I11.requiredBlankIsRejected',
  q7BlankIds.length === 1 && q7BlankStored.length === 0 && q7PresentStored.length === q7PresentIds.length &&
    (q7Isolated.length === q7BlankIds.length || q7Contacts.errors.length > 0),
  `blank-email rows in the input bytes: ${q7BlankIds.join(', ')}; contacts stored under the blank row's first name: ${String(q7BlankStored.length)}; present-email contacts stored: ${String(q7PresentStored.length)} of ${String(q7PresentIds.length)}; engine isolations: ${String(q7Isolated.length)}; import errors: ${String(q7Contacts.errors.length)}`);
expect('I11.thePackagePredictedIt',
  q7Isolated.length === q7BlankIds.length &&
    q7Isolated.every((row) => row.field === 'contact.email' &&
      // The row the input bytes say is blank: its physical row number is its
      // position after the header row.
      q7Input.findIndex((inputRow) => String(inputRow['Email'] ?? '') === '') + 2 === Number(row.row_number)),
  'the package did not isolate the blank-email row under DESTINATION_REQUIRED_FIELD_MISSING');

// ------------------------------------------------------------------ Q3 and Q4

// Q2 created its contact and refused only the offending cell, so the population
// the update cases are measured against is the one that exists after Q2 — not
// the one Q1 left behind.
const beforeUpdate = qualificationContacts();

const q3 = runEngine('Q3-update');
const q3Contacts = record('Q3 update by email',
  importObjectFile('kauro qual Q3 update', join(importArea(q3.packageDir), 'contacts.csv'), 'CONTACT', 'UPDATE', 'Email'));

const afterUpdate = qualificationContacts();
expect('I6.updateCreatesNothing', afterUpdate.size === beforeUpdate.size,
  `the portal held ${String(beforeUpdate.size)} contacts and holds ${String(afterUpdate.size)} after an update`);
expect('I6.updateKeepsTheSameRecord',
  [...portalContacts.entries()].every(([email, contact]) => afterUpdate.get(email)?.id === contact.id),
  'a contact came back with a different record id after an update');
expect('I6.updateChangedTheValue',
  afterUpdate.get(`ada@${QUALIFICATION_DOMAIN}`)?.properties?.jobtitle === 'Principal Engineer',
  `ada reads jobtitle="${String(afterUpdate.get(`ada@${QUALIFICATION_DOMAIN}`)?.properties?.jobtitle ?? '')}"`);

const q4 = runEngine('Q4-mixed');
const q4Contacts = record('Q4 one existing and one new',
  importObjectFile('kauro qual Q4 mixed', join(importArea(q4.packageDir), 'contacts.csv'), 'CONTACT', 'UPSERT', 'Email'));

const afterMixed = qualificationContacts();
expect('I6.mixedCreatedExactlyOne', afterMixed.size === afterUpdate.size + 1,
  `the portal held ${String(afterUpdate.size)} contacts and holds ${String(afterMixed.size)} after one existing and one new`);
expect('I6.mixedUpdatedTheExisting',
  afterMixed.get(`ada@${QUALIFICATION_DOMAIN}`)?.properties?.jobtitle === 'Fellow' &&
  afterMixed.get(`ada@${QUALIFICATION_DOMAIN}`)?.id === portalContacts.get(`ada@${QUALIFICATION_DOMAIN}`)?.id,
  `ada reads jobtitle="${String(afterMixed.get(`ada@${QUALIFICATION_DOMAIN}`)?.properties?.jobtitle ?? '')}" on record ${String(afterMixed.get(`ada@${QUALIFICATION_DOMAIN}`)?.id)}`);

// ------------------------------------------------------------------------ I7
//
// The association, as the adapter tells an operator to do it: the key from the
// association file becomes a common column in both object files, and one import
// carries both. The column values are taken from the package's association
// file; nothing about which contact belongs to which company is decided here.

// The common column has to be a property, for the same reason every other
// column does: the API refuses "Must specify property name for column X". So it
// cannot be the Kauro association key, and it should not be — a join key the
// portal carries is the destination's own identity, which is the whole
// distinction this engine is built around. It is the company's domain.
//
// Which contact belongs to which company is still decided entirely by the
// package: the association file gives contact association key to company
// association key, and the company file gives company association key to
// domain. Nothing here knows anything the package did not say.
//
// The three column names come from the adapter rather than being written out
// here. They were literals until 2.0.0 renamed the column, and a literal that
// no longer matches any header does not fail — every lookup misses, the common
// column comes out empty for every row, and the import that follows proves
// nothing about a join that never happened. Read from the adapter, a rename
// carries through; and the expectation below states the join outright, so a
// mismatch that does slip in is a failure rather than a silence.
const COMMON_COLUMN = 'Company domain name';
const ASSOCIATION_FROM = hubspot.associationFromHeader;
const ASSOCIATION_TO = hubspot.associationToHeader;
const ASSOCIATION_KEY = hubspot.associationKeyHeader;
const associationTable = readCsvFile(join(q1Import, 'associations', 'contact_to_company.csv'));
const associations = associationTable.rows;
const companyOfContact = new Map(associations.map((row) => [row[ASSOCIATION_FROM], row[ASSOCIATION_TO]]));

const contactsTable = readCsvFile(join(q1Import, 'contacts.csv'));
const companiesTable = readCsvFile(join(q1Import, 'companies.csv'));
const domainOfCompany = new Map(companiesTable.rows.map((row) => [row[ASSOCIATION_KEY], row[COMMON_COLUMN]]));

// A join that matched nothing is the failure this section was blind to, so it is
// stated rather than left to be inferred from whether the portal later reported
// an association. The detail names the headers actually in the file, because the
// way this breaks is a column that was renamed underneath the runner.
const contactKeys = new Set(contactsTable.rows.map((row) => row[ASSOCIATION_KEY]));
expect('I7.theAssociationFileJoinsTheObjectFiles',
  associations.length > 0 && associations.every((row) =>
    contactKeys.has(row[ASSOCIATION_FROM]) && domainOfCompany.has(row[ASSOCIATION_TO])),
  `${String(associations.length)} contact-to-company rows read under "${ASSOCIATION_FROM}" and "${ASSOCIATION_TO}"; the file carries ${associationTable.headers.join(', ')} and the object files carry "${ASSOCIATION_KEY}" ${String(contactKeys.size)} times`);

const contactsWithKey = join(workDir, 'contacts-with-common-column.csv');
const companiesWithKey = join(workDir, 'companies-with-common-column.csv');
const contactHeaders = contactsTable.headers.filter((header) => PROPERTY_OF[header] !== undefined);
const companyHeaders = companiesTable.headers.filter((header) => PROPERTY_OF[header] !== undefined);
writeCsvFile(contactsWithKey, [...contactHeaders, COMMON_COLUMN],
  contactsTable.rows.map((row) => ({
    ...row,
    [COMMON_COLUMN]: domainOfCompany.get(companyOfContact.get(row[ASSOCIATION_KEY]) ?? '') ?? '',
  })));
writeCsvFile(companiesWithKey, companyHeaders, companiesTable.rows);

function mappingsFor(table, object, extra) {
  const named = new Set(extra.map((mapping) => mapping.columnName));
  return [
    ...table.headers
      .filter((header) => !named.has(header) && PROPERTY_OF[header] !== undefined)
      .map((header) => columnMapping(header, object, false)),
    ...extra,
  ];
}

const associationRequest = {
  name: 'kauro qual I7 contact to company',
  importOperations: { [OBJECT_TYPE.CONTACT]: 'UPSERT', [OBJECT_TYPE.COMPANY]: 'UPSERT' },
  dateFormat: 'YEAR_MONTH_DAY',
  files: [
    {
      fileName: 'contacts-with-common-column.csv',
      fileFormat: 'CSV',
      fileImportPage: {
        hasHeader: true,
        columnMappings: mappingsFor({ headers: contactHeaders }, 'CONTACT', [
          { columnObjectTypeId: OBJECT_TYPE.CONTACT, columnName: 'Email', propertyName: 'email', columnType: 'HUBSPOT_ALTERNATE_ID' },
          { columnObjectTypeId: OBJECT_TYPE.COMPANY, columnName: COMMON_COLUMN, propertyName: 'domain', columnType: 'HUBSPOT_ALTERNATE_ID' },
        ]),
      },
    },
    {
      fileName: 'companies-with-common-column.csv',
      fileFormat: 'CSV',
      fileImportPage: {
        hasHeader: true,
        columnMappings: mappingsFor({ headers: companyHeaders }, 'COMPANY', [
          { columnObjectTypeId: OBJECT_TYPE.COMPANY, columnName: COMMON_COLUMN, propertyName: 'domain', columnType: 'HUBSPOT_ALTERNATE_ID' },
        ]),
      },
    },
  ],
};

const associationSubmitted = submitImport(associationRequest, [contactsWithKey, companiesWithKey]);
let associationOutcome = { submitted: associationSubmitted, settled: null, errors: [], counters: {} };
if (associationSubmitted.status < 400 && associationSubmitted.json?.id !== undefined) {
  const settled = settle(associationSubmitted.json.id);
  associationOutcome = { submitted: associationSubmitted, settled, errors: importErrors(associationSubmitted.json.id), counters: settled?.metadata?.counters ?? {} };
}
record('I7 two-file common column', associationOutcome);

const ada = afterMixed.get(`ada@${QUALIFICATION_DOMAIN}`);
const adaCompanies = ada === undefined ? { json: null } : hs('GET', `/crm/v4/objects/contacts/${ada.id}/associations/companies`);
expect('I7.associationResolves', (adaCompanies.json?.results ?? []).length > 0,
  `the contact came back with ${String((adaCompanies.json?.results ?? []).length)} company associations; import ended ${String(associationOutcome.settled?.state)} ${associationOutcome.submitted.status >= 400 ? associationOutcome.submitted.text.slice(0, 300) : ''}`);

// ------------------------------------------------------------------------ I8
//
// Engine-side, and deliberately so: an activity must be refused before a file
// exists, not attempted and lost somewhere in a portal.

function refusesConfig(id, mutate, fragment) {
  const base = JSON.parse(readFileSync(join(corpusRoot, 'Q2-enumeration', 'config.json'), 'utf8'));
  const mutated = mutate(base);
  try {
    loadConfig(JSON.stringify(mutated), 'activity.json');
    expect(id, false, 'the engine accepted a configuration it must refuse');
  } catch (error) {
    const text = `${String(error?.message ?? '')} ${String(error?.remedy ?? '')} ${JSON.stringify(error?.details ?? {})}`;
    expect(id, text.toLowerCase().includes(fragment.toLowerCase()), `refused for the wrong reason: ${text.slice(0, 600)}`);
  }
}

refusesConfig('I8.activityObjectRefused', (config) => {
  config.records[0].object = 'ACTIVITY';
  return config;
}, 'ACTIVITY');

refusesConfig('I8.activityRelationshipRefused', (config) => {
  config.associations = [{
    id: 'contact-activity',
    kind: 'COLUMN_REFERENCE',
    recordMappingId: 'contacts',
    relationshipType: 'CONTACT_TO_ACTIVITY',
    keyColumn: { header: 'Contact ID' },
    targetRecordMappingId: 'contacts',
    targetMatchKey: 'SOURCE_RECORD_ID',
  }];
  return config;
}, 'CONTACT_TO_ACTIVITY');

// -------------------------------------------------------------------- report

evidence.cases = cases;
evidence.failures = failures;
evidence.contractHash = contract.contractHash;
evidence.columnsTheApiCannotCarry = [...columnsDropped];

// Everything this run created, deleted by id and read back.
//
// Read back one at a time rather than counted: a DELETE that returns 204 and a
// record that is actually gone are two different observations, and this gate
// exists because they are.
harvestNamespace();

// X1: everything this run created is inside this campaign's namespace. Contacts
// and companies carry the namespace in the value the corpus was instantiated
// with; a deal carries no domain and is in the ledger only because it is
// associated to a company that does.
// X1 asks the portal, not the ledger.
//
// The first version filtered the ledger for entries not ending in the namespace
// domain — and the ledger is populated by a harvest that admits an entry only if
// it *does* end in that domain. Expected and observed were the same predicate,
// one applied as a filter and the other as its negation, so the case could not
// fail on any possible run.
//
// So the question is asked of the object store instead: every contact and every
// company the portal holds, partitioned by whether it is in this campaign's
// namespace, against the ids this run created. A record this run created that
// is not in the namespace is a defect; a record in the namespace that this run
// did not create is a leftover from an earlier run of this campaign, which
// `assertNamespaceEmpty` is supposed to have refused.
const inTheStore = { inNamespace: [], createdHere: new Set(ledger.entries.map((entry) => `${entry.objectType}/${entry.id}`)) };
for (const [objectType, property] of [['contacts', 'email'], ['companies', 'domain']]) {
  for (const record of listObjects(objectType, [property])) {
    const value = String(record.properties?.[property] ?? '');
    if (!value.endsWith(QUALIFICATION_DOMAIN)) continue;
    inTheStore.inNamespace.push(`${objectType}/${String(record.id)}`);
  }
}
const createdOutside = [...inTheStore.createdHere].filter(
  (handle) => !handle.startsWith('deals/') && !inTheStore.inNamespace.includes(handle),
);
const strangersInside = inTheStore.inNamespace.filter((handle) => !inTheStore.createdHere.has(handle));

const created = {
  total: ledger.count,
  byType: ledger.entries.reduce((tally, entry) => ({ ...tally, [entry.objectType]: (tally[entry.objectType] ?? 0) + 1 }), {}),
  outsideTheNamespace: createdOutside,
  strangersInTheNamespace: strangersInside,
};
evidence.created = { ...created, ids: ledger.entries };
expect(
  'X1.everyCreatedRecordIsInThisCampaignNamespace',
  { createdOutside: createdOutside.length, strangersInside: strangersInside.length, created: ledger.count > 0 },
  `records this run created outside ${QUALIFICATION_DOMAIN}: ${createdOutside.join(', ')}; records in the namespace this run did not create: ${strangersInside.join(', ')}`,
  { createdOutside: 0, strangersInside: 0, created: true },
);

evidence.cleanup = ledger.dispose(
  (objectType, id) => {
    const response = hs('DELETE', `/crm/v3/objects/${objectType}/${id}`);
    return { deleted: response.status === 204 || response.status === 200, detail: `DELETE -> ${String(response.status)}` };
  },
  (objectType, id) => {
    const response = hs('GET', `/crm/v3/objects/${objectType}/${id}`);
    return { present: response.status === 200, detail: `GET -> ${String(response.status)}` };
  },
);
evidence.cleanup.instanceId = writingToPortal;

// X2: exactly what was created, and nothing else, was deleted.
expect(
  'X2.cleanupRemovedExactlyTheRecordsCreated',
  { requested: evidence.cleanup.requested, deleted: evidence.cleanup.deleted, leftBehind: evidence.cleanup.leftBehind.length },
  `deletion outcomes: ${JSON.stringify(evidence.cleanup.leftBehind)}`,
  { requested: created.total, deleted: created.total, leftBehind: 0 },
);

// X3: the namespace is empty when it is looked at again, which is a different
// observation from a DELETE having returned 204.
// The object store, not the search index.
//
// This file says in as many words, above `listObjects`, that HubSpot's search
// index is eventually consistent and that a record created seconds ago is
// routinely absent from it — "which is a fine way to conclude that an import
// created nothing when it created three" — and that anything this gate asserts
// about what the portal holds is read from the store. X3 is exactly such an
// assertion, and it was reading the index: a record that survived the delete is
// routinely invisible there seconds later, so the case passed.
const remaining = [];
for (const [objectType, property] of [['contacts', 'email'], ['companies', 'domain']]) {
  for (const record of listObjects(objectType, [property])) {
    if (!String(record.properties?.[property] ?? '').endsWith(QUALIFICATION_DOMAIN)) continue;
    remaining.push(`${objectType}/${String(record.id)}`);
  }
}
evidence.namespaceOnReadBack = { records: remaining };
expect(
  'X3.theNamespaceIsEmptyOnReadBack',
  remaining.length,
  `the namespace still holds ${remaining.join(', ')}`,
  0,
);

evidence.result = failures.length === 0 ? 'PASS' : 'FAIL';

// What this measurement was taken against, captured by the thing that took it.
//
// Written last, after the result, so a run that fell over part way through
// leaves no binding to be mistaken for one — and re-checked here against the
// subject captured before the first request, so a tree that moved while the
// portal was being written to is recorded as such rather than described as a
// subject that no longer exists.
evidence.capture = await captureEnd(started);

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
  assertRunnerAskedEverything('hs-import.json', cases);
} catch (error) {
  process.stderr.write(`REFUSED: ${String(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
}

if (evidencePath !== null) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

process.stdout.write(`HSP-TARGET-01 import: ${String(cases.length)} expectations\n`);
for (const entry of cases) process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id}${entry.ok ? '' : ` — ${entry.detail}`}\n`);
for (const entry of evidence.imports) {
  process.stdout.write(`  import ${entry.label}: http=${String(entry.status)} state=${String(entry.state)} counters=${JSON.stringify(entry.counters)} errors=${String(entry.errorCount)}${entry.detail === null ? '' : ` ${entry.detail}`}\n`);
}
process.stdout.write(`result = ${evidence.result}\n`);
if (failures.length > 0) process.exitCode = 1;

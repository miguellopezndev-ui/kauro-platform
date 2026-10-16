#!/usr/bin/env node
// Captures the HubSpot artifacts a target contract is built from.
//
// Two of the three are captured here. The third — the property export — is
// produced by a Settings action that emails a file and has no API, so it is
// supplied to this collector rather than fetched by it. That asymmetry is the
// point: what can be captured headlessly is, and what cannot is named as
// something a person handed over, not quietly generated.
//
// What this writes:
//
//   pipelines.csv             the Kauro-canonical pipelines artifact, from the
//                             portal's own pipeline and stage identifiers
//   hubspot-supplement.json   the portal id, and the uniqueness the export
//                             cannot carry, read from the Properties API
//   access-grant.json         what the portal granted this integration: the
//                             scopes, from the token-information endpoint, so
//                             the contract can state whether an object accepts
//                             creates and updates here (capture version 2)
//   contact.csv, company.csv, deal.csv
//                             copied from the supplied export, unmodified, so
//                             the bundle records the exact bytes parsed
//
// Usage:
//   node collect-target-schema.mjs --auth <dir> --export <dir> --out <dir>
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const authDir = argument('--auth');
const exportDir = argument('--export');
const outDir = argument('--out');
if (authDir === null || outDir === null) {
  process.stderr.write(
    'usage: node collect-target-schema.mjs --auth <dir> --out <dir> [--export <dir>]\n' +
      '  with --export: the Settings property export is copied in and parsed, and the\n' +
      '                 supplement states uniqueness for the properties it carries.\n' +
      '  without      : the properties API is captured directly. Headless, and the only\n' +
      '                 route to a portal whose export nobody can produce.\n',
  );
  process.exit(2);
}

/**
 * Which route this capture took, recorded rather than inferred.
 *
 * The export is a Settings action that emails a file, so a portal nobody can
 * sign into has no export and never will. That is not hypothetical here: every
 * committed HubSpot evidence file names portal 51050101, because that is the
 * portal whose export somebody had, while the qualification credential
 * authenticates to the isolated developer test account 51872453. A contract
 * built from one portal's export cannot speak for the other, and no amount of
 * care with the second portal fixes a capture taken from the first.
 *
 * The API route is not a lesser substitute for the export. `GET
 * /crm/v3/properties/{object}` carries `hasUniqueValue`, which the export cannot
 * carry at all — and uniqueness is the fact a match key rests on. On the export
 * route it arrives UNKNOWN and a person has to state it in the supplement; here
 * the portal states it, and the supplement is left to say only what the portal
 * did not.
 */
const route = exportDir === null ? 'API' : 'EXPORT';

const shPath = (...parts) => join(...parts).split('\\').join('/');

function hs(method, path) {
  const out = execFileSync('bash', [shPath(resolve(authDir), 'hs.sh'), method, path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const body = out.split('\n__HTTP_STATUS__')[0];
  if (status !== 200) throw new Error(`${method} ${path} -> ${String(status)}: ${body.slice(0, 240)}`);
  return JSON.parse(body);
}

mkdirSync(resolve(outDir), { recursive: true });

/**
 * What the portal granted the integration this capture authenticates as.
 *
 * `hs-token-info.sh` in the auth directory asks HubSpot's token-information
 * endpoint about the token in `env`; the token travels in the request body that
 * script composes, never on a command line and never in the answer. The answer
 * names the portal (hubId), the app and the scopes — the portal's own statement
 * of what this integration may create and update — and that is what the contract
 * reads the object flags from. Before this artifact existed the flags were
 * UNKNOWN from every reader, and under the rule that UNKNOWN never authorises,
 * every HubSpot writing run refused at destination validation.
 */
function accessGrant() {
  const out = execFileSync('bash', [shPath(resolve(authDir), 'hs-token-info.sh')], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/) ?? [])[1] ?? 0);
  const body = out.split('\n__HTTP_STATUS__')[0];
  if (status !== 200) throw new Error(`POST /oauth/v2/private-apps/get/access-token-info -> ${String(status)}: ${body.slice(0, 240)}`);
  const info = JSON.parse(body);
  const scopes = Array.isArray(info.scopes) ? info.scopes.map((scope) => String(scope)) : [];
  if (scopes.length === 0) throw new Error('the token-information response names no scopes; a grant with no scopes is not a capture');
  return { hubId: String(info.hubId), appId: String(info.appId), scopes: [...new Set(scopes)].sort() };
}

// ------------------------------------------------------------ property export
//
// Copied byte for byte. A collector that reformats an export is a collector
// that has started producing the evidence it claims to be gathering.
const EXPORT_FILES = ['contact.csv', 'company.csv', 'deal.csv'];
if (route === 'EXPORT') {
  for (const file of EXPORT_FILES) {
    copyFileSync(join(resolve(exportDir), file), join(resolve(outDir), file));
  }
}

// ------------------------------------------------------------------ pipelines

const capturedAt = `${new Date().toISOString().slice(0, 19)}Z`;

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.split('"').join('""')}"` : text;
}

const pipelineRows = [];
for (const [object, endpoint] of [['DEAL', 'deals']]) {
  const pipelines = hs('GET', `/crm/v3/pipelines/${endpoint}`);
  for (const pipeline of pipelines.results ?? []) {
    // The declaration row. The artifact requires a pipeline to be declared by a
    // row of its own before any stage may name it, so that a stage naming a
    // pipeline nobody captured is a contradiction rather than a pipeline the
    // reader conjures from the reference to it.
    pipelineRows.push([object, pipeline.label, pipeline.id, '', '', '', '', capturedAt]);
    for (const stage of pipeline.stages ?? []) {
      // The portal states a stage as closed-or-open plus a probability. Both go
      // into one column because the artifact declares one, and losing which of
      // them a value came from would make the column unreadable — so the closed
      // state is spelled out rather than reduced to its probability.
      const closed = String(stage.metadata?.isClosed ?? '') === 'true';
      const probability = String(stage.metadata?.probability ?? '');
      pipelineRows.push([
        object,
        pipeline.label,
        pipeline.id,
        stage.label,
        stage.id,
        String(stage.displayOrder ?? ''),
        `${closed ? 'CLOSED' : 'OPEN'} ${probability}`.trim(),
        capturedAt,
      ]);
    }
  }
}

const pipelineHeader = [
  'object',
  'pipeline_label',
  'pipeline_internal_name',
  'stage_label',
  'stage_internal_name',
  'display_order',
  'stage_probability_or_state',
  'captured_at',
];
writeFileSync(
  join(resolve(outDir), 'pipelines.csv'),
  `${[pipelineHeader, ...pipelineRows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
);

// ----------------------------------------------------------------- supplement
//
// Uniqueness is read from the Properties API rather than asserted. The export
// cannot carry it, which is what a supplement is for; that does not license
// making it up. `statedBy` names where each statement came from so a reader can
// go and check it.

const OBJECTS = [
  ['contacts', 'CONTACT', 'Contact', 'contact.csv'],
  ['companies', 'COMPANY', 'Company', 'company.csv'],
  ['deals', 'DEAL', 'Deal', 'deal.csv'],
];

// Read the export with the shipped parser rather than a second one written
// here. The supplement may only speak about properties the export carries, and
// the only honest answer to "does the export carry this?" is the answer the
// reader that builds the contract would give.
const { parseHubSpotPropertyExport } = await import('../../dist/src/target/hubspot-artifacts.js');

const uniqueProperties = [];
const uniquenessSeen = [];
const notExported = [];
const apiCaptures = [];
for (const [endpoint, apiName, label, file] of OBJECTS) {
  const properties = hs('GET', `/crm/v3/properties/${endpoint}`);

  // On the API route the response IS the artifact, so it is written exactly as
  // the portal returned it — pretty-printed only, which changes no value — and
  // the contract is built by parsing this file back rather than by using the
  // object this collector happens to be holding. A collector whose output and
  // whose parse can disagree is a collector nobody can check.
  if (route === 'API') {
    const path = `properties-${endpoint}.json`;
    writeFileSync(join(resolve(outDir), path), `${JSON.stringify(properties, null, 2)}\n`);
    apiCaptures.push({ path, endpoint, objectApiName: apiName, objectLabel: label, properties: (properties.results ?? []).length });
    continue;
  }

  const exported = new Set(
    parseHubSpotPropertyExport(readFileSync(join(resolve(outDir), file), 'utf8'), {
      objectApiName: apiName,
      objectLabel: label,
      filePath: file,
    }).fields.map((field) => field.apiName),
  );

  for (const property of properties.results ?? []) {
    const unique = property.hasUniqueValue === true;
    if (unique) uniquenessSeen.push(`${apiName}.${property.name}`);
    // The API lists properties the export does not: associations rendered as
    // properties, and internals the Settings export leaves out. A statement
    // about one of those would name a match key the contract has nowhere to
    // put, so it is dropped here rather than refused later.
    if (!exported.has(property.name)) {
      notExported.push(`${apiName}.${property.name}`);
      continue;
    }
    uniqueProperties.push({
      objectApiName: apiName,
      internalName: property.name,
      unique: unique ? 'TRUE' : 'FALSE',
    });
  }
}

// The account says what it is; this collector does not.
//
// `portalName` used to read "HubSpot developer test portal <id>" whatever the
// credential pointed at. That is an assertion about somebody's account made by
// the tool that is supposed to be recording it, and it was wrong in practice:
// `qualification/evidence/hs-property-export.json` records portal 51050101 with
// `accountType` STANDARD. A supplement is evidence about one instance, so the
// type comes out of the response.
//
// Where the response carries no `accountType`, the supplement says so rather
// than picking one — the schema needs a non-empty name, not a confident one.
const account = hs('GET', '/account-info/v3/details');
const accountType = String(account.accountType ?? '');
const supplement = {
  artifactKind: 'HUBSPOT_TARGET_SUPPLEMENT',
  supplementVersion: '1',
  portalId: String(account.portalId),
  portalName: `HubSpot portal ${String(account.portalId)}, accountType ${accountType === '' ? 'not stated by GET /account-info/v3/details' : accountType}`,
  capturedAt,
  statedBy: 'kauro qualification collector, from GET /crm/v3/properties/{object} on the portal named above',
  uniqueProperties,
};
writeFileSync(join(resolve(outDir), 'hubspot-supplement.json'), `${JSON.stringify(supplement, null, 2)}\n`);

/**
 * What this capture is, so the runner does not have to guess.
 *
 * The runner used to know the file names because there was one shape of
 * capture. There are two now, and a runner that inferred the shape from which
 * files happened to be present would read a half-written capture as an API one.
 * The manifest is written last, after every artifact, so its presence is also
 * the statement that the capture finished.
 *
 * The portal id is here as well as in the supplement, and deliberately: a
 * reader that has to open the supplement to find out which portal a directory
 * describes will eventually not bother.
 */
// ---------------------------------------------------------------- access grant
//
// Captured after the properties, from the same credential in the same run, and
// compared against the portal the properties came from before anything is
// written: a grant answered by another portal is not this capture's grant.
const grant = accessGrant();
if (grant.hubId !== String(account.portalId)) {
  throw new Error(
    `the token-information endpoint answered for portal ${grant.hubId} and GET /account-info/v3/details named ${String(account.portalId)}; one credential cannot speak for two portals`,
  );
}
const accessGrantArtifact = {
  artifactKind: 'HUBSPOT_ACCESS_GRANT',
  accessGrantVersion: '1',
  portalId: grant.hubId,
  appId: grant.appId,
  capturedAt,
  statedBy: 'HubSpot POST /oauth/v2/private-apps/get/access-token-info, answered for the private-app token this capture authenticated with',
  scopes: grant.scopes,
};
writeFileSync(join(resolve(outDir), 'access-grant.json'), `${JSON.stringify(accessGrantArtifact, null, 2)}\n`);

const captureManifest = {
  artifactKind: 'HUBSPOT_CAPTURE_MANIFEST',
  // Version 2: the manifest names an access grant. A version-1 capture is still
  // read by the runners; its contract states UNKNOWN object flags and the engine
  // refuses to write against it.
  captureVersion: '2',
  route,
  portalId: String(account.portalId),
  accountType: accountType === '' ? null : accountType,
  capturedAt,
  supplement: 'hubspot-supplement.json',
  accessGrant: 'access-grant.json',
  pipelines: 'pipelines.csv',
  propertyExports: route === 'EXPORT' ? EXPORT_FILES : [],
  propertyApiCaptures: apiCaptures.map((capture) => ({
    path: capture.path,
    endpoint: capture.endpoint,
    objectApiName: capture.objectApiName,
    objectLabel: capture.objectLabel,
    properties: capture.properties,
    // Where the portal id came from, because the properties response carries
    // none and a contract has already been built against the wrong portal once.
    portalIdSource: 'GET /account-info/v3/details on the same credential, in this run',
  })),
};
writeFileSync(join(resolve(outDir), 'capture-manifest.json'), `${JSON.stringify(captureManifest, null, 2)}\n`);

process.stdout.write(`route ${route}\n`);
process.stdout.write(`portal ${supplement.portalId} (${accountType === '' ? 'account type not stated' : accountType})\n`);
process.stdout.write(`pipelines.csv: ${String(pipelineRows.length)} rows\n`);
process.stdout.write(`access-grant.json: app ${grant.appId}, ${String(grant.scopes.length)} scopes, write: ${grant.scopes.filter((scope) => scope.endsWith('.write')).join(', ') || 'none'}\n`);
if (route === 'EXPORT') {
  process.stdout.write(`supplement: ${String(uniqueProperties.length)} uniqueness statements\n`);
  process.stdout.write(`unique properties in the portal: ${uniquenessSeen.join(', ') || 'none'}\n`);
  process.stdout.write(`api properties the export does not carry, so not stated: ${String(notExported.length)}\n`);
  for (const file of EXPORT_FILES) {
    const bytes = readFileSync(join(resolve(outDir), file));
    process.stdout.write(`${file}: ${String(bytes.length)} bytes\n`);
  }
} else {
  // No uniqueness statements on this route, and that is the improvement rather
  // than a gap: the portal states uniqueness in the capture itself, so the
  // supplement has nothing left to assert about it.
  process.stdout.write('supplement: 0 uniqueness statements — the capture carries hasUniqueValue itself\n');
  for (const capture of apiCaptures) {
    const bytes = readFileSync(join(resolve(outDir), capture.path));
    process.stdout.write(
      `${capture.path}: ${String(capture.properties)} properties, ${String(bytes.length)} bytes\n`,
    );
  }
}

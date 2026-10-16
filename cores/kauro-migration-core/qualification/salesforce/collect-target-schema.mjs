#!/usr/bin/env node
// Salesforce target-schema collector.
//
// The agency runs this on their own machine, against their own org, with the
// official Salesforce CLI they authenticated themselves. Kauro never holds an
// OAuth credential, never calls Salesforce, and never sees a token. What
// crosses the boundary is a bundle of describe output and a manifest of its
// hashes.
//
// Everything this writes is inspected as hostile input on the way back in, so
// the collector's job is not to be trusted — it is to make an honest bundle easy
// to produce. The reader refuses anything it disagrees with.
//
// Secrets: as of Salesforce CLI v2.136.8 (27 May 2026) access tokens, passwords
// and SFDX auth URLs are already removed from the output of `org display`,
// `org list` and the login commands. This collector still scans every byte it is
// about to write and refuses rather than redacts, because an older CLI, a manual
// edit, or SF_TEMP_SHOW_SECRETS=true can put one back, and a bundle that once
// held a token should not be repaired and shipped — it should be rebuilt.
//
// Usage:
//   node collect-target-schema.mjs --org <alias-or-username> --out <directory>
//        --captured-at <ISO-8601 UTC instant> --captured-by <who ran this> [--with-ocr]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const COLLECTOR_VERSION = '1.1.0';

// The one string that says what layout this produces. Imported rather than
// retyped: the collector and the reader disagreeing about the bundle format is
// exactly the drift that made every bundle this tool wrote unreadable.
const { SALESFORCE_BUNDLE_FORMAT } = await import('../../dist/src/target/salesforce-bundle.js');

/** The objects the V1 support envelope covers. OpportunityContactRole is separate and only collected on request. */
const OBJECTS = ['Account', 'Contact', 'Lead', 'Opportunity'];
const OCR_OBJECT = 'OpportunityContactRole';

/**
 * Anything matching these is a credential, and its presence means the bundle is
 * not safe to hand over. The patterns are deliberately broad: a false refusal
 * costs one re-run, and a missed token is somebody's whole org.
 */
const SECRET_PATTERNS = [
  { name: 'sfdxAuthUrl', pattern: /force:\/\/[^\s"']+/i },
  { name: 'sfdxAuthUrl key', pattern: /"sfdxAuthUrl"\s*:/i },
  { name: 'accessToken', pattern: /"accessToken"\s*:\s*"(?!\[REDACTED)[^"]{12,}"/i },
  { name: 'refreshToken', pattern: /"refreshToken"\s*:\s*"(?!\[REDACTED)[^"]{12,}"/i },
  { name: 'clientSecret', pattern: /"clientSecret"\s*:\s*"(?!\[REDACTED)[^"]{6,}"/i },
  { name: 'password', pattern: /"password"\s*:\s*"(?!\[REDACTED)[^"]{4,}"/i },
  { name: 'sessionId', pattern: /"sessionId"\s*:\s*"(?!\[REDACTED)[^"]{12,}"/i },
  { name: 'OAuth session token', pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{20,}/ },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function fail(message, remedy) {
  process.stderr.write(`\ncollector refused: ${message}\n\n${remedy}\n\n`);
  process.exit(1);
}

/** Refuse rather than redact. A bundle that held a secret is rebuilt, not repaired. */
function assertNoSecrets(text, where) {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      // The value itself is never printed. Naming it would put it in a terminal
      // scrollback, a CI log, or a support ticket.
      fail(
        `${where} contains something that looks like a ${name}.`,
        [
          'Treat that credential as disclosed and rotate it before doing anything else.',
          '',
          'Nothing was written. Then update the Salesforce CLI to a current version — v2.136.8 and',
          'later keep tokens, passwords and SFDX auth URLs out of their own output — make sure',
          'SF_TEMP_SHOW_SECRETS is not set, and run the collector again.',
          '',
          'Do not edit the value out of the file and re-send it. A bundle that held a credential is',
          'rebuilt, not repaired.',
        ].join('\n'),
      );
    }
  }
}

function sf(args, where) {
  const result = spawnSync('sf', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.error !== undefined && result.error.code === 'ENOENT') {
    fail(
      'the Salesforce CLI ("sf") is not on the PATH.',
      'Install it from https://developer.salesforce.com/tools/salesforcecli and run "sf --version" to confirm, then run the collector again.',
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n').slice(-3).join(' ');
    fail(`"sf ${args.join(' ')}" failed while ${where}.\n  ${detail}`, 'Check that you are logged in to the org ("sf org login web") and that the alias is right.');
  }
  const text = result.stdout ?? '';
  assertNoSecrets(text, `the output of "sf ${args.slice(0, 3).join(' ')}"`);
  return text;
}

/**
 * The describe payload, unwrapped.
 *
 * With --json the CLI wraps every result as { status, result, warnings }. The
 * reader on the other side accepts both shapes, but the bundle is written in one
 * of them so that two bundles from the same org are the same bytes.
 */
function unwrap(text, where) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`the output of ${where} is not JSON.`, 'Run the command by hand to see what it printed.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`the output of ${where} is not a JSON object.`, 'Run the command by hand to see what it printed.');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'result') && Object.prototype.hasOwnProperty.call(parsed, 'status')) {
    if (parsed.status !== 0) {
      fail(`${where} reported status ${String(parsed.status)}.`, 'Run the command by hand to see the error.');
    }
    return parsed.result;
  }
  return parsed;
}

/** Keys the bundle never carries, whatever the CLI decides to add later. */
const DROP_KEYS = new Set([
  'accessToken',
  'refreshToken',
  'sfdxAuthUrl',
  'clientSecret',
  'password',
  'sessionId',
  'privateKey',
  'privateKeyFile',
]);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (DROP_KEYS.has(key)) continue;
    out[key] = scrub(value[key]);
  }
  return out;
}

/** Sorted keys and a trailing newline, so the same org twice is the same bytes. */
function canonical(value) {
  return `${JSON.stringify(scrub(value), null, 2)}\n`;
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// ------------------------------------------------------------------------ run

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

const org = flag('--org');
const out = flag('--out') ?? 'salesforce-target-bundle';
const withOcr = args.includes('--with-ocr');
// Stated, never guessed. The reader's whole account of `capturedAt` is that it
// is when the agency exported, as the agency says it -- not when this ran -- so
// that a bundle rebuilt from the same org twice is the same bytes.
const capturedAt = flag('--captured-at');
const capturedBy = flag('--captured-by');

if (org === null || capturedAt === null || capturedBy === null) {
  process.stderr.write(
    'usage: node collect-target-schema.mjs --org <alias-or-username> --out <directory>\n' +
      '       --captured-at <ISO-8601 UTC instant> --captured-by <who ran this> [--with-ocr]\n',
  );
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(capturedAt)) {
  fail(
    `--captured-at "${capturedAt}" is not an ISO-8601 instant in UTC to the second.`,
    'Pass the moment the export was taken, for example 2026-09-06T04:12:00Z.',
  );
}

const version = spawnSync('sf', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (version.status !== 0) {
  fail('could not run "sf --version".', 'Install the Salesforce CLI and make sure "sf" is on your PATH.');
}
const cliVersion = (version.stdout ?? '').trim().split('\n')[0] ?? 'unknown';
// The reader wants a three-part version and nothing else; the CLI reports
// `@salesforce/cli/2.149.9 win32-x64 node-v24.14.1`. Refusing here rather than
// writing something the reader will reject: a bundle that fails to open on the
// far side costs a round trip with an agency.
const cliSemver = (cliVersion.match(/\b(\d+\.\d+\.\d+)\b/u) ?? [])[1] ?? null;
if (cliSemver === null) {
  fail(
    `the Salesforce CLI reported its version as "${cliVersion}", which carries no three-part version number.`,
    'Update the Salesforce CLI, or run "sf --version" and check what it prints.',
  );
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'describe'), { recursive: true });

const files = [];
const write = (relativePath, text) => {
  assertNoSecrets(text, relativePath);
  const target = join(out, ...relativePath.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, Buffer.from(text, 'utf8'));
  files.push({ path: relativePath, sha256: sha256(text), byteLength: Buffer.byteLength(text, 'utf8') });
};

// Org identity. orgId, instanceUrl and username are not secrets and are still
// returned by a current CLI; the access token is redacted by the CLI itself and
// dropped again here.
const display = unwrap(sf(['org', 'display', '--target-org', org, '--json'], 'reading the org identity'), 'sf org display');
write(
  'org-summary.json',
  canonical({
    orgId: display.id ?? display.orgId ?? null,
    instanceUrl: display.instanceUrl ?? null,
    username: display.username ?? null,
    alias: display.alias ?? null,
    apiVersion: display.apiVersion ?? null,
  }),
);

const collected = [...OBJECTS, ...(withOcr ? [OCR_OBJECT] : [])];
for (const object of collected) {
  const text = sf(['sobject', 'describe', '--sobject', object, '--target-org', org, '--json'], `describing ${object}`);
  const described = unwrap(text, `sf sobject describe --sobject ${object}`);
  if (described === null || typeof described !== 'object' || !Array.isArray(described.fields)) {
    fail(
      `the describe for ${object} carried no fields array.`,
      'Run "sf sobject describe --sobject ' + object + ' --target-org ' + org + '" by hand and check the output. A describe run by a user without read access to the object returns nothing useful.',
    );
  }
  write(`describe/${object}.json`, canonical(described));
  process.stdout.write(`  described ${object.padEnd(24)} ${String(described.fields.length).padStart(4)} fields\n`);
}

// The attestation and the manifest, in the shapes the reader actually reads.
//
// This collector used to write one file, `target-attestation.json`, in a shape
// of its own: a collector version, a note about where to put `capturedAt`, an
// object list, and every file's hash. The reader wants two files -- an
// `attestation.json` of exactly `capturedAt`, `capturedBy` and `cliVersion`, and
// a `manifest.json` declaring the closed file set with a kind on each entry --
// and it refuses a bundle carrying neither.
//
// So the documented collector produced a bundle the engine would not open, and
// had done since both were written. The recorded PASS for SF-TARGET-01 names a
// `manifest.json` that nothing here ever wrote, which means a person assembled
// it by hand: an owner action, undocumented, in the middle of a gate that is
// supposed to need none. Both files are written here now, from the same run,
// and the format string comes from the reader rather than being retyped.
//
// `capturedAt` and `capturedBy` are still not read from a clock, and are still
// the capturer's statement rather than this tool's guess -- a bundle rebuilt
// from the same org twice has to be the same bytes. They are required flags
// instead, so a bundle cannot be produced without somebody saying when it was
// taken and by whom.
const attestationText = `${JSON.stringify({ capturedAt, capturedBy, cliVersion: cliSemver }, null, 2)}\n`;
write('attestation.json', attestationText);

const manifest = {
  bundleFormat: SALESFORCE_BUNDLE_FORMAT,
  files: [
    { path: 'attestation.json', kind: 'SALESFORCE_ATTESTATION' },
    { path: 'org-summary.json', kind: 'SALESFORCE_ORG_SUMMARY' },
    ...collected.map((object) => ({ path: `describe/${object}.json`, kind: 'SALESFORCE_DESCRIBE', sobject: object })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
};
// The manifest declares every other file and is not a member of its own set, so
// it is written directly rather than through `write`, which would add it to the
// list it is describing.
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
assertNoSecrets(manifestText, 'manifest.json');
writeFileSync(join(out, 'manifest.json'), Buffer.from(manifestText, 'utf8'));

// One last sweep over every byte that is now on disk, including the attestation.
for (const entry of readdirSync(out, { recursive: true, withFileTypes: true })) {
  const path = join(entry.parentPath ?? entry.path ?? out, entry.name);
  if (!statSync(path).isFile()) continue;
  assertNoSecrets(readFileSync(path, 'utf8'), relative(out, path).split(sep).join('/'));
}

process.stdout.write(
  `\nwrote ${String(files.length + 1)} files to ${out}\n` +
    `CLI: ${cliVersion}\n` +
    'No credential of any kind was written. Send the whole directory as it is; do not edit it.\n',
);

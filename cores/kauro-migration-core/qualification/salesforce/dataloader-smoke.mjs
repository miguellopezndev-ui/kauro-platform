#!/usr/bin/env node
// Early host smoke for the headless Data Loader path. Not a gate: it answers,
// before any campaign spends anything, whether the launcher can authenticate
// with the integration's access token, act as the right principal in the right
// org, load one synthetic record through Data Loader's own engine, and refuse
// an invalid token and a broken configuration without ever reaching a browser.
//
//   node qualification/salesforce/dataloader-smoke.mjs --auth <dir> --out <dir>
//
// Writes <out>/smoke.json. Vendor writes: one Account insert, one delete.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileLauncher, forward, javaVersions, jarPath, mintSession, parseStatusCsv, runLauncher } from './dataloader-headless.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) {
    process.stderr.write('usage: node dataloader-smoke.mjs --auth <dir> --out <dir>\n');
    process.exit(64);
  }
  return process.argv[index + 1];
};
const authDir = resolve(argument('--auth'));
const outDir = resolve(argument('--out'));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const allow = JSON.parse(readFileSync(join(here, '..', 'authorized-instances.json'), 'utf8'));
const authorisedOrgIds = new Set(allow.salesforce.map((entry) => entry.orgId));

function sf(method, path, body) {
  const args = [forward(join(authDir, 'sf.sh')), method, path];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = execFileSync('bash', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = Number((out.match(/__HTTP_STATUS__:(\d+)/u) ?? [])[1] ?? 0);
  const text = out.split('\n__HTTP_STATUS__')[0];
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status, json, text };
}

const checks = [];
const check = (id, ok, detail) => {
  checks.push({ id, ok, detail: detail ?? null });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}\n`);
};

const campaign = `smoke-${new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '')}`;
process.stdout.write(`Data Loader headless smoke ${campaign}\n`);

// ---- identity by observation, before anything else ----
const session = mintSession(authDir);
const who = sf('GET', '/services/oauth2/userinfo');
const orgId = who.json?.organization_id ?? null;
const userId = who.json?.user_id ?? null;
check('identity.userinfo', who.status === 200 && typeof orgId === 'string', `HTTP ${String(who.status)}`);
check('identity.orgAuthorised', authorisedOrgIds.has(orgId), `org ${String(orgId)}`);
if (!authorisedOrgIds.has(orgId)) {
  process.stderr.write('REFUSED: the credential does not point at an authorised org\n');
  process.exit(1);
}
const org = sf('GET', '/services/data/v67.0/query?q=SELECT+Id,OrganizationType,IsSandbox+FROM+Organization');
check('identity.organizationRecord', org.json?.records?.[0]?.Id === orgId, JSON.stringify(org.json?.records?.[0] ?? null));

// ---- the launcher ----
const jar = jarPath(authDir);
const compiled = compileLauncher({ jar, classesDir: join(outDir, 'classes') });
check('launcher.compiled', true, `source ${compiled.launcherSourceSha256.slice(0, 16)} jar ${compiled.jarSha256.slice(0, 16)}`);

const common = { jar, classesDir: compiled.classesDir, expectedOrgId: orgId, expectedUserId: userId };
const csv = join(outDir, 'in.csv');
const name = `KQ ${campaign} smoke account`;
writeFileSync(csv, `Name\n${name}\n`);

// S1: valid token, real mapping, minimal synthetic insert.
const s1 = runLauncher({ ...common, runDir: join(outDir, 'S1-valid'), entity: 'Account', operation: 'insert', inputCsv: csv, mapping: [['Name', 'Name']], session });
const s1Rows = parseStatusCsv(s1.success);
const createdId = s1Rows[0]?.ID ?? null;
check('S1.exitClassOk', s1.exitClass === 'OK' && s1.status === 0, `${s1.exitClass} status=${String(s1.status)} ${s1.report?.error ?? ''}`);
check('S1.identityMatches', s1.report?.orgId === orgId && s1.report?.userId === userId, `${String(s1.report?.orgId)} ${String(s1.report?.userId)} ${String(s1.report?.userName)}`);
check('S1.successFileHasOneRow', s1Rows.length === 1 && typeof createdId === 'string' && createdId.length >= 15, `rows=${String(s1Rows.length)}`);
check('S1.errorFileEmpty', parseStatusCsv(s1.error).length === 0);
check('S1.noBrowserFlow', s1.browserFlowEntered === false && s1.report?.lastOAuthFlowAfter === '', JSON.stringify(s1.browserMarkersInLog));
check('S1.noTokenLeak', s1.tokenLeaks.length === 0, JSON.stringify(s1.tokenLeaks));

// Read back, then remove exactly what was created.
let readBack = { status: 0 };
let deleted = { status: 0 };
let readBackAfter = { status: 0 };
if (createdId !== null) {
  readBack = sf('GET', `/services/data/v67.0/sobjects/Account/${createdId}`);
  check('S1.readBack', readBack.status === 200 && readBack.json?.Name === name, `HTTP ${String(readBack.status)}`);
  deleted = sf('DELETE', `/services/data/v67.0/sobjects/Account/${createdId}`);
  check('S1.cleanupExactId', deleted.status === 204, `HTTP ${String(deleted.status)}`);
  readBackAfter = sf('GET', `/services/data/v67.0/sobjects/Account/${createdId}`);
  check('S1.readBackAfterCleanup', readBackAfter.status === 404, `HTTP ${String(readBackAfter.status)}`);
}

// S2: an invalid token must be refused structurally, without a browser.
const s2 = runLauncher({ ...common, runDir: join(outDir, 'S2-invalid-token'), entity: 'Account', operation: 'insert', inputCsv: csv, mapping: [['Name', 'Name']], session: { accessToken: `00D000000000000!invalid.${campaign}`, instanceUrl: session.instanceUrl } });
check('S2.authInvalid', s2.exitClass === 'AUTH_INVALID' && s2.status === 10, `${s2.exitClass} status=${String(s2.status)} ${s2.report?.error ?? ''}`);
check('S2.noBrowserFlow', s2.browserFlowEntered === false, JSON.stringify(s2.browserMarkersInLog));
check('S2.nothingWritten', s2.success === null || parseStatusCsv(s2.success).length === 0);

// S3: a configuration error (mapping file missing) must be refused before login.
const s3 = runLauncher({ ...common, runDir: join(outDir, 'S3-config-error'), entity: 'Account', operation: 'insert', inputCsv: csv, mapping: [['Name', 'Name']], session });
rmSync(join(outDir, 'S3-config-error', 'conf', 'insert-Account.sdl'), { force: true });
const s3b = (() => {
  // Re-run with the mapping removed after writing: the launcher validates the
  // spec before reading stdin, so the token is never used.
  const dir = join(outDir, 'S3-config-error-b');
  const result = runLauncher({ ...common, runDir: dir, entity: 'Account', operation: 'insert', inputCsv: join(outDir, 'does-not-exist.csv'), mapping: [['Name', 'Name']], session });
  return result;
})();
check('S3.configError', s3b.exitClass === 'CONFIG_ERROR' && s3b.status === 12, `${s3b.exitClass} status=${String(s3b.status)} ${s3b.report?.error ?? ''}`);
check('S3.noBrowserFlow', s3b.browserFlowEntered === false && s3.browserFlowEntered === false);
check('S3.noTokenLeak', s3b.tokenLeaks.length === 0 && s3.tokenLeaks.length === 0);

const failures = checks.filter((entry) => !entry.ok);
const smoke = {
  artifactKind: 'KAURO_DATALOADER_HEADLESS_SMOKE',
  campaign,
  observedAt: new Date().toISOString().slice(0, 19) + 'Z',
  orgId,
  userId,
  dataLoaderVersion: '67.0.0',
  jarSha256: compiled.jarSha256,
  launcherSourceSha256: compiled.launcherSourceSha256,
  java: javaVersions(),
  runs: {
    S1: { exitClass: s1.exitClass, status: s1.status, wallMs: s1.wallMs, browserFlowEntered: s1.browserFlowEntered, tokenLeaks: s1.tokenLeaks, report: s1.report, createdId, cleanup: { deleteStatus: deleted.status, readBackAfter: readBackAfter.status } },
    S2: { exitClass: s2.exitClass, status: s2.status, wallMs: s2.wallMs, browserFlowEntered: s2.browserFlowEntered, tokenLeaks: s2.tokenLeaks, report: s2.report },
    S3: { exitClass: s3b.exitClass, status: s3b.status, wallMs: s3b.wallMs, browserFlowEntered: s3b.browserFlowEntered, tokenLeaks: s3b.tokenLeaks, report: s3b.report },
  },
  checks,
  failures: failures.map((entry) => entry.id),
  result: failures.length === 0 ? 'PASS' : 'FAIL',
  vendorWrites: { inserts: createdId === null ? 0 : 1, deletes: deleted.status === 204 ? 1 : 0 },
  browserOpenings: 0,
};
writeFileSync(join(outDir, 'smoke.json'), `${JSON.stringify(smoke, null, 2)}\n`);
process.stdout.write(`result = ${smoke.result} (${String(checks.length)} checks, ${String(failures.length)} failures)\n`);
if (failures.length > 0) process.exitCode = 1;

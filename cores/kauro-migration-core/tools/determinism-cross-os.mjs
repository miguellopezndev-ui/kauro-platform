#!/usr/bin/env node
/**
 * S034 across operating systems: the same subject on Windows and on Linux, with a
 * different time zone and a different locale, gives the same package.
 *
 * `test/property/invariants.test.ts` ([S034]) proves the half that needs one host:
 * child processes with another TZ, LANG and LC_ALL, and every chunk size. What it
 * cannot prove is that a second operating system agrees, and the registry case asks
 * for exactly that, on the exact subject. This tool is the evidence stage's half:
 *
 *   node tools/determinism-cross-os.mjs --probe --out <probe.json> [--tz <zone>] [--lang <locale>]
 *       run the fixed subject here, in the named environment, and write what came out
 *   node tools/determinism-cross-os.mjs --compare <a.json> <b.json> --out <evidence.json>
 *       compare two probes and write qualification/evidence/determinism-cross-os.json
 *   node tools/determinism-cross-os.mjs --run [--distro <name>] [--out <evidence.json>]
 *       a Windows probe and a WSL probe of this same checkout (the WSL one runs the
 *       same built files under Linux Node), then the comparison
 *
 * What is compared is the canonical artifacts: every file of the package, by path and
 * digest. What is recorded beside them and never compared is the variable metadata:
 * operating system, architecture, Node, tzdata, ICU, the TZ and locale in force, and
 * the host's name as a digest. The subject is named by the commit and by a digest of
 * the built engine with line endings normalised, because a Windows `tsc` writes CRLF.
 * The two probes must differ in TZ and in locale, or the comparison is refused: a
 * comparison of two identical environments proves nothing about either.
 *
 * It runs in the evidence stage after the seal, not inside `npm test`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DETERMINISM_GATE = 'DETERMINISM-CROSS-OS-01';
export const DETERMINISM_EVIDENCE_PATH = 'qualification/evidence/determinism-cross-os.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nowUtc = () => `${new Date().toISOString().slice(0, 19)}Z`;

/** Names that sort differently in different locales, a multi-line cell, a quoted comma, a date. */
function subjectFiles() {
  const rows = [
    ['a1', 'Zoe', 'zoe@example.com', '2026-03-01', 'plain'],
    ['B2', 'Äda', 'ada@example.com', '2026-03-02', 'two\nlines'],
    ['ä3', 'Émile', 'emile@example.com', '2026-03-03', 'a, "quoted" comma'],
    ['Z4', 'Zoë', 'zoe2@example.com', '2026-03-04', 'İstanbul'],
    ['é5', 'Eve', 'eve@example.com', '2026-03-05', 'i̇ dotted'],
    ['e6', 'Ida', 'ida@example.com', '2026-03-06', 'Straße'],
    ['ss7', 'Ivo', 'ivo@example.com', '2026-03-07', 'STRASSE'],
  ];
  const quote = (value) => (/[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const csv = `${['Contact ID', 'First Name', 'Email', 'Signed Up', 'Notes'].join(',')}\n${rows.map((row) => row.map(quote).join(',')).join('\n')}\n`;
  const field = (header, destinationField, semanticType) => ({ column: { header }, destinationField, semanticType });
  const config = {
    configVersion: '3.0.0',
    source: { system: 'generic_csv', namespace: 'cross-os' },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [{ id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: { header: 'Contact ID' }, fields: [field('First Name', 'contact.firstName', 'TEXT'), field('Email', 'contact.email', 'EMAIL'), field('Signed Up', 'contact.createdAt', 'DATE'), field('Notes', 'contact.description', 'TEXT')] }],
  };
  return { csv, config: `${JSON.stringify(config, null, 2)}\n` };
}

function walk(directory) {
  const found = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else found.push(path);
    }
  };
  visit('');
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The built engine, with CRLF read as LF: the same commit built on Windows and on Linux is one subject. */
function engineDigest() {
  const root = join(repoRoot, 'dist', 'src');
  const lines = walk(root).map((path) => `${path} ${sha256(Buffer.from(readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n'), 'utf8'))}`);
  return sha256(`${lines.join('\n')}\n`);
}

function git(...args) {
  const run = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

export function probe({ tz, lang, commit = null, clean = null }) {
  const work = mkdtempSync(join(tmpdir(), 'kauro-cross-os-'));
  try {
    const input = join(work, 'input');
    mkdirSync(input, { recursive: true });
    const { csv, config } = subjectFiles();
    writeFileSync(join(input, 'contacts.csv'), csv, 'utf8');
    writeFileSync(join(work, 'config.json'), config, 'utf8');
    const out = join(work, 'package');
    const env = { ...process.env, ...(tz === null ? {} : { TZ: tz }), ...(lang === null ? {} : { LANG: lang, LC_ALL: lang }) };
    const run = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli', 'main.js'), 'run', '--input', input, '--config', join(work, 'config.json'), '--out', out, '--force'], { cwd: repoRoot, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`the run exited ${String(run.status)}: ${String(run.stdout)}${String(run.stderr)}`.slice(0, 600));
    // What the environment actually resolved to, asked of a process that has it. Windows
    // Node ignores TZ, LANG and LC_ALL and answers with the system's settings; saying so
    // here is what stops two Windows runs passing as two environments.
    const resolved = JSON.parse(spawnSync(process.execPath, ['-e', 'const o = Intl.DateTimeFormat().resolvedOptions(); process.stdout.write(JSON.stringify([o.timeZone, o.locale]));'], { encoding: 'utf8', env }).stdout);
    const artifacts = walk(out).map((path) => ({ path, sha256: sha256(readFileSync(join(out, path))) }));
    const digestText = `kauro-package-digest/1\n${artifacts.map((entry) => `${entry.path} ${entry.sha256}\n`).join('')}`;
    return {
      gate: DETERMINISM_GATE,
      probe: true,
      // Git may not be usable from where a probe runs (git refuses a Windows-owned tree from WSL).
      // The driver then names the commit and cleanliness of the one checkout both probes read, and
      // the record says who said so.
      subject: (() => {
        const own = git('rev-parse', 'HEAD');
        return own !== null
          ? { commit: own, clean: git('status', '--porcelain') === '', statedBy: 'PROBE', engineDigest: engineDigest() }
          : { commit, clean, statedBy: commit === null ? 'NOBODY' : 'DRIVER', engineDigest: engineDigest() };
      })(),
      canonical: { packageDigest: sha256(digestText), artifacts },
      // Recorded, never compared.
      variable: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        tzdata: process.versions.tz ?? null,
        icu: process.versions.icu ?? null,
        tz: env.TZ ?? null,
        lang: env.LANG ?? null,
        lcAll: env.LC_ALL ?? null,
        resolvedTimeZone: resolved[0],
        resolvedLocale: resolved[1],
        hostSha256: sha256(hostname()),
        observedAt: nowUtc(),
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function compare(a, b) {
  const problems = [];
  const checks = [];
  const check = (id, ok, expected, observed) => {
    checks.push({ id, ok, expected, observed });
    if (!ok) problems.push(`${id}: ${observed}`);
  };
  check('probes.differInOperatingSystem', a.variable.platform !== b.variable.platform, 'the two probes ran on different operating systems', `${a.variable.platform} and ${b.variable.platform}`);
  check('probes.differInTimeZone', a.variable.resolvedTimeZone !== b.variable.resolvedTimeZone, 'the two probes ran in different time zones', `${a.variable.resolvedTimeZone} and ${b.variable.resolvedTimeZone}`);
  check('probes.differInLocale', a.variable.resolvedLocale !== b.variable.resolvedLocale, 'the two probes ran in different locales', `${a.variable.resolvedLocale} and ${b.variable.resolvedLocale}`);
  check('subject.sameCommit', a.subject.commit !== null && a.subject.commit === b.subject.commit, 'both probes ran the same commit', `${String(a.subject.commit)} and ${String(b.subject.commit)}`);
  check('subject.clean', a.subject.clean === true && b.subject.clean === true, 'the checkout was clean for both', `${String(a.subject.clean)} and ${String(b.subject.clean)}`);
  check('subject.sameEngine', a.subject.engineDigest === b.subject.engineDigest, 'both probes ran the same built engine (line endings normalised)', `${a.subject.engineDigest.slice(0, 16)} and ${b.subject.engineDigest.slice(0, 16)}`);
  const left = new Map(a.canonical.artifacts.map((entry) => [entry.path, entry.sha256]));
  const right = new Map(b.canonical.artifacts.map((entry) => [entry.path, entry.sha256]));
  const differing = [...new Set([...left.keys(), ...right.keys()])].filter((path) => left.get(path) !== right.get(path)).sort();
  check('canonical.sameArtifacts', differing.length === 0 && left.size > 0, 'every artifact has the same path and digest on both', differing.length === 0 ? `${String(left.size)} artifacts equal` : `differ: ${differing.slice(0, 5).join(', ')}`);
  check('canonical.samePackageDigest', a.canonical.packageDigest === b.canonical.packageDigest, 'the canonical package digest is equal', `${a.canonical.packageDigest.slice(0, 16)} and ${b.canonical.packageDigest.slice(0, 16)}`);
  return {
    gate: DETERMINISM_GATE,
    observedAt: nowUtc(),
    subject: a.subject,
    canonical: { packageDigest: a.canonical.packageDigest, artifactCount: left.size },
    // Kept apart from the canonical claim on purpose.
    variableMetadata: { a: a.variable, b: b.variable },
    checks,
    problems,
    result: problems.length === 0 ? 'PASS' : 'FAIL',
  };
}

function readProbe(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.gate !== DETERMINISM_GATE || parsed.probe !== true) throw new Error(`${path} is not a probe of ${DETERMINISM_GATE}`);
  return parsed;
}

function toWslPath(path) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(path);
  return match === null ? path : `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : args[at + 1] ?? null;
  };
  const write = (path, value) => {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    if (args.includes('--probe')) {
      const out = valueOf('--out');
      if (out === null) throw new Error('--probe needs --out <probe.json>');
      write(out, probe({ tz: valueOf('--tz'), lang: valueOf('--lang'), commit: valueOf('--commit'), clean: valueOf('--clean') === null ? null : valueOf('--clean') === 'true' }));
      process.stdout.write(`probe written to ${resolve(out)}\n`);
    } else if (args.includes('--compare')) {
      const at = args.indexOf('--compare');
      const a = args[at + 1];
      const b = args[at + 2];
      const out = valueOf('--out') ?? DETERMINISM_EVIDENCE_PATH;
      if (a === undefined || b === undefined) throw new Error('--compare needs two probe files');
      const evidence = compare(readProbe(a), readProbe(b));
      write(resolve(repoRoot, out), evidence);
      process.stdout.write(`${DETERMINISM_GATE} = ${evidence.result}${evidence.problems.length === 0 ? '' : `: ${evidence.problems.join('; ')}`}\n`);
      process.exit(evidence.result === 'PASS' ? 0 : 1);
    } else if (args.includes('--run')) {
      const distro = valueOf('--distro');
      const out = valueOf('--out') ?? DETERMINISM_EVIDENCE_PATH;
      mkdirSync(join(repoRoot, 'tmp'), { recursive: true });
      const work = mkdtempSync(join(repoRoot, 'tmp', 'cross-os-'));
      try {
        const windows = join(work, 'windows.json');
        const linux = join(work, 'linux.json');
        const native = spawnSync(process.execPath, [join(repoRoot, 'tools', 'determinism-cross-os.mjs'), '--probe', '--out', windows, '--tz', 'America/Los_Angeles', '--lang', 'en_US.UTF-8'], { encoding: 'utf8' });
        if (native.status !== 0) throw new Error(`the native probe failed: ${String(native.stderr).slice(-400)}`);
        const wsl = spawnSync('wsl.exe', [...(distro === null ? [] : ['-d', distro]), '--', 'node', toWslPath(join(repoRoot, 'tools', 'determinism-cross-os.mjs')), '--probe', '--out', toWslPath(linux), '--tz', 'Asia/Kolkata', '--lang', 'de_DE.UTF-8', '--commit', String(git('rev-parse', 'HEAD')), '--clean', String(git('status', '--porcelain') === '')], { encoding: 'utf8' });
        if (wsl.status !== 0) throw new Error(`the WSL probe failed: ${String(wsl.stderr).slice(-400)}`);
        const evidence = compare(readProbe(windows), readProbe(linux));
        write(resolve(repoRoot, out), evidence);
        process.stdout.write(`${DETERMINISM_GATE} = ${evidence.result}${evidence.problems.length === 0 ? '' : `: ${evidence.problems.join('; ')}`}\n`);
        process.exit(evidence.result === 'PASS' ? 0 : 1);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    } else {
      process.stderr.write('usage: node tools/determinism-cross-os.mjs (--probe --out <f> [--tz z] [--lang l] | --compare <a> <b> [--out <f>] | --run [--distro <name>] [--out <f>])\n');
      process.exit(64);
    }
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n`);
    process.exit(1);
  }
}


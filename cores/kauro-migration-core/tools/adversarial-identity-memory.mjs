#!/usr/bin/env node
/**
 * O18A: the identity, duplicate and memory campaign 3.1.0 owes.
 *
 * 3.1.0 makes the person signals (email, phone, full name) read a Lead as they
 * read a Contact (D78). Before it, leads never reached the duplicate clusters at
 * all, so a lead-heavy export could not get near the declared identity group
 * limit through them; now one shared mailbox on a web-form export is one bucket.
 * Nothing in `test/` reaches `IDENTITY_GROUP_TOO_LARGE`, because doing so takes a
 * quarter of a million rows, so this runs the cases that matter at their real
 * scale, each in its own process under the qualification heap, and records the
 * outcome, the peak resident memory and the CPU time of every one.
 *
 *   node tools/adversarial-identity-memory.mjs [--out <evidence.json>] [--scale <n>] [--case L1,L2]
 *
 * The record goes to `--out` (the monorepo keeps it under docs/qualification/mc31/evidence/); without it, beside the work
 * directory under bench/, which is not tracked. It is not a qualification/ record and no gate of this repository reads it.
 *
 * `--scale` divides the row counts for a smoke run; the limit cases are only
 * meaningful at scale 1, and a smoke run says so in its record.
 *
 * Cases, each stated from the input:
 *   L1  MAX leads share one email           -> PASS, one cluster of MAX members
 *   L2  MAX + 1 leads share one email       -> refused, IDENTITY_GROUP_TOO_LARGE
 *   L3  MAX leads and MAX contacts share one email -> PASS, two clusters (one per object)
 *   L4  MAX + 1 leads share one phone       -> refused, IDENTITY_GROUP_TOO_LARGE
 *   L5  MAX + 1 leads share one full name   -> refused, IDENTITY_GROUP_TOO_LARGE
 *
 * The child exits 0 on completion, 3 on the declared refusal, 1 on anything else.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};

const { HARD_MEMORY_LIMIT_BYTES, MAX_IDENTITY_GROUP_MEMBERS, SCRATCH_BUDGET_BYTES, MEMORY_BUDGET_BYTES } = await import(
  '../dist/src/domain/resource-profile.js'
);

// ------------------------------------------------------------------ the child
if (args[0] === '--child') {
  const [caseDir] = args.slice(1);
  const { loadConfig } = await import('../dist/src/mapping/load-config.js');
  const { runMigration } = await import('../dist/src/run/run-migration.js');
  const { createFilesystemScratchStore } = await import('../dist/src/scratch/filesystem-scratch-store.js');
  const loaded = loadConfig(readFileSync(join(caseDir, 'config.json'), 'utf8'), join(caseDir, 'config.json'));
  const scratch = createFilesystemScratchStore({ root: join(caseDir, 'scratch'), runId: 'adv', quotaBytes: SCRATCH_BUDGET_BYTES });
  const report = (fields) => writeFileSync(join(caseDir, 'child.json'), JSON.stringify({ ...fields, peakRssBytes: process.resourceUsage().maxRSS * 1024, cpu: process.cpuUsage() }));
  try {
    const result = runMigration({ inputRoot: join(caseDir, 'input'), config: loaded.config, configHash: loaded.configHash, scratch });
    let clusters = new Map();
    for (const entry of result.truth.duplicateCandidates) clusters.set(entry.clusterId, { object: entry.object, signal: entry.signal, members: (clusters.get(entry.clusterId)?.members ?? 0) + 1 });
    report({
      outcome: 'COMPLETED',
      equationHolds: result.reconciliation.sourceRows.equationHolds,
      sourceRows: result.reconciliation.sourceRows.total,
      clusters: [...clusters.values()].sort((a, b) => b.members - a.members).slice(0, 10),
    });
    process.exitCode = 0;
  } catch (error) {
    const code = error?.code ?? null;
    report({ outcome: code === 'IDENTITY_GROUP_TOO_LARGE' ? 'REFUSED' : 'FAILED', code, message: String(error?.message ?? error).slice(0, 500), details: error?.details ?? null });
    process.exitCode = code === 'IDENTITY_GROUP_TOO_LARGE' ? 3 : 1;
  } finally {
    scratch.dispose();
  }
  process.exit();
}

// ----------------------------------------------------------------- the parent
const scale = Number(flag('--scale') ?? 1);
const MAX = Math.floor(MAX_IDENTITY_GROUP_MEMBERS / scale);
const work = join(repoRoot, 'bench', 'adversarial-identity-memory');
const outPath = flag('--out') ?? join(work, 'evidence.json');

const quote = (value) => (/[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
function writeCsv(path, headers, count, row) {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, `${headers.join(',')}\n`);
    let chunk = '';
    for (let i = 0; i < count; i += 1) {
      chunk += `${row(i).map(quote).join(',')}\n`;
      if (chunk.length > 1 << 20) {
        writeSync(fd, chunk);
        chunk = '';
      }
    }
    writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
}
const text = (header, destinationField) => ({ column: { header }, destinationField, semanticType: 'TEXT' });
const PERSON = (prefix, idHeader) => ({
  headers: [idHeader, 'First', 'Last', 'Email', 'Phone'],
  fields: [text('First', `${prefix}.firstName`), text('Last', `${prefix}.lastName`), text('Email', `${prefix}.email`), text('Phone', `${prefix}.phone`)],
});
const distinct = (i) => ({ first: `F${String(i)}`, last: `L${String(i)}`, email: `p${String(i)}@example.com`, phone: `+1212${String(1_000_000 + i).padStart(7, '0')}` });

/** One person file whose rows share exactly the value under `shared`, and nothing else. */
function personFile(prefix, idPrefix, count, shared) {
  const shape = PERSON(prefix, prefix === 'lead' ? 'Lead ID' : 'Contact ID');
  return {
    ...shape,
    count,
    row: (i) => {
      const own = distinct(i);
      return [
        `${idPrefix}-${String(i)}`,
        shared === 'NAME' ? 'Info' : own.first,
        shared === 'NAME' ? 'Desk' : own.last,
        shared === 'EMAIL' ? 'info@shared.example' : own.email,
        shared === 'PHONE' ? '+12125550100' : own.phone,
      ];
    },
  };
}

const CASES = [
  { id: 'L1', expect: 'COMPLETED', clusterMembers: MAX, files: [['leads', 'LEAD', personFile('lead', 'L', MAX, 'EMAIL')]] },
  { id: 'L2', expect: 'REFUSED', files: [['leads', 'LEAD', personFile('lead', 'L', MAX + 1, 'EMAIL')]] },
  {
    id: 'L3',
    expect: 'COMPLETED',
    clusterMembers: MAX,
    clusterCount: 2,
    files: [
      ['leads', 'LEAD', personFile('lead', 'L', MAX, 'EMAIL')],
      ['contacts', 'CONTACT', personFile('contact', 'C', MAX, 'EMAIL')],
    ],
  },
  { id: 'L4', expect: 'REFUSED', files: [['leads', 'LEAD', personFile('lead', 'L', MAX + 1, 'PHONE')]] },
  { id: 'L5', expect: 'REFUSED', files: [['leads', 'LEAD', personFile('lead', 'L', MAX + 1, 'NAME')]] },
];
const wanted = flag('--case');
const chosen = wanted === null ? CASES : CASES.filter((c) => wanted.split(',').includes(c.id));

const heapFlag = `--max-old-space-size=${String(Math.floor(HARD_MEMORY_LIMIT_BYTES / (1024 * 1024)))}`;
const results = [];
for (const testCase of chosen) {
  const caseDir = join(work, testCase.id);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(join(caseDir, 'input'), { recursive: true });
  const files = [];
  const records = [];
  for (const [id, object, file] of testCase.files) {
    writeCsv(join(caseDir, 'input', `${id}.csv`), file.headers, file.count, file.row);
    files.push({ id, path: `${id}.csv`, format: 'CSV' });
    records.push({ id, fileId: id, object, sourceRecordIdColumn: { header: file.headers[0] }, fields: file.fields });
  }
  const config = {
    configVersion: '3.0.0',
    source: { system: 'generic_csv', namespace: `adv-${testCase.id.toLowerCase()}` },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    // Above the shipped per-file input limits, as the capacity ladder does: the default `maxRowsPerSheet` (250,000) counts
    // the header record, so it refuses a file of 250,000 leads with INPUT_LIMIT_EXCEEDED before identity is ever reached,
    // and the subject here is the identity group limit, not the input limit. The first Linux run at scale 1 stopped there.
    limits: { maxRowsPerSheet: 2_000_000, maxBytesPerFile: 4_294_967_296, maxTotalBytes: 17_179_869_184 },
    files,
    records,
  };
  writeFileSync(join(caseDir, 'config.json'), JSON.stringify(config, null, 2));
  const started = Date.now();
  const child = spawnSync(process.execPath, [heapFlag, fileURLToPath(import.meta.url), '--child', caseDir], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const wallMs = Date.now() - started;
  let observed = null;
  try {
    observed = JSON.parse(readFileSync(join(caseDir, 'child.json'), 'utf8'));
  } catch {
    observed = { outcome: 'NO_REPORT', exitStatus: child.status, signal: child.signal, stderr: String(child.stderr).slice(-2000) };
  }
  const problems = [];
  if (observed.outcome !== testCase.expect) problems.push(`expected ${testCase.expect}, observed ${String(observed.outcome)}`);
  if (testCase.expect === 'COMPLETED' && observed.outcome === 'COMPLETED') {
    if (observed.equationHolds !== true) problems.push('the source rows do not reconcile');
    const big = (observed.clusters ?? []).filter((c) => c.members === testCase.clusterMembers);
    if (big.length !== (testCase.clusterCount ?? 1)) problems.push(`expected ${String(testCase.clusterCount ?? 1)} cluster(s) of ${String(testCase.clusterMembers)}, observed ${JSON.stringify(observed.clusters)}`);
    if (testCase.clusterCount === 2 && new Set(big.map((c) => c.object)).size !== 2) problems.push('a Lead and a Contact were put in one cluster');
  }
  if (typeof observed.peakRssBytes === 'number' && observed.peakRssBytes > MEMORY_BUDGET_BYTES) problems.push(`peak RSS ${String(observed.peakRssBytes)} over the memory budget ${String(MEMORY_BUDGET_BYTES)}`);
  const result = {
    id: testCase.id,
    expected: testCase.expect,
    sourceRows: testCase.files.reduce((sum, [, , file]) => sum + file.count, 0),
    outcome: observed.outcome,
    code: observed.code ?? null,
    exitStatus: child.status,
    wallMs,
    peakRssBytes: observed.peakRssBytes ?? null,
    cpuUserMicroseconds: observed.cpu?.user ?? null,
    cpuSystemMicroseconds: observed.cpu?.system ?? null,
    clusters: observed.clusters ?? null,
    details: observed.details ?? null,
    problems,
    result: problems.length === 0 ? 'PASS' : 'FAIL',
  };
  results.push(result);
  process.stdout.write(`${result.id} ${result.result} ${String(result.outcome)} rows=${String(result.sourceRows)} rss=${String(result.peakRssBytes)} wallMs=${String(wallMs)} ${problems.join('; ')}\n`);
  rmSync(caseDir, { recursive: true, force: true });
}

const evidence = {
  gate: 'O18A-ADVERSARIAL-IDENTITY-MEMORY',
  coreVersion: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
  scale,
  limit: MAX_IDENTITY_GROUP_MEMBERS,
  meaningful: scale === 1,
  memoryBudgetBytes: MEMORY_BUDGET_BYTES,
  heapFlag,
  environment: { platform: process.platform, arch: process.arch, release: release(), cpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version },
  results,
  result: results.every((r) => r.result === 'PASS') ? 'PASS' : 'FAIL',
};
mkdirSync(resolve(outPath, '..'), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(evidence, null, 1)}\n`);
process.stdout.write(`adversarial identity memory = ${evidence.result}\n`);
process.exit(evidence.result === 'PASS' ? 0 : 1);

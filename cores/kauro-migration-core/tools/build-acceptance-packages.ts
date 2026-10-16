/**
 * Builds the acceptance packages.
 *
 * For each acceptance fixture this writes the package, runs the verifier over
 * it from disk, and records the exact SHA-256 of every artifact. The results
 * are committed, so a reviewer can read a finished package rather than take a
 * summary on trust, and a later change that alters any byte shows up as a diff.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/mapping/load-config.js';
import { createFilesystemScratchStore } from '../src/scratch/filesystem-scratch-store.js';
import { SCRATCH_BUDGET_BYTES } from '../src/domain/resource-profile.js';
import { runMigration } from '../src/run/run-migration.js';
import { writeAndPromotePackage } from '../src/artifacts/write-package.js';
import { verifyPackage } from '../src/verify/verify-package.js';
import { canonicalJsonText } from '../src/util/json.js';
import type { JsonObject, JsonValue } from '../src/util/json.js';
import { CORE_VERSION } from '../src/version.js';
import { attestationFor } from './attestation-fixture.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const fixtureRoot = join(repoRoot, 'test', 'fixtures', 'acceptance');
const outputRoot = join(repoRoot, 'acceptance');

const CASES = [
  {
    id: 'A-clean-multi-object',
    title: 'Clean multi-object migration',
    // What this case actually maps, checked against its own configuration
    // rather than described from memory. It read "contacts, companies, deals,
    // notes and four relationship shapes": there is no note object anywhere in
    // the engine — activities are outside the support envelope and are refused
    // — and the configuration declares three relationship types, not four. The
    // sentence had been true of a corpus that predates the envelope, and it
    // shipped in the generated index as a current description of a current
    // package.
    intent:
      'Contacts, companies, deals and leads with all three relationship shapes in one run, and nothing wrong in the source. Everything is delivered and every relationship resolves.',
  },
  {
    id: 'B-dirty-multinational',
    title: 'Dirty multinational data',
    intent:
      'Phone numbers from five countries with and without evidence, whitespace, mixed email case, Unicode names, an unparseable date and postal codes with leading zeros. Nothing is guessed and nothing is blanked.',
  },
  {
    id: 'C-identity-adversarial',
    title: 'Identity under adversarial conditions',
    intent:
      'A proven duplicate, a proven duplicate that disagrees with itself, two different people sharing an address, a shared mailbox used by two people, and the same record id in two different source systems. Only the provable duplicate is combined.',
  },
  { id: 'D-hubspot', title: 'HubSpot destination package', intent: 'One shared source bundle rendered for HubSpot.' },
  {
    id: 'D-salesforce',
    title: 'Salesforce destination package',
    intent:
      'The same source bundle rendered for Salesforce, which carries a Lead object HubSpot does not, and supports fewer relationships: a contact on an opportunity is an OpportunityContactRole, which is outside this envelope.',
  },
];

function buildCase(caseId: string, title: string, intent: string): JsonObject {
  const fixtureDir = join(fixtureRoot, caseId);
  const packageDir = join(outputRoot, caseId, 'package');
  rmSync(join(outputRoot, caseId), { recursive: true, force: true });
  mkdirSync(join(outputRoot, caseId), { recursive: true });

  const configPath = join(fixtureDir, 'config.json');
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  // One store per case, under the case output, removed once the package is
  // written. Nothing an acceptance package holds may depend on scratch that
  // outlived the run that made it.
  const scratch = createFilesystemScratchStore({
    root: join(outputRoot, caseId, 'work'),
    runId: 'acceptance',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
  const result = runMigration({
    inputRoot: join(fixtureDir, 'input'),
    config: loaded.config,
    configHash: loaded.configHash,
    scratch,
    // A CRM case attests, like any CRM run. See tools/attestation-fixture.ts.
    ...attestationFor(loaded.config.target.mode),
  });
  const written = writeAndPromotePackage({
    result,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });

  // The package is written, so the families are spent. Scratch holds customer
  // data and this directory sits inside the repository, so leaving it behind
  // does not just waste space — it commits somebody's rows.
  //
  // The store removes what it wrote; the root is this tool's, so this tool
  // removes that.
  scratch.dispose();
  rmSync(join(outputRoot, caseId, 'work'), { recursive: true, force: true });

  const verifyStore = createFilesystemScratchStore({
    root: join(outputRoot, caseId, 'verify-work'),
    runId: 'verify',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
  let verification;
  try {
    verification = verifyPackage(packageDir, { scratch: verifyStore });
  } finally {
    verifyStore.dispose();
    rmSync(join(outputRoot, caseId, 'verify-work'), { recursive: true, force: true });
  }
  const reconciliation = result.reconciliation;

  const summary: JsonObject = {
    caseId,
    title,
    intent,
    coreVersion: CORE_VERSION,
    runId: result.truth.runId,
    bundleId: result.truth.bundleId,
    configHash: result.truth.configHash,
    target: { vendor: result.adapter.mode, adapterVersion: result.adapter.version, mode: result.truth.importMode },
    verification: {
      passed: verification.passed,
      checksRun: verification.checks.length,
      problems: verification.problems.map((problem) => ({ check: problem.check, detail: problem.detail })),
    },
    sourceRows: {
      total: reconciliation.sourceRows.total,
      byDisposition: { ...reconciliation.sourceRows.byDisposition },
      withoutDisposition: reconciliation.sourceRows.withoutDisposition,
    },
    records: { total: reconciliation.records.deliveredTotal, byObject: { ...reconciliation.records.byObject } },
    cells: { ...reconciliation.cells },
    identity: { ...reconciliation.identity },
    associations: {
      sourceEdges: reconciliation.associations.sourceEdges,
      byDisposition: { ...reconciliation.associations.byDisposition },
      withoutDisposition: reconciliation.associations.withoutDisposition,
    },
    destination: { ...reconciliation.destination },
    artifacts: written.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      rowCount: artifact.rowCount,
    })),
    manifestSha256: written.manifestSha256,
  } as unknown as JsonObject;

  writeFileSync(
    join(outputRoot, caseId, 'acceptance.json'),
    Buffer.from(canonicalJsonText(summary), 'utf8'),
  );

  const hashLines = [
    ...written.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`),
    `${written.manifestSha256}  manifest.json`,
  ].sort();
  writeFileSync(join(outputRoot, caseId, 'hashes.txt'), Buffer.from(`${hashLines.join('\n')}\n`, 'utf8'));

  if (!verification.passed) {
    process.stderr.write(`${caseId} did not verify:\n`);
    for (const problem of verification.problems) {
      process.stderr.write(`  ${problem.check}: ${problem.detail}\n`);
    }
    process.exitCode = 1;
  }

  return summary;
}

function run(): void {
  mkdirSync(outputRoot, { recursive: true });
  const summaries: JsonValue[] = [];

  for (const entry of CASES) {
    const summary = buildCase(entry.id, entry.title, entry.intent);
    summaries.push(summary);
    const rows = summary['sourceRows'] as { total: number; byDisposition: Record<string, number> };
    process.stdout.write(
      `${entry.id}: ${String(rows.total)} source rows ` +
        `(${Object.entries(rows.byDisposition)
          .filter(([, value]) => value > 0)
          .map(([key, value]) => `${String(value)} ${key.toLowerCase()}`)
          .join(', ')})` +
        `, ${String((summary['records'] as { total: number }).total)} records, verified\n`,
    );
  }

  writeFileSync(
    join(outputRoot, 'index.json'),
    Buffer.from(canonicalJsonText({ coreVersion: CORE_VERSION, cases: summaries }), 'utf8'),
  );

  writeFileSync(
    join(outputRoot, 'README.md'),
    Buffer.from(renderIndex(summaries as JsonObject[]), 'utf8'),
  );
}

function renderIndex(summaries: readonly JsonObject[]): string {
  const lines = [
    '# Acceptance packages',
    '',
    'Generated by `npm run acceptance`. Each directory holds a complete package,',
    'the verifier report, and the SHA-256 of every artifact. Regenerating from the',
    'same inputs reproduces these bytes exactly.',
    '',
    'These particular packages have never been imported into a live CRM account.',
    'They satisfy the file-level requirements this repository tests against official',
    'vendor documentation, which is a narrower claim than working.',
    '',
    'Packages the engine built from the qualification corpora **have** been imported,',
    'into a real Salesforce org and a real HubSpot portal, and read back record by',
    'record — see `qualification/`. That is where the claim that these files work',
    'comes from; this directory is where the claim that they are reproducible does.',
    '',
    // Two corrections in this header row, both of which made the table say
    // something other than what the packages hold.
    //
    // "Target" printed `target.mode`, which is the *import* mode — every row
    // read CREATE_ONLY, in a column a reader takes for the destination. The
    // destination is `target.vendor`, and the import mode is a different fact
    // that now has its own column.
    //
    // "Relationships" printed `associations.sourceEdges`, which is how many
    // relationship candidates the source asserted, not how many were delivered.
    // Those differ exactly when a relationship could not be resolved — the case
    // a reader scanning this column is looking for — so the one number that
    // could not show a problem was the one on display. Delivered, unresolved
    // and leftover are now three columns, and they sum to the candidates.
    '| Case | Destination | Import mode | Source rows | Delivered | Merged | Isolated | Relationships delivered | Unresolved | Leftover | Verified |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const summary of summaries) {
    const rows = summary['sourceRows'] as { total: number; byDisposition: Record<string, number> };
    const records = summary['records'] as { total: number };
    const associations = summary['associations'] as { sourceEdges: number; byDisposition: Record<string, number> };
    const target = summary['target'] as { mode: string; vendor: string };
    const verification = summary['verification'] as { passed: boolean; checksRun: number };
    lines.push(
      `| ${String(summary['caseId'])} | ${target.vendor} | ${target.mode} | ${String(rows.total)} | ${String(records.total)} | ` +
        `${String(rows.byDisposition['MERGED_PROVEN'] ?? 0)} | ${String(rows.byDisposition['ISOLATED'] ?? 0)} | ` +
        `${String(associations.byDisposition['OUTPUT'] ?? 0)} | ${String(associations.byDisposition['UNRESOLVED'] ?? 0)} | ` +
        `${String(associations.byDisposition['LEFTOVER'] ?? 0)} | ` +
        `${verification.passed ? `yes (${String(verification.checksRun)} checks)` : 'NO'} |`,
    );
  }

  lines.push('');
  for (const summary of summaries) {
    lines.push(`## ${String(summary['caseId'])} — ${String(summary['title'])}`);
    lines.push('');
    lines.push(String(summary['intent']));
    lines.push('');
    lines.push(`Run id \`${String(summary['runId'])}\`, configuration hash \`${String(summary['configHash'])}\`.`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

run();

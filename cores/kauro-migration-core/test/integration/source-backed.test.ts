import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { caseScratch, GOLDEN_ROOT, readTable, runFixture, verifyScratch } from '../support/harness.js';
import {
  authorityCoversRead,
  readCsvRecordsFromPieces,
  READ_BLOCK_BYTES,
  verifyAgainstSource,
} from '../../src/verify/verify-against-source.js';
import type { StrongCounts } from '../../src/verify/verify-against-source.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { listPackageFiles } from '../../src/artifacts/write-package.js';
import { renderCsv } from '../../src/artifacts/csv-writer.js';
import { sha256Hex } from '../../src/util/hash.js';
import { canonicalJsonText, parseJson } from '../../src/util/json.js';
import { packageDigest } from '../../src/artifacts/package-digest.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import type { JsonObject } from '../../src/util/json.js';
import { IMPORT_AREA, packagePath } from '../../src/artifacts/layout.js';

/**
 * Source-backed verification.
 *
 * Package-only verification ends where the package's own knowledge ends: it
 * carries the input hashes, not the inputs. Every case here is a tamper that
 * package-only verification cannot see, or can only see by luck, and that
 * source-backed verification must see because it holds the source bytes, the
 * accepted configuration and this core version as authorities the candidate
 * cannot reach.
 *
 * Each case asserts the named count as well as the failure, so a check that
 * fires for the wrong reason does not read as a pass.
 */

interface Subject {
  readonly dir: string;
  readonly sourceRoot: string;
  readonly configPath: string;
}

function open(caseId: string, scratchName: string): Subject {
  const run = runFixture(GOLDEN_ROOT, caseId, { scratchName });
  return {
    dir: run.packageDir,
    sourceRoot: join(GOLDEN_ROOT, caseId, 'input'),
    configPath: join(GOLDEN_ROOT, caseId, 'config.json'),
  };
}

function read(subject: Subject, relativePath: string): string {
  return readFileSync(join(subject.dir, ...packagePath(relativePath).split('/')), 'utf8');
}

function write(subject: Subject, relativePath: string, text: string): void {
  writeFileSync(join(subject.dir, ...packagePath(relativePath).split('/')), Buffer.from(text, 'utf8'));
}

function readJson(subject: Subject, relativePath: string): JsonObject {
  return parseJson(read(subject, relativePath)) as JsonObject;
}

function writeJson(subject: Subject, relativePath: string, value: JsonObject): void {
  write(subject, relativePath, canonicalJsonText(value));
}

/** Repairs the manifest so the tamper is invisible to hash comparison. */
function repairManifest(subject: Subject): void {
  const manifest = readJson(subject, 'manifest.json');
  const present = new Set(listPackageFiles(subject.dir).filter((path) => path !== 'manifest.json'));
  const artifacts = (manifest['artifacts'] as { path: string; rowCount: number | null; kind?: string }[])
    .filter((artifact) => present.has(artifact.path))
    .map((artifact) => {
      const bytes = readFileSync(join(subject.dir, ...artifact.path.split('/')));
      const rowCount =
        artifact.rowCount === null
          ? null
          : Math.max(0, bytes.toString('utf8').split('\n').filter((line) => line.length > 0).length - 1);
      // The declared kind is kept: a repair restores hashes and counts, it does not re-declare what a file is.
      return { ...artifact, sha256: sha256Hex(bytes), byteLength: bytes.length, rowCount };
    });
  writeJson(subject, 'manifest.json', { ...manifest, artifacts: artifacts as never });
}

function expectCaught(subject: Subject, check: string, count: keyof StrongCounts): void {
  const report = verifyAgainstSource({
    packageDir: subject.dir,
    sourceRoot: subject.sourceRoot,
    configPath: subject.configPath,
  });
  assert.equal(report.passed, false, 'source-backed verification accepted a tampered package');
  assert.ok(
    report.problems.some((problem) => problem.check === check),
    `expected "${check}"; problems were: ${report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | ')}`,
  );
  assert.ok(
    report.counts[count] > 0,
    `expected ${count} to be counted; counts were ${JSON.stringify(report.counts)}`,
  );
  assert.equal(report.authorityUnchanged, true, 'verification altered the authority it checked against');
}

function runFixtureFromSource(sourceRoot: string, configPath: string, scratchName: string): string {
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  const outputDir = mkdtempSync(join(tmpdir(), `kauro-${scratchName}-`));
  writeAndPromotePackage({
    result: runMigration({
      scratch: caseScratch('sourcebacked1'), inputRoot: sourceRoot, config: loaded.config, configHash: loaded.configHash }),
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir,
    force: true,
  });
  return outputDir;
}

describe('source-backed verification holds authorities the package cannot reach', () => {
  it('accepts a package the source and configuration actually produce', () => {
    const subject = open('G11-associations', 'strong-clean');
    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.deepEqual(
      report.problems,
      [],
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
    );
    assert.equal(report.authorityUnchanged, true);
    assert.ok(report.authority.length >= 2, 'the configuration and every source file are authorities');
    for (const entry of report.authority) {
      assert.equal(entry.sha256Before, entry.sha256After, `${entry.path} changed during verification`);
      assert.match(entry.sha256Before, /^[0-9a-f]{64}$/u);
    }
  });

  it('catches a delivered value rewritten where no artifact describes the cell', () => {
    // This is the case package-only verification cannot see at all: the value
    // was never changed by the migration, so no change-log row contradicts it.
    const subject = open('G01-clean-contacts', 'strong-value');
    const path = '01_IMPORT/clean-only/contacts.csv';
    const before = read(subject, path);
    const after = before.replace('katherine@example.com', 'attacker@evil.example');
    assert.notEqual(after, before, 'the tamper must actually change the file');
    write(subject, path, after);
    // Package format 2.1.0 carries a neutralised copy of an import file that has a
    // risky cell (G01 has phone numbers), and the verifier compares the copy with
    // the file. A forger who rewrites the file rewrites the copy too, so the
    // rewrite is made coherent here; the point of the case is unchanged: nothing
    // inside the package contradicts it.
    const viewPath = '04_DOCUMENTATION/data-view/clean-only/contacts.csv';
    write(subject, viewPath, read(subject, viewPath).replace('katherine@example.com', 'attacker@evil.example'));
    repairManifest(subject);
    assert.equal(verifyPackage(subject.dir, { scratch: verifyScratch(subject.dir) }).passed, true, 'package-only verification is expected to miss this');
    expectCaught(subject, 'source.deliveredValues', 'deliveredValuesAltered');
  });

  it('catches a source row invented out of nothing', () => {
    const subject = open('G01-clean-contacts', 'strong-invent-row');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    const model = lineage.rows[0];
    assert.ok(model !== undefined);
    const planted = lineage.headers.map((header) => {
      if (header === 'row_number') return '99';
      if (header === 'row_locator_id') return `${model['file_id'] ?? ''}:${model['sheet_id'] ?? ''}:R99`;
      return model[header] ?? '';
    });
    write(
      subject,
      'source-lineage.csv',
      renderCsv(lineage.headers, [
        ...lineage.rows.map((row) => lineage.headers.map((header) => row[header] ?? '')),
        planted,
      ]),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.rowsAreTheRowsThatExist', 'sourceRowsInvented');
  });

  it('catches a source row removed from the record', () => {
    const subject = open('G01-clean-contacts', 'strong-remove-row');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    write(
      subject,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.slice(1).map((row) => lineage.headers.map((header) => row[header] ?? '')),
      ),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.rowsAreTheRowsThatExist', 'sourceRowsRemoved');
  });

  it('catches a disposition that is not what the source gives', () => {
    const subject = open('G01-clean-contacts', 'strong-disposition');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    write(
      subject,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.map((row, index) =>
          lineage.headers.map((header) =>
            index === 0 && header === 'disposition' ? 'LEFTOVER' : row[header] ?? '',
          ),
        ),
      ),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.dispositionsAreTheTruth', 'dispositionsAltered');
  });

  it('catches a forged derived identifier', () => {
    const subject = open('G01-clean-contacts', 'strong-derived-id');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    write(
      subject,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.map((row, index) =>
          lineage.headers.map((header) =>
            index === 0 && header === 'row_hash' ? '0'.repeat(64) : row[header] ?? '',
          ),
        ),
      ),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.derivedIdentifiers', 'derivedIdMismatches');
  });

  it('catches a relationship the source never asserted', () => {
    const subject = open('G11-associations', 'strong-invent-edge');
    const table = readTable(subject.dir, 'associations.csv');
    const model = table.rows[0];
    assert.ok(model !== undefined);
    write(
      subject,
      'associations.csv',
      renderCsv(table.headers, [
        ...table.rows.map((row) => table.headers.map((header) => row[header] ?? '')),
        table.headers.map((header) => (header === 'source_edge_id' ? 'ed_ffffffffffffffff' : model[header] ?? '')),
      ]),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.relationships', 'edgesInvented');
  });

  it('catches a relationship re-pointed at another record', () => {
    const subject = open('G11-associations', 'strong-repoint-edge');
    const table = readTable(subject.dir, 'associations.csv');
    const edge = table.rows.find((row) => (row['disposition'] ?? '') === 'OUTPUT');
    assert.ok(edge !== undefined);
    const other = table.rows
      .map((row) => row['to_migration_key'] ?? '')
      .find((key) => key !== (edge['to_migration_key'] ?? '') && key !== '');
    assert.ok(other !== undefined);
    write(
      subject,
      'associations.csv',
      renderCsv(
        table.headers,
        table.rows.map((row) =>
          table.headers.map((header) => (row === edge && header === 'to_migration_key' ? other : row[header] ?? '')),
        ),
      ),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.relationships', 'edgesAltered');
  });

  it('catches a merge the source does not prove', () => {
    const subject = open('G22-same-name-different-people', 'strong-invent-merge');
    writeJson(subject, 'merges.json', {
      merges: [
        {
          mergeId: 'mg_ffffffffffffffff',
          object: 'CONTACT',
          survivorMigrationKey: 'mk_contact_ffffffffffffffffffff',
          survivorRowLocatorId: 'F-000000000000:S0:R2',
          absorbedRowLocatorIds: ['F-000000000000:S0:R3'],
          identityEvidence: [],
          fieldDecisions: [],
          conflicts: [],
          associationRemaps: [],
          ruleVersion: '1.0.0',
        },
      ],
    } as never);
    repairManifest(subject);
    expectCaught(subject, 'source.merges', 'mergesInvented');
  });

  it('catches a change the source does not produce', () => {
    const subject = open('G02-safe-formatting', 'strong-invent-change');
    const changes = readTable(subject.dir, 'changes.csv');
    const model = changes.rows[0];
    assert.ok(model !== undefined);
    write(
      subject,
      'changes.csv',
      renderCsv(
        changes.headers,
        changes.rows.map((row) =>
          changes.headers.map((header) => (row === model && header === 'final_value' ? 'invented' : row[header] ?? '')),
        ),
      ),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.changes', 'unauthorizedChanges');
  });

  it('does not take the configuration inside the package as authority', () => {
    // The package carries a normalised copy of the configuration. A candidate
    // that rewrites it — and re-hashes so package-only verification is content —
    // must still be judged against the configuration the operator accepted.
    const subject = open('G01-clean-contacts', 'strong-config-authority');
    const normalized = readJson(subject, 'config.normalized.json');
    (normalized['source'] as JsonObject)['namespace'] = 'rewritten-by-the-candidate';
    writeJson(subject, 'config.normalized.json', normalized);
    repairManifest(subject);

    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.equal(report.passed, false, 'a rewritten configuration inside the package was accepted');
    assert.ok(
      report.problems.some((problem) => problem.check === 'package.bytesMatchTheSource'),
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
    );
  });

  it('refuses to judge a package claimed against another core version', () => {
    const subject = open('G01-clean-contacts', 'strong-core-version');
    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
      coreVersion: '99.0.0',
    });
    assert.equal(report.passed, false);
    assert.ok(report.problems.some((problem) => problem.check === 'authority.coreVersion'));
  });

  it('leaves the source bytes and the accepted configuration untouched', () => {
    const subject = open('G11-associations', 'strong-authority-hashes');
    const before = listPackageFiles(subject.sourceRoot).map((path) => ({
      path,
      sha256: sha256Hex(readFileSync(join(subject.sourceRoot, ...path.split('/')))),
    }));
    const configBefore = sha256Hex(readFileSync(subject.configPath));

    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.equal(report.passed, true);

    for (const entry of before) {
      const after = sha256Hex(readFileSync(join(subject.sourceRoot, ...entry.path.split('/'))));
      assert.equal(after, entry.sha256, `${entry.path} changed`);
    }
    assert.equal(sha256Hex(readFileSync(subject.configPath)), configBefore, 'the configuration changed');
  });

  it(`refuses the package own normalised configuration as the authority`, () => {
    // The one candidate-supplied file that is both a valid input to loadConfig
    // and a legitimate artifact. Pointing --config at it made the candidate the
    // authority: normalisation is idempotent, so a package built from a hostile
    // configuration re-derived byte-identically and every check passed.
    const subject = open('G01-clean-contacts', 'strong-config-inside');
    assert.throws(
      () =>
        verifyAgainstSource({
          packageDir: subject.dir,
          sourceRoot: subject.sourceRoot,
          configPath: join(subject.dir, ...packagePath('config.normalized.json').split('/')),
        }),
      (error: unknown) => String(error).includes('inside the package being verified'),
    );
  });

  it('refuses a source directory inside the package', () => {
    const subject = open('G01-clean-contacts', 'strong-source-inside');
    assert.throws(
      () =>
        verifyAgainstSource({
          packageDir: subject.dir,
          sourceRoot: join(subject.dir, IMPORT_AREA),
          configPath: subject.configPath,
        }),
      (error: unknown) => String(error).includes('inside the package being verified'),
    );
  });

  it('reports every authority, and reports that none of them changed', () => {
    // The mechanism itself, asserted rather than assumed: the whole before and
    // after apparatus could be replaced by a constant and nothing noticed.
    const subject = open('G11-associations', 'strong-authority-reported');
    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.equal(report.passed, true);
    assert.equal(report.authorityUnchanged, true);
    const sourceFiles = listPackageFiles(subject.sourceRoot).length;
    assert.equal(
      report.authority.length,
      sourceFiles + 1,
      'every source file the configuration names, and the configuration itself',
    );
    assert.ok(report.checks.includes('authority.hashesCoverTheBytesRead'));
    assert.ok(report.checks.includes('authority.isOutsideTheCandidate'));
    for (const entry of report.authority) {
      assert.match(entry.sha256Before, /^[0-9a-f]{64}$/u);
      assert.equal(entry.sha256Before, entry.sha256After);
    }
  });

  for (const column of [
    'file_id',
    'file_sha256',
    'identity_key',
    'record_identity_key',
    'migration_key',
    'merge_id',
  ]) {
    it(`catches a forged ${column}`, () => {
      const subject = open('G07-proven-duplicate', `strong-forge-${column}`);
      const lineage = readTable(subject.dir, 'source-lineage.csv');
      const forged = column.endsWith('_id') || column === 'merge_id' ? 'forged-value' : 'f'.repeat(64);
      write(
        subject,
        'source-lineage.csv',
        renderCsv(
          lineage.headers,
          lineage.rows.map((row, index) =>
            lineage.headers.map((header) => (index === 0 && header === column ? forged : row[header] ?? '')),
          ),
        ),
      );
      repairManifest(subject);
      expectCaught(subject, 'source.derivedIdentifiers', 'derivedIdMismatches');
    });
  }

  it('counts a duplicated source row rather than only noticing the bytes', () => {
    const subject = open('G01-clean-contacts', 'strong-duplicate-row');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    const first = lineage.rows[0];
    assert.ok(first !== undefined);
    write(
      subject,
      'source-lineage.csv',
      renderCsv(lineage.headers, [
        ...lineage.rows.map((row) => lineage.headers.map((header) => row[header] ?? '')),
        lineage.headers.map((header) => first[header] ?? ''),
      ]),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.rowsAreTheRowsThatExist', 'sourceRowsInvented');
  });

  it('notices when the hashes taken before the run do not describe what it read', () => {
    // Hashing before and after brackets the read; it does not cover it. This is
    // the comparison that closes the window, put through a mismatch directly
    // rather than by winning a race.
    const clean = authorityCoversRead({
      configHashBefore: 'c'.repeat(64),
      configHashRead: 'c'.repeat(64),
      hashedBefore: new Map([['contacts.csv', 'a'.repeat(64)]]),
      readByRun: new Map([['contacts.csv', 'a'.repeat(64)]]),
    });
    assert.deepEqual(clean, []);

    const swapped = authorityCoversRead({
      configHashBefore: 'c'.repeat(64),
      configHashRead: 'c'.repeat(64),
      hashedBefore: new Map([['contacts.csv', 'a'.repeat(64)]]),
      readByRun: new Map([['contacts.csv', 'b'.repeat(64)]]),
    });
    assert.equal(swapped.length, 1);
    assert.ok(swapped[0]?.includes('but the run read'));

    const configSwapped = authorityCoversRead({
      configHashBefore: 'c'.repeat(64),
      configHashRead: 'd'.repeat(64),
      hashedBefore: new Map(),
      readByRun: new Map(),
    });
    assert.equal(configSwapped.length, 1);
    assert.ok(configSwapped[0]?.includes('not the configuration that was hashed'));

    const unread = authorityCoversRead({
      configHashBefore: 'c'.repeat(64),
      configHashRead: 'c'.repeat(64),
      hashedBefore: new Map([['contacts.csv', 'a'.repeat(64)]]),
      readByRun: new Map(),
    });
    assert.equal(unread.length, 1, 'a file that was hashed but never read is a mismatch too');
  });

  it('cannot, and does not claim to, detect a substituted source', () => {
    // The boundary of what verification can reach, stated as a test rather than
    // as a hope. Someone who controls the source bytes and the accepted
    // configuration can produce a package that is perfectly correct for the
    // source they supplied. Both verifiers pass, and they are right to: the
    // package does describe that source faithfully.
    //
    // What neither can answer is whether that source is the customer's data.
    // That question is answered by an attestation made outside this engine over
    // the source digest, the configuration digest, the core version and the
    // canonical package digest — which is what the digest exists for, and why
    // the package does not attest to its own truth.
    const original = open('G01-clean-contacts', 'strong-substituted-a');
    const substituted = mkdtempSync(join(tmpdir(), 'kauro-substituted-'));
    try {
      for (const name of ['contacts.csv']) {
        const text = readFileSync(join(original.sourceRoot, name), 'utf8');
        writeFileSync(join(substituted, name), Buffer.from(text.replace('Katherine', 'Substituted'), 'utf8'));
      }
      const run = runFixtureFromSource(substituted, original.configPath, 'strong-substituted-b');
      const report = verifyAgainstSource({
        packageDir: run,
        sourceRoot: substituted,
        configPath: original.configPath,
      });
      assert.equal(report.passed, true, 'a package correct for its source is correct');
      assert.equal(verifyPackage(run, { scratch: verifyScratch(run) }).passed, true);

      // And the digest is what distinguishes the two, for whoever attests.
      assert.notEqual(packageDigest(run).digest, packageDigest(original.dir).digest);
    } finally {
      rmSync(substituted, { recursive: true, force: true });
    }
  });

  it('reports a source directory that does not hold what the configuration names', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kauro-nosource-'));
    try {
      const subject = open('G01-clean-contacts', 'strong-missing-source');
      assert.throws(() =>
        verifyAgainstSource({
          packageDir: subject.dir,
          sourceRoot: empty,
          configPath: subject.configPath,
        }),
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  /**
   * The boundaries the bounded comparison introduced.
   *
   * Verification no longer reads an artifact into an array of rows and indexes
   * it; it reads a block at a time and compares two ordered families in step.
   * That removes a memory bound and adds three seams that did not exist before,
   * and each of them can be got wrong in a way that reads as a pass:
   *
   * - a record can straddle the join between two read blocks, so a reader that
   *   carried its parser's state across the join instead of re-reading the
   *   record would split one row into two, or lose a quoted separator;
   * - a group in a merge holds every row that shares a key, where an index held
   *   one, so a repeated key is now visible where it used to be silently
   *   overwritten -- and has to be treated exactly as the index treated it;
   * - a key is escaped on the way into a family, so untrusted text that holds
   *   the characters a segment's format owns must still group with itself and
   *   still not group with anything else.
   *
   * The cases below are those three seams.
   */

  /**
   * A source whose delivered rows are certain to cross a read block.
   *
   * Every row carries a quoted value holding a record separator and a doubled
   * quote, padded to a different length each time, so the block joins land at a
   * different place inside a record on every pass — inside the quotes, between
   * the two halves of a CRLF, and immediately before the second quote of an
   * escaped pair, which are the three positions a chunked reader can get wrong.
   */
  function multilineContacts(rows: number): string {
    const lines = ['Contact ID,First Name,Last Name,Email,Phone'];
    for (let row = 1; row <= rows; row += 1) {
      const padding = 'x'.repeat(row % 37);
      const surname = `Lovelace${padding}\r\nof ""Kent""`;
      const phone = `+1212555${String(1000 + (row % 9000))}`;
      lines.push(`${String(row)},Ada,"${surname}",ada${String(row)}@example.com,${phone}`);
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  function openGeneratedContacts(text: string, scratchName: string): Subject {
    const sourceRoot = mkdtempSync(join(tmpdir(), `kauro-${scratchName}-`));
    writeFileSync(join(sourceRoot, 'contacts.csv'), Buffer.from(text, 'utf8'));
    const configPath = join(GOLDEN_ROOT, 'G01-clean-contacts', 'config.json');
    return { dir: runFixtureFromSource(sourceRoot, configPath, scratchName), sourceRoot, configPath };
  }

  it('reads the same records wherever the file is cut into blocks', () => {
    // The exhaustive form of the boundary case, because the two positions a
    // chunked reader can actually get wrong are one character wide each: the
    // carriage return of a CRLF, and the first quote of an escaped pair. A
    // fixture large enough to have block joins lands on them by luck; cutting
    // one short text at every offset lands on them by construction. Two
    // mutations that broke exactly those two positions survived a case built out
    // of rows, on 2026-09-05, which is why this exists as well as that one.
    const text =
      'a,b,c\r\n' +
      '1,"two\r\nlines","say ""hi"""\r\n' +
      '2,,\n' +
      '3,"x",""\r\n' +
      '4,"ends with a quote """,z\r\n';
    const whole = readCsvRecordsFromPieces([text]);
    assert.deepEqual(whole, [
      ['a', 'b', 'c'],
      ['1', 'two\r\nlines', 'say "hi"'],
      ['2', '', ''],
      ['3', 'x', ''],
      ['4', 'ends with a quote "', 'z'],
    ]);

    for (let cut = 0; cut <= text.length; cut += 1) {
      assert.deepEqual(
        readCsvRecordsFromPieces([text.slice(0, cut), text.slice(cut)]),
        whole,
        `cut at ${String(cut)} of ${String(text.length)}`,
      );
    }
    // And in three pieces, so a record spanning two joins is covered too: a
    // reader that re-read its unfinished record only once would pass the pair
    // above and lose the middle piece here.
    for (let first = 0; first <= text.length; first += 1) {
      for (let second = first; second <= text.length; second += 1) {
        assert.deepEqual(
          readCsvRecordsFromPieces([text.slice(0, first), text.slice(first, second), text.slice(second)]),
          whole,
          `cut at ${String(first)} and ${String(second)}`,
        );
      }
    }
  });

  it('reads artifacts whose records straddle a read block, and accepts them', () => {
    // 2,000 rows is not a scale test. It is the smallest input that makes the
    // import artifact several blocks long, which is what makes the joins between
    // blocks fall inside records rather than only at the end of the file.
    const subject = openGeneratedContacts(multilineContacts(2_000), 'strong-block-clean');
    try {
      const delivered = join(subject.dir, IMPORT_AREA, 'clean-only', 'contacts.csv');
      const bytes = readFileSync(delivered).length;
      assert.ok(
        bytes > 2 * READ_BLOCK_BYTES,
        `the artifact must span several blocks for this to be a boundary case; it is ${String(bytes)} bytes`,
      );

      const report = verifyAgainstSource({
        packageDir: subject.dir,
        sourceRoot: subject.sourceRoot,
        configPath: subject.configPath,
      });
      assert.deepEqual(
        report.problems,
        [],
        report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
      );
      // The quoted record separators survived the read: a reader that split on
      // newlines, or that lost its quoting state at a block join, would have
      // produced more rows than the source has and reported them as invented.
      assert.equal(report.counts.recordsInvented, 0);
      assert.equal(report.counts.sourceRowsInvented, 0);
    } finally {
      rmSync(subject.sourceRoot, { recursive: true, force: true });
    }
  });

  it('catches a value rewritten in a record beyond the first read block', () => {
    const subject = openGeneratedContacts(multilineContacts(2_000), 'strong-block-tamper');
    try {
      const path = `${IMPORT_AREA}/clean-only/contacts.csv`;
      const before = read(subject, path);
      // Far enough in that the row it names cannot be in the first block.
      const after = before.replace('ada1500@example.com', 'attacker@evil.example');
      assert.notEqual(after, before, 'the tamper must actually change the file');
      write(subject, path, after);
      repairManifest(subject);
      expectCaught(subject, 'source.deliveredValues', 'deliveredValuesAltered');
    } finally {
      rmSync(subject.sourceRoot, { recursive: true, force: true });
    }
  });

  it('catches a row appended past the end of an import file', () => {
    // The end of one side of a positional walk. The candidate keeps delivering
    // after the source has run out, which is the case a walk that stopped when
    // either side ended would report as nothing at all.
    const subject = open('G01-clean-contacts', 'strong-import-appended-row');
    const path = `${IMPORT_AREA}/clean-only/contacts.csv`;
    const table = readTable(subject.dir, path);
    const last = table.rows[table.rows.length - 1];
    assert.ok(last !== undefined);
    write(
      subject,
      path,
      renderCsv(table.headers, [
        ...table.rows.map((row) => table.headers.map((header) => row[header] ?? '')),
        table.headers.map((header) => last[header] ?? ''),
      ]),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.deliveredValues', 'recordsInvented');
  });

  it('catches the last row of an import file being dropped', () => {
    // The other end of the same walk: the source is still producing after the
    // candidate has stopped, and the rows it produced are counted rather than
    // inferred from a length the package states about itself.
    const subject = open('G01-clean-contacts', 'strong-import-dropped-row');
    const path = `${IMPORT_AREA}/clean-only/contacts.csv`;
    const table = readTable(subject.dir, path);
    write(
      subject,
      path,
      renderCsv(
        table.headers,
        table.rows.slice(0, -1).map((row) => table.headers.map((header) => row[header] ?? '')),
      ),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.deliveredValues', 'recordsRemoved');
  });

  it('catches an import file the source does not produce at all', () => {
    const subject = open('G01-clean-contacts', 'strong-import-invented-file');
    write(subject, `${IMPORT_AREA}/clean-only/invented.csv`, 'contact.email\ninvented@evil.example\n');
    repairManifest(subject);
    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.equal(report.passed, false);
    assert.ok(
      report.problems.some((problem) => problem.check === 'package.sameArtifacts'),
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
    );
    // And its rows are delivered records nothing produced, not merely a file
    // nobody expected: a comparison that only walked the files both sides have
    // would have said the first and missed the second.
    assert.ok(report.counts.recordsInvented > 0, JSON.stringify(report.counts));
  });

  it('catches a relationship repeated with a different endpoint', () => {
    // A repeated key is a group of two rows where an index held one. The index
    // kept the last of them, so that is what a group has to compare, and a
    // comparison that took the first would accept the rewrite that follows.
    const subject = open('G11-associations', 'strong-edge-repeated');
    const table = readTable(subject.dir, 'associations.csv');
    const edge = table.rows.find((row) => (row['disposition'] ?? '') === 'OUTPUT');
    assert.ok(edge !== undefined);
    write(
      subject,
      'associations.csv',
      renderCsv(table.headers, [
        ...table.rows.map((row) => table.headers.map((header) => row[header] ?? '')),
        table.headers.map((header) =>
          header === 'to_migration_key' ? 'mk_contact_ffffffffffffffffffff' : edge[header] ?? '',
        ),
      ]),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.relationships', 'edgesAltered');
  });

  it('does not read a change stated twice as a change nobody authorised', () => {
    // The other half of the repeated-key seam, and the one that fails quietly:
    // a change log was compared as two sets, so a duplicated row was one change.
    // A merge sees both rows, and a merge that counted rows instead of keys
    // would invent an unauthorised change out of a package that has none.
    const subject = open('G02-safe-formatting', 'strong-change-repeated');
    const changes = readTable(subject.dir, 'changes.csv');
    const first = changes.rows[0];
    assert.ok(first !== undefined);
    write(
      subject,
      'changes.csv',
      renderCsv(changes.headers, [
        ...changes.rows.map((row) => changes.headers.map((header) => row[header] ?? '')),
        changes.headers.map((header) => first[header] ?? ''),
      ]),
    );
    repairManifest(subject);

    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.equal(report.counts.unauthorizedChanges, 0, JSON.stringify(report.counts));
    assert.equal(
      report.problems.filter((problem) => problem.check === 'source.changes').length,
      0,
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
    );
    // It is still a tampered package, and the byte comparison still says so.
    assert.equal(report.passed, false);
    assert.ok(report.counts.artifactsDiffering > 0, JSON.stringify(report.counts));
  });

  it('catches an invented row whose locator holds the characters a sort key is made of', () => {
    // The escaping seam. A row locator is customer-adjacent text that becomes a
    // sort key, and the segment format owns the newline, the tab, the NUL and
    // U+0001. Escaped on the way in, the forged locator still groups with itself
    // and is still reported by the spelling the artifact actually holds; not
    // escaped, the family write fails or the two sides stop matching and the
    // check reports nothing.
    const subject = open('G01-clean-contacts', 'strong-locator-control-characters');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    const model = lineage.rows[0];
    assert.ok(model !== undefined);
    const forged = `F-000000000000:S0:R\u0001\u0000\tR9%9`;
    write(
      subject,
      'source-lineage.csv',
      renderCsv(lineage.headers, [
        ...lineage.rows.map((row) => lineage.headers.map((header) => row[header] ?? '')),
        lineage.headers.map((header) => (header === 'row_locator_id' ? forged : model[header] ?? '')),
      ]),
    );
    repairManifest(subject);
    expectCaught(subject, 'source.rowsAreTheRowsThatExist', 'sourceRowsInvented');

    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.ok(
      report.problems.some(
        (problem) => problem.check === 'source.rowsAreTheRowsThatExist' && problem.detail.includes(forged),
      ),
      'the finding must name the locator the artifact holds, not the spelling the sort key uses',
    );
  });

  it('keeps two invented locators apart when one is a prefix of the other', () => {
    // Grouping is what a merge does instead of a lookup, and a grouping that
    // compared keys by prefix — or that composed a key without a separator
    // below every character a locator can hold — would fold these two forged
    // rows into one and report a single invented row where there are two.
    const subject = open('G01-clean-contacts', 'strong-locator-prefixes');
    const lineage = readTable(subject.dir, 'source-lineage.csv');
    const model = lineage.rows[0];
    assert.ok(model !== undefined);
    // A file id no fixture produces, so neither locator can collide with a real
    // row and be reported as a duplicate instead of an invention.
    const shorter = 'F-ffffffffffff:S0:R7';
    const longer = `${shorter}0`;
    write(
      subject,
      'source-lineage.csv',
      renderCsv(lineage.headers, [
        ...lineage.rows.map((row) => lineage.headers.map((header) => row[header] ?? '')),
        lineage.headers.map((header) => (header === 'row_locator_id' ? longer : model[header] ?? '')),
        lineage.headers.map((header) => (header === 'row_locator_id' ? shorter : model[header] ?? '')),
      ]),
    );
    repairManifest(subject);

    const report = verifyAgainstSource({
      packageDir: subject.dir,
      sourceRoot: subject.sourceRoot,
      configPath: subject.configPath,
    });
    assert.equal(report.passed, false);
    assert.equal(report.counts.sourceRowsInvented, 2, JSON.stringify(report.counts));
    for (const locator of [shorter, longer]) {
      assert.ok(
        report.problems.some(
          (problem) =>
            problem.check === 'source.rowsAreTheRowsThatExist' &&
            problem.detail.startsWith(`${locator} is in the package`),
        ),
        `${locator} was not reported on its own`,
      );
    }
  });
});

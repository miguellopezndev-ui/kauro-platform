import { strict as assert } from 'node:assert';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import {
  SOURCE_PROFILE_VERSION,
  assertProfileDescribesBundle,
  buildSourceProfile,
  hashSourceProfile,
  loadSourceProfile,
  serializeSourceProfile,
} from '../../src/profile/source-profile.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { caseScratch, repoRoot, scratchDir } from '../support/harness.js';

/**
 * What the source is, and whether the run agrees.
 *
 * A profile exists so that the plan compiled from it and the execution that
 * follows are talking about the same bytes read the same way. The report this
 * replaces could not establish that: it had no version and no hash, so a plan
 * compiled against one reading of a bundle could be executed against another
 * and neither artifact would say anything.
 *
 * The cases below are about that binding and about the counts being exact
 * without holding the data — a distinct count taken from a set of every distinct
 * value is exact and unbounded, and the canonical contract forbids reaching it
 * either by holding the data or by sampling it.
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');

function build(name: string, inputDir?: string) {
  const configPath = join(FIXTURES, 'clean-only.json');
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  return {
    loaded,
    profiled: buildSourceProfile({
      inputRoot: inputDir ?? join(FIXTURES, 'input'),
      config: loaded.config,
      scratch: caseScratch(name),
    }),
  };
}

describe('a profile is versioned, hashable and about a particular bundle', () => {
  it('names the version this core reads', () => {
    const { profiled } = build('profile-version');
    assert.equal(profiled.profile.profileVersion, SOURCE_PROFILE_VERSION);
    assert.equal(SOURCE_PROFILE_VERSION, '1.0.0');
  });

  it('hashes to the same value for the same bytes, and a different one for different bytes', () => {
    const first = build('profile-hash-a');
    const second = build('profile-hash-b');
    assert.equal(first.profiled.profileHash, second.profiled.profileHash, 'the same bundle profiles the same');
    assert.equal(first.profiled.profileHash.length, 64);

    const changed = scratchDir('profile', 'changed');
    copyFileSync(join(FIXTURES, 'input', 'contacts.csv'), join(changed, 'contacts.csv'));
    appendFileSync(join(changed, 'contacts.csv'), '4,Edsger,Dijkstra,edsger@example.com,Engineer\n');
    const third = build('profile-hash-c', changed);
    assert.notEqual(third.profiled.profileHash, first.profiled.profileHash, 'one more row is a different profile');
  });

  it('survives being written and read back', () => {
    const { profiled } = build('profile-roundtrip');
    const text = serializeSourceProfile(profiled);
    const reloaded = loadSourceProfile(text, 'profile.json');
    assert.equal(reloaded.profileHash, profiled.profileHash);
    assert.deepEqual(reloaded.profile, profiled.profile);
  });

  it('refuses a profile written by a version it does not read', () => {
    const { profiled } = build('profile-version-refused');
    const later = { ...profiled.profile, profileVersion: '2.0.0' };
    const text = serializeSourceProfile({ profile: later, profileHash: hashSourceProfile(later) });
    assert.throws(
      () => loadSourceProfile(text, 'profile.json'),
      (error: unknown) =>
        isMigrationError(error) && error.code === 'SOURCE_PROFILE_INVALID' && error.message.includes('version 2.0.0'),
    );
  });

  it('refuses something that is not a profile at all', () => {
    const refused = (fragment: string) => (error: unknown) =>
      isMigrationError(error) && error.code === 'SOURCE_PROFILE_INVALID' && error.message.includes(fragment);
    assert.throws(() => loadSourceProfile('{ not json', 'profile.json'), refused('not valid JSON'));
    // The two inputs the previous reader got wrong: a bare version passed as a
    // profile of nothing, and null reached the reader's own code as a TypeError.
    assert.throws(() => loadSourceProfile('{"profileVersion":"1.0.0"}', 'profile.json'), refused('schema'));
    assert.throws(() => loadSourceProfile('null', 'profile.json'), refused('not a profile document'));
    assert.throws(() => loadSourceProfile('[]', 'profile.json'), refused('not a profile document'));
    assert.throws(() => loadSourceProfile('', 'profile.json'), refused('not valid JSON'));
  });

  it('refuses a profile whose hash was edited, and one whose content was', () => {
    const { profiled } = build('profile-tampered');
    const text = serializeSourceProfile(profiled);
    const refused = (fragment: string) => (error: unknown) =>
      isMigrationError(error) && error.code === 'SOURCE_PROFILE_INVALID' && error.message.includes(fragment);
    assert.throws(
      () => loadSourceProfile(text.replace(profiled.profileHash, `${'0'.repeat(63)}1`), 'profile.json'),
      refused('does not hash'),
    );
    // One counter moved, hash left alone: the content check fires before the hash does.
    const column = profiled.profile.files[0]?.sheets[0]?.columns[0];
    assert.ok(column !== undefined);
    const edited = text.replace(`"populated": ${String(column.populated)}`, `"populated": ${String(column.populated + 1)}`);
    assert.notEqual(edited, text);
    assert.throws(() => loadSourceProfile(edited, 'profile.json'), refused('invariants'));
  });

  it('refuses an unknown key, a repeated file and a counter that contradicts the sheet', () => {
    const { profiled } = build('profile-shape');
    const refused = (fragment: string) => (error: unknown) =>
      isMigrationError(error) && error.code === 'SOURCE_PROFILE_INVALID' && error.message.includes(fragment);
    const withExtra = { ...profiled.profile, note: 'an unknown key' } as unknown as typeof profiled.profile;
    assert.throws(
      () => loadSourceProfile(serializeSourceProfile({ profile: withExtra, profileHash: hashSourceProfile(withExtra) }), 'profile.json'),
      refused('schema'),
    );
    const file = profiled.profile.files[0];
    assert.ok(file !== undefined);
    const repeated = { ...profiled.profile, files: [file, file] };
    assert.throws(
      () => loadSourceProfile(serializeSourceProfile({ profile: repeated, profileHash: hashSourceProfile(repeated) }), 'profile.json'),
      refused('more than once'),
    );
    const sheet = file.sheets[0];
    assert.ok(sheet !== undefined);
    const column = sheet.columns[0];
    assert.ok(column !== undefined);
    const distinctTooMany = {
      ...profiled.profile,
      files: [{ ...file, sheets: [{ ...sheet, columns: [{ ...column, distinctValues: column.populated + 5 }, ...sheet.columns.slice(1)] }] }],
    };
    assert.throws(
      () =>
        loadSourceProfile(
          serializeSourceProfile({ profile: distinctTooMany, profileHash: hashSourceProfile(distinctTooMany) }),
          'profile.json',
        ),
      refused('exceeds the populated count'),
    );
  });
});

describe('the counts are exact and about the whole bundle', () => {
  it('counts populated, blank and absent cells apart', () => {
    // The fixture's Job Title column has one populated value, one blank cell and
    // one authorized-clear source value. Blank and absent are different
    // observations about the source, and a profile that reported one number for
    // both would hide the difference the value semantics turn on.
    const { profiled } = build('profile-counts');
    const sheet = profiled.profile.files[0]?.sheets[0];
    assert.ok(sheet !== undefined);
    assert.equal(sheet.dataRowCount, 3);

    const jobTitle = sheet.columns.find((column) => column.headerRaw === 'Job Title');
    assert.ok(jobTitle !== undefined);
    assert.equal(jobTitle.populated, 2, 'N/A and Engineer');
    assert.equal(jobTitle.blank, 1, 'the cell that is there and empty');
    assert.equal(jobTitle.absent, 0);
    assert.equal(jobTitle.distinctValues, 2);
  });

  it('counts distinct values exactly, including where every value repeats', () => {
    const repeated = scratchDir('profile', 'repeated');
    const rows = ['Contact ID,First Name,Last Name,Email,Job Title'];
    for (let index = 0; index < 300; index += 1) {
      // Ten distinct titles across three hundred rows, and one id per row.
      rows.push(`${String(index)},First,Last,person${String(index)}@example.com,Title ${String(index % 10)}`);
    }
    writeFileSync(join(repeated, 'contacts.csv'), `${rows.join('\n')}\n`);

    const { profiled } = build('profile-distinct', repeated);
    const sheet = profiled.profile.files[0]?.sheets[0];
    assert.ok(sheet !== undefined);

    const jobTitle = sheet.columns.find((column) => column.headerRaw === 'Job Title');
    assert.equal(jobTitle?.populated, 300);
    assert.equal(jobTitle?.distinctValues, 10, 'exact, not sampled');
    assert.equal(jobTitle?.mostRepeatedValueCount, 30);
    assert.equal(jobTitle?.uniqueAcrossPopulatedRows, false);

    const email = sheet.columns.find((column) => column.headerRaw === 'Email');
    assert.equal(email?.distinctValues, 300);
    assert.equal(email?.uniqueAcrossPopulatedRows, true, 'every populated value differs');
    assert.ok(sheet.candidateKeyColumns.includes(email?.columnIndex ?? -1), 'so it is a key candidate');

    const firstName = sheet.columns.find((column) => column.headerRaw === 'First Name');
    assert.equal(firstName?.distinctValues, 1, 'one value, three hundred times');
    assert.equal(firstName?.mostRepeatedValueCount, 300);
  });

  it('gives the same answer however much it had to spill', () => {
    // The distinct count is taken from a sorted spill, so it must not depend on
    // how much of that sort fitted in memory.
    const repeated = scratchDir('profile', 'spilled');
    const rows = ['Contact ID,First Name,Last Name,Email,Job Title'];
    for (let index = 0; index < 400; index += 1) {
      rows.push(`${String(index)},F${String(index % 7)},L,person${String(index)}@example.com,T${String(index % 13)}`);
    }
    writeFileSync(join(repeated, 'contacts.csv'), `${rows.join('\n')}\n`);

    const first = build('profile-spill-a', repeated);
    const second = build('profile-spill-b', repeated);
    assert.equal(first.profiled.profileHash, second.profiled.profileHash);

    const sheet = first.profiled.profile.files[0]?.sheets[0];
    assert.equal(sheet?.columns.find((column) => column.headerRaw === 'First Name')?.distinctValues, 7);
    assert.equal(sheet?.columns.find((column) => column.headerRaw === 'Job Title')?.distinctValues, 13);
  });

  it('records the totals over the whole bundle in bytes and rows', () => {
    const { profiled } = build('profile-totals');
    assert.equal(profiled.profile.totals.fileCount, 1);
    assert.equal(profiled.profile.totals.sheetCount, 1);
    assert.equal(profiled.profile.totals.dataRowCount, 3);
    assert.equal(profiled.profile.totals.readerRowCount, 3);
    assert.ok(profiled.profile.totals.byteLength > 0);
    assert.ok(profiled.profile.totals.populatedCells > 0);
  });
});

describe('a run refuses a profile that does not describe what it read', () => {
  it('runs when the profile is the one the bundle produces', () => {
    const { loaded, profiled } = build('profile-run-ok');
    const run = runMigration({
      inputRoot: join(FIXTURES, 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: caseScratch('profile-run-ok-run'),
      sourceProfile: profiled,
    });
    assert.equal(run.truth.sourceProfileHash, profiled.profileHash);
    assert.equal(run.reconciliation.sourceRows.equationHolds, true);
  });

  it('refuses a profile built over different bytes', () => {
    // A row added after the profile was built. The plan was compiled against a
    // dataset that no longer exists, and a decision made about data that is not
    // there is the thing this refusal exists to prevent.
    const changed = scratchDir('profile', 'stale');
    copyFileSync(join(FIXTURES, 'input', 'contacts.csv'), join(changed, 'contacts.csv'));
    const { loaded, profiled } = build('profile-run-stale', changed);
    appendFileSync(join(changed, 'contacts.csv'), '4,Edsger,Dijkstra,edsger@example.com,Engineer\n');

    assert.throws(
      () =>
        runMigration({
          inputRoot: changed,
          config: loaded.config,
          configHash: loaded.configHash,
          scratch: caseScratch('profile-run-stale-run'),
          sourceProfile: profiled,
        }),
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'INPUT_CORRUPT' &&
        error.message.includes('describes bundle'),
    );
  });

  it('refuses a profile whose file digest disagrees, even where the bundle id is forced to match', () => {
    // The bundle id is derived from the digests, so the two normally move
    // together. Forcing one to agree and leaving the other wrong is what a
    // tampered profile would look like, and the per-file comparison is what
    // catches it.
    const { loaded, profiled } = build('profile-run-forged');
    const forged = {
      profile: {
        ...profiled.profile,
        files: profiled.profile.files.map((file) => ({ ...file, sha256: 'f'.repeat(64) })),
      },
      profileHash: profiled.profileHash,
    };
    // Named honestly after the forgery, so that what is exercised here is the
    // per-file comparison and not the digest check that now runs before it
    // (mc3-reopen-runtime covers a profile whose hash is stale).
    const forgedBody = { ...forged.profile, bundleId: profiled.profile.bundleId };
    const rehashed = { profile: forgedBody, profileHash: hashSourceProfile(forgedBody) };

    // The per-file comparison itself, given the facts the run derives (the
    // genuine profile agrees with the run about them, see below).
    assert.throws(
      () =>
        assertProfileDescribesBundle(
          rehashed,
          profiled.profile.bundleId,
          profiled.profile.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
          loaded.config,
        ),
      (error: unknown) =>
        isMigrationError(error) && error.code === 'INPUT_CORRUPT' && error.message.includes('a different'),
    );
    // And through the engine boundary, where such a profile is refused before
    // the source is opened: a bundle id that does not derive from the files it
    // lists breaks the profile invariants (MC-03).
    assert.throws(
      () =>
        runMigration({
          inputRoot: join(FIXTURES, 'input'),
          config: loaded.config,
          configHash: loaded.configHash,
          scratch: caseScratch('profile-run-forged-run'),
          sourceProfile: rehashed,
        }),
      (error: unknown) => isMigrationError(error) && error.code === 'SOURCE_PROFILE_INVALID',
    );
  });

  it('refuses a profile that describes a file this run did not read', () => {
    // The other direction of the inventory. A profile of more files than the
    // run reads was compiled against data the run never saw, and it used to
    // pass because only the run's files were looked up in the profile.
    const { loaded, profiled } = build('profile-run-extra');
    const file = profiled.profile.files[0];
    assert.ok(file !== undefined);
    const extra = { ...file, path: 'other.csv', sha256: 'a'.repeat(64), fileId: `F-${'a'.repeat(12)}` };
    const widerBody = {
      ...profiled.profile,
      files: [file, extra],
      readConfig: {
        ...profiled.profile.readConfig,
        files: [...profiled.profile.readConfig.files, { path: 'other.csv', format: 'CSV', encoding: null, delimiter: null, sheets: null }],
      },
    };
    // Named honestly, so the inventory comparison is what refuses it rather
    // than the digest check that now runs first.
    const wider = { profile: widerBody, profileHash: hashSourceProfile(widerBody) };
    assert.throws(
      () =>
        assertProfileDescribesBundle(
          wider,
          profiled.profile.bundleId,
          profiled.profile.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
          loaded.config,
        ),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT' && error.message.includes('did not read'),
    );
    // Through the engine boundary the same profile is refused before the
    // source is opened: its bundle id and file ids do not derive from the
    // files it lists (MC-03).
    assert.throws(
      () =>
        runMigration({
          inputRoot: join(FIXTURES, 'input'),
          config: loaded.config,
          configHash: loaded.configHash,
          scratch: caseScratch('profile-run-extra-run'),
          sourceProfile: wider,
        }),
      (error: unknown) => isMigrationError(error) && error.code === 'SOURCE_PROFILE_INVALID',
    );
  });

  it('refuses a profile built under a different reading of the same bytes', () => {
    const { loaded, profiled } = build('profile-run-reading');
    const differentReadingBody = {
      ...profiled.profile,
      readConfig: { ...profiled.profile.readConfig, formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' as const },
    };
    // Named honestly, so the reading comparison is what refuses it rather than
    // the digest check that now runs first.
    const differentReading = { profile: differentReadingBody, profileHash: hashSourceProfile(differentReadingBody) };
    assert.throws(
      () =>
        runMigration({
          inputRoot: join(FIXTURES, 'input'),
          config: loaded.config,
          configHash: loaded.configHash,
          scratch: caseScratch('profile-run-reading-run'),
          sourceProfile: differentReading,
        }),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT' && error.message.includes('different reading'),
    );
  });

  it('runs without one, and says so rather than implying a profile it never saw', () => {
    const { loaded } = build('profile-run-absent');
    const run = runMigration({
      inputRoot: join(FIXTURES, 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: caseScratch('profile-run-absent-run'),
    });
    assert.equal(run.truth.sourceProfileHash, null);
  });
});

describe('the profile and the run read the same bytes the same way', () => {
  it('agrees with the run about every sheet', () => {
    // The point of one reader. If the profile and the execution disagreed about
    // how many rows a sheet holds, the plan would have been written against one
    // interpretation and carried out against another.
    const { loaded, profiled } = build('profile-agrees');
    const run = runMigration({
      inputRoot: join(FIXTURES, 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: caseScratch('profile-agrees-run'),
      sourceProfile: profiled,
    });

    const fromProfile = profiled.profile.files.flatMap((file) =>
      file.sheets.map((sheet) =>
        [file.path, sheet.sheetId, sheet.dataRowCount, sheet.rejectedRowCount, sheet.columnCount, file.sha256].join('|'),
      ),
    );
    const fromRun = run.truth.sourceFiles.flatMap((file) =>
      file.sheets.map((sheet) =>
        [file.path, sheet.sheetId, sheet.dataRowCount, sheet.rejectedRowCount, sheet.columnCount, file.sha256].join('|'),
      ),
    );
    assert.deepEqual(fromProfile.sort(), fromRun.sort());
  });

  it('writes a profile a host can keep', () => {
    const { profiled } = build('profile-writeable');
    const out = scratchDir('profile', 'written');
    mkdirSync(out, { recursive: true });
    const path = join(out, 'profile.json');
    writeFileSync(path, serializeSourceProfile(profiled));
    const reloaded = loadSourceProfile(readFileSync(path, 'utf8'), path);
    assert.equal(reloaded.profileHash, profiled.profileHash);
  });
});

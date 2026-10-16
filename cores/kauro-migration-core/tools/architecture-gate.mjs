#!/usr/bin/env node
/**
 * ARCHITECTURE-01 — the MC-1 architecture gate.
 *
 * Answers one question: is the bounded, deterministic architecture the canonical
 * document specifies actually in this tree?
 *
 * Every fact below is derived by doing something — running both readers over the
 * same bytes and comparing what they saw, sorting the same records at different
 * run sizes and comparing the output, counting how many times a check touches the
 * lineage, breaking a package write on purpose and looking at what survives.
 * None of them is a search for a word in a file, and none of them is a constant
 * this repository sets about itself. A gate that reads its own claims is a gate
 * that passes whenever somebody writes the claim down.
 *
 * The output is machine-readable on stdout and a table on stderr. It exits
 * non-zero when MIGRATION_CORE_ARCHITECTURE_CLOSED is not TRUE, which is the
 * point: the value is computed, never declared.
 *
 *   node tools/architecture-gate.mjs             run the gate
 *   node tools/architecture-gate.mjs --json      machine output only
 *   node tools/architecture-gate.mjs --self-test prove the gate can say FALSE
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { VERSION_FLOORS, semverAtLeast, versionFloorProblems } from './version-floors.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(repoRoot, 'dist', 'src');
const scratchRoot = join(repoRoot, 'tmp', 'architecture-gate');

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const selfTest = args.includes('--self-test');

if (!existsSync(dist)) {
  process.stderr.write('dist/src does not exist. Run "npm run build" first.\n');
  process.exit(1);
}

const facts = [];

/**
 * @param {string} name
 * @param {boolean|string} value
 * @param {string} derivation how the value was obtained, not what it means
 * @param {string} detail what was actually observed
 */
function fact(name, value, derivation, detail) {
  facts.push({ name, value, derivation, detail });
  return value;
}

function failed(name, error) {
  return fact(name, false, 'EXECUTED', `the derivation could not complete: ${String(error && error.message ? error.message : error)}`);
}

function freshDir(name) {
  const dir = join(scratchRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Bumped when the self-test rewrites a compiled module, because an ES module is
// cached by URL and a re-import of the same specifier would hand back the copy
// that was loaded before the sabotage.
let generation = 0;

async function load(relative) {
  const url = new URL(`../dist/src/${relative}`, import.meta.url);
  url.search = `g=${String(generation)}`;
  return import(url.href);
}

async function maybeLoad(relative) {
  try {
    return await load(relative);
  } catch {
    return null;
  }
}

const { attestationInputFor, attestExistingContract } = await import(new URL('qualification-attestation.mjs', import.meta.url).href);

const FIXTURES = join(repoRoot, 'test', 'fixtures');

/**
 * Somewhere for a run to spill, for the length of one derivation.
 *
 * The gate is a host like any other, so it says where scratch goes rather than
 * letting the engine choose. Each derivation gets its own directory so nothing
 * one measurement writes can be read by another.
 */
async function gateScratch(name) {
  const { createFilesystemScratchStore } = await load('scratch/filesystem-scratch-store.js');
  const { SCRATCH_BUDGET_BYTES } = await load('domain/resource-profile.js');
  return createFilesystemScratchStore({
    root: freshDir(`store-${name}`),
    runId: 'gate',
    // The founding budget, in bytes. The gate used to hand out two gibibytes,
    // which is a number nothing declares: a run that spills what the canonical
    // document allows it to spill was refused by the probe rather than
    // measured, and the fact read as a verdict about memory.
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
}

function readConfig(path) {
  return readFileSync(path, 'utf8');
}

// --------------------------------------------------------------------------
// A. one reader, consulted by profiling and by execution
// --------------------------------------------------------------------------
async function commonSourceReader() {
  const name = 'common_source_reader';
  try {
    const { inspectBundle } = await load('profile/inspect.js');
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');

    const configPath = join(FIXTURES, 'value-intent', 'clean-only.json');
    const inputRoot = join(FIXTURES, 'value-intent', 'input');
    const loaded = loadConfig(readConfig(configPath), configPath);

    const profile = inspectBundle({ inputRoot });
    const run = runMigration({
      inputRoot,
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: await gateScratch('reader'),
    });

    // The same bytes, read twice by two entry points. If they disagree about how
    // many rows a sheet holds, how many columns it has, or what the file hashes
    // to, then the plan is being written against one interpretation and executed
    // against another.
    const fromProfile = [];
    for (const file of profile.files) {
      for (const sheet of file.sheets) {
        fromProfile.push(`${file.path}|${sheet.sheetId}|${sheet.dataRows}|${sheet.rejectedRows}|${sheet.columns.length}|${file.sha256}`);
      }
    }
    const fromRun = [];
    for (const file of run.truth.sourceFiles) {
      for (const sheet of file.sheets) {
        fromRun.push(`${file.path}|${sheet.sheetId}|${sheet.dataRowCount}|${sheet.rejectedRowCount}|${sheet.columnCount}|${file.sha256}`);
      }
    }
    fromProfile.sort();
    fromRun.sort();

    const agree = JSON.stringify(fromProfile) === JSON.stringify(fromRun) && fromProfile.length > 0;
    return fact(
      name,
      agree,
      'EXECUTED',
      agree
        ? `inspect and run agree on all ${String(fromProfile.length)} sheets: rows, rejections, columns and file digest`
        : `inspect saw ${JSON.stringify(fromProfile)} and run saw ${JSON.stringify(fromRun)}`,
    );
  } catch (error) {
    return failed(name, error);
  }
}

// --------------------------------------------------------------------------
// B. a versioned, hashable profile bound to the run
// --------------------------------------------------------------------------
/**
 * Is a run bound to a reading of its source, and does the binding hold?
 *
 * A hash present on a run proves nothing on its own — a field can be filled in.
 * What makes the binding real is that a profile describing different bytes is
 * refused, so the derivation supplies one and checks that the run stops. A
 * profile the run would accept whatever it described would be a label, not a
 * binding.
 */
async function sourceProfileBound() {
  const name = 'source_profile_v1_bound';
  const module = await maybeLoad('profile/source-profile.js');
  if (module === null) {
    return fact(name, false, 'MODULE_ABSENT', 'no SourceProfileV1 contract module exists; profiling still produces an unversioned, unhashed report');
  }
  // A floor, not an equality.
  //
  // This asked for exactly 1.0.0, which is the defect tools/versions.mjs was
  // written to remove: a deliberate bump of the contract fails the architecture
  // gate for a reason that has nothing to do with the architecture, and the
  // remedy an operator reaches for is to put the old number back.
  const profileFloor = VERSION_FLOORS.sourceProfileVersion;
  if (!semverAtLeast(String(module.SOURCE_PROFILE_VERSION), profileFloor)) {
    return fact(
      name,
      false,
      'EXECUTED',
      `SOURCE_PROFILE_VERSION is ${String(module.SOURCE_PROFILE_VERSION)}, below the declared floor of ${profileFloor}`,
    );
  }
  try {
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const configPath = join(FIXTURES, 'value-intent', 'clean-only.json');
    const inputRoot = join(FIXTURES, 'value-intent', 'input');
    const loaded = loadConfig(readConfig(configPath), configPath);

    const profiled = module.buildSourceProfile({
      inputRoot,
      config: loaded.config,
      scratch: await gateScratch('profile-build'),
    });
    const hashed = typeof profiled.profileHash === 'string' && profiled.profileHash.length === 64;

    // The same bytes profile to the same hash, or the hash is not a name for
    // anything.
    const again = module.buildSourceProfile({
      inputRoot,
      config: loaded.config,
      scratch: await gateScratch('profile-build-again'),
    });
    const stable = again.profileHash === profiled.profileHash;

    const run = runMigration({
      inputRoot,
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: await gateScratch('profile-run'),
      sourceProfile: profiled,
    });
    const bound = run.truth.sourceProfileHash === profiled.profileHash;

    // A profile about a different bundle. The run has to stop before it
    // interprets anything — and it has two ways to be wrong. A body edited
    // under the old digest is refused at the boundary as a profile that does
    // not hash to what it claims (MC-03). A genuine profile of another bundle
    // — the same configuration profiled over different bytes — is refused by
    // the bundle comparison. Both must stop the run; neither may reach the
    // source. The bundle id is derived from the files a profile lists, so
    // "another bundle" has to be another bundle, not an edited id.
    let refusedForged = false;
    try {
      runMigration({
        inputRoot,
        config: loaded.config,
        configHash: loaded.configHash,
        scratch: await gateScratch('profile-run-forged'),
        sourceProfile: { profile: { ...profiled.profile, capturedAt: '1999-01-01T00:00:00Z' }, profileHash: profiled.profileHash },
      });
    } catch (error) {
      refusedForged = Boolean(error) && error.code === 'SOURCE_PROFILE_INVALID';
    }
    let refusedOtherBundle = false;
    {
      const otherRoot = join(freshDir('profile-other-bundle'), 'input');
      mkdirSync(otherRoot, { recursive: true });
      for (const entry of readdirSync(inputRoot)) {
        const bytes = readFileSync(join(inputRoot, entry));
        writeFileSync(join(otherRoot, entry), entry.endsWith('.csv') ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes);
      }
      const otherProfile = module.buildSourceProfile({ inputRoot: otherRoot, config: loaded.config, scratch: await gateScratch('profile-other-build') });
      try {
        runMigration({
          inputRoot,
          config: loaded.config,
          configHash: loaded.configHash,
          scratch: await gateScratch('profile-run-stale'),
          sourceProfile: otherProfile,
        });
      } catch (error) {
        refusedOtherBundle = Boolean(error) && error.code === 'INPUT_CORRUPT';
      }
    }
    const refusedStale = refusedForged && refusedOtherBundle;

    const value = hashed && stable && bound && refusedStale;
    return fact(
      name,
      value,
      'EXECUTED',
      value
        ? 'the profile is versioned at 1.0.0, hashes the same for the same bytes, is recorded on the run, and a profile describing another bundle is refused before anything is interpreted'
        : `hashed=${String(hashed)} stableAcrossRuns=${String(stable)} recordedOnTheRun=${String(bound)} refusesAForgedProfile=${String(refusedForged)} refusesAnotherBundle=${String(refusedOtherBundle)}`,
    );
  } catch (error) {
    return failed(name, error);
  }
}

// --------------------------------------------------------------------------
// C. what a finished run is still holding
// --------------------------------------------------------------------------
/**
 * What a run holds, and what it needs to hold.
 *
 * Two questions, and the second is the one that matters. Whether the finished
 * result still points at decoded source rows is a structural fact and easy to
 * check. Whether the run *needed* the whole dataset in memory while it worked is
 * a measurement, and it is the one the canonical memory contract is about — an
 * engine that hands nothing back but peaked at the size of its input has not
 * become bounded, it has become tidy.
 *
 * So the second is measured the only way that cannot argue with itself: a fresh
 * process is given a heap smaller than the source it has to migrate. Nothing is
 * inferred from a sampled number.
 */
async function runRetention() {
  let bundleRetained = null;
  let arraysUnbounded = null;
  try {
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const configPath = join(FIXTURES, 'value-intent', 'clean-only.json');
    const loaded = loadConfig(readConfig(configPath), configPath);
    const run = runMigration({
      inputRoot: join(FIXTURES, 'value-intent', 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: await gateScratch('retention'),
    });

    // Counted on the object the run hands back, after it has finished. Anything
    // row-scale still reachable from here is something the process carries for
    // as long as the caller holds the result.
    let retainedRows = 0;
    const bundle = run.bundle;
    if (bundle && Array.isArray(bundle.files)) {
      for (const file of bundle.files) {
        for (const sheet of file.sheets ?? []) {
          retainedRows += (sheet.rows ?? []).length + (sheet.rejectedRows ?? []).length;
        }
      }
    }

    const heapMib = 192;
    // One fewer than the row limit, because the header is a record too: a file
    // of 250,000 data rows is 250,001 records and the reader refuses it. The
    // probe was failing on that limit, and a limit is not a measurement.
    const rows = 249_999;
    const probe = join(repoRoot, 'tools', 'run-memory-probe.mjs');
    const built = buildProbeInput(rows);
    const measured = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${String(heapMib)}`,
        probe,
        built.inputDir,
        built.configPath,
        freshDir('retention-probe-work'),
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 1_800_000 },
    );
    const sourceMib = Math.round(built.bytes / (1024 * 1024));
    const survivedTheHeap = measured.status === 0;
    // Exit 1 is the probe saying the migration failed for a reason that is not
    // memory. Reading that as "needed more heap" would be a measurement nobody
    // took, so it is reported as what it is.
    const couldNotAnswer = measured.status === 1;
    const why = (measured.stderr || measured.stdout || "").trim().split("\n").slice(-1)[0] ?? "";

    bundleRetained = retainedRows > 0 || !survivedTheHeap;
    fact(
      'run_whole_bundle_retention',
      bundleRetained,
      'MEASURED',
      retainedRows > 0
        ? `the finished run still holds ${String(retainedRows)} decoded source rows on its result`
        : survivedTheHeap
          ? `the result holds no decoded source rows, and a ${String(sourceMib)} MiB source migrated in a process limited to a ${String(heapMib)} MiB heap`
          : couldNotAnswer
            ? `the retention probe could not run, so nothing was measured: ${why}`
            : `the result holds no decoded source rows, but migrating a ${String(sourceMib)} MiB source needed more than a ${String(heapMib)} MiB heap, so the run still carries its input rather than reading it`,
    );

    const rowScale = ['lineage', 'changes', 'flags', 'unmappedFields', 'isolated', 'leftovers', 'rejected', 'edges', 'deliveredRecords', 'formulaRisks'];
    const materialised = rowScale.filter((family) => Array.isArray(run.truth[family]));
    // Not an array is necessary and not sufficient: a family has to be readable
    // more than once and know how many facts it holds, or nothing downstream
    // could use it without collecting it anyway.
    const walkable = rowScale.filter((family) => {
      const value = run.truth[family];
      if (value === undefined || Array.isArray(value)) return false;
      if (typeof value.count !== 'number') return false;
      const first = [...value].length;
      const second = [...value].length;
      return first === value.count && second === value.count;
    });
    arraysUnbounded = materialised.length > 0 || walkable.length !== rowScale.length;
    fact(
      'run_truth_arrays_unbounded',
      arraysUnbounded,
      'EXECUTED',
      arraysUnbounded
        ? `${String(materialised.length)} of ${String(rowScale.length)} row-scale families are plain arrays held whole${materialised.length > 0 ? `: ${materialised.join(', ')}` : ''}; ${String(walkable.length)} of ${String(rowScale.length)} can be walked twice and agree with their own count`
        : `all ${String(rowScale.length)} row-scale families are spilled: none is an array, each knows its count, and each yields exactly that many facts on every walk`,
    );
  } catch (error) {
    if (bundleRetained === null) failed('run_whole_bundle_retention', error);
    if (arraysUnbounded === null) failed('run_truth_arrays_unbounded', error);
  }
}

/**
 * A source large enough that holding it would show, with relationships in it.
 *
 * Contacts referencing companies, because a run that reads its source in
 * blocks and spills every family can still fall over on an index of every
 * record built to resolve endpoints. A probe with no associations would not
 * ask that question, and the answer would look better than it was.
 *
 * Written in blocks so building the probe's input is not itself the largest
 * thing this process holds.
 */
function buildProbeInput(rows) {
  const inputDir = freshDir('retention-probe-input');

  // One company for every hundred contacts, each referenced by the hundred
  // contacts that name it: a hundred relationships per company is a graph
  // dense enough to tension the joins that resolve them.
  const companies = Math.max(1, Math.floor(rows / 100));
  const companiesPath = join(inputDir, 'companies.csv');
  writeFileSync(companiesPath, 'Company ID,Name,Domain\n');
  {
    let block = [];
    for (let index = 0; index < companies; index += 1) {
      block.push(`A-${String(index)},Company ${String(index)},company${String(index)}.example\n`);
      if (block.length >= 5000) {
        appendFileSync(companiesPath, block.join(''));
        block = [];
      }
    }
    if (block.length > 0) appendFileSync(companiesPath, block.join(''));
  }

  const csvPath = join(inputDir, 'contacts.csv');
  writeFileSync(csvPath, 'Contact ID,First Name,Last Name,Email,Job Title,Company ID\n');
  let bytes = 0;
  let block = [];
  for (let index = 0; index < rows; index += 1) {
    const line = `${String(index)},First${String(index)},Last${String(index)},person${String(index)}@example.com,Title ${String(index)} with enough text on it that the source is measured in hundreds of megabytes rather than tens,A-${String(index % companies)}\n`;
    bytes += line.length;
    block.push(line);
    if (block.length >= 5000) {
      appendFileSync(csvPath, block.join(''));
      block = [];
    }
  }
  if (block.length > 0) appendFileSync(csvPath, block.join(''));

  // The configuration that maps them, written beside the input: the
  // value-intent fixture describes one file and this probe needs two and a
  // relationship between them.
  const configPath = join(inputDir, 'probe-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: '3.0.0',
      source: { system: 'probe', namespace: 'retention' },
      target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
      limits: {
        maxFiles: 50,
        maxBytesPerFile: 4_294_967_296,
        maxTotalBytes: 17_179_869_184,
        maxSheetsPerFile: 25,
        maxRowsPerSheet: 2_000_000,
        maxColumnsPerSheet: 1_000,
        maxCellLength: 65_536,
        maxWorkbookUncompressedBytes: 268_435_456,
      },
      files: [
        { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
        { id: 'companies', path: 'companies.csv', format: 'CSV' },
      ],
      records: [
        {
          id: 'contacts',
          fileId: 'contacts',
          object: 'CONTACT',
          sourceRecordIdColumn: { header: 'Contact ID' },
          fields: [
            { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
            { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
            { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
            { column: { header: 'Job Title' }, destinationField: 'contact.jobTitle', semanticType: 'TEXT' },
          ],
        },
        {
          id: 'companies',
          fileId: 'companies',
          object: 'COMPANY',
          sourceRecordIdColumn: { header: 'Company ID' },
          fields: [
            { column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' },
            { column: { header: 'Domain' }, destinationField: 'company.domain', semanticType: 'TEXT' },
          ],
        },
      ],
      associations: [
        {
          id: 'contact-company',
          kind: 'COLUMN_REFERENCE',
          recordMappingId: 'contacts',
          relationshipType: 'CONTACT_TO_COMPANY',
          keyColumn: { header: 'Company ID' },
          targetRecordMappingId: 'companies',
          targetMatchKey: 'SOURCE_RECORD_ID',
        },
      ],
    }),
  );

  return { inputDir, configPath, bytes };
}

// --------------------------------------------------------------------------
// C/D. scratch, and a sort whose output does not depend on how it was run
// --------------------------------------------------------------------------
async function scratchContract() {
  const name = 'scratch_contract_version';
  try {
    const { SCRATCH_STORE_CONTRACT_VERSION } = await load('scratch/scratch-store.js');
    const { createFilesystemScratchStore } = await load('scratch/filesystem-scratch-store.js');

    // Exercised rather than read: a version constant with no working store
    // behind it would be the kind of self-certification this gate exists to
    // refuse.
    const store = createFilesystemScratchStore({
      root: freshDir('scratch-contract'),
      runId: 'gate',
      quotaBytes: 8 * 1024 * 1024,
    });
    let observed;
    try {
      const writer = store.createSegment({ schema: 'gate', schemaVersion: '1.0.0', sorted: true });
      writer.append('a', 'k1');
      writer.append('b', 'k2');
      const manifest = writer.seal();
      const readBack = [...store.readLines(manifest.segmentId)];
      observed =
        readBack.join(',') === 'a,b' &&
        manifest.rowCount === 2 &&
        manifest.firstKey === 'k1' &&
        manifest.lastKey === 'k2' &&
        manifest.sha256.length === 64;
    } finally {
      store.dispose();
    }

    // The floor again, for the same reason: the header of tools/versions.mjs
    // records that this exact-equality is what made a deliberate contract bump
    // fail a gate about something else.
    const scratchFloor = VERSION_FLOORS.scratchStoreContractVersion;
    const atFloor = semverAtLeast(String(SCRATCH_STORE_CONTRACT_VERSION), scratchFloor);
    const value = atFloor && observed;
    return fact(
      name,
      value ? String(SCRATCH_STORE_CONTRACT_VERSION) : String(SCRATCH_STORE_CONTRACT_VERSION),
      'EXECUTED',
      value
        ? `a segment round-tripped with a verified manifest, and the contract reports ${String(SCRATCH_STORE_CONTRACT_VERSION)}`
        : atFloor
          ? 'the store did not round-trip a segment'
          : `the scratch contract is ${String(SCRATCH_STORE_CONTRACT_VERSION)}, below the declared floor of ${scratchFloor}`,
    );
  } catch (error) {
    failed(name, error);
    return 'absent';
  }
}

async function sortDeterminism() {
  const name = 'external_sort_join_deterministic';
  try {
    const { externalSort, readSorted } = await load('scratch/external-sort.js');
    const { createFilesystemScratchStore } = await load('scratch/filesystem-scratch-store.js');

    // Deliberately full of ties: equal keys are where a sort that is merely
    // correct stops being reproducible.
    const input = Array.from({ length: 600 }, (_, index) => ({
      key: `k${String(index % 7)}`,
      payload: `p${String(index)}`,
    }));

    const outputs = [];
    for (const shape of [
      { runSize: 1, fanIn: 2 },
      { runSize: 11, fanIn: 3 },
      { runSize: 64, fanIn: 2 },
      { runSize: 600, fanIn: 8 },
      { runSize: 5000, fanIn: 16 },
    ]) {
      const store = createFilesystemScratchStore({
        root: freshDir(`sort-${String(shape.runSize)}-${String(shape.fanIn)}`),
        runId: 'gate',
        quotaBytes: 64 * 1024 * 1024,
      });
      try {
        const result = externalSort(input, {
          store,
          schema: 'gate',
          schemaVersion: '1.0.0',
          runSize: shape.runSize,
          fanIn: shape.fanIn,
          key: (item) => item.key,
          encode: (item) => JSON.stringify(item),
          decode: (line) => JSON.parse(line),
        });
        outputs.push(JSON.stringify([...readSorted(store, result.segmentId, (line) => JSON.parse(line))]));
      } finally {
        store.dispose();
      }
    }

    const identical = outputs.every((output) => output === outputs[0]);
    const stable = outputs[0] === JSON.stringify(
      input
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : a.index - b.index))
        .map((entry) => entry.item),
    );
    const value = identical && stable;
    return fact(
      name,
      value,
      'EXECUTED',
      value
        ? '600 records with 7 distinct keys sorted identically at run sizes 1 to 5000 and fan-ins 2 to 16, and match a materialised stable sort'
        : identical
          ? 'the sort is self-consistent but disagrees with a materialised stable sort'
          : 'the output changed with the run size, so it depends on how much memory the machine had',
    );
  } catch (error) {
    return failed(name, error);
  }
}

// --------------------------------------------------------------------------
// D. no quadratic path in the soundness check
// --------------------------------------------------------------------------
async function reconciliationComplexity() {
  const name = 'reconciliation_quadratic_path';
  try {
    const { assertReconciliationSound, computeReconciliation } = await load('reconcile/reconcile.js');

    const build = (rows) => {
      const address = (rowNumber) => ({
        bundleId: 'B',
        fileId: 'F',
        fileSha256: 'a'.repeat(64),
        filePath: 'c.csv',
        sheetId: 'S0',
        sheetName: null,
        rowNumberSource: rowNumber,
        rowLocatorId: `F:S0:R${String(rowNumber)}`,
        rowHash: 'b'.repeat(64),
      });
      const lineage = Array.from({ length: rows }, (_, index) => ({
        address: address(index + 2),
        contributionKind: 'NONE',
        disposition: 'LEFTOVER',
        reasonCode: 'LEFTOVER_NO_RECORD_MAPPING',
        detail: 'gate',
        recordMappingId: null,
        object: null,
        sourceSystem: null,
        sourceNamespace: null,
        sourceRecordId: null,
        identityKey: null,
        recordIdentityKey: null,
        migrationKey: null,
        mergeId: null,
      }));
      const family = (items) => ({
        count: items.length,
        [Symbol.iterator]: () => items[Symbol.iterator](),
      });
      return {
        coreVersion: '0', bundleId: 'B', runId: 'r', configHash: 'c'.repeat(64),
        mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY', targetContractHash: null,
        destinationMatching: [],
        sourceFiles: [{
          fileId: 'F', path: 'c.csv', sha256: 'a'.repeat(64), byteLength: 1, format: 'CSV',
          encoding: 'UTF8', encodingEvidence: 'UTF8_VALIDATED',
          sheets: [{ sheetId: 'S0', sheetName: null, hidden: false, columnCount: 1, readerRowCount: rows, dataRowCount: rows, rejectedRowCount: 0, evidence: [] }],
        }],
        lineage: family(lineage),
        changes: family([]), flags: family([]), unmappedFields: family([]), isolated: family([]),
        leftovers: family(
          lineage.map((entry) => ({ address: entry.address, reasonCode: 'LEFTOVER_NO_RECORD_MAPPING', detail: 'gate' })),
        ),
        rejected: family([]), merges: [], duplicateCandidates: [], edges: family([]), edgeCandidateCount: 0,
        destinationConflicts: [], instanceVerification: [], deliveredRecords: family([]), formulaRisks: family([]),
      };
    };

    // Counted, not timed. Every row is also an exception, so a check that
    // searches the lineage once per exception reads about rows squared.
    const measure = async (rows) => {
      const truth = build(rows);
      const reconciliation = computeReconciliation(truth);
      let reads = 0;
      const counted = {
        count: truth.lineage.count,
        *[Symbol.iterator]() {
          for (const entry of truth.lineage) {
            reads += 1;
            yield entry;
          }
        },
      };
      const store = await gateScratch(`complexity-${String(rows)}`);
      try {
        assertReconciliationSound({ ...truth, lineage: counted }, reconciliation, store);
      } finally {
        store.dispose();
      }
      return reads;
    };

    const small = await measure(200);
    const large = await measure(400);
    // Linear work doubles when the input doubles; quadratic work quadruples.
    const growth = small === 0 ? Infinity : large / small;
    const quadratic = growth > 2.5;
    return fact(
      name,
      quadratic,
      'INSTRUMENTED',
      `doubling the rows took the soundness check from ${String(small)} to ${String(large)} lineage reads, a factor of ${growth.toFixed(2)}`,
    );
  } catch (error) {
    return failed(name, error);
  }
}

// --------------------------------------------------------------------------
// E. value semantics, end to end
// --------------------------------------------------------------------------
async function valueIntent() {
  const nameEndToEnd = 'value_intent_end_to_end';
  const nameBlank = 'hubspot_blank_clear_is_not_emitted';
  try {
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const { writePackage, writeAndPromotePackage } = await load('artifacts/write-package.js');
    const { getAdapter } = await load('adapters/specs.js');
    const { hashTargetContract } = await load('target/contract.js');

    const inputRoot = join(FIXTURES, 'value-intent', 'input');

    // CLEAN_ONLY: all four intents have to arrive distinguishable in the file.
    const cleanPath = join(FIXTURES, 'value-intent', 'clean-only.json');
    const clean = loadConfig(readConfig(cleanPath), cleanPath);
    const cleanRun = runMigration({
      inputRoot,
      config: clean.config,
      configHash: clean.configHash,
      scratch: await gateScratch('value-intent-clean'),
    });
    const cleanDir = freshDir('value-intent-clean');
    writeAndPromotePackage({ result: cleanRun, config: clean.config, normalizedConfig: clean.normalizedJson, outputDir: cleanDir, force: true });

    const representation = getAdapter('CLEAN_ONLY').clearRepresentation;
    const token = representation.kind === 'EXPLICIT_TOKEN' ? representation.token : null;
    const importFile = readFileSync(join(cleanDir, '01_IMPORT', 'clean-only', 'contacts.csv'), 'utf8');
    const lines = importFile.trim().split('\n');
    const header = lines[0].split(',');
    const jobTitle = header.indexOf('contact.jobTitle');
    const cells = lines.slice(1).map((line) => line.split(',')[jobTitle]);

    const cleared = cells.filter((cell) => cell === token).length;
    const blank = cells.filter((cell) => cell === '').length;
    const held = cells.filter((cell) => cell !== token && cell !== '').length;
    const distinguishable = token !== null && cleared === 1 && blank === 1 && held === 1;

    fact(
      nameEndToEnd,
      distinguishable,
      'EXECUTED',
      distinguishable
        ? `the one authorized clear, the one blank source cell and the one held value reach the artifact as three different things (${String(token)}, empty, value)`
        : `the artifact holds ${String(cleared)} clears, ${String(blank)} blanks and ${String(held)} values, so the three source states are not distinguishable`,
    );

    // HubSpot on an update: a clear it cannot express must not become a blank.
    const hsPath = join(FIXTURES, 'value-intent', 'hubspot-update.json');
    const hs = loadConfig(readConfig(hsPath), hsPath);
    const contract = hashTargetContract({
      contractVersion: '1.0.0', parserVersion: '1.0.0', capturedAt: '2026-09-01T00:00:00Z',
      instance: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'gate', evidence: 'ARTIFACT' },
      artifacts: [{ path: 'describe/Contact.json', sha256: 'a'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
      objects: [{
        apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [],
        fields: [{
          apiName: 'email', label: 'Email', type: 'string', createable: 'TRUE', updateable: 'TRUE',
          nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'TRUE', externalId: 'FALSE',
          idLookup: 'TRUE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
          restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT',
        },
        // Destination validation reads the contract (MC-04): the plan delivers
        // these three fields as well, and an instance that lacked them would
        // refuse the run rather than exercise what this fact is about.
        ...[['firstname', 'First name'], ['lastname', 'Last name'], ['jobtitle', 'Job title']].map(([apiName, label]) => ({
          apiName, label, type: 'string', createable: 'TRUE', updateable: 'TRUE',
          nillable: 'TRUE', length: null, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE',
          idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
          restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT',
        }))],
      }],
      pipelines: [],
    });
    const hsRun = runMigration({
      inputRoot,
      config: hs.config,
      configHash: hs.configHash,
      targetContract: contract,
      // The mode makes attestation REQUIRED, so the gate attests, like any host.
      ...attestExistingContract(contract),
      scratch: await gateScratch('value-intent-hubspot'),
    });
    const hsDir = freshDir('value-intent-hubspot');
    writeAndPromotePackage({ result: hsRun, config: hs.config, normalizedConfig: hs.normalizedJson, outputDir: hsDir, force: true });

    const refused = [...hsRun.truth.isolated].filter((entry) => entry.reasonCode === 'TARGET_CLEAR_NOT_REPRESENTABLE');
    const hsFile = readFileSync(join(hsDir, '01_IMPORT', 'hubspot', 'contacts.csv'), 'utf8');
    const deliveredAda = hsFile.includes('ada@example.com');
    const value = refused.length === 1 && !deliveredAda;
    fact(
      nameBlank,
      value,
      'EXECUTED',
      value
        ? 'the record whose clear HubSpot cannot express is set aside, and no blank cell is shipped in its place'
        : `${String(refused.length)} records were refused and the record whose clear cannot be carried out ${deliveredAda ? 'was still delivered' : 'was not delivered'}`,
    );
  } catch (error) {
    // Recorded once each. A derivation that half-succeeded and then threw used
    // to report the same fact twice, and a table with one name in it twice is a
    // table a reader cannot act on.
    if (!facts.some((entry) => entry.name === nameEndToEnd)) failed(nameEndToEnd, error);
    if (!facts.some((entry) => entry.name === nameBlank)) failed(nameBlank, error);
  }
}

// --------------------------------------------------------------------------
// F. an attestation the core did not issue to itself
// --------------------------------------------------------------------------
async function attestation() {
  const name = 'target_attestation_verified';
  const module = await maybeLoad('target/attestation.js');
  if (module === null) {
    return fact(
      name,
      false,
      'MODULE_ABSENT',
      'no external attestation seam exists; a target contract carries no issuer, no signature and no key material the core verifies offline',
    );
  }
  const required = ['verifyAttestation', 'attestationSigningBytes', 'ATTESTATION_CONTRACT_VERSION'];
  const missing = required.filter((exported) => typeof module[exported] === 'undefined');
  if (missing.length > 0) {
    return fact(name, false, 'EXECUTED', `the attestation module does not export ${missing.join(', ')}`);
  }
  try {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const named = generateKeyPairSync('ed25519');
    const unnamed = generateKeyPairSync('ed25519');
    const authority = {
      issuerId: 'gate:issuer',
      keyId: 'k1',
      algorithm: module.ATTESTATION_ALGORITHM,
      publicKeyPem: named.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    const body = {
      attestationVersion: module.ATTESTATION_CONTRACT_VERSION,
      issuer: { id: 'gate:issuer', name: 'Gate', keyId: 'k1' },
      subject: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'gate' },
      artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 10 }],
      contractHash: 'c'.repeat(64),
      schemaVersion: '1.0.0',
      toolVersion: 'gate/1.0.0',
      capturedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-10-01T00:00:00Z',
      nonce: null,
    };
    const signedBy = (key) => {
      const candidate = { ...body, signature: { algorithm: module.ATTESTATION_ALGORITHM, value: '' } };
      const value = sign(null, Buffer.from(module.attestationSigningBytes(candidate), 'utf8'), key).toString('base64');
      return { ...body, signature: { algorithm: module.ATTESTATION_ALGORITHM, value } };
    };
    const expect = {
      mode: 'HUBSPOT',
      instanceId: '00000001',
      contractHash: 'c'.repeat(64),
      artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64) }],
      at: '2026-09-15T00:00:00Z',
    };

    // Four questions, each of which a decorated assertion would answer wrongly.
    const accepts = module.verifyAttestation({ attestation: signedBy(named.privateKey), publicKeys: [authority], expect }).ok === true;
    // The one that matters: a real signature from a key the host never named.
    // That is what a self-issued attestation looks like, and it is
    // indistinguishable from a genuine one unless the key comes from elsewhere.
    const refusesUnnamed = module.verifyAttestation({ attestation: signedBy(unnamed.privateKey), publicKeys: [authority], expect }).ok === false;
    const refusesAbsent = module.verifyAttestation({ attestation: null, publicKeys: [authority], expect }).ok === false;
    const refusesExpired = module.verifyAttestation({
      attestation: signedBy(named.privateKey),
      publicKeys: [authority],
      expect: { ...expect, at: '2027-01-01T00:00:00Z' },
    }).ok === false;
    const refusesOtherInstance = module.verifyAttestation({
      attestation: signedBy(named.privateKey),
      publicKeys: [authority],
      expect: { ...expect, instanceId: '99999999' },
    }).ok === false;

    // And the seam has to be one the run consults, or it is a library rather
    // than a control.
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const { hashTargetContract } = await load('target/contract.js');
    const configPath = join(FIXTURES, 'value-intent', 'hubspot-update.json');
    const loaded = loadConfig(readConfig(configPath), configPath);
    const contract = hashTargetContract({
      contractVersion: '1.0.0', parserVersion: '1.0.0', capturedAt: '2026-09-01T00:00:00Z',
      instance: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'gate', evidence: 'ARTIFACT' },
      artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
      objects: [{
        apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [],
        fields: [{
          apiName: 'email', label: 'Email', type: 'string', createable: 'TRUE', updateable: 'TRUE',
          nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'TRUE', externalId: 'FALSE',
          idLookup: 'TRUE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
          restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT',
        },
        // Destination validation reads the contract (MC-04): the plan delivers
        // these three fields as well, and an instance that lacked them would
        // refuse the run rather than exercise what this fact is about.
        ...[['firstname', 'First name'], ['lastname', 'Last name'], ['jobtitle', 'Job title']].map(([apiName, label]) => ({
          apiName, label, type: 'string', createable: 'TRUE', updateable: 'TRUE',
          nillable: 'TRUE', length: null, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE',
          idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
          restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT',
        }))],
      }],
      pipelines: [],
    });
    let runRefused = false;
    try {
      runMigration({
        inputRoot: join(FIXTURES, 'value-intent', 'input'),
        config: loaded.config,
        configHash: loaded.configHash,
        targetContract: contract,
        attestationPolicy: 'REQUIRED',
        attestationAuthorities: [authority],
        attestationInstant: '2026-09-15T00:00:00Z',
        scratch: await gateScratch('attestation'),
      });
    } catch (error) {
      // Matched on the code rather than the class: this gate loads modules under
      // a cache-busting query, so an instanceof check would compare two copies of
      // the same error class and always answer no.
      runRefused = Boolean(error) && error.code === 'TARGET_CONTRACT_INVALID';
    }

    const value = accepts && refusesUnnamed && refusesAbsent && refusesExpired && refusesOtherInstance && runRefused;
    return fact(
      name,
      value,
      'EXECUTED',
      value
        ? 'a signature from a named issuer verifies; one from a key nobody named, an absent one, an expired one and one about another instance are each refused; and a run under REQUIRED stops before reading the source when the attestation is missing'
        : `accepts=${String(accepts)} refusesUnnamedKey=${String(refusesUnnamed)} refusesAbsent=${String(refusesAbsent)} refusesExpired=${String(refusesExpired)} refusesOtherInstance=${String(refusesOtherInstance)} runRefuses=${String(runRefused)}`,
    );
  } catch (error) {
    return failed(name, error);
  }
}

// --------------------------------------------------------------------------
// G. the package: version, streaming, atomicity
// --------------------------------------------------------------------------
/**
 * Is a package actually in the 2.0.0 shape, or does it only say so?
 *
 * The version is a constant somebody can edit, so this derivation does not
 * believe it. It writes two real packages -- one whose plan declares
 * relationships and one whose plan does not -- and looks at what came out:
 *
 *   the four areas exist, and nothing sits at the root except the manifest;
 *
 *   01_IMPORT carries no column named the way any of Kauro's own keys are, in
 *   any adapter's spelling, including the ones 1.1.0 used;
 *
 *   the object files carry the association key exactly where a relationship
 *   needs it and nowhere else;
 *
 *   the crosswalk that replaces the column is in 03_TRACEABILITY and accounts
 *   for every import row;
 *
 *   the operator instructions are in 04_DOCUMENTATION.
 *
 * Only when all of that holds does the declared version count for anything.
 */
async function packageFormat() {
  const name = 'package_format_version';
  try {
    const { PACKAGE_FORMAT_VERSION } = await load('version.js');
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const { writeAndPromotePackage, listPackageFiles } = await load('artifacts/write-package.js');
    const { ALL_ADAPTERS } = await load('adapters/specs.js');

    const fold = (value) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '');
    const kauroKeyNames = new Set(
      [
        ...ALL_ADAPTERS.flatMap((adapter) => [
          adapter.associationKeyHeader,
          adapter.associationFromHeader,
          adapter.associationToHeader,
        ]),
        'kauro_trace_key',
        'from_kauro_trace_key',
        'to_kauro_trace_key',
        'Kauro Trace Key',
        'Associated Kauro Trace Key',
        'Kauro_Trace_Key__c',
        'Related_Kauro_Trace_Key__c',
      ].map(fold),
    );

    const build = async (configPath, inputRoot, scratchName) => {
      const loaded = loadConfig(readConfig(configPath), configPath);
      const run = runMigration({
        inputRoot,
        config: loaded.config,
        configHash: loaded.configHash,
        scratch: await gateScratch(`${scratchName}-run`),
      });
      const outDir = freshDir(`${scratchName}-package`);
      writeAndPromotePackage({
        result: run,
        config: loaded.config,
        normalizedConfig: loaded.normalizedJson,
        outputDir: outDir,
        force: true,
      });
      return { adapter: run.adapter, config: loaded.config, dir: outDir };
    };

    const withEdges = await build(
      join(FIXTURES, 'golden', 'G11-associations', 'config.json'),
      join(FIXTURES, 'golden', 'G11-associations', 'input'),
      'format-edges',
    );
    const withoutEdges = await build(
      join(FIXTURES, 'value-intent', 'clean-only.json'),
      join(FIXTURES, 'value-intent', 'input'),
      'format-plain',
    );

    const problems = [];
    for (const built of [withEdges, withoutEdges]) {
      const files = listPackageFiles(built.dir);
      const areas = new Set(files.map((path) => path.split('/')[0]));
      for (const area of ['01_IMPORT', '02_EXCEPTIONS', '03_TRACEABILITY', '04_DOCUMENTATION']) {
        if (!areas.has(area)) problems.push(`${area} is missing`);
      }
      for (const area of areas) {
        if (!['01_IMPORT', '02_EXCEPTIONS', '03_TRACEABILITY', '04_DOCUMENTATION', 'manifest.json'].includes(area)) {
          problems.push(`${area} sits at the package root`);
        }
      }
      if (!files.includes('03_TRACEABILITY/import-crosswalk.csv')) problems.push('the crosswalk is missing');
      if (!files.includes('04_DOCUMENTATION/import-instructions.md')) problems.push('the instructions are missing');

      const declaresEdges = built.config.associations.length > 0;
      let importRows = 0;
      for (const path of files) {
        if (!path.startsWith('01_IMPORT/') || !path.endsWith('.csv')) continue;
        const text = readFileSync(join(built.dir, ...path.split('/')), 'utf8');
        const headers = (text.split('\n')[0] ?? '').split(',');
        const isAssociationFile = path.includes('/associations/');
        for (const header of headers) {
          if (!kauroKeyNames.has(fold(header))) continue;
          if (isAssociationFile) continue;
          if (declaresEdges && fold(header) === fold(built.adapter.associationKeyHeader)) continue;
          problems.push(`${path} carries a Kauro-named column "${header}"`);
        }
        if (!isAssociationFile) {
          importRows += Math.max(0, text.split('\n').filter((line) => line.length > 0).length - 1);
          const carries = kauroKeyNames.has(fold(headers[0] ?? ''));
          if (declaresEdges !== carries) {
            problems.push(
              declaresEdges
                ? `${path} has no association key although the plan declares relationships`
                : `${path} carries an association key although the plan declares no relationship`,
            );
          }
        }
      }

      const crosswalk = readFileSync(join(built.dir, '03_TRACEABILITY', 'import-crosswalk.csv'), 'utf8');
      const crosswalkRows = crosswalk.split('\n').filter((line) => line.length > 0).length - 1;
      if (crosswalkRows !== importRows) {
        problems.push(`the crosswalk accounts for ${String(crosswalkRows)} of ${String(importRows)} import rows`);
      }
    }

    const shaped = problems.length === 0;
    return fact(
      name,
      shaped ? PACKAGE_FORMAT_VERSION : `${String(PACKAGE_FORMAT_VERSION)} (not the shape)`,
      'EXECUTED',
      shaped
        ? 'two packages were written and inspected: four areas, nothing else at the root, no Kauro-named column in 01_IMPORT beyond the association key a declared relationship needs, and a crosswalk accounting for every import row'
        : problems.slice(0, 6).join('; '),
    );
  } catch (error) {
    failed(name, error);
    return 'absent';
  }
}

/**
 * Atomic delivery is a question about where the bytes are when the writer
 * returns, and it is asked by looking.
 *
 * The canonical order is render, reconcile, hash, verify, attest, and only then
 * publish. A writer that puts the manifest at the destination itself has already
 * published before any of that could happen, and a failure part way through
 * leaves a partial package sitting where a reader expects a whole one. So the
 * probe writes a package and asks one thing: is it already published?
 */
async function packageAtomicity() {
  const name = 'package_streaming_atomic';
  try {
    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const { writePackage, writeAndPromotePackage } = await load('artifacts/write-package.js');

    const configPath = join(FIXTURES, 'value-intent', 'clean-only.json');
    const loaded = loadConfig(readConfig(configPath), configPath);
    const run = runMigration({
      inputRoot: join(FIXTURES, 'value-intent', 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
      scratch: await gateScratch('atomicity'),
    });

    const destination = freshDir('atomicity');
    const written = writePackage({
      result: run,
      config: loaded.config,
      normalizedConfig: loaded.normalizedJson,
      outputDir: destination,
      force: true,
    });

    const publishedAtDestination = existsSync(join(destination, 'manifest.json'));
    const staged = typeof written.stagingDir === 'string' && written.stagingDir !== destination;
    const value = staged && !publishedAtDestination;
    return fact(
      name,
      value,
      'EXECUTED',
      value
        ? 'the writer leaves the package staged and unpublished, so the host promotes it only after it has been verified'
        : publishedAtDestination
          ? 'the writer published the manifest at the destination itself, so the package is live before anything has verified it and a failure part way through leaves a partial one there'
          : 'the writer reports no staging area distinct from the destination',
    );
  } catch (error) {
    return failed(name, error);
  }
}

/**
 * Bounded means the work does not need memory proportional to the artifact.
 *
 * Measured by giving a fresh process a heap smaller than the artifact it has to
 * check. A verifier that reads a table into a string needs the whole table; one
 * that streams needs a buffer. The first dies, the second finishes, and there is
 * nothing to interpret about the result.
 */
async function buildProbePackage(rows) {
  const { loadConfig } = await load('mapping/load-config.js');
  const { runMigration } = await load('run/run-migration.js');
  const { writePackage, writeAndPromotePackage } = await load('artifacts/write-package.js');

  const inputDir = freshDir('probe-input');
  const csvPath = join(inputDir, 'contacts.csv');
  // Written in blocks so building the probe's input is not itself the largest
  // thing this process holds.
  writeFileSync(csvPath, 'Contact ID,First Name,Last Name,Email,Job Title\n');
  let block = [];
  for (let index = 0; index < rows; index += 1) {
    block.push(`${String(index)},First${String(index)},Last${String(index)},person${String(index)}@example.com,Title ${String(index)}\n`);
    if (block.length >= 5000) {
      appendFileSync(csvPath, block.join(''));
      block = [];
    }
  }
  if (block.length > 0) appendFileSync(csvPath, block.join(''));

  const configPath = join(FIXTURES, 'value-intent', 'clean-only.json');
  const loaded = loadConfig(readConfig(configPath), configPath);
  const result = runMigration({
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
    scratch: await gateScratch('probe'),
  });
  const outputDir = freshDir('probe-package');
  writeAndPromotePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir, force: true });

  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else bytes += readFileSync(path).length;
    }
  };
  walk(outputDir);
  return { outputDir, bytes };
}

async function verifierBounded() {
  const name = 'verifier_bounded';
  const probe = join(repoRoot, 'tools', 'verifier-memory-probe.mjs');
  if (!existsSync(probe)) {
    return fact(name, false, 'PROBE_ABSENT', 'the bounded-verifier probe is missing');
  }
  try {
    const heapMib = 96;
    const built = await buildProbePackage(120_000);
    const packageMib = Math.round(built.bytes / (1024 * 1024));
    const result = spawnSync(
      process.execPath,
      [`--max-old-space-size=${String(heapMib)}`, probe, built.outputDir],
      { cwd: repoRoot, encoding: 'utf8', timeout: 900_000 },
    );
    if (result.status === 1) {
      return fact(name, false, 'MEASURED', `the probe package did not verify: ${(result.stderr || '').trim().split('\n').slice(-1)[0]}`);
    }
    const survived = result.status === 0;
    return fact(
      name,
      survived,
      'MEASURED',
      survived
        ? `a ${String(packageMib)} MiB package verified in a process limited to a ${String(heapMib)} MiB heap, so the checks do not hold the artifacts`
        : `verifying a ${String(packageMib)} MiB package needed more than a ${String(heapMib)} MiB heap, so the verifier materialises artifacts rather than streaming them`,
    );
  } catch (error) {
    return failed(name, error);
  }
}

// --------------------------------------------------------------------------
// I. the capacity harness, and what it has not yet been asked to prove
// --------------------------------------------------------------------------
/**
 * Is there a representative corpus, and does it run?
 *
 * A manifest of twelve profiles proves nothing on its own -- it is a file this
 * repository writes about itself. So the derivation generates every profile it
 * declares, migrates each one, and compares what came out against what the
 * manifest said would: the rows a reader must account for and the relationships
 * the source asserts, both computed from the profile's parameters rather than
 * read back from the bundle.
 *
 * It runs them small. Whether the corpus holds at a million rows in every mode
 * is MC-2's question and takes hours; whether the corpus exists, covers the
 * dimensions the canonical document names, and produces packages that verify is
 * this one, and it is answerable now.
 */
async function capacityHarness() {
  const name = 'representative_capacity_harness_ready';
  const manifestPath = join(repoRoot, 'qualification', 'capacity', 'profiles.json');
  if (!existsSync(manifestPath)) {
    return fact(
      name,
      false,
      'EVIDENCE_ABSENT',
      'no capacity profile manifest exists; the harness still generates one narrow CSV shape rather than the P1-P12 matrix',
    );
  }
  try {
    const profiles = await import(pathToFileURL(join(repoRoot, 'tools', 'capacity-profiles.mjs')).href);
    const manifest = profiles.loadProfiles();

    // Every dimension profile the manifest declares, rather than a count.
    //
    // `Array.from({ length: 12 })` said P1 to P12 and the manifest declares
    // fifteen — twelve dimensions and three founding profiles. Because the test
    // is a subset check it passed, and a thirteenth dimension added to the
    // manifest would never have been required by this gate. The manifest is the
    // authority for what the matrix is; this asks for all of it that is a
    // dimension.
    const wanted = manifest.profiles.map((profile) => profile.id).filter((id) => /^P\d+$/u.test(id));
    const present = new Set(manifest.profiles.map((profile) => profile.id));
    const missing = wanted.filter((id) => !present.has(id));
    const modes = new Set(manifest.profiles.map((profile) => profile.mode));
    const allModes = ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY'].every((mode) => modes.has(mode));
    const dimensions = new Set(manifest.profiles.map((profile) => profile.dimension));

    if (missing.length > 0 || !allModes) {
      return fact(
        name,
        false,
        'EVIDENCE_READ',
        `the manifest is missing ${missing.join(', ') || 'no profiles'} and covers modes ${[...modes].join(', ')}`,
      );
    }

    // The evidence is denominated in bytes, and the limits are the founding
    // ones. A harness that measured in MiB would be comparing a rounded number
    // against a budget stated to the byte.
    const { HARD_MEMORY_LIMIT_BYTES, MEMORY_BUDGET_BYTES, HARD_SCRATCH_LIMIT_BYTES, SCRATCH_BUDGET_BYTES } =
      await load('domain/resource-profile.js');
    const limitsAgree =
      manifest.limits.hardMemoryBytes === HARD_MEMORY_LIMIT_BYTES &&
      manifest.limits.memoryBudgetBytes === MEMORY_BUDGET_BYTES &&
      manifest.limits.hardScratchBytes === HARD_SCRATCH_LIMIT_BYTES &&
      manifest.limits.scratchBudgetBytes === SCRATCH_BUDGET_BYTES;
    if (!limitsAgree || manifest.evidenceSchemaVersion !== profiles.CAPACITY_EVIDENCE_SCHEMA_VERSION) {
      return fact(
        name,
        false,
        'EVIDENCE_READ',
        `the manifest states evidence schema ${String(manifest.evidenceSchemaVersion)} and limits that do not match the founding byte constants`,
      );
    }

    const { loadConfig } = await load('mapping/load-config.js');
    const { runMigration } = await load('run/run-migration.js');
    const { writeAndPromotePackage } = await load('artifacts/write-package.js');
    const { verifyPackage } = await load('verify/verify-package.js');

    const problems = [];
    for (const profile of manifest.profiles) {
      const outDir = freshDir(`capacity-${profile.id.toLowerCase()}`);
      const built = profiles.generateProfile(profile, 120, outDir);
      const loaded = loadConfig(readConfig(built.configPath), built.configPath);
      const result = runMigration({
        inputRoot: built.inputDir,
        config: loaded.config,
        configHash: loaded.configHash,
        ...attestationInputFor(loaded.config.target.mode),
        scratch: await gateScratch(`capacity-${profile.id.toLowerCase()}`),
      });

      const rows = result.reconciliation.sourceRows;
      if (rows.ingested !== built.plan.sourceRows) {
        problems.push(
          `${profile.id} declares ${String(built.plan.sourceRows)} source rows and the reader produced ${String(rows.ingested)}`,
        );
      }
      if (result.reconciliation.associations.sourceEdges !== built.plan.edges) {
        problems.push(
          `${profile.id} declares ${String(built.plan.edges)} relationships and the source asserted ${String(result.reconciliation.associations.sourceEdges)}`,
        );
      }
      if (!rows.equationHolds) problems.push(`${profile.id} does not reconcile its rows`);
      // What the giant cluster and the hot key were declared to produce, from
      // the parameters, against what the run found.
      if (built.plan.mergedRows !== null && rows.byDisposition.MERGED_PROVEN !== built.plan.mergedRows) {
        problems.push(
          `${profile.id} declares ${String(built.plan.mergedRows)} absorbed rows and the run merged ${String(rows.byDisposition.MERGED_PROVEN)}`,
        );
      }
      if (built.plan.provenMerges !== null && result.reconciliation.identity.provenMerges !== built.plan.provenMerges) {
        problems.push(
          `${profile.id} declares ${String(built.plan.provenMerges)} proven merge and the run made ${String(result.reconciliation.identity.provenMerges)}`,
        );
      }
      if (built.plan.hotKey !== null) {
        let hotEdges = 0;
        for (const edge of result.truth.edges) {
          const named = built.plan.hotKey.side === 'to' ? edge.toKeyRaw : edge.fromKeyRaw;
          if (edge.relationshipType === built.plan.hotKey.relationship && named === built.plan.hotKey.targetKeyRaw) hotEdges += 1;
        }
        if (hotEdges !== built.plan.hotKey.edges) {
          problems.push(
            `${profile.id} declares ${String(built.plan.hotKey.edges)} relationships ending at ${built.plan.hotKey.targetKeyRaw} and the source asserted ${String(hotEdges)}`,
          );
        }
      }

      const packageDir = freshDir(`capacity-${profile.id.toLowerCase()}-package`);
      writeAndPromotePackage({
        result,
        config: loaded.config,
        normalizedConfig: loaded.normalizedJson,
        outputDir: packageDir,
        force: true,
      });
      const report = verifyPackage(packageDir, {
        scratch: await gateScratch(`capacity-${profile.id.toLowerCase()}-verify`),
      });
      if (!report.passed) {
        // Every problem the verifier found, and the check each belongs to. The
        // first one alone was what this reported, and a package that fails one
        // check usually fails several: the operator fixed the first, re-ran the
        // gate — twelve profiles, minutes each — and was handed the second.
        problems.push(
          `${profile.id} produced a package that does not verify (${String(report.problems.length)} problems): ` +
            report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
        );
      }
    }

    const value = problems.length === 0;
    return fact(
      name,
      value,
      'EXECUTED',
      value
        ? // Counted, not written down. The word "twelve" sat here as a literal
          // and went on saying twelve after the three founding profiles were
          // added, in a sentence whose next clause was already counting.
          `all ${String(manifest.profiles.length)} profiles were generated and migrated: ${String(dimensions.size)} dimensions across ${String(modes.size)} modes, each one accounting for the rows and relationships its parameters declare, each producing a package that verifies`
        : // All of them. `slice(0, 4)` stood here, and a run in which five
          // profiles failed reported four — so the fifth was found by the next
          // run, after the four were fixed and the whole harness re-run.
          `${String(problems.length)} problems: ${problems.join('; ')}`,
    );
  } catch (error) {
    return failed(name, error);
  }
}

function mc2Qualification() {
  const name = 'full_mc2_capacity_qualification';
  const root = join(repoRoot, 'qualification', 'capacity');
  let modesAtScale = [];
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const evidence = JSON.parse(readFileSync(join(root, entry.name), 'utf8'));
        if (evidence.result === 'PASS' && Number(evidence.sourceRows) >= 1_000_000 && typeof evidence.mode === 'string') {
          modesAtScale.push(evidence.mode);
        }
      } catch {
        // Unreadable evidence proves nothing, which is the answer this wants.
      }
    }
  }
  const complete = ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY'].every((mode) => modesAtScale.includes(mode));
  return fact(
    name,
    complete,
    'EVIDENCE_READ',
    complete
      ? 'every mode has passing evidence at a million representative source rows'
      : `modes with passing evidence at a million rows: ${modesAtScale.length === 0 ? 'none' : modesAtScale.join(', ')}`,
  );
}

/**
 * Where the two product flags are decided, named rather than read.
 *
 * This used to open `migration-core-v1-provenance.json` — a file this same tree
 * generates — and report what it found as two facts with derivation
 * `EVIDENCE_READ`. Nothing was verified by that: a boolean somebody's generator
 * wrote was read back and printed beside facts that had been executed and
 * measured, in the same table and the same shape. A reader scanning the column
 * could not tell the two apart, and the release gate then read this gate's
 * output.
 *
 * Reading is not a derivation. Both flags are decided outside this tree —
 * `MIGRATION_CORE_RELEASE_CANDIDATE` by RELEASE-CANDIDATE-01 over the gates and
 * an external CI receipt, `MIGRATION_CORE_IMPLEMENTATION_FROZEN` by
 * `tools/freeze-verdict.mjs` over the merged commit, the receipt, the branch
 * protection in force, the tag and the downloaded release assets — so what this
 * gate says about them is where to look.
 */
function decidedElsewhere() {
  fact(
    'release_candidate',
    null,
    'DECIDED_ELSEWHERE',
    'RELEASE-CANDIDATE-01 decides it, over these facts, the offline universe, the vendor campaign, the capacity evidence and an external CI receipt',
  );
  fact(
    'implementation_frozen',
    null,
    'DECIDED_ELSEWHERE',
    'tools/freeze-verdict.mjs decides it, outside this tree, from the merged SHA, the external receipt, the protection in force on main, the annotated tag and the downloaded release assets',
  );
}

// --------------------------------------------------------------------------

async function collect() {
  facts.length = 0;
  await commonSourceReader();
  await sourceProfileBound();
  await runRetention();
  await scratchContract();
  await sortDeterminism();
  await reconciliationComplexity();
  await valueIntent();
  await attestation();
  await packageFormat();
  await packageAtomicity();
  await verifierBounded();
  await capacityHarness();
  mc2Qualification();
  decidedElsewhere();
  return facts.slice();
}

/**
 * The closure condition.
 *
 * Named explicitly rather than folded into a loop so that adding a fact cannot
 * change the meaning of the gate by accident, and so a reader can see exactly
 * which way each one has to point.
 */
function closed(observed) {
  const value = (name) => observed.find((entry) => entry.name === name)?.value;
  const mustBeTrue = [
    'common_source_reader',
    'source_profile_v1_bound',
    'external_sort_join_deterministic',
    'value_intent_end_to_end',
    'hubspot_blank_clear_is_not_emitted',
    'target_attestation_verified',
    'package_streaming_atomic',
    'verifier_bounded',
    'representative_capacity_harness_ready',
  ];
  // What this gate is about: whether the bounded architecture the canonical
  // document specifies is in this tree. Only facts about the architecture decide
  // it.
  //
  // `full_mc2_capacity_qualification`, `release_candidate` and
  // `implementation_frozen` were in this list while MC-1 was the front, because
  // MC-1 had to leave all three false and a gate that could not say so would
  // have let unfinished work read as finished. They are no longer here, and the
  // reason matters more than the edit: they are not architecture facts. They
  // describe how far the product has been carried, and requiring them to be
  // false made this gate fail precisely when the next front succeeded — the
  // moment a million rows passed in all three modes, the architecture would have
  // been reported as not closed, on the strength of evidence that says the
  // opposite.
  //
  // They are still collected, still reported, and still load-bearing: they are
  // now the closure condition of RELEASE-CANDIDATE-01, which is the gate whose
  // question they answer. Each gate decides on the facts it owns.
  const mustBeFalse = [
    'run_whole_bundle_retention',
    'run_truth_arrays_unbounded',
    'reconciliation_quadratic_path',
  ];
  // The two version facts are compared against floors rather than against
  // literals.
  //
  // `value('scratch_contract_version') === '1.0.0'` was the rule, and it fails
  // a correct tree the day either contract is deliberately versioned — which is
  // the day a gate should be reporting a considered change, not a failure. It
  // also cannot tell a downgrade from an upgrade, which is the only direction
  // that matters. `tools/version-floors.mjs` states what this release requires
  // and the comparison is `>=`.
  const floors = versionFloorProblems({
    scratchStoreContractVersion: value('scratch_contract_version'),
    packageFormatVersion: value('package_format_version'),
  }).filter((problem) => problem.startsWith('scratchStoreContractVersion') || problem.startsWith('packageFormatVersion'));
  if (floors.length > 0) {
    process.stderr.write(`\nthe declared contract versions are below their floors:\n${floors.map((problem) => `  - ${problem}`).join('\n')}\n`);
  }
  return (
    mustBeTrue.every((name) => value(name) === true) &&
    mustBeFalse.every((name) => value(name) === false) &&
    floors.length === 0
  );
}

const observed = await collect();
const isClosed = closed(observed);
/**
 * One facts schema, shared with every gate that reads one.
 *
 * This used to emit two objects: `facts` as `name -> value` and `derivations`
 * as `name -> {by, observed}`. RELEASE-CANDIDATE-01 read `facts` and filtered
 * it for `entry.value === false` — over booleans, so `entry.value` was
 * `undefined` on every entry, the filter never matched, and a failing
 * architecture gate was reported by the release gate as "false facts: none
 * named". Two shapes for one thing is one shape and one guess.
 *
 * `value` is a boolean for most facts and a string for the two that report a
 * version, which is why `factsProblems` in tools/evidence-schema.mjs validates
 * the envelope rather than the type of every value.
 */
const report = {
  gate: 'ARCHITECTURE-01',
  coreVersion: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
  facts: Object.fromEntries(
    observed.map((entry) => [entry.name, { value: entry.value, by: entry.derivation, observed: entry.detail }]),
  ),
  MIGRATION_CORE_ARCHITECTURE_CLOSED: isClosed ? 'TRUE' : 'FALSE',
};

if (selfTest) {
  // The gate has to be able to say FALSE, and it has to say it because of the
  // thing that was broken. Anything material will do; the sort is used because
  // breaking it is unambiguous and leaves nothing behind.
  const before = observed.find((entry) => entry.name === 'external_sort_join_deterministic')?.value;
  const sortSource = join(repoRoot, 'dist', 'src', 'scratch', 'external-sort.js');
  const original = readFileSync(sortSource, 'utf8');
  const anchor = 'return `${key}${KEY_TERMINATOR}${padded}`;';
  if (!original.includes(anchor)) {
    process.stderr.write('self-test could not find the sort key to break; the gate has not been shown to fail\n');
    process.exit(1);
  }
  writeFileSync(sortSource, original.replace(anchor, 'return key;'));
  let after;
  let afterClosed;
  try {
    generation += 1;
    const sabotaged = await collect();
    after = sabotaged.find((entry) => entry.name === 'external_sort_join_deterministic')?.value;
    afterClosed = closed(sabotaged);
  } finally {
    writeFileSync(sortSource, original);
    generation += 1;
  }
  // Two things have to hold, and the second is the one that is easy to miss.
  // The fact has to have flipped, and it has to be a fact the closure condition
  // actually consults — a gate that notices a broken invariant and then closes
  // anyway has noticed nothing.
  const loadBearing = closed(
    observed.map((entry) =>
      entry.name === 'external_sort_join_deterministic' ? { ...entry, value: false } : entry,
    ),
  ) === false;
  const proved = before === true && after === false && afterClosed === false && loadBearing;
  process.stderr.write(
    `self-test: sort determinism ${String(before)} -> ${String(after)}; ` +
      `the closure condition ${loadBearing ? 'consults' : 'DOES NOT CONSULT'} it; ` +
      `closure ${String(isClosed)} -> ${String(afterClosed)} — ` +
      `${proved ? 'the gate responds to a broken invariant' : 'THE GATE DID NOT RESPOND'}\n`,
  );
  process.exit(proved ? 0 : 1);
}

if (!jsonOnly) {
  const width = Math.max(...observed.map((entry) => entry.name.length));
  process.stderr.write('ARCHITECTURE-01 — MC-1 architecture closure\n\n');
  for (const entry of observed) {
    // A fact decided elsewhere has no value here, and prints as one rather than
    // as `null` beside a column of booleans.
    const shown = entry.value === null ? '—' : typeof entry.value === 'boolean' ? String(entry.value) : entry.value;
    process.stderr.write(`  ${entry.name.padEnd(width)}  ${shown.padEnd(7)}  [${entry.derivation}] ${entry.detail}\n`);
  }
  process.stderr.write(`\nMIGRATION_CORE_ARCHITECTURE_CLOSED=${report.MIGRATION_CORE_ARCHITECTURE_CLOSED}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(isClosed ? 0 : 1);

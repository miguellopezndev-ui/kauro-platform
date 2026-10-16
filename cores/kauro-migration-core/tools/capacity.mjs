#!/usr/bin/env node
// The capacity ladder.
//
// The benchmark this replaces measured one 6-column contact sheet with no
// associations, no merges, no unmapped columns and no second object, and it
// sampled resident memory once at the end while calling the number a peak. It
// therefore measured neither a representative workload nor a peak.
//
// This harness measures what a qualification run has to survive: several
// objects, relationships across files, columns the configuration does not map,
// a population of rows that merge, and the full run -> package -> verify ->
// attest sequence. Memory is sampled on an interval inside the child so the
// figure is a high-water mark, and each size runs in its own process so the
// figure belongs to that size alone.
//
// Fixtures are streamed to disk a chunk at a time. Building a 1M-row fixture in
// memory would make the harness itself the thing that runs out of memory, and
// the number would then describe the harness.
//
// Usage:
//   node tools/capacity.mjs --rows 100000 --mode CLEAN_ONLY [--out <dir>]
//   node tools/capacity.mjs --ladder                    (every rung, every mode)
//   node tools/capacity.mjs --child <caseDir>           (internal)
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus as osCpus, release as osReleaseRaw, totalmem } from 'node:os';

// Named so the evidence record reads as prose rather than as three os calls.
const osRelease = () => osReleaseRaw();
const cpuCount = () => osCpus().length;
const totalMemory = () => totalmem();

const {
  HARD_MEMORY_LIMIT_BYTES,
  MEMORY_BUDGET_BYTES,
  HARD_SCRATCH_LIMIT_BYTES,
  SCRATCH_BUDGET_BYTES,
  WALL_CLOCK_LIMIT_MS,
} = await import('../dist/src/domain/resource-profile.js');
const profiles = await import(new URL('capacity-profiles.mjs', import.meta.url).href);
// The declared stage list. The child measures all but , which the parent runs.
const { CAPACITY_STAGES } = await import(new URL('capacity-stages.mjs', import.meta.url).href);
// The producer's capture of the execution subject, taken at the start of this
// invocation and re-checked when each record is written. A measurement that
// cannot say what it was taken against is a measurement nothing can place.
const { captureEnd, captureStart, nowUtc } = await import(new URL('../qualification/campaign.mjs', import.meta.url).href);

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outRoot = join(repoRoot, 'bench', 'capacity');

// ------------------------------------------------------------------ the ladder

/**
 * Declared before the final run, and not moved afterwards to make a run pass.
 *
 * In bytes, because the budget is stated in bytes. The ladder used to compare
 * a mebibyte figure rounded to the nearest integer against a fraction of
 * another rounded figure, which is a comparison that can be off by a megabyte
 * in either direction and says nothing about where the budget really is.
 */
export const QUALIFICATION_LIMITS = {
  hardMemoryBytes: HARD_MEMORY_LIMIT_BYTES,
  memoryBudgetBytes: MEMORY_BUDGET_BYTES,
  hardScratchBytes: HARD_SCRATCH_LIMIT_BYTES,
  scratchBudgetBytes: SCRATCH_BUDGET_BYTES,
  wallClockMs: WALL_CLOCK_LIMIT_MS,
};

const RUNGS = [100_000, 250_000, 500_000, 1_000_000];

/**
 * The heap ceiling every measuring child runs under, derived rather than typed.
 *
 * `--max-old-space-size=8192` was written out at three call sites: the hard
 * memory limit restated in mebibytes, inside the harness that produces the
 * evidence the memory budget is judged from. That is exactly the unit
 * substitution `src/domain/resource-profile.ts` exists to forbid, and moving the
 * ceiling would have left the measuring children running under the old one.
 */
const CHILD_HEAP_FLAG = `--max-old-space-size=${String(Math.floor(HARD_MEMORY_LIMIT_BYTES / (1024 * 1024)))}`;

// ------------------------------------------------------------------- the child

/**
 * A package digest, from the engine that defines what one is.
 *
 * Not a hash computed here. `packageDigest` states the version of its own
 * definition and orders the files itself, and a second implementation in this
 * file would agree with it exactly until the day the definition moved — which
 * is the day a determinism claim has to be right.
 */
const { packageDigest } = await import('../dist/src/artifacts/package-digest.js');

function digestOfPackage(packageDir, wallClockMs) {
  try {
    return { packageDigest: packageDigest(packageDir).digest, wallClockMs };
  } catch (error) {
    return { packageDigest: null, wallClockMs, detail: String(error && error.message ? error.message : error) };
  }
}

/**
 * A duration, or null where none was taken.
 *
 * `Math.round(undefined)` is NaN and `JSON.stringify(NaN)` is `null`, which is
 * the right answer arrived at by accident and only sometimes: `Math.round(x ??
 * 0)` is 0, and 0 milliseconds is a claim that the stage ran and cost nothing.
 * Both spellings were in this file. A stage that did not run has no duration.
 */
function msOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** Where a failed child's whole output is kept. Never removed with the case. */
const logRoot = join(outRoot, 'logs');

/**
 * Everything a child said, kept, and the line worth quoting.
 *
 * Three places in this harness reduced a child's failure to
 * `stderr.slice(-3).join(' | ')` or `.slice(-1)[0]`. For a Node crash the last
 * three lines are `}`, an empty line and the version banner, so a failed
 * founding run recorded `} |  | Node.js v24.14.1` — a record of a failure that
 * says nothing about the failure, and the case directory holding the real
 * output is deleted immediately afterwards to keep the disk from filling.
 *
 * So the whole of stdout and stderr goes to a file that survives the case, the
 * record carries that path and its digest, and the summary quotes the first
 * line that names an error rather than the last line that happened to be
 * printed.
 *
 * @param {string} label a filename-safe name for this child
 * @param {{status: number|null, signal: string|null, stdout: string|null, stderr: string|null}} child
 */
function keepChildLog(label, child) {
  const stdout = String(child.stdout ?? '');
  const stderr = String(child.stderr ?? '');
  const body =
    `exit ${String(child.status)}${child.signal ? ` (signal ${String(child.signal)})` : ''}\n` +
    `--- stdout (${String(stdout.length)} bytes) ---\n${stdout}\n` +
    `--- stderr (${String(stderr.length)} bytes) ---\n${stderr}\n`;
  const path = join(logRoot, `${label.replace(/[^A-Za-z0-9._-]/gu, '_')}.log`);
  mkdirSync(logRoot, { recursive: true });
  writeFileSync(path, body);
  const relativePath = relative(repoRoot, path).split(sep).join('/');
  const lines = stderr.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
  const named =
    lines.find((line) => line.includes('heap out of memory') || line.includes('Allocation failed')) ??
    lines.find((line) => /^[A-Za-z]*Error\b/u.test(line)) ??
    lines.find((line) => /^\s*at\b/u.test(line) === false && line !== '^') ??
    lines[0] ??
    null;
  return {
    logPath: relativePath,
    logSha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    exitCode: child.status ?? null,
    signal: child.signal ?? null,
    stderrLines: lines.length,
    summary:
      named === null
        ? `the child exited ${String(child.status)} and wrote nothing to stderr; whole output in ${relativePath}`
        : `${named.slice(0, 300)} — ${String(lines.length)} stderr line${lines.length === 1 ? '' : 's'} in ${relativePath}`,
  };
}

/**
 * What `process.resourceUsage().maxRSS` is denominated in, on this host, today.
 *
 * Node documents the field in kibibytes, and the engine's `maxRssToBytes`
 * multiplies by 1024 on that authority. Documentation is the right basis for
 * the conversion and the wrong basis for a capacity record: the number this
 * harness reports is compared against a byte budget, so a record that carried
 * the conversion as an assumption would be one nobody could check afterwards.
 *
 * So it is measured. A child allocates a known buffer, reports both its own
 * `rss` and its `maxRSS`, and the ratio is recorded beside every figure the
 * conversion produced. A ratio that is not 1024 does not silently change the
 * arithmetic — it is recorded, and a reader who finds one knows the platform
 * moved under the record.
 */
function calibrateMaxRss() {
  const probe =
    'const before = process.memoryUsage().rss;' +
    'const block = Buffer.alloc(200 * 1024 * 1024, 1);' +
    'const usage = process.resourceUsage();' +
    'const now = process.memoryUsage();' +
    'process.stdout.write(JSON.stringify({ maxRSS: usage.maxRSS, rss: now.rss, allocated: block.length, before }));';
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { ratio: null, unit: 'unmeasured', detail: `the calibration probe exited ${String(result.status)}` };
  }
  try {
    const seen = JSON.parse(result.stdout);
    const ratio = seen.maxRSS === 0 ? null : Number((seen.rss / seen.maxRSS).toFixed(4));
    return {
      ratio,
      unit: ratio === 1024 ? 'KiB' : ratio === 1 ? 'bytes' : `${String(ratio)} bytes per unit`,
      maxRSS: seen.maxRSS,
      rss: seen.rss,
      detail: `a child allocating ${String(seen.allocated)} bytes reported rss ${String(seen.rss)} and maxRSS ${String(seen.maxRSS)}`,
    };
  } catch (error) {
    return { ratio: null, unit: 'unmeasured', detail: `the calibration probe was unreadable: ${String(error && error.message ? error.message : error)}` };
  }
}

/** The host, in the fields the evidence schema requires. Nothing is combined into one string. */
function capacityEnvironment(calibration) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    cpuCount: cpuCount(),
    totalMemoryBytes: totalMemory(),
    samplingIntervalMs: 50,
    // How the peak was converted, measured on this host rather than assumed.
    maxRssCalibration: calibration,
    // The process limits the platform exposes. Windows exposes none of the
    // POSIX ones, and the record says so rather than reporting zero.
    processLimits:
      typeof process.report?.getReport === 'function'
        ? (() => {
            try {
              const report = process.report.getReport();
              return report.resourceUsage === undefined ? null : { rss: report.resourceUsage.rss ?? null, maxRss: report.resourceUsage.maxRss ?? null };
            } catch {
              return null;
            }
          })()
        : null,
    processLimitsReason: process.platform === 'win32' ? 'this platform exposes no POSIX resource limits' : null,
  };
}

function directorySize(directory) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        try {
          total += statSync(path).size;
        } catch {
          // A segment deleted as it was spent is not a segment this counts.
        }
    }
  };
  try {
    walk(directory);
  } catch {
    return 0;
  }
  return total;
}

async function runChild(caseDir) {
  const { loadConfig } = await import('../dist/src/mapping/load-config.js');
  const { runMigration } = await import('../dist/src/run/run-migration.js');
  const { writeAndPromotePackage } = await import('../dist/src/artifacts/write-package.js');
  const { verifyPackage } = await import('../dist/src/verify/verify-package.js');
  const { createFilesystemScratchStore } = await import('../dist/src/scratch/filesystem-scratch-store.js');
  const { SCRATCH_BUDGET_BYTES } = await import('../dist/src/domain/resource-profile.js');

  // Scratch is host-injected, and the ladder is the host: one store per case,
  // under the case directory, so the peak it reports is the peak of a run that
  // spilled exactly where a real one would.
  const scratch = createFilesystemScratchStore({
    root: join(caseDir, 'work'),
    runId: 'capacity',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });

  // A high-water mark, not a reading. The old benchmark sampled once at the end
  // and called it a peak; a peak that happens mid-run is exactly the peak that
  // decides whether a machine survives.
  // Sampled at stage boundaries, not on a timer.
  //
  // An earlier version armed a setInterval and called the result a peak. It was
  // not one: every stage here is synchronous, so the event loop never runs
  // between the start of a stage and its end, and the timer never fires. What
  // it actually recorded was the reading at each boundary — which is what this
  // now says it is. The true high-water mark comes from the operating system,
  // which the parent reads after this process exits.
  let peakRss = 0;
  let stage = 'load';
  const stagePeak = {};
  let peakScratchBytes = 0;
  const sample = () => {
    const scratchBytes = directorySize(join(caseDir, 'work'));
    if (scratchBytes > peakScratchBytes) peakScratchBytes = scratchBytes;
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
    if (rss > (stagePeak[stage] ?? 0)) stagePeak[stage] = rss;
  };
  sample();

  // Boundaries say where memory stood between stages, and that turned out not to
  // be enough: at 1,000,000 rows no boundary exceeded 6,820 MiB while the
  // operating system reported 9,267, so 2,447 MiB lived and died inside a stage
  // and the measurement could not say which. Optimising against that is
  // guesswork, and this harness exists so that nothing here is guesswork.
  //
  // A worker thread fixes it. It has its own event loop, so its timer fires
  // while this thread is busy in a synchronous stage, and `rss` is a property of
  // the process rather than the thread — so what it reads is this run's true
  // high-water mark, attributed to the stage that was running when it read it.
  const stages = {};
  const at = process.hrtime.bigint.bind(process.hrtime);
  const since = (from) => Number(at() - from) / 1_000_000;

  // The six stages a reproduction is made of, named the way the resource
  // contract names them. `load` was the only one before `run`, and it hid the
  // profiling pass entirely: a migration in this product is preceded by a full
  // profile of the same bundle — the Free Audit's, and the one a plan is
  // compiled against — which spills one tuple per populated cell and is the
  // second largest sort the product performs. A capacity record that measured
  // the run and not the profile measured most of the work and reported all of
  // it. `attest` is measured by the parent, in its own process, and merged in;
  // `cleanup` is the disposal, which is where a store that cannot let go of a
  // customer's data would show.
  // The stages the child measures: every declared stage but `attest`, which is a
  // separate process the parent runs and times. Derived from the declaration
  // rather than written a second time — the two lists disagreed once already,
  // and the way that shows is a capacity record refused for a missing stage
  // after an eight-hour run.
  const STAGES = CAPACITY_STAGES.filter((stage) => stage !== 'attest');
  const shared = new Int32Array(new SharedArrayBuffer(4 * (STAGES.length + 1)));
  const stageRecords = [];
  const setStage = (name) => {
    stage = name;
    Atomics.store(shared, 0, STAGES.indexOf(name));
  };
  setStage('profile');

  /**
   * One stage's wall clock and resources, taken at its boundary.
   *
   * A metric this cannot measure is recorded as `null` beside the reason, never
   * as zero: zero is a measurement and "the store was already disposed" is not.
   */
  const closeStage = (name, from, options = {}) => {
    const wallMs = Math.round(since(from));
    let usage = null;
    let usageReason = null;
    try {
      usage = options.scratchDisposed === true ? null : scratch.usage();
      if (usage === null) usageReason = 'the scratch store was disposed before this stage ended';
    } catch (error) {
      usageReason = `the scratch store could not be read: ${String(error && error.message ? error.message : error)}`;
    }
    let sampledScratch = null;
    let sampledReason = null;
    try {
      sampledScratch = directorySize(join(caseDir, 'work'));
    } catch (error) {
      sampledReason = `the scratch directory could not be walked: ${String(error && error.message ? error.message : error)}`;
    }
    const index = STAGES.indexOf(name);
    const sampledMib = index === -1 ? 0 : Atomics.load(shared, index + 1);
    stageRecords.push({
      stage: name,
      wallMs,
      // The sampler writes mebibytes because it writes into a shared integer,
      // so the byte figure it yields is rounded to a mebibyte and the record
      // says by how much rather than presenting a precise-looking number. The
      // field was called `sampledByStageMib` and shipped as a display unit in a
      // record whose whole point is that it is denominated in bytes.
      // Null, not zero, when the sampler never fired inside the stage.
      //
      // The docstring above says a metric this cannot measure is recorded as
      // null beside the reason, never as zero, and then this line wrote both: a
      // 0 that the evidence schema accepts as a non-negative measurement, beside
      // a reason saying it is not one. Reproducible on every run — the sampler
      // ticks at 50 ms and `cleanup` is a `dispose()` call that usually finishes
      // between two ticks, so every founding record carried
      // `cleanup.peakRssBytes: 0`.
      peakRssBytes: sampledMib === 0 ? null : sampledMib * 1024 * 1024,
      peakRssBytesReason: sampledMib === 0 ? 'the sampler recorded no reading inside this stage' : null,
      maxRssDeltaBytes: null,
      maxRssDeltaBytesReason: 'the operating system’s high-water mark is a property of the process and is read by the parent after it exits',
      scratchLiveBytesAtEnd: usage === null ? null : usage.bytes,
      scratchLiveBytesAtEndReason: usageReason,
      // The store's high-water mark **so far**, not this stage's.
      //
      // `peakBytes` in the filesystem store is monotone and never reset, so
      // the package, verify and cleanup entries all carried the peak the run
      // stage reached. A reader attributing scratch pressure to a stage would
      // conclude that `cleanup` — a `dispose()` — held three gigabytes. The
      // name says which number it is.
      scratchPeakLiveBytesSoFar: usage === null ? null : usage.peakBytes,
      scratchPeakLiveBytesSoFarReason: usageReason,
      scratchSampledBytesAtEnd: sampledScratch,
      scratchSampledBytesAtEndReason: sampledReason,
      samplingGranularityBytes: 1024 * 1024,
    });
  };

  const sampler = new Worker(
    `const { workerData } = require('node:worker_threads');
     const shared = workerData;
     setInterval(() => {
       const mb = Math.round(process.memoryUsage.rss() / (1024 * 1024));
       const at = Atomics.load(shared, 0) + 1;
       let seen = Atomics.load(shared, at);
       while (mb > seen) {
         const swapped = Atomics.compareExchange(shared, at, seen, mb);
         if (swapped === seen) break;
         seen = swapped;
       }
     }, 50);`,
    { eval: true, workerData: shared },
  );
  // Unreffed here, not inside the worker: the timer has to keep the worker's own
  // event loop alive, and this only stops the worker keeping the process alive.
  sampler.unref();

  const inputDir = join(caseDir, 'input');
  const configPath = join(caseDir, 'config.json');
  const packageDir = join(caseDir, 'package');
  const configText = readFileSync(configPath, 'utf8');

  // The run's own state is dropped before the package is verified.
  //
  // Verification reads the package off disk and needs nothing the run held, but
  // holding `result` across the call keeps every lineage entry, every change and
  // every delivered record alive underneath it. Measuring "verification" while
  // the whole run is still resident measures the wrong thing, and shipping it
  // that way costs a customer the same memory for no reason.
  let runSummary;
  let profileSummary = null;
  // Hoisted out of the run block on purpose. The same evidence the run was given
  // is what the source-backed verification below has to re-derive with, and a
  // binding scoped to the run would have left that verification asking for a
  // contract nobody could hand it — which is exactly what it did.
  let attested = {};

  /**
   * The profile, measured because the product performs it.
   *
   * A migration in this product is preceded by a full profile of the same
   * bundle — it is what the Free Audit shows a person and what a plan is
   * compiled against — and it is the second largest sort the product does: one
   * spilled tuple per populated cell, sorted, walked once. Measuring the run
   * and not the profile measured most of the work and reported all of it.
   *
   * Its family is released before the stage ends, so what the next stage starts
   * from is the store with the profile's bytes gone rather than still resident.
   */
  {
    const tProfile = at();
    const { buildSourceProfile } = await import('../dist/src/profile/source-profile.js');
    const loaded = loadConfig(configText, configPath);
    const profiled = buildSourceProfile({ inputRoot: inputDir, config: loaded.config, scratch });
    stages.profileMs = since(tProfile);
    profileSummary = {
      profileHash: profiled.profileHash,
      files: profiled.profile.totals.fileCount,
      sheets: profiled.profile.totals.sheetCount,
      readerRowCount: profiled.profile.totals.readerRowCount,
      populatedCells: profiled.profile.totals.populatedCells,
    };
    closeStage('profile', tProfile);
    sample();
  }

  {
    const t0 = at();
    setStage('run');
    const loaded = loadConfig(configText, configPath);
    // A CRM profile now has to attest, like any other CRM run. The harness is
    // the host here, so it supplies the contract, the signature and the key the
    // way a deployment would — and the run verifies it rather than being
    // excused from doing so. See tools/qualification-attestation.mjs for why
    // the harness attests for real instead of relaxing the default.
    const { attestationInputFor } = await import(new URL('qualification-attestation.mjs', import.meta.url).href);
    attested = attestationInputFor(loaded.config.target.mode);
    let result = runMigration({
      inputRoot: inputDir,
      config: loaded.config,
      configHash: loaded.configHash,
      scratch,
      ...attested,
    });
    stages.runMs = since(t0);
    closeStage('run', t0);
    sample();

    const t1 = at();
    setStage('package');
    writeAndPromotePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: packageDir, force: true });
    stages.packageMs = since(t1);
    closeStage('package', t1);
    sample();

    const reconciliation = result.reconciliation;
    runSummary = {
      sourceRows: reconciliation.sourceRows.total,
      rowsIngested: reconciliation.sourceRows.ingested,
      equationHolds: reconciliation.sourceRows.equationHolds,
      delivered: reconciliation.records.deliveredTotal,
      edges: reconciliation.associations.sourceEdges,
      mergedRows: reconciliation.sourceRows.byDisposition.MERGED_PROVEN,
      cells: reconciliation.cells.changed + reconciliation.cells.unmappedPreserved,
    };
    result = null;
  }

  const t2 = at();
  setStage('verify');
  const report = verifyPackage(packageDir, { scratch });
  stages.verifyMs = since(t2);
  closeStage('verify', t2);
  sample();

  /**
   * The disposal, measured.
   *
   * The scratch contract says a store removes everything the run wrote, on
   * success and on failure alike, and says so rather than leaving customer data
   * behind quietly. That is a claim about a thing that takes time and can fail,
   * and nothing measured it: the record said what the run cost and stopped at
   * the point where the run's data was still on the device.
   *
   * The store's own usage is read before the disposal and the directory is
   * walked after it, so what this records is both what was let go and whether
   * anything was left.
   */
  const tCleanup = at();
  setStage('cleanup');
  const usageBeforeDisposal = scratch.usage();
  let disposalProblem = null;
  try {
    scratch.dispose();
  } catch (error) {
    disposalProblem = String(error && error.message ? error.message : error);
  }
  const scratchLeftBehindBytes = directorySize(join(caseDir, 'work'));
  stages.cleanupMs = since(tCleanup);
  closeStage('cleanup', tCleanup, { scratchDisposed: true });

  /**
   * And then the harder question, asked of the same package.
   *
   * `verifyPackage` reads the package and checks it against itself: it catches a
   * package that contradicts its own manifest, and it cannot catch a delivered
   * value the package alone has no witness for. Source-backed verification
   * re-derives the truth from the original source bytes and the configuration
   * the operator accepted, and compares the candidate against that — nothing the
   * package says is taken as a premise.
   *
   * The founding evidence recorded `attestationOk: null` because nothing here
   * asked. A capacity run that proves a million rows fit the budget and never
   * asks whether the package is true of its source has measured the cheaper
   * half; `null` in that field is the harness declining to answer, and the gate
   * reads it as exactly that.
   *
   * The source and the configuration are hashed before and after, inside
   * `verifyAgainstSource`, so a verification that altered what it checked
   * against would say so.
   */
  // Source-backed verification does NOT happen here. It happens in its own
  // process, spawned by the parent after this one has exited.
  //
  // It ran here for exactly one measurement, and that measurement was an OOM at
  // a million rows on a profile that had passed at 77.6% of the memory budget an
  // hour earlier. The cause is not subtle once seen: `verifyAgainstSource`
  // re-derives the truth by running the whole migration again, so calling it
  // here asked one process to hold two migrations of the same million rows. The
  // eight-gibibyte old space that a single run fits inside comfortably is not
  // two runs.
  //
  // Two things would have been wrong even if it had fitted. The peak this
  // harness reports is meant to be what a customer's migration costs, and a
  // second migration inside the measured process makes that number describe the
  // harness. And an operator attests a package as a separate act, afterwards,
  // with its own memory — measuring the two together would answer a question
  // nobody asks.

  writeFileSync(
    join(caseDir, 'result.json'),
    `${JSON.stringify(
      {
        evidenceSchemaVersion: profiles.CAPACITY_EVIDENCE_SCHEMA_VERSION,
        ok: report.passed,
        // What this process saw at each stage boundary. The gate uses the
        // operating system's peak instead, which no boundary can miss.
        boundaryRssBytes: peakRss,
        peakByStageBytes: Object.fromEntries(Object.entries(stagePeak)),
        peakScratchBytes,
        // What the store itself counted, rather than what a directory walk saw.
        //
        // The walk is sampled at stage boundaries and cannot see a segment that
        // was created and reclaimed between two of them, and it cannot see bytes
        // at all once the external sort has deleted a spent run — so it reports
        // the high-water mark of what was *lying about*, not what the device was
        // asked to take. The difference is the whole amplification question:
        // being under quota and being proportionate are not the same claim, and
        // only the second one says anything about ten million rows.
        //
        // The per-family breakdown is what makes the number explicable. A total
        // says a run spilled four hundred times its source; the breakdown says
        // which family did it, which is the difference between a fact and a
        // shrug.
        //
        // One shape, not two.
        //
        // The previous round wrote the whole breakdown twice — `scratchByFamily`
        // keyed by name and `scratchFamilies` as a list — on the argument that a
        // model recomputing per-pass traffic needs the families in an order the
        // runtime cannot rearrange. That argument does not survive reading the
        // model: `familiesOf` in tools/scratch-model.mjs sorts whichever shape it
        // is given into code-unit order before it looks at anything, so the
        // object's enumeration order never reaches a decision. What the second
        // copy did buy was size: each family now carries a `sorts` array holding
        // one entry per initial run, and at the founding scale that is a few
        // hundred kilobytes of committed artifact duplicated for nothing.
        //
        // The object form is the one that survives, because it is what
        // tools/release-candidate-gate.mjs has always read and every field in it
        // still means what it meant.
        ...(() => {
          const usage = usageBeforeDisposal;
          const family = (entry) => ({
            bytesWritten: entry.bytesWritten,
            peakBytes: entry.peakBytes,
            liveBytes: entry.liveBytes,
            segments: entry.segments,
            released: entry.released,
            // What the family is for, and who reads it last. Null where the
            // stage that opens it has not yet said; the model reports undeclared
            // rather than inventing an answer.
            declaration: entry.declaration,
            segmentsSealed: entry.segmentsSealed,
            linesWritten: entry.linesWritten,
            framingBytes: entry.framingBytes,
            // Index 0 is run generation and index p the p-th merge pass. This is
            // the split that makes scratch explicable at all: the pass count
            // grows with the run count, which is why a ratio against source bytes
            // gives 52.6x at two thousand rows and 154x at a million for the same
            // algorithm doing the same thing.
            bytesWrittenByPass: entry.bytesWrittenByPass,
            bytesWrittenUnattributed: entry.bytesWrittenUnattributed,
            openedAt: entry.openedAt,
            closedAt: entry.closedAt,
            sorts: entry.sorts,
          });
          return {
            scratchBytesWritten: usage.bytesWritten,
      scratchPeakLiveBytes: usage.peakBytes,
            // What the store still held when this record was taken. The scratch
            // model needs it to pin the directory walk from below: a walk that
            // reports fewer bytes than the store is still holding is not a
            // measurement of this run, and without a floor a caller could
            // satisfy the peak fact by reporting zero.
            scratchLiveBytes: usage.bytes,
            scratchQuotaBytes: usage.quotaBytes,
            scratchFramingBytesPerLine: usage.framingBytesPerLine,
            scratchSegmentCount: usage.segmentCount,
            scratchByFamily: Object.fromEntries((usage.byFamily ?? []).map((entry) => [entry.family, family(entry)])),
          };
        })(),
        cpuUserMicroseconds: process.cpuUsage().user,
        cpuSystemMicroseconds: process.cpuUsage().system,
        // What the sampler saw *inside* each stage, which is where the memory a
        // boundary cannot see actually lives. These are the numbers to optimise
        // against; the gate still believes only the operating system's figure.
        // The sampler reads mebibytes because it writes into a shared integer;
        // the name says so rather than leaving the unit to be guessed.
        // In bytes, with the granularity the sampler works at stated beside
        // them. This was `sampledByStageMib` — a field named for a display unit
        // in a record whose entire point is that it is denominated in bytes,
        // and the exact shape of the defect that let `peakMb` be compared
        // against a byte budget.
        sampledByStageBytes: Object.fromEntries(STAGES.map((name, index) => [name, Atomics.load(shared, index + 1) * 1024 * 1024])),
        samplingGranularityBytes: 1024 * 1024,
        samplingIntervalMs: 50,
        // One record per stage: wall clock and resources, with a reason wherever
        // a metric could not be taken. A missing metric is null, never zero.
        stages: stageRecords,
        // What the profile pass established, so a reader can see that the stage
        // did the work rather than merely taking time.
        sourceProfile: profileSummary,
        // The disposal, which the contract requires and nothing measured.
        cleanup: {
          scratchLiveBytesBeforeDisposal: usageBeforeDisposal.bytes,
          scratchLeftBehindBytes,
          disposalProblem,
          ok: disposalProblem === null && scratchLeftBehindBytes === 0,
        },
        ...stages,
        sourceRows: runSummary.sourceRows,
        rowsIngested: runSummary.rowsIngested,
        // The partition closing is the correctness half of the gate. A run that
        // fits in memory by losing rows is a failure, not a capacity result.
        equationHolds: runSummary.equationHolds,
        delivered: runSummary.delivered,
        packageBytes: directorySize(packageDir),
        edges: runSummary.edges,
        mergedRows: runSummary.mergedRows,
        cells: runSummary.cells,
        checksRun: report.checks.length,
        // Written by the separate attest pass the parent runs next, merged into
        // this record by the parent. Absent here rather than null, so a record
        // that never met the attest pass is visibly missing it.
        problems: report.passed ? [] : (report.problems ?? []).slice(0, 5).map((p) => `${p.check}: ${p.detail}`),
      },
      null,
      2,
    )}\n`,
  );
}

// ------------------------------------------------------------------ the parent

function measure(profile, rung, reproductionPasses = 1) {
  const caseDir = join(outRoot, `${profile.id}-${String(rung)}`);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });

  // Generated from the profile, and separately from the measurement: the
  // child migrates what is already on disk, so nothing the generator costs is
  // counted as what the migration costs.
  const built = profiles.generateProfile(profile, rung, caseDir);
  const inputBytes = directorySize(built.inputDir);

  /**
   * The same inputs, twice, in processes that share nothing.
   *
   * `candidate_bytes_deterministic` asks whether a package is a function of its
   * source and its configuration, and there is exactly one way to answer that:
   * run it again and compare the bytes. Recording one run's digest twice would
   * satisfy the field and prove nothing, which is the failure mode this whole
   * front keeps finding, so the reproductions are separate `spawnSync` calls
   * writing to separate directories, each timed on its own.
   *
   * Not two runs *instead of* the measurement — the first reproduction IS the
   * measurement. What the extra pass costs is one more migration; what it buys
   * is the difference between "the engine is deterministic" as a design claim
   * and as an observation.
   */
  const reproductions = [];
  const started = Date.now();
  // The child is measured from outside. A process cannot observe its own peak
  // while it is busy: every stage is synchronous, so a timer inside it never
  // fires, and a reading taken between stages misses whatever happened during
  // one. The operating system counts the high-water mark whether or not the
  // process is willing to stop and look.
  const child = spawnSync(
    process.execPath,
    [
      CHILD_HEAP_FLAG,
      join(repoRoot, 'tools', 'capacity.mjs'),
      '--child',
      caseDir,
      '--peak-out',
      join(caseDir, 'peak.txt'),
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const wallMs = Date.now() - started;

  // The first pass is the measurement, and it is also reproduction one. Its
  // digest is taken from the engine's own `packageDigest` rather than from a
  // second opinion about what a package's bytes are. Its stages are attached
  // below, once the child's record has been read.
  if (child.status === 0) reproductions.push(digestOfPackage(join(caseDir, 'package'), wallMs));

  // The attestation, once, in its own process. It is not timed into the run:
  // the wall clock this harness reports is the migration a customer pays for,
  // and attesting is a separate act somebody performs afterwards.
  let attestation = { ok: false, checks: 0, problems: ['source-backed verification did not run'] };
  let attestMs = null;
  if (child.status === 0) {
    const attestOut = join(caseDir, 'attest.json');
    const attestStarted = Date.now();
    const attested = spawnSync(
      process.execPath,
      [
        CHILD_HEAP_FLAG,
        join(repoRoot, 'tools', 'capacity.mjs'),
        '--attest-case',
        caseDir,
        '--attest-out',
        attestOut,
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    attestMs = Date.now() - attestStarted;
    try {
      attestation = JSON.parse(readFileSync(attestOut, 'utf8'));
    } catch {
      const kept = keepChildLog(`${profile.id}-${String(rung)}-attest`, attested);
      attestation = {
        ok: false,
        checks: 0,
        problems: [`the attest pass wrote nothing; ${kept.summary}`],
        childLog: kept,
      };
    }
  }

  // Every further pass is a fresh process against the same generated corpus,
  // writing somewhere else so nothing of the first is reachable to be reused.
  for (let pass = 2; pass <= reproductionPasses; pass += 1) {
    const passDir = join(caseDir, `reproduction-${String(pass)}`);
    rmSync(passDir, { recursive: true, force: true });
    mkdirSync(passDir, { recursive: true });
    // The child reads `input/` and `config.json` from the case directory it is
    // given, so the corpus is copied by reference rather than regenerated: a
    // regenerated corpus would be a second question (is the generator
    // deterministic) wearing the first one's name.
    cpSync(join(caseDir, 'input'), join(passDir, 'input'), { recursive: true });
    cpSync(join(caseDir, 'config.json'), join(passDir, 'config.json'));
    const at = Date.now();
    const again = spawnSync(
      process.execPath,
      [CHILD_HEAP_FLAG, join(repoRoot, 'tools', 'capacity.mjs'), '--child', passDir, '--peak-out', join(passDir, 'peak.txt')],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // The pass's own per-stage record, read before the directory is removed. A
    // reproduction that recorded only a digest and a wall clock said nothing
    // about where the second run's time and memory went, so a reproduction that
    // was slower for a reason nobody could name looked identical to one that
    // was not.
    let passStages = [];
    try {
      passStages = JSON.parse(readFileSync(join(passDir, 'result.json'), 'utf8')).stages ?? [];
    } catch {
      passStages = [];
    }
    if (again.status === 0) reproductions.push({ ...digestOfPackage(join(passDir, 'package'), Date.now() - at), stages: passStages });
    else {
      const kept = keepChildLog(`${profile.id}-${String(rung)}-reproduction-${String(pass)}`, again);
      reproductions.push({ packageDigest: null, wallClockMs: Date.now() - at, stages: passStages, detail: kept.summary, childLog: kept });
    }
    // The spill and the package of a reproduction are not evidence; the digest
    // is. Ten gigabytes per pass would fill the disk before the third profile.
    rmSync(passDir, { recursive: true, force: true });
  }

  let osPeakBytes = null;
  try {
    osPeakBytes = Number(readFileSync(join(caseDir, 'peak.txt'), 'utf8').trim());
    if (!Number.isFinite(osPeakBytes)) osPeakBytes = null;
  } catch {
    osPeakBytes = null;
  }

  let result = null;
  try {
    result = JSON.parse(readFileSync(join(caseDir, 'result.json'), 'utf8'));
  } catch {
    result = null;
  }

  // Declared by the profile, computed from its parameters. Reading the count
  // back from the bundle would be the harness agreeing with itself.
  const declaredRows = built.plan.sourceRows;
  const declaredEdges = built.plan.edges;
  if (result === null) {
    const kept = keepChildLog(`${profile.id}-${String(rung)}-run`, child);
    const oom = String(child.stderr ?? '').includes('heap out of memory') || String(child.stderr ?? '').includes('Allocation failed');
    return {
      evidenceSchemaVersion: profiles.CAPACITY_EVIDENCE_SCHEMA_VERSION,
      profile: profile.id,
      dimension: profile.dimension,
      mode: profile.mode,
      rung,
      rows: declaredRows,
      outcome: oom ? 'OOM' : 'FAILED',
      wallClockMs: wallMs,
      sourceBytes: inputBytes,
      detail: kept.summary,
      childLog: kept,
    };
  }

  // The operating system's figure is the one the gate believes. Falling back to
  // the child's own boundary reading would quietly lower the bar, so a run whose
  // peak could not be measured fails rather than passes on the weaker number.
  const peakRssBytes = osPeakBytes;
  // The attestation is in the verdict.
  //
  // It was not, so a run whose source-backed verification failed — or whose
  // attest child ran out of memory — still reported `outcome: PASS`, wrote
  // `result: PASS` into the founding evidence, printed CAPACITY-FOUNDING = PASS,
  // exited 0, and climbed to the next rung. The contradiction sat in the same
  // file, as `verification.attestationOk: false`, to be discovered hours later
  // by a different tool reading what this one wrote.
  const passed =
    attestation.ok === true &&
    result.ok &&
    result.equationHolds === true &&
    result.sourceRows === declaredRows &&
    result.edges === declaredEdges &&
    // A giant cluster declares how many rows it absorbs; the other profiles
    // declare none and are not asked.
    (built.plan.mergedRows === null || result.mergedRows === built.plan.mergedRows) &&
    peakRssBytes !== null &&
    peakRssBytes <= QUALIFICATION_LIMITS.memoryBudgetBytes &&
    // Measured, like the memory peak two lines above, rather than defaulted.
    // `?? 0` meant a scratch peak that could not be walked — a permissions
    // problem on the directory returns 0 from `directorySize` — passed the
    // budget it was never compared against.
    typeof result.peakScratchBytes === 'number' &&
    Number.isFinite(result.peakScratchBytes) &&
    result.peakScratchBytes <= QUALIFICATION_LIMITS.scratchBudgetBytes &&
    wallMs <= QUALIFICATION_LIMITS.wallClockMs;
  return {
    evidenceSchemaVersion: profiles.CAPACITY_EVIDENCE_SCHEMA_VERSION,
    profile: profile.id,
    dimension: profile.dimension,
    mode: profile.mode,
    rung,
    rows: declaredRows,
    declaredEdges,
    outcome: passed ? 'PASS' : 'FAIL',
    wallClockMs: wallMs,
    sourceBytes: inputBytes,
    ...result,
    peakRssBytes,
    memoryBudgetBytes: QUALIFICATION_LIMITS.memoryBudgetBytes,
    scratchBudgetBytes: QUALIFICATION_LIMITS.scratchBudgetBytes,
    // Throughput over the bytes the reader was given, in decimal megabytes per
    // second, which is how parser throughput is quoted.
    // Every reproduction carries the stages of the run that produced it: the
    // first one's come from the child's record, the rest from their own.
    reproductions: reproductions.map((entry, index) => (index === 0 ? { ...entry, stages: result.stages ?? [] } : entry)),
    // The attest stage, measured in the process that performed it. It is
    // deliberately not inside the run's wall clock — attesting is a separate
    // act an operator performs afterwards, with its own memory — and it is
    // deliberately not absent either, because the resource contract names six
    // stages and a record that measured five was reporting most of a sequence.
    stages: [
      ...(result.stages ?? []),
      {
        stage: 'attest',
        wallMs: attestMs ?? 0,
        peakRssBytes: attestation.peakRssBytes ?? null,
        peakRssBytesReason: attestation.peakRssBytes === undefined || attestation.peakRssBytes === null ? 'the attest pass reported no peak' : null,
        maxRssDeltaBytes: null,
        maxRssDeltaBytesReason: 'the attest pass runs in its own process and reports its own high-water mark',
        scratchLiveBytesAtEnd: 0,
        scratchLiveBytesAtEndReason: null,
        scratchPeakLiveBytesSoFar: null,
        scratchPeakLiveBytesSoFarReason: 'the attest pass owns a store of its own and disposes it before it reports',
        scratchSampledBytesAtEnd: 0,
        scratchSampledBytesAtEndReason: null,
      },
    ],
    attestationOk: attestation.ok,
    attestationChecks: attestation.checks,
    attestationProblems: attestation.problems,
    attestationPeakRssBytes: attestation.peakRssBytes ?? null,
    sourceMegabytesPerSecond: wallMs === 0 ? null : Number((inputBytes / 1e6 / (wallMs / 1000)).toFixed(2)),
    rowsPerSecond: wallMs === 0 ? null : Math.round(declaredRows / (wallMs / 1000)),
  };
}

// --------------------------------------------------------------------- the CLI

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

/**
 * Source-backed verification, in a process of its own.
 *
 * Separate from `--child` because it re-derives the whole migration: asking one
 * process to hold the run being measured and the run being re-derived was an OOM
 * at a million rows on a profile that had passed at 77.6% of the budget an hour
 * before. It also measures the wrong thing — the peak this harness reports is
 * meant to be what a customer's migration costs, and an operator attests
 * afterwards, separately, with memory of their own.
 */
if (args.includes('--attest-case')) {
  const caseDir = flag('--attest-case');
  const out = flag('--attest-out');
  let attestation = { ok: false, checks: 0, problems: ['source-backed verification did not run'] };
  try {
    const { verifyAgainstSource } = await import('../dist/src/verify/verify-against-source.js');
    const { loadConfig } = await import('../dist/src/mapping/load-config.js');
    const { attestationInputFor } = await import(new URL('qualification-attestation.mjs', import.meta.url).href);
    const configPath = join(caseDir, 'config.json');
    const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
    // The same evidence the run was given. A verification that re-derived
    // without it would derive a different truth and blame the package for the
    // difference — which is what happened to every CRM package until the
    // contract was passed through.
    const strong = verifyAgainstSource({
      packageDir: join(caseDir, 'package'),
      sourceRoot: join(caseDir, 'input'),
      configPath,
      ...attestationInputFor(loaded.config.target.mode),
    });
    attestation = {
      ok: strong.problems.length === 0,
      checks: strong.checks.length,
      problems: strong.problems.slice(0, 5).map((problem) => `${problem.check}: ${problem.detail}`),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
  } catch (error) {
    attestation = {
      ok: false,
      checks: 0,
      problems: [`source-backed verification threw: ${String(error && error.message ? error.message : error)}`],
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
  }
  writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`);
  process.exit(0);
}

if (args.includes('--child')) {
  const peakOut = flag('--peak-out');
  try {
    await runChild(flag('--child'));
  } finally {
    // process.resourceUsage().maxRSS is the high-water mark the operating system
    // kept for this process, in kilobytes. It is recorded even if the run threw,
    // so a failure still reports what it cost before it failed.
    if (peakOut !== null && peakOut !== undefined) {
      // `process.resourceUsage().maxRSS` is the high-water mark the operating
      // system kept for this process, in kibibytes of 1024 bytes. Node documents
      // it that way; calling it megabytes and dividing was how this harness
      // reported a number a thousand times too small once.
      const maxRssKib = process.resourceUsage().maxRSS;
      writeFileSync(peakOut, `${String(maxRssKib * 1024)}\n`);
    }
  }
} else {
  mkdirSync(outRoot, { recursive: true });
  const manifest = profiles.loadProfiles();

  // `--ladder` runs every profile up the rungs, which is what MC-2 asks for and
  // takes hours. Without it, one profile at one size: `--profile P6 --rows 50000`.
  const ladder = args.includes('--ladder');
  /**
   * `--profile` takes a list, not just one name.
   *
   * With one name it selected one profile and with none it selected all fifteen,
   * and there was nothing in between — so writing the complementary matrix,
   * which needs P1 through P12 in a single invocation because it writes the file
   * from that invocation's results, also ran the three founding profiles and
   * threw the measurements away. At a million rows that is about an hour of a
   * machine's time spent producing nothing, every time the matrix is taken.
   *
   * A comma-separated list costs one `split` and removes the waste. It selects;
   * it does not scale anything down, and a name that matches nothing is still
   * refused by name rather than quietly ignored.
   */
  const wanted = flag('--profile');
  const names = wanted === null ? null : wanted.split(',').map((name) => name.trim()).filter((name) => name !== '');
  if (names !== null) {
    const declared = new Set(manifest.profiles.map((profile) => profile.id));
    const missing = names.filter((name) => !declared.has(name));
    if (missing.length > 0) {
      process.stderr.write(`no profile named ${missing.join(', ')}\n`);
      process.exit(64);
    }
  }
  const chosen = manifest.profiles.filter((profile) => names === null || names.includes(profile.id));
  if (chosen.length === 0) {
    process.stderr.write(`no profile named ${String(wanted)}\n`);
    process.exit(64);
  }
  const rungs = ladder ? RUNGS : [Number(flag('--rows') ?? 100_000)];

  /**
   * How many times each case is migrated.
   *
   * Two under `--founding`, because two is what a determinism claim needs and a
   * third proves nothing the second did not. One everywhere else: a smoke run
   * that took twice as long to say the same thing is a smoke run people stop
   * using.
   *
   * `--reproductions` is offered rather than fixed so a suspected
   * non-determinism can be chased with more passes, and lowering it below two on
   * a founding run is refused — the field it fills is read by a gate, and a
   * reproduction count of one is not a smaller answer, it is a different claim.
   */
  const foundingRun = args.includes('--founding');
  const reproductionPasses = (() => {
    const asked = flag('--reproductions');
    const wanted = asked === null ? (foundingRun ? 2 : 1) : Number(asked);
    if (!Number.isInteger(wanted) || wanted < 1) {
      process.stderr.write(`--reproductions must be a whole number of passes, at least 1\n`);
      process.exit(64);
    }
    if (foundingRun && wanted < 2) {
      process.stderr.write(
        'a founding run reproduces at least twice: candidate_bytes_deterministic asks whether a package is a\n' +
          'function of its source, and one run cannot answer that.\n',
      );
      process.exit(64);
    }
    return wanted;
  })();

  const mib = (bytes) => (bytes === null || bytes === undefined ? '' : (bytes / (1024 * 1024)).toFixed(0));
  const ms = (value) => (value === undefined ? '' : String(Math.round(value)));

  process.stdout.write(
    `capacity — profiles ${manifest.capacityProfilesVersion}, evidence ${manifest.evidenceSchemaVersion}, ` +
      `memory budget ${String(QUALIFICATION_LIMITS.memoryBudgetBytes)} bytes (${mib(QUALIFICATION_LIMITS.memoryBudgetBytes)} MiB), ` +
      `scratch budget ${String(QUALIFICATION_LIMITS.scratchBudgetBytes)} bytes\n\n`,
  );
  process.stdout.write(
    'profile  dimension            mode         rows      outcome   peak MiB  scratch MiB   run ms   pkg ms   verify ms   MB/s\n',
  );

  // Measured once, before anything runs, and recorded on every record this
  // invocation writes: the conversion the peak figures rest on, and the
  // subject the producer is measuring.
  const calibration = calibrateMaxRss();
  const started = await captureStart({ producer: 'tools/capacity.mjs' });

  const results = [];
  for (const profile of chosen) {
    for (const rung of rungs) {
      const measured = measure(profile, rung, reproductionPasses);
      results.push(measured);
      process.stdout.write(
        `${profile.id.padEnd(9)}${profile.dimension.padEnd(21)}${profile.mode.padEnd(13)}` +
          `${String(measured.rows).padEnd(10)}${String(measured.outcome).padEnd(10)}` +
          `${mib(measured.peakRssBytes).padStart(8)}${mib(measured.peakScratchBytes).padStart(13)}` +
          `${ms(measured.runMs).padStart(9)}${ms(measured.packageMs).padStart(9)}${ms(measured.verifyMs).padStart(12)}` +
          `${String(measured.sourceMegabytesPerSecond ?? '').padStart(7)}\n`,
      );
      if (measured.detail) process.stdout.write(`  ${measured.detail}\n`);

      // The corpus and the spill of a finished case are not evidence; the
      // measurement is, and it has already been taken. Twelve profiles at the
      // million rung generate several hundred gigabytes between them and the
      // matrix would stop on a full disk somewhere around the seventh — which
      // is a fact about this machine, not about the engine, and it would be
      // recorded as a capacity failure.
      //
      // `--keep` holds them for a case that needs looking at. Nothing
      // downstream reads them.
      if (!args.includes('--keep')) {
        rmSync(join(outRoot, `${profile.id}-${String(rung)}`), { recursive: true, force: true });
      }

      // A rung that did not pass makes the rungs above it meaningless.
      if (measured.outcome !== 'PASS') break;
    }
  }

  /**
   * Founding evidence, written where the gate reads it and in the shape it reads.
   *
   * The ladder's own output is not that. It goes to `bench/capacity/ladder.json`,
   * which `.gitignore` excludes, as one object holding an array, keyed `outcome`
   * and `rows`. The gate scans `qualification/capacity/*.json` for one file per
   * mode keyed `result` and `sourceRows`. So a genuinely passing ladder produced
   * evidence that scored as nothing, in a directory no checkout would ever see —
   * a producer and a consumer that had never been run against each other.
   *
   * This writes the committed form: one file per mode, every quantity an integer
   * count of bytes or milliseconds, and the per-family scratch accounting the
   * amplification claim needs. It is deliberately not the ladder's file renamed,
   * because the two answer different questions — the ladder is a working
   * measurement and this is evidence about a candidate.
   */
  /**
   * The complementary matrix, at the scale each profile declares.
   *
   * The three founding profiles are integral: each is one mode's real work, and
   * each stresses many dimensions at once. P1 to P12 are the opposite shape —
   * one dimension each, sized as a share of the rung by their own `rowFactor`,
   * so P2 at the million rung is a hundred thousand very wide rows and P6 is a
   * million narrow ones with relationships across three objects.
   *
   * "At its declared scale" therefore means the rung times the profile's own
   * factor, and it is the profile that says which — not this file, and not a
   * number chosen to make a run finish sooner. `declaredRows` is written beside
   * `sourceRows` so a reader can see the two agree, and the rung is recorded so
   * nobody has to infer what scale the matrix was taken at.
   */
  if (args.includes('--matrix')) {
    const evidenceRoot = join(repoRoot, 'qualification', 'capacity');
    mkdirSync(evidenceRoot, { recursive: true });
    const matrixResults = results
      .filter((measured) => /^P\d+$/u.test(String(measured.profile)))
      .map((measured) => ({
        profile: measured.profile,
        dimension: measured.dimension,
        mode: measured.mode,
        rung: measured.rung,
        // What the profile's parameters say this rung should produce, and what
        // the reader actually produced. The harness compares them itself; a
        // matrix that only recorded one of them could not be checked.
        declaredRows: measured.declaredRows ?? measured.rows,
        sourceRows: measured.sourceRows ?? measured.rows,
        result: measured.outcome === 'PASS' ? 'PASS' : 'FAIL',
        detail: measured.detail ?? null,
        measured: {
          sourceBytes: measured.sourceBytes,
          packageBytes: measured.packageBytes ?? null,
          peakRssBytes: measured.peakRssBytes ?? null,
          peakScratchBytes: measured.peakScratchBytes ?? null,
          scratchBytesWritten: measured.scratchBytesWritten ?? null,
          wallClockMs: Math.round(measured.wallClockMs),
        },
        reconciliation: {
          rowsIngested: measured.rowsIngested ?? null,
          delivered: measured.delivered ?? null,
          edges: measured.edges ?? null,
          declaredEdges: measured.declaredEdges ?? null,
          equationHolds: measured.equationHolds ?? null,
          checksRun: measured.checksRun ?? null,
        },
        verification: { ok: measured.ok === true, attestationOk: measured.attestationOk ?? null },
      }));
    writeFileSync(
      join(evidenceRoot, 'matrix.json'),
      `${JSON.stringify(
        {
          evidenceSchemaVersion: profiles.CAPACITY_EVIDENCE_SCHEMA_VERSION,
          gate: 'CAPACITY-PROFILE-MATRIX',
          observedAt: nowUtc(),
          capture: await captureEnd(started),
          note:
            'The complementary dimension matrix. Each profile is sized as a share of the rung by its own rowFactor, ' +
            'and declaredRows is what those parameters say the rung should produce. Nothing here was scaled down to finish sooner.',
          rungs,
          capacityProfilesVersion: manifest.capacityProfilesVersion,
          limits: {
            hardMemoryLimitBytes: QUALIFICATION_LIMITS.hardMemoryBytes,
            memoryBudgetBytes: QUALIFICATION_LIMITS.memoryBudgetBytes,
            hardScratchLimitBytes: QUALIFICATION_LIMITS.hardScratchBytes,
            scratchBudgetBytes: QUALIFICATION_LIMITS.scratchBudgetBytes,
            wallClockLimitMs: QUALIFICATION_LIMITS.wallClockMs,
          },
          environment: capacityEnvironment(calibration),
          results: matrixResults,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`  matrix: ${join(evidenceRoot, 'matrix.json')} (${String(matrixResults.length)} profiles)\n`);
    if (matrixResults.length === 0) {
      process.stderr.write(
        `--matrix was asked for and none of the ${String(results.length)} measurements is a matrix profile, so the file holds no results.\n` +
          `The measurements name: ${results.map((entry) => JSON.stringify(entry.profile)).join(', ')}\n`,
      );
      process.exitCode = 1;
    }
  }

  if (args.includes('--founding')) {
    const evidenceRoot = join(repoRoot, 'qualification', 'capacity');
    mkdirSync(evidenceRoot, { recursive: true });
    let written = 0;
    for (const measured of results) {
      if (!String(measured.profile).startsWith('FOUNDING-')) continue;
      const record = {
        evidenceSchemaVersion: profiles.CAPACITY_EVIDENCE_SCHEMA_VERSION,
        gate: 'CAPACITY-FOUNDING',
        scope: 'MIGRATION_CORE',
        note:
          'The Migration-Core-shaped subset of CAPACITY-FOUNDING: a million representative source rows end to end in one mode, ' +
          'inside the founding budgets, measured in bytes. The full-stack traversal named by the qualification canonical — upload ' +
          'authorization, object storage read-back, malware preflight, outbox — belongs to a later front and is not discharged here.',
        observedAt: nowUtc(),
        capture: await captureEnd(started),
        mode: measured.mode,
        profile: measured.profile,
        dimension: measured.dimension,
        sourceRows: measured.rows,
        result: measured.outcome === 'PASS' ? 'PASS' : 'FAIL',
        // Why, when the answer is FAIL.
        //
        // The record carried the verdict and not the reason: `result: "FAIL"`,
        // every measured figure null, `verification.problems: 0`. A reader
        // could not tell a run that blew the memory budget from one whose child
        // never started, and `problems: 0` beside a failure reads as "nothing
        // was wrong" rather than as "nothing was counted". The outcome the
        // harness computed and the detail it printed to the terminal both
        // belong in the file the gate reads.
        outcome: measured.outcome,
        detail: measured.detail ?? null,
        childLog: measured.childLog ?? null,
        limits: {
          hardMemoryLimitBytes: QUALIFICATION_LIMITS.hardMemoryBytes,
          memoryBudgetBytes: QUALIFICATION_LIMITS.memoryBudgetBytes,
          hardScratchLimitBytes: QUALIFICATION_LIMITS.hardScratchBytes,
          scratchBudgetBytes: QUALIFICATION_LIMITS.scratchBudgetBytes,
          wallClockLimitMs: QUALIFICATION_LIMITS.wallClockMs,
        },
        measured: {
          sourceBytes: measured.sourceBytes ?? null,
          packageBytes: measured.packageBytes ?? null,
          // Written as null when it was not taken, and written at all.
          // `peakRssBytes: measured.peakRssBytes` with nothing measured put
          // `undefined` here, and `JSON.stringify` drops an undefined property
          // — so the field vanished from the record entirely and the reader
          // that looks for it could not tell an absent measurement from a
          // schema it did not understand.
          peakRssBytes: measured.peakRssBytes ?? null,
          peakScratchBytes: measured.peakScratchBytes ?? null,
          scratchBytesWritten: measured.scratchBytesWritten ?? null,
          // The store's own high-water mark and the quota it was actually
          // constructed with. `peakScratchBytes` above is a directory walk
          // sampled at stage boundaries: it cannot see a segment created and
          // reclaimed between two of them, and it sees nothing at all once a
          // spent run has been deleted. The scratch model judges the peak
          // against the budget, so it needs the figure the store kept rather
          // than the figure the walk happened to catch — and it needs to know
          // the run was measured against the canonical budget rather than
          // against some other number the host passed in.
          scratchPeakLiveBytes: measured.scratchPeakLiveBytes ?? null,
          scratchLiveBytes: measured.scratchLiveBytes ?? null,
          scratchQuotaBytes: measured.scratchQuotaBytes ?? null,
          scratchFramingBytesPerLine: measured.scratchFramingBytesPerLine ?? null,
          // A stage that did not run has no duration, and zero is a duration.
          // MC-2 wrote `?? 0` here, so a run whose child never started reported
          // a migration that took no time at all and a package that was written
          // instantly — figures a throughput calculation will happily divide by.
          wallClockMs: msOrNull(measured.wallClockMs),
          runMs: msOrNull(measured.runMs),
          packageMs: msOrNull(measured.packageMs),
          verifyMs: msOrNull(measured.verifyMs),
          cpuUserMicroseconds: measured.cpuUserMicroseconds ?? null,
          cpuSystemMicroseconds: measured.cpuSystemMicroseconds ?? null,
          rowsPerSecond: measured.rowsPerSecond ?? null,
          maxRssUnit: calibration.unit,
        },
        stages: measured.stages ?? [],
        // What the profile pass established, so a reader can see that the stage
        // did the work rather than merely occupying time in the table.
        sourceProfile: measured.sourceProfile ?? null,
        cleanup: measured.cleanup ?? null,
        // One shape. tools/scratch-model.mjs orders it for itself and
        // tools/release-candidate-gate.mjs reads it as it stands; the list this
        // was emitted beside for one round was the same records again, and the
        // reason given for it — that the model needs a stated order — was not
        // true of the model.
        scratchByFamily: measured.scratchByFamily ?? null,
        reconciliation: {
          sourceRows: measured.sourceRows,
          rowsIngested: measured.rowsIngested,
          delivered: measured.delivered,
          edges: measured.edges,
          declaredEdges: measured.declaredEdges,
          equationHolds: measured.equationHolds ?? null,
          checksRun: measured.checksRun ?? null,
          problems: measured.problems ?? null,
        },
        verification: {
          ok: measured.ok === true,
          // Null, not zero. "The verification ran no checks and found no
          // problems" and "the verification never ran" were the same record.
          checksRun: measured.checksRun ?? null,
          problems: measured.problems ?? null,
          attestationOk: measured.attestationOk ?? null,
        },
        reproductions: measured.reproductions ?? [],
        environment: capacityEnvironment(calibration),
      };
      const path = join(evidenceRoot, `${measured.mode.toLowerCase().split('_').join('-')}.json`);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      process.stdout.write(`  evidence: ${path}\n`);
      written += 1;
    }
    // A run that was asked for founding evidence and wrote none says so.
    //
    // The filter above skips a measurement whose profile id does not start with
    // FOUNDING-, and a passing run once carried an object there instead of the
    // id — so every measurement was skipped, nothing was written, and the
    // harness printed PASS. A campaign would have spent four hours and produced
    // an empty directory that nobody would look at until the gate ran.
    if (written === 0) {
      process.stderr.write(
        `--founding was asked for and none of the ${String(results.length)} measurements is a founding profile, so no evidence was written.\n` +
          `The measurements name: ${results.map((entry) => JSON.stringify(entry.profile)).join(', ')}\n`,
      );
      process.exitCode = 1;
    }
  }

  writeFileSync(
    join(outRoot, 'ladder.json'),
    `${JSON.stringify(
      {
        evidenceSchemaVersion: manifest.evidenceSchemaVersion,
        capacityProfilesVersion: manifest.capacityProfilesVersion,
        limits: QUALIFICATION_LIMITS,
        // What this run is and is not. A ladder that did not climb to a million
        // rows in every mode is not the founding qualification, and saying so
        // here is what stops the file being read as one.
        scope: ladder ? 'FULL_LADDER' : 'SINGLE_RUNG',
        results,
      },
      null,
      2,
    )}\n`,
  );
  const failed = results.filter((entry) => entry.outcome !== 'PASS');
  process.stdout.write(`\n${ladder ? 'CAPACITY-FOUNDING' : 'CAPACITY-SMOKE'} = ${failed.length === 0 ? 'PASS' : 'FAIL'}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

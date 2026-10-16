#!/usr/bin/env node
/**
 * Is the verifier bounded, or does it need the artifact?
 *
 * Run as a fresh process against a package, with a heap ceiling if the caller
 * wants one:
 *
 *   node [--max-old-space-size=<mib>] tools/verifier-memory-probe.mjs <packageDir>
 *
 * Exit 0: the package verified, and every bound below held.
 * Exit 1: the probe refuses to certify, and the last line on stderr says why --
 *         the package did not verify, or a bound was exceeded, or the
 *         measurement itself could not be trusted.
 * Any other exit, or a signal: the verifier could not work in that heap.
 *
 * ---- why the exit code no longer means "it did not die" ----
 *
 * The first version of this probe decided on survival: give the process a heap
 * smaller than the package, and a verifier that materialises an artifact dies
 * while one that streams finishes. Then it printed numbers beside that verdict.
 *
 * An adversarial reading of that arrangement was right about it: nothing read
 * the numbers, so `verifier_bounded` still meant "the probe chose to exit 0",
 * which is a fact made true by running the tool. Two measurements, taken here
 * on 2026-09-04 with the exact command `tools/architecture-gate.mjs` uses, show
 * that the survival argument was not merely unread but unsound:
 *
 *   - `node --max-old-space-size=96` leaves `v8.getHeapStatistics()
 *     .heap_size_limit` at 301,989,888 bytes. V8 adds its non-old-space
 *     reservation on top of the flag, so the ceiling actually in force was
 *     288 MiB, not 96 MiB;
 *   - the package the gate builds at 120,000 rows weighs 78,718,317 bytes,
 *     which is under even the 100,663,296-byte old space that flag does buy.
 *
 * A package that fits in the heap cannot be proved not to be held by the fact
 * that the process lived. So survival is no longer the proof. The probe forces
 * a collection at every point the verification passes, measures what is still
 * reachable afterwards, and compares that against a bound derived from the
 * package in front of it. The heap ceiling is now a reported condition, not the
 * argument.
 *
 * ---- the bounds, and where each number comes from ----
 *
 * Every bound is derived from the package handed to this run or from what the
 * verification itself reports. None of them is a figure written down here,
 * because a limit this file chose is a limit this file can be edited to meet.
 *
 *  1. The verification must read at least the package.
 *     `bytesRead` is counted at `fs.readSync` and `fs.readFileSync`, and the
 *     bound is `packageBytes`, measured by walking the directory. A verifier
 *     cannot check a package it did not read, so a count below that means the
 *     counter did not take effect and every other number here is worthless.
 *     This bound exists because that is exactly what happened: the previous
 *     version wrapped the two calls but also carried a static
 *     `import { readdirSync, statSync } from 'node:fs'`. A static import is
 *     evaluated before the module body, which instantiates the `node:fs` ESM
 *     facade and snapshots its named exports from the originals, so the
 *     verifier -- an ES module that imports `readSync` by name -- bound the
 *     unwrapped functions and the probe reported 10 calls and 11,714 bytes for
 *     a 78,718,317-byte package. The import is gone, `fs` comes from
 *     `createRequire` below, and the bound would fail the run rather than
 *     print a confident number if it ever comes back.
 *
 *  2. What the verification still holds must be smaller than the largest
 *     artifact it read.
 *     Measured as the peak of `heapUsed + external` taken after two forced
 *     collections at each of the verification's own observation points, less the
 *     same reading taken before it started. The bound is the size of the largest
 *     single file in the package, taken from the file system rather than from
 *     `manifest.json`, so a tampered manifest cannot raise the bar it is
 *     judged against. This is the gate's sentence -- "the checks do not hold
 *     the artifacts" -- stated as arithmetic: at the moment it holds the most,
 *     the verification holds less than the largest thing it is reading.
 *
 *     It read `heapUsed` alone until 2026-09-04, and that made it certify the
 *     exact defect it exists to catch. An artifact is held as a Buffer, a
 *     Buffer's payload is external memory rather than heap, and a verifier that
 *     read every artifact of the package and never released one was measured at
 *     1,192,672 bytes -- *lower* than the honest verifier's figure, because the
 *     honest one does its work on the heap. One shape of retention was invisible
 *     to the only bound that looks for retention. `external` already includes
 *     `arrayBuffers`, so the sum is the two halves and not three.
 *
 *     Nothing else in the system enforces it. The old space the gate hands out
 *     is larger than that artifact, so a verifier that read the biggest table
 *     into a string would survive and fail this.
 *
 *     What it does not prove, said plainly rather than left to be discovered:
 *     one run at one size cannot show that retention is independent of the row
 *     count, because one point does not determine a slope. So the slope was
 *     measured separately, on 2026-09-04, against two packages from the gate's
 *     own builder, at 30,000 and 120,000 rows:
 *
 *       before `verify-package.ts` stopped noting every produced migration key
 *       in its destination-conflict map: 5,700,840 and 13,363,064 bytes, which
 *       is a slope of about 85 bytes per source row;
 *       after: 1,664,152 and 1,296,840 bytes, which is no slope at all.
 *
 *     `retainedBytesPerSourceRow` is printed so the next reader gets that
 *     number without having to build two packages, and a reading that starts
 *     climbing with the rows is the signal that something began holding the
 *     dataset again.
 *
 * A bound that cannot fail is not a bound, so both were made to fail before
 * they were relied on, on 2026-09-04:
 *
 *   - restoring the static `node:fs` import and changing nothing else exits 1
 *     with "the read counter did not take effect: the verification read 11,714
 *     bytes in 10 calls, which is less than the 78,718,317 bytes of the package
 *     it verified";
 *   - pointing the probe at a 200-row package exits 1 with "it retained
 *     1,329,080 bytes at destinationMatching.contractRecorded, and the largest
 *     artifact it read weighs 96,131 bytes". That is the honest answer there
 *     rather than a false positive: what a verification holds does not fall
 *     below the size of a package that small, so such a package cannot
 *     demonstrate anything about boundedness, and refusing to certify from it
 *     is the difference between this probe and one that exits 0 on evidence
 *     that proves nothing.
 *
 * ---- what else is reported ----
 *
 * Every quantity printed is a byte or a millisecond read off the process, the
 * operating system or the package at a named moment; never a ratio, never a
 * unit in a field name, so a number here can be compared against a budget
 * stated in bytes without anybody converting anything.
 *
 * With `--trace` the retained heap and the elapsed time are printed at each
 * point the verification passes, which is how growth is attributed to a check
 * rather than guessed at. With `--json` the measurements are printed as one
 * object on stdout. The verdict lines stay on stderr either way, in the shape
 * `tools/architecture-gate.mjs` reads.
 *
 * ---- the other half, and the bound that fits it ----
 *
 *   node [--max-old-space-size=<mib>] tools/verifier-memory-probe.mjs --attest \
 *        --source <dir> --config <file> [--target-contract <file>] \
 *        [--attestation <file>] [--attestation-issuer <file>] \
 *        [--attestation-instant <iso>] <packageDir>
 *
 * `verifyPackage` reads a package and checks it against itself. It was the only
 * thing this probe could see, and the half it could not see was the stronger
 * one: `verifyAgainstSource` re-derives the truth from the original source bytes
 * and compares. Nothing measured it, and on 2026-09-05 it turned out to retain
 * about sixteen kilobytes per source row and to be unable to attest a package at
 * the capacity this engine declares — while `verifier_bounded` read TRUE, because
 * the verifier it named was the other one.
 *
 * The bound cannot be the same sentence, and pretending it could would be the
 * mistake this probe exists to avoid. This call *contains a migration*: it runs
 * the whole engine again over the source, so what the process holds at its peak
 * is properly larger than any one artifact and always will be. What must be
 * bounded is the **comparison** — the part that reads two packages and says
 * whether they agree — and that is measurable separately because
 * `verifyAgainstSource` reports when the re-derivation is done and the run's
 * result is out of reach. So:
 *
 *  3. It must read at least the package and the source it was checked against.
 *     Both are measured by walking the directories, and a count below their sum
 *     means the counter did not take effect and every other number is worthless.
 *
 *  4. What the comparison still holds must be smaller than the largest artifact
 *     it read. Measured as the peak of `heapUsed + external` after two forced
 *     collections at each of the comparison's own observation points, less the
 *     same reading taken at `authority.rederived` — which is the first point
 *     after the re-derivation's result went out of scope. The bound is the size
 *     of the largest single file in the package, from the file system rather
 *     than from `manifest.json`, so a tampered manifest cannot raise the bar it
 *     is judged against.
 *
 *     A bound that cannot fail is not a bound, so this one was made to fail
 *     before it was relied on, on 2026-09-05: putting the lineage back the way
 *     it was — one index per side, held across the comparison — and running this
 *     probe against the 125,375-row founding CLEAN_ONLY package exits 1 with
 *
 *       the comparison is not bounded on this package: it retained
 *       2,992,390,088 bytes at source.derivedIdentifiers, and the largest
 *       artifact it read weighs 64,819,304 bytes
 *
 *     which is the shipped defect, quoted by the bound that now catches it, at a
 *     factor of forty-six. The same package with the merge in place reports
 *     1,028,632 bytes, and 156,888 at twice the rows. Nothing else in the system
 *     enforces it.
 *
 * `retainedBytesPerSourceRow` is reported here too, over the lineage rows
 * counted off the artifact rather than read out of the manifest. One run cannot
 * determine a slope, which is why it is reported rather than bounded; two runs
 * at two sizes can, and the number is printed so the next reader has it without
 * building two packages first.
 *
 * A CRM package needs the evidence its run needed, for the reason
 * `verifyAgainstSource` explains: the target contract is an input to the
 * re-derivation, not a permission slip. The probe passes those files through and
 * refuses rather than inventing any of them, because a probe that supplied its
 * own evidence would be measuring a verification nobody asked for.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setFlagsFromString, getHeapStatistics } from 'node:v8';
import { runInNewContext } from 'node:vm';

const argv = process.argv.slice(2);
const trace = argv.includes('--trace');
const asJson = argv.includes('--json');
const attesting = argv.includes('--attest');

/**
 * A flag's value, and nothing else taken as one.
 *
 * The positional argument is the package, and every other value belongs to the
 * flag in front of it. Filtering on a leading `--` alone would have made
 * `--source <dir>` contribute `<dir>` to the positional list and the probe would
 * have measured the source directory as though it were the package.
 */
const VALUED = new Set([
  '--source',
  '--config',
  '--target-contract',
  '--attestation',
  '--attestation-issuer',
  '--attestation-instant',
]);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const positional = argv.filter(
  (value, index) => !value.startsWith('--') && !VALUED.has(argv[index - 1] ?? ''),
);
const packageDir = positional[0];
const USAGE =
  'usage: verifier-memory-probe.mjs [--trace] [--json] <packageDir>\n' +
  '       verifier-memory-probe.mjs --attest --source <dir> --config <file>\n' +
  '           [--target-contract <file>] [--attestation <file>]\n' +
  '           [--attestation-issuer <file>] [--attestation-instant <iso>]\n' +
  '           [--trace] [--json] <packageDir>\n';
if (packageDir === undefined) {
  process.stderr.write(USAGE);
  process.exit(64);
}
if (attesting && (flag('--source') === undefined || flag('--config') === undefined)) {
  process.stderr.write(USAGE);
  process.exit(64);
}

// ---------------------------------------------------------------- bytes read
//
// Counted at the two calls the verifier reads through, wrapped before anything
// that uses them is loaded. `import` of a built-in binds its named exports when
// the importing module is first evaluated, so the verifier has to be brought in
// with a dynamic import *after* this -- which is why the loading below is not at
// the top of the file where it would ordinarily be, and why there is no static
// `node:fs` import anywhere above: one instantiates the facade the verifier
// will bind, and the wrappers then count nothing. Bound 1 fails the run if that
// ever happens again, rather than printing a confident number.
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const realReadSync = fs.readSync;
const realReadFileSync = fs.readFileSync;
let bytesRead = 0;
let readCalls = 0;
fs.readSync = function countedReadSync(...parameters) {
  const read = realReadSync.apply(this, parameters);
  bytesRead += read;
  readCalls += 1;
  return read;
};
fs.readFileSync = function countedReadFileSync(...parameters) {
  const contents = realReadFileSync.apply(this, parameters);
  bytesRead += typeof contents === 'string' ? Buffer.byteLength(contents, 'utf8') : contents.length;
  readCalls += 1;
  return contents;
};

// ------------------------------------------------------------ retained bytes
//
// `heapUsed` without a collection is allocation, not retention: under a 96 MiB
// old space V8 lets tens of megabytes of garbage accumulate before it collects,
// so a peak taken from it says how much the verification allocated between two
// collections and nothing about what it holds. What this probe is about is what
// is still reachable, so the heap is collected before every reading.
//
// `--expose-gc` is not on the command line and cannot be, because the gate
// spawns this with the flags it already has. Turning the flag on from inside
// the process and pulling `gc` out of a fresh context is the way to get a
// collection without dictating how the probe is invoked. If a future runtime
// takes that away the probe refuses to report rather than silently going back
// to measuring allocation: an unforced reading would pass bound 2 or fail it
// for reasons that have nothing to do with what the verifier held.
let collect = null;
try {
  setFlagsFromString('--expose-gc');
  const exposed = runInNewContext('gc');
  if (typeof exposed === 'function') collect = exposed;
} catch {
  collect = null;
}
if (collect === null) {
  process.stderr.write(
    'the probe cannot force a collection on this runtime, so retained bytes cannot be measured and nothing here may be certified\n',
  );
  process.exit(1);
}

const { verifyPackage } = await import('../dist/src/verify/verify-package.js');
const { createFilesystemScratchStore } = await import('../dist/src/scratch/filesystem-scratch-store.js');
const { SCRATCH_BUDGET_BYTES } = await import('../dist/src/domain/resource-profile.js');
const { verifyAgainstSource } = attesting
  ? await import('../dist/src/verify/verify-against-source.js')
  : { verifyAgainstSource: null };
const { loadTargetContract } = attesting
  ? await import('../dist/src/target/contract.js')
  : { loadTargetContract: null };
const { parseTargetAttestation, parseAttestationAuthorities } = attesting
  ? await import('../dist/src/target/attestation.js')
  : { parseTargetAttestation: null, parseAttestationAuthorities: null };

/**
 * What the package weighs, and what its largest single file weighs.
 *
 * Both from the file system. The manifest states the same two numbers and is
 * part of what is under test, so a bound taken from it would move with the
 * tamper it is supposed to survive.
 */
function measurePackage(dir) {
  let total = 0;
  let largest = 0;
  let largestPath = '';
  let files = 0;
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const { size } = fs.statSync(path);
      total += size;
      files += 1;
      if (size > largest) {
        largest = size;
        largestPath = path;
      }
    }
  };
  walk(dir);
  return { packageBytes: total, largestArtifactBytes: largest, largestArtifactPath: largestPath, artifactFiles: files };
}

let measured = null;
try {
  measured = measurePackage(resolve(packageDir));
} catch (error) {
  // Said as one line rather than as a stack, because the gate quotes the last
  // line of stderr and a stack frame is not a reason.
  process.stderr.write(
    `the package could not be measured: ${String(error && error.message ? error.message : error)}\n`,
  );
  process.exit(1);
}
if (measured.packageBytes === 0) {
  process.stderr.write(`there is nothing in ${resolve(packageDir)} to verify\n`);
  process.exit(1);
}

/**
 * The source, weighed the same way and for the same reason.
 *
 * Source-backed verification reads the original bytes as well as the package,
 * so "it must have read at least what it claims to have checked" is the sum of
 * the two. Zero here would mean the probe is about to certify a verification of
 * a source that is not there.
 */
let sourceMeasured = { packageBytes: 0 };
if (attesting) {
  try {
    sourceMeasured = measurePackage(resolve(flag('--source')));
  } catch (error) {
    process.stderr.write(
      `the source could not be measured: ${String(error && error.message ? error.message : error)}\n`,
    );
    process.exit(1);
  }
  if (sourceMeasured.packageBytes === 0) {
    process.stderr.write(`there is nothing in ${resolve(flag('--source'))} to verify against\n`);
    process.exit(1);
  }
}

/**
 * How many rows the package accounts for, counted off the artifact.
 *
 * `verifyPackage` reports this; `verifyAgainstSource` does not, because it is
 * not a fact about the verification. Counting record separators outside quotes
 * in `source-lineage.csv` is the cheapest honest answer and it is a measurement
 * of the bytes rather than a figure read out of the manifest, which is part of
 * what is under test. It is used for one reported ratio and for nothing that is
 * bounded, so a package whose lineage is missing reports zero rather than
 * stopping the run.
 */
function countLineageRows(dir) {
  const path = join(resolve(dir), '03_TRACEABILITY', 'source-lineage.csv');
  let handle;
  try {
    handle = fs.openSync(path, 'r');
  } catch {
    return 0;
  }
  const buffer = Buffer.allocUnsafe(1 << 16);
  let records = 0;
  let quoted = false;
  let sawAny = false;
  try {
    for (;;) {
      const read = realReadSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      for (let index = 0; index < read; index += 1) {
        const byte = buffer[index];
        if (byte === 0x22) {
          quoted = !quoted;
          sawAny = true;
          continue;
        }
        if (quoted) {
          sawAny = true;
          continue;
        }
        if (byte === 0x0a) {
          records += 1;
          sawAny = false;
          continue;
        }
        if (byte !== 0x0d) sawAny = true;
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  if (sawAny) records += 1;
  // The header is a record and it is not a row.
  return Math.max(0, records - 1);
}

// Beside the package, and removed afterwards. The probe is measuring heap, and
// spilling to disk is how a bounded verifier stays inside one.
const scratch = createFilesystemScratchStore({
  root: resolve(`${packageDir}.kauro-verify`),
  runId: 'probe',
  quotaBytes: SCRATCH_BUDGET_BYTES,
});

/** One reading of the process, in bytes, at a named moment, after a collection. */
function sample() {
  // Twice, because one collection leaves what the first made unreachable.
  collect();
  collect();
  const usage = process.memoryUsage();
  return {
    residentSetBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

const peak = { residentSetBytes: 0, heapTotalBytes: 0, heapUsedBytes: 0, externalBytes: 0, arrayBuffersBytes: 0 };
function keepPeak(reading) {
  for (const key of Object.keys(peak)) {
    if (reading[key] > peak[key]) peak[key] = reading[key];
  }
}

const startedAt = Date.now();
// Sampled at every point the verification passes. A peak nobody sampled is a
// peak nobody can report, and the operating system's own high-water mark below
// is what covers the gaps between samples -- for the resident set, which is the
// only one it knows about.
let observations = 0;
let heldMostAt = 'nothing observed';

/**
 * What a reading actually holds: the heap and the memory outside it.
 *
 * This read `heapUsed` alone, and a verifier that held the entire package was
 * certified by it — because an artifact is held as a Buffer and a Buffer's
 * payload is external memory, not heap. The one shape of retention this probe
 * exists to catch was the one shape it could not see, and the number it printed
 * for the honest verifier was the larger of the two.
 *
 * `external` already includes `arrayBuffers`, so adding both would count the
 * same bytes twice.
 */
const held = (reading) => reading.heapUsedBytes + reading.externalBytes;

/**
 * The comparison, measured apart from the migration it sits behind.
 *
 * `verifyAgainstSource` runs the whole engine again before it compares
 * anything, so the peak of the call says nothing about the comparison: a
 * process that has just held a migration is properly larger than any one
 * artifact. `authority.rederived` is reported once the run's result is out of
 * reach, and everything after it is the comparison. Its own high-water mark,
 * less the reading at that point, is the figure bound 4 judges.
 */
let comparisonBaseline = null;
let comparisonPeak = 0;
let comparisonHeldMostAt = 'the comparison was not reached';

const observe = (where) => {
  const reading = sample();
  observations += 1;
  if (held(reading) > held(peak)) heldMostAt = where;
  keepPeak(reading);
  if (where === 'authority.rederived') {
    comparisonBaseline = held(reading);
    comparisonPeak = held(reading);
    comparisonHeldMostAt = where;
  } else if (comparisonBaseline !== null && held(reading) > comparisonPeak) {
    comparisonPeak = held(reading);
    comparisonHeldMostAt = where;
  }
  if (trace) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stderr.write(`${String(reading.heapUsedBytes).padStart(11)} retained, ${seconds}s at ${where}\n`);
  }
};

const before = sample();
keepPeak(before);
// Only the verification is measured. Loading the modules above read them off
// disk through the very wrappers that are counting, and that is the probe's own
// I/O, not the verifier's.
bytesRead = 0;
readCalls = 0;

let report = null;
let thrown = null;
let measurements = null;
try {
  report = attesting
    ? verifyAgainstSource({
        packageDir,
        sourceRoot: flag('--source'),
        configPath: flag('--config'),
        // Passed through, never supplied. The target contract is an input to
        // the re-derivation rather than a permission slip, so a probe that
        // built one would be measuring a verification of its own invention.
        targetContract:
          flag('--target-contract') === undefined
            ? null
            : loadTargetContract(
                realReadFileSync(resolve(flag('--target-contract')), 'utf8'),
                resolve(flag('--target-contract')),
              ),
        targetAttestation:
          flag('--attestation') === undefined
            ? null
            : parseTargetAttestation(
                realReadFileSync(resolve(flag('--attestation')), 'utf8'),
                resolve(flag('--attestation')),
              ),
        attestationAuthorities:
          flag('--attestation-issuer') === undefined
            ? []
            : parseAttestationAuthorities(
                realReadFileSync(resolve(flag('--attestation-issuer')), 'utf8'),
                resolve(flag('--attestation-issuer')),
              ),
        attestationInstant: flag('--attestation-instant') ?? null,
        observe,
      })
    : verifyPackage(packageDir, { scratch, observe });
} catch (error) {
  thrown = error;
} finally {
  const after = sample();
  keepPeak(after);
  const elapsedMs = Date.now() - startedAt;
  // Node documents `maxRSS` in kibibytes. Re-read 2026-09-04; the arithmetic
  // below is the only place this probe turns a documented unit into bytes.
  const peakResidentSetBytes = process.resourceUsage().maxRSS * 1024;
  const heapCeilingBytes = getHeapStatistics().heap_size_limit;
  const retainedBytesGrown = held(peak) - held(before);
  // Counted off the artifact after the verification, through the uncounted
  // reads, so the probe's own arithmetic never lands in `bytesRead`.
  const sourceRows = report === null ? 0 : attesting ? countLineageRows(packageDir) : report.sourceRows;
  const comparisonRetainedBytesGrown =
    comparisonBaseline === null ? null : comparisonPeak - comparisonBaseline;

  measurements = {
    packageDir: resolve(packageDir),
    verification: attesting ? 'verifyAgainstSource' : 'verifyPackage',
    sourceRoot: attesting ? resolve(flag('--source')) : null,
    sourceBytes: attesting ? sourceMeasured.packageBytes : null,
    comparisonRetainedBytesGrown,
    comparisonHeldMostAt: attesting ? comparisonHeldMostAt : null,
    comparisonRetainedBytesPerSourceRow:
      comparisonRetainedBytesGrown === null || sourceRows === 0
        ? null
        : Math.round(comparisonRetainedBytesGrown / sourceRows),
    packageBytes: measured.packageBytes,
    artifactFiles: measured.artifactFiles,
    largestArtifactBytes: measured.largestArtifactBytes,
    largestArtifactPath: measured.largestArtifactPath,
    heapCeilingBytes,
    elapsedMs,
    bytesRead,
    readCalls,
    observations,
    sourceRows,
    retainedBytesBefore: held(before),
    retainedBytesPeak: held(peak),
    // Kept apart so a reader can see which half moved. A verifier that starts
    // holding artifacts moves the external half and leaves the heap alone.
    retainedHeapGrown: peak.heapUsedBytes - before.heapUsedBytes,
    retainedExternalGrown: peak.externalBytes - before.externalBytes,
    retainedBytesGrown,
    // Zero rows would be a division, not a measurement.
    retainedBytesPerSourceRow: sourceRows === 0 ? null : Math.round(retainedBytesGrown / sourceRows),
    heldMostAt,
    before,
    after,
    peak: { ...peak, residentSetBytes: Math.max(peak.residentSetBytes, peakResidentSetBytes) },
    peakResidentSetBytes,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);
  } else {
    const line = (label, value) => `${label.padEnd(30)}${value === null ? 'not measured' : String(value)}\n`;
    for (const [label, value] of [
      ['package bytes', measurements.packageBytes],
      ['artifact files', measurements.artifactFiles],
      ['largest artifact bytes', measurements.largestArtifactBytes],
      ['heap ceiling bytes', measurements.heapCeilingBytes],
      ['elapsed ms', measurements.elapsedMs],
      ['bytes read', measurements.bytesRead],
      ['read calls', measurements.readCalls],
      ['observations', measurements.observations],
      ['source rows', measurements.sourceRows],
      ['retained bytes before', measurements.retainedBytesBefore],
      ['retained bytes peak', measurements.retainedBytesPeak],
      ['retained bytes grown', measurements.retainedBytesGrown],
      ['retained bytes per row', measurements.retainedBytesPerSourceRow],
      ['source bytes', measurements.sourceBytes],
      ['comparison retained bytes', measurements.comparisonRetainedBytesGrown],
      ['comparison bytes per row', measurements.comparisonRetainedBytesPerSourceRow],
    ]) {
      process.stdout.write(line(label, value));
    }
    for (const [label, reading] of [
      ['before', before],
      ['after', after],
      ['peak', measurements.peak],
    ]) {
      for (const key of Object.keys(peak)) {
        process.stdout.write(line(`${label} ${key}`, reading[key]));
      }
    }
    process.stdout.write(line('peak resident set bytes', peakResidentSetBytes));
    process.stdout.write(line('held most at', heldMostAt));
    process.stdout.write(line('comparison held most at', measurements.comparisonHeldMostAt));
  }

  scratch.dispose();
}

/** Refuses, with the reason as the last line on stderr, which is what the gate quotes. */
function refuse(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

if (thrown !== null) {
  // A package is data. Whatever it holds, the verification's answer is a report
  // with problems in it; an engine invariant reaching this line means some cell
  // of some artifact reached code that treats it as engine vocabulary, and that
  // is a defect in the verifier rather than a verdict about the package.
  refuse(
    `the verification threw rather than reporting: ${String(thrown && thrown.message ? thrown.message : thrown)}`,
  );
}

if (report.problems.length > 0) {
  refuse(
    `the package did not verify: ${report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join('; ')}`,
  );
}

if (measurements.observations === 0) {
  refuse('the verification reported no observation points, so nothing about what it held was measured');
}

// Bounds 1 and 3: it must have read at least what it claims to have checked --
// the package, and for source-backed verification the source bytes as well.
const mustHaveRead = measurements.packageBytes + (measurements.sourceBytes ?? 0);
if (measurements.bytesRead < mustHaveRead) {
  refuse(
    `the read counter did not take effect: the verification read ${String(measurements.bytesRead)} bytes in ${String(measurements.readCalls)} calls, which is less than the ${String(mustHaveRead)} bytes of what it checked`,
  );
}

// Bound 2, for a verification that reads a package and nothing else: at the
// moment it held the most, it held less than the largest file it read.
if (!attesting && measurements.retainedBytesGrown >= measurements.largestArtifactBytes) {
  refuse(
    `the verifier is not bounded on this package: it retained ${String(measurements.retainedBytesGrown)} bytes at ${measurements.heldMostAt}, and the largest artifact it read weighs ${String(measurements.largestArtifactBytes)} bytes`,
  );
}

// Bound 4, for source-backed verification: the same sentence about the half of
// the call that compares, because the half that re-derives is a migration and a
// migration is properly larger than an artifact. Measuring them together is what
// let a comparison holding three gigabytes look like a run that was always going
// to be large.
if (attesting) {
  if (measurements.comparisonRetainedBytesGrown === null) {
    refuse(
      'the verification never reported that its re-derivation had finished, so the comparison could not be measured apart from the migration behind it',
    );
  }
  if (measurements.comparisonRetainedBytesGrown >= measurements.largestArtifactBytes) {
    refuse(
      `the comparison is not bounded on this package: it retained ${String(measurements.comparisonRetainedBytesGrown)} bytes at ${measurements.comparisonHeldMostAt}, and the largest artifact it read weighs ${String(measurements.largestArtifactBytes)} bytes`,
    );
  }
}

process.stderr.write('verified\n');
process.exit(0);

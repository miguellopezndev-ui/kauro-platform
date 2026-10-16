import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MigrationError } from '../domain/errors.js';
import { compareCodeUnits } from '../util/json.js';
import { IMPORT_AREA, packagePath } from '../artifacts/layout.js';
import { loadConfig } from '../mapping/load-config.js';
import { runMigration } from '../run/run-migration.js';
import { writeAndPromotePackage, listPackageFiles, MANIFEST_FILE } from '../artifacts/write-package.js';
import { CORE_VERSION } from '../version.js';
import { createFilesystemScratchStore } from '../scratch/filesystem-scratch-store.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import { SCRATCH_BUDGET_BYTES } from '../domain/resource-profile.js';
import { orderText } from '../run/spool.js';
import type { SpooledFamily } from '../run/spool.js';
import { coGroup, openKeyedSpill as openRawKeyedSpill } from './join.js';
import type { Keyed, KeyedSpill } from './join.js';
import type { HashedTargetContract } from '../target/contract.js';
import type { AttestationAuthority, TargetAttestation } from '../target/attestation.js';

/**
 * Source-backed verification.
 *
 * `verifyPackage` reads a package and nothing else, so its reach ends where the
 * package's own knowledge ends: it carries the input hashes, not the inputs, and
 * a delivered value no artifact independently describes can be rewritten without
 * contradicting anything. That is a real limit and no amount of cross-checking
 * inside the package removes it.
 *
 * This is the other half. It takes four authorities from **outside** the
 * candidate:
 *
 * - the original source bytes,
 * - the configuration the operator accepted,
 * - the core version whose contract is being claimed,
 * - and only then the candidate package.
 *
 * It re-derives the truth from those authorities and compares. Nothing the
 * candidate says is believed, including its own copy of the configuration and
 * its own record of the input hashes: those are compared against the
 * authorities, never used as them.
 *
 * The source bytes and the accepted configuration are hashed before and after,
 * so a verification that quietly altered what it was checking against would say
 * so.
 *
 * ---- what it is allowed to hold ----
 *
 * Nothing that grows with the dataset. That is not a preference; it is the
 * difference between a check that runs at the capacity this engine declares and
 * one that does not, and it was established by measuring rather than by reading.
 * On this tree, on 2026-09-05, against the founding CLEAN_ONLY profile at
 * 125,375 source rows, retained heap plus external after a forced collection at
 * each point:
 *
 *   the authoritative lineage, read into an array of row objects  1,496,167,408
 *   the candidate lineage, the same                               1,496,156,688
 *   the two indexes over them, by row locator                         7,302,584
 *   the per-locator tally                                             3,712,568
 *   ----------------------------------------------------------------------------
 *   held at once, before any of it could be dropped               3,073,313,849
 *
 * which is 11,933 bytes per source row for one copy of one artifact. The
 * delivered rows then cost 701,062,553 and the relationships 596,737,392 on top
 * of what remained. Whole-call peak resident set on the same two packages:
 * 5,454,970,880 at 125,375 rows and 7,326,605,312 at 250,750, a slope of 14,928
 * bytes per source row. A 501,500-row package could not be attested at all —
 * exit 134, SIGABRT, V8 heap, at `--max-old-space-size=8192` — which is the
 * measurement this work was handed and the one it had to answer.
 *
 * So every row-scale comparison here is a **merge of two ordered families**,
 * spilled through a scratch store, rather than two dictionaries. Comparing two
 * ordered families in step holds one key's rows from each side; indexing them
 * holds the package twice. The machinery is the engine's own — `openFamily` over
 * the external sort, reached through `join.ts` — rather than a second one
 * written here. The delivered rows need no spill at all, because their address
 * *is* the order both sides are written in, so they are two file cursors walked
 * together. Every artifact is read a block at a time, by this file's own reader,
 * and the byte comparison at the end is a block against a block.
 *
 * Measured again afterwards, by `tools/verifier-memory-probe.mjs --attest`,
 * which reports what the comparison alone retains once the re-derivation's
 * result is out of reach:
 *
 *   source rows                             125,375         250,750
 *   the comparison retains                1,028,632         156,888
 *   the largest artifact it read         64,819,304     129,864,184
 *
 * — a megabyte or so either way, and no slope: the figure at twice the rows is
 * smaller than the figure at half of them. What the whole call retains, 473 and
 * 596 bytes per source row, is the migration it re-derives and not the
 * comparison, which is why the two are measured apart.
 *
 * What that leaves is a call that costs what a run costs — peak resident set, on
 * the same three corpora, against one migration of each measured the same way:
 *
 *   source rows            125,375        250,750        501,500
 *   attesting, before    5,454,970,880  7,326,605,312   would not run
 *   attesting, after       986,443,776  1,341,140,992   1,914,429,440
 *                        1,109,143,552  1,543,405,568
 *                        1,129,975,808  1,720,918,016
 *   migrating            1,035,493,376  1,420,804,096   2,093,035,520
 *
 * Three passes are quoted for the middle row because a resident set is a
 * high-water mark and it wanders by a couple of hundred megabytes between them.
 * That is also why the bound the probe enforces is measured on what is *retained*
 * after a forced collection rather than on this.
 *
 * The last column is the one that matters: 501,500 rows, thirteen checks, no
 * problems, 505 seconds — where the same package on the same tree was exit 134,
 * SIGABRT, V8 heap. Attesting now costs slightly less than migrating did.
 *
 * The residual slope is the re-derivation's, and bounding a run is not this
 * file's work: what is left here is one migration, which is what attesting a
 * package honestly costs.
 *
 * What is *not* bounded, said out loud rather than left to be discovered:
 * `merges.json` is still parsed whole, because a merge id set is the one
 * row-scale question here whose artifact is JSON. It is the smallest row-scale
 * artifact in the package — 4,383,385 bytes at 125,375 rows, 35 bytes per source
 * row — the parse tree is transient rather than retained, and it is the same
 * read `verify-package.ts` performs on the same artifact under a probe that
 * certifies that verifier bounded. A second JSON reader written here would be a
 * second definition of what `merges.json` is, and unlike the CSV reader below it
 * would have nothing to disagree with the engine about: both sides parse with
 * the platform's `JSON.parse`.
 */

export interface StrongVerificationInput {
  readonly packageDir: string;
  /** External authority: the directory holding the original source files. */
  readonly sourceRoot: string;
  /** External authority: the configuration the operator accepted, outside the package. */
  readonly configPath: string;
  /**
   * External authority: the core version whose contract is claimed. A package
   * produced by a different version is not judged against this one's rules.
   */
  readonly coreVersion?: string;
  /**
   * External authority: what the destination instance held, and who said so.
   *
   * A CRM package could not be attested at all without these, and the reason is
   * worth stating because it looks at first like a permission problem and is
   * not. This verification re-derives the truth by running the migration again
   * from the source bytes, and a run's target contract is an *input to that
   * derivation*: it decides which destination records may be matched and on
   * which properties. Re-deriving without it would not produce the same truth
   * and then compare — it would produce a different truth and report the
   * difference as the package's fault.
   *
   * So the contract travels with the attestation request, as the same external
   * authority the source and the configuration are. It is optional here for the
   * same reason it is optional on a run: `CLEAN_ONLY` addresses no instance and
   * a contract offered for it is refused.
   *
   * This was found by measuring rather than by reading. Making attestation
   * REQUIRED for the CRM modes left `verifyAgainstSource` re-running without a
   * contract, so every HubSpot and Salesforce package in the capacity matrix
   * came back `attestationOk: false` with `TARGET_CONTRACT_INVALID` — the
   * strongest check the engine has, switched off for two of three modes by a
   * change meant to strengthen it.
   */
  readonly targetContract?: HashedTargetContract | null;
  readonly targetAttestation?: TargetAttestation | null;
  readonly attestationAuthorities?: readonly AttestationAuthority[];
  readonly attestationInstant?: string | null;
  /**
   * Called as each check finishes, with its name.
   *
   * The same hook `verifyPackage` offers, and for the same reason: a peak
   * nobody sampled is a peak nobody can report, and this call does two very
   * different things — it re-derives a whole migration, and then it compares
   * two packages — so one figure for the whole of it cannot say which of them
   * held what. Measuring them together is how the comparison's 3 GB hid inside
   * a process that was expected to hold a migration anyway.
   *
   * It changes nothing about the verdict, and `tools/verifier-memory-probe.mjs`
   * is its only caller.
   */
  readonly observe?: (where: string) => void;
}

export interface StrongProblem {
  readonly check: string;
  readonly detail: string;
}

export interface AuthorityHash {
  readonly path: string;
  readonly sha256Before: string;
  readonly sha256After: string;
}

export interface StrongCounts {
  readonly sourceRowsInvented: number;
  readonly sourceRowsRemoved: number;
  readonly recordsInvented: number;
  readonly recordsRemoved: number;
  readonly deliveredValuesAltered: number;
  readonly dispositionsAltered: number;
  readonly edgesInvented: number;
  readonly edgesRemoved: number;
  readonly edgesAltered: number;
  readonly mergesInvented: number;
  readonly mergesRemoved: number;
  readonly derivedIdMismatches: number;
  readonly unauthorizedChanges: number;
  readonly artifactsDiffering: number;
}

export interface StrongReport {
  readonly packageDir: string;
  readonly sourceRoot: string;
  readonly configPath: string;
  readonly coreVersion: string;
  readonly passed: boolean;
  readonly checks: readonly string[];
  readonly problems: readonly StrongProblem[];
  readonly authority: readonly AuthorityHash[];
  /** True when every authority hashed the same before and after the verification. */
  readonly authorityUnchanged: boolean;
  readonly counts: StrongCounts;
}

const EMPTY_COUNTS: StrongCounts = {
  sourceRowsInvented: 0,
  sourceRowsRemoved: 0,
  recordsInvented: 0,
  recordsRemoved: 0,
  deliveredValuesAltered: 0,
  dispositionsAltered: 0,
  edgesInvented: 0,
  edgesRemoved: 0,
  edgesAltered: 0,
  mergesInvented: 0,
  mergesRemoved: 0,
  derivedIdMismatches: 0,
  unauthorizedChanges: 0,
  artifactsDiffering: 0,
};

export function verifyAgainstSource(input: StrongVerificationInput): StrongReport {
  const packageDir = resolve(input.packageDir);
  const sourceRoot = resolve(input.sourceRoot);
  const configPath = resolve(input.configPath);
  const coreVersion = input.coreVersion ?? CORE_VERSION;

  const problems: StrongProblem[] = [];
  const checks: string[] = [];
  const counts: Record<keyof StrongCounts, number> = { ...EMPTY_COUNTS };
  const record = (check: string): void => {
    checks.push(check);
  };
  const observe = input.observe ?? ((): void => {});
  const fail = (check: string, detail: string): void => {
    problems.push({ check, detail });
  };

  // ------------------------------------------------ the authorities, hashed
  record('authority.isOutsideTheCandidate');
  if (configPath === packageDir || configPath.startsWith(packageDir + sep)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the configuration at ${configPath} is inside the package being verified`,
      'Point --config at the configuration the operator accepted, outside the package. A package cannot supply the authority it is judged against.',
      { configPath, packageDir },
    );
  }
  if (sourceRoot === packageDir || sourceRoot.startsWith(packageDir + sep)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the source directory ${sourceRoot} is inside the package being verified`,
      'Point --source at the original source files, outside the package.',
      { sourceRoot, packageDir },
    );
  }

  record('authority.hashedBeforeAndAfter');
  const configText = readFileSync(configPath, 'utf8');
  const loaded = loadConfig(configText, configPath);
  const authorityPaths = [
    configPath,
    ...loaded.config.files.map((file) => join(sourceRoot, ...file.path.split('/'))),
  ];
  const before = authorityPaths.map((path) => ({ path, sha256: hashFile(path) }));

  // -------------------------------------- the truth, re-derived from authority
  record('authority.coreVersion');
  if (coreVersion !== CORE_VERSION) {
    fail(
      'authority.coreVersion',
      `this build is core ${CORE_VERSION} and cannot judge a package claimed against ${coreVersion}`,
    );
  }

  let scratch: string | null = null;
  let authorityScratch: ScratchStore | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'kauro-strong-'));
    const authoritative = join(scratch, 'authoritative');
    // The authoritative run gets its own store, inside the same temporary
    // directory this check already owns and already removes.
    authorityScratch = createFilesystemScratchStore({
      root: join(scratch, 'work'),
      runId: 'attest',
      quotaBytes: SCRATCH_BUDGET_BYTES,
    });

    /**
     * What the re-derivation is asked afterwards, taken while it is still here.
     *
     * The run and the comparison are in separate blocks so the run's result is
     * unreachable while the comparison happens. Holding it across the comparison
     * keeps the whole re-derived migration alive underneath a check that reads
     * everything it needs off disk again — the capacity harness had already
     * found this on the run side and drops its own result the same way before it
     * verifies, with the same reasoning.
     *
     * What survives the block is one hash per source file and one for the
     * configuration: bounded by the number of files the configuration names,
     * never by the rows in them.
     */
    let configHashRead: string;
    let readByRun: Map<string, string>;
    {
      const result = runMigration({
        inputRoot: sourceRoot,
        config: loaded.config,
        configHash: loaded.configHash,
        scratch: authorityScratch,
        // Passed through rather than defaulted. The re-derivation is held to the
        // same policy a run is, and it has to be: a verification that could run
        // where a run could not would be judging the package against rules the
        // package was never produced under.
        targetContract: input.targetContract ?? null,
        targetAttestation: input.targetAttestation ?? null,
        ...(input.attestationAuthorities === undefined ? {} : { attestationAuthorities: input.attestationAuthorities }),
        attestationInstant: input.attestationInstant ?? null,
      });
      writeAndPromotePackage({
        result,
        config: loaded.config,
        normalizedConfig: loaded.normalizedJson,
        outputDir: authoritative,
        force: false,
      });
      configHashRead = result.truth.configHash;
      readByRun = new Map(result.truth.sourceFiles.map((file) => [file.path, file.sha256]));
    }
    // Outside the block, so a watcher's reading is taken with the run's result
    // already unreachable. Taken inside it, the figure the comparison is
    // measured against would include the migration it is not responsible for.
    observe('authority.rederived');

    record('authority.hashesCoverTheBytesRead');
    for (const detail of authorityCoversRead({
      configHashBefore: loaded.configHash,
      configHashRead,
      hashedBefore: new Map(
        loaded.config.files.map((file) => [
          file.path,
          before.find((entry) => entry.path === join(sourceRoot, ...file.path.split('/')))?.sha256 ?? null,
        ]),
      ),
      readByRun,
    })) {
      fail('authority.hashesCoverTheBytesRead', detail);
    }

    // The comparison spills through a store of its own, beside the run's and
    // inside the same temporary directory, so that a family the comparison wrote
    // is never mistaken for a family the run wrote in either store's accounting.
    const compareScratch = createFilesystemScratchStore({
      root: join(scratch, 'compare'),
      runId: 'attest-compare',
      quotaBytes: SCRATCH_BUDGET_BYTES,
    });
    compare(authoritative, packageDir, compareScratch, { record, fail, counts, observe });
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }

  const after = authorityPaths.map((path) => ({ path, sha256: hashFile(path) }));
  const authority: AuthorityHash[] = before.map((entry, index) => ({
    path: relativeTo(sourceRoot, entry.path),
    sha256Before: entry.sha256,
    sha256After: after[index]?.sha256 ?? '',
  }));
  const authorityUnchanged = authority.every((entry) => entry.sha256Before === entry.sha256After);
  if (!authorityUnchanged) {
    fail('authority.hashedBeforeAndAfter', 'verification changed a source file or the accepted configuration');
  }

  return {
    packageDir,
    sourceRoot,
    configPath,
    coreVersion,
    passed: problems.length === 0,
    checks,
    problems,
    authority,
    authorityUnchanged,
    counts: { ...counts },
  };
}

export interface AuthorityCoverage {
  readonly configHashBefore: string;
  readonly configHashRead: string;
  /** What each source file hashed to before the run, by the path the configuration names. */
  readonly hashedBefore: ReadonlyMap<string, string | null>;
  /** What the run actually read, by the same path. */
  readonly readByRun: ReadonlyMap<string, string>;
}

/**
 * Whether the hashes taken before the run describe the bytes the run read.
 *
 * Hashing before and after brackets the read; it does not cover it. A writer
 * that swapped a source file inside that window and restored it afterwards left
 * both reported hashes equal to the operator's copy while the package was built
 * from something else. The run records what it consumed, so comparing closes
 * the window with no extra reading — and this is a pure function so the
 * comparison can be tested without having to win a race.
 */
export function authorityCoversRead(coverage: AuthorityCoverage): string[] {
  const problems: string[] = [];
  if (coverage.configHashBefore !== coverage.configHashRead) {
    problems.push('the configuration the run consumed is not the configuration that was hashed');
  }
  for (const [path, hashed] of coverage.hashedBefore) {
    const read = coverage.readByRun.get(path);
    if (hashed === null || read === undefined || hashed !== read) {
      problems.push(`${path} was hashed as ${hashed ?? 'nothing'} but the run read ${read ?? 'nothing'}`);
    }
  }
  return problems;
}

interface Sink {
  readonly record: (check: string) => void;
  readonly fail: (check: string, detail: string) => void;
  readonly counts: Record<keyof StrongCounts, number>;
  /** Called as each check finishes. A no-op unless the caller asked to watch. */
  readonly observe: (where: string) => void;
}

/**
 * The comparison.
 *
 * Every artifact is compared as bytes, which is what makes this complete: the
 * engine is deterministic given the same source, configuration and core
 * version, so any difference at all is the candidate departing from the truth.
 * The named comparisons that follow exist so the report says *what* was done to
 * the package rather than only that something was.
 */
function compare(authoritativeDir: string, candidateDir: string, scratch: ScratchStore, sink: Sink): void {
  const { record, fail, counts, observe } = sink;

  record('package.sameArtifacts');
  const authoritativeFiles = listPackageFiles(authoritativeDir);
  const candidateFiles = listPackageFiles(candidateDir);
  const authoritativeSet = new Set(authoritativeFiles);
  const candidateSet = new Set(candidateFiles);
  for (const path of authoritativeFiles) {
    if (!candidateSet.has(path)) fail('package.sameArtifacts', `${path} is missing from the candidate package`);
  }
  for (const path of candidateFiles) {
    if (!authoritativeSet.has(path)) fail('package.sameArtifacts', `${path} is in the candidate package but the source does not produce it`);
  }

  observe('package.sameArtifacts');

  // ------------------------------------------------------ named differences
  compareLineage(authoritativeDir, candidateDir, scratch, sink);
  compareDelivered(authoritativeDir, candidateDir, sink);
  compareRelationships(authoritativeDir, candidateDir, scratch, sink);

  // The one family that is not row-scale in memory even when read whole: a
  // merge id is a short string and there are as many of them as there are
  // proven merges. What is read whole is the document they are in, which is
  // the residual the header names.
  record('source.merges');
  const authoritativeMerges = mergeIds(authoritativeDir);
  const candidateMerges = mergeIds(candidateDir);
  for (const id of candidateMerges) {
    if (!authoritativeMerges.has(id)) {
      counts.mergesInvented += 1;
      fail('source.merges', `merge ${id} is recorded but the source proves no such merge`);
    }
  }
  for (const id of authoritativeMerges) {
    if (!candidateMerges.has(id)) {
      counts.mergesRemoved += 1;
      fail('source.merges', `merge ${id} is proven by the source but missing from the package`);
    }
  }
  observe('source.merges');

  compareChanges(authoritativeDir, candidateDir, scratch, sink);

  // ------------------------------------------------------- the catch-all
  //
  // Everything above names a difference. This one catches the differences
  // nobody thought to name, which is the point of comparing bytes: the engine
  // is deterministic, so any artifact that differs at all is the candidate
  // departing from the truth the authorities derive.
  //
  // The bytes are compared a block at a time rather than by reading both files
  // whole. It is the same comparison — two byte sequences are equal or they are
  // not, and sequences of different length are not — and it is the only form of
  // it that survives an artifact larger than the heap: `source-lineage.csv`
  // alone is 64,819,304 bytes at 125,375 rows, and both copies of it were being
  // held at once in order to ask whether they were the same.
  record('package.bytesMatchTheSource');
  for (const path of authoritativeFiles) {
    if (!candidateSet.has(path)) continue;
    if (!sameBytes(join(authoritativeDir, ...path.split('/')), join(candidateDir, ...path.split('/')))) {
      counts.artifactsDiffering += 1;
      fail(
        'package.bytesMatchTheSource',
        `${path} differs from the artifact this source and configuration produce`,
      );
    }
  }
  observe('package.bytesMatchTheSource');
}

// ------------------------------------------------------------ the lineage

/**
 * The three columns a disposition is, and the seven a derived identifier is.
 *
 * Named once and spilled once. Both checks walk the same join over the same
 * artifact, so reading the lineage twice to ask two questions about the same row
 * would be two passes over the largest artifact in the package to save nothing.
 */
const DISPOSITION_COLUMNS = ['disposition', 'reason_code', 'contribution_kind'] as const;
const DERIVED_COLUMNS = [
  'file_id',
  'row_hash',
  'file_sha256',
  'identity_key',
  'record_identity_key',
  'migration_key',
  'merge_id',
] as const;
const LINEAGE_COLUMNS = [...DISPOSITION_COLUMNS, ...DERIVED_COLUMNS] as const;

/**
 * One lineage row, reduced to what the three lineage checks read.
 *
 * `id` travels beside the key rather than being recovered from it. The key is
 * the escaped spelling — `orderText` moves the characters below U+0020 and the
 * per-cent sign — and a message that quoted the escaped spelling would name a
 * row locator that is not in the artifact. `at` is where the row sat in its
 * file, which is the order the problems have always been reported in.
 */
interface LineageFacts {
  readonly id: string;
  readonly at: number;
  readonly cells: readonly string[];
}

function compareLineage(
  authoritativeDir: string,
  candidateDir: string,
  scratch: ScratchStore,
  sink: Sink,
): void {
  const { record, fail, counts, observe } = sink;

  // Recorded in the order they have always been recorded in, before the pass
  // that answers all three runs. The report says which checks ran; running them
  // together is how the artifact is read once instead of six times.
  record('source.rowsAreTheRowsThatExist');
  record('source.dispositionsAreTheTruth');
  record('source.derivedIdentifiers');

  const existence = heldInOrder('source.rowsAreTheRowsThatExist', fail);
  const dispositions = heldInOrder('source.dispositionsAreTheTruth', fail);
  const derived = heldInOrder('source.derivedIdentifiers', fail);

  const spill = (dir: string, schema: string): SpooledFamily<Keyed<LineageFacts>> => {
    const writer = openKeyed<LineageFacts>(scratch, schema);
    let at = 0;
    for (const row of rowsOf(dir, 'source-lineage.csv')) {
      const id = row['row_locator_id'] ?? '';
      writer.add({ k: id, v: { id, at, cells: LINEAGE_COLUMNS.map((column) => row[column] ?? '') } });
      at += 1;
    }
    return writer.seal();
  };

  const authoritative = spill(authoritativeDir, 'attest-lineage-authoritative');
  const candidate = spill(candidateDir, 'attest-lineage-candidate');

  for (const group of coGroup(authoritative, candidate)) {
    const source = group.left;
    const held = group.right;
    const first = source[0] ?? held[0];
    if (first === undefined) continue;
    const id = first.id;

    // Counted, not deduplicated: an index hid a repeated row, so the named
    // finding read zero while only the byte comparison objected.
    if (held.length > 0 && source.length === 0) {
      counts.sourceRowsInvented += held.length;
      existence.found([0, held[0]?.at ?? 0], `${id} is in the package but no such row exists in the source`);
    } else if (held.length > 1) {
      counts.sourceRowsInvented += held.length - 1;
      existence.found(
        [0, held[0]?.at ?? 0],
        `${id} appears ${String(held.length)} times in the package and once in the source`,
      );
    }
    if (source.length > 0 && held.length === 0) {
      counts.sourceRowsRemoved += 1;
      existence.found([1, source[0]?.at ?? 0], `${id} exists in the source but the package does not account for it`);
    }

    if (source.length === 0 || held.length === 0) continue;
    // The last occurrence on each side, which is what an index keyed by the
    // locator returned when a locator appeared twice.
    const expected = source[source.length - 1]?.cells ?? [];
    const actual = held[held.length - 1]?.cells ?? [];
    const at = source[0]?.at ?? 0;

    DISPOSITION_COLUMNS.forEach((column, index) => {
      if ((actual[index] ?? '') === (expected[index] ?? '')) return;
      counts.dispositionsAltered += 1;
      dispositions.found(
        [at, index],
        `${id} is recorded as ${column}="${actual[index] ?? ''}" but the source gives "${expected[index] ?? ''}"`,
      );
    });
    DERIVED_COLUMNS.forEach((column, index) => {
      const offset = DISPOSITION_COLUMNS.length + index;
      if ((actual[offset] ?? '') === (expected[offset] ?? '')) return;
      counts.derivedIdMismatches += 1;
      derived.found(
        [at, index],
        `${id} carries ${column}="${actual[offset] ?? ''}" but the source derives "${expected[offset] ?? ''}"`,
      );
    });
  }

  existence.flush();
  dispositions.flush();
  derived.flush();
  observe('source.derivedIdentifiers');
}

// ------------------------------------------------------ the delivered rows

/**
 * Every delivered row, addressed by where it sits in its import file.
 *
 * The address used to be the first column, because the first column was the
 * Kauro trace key. In package format 2.0.0 an import file carries no Kauro
 * identity at all, so the first column is destination data -- and keying on it
 * meant that rewriting the first column of a row read as one record removed and
 * a different one invented, instead of as the value it actually was.
 *
 * The position is a sound address because the engine is deterministic: the
 * authoritative rebuild writes the same records in the same order from the same
 * source. A row moved within its file therefore shows up as the values of two
 * rows having changed, which is what happened.
 *
 * And because the address *is* the order, this is the one row-scale comparison
 * that needs no spill and no sort: the two files are opened together and walked
 * in step, a row from each at a time. Indexing them by `path|rowNumber` first
 * cost 701,062,553 bytes at 125,375 rows to answer a question two cursors answer
 * for the price of a block.
 */
function compareDelivered(authoritativeDir: string, candidateDir: string, sink: Sink): void {
  const { record, fail, counts, observe } = sink;
  record('source.deliveredValues');

  const authoritativePaths = importCsvPaths(authoritativeDir);
  const authoritativeSet = new Set(authoritativePaths);
  // Bounded by the number of import files, not by their rows. Both counts are
  // taken while each file is walked so the second pass below needs no re-read.
  const deliveredRowCount = new Map<string, number>();
  const producedRowCount = new Map<string, number>();

  for (const path of importCsvPaths(candidateDir)) {
    const produced = authoritativeSet.has(path) ? rowsOf(authoritativeDir, path) : noRows();
    let delivered = 0;
    let source = 0;
    try {
      for (const row of rowsOf(candidateDir, path)) {
        delivered += 1;
        const step = produced.next();
        if (step.done === true) {
          counts.recordsInvented += 1;
          fail(
            'source.deliveredValues',
            `${path}|${String(delivered)} is delivered but the source produces no such record`,
          );
          continue;
        }
        source += 1;
        const expected = step.value;
        for (const column of Object.keys(row)) {
          if ((row[column] ?? '') !== (expected[column] ?? '')) {
            counts.deliveredValuesAltered += 1;
            fail(
              'source.deliveredValues',
              `${path}|${String(delivered)} is delivered with ${column}="${row[column] ?? ''}" but the source gives "${expected[column] ?? ''}"`,
            );
          }
        }
      }
      // What the source still had to say after the package stopped listening.
      // Counted here rather than by opening the file a second time below.
      while (produced.next().done !== true) source += 1;
    } finally {
      // A generator that is abandoned rather than finished never runs its own
      // `finally`, so the artifact it is reading keeps its handle open. On
      // Windows an open handle inside a directory makes the directory
      // unremovable, and this verification removes the tree it built.
      produced.return?.(undefined);
    }
    deliveredRowCount.set(path, delivered);
    if (authoritativeSet.has(path)) producedRowCount.set(path, source);
  }

  for (const path of authoritativePaths) {
    const delivered = deliveredRowCount.get(path) ?? 0;
    const produced = producedRowCount.get(path) ?? countRows(authoritativeDir, path);
    for (let rowNumber = delivered + 1; rowNumber <= produced; rowNumber += 1) {
      counts.recordsRemoved += 1;
      fail(
        'source.deliveredValues',
        `${path}|${String(rowNumber)} is produced by the source but the package does not deliver it`,
      );
    }
  }
  observe('source.deliveredValues');
}

/**
 * The import files a delivered row can be in.
 *
 * Association files are excluded here and compared as relationships instead,
 * which is what they are; `listPackageFiles` sorts, so both sides are walked in
 * one order whatever the file system hands back.
 */
function importCsvPaths(dir: string): string[] {
  return listPackageFiles(dir).filter(
    (path) => path.startsWith(`${IMPORT_AREA}/`) && path.endsWith('.csv') && !path.includes('/associations/'),
  );
}

// ------------------------------------------------------ the relationships

const EDGE_COLUMNS = [
  'from_migration_key',
  'to_migration_key',
  'disposition',
  'reason_code',
  'relationship_type',
  'label',
] as const;

/**
 * One relationship, reduced to what the check reads, with its edge id beside the
 * key for the same reason the lineage carries its locator: the key is the
 * escaped spelling and a finding has to name the artifact's.
 */
interface EdgeFacts {
  readonly id: string;
  readonly at: number;
  readonly cells: readonly string[];
}

/**
 * The relationships, as a merge rather than as two indexes.
 *
 * The same shape as the lineage and for the same reason: `associations.csv` is
 * 30,891,151 bytes at 125,375 rows, both copies were indexed by edge id, and the
 * pair cost 596,737,392 bytes to answer a question about one edge at a time.
 */
function compareRelationships(
  authoritativeDir: string,
  candidateDir: string,
  scratch: ScratchStore,
  sink: Sink,
): void {
  const { record, fail, counts, observe } = sink;
  record('source.relationships');
  const relationships = heldInOrder('source.relationships', fail);

  const spill = (dir: string, schema: string): SpooledFamily<Keyed<EdgeFacts>> => {
    const writer = openKeyed<EdgeFacts>(scratch, schema);
    let at = 0;
    for (const row of rowsOf(dir, 'associations.csv')) {
      const id = row['source_edge_id'] ?? '';
      writer.add({ k: id, v: { id, at, cells: EDGE_COLUMNS.map((column) => row[column] ?? '') } });
      at += 1;
    }
    return writer.seal();
  };

  const authoritative = spill(authoritativeDir, 'attest-edges-authoritative');
  const candidate = spill(candidateDir, 'attest-edges-candidate');

  for (const group of coGroup(authoritative, candidate)) {
    const source = group.left;
    const held = group.right;
    const first = source[0] ?? held[0];
    if (first === undefined) continue;
    const id = first.id;

    if (held.length > 0) {
      if (source.length === 0) {
        counts.edgesInvented += 1;
        relationships.found(
          [0, held[0]?.at ?? 0, 0],
          `relationship ${id} is in the package but the source asserts no such relationship`,
        );
      } else {
        // The last occurrence on each side, which is what an index keyed by the
        // edge id returned when an edge id appeared twice.
        const expected = source[source.length - 1]?.cells ?? [];
        const actual = held[held.length - 1]?.cells ?? [];
        const at = held[0]?.at ?? 0;
        EDGE_COLUMNS.forEach((column, index) => {
          if ((actual[index] ?? '') === (expected[index] ?? '')) return;
          counts.edgesAltered += 1;
          relationships.found(
            [0, at, index],
            `relationship ${id} has ${column}="${actual[index] ?? ''}" but the source gives "${expected[index] ?? ''}"`,
          );
        });
      }
    }
    if (source.length > 0 && held.length === 0) {
      counts.edgesRemoved += 1;
      relationships.found(
        [1, source[0]?.at ?? 0, 0],
        `relationship ${id} is asserted by the source but missing from the package`,
      );
    }
  }

  relationships.flush();
  observe('source.relationships');
}

// ------------------------------------------------------------ the changes

/**
 * One change, as the composed key the check compares and where it sat.
 *
 * The key travels as a value as well as a key. It is built out of a delivered
 * value, so it can hold anything a cell can hold, and the finding has to quote
 * what the artifact says rather than what the sort key spells.
 */
interface ChangeFacts {
  readonly key: string;
  readonly at: number;
}

/**
 * The change log, compared as two ordered families rather than as two sets.
 *
 * A set of composed keys is one entry per change, and there are more changes
 * than there are rows: 131,252,793 bytes for the pair at 125,375 rows, on an
 * artifact of 11,757,062. Grouping is what keeps the old meaning — a change
 * stated twice was one member of a set, and is one key here.
 */
function compareChanges(
  authoritativeDir: string,
  candidateDir: string,
  scratch: ScratchStore,
  sink: Sink,
): void {
  const { record, fail, counts, observe } = sink;
  record('source.changes');
  const changes = heldInOrder('source.changes', fail);

  const spill = (dir: string, schema: string): SpooledFamily<Keyed<ChangeFacts>> => {
    const writer = openKeyed<ChangeFacts>(scratch, schema);
    let at = 0;
    for (const row of rowsOf(dir, 'changes.csv')) {
      const key = changeKey(row);
      writer.add({ k: key, v: { key, at } });
      at += 1;
    }
    return writer.seal();
  };

  const authoritative = spill(authoritativeDir, 'attest-changes-authoritative');
  const candidate = spill(candidateDir, 'attest-changes-candidate');

  for (const group of coGroup(authoritative, candidate)) {
    const source = group.left;
    const held = group.right;
    const first = source[0] ?? held[0];
    if (first === undefined) continue;
    // A change stated twice is one change, as it was when both sides were sets;
    // what the two sides disagree about is which changes exist at all.
    if (held.length > 0 && source.length === 0) {
      counts.unauthorizedChanges += 1;
      changes.found([0, held[0]?.at ?? 0], `the change log records ${first.key}, which the source does not produce`);
    }
    if (source.length > 0 && held.length === 0) {
      counts.unauthorizedChanges += 1;
      changes.found(
        [1, source[0]?.at ?? 0],
        `the source produces the change ${first.key}, which the package does not record`,
      );
    }
  }

  changes.flush();
  observe('source.changes');
}

function changeKey(row: Readonly<Record<string, string>>): string {
  return `${row['row_locator_id'] ?? ''}/${row['destination_field'] ?? ''}=${row['final_value'] ?? ''} (${row['reason_code'] ?? ''})`;
}

// ------------------------------------------------------------ the merges

/**
 * The merge ids, read whole, deliberately and with the reason measured.
 *
 * Everything else here reads in blocks. This does not, and the honest account is
 * in the header: `merges.json` is 4,383,385 bytes at 125,375 rows — 35 bytes per
 * source row, the smallest of the row-scale artifacts — what is retained is a set
 * of short ids rather than the document, and the parse tree is transient. It is
 * also the same read `verify-package.ts` performs on the same artifact under a
 * probe that certifies that verifier bounded.
 *
 * A malformed document is no merges rather than a failure, as it always has
 * been: every id the source proves is then reported missing, which is the
 * fail-closed direction, and `package.bytesMatchTheSource` objects as well.
 */
function mergeIds(dir: string): Set<string> {
  try {
    const text = readFileSync(join(dir, ...packagePath('merges.json').split('/')), 'utf8');
    const parsed = JSON.parse(text) as { merges?: { mergeId?: string }[] };
    return new Set((parsed.merges ?? []).map((merge) => merge.mergeId ?? ''));
  } catch {
    return new Set();
  }
}

// --------------------------------------------------- problems, still in order

interface HeldProblem {
  readonly at: readonly number[];
  readonly detail: string;
}

/**
 * Problems found by a merge, reported in the order a pair of indexes reported
 * them.
 *
 * This exists because determinism outranks the change. Indexing both artifacts
 * and walking one of them emitted problems in the order the rows sit in their
 * file; a merge visits keys in key order, and `F-0:S0:R100` sorts before
 * `F-0:S0:R99`. Nothing about *what* is found moves, but the sequence of a
 * report would, and a report's sequence is one of its outputs.
 *
 * So each finding carries where it would have been found — which side was being
 * walked, the row's position in its file, and the column within the row — and
 * the pass hands them over in that order when it is done. Findings are held in
 * memory, as they always have been: a package with a row-scale number of
 * problems is a package that failed, and `problems` was already an array of
 * every one of them.
 */
function heldInOrder(
  check: string,
  fail: (check: string, detail: string) => void,
): { found: (at: readonly number[], detail: string) => void; flush: () => void } {
  const held: HeldProblem[] = [];
  return {
    found(at: readonly number[], detail: string): void {
      held.push({ at, detail });
    },
    flush(): void {
      held.sort((a, b) => comparePositions(a.at, b.at));
      for (const problem of held) fail(check, problem.detail);
      held.length = 0;
    },
  };
}

function comparePositions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? -1;
    const right = b[index] ?? -1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------- the spilled join

/**
 * A key on its way into a family, escaped.
 *
 * `orderText` is injective, so two keys group together after escaping exactly
 * when they were equal before it. This file is where untrusted text becomes a
 * sort key: a row locator, an edge id and a composed change key all come out of
 * the candidate's artifacts, and a segment refuses a key holding the characters
 * its format owns — a newline, a tab, a NUL, the part separator. Escaping on the
 * way in is the only place it can be done once; escaping at the call sites is
 * how one side of a join ends up escaped and the other raw, which does not fail
 * loudly. It simply stops matching on the hostile key and reports nothing.
 */
function openKeyed<T>(scratch: ScratchStore, schema: string): KeyedSpill<T> {
  const spill = openRawKeyedSpill<T>(scratch, schema);
  return {
    add(entry: Keyed<T>): void {
      spill.add({ k: orderText(entry.k), v: entry.v });
    },
    seal(): SpooledFamily<Keyed<T>> {
      return spill.seal();
    },
  };
}

// -------------------------------------------------------------- reading CSV

/**
 * Bytes per read. Fixed, so the cost of reading an artifact does not depend on
 * its size.
 *
 * Exported so the suite can build an artifact that is certain to be several
 * blocks long and certain to have records straddling the joins between them. A
 * boundary case written against a number a test file chose for itself stops
 * being a boundary case the day this one moves.
 */
export const READ_BLOCK_BYTES = 1 << 16;

/**
 * The rows of one artifact, keyed by its header, a block at a time.
 *
 * An artifact that is not there is no rows rather than a failure, which is what
 * `package.sameArtifacts` above is for: a missing artifact is reported once, by
 * name, instead of once per check that wanted to read it.
 */
function rowsOf(dir: string, name: string): IterableIterator<Record<string, string>> {
  return readRows(join(dir, ...packagePath(name).split('/')));
}

function countRows(dir: string, name: string): number {
  let rows = 0;
  const cursor = rowsOf(dir, name);
  while (cursor.next().done !== true) rows += 1;
  return rows;
}

/**
 * No rows at all, as an artifact that is not there.
 *
 * A cursor rather than a null, so the walk below has one shape: a side that is
 * absent runs out immediately, which is exactly what "the source produces no
 * such record" means, and the alternative was a null check inside the loop that
 * had to say the same thing twice.
 */
function* noRows(): IterableIterator<Record<string, string>> {
  // Deliberately empty.
}

function* readRows(path: string): IterableIterator<Record<string, string>> {
  let headers: readonly string[] | null = null;
  for (const fields of readRecords(path)) {
    if (headers === null) {
      headers = fields;
      continue;
    }
    const row: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index] ?? ''] = fields[index] ?? '';
    }
    yield row;
  }
}

/**
 * An artifact's records, read a block at a time and kept for one step.
 *
 * The whole file used to be decoded into one string and parsed into an array of
 * every record before a single one was looked at, which is where 11,933 bytes
 * per source row came from. Reading in blocks costs the same total work and
 * holds one block.
 *
 * Decoding is incremental and has to be: a multi-byte character can land across
 * a block boundary, and a decoder that finished at every boundary would turn one
 * character into two replacement characters at a position that depends on the
 * block size — which would make the read non-deterministic in the one way
 * nothing downstream could detect.
 */
function* readRecords(path: string): IterableIterator<readonly string[]> {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return;
  }
  const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
  // `ignoreBOM: true` means do NOT strip it. The flag reads backwards, and
  // leaving it off cost a check.
  //
  // `table()` read with `readFileSync(path, 'utf8')`, which keeps a leading
  // U+FEFF; a TextDecoder removes one by default. So the block reader was
  // canonicalising away a byte-level difference between the two artifacts
  // before the row-level checks ever compared them. Measured: prepending a BOM
  // to an import file made `source.deliveredValues` report three altered values
  // before this change and none after — the artifact still failed, on
  // `package.bytesMatchTheSource` alone, so the verdict did not move, but a
  // named check had quietly stopped firing and only the byte comparison was
  // left to notice.
  //
  // A verification exists to compare the bytes an artifact holds. Normalising
  // them on the way in is the reader deciding what the artifact meant.
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const scanner = openCsvScanner();
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      // `stream: true` keeps any partial character for the next block instead of
      // resolving it to a replacement character at a block boundary.
      yield* scanner.push(decoder.decode(buffer.subarray(0, read), { stream: true }));
    }
    // The final call without `stream` flushes anything the file ended part way
    // through, so a truncated character is reported rather than dropped.
    yield* scanner.end(decoder.decode());
  } finally {
    closeSync(handle);
  }
}

/**
 * The reader, waiting to be fed.
 *
 * One shape for the two callers that exist: the file reader above, which hands
 * it whatever pieces the block size and the file's length happen to make, and
 * the suite, which hands it the same text cut at every offset there is. Those
 * have to be the same reader or the exhaustive case is exhaustive about
 * something else.
 */
interface CsvScanner {
  push(piece: string): string[][];
  end(piece: string): string[][];
}

function openCsvScanner(): CsvScanner {
  let carry = '';
  return {
    push(piece: string): string[][] {
      const scanned = splitCsvRecords(carry + piece, false);
      carry = scanned.rest;
      return scanned.records;
    },
    end(piece: string): string[][] {
      const scanned = splitCsvRecords(carry + piece, true);
      carry = '';
      return scanned.records;
    },
  };
}

/**
 * Every record of a CSV handed over in pieces, for the suite.
 *
 * Exposed because the seam this reader introduced is *every offset*, and a
 * fixture cannot reach them. A file gives the reader the three or four joins
 * that its length and the block size happen to produce, and the two positions
 * that can actually be got wrong — the carriage return of a CRLF, and the first
 * quote of an escaped pair — are each one character wide. A case built out of
 * rows will land on them by luck or not at all; two mutations that broke
 * exactly those two positions survived such a case on 2026-09-05, which is how
 * this came to exist. Splitting one short text at all of its offsets reaches
 * them by construction.
 */
export function readCsvRecordsFromPieces(pieces: readonly string[]): string[][] {
  const scanner = openCsvScanner();
  const records: string[][] = [];
  for (const piece of pieces) records.push(...scanner.push(piece));
  records.push(...scanner.end(''));
  return records;
}

/**
 * A small RFC 4180 reader. The package reader is not reused here on purpose:
 * this file's job is to disagree with the engine when the engine is wrong, and
 * sharing a parser with it narrows what a disagreement can look like.
 *
 * Records are separated here rather than by splitting the text on newlines: a
 * delivered value may contain one, and splitting first turned a multi-line
 * address into three records and reported them as invented.
 *
 * It reads a piece of the file rather than the whole of it, and what survives a
 * piece is the *text* of the record that was still being read — never the
 * parser's state. The unfinished record is read again from its first character
 * when the next piece arrives, which costs one record and removes the entire
 * class of bug the alternative has: a parser whose quoting state is threaded
 * across a boundary is a parser with two ways to be in the middle of a quoted
 * field.
 *
 * Two characters look ambiguous at the end of a piece — a quote, which may open
 * an escaped pair, and a carriage return, which may open a CRLF — and only the
 * carriage return actually is. Both were guarded at first. A mutation that
 * removed the quote guard could not be killed by any case, and the reason it
 * could not is the reason the guard was wrong to be there: a quote is not a
 * terminator, so nothing is emitted and `rest` carries the record back to be
 * read again from its first character with what follows it. The wrong decision
 * is discarded before it can be observed. A carriage return *is* a terminator,
 * so guessing there emits a record and moves `recordStart` past it — the guess
 * is committed, and a lone line feed opening the next piece then becomes an
 * extra empty record. That one is guarded; the other is gone, because a branch
 * that cannot change an outcome is not a check and reads like one.
 */
function splitCsvRecords(text: string, final: boolean): { records: string[][]; rest: string } {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  let recordStart = 0;

  const endField = (): void => {
    fields.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    if (started) records.push(fields);
    fields = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    started = true;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += character ?? '';
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ',') {
      endField();
      continue;
    }
    if (character === CARRIAGE_RETURN || character === LINE_FEED) {
      if (!final && character === CARRIAGE_RETURN && index + 1 === text.length) break;
      if (character === CARRIAGE_RETURN && text[index + 1] === LINE_FEED) index += 1;
      endRecord();
      recordStart = index + 1;
      continue;
    }
    field += character ?? '';
  }
  if (!final) return { records, rest: text.slice(recordStart) };
  if (started || field.length > 0 || fields.length > 0) endRecord();
  return { records, rest: '' };
}

const CARRIAGE_RETURN = String.fromCharCode(13);
const LINE_FEED = String.fromCharCode(10);

// ------------------------------------------------------------ reading bytes

/**
 * Whether two files hold the same bytes, without holding either of them.
 *
 * Not a hash comparison. Two files are the same when every byte is the same and
 * there are as many of them, which is what this asks directly; a digest would be
 * the same answer with an assumption attached, for no saving — both files have
 * to be read either way.
 */
function sameBytes(leftPath: string, rightPath: string): boolean {
  const left = openSync(leftPath, 'r');
  let right: number | null = null;
  try {
    right = openSync(rightPath, 'r');
    const leftBuffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
    const rightBuffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
    for (;;) {
      const readLeft = fill(left, leftBuffer);
      const readRight = fill(right, rightBuffer);
      if (readLeft !== readRight) return false;
      if (readLeft === 0) return true;
      if (!leftBuffer.subarray(0, readLeft).equals(rightBuffer.subarray(0, readRight))) return false;
    }
  } finally {
    closeSync(left);
    if (right !== null) closeSync(right);
  }
}

/**
 * Fills a block, or reaches the end of the file trying.
 *
 * `readSync` may return fewer bytes than asked for, and a comparison that took a
 * short read for the end of a file would call two identical files different —
 * loudly and wrongly, which is the worst way for a verifier to be wrong.
 */
function fill(handle: number, buffer: Buffer): number {
  let filled = 0;
  while (filled < buffer.length) {
    const read = readSync(handle, buffer, filled, buffer.length - filled, null);
    if (read === 0) break;
    filled += read;
  }
  return filled;
}

/**
 * A source file's SHA-256, read a block at a time.
 *
 * The authorities are hashed twice, before and after, and a source file is the
 * largest thing this call touches: reading each one whole put two copies of the
 * customer's export in memory to establish a 32-byte fact about it. This is the
 * same digest — SHA-256 fed in pieces is SHA-256 — and the repository holds it
 * to that rather than asserting it, because every fixture's authority hashes are
 * compared against `sha256Hex` over the whole file elsewhere in the suite.
 */
function hashFile(path: string): string {
  try {
    statSync(path);
  } catch {
    throw new MigrationError(
      'INPUT_NOT_FOUND',
      `${path} is named by the accepted configuration but is not present`,
      'Point --source at the directory holding the original source files.',
      { path },
    );
  }
  const hash = createHash('sha256');
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

function relativeTo(root: string, path: string): string {
  return path.startsWith(root + sep) ? path.slice(root.length + 1).split(sep).join('/') : path;
}

/** Sorted, so a report reads the same way twice. */
export function sortProblems(problems: readonly StrongProblem[]): StrongProblem[] {
  return [...problems].sort(
    (a, b) => compareCodeUnits(a.check, b.check) || compareCodeUnits(a.detail, b.detail),
  );
}

export { MANIFEST_FILE };

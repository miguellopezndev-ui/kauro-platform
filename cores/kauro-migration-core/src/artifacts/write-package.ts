import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { MigrationError } from '../domain/errors.js';
import { sha256Hex } from '../util/hash.js';
import { canonicalJsonText } from '../util/json.js';
import type { JsonObject } from '../util/json.js';
import { by, onString, sorted } from '../util/sorting.js';
import { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_REGISTRY_VERSION } from '../version.js';
import type { RunResult } from '../run/run-migration.js';
import type { MigrationConfig } from '../domain/config.js';
import { renderPackage } from './render-package.js';
import { artifactKind } from './layout.js';
import { neutraliseRow, rowHasRiskyCell } from './human-view.js';
import { escapeField } from './csv-writer.js';
import type { ArtifactFile } from './render-package.js';

export const MANIFEST_FILE = 'manifest.json';

export interface WritePackageInput {
  readonly result: RunResult;
  readonly config: MigrationConfig;
  readonly normalizedConfig: JsonObject;
  readonly outputDir: string;
  /** Replace an existing package written by this core. Never touches anything else. */
  readonly force: boolean;
}

export interface WrittenArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly rowCount: number | null;
}

export interface WritePackageResult {
  /**
   * Where the package was written. It is **not** the destination: a package is
   * staged, checked, and only then promoted.
   */
  readonly stagingDir: string;
  /** Where `promotePackage` will put it. Nothing is there yet. */
  readonly outputDir: string;
  readonly artifacts: readonly WrittenArtifact[];
  readonly manifestSha256: string;
}

/** The staging directory a package is built in before anybody may read it. */
export function stagingDirFor(outputDir: string): string {
  // A sibling, so promotion is a rename within one filesystem rather than a
  // copy. A rename is the only step here that is atomic, and atomicity is the
  // whole point.
  return `${resolve(outputDir)}.kauro-staging`;
}

/**
 * Render, freeze, hash, write, then read the written bytes back and confirm
 * they still hash to what the manifest claims.
 *
 * Nothing is allowed to touch an artifact between hashing and delivery: the
 * bytes that were verified are the bytes on disk.
 *
 * The package is built in a staging directory and left there. Publishing it is
 * a separate step the caller takes after it has been verified, which is the
 * order the contract requires and the only way a failure part way through
 * cannot leave a half-written package sitting where a reader expects a whole
 * one. Writing straight to the destination made the package live before
 * anything had checked it.
 */
export function writePackage(input: WritePackageInput): WritePackageResult {
  const outputDir = resolve(input.outputDir);
  const stagingDir = stagingDirFor(outputDir);
  // Refuse early rather than after the work: a destination that cannot be
  // published to should not cost a full render first.
  assertDestinationClaimable(outputDir, input.force);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const rendered = renderPackage({
    truth: input.result.truth,
    reconciliation: input.result.reconciliation,
    adapter: input.result.adapter,
    config: input.config,
    normalizedConfig: input.normalizedConfig,
  });

  // Written before the manifest, because the manifest carries their hashes.
  // A table with a human view yields two files when a cell needed neutralising.
  // The manifest lists them in path order, like every other artifact.
  const frozen = sorted(
    rendered.flatMap((file) => writeArtifact(stagingDir, file)),
    by(onString((file) => file.path)),
  );

  const manifest: JsonObject = {
    manifestVersion: PACKAGE_FORMAT_VERSION,
    coreVersion: CORE_VERSION,
    runId: input.result.truth.runId,
    bundleId: input.result.truth.bundleId,
    configHash: input.result.truth.configHash,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
    target: {
      mode: input.result.adapter.mode,
      adapterVersion: input.result.adapter.version,
      importMode: input.result.truth.importMode,
      // The instance this package was shaped against, named by its content.
      // Null where there was no instance: CLEAN_ONLY, or an import that matches
      // nothing and so needed no evidence about anybody's account.
      targetContractHash: input.result.truth.targetContractHash,
    },
    // The reading of the source this run was authorised against, or null where
    // the host supplied no profile. The canonical manifest carries it so a
    // package states which profile it belongs to rather than leaving a reader to
    // assume that whichever profile is to hand is the right one.
    sourceProfileHash: input.result.truth.sourceProfileHash,
    // Counted where the relationship candidates were produced, so the verifier
    // can compare three numbers rather than tally one array against itself.
    relationshipCandidates: input.result.truth.edgeCandidateCount,
    inputs: input.result.truth.sourceFiles.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
      format: file.format,
      encoding: file.encoding,
      encodingEvidence: file.encodingEvidence,
      // Per-sheet row counts, recorded by the readers. The verifier adds these
      // up and compares the total against the lineage, which is the only way it
      // can tell that a row was lost rather than never read.
      sheets: file.sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        sheetName: sheet.sheetName,
        hidden: sheet.hidden,
        columnCount: sheet.columnCount,
        readerRowCount: sheet.readerRowCount,
        dataRowCount: sheet.dataRowCount,
        rejectedRowCount: sheet.rejectedRowCount,
      })),
    })),
    artifacts: frozen.map((file) => ({
      path: file.path,
      // What the file is (D72): the verifier re-derives it from the path and
      // insists on the same answer.
      kind: artifactKind(file.path),
      sha256: file.sha256,
      byteLength: file.byteLength,
      rowCount: file.rowCount,
    })),
  };

  const manifestText = canonicalJsonText(manifest);
  const manifestBytes = Buffer.from(manifestText, 'utf8');

  writeFileSync(join(stagingDir, MANIFEST_FILE), manifestBytes);

  // Read the delivered bytes back. A mismatch here means something altered an
  // artifact after it was hashed, which invalidates the whole package.
  //
  // Read in blocks rather than whole. The check is the same check; what changes
  // is that confirming a package no longer requires holding its largest artifact
  // in memory. Reading each one whole put a transient peak proportional to the
  // biggest file at the very end of a run — the moment a large migration is
  // already holding the most — and it bought nothing, because a digest is
  // computed a block at a time either way.
  for (const file of frozen) {
    const target = join(stagingDir, ...file.path.split('/'));
    const readBack = digestFile(target);
    const digest = readBack.sha256;
    if (digest !== file.sha256 || readBack.byteLength !== file.byteLength) {
      throw new MigrationError(
        'ARTIFACT_VERIFICATION_FAILED',
        `${file.path} does not match the bytes that were hashed`,
        'The package was not delivered. Re-run the migration; if this repeats, the output directory is being modified by another process.',
        { path: file.path, expected: file.sha256, actual: digest },
      );
    }
  }

  return {
    stagingDir,
    outputDir,
    artifacts: frozen.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
      rowCount: file.rowCount,
    })),
    manifestSha256: sha256Hex(manifestBytes),
  };
}

/**
 * Publish a staged package.
 *
 * One rename. Until it happens the destination holds either nothing or the
 * previous package, and after it happens the destination holds a complete one.
 * There is no moment at which a reader can see half of this package, which is
 * the property that writing straight to the destination could not offer at any
 * price.
 *
 * The caller decides when. The contract puts verification first — render,
 * reconcile, hash, verify, attest, then publish — and this is the last step.
 */
export function promotePackage(staged: WritePackageResult, options: { force: boolean }): string {
  const outputDir = resolve(staged.outputDir);
  const stagingDir = resolve(staged.stagingDir);

  if (!existsSync(stagingDir)) {
    throw new MigrationError(
      'PACKAGE_INVALID',
      `there is no staged package at ${stagingDir}`,
      'Write the package before promoting it. A promotion publishes what was staged; it does not produce anything.',
      { stagingDir, outputDir },
    );
  }

  assertDestinationClaimable(outputDir, options.force);
  // Removed rather than emptied: a rename onto an existing directory is not a
  // rename. The occupancy rules above have already decided this is ours to
  // replace.
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(dirname(outputDir), { recursive: true });
  renameSync(stagingDir, outputDir);
  return outputDir;
}

/**
 * Discard a staged package that will not be published.
 *
 * Safe to call when there is nothing there, because the failure path should not
 * need to know how far the writing got.
 */
export function discardStagedPackage(staged: Pick<WritePackageResult, 'stagingDir'>): void {
  rmSync(resolve(staged.stagingDir), { recursive: true, force: true });
}

/**
 * Write a package and publish it in one step.
 *
 * For callers that are not verifying in between — fixtures, benchmarks, the
 * tools that only need a package on disk. Anything that delivers a package to
 * somebody stages it, verifies it, and promotes it, in that order.
 */
export function writeAndPromotePackage(input: WritePackageInput): WritePackageResult {
  const staged = writePackage(input);
  try {
    promotePackage(staged, { force: input.force });
  } catch (error) {
    discardStagedPackage(staged);
    throw error;
  }
  return staged;
}

interface WrittenBytes {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly rowCount: number | null;
}

/**
 * How much to accumulate before writing, in **bytes**.
 *
 * It used to be 2,048 rows, on the reasoning that a block should be large
 * enough that the syscall count is not the cost and small enough that the buffer
 * is not the cost. The second half of that does not follow from a row count: a
 * block of 2,048 rows costs whatever 2,048 rows happen to weigh, and a
 * destination that allows a 65,536-character cell allows five of them in a row,
 * which makes one block 670 MB — held as a JavaScript string, joined into a
 * second string, and encoded into a Buffer beside both.
 *
 * That is what took P8 down. A migration of 200,000 records with 5 KB of text on
 * each is an ordinary CRM with long notes in it, and it exhausted an eight
 * gibibyte heap inside `Array.prototype.join` in this function. The rows were
 * streaming correctly and the writer was not.
 *
 * A megabyte, measured as the rows are appended, so what a block costs no longer
 * depends on how wide the customer's data is.
 */
const WRITE_BLOCK_BYTES = 1 << 20;

/** Bytes per read when confirming an artifact. Fixed, so the check costs the same whatever the artifact weighs. */
const READ_BLOCK_BYTES = 1 << 16;

/**
 * Write one artifact, hashing the bytes as they go out.
 *
 * The hash is taken over exactly the bytes written, in the order they are
 * written, so "the bytes that were hashed are the bytes on disk" still holds —
 * and the read-back below still proves it independently. What has gone is
 * holding a whole artifact as a string and again as a buffer: at half a million
 * rows the package is most of a gigabyte, and paying for it twice in memory was
 * most of what packaging cost.
 */
function writeArtifact(outputDir: string, file: ArtifactFile): WrittenBytes[] {
  const target = join(outputDir, ...file.path.split('/'));
  mkdirSync(dirname(target), { recursive: true });

  const hash = createHash('sha256');
  let byteLength = 0;
  let written = 0;
  const handle = openSync(target, 'w');
  // The human view beside a table, when it has one: opened with the table,
  // written in the same pass, and kept only if some cell needed neutralising.
  const view = file.kind === 'TABLE' && file.humanView !== undefined ? openView(outputDir, file.humanView.path) : null;
  let viewRisky = false;
  try {
    const emit = (text: string): void => {
      const bytes = Buffer.from(text, 'utf8');
      writeSync(handle, bytes);
      hash.update(bytes);
      byteLength += bytes.length;
    };

    if (file.kind === 'DOCUMENT') {
      emit(file.text);
    } else {
      emit(`${file.headers.map(escapeField).join(',')}\n`);
      view?.emit(`${neutraliseRow(file.headers).map(escapeField).join(',')}\n`);
      let block: string[] = [];
      let blockBytes = 0;
      for (const row of file.rows) {
        written += 1;
        const line = row.map((value) => escapeField(value ?? '')).join(',');
        if (view !== null) {
          if (rowHasRiskyCell(row)) viewRisky = true;
          view.line(neutraliseRow(row).map(escapeField).join(','));
        }
        block.push(line);
        // Counted in bytes rather than in characters, because that is what the
        // buffer this becomes will cost. A row of astral characters is two code
        // units and four bytes each, and a block measured in characters would be
        // twice the size it was meant to be on exactly the data that is already
        // the most expensive.
        blockBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (blockBytes >= WRITE_BLOCK_BYTES) {
          emit(`${block.join('\n')}\n`);
          block = [];
          blockBytes = 0;
        }
      }
      if (block.length > 0) emit(`${block.join('\n')}\n`);
    }
  } finally {
    closeSync(handle);
    view?.close();
  }

  // The manifest states what was written, not what was predicted.
  //
  // Where the renderer knew the count in advance it declared one, and a
  // disagreement between the two is an artifact that lost or gained rows
  // between the family being counted and the bytes being emitted — which is
  // precisely the silent loss the whole package exists to make impossible.
  if (file.kind === 'TABLE' && file.rowCount !== null && file.rowCount !== written) {
    throw new MigrationError(
      'ARTIFACT_VERIFICATION_FAILED',
      `${file.path} was declared to hold ${String(file.rowCount)} rows and ${String(written)} were written`,
      'This is a defect in the engine, not in the customer data. The package was not written.',
      { path: file.path, declared: file.rowCount, written },
    );
  }

  const main: WrittenBytes = {
    path: file.path,
    sha256: hash.digest('hex'),
    byteLength,
    rowCount: file.kind === 'TABLE' ? written : null,
  };
  if (view === null) return [main];
  if (!viewRisky) {
    view.discard();
    return [main];
  }
  return [main, { path: view.path, sha256: view.sha256(), byteLength: view.byteLength(), rowCount: written }];
}

/**
 * The file a human view is written to, a block at a time, hashed as it goes.
 *
 * Kept apart from the table it copies so that the table's own bytes and digest
 * are produced exactly as they always were.
 */
function openView(outputDir: string, path: string) {
  const target = join(outputDir, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  const handle = openSync(target, 'w');
  const hash = createHash('sha256');
  let length = 0;
  let block: string[] = [];
  let blockBytes = 0;
  let closed = false;
  const write = (text: string): void => {
    const bytes = Buffer.from(text, 'utf8');
    writeSync(handle, bytes);
    hash.update(bytes);
    length += bytes.length;
  };
  const flush = (): void => {
    if (block.length === 0) return;
    write(`${block.join('\n')}\n`);
    block = [];
    blockBytes = 0;
  };
  return {
    path,
    emit: (text: string): void => {
      write(text);
    },
    line: (line: string): void => {
      block.push(line);
      blockBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (blockBytes >= WRITE_BLOCK_BYTES) flush();
    },
    close: (): void => {
      if (closed) return;
      flush();
      closed = true;
      closeSync(handle);
    },
    discard: (): void => {
      rmSync(target, { force: true });
    },
    sha256: (): string => hash.copy().digest('hex'),
    byteLength: (): number => length,
  };
}

/**
 * The digest and length of a file on disk, computed a block at a time.
 *
 * The buffer is fixed, so the cost of confirming an artifact does not depend on
 * how large the artifact is. That is the whole difference from reading it whole:
 * the answer is identical and the peak is not.
 */
function digestFile(path: string): { sha256: string; byteLength: number } {
  const handle = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
  let byteLength = 0;
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      byteLength += read;
    }
  } finally {
    closeSync(handle);
  }
  return { sha256: hash.digest('hex'), byteLength };
}

/**
 * May this run claim that destination?
 *
 * Asked before the work starts and again before the rename. It never creates or
 * empties anything: the answer has to hold while a package is being staged, and
 * a check that changed the thing it was checking could not be asked twice.
 */
function assertDestinationClaimable(outputDir: string, force: boolean): void {
  let exists = true;
  try {
    statSync(outputDir);
  } catch {
    exists = false;
  }

  if (!exists) return;

  const entries = readdirSync(outputDir);
  if (entries.length === 0) return;

  const looksLikeOurPackage = entries.includes(MANIFEST_FILE);
  if (!force || !looksLikeOurPackage) {
    throw new MigrationError(
      'PACKAGE_INVALID',
      `the output directory ${outputDir} is not empty`,
      looksLikeOurPackage
        ? 'It holds a package from an earlier run. Pass --force to replace it, or choose a different directory.'
        : 'Choose an empty directory. The engine will not delete files it did not write.',
      { outputDir, entries: sorted(entries, (a, b) => (a < b ? -1 : a > b ? 1 : 0)) },
    );
  }

}

/** Lists artifact files actually present on disk, so the verifier can spot anything the manifest omits. */
export function listPackageFiles(packageDir: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(resolve(packageDir), '');
  return sorted(found, by(onString((path) => path)));
}
